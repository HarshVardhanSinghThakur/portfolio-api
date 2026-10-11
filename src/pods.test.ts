import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { V1Pod } from '@kubernetes/client-node'
import { podInfo } from './pods.ts'

const pod = (x: object) => x as V1Pod
const meta = { name: 'demo-db-0', creationTimestamp: new Date('2026-10-11T12:00:00Z') }

test('a running pod', () => {
  const p = podInfo(pod({ metadata: meta, spec: { containers: [{}] }, status: { phase: 'Running', containerStatuses: [{ ready: true }] } }))
  assert.deepEqual(p, { name: 'demo-db-0', ready: '1/1', status: 'Running', createdAt: Date.parse('2026-10-11T12:00:00Z') })
})

test('a container that has not started shows its waiting reason', () => {
  const creating = pod({ metadata: meta, spec: { containers: [{}] }, status: { phase: 'Pending', containerStatuses: [{ ready: false, state: { waiting: { reason: 'ContainerCreating' } } }] } })
  assert.equal(podInfo(creating).status, 'ContainerCreating')
  assert.equal(podInfo(creating).ready, '0/1')
  assert.equal(podInfo(pod({ metadata: meta, spec: { containers: [{}] }, status: { phase: 'Pending' } })).status, 'Pending')
})

test('deletion wins over everything else', () => {
  const dying = pod({ metadata: { ...meta, deletionTimestamp: new Date() }, spec: { containers: [{}] }, status: { phase: 'Running', containerStatuses: [{ ready: true }] } })
  assert.equal(podInfo(dying).status, 'Terminating')
})

test('job pods end as Completed or Error', () => {
  assert.equal(podInfo(pod({ metadata: meta, spec: { containers: [{}] }, status: { phase: 'Succeeded', containerStatuses: [{ ready: false }] } })).status, 'Completed')
  assert.equal(podInfo(pod({ metadata: meta, spec: { containers: [{}] }, status: { phase: 'Failed' } })).status, 'Error')
})
