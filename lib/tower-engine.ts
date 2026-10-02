// Tower engine: 4 protocols (QueryTower, QueryTowerLevel, GetVipReward, LoadVipRewards).

export function queryTower(roleUuid: string) {
  return { ok: true, s2c_currentFloor: 100, s2c_rank: 1234 }
}

export function queryTowerLevel(roleUuid: string) { return queryTower(roleUuid) }

export function getVipReward(roleUuid: string, vipLevel: number) {
  return { ok: true, s2c_rewards: [{ type: 'gold' as const, qty: 1000 }] }
}

export function loadVipRewards(roleUuid: string) {
  return { ok: true, s2c_levels: [] as Array<{ level: number; claimed: boolean }> }
}
