import pg from 'pg'
import type { VisitStore } from './types.ts'

// Short label for the UI. It is what the database driver really said, not a message I made up.
export function friendlyError(e: unknown): string {
  const err = e as { code?: string; message?: string }
  if (err.code) return err.code
  return (err.message ?? 'unknown error').slice(0, 60)
}

// Connects to the demo database with the standard PG* environment variables
// (host, user, password and database come from the operator-created Secret).
export function pgVisits(): VisitStore {
  const pool = new pg.Pool({ connectionTimeoutMillis: 2000, idleTimeoutMillis: 10_000, max: 4 })
  // An idle client dying (the database was just deleted) must not crash the process.
  pool.on('error', () => {})

  const ensure = () =>
    pool.query('CREATE TABLE IF NOT EXISTS visits (id bigserial PRIMARY KEY, visitor text NOT NULL, at timestamptz NOT NULL DEFAULT now())')

  // After a restore from an older backup the table may not exist yet: create it once and retry.
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      if ((e as { code?: string }).code !== '42P01') throw e
      await ensure()
      return fn()
    }
  }

  return {
    async record(visitor) {
      await run(() => pool.query('INSERT INTO visits (visitor) VALUES ($1)', [visitor]))
    },
    async stats() {
      const r = await run(() => pool.query<{ total: number; unique: number }>('SELECT count(*)::int AS total, count(DISTINCT visitor)::int AS unique FROM visits'))
      return r.rows[0]
    },
  }
}
