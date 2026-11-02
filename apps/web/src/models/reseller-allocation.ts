import type { Account, Limit, Plan } from '@xpanel/core'

/** Assigned plan limits only; never observed consumption. */
export const allocated = (accounts: readonly Account[] | undefined, plans: readonly Plan[] | undefined, kind: 'diskMb' | 'bandwidthMbMonth'): Limit | undefined => {
  if (accounts === undefined || plans === undefined) return undefined
  let total = 0
  for (const account of accounts) {
    const value = plans.find(plan => plan.id === account.planId)?.resources[kind]
    if (value === undefined) return undefined
    if (value === 'unlimited') return 'unlimited'
    total += value
    if (!Number.isSafeInteger(total)) return undefined
  }
  return total
}
