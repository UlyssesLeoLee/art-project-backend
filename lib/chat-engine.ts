// Chat engine: REGULATORY. Hot-reloadable forbidden-word filter + mute mechanism.
// CN/JP/KR markets require word filtering for public chat; this is non-optional.

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const WORDS_PATH = resolve(process.env.FORBIDDEN_WORDS_PATH || './config/forbidden_words.json')

let forbiddenWords: string[] = []
let lastLoadedAt = 0

function loadWords() {
  if (!existsSync(WORDS_PATH)) {
    forbiddenWords = []
    lastLoadedAt = Date.now()
    return
  }
  try {
    const raw = readFileSync(WORDS_PATH, 'utf8')
    const data = JSON.parse(raw)
    forbiddenWords = Array.isArray(data.words) ? data.words : []
    lastLoadedAt = Date.now()
    console.log(`[chat] loaded ${forbiddenWords.length} forbidden words`)
  } catch (e: any) {
    console.error(`[chat] failed to load forbidden words: ${e.message}`)
  }
}

loadWords()
// Hot-reload every 30s — admin can edit JSON without restart
setInterval(loadWords, 30_000).unref()

export function getForbiddenWordCount(): number { return forbiddenWords.length }

// roleUuid -> expiresAt (sec)
const mutes = new Map<string, number>()

export function isMuted(roleUuid: string, now: number = Math.floor(Date.now() / 1000)): boolean {
  const exp = mutes.get(roleUuid)
  if (exp == null) return false
  if (now > exp) { mutes.delete(roleUuid); return false }
  return true
}

export function mute(roleUuid: string, durationSec: number, reason: string) {
  mutes.set(roleUuid, Math.floor(Date.now() / 1000) + durationSec)
  console.log(`[chat-mute] role=${roleUuid} dur=${durationSec}s reason=${reason}`)
}

export function unmute(roleUuid: string) {
  mutes.delete(roleUuid)
}

export interface ChatResult {
  ok: boolean
  reason?: string
}

export function sendMessage(roleUuid: string, channel: string, text: string): ChatResult {
  if (isMuted(roleUuid)) return { ok: false, reason: 'MUTED' }
  const lower = text.toLowerCase()
  for (const w of forbiddenWords) {
    if (lower.includes(w.toLowerCase())) return { ok: false, reason: 'FORBIDDEN' }
  }
  console.log(`[chat-msg] role=${roleUuid} ch=${channel} text=${text.slice(0, 32)}`)
  return { ok: true }
}

export interface ChatMessage { id: string; roleUuid: string; text: string; at: number }
const _history: ChatMessage[] = []
let _idCounter = 0

export function sendAndStore(roleUuid: string, channel: string, text: string): ChatResult {
  const r = sendMessage(roleUuid, channel, text)
  if (r.ok) {
    _idCounter++
    _history.push({ id: `msg_${_idCounter}`, roleUuid, text, at: Math.floor(Date.now() / 1000) })
    // 30-day TTL retention
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400
    while (_history.length > 0 && _history[0].at < cutoff) _history.shift()
  }
  return r
}

export function listMessages(channel: string, before: number, limit: number) {
  return {
    ok: true,
    s2c_messages: _history.filter(m => m.at < before).slice(-limit)
  }
}
