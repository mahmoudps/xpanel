import { describe, expect, it } from 'vitest'
import { XpanelError } from '../errors.ts'
import type { Limit, Plan, Principal, Reseller } from '../types.ts'
import { defaultPlan } from './plans.ts'
import { assertAcl, assertCanSeeAccount, assertResellerCapacity, canSeeAccount, hasAcl, visibleAccounts } from './resellers.ts'

const code = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof XpanelError) return e.code
    throw e
  }
}

const root: Principal = { kind: 'root', id: 'root', username: 'root' }
const rsP: Principal = { kind: 'reseller', id: 'rs1', username: 'acme' }
const userP: Principal = { kind: 'user', id: 'u1', username: 'bob', accountId: 'a1' }

const reseller = (over: Partial<Reseller> = {}): Reseller => ({
  id: 'rs1',
  username: 'acme',
  acl: ['create-account', 'list-accounts'],
  maxAccounts: 3,
  totalDiskMb: 10_000,
  totalBandwidthMb: 100_000,
  oversell: false,
  nameservers: [],
  delegatedIps: [],
  ...over,
})

const plan = (diskMb: Limit, bandwidthMbMonth: Limit = 1000): Pick<Plan, 'resources'> => {
  const p = defaultPlan()
  p.resources.diskMb = diskMb
  p.resources.bandwidthMbMonth = bandwidthMbMonth
  return p
}

describe('canSeeAccount', () => {
  const mine = { id: 'a1', ownerId: 'rs1' }
  const other = { id: 'a2', ownerId: 'rs2' }
  const rootOwned = { id: 'a3', ownerId: null }

  it('root sees everything', () => {
    for (const a of [mine, other, rootOwned]) expect(canSeeAccount(root, a)).toBe(true)
  })

  it('a reseller sees only what it owns', () => {
    expect(canSeeAccount(rsP, mine)).toBe(true)
    expect(canSeeAccount(rsP, other)).toBe(false)
    expect(canSeeAccount(rsP, rootOwned)).toBe(false)
    expect(visibleAccounts(rsP, [mine, other, rootOwned])).toEqual([mine])
  })

  it('a user sees only its own account', () => {
    expect(canSeeAccount(userP, mine)).toBe(true)
    expect(canSeeAccount(userP, { id: 'a9', ownerId: 'rs1' })).toBe(false)
  })

  it('fails closed on unknown principal kinds and hides with NOT_FOUND', () => {
    expect(canSeeAccount({ kind: 'admin', id: 'x', username: 'x' } as unknown as Principal, mine)).toBe(false)
    expect(code(() => assertCanSeeAccount(rsP, other))).toBe('NOT_FOUND')
    expect(() => assertCanSeeAccount(rsP, mine)).not.toThrow()
    expect(canSeeAccount(null as unknown as Principal, mine)).toBe(false)
    expect(code(() => assertCanSeeAccount(root, null as unknown as typeof mine))).toBe('NOT_FOUND')
  })
})

describe('assertAcl', () => {
  it('root always passes', () => {
    expect(() => assertAcl(root, null, 'terminate-account')).not.toThrow()
  })

  it('reseller needs the privilege in its own record', () => {
    expect(() => assertAcl(rsP, reseller(), 'create-account')).not.toThrow()
    expect(code(() => assertAcl(rsP, reseller(), 'terminate-account'))).toBe('FORBIDDEN')
    expect(code(() => assertAcl(rsP, null, 'create-account'))).toBe('FORBIDDEN')
    expect(code(() => assertAcl(rsP, reseller({ id: 'rs2' }), 'create-account'))).toBe('FORBIDDEN')
  })

  it('users never pass', () => {
    expect(code(() => assertAcl(userP, reseller(), 'create-account'))).toBe('FORBIDDEN')
    expect(hasAcl(userP, reseller(), 'create-account')).toBe(false)
    expect(hasAcl(rsP, reseller(), 'create-account')).toBe(true)
  })

  it('fails closed on unknown principal kinds and malformed ACL lists', () => {
    const forged = { kind: 'admin', id: 'rs1', username: 'acme' } as unknown as Principal
    expect(code(() => assertAcl(forged, reseller(), 'create-account'))).toBe('FORBIDDEN')
    expect(code(() => assertAcl(null as unknown as Principal, reseller(), 'create-account'))).toBe('FORBIDDEN')
    expect(code(() => assertAcl(rsP, reseller({ acl: 'create-account' as unknown as Reseller['acl'] }), 'create-account'))).toBe('FORBIDDEN')
  })
})

describe('assertResellerCapacity', () => {
  it('enforces maxAccounts', () => {
    const owned = [{ plan: plan(1000) }, { plan: plan(1000) }]
    expect(() => assertResellerCapacity({ reseller: reseller(), ownedAccounts: owned, newPlan: plan(1000) })).not.toThrow()
    const full = [...owned, { plan: plan(1000) }]
    expect(code(() => assertResellerCapacity({ reseller: reseller(), ownedAccounts: full, newPlan: plan(1000) }))).toBe('LIMIT_EXCEEDED')
  })

  it('enforces maxAccounts even when overselling is on', () => {
    const full = [{ plan: plan(1) }, { plan: plan(1) }, { plan: plan(1) }]
    expect(code(() => assertResellerCapacity({ reseller: reseller({ oversell: true }), ownedAccounts: full, newPlan: plan(1) }))).toBe(
      'LIMIT_EXCEEDED',
    )
  })

  it('skips the count check for a plan change', () => {
    const full = [{ plan: plan(1000) }, { plan: plan(1000) }, { plan: plan(1000) }]
    expect(() =>
      assertResellerCapacity({ reseller: reseller(), ownedAccounts: full.slice(0, 2), newPlan: plan(2000), isNewAccount: false }),
    ).not.toThrow()
  })

  it('blocks disk oversell at the boundary', () => {
    const owned = [{ plan: plan(4000) }, { plan: plan(4000) }]
    expect(() => assertResellerCapacity({ reseller: reseller(), ownedAccounts: owned, newPlan: plan(2000) })).not.toThrow()
    expect(code(() => assertResellerCapacity({ reseller: reseller(), ownedAccounts: owned, newPlan: plan(2001) }))).toBe('OVERSELL_BLOCKED')
  })

  it('blocks bandwidth oversell', () => {
    const r = reseller({ totalBandwidthMb: 1000 })
    expect(code(() => assertResellerCapacity({ reseller: r, ownedAccounts: [{ plan: plan(1, 600) }], newPlan: plan(1, 401) }))).toBe(
      'OVERSELL_BLOCKED',
    )
  })

  it('an unlimited plan never fits finite totals without oversell', () => {
    expect(code(() => assertResellerCapacity({ reseller: reseller(), ownedAccounts: [], newPlan: plan('unlimited') }))).toBe('OVERSELL_BLOCKED')
    expect(code(() => assertResellerCapacity({ reseller: reseller(), ownedAccounts: [{ plan: plan('unlimited') }], newPlan: plan(1) }))).toBe(
      'OVERSELL_BLOCKED',
    )
    expect(code(() => assertResellerCapacity({ reseller: reseller(), ownedAccounts: [], newPlan: plan(1, 'unlimited') }))).toBe(
      'OVERSELL_BLOCKED',
    )
  })

  it('unlimited totals or oversell on allow anything within the account count', () => {
    const r = reseller({ totalDiskMb: 'unlimited', totalBandwidthMb: 'unlimited' })
    expect(() => assertResellerCapacity({ reseller: r, ownedAccounts: [], newPlan: plan('unlimited', 'unlimited') })).not.toThrow()
    expect(() =>
      assertResellerCapacity({ reseller: reseller({ oversell: true }), ownedAccounts: [{ plan: plan(9000) }], newPlan: plan('unlimited') }),
    ).not.toThrow()
  })

  it('treats a non-boolean oversell flag as off', () => {
    const r = reseller({ oversell: 'yes' as unknown as boolean })
    expect(code(() => assertResellerCapacity({ reseller: r, ownedAccounts: [], newPlan: plan(10_001) }))).toBe('OVERSELL_BLOCKED')
  })

  it('fails closed on malformed stored limits', () => {
    const bad = plan('5000' as unknown as number)
    expect(code(() => assertResellerCapacity({ reseller: reseller(), ownedAccounts: [{ plan: bad }], newPlan: plan(1) }))).toBe('VALIDATION')
    expect(code(() => assertResellerCapacity({ reseller: reseller({ totalDiskMb: -1 }), ownedAccounts: [], newPlan: plan(1) }))).toBe('VALIDATION')
    expect(code(() => assertResellerCapacity({ reseller: reseller({ maxAccounts: '3' as unknown as number }), ownedAccounts: [], newPlan: plan(1) }))).toBe(
      'VALIDATION',
    )
  })

  it('fails closed on malformed inputs instead of crashing', () => {
    const noResources = { resources: undefined } as unknown as Pick<Plan, 'resources'>
    expect(code(() => assertResellerCapacity({ reseller: reseller(), ownedAccounts: [], newPlan: noResources }))).toBe('VALIDATION')
    expect(code(() => assertResellerCapacity({ reseller: reseller(), ownedAccounts: [null as unknown as { plan: Pick<Plan, 'resources'> }], newPlan: plan(1) }))).toBe(
      'VALIDATION',
    )
    expect(code(() => assertResellerCapacity({ reseller: reseller(), ownedAccounts: undefined as unknown as [], newPlan: plan(1) }))).toBe('VALIDATION')
    expect(code(() => assertResellerCapacity({ reseller: reseller(), ownedAccounts: [], newPlan: plan(1), isNewAccount: 'no' as unknown as boolean }))).toBe(
      'VALIDATION',
    )
  })

  it('a reseller with maxAccounts 0 cannot create', () => {
    expect(code(() => assertResellerCapacity({ reseller: reseller({ maxAccounts: 0 }), ownedAccounts: [], newPlan: plan(1) }))).toBe(
      'LIMIT_EXCEEDED',
    )
    expect(() => assertResellerCapacity({ reseller: reseller({ maxAccounts: 'unlimited' }), ownedAccounts: [], newPlan: plan(1) })).not.toThrow()
  })
})
