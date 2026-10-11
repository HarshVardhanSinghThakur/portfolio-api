import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { FakeCluster } from './fake.ts'
import { K8sCluster } from './k8s.ts'
import type { Cluster, DestroyGuard, LogLine, Snapshot, VisitStats } from './types.ts'
import { friendlyError, pgVisits } from './visits.ts'

const PORT = Number(process.env.PORT ?? 8787)
const COOLDOWN_MS = Number(process.env.DESTROY_COOLDOWN_SEC ?? 300) * 1000
const TRUST_PROXY = process.env.TRUST_PROXY === '1'
const HOUR = 3_600_000

function makeCluster(): Cluster {
  if (process.env.CLUSTER === 'fake') return new FakeCluster()
  const ns = process.env.NAMESPACE ?? 'portfolio'
  const name = process.env.DB_NAME ?? 'demo-db'
  return new K8sCluster(ns, name, process.env.OPERATOR_METRICS_URL ?? `http://postgres-operator.${ns}.svc:8080/metrics`, pgVisits())
}
const cluster = makeCluster()

// ── live feed ───────────────────────────────────────────────────────
interface LogEvent extends LogLine {
  id: number
  ts: number
}
const recent: LogEvent[] = []
const clients = new Set<ServerResponse>()
let seq = 0

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const broadcast = (event: string, data: unknown) => {
  for (const c of clients) c.write(sse(event, data))
}
function pushLog(line: LogLine) {
  const e = { ...line, id: ++seq, ts: Date.now() }
  recent.push(e)
  if (recent.length > 20) recent.shift()
  broadcast('log', e)
}

// ── abuse limits: visitor identity lives only in memory, as a salted hash ──
const SALT = randomBytes(16).toString('hex')
const hits = new Map<string, number[]>()
const who = (req: IncomingMessage) => {
  const forwarded = TRUST_PROXY ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : ''
  return createHash('sha256')
    .update(SALT + (forwarded || req.socket.remoteAddress || ''))
    .digest('hex')
    .slice(0, 16)
}
function allow(key: string, limit: number) {
  const now = Date.now()
  const recentHits = (hits.get(key) ?? []).filter((t) => now - t < HOUR)
  if (recentHits.length >= limit) {
    hits.set(key, recentHits)
    return false
  }
  hits.set(key, [...recentHits, now])
  return true
}
setInterval(() => {
  const now = Date.now()
  for (const [k, ts] of hits) if (ts.every((t) => now - t >= HOUR)) hits.delete(k)
}, 10 * 60_000).unref()

// ── the delete button's rules ───────────────────────────────────────
let lastDestroyAt = 0
function guard(): DestroyGuard {
  const s = cluster.status()
  if (s.phase !== 'Running') return { allowed: false, reason: 'The database is already down.' }
  if (!s.lastBackup) return { allowed: false, reason: 'No backup exists yet, so a deletion could not be undone.' }
  const left = COOLDOWN_MS - (Date.now() - lastDestroyAt)
  if (left > 0) return { allowed: false, reason: 'Cooling down after the last deletion.', cooldownSec: Math.ceil(left / 1000) }
  return { allowed: true }
}

// ── snapshots ───────────────────────────────────────────────────────
async function snapshot(): Promise<Snapshot> {
  let visits: VisitStats
  try {
    visits = { ok: true, ...(await cluster.visits.stats()) }
  } catch (e) {
    visits = { ok: false, error: friendlyError(e) }
  }
  return { simulated: process.env.CLUSTER === 'fake', status: cluster.status(), metrics: cluster.metrics(), visits, viewers: clients.size, destroy: guard() }
}

let lastJson = ''
let ticking = false
async function tick() {
  if (ticking || clients.size === 0) return
  ticking = true
  try {
    const snap = await snapshot()
    const json = JSON.stringify(snap)
    if (json !== lastJson) {
      lastJson = json
      broadcast('snapshot', snap)
    }
  } finally {
    ticking = false
  }
}

// ── http ────────────────────────────────────────────────────────────
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage, limit = 2048): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'))
      } catch {
        reject(new Error('bad json'))
      }
    })
    req.on('error', reject)
  })
}

async function stream(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.write('retry: 3000\n\n')
  for (const e of recent.slice(-5)) res.write(sse('log', e))
  clients.add(res)
  req.on('close', () => {
    clients.delete(res)
    void tick()
  })
  res.write(sse('snapshot', await snapshot()))
  void tick()
}

async function visit(req: IncomingMessage, res: ServerResponse) {
  if (!allow(`visit:${who(req)}`, 30)) return json(res, 429, { error: 'too many requests' })
  let body: { visitor?: unknown }
  try {
    body = (await readJson(req)) as { visitor?: unknown }
  } catch {
    return json(res, 400, { error: 'invalid body' })
  }
  if (typeof body.visitor !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(body.visitor)) return json(res, 400, { error: 'invalid visitor id' })
  try {
    await cluster.visits.record(body.visitor)
    void tick()
    return json(res, 201, { ok: true })
  } catch (e) {
    return json(res, 503, { error: friendlyError(e) })
  }
}

async function destroy(req: IncomingMessage, res: ServerResponse) {
  if (!allow(`destroy:${who(req)}`, 3)) return json(res, 429, { error: 'You have used your deletions for this hour.' })
  const g = guard()
  if (!g.allowed) return json(res, 409, g)
  lastDestroyAt = Date.now() // set before awaiting, so a double click cannot start two deletions
  pushLog({ level: 'warn', text: 'A visitor pressed the delete button' })
  try {
    await cluster.destroy()
  } catch (e) {
    lastDestroyAt = 0
    console.error('destroy failed:', e)
    return json(res, 502, { error: 'The cluster refused the deletion.' })
  }
  void tick()
  return json(res, 202, { ok: true })
}

const server = createServer(async (req, res) => {
  const route = `${req.method} ${new URL(req.url ?? '/', 'http://localhost').pathname}`
  try {
    switch (route) {
      case 'GET /api/health':
        return json(res, 200, { ok: true })
      case 'GET /api/stream':
        return await stream(req, res)
      case 'POST /api/visit':
        return await visit(req, res)
      case 'POST /api/destroy':
        return await destroy(req, res)
      default:
        return json(res, 404, { error: 'not found' })
    }
  } catch (e) {
    console.error(route, e)
    if (!res.headersSent) json(res, 500, { error: 'internal error' })
  }
})

cluster.start(pushLog)
setInterval(() => void tick(), 2000)
setInterval(() => broadcast('ping', {}), 15_000).unref()
server.listen(PORT, () => console.log(`portfolio-api on :${PORT} (${process.env.CLUSTER === 'fake' ? 'fake cluster' : 'kubernetes'})`))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
