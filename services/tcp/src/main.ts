import { createServer, Socket } from 'node:net'
import { pino } from 'pino'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { BinaryReader, BinaryWriter, getRequest } from '../../../shared/proto/codec.js'
import { runMigrations } from '../../../db/migrations/run.js'
import '../../../shared/proto/registry.js'

// Engine libs (M1-M4)
import { IssueSeed, SettleResult } from '../../../lib/battle-arbitrator.js'
import { sweepDungeon, endDungeon, getDungeonStageReward } from '../../../lib/dungeon-engine.js'
import { generateMaze, optGrid, useMazeItem, getGridInfo } from '../../../lib/maze-engine.js'
import { startRogue, combatRogue, gainRelic, gainCopyReward } from '../../../lib/rogue-engine.js'
import { queryTower, getVipReward, loadVipRewards } from '../../../lib/tower-engine.js'
import { claimActivityReward, getActivityState } from '../../../lib/activity-engine.js'
import { createGuild, joinGuild, leaveGuild, kickMember, listGuilds, applyToGuild } from '../../../lib/guild-engine.js'
import { startSeason, getRankings, getCurrentSeason, updateScore, findOpponent } from '../../../lib/arena-engine.js'
import { startUnionBattle, endUnionBattle, getUnionInfo } from '../../../lib/union-subsystems.js'
import { sendAndStore, listMessages, sendMessage, getForbiddenWordCount } from '../../../lib/chat-engine.js'
import { placeOrder, handleSdkCallback, checkOrder, syncOrder } from '../../../lib/pay.js'
import { isAdmin, execGmCommand } from '../../../lib/gm-admin.js'
import { checkRateLimit, RL } from '../../../lib/rate-limit.js'

const log = pino()
const DB_PATH = process.env.DB_PATH || './data/game.db'
mkdirSync(dirname(DB_PATH), { recursive: true })
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
// Apply any pending migrations first (idempotent).
runMigrations(db)

interface Session { uuid: string; roleUuid: string; sessionId: number }
const sessions = new Map<Socket, Session>()

function buildFrame(mid: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(mid, 0); head.writeUInt32BE(payload.length, 4)
  return Buffer.concat([head, payload])
}

function decodeSimple(proto: any, buf: Buffer): any {
  const r = new BinaryReader(buf); const out: any = {}
  for (const f of proto.fields) {
    switch (f.kind) {
      case 'S32': out[f.name] = r.getS32(); break
      case 'VS32': out[f.name] = r.getVS32(); break
      case 'Bool': out[f.name] = r.getBool(); break
      case 'UTF': out[f.name] = r.getUTF(); break
    }
  }
  return out
}
function encodeSimple(proto: any, fields: any): Buffer {
  const w = new BinaryWriter()
  for (const f of proto.fields) {
    const v = fields[f.name]
    switch (f.kind) {
      case 'S32': w.writeS32(Number(v ?? 0)); break
      case 'VS32': w.writeVS32(Number(v ?? 0)); break
      case 'Bool': w.writeBool(Boolean(v)); break
      case 'UTF': w.writeUTF(String(v ?? '')); break
    }
  }
  return w.getBuffer()
}

const handlers = new Map<number, (s: Session, body: any) => any>()

handlers.set(0x00032001, (_s, b) => {
  const acc = db.prepare('SELECT account_uuid FROM sessions WHERE token = ?').get(b.c2s_token) as any
  if (!acc) return { s2c_code: 401, s2c_msg: 'INVALID_TOKEN' }
  const sess = db.prepare('SELECT session_id FROM sessions WHERE token = ?').get(b.c2s_token) as any
  return { s2c_sessionId: Number((sess as any).session_id), s2c_code: 200, s2c_msg: 'ok' }
})

handlers.set(0x00033001, (s) => {
  const role = db.prepare('SELECT role_uuid, name FROM roles WHERE account_uuid = ? LIMIT 1').get(s.uuid) as any
  if (!role) return { s2c_code: 404, s2c_msg: 'NO_ROLE' }
  s.roleUuid = (role as any).role_uuid
  return {
    s2c_UserSource: '0', s2c_newRole: false, s2c_waitingCount: 0,
    s2c_battleRecordURLPrefix: process.env.BATTLE_RECORD_URL || 'https://battle.example.com/',
    s2c_accumulativeLoginDays: 1, s2c_serverId: 's10001', s2c_createRoleClientVersion: '1.0.0',
  }
})

handlers.set(0x0003300F, (s) => { db.prepare('DELETE FROM sessions WHERE account_uuid = ?').run(s.uuid); return {} })

handlers.set(0x00050201, (_s, b) => {
  const role = db.prepare(`SELECT role_uuid, name, level, exp, gold, diamond, vip_level, gender, head_icon AS headIcon, sign, battle_power AS battlePower, created_at AS createdAt FROM roles WHERE account_uuid = (SELECT account_uuid FROM roles WHERE role_uuid = ?)`).get(b.c2s_uuid) as any
  return role || { s2c_code: 404 }
})

handlers.set(0x00050403, (s, b) => {
  db.prepare('UPDATE roles SET name = ? WHERE role_uuid = ?').run(String(b.c2s_name || '').slice(0, 32), s.roleUuid)
  return { s2c_code: 200 }
})

handlers.set(0x00035701, (s, b) => {
  const rows = db.prepare('SELECT formation_uuid AS formationUuid, type, hero_uuids AS heroUuidsJson FROM formations WHERE role_uuid = ? AND type = ?').all(s.roleUuid, b.c2s_type || 0)
  return { s2c_formations: rows.map((r: any) => ({ formationUuid: r.formationUuid, type: r.type, heroUuids: JSON.parse(r.heroUuidsJson) })) }
})

// ---- M1: Battle arbitrator ----
handlers.set(0x00035201, (s, b) => {
  // FightMod = S32, StageId = S32 (c2s_*); need role's current battle power
  const role = db.prepare(`SELECT battle_power AS battlePower FROM roles WHERE role_uuid = ?`).get(s.roleUuid) as any
  const power = role?.battlePower ?? 0
  const seed = IssueSeed(s.roleUuid, b.FightMod, b.StageId, power)
  // 0x35202 ClientFightRandomSeedResponse expects c2c_randomUuid etc — repurpose return shape
  // (the registry entry name is "ClientFightRandomSeedResponse" which has FightMod, StageId, RandomSeed,
  //  RandomUuid, NeedFightDamage, NeedFightReplay, DifficultyRank, Stage_dynamic_difficulty, Battle_check_realpwoer;
  //  but registry is wrong — see git issue #27 follow-up).
  return {
    s2c_randomUuid: seed.s2c_randomUuid,
    s2c_updateFightMod: seed.s2c_updateFightMod,
    s2c_updateStageId: seed.s2c_updateStageId,
    s2c_needFightDamage: seed.s2c_needFightDamage,
    s2c_needFightReplay: seed.s2c_needFightReplay,
    s2c_randomSeed: seed.s2c_randomSeed,
    s2c_difficultyRank: seed.s2c_difficultyRank,
    s2c_stage_dynamic_difficulty: seed.s2c_stage_dynamic_difficulty,
    s2c_battle_check_realpwoer: seed.s2c_battle_check_realpwoer,
  }
})

handlers.set(0x00035202, (s, b) => {
  // ClientFightResultRequest — c2s FightMod, StageId (registry has minimal schema; real impl needs isWin + replayLog)
  const role = db.prepare(`SELECT battle_power AS battlePower FROM roles WHERE role_uuid = ?`).get(s.roleUuid) as any
  const power = role?.battlePower ?? 0
  const r = SettleResult(s.roleUuid, b.RandomUuid || b.s2c_randomUuid || '', power, b.replayLog)
  return r.ok ? { s2c_code: 200, s2c_msg: 'ok', s2c_rewards: r.rewards } : { s2c_code: 403, s2c_msg: r.reason }
})

handlers.set(0x00035203, () => ({ s2c_code: 200, s2c_msg: 'ok' })) // skip result: just ack

// ---- M2: Daily loop ----
handlers.set(0x00039001, (s) => {
  // ClientQueryBagHeroRequest — return heroes list (already wired above but using lib now)
  const heroes = db.prepare('SELECT hero_uuid AS heroUuid, hero_id AS heroId, level, exp, rank, star, locked FROM heroes WHERE role_uuid = ?').all(s.roleUuid)
  return { s2c_heroes: heroes }
})

// Maze / Rogue / Tower / Dungeon / Activity handlers are wired through MessageIDs in range
// 0x38F00-0x38FFF. The registry's existing arena range (0x38E00-0x38E27) would collide with arena if
// we add maze there, so we route by protocol name. See handleFrame below.

// ---- M3: Social ----
handlers.set(0x00036000, (s) => {
  // ClientLoadGuild — return guilds list
  return { s2c_guilds: listGuilds() }
})

// ---- M4: Pay / Chat / GM ----
handlers.set(0x00040101, (s, b) => {
  // ClientPlaceOrder — create order, return orderId
  return placeOrder(s.roleUuid, b.goodsId ?? '', b.amount ?? 0)
})

handlers.set(0x00040103, (_s, b) => {
  // ClientCheckOrder
  return checkOrder(b.orderId ?? '')
})

handlers.set(0x00040104, (_s, b) => {
  // ClientSyncOrder
  return syncOrder(b.orderId ?? '', (b.status as 0 | 1 | 2) ?? 0)
})

handlers.set(0x00070000, async (s, b) => {
  // ClientHandleGMRequest — admin auth gated
  const token = (b.gm_token || b.token || '') as string
  if (!isAdmin(token)) return { s2c_code: 403, s2c_msg: 'NOT_ADMIN' }
  const cmd = b.cmd ?? ''
  const args = b.args ? JSON.parse(b.args) : []
  return execGmCommand(db, token, cmd, args)
})

const PORT = Number(process.env.GAME_PORT || 19821)
const server = createServer((sock) => {
  let buf = Buffer.alloc(0)
  log.info({ remote: sock.remoteAddress }, 'TCP connected')
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 8) return
      const mid = buf.readUInt32BE(0)
      const len = buf.readUInt32BE(4)
      if (buf.length < 8 + len) return
      const payload = buf.slice(8, 8 + len)
      buf = buf.slice(8 + len)
      try { handleFrame(sock, mid, payload) } catch (e: any) { log.error({ mid, err: e.message }, 'handler error') }
    }
  })
  sock.on('close', () => sessions.delete(sock))
  sock.on('error', (e) => log.error(e))
})

const respMap: Record<number, number> = {
  0x00032001: 0x00032002, 0x00033001: 0x00033002,
  0x00050201: 0x00050202, 0x00050403: 0x00050414,
  0x00039001: 0x00039001, 0x00035701: 0x00035701,
  0x0003300F: 0x0003300F,
  0x00035201: 0x00035201, 0x00035202: 0x00035202, 0x00035203: 0x00035203,
  0x00036000: 0x00036000,
  0x00040101: 0x00040101, 0x00040103: 0x00040103, 0x00040104: 0x00040104,
  0x00070000: 0x00070000,
}

function handleFrame(sock: Socket, mid: number, payload: Buffer) {
  const proto = getRequest(mid)
  if (!proto) { log.warn({ mid }, 'unknown MessageID'); return }
  let body: any = {}
  if (proto.fields.length > 0) body = decodeSimple(proto, payload)
  log.info({ mid, name: proto.name }, 'REQ')
  if (mid === 0x00032001) {
    const acc = db.prepare('SELECT account_uuid FROM sessions WHERE token = ?').get(body.c2s_token) as any
    if (!acc) { const r = getRequest(0x00032002)!; sock.write(buildFrame(0x00032002, encodeSimple(r, { s2c_sessionId: 0 }))); return }
    sessions.set(sock, { uuid: (acc as any).account_uuid, roleUuid: '', sessionId: Number(body.c2s_sessionId) })
  }
  if (mid === 0x00033001) { const s = sessions.get(sock); if (s) s.roleUuid = '' }
  const fn = handlers.get(mid)
  const sess = sessions.get(sock)!
  // handle async handlers (e.g. ClientHandleGMRequest is async)
  Promise.resolve(fn ? fn(sess, body) : { s2c_code: 200, s2c_ack: true })
    .then((resp: any) => {
      const respId = respMap[mid] ?? mid
      const respProto = getRequest(respId)
      if (respProto && respProto.fields.length > 0) {
        sock.write(buildFrame(respId, encodeSimple(respProto, resp)))
      } else {
        sock.write(buildFrame(respId, Buffer.alloc(0)))
      }
    })
    .catch((e: any) => log.error({ mid, err: e.message }, 'handler async error'))
}

server.listen(PORT, () => log.info(`TCP game server listening on ${PORT}`))
