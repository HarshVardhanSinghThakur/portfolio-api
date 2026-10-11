import type { Cluster, DbStatus, LogLine, Metrics, Phase, PodInfo, VisitStore } from './types.ts'

const pod = (name: string, status: string, ageMs: number, ready = '1/1'): PodInfo => ({ name, ready, status, createdAt: Date.now() - ageMs })

// A stand-in for the real operator so the whole site can be developed and tested without
// a cluster. Messages mirror what the operator logs. Deleting wipes the visit table and a
// "restore" brings back the last backup, so the rollback behaviour is real here too.
export class FakeCluster implements Cluster {
  private phase: Phase = 'Running'
  private lastBackup: string | null = new Date(Date.now() - 20_000).toISOString()
  private backupCount = 3
  private rows: string[] = Array.from({ length: 120 }, (_, i) => `seed-${i % 23}`)
  private backupRows = [...this.rows]
  private reconciles = 0
  private reconcileMs: number[] = []
  private restores = 0
  private recoverySecs: number[] = []
  private log: (l: LogLine) => void = () => {}
  private timers: ReturnType<typeof setTimeout>[] = []
  // the pods `kubectl get pods` would list: three that never change, plus the database pod and the restore Job pod
  private others = [pod('portfolio-api-6d8f7c9b5-x2k4q', 'Running', 3_600_000), pod('portfolio-site-5c7b8d6f4-m9p2w', 'Running', 3_600_000), pod('postgres-operator-7977fc4b55-smvvk', 'Running', 7_200_000)]
  private dbPod: PodInfo | null = pod('demo-db-0', 'Running', 600_000)
  private restorePod: PodInfo | null = null
  // exported so the server can read a single namespace/name pair
  readonly name = 'demo-db'
  readonly namespace = 'portfolio'

  private up() {
    if (this.phase !== 'Running') throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
  }

  visits: VisitStore = {
    record: async (v) => {
      this.up()
      this.rows.push(v)
    },
    stats: async () => {
      this.up()
      return { total: this.rows.length, unique: new Set(this.rows).size }
    },
  }

  start(onLog: (l: LogLine) => void) {
    this.log = onLog
    setInterval(() => {
      if (this.phase !== 'Running') return
      this.reconciles++
      this.reconcileMs.push(2 + Math.random() * 6)
      onLog({ level: 'info', text: `reconcile loop ran (${this.reconciles} total)` })
    }, 5000)
    setInterval(() => {
      if (this.phase !== 'Running') return
      this.backupRows = [...this.rows]
      this.lastBackup = new Date().toISOString()
      this.backupCount++
      onLog({ level: 'info', text: `backup complete (${this.backupRows.length} visits captured)` })
    }, 45_000)
  }

  status(): DbStatus {
    return { name: this.name, namespace: this.namespace, phase: this.phase, lastBackup: this.lastBackup, backupCount: this.backupCount }
  }

  metrics(): Metrics {
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
    return {
      reconciles: this.reconciles,
      reconcileAvgMs: avg(this.reconcileMs.slice(-20)),
      backups: this.backupCount,
      restores: this.restores,
      recoveryAvgSec: avg(this.recoverySecs),
    }
  }

  pods() {
    return [...this.others, this.dbPod, this.restorePod].filter((p) => p !== null).sort((a, b) => a.name.localeCompare(b.name))
  }

  async destroy() {
    const t0 = Date.now()
    const later = (ms: number, fn: () => void) => this.timers.push(setTimeout(fn, ms))
    this.phase = 'Degraded'
    this.rows = []
    if (this.dbPod) this.dbPod = { ...this.dbPod, ready: '0/1', status: 'Terminating' }
    this.log({ level: 'error', text: `pvc/${this.name}-data deleted` })
    later(700, () => (this.dbPod = null))
    later(1300, () => this.log({ level: 'warn', text: 'PVC UID changed: data loss detected' }))
    // no pod at all until the operator has recreated the volume (about a reconcile interval), like the real cluster
    later(2600, () => {
      this.dbPod = pod('demo-db-0', 'Pending', 0, '0/1')
      this.log({ level: 'warn', text: `auto-restore: PostgresRestore ${this.name}-auto created (backupFile=latest)` })
    })
    later(3200, () => {
      if (this.dbPod) this.dbPod = { ...this.dbPod, status: 'ContainerCreating' }
    })
    later(3800, () => {
      this.phase = 'Restoring'
      if (this.dbPod) this.dbPod = { ...this.dbPod, ready: '1/1', status: 'Running' }
      this.restorePod = pod('demo-db-auto-restore-x7k2p', 'Running', 0, '0/1')
      this.log({ level: 'info', text: `restore Job ${this.name}-auto-restore started` })
    })
    later(6600, () => this.log({ level: 'info', text: 'gunzip | psql: restoring from newest backup' }))
    later(9000, () => {
      if (this.restorePod) this.restorePod = { ...this.restorePod, status: 'Completed' }
      this.rows = [...this.backupRows]
      this.log({ level: 'info', text: `restore finished: ${this.rows.length} visits recovered` })
    })
    later(9800, () => {
      this.phase = 'Running'
      this.restores++
      this.recoverySecs.push((Date.now() - t0) / 1000)
      this.log({ level: 'ok', text: `${this.name} is Running again` })
    })
  }
}
