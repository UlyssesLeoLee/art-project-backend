// Migrations runner: applies db/migrations/*.sql in numeric order, idempotent, version-tracked.
// Run as:
//   node --import tsx db/migrations/run.ts
// Or auto-applied at service boot via autoMigrate(db).

import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const DB_PATH = process.env.DB_PATH || './data/game.db'
const MIGRATIONS_DIR = './db/migrations'

interface MigrationRow { id: number; name: string; applied_at: number }

function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  return new DatabaseSync(path)
}

function ensureTable(db: DatabaseSync): void {
  const ddlPath = `${MIGRATIONS_DIR}/_migrations.sql`
  const ddl = readFileSync(ddlPath, 'utf8')
  db.exec(ddl)
}

function appliedSet(db: DatabaseSync): Set<string> {
  const rows = db.prepare(`SELECT name FROM _migrations`).all() as Array<{ name: string }>
  return new Set(rows.map(r => r.name))
}

function listMigrationFiles(): Array<{ file: string; id: number; name: string }> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql') && f !== '_migrations.sql')
    .sort() // ascending lexicographic — works for "001_*", "002_*" etc.
  return files.map(file => {
    const m = /^(\d+)_/.exec(file)
    if (!m) throw new Error(`migration file must start with digits: ${file}`)
    return { file, id: parseInt(m[1], 10), name: file }
  })
}

export function runMigrations(db: DatabaseSync, dir: string = MIGRATIONS_DIR): { applied: string[]; skipped: string[] } {
  const applied: string[] = []
  const skipped: string[] = []
  ensureTable(db)
  const applied_so_far = appliedSet(db)
  for (const m of listMigrationFiles()) {
    if (applied_so_far.has(m.name)) {
      skipped.push(m.name)
      continue
    }
    const sql = readFileSync(`${dir}/${m.file}`, 'utf8')
    // SQLite DDL is auto-committed; explicit BEGIN/COMMIT breaks PRAGMA statements
    // inside migrations. We record to _migrations *after* successful exec; if that
    // record fails, the next run will re-attempt (idempotent migrations are safe).
    try {
      db.exec(sql)
      db.prepare(`INSERT INTO _migrations(id, name, applied_at) VALUES (?, ?, ?)`)
        .run(m.id, m.name, Math.floor(Date.now() / 1000))
      applied.push(m.name)
      console.log(`[migrate] applied ${m.name}`)
    } catch (e) {
      throw new Error(`migration ${m.name} failed: ${(e as Error).message}`)
    }
  }
  return { applied, skipped }
}

// CLI entry
if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  const db = openDb(DB_PATH)
  console.log(`[migrate] db=${DB_PATH}`)
  const r = runMigrations(db)
  console.log(`[migrate] done. applied=${r.applied.length} skipped=${r.skipped.length}`)
}
