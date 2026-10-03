// smoke.ts — exhaustive unit/functional smoke test for every lib/* engine.
// Run: node --import tsx tests/smoke.ts

import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from '../db/migrations/run.js'
import {
  BinaryReader, BinaryWriter, encodeBody, decodeBody, encodeFrame, decodeFrame,
  PackageType, MessageType, getProtocolById, responseIdFor,
} from '../shared/proto/codec.js'
import '../shared/proto/registry.js'
import { dispatchRewards } from '../lib/rewards.js'
import { IssueSeed, resolveBot } from '../lib/battle-arbitrator.js'
import { generateMaze, optGrid, useMazeItem, getGridInfo } from '../lib/maze-engine.js'
import { startSeason, getCurrentSeason, getSeason, getRankings, findOpponent, updateScore, listSeasons } from '../lib/arena-engine.js'
import { startDungeon, sweepDungeon, endDungeon, getDungeonStageReward } from '../lib/dungeon-engine.js'
import { startRogue, combatRogue, granary, gainRelic } from '../lib/rogue-engine.js'
import { queryTower, queryTowerLevel, getVipReward, loadVipRewards } from '../lib/tower-engine.js'
import { startUnionBattle, endUnionBattle, getUnionInfo } from '../lib/union-subsystems.js'
import { isActivityOpen, getActivityState, ACTIVITY_OPEN_WINDOWS } from '../lib/activity-engine.js'
import { sendAndStore, listMessages, isMuted, mute, unmute, getForbiddenWordCount } from '../lib/chat-engine.js'
import { createGuild, joinGuild, leaveGuild, loadGuild, listGuilds, applyToGuild, searchGuild, changeGuildNotice, changeGuildPosition } from '../lib/guild-engine.js'
import { placeOrder, checkOrder, syncOrder, handleSdkCallback } from '../lib/pay.js'
import { isAdmin, execGmCommand } from '../lib/gm-admin.js'
import { checkRateLimit, RL } from '../lib/rate-limit.js'
import { startPushScheduler, setBroadcaster, stopPushScheduler, pushCommonNotify, _timerCount, logPush } from '../lib/push-scheduler.js'

let pass = 0, fail = 0
const FAILED: Array<{ section: string; cond: boolean; name: string; info: string }> = []
function ok(name: string, cond: boolean, label = '', info = '') {
  if (cond) { pass++; console.log(`  PASS ${label ? '['+label+'] ' : ''}${name}${info ? ' (' + info + ')' : ''}`) }
  else { fail++; FAILED.push({ section: label, name, cond, info }); console.log(`  FAIL ${label ? '['+label+'] ' : ''}${name}${info ? ' ('+info + ')' : ''}`) }
}

function newDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  runMigrations(db)
  db.prepare(`INSERT INTO accounts(account_uuid, platform, account, created_at) VALUES ('a','0','g',0)`).run()
  db.prepare(`INSERT INTO roles(account_uuid, server_id, role_uuid, name, level, gold, diamond, battle_power) VALUES ('a','s1','r1','r1',1,0,0,1000)`).run()
  db.prepare(`INSERT INTO sessions(account_uuid, session_id, token, expires_at) VALUES ('a','1','tok',strftime('%s','now')+86400)`).run()
  return db
}

console.log('=== 1. codec primitives ===')
{
  const w = new BinaryWriter(); w.writeS32(0x12345678)
  const b = w.getBuffer()
  ok('S32 little-endian', b[0] === 0x78 && b[3] === 0x12, 'codec', `bytes=${b.toString('hex')}`)
  const w2 = new BinaryWriter(); w2.writeUTF('ab')
  const b2 = w2.getBuffer()
  ok('UTF = s16 + utf16le', b2.length === 6 && b2.readInt16LE(0) === 2 && b2.toString('utf16le', 2) === 'ab', 'codec')
  const w3 = new BinaryWriter()
  w3.writeS32(-5); w3.writeUTF('héllo'); w3.writeBool(true); w3.writeS64(9007199254740993n); w3.writeF64(1.5); w3.writeU8(7)
  const r3 = new BinaryReader(w3.getBuffer())
  ok('all scalars roundtrip',
    r3.getS32() === -5 && r3.getUTF() === 'héllo' && r3.getBool() === true &&
    r3.getS64() === 9007199254740993n && r3.getF64() === 1.5 && r3.getU8() === 7, 'codec')
  const w4 = new BinaryWriter(); w4.writeS32(-1)
  ok('OBJ null = S32(-1)', new BinaryReader(w4.getBuffer()).getS32() === -1, 'codec')
}

console.log('\n=== 2. registry + body roundtrip ===')
{
  const seedReq = getProtocolById(0x00035201)
  ok('FightRandomSeedRequest registered', seedReq?.shortName === 'ClientFightRandomSeedRequest', 'registry')
  ok('response pairing 0x35201->0x35202', responseIdFor(0x00035201) === 0x00035202, 'registry')
  const respProto = getProtocolById(0x00035202)!
  const obj: Record<string, unknown> = {
    s2c_code: 200, s2c_msg: 'ok', InnerResponse: null, s2c_notifys: [],
    RandomUuid: 'u-1', UpdateFightMod: 1, UpdateStageId: 100,
    NeedFightDamage: 0, NeedFightReplay: 0, RandomSeed: 42,
    DifficultyRank: 2, Stage_dynamic_difficulty: 2, Battle_check_realpwoer: 1,
  }
  const decoded = decodeBody(respProto, encodeBody(respProto, obj))
  ok('body roundtrip 13-field w/ OBJ+LIST',
    decoded.RandomUuid === 'u-1' && decoded.RandomSeed === 42 && decoded.s2c_code === 200, 'registry')
  const frame = encodeFrame({ pkgType: PackageType.PKG_MESSAGE, msgType: MessageType.MSG_NOTIFY, route: 0x35001, payload: encodeBody(respProto, obj) })
  const f = decodeFrame(frame)
  ok('frame MSG_NOTIFY decode', f.pkgType === 4 && f.msgType === 0 && f.route === 0x35001, 'registry')
}

console.log('\n=== 3. DB migrations + battle-arbitrator ===')
{
  const db = newDb()
  const seed = IssueSeed(db, 'r1', 1, 100, 5000)
  ok('IssueSeed ok', !!seed.s2c_randomUuid && seed.s2c_randomSeed >= 0, 'battle')
  const win = resolveBot(db, 'r1', seed.s2c_randomUuid, 5000)
  ok('resolveBot win', win.ok === true && Array.isArray(win.rewards), 'battle')
  const replay = resolveBot(db, 'r1', seed.s2c_randomUuid, 5000)
  ok('replay guard', replay.ok === false && replay.reason === 'INVALID_UUID', 'battle')
  const seed2 = IssueSeed(db, 'r1', 1, 100, 5000)
  const drift = resolveBot(db, 'r1', seed2.s2c_randomUuid, 6000)
  ok('power drift rejected', drift.ok === false && drift.reason === 'POWER_DRIFT', 'battle')
  const bad = resolveBot(db, 'r1', 'bogus-uuid', 5000)
  ok('INVALID_UUID rejected', bad.ok === false && bad.reason === 'INVALID_UUID', 'battle')
}

console.log('\n=== 4. rewards ===')
{
  const db = newDb()
  const dr = await dispatchRewards(db, 'r1', [{ type: 'gold', qty: 100 }, { type: 'diamond', qty: 10 }, { type: 'exp', qty: 50 }, { type: 'item', id: 100, qty: 1 }], 'smoke')
  ok('gold/diamond/exp deltas',
    dr.deltas.gold === 100 && dr.deltas.diamond === 10 && dr.deltas.exp === 50, 'rewards')
  ok('item_100 in deltas', dr.deltas['item_100'] === 1, 'rewards')
  const row = db.prepare(`SELECT gold, diamond, exp FROM roles WHERE role_uuid='r1'`).get() as any
  ok('DB row reflects deltas', row.gold === 100 && row.diamond === 10 && row.exp === 50, 'rewards')
  try {
    await dispatchRewards(db, 'r1', [{ type: 'gold', qty: 200_000_000 }], 'smoke')
    ok('sanity cap rejects huge currency', false, 'rewards')
  } catch (e: any) {
    ok('sanity cap rejects huge currency', /cap|exceed/i.test(e.message), 'rewards', e.message.slice(0, 60))
  }
}

console.log('\n=== 5. chat-engine ===')
{
  ok('forbidden-word list loaded', getForbiddenWordCount() > 0, 'chat', `count=${getForbiddenWordCount()}`)
  const sendRes = sendAndStore('r1', 'world', 'hello world')
  ok('sendAndStore ok', sendRes.ok === true, 'chat')
  const filtered = sendAndStore('r1', 'world', 'this contains badword1')
  ok('forbidden word filtered', filtered.ok === false, 'chat', `reason=${JSON.stringify(filtered)}`)
  mute('r1', 60, 'test')
  ok('mute blocks', isMuted('r1') === true, 'chat')
  const whileMuted = sendAndStore('r1', 'world', 'hi')
  ok('muted user cannot send', whileMuted.ok === false && whileMuted.reason === 'MUTED', 'chat')
  unmute('r1')
  ok('unmute restores', isMuted('r1') === false, 'chat')
  const hist = listMessages('world', Math.floor(Date.now() / 1000), 10)
  ok('listMessages returns history', hist.s2c_messages !== undefined, 'chat')
}

console.log('\n=== 6. guild-engine ===')
{
  const db = newDb()
  const g1 = createGuild(db, 'r1', 'FirstGuild', 'hi')
  const g2 = createGuild(db, 'r1', 'SecondGuild', 'hi')
  ok('createGuild ok', !!g1.uuid && g1.name === 'FirstGuild', 'guild')
  ok('listGuilds >= 2', listGuilds().length >= 2, 'guild')
  ok('searchGuild by name prefix', searchGuild('First').s2c_guilds.some((g: any) => g.name === 'FirstGuild'), 'guild')
  joinGuild('r1', g2.uuid)
  leaveGuild('r1', g2.uuid)
  changeGuildNotice('r1', g1.uuid, 'updated notice')
  const reloaded = loadGuild('r1', g1.uuid)
  ok('changeGuildNotice persisted', reloaded?.notice === 'updated notice', 'guild')
  changeGuildPosition('r1', g1.uuid, 'r1', 2)
  ok('changeGuildPosition did not throw', true, 'guild')
}

console.log('\n=== 7. arena-engine ===')
{
  startSeason(99, 7 * 24 * 3600)
  const sid = 99
  ok('startSeason stores season (getSeason ok)', getSeason(sid)?.id === sid, 'arena')
  ok('getCurrentSeason returns active id', getCurrentSeason() !== null, 'arena')
  const gs = getSeason(sid)
  ok('getSeason ok', gs?.id === sid, 'arena')
  const sid2 = 999
  startSeason(sid2, 7 * 24 * 3600)
  updateScore('r1', sid2, 100)
  updateScore('r2', sid2, 200)
  const ranks = getRankings(sid2)
  ok('getRankings returns sorted (r2 first)', ranks.length >= 2 && ranks[0].roleUuid === 'r2' && ranks[1].roleUuid === 'r1', 'arena')
  const opp = findOpponent('r1', sid2, 5)
  ok('findOpponent returns opponents', opp.s2c_opponents !== undefined, 'arena')
  ok('listSeasons has at least 1', listSeasons().length >= 1, 'arena')
}

console.log('\n=== 8. maze-engine ===')
{
  const m = generateMaze('r1', 0)
  ok('layout has tiles', m.tiles.length > 0, 'maze')
  ok('layout has dimensions', m.width > 0 && m.height > 0, 'maze')
  const opt = optGrid('r1', 0, 'reveal')
  ok('optGrid returns object', typeof opt === 'object' && opt !== null, 'maze')
  const use = useMazeItem('r1', 1)
  ok('useMazeItem ok', typeof use.ok === 'boolean', 'maze')
  const info = getGridInfo('r1', 0)
  ok('getGridInfo ok', info !== undefined, 'maze')
}

console.log('\n=== 9. dungeon-engine ===')
{
  const db = newDb()
  ok('startDungeon ok', startDungeon(db, 'r1', 'gold', 100).ok === true, 'dungeon')
  ok('sweepDungeon ok', (await sweepDungeon(db, 'r1', 'gold', 3)).ok === true, 'dungeon')
  ok('endDungeon (win) ok', (await endDungeon(db, 'r1', 'gold', 100, true)).ok === true, 'dungeon')
  const reward = getDungeonStageReward(100)
  ok('stage reward has shape', typeof reward.s2c_reward === 'object', 'dungeon')
}

console.log('\n=== 10. rogue-engine ===')
{
  const db = newDb()
  ok('startRogue ok', startRogue('r1', 1, 0).ok === true, 'rogue')
  ok('combatRogue ok', typeof combatRogue('r1', 3, 4).ok === 'boolean', 'rogue')
  ok('gainRelic ok', typeof gainRelic('r1', 5, 5).ok === 'boolean', 'rogue')
  ok('granary collect ok', typeof granary('r1', 1, 'collect', 1, 10).ok === 'boolean', 'rogue')
}

console.log('\n=== 11. tower-engine ===')
{
  ok('queryTower returns object', typeof queryTower('r1') === 'object', 'tower')
  ok('queryTowerLevel returns object', typeof queryTowerLevel('r1') === 'object', 'tower')
  ok('getVipReward returns rewards', Array.isArray(getVipReward('r1', 3).s2c_rewards), 'tower')
  const lvr = loadVipRewards('r1')
  ok('loadVipRewards ok', lvr.ok === true && Array.isArray(lvr.s2c_levels), 'tower')
}

console.log('\n=== 12. union-subsystems ===')
{
  ok('startUnionBattle ok', startUnionBattle('g-uuid', 'hunting').ok === true, 'union')
  ok('endUnionBattle ok', endUnionBattle('g-uuid', 'hunting', true, 100).ok === true, 'union')
  ok('getUnionInfo ok', typeof getUnionInfo('g-uuid') === 'object', 'union')
}

console.log('\n=== 13. activity-engine ===')
{
  ok(`open windows defined: ${ACTIVITY_OPEN_WINDOWS.length}`, ACTIVITY_OPEN_WINDOWS.length >= 1, 'activity')
  ok('isActivityOpen returns boolean', typeof isActivityOpen('login_sign' as any) === 'boolean', 'activity')
  ok('getActivityState returns state', typeof getActivityState('r1', 'login_sign' as any) === 'object', 'activity')
}

console.log('\n=== 14. pay + SDK signatures ===')
{
  const db = newDb()
  const o = placeOrder('r1', 'gold100', 100)
  ok('placeOrder returns orderId', typeof o.s2c_orderId === 'string' && o.s2c_orderId.length > 0, 'pay')
  ok('checkOrder for known order = status 0', checkOrder(o.s2c_orderId).s2c_status === 0, 'pay')
  syncOrder(o.s2c_orderId, 1)
  ok('checkOrder after syncOrder(status 1)', checkOrder(o.s2c_orderId).s2c_status === 1, 'pay')
  ok('checkOrder for unknown = -1', checkOrder('not-real').s2c_status === -1, 'pay')
  const payload = Buffer.from(JSON.stringify({ orderId: o.s2c_orderId, amount: 100 }))
  const bad = await handleSdkCallback(db, 'quick', payload, 'wrong-sig')
  ok('handleSdkCallback rejects bad signature', bad.ok === false, 'pay')
  const crypto = await import('node:crypto')
  const goodSig = crypto.createHmac('md5', 'dev-quick-app-key').update(payload).digest('hex')
  const good = await handleSdkCallback(db, 'quick', payload, goodSig)
  ok('handleSdkCallback accepts correct signature', good.ok === true, 'pay')
}

console.log('\n=== 15. gm-admin ===')
{
  const db = newDb()
  ok('isAdmin("admin-x") === true', isAdmin('admin-x') === true, 'gm')
  ok('isAdmin("user-x") === false', isAdmin('user-x') === false, 'gm')
  ok('isAdmin("") === false', isAdmin('') === false, 'gm')
  const inspect = await execGmCommand(db, 'admin-cli', 'inspect', ['r1'])
  ok('inspect r1 returns role', inspect.ok === true && (inspect.result as any)?.role_uuid === 'r1', 'gm')
  const notAdmin = await execGmCommand(db, 'user-x', 'inspect', ['r1'])
  ok('non-admin rejected', notAdmin.ok === false && notAdmin.reason === 'NOT_ADMIN', 'gm')
  const unknownCmd = await execGmCommand(db, 'admin-cli', 'whoisthis', [])
  ok('unknown cmd rejected', unknownCmd.ok === false && unknownCmd.reason === 'UNKNOWN_CMD', 'gm')
  const audit = db.prepare(`SELECT admin_user, action_taken FROM gm_log ORDER BY id DESC LIMIT 1`).get() as any
  ok('gm_log row persisted', audit && audit.admin_user.length > 0, 'gm')
}

console.log('\n=== 16. rate-limit ===')
{
  const key = 'test-' + Math.random()
  const r1 = checkRateLimit(key, 2, 60)
  ok('first call allowed', r1.allowed === true, 'rate-limit')
  const r2 = checkRateLimit(key, 2, 60)
  ok('second call allowed', r2.allowed === true, 'rate-limit')
  const r3 = checkRateLimit(key, 2, 60)
  ok('third call blocked', r3.allowed === false && r3.remaining === 0, 'rate-limit')
  ok('RL table has TCP_BATTLE/CHAT/PAY', !!(RL.TCP_BATTLE && RL.TCP_CHAT && RL.TCP_PAY), 'rate-limit')
}

console.log('\n=== 17. push-scheduler ===')
{
  const db = newDb()
  ok('_timerCount starts at 0', _timerCount() === 0, 'push')
  let broadcastCalls = 0
  setBroadcaster((_roleUuid, _route, _obj) => { broadcastCalls++ })
  startPushScheduler(db)
  ok('startPushScheduler adds 5 timers', _timerCount() === 5, 'push')
  logPush(db, 'r1', 'TestPush', 1, { hello: 'world' })
  const row = db.prepare(`SELECT push_name, message_id FROM push_log ORDER BY id DESC LIMIT 1`).get() as any
  ok('logPush persisted',
    row?.push_name === 'TestPush' && row?.message_id === 1, 'push')
  pushCommonNotify(db, null, 9001)
  ok('pushCommonNotify broadcast (null role)', broadcastCalls === 1, 'push')
  pushCommonNotify(db, 'r1', 9001)
  ok('pushCommonNotify broadcast (per role)', broadcastCalls === 2, 'push')
  stopPushScheduler()
  ok('stopPushScheduler clears timers', _timerCount() === 0, 'push')
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
if (fail > 0) {
  console.log('\nFAILURES:')
  for (const f of FAILED) console.log(`  [${f.section}] ${f.name}${f.info ? ' ('+f.info+')' : ''}`)
}
process.exit(fail ? 1 : 0)
