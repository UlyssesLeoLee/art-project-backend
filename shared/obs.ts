// DX-OBS: pino logger with daily file rotation (no extra deps: pino.destination + manual rollover)
// DX-MET: Prometheus-style metrics registry (counter/gauge/histogram-lite)
// DX-HEA: health state (liveness/readiness)

import { pino, multistream, type Logger } from 'pino'
import { mkdirSync, appendFileSync, renameSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { config } from './config.js'

// ---------------- logging ----------------

mkdirSync(config.log.dir, { recursive: true })

function todayFile(): string {
  const d = new Date().toISOString().slice(0, 10)
  return join(config.log.dir, `server-${d}.log`)
}

let currentDate = new Date().toISOString().slice(0, 10)
let stream: NodeJS.WritableStream = process.stdout

function ensureStream() {
  const d = new Date().toISOString().slice(0, 10)
  if (d !== currentDate) {
    // rotate: current file already dated; prune old files beyond maxFiles
    currentDate = d
    pruneOldLogs()
  }
}

function pruneOldLogs() {
  try {
    const files = readdirSync(config.log.dir)
      .filter((f: string) => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort()
    while (files.length > config.log.maxFiles) {
      const old = files.shift()!
      try { renameSync(join(config.log.dir, old), join(config.log.dir, old + '.old')) } catch { /* ignore */ }
    }
  } catch { /* non-fatal */ }
}

// Dual destination: stdout (for console) + dated file
const fileDest = {
  write(line: string) {
    ensureStream()
    try { appendFileSync(todayFile(), line) } catch { /* non-fatal */ }
  },
}

export const log: Logger = pino(
  { level: config.log.level },
  multistream([
    { stream: process.stdout },
    { stream: fileDest as unknown as NodeJS.WritableStream },
  ])
)

// ---------------- shared metrics store ----------------
// Both HTTP and TCP processes share the same SQLite file for metrics, so a single
// /metrics scrape (HTTP) sees the union of all protocol events. Counters are
// accumulated by metric+labels in `metrics_agg`; renderMetrics() merges persisted
// rows with live in-process gauges.
import type { DatabaseSync } from 'node:sqlite'
let metricsDb: DatabaseSync | null = null
export function attachMetricsDb(db: DatabaseSync) {
  metricsDb = db
  try { db.exec(`CREATE TABLE IF NOT EXISTS metrics_agg(metric TEXT NOT NULL, labels_key TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY(metric, labels_key))`) } catch {}
}
function bumpMetricsDb(metric: string, labelsKey: string, by = 1) {
  if (!metricsDb) return
  try {
    metricsDb.prepare(`INSERT INTO metrics_agg(metric, labels_key, value) VALUES (?, ?, ?)
                       ON CONFLICT(metric, labels_key) DO UPDATE SET value = value + ?`)
      .run(metric, labelsKey, by, by)
  } catch { /* non-fatal */ }
}
function readMetricsDb(): Array<{ metric: string; key: string; value: number }> {
  if (!metricsDb) return []
  try {
    return (metricsDb.prepare(`SELECT metric, labels_key AS k, value FROM metrics_agg`).all() as Array<{ metric: string; k: string; value: number | string }>)
      .map((r: { metric: string; k: string; value: number | string }) => ({ metric: r.metric, key: r.k, value: Number(r.value) }))
  } catch { return [] }
}

// ---------------- metrics ----------------

interface Metric { name: string; help: string; type: 'counter' | 'gauge'; labels: string[]; values: Map<string, number> }

const metrics = new Map<string, Metric>()

function keyOf(labels: Record<string, string>, order: string[]): string {
  return order.map(l => labels[l] ?? '').join('\u0000')
}

export function counter(name: string, help: string, labels: string[] = []) {
  if (!metrics.has(name)) metrics.set(name, { name, help, type: 'counter', labels, values: new Map() })
  return (labelVals: Record<string, string> = {}, by = 1) => {
    const m = metrics.get(name)!
    const k = keyOf(labelVals, m.labels)
    m.values.set(k, (m.values.get(k) ?? 0) + by)
    if (metricsDb) bumpMetricsDb(name, k, by)
  }
}

export function gauge(name: string, help: string, labels: string[] = []) {
  if (!metrics.has(name)) metrics.set(name, { name, help, type: 'gauge', labels, values: new Map() })
  return (labelVals: Record<string, string> = {}, value = 0) => {
    const m = metrics.get(name)!
    m.values.set(keyOf(labelVals, m.labels), value)
  }
}

export function renderMetrics(): string {
  const out: string[] = []
  // Merge aggregated counters from DB (persisted by all processes — TCP & HTTP).
  // Gauges: prefer live in-process values; fall back to last-persisted reading.
  // Counters: in-process local increment + persisted last-value are summed.
  if (metricsDb) {
    const persistedByMetric = new Map<string, Map<string, number>>()
    for (const r of readMetricsDb()) {
      let bucket = persistedByMetric.get(r.metric)
      if (!bucket) { bucket = new Map(); persistedByMetric.set(r.metric, bucket) }
      bucket.set(r.key, r.value)
    }
    const seen = new Set<string>()
    for (const [metric, bucket] of persistedByMetric) {
      const inProc = metrics.get(metric)
      const help = inProc?.help ?? metric
      const labels = inProc?.labels ?? []
      const type = inProc?.type ?? 'counter'
      out.push(`# HELP ${metric} ${help}`)
      out.push(`# TYPE ${metric} ${type}`)
      for (const [k, val] of bucket) {
        const local = inProc?.values.get(k) ?? 0
        const merged = type === 'gauge' ? val : (val + local)
        const parts = k.split('\u0000')
        const labelStr = labels.length ? '{' + labels.map((l, i) => `${l}="${parts[i] ?? ''}"`).join(',') + '}' : ''
        out.push(`${metric}${labelStr} ${merged}`)
      }
      seen.add(metric)
          }
          for (const m of metrics.values()) {
            if (seen.has(m.name)) continue
            // No persisted data; render live in-process values
            out.push(`# HELP ${m.name} ${m.help}`)
            out.push(`# TYPE ${m.name} ${m.type}`)
            for (const [k, v] of m.values) {
              const parts = k.split('\u0000')
              const labelStr = m.labels.length
                ? '{' + m.labels.map((l: string, i: number) => `${l}="${parts[i] ?? ''}"`).join(',') + '}'
                : ''
              out.push(`${m.name}${labelStr} ${v}`)
            }
          }
        }
  // process defaults
  out.push(`# HELP process_uptime_seconds uptime`)
  out.push(`# TYPE process_uptime_seconds gauge`)
  out.push(`process_uptime_seconds ${process.uptime().toFixed(1)}`)
  const mem = process.memoryUsage()
  out.push(`# HELP process_resident_memory_bytes rss`)
  out.push(`# TYPE process_resident_memory_bytes gauge`)
  out.push(`process_resident_memory_bytes ${mem.rss}`)
  return out.join('\n') + '\n'
}

// Pre-registered app metrics
export const httpRequests = counter('http_requests_total', 'HTTP requests', ['method', 'path', 'status'])
export const tcpMessages = counter('tcp_messages_total', 'TCP protocol messages', ['route', 'result'])
export const tcpConnections = gauge('tcp_connections', 'Current TCP connections')
export const battleSeeds = gauge('battle_seeds_active', 'Active battle seeds')
export const dbErrors = counter('db_errors_total', 'DB errors')

// ---------------- health ----------------

export interface HealthState {
  startedAt: number
  dbOk: boolean
  dbLastError?: string
  tcpListening: boolean
  httpListening: boolean
}

export const health: HealthState = {
  startedAt: Date.now(),
  dbOk: true,
  tcpListening: false,
  httpListening: false,
}

export function liveness() {
  return { status: 'ok', uptime: Math.floor(process.uptime()) }
}

export function readiness() {
  const ok = health.dbOk && (health.tcpListening || health.httpListening)
  return {
    status: ok ? 'ready' : 'not_ready',
    db: health.dbOk,
    tcp: health.tcpListening,
    http: health.httpListening,
    uptime: Math.floor(process.uptime()),
    dbLastError: health.dbLastError,
  }
}