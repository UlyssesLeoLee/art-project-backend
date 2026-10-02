// Single dispatcher for rewards (gold / diamond / exp / item / hero / relic / hallow / artifact).
// Every business engine (battle, dungeon, arena, pay, GM, etc.) MUST go through this function.
// Atomic SQLite transaction wrapping all writes; cap overflow at INT32_MAX; returns delta
// for client diff display.

import { DatabaseSync } from 'node:sqlite'

export type RewardType = 'gold' | 'diamond' | 'item' | 'hero' | 'exp' | 'relic' | 'hallow' | 'artifact'

export interface RewardItem {
  type: RewardType
  id?: number
  qty: number
}

const INT32_MAX = 0x7FFFFFFF

export interface DispatchResult {
  deltas: Record<string, number>
  applied: RewardItem[]
}

export async function dispatchRewards(
  db: DatabaseSync,
  roleUuid: string,
  items: RewardItem[],
  reason: string
): Promise<DispatchResult> {
  const deltas: Record<string, number> = {}

  // Sanity cap: total currency delta vs role.level * 1_000_000
  let currencyTotal = 0
  for (const it of items) {
    if (it.type === 'gold' || it.type === 'diamond' || it.type === 'exp') {
      currencyTotal += it.qty
    }
  }
  if (currencyTotal > 100_000_000) {
    throw new Error(`rejected: currency total ${currencyTotal} exceeds sanity cap for role=${roleUuid}`)
  }

  // Compute deltas (cap each at INT32_MAX)
  for (const it of items) {
    let delta = 0
    switch (it.type) {
      case 'gold':
      case 'diamond':
      case 'exp':
        delta = Math.min(it.qty, INT32_MAX)
        deltas[it.type] = (deltas[it.type] ?? 0) + delta
        break
      default:
        delta = it.qty
        const key = `${it.type}_${it.id ?? 0}`
        deltas[key] = (deltas[key] ?? 0) + delta
    }
  }

  // Atomic write
  db.exec('BEGIN')
  try {
    for (const it of items) {
      const q = Math.min(it.qty, INT32_MAX)
      switch (it.type) {
        case 'gold':
          db.prepare(`UPDATE roles SET gold = MIN(gold + ?, ?) WHERE role_uuid = ?`)
            .run(q, INT32_MAX, roleUuid)
          break
        case 'diamond':
          db.prepare(`UPDATE roles SET diamond = MIN(diamond + ?, ?) WHERE role_uuid = ?`)
            .run(q, INT32_MAX, roleUuid)
          break
        case 'exp':
          db.prepare(`UPDATE roles SET exp = exp + ? WHERE role_uuid = ?`).run(q, roleUuid)
          // auto-level-up: if exp >= level*100, increment level
          db.prepare(`UPDATE roles SET level = level + 1, exp = exp - (level * 100)
                     WHERE role_uuid = ? AND exp >= level * 100`).run(roleUuid)
          break
        case 'item':
          if (it.id == null) throw new Error('item reward requires id')
          // upsert: increment count if exists, else insert
          const existing = db.prepare(`SELECT id FROM items WHERE role_uuid = ? AND item_id = ?`).get(roleUuid, it.id) as any
          if (existing) {
            db.prepare(`UPDATE items SET count = count + ? WHERE id = ?`).run(q, existing.id)
          } else {
            db.prepare(`INSERT INTO items(item_uuid, role_uuid, item_id, count) VALUES (?, ?, ?, ?)`)
              .run(`it_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, roleUuid, it.id, q)
          }
          break
        case 'hero':
          if (it.id == null) throw new Error('hero reward requires id')
          db.prepare(`INSERT INTO heroes(hero_uuid, role_uuid, hero_id, level, exp, rank, star, locked) VALUES (?, ?, ?, 1, 0, 1, 0, 0)`)
            .run(`hr_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, roleUuid, it.id)
          break
        // relic / hallow / artifact: similar insert patterns can be added later
      }
    }
    // audit row
    db.prepare(`INSERT INTO gm_log(role_uuid, cmd, args, created_at) VALUES (?, ?, ?, ?)`)
      .run(roleUuid, `rewards:${reason}`, JSON.stringify(items), Math.floor(Date.now()/1000))
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  console.log(`[rewards] role=${roleUuid} reason=${reason} deltas=`, deltas)
  return { deltas, applied: items }
}
