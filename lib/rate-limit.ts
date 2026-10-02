// Rate-limit: token bucket per key. HTTP applies per IP; TCP applies per (roleUuid, messageName).

interface Bucket { count: number; windowStart: number }
const buckets = new Map<string, Bucket>()

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

export function checkRateLimit(key: string, max: number, windowSec: number): RateLimitResult {
  const now = Math.floor(Date.now() / 1000)
  const b = buckets.get(key)
  if (!b || now - b.windowStart >= windowSec) {
    buckets.set(key, { count: 1, windowStart: now })
    return { allowed: true, remaining: max - 1, resetAt: now + windowSec }
  }
  b.count++
  const allowed = b.count <= max
  return { allowed, remaining: Math.max(0, max - b.count), resetAt: b.windowStart + windowSec }
}

// Periodic prune of stale buckets (every 5 min)
setInterval(() => {
  const now = Math.floor(Date.now() / 1000)
  for (const [k, b] of buckets) {
    if (now - b.windowStart > 3600) buckets.delete(k) // 1h stale threshold
  }
}, 300_000).unref()

export const RL = {
  HTTP_LOGIN:        { max: 5,  windowSec: 60 },
  HTTP_REGISTER:     { max: 3,  windowSec: 3600 },
  HTTP_ACTIVATION:   { max: 10, windowSec: 3600 },
  HTTP_BIND:         { max: 10, windowSec: 3600 },
  TCP_FIGHT_RESULT:  { max: 5,  windowSec: 1 },
  TCP_GLOBAL:        { max: 30, windowSec: 1 },
  TCP_GM:            { max: 1,  windowSec: 1 },
  TCP_BATTLE:        { max: 60, windowSec: 60 },
  TCP_CHAT:          { max: 30, windowSec: 60 },
  TCP_PAY:           { max: 5,  windowSec: 3600 },
}
