import type { Metrics } from './types.ts'

// Sum every series of each metric name; label sets are ignored on purpose, there is one demo database.
export function parseProm(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+(\S+)/)
    if (!m) continue
    const value = Number(m[2])
    if (Number.isFinite(value)) out.set(m[1], (out.get(m[1]) ?? 0) + value)
  }
  return out
}

const avg = (p: Map<string, number>, base: string, scale: number) => {
  const count = p.get(`${base}_count`)
  const sum = p.get(`${base}_sum`)
  return count && sum !== undefined ? (sum / count) * scale : null
}

export function summarize(p: Map<string, number>): Metrics {
  return {
    reconciles: p.get('postgres_operator_reconcile_total') ?? null,
    reconcileAvgMs: avg(p, 'postgres_operator_reconcile_duration_seconds', 1000),
    backups: p.get('postgres_operator_backups_success_total') ?? null,
    restores: p.get('postgres_operator_restores_completed_total') ?? null,
    recoveryAvgSec: avg(p, 'postgres_operator_recovery_duration_seconds', 1),
  }
}
