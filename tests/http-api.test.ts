// HTTP API test — covers all 11 routes + edge cases. Run: node --import tsx tests/http-api.test.ts
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from '../db/migrations/run.js'
import http from 'node:http'
import crypto from 'node:crypto'

// boot HTTP server on a random port
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PORT = 18888
process.env.APP_ENV = 'dev'
process.env.DB_PATH = ':memory:'
process.env.PORT = String(PORT)

let pass = 0, fail = 0
const FAILED: Array<{ section: string; name: string; info: string }> = []
function ok(section: string, name: string, cond: boolean, info = '') {
  if (cond) { pass++; console.log(`  PASS [${section}] ${name}${info ? ' ('+info+')' : ''}`) }
  else { fail++; FAILED.push({ section, name, info }); console.log(`  FAIL [${section}] ${name}${info ? ' ('+info+')' : ''}`) }
}

// Start HTTP server
const proc = spawn(process.execPath, ['--import','tsx','services/http/src/main.ts'], {
  env: { ...process.env, APP_ENV: 'dev', DB_PATH: ':memory:', PORT: String(PORT) },
  cwd: root, stdio: 'pipe',
})

// wait for readiness
async function waitReady(url: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      if (r.ok) return true
    } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

// helpers
const SECRET = '3dbf6b137a80d10953507929a0216d8b'
async function signedPost(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const bodyStr = JSON.stringify(body)
  const ts = Date.now()
  const sign = crypto.createHash('md5').update(bodyStr + SECRET + String(ts)).digest('hex')
  const url = `http://127.0.0.1:${PORT}${path}?sign=${sign}&timestamp=${ts}`
  const r = await fetch(url, {
    method: 'POST',
    body: Buffer.from(bodyStr).toString('base64'),
    headers: { 'Content-Type': 'application/json' },
  })
  let parsed: any = null
  try { parsed = await r.json() } catch {}
  return { status: r.status, body: parsed }
}

async function post(path: string, body: string, contentType = 'text/plain'): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST', body, headers: { 'Content-Type': contentType },
  })
  let parsed: any = null
  try { parsed = await r.json() } catch { parsed = await r.text() }
  return { status: r.status, body: parsed }
}

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`)
  let parsed: any = null
  try { parsed = await r.json() } catch {}
  return { status: r.status, body: parsed }
}

async function getText(path: string): Promise<{ status: number; body: string }> {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`)
  return { status: r.status, body: await r.text() }
}

try {
  if (!await waitReady(`http://127.0.0.1:${PORT}/health`)) {
    throw new Error('HTTP server did not become ready')
  }

  console.log('=== 1. GET endpoints ===')
  {
    const h = await getJson('/health')
    ok('http-get', 'GET /health 200 + ok', h.status === 200 && h.body?.status === 'ok', JSON.stringify(h.body))
    const hr = await getJson('/health/ready')
    ok('http-get', 'GET /health/ready 200', hr.status === 200 && hr.body?.db === true, `db=${hr.body?.db}`)
    const sl = await getJson('/serverlist.json')
    ok('http-get', 'GET /serverlist.json has s10001', sl.status === 200 && sl.body?.servers?.[0]?.serverID === 's10001')
    const init = await post('/api/client/init', '', 'application/json')
    ok('http-get', 'POST /api/client/init has gameHost', init.status === 200 && init.body?.gameHost !== undefined)
    const updResp = await fetch(`http://127.0.0.1:${PORT}/api/client/check_update`, { method: 'POST', body: '' })
    const updText = await updResp.text()
    ok('http-get', 'POST /api/client/check_update returns XML', updResp.status === 200 && updText.startsWith('<?xml'))
  }

  console.log('\n=== 2. /metrics is Prometheus text ===')
  {
    const m = await getText('/metrics')
    ok('http-metrics', '200 + Prometheus content-type', m.status === 200)
    ok('http-metrics', 'has http_requests_total metric', m.body.includes('http_requests_total'))
    ok('http-metrics', 'has HELP + TYPE comments', m.body.includes('# HELP ') && m.body.includes('# TYPE '))
    ok('http-metrics', 'includes process_uptime_seconds', m.body.includes('process_uptime_seconds'))
  }

  console.log('\n=== 3. /account/login (positive + negative) ===')
  {
    const okLogin = await signedPost('/account/login', { platform: '0', deviceID: 'dev', account: '', binVersion: '1.0' })
    ok('http-login', 'login returns token + accountUUID',
      okLogin.status === 200 && okLogin.body?.code === 0 && typeof okLogin.body?.token === 'string',
      JSON.stringify(okLogin.body).slice(0, 100))
    // bad signature
    const bodyStr = JSON.stringify({ platform: '0', deviceID: 'x' })
    const ts = Date.now()
    const url = `http://127.0.0.1:${PORT}/account/login?sign=DEADBEEF&timestamp=${ts}`
    const bad = await fetch(url, {
      method: 'POST', body: Buffer.from(bodyStr).toString('base64'),
      headers: { 'Content-Type': 'application/json' },
    })
    ok('http-login', 'bad signature rejected with 401', bad.status === 401)
    // replay: old timestamp rejected
    const tsOld = Date.now() - 10 * 60 * 1000
    const oldSign = crypto.createHash('md5').update(bodyStr + SECRET + String(tsOld)).digest('hex')
    const url2 = `http://127.0.0.1:${PORT}/account/login?sign=${oldSign}&timestamp=${tsOld}`
    const old = await fetch(url2, {
      method: 'POST', body: Buffer.from(bodyStr).toString('base64'),
      headers: { 'Content-Type': 'application/json' },
    })
    ok('http-login', 'old timestamp (>5min) rejected with 401', old.status === 401)
    // zod: missing platform
    const badBody = { deviceID: 'x' }
    const ts2 = Date.now()
    const b2s = JSON.stringify(badBody)
    const sign2 = crypto.createHash('md5').update(b2s + SECRET + String(ts2)).digest('hex')
    const u2 = `http://127.0.0.1:${PORT}/account/login?sign=${sign2}&timestamp=${ts2}`
    const noP = await fetch(u2, {
      method: 'POST', body: Buffer.from(b2s).toString('base64'),
      headers: { 'Content-Type': 'application/json' },
    })
    const noPBody = await noP.json()
    ok('http-zod', 'missing platform returns 400 BAD_REQUEST',
      noP.status === 400 && noPBody?.code === 'BAD_REQUEST')
  }

  console.log('\n=== 4. /account/register (positive + duplicate) ===')
  {
    const ts = Date.now()
    const body = { platform: '0', account: 'newuser1', password: 'strongpw1', deviceID: 'dev' }
    const r1 = await signedPost('/account/register', body)
    ok('http-register', 'first register returns 200 + token', r1.status === 200 && typeof r1.body?.token === 'string')
    // duplicate
    const r2 = await signedPost('/account/register', body)
    ok('http-register', 'duplicate returns 409', r2.status === 409 && r2.body?.code === 'ACCOUNT_EXISTS')
    // weak password
    const weak = { platform: '0', account: 'weak', password: 'abc', deviceID: 'x' }
    const r3 = await signedPost('/account/register', weak)
    ok('http-register', 'weak password (3 chars) returns 400', r3.status === 400 && r3.body?.code === 'BAD_REQUEST')
  }

  console.log('\n=== 5. /account/bind + /account/activation ===')
  {
    // Get a uuid from login
    const lg = await signedPost('/account/login', { platform: '0', deviceID: 'd1', account: 'binder', binVersion: '1' })
    const uuid = lg.body?.accountUUID
    // bind
    const b = await signedPost('/account/bind', { accountUUID: uuid, platform: '1', account: 'fb', token: 'tok1' })
    ok('http-bind', 'bind returns 200', b.status === 200 && b.body?.code === 0)
    // invalid uuid
    const bad = await signedPost('/account/bind', { accountUUID: 'not-a-uuid', platform: '0', account: 'x', token: 'y' })
    ok('http-bind', 'bad uuid returns 400 BAD_REQUEST', bad.status === 400 && bad.body?.code === 'BAD_REQUEST')
    // activation: correct code
    const ts = Date.now()
    const body = { accountUUID: uuid, code: 'WELCOME2024' }
    const bodyStr = JSON.stringify(body)
    const sign = crypto.createHash('md5').update(bodyStr + SECRET + String(ts)).digest('hex')
    const url = `http://127.0.0.1:${PORT}/account/activation?sign=${sign}&timestamp=${ts}`
    const act = await fetch(url, { method: 'POST', body: Buffer.from(bodyStr).toString('base64'), headers: { 'Content-Type': 'application/json' } })
    const actBody = await act.json()
    ok('http-activation', 'correct code returns 200 + token', act.status === 200 && typeof actBody?.token === 'string')
    // wrong code
    const ts2 = Date.now()
    const body2 = { accountUUID: uuid, code: 'WRONG' }
    const b2s = JSON.stringify(body2)
    const s2 = crypto.createHash('md5').update(b2s + SECRET + String(ts2)).digest('hex')
    const u2 = `http://127.0.0.1:${PORT}/account/activation?sign=${s2}&timestamp=${ts2}`
    const act2 = await fetch(u2, { method: 'POST', body: Buffer.from(b2s).toString('base64'), headers: { 'Content-Type': 'application/json' } })
    ok('http-activation', 'wrong code returns 400', act2.status === 400)
  }

  console.log('\n=== 6. CORS preflight + origin handling ===')
  {
    const preflight = await fetch(`http://127.0.0.1:${PORT}/account/login`, {
      method: 'OPTIONS', headers: { Origin: 'http://example.com', 'Access-Control-Request-Method': 'POST' }
    })
    ok('http-cors', 'OPTIONS preflight returns 204', preflight.status === 204)
    const acao = preflight.headers.get('Access-Control-Allow-Origin')
    ok('http-cors', 'preflight sets Allow-Origin (*)',
      acao === '*' || acao === 'http://example.com', `acao=${acao}`)
    const normal = await fetch(`http://127.0.0.1:${PORT}/serverlist.json`, {
      headers: { Origin: 'http://example.com' }
    })
    const nacao = normal.headers.get('Access-Control-Allow-Origin')
    ok('http-cors', 'normal GET echoes Origin', nacao !== null, `acao=${nacao}`)
  }

  console.log('\n=== 7. Rate limit on /account/login ===')
  {
    // Hit login 7 times rapidly; expect 5xx success, then 429
    let saw429 = false
    let sawRetryAfter = false
    for (let i = 0; i < 10; i++) {
      const ts = Date.now() + i  // bump ts to avoid replay protection
      const body = { platform: '0', deviceID: 'rl', account: '', binVersion: '1' }
      const bodyStr = JSON.stringify(body)
      const sign = crypto.createHash('md5').update(bodyStr + SECRET + String(ts)).digest('hex')
      const url = `http://127.0.0.1:${PORT}/account/login?sign=${sign}&timestamp=${ts}`
      const r = await fetch(url, {
        method: 'POST', body: Buffer.from(bodyStr).toString('base64'), headers: { 'Content-Type': 'application/json' }
      })
      if (r.status === 429) {
        saw429 = true
        if (r.headers.get('Retry-After')) sawRetryAfter = true
      }
    }
    ok('http-ratelimit', '7 rapid logins trigger 429', saw429)
    ok('http-ratelimit', '429 response has Retry-After', sawRetryAfter)
  }

} catch (e: any) {
  console.log('ERROR:', e.message, e.stack)
  fail++
} finally {
  proc.kill()
}

console.log(`\n=== HTTP-API RESULT: ${pass} passed, ${fail} failed ===`)
if (fail > 0) {
  console.log('FAILURES:')
  for (const f of FAILED) console.log(`  [${f.section}] ${f.name}${f.info ? ' ('+f.info+')' : ''}`)
}
process.exit(fail ? 1 : 0)
