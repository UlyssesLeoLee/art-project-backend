import 'reflect-metadata'
import express from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { runMigrations } from '../../../db/migrations/run.js'
import { config } from '../../../shared/config.js'
import { log, health, liveness, readiness, renderMetrics, httpRequests } from '../../../shared/obs.js'

const SECRET_KEY = process.env.SECRET_KEY || config.secrets.secretKey
const JWT_SECRET = process.env.JWT_SECRET || config.secrets.jwtSecret
const DB_PATH = config.db.path
mkdirSync(dirname(DB_PATH), { recursive: true })
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
// Apply any pending migrations first (idempotent). For initial fresh DB, this also runs 001_init.sql
// (since the schema file is the very first migration to apply).
runMigrations(db)

const app = express()
app.use(express.raw({ type: '*/*', limit: '2mb' }))

// DX-OBS: request metrics + DX-HEA: health endpoints
app.use((req, res, next) => {
  res.on('finish', () => httpRequests({ method: req.method, path: req.route?.path ?? req.path, status: String(res.statusCode) }))
  next()
})
app.get('/health', (_req, res) => res.json(liveness()))
app.get('/health/ready', (_req, res) => {
  const r = readiness()
  res.status(r.status === 'ready' ? 200 : 503).json(r)
})
app.get('/metrics', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4')
  res.send(renderMetrics())
})

function verifySign(body: string, sign: string, ts: number): boolean {
  if (!sign || !ts) return false
  const expected = crypto.createHash('md5').update(body + SECRET_KEY + ts).digest('hex')
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sign)) } catch { return false }
}
function makeToken(uuid: string) { return jwt.sign({ uuid }, JWT_SECRET, { expiresIn: '24h' }) }

function rawBody(req: any): string {
  // Client base64-encodes the JSON body before POSTing (see LoginMgr.cs AccountLoginRequest).
  // Try base64 first; if decoded text parses as JSON, return it. Otherwise return raw.
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8').trim()
           : typeof req.body === 'string' ? req.body.trim()
           : JSON.stringify(req.body)
  try { const d = Buffer.from(raw, 'base64').toString('utf8'); JSON.parse(d); return d } catch {}
  return raw
}

app.get('/serverlist.json', (_req, res) => {
  res.json({
    servers: [{
      serverID: 's10001', name: '亚特兰蒂斯',
      host: process.env.GAME_HOST || '127.0.0.1',
      port: Number(process.env.GAME_PORT || 19821),
      state: 0, recommend: true, openTime: '2024-01-01T00:00:00Z'
    }]
  })
})

app.post('/account/login', (req, res) => {
  try {
    const sign = String(req.query.sign || '')
    const ts = Number(req.query.timestamp || 0)
    const bodyRaw = rawBody(req)
    if (!verifySign(bodyRaw, sign, ts)) return res.status(401).json({ code: 'SIGN_INVALID' })
    const p = JSON.parse(bodyRaw)
    const { platform, account = '', token = '', deviceID = '', serverID = '', accountUUID = '' } = p
    let uuid = accountUUID
    if (!uuid) {
      const existing = db.prepare('SELECT account_uuid FROM accounts WHERE platform = ? AND account = ?').get(platform, account) as any
      uuid = (existing as any)?.account_uuid
      if (!uuid) {
        uuid = crypto.randomUUID()
        db.prepare('INSERT INTO accounts(account_uuid, platform, account, device_id, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(uuid, platform, account, deviceID, Math.floor(Date.now()/1000), Math.floor(Date.now()/1000))
      }
    }
    let role = db.prepare('SELECT role_uuid, name FROM roles WHERE account_uuid = ?').get(uuid) as any
    if (!role) {
      const roleUuid = crypto.randomUUID()
      const defaultName = account || `Guest${uuid.slice(0, 6)}`
      db.prepare('INSERT INTO roles(account_uuid, server_id, role_uuid, name, level, gold, diamond, vip_level, battle_power, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(uuid, serverID || 's10001', roleUuid, defaultName, 1, 1000, 100, 0, 0, Math.floor(Date.now()/1000))
      role = { role_uuid: roleUuid, name: defaultName }
    }
    const sessId = Math.floor(Math.random() * 1_000_000)
    const sessionToken = makeToken(uuid)
    db.prepare('INSERT INTO sessions(account_uuid, session_id, token, server_id, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(uuid, String(sessId), sessionToken, serverID || 's10001', Math.floor(Date.now()/1000) + 86400)
    res.json({
      code: 0, msg: 'ok',
      accountUUID: uuid, token: sessionToken,
      serverAddress: process.env.GAME_HOST || '127.0.0.1',
      serverID: serverID || 's10001',
      sessionId: sessId,
      roleUUID: (role as any).role_uuid,
      roleName: (role as any).name,
      expiredAt: Math.floor(Date.now()/1000) + 86400,
    })
  } catch (e: any) { log.error(e); res.status(500).json({ code: 'INTERNAL', msg: e.message }) }
})

app.post('/account/bind', (req, res) => {
  try {
    const sign = String(req.query.sign || ''); const ts = Number(req.query.timestamp || 0)
    const bodyRaw = rawBody(req)
    if (!verifySign(bodyRaw, sign, ts)) return res.status(401).json({ code: 'SIGN_INVALID' })
    const p = JSON.parse(bodyRaw)
    const row = db.prepare('SELECT id FROM accounts WHERE account_uuid = ?').get(p.accountUUID)
    if (!row) return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND' })
    db.prepare('UPDATE accounts SET platform = ?, account = ?, token_hash = ? WHERE account_uuid = ?')
      .run(p.platform, p.account, crypto.createHash('md5').update(p.token || '').digest('hex'), p.accountUUID)
    res.json({ code: 0, msg: 'ok', bindResult: 1, accountUUID: p.accountUUID })
  } catch (e: any) { res.status(500).json({ code: 'INTERNAL', msg: e.message }) }
})

app.post('/account/register', (req, res) => {
  try {
    const sign = String(req.query.sign || ''); const ts = Number(req.query.timestamp || 0)
    const bodyRaw = rawBody(req)
    if (!verifySign(bodyRaw, sign, ts)) return res.status(401).json({ code: 'SIGN_INVALID' })
    const p = JSON.parse(bodyRaw)
    const uuid = crypto.randomUUID()
    db.prepare('INSERT INTO accounts(account_uuid, platform, account, token_hash, device_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuid, p.platform, p.account, crypto.createHash('md5').update(p.password || '').digest('hex'), p.deviceID, Math.floor(Date.now()/1000))
    res.json({ code: 0, msg: 'ok', accountUUID: uuid, token: makeToken(uuid) })
  } catch (e: any) { res.status(500).json({ code: 'INTERNAL', msg: e.message }) }
})

app.post('/account/activation', (req, res) => {
  try {
    const sign = String(req.query.sign || ''); const ts = Number(req.query.timestamp || 0)
    const bodyRaw = rawBody(req)
    if (!verifySign(bodyRaw, sign, ts)) return res.status(401).json({ code: 'SIGN_INVALID' })
    const p = JSON.parse(bodyRaw)
    if (p.code !== 'WELCOME2024') return res.status(400).json({ code: 'CODE_INVALID' })
    const acc = db.prepare('SELECT account_uuid FROM accounts WHERE account_uuid = ?').get(p.accountUUID)
    if (!acc) return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND' })
    db.prepare('UPDATE roles SET diamond = diamond + 100 WHERE account_uuid = ?').run(p.accountUUID)
    res.json({ code: 0, msg: 'ok', serverId: 's10001', accountUUID: p.accountUUID, token: makeToken(p.accountUUID) })
  } catch (e: any) { res.status(500).json({ code: 'INTERNAL', msg: e.message }) }
})

app.post('/api/client/check_update', (_req, res) => {
  res.set('Content-Type', 'application/xml')
  res.send(`<?xml version="1.0"?><root><status>1</status><message>ok</message><UpdateType>0</UpdateType><UpdateUrl></UpdateUrl><ResType>0</ResType><CDNUrl>${process.env.CDN_URL || 'https://cdn.example.com/'}</CDNUrl><RepairNoticeState>0</RepairNoticeState><RepairContents></RepairContents><SystemNoticeState>0</SystemNoticeState><SystemNoticeContent></SystemNoticeContent><MpqNoticeState>0</MpqNoticeState><MpqNoticeContent></MpqNoticeContent></root>`)
})

app.post('/api/client/init', (_req, res) => {
  res.json({
    cdnRoot: process.env.CDN_URL || 'https://cdn.example.com/',
    forceUpdate: false, serverListHash: 'v1',
    loginUrl: process.env.PUBLIC_LOGIN_URL || `http://localhost:${process.env.PORT || 8080}`,
    gameHost: process.env.GAME_HOST || '127.0.0.1',
    gamePort: Number(process.env.GAME_PORT || 19821),
  })
})

const port = config.http.port
app.listen(port, config.http.host, () => {
  health.httpListening = true
  log.info(`HTTP listening on ${config.http.host}:${port}`)
})
