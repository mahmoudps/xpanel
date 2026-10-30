import { assertResellerCapacity, hasAcl, isXpanelError, type Account, type Plan, type Principal, type Reseller } from '@xpanel/core'
import { formatDisplayName } from '../display-name.ts'

export interface AccountListInput {
  principal: Principal
  activeReseller?: Reseller | null
  accounts?: readonly Account[]
  plans?: readonly Plan[]
  resellers?: readonly Reseller[]
}
export interface AccountListModel {
  state: 'forbidden' | 'unavailable' | 'empty' | 'ready'
  accounts: readonly Account[]
  owners: readonly { value: string; label: string }[]
  plans: readonly { value: string; label: string }[]
}

/** Projects only supplied, authorized account rows; this never reads or mutates a store. */
export function accountListModel(input: AccountListInput): AccountListModel {
  const allowed = input.principal.kind !== 'user' && hasAcl(input.principal, input.activeReseller ?? null, 'list-accounts')
  if (!allowed) return { state: 'forbidden', accounts: [], owners: [], plans: [] }
  if (input.accounts === undefined) return { state: 'unavailable', accounts: [], owners: [], plans: [] }
  const accounts = input.accounts.filter(account => input.principal.kind === 'root' || account.ownerId === input.principal.id).sort((a, b) => {
    const at = Date.parse(a.createdAt), bt = Date.parse(b.createdAt)
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at
    if (Number.isFinite(at) !== Number.isFinite(bt)) return Number.isFinite(at) ? -1 : 1
    return a.username < b.username ? -1 : a.username > b.username ? 1 : 0
  })
  const ownerIds = new Set(accounts.map(account => account.ownerId ?? ''))
  const planIds = new Set(accounts.map(account => account.planId))
  const owners = [...ownerIds].flatMap(value => {
    const name = value === '' ? 'root' : input.resellers?.find(reseller => reseller.id === value)?.username
    return name ? [{ value, label: name }] : []
  })
  const plans = (input.plans ?? []).filter(plan => planIds.has(plan.id)).map(plan => ({ value: plan.id, label: formatDisplayName(plan.name) }))
  return { state: accounts.length ? 'ready' : 'empty', accounts, owners, plans }
}

export interface AccountPlanPreview {
  plans: readonly { id: string; name: string; disk: string; memory: string; cpu: string; capacity: 'server-check' | 'fits' | 'exceeds' | 'unavailable' }[]
}

/** A preview of supplied desired state, never permission to create or allocate an address. */
export function accountPlanPreviewModel(input: AccountListInput): AccountPlanPreview {
  if (!hasAcl(input.principal, input.activeReseller ?? null, 'create-account')) return { plans: [] }
  const actor = input.activeReseller
  const owned = input.accounts?.filter(account => account.ownerId === input.principal.id)
  const knownPlans = new Map(input.plans?.map(plan => [plan.id, plan]))
  const ownedPlans = owned?.map(account => knownPlans.get(account.planId))
  const canReadOwned = hasAcl(input.principal, actor ?? null, 'list-accounts')
  return { plans: (input.plans ?? []).map(plan => {
    let capacity: AccountPlanPreview['plans'][number]['capacity'] = input.principal.kind === 'root' ? 'server-check' : 'unavailable'
    if (input.principal.kind === 'reseller' && actor?.id === input.principal.id && canReadOwned && ownedPlans?.every(item => item !== undefined)) {
      try { assertResellerCapacity({ reseller: actor, ownedAccounts: ownedPlans.map(item => ({ plan: item! })), newPlan: plan }); capacity = 'fits' }
      catch (error) { capacity = isXpanelError(error) && error.code === 'LIMIT_EXCEEDED' ? 'exceeds' : 'unavailable' }
    }
    return { id: plan.id, name: formatDisplayName(plan.name), disk: String(plan.resources.diskMb), memory: String(plan.resources.memoryMb), cpu: String(plan.resources.cpuPercent), capacity }
  }) }
}

