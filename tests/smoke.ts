// Smoke test — verifies lib engines + the new DeepCore-compatible codec.
// Run: node --import tsx tests/smoke.ts
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from '../db/migrations/run.js'
import { dispatchRewards } from '../lib/rewards.js'
import { IssueSeed, resolveBot } from '../lib/battle-arbitrator.js'
import { generateMaze } from '../lib/maze-engine.js'
import { getCurrentSeason } from '../lib/arena-engine.js'
import { createGuild } from '../lib/guild-engine.js'
import { isMuted, mute, getForbiddenWordCount } from '../lib/chat-engine.js'
import { placeOrder, checkOrder } from '../lib/pay.js'
import { isAdmin } from '../lib/gm-admin.js'
import { checkRateLimit, RL } from '../lib/rate-limit.js'
import { startRogue } from '../lib/rogue-engine.js'
import { queryTower } from '../lib/tower-engine.js'
import {
  BinaryReader, BinaryWriter, encodeBody, decodeBody, encodeFrame, decodeFrame,
  PackageType, MessageType, getProtocolById, responseIdFor,
} from '../shared/proto/codec.js'
import '../shared/proto/registry.js'

let pass = 0, fail = 0
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}`) }
}

console.log('=== 1. Codec primitives (DeepCore wire format) ===')
const w = new BinaryWriter()
w.writeS32(0x12345678)
const b = w.getBuffer()
ok('S32 little-endian', b[0] === 0x78 && b[1] === 0x56 && b[2] === 0x34 && b[3] === 0x12)

const w2 = new BinaryWriter()
w2.writeUTF('ab')
const b2 = w2.getBuffer()
ok('UTF s16-count + utf16le', b2.length === 6 && b2.readInt16LE(0) === 2 && b2.toString('utf16le', 2) === 'ab')

const w3 = new BinaryWriter()
w3.writeS32(-5); w3.writeUTF('héllo'); w3.writeBool(true); w3.writeS64(9007199254740993n); w3.writeF64(1.5)
const r3 = new BinaryReader(w3.getBuffer())
ok('scalar roundtrip', r3.getS32() === -5 && r3.getUTF() === 'héllo' && r3.getBool() === true && r3.getS64() === 9007199254740993n && r3.getF64() === 1.5)

console.log('=== 2. Registry (real Lua corpus) ===')
const seedReq = getProtocolById(0x00035201)
ok('registry has FightRandomSeedRequest', seedReq?.shortName === 'ClientFightRandomSeedRequest')
ok('response pairing 0x35201->0x35202', responseIdFor(0x00035201) === 0x00035202)

console.log('=== 3. Body encode/decode roundtrip (FightRandomSeedResponse) ===')
const respProto = getProtocolById(0x00035202)!
const obj: Record<string, unknown> = {
  s2c_code: 200, s2c_msg: 'ok', InnerResponse: null, s2c_notifys: [],
  RandomUuid: 'uuid-123', UpdateFightMod: 1, UpdateStageId: 100,
  NeedFightDamage: 0, NeedFightReplay: 0, RandomSeed: 12345,
  DifficultyRank: 2, Stage_dynamic_difficulty: 2, Battle_check_realpwoer: 1,
}
const encoded = encodeBody(respProto, obj)
const decoded = decodeBody(respProto, encoded)
ok('body roundtrip', decoded.RandomUuid === 'uuid-123' && decoded.RandomSeed === 12345 && decoded.s2c_code === 200)

console.log('=== 4. Frame encode/decode ===')
const frame = encodeFrame({ pkgType: PackageType.PKG_MESSAGE, msgType: MessageType.MSG_RESPONSE_S2C, sendId: 42, route: 0x35202, payload: encoded })
const df = decodeFrame(frame)
ok('frame roundtrip', df.pkgType === 4 && df.msgType === 2 && df.sendId === 42 && df.route === 0x35202)
const dfBody = decodeBody(respProto, df.payload)
ok('frame body intact', dfBody.RandomSeed === 12345)

console.log('=== 5. DB migrations + battle arbitrator (persisted) ===')
const db = new DatabaseSync(':memory:')
runMigrations(db)
const seed = IssueSeed(db, 'role-1', 1, 100, 5000)
ok('IssueSeed returns uuid+seed', !!seed.s2c_randomUuid && seed.s2c_randomSeed >= 0)
const settled = resolveBot(db, 'role-1', seed.s2c_randomUuid, 5000)
ok('resolveBot win', settled.ok === true && Array.isArray(settled.rewards))
const bad = resolveBot(db, 'role-1', seed.s2c_randomUuid, 5000)
ok('resolveBot replay-guard', bad.ok === false && bad.reason === 'INVALID_UUID')

console.log('=== 6. dispatchRewards ===')
db.prepare(`INSERT INTO accounts(account_uuid,platform,account,created_at) VALUES ('a','0','guest',0)`).run()
db.prepare(`INSERT INTO roles(account_uuid,server_id,role_uuid,name,level,gold,diamond,battle_power) VALUES ('a','s1','role-1','P',1,0,0,5000)`).run()
await dispatchRewards(db, 'role-1', [{ type: 'gold', qty: 100 }, { type: 'diamond', qty: 10 }], 'test')
const row = db.prepare(`SELECT gold,diamond FROM roles WHERE role_uuid='role-1'`).get() as any
ok('rewards applied', row.gold === 100 && row.diamond === 10)

console.log('=== 7. Other engines ===')
ok('maze', generateMaze('role-1', 0).tiles.length > 0)
ok('arena season', typeof getCurrentSeason() === 'number')
const g = createGuild(db, 'role-1', 'MyGuild', 'hi')
ok('guild create', !!g.uuid && g.name === 'MyGuild')
ok('forbidden words', getForbiddenWordCount() > 0)
mute('role-1', 60, 'spam')
ok('mute blocks', isMuted('role-1') === true)
const o = placeOrder('role-1', 'gold100', 100)
ok('placeOrder', !!o.s2c_orderId)
ok('checkOrder', checkOrder(o.s2c_orderId).s2c_status === 0)
ok('isAdmin gate', isAdmin('admin-x') === true && isAdmin('user-x') === false)
ok('rateLimit', checkRateLimit('k1', RL.TCP_CHAT.max, RL.TCP_CHAT.windowSec).allowed === true)
ok('rogue', (startRogue('role-1', 1, 0) as any).ok !== false)
ok('tower', typeof queryTower('role-1') === 'object')

console.log(`\n=== RESULT: ${pass} pass, ${fail} fail ===`)
process.exit(fail ? 1 : 0)
