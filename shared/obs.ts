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
  for (const m of metrics.values()) {
    out.push(`# HELP ${m.name} ${m.help}`)
    out.push(`# TYPE ${m.name} ${m.type}`)
    for (const [k, v] of m.values) {
      const parts = k.split('\u0000')
      const labelStr = m.labels.length
        ? '{' + m.labels.map((l, i) => `${l}="${parts[i]}"`).join(',') + '}'
        : ''
      out.push(`${m.name}${labelStr} ${v}`)
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