// RandomSeed + power-snapshot + Replay validator for the Unity client-authoritative battle system.
// Persists to battle_seeds (DB-003) and battle_replays (DB-004).

import { randomUUID, randomInt } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

const SEED_TTL_SEC = 300
const POWER_DRIFT_MAX = 0.05

interface SeedRow {
  uuid: string
  role_uuid: string
  fight_mod: number
  stage_id: number
  random_seed: number
  difficulty_rank: number
  need_replay: 0 | 1
  power_snapshot: number
  needs_replay: 0 | 1
  update_fight_mod: number
  update_stage_id: number
  stage_dynamic_difficulty: number
  battle_check_realpwoer: 0 | 1
  created_at: number
  expires_at: number
}

export interface SeedResponse {
  s2c_randomUuid: string
  s2c_updateFightMod: number
  s2c_updateStageId: number
  s2c_needFightDamage: 0 | 1
  s2c_needFightReplay: 0 | 1
  s2c_randomSeed: number
  s2c_difficultyRank: number
  s2c_stage_dynamic_difficulty: number
  s2c_battle_check_realpwoer: 0 | 1
}

export function IssueSeed(db: DatabaseSync, roleUuid: string, fightMod: number, stageId: number, currentPower: number): SeedResponse {
  const uuid = randomUUID()
  const randomSeed = randomInt(0, 0x7FFFFFFF)
  const difficultyRank = computeDifficultyRank(currentPower, fightMod, stageId)
  const needReplay = (fightMod >= 11 && fightMod <= 13) ? 1 as const : 0 as const
  const now = Math.floor(Date.now() / 1000)
  const expires = now + SEED_TTL_SEC
  db.prepare(`INSERT INTO battle_seeds(uuid, role_uuid, fight_mod, stage_id, random_seed, difficulty_rank, need_replay, power_snapshot, needs_replay, update_fight_mod, update_stage_id, stage_dynamic_difficulty, battle_check_realpwoer, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    uuid, roleUuid, fightMod, stageId, randomSeed, difficultyRank, needReplay, currentPower,
    needReplay, fightMod, stageId, difficultyRank, currentPower > 0 ? 1 : 0, now, expires)
  return {
    s2c_randomUuid: uuid,
    s2c_updateFightMod: fightMod,
    s2c_updateStageId: stageId,
    s2c_needFightDamage: 0,
    s2c_needFightReplay: needReplay,
    s2c_randomSeed: randomSeed,
    s2c_difficultyRank: difficultyRank,
    s2c_stage_dynamic_difficulty: difficultyRank,
    s2c_battle_check_realpwoer: currentPower > 0 ? 1 : 0,
  }
}

export interface SettleResultResp {
  ok: boolean
  reason?: string
  rewards?: Array<{ type: string; id?: number; qty: number }>
}

export function resolveBot(db: DatabaseSync, roleUuid: string, randomUuid: string, currentPower: number, replayLog?: string, replayHash?: string): SettleResultResp {
  const row = db.prepare(`SELECT * FROM battle_seeds WHERE uuid = ?`).get(randomUuid) as SeedRow | undefined
  if (!row) return { ok: false, reason: 'INVALID_UUID' }
  if (row.role_uuid !== roleUuid) return { ok: false, reason: 'UUID_MISMATCH' }
  const now = Math.floor(Date.now() / 1000)
  if (now > row.expires_at) {
    db.prepare(`DELETE FROM battle_seeds WHERE uuid = ?`).run(randomUuid)
    return { ok: false, reason: 'SEED_EXPIRED' }
  }
  if (row.power_snapshot > 0 && currentPower > 0) {
    const drift = Math.abs(currentPower - row.power_snapshot) / Math.max(row.power_snapshot, 1)
    if (drift > POWER_DRIFT_MAX) {
      console.warn(`[cheat-detect] roleUuid=${roleUuid} power drift=${drift.toFixed(4)}`)
      return { ok: false, reason: 'POWER_DRIFT' }
    }
  }
  if (row.need_replay === 1 && !replayLog) {
    return { ok: false, reason: 'REPLAY_REQUIRED' }
  }
  if (replayLog && replayHash) {
    db.prepare(`INSERT INTO battle_replays(uuid, role_uuid, replay_json, replay_hash, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(randomUUID(), roleUuid, replayLog, replayHash, now + 7 * 24 * 3600)
  }
  const rewards = computeRewards(db, row.fight_mod, row.stage_id)
  db.prepare(`DELETE FROM battle_seeds WHERE uuid = ?`).run(randomUuid)
  return { ok: true, rewards }
}

function computeDifficultyRank(power: number, mod: number, stageId: number): number {
  const expected = 1000 + stageId * 50
  if (power < expected * 0.5) return 5
  if (power < expected * 0.8) return 4
  if (power < expected) return 3
  if (power < expected * 1.2) return 2
  return 1
}

function computeRewards(db: DatabaseSync, fightMod: number, stageId: number): Array<{ type: string; id?: number; qty: number }> {
  const rows = db.prepare(`SELECT item_id, weight, min_qty, max_qty FROM drop_tables WHERE stage_id = ?`).all(stageId) as Array<{ item_id: number; weight: number; min_qty: number; max_qty: number }>
  const rewards: Array<{ type: string; id?: number; qty: number }> = []
  if (rows.length === 0) {
    rewards.push({ type: 'gold', qty: stageId * 10 })
    rewards.push({ type: 'exp', qty: stageId * 5 })
    return rewards
  }
  const total = rows.reduce((s, r) => s + r.weight, 0)
  let pick = randomInt(0, total)
  for (const r of rows) {
    pick -= r.weight
    if (pick <= 0) {
      const qty = r.min_qty + randomInt(0, Math.max(1, r.max_qty - r.min_qty + 1))
      rewards.push({ type: 'item', id: r.item_id, qty })
      break
    }
  }
  return rewards
}

export function _seedCount(db: DatabaseSync): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM battle_seeds`).get() as any).n
}