import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { runMigrations } from '../migrations/run.js'

const DB_PATH = process.env.DB_PATH || './data/game.db'
mkdirSync(dirname(DB_PATH), { recursive: true })
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')

// Apply any pending migrations first (idempotent — does nothing if all already applied).
runMigrations(db)

// Apply the original schema only if no accounts table exists yet
// (the seed is meant to be runnable against an empty DB OR an already-migrated DB).
const hasAccounts = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'`).get()
if (!hasAccounts) {
  db.exec(readFileSync('./db/migrations/001_init.sql', 'utf8'))
  console.log('[seed] applied initial schema')
} else {
  console.log('[seed] schema already present, skipping 001_init.sql')
}

const now = Math.floor(Date.now() / 1000)
db.prepare(`INSERT OR IGNORE INTO accounts(account_uuid, platform, account, token_hash, device_id, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run('demo-uuid-001', '0', 'guest', '', 'demo-device', now, now)
db.prepare(`INSERT OR IGNORE INTO roles(account_uuid, server_id, role_uuid, name, level, exp, gold, diamond, vip_level, battle_power, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run('demo-uuid-001', 's10001', 'demo-role-001', 'DemoPlayer', 30, 0, 10000, 500, 3, 12345, now)
console.log('Seeded demo data at', DB_PATH)
