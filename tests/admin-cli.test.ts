import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runMigrations } from '../db/migrations/run.js'

const here = dirname(fileURLToPath(import.meta.url))
const projRoot = join(here, '..')
const dbPath = join(projRoot, 'data', 'cli-test.db')

let pass = 0, fail = 0
const FAILED: Array<{ name: string; info: string }> = []
function ok(name: string, cond: boolean, label = '', info = '') {
  if (cond) { pass++; console.log(`  PASS ${name}${label ? ' ['+label+']' : ''}${info ? ' (' + info + ')' : ''}`) }
  else { fail++; FAILED.push({ name, info }); console.log(`  FAIL ${name}${label ? ' ['+label+']' : ''}${info ? ' (' + info + ')' : ''}`) }
}

async function runCli(args: string[], timeoutMs = 20000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['--import','tsx','bin/admin.ts', ...args], {
      env: { ...process.env, APP_ENV: 'dev', DB_PATH: dbPath },
      cwd: projRoot, stdio: 'pipe',
    })
    let out = '', err = ''
    proc.stdout?.on('data', d => out += d.toString())
    proc.stderr?.on('data', d => err += d.toString())
    const t = setTimeout(() => { proc.kill() }, timeoutMs)
    proc.on('exit', (code) => { clearTimeout(t); resolve({ code: code ?? -1, stdout: out, stderr: err }) })
  })
}

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA journal_mode = WAL')
runMigrations(db)
db.prepare(`INSERT OR IGNORE INTO accounts(account_uuid, platform, account, created_at) VALUES ('admin-acct','0','admin',0)`).run()
db.prepare(`INSERT OR IGNORE INTO roles(account_uuid, server_id, role_uuid, name, level, gold, diamond, battle_power) VALUES ('admin-acct','s1','gold-uuid','Goldy',10,500,50,1000)`).run()
db.prepare(`INSERT OR IGNORE INTO roles(account_uuid, server_id, role_uuid, name, level, gold, diamond, battle_power) VALUES ('admin-acct','s1','mute-uuid','MuteMe',1,0,0,100)`).run()
db.prepare(`INSERT OR IGNORE INTO sessions(account_uuid, session_id, token, expires_at) VALUES ('admin-acct','1','tok1',strftime('%s','now')+3600)`).run()
db.prepare(`INSERT OR IGNORE INTO orders(order_id, role_uuid, goods_id, amount, status) VALUES ('O-test1', 'gold-uuid', 'gold100', 100, 0)`).run()
db.prepare(`INSERT OR IGNORE INTO battle_seeds(uuid, role_uuid, fight_mod, stage_id, random_seed, expires_at) VALUES ('test-uuid','gold-uuid',1,2,4,strftime('%s','now')+300)`).run()
db.close()

console.log('=== admin CLI subcommands ===')
{
  const r = await runCli(['accounts', '--limit', '5'])
  ok('accounts', r.code === 0 && r.stdout.includes('admin-acct'), 'rc 0 + prints account_uuid')

  const r2 = await runCli(['roles', '--limit', '5'])
  ok('roles', r2.code === 0 && r2.stdout.includes('gold-uuid'), 'rc 0 + prints gold-uuid')

  const r3 = await runCli(['role', 'gold-uuid'])
  ok('role <uuid>', r3.code === 0 && r3.stdout.includes('Goldy') && r3.stdout.includes('500'), 'shows name + level')

  const r4 = await runCli(['role', 'does-not-exist'])
  ok('role <missing>', r4.code === 0 && r4.stdout.includes('null'), 'prints null')

  const r5 = await runCli(['orders', '--limit', '5'])
  ok('orders', r5.code === 0 && r5.stdout.includes('O-test1'), 'rc 0 + prints O-test1')

  const r6 = await runCli(['give', 'gold-uuid', 'gold', '50'])
  ok('give gold 50', r6.code === 0, 'rc 0')

  const r7 = await runCli(['give', 'gold-uuid', 'item', '3', '7'])
  ok('give item 7', r7.code === 0, 'rc 0')

  const r8 = await runCli(['give', 'gold-uuid'])
  ok('give (missing args)', r8.code === 2 && r8.stderr.includes('usage'), 'rc 2 + usage')

  const r9 = await runCli(['mute', 'mute-uuid', '10', 'spam'])
  ok('mute', r9.code === 0, 'rc 0')

  const r10 = await runCli(['mute', 'mute-uuid', '0', 'unmute'])
  ok('mute 0 (unmute-like)', r10.code === 0, 'rc 0')

  const r11 = await runCli(['inspect', 'gold-uuid'])
  ok('inspect <uuid>', r11.code === 0 && r11.stdout.includes('Goldy'), 'rc 0 + Goldy name')

  const r12 = await runCli(['gmlog', '--limit', '10'])
  ok('gmlog', r12.code === 0, 'rc 0')

  const r13 = await runCli(['pushlog', '--limit', '10'])
  ok('pushlog', r13.code === 0, 'rc 0')

  const r14 = await runCli(['seeds'])
  // seeds command prints column headers even on empty; check for any known column
  ok('seeds', r14.code === 0 && (r14.stdout.includes('uuid') || r14.stdout.includes('role_uuid') || r14.stdout.includes('expires_at') || r14.stdout.includes('no rows')), 'rc 0 + table shape')

  const r15 = await runCli(['migrate'])
  ok('migrate (idempotent)', r15.code === 0 && (r15.stdout.includes('applied') || r15.stdout.includes('skipped')), 'rc 0')

  const r16 = await runCli(['health'])
  ok('health', r16.code === 0 && r16.stdout.includes('accounts'), 'rc 0 + accounts count')

  const r17 = await runCli(['foobar'])
  ok('unknown command', r17.code === 2 && r17.stdout.includes('commands:'), 'rc 2 + usage')

  const r18 = await runCli([])
  ok('no args', r18.code === 0 && r18.stdout.includes('commands:'), 'rc 0 + usage')
}

console.log('\n=== ADMIN-CLI RESULT: ' + pass + ' passed, ' + fail + ' failed ===')
if (fail > 0) {
  console.log('FAILURES:')
  for (const f of FAILED) console.log('  ' + f.name + (f.info ? ' (' + f.info + ')' : ''))
}
process.exit(fail ? 1 : 0)
