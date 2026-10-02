// RandomSeed + power-snapshot + Replay validator for the Unity client-authoritative battle system.
// The client simulates battles locally using a server-issued RandomSeed and reports results back.
// This module enforces:
//   1. seed TTL (5 minutes)
//   2. roleUuid binding (no replay-attack across players)
//   3. power drift check (5% max)
//   4. replay requirement on arena modes (mod 11..13)
//
// All state is in-memory. For prod-grade, persist to battle_seeds table (DB-002 migration).

import { randomUUID, randomInt } from 'node:crypto'

const SEED_TTL_SEC = 300

interface SeedRecord {
  uuid: string
  roleUuid: string
  fightMod: number
  stageId: number
  randomSeed: number
  difficultyRank: number
  needReplay: 0 | 1
  powerSnapshot: number
  createdAt: number
}

const seeds = new Map<string, SeedRecord>()

// Periodic prune of expired seeds
setInterval(() => {
  const now = Math.floor(Date.now() / 1000)
  for (const [k, v] of seeds) {
    if (now - v.createdAt > SEED_TTL_SEC) seeds.delete(k)
  }
}, 60_000).unref()

export function IssueSeed(roleUuid: string, fightMod: number, stageId: number, currentPower: number) {
  const uuid = randomUUID()
  const randomSeed = randomInt(0, 0x7FFFFFFF)
  const difficultyRank = computeDifficultyRank(currentPower, fightMod, stageId)
  // arena modes (FightType_ArenaValor=11, FightType_ArenaHighend=12, FightType_ArenaPinnacle=13)
  const needReplay = (fightMod >= 11 && fightMod <= 13) ? 1 : 0
  const rec: SeedRecord = {
    uuid, roleUuid, fightMod, stageId,
    randomSeed, difficultyRank, needReplay,
    powerSnapshot: currentPower,
    createdAt: Math.floor(Date.now() / 1000),
  }
  seeds.set(uuid, rec)
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

export interface SettleResult {
  ok: boolean
  reason?: string
  rewards?: Array<{ type: string; id?: number; qty: number }>
}

export function SettleResult(roleUuid: string, randomUuid: string, currentPower: number, replayLog?: string): SettleResult {
  const rec = seeds.get(randomUuid)
  if (!rec) return { ok: false, reason: 'INVALID_UUID' }
  if (rec.roleUuid !== roleUuid) return { ok: false, reason: 'UUID_MISMATCH' }
  if (Math.floor(Date.now() / 1000) - rec.createdAt > SEED_TTL_SEC) {
    seeds.delete(randomUuid)
    return { ok: false, reason: 'SEED_EXPIRED' }
  }
  if (rec.powerSnapshot > 0 && currentPower > 0) {
    const drift = Math.abs(currentPower - rec.powerSnapshot) / Math.max(rec.powerSnapshot, 1)
    if (drift > 0.05) {
      console.warn(`[cheat-detect] roleUuid=${roleUuid} power drift=${drift.toFixed(4)}`)
      return { ok: false, reason: 'POWER_DRIFT' }
    }
  }
  if (rec.needReplay === 1 && !replayLog) {
    return { ok: false, reason: 'REPLAY_REQUIRED' }
  }
  const rewards = computeRewards(rec.fightMod, rec.stageId)
  seeds.delete(randomUuid)
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

function computeRewards(fightMod: number, stageId: number) {
  return [
    { type: 'gold', qty: stageId * 10 },
    { type: 'exp', qty: stageId * 5 },
  ]
}

// Test hook
export function _seedCount() { return seeds.size }
