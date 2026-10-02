// M4-PUS: push scheduler — interval-driven maintenance + server push dispatch.
//
// Jobs (all registered with unref'd intervals so they never keep the process alive):
//   - battle_seed prune   : delete expired battle_seeds rows (60s)
//   - replay prune        : delete expired battle_replays rows (10min)
//   - rate bucket cleanup : delete stale rate_buckets windows (5min)
//   - arena season roll   : check arena_seasons end_at, start next season (5min)
//   - activity window     : push ActivityState when a calendar window opens (5min)
//
// Socket broadcast: the TCP server registers a broadcaster via setBroadcaster();
// push jobs use it to send ClientCommonNotify-style frames. If no broadcaster is
// registered (e.g. in tests), pushes are recorded in push_log only.

import type { DatabaseSync } from 'node:sqlite'

export type Broadcaster = (roleUuid: string | null, route: number, payloadObj: Record<string, unknown>) => void

let broadcaster: Broadcaster | null = null
export function setBroadcaster(fn: Broadcaster | null) { broadcaster = fn }

const timers: NodeJS.Timeout[] = []

export function startPushScheduler(db: DatabaseSync) {
  // battle seed prune
  timers.push(setInterval(() => {
    try {
      const now = Math.floor(Date.now() / 1000)
      db.prepare(`DELETE FROM battle_seeds WHERE expires_at < ?`).run(now)
    } catch { /* table may not exist yet */ }
  }, 60_000))

  // replay prune (7d TTL)
  timers.push(setInterval(() => {
    try {
      const now = Math.floor(Date.now() / 1000)
      db.prepare(`DELETE FROM battle_replays WHERE expires_at < ?`).run(now)
    } catch { /* ignore */ }
  }, 600_000))

  // rate bucket cleanup
  timers.push(setInterval(() => {
    try {
      const now = Math.floor(Date.now() / 1000)
      db.prepare(`DELETE FROM rate_buckets WHERE window_start < ?`).run(now - 3600)
    } catch { /* ignore */ }
  }, 300_000))

  // arena season rollover
  timers.push(setInterval(() => {
    try {
      const now = Math.floor(Date.now() / 1000)
      const cur = db.prepare(`SELECT season_id, end_at FROM arena_seasons WHERE status = 'active' ORDER BY season_id DESC LIMIT 1`).get() as any
      if (cur && now >= Number(cur.end_at)) {
        db.prepare(`UPDATE arena_seasons SET status = 'ended' WHERE season_id = ?`).run(cur.season_id)
        const nextId = Number(cur.season_id) + 1
        db.prepare(`INSERT INTO arena_seasons(season_id, start_at, end_at, status) VALUES (?, ?, ?, 'active')`)
          .run(nextId, now, now + 30 * 24 * 3600)
        logPush(db, null, 'ArenaSeasonRefresh', nextId)
        if (broadcaster) broadcaster(null, 0x00035001, { s2c_gainItemsReason: 9001 }) // season refresh notify reason
      }
    } catch { /* ignore */ }
  }, 300_000))

  // activity window opener
  timers.push(setInterval(() => {
    try {
      const now = Math.floor(Date.now() / 1000)
      const opening = db.prepare(`SELECT id, activity_id, server_id FROM activity_calendar WHERE open_at <= ? AND close_at > ? AND params_json NOT LIKE '%"opened"%' LIMIT 50`).all(now, now) as any[]
      for (const row of opening) {
        logPush(db, null, 'ActivityWindowOpen', row.activity_id)
      }
    } catch { /* ignore */ }
  }, 300_000))

  for (const t of timers) t.unref()
}

export function stopPushScheduler() {
  for (const t of timers) clearInterval(t)
  timers.length = 0
}

export function logPush(db: DatabaseSync, roleUuid: string | null, pushName: string, messageId: number, payload: Record<string, unknown> = {}) {
  try {
    db.prepare(`INSERT INTO push_log(role_uuid, push_name, message_id, payload) VALUES (?, ?, ?, ?)`)
      .run(roleUuid ?? '', pushName, messageId, JSON.stringify(payload))
  } catch { /* non-fatal */ }
}

/** Send a ClientCommonNotify push to one role (or broadcast when roleUuid=null). */
export function pushCommonNotify(db: DatabaseSync, roleUuid: string | null, reason: number, extra: Record<string, unknown> = {}) {
  if (!broadcaster) { logPush(db, roleUuid, 'ClientCommonNotify', reason); return }
  broadcaster(roleUuid, 0x00035001, {
    s2c_gainItemsReason: reason,
    s2c_gainItems: [], s2c_roleDatas: {}, s2c_roleDatas64: {},
    s2c_itemsUpdate: [], s2c_itemsDelete: [], s2c_heroUpdates: [], s2c_herosDelete: [],
    s2c_equipsUpdate: [], s2c_equipsDelete: [], s2c_relicItems: {}, s2c_relicDelete: {},
    s2c_artifactsUpdate: [], s2c_mercenaryUseMap: {}, s2c_heroBufUpdates: [],
    Empty: true,
    ...extra,
  })
  logPush(db, roleUuid, 'ClientCommonNotify', reason)
}

export function _timerCount() { return timers.length }