#!/usr/bin/env node
// DX-CLI: admin CLI for local ops — inspect accounts/roles/orders, run GM actions
// directly against the SQLite DB (no server needed), tail audit + push logs.
//
// Usage:
//   node --import tsx bin/admin.ts accounts [--limit N]
//   node --import tsx bin/admin.ts roles [--limit N]
//   node --import tsx bin/admin.ts role <roleUuid>
//   node --import tsx bin/admin.ts orders [--status 0|1|2] [--limit N]
//   node --import tsx bin/admin.ts give <roleUuid> <gold|diamond|exp|item> [qty] [itemId]
//   node --import tsx bin/admin.ts mute <roleUuid> <seconds> [reason]
//   node --import tsx bin/admin.ts unmute <roleUuid>
//   node --import tsx bin/admin.ts gmlog [--limit N]
//   node --import tsx bin/admin.ts pushlog [--limit N]
//   node --import tsx bin/admin.ts seeds           (active battle seeds)
//   node --import tsx bin/admin.ts migrate
//   node --import tsx bin/admin.ts health

import { DatabaseSync } from 'node:sqlite'
import { config } from '../shared/config.js'
import { runMigrations } from '../db/migrations/run.js'
import { dispatchRewards } from '../lib/rewards.js'
import { execGmCommand } from '../lib/gm-admin.js'

const db = new DatabaseSync(config.db.path)
db.exec('PRAGMA journal_mode = WAL')

const [cmd, ...args] = process.argv.slice(2)

function flag(name: string, dflt: string): string {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}

function table(rows: any[], cols: string[]) {
  if (!rows.length) { console.log('(no rows)'); return }
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').slice(0, 40).length)))
  const line = (vals: string[]) => vals.map((v, i) => v.slice(0, 40).padEnd(widths[i])).join('  ')
  console.log(line(cols))
  console.log(line(widths.map(w => '-'.repeat(w))))
  for (const r of rows) console.log(line(cols.map(c => String(r[c] ?? ''))))
}

async function main() {
  switch (cmd) {
    case 'accounts': {
      const rows = db.prepare(`SELECT account_uuid, platform, account, device_id, created_at, last_login_at FROM accounts ORDER BY created_at DESC LIMIT ?`).all(Number(flag('limit', '20')))
      table(rows as any[], ['account_uuid', 'platform', 'account', 'device_id', 'created_at', 'last_login_at'])
      break
    }
    case 'roles': {
      const rows = db.prepare(`SELECT role_uuid, name, server_id, level, gold, diamond, vip_level, battle_power FROM roles ORDER BY level DESC LIMIT ?`).all(Number(flag('limit', '20')))
      table(rows as any[], ['role_uuid', 'name', 'server_id', 'level', 'gold', 'diamond', 'vip_level', 'battle_power'])
      break
    }
    case 'role': {
      const uuid = args[0]
      if (!uuid) { console.error('usage: role <roleUuid>'); process.exit(2) }
      const role = db.prepare(`SELECT * FROM roles WHERE role_uuid = ?`).get(uuid)
      console.log(JSON.stringify(role ?? null, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2))
      break
    }
    case 'orders': {
      const status = flag('status', '')
      const q = status !== ''
        ? db.prepare(`SELECT order_id, role_uuid, goods_id, amount, status, created_at, paid_at FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(Number(status), Number(flag('limit', '20')))
        : db.prepare(`SELECT order_id, role_uuid, goods_id, amount, status, created_at, paid_at FROM orders ORDER BY created_at DESC LIMIT ?`).all(Number(flag('limit', '20')))
      table(q as any[], ['order_id', 'role_uuid', 'goods_id', 'amount', 'status', 'created_at', 'paid_at'])
      break
    }
    case 'give': {
      const [roleUuid, type, qty, itemId] = args
      if (!roleUuid || !type) { console.error('usage: give <roleUuid> <gold|diamond|exp|item> [qty] [itemId]'); process.exit(2) }
      const res = await dispatchRewards(db, roleUuid, [{ type: type as any, qty: Number(qty ?? 100), id: itemId != null ? Number(itemId) : undefined }], 'admin_cli')
      console.log('applied:', JSON.stringify(res.deltas))
      break
    }
    case 'mute': {
      const [roleUuid, mins, ...reasonParts] = args
      if (!roleUuid || !mins) { console.error('usage: mute <roleUuid> <minutes> [reason]'); process.exit(2) }
      const r = await execGmCommand(db, `admin-${process.env.USER ?? 'cli'}`, 'mute', [roleUuid, Number(mins), reasonParts.join(' ') || 'cli-mute'], { roleUuid })
      console.log(JSON.stringify(r))
      break
    }
    case 'inspect': {
      const [roleUuid] = args
      if (!roleUuid) { console.error('usage: inspect <roleUuid>'); process.exit(2) }
      const r = await execGmCommand(db, `admin-${process.env.USER ?? 'cli'}`, 'inspect', [roleUuid], { roleUuid })
      console.log(JSON.stringify(r, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2))
      break
    }
    case 'gmlog': {
      const rows = db.prepare(`SELECT id, role_uuid, cmd, args, admin_user, action_taken, ip, created_at FROM gm_log ORDER BY id DESC LIMIT ?`).all(Number(flag('limit', '20')))
      table(rows as any[], ['id', 'role_uuid', 'cmd', 'admin_user', 'action_taken', 'created_at'])
      break
    }
    case 'pushlog': {
      const rows = db.prepare(`SELECT id, role_uuid, push_name, message_id, sent_at FROM push_log ORDER BY id DESC LIMIT ?`).all(Number(flag('limit', '20')))
      table(rows as any[], ['id', 'role_uuid', 'push_name', 'message_id', 'sent_at'])
      break
    }
    case 'seeds': {
      const now = Math.floor(Date.now() / 1000)
      const rows = db.prepare(`SELECT uuid, role_uuid, fight_mod, stage_id, random_seed, expires_at FROM battle_seeds WHERE expires_at > ? ORDER BY created_at DESC LIMIT 50`).all(now)
      table(rows as any[], ['uuid', 'role_uuid', 'fight_mod', 'stage_id', 'random_seed', 'expires_at'])
      break
    }
    case 'migrate': {
      const r = runMigrations(db)
      console.log(`applied=${r.applied.length} skipped=${r.skipped.length}`)
      break
    }
    case 'health': {
      const counts: Record<string, number> = {}
      for (const t of ['accounts', 'roles', 'sessions', 'orders', 'guilds', 'battle_seeds', 'chat_messages', 'push_log', 'gm_log']) {
        try { counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n } catch { counts[t] = -1 }
      }
      console.log(JSON.stringify(counts, null, 2))
      break
    }
    default:
      console.log(`art-project-backend admin CLI
commands: accounts | roles | role <uuid> | orders | give <uuid> <type> [qty] [itemId]
          mute <uuid> <minutes> [reason] | inspect <uuid> | gmlog | pushlog | seeds | migrate | health`)
      process.exit(cmd ? 2 : 0)
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })