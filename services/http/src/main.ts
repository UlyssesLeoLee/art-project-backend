// HTTP gateway — login/bind/register/activation + update/init/serverlist + ops endpoints.
//
// Security layers (issues #1-#4):
//  - #1 TLS: when config.tls.enabled (or TLS_ENABLED=true) and cert/key exist, serves HTTPS
//  - #2 rate limit: token bucket per IP on /account/* (RL.HTTP_* from lib/rate-limit.ts)
//  - #3 zod: all request bodies validated before DB access (shared/validation.ts)
//  - #4 CORS: allowlist from config.cors.origins (default '*' for dev; set CORS_ORIGINS in prod)

import 'reflect-metadata'
import express from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import https from 'node:https'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from '../../../db/migrations/run.js'
import { config } from '../../../shared/config.js'
import { log, health, liveness, readiness, renderMetrics, httpRequests } from '../../../shared/obs.js'
import { checkRateLimit, RL } from '../../../lib/rate-limit.js'
import { LoginBody, BindBody, RegisterBody, ActivationBody, parseBody } from '../../../shared/validation.js'

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
app.disable('x-powered-by')
app.use(express.raw({ type: '*/*', limit: '2mb' }))

// ---------------- #4 CORS ----------------

const CORS_ORIGINS = config.cors.origins
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGINS.includes('*') ? '*' : origin!)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    res.setHeader('Access-Control-Max-Age', '600')
  }
  if (req.method === 'OPTIONS') { res.sendStatus(204); return }
  next()
})

// ---------------- DX-OBS metrics + DX-HEA health ----------------

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

// ---------------- #2 rate limiting (/account/*) ----------------

function clientIp(req: express.Request): string {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
  return fwd || req.socket.remoteAddress || 'unknown'
}

function rateGate(bucket: { max: number; windowSec: number }) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Use originalUrl path (not req.path, which is mount-relative under app.use) so each
    // /account/* endpoint gets its own bucket.
    const path = (req.originalUrl || req.url).split('?')[0]
    const r = checkRateLimit(`http:${clientIp(req)}:${path}`, bucket.max, bucket.windowSec)
    if (!r.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, r.resetAt - Math.floor(Date.now() / 1000))))
      res.status(429).json({ code: 'RATE_LIMITED', msg: 'too many requests' })
      return
    }
    next()
  }
}

app.use('/account/login', rateGate(RL.HTTP_LOGIN))
app.use('/account/register', rateGate(RL.HTTP_REGISTER))
app.use('/account/activation', rateGate(RL.HTTP_ACTIVATION))
app.use('/account/bind', rateGate(RL.HTTP_BIND))

// ---------------- signing + body helpers ----------------

function verifySign(body: string, sign: string, ts: number): boolean {
  if (!sign || !ts) return false
  // Replay window: reject timestamps older than 5 minutes
  const now = Date.now()
  if (Math.abs(now - ts) > 5 * 60 * 1000) return false
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

// ---------------- endpoints ----------------

app.get('/serverlist.json', (_req, res) => {
  res.json({
    servers: [{
      serverID: config.game.serverId, name: '亚特兰蒂斯',
      host: process.env.GAME_HOST || '127.0.0.1',
      port: config.tcp.port,
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
    const parsed = parseBody(LoginBody, JSON.parse(bodyRaw))
    if (!parsed.ok) return res.status(400).json(parsed.error)
    const p = parsed.data
    let uuid = p.accountUUID
    if (!uuid) {
      const existing = db.prepare('SELECT account_uuid FROM accounts WHERE platform = ? AND account = ?').get(p.platform, p.account) as any
      uuid = existing?.account_uuid
      if (!uuid) {
        uuid = crypto.randomUUID()
        db.prepare('INSERT INTO accounts(account_uuid, platform, account, device_id, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(uuid, p.platform, p.account, p.deviceID, Math.floor(Date.now()/1000), Math.floor(Date.now()/1000))
      } else {
        db.prepare('UPDATE accounts SET last_login_at = ? WHERE account_uuid = ?').run(Math.floor(Date.now()/1000), uuid)
      }
    }
    let role = db.prepare('SELECT role_uuid, name FROM roles WHERE account_uuid = ?').get(uuid) as any
    if (!role) {
      const roleUuid = crypto.randomUUID()
      const defaultName = p.account || `Guest${uuid.slice(0, 6)}`
      db.prepare('INSERT INTO roles(account_uuid, server_id, role_uuid, name, level, gold, diamond, vip_level, battle_power, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(uuid, p.serverID || config.game.serverId, roleUuid, defaultName, 1, 1000, 100, 0, 0, Math.floor(Date.now()/1000))
      role = { role_uuid: roleUuid, name: defaultName }
    }
    const sessId = Math.floor(Math.random() * 1_000_000)
    const sessionToken = makeToken(uuid)
    db.prepare('INSERT INTO sessions(account_uuid, session_id, token, server_id, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(uuid, String(sessId), sessionToken, p.serverID || config.game.serverId, Math.floor(Date.now()/1000) + 86400)
    res.json({
      code: 0, msg: 'ok',
      accountUUID: uuid, token: sessionToken,
      serverAddress: process.env.GAME_HOST || '127.0.0.1',
      serverID: p.serverID || config.game.serverId,
      sessionId: sessId,
      roleUUID: role.role_uuid,
      roleName: role.name,
      expiredAt: Math.floor(Date.now()/1000) + 86400,
    })
  } catch (e: any) { log.error(e); res.status(500).json({ code: 'INTERNAL', msg: e.message }) }
})

app.post('/account/bind', (req, res) => {
  try {
    const sign = String(req.query.sign || ''); const ts = Number(req.query.timestamp || 0)
    const bodyRaw = rawBody(req)
    if (!verifySign(bodyRaw, sign, ts)) return res.status(401).json({ code: 'SIGN_INVALID' })
    const parsed = parseBody(BindBody, JSON.parse(bodyRaw))
    if (!parsed.ok) return res.status(400).json(parsed.error)
    const p = parsed.data
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
    const parsed = parseBody(RegisterBody, JSON.parse(bodyRaw))
    if (!parsed.ok) return res.status(400).json(parsed.error)
    const p = parsed.data
    const dupe = db.prepare('SELECT 1 FROM accounts WHERE platform = ? AND account = ?').get(p.platform, p.account)
    if (dupe) return res.status(409).json({ code: 'ACCOUNT_EXISTS' })
    const uuid = crypto.randomUUID()
    db.prepare('INSERT INTO accounts(account_uuid, platform, account, token_hash, device_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuid, p.platform, p.account, crypto.createHash('md5').update(p.password).digest('hex'), p.deviceID, Math.floor(Date.now()/1000))
    res.json({ code: 0, msg: 'ok', accountUUID: uuid, token: makeToken(uuid) })
  } catch (e: any) { res.status(500).json({ code: 'INTERNAL', msg: e.message }) }
})

app.post('/account/activation', (req, res) => {
  try {
    const sign = String(req.query.sign || ''); const ts = Number(req.query.timestamp || 0)
    const bodyRaw = rawBody(req)
    if (!verifySign(bodyRaw, sign, ts)) return res.status(401).json({ code: 'SIGN_INVALID' })
    const parsed = parseBody(ActivationBody, JSON.parse(bodyRaw))
    if (!parsed.ok) return res.status(400).json(parsed.error)
    const p = parsed.data
    if (p.code !== (process.env.ACTIVATION_CODE || 'WELCOME2024')) return res.status(400).json({ code: 'CODE_INVALID' })
    const acc = db.prepare('SELECT account_uuid FROM accounts WHERE account_uuid = ?').get(p.accountUUID)
    if (!acc) return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND' })
    db.prepare('UPDATE roles SET diamond = diamond + 100 WHERE account_uuid = ?').run(p.accountUUID)
    res.json({ code: 0, msg: 'ok', serverId: config.game.serverId, accountUUID: p.accountUUID, token: makeToken(p.accountUUID) })
  } catch (e: any) { res.status(500).json({ code: 'INTERNAL', msg: e.message }) }
})

app.post('/api/client/check_update', (_req, res) => {
  res.set('Content-Type', 'application/xml')
  res.send(`<?xml version="1.0"?><root><status>1</status><message>ok</message><UpdateType>0</UpdateType><UpdateUrl></UpdateUrl><ResType>0</ResType><CDNUrl>${config.game.cdnUrl || 'https://cdn.example.com/'}</CDNUrl><RepairNoticeState>0</RepairNoticeState><RepairContents></RepairContents><SystemNoticeState>0</SystemNoticeState><SystemNoticeContent></SystemNoticeContent><MpqNoticeState>0</MpqNoticeState><MpqNoticeContent></MpqNoticeContent></root>`)
})

app.post('/api/client/init', (_req, res) => {
  res.json({
    cdnRoot: config.game.cdnUrl || 'https://cdn.example.com/',
    forceUpdate: false, serverListHash: 'v1',
    loginUrl: process.env.PUBLIC_LOGIN_URL || `http://localhost:${config.http.port}`,
    gameHost: process.env.GAME_HOST || '127.0.0.1',
    gamePort: config.tcp.port,
  })
})

// SDK pay callbacks (lib/pay.handleSdkCallback) — POST /pay/callback/:sdk
app.post('/pay/callback/:sdk', async (req, res) => {
  try {
    const { handleSdkCallback } = await import('../../../lib/pay.js')
    const sig = String(req.headers['x-sdk-signature'] ?? req.query.sign ?? '')
    const payload = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}))
    const r = await handleSdkCallback(db, req.params.sdk, payload, sig)
    res.json(r.ok ? { code: 0, msg: 'ok', orderId: (r as any).orderId } : { code: 400, msg: (r as any).reason })
  } catch (e: any) { log.error(e); res.status(500).json({ code: 'INTERNAL', msg: e.message }) }
})

// ---------------- #1 TLS + listen ----------------

const port = config.http.port
function onListening(proto: string) {
  health.httpListening = true
  log.info(`HTTP${proto === 'https' ? 'S' : ''} listening on ${config.http.host}:${port}`)
}

if (config.tls.enabled && config.tls.cert && config.tls.key && existsSync(config.tls.cert) && existsSync(config.tls.key)) {
  const server = https.createServer({ cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) }, app)
  server.listen(port, config.http.host, () => onListening('https'))
} else {
  if (config.tls.enabled) log.warn('TLS enabled in config but cert/key missing — falling back to plain HTTP')
  app.listen(port, config.http.host, () => onListening('http'))
}
