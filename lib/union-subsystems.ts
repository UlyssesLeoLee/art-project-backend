// Union subsystems: 5 union mini-modes (BossMain / Curse / Hunting / Screwy / Territory) + WarriorTreasure.

export type UnionMode = 'bossMain' | 'curse' | 'hunting' | 'screwy' | 'territory' | 'warriorTreasure'

export function startUnionBattle(guildUuid: string, mode: UnionMode) {
  console.log(`[union] guild=${guildUuid} mode=${mode}`)
  return { ok: true }
}

export function endUnionBattle(guildUuid: string, mode: UnionMode, isWin: boolean, dmgDealt: number) {
  console.log(`[union-end] guild=${guildUuid} mode=${mode} win=${isWin} dmg=${dmgDealt}`)
  return { ok: true }
}

export function getUnionInfo(guildUuid: string) {
  return { ok: true, s2c_territoryLevel: 1, s2c_curseHp: 1000000 }
}
