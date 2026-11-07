import { describe, expect, it } from 'vitest'
import { XpanelError } from '../errors.ts'
import type { Limit, Plan, Principal, Reseller } from '../types.ts'
import { defaultPlan } from './plans.ts'
import {
  assertAcl,
  assertCanSeeAccount,
  assertResellerCapacity,
  assertResellerOversell,
  assertResellerSharedIp,
  canSeeAccount,
  hasAcl,
  validateResellerAclList,
  validateResellerPackageLimits,
  visibleAccounts,
} from './resellers.ts'

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
  oversell: { disk: false, bandwidth: false },
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
    expect(code(() => assertResellerCapacity({ reseller: reseller({ oversell: { disk: true, bandwidth: true } }), ownedAccounts: full, newPlan: plan(1) }))).toBe(
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
      assertResellerCapacity({ reseller: reseller({ oversell: { disk: true, bandwidth: true } }), ownedAccounts: [{ plan: plan(9000) }], newPlan: plan('unlimited') }),
    ).not.toThrow()
  })

  it('treats a non-boolean oversell flag as off', () => {
    const r = reseller({ oversell: { disk: 'yes', bandwidth: 'yes' } as unknown as Reseller['oversell'] })
    expect(code(() => assertResellerCapacity({ reseller: r, ownedAccounts: [], newPlan: plan(10_001) }))).toBe('OVERSELL_BLOCKED')
    expect(code(() => assertResellerCapacity({ reseller: reseller({ oversell: true as unknown as Reseller['oversell'] }), ownedAccounts: [], newPlan: plan(10_001) }))).toBe('OVERSELL_BLOCKED')
  })

  it('oversells disk and bandwidth separately', () => {
    const r = reseller({ totalBandwidthMb: 1000 })
    const diskOnly = reseller({ totalBandwidthMb: 1000, oversell: { disk: true, bandwidth: false } })
    expect(() => assertResellerCapacity({ reseller: diskOnly, ownedAccounts: [], newPlan: plan(10_001, 1000) })).not.toThrow()
    expect(code(() => assertResellerCapacity({ reseller: diskOnly, ownedAccounts: [], newPlan: plan(10_001, 1001) }))).toBe('OVERSELL_BLOCKED')
    const bandwidthOnly = { ...r, oversell: { disk: false, bandwidth: true } }
    expect(() => assertResellerCapacity({ reseller: bandwidthOnly, ownedAccounts: [], newPlan: plan(10_000, 'unlimited') })).not.toThrow()
    expect(code(() => assertResellerCapacity({ reseller: bandwidthOnly, ownedAccounts: [], newPlan: plan(10_001, 1) }))).toBe('OVERSELL_BLOCKED')
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

describe('reseller field validators', () => {
  it('takes overselling as exactly two booleans', () => {
    expect(assertResellerOversell({ disk: true, bandwidth: false })).toEqual({ disk: true, bandwidth: false })
    for (const bad of [true, false, null, { disk: true }, { disk: true, bandwidth: 'no' }, { disk: true, bandwidth: true, cpu: true }]) {
      expect(code(() => assertResellerOversell(bad))).toBe('VALIDATION')
    }
  })

  it('normalizes package limits to one entry per plan', () => {
    const a = '10000000-0000-4000-8000-00000000000A', b = '10000000-0000-4000-8000-000000000001'
    expect(validateResellerPackageLimits([{ planId: a, maxAccounts: 2 }, { planId: b, maxAccounts: 'unlimited' }]))
      .toEqual([{ planId: b, maxAccounts: 'unlimited' }, { planId: a.toLowerCase(), maxAccounts: 2 }])
    expect(code(() => validateResellerPackageLimits([{ planId: a, maxAccounts: 1 }, { planId: a.toLowerCase(), maxAccounts: 2 }]))).toBe('VALIDATION')
    expect(code(() => validateResellerPackageLimits([{ planId: 'basic', maxAccounts: 1 }]))).toBe('VALIDATION')
    expect(code(() => validateResellerPackageLimits([{ planId: a, maxAccounts: -1 }]))).toBe('VALIDATION')
    expect(code(() => validateResellerPackageLimits({}))).toBe('VALIDATION')
  })

  it('takes a canonical shared IP or null', () => {
    expect(assertResellerSharedIp(null)).toBeNull()
    expect(assertResellerSharedIp('2001:DB8::1')).toBe('2001:db8::1')
    expect(code(() => assertResellerSharedIp('192.0.2.0/24'))).toBe('VALIDATION')
  })

  it('names an ACL list with a file-safe name and known privileges', () => {
    expect(validateResellerAclList({ name: 'support-team', acl: ['list-accounts', 'create-account', 'list-accounts'] }))
      .toEqual({ name: 'support-team', acl: ['create-account', 'list-accounts'] })
    for (const name of ['', '../x', '.hidden', 'a b', 'x'.repeat(65)]) expect(code(() => validateResellerAclList({ name, acl: [] }))).toBe('VALIDATION')
    expect(code(() => validateResellerAclList({ name: 'ok', acl: ['root-everything'] }))).toBe('VALIDATION')
    expect(code(() => validateResellerAclList({ name: 'ok', acl: [], extra: 1 }))).toBe('VALIDATION')
  })
})

describe('reseller package limits', () => {
  const planA = '00000000-0000-4000-8000-0000000000a1', planB = '00000000-0000-4000-8000-0000000000b1'
  const limited = reseller({ maxAccounts: 10, totalDiskMb: 'unlimited', totalBandwidthMb: 'unlimited', packageLimits: [{ planId: planA, maxAccounts: 2 }] })
  const owned = (n: number) => Array.from({ length: n }, () => ({ plan: plan(100), accountPlanId: planA }))

  it('refuses a third account on a package limited to two, and a package that is not listed', () => {
    expect(code(() => assertResellerCapacity({ reseller: limited, ownedAccounts: owned(1), newPlan: plan(100), newPlanId: planA }))).toBeNull()
    expect(code(() => assertResellerCapacity({ reseller: limited, ownedAccounts: owned(2), newPlan: plan(100), newPlanId: planA }))).toBe('LIMIT_EXCEEDED')
    expect(code(() => assertResellerCapacity({ reseller: limited, ownedAccounts: owned(2), newPlan: plan(100), newPlanId: planB }))).toBe('FORBIDDEN')
    expect(code(() => assertResellerCapacity({ reseller: limited, ownedAccounts: owned(2), newPlan: plan(100), newPlanId: planA, isNewAccount: false }))).toBe('LIMIT_EXCEEDED')
  })

  it('applies no package rule without package limits or without a package change', () => {
    expect(code(() => assertResellerCapacity({ reseller: { ...limited, packageLimits: undefined }, ownedAccounts: owned(5), newPlan: plan(100), newPlanId: planB }))).toBeNull()
    expect(code(() => assertResellerCapacity({ reseller: limited, ownedAccounts: owned(5), newPlan: plan(100), isNewAccount: false }))).toBeNull()
  })
})
