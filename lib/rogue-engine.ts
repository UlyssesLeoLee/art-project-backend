// Rogue/Copy engine: 14 thin handlers covering RogueDataCtrl scope (gain-reward, combat, relic, trap, spring, relive, hire, explore, get-hire, get-monsters, save-event, set-pos, add-map-log, granary).

export function startRogue(roleUuid: string, copyId: number, type: number) {
  console.log(`[rogue] role=${roleUuid} copy=${copyId} type=${type}`)
  return { ok: true, s2c_mapId: copyId, s2c_fog: [] as Array<{ x: number; y: number }> }
}

export function combatRogue(roleUuid: string, x: number, y: number) {
  console.log(`[rogue-combat] role=${roleUuid} pos=(${x},${y})`)
  return { ok: true }
}

export function gainRelic(roleUuid: string, x: number, y: number) {
  console.log(`[rogue-relic] role=${roleUuid} pos=(${x},${y})`)
  return { ok: true, s2c_relicIds: [1, 2] }
}

export function trapTrigger(roleUuid: string, x: number, y: number) { return { ok: true } }
export function useSpring(roleUuid: string, x: number, y: number) { return { ok: true } }
export function reliveHero(roleUuid: string, heroUuid: string) { return { ok: true } }
export function hireHero(roleUuid: string, heroUuid: string) { return { ok: true } }
export function exploreMap(roleUuid: string, copyId: number, pos: number) {
  return { ok: true, s2c_newTiles: [] as Array<{ x: number; y: number; type: string }> }
}
export function getHireHeroList(roleUuid: string, copyId: number) {
  return { ok: true, s2c_heroes: [] as Array<{ heroUuid: string; heroId: number; level: number }> }
}
export function getMonsters(roleUuid: string, copyId: number) {
  return { ok: true, s2c_monsters: [] as Array<{ x: number; y: number; type: number; hp: number }> }
}
export function saveCopyEvent(roleUuid: string, copyId: number, eventJson: string) { return { ok: true } }
export function setPlayerPos(roleUuid: string, copyId: number, x: number, y: number) { return { ok: true } }
export function addMapLog(roleUuid: string, copyId: number, logJson: string) { return { ok: true } }
export function granary(roleUuid: string, copyId: number, op: 'collect' | 'deposit', itemId: number, qty: number) {
  return { ok: true }
}
export function gainCopyReward(roleUuid: string, copyId: number, stageId: number) {
  return { ok: true, s2c_rewards: [{ type: 'gold' as const, qty: 100 }] }
}
