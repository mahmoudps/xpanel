import { assertAcl, assertResellerCapacity, effectivePlan, fail, isUuid, isXpanelError, validateDomainName, validateUsername } from '@xpanel/core'
import type { Account, Domain, Plan, Reseller } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'

export interface AccountPreflightCheck {
  readonly status: 'empty' | 'available' | 'invalid' | 'taken'
  readonly value: string
  readonly reason: string | null
}

export interface AccountPreflightCapacity {
  readonly status: 'fits' | 'exceeds' | 'unavailable'
  readonly ownerUsername: string | null
  readonly accountsAfter: number | null
  readonly assignedDiskMbAfter: number | 'unlimited' | null
  readonly limitsSummary: string
  readonly reason: string | null
}

export interface AccountPreflightPreview {
  readonly linuxUser: string | null
  readonly home: string | null
  readonly apacheVhost: string | null
  readonly nginxServer: string | null
  readonly phpPool: string | null
  readonly dnsZone: string | null
  readonly mailDomain: string | null
}

export interface AccountPreflightResult {
  readonly checkedAt: string
  readonly username: AccountPreflightCheck
  readonly primaryDomain: AccountPreflightCheck
  readonly capacity: AccountPreflightCapacity
  readonly preview: AccountPreflightPreview
}

export interface AccountPreflightPorts {
  readonly store: Pick<StateStore, 'getAccountByUsername' | 'listAccounts' | 'listPlans' | 'listDomains' | 'getDnsZone' | 'listResellers'>
  readonly findPrincipalByUsername: (username: string) => Promise<unknown>
  readonly resolveReseller: (caller: AuthenticatedCaller) => Promise<Reseller | null>
  readonly now?: () => Date
}

function summarizeOwnerLimits(reseller: Reseller | null): string {
  if (!reseller) return 'No reseller allocation cap'
  const acc = reseller.maxAccounts === 'unlimited' ? 'unlimited' : String(reseller.maxAccounts)
  const disk = reseller.totalDiskMb === 'unlimited' ? 'unlimited' : `${reseller.totalDiskMb} MiB`
  const bw = reseller.totalBandwidthMb === 'unlimited' ? 'unlimited' : `${reseller.totalBandwidthMb} MiB/mo`
  return `${acc} accounts · ${disk} disk · ${bw} bandwidth`
}

function evaluateCapacity(
  plan: Plan | null,
  owner: Reseller | null,
  ownerAccounts: readonly Account[],
  plansById: ReadonlyMap<string, Plan>,
): AccountPreflightCapacity {
  if (!plan) {
    return {
      status: 'unavailable',
      ownerUsername: owner ? owner.username : 'root',
      accountsAfter: null,
      assignedDiskMbAfter: null,
      limitsSummary: summarizeOwnerLimits(owner),
      reason: 'Select an available hosting plan to evaluate capacity.',
    }
  }
  const accountsAfter = ownerAccounts.length + 1
  if (!owner) {
    if (plan.ownerId !== null) {
      return {
        status: 'exceeds',
        ownerUsername: 'root',
        accountsAfter,
        assignedDiskMbAfter: null,
        limitsSummary: summarizeOwnerLimits(null),
        reason: 'This plan belongs to a reseller and cannot be assigned to a root-owned account.',
      }
    }
    return {
      status: 'fits',
      ownerUsername: 'root',
      accountsAfter,
      assignedDiskMbAfter: plan.resources.diskMb === 'unlimited' ? 'unlimited' : plan.resources.diskMb,
      limitsSummary: summarizeOwnerLimits(null),
      reason: null,
    }
  }
  if (owner.suspended === true) {
    return {
      status: 'exceeds',
      ownerUsername: owner.username,
      accountsAfter,
      assignedDiskMbAfter: null,
      limitsSummary: summarizeOwnerLimits(owner),
      reason: 'The selected reseller is suspended.',
    }
  }
  if (plan.ownerId !== null && plan.ownerId !== owner.id) {
    return {
      status: 'exceeds',
      ownerUsername: owner.username,
      accountsAfter,
      assignedDiskMbAfter: null,
      limitsSummary: summarizeOwnerLimits(owner),
      reason: 'This plan belongs to a different reseller.',
    }
  }
  const existingDiskMb = ownerAccounts.reduce<number | 'unlimited'>((sum, acc) => {
    if (sum === 'unlimited') return 'unlimited'
    const base = plansById.get(acc.planId)
    const assigned = base ? effectivePlan(base, acc).resources.diskMb : undefined
    if (assigned === 'unlimited') return 'unlimited'
    return sum + (typeof assigned === 'number' ? assigned : 0)
  }, 0)
  const assignedDiskMbAfter: number | 'unlimited' =
    existingDiskMb === 'unlimited' || plan.resources.diskMb === 'unlimited'
      ? 'unlimited'
      : existingDiskMb + plan.resources.diskMb
  const ownedAccounts = ownerAccounts.flatMap(acc => {
    const base = plansById.get(acc.planId)
    return base ? [{ plan: effectivePlan(base, acc), accountPlanId: acc.planId }] : []
  })
  try {
    assertResellerCapacity({
      reseller: owner,
      ownedAccounts,
      newPlan: plan,
      newPlanId: plan.id,
      isNewAccount: true,
    })
  } catch (error) {
    if (isXpanelError(error) && (error.code === 'LIMIT_EXCEEDED' || error.code === 'OVERSELL_BLOCKED' || error.code === 'FORBIDDEN')) {
      return {
        status: 'exceeds',
        ownerUsername: owner.username,
        accountsAfter,
        assignedDiskMbAfter,
        limitsSummary: summarizeOwnerLimits(owner),
        reason: error.message,
      }
    }
    throw error
  }
  return {
    status: 'fits',
    ownerUsername: owner.username,
    accountsAfter,
    assignedDiskMbAfter,
    limitsSummary: summarizeOwnerLimits(owner),
    reason: null,
  }
}

/**
 * Read-only, zero-mutation preflight check for account creation.
 * Reuses core username/domain validators, existing account/domain uniqueness, and reseller capacity caps.
 */
export async function evaluateAccountPreflight(
  caller: AuthenticatedCaller,
  query: URLSearchParams,
  ports: AccountPreflightPorts,
): Promise<AccountPreflightResult> {
  if (caller.principal.kind === 'user') {
    return fail('FORBIDDEN', 'user accounts cannot preflight account creation', { stateChanged: false })
  }
  let callerReseller: Reseller | null = null
  if (caller.principal.kind === 'reseller') {
    callerReseller = await ports.resolveReseller(caller)
    assertAcl(caller.principal, callerReseller, 'create-account')
  }

  for (const key of query.keys()) {
    if (!['username', 'primaryDomain', 'planId', 'ownerId'].includes(key)) {
      return fail('VALIDATION', 'unsupported preflight query parameter', { stateChanged: false })
    }
  }

  const rawUsername = (query.get('username') ?? '').trim()
  const rawDomain = (query.get('primaryDomain') ?? '').trim()
  const rawPlanId = (query.get('planId') ?? '').trim()
  const rawOwnerId = (query.get('ownerId') ?? '').trim()

  let usernameCheck: AccountPreflightCheck = { status: 'empty', value: '', reason: null }
  let validUser: string | null = null
  if (rawUsername) {
    let normalized: string | null = null
    try {
      normalized = validateUsername(rawUsername)
    } catch {
      usernameCheck = { status: 'invalid', value: rawUsername, reason: 'Use 1 to 16 lowercase ASCII letters or digits, starting with a letter.' }
    }
    if (normalized !== null) {
      const [principalHit, accountHit] = await Promise.all([
        ports.findPrincipalByUsername(normalized),
        ports.store.getAccountByUsername(normalized),
      ])
      if (principalHit || accountHit) {
        usernameCheck = { status: 'taken', value: normalized, reason: 'This username is already reserved.' }
      } else {
        usernameCheck = { status: 'available', value: normalized, reason: null }
        validUser = normalized
      }
    }
  }

  let domainCheck: AccountPreflightCheck = { status: 'empty', value: '', reason: null }
  let validDomain: string | null = null
  if (rawDomain) {
    let normalized: string | null = null
    try {
      normalized = validateDomainName(rawDomain)
    } catch {
      domainCheck = { status: 'invalid', value: rawDomain, reason: 'Enter a valid fully-qualified domain name.' }
    }
    if (normalized !== null) {
      const [allDomains, existingZone] = await Promise.all([
        ports.store.listDomains(),
        ports.store.getDnsZone(normalized),
      ])
      const domainExists = allDomains.some((d: Domain) => d.name.toLowerCase() === normalized!.toLowerCase())
      if (domainExists || existingZone) {
        domainCheck = { status: 'taken', value: normalized, reason: 'This domain or DNS zone already exists on the server.' }
      } else {
        domainCheck = { status: 'available', value: normalized, reason: null }
        validDomain = normalized
      }
    }
  }

  const [allPlans, allAccounts, allResellers] = await Promise.all([
    ports.store.listPlans(),
    ports.store.listAccounts(),
    caller.principal.kind === 'root' ? ports.store.listResellers() : Promise.resolve(callerReseller ? [callerReseller] : []),
  ])
  const visiblePlans = caller.principal.kind === 'root'
    ? allPlans
    : allPlans.filter(p => p.ownerId === null || p.ownerId === callerReseller?.id)
  const selectedPlan = rawPlanId && isUuid(rawPlanId)
    ? visiblePlans.find(p => p.id === rawPlanId.toLowerCase()) ?? null
    : null

  let targetOwner: Reseller | null = null
  let ownerUnknown = false
  if (caller.principal.kind === 'reseller') {
    targetOwner = callerReseller
  } else if (rawOwnerId) {
    if (!isUuid(rawOwnerId)) ownerUnknown = true
    else {
      targetOwner = allResellers.find(r => r.id === rawOwnerId.toLowerCase()) ?? null
      if (!targetOwner) ownerUnknown = true
    }
  }

  const plansById = new Map(allPlans.map(p => [p.id, p]))
  const ownerAccounts = targetOwner
    ? allAccounts.filter(a => a.ownerId === targetOwner!.id && a.status !== 'terminating')
    : allAccounts.filter(a => a.ownerId === null && a.status !== 'terminating')
  const capacity: AccountPreflightCapacity = ownerUnknown
    ? { status: 'unavailable', ownerUsername: null, accountsAfter: null, assignedDiskMbAfter: null, limitsSummary: 'Owner unavailable', reason: 'The selected owner could not be found.' }
    : evaluateCapacity(selectedPlan, targetOwner, ownerAccounts, plansById)

  const preview: AccountPreflightPreview = {
    linuxUser: validUser,
    home: validUser ? `/home/${validUser}` : null,
    apacheVhost: validDomain ? `${validDomain} (Apache vhost)` : null,
    nginxServer: validDomain ? `${validDomain} (Nginx server)` : null,
    phpPool: validUser ? `xpanel-php-fpm-${validUser}` : null,
    dnsZone: validDomain,
    mailDomain: validDomain,
  }

  return {
    checkedAt: (ports.now ?? (() => new Date()))().toISOString(),
    username: usernameCheck,
    primaryDomain: domainCheck,
    capacity,
    preview,
  }
}
