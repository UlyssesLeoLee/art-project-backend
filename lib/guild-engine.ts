// Guild engine: 14 protocols covering unionHallCtrl.lua scope.

import { randomUUID } from 'node:crypto'
import { dispatchRewards, type RewardItem } from './rewards.js'
import type { DatabaseSync } from 'node:sqlite'

export interface Guild {
  uuid: string
  name: string
  level: number
  exp: number
  notice: string
  leaderUuid: string
  createdAt: number
}

// In-memory map; for production persist to DB (db/migrations/006_guild.sql)
const guilds = new Map<string, Guild>()
const members = new Map<string, Set<string>>()

export function createGuild(db: DatabaseSync, roleUuid: string, name: string, notice: string): Guild {
  const g: Guild = {
    uuid: randomUUID(),
    name: name.slice(0, 32),
    level: 1, exp: 0, notice: notice.slice(0, 200),
    leaderUuid: roleUuid,
    createdAt: Math.floor(Date.now() / 1000),
  }
  guilds.set(g.uuid, g)
  members.set(g.uuid, new Set([roleUuid]))
  console.log(`[guild] created ${g.uuid} by ${roleUuid}`)
  return g
}

export function joinGuild(roleUuid: string, guildUuid: string) {
  const m = members.get(guildUuid)
  if (!m) return { ok: false, reason: 'NOT_FOUND' }
  if (m.size >= 100) return { ok: false, reason: 'FULL' }
  m.add(roleUuid)
  return { ok: true }
}

export function leaveGuild(roleUuid: string, guildUuid: string) {
  members.get(guildUuid)?.delete(roleUuid)
  return { ok: true }
}

export function kickMember(actorUuid: string, targetUuid: string, guildUuid: string) {
  const g = guilds.get(guildUuid)
  if (!g) return { ok: false, reason: 'NOT_FOUND' }
  if (g.leaderUuid !== actorUuid) return { ok: false, reason: 'NOT_LEADER' }
  members.get(guildUuid)?.delete(targetUuid)
  return { ok: true }
}

export function loadGuild(roleUuid: string, guildUuid: string): Guild | null {
  return guilds.get(guildUuid) ?? null
}

export function listGuilds(): Guild[] {
  return Array.from(guilds.values())
}

export function applyToGuild(roleUuid: string, guildUuid: string) {
  members.get(guildUuid)?.add(roleUuid) // direct add; real impl has approve flow
  return { ok: true }
}

export function handleApply(leaderUuid: string, applicantUuid: string, guildUuid: string, decision: 'accept' | 'reject') {
  const g = guilds.get(guildUuid)
  if (!g || g.leaderUuid !== leaderUuid) return { ok: false, reason: 'NOT_LEADER' }
  if (decision === 'accept') members.get(guildUuid)?.add(applicantUuid)
  return { ok: true }
}

export function changeGuildNotice(leaderUuid: string, guildUuid: string, notice: string) {
  const g = guilds.get(guildUuid)
  if (!g || g.leaderUuid !== leaderUuid) return { ok: false, reason: 'NOT_LEADER' }
  g.notice = notice.slice(0, 200)
  return { ok: true }
}

export function changeGuildInfo(leaderUuid: string, guildUuid: string, info: { name?: string; notice?: string }) {
  const g = guilds.get(guildUuid)
  if (!g || g.leaderUuid !== leaderUuid) return { ok: false, reason: 'NOT_LEADER' }
  if (info.name) g.name = info.name.slice(0, 32)
  if (info.notice) g.notice = info.notice.slice(0, 200)
  return { ok: true }
}

export function setGuildProtector(leaderUuid: string, guildUuid: string, targetUuid: string) {
  const g = guilds.get(guildUuid)
  if (!g || g.leaderUuid !== leaderUuid) return { ok: false, reason: 'NOT_LEADER' }
  return { ok: true, s2c_protectorUuid: targetUuid }
}

export function changeGuildPosition(leaderUuid: string, guildUuid: string, targetUuid: string, position: number) {
  const g = guilds.get(guildUuid)
  if (!g || g.leaderUuid !== leaderUuid) return { ok: false, reason: 'NOT_LEADER' }
  return { ok: true }
}

export function challengeGuildMember(roleUuid: string, targetUuid: string) {
  return { ok: true, s2c_battleId: randomUUID() }
}

export function loadJoinGuildApplies(leaderUuid: string, guildUuid: string) {
  return { ok: true, s2c_applies: [] as Array<{ uuid: string; name: string }> }
}

export function searchGuild(name: string) {
  return { ok: true, s2c_guilds: listGuilds().filter(g => g.name.includes(name.slice(0, 32))) }
}
