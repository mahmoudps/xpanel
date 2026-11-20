import { effectivePlan, fail } from '@xpanel/core'
import type { Account, Database, Domain, Plan, ServiceUser } from '@xpanel/core'
import { agentCallerHeaders } from '@xpanel/agent'
import type { AuthenticatedCaller } from './auth.ts'
import { isMailboxPrincipalUsername } from './entry-points.ts'

export interface AccountUsageObservation {
  readonly phpVersion: string | null
  readonly diskBytes: number | null
  readonly memoryBytes: number | null
  readonly processCount: number | null
  readonly bandwidth: 'unmeasured'
  readonly ioEnforced?: boolean
  readonly bandwidthMonth?: {
    readonly month: string
    readonly totalBytes: number | null
    readonly limitBytes: number | null
    readonly usedPercent: number | null
    readonly enforced: boolean
    readonly limited: boolean
  }
}

const readUsageNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** Strict parser for the host agent /host/account-usage contract; invalid payloads stay null. */
export async function fetchAccountUsageObservation(
  agent: { fetch: (req: Request) => Promise<Response>; token: string } | null | undefined,
  principalId: string,
  username: string,
): Promise<AccountUsageObservation | null> {
  if (!agent) return null
  try {
    const response = await agent.fetch(new Request(`http://agent.local/host/account-usage?username=${encodeURIComponent(username)}`, {
      headers: agentCallerHeaders({ principalId, token: agent.token }),
    }))
    if (!response.ok) return null
    const body = await response.json() as {
      phpVersion?: unknown
      diskBytes?: unknown
      memoryBytes?: unknown
      processCount?: unknown
      bandwidth?: unknown
      ioEnforced?: unknown
      bandwidthMonth?: unknown
    }
    if (body.bandwidth !== 'unmeasured') return null
    const month = body.bandwidthMonth as Record<string, unknown> | undefined
    const nullableCount = (value: unknown): boolean => value === null || Number.isSafeInteger(value) && (value as number) >= 0
    const bandwidthMonth = month && typeof month === 'object' && typeof month.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month.month) && nullableCount(month.totalBytes) && nullableCount(month.limitBytes)
      && (month.usedPercent === null || readUsageNumber(month.usedPercent) !== null) && typeof month.enforced === 'boolean' && typeof month.limited === 'boolean'
      ? { month: month.month, totalBytes: month.totalBytes as number | null, limitBytes: month.limitBytes as number | null, usedPercent: month.usedPercent as number | null, enforced: month.enforced, limited: month.limited } : null
    return {
      phpVersion: typeof body.phpVersion === 'string' && /^\d+\.\d+$/.test(body.phpVersion) ? body.phpVersion : null,
      diskBytes: readUsageNumber(body.diskBytes),
      memoryBytes: readUsageNumber(body.memoryBytes),
      processCount: readUsageNumber(body.processCount),
      bandwidth: 'unmeasured' as const,
      ...(typeof body.ioEnforced === 'boolean' ? { ioEnforced: body.ioEnforced } : {}),
      ...(bandwidthMonth ? { bandwidthMonth } : {}),
    }
  } catch {
    return null
  }
}

export interface LiveAccountResourcesSnapshot {
  readonly observedAt: string
  readonly state: 'read' | 'unavailable'
  readonly account: {
    readonly username: string
    readonly primaryDomain: string
    readonly configuredSlice: string
  }
  readonly plan: {
    readonly name: string
    readonly resources: Plan['resources']
    readonly caps: Plan['caps']
  } | null
  readonly usage: AccountUsageObservation | null
  readonly counts: {
    readonly addonDomains: number
    readonly mailboxes: number
    readonly mariadbDatabases: number
  }
}

export interface LiveAccountResourcesPorts {
  readonly getAccount: (accountId: string) => Promise<Account | null>
  readonly getPlan: (planId: string) => Promise<Plan | null>
  readonly listDomains: (filter: { accountId: string }) => Promise<readonly Domain[]>
  readonly listServiceUsers: (accountId: string) => Promise<readonly ServiceUser[]>
  readonly listDatabases: (accountId: string) => Promise<readonly Database[]>
  readonly readUsage: (principalId: string, username: string) => Promise<AccountUsageObservation | null>
  readonly assertCanAccessAccount: (caller: AuthenticatedCaller, target: Account, action: string) => Promise<void>
  readonly assertAccountFeatures: (caller: AuthenticatedCaller, target: Account, features: readonly string[]) => Promise<void>
  readonly now?: () => Date
}

/**
 * Authenticated, owner-scoped on-demand account resource reader for GET /api/account/resources/live.
 * Never fabricates host observations when the host agent is unavailable or returns an unreadable payload.
 */
export async function readLiveAccountResources(
  caller: AuthenticatedCaller,
  url: URL,
  ports: LiveAccountResourcesPorts,
): Promise<LiveAccountResourcesSnapshot> {
  if (caller.principal.kind !== 'user' || isMailboxPrincipalUsername(caller.principal.username)) {
    return fail('FORBIDDEN', 'hosting account owner access is required', { stateChanged: false })
  }
  if (url.searchParams.size > 0) {
    return fail('VALIDATION', 'account resource reads do not accept query selectors', { stateChanged: false })
  }
  const account = await ports.getAccount(caller.principal.accountId)
  if (!account || account.status !== 'active') {
    return fail('FORBIDDEN', 'active hosting account owner access is required', { stateChanged: false })
  }
  await ports.assertCanAccessAccount(caller, account, 'account.resources.read')
  await ports.assertAccountFeatures(caller, account, ['resource-usage'])

  const [plan, domains, serviceUsers, databases, usage] = await Promise.all([
    ports.getPlan(account.planId),
    ports.listDomains({ accountId: account.id }),
    ports.listServiceUsers(account.id),
    ports.listDatabases(account.id),
    ports.readUsage(caller.principal.id, account.username).catch(() => null),
  ])

  const observedAt = (ports.now ?? (() => new Date()))().toISOString()
  const resolvedPlan = plan && plan.id === account.planId ? effectivePlan(plan, account) : null
  return {
    observedAt,
    state: usage ? 'read' : 'unavailable',
    account: {
      username: account.username,
      primaryDomain: account.primaryDomain,
      configuredSlice: `xpanel-${account.uid}.slice`,
    },
    plan: resolvedPlan
      ? { name: resolvedPlan.name, resources: resolvedPlan.resources, caps: resolvedPlan.caps }
      : null,
    usage,
    counts: {
      addonDomains: domains.filter((d: Domain) => d.kind === 'addon').length,
      mailboxes: serviceUsers.filter((u: ServiceUser) => u.services.email).length,
      mariadbDatabases: databases.filter((db: Database) => db.engine === 'mariadb' && db.trashedAt === null).length,
    },
  }
}
