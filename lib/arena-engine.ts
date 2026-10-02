// Arena engine: 4 sub-modes (system / highOrder / Pinnacle / Valor) + season refresh + matchmaker stub.

interface Season {
  id: number
  startAt: number
  endAt: number
  status: 'open' | 'closing' | 'closed'
}

const seasons = new Map<number, Season>()
const rankings = new Map<number, Map<string, number>>() // seasonId -> roleUuid -> score

export function startSeason(id: number, durationSec: number) {
  const now = Math.floor(Date.now() / 1000)
  seasons.set(id, { id, startAt: now, endAt: now + durationSec, status: 'open' })
  if (!rankings.has(id)) rankings.set(id, new Map())
}

export function getCurrentSeason(): number | null {
  const now = Math.floor(Date.now() / 1000)
  for (const s of seasons.values()) {
    if (s.startAt <= now && now < s.endAt) return s.id
  }
  return null
}

export function getSeason(id: number): Season | null {
  return seasons.get(id) ?? null
}

export function listSeasons(): Season[] {
  return Array.from(seasons.values())
}

export function getRankings(seasonId: number, top: number = 100) {
  const m = rankings.get(seasonId)
  if (!m) return []
  const sorted = Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, top)
  return sorted.map(([roleUuid, score], i) => ({ roleUuid, score, rank: i + 1 }))
}

export function updateScore(roleUuid: string, seasonId: number, delta: number) {
  const m = rankings.get(seasonId)
  if (!m) return
  m.set(roleUuid, (m.get(roleUuid) ?? 0) + delta)
}

// Matchmaker stub: returns a random opponent from the same season (real impl uses score bracket matching)
export function findOpponent(roleUuid: string, seasonId: number, count: number = 5) {
  const m = rankings.get(seasonId)
  if (!m) return { ok: true, s2c_opponents: [] }
  const opponents = Array.from(m.entries())
    .filter(([uuid]) => uuid !== roleUuid)
    .slice(0, count)
    .map(([uuid, score]) => ({ roleUuid: uuid, score }))
  return { ok: true, s2c_opponents: opponents }
}

// Auto-start demo season on import
startSeason(1, 7 * 24 * 3600)
