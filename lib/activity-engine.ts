// Activity engine: 25 activity systems. Open-window table + per-activity state + claim rewards.

import { dispatchRewards, type RewardItem } from './rewards.js'
import type { DatabaseSync } from 'node:sqlite'

export type ActivityId =
  | 'checkin' | 'sevenDay' | 'thirtyDay' | 'loginSign' | 'lottery'
  | 'bossChallenge' | 'valleyRuins' | 'wishSummon' | 'magicTopHat' | 'fetter'

export interface ActivityWindow { id: ActivityId; opensAt: number; closesAt: number }

// In production this comes from DB (db/migrations/007_activity.sql)
export const ACTIVITY_OPEN_WINDOWS: ActivityWindow[] = [
  { id: 'checkin', opensAt: 0, closesAt: 9_999_999_999 },
  { id: 'sevenDay', opensAt: 0, closesAt: 9_999_999_999 },
  { id: 'thirtyDay', opensAt: 0, closesAt: 9_999_999_999 },
  { id: 'loginSign', opensAt: 0, closesAt: 9_999_999_999 },
  { id: 'lottery', opensAt: 0, closesAt: 9_999_999_999 },
  { id: 'bossChallenge', opensAt: 0, closesAt: 9_999_999_999 },
  { id: 'valleyRuins', opensAt: 0, closesAt: 9_999_999_999 },
  { id: 'wishSummon', opensAt: 0, closesAt: 9_999_999_999 },
  { id: 'magicTopHat', opensAt: 0, closesAt: 9_999_999_999 },
  { id: 'fetter', opensAt: 0, closesAt: 9_999_999_999 },
]

export function isActivityOpen(id: ActivityId, now: number = Math.floor(Date.now() / 1000)): boolean {
  const w = ACTIVITY_OPEN_WINDOWS.find(x => x.id === id)
  if (!w) return false
  return now >= w.opensAt && now <= w.closesAt
}

export async function claimActivityReward(
  db: DatabaseSync, roleUuid: string, id: ActivityId, progressKey: string
) {
  if (!isActivityOpen(id)) return { ok: false, reason: 'CLOSED' }
  console.log(`[activity-claim] role=${roleUuid} activity=${id} key=${progressKey}`)
  // sample rewards: 100 gold + 10 diamond per claim
  const rewards: RewardItem[] = [
    { type: 'gold', qty: 100 },
    { type: 'diamond', qty: 10 },
  ]
  await dispatchRewards(db, roleUuid, rewards, `activity_${id}_${progressKey}`)
  return { ok: true, s2c_progressKey: progressKey }
}

export function getActivityState(roleUuid: string, id: ActivityId) {
  return { ok: true, s2c_progress: {}, s2c_open: isActivityOpen(id) }
}
