import type { V1Pod } from '@kubernetes/client-node'
import type { PodInfo } from './types.ts'

// Only name, readiness, status and creation time leave the cluster: no IPs, node names or env.
// STATUS follows kubectl: a deleted pod is Terminating, a container that has not started shows why
// (ContainerCreating, CrashLoopBackOff, ImagePullBackOff), a finished Job pod is Completed.
export function podInfo(p: V1Pod): PodInfo {
  const init = p.status?.initContainerStatuses ?? []
  const containers = p.status?.containerStatuses ?? []
  const waiting = [...init, ...containers].find((c) => c.state?.waiting?.reason)?.state?.waiting?.reason
  const phase = p.status?.phase
  let status = waiting ?? (phase === 'Succeeded' ? 'Completed' : phase === 'Failed' ? 'Error' : (phase ?? 'Unknown'))
  if (p.metadata?.deletionTimestamp) status = 'Terminating'
  return {
    name: p.metadata?.name ?? '',
    ready: `${containers.filter((c) => c.ready).length}/${p.spec?.containers.length ?? 0}`,
    status,
    createdAt: p.metadata?.creationTimestamp ? new Date(p.metadata.creationTimestamp).getTime() : 0,
  }
}
