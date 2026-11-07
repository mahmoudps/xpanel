import { readManagementHosts } from './agent-origin.ts'
import type { AgentExecutor } from './executor.ts'
import { HostReconciler, type ReconcilerDeps } from './reconciler.ts'
import { createNativeDnsReconcileProvider, type DnsReconcileProvider } from './services/dns-native.ts'

/**
 * The one native reconciler composition. The agent and the lifecycle runtime (upgrade, rollback, recovery) must
 * render and verify the same generation: the same DNS validator/observer and the same management TLS hosts.
 * `hostsReader` serves a composition that runs outside the scope its guarded executor requires.
 */
export const createNativeHostReconciler = async (deps: Omit<ReconcilerDeps, 'dnsPublication' | 'managementHosts'>, hostsReader: Pick<AgentExecutor, 'readFile'> = deps.executor): Promise<{ reconciler: HostReconciler; dnsPublication: DnsReconcileProvider }> => {
  const dnsPublication = createNativeDnsReconcileProvider({ executor: deps.executor, family: deps.os.family,
    readOwnedPaths: async () => new Set((await reconciler.ownedChecksums()).keys()),
  })
  const reconciler: HostReconciler = new HostReconciler({ ...deps, dnsPublication, managementHosts: await readManagementHosts(hostsReader) })
  return { reconciler, dnsPublication }
}
