import * as k8s from '@kubernetes/client-node'
import { podInfo } from './pods.ts'
import { parseProm, summarize } from './prom.ts'
import type { Cluster, DbStatus, LogLine, Metrics, Phase, PodInfo, VisitStore } from './types.ts'

const GROUP = 'db.harshdev.io'
const VERSION = 'v1'
const EMPTY: Metrics = { reconciles: null, reconcileAvgMs: null, backups: null, restores: null, recoveryAvgSec: null }
const notFound = (e: unknown) => (e as { code?: number; statusCode?: number }).code === 404 || (e as { statusCode?: number }).statusCode === 404

// Reads the operator's state and, on request, deletes the demo database's volume (and its pod,
// so the volume can finish terminating). It never touches anything else: the Role in
// k8s/portfolio-api.yaml only allows those two deletes, by name.
export class K8sCluster implements Cluster {
  private custom: k8s.CustomObjectsApi
  private core: k8s.CoreV1Api
  private apps: k8s.AppsV1Api
  private st: DbStatus
  private m: Metrics = EMPTY
  private podList: PodInfo[] = []
  private log: (l: LogLine) => void = () => {}
  private seenEvents: Set<string> | null = null
  private lastReconciles: number | null = null
  private busy = false
  private ns: string
  private name: string
  private metricsUrl: string
  visits: VisitStore

  constructor(ns: string, name: string, metricsUrl: string, visits: VisitStore) {
    this.ns = ns
    this.name = name
    this.metricsUrl = metricsUrl
    this.visits = visits
    const kc = new k8s.KubeConfig()
    kc.loadFromDefault()
    this.custom = kc.makeApiClient(k8s.CustomObjectsApi)
    this.core = kc.makeApiClient(k8s.CoreV1Api)
    this.apps = kc.makeApiClient(k8s.AppsV1Api)
    this.st = { name, namespace: ns, phase: 'Creating', lastBackup: null, backupCount: 0 }
  }

  start(onLog: (l: LogLine) => void) {
    this.log = onLog
    const guard = (fn: () => Promise<void>) => async () => {
      if (this.busy) return
      this.busy = true
      try {
        await fn()
      } catch (e) {
        console.warn('poll failed:', (e as Error).message)
      } finally {
        this.busy = false
      }
    }
    setInterval(guard(() => this.refresh()), 2000)
    setInterval(() => void this.scrape(), 5000)
    void this.refresh()
    void this.scrape()
  }

  status() {
    return this.st
  }

  metrics() {
    return this.m
  }

  pods() {
    return this.podList
  }

  async destroy() {
    await this.core.deleteNamespacedPersistentVolumeClaim({ name: `${this.name}-data`, namespace: this.ns })
    // The volume is protected while a pod uses it, so remove the pod too; the StatefulSet recreates it.
    await this.core.deleteNamespacedPod({ name: `${this.name}-0`, namespace: this.ns, gracePeriodSeconds: 0 })
    this.log({ level: 'error', text: `pvc/${this.name}-data deleted` })
  }

  private async refresh() {
    const { ns, name } = this
    const cr = await this.custom
      .getNamespacedCustomObject({ group: GROUP, version: VERSION, namespace: ns, plural: 'managedpostgres', name })
      .catch((e) => (notFound(e) ? null : Promise.reject(e)))
    if (!cr) {
      this.st = { ...this.st, phase: 'Creating' }
      return
    }
    const crStatus = ((cr as { status?: Record<string, unknown> }).status ?? {}) as { phase?: Phase; lastBackup?: string; backupCount?: number }

    const restores = (await this.custom.listNamespacedCustomObject({ group: GROUP, version: VERSION, namespace: ns, plural: 'postgresrestores' })) as {
      items?: { spec?: { targetDatabase?: string }; status?: { phase?: string } }[]
    }
    const restoring = (restores.items ?? []).some((r) => r.spec?.targetDatabase === name && ['Pending', 'Running', undefined].includes(r.status?.phase))

    const sts = await this.apps.readNamespacedStatefulSet({ name, namespace: ns }).catch((e) => (notFound(e) ? null : Promise.reject(e)))
    const pvc = await this.core.readNamespacedPersistentVolumeClaim({ name: `${name}-data`, namespace: ns }).catch((e) => (notFound(e) ? null : Promise.reject(e)))

    let phase: Phase = restoring ? 'Restoring' : (crStatus.phase ?? 'Creating')
    // The operator only reconciles on a timer; look at the objects directly so the UI reacts at once.
    const podReady = (sts?.status?.readyReplicas ?? 0) >= 1
    const pvcGone = !pvc || !!pvc.metadata?.deletionTimestamp
    if (phase === 'Running' && (!podReady || pvcGone)) phase = 'Degraded'

    this.st = { name, namespace: ns, phase, lastBackup: crStatus.lastBackup ?? null, backupCount: crStatus.backupCount ?? 0 }
    this.podList = await this.listPods().catch((e) => {
      console.warn('pod list failed:', (e as Error).message) // most likely the Role lacks pods list: reapply k8s/portfolio-api.yaml
      return []
    })
    await this.pullEvents()
  }

  // The same table `kubectl get pods` prints. Finished Job pods (old backups, past restores) pile up,
  // so ones that completed over half an hour ago are left out.
  private async listPods() {
    const stale = Date.now() - 30 * 60_000
    const list = await this.core.listNamespacedPod({ namespace: this.ns })
    return list.items
      .map(podInfo)
      .filter((p) => !(p.status === 'Completed' && p.createdAt < stale))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  // Events the operator posts (drift healed, data loss detected, auto-restore) become the live feed.
  private async pullEvents() {
    const list = await this.core.listNamespacedEvent({ namespace: this.ns, fieldSelector: `involvedObject.name=${this.name}` })
    const first = this.seenEvents === null
    this.seenEvents ??= new Set()
    for (const e of list.items) {
      const id = e.metadata?.uid
      if (!id || this.seenEvents.has(id)) continue
      this.seenEvents.add(id)
      if (!first) this.log({ level: e.type === 'Warning' ? 'warn' : 'info', text: `${e.reason}: ${e.message}` })
    }
  }

  private async scrape() {
    try {
      const res = await fetch(this.metricsUrl, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      this.m = summarize(parseProm(await res.text()))
      const n = this.m.reconciles
      if (n !== null && this.lastReconciles !== null && n > this.lastReconciles) this.log({ level: 'info', text: `reconcile loop ran (${n} total)` })
      this.lastReconciles = n
    } catch {
      this.m = EMPTY
    }
  }
}
