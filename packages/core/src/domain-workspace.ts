import { createHash } from 'node:crypto'
import { fail } from './errors.ts'
import type { Account, Domain, Id, Plan } from './types.ts'

export interface DomainWorkspaceSource {
  account: Account
  plan: Plan
  disabledFeatures: readonly string[]
  domains: readonly Domain[]
  dependencies: readonly { domainId: Id; childCount: number; serviceUserCount: number }[]
  managedConfigDigests: Readonly<Record<Id, string>>
}

export interface DomainWorkspaceTransition {
  account: Account
  before: readonly Domain[]
  after: readonly Domain[]
  affectedIds: readonly Id[]
}

const graphInvalid = (): never => fail('PRECONDITION_FAILED', 'account domain graph requires review', {
  reason: 'domain_graph_invalid', stateChanged: false,
})

/** Structural ownership preflight; existing domain field and name rules remain separate. */
export const assertAccountDomainGraph = (allDomains: readonly Domain[], accountId: Id): void => {
  const byId = new Map<Id, Domain>()
  const duplicates = new Set<Id>()
  const owned = new Map<Id, Domain>()
  for (const domain of allDomains) {
    if (byId.has(domain.id)) duplicates.add(domain.id)
    else byId.set(domain.id, domain)
    if (domain.accountId === accountId) owned.set(domain.id, domain)
  }
  for (const id of owned.keys()) if (duplicates.has(id)) graphInvalid()
  for (const domain of allDomains) {
    if (domain.accountId !== accountId && domain.parentId !== null && owned.has(domain.parentId)) graphInvalid()
  }
  for (const domain of owned.values()) {
    if (domain.parentId === null) continue
    const parent = byId.get(domain.parentId)
    if (domain.parentId === domain.id || !parent || parent.accountId !== accountId || duplicates.has(domain.parentId)) graphInvalid()
  }

  // Iterative coloring avoids a recursive stack or a repeated walk for each descendant.
  const colors = new Map<Id, 1 | 2>()
  for (const id of owned.keys()) {
    if (colors.get(id) === 2) continue
    const path: Id[] = []
    let current: Id | null = id
    while (current !== null && colors.get(current) !== 2) {
      if (colors.get(current) === 1) graphInvalid()
      colors.set(current, 1)
      path.push(current)
      current = owned.get(current)!.parentId
    }
    for (const visited of path) colors.set(visited, 2)
  }
}

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(object).sort(compare).map(key => [key, stable(object[key])]))
  }
  return value
}

const domainProjection = (domain: Domain) => ({
  id: domain.id,
  accountId: domain.accountId,
  name: domain.name,
  kind: domain.kind,
  parentId: domain.parentId,
  docRoot: domain.docRoot,
  siteType: domain.siteType,
  upstream: domain.upstream,
  redirect: domain.redirect === null ? null : { to: domain.redirect.to, code: domain.redirect.code },
  php: {
    version: domain.php.version, handler: domain.php.handler,
    fpm: {
      mode: domain.php.fpm.mode, maxChildren: domain.php.fpm.maxChildren,
      startServers: domain.php.fpm.startServers, minSpareServers: domain.php.fpm.minSpareServers,
      maxSpareServers: domain.php.fpm.maxSpareServers, maxRequests: domain.php.fpm.maxRequests,
      processIdleTimeoutSec: domain.php.fpm.processIdleTimeoutSec,
    },
    ini: domain.php.ini,
  },
  wildcard: domain.wildcard,
  certificateId: domain.certificateId,
  suspended: domain.suspended,
  expiresAt: domain.expiresAt,
  pathQuotaMb: domain.pathQuotaMb,
  ...(domain.indexFiles !== undefined ? { indexFiles: domain.indexFiles } : {}),
  ...(domain.proxy !== undefined ? { proxy: { websocket: domain.proxy.websocket, hostHeader: domain.proxy.hostHeader, headers: domain.proxy.headers.map(h => ({ name: h.name, value: h.value })) } } : {}),
  ipv4: domain.ipv4 ?? null,
  ipv6: domain.ipv6 ?? null,
})

/** Trusted-source current-value SHA256, not a public capability or monotonic history counter. */
export const domainWorkspaceRevision = (source: DomainWorkspaceSource): string => {
  assertAccountDomainGraph(source.domains, source.account.id)
  const { account, plan } = source
  const projection = {
    account: {
      id: account.id, username: account.username, uid: account.uid, gid: account.gid,
      home: account.home, primaryDomain: account.primaryDomain, planId: account.planId,
      ownerId: account.ownerId, status: account.status, createdAt: account.createdAt,
      ipv4: account.ipv4, ipv6: account.ipv6 ?? null, extraIps: [...(account.extraIps ?? [])].sort(compare),
    },
    plan: {
      id: plan.id, name: plan.name, ownerId: plan.ownerId, featureListId: plan.featureListId,
      resources: {
        diskMb: plan.resources.diskMb, bandwidthMbMonth: plan.resources.bandwidthMbMonth,
        ioReadBps: plan.resources.ioReadBps, ioWriteBps: plan.resources.ioWriteBps,
        ioReadIops: plan.resources.ioReadIops, ioWriteIops: plan.resources.ioWriteIops,
        memoryMb: plan.resources.memoryMb, maxProcesses: plan.resources.maxProcesses, cpuPercent: plan.resources.cpuPercent,
      },
      caps: {
        addonDomains: plan.caps.addonDomains, aliasDomains: plan.caps.aliasDomains, subdomains: plan.caps.subdomains,
        mailboxes: plan.caps.mailboxes, forwarders: plan.caps.forwarders, mailingLists: plan.caps.mailingLists,
        ftpAccounts: plan.caps.ftpAccounts, databases: plan.caps.databases, phpWorkers: plan.caps.phpWorkers,
      },
      dedicatedIp: plan.dedicatedIp, shell: plan.shell, defaultMailboxQuotaMb: plan.defaultMailboxQuotaMb,
    },
    domains: source.domains.filter(domain => domain.accountId === account.id)
      .map(domainProjection).sort((left, right) => compare(left.id, right.id)),
    disabledFeatures: [...new Set(source.disabledFeatures)].sort(compare),
    dependencies: source.dependencies.map(dependency => ({
      domainId: dependency.domainId, childCount: dependency.childCount, serviceUserCount: dependency.serviceUserCount,
    })).sort((left, right) => compare(left.domainId, right.domainId)
      || left.childCount - right.childCount || left.serviceUserCount - right.serviceUserCount),
    managedConfigDigests: source.managedConfigDigests,
  }
  return createHash('sha256').update(JSON.stringify(stable(projection)), 'utf8').digest('hex')
}

export const assertDomainWorkspaceRevision = (value: unknown): string => {
  if (typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value)) {
    return fail('VALIDATION', 'invalid domain workspace revision', { what: 'domainWorkspaceRevision' })
  }
  return value
}
