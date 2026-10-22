import type { Account, Limit, Plan, Principal, Reseller, ResellerAcl } from '../types.ts'
import { fail } from '../errors.ts'
import { assertFits, isUnlimited } from '../limits.ts'
import { invalid, isLimit, isRecord } from './check.ts'

/** Root sees every account, a reseller only accounts it owns, a user only its own. */
export const canSeeAccount = (principal: Principal, account: Pick<Account, 'id' | 'ownerId'>): boolean => {
  if (!isRecord(principal) || !isRecord(account)) return false
  switch (principal.kind) {
    case 'root':
      return true
    case 'reseller':
      return account.ownerId !== null && account.ownerId === principal.id
    case 'user':
      return account.id === principal.accountId
    default:
      return false
  }
}

/** NOT_FOUND rather than FORBIDDEN so account ids cannot be probed across owners. */
export const assertCanSeeAccount = (principal: Principal, account: Pick<Account, 'id' | 'ownerId'>): void => {
  if (!canSeeAccount(principal, account)) fail('NOT_FOUND', 'account not found', { accountId: isRecord(account) ? account.id : null })
}

export const visibleAccounts = <A extends Pick<Account, 'id' | 'ownerId'>>(principal: Principal, accounts: readonly A[]): A[] =>
  accounts.filter((a) => canSeeAccount(principal, a))

/**
 * Root passes every check. A reseller needs the privilege in its own record; a mismatched
 * or missing record fails closed. Account users never hold reseller privileges.
 */
export const assertAcl = (principal: Principal, reseller: Reseller | null | undefined, acl: ResellerAcl): void => {
  const kind: unknown = isRecord(principal) ? principal.kind : undefined
  if (kind === 'root') return
  if (kind !== 'reseller') fail('FORBIDDEN', `privilege "${acl}" requires a reseller or root`, { acl })
  if (!reseller || reseller.id !== principal.id) fail('FORBIDDEN', 'reseller record does not match the acting principal', { acl })
  if (!Array.isArray(reseller!.acl) || !reseller!.acl.includes(acl)) fail('FORBIDDEN', `reseller lacks the "${acl}" privilege`, { acl })
}

export const hasAcl = (principal: Principal, reseller: Reseller | null | undefined, acl: ResellerAcl): boolean => {
  try {
    assertAcl(principal, reseller, acl)
    return true
  } catch {
    return false
  }
}

export interface ResellerCapacityInput {
  reseller: Reseller
  /** every account the reseller owns now (suspended ones included: they still hold resources) */
  ownedAccounts: readonly { plan: Pick<Plan, 'resources'> }[]
  newPlan: Pick<Plan, 'resources'>
  /**
   * false when an existing account changes plan: the caller leaves that account out of
   * `ownedAccounts` and the account count is not checked again.
   */
  isNewAccount?: boolean
}

const assertTotalFits = (
  what: 'disk' | 'bandwidth',
  total: Limit,
  values: readonly unknown[],
  reseller: Reseller,
): void => {
  if (!isLimit(total) || !values.every((a) => isLimit(a))) {
    invalid(`reseller ${what} total or a plan ${what} limit is malformed`, { what, resellerId: reseller.id })
  }
  if (isUnlimited(total)) return
  const assigned = values as Limit[]
  if (assigned.some(isUnlimited)) {
    fail('OVERSELL_BLOCKED', `an unlimited ${what} plan cannot fit a finite reseller ${what} total while overselling is off`, {
      what,
      total,
      resellerId: reseller.id,
    })
  }
  const sum = (assigned as number[]).reduce((a, b) => a + b, 0)
  if (sum > total) {
    fail('OVERSELL_BLOCKED', `assigned ${what} (${sum} MB) would exceed the reseller total (${total} MB)`, {
      what,
      total,
      assigned: sum,
      resellerId: reseller.id,
    })
  }
}

/**
 * Account count always applies (LIMIT_EXCEEDED). With overselling off, the disk and
 * bandwidth of every owned plan plus the new one must fit the reseller totals
 * (OVERSELL_BLOCKED); an unlimited plan never fits a finite total.
 */
export const assertResellerCapacity = ({ reseller, ownedAccounts, newPlan, isNewAccount = true }: ResellerCapacityInput): void => {
  if (!isRecord(reseller) || !isLimit(reseller.maxAccounts)) invalid('reseller maxAccounts is malformed')
  if (!Array.isArray(ownedAccounts)) invalid('ownedAccounts must list every account the reseller owns', { resellerId: reseller.id })
  if (isNewAccount !== true && isNewAccount !== false) invalid('isNewAccount must be a boolean')
  if (isNewAccount) assertFits('reseller accounts', reseller.maxAccounts, ownedAccounts.length, 1)
  if (reseller.oversell === true) return
  const plans = [...ownedAccounts.map((a) => (isRecord(a) ? a.plan : undefined)), newPlan]
  const resources = plans.map((p) => (isRecord(p) && isRecord(p.resources) ? p.resources : invalid('a plan without resources cannot be counted', { resellerId: reseller.id })))
  assertTotalFits('disk', reseller.totalDiskMb, resources.map((r) => r.diskMb), reseller)
  assertTotalFits('bandwidth', reseller.totalBandwidthMb, resources.map((r) => r.bandwidthMbMonth), reseller)
}
