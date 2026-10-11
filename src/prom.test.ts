import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseProm, summarize } from './prom.ts'

const sample = `
# HELP postgres_operator_reconcile_total Total reconciliation loops executed
# TYPE postgres_operator_reconcile_total counter
postgres_operator_reconcile_total{namespace="portfolio",result="noop"} 40
postgres_operator_reconcile_total{namespace="portfolio",result="healed"} 2
postgres_operator_reconcile_duration_seconds_bucket{namespace="portfolio",le="0.1"} 40
postgres_operator_reconcile_duration_seconds_sum{namespace="portfolio"} 0.21
postgres_operator_reconcile_duration_seconds_count{namespace="portfolio"} 42
postgres_operator_backups_success_total{namespace="portfolio",instance="demo-db",backend="local"} 7
postgres_operator_recovery_duration_seconds_sum{namespace="portfolio"} 90
postgres_operator_recovery_duration_seconds_count{namespace="portfolio"} 3
`

test('sums label variants and derives averages', () => {
  const m = summarize(parseProm(sample))
  assert.equal(m.reconciles, 42)
  assert.equal(m.reconcileAvgMs, 5)
  assert.equal(m.backups, 7)
  assert.equal(m.recoveryAvgSec, 30)
})

test('missing series are null, not zero', () => {
  const m = summarize(parseProm(''))
  assert.equal(m.reconciles, null)
  assert.equal(m.restores, null)
  assert.equal(m.recoveryAvgSec, null)
})
