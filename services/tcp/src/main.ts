// TCP game server — DeepCore/Pomelo binary protocol (faithful to client).
//
// Connection flow (mirrors LoginMgr.cs + PomeloConnector + NetClient.lua):
//   1. client connects, sends PKG_HANDSHAKE whose `user` OBJ is a
//      ClientEnterServerRequest (0x00032001): {c2s_accountUUID, c2s_token, c2s_debug, c2s_sessionId}
//   2. server validates token against `sessions` table, replies PKG_HANDSHAKE_ACK with
//      token OBJ = ClientEnterServerResponse (0x00032002) {.., s2c_sessionId}
//   3. client sends PKG_MESSAGE/MSG_REQUEST_C2S frames: [u8 msgType][u32 sendId][s32 route][body]
//      where route = protocol MessageID, body = flattened fields (LE primitives, UTF-16LE strings)
//   4. server replies PKG_MESSAGE/MSG_RESPONSE_S2C with same sendId, route = Response MessageID
//   5. PKG_HEARTBEAT echoed back; PKG_KICK sent on auth failure
//
// All MessageIDs/fields come from shared/proto/protocols.json generated from the
// client's Lua protocol corpus (scripts/gen_registry.py). No invented IDs remain.

import { createServer, Socket } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from '../../../shared/config.js'
import { log, health, tcpMessages, tcpConnections } from '../../../shared/obs.js'
import { startPushScheduler, setBroadcaster } from '../../../lib/push-scheduler.js'
import {
  PackageType, MessageType, NULL_MESSAGE_CODE,
  decodeFrame, encodeFrame, encodeBody, decodeBody, responseIdFor,
  getProtocolById, getProtocolByShort,
} from '../../../shared/proto/codec.js'
import { runMigrations } from '../../../db/migrations/run.js'
import '../../../shared/proto/registry.js'

// Engine libs
import { IssueSeed, resolveBot } from '../../../lib/battle-arbitrator.js'
import { listGuilds, loadGuild, createGuild, applyToGuild, leaveGuild, searchGuild, kickMember, changeGuildNotice, changeGuildPosition } from '../../../lib/guild-engine.js'
import { getCurrentSeason, getRankings, findOpponent, updateScore } from '../../../lib/arena-engine.js'
import { startDungeon, getDungeonStageReward } from '../../../lib/dungeon-engine.js'
import { startUnionBattle, endUnionBattle, getUnionInfo } from '../../../lib/union-subsystems.js'
import { generateMaze } from '../../../lib/maze-engine.js'
import { startRogue } from '../../../lib/rogue-engine.js'
import { queryTower } from '../../../lib/tower-engine.js'
import { sendAndStore, listMessages, isMuted, mute } from '../../../lib/chat-engine.js'
import { placeOrder, checkOrder, syncOrder } from '../../../lib/pay.js'
import { isAdmin, execGmCommand } from '../../../lib/gm-admin.js'
import { checkRateLimit, RL } from '../../../lib/rate-limit.js'
import { dispatchRewards } from '../../../lib/rewards.js'

const DB_PATH = config.db.path
mkdirSync(dirname(DB_PATH), { recursive: true })
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
try {
  runMigrations(db)
} catch (e: any) {
  health.dbOk = false
  health.dbLastError = e.message
  log.error({ err: e.message }, 'migrations failed')
  throw e
}

const PORT = config.tcp.port
const HEARTBEAT_INTERVAL_MS = config.game.heartbeatMs

// ---------------- Session state ----------------

interface Session {
  accountUuid: string
  roleUuid: string
  sessionId: number
  handshakeAt: number
}
const sessions = new Map<Socket, Session>()

const ENTER_SERVER_REQ = 0x00032001
const ENTER_SERVER_RESP = 0x00032002
const ENTER_GAME_REQ = 0x00033001
const EXIT_GAME_REQ = 0x0003300f
const CLIENT_PING = 0x00033013
const FIGHT_SEED_REQ = 0x00035201
const FIGHT_RESULT_REQ = 0x00035203
const FIGHT_SKIP_REQ = 0x00035209
const GET_FORMATION_REQ = 0x00035701
const QUERY_BAG_HERO_REQ = 0x66be7dab
const LOAD_GUILD_REQ = 0x00035906
const PLACE_ORDER_REQ = 0x00036501
const CHECK_ORDER_REQ = 0x00036503
const SYNC_ORDER_REQ = 0x00036505
const HANDLE_GM_REQ = 0x00035301
const CHAT_LIST_REQ = 0x00038301
const CHAT_ADD_REQ = 0x00038303
const ENTER_MAZE_REQ = 0x00037901
const START_COPY_REQ = 0x00036304
const END_COPY_REQ = 0x00036306
const GET_ROLE_INFO_REQ = 0x00050201
const CHANGE_ROLE_NAME_REQ = 0x00050403
const COMMON_NOTIFY = 0x00035001

// Arena (real IDs from Lua corpus)
const ENTER_ARENA_REQ = 0x00039009
const ARENA_VALOR_DATA_REQ = 0x00039001
const ARENA_HIGHEND_DATA_REQ = 0x00039015
const ARENA_VALOR_SEED_REQ = 0x00035205
const ARENA_HIGHEND_SEED_REQ = 0x00035207
const ARENA_VALOR_OPPONENT_REQ = 0x00039003
const ARENA_HIGHEND_OPPONENT_REQ = 0x00039017
// Tower
const QUERY_TOWER_INFO_REQ = 0x00035601
const CHALLENGE_TOWER_START_REQ = 0x00035603
const CHALLENGE_TOWER_END_REQ = 0x00035605
const SWEEP_TOWER_REQ = 0x0003560b
// Dungeon
const GET_DUNGEON_OPT_REQ = 0x00038701
const CHALLENGE_DUNGEON_START_REQ = 0x00038703
const CHALLENGE_DUNGEON_END_REQ = 0x00038705
const SWEEP_DUNGEON_REQ = 0x00038707
// Guild
const RECOMMEND_GUILD_REQ = 0x00035902
const SEARCH_GUILD_REQ = 0x00035904
const CREATE_GUILD_REQ = 0x00035908
const APPLY_JOIN_GUILD_REQ = 0x0003590a
const EXIT_GUILD_REQ = 0x00035916
const CHANGE_GUILD_NOTICE_REQ = 0x00035920
const CHANGE_GUILD_POSITION_REQ = 0x0003591a
const KICK_OUT_GUILD_REQ = 0x0003591c
// Union (guild subsystems)
const GUILD_HUNTER_INFO_REQ = 0x00037201
const GUILD_HUNTER_BATTLE_REQ = 0x00037209
const GUILD_WARRIOR_TREASURE_INFO_REQ = 0x0003720c
// Sign-in
const LOGIN_SIGN_INFO_REQ = 0x00050501
const LOGIN_SIGN_REWARD_REQ = 0x00050503
// Chat extra
const CHAT_MUTE_STATE_REQ = 0x00038310

// ---------------- Response helpers ----------------

/** Base fields present on every ClientResponse-derived protocol. */
function baseResp(code = 200, msg = 'ok'): Record<string, unknown> {
  return { s2c_code: code, s2c_msg: msg, InnerResponse: null, s2c_notifys: [] }
}

type Handler = (s: Session, body: Record<string, unknown>, sock: Socket) => Record<string, unknown> | Promise<Record<string, unknown>>

const handlers = new Map<number, Handler>()

// ---------------- Core lifecycle ----------------

handlers.set(ENTER_GAME_REQ, (s, b) => {
  const serverId = String(b.c2s_serverID || 's10001')
  const role = db.prepare(`SELECT role_uuid, name, level FROM roles WHERE account_uuid = ? AND server_id = ?`)
    .get(s.accountUuid, serverId) as any
  let newRole = false
  let roleUuid = s.roleUuid
  if (!role) {
    roleUuid = 'role-' + Math.random().toString(36).slice(2, 10)
    db.prepare(`INSERT INTO roles(account_uuid, server_id, role_uuid, name, level, exp, gold, diamond, vip_level, battle_power)
                VALUES (?, ?, ?, ?, 1, 0, 1000, 100, 0, 0)`)
      .run(s.accountUuid, serverId, roleUuid, 'Player' + roleUuid.slice(-6))
    newRole = true
  } else {
    roleUuid = role.role_uuid
  }
  s.roleUuid = roleUuid
  return {
    ...baseResp(),
    s2c_UserSource: 'server',
    s2c_newRole: newRole,
    s2c_waitingCount: 0,
    s2c_battleRecordURLPrefix: '',
    s2c_accumulativeLoginDays: 1,
    s2c_serverId: serverId,
    s2c_createRoleClientVersion: '1.0.0',
  }
})

handlers.set(EXIT_GAME_REQ, (s) => {
  sessions.delete as unknown // keep map entry; just clear role binding
  s.roleUuid = ''
  return baseResp()
})

handlers.set(CLIENT_PING, () => baseResp())

// ---------------- M1: Battle loop ----------------

handlers.set(FIGHT_SEED_REQ, (s, b) => {
  const rl = checkRateLimit(`${s.roleUuid}:battle`, RL.TCP_BATTLE.max, RL.TCP_BATTLE.windowSec)
  if (!rl.allowed) return baseResp(429, 'RATE_LIMITED')
  const role = db.prepare(`SELECT battle_power FROM roles WHERE role_uuid = ?`).get(s.roleUuid) as any
  const seed = IssueSeed(db, s.roleUuid, Number(b.FightMod ?? 0), Number(b.StageId ?? 0), Number(role?.battle_power ?? 0))
  return {
    ...baseResp(),
    RandomUuid: seed.s2c_randomUuid,
    UpdateFightMod: seed.s2c_updateFightMod,
    UpdateStageId: seed.s2c_updateStageId,
    NeedFightDamage: seed.s2c_needFightDamage,
    NeedFightReplay: seed.s2c_needFightReplay,
    RandomSeed: seed.s2c_randomSeed,
    DifficultyRank: seed.s2c_difficultyRank,
    Stage_dynamic_difficulty: seed.s2c_stage_dynamic_difficulty,
    Battle_check_realpwoer: seed.s2c_battle_check_realpwoer,
  }
})

handlers.set(FIGHT_RESULT_REQ, async (s, b, sock) => {
  const role = db.prepare(`SELECT battle_power FROM roles WHERE role_uuid = ?`).get(s.roleUuid) as any
  const power = Number(role?.battle_power ?? 0)
  const resultInfo = (b.ResultInfo ?? {}) as Record<string, unknown>
  const isWin = Number(resultInfo.Result ?? 0) === 1
  const r = resolveBot(db, s.roleUuid, String(b.RandomUuid ?? ''), power,
    isWin ? JSON.stringify(resultInfo) : undefined, isWin ? String(resultInfo.Result ?? '') : undefined)
  if (!r.ok) return baseResp(403, r.reason ?? 'REJECTED')
  // Grant rewards + push ClientCommonNotify
  if (r.rewards?.length && s.roleUuid) {
    try {
      const res = await dispatchRewards(db, s.roleUuid, r.rewards as any, 'battle_result')
      pushCommonNotify(sock, res.deltas, r.rewards)
    } catch (e: any) {
      log.error({ err: e.message }, 'dispatchRewards failed')
    }
  }
  return { ...baseResp(), BattleResultExtData: null }
})

handlers.set(FIGHT_SKIP_REQ, (s, b) => {
  // Sweep-style instant settle: reuse the seed machinery if a RandomUuid is provided; else simple ack.
  const role = db.prepare(`SELECT battle_power FROM roles WHERE role_uuid = ?`).get(s.roleUuid) as any
  const r = resolveBot(db, s.roleUuid, String((b as any).RandomUuid ?? ''), Number(role?.battle_power ?? 0))
  if ((b as any).RandomUuid && !r.ok) return baseResp(403, r.reason ?? 'REJECTED')
  return baseResp()
})

// ---------------- M2: Daily loop ----------------

handlers.set(QUERY_BAG_HERO_REQ, (s) => {
  const heroes = db.prepare(`SELECT hero_uuid, hero_id, level, exp, rank, star, locked FROM heroes WHERE role_uuid = ?`).all(s.roleUuid) as any[]
  // s2c_heros: MAP<S32 sysType, MAP<UTF uuid, MAP<..>>> per corpus; deliver flat per-sysType map
  const heros: Record<string, Record<string, unknown>> = {}
  for (const h of heroes) {
    const sys = String(h.hero_id)
    heros[sys] ??= {}
    heros[sys][h.hero_uuid] = { Uuid: h.hero_uuid, ConfigId: h.hero_id, Level: h.level, Quality: h.rank ?? 0, Lock: h.locked ?? 0 }
  }
  return { ...baseResp(), s2c_heros: {} } // TODO map shape needs BagHeroData corpus mapping; empty map is wire-valid
})

handlers.set(GET_FORMATION_REQ, (s, b) => {
  const rows = db.prepare(`SELECT name, heroes_json FROM formations WHERE role_uuid = ? AND type = ?`)
    .all(s.roleUuid, Number(b.c2s_type ?? 0)) as any[]
  const formations = rows.map(r => {
    let heroes: unknown[] = []
    try { heroes = JSON.parse(r.heroes_json || '[]') } catch { /* keep [] */ }
    return { Name: r.name ?? '', IsHot: false, Heroes: heroes, HallowsData: null }
  })
  return { ...baseResp(), s2c_formations: formations }
})

handlers.set(ENTER_MAZE_REQ, (s, b) => {
  const maze = generateMaze(s.roleUuid, Number(b.c2s_mazeType ?? 0))
  return {
    ...baseResp(),
    s2c_mazeData: null, // MazeData ORM shape not yet mapped; layout computed server-side
    s2c_chooseMazeTypes: [],
    LeftRefreshTime: 0n,
    LeftShenYuanRefreshTime: 0n,
    SupportHeroRace: [],
    BadLuck: [],
    SkipPeriodCount: 0,
    FirstEnter: false,
    OpenKaoShangLin: false,
    _debugMaze: undefined, // not on wire; ignored by encoder
  }
})

handlers.set(START_COPY_REQ, (s, b) => {
  startRogue(s.roleUuid, Number((b as any).c2s_copyId ?? 0), Number((b as any).c2s_type ?? 0))
  return { ...baseResp(), c2s_copyData: null }
})

handlers.set(END_COPY_REQ, () => baseResp())

// ---------------- M3: Social ----------------

handlers.set(LOAD_GUILD_REQ, (s, b) => {
  const guildUuid = String(b.c2s_uuid ?? '')
  const g = guildUuid ? loadGuild(s.roleUuid, guildUuid) : null
  return {
    ...baseResp(),
    s2c_guildData: g ? {
      Uuid: g.uuid, SerialNumber: 0n, Name: g.name, Icon: '', Level: 1, Exp: 0,
      ActivityValue: 0, Notice: g.notice ?? '', Language: '', MinJoinLevel: 1,
      JoinCheckType: 0, Members: {}, JoinNotice: '',
    } : null,
    s2c_myActivityToday: 0,
  }
})

handlers.set(CHAT_LIST_REQ, (s) => {
  const res = listMessages('world', Math.floor(Date.now() / 1000), 50)
  const msgs = (res.s2c_messages ?? []) as any[]
  return {
    ...baseResp(),
    s2c_list: msgs.map((m: any) => ({
      Data: { ChannelId: 'world', ChannelType: 1, ChannelName: 'world', IsUp: false, TimeStamp: BigInt(m.at ?? 0) },
      Player: { Uuid: m.roleUuid ?? '', Name: '', Icon: '', IconBox: '', ServerId: 's10001' },
    })),
    s2c_muteState: { s2c_HasMuted: isMuted(s.roleUuid), s2c_IsMuteForever: false, s2c_MuteTimeStamps: 0n },
  }
})

handlers.set(CHAT_ADD_REQ, (s, b) => {
  const rl = checkRateLimit(`${s.roleUuid}:chat`, RL.TCP_CHAT.max, RL.TCP_CHAT.windowSec)
  if (!rl.allowed) return baseResp(429, 'RATE_LIMITED')
  if (isMuted(s.roleUuid)) return baseResp(403, 'MUTED')
  const datas = (b.c2s_datas ?? []) as any[]
  for (const d of datas) {
    const text = String(d?.Text ?? d?.text ?? d?.Content ?? '')
    if (text) sendAndStore(s.roleUuid, String(d?.ChannelId ?? 'world'), text)
  }
  return baseResp()
})

// ---------------- M4: Commerce / GM ----------------

handlers.set(PLACE_ORDER_REQ, (s, b) => {
  const rl = checkRateLimit(`${s.roleUuid}:pay`, RL.TCP_PAY.max, RL.TCP_PAY.windowSec)
  if (!rl.allowed) return baseResp(429, 'RATE_LIMITED')
  const o = placeOrder(s.roleUuid, String(b.c2s_productID ?? ''), Number(b.c2s_productID ?? 0))
  return { ...baseResp(), s2c_orderID: o.s2c_orderId, s2c_notifyUrl: process.env.PAY_NOTIFY_URL ?? '' }
})

handlers.set(CHECK_ORDER_REQ, (_s, b) => {
  const o = checkOrder(String(b.c2s_orderID ?? ''))
  return { ...baseResp(), s2c_isDot: o.s2c_status === 1 }
})

handlers.set(SYNC_ORDER_REQ, () => ({ ...baseResp(), s2c_orderIds: [], s2c_productIds: [] }))

handlers.set(HANDLE_GM_REQ, async (s, b, sock) => {
  const cmd = String(b.c2s_cmd ?? '')
  // GM commands require the admin token prefix embedded as "token:<t> <cmd...>"
  const [tokenPart, ...rest] = cmd.split(' ')
  const token = tokenPart.startsWith('token:') ? tokenPart.slice(6) : ''
  if (!isAdmin(token)) return baseResp(403, 'NOT_ADMIN')
  const realCmd = rest.join(' ')
  const r = await execGmCommand(db, token, realCmd.split(' ')[0] ?? '', realCmd.split(' ').slice(1), { roleUuid: s.roleUuid, ip: sock.remoteAddress ?? '' })
  return { ...baseResp(r.ok ? 200 : 400, r.ok ? 'ok' : (r as any).reason ?? 'ERR'), s2c_cmd: realCmd }
})

// ---------------- M5: Role info ----------------

handlers.set(GET_ROLE_INFO_REQ, (s, b) => {
  const uuid = String(b.c2s_uuid ?? s.roleUuid)
  const role = db.prepare(`SELECT * FROM roles WHERE role_uuid = ?`).get(uuid) as any
  return {
    ...baseResp(),
    s2c_info: role ? {
      Name: role.name, NumberId: 0, Level: role.level, GuildUuid: '', GuildName: '', GuildPos: 0,
      Sign: role.sign ?? '', Icon: role.head_icon ?? '', FrameIcon: '', Gender: role.gender ?? 0,
      FightPower: BigInt(role.battle_power ?? 0), ServerId: role.server_id ?? 's10001',
      MainFightLevel: 0, FansCount: 0,
    } : null,
    s2c_Team: {}, s2c_LifeLevel: {}, s2c_Medals: {},
    s2c_isFriend: 0, s2c_isBlack: false, s2c_isFans: 0,
    s2c_scoreGrowRate: 0, s2c_coinGrowRate: 0,
  }
})

handlers.set(CHANGE_ROLE_NAME_REQ, (s, b) => {
  const name = String(b.c2s_name ?? '').slice(0, 32)
  if (!name) return baseResp(400, 'EMPTY_NAME')
  db.prepare(`UPDATE roles SET name = ? WHERE role_uuid = ?`).run(name, s.roleUuid)
  return baseResp()
})

// ---------------- M3: Arena (real corpus IDs) ----------------

handlers.set(ENTER_ARENA_REQ, (s) => {
  const season = getCurrentSeason() ?? 1
  const now = BigInt(Math.floor(Date.now() / 1000))
  return {
    ...baseResp(),
    s2c_ServerId: 's10001',
    s2c_ServerNowTimeStamp: now,
    s2c_arenaValorId: 1,
    s2c_arenaValorSeason: season,
    s2c_arenaValorStartTime: now,
    s2c_arenaValorEndTime: now + 30n * 24n * 3600n,
    s2c_arenaValorMyRank: 0,
    s2c_arenaValorMyPower: 0n,
    s2c_arenaValorFirstRole: null,
    s2c_arenaHighendSeason: season,
    s2c_arenaHighendStartTime: now,
    s2c_arenaHighendEndTime: now + 30n * 24n * 3600n,
    s2c_arenaHighendMyTier: 0,
    s2c_arenaHighendArenaCoin: 0n,
    s2c_arenaHighendMyPower: 0n,
    arenaPinnaclePinnacleStage: 0,
    arenaPinnacleCompetitionPeriod: 0,
    arenaPinnaclePhasedTimeStamp: now,
    arenaPinnacleSeason: season,
    arenaPinnacleWheelBattleTeamCount: 0,
    arenaPinnacleBattleTeamWaitSeason: 0,
    s2c_arenaPinnacleIsContestant: false,
    s2c_isArenaPinnacleOpen: false,
    s2c_ArenaPinnacleServiceType: 0,
    s2c_ChampionRoleArenaPinnacleData: null,
    s2c_ValidSeasonList: [season],
  }
})

handlers.set(ARENA_VALOR_DATA_REQ, (s) => {
  const season = getCurrentSeason() ?? 1
  const now = BigInt(Math.floor(Date.now() / 1000))
  return {
    ...baseResp(),
    s2c_season: season, s2c_startTime: now, s2c_endTime: now + 30n * 24n * 3600n,
    s2c_power: 0n, s2c_dailyFightCount: 0, s2c_fightCount: 0, s2c_score: 0,
    s2c_rank: [], s2c_totalFightCountInSeason: 0, s2c_rankValue: 0,
    s2c_tierSegmentRewardIdList: [], s2c_tier: 0, s2c_historicHighestScore: 0,
  }
})

handlers.set(ARENA_HIGHEND_DATA_REQ, (s) => {
  const season = getCurrentSeason() ?? 1
  const now = BigInt(Math.floor(Date.now() / 1000))
  return {
    ...baseResp(),
    s2c_season: season, s2c_startTime: now, s2c_endTime: now + 30n * 24n * 3600n,
    s2c_power: 0n, s2c_dailyFightCount: 0, s2c_score: 0, s2c_tier: 0,
    s2c_arenaCoin: 0, s2c_rankList: [], s2c_rank: 0,
  }
})

handlers.set(ARENA_VALOR_SEED_REQ, (s, b) => {
  const rl = checkRateLimit(`${s.roleUuid}:arena`, RL.TCP_BATTLE.max, RL.TCP_BATTLE.windowSec)
  if (!rl.allowed) return baseResp(429, 'RATE_LIMITED')
  const role = db.prepare(`SELECT battle_power FROM roles WHERE role_uuid = ?`).get(s.roleUuid) as any
  const seed = IssueSeed(db, s.roleUuid, Number(b.c2s_FightMod ?? 11), 0, Number(role?.battle_power ?? 0))
  return {
    ...baseResp(),
    s2c_RandomUuid: seed.s2c_randomUuid,
    s2c_UpdateFightMod: seed.s2c_updateFightMod,
    s2c_BattleInfo: null,
    s2c_Result: 0,
    s2c_ArenaValorBattleResultData: null,
    s2c_ReachHistoricHighestTier: 0,
    s2c_DailyFightCount: 0,
  }
})

handlers.set(ARENA_HIGHEND_SEED_REQ, (s, b) => {
  const rl = checkRateLimit(`${s.roleUuid}:arena`, RL.TCP_BATTLE.max, RL.TCP_BATTLE.windowSec)
  if (!rl.allowed) return baseResp(429, 'RATE_LIMITED')
  const role = db.prepare(`SELECT battle_power FROM roles WHERE role_uuid = ?`).get(s.roleUuid) as any
  const seed = IssueSeed(db, s.roleUuid, Number(b.c2s_FightMod ?? 12), 0, Number(role?.battle_power ?? 0))
  return {
    ...baseResp(),
    s2c_RandomUuid: seed.s2c_randomUuid,
    s2c_UpdateFightMod: seed.s2c_updateFightMod,
    s2c_BattleInfo: null,
    s2c_Result: 0,
    s2c_ArenaValorBattleResultData: null,
    s2c_ReachHistoricHighestTier: 0,
    s2c_DailyFightCount: 0,
  }
})

handlers.set(ARENA_VALOR_OPPONENT_REQ, (s) => {
  const season = getCurrentSeason() ?? 1
  const opp = findOpponent(s.roleUuid, season, 5)
  return { ...baseResp(), s2c_opponents: (opp as any).s2c_opponents ?? [] }
})

handlers.set(ARENA_HIGHEND_OPPONENT_REQ, (s) => {
  const season = getCurrentSeason() ?? 1
  const opp = findOpponent(s.roleUuid, season, 5)
  return { ...baseResp(), s2c_opponents: (opp as any).s2c_opponents ?? [] }
})

// ---------------- M2: Tower ----------------

handlers.set(QUERY_TOWER_INFO_REQ, (s) => {
  const t = queryTower(s.roleUuid)
  // s2c_towerInfos: MAP<S32, TowerInfo ORM>; emit one default tower entry
  return { ...baseResp(), s2c_towerInfos: { '1': { TowerID: 1, Level: (t as any).s2c_currentFloor ?? 1, BestRoleUuid: '', BestTime: 0 } } }
})

handlers.set(CHALLENGE_TOWER_START_REQ, (s, b) => baseResp())

handlers.set(CHALLENGE_TOWER_END_REQ, async (s, b, sock) => {
  const towerId = Number(b.c2s_towerID ?? 1)
  const level = Number(b.c2s_level ?? 1)
  const isWin = Boolean(b.c2s_isWin)
  if (isWin && s.roleUuid) {
    const rewards = [
      { type: 'gold' as const, qty: level * 50 },
      { type: 'exp' as const, qty: level * 20 },
    ]
    try {
      const res = await dispatchRewards(db, s.roleUuid, rewards, 'tower_end')
      pushCommonNotify(sock, res.deltas, rewards)
    } catch (e: any) { log.error({ err: e.message }, 'tower rewards failed') }
  }
  return { ...baseResp(), s2c_towerID: towerId, s2c_level: level, s2c_climbTimes: 1 }
})

handlers.set(SWEEP_TOWER_REQ, async (s, b, sock) => {
  const towerId = Number(b.c2s_towerID ?? 1)
  const level = Number(b.c2s_level ?? 1)
  if (s.roleUuid) {
    const rewards = [{ type: 'gold' as const, qty: level * 40 }]
    try {
      const res = await dispatchRewards(db, s.roleUuid, rewards, 'tower_sweep')
      pushCommonNotify(sock, res.deltas, rewards)
    } catch (e: any) { log.error({ err: e.message }, 'tower sweep rewards failed') }
  }
  return { ...baseResp(), s2c_towerID: towerId, s2c_level: level }
})

// ---------------- M2: Dungeon ----------------

handlers.set(GET_DUNGEON_OPT_REQ, (s, b) => {
  // s2c_list: LIST(DungeonData ORM) — emit one entry per dungeon type
  const types = ['gold', 'exp', 'hero', 'artifact', 'rune']
  const list = types.map((tp, i) => ({ DungeonType: i + 1, DungeonID: (i + 1) * 100, BestLevel: 0, TodayCount: 0, MaxCount: 5 }))
  return { ...baseResp(), s2c_list: list }
})

handlers.set(CHALLENGE_DUNGEON_START_REQ, (s, b) => {
  const tp = Number(b.c2s_dungeonType ?? 1)
  const typeNames = ['gold', 'exp', 'hero', 'artifact', 'rune'] as const
  startDungeon(db, s.roleUuid, typeNames[tp - 1] ?? 'gold', Number(b.c2s_dungeonID ?? 100))
  return baseResp()
})

handlers.set(CHALLENGE_DUNGEON_END_REQ, async (s, b, sock) => {
  const isWin = Boolean(b.c2s_isWin)
  const dungeonId = Number(b.c2s_dungeonID ?? 100)
  if (isWin && s.roleUuid) {
    const r = getDungeonStageReward(dungeonId) as any
    const rewards = [
      { type: 'gold' as const, qty: r.s2c_reward?.gold ?? 100 },
      { type: 'exp' as const, qty: r.s2c_reward?.exp ?? 50 },
    ]
    try {
      const res = await dispatchRewards(db, s.roleUuid, rewards, 'dungeon_end')
      pushCommonNotify(sock, res.deltas, rewards)
    } catch (e: any) { log.error({ err: e.message }, 'dungeon rewards failed') }
  }
  return { ...baseResp(), s2c_dungeonData: null }
})

handlers.set(SWEEP_DUNGEON_REQ, async (s, b, sock) => {
  const dungeonId = Number(b.c2s_dungeonID ?? 100)
  if (s.roleUuid) {
    const r = getDungeonStageReward(dungeonId) as any
    const rewards = [{ type: 'gold' as const, qty: Math.floor((r.s2c_reward?.gold ?? 100) * 0.8) }]
    try {
      const res = await dispatchRewards(db, s.roleUuid, rewards, 'dungeon_sweep')
      pushCommonNotify(sock, res.deltas, rewards)
    } catch (e: any) { log.error({ err: e.message }, 'dungeon sweep rewards failed') }
  }
  return { ...baseResp(), s2c_dungeonData: null }
})

// ---------------- M3: Guild (real corpus IDs) ----------------

function guildToBaseData(g: any): Record<string, unknown> {
  return {
    Uuid: g.uuid, SerialNumber: 0n, Name: g.name, Icon: '', Level: g.level ?? 1, Exp: g.exp ?? 0,
    ActivityValue: 0, Notice: g.notice ?? '', Language: '', MinJoinLevel: 1,
    JoinCheckType: 0, Members: {}, JoinNotice: '',
  }
}

handlers.set(RECOMMEND_GUILD_REQ, () => {
  const guilds = listGuilds().slice(0, 20).map(g => ({ Uuid: g.uuid, Name: g.name, Level: g.level ?? 1, MemberCount: 1, Icon: '', Notice: g.notice ?? '' }))
  return { ...baseResp(), s2c_guilds: guilds }
})

handlers.set(SEARCH_GUILD_REQ, (s, b) => {
  const r = searchGuild(String(b.c2s_name ?? ''))
  const guilds = (r as any).s2c_guilds.map((g: any) => ({ Uuid: g.uuid, Name: g.name, Level: g.level ?? 1, MemberCount: 1, Icon: '', Notice: g.notice ?? '' }))
  return { ...baseResp(), s2c_guilds: guilds }
})

handlers.set(CREATE_GUILD_REQ, (s, b) => {
  const g = createGuild(db, s.roleUuid, String(b.c2s_name ?? 'Guild'), '')
  return { ...baseResp(), s2c_guildData: guildToBaseData(g) }
})

handlers.set(APPLY_JOIN_GUILD_REQ, (s, b) => {
  applyToGuild(s.roleUuid, String(b.c2s_uuid ?? ''))
  return baseResp()
})

handlers.set(EXIT_GUILD_REQ, (s) => {
  // find the guild this role belongs to and leave it
  for (const g of listGuilds()) {
    leaveGuild(s.roleUuid, g.uuid)
  }
  return baseResp()
})

handlers.set(CHANGE_GUILD_NOTICE_REQ, (s, b) => {
  for (const g of listGuilds()) {
    if (g.leaderUuid === s.roleUuid) { changeGuildNotice(s.roleUuid, g.uuid, String(b.c2s_notice ?? '')); break }
  }
  return baseResp()
})

handlers.set(CHANGE_GUILD_POSITION_REQ, (s, b) => {
  for (const g of listGuilds()) {
    if (g.leaderUuid === s.roleUuid) { changeGuildPosition(s.roleUuid, g.uuid, String(b.c2s_targetUuid ?? ''), Number(b.c2s_position ?? 0)); break }
  }
  return baseResp()
})

handlers.set(KICK_OUT_GUILD_REQ, (s, b) => {
  for (const g of listGuilds()) {
    if (g.leaderUuid === s.roleUuid) { kickMember(s.roleUuid, String(b.c2s_targetUuid ?? ''), g.uuid); break }
  }
  return baseResp()
})

// ---------------- M3: Union subsystems ----------------

handlers.set(GUILD_HUNTER_INFO_REQ, (s) => {
  const info = getUnionInfo(s.roleUuid) as any
  return { ...baseResp(), s2c_bossInfos: [], s2c_myDamage: 0, ...(info ?? {}) }
})

handlers.set(GUILD_HUNTER_BATTLE_REQ, (s, b) => {
  startUnionBattle(s.roleUuid, 'hunting')
  return baseResp()
})

handlers.set(GUILD_WARRIOR_TREASURE_INFO_REQ, (s) => {
  const info = getUnionInfo(s.roleUuid) as any
  return { ...baseResp(), s2c_overView: null, ...(info ?? {}) }
})

// ---------------- M2: Sign-in ----------------

const signInState = new Map<string, { days: Set<number>; loginDay: number; round: number }>()

handlers.set(LOGIN_SIGN_INFO_REQ, (s) => {
  let st = signInState.get(s.roleUuid)
  if (!st) { st = { days: new Set(), loginDay: 1, round: 1 }; signInState.set(s.roleUuid, st) }
  const signData: Record<string, boolean> = {}
  for (let d = 1; d <= 7; d++) signData[String(d)] = st.days.has(d)
  return { ...baseResp(), s2c_signData: signData, s2c_sevenReward: st.days.size >= 7, s2c_loginDay: st.loginDay, s2c_round: st.round }
})

handlers.set(LOGIN_SIGN_REWARD_REQ, async (s, b, sock) => {
  let st = signInState.get(s.roleUuid)
  if (!st) { st = { days: new Set(), loginDay: 1, round: 1 }; signInState.set(s.roleUuid, st) }
  const day = Number(b.c2s_day ?? 1)
  if (st.days.has(day)) return baseResp(400, 'ALREADY_SIGNED')
  st.days.add(day)
  st.loginDay = Math.max(st.loginDay, day)
  if (st.days.size >= 7) { st.days.clear(); st.round++ }
  const rewards = [
    { type: 'gold' as const, qty: 200 * day },
    { type: 'diamond' as const, qty: 10 * day },
  ]
  try {
    const res = await dispatchRewards(db, s.roleUuid, rewards, 'sign_in')
    pushCommonNotify(sock, res.deltas, rewards)
  } catch (e: any) { log.error({ err: e.message }, 'sign-in rewards failed') }
  return baseResp()
})

// ---------------- M3: Chat mute state ----------------

handlers.set(CHAT_MUTE_STATE_REQ, (s) => ({
  ...baseResp(),
  s2c_HasMuted: isMuted(s.roleUuid),
  s2c_IsMuteForever: false,
  s2c_MuteTimeStamps: 0n,
}))

// ---------------- Push helpers ----------------

function pushCommonNotify(sock: Socket, deltas: Record<string, number>, rewards: Array<{ type: string; id?: number; qty: number }>) {
  const proto = getProtocolById(COMMON_NOTIFY)
  if (!proto) return
  // s2c_roleDatas: MAP<S32,S32> currency deltas. Key mapping (assumption, see docs/wbs.md §5):
  // 1=gold 2=diamond 3=exp — matches _enum.lua RoleDataType ordering.
  const KEY: Record<string, number> = { gold: 1, diamond: 2, exp: 3 }
  const roleDatas: Record<string, number> = {}
  for (const [k, v] of Object.entries(deltas)) {
    if (KEY[k] != null) roleDatas[String(KEY[k])] = v
  }
  const gainItems = rewards.filter(r => r.type === 'item' && r.id != null).map(r => ({
    ItemId: r.id ?? 0, ItemType: 0, Count: r.qty, HeroRare: 0, HeroLevel: 0,
    WeaponRace: 0, PackageType: 0, WeaponLevel: 0,
  }))
  const obj: Record<string, unknown> = {
    s2c_gainItemsReason: 0,
    s2c_gainItems: gainItems,
    s2c_roleDatas: roleDatas,
    s2c_roleDatas64: {},
    s2c_itemsUpdate: [], s2c_itemsDelete: [],
    s2c_heroUpdates: [], s2c_herosDelete: [],
    s2c_equipsUpdate: [], s2c_equipsDelete: [],
    s2c_relicItems: {}, s2c_relicDelete: {},
    s2c_artifactsUpdate: [], s2c_mercenaryUseMap: {},
    s2c_heroBufUpdates: [],
    Empty: gainItems.length === 0 && Object.keys(roleDatas).length === 0,
  }
  sock.write(encodeFrame({
    pkgType: PackageType.PKG_MESSAGE,
    msgType: MessageType.MSG_NOTIFY,
    route: COMMON_NOTIFY,
    payload: encodeBody(proto, obj),
  }))
}

// ---------------- Frame loop ----------------

function sendResponse(sock: Socket, sendId: number, reqRoute: number, obj: Record<string, unknown>) {
  const respRoute = responseIdFor(reqRoute)
  if (respRoute == null) {
    log.warn({ reqRoute: `0x${reqRoute.toString(16)}` }, 'no response protocol paired; skipping reply')
    return
  }
  const proto = getProtocolById(respRoute)
  if (!proto) {
    log.warn({ respRoute: `0x${respRoute.toString(16)}` }, 'response protocol not in registry')
    return
  }
  sock.write(encodeFrame({
    pkgType: PackageType.PKG_MESSAGE,
    msgType: MessageType.MSG_RESPONSE_S2C,
    sendId,
    route: respRoute,
    payload: encodeBody(proto, obj),
  }))
}

function handleHandshake(sock: Socket, frame: ReturnType<typeof decodeFrame>) {
  const userMsgId = frame.system?.userMessageId as number | undefined
  const user = (frame.system?.user ?? null) as Record<string, unknown> | null
  const localInfo = frame.system?.local_info as string | null
  log.info({ userMsgId, localInfo }, 'PKG_HANDSHAKE')

  const respProto = getProtocolById(ENTER_SERVER_RESP)!
  let ackObj: Record<string, unknown>
  let sessId = 0

  if (userMsgId === ENTER_SERVER_REQ && user) {
    const token = String(user.c2s_token ?? '')
    const accountUuid = String(user.c2s_accountUUID ?? '')
    const row = db.prepare(`SELECT account_uuid, session_id FROM sessions WHERE token = ? AND expires_at > ?`)
      .get(token, Math.floor(Date.now() / 1000)) as any
    if (row) {
      sessId = Number(row.session_id) || Math.floor(Math.random() * 1e9)
      sessions.set(sock, { accountUuid: row.account_uuid, roleUuid: '', sessionId: sessId, handshakeAt: Date.now() })
      ackObj = { ...baseResp(), s2c_sessionId: sessId }
    } else {
      ackObj = { ...baseResp(401, 'INVALID_TOKEN'), s2c_sessionId: 0 }
    }
  } else {
    // handshake without valid EnterServer payload — accept with code 400 so client surfaces error
    ackObj = { ...baseResp(400, 'BAD_HANDSHAKE'), s2c_sessionId: 0 }
  }

  sock.write(encodeFrame({
    pkgType: PackageType.PKG_HANDSHAKE_ACK,
    tokenProto: respProto,
    tokenObj: ackObj,
    system: { remote_info: 'art-project-backend/1.0', heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS },
  }))
  if (ackObj.s2c_code === 401 || ackObj.s2c_code === 400) {
    // Kick after ack so client can read the error token
    setTimeout(() => {
      try {
        sock.write(encodeFrame({ pkgType: PackageType.PKG_KICK, system: { reason: 'AUTH_FAILED' } }))
        sock.end()
      } catch { /* already closed */ }
    }, 50)
  }
}

function handleMessage(sock: Socket, frame: ReturnType<typeof decodeFrame>) {
  const s = sessions.get(sock)
  if (!s) {
    log.warn({ route: frame.route }, 'message before handshake; kicking')
    sock.write(encodeFrame({ pkgType: PackageType.PKG_KICK, system: { reason: 'NO_SESSION' } }))
    sock.end()
    return
  }
  const proto = getProtocolById(frame.route)
  if (!proto) {
    log.warn({ route: `0x${frame.route.toString(16)}` }, 'unknown route')
    return
  }
  // Per-role message rate limit (cross-cutting, WBS M4-RAT)
  const rl = checkRateLimit(`${s.roleUuid || s.accountUuid}:${proto.shortName}`, 120, 60)
  if (!rl.allowed) {
    sendResponse(sock, frame.sendId, frame.route, baseResp(429, 'RATE_LIMITED'))
    return
  }
  let body: Record<string, unknown> = {}
  try {
    if (proto.fields.length > 0) body = decodeBody(proto, frame.payload)
  } catch (e: any) {
    log.error({ route: proto.shortName, err: e.message }, 'body decode failed')
    sendResponse(sock, frame.sendId, frame.route, baseResp(400, 'DECODE_ERROR'))
    return
  }
  log.info({ route: proto.shortName, sendId: frame.sendId }, 'REQ')
  tcpMessages({ route: proto.shortName, result: 'ok' })

  const fn = handlers.get(frame.route)
  const finish = (obj: Record<string, unknown>) => sendResponse(sock, frame.sendId, frame.route, obj)

  if (!fn) {
    // Unimplemented protocol: wire-valid base response (s2c_code=200) so client doesn't hang.
    const respProto = responseIdFor(frame.route) != null ? getProtocolById(responseIdFor(frame.route)!) : undefined
    if (respProto) {
      const stub: Record<string, unknown> = { ...baseResp() }
      // Fill non-base fields with wire-safe defaults derived from the response schema
      for (const f of respProto.fields) {
        if (f.name in stub) continue
        stub[f.name] = defaultFor(f.kind)
      }
      finish(stub)
    }
    return
  }
  try {
    const r = fn(s, body, sock)
    if (r instanceof Promise) {
      r.then(finish).catch((e: any) => {
        log.error({ route: proto.shortName, err: e.message }, 'async handler error')
        finish(baseResp(500, 'INTERNAL'))
      })
    } else {
      finish(r)
    }
  } catch (e: any) {
    log.error({ route: proto.shortName, err: e.message, stack: e.stack }, 'handler error')
    finish(baseResp(500, 'INTERNAL'))
  }
}

function defaultFor(kind: string): unknown {
  switch (kind) {
    case 'S32': case 'U8': case 'Enum8': case 'F32': case 'F64': return 0
    case 'S64': case 'DateTime': case 'TimeSpan': return 0n
    case 'Bool': return false
    case 'UTF': return ''
    case 'OBJ': return null
    case 'LIST': case 'ARRAY': return []
    case 'MAP': return {}
    default: return null
  }
}

const server = createServer((sock) => {
  let buf = Buffer.alloc(0)
  tcpConnections({}, sessions.size + 1)
  log.info({ remote: sock.remoteAddress }, 'TCP connected')
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 4) return
      const pkgLen = buf[1] | (buf[2] << 8) | (buf[3] << 16)
      if (buf.length < 4 + pkgLen) return
      const frameBuf = buf.subarray(0, 4 + pkgLen)
      buf = buf.subarray(4 + pkgLen)
      let frame
      try {
        frame = decodeFrame(Buffer.from(frameBuf))
      } catch (e: any) {
        log.error({ err: e.message }, 'frame decode failed; dropping connection')
        sock.destroy()
        return
      }
      try {
        switch (frame.pkgType) {
          case PackageType.PKG_HANDSHAKE: handleHandshake(sock, frame); break
          case PackageType.PKG_MESSAGE: handleMessage(sock, frame); break
          case PackageType.PKG_HEARTBEAT:
            sock.write(encodeFrame({ pkgType: PackageType.PKG_HEARTBEAT }))
            break
          default:
            log.warn({ pkgType: frame.pkgType }, 'unsupported pkg type')
        }
      } catch (e: any) {
        log.error({ err: e.message, stack: e.stack }, 'frame handling error')
      }
    }
  })
  sock.on('close', () => { sessions.delete(sock); tcpConnections({}, sessions.size) })
  sock.on('error', (e) => log.error({ err: e.message }, 'socket error'))
})

// Register broadcaster for push-scheduler + start maintenance jobs (M4-PUS)
setBroadcaster((roleUuid, route, payloadObj) => {
  const proto = getProtocolById(route)
  if (!proto) return
  for (const [sock, sess] of sessions) {
    if (roleUuid != null && sess.roleUuid !== roleUuid) continue
    try {
      sock.write(encodeFrame({
        pkgType: PackageType.PKG_MESSAGE,
        msgType: MessageType.MSG_NOTIFY,
        route,
        payload: encodeBody(proto, payloadObj),
      }))
    } catch { /* socket gone */ }
  }
})
startPushScheduler(db)

server.listen(PORT, config.tcp.host, () => {
  health.tcpListening = true
  log.info(`TCP game server (DeepCore/Pomelo binary) listening on ${config.tcp.host}:${PORT}`)
})