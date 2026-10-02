import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

const DB_PATH = process.env.DB_PATH || './data/game.db'
mkdirSync(dirname(DB_PATH), { recursive: true })
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec(readFileSync('./db/migrations/001_init.sql', 'utf8'))

const now = Math.floor(Date.now() / 1000)
db.prepare(`INSERT OR IGNORE INTO accounts(account_uuid, platform, account, token_hash, device_id, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run('demo-uuid-001', '0', 'guest', '', 'demo-device', now, now)
db.prepare(`INSERT OR IGNORE INTO roles(account_uuid, server_id, role_uuid, name, level, exp, gold, diamond, vip_level, battle_power, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run('demo-uuid-001', 's10001', 'demo-role-001', 'DemoPlayer', 30, 0, 10000, 500, 3, 12345, now)
console.log('Seeded demo data at', DB_PATH)
