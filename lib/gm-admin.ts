// GM admin commands: gated by token prefix, audit-logged.

import { dispatchRewards, type RewardItem } from './rewards.js'
import { mute } from './chat-engine.js'
import type { DatabaseSync } from 'node:sqlite'

const ADMIN_TOKEN_PREFIX = 'admin-'

export function isAdmin(authToken: string): boolean {
  return authToken.startsWith(ADMIN_TOKEN_PREFIX)
}

interface AuditEntry { ts: number; adminToken: string; cmd: string; args: any }
const auditLog: AuditEntry[] = []

export function getAuditLog(): readonly AuditEntry[] { return auditLog }

export interface GmResult {
  ok: boolean
  result?: any
  reason?: string
}

export async function execGmCommand(
  db: DatabaseSync, authToken: string, cmd: string, args: any, opts?: { roleUuid?: string; ip?: string }
): Promise<GmResult> {
  const maskedToken = authToken.slice(0, 16)
  auditLog.push({ ts: Date.now(), adminToken: maskedToken, cmd, args })

  if (!isAdmin(authToken)) {
    persistGmLog(db, opts?.roleUuid ?? '', cmd, args, 'NOT_ADMIN', maskedToken, opts?.ip ?? '')
    return { ok: false, reason: 'NOT_ADMIN' }
  }

  const r = await runGm(db, cmd, args)
  persistGmLog(db, opts?.roleUuid ?? '', cmd, args, r.ok ? 'OK' : (r.reason ?? 'ERR'), maskedToken, opts?.ip ?? '')
  return r
}

function persistGmLog(db: DatabaseSync, roleUuid: string, cmd: string, args: any, result: string, adminUser: string, ip: string) {
  try {
    db.prepare(`INSERT INTO gm_log(role_uuid, cmd, args, admin_user, action_taken, ip) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(roleUuid, cmd, JSON.stringify(args ?? []), adminUser, result, ip)
  } catch { /* table may predate 012 migration in old DBs; non-fatal */ }
}

async function runGm(db: DatabaseSync, cmd: string, args: any): Promise<GmResult> {
  switch (cmd) {
    case 'give': {
      const [roleUuid, type, id, qty] = args as [string, string, string | number, string | number]
      const reward: RewardItem = {
        type: type as any,
        id: id !== undefined && id !== '' ? Number(id) : undefined,
        qty: Number(qty),
      }
      await dispatchRewards(db, roleUuid, [reward], `gm_give_${cmd}_${Date.now()}`)
      return { ok: true }
    }
    case 'inspect': {
      const [roleUuid] = args as [string]
      const role = db.prepare(`SELECT role_uuid, name, level, gold, diamond, vip_level FROM roles WHERE role_uuid = ?`).get(roleUuid) as any
      return { ok: true, result: role ?? null }
    }
    case 'mute': {
      const [roleUuid, durationMin, reason] = args as [string, string | number, string?]
      mute(roleUuid, Number(durationMin) * 60, String(reason ?? ''))
      return { ok: true }
    }
    case 'kick':
    case 'ban':
      return { ok: true, result: { note: 'kick/ban not yet implemented; flag stored' } }
    default:
      return { ok: false, reason: 'UNKNOWN_CMD' }
  }
}
