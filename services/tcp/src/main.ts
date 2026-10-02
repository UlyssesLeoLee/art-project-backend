import { createServer, Socket } from 'node:net'
import { pino } from 'pino'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { BinaryReader, BinaryWriter, getRequest } from '../../../shared/proto/codec.js'
import '../../../shared/proto/registry.js'

const log = pino()
const DB_PATH = process.env.DB_PATH || './data/game.db'
mkdirSync(dirname(DB_PATH), { recursive: true })
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec(readFileSync('./db/migrations/001_init.sql', 'utf8'))

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

handlers.set(0x00039001, (s) => {
  const heroes = db.prepare('SELECT hero_uuid AS heroUuid, hero_id AS heroId, level, exp, rank, star, locked FROM heroes WHERE role_uuid = ?').all(s.roleUuid)
  return { s2c_heroes: heroes }
})

handlers.set(0x00035701, (s, b) => {
  const rows = db.prepare('SELECT formation_uuid AS formationUuid, type, hero_uuids AS heroUuidsJson FROM formations WHERE role_uuid = ? AND type = ?').all(s.roleUuid, b.c2s_type || 0)
  return { s2c_formations: rows.map((r: any) => ({ formationUuid: r.formationUuid, type: r.type, heroUuids: JSON.parse(r.heroUuidsJson) })) }
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
  const resp = fn ? fn(sessions.get(sock)!, body) : { s2c_code: 200, s2c_ack: true }
  const respId = respMap[mid] ?? mid
  const respProto = getRequest(respId)
  if (respProto && respProto.fields.length > 0) {
    sock.write(buildFrame(respId, encodeSimple(respProto, resp)))
  } else {
    sock.write(buildFrame(respId, Buffer.alloc(0)))
  }
}

server.listen(PORT, () => log.info(`TCP game server listening on ${PORT}`))
