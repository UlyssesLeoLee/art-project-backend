// Maze engine: deterministic layout generation per (roleUuid + mazeType), grid opt, item use.

export type TileType = 'empty' | 'wall' | 'trap' | 'reward' | 'boss'

export interface MazeTile { x: number; y: number; type: TileType; revealed: boolean }
export interface MazeLayout { width: number; height: number; tiles: MazeTile[] }

export function generateMaze(roleUuid: string, mazeType: number): MazeLayout {
  let seed = 0
  const s = roleUuid + ':' + mazeType
  for (let i = 0; i < s.length; i++) seed = ((seed << 5) - seed + s.charCodeAt(i)) | 0
  const rng = (n: number) => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 * n | 0 }

  const width = 8, height = 8
  const tiles: MazeTile[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r = rng(100)
      let type: TileType = 'empty'
      if (r < 10) type = 'wall'
      else if (r < 18) type = 'trap'
      else if (r < 28) type = 'reward'
      else if (r === 99) type = 'boss'
      tiles.push({ x, y, type, revealed: false })
    }
  }
  return { width, height, tiles }
}

export function optGrid(roleUuid: string, gridId: number, opt: 'reveal' | 'move' | 'useItem') {
  console.log(`[maze] role=${roleUuid} grid=${gridId} opt=${opt}`)
  return { ok: true }
}

export function useMazeItem(roleUuid: string, itemId: number) {
  console.log(`[maze] role=${roleUuid} item=${itemId}`)
  return { ok: true }
}

export function getGridInfo(roleUuid: string, gridId: number) {
  return { ok: true, s2c_gridId: gridId, s2c_tile: { type: 'empty' as TileType } }
}
