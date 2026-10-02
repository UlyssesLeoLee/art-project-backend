// Config loader (DX-CFG): reads config/<env>.json and expands ${VAR} / ${VAR:-default}
// placeholders from process.env. Env selection: APP_ENV || NODE_ENV || 'dev'.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export interface AppConfig {
  env: string
  http: { port: number; host: string }
  tcp: { port: number; host: string }
  db: { path: string }
  secrets: { secretKey: string; jwtSecret: string }
  game: { serverId: string; cdnUrl: string; heartbeatMs: number; battleRecordUrlPrefix: string }
  pay: { notifyUrl: string; quickAppKey: string; tianjiAppKey: string; ymnAppKey: string }
  log: { level: string; dir: string; maxFiles: number }
  tls: { enabled: boolean; cert: string; key: string }
  cors: { origins: string[] }
}

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function expand(text: string): string {
  return text.replace(/\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}/g, (_m, name, dflt) => {
    const v = process.env[name]
    return v != null && v !== '' ? v : (dflt ?? '')
  })
}

let cached: AppConfig | null = null

export function loadConfig(): AppConfig {
  if (cached) return cached
  const env = process.env.APP_ENV || process.env.NODE_ENV || 'dev'
  const path = join(root, 'config', `${env}.json`)
  let raw: string
  if (existsSync(path)) {
    raw = readFileSync(path, 'utf8')
  } else {
    // fall back to dev config, then to safe defaults
    const devPath = join(root, 'config', 'dev.json')
    raw = existsSync(devPath) ? readFileSync(devPath, 'utf8') : '{}'
  }
  const parsed = JSON.parse(expand(raw)) as Partial<AppConfig>
  cached = {
    env,
    http: { port: Number(process.env.PORT ?? parsed.http?.port ?? 8080), host: parsed.http?.host ?? '0.0.0.0' },
    tcp: { port: Number(process.env.GAME_PORT ?? parsed.tcp?.port ?? 19821), host: parsed.tcp?.host ?? '0.0.0.0' },
    db: { path: process.env.DB_PATH ?? parsed.db?.path ?? './data/game.db' },
    secrets: {
      secretKey: parsed.secrets?.secretKey ?? '',
      jwtSecret: parsed.secrets?.jwtSecret ?? 'dev-jwt-secret',
    },
    game: {
      serverId: parsed.game?.serverId ?? 's10001',
      cdnUrl: parsed.game?.cdnUrl ?? '',
      heartbeatMs: Number(parsed.game?.heartbeatMs ?? 15000),
      battleRecordUrlPrefix: parsed.game?.battleRecordUrlPrefix ?? '',
    },
    pay: {
      notifyUrl: parsed.pay?.notifyUrl ?? '',
      quickAppKey: parsed.pay?.quickAppKey ?? '',
      tianjiAppKey: parsed.pay?.tianjiAppKey ?? '',
      ymnAppKey: parsed.pay?.ymnAppKey ?? '',
    },
    log: { level: parsed.log?.level ?? 'info', dir: parsed.log?.dir ?? './logs', maxFiles: Number(parsed.log?.maxFiles ?? 14) },
    tls: {
      enabled: process.env.TLS_ENABLED === 'true' ? true : Boolean(parsed.tls?.enabled ?? false),
      cert: process.env.TLS_CERT_PATH ?? parsed.tls?.cert ?? '',
      key: process.env.TLS_KEY_PATH ?? parsed.tls?.key ?? '',
    },
    cors: {
      origins: (process.env.CORS_ORIGINS ?? (Array.isArray(parsed.cors?.origins) ? parsed.cors.origins.join(',') : (parsed.cors?.origins as unknown as string) ?? '*'))
        .split(',').map((s: string) => s.trim()).filter(Boolean),
    },
  }
  return cached
}

export const config = loadConfig()