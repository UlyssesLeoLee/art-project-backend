// Dungeon engine: 5 resource dungeons + sweep + clear.
// Hooks: ClientSweepDungeon (sweep), ClientChallengeDungeonEnd (clear), ClientStageRewardClaim (stage reward).

import { dispatchRewards, type RewardItem } from './rewards.js'
import type { DatabaseSync } from 'node:sqlite'

export type DungeonType = 'gold' | 'exp' | 'hero' | 'artifact' | 'rune'

export function startDungeon(db: DatabaseSync, roleUuid: string, type: DungeonType, stageId: number) {
  console.log(`[dungeon] role=${roleUuid} type=${type} stage=${stageId}`)
  return { ok: true, s2c_energyCost: 6 }
}

export async function sweepDungeon(db: DatabaseSync, roleUuid: string, type: DungeonType, times: number) {
  // cap sweep times to prevent farming
  if (times < 1 || times > 50) return { ok: false, reason: 'INVALID_TIMES' }

  const rewards: RewardItem[] = []
  for (let i = 0; i < times; i++) {
    rewards.push({ type: 'gold', qty: 500 + Math.floor(Math.random() * 500) })
    if (type === 'exp') rewards.push({ type: 'exp', qty: 200 })
  }
  await dispatchRewards(db, roleUuid, rewards, `dungeon_sweep_${type}_${times}`)
  return { ok: true, s2c_rewardsCount: rewards.length }
}

export async function endDungeon(db: DatabaseSync, roleUuid: string, type: DungeonType, stageId: number, isWin: boolean) {
  if (isWin) {
    await dispatchRewards(db, roleUuid, [
      { type: 'gold', qty: 200 },
      { type: 'exp', qty: 100 },
    ], `dungeon_clear_${type}_${stageId}`)
  }
  return { ok: true }
}

export function getDungeonStageReward(stageId: number) {
  return { ok: true, s2c_reward: { gold: 500, exp: 200 } }
}
