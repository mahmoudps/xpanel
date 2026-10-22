import { describe, expect, it } from 'vitest'
import { XpanelError } from '../errors.ts'
import type { Plan, Principal, Reseller } from '../types.ts'
import {
  assertCanManagePlan,
  assertCapAvailable,
  canManagePlan,
  changePlanImpact,
  defaultPlan,
  planErrors,
  unlimitedFields,
  validatePlan,
} from './plans.ts'
import type { PlanUsage } from './plans.ts'
import { MAX_DISK_MB } from './quota.ts'

const code = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof XpanelError) return e.code
    throw e
  }
}

const root: Principal = { kind: 'root', id: 'r0', username: 'root' }
const resellerP: Principal = { kind: 'reseller', id: 'rs1', username: 'acme' }
const userP: Principal = { kind: 'user', id: 'u1', username: 'bob', accountId: 'a1' }

const reseller = (acl: Reseller['acl'] = ['manage-plans']): Reseller => ({
  id: 'rs1',
  username: 'acme',
  acl,
  maxAccounts: 10,
  totalDiskMb: 100_000,
  totalBandwidthMb: 1_000_000,
  oversell: false,
  nameservers: [],
  delegatedIps: [],
})

const withChanges = (p: Plan, f: (p: Plan) => void): Plan => {
  const copy = structuredClone(p)
  f(copy)
  return copy
}

describe('defaultPlan', () => {
  it('is finite, well-formed and fresh on every call', () => {
    const a = defaultPlan()
    expect(planErrors(a)).toEqual([])
    expect(unlimitedFields(a)).toEqual([])
    a.caps.addonDomains = 99
    expect(defaultPlan().caps.addonDomains).not.toBe(99)
    expect(defaultPlan({ id: 'p1', ownerId: 'rs1' })).toMatchObject({ id: 'p1', ownerId: 'rs1' })
  })
})

describe('validatePlan', () => {
  it('lets root create anything including unlimited', () => {
    const p = withChanges(defaultPlan(), (p) => {
      p.resources.diskMb = 'unlimited'
      p.caps.databases = 'unlimited'
    })
    expect(validatePlan(p, root)).toEqual(p)
  })

  it('returns a copy, not the input', () => {
    const p = defaultPlan()
    const out = validatePlan(p, root)
    expect(out).not.toBe(p)
    expect(out.caps).not.toBe(p.caps)
  })

  it('never lets account users manage plans', () => {
    expect(code(() => validatePlan(defaultPlan(), userP))).toBe('FORBIDDEN')
  })

  it('fails closed on unknown or missing principals instead of treating them as root', () => {
    const unlimited = withChanges(defaultPlan(), (p) => {
      p.resources.diskMb = 'unlimited'
    })
    expect(code(() => validatePlan(unlimited, { kind: 'admin', id: 'x', username: 'x' } as unknown as Principal))).toBe('FORBIDDEN')
    expect(code(() => validatePlan(unlimited, null as unknown as Principal))).toBe('FORBIDDEN')
    expect(code(() => validatePlan(defaultPlan({ ownerId: 'rs1' }), resellerP, { ...reseller(), acl: 'manage-plans' as unknown as Reseller['acl'] }))).toBe(
      'FORBIDDEN',
    )
  })

  it('rejects unknown top-level fields', () => {
    expect(code(() => validatePlan({ ...defaultPlan(), isAdmin: true } as unknown as Plan, root))).toBe('VALIDATION')
  })

  it('requires the acting reseller record with manage-plans and own ownership', () => {
    const own = defaultPlan({ ownerId: 'rs1' })
    expect(validatePlan(own, resellerP, reseller()).ownerId).toBe('rs1')
    expect(code(() => validatePlan(own, resellerP))).toBe('FORBIDDEN')
    expect(code(() => validatePlan(own, resellerP, { ...reseller(), id: 'other' }))).toBe('FORBIDDEN')
    expect(code(() => validatePlan(own, resellerP, reseller([])))).toBe('FORBIDDEN')
    expect(code(() => validatePlan(defaultPlan({ ownerId: null }), resellerP, reseller()))).toBe('FORBIDDEN')
    expect(code(() => validatePlan(defaultPlan({ ownerId: 'rs2' }), resellerP, reseller()))).toBe('FORBIDDEN')
  })

  it('blocks unlimited fields for resellers without allow-unlimited-plans', () => {
    const p = withChanges(defaultPlan({ ownerId: 'rs1' }), (p) => {
      p.resources.memoryMb = 'unlimited'
      p.caps.mailboxes = 'unlimited'
    })
    try {
      validatePlan(p, resellerP, reseller())
      expect.unreachable()
    } catch (e) {
      expect((e as XpanelError).code).toBe('FORBIDDEN')
      expect((e as XpanelError).detail.unlimited).toEqual(['resources.memoryMb', 'caps.mailboxes'])
    }
    expect(validatePlan(p, resellerP, reseller(['manage-plans', 'allow-unlimited-plans']))).toEqual(p)
  })

  it('treats an unlimited mailbox quota as unlimited too', () => {
    const p = withChanges(defaultPlan({ ownerId: 'rs1' }), (p) => {
      p.defaultMailboxQuotaMb = 'unlimited'
    })
    expect(code(() => validatePlan(p, resellerP, reseller()))).toBe('FORBIDDEN')
  })

  it.each<[string, (p: Plan) => void]>([
    ['negative disk', (p) => { p.resources.diskMb = -1 }],
    ['fractional cap', (p) => { p.caps.addonDomains = 1.5 }],
    ['NaN', (p) => { p.caps.subdomains = Number.NaN }],
    ['Infinity', (p) => { p.resources.diskMb = Number.POSITIVE_INFINITY }],
    ['string number', (p) => { (p.caps as unknown as Record<string, unknown>).databases = '5' }],
    ['zero memory', (p) => { p.resources.memoryMb = 0 }],
    ['memory below 64', (p) => { p.resources.memoryMb = 32 }],
    ['zero processes', (p) => { p.resources.maxProcesses = 0 }],
    ['io below 1 MiB/s', (p) => { p.resources.ioWriteBps = 1000 }],
    ['zero php workers', (p) => { p.caps.phpWorkers = 0 }],
    ['php workers above 1024', (p) => { p.caps.phpWorkers = 2000 }],
    ['missing field', (p) => { delete (p.caps as Partial<Plan['caps']>).ftpAccounts }],
    ['unknown field', (p) => { (p.caps as unknown as Record<string, unknown>).evil = 1 }],
    ['bad shell', (p) => { (p as unknown as Record<string, unknown>).shell = 'bash' }],
    ['bad name', (p) => { p.name = 'gold; DROP TABLE plans' }],
    ['empty name', (p) => { p.name = '' }],
    ['trailing space', (p) => { p.name = 'gold ' }],
    ['non-bool ip', (p) => { (p as unknown as Record<string, unknown>).dedicatedIp = 'yes' }],
    ['mailbox quota above disk', (p) => { p.defaultMailboxQuotaMb = p.resources.diskMb as number + 1 }],
    ['zero mailbox quota', (p) => { p.defaultMailboxQuotaMb = 0 }],
    ['disk whose byte count is not an exact integer', (p) => { p.resources.diskMb = Number.MAX_SAFE_INTEGER }],
  ])('rejects %s', (_, change) => {
    expect(code(() => validatePlan(withChanges(defaultPlan(), change), root))).toBe('VALIDATION')
  })

  it('accepts the largest exact disk cap and bounds the mailbox quota the same way', () => {
    const p = withChanges(defaultPlan(), (p) => {
      p.resources.diskMb = 'unlimited'
      p.defaultMailboxQuotaMb = MAX_DISK_MB
    })
    expect(validatePlan(p, root).defaultMailboxQuotaMb).toBe(MAX_DISK_MB)
    expect(code(() => validatePlan({ ...p, defaultMailboxQuotaMb: MAX_DISK_MB + 1 }, root))).toBe('VALIDATION')
  })

  it('allows zero for countable caps', () => {
    const p = withChanges(defaultPlan(), (p) => {
      p.caps.addonDomains = 0
      p.caps.mailingLists = 0
    })
    expect(validatePlan(p, root).caps.addonDomains).toBe(0)
  })

  it('reports all problems at once', () => {
    const p = withChanges(defaultPlan(), (p) => {
      p.resources.diskMb = -1
      p.caps.addonDomains = -1
    })
    try {
      validatePlan(p, root)
      expect.unreachable()
    } catch (e) {
      expect(((e as XpanelError).detail.errors as string[]).length).toBe(2)
    }
  })

  it('rejects non-objects', () => {
    expect(code(() => validatePlan(null as unknown as Plan, root))).toBe('VALIDATION')
  })
})

describe('assertCapAvailable', () => {
  const plan = withChanges(defaultPlan(), (p) => {
    p.caps.addonDomains = 2
    p.caps.databases = 'unlimited'
    p.caps.ftpAccounts = 0
  })

  it('allows below the cap and refuses at the cap', () => {
    expect(() => assertCapAvailable(plan, { addonDomains: 1 }, 'addonDomains')).not.toThrow()
    expect(code(() => assertCapAvailable(plan, { addonDomains: 2 }, 'addonDomains'))).toBe('LIMIT_EXCEEDED')
    expect(code(() => assertCapAvailable(plan, { addonDomains: 1 }, 'addonDomains', 2))).toBe('LIMIT_EXCEEDED')
  })

  it('handles zero and unlimited caps', () => {
    expect(code(() => assertCapAvailable(plan, { ftpAccounts: 0 }, 'ftpAccounts'))).toBe('LIMIT_EXCEEDED')
    expect(() => assertCapAvailable(plan, { databases: 1_000_000 }, 'databases')).not.toThrow()
  })

  it('fails closed when the count is missing or malformed', () => {
    expect(code(() => assertCapAvailable(plan, {}, 'addonDomains'))).toBe('VALIDATION')
    expect(code(() => assertCapAvailable(plan, { addonDomains: -1 }, 'addonDomains'))).toBe('VALIDATION')
    expect(code(() => assertCapAvailable(plan, { addonDomains: 0 }, 'addonDomains', 0))).toBe('VALIDATION')
    expect(code(() => assertCapAvailable(plan, { addonDomains: 0 }, 'nope' as 'addonDomains'))).toBe('VALIDATION')
    const corrupt = withChanges(plan, (p) => {
      (p.caps as unknown as Record<string, unknown>).addonDomains = '5'
    })
    expect(code(() => assertCapAvailable(corrupt, { addonDomains: 1 }, 'addonDomains'))).toBe('VALIDATION')
  })
})

describe('changePlanImpact', () => {
  const big = withChanges(defaultPlan(), (p) => {
    p.caps.addonDomains = 'unlimited'
    p.caps.mailboxes = 50
    p.resources.diskMb = 10_000
    p.dedicatedIp = true
    p.shell = 'jailed'
  })
  const small = withChanges(defaultPlan(), (p) => {
    p.caps.addonDomains = 2
    p.caps.mailboxes = 10
    p.resources.diskMb = 1000
    p.caps.phpWorkers = 4
  })

  it('lists usage the new plan is already below', () => {
    const impact = changePlanImpact(big, small, { caps: { addonDomains: 3, mailboxes: 10, phpWorkers: 8 }, diskMb: 1500 })
    expect(impact.violations.map((v) => v.key).sort()).toEqual(['addonDomains', 'diskMb', 'phpWorkers'])
    expect(impact.violations.find((v) => v.key === 'addonDomains')).toMatchObject({ used: 3, limit: 2, scope: 'cap' })
    expect(impact.losesDedicatedIp).toBe(true)
    expect(impact.losesShell).toBe(true)
  })

  it('records unlimited to finite as a reduction', () => {
    const impact = changePlanImpact(big, small, { caps: {} })
    expect(impact.violations).toEqual([])
    expect(impact.reductions.find((r) => r.key === 'addonDomains')).toMatchObject({ from: 'unlimited', to: 2 })
  })

  it('reports nothing for an upgrade', () => {
    const impact = changePlanImpact(small, big, { caps: { addonDomains: 2, mailboxes: 10 }, diskMb: 900 })
    expect(impact.violations).toEqual([])
    expect(impact.reductions).toEqual([])
    expect(impact.losesDedicatedIp).toBe(false)
  })

  it('usage exactly at the new cap is not a violation', () => {
    expect(changePlanImpact(big, small, { caps: { mailboxes: 10 } }).violations).toEqual([])
  })

  it('rejects malformed usage', () => {
    expect(code(() => changePlanImpact(big, small, { caps: { mailboxes: -1 } }))).toBe('VALIDATION')
    expect(code(() => changePlanImpact(big, small, { caps: {}, diskMb: Number.NaN }))).toBe('VALIDATION')
    expect(code(() => changePlanImpact(big, small, {} as PlanUsage))).toBe('VALIDATION')
  })

  it('fails closed on a malformed stored plan instead of comparing strings', () => {
    const corrupt = withChanges(small, (p) => {
      (p.caps as unknown as Record<string, unknown>).mailboxes = '5'
    })
    expect(code(() => changePlanImpact(big, corrupt, { caps: { mailboxes: 10 } }))).toBe('VALIDATION')
    expect(code(() => changePlanImpact(corrupt, big, { caps: {} }))).toBe('VALIDATION')
    expect(code(() => changePlanImpact(big, { ...small, resources: undefined } as unknown as Plan, { caps: {} }))).toBe('VALIDATION')
  })
})

describe('canManagePlan', () => {
  const own = defaultPlan({ id: 'p1', ownerId: 'rs1' })
  const foreign = defaultPlan({ id: 'p2', ownerId: 'rs2' })
  const rootOwned = defaultPlan({ id: 'p3', ownerId: null })

  it('root manages all, a reseller only its own, users none', () => {
    for (const p of [own, foreign, rootOwned]) expect(canManagePlan(root, p)).toBe(true)
    expect(canManagePlan(resellerP, own)).toBe(true)
    expect(canManagePlan(resellerP, foreign)).toBe(false)
    expect(canManagePlan(resellerP, rootOwned)).toBe(false)
    expect(canManagePlan(userP, own)).toBe(false)
  })

  it('hides other owners’ plans with NOT_FOUND, so an edit cannot take over a plan by resubmitting it', () => {
    expect(code(() => assertCanManagePlan(resellerP, foreign))).toBe('NOT_FOUND')
    expect(code(() => assertCanManagePlan(userP, own))).toBe('NOT_FOUND')
    expect(() => assertCanManagePlan(resellerP, own)).not.toThrow()
    // the submitted copy alone would pass: the stored plan is what decides
    expect(validatePlan({ ...foreign, ownerId: 'rs1' }, resellerP, reseller()).ownerId).toBe('rs1')
  })
})
