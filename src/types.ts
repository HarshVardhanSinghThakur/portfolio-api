export type Phase = 'Creating' | 'Running' | 'Degraded' | 'Restoring' | 'Terminating'
export type Level = 'info' | 'warn' | 'error' | 'ok'

export interface LogLine {
  level: Level
  text: string
}

export interface DbStatus {
  name: string
  namespace: string
  phase: Phase
  lastBackup: string | null
  backupCount: number
}

// null = the operator's /metrics could not be read (or has no samples yet)
export interface Metrics {
  reconciles: number | null
  reconcileAvgMs: number | null
  backups: number | null
  restores: number | null
  recoveryAvgSec: number | null
}

export type VisitStats = { ok: true; total: number; unique: number } | { ok: false; error: string }

export interface DestroyGuard {
  allowed: boolean
  reason?: string
  cooldownSec?: number
}

export interface Snapshot {
  simulated: boolean
  status: DbStatus
  metrics: Metrics
  visits: VisitStats
  viewers: number
  destroy: DestroyGuard
}

export interface VisitStore {
  record(visitor: string): Promise<void>
  stats(): Promise<{ total: number; unique: number }>
}

// The one seam between the HTTP server and "whatever is running the database":
// K8sCluster talks to the real operator, FakeCluster simulates it for local dev.
export interface Cluster {
  start(onLog: (line: LogLine) => void): void
  status(): DbStatus
  metrics(): Metrics
  destroy(): Promise<void>
  visits: VisitStore
}
