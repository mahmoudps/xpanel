import { describe, expect, it } from 'vitest'
import { defaultPlan, type Account, type Domain, type Plan, type Reseller } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { evaluateAccountPreflight } from './account-preflight.ts'

const PLAN_ID = '11111111-1111-4111-8111-111111111111'
const RESELLER_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_RESELLER_ID = '33333333-3333-4333-8333-333333333333'
const PRIVATE_PLAN_ID = '44444444-4444-4444-8444-444444444444'

const basePlan = defaultPlan({ id: PLAN_ID, name: 'Starter' })
const plan: Plan = { ...basePlan, resources: { ...basePlan.resources, diskMb: 2048 } }
const foreignBase = defaultPlan({ id: PRIVATE_PLAN_ID, name: 'Foreign', ownerId: OTHER_RESELLER_ID })
const foreignPlan: Plan = { ...foreignBase, resources: { ...foreignBase.resources, diskMb: 4096 } }
const reseller: Reseller = {
  id: RESELLER_ID,
  username: 'partner',
  acl: ['create-account', 'list-accounts'],
  maxAccounts: 2,
  totalDiskMb: 3000,
  totalBandwidthMb: 100000,
  oversell: { disk: false, bandwidth: false },
  nameservers: [],
  delegatedIps: [],
}
const existingAccount: Account = {
  id: '55555555-5555-4555-8555-555555555555',
  username: 'alice',
  uid: 20001,
  gid: 20001,
  home: '/home/alice',
  primaryDomain: 'alice.example.test',
  planId: PLAN_ID,
  ownerId: RESELLER_ID,
  status: 'active',
  suspendReason: null,
  contactEmail: 'alice@example.test',
  ipv4: '192.0.2.10',
  shell: 'jailed',
  createdAt: '2026-11-01T00:00:00Z',
}
const existingDomain: Domain = {
  id: '66666666-6666-4666-8666-666666666666',
  accountId: existingAccount.id,
  name: 'alice.example.test',
  kind: 'primary',
  parentId: null,
  docRoot: '/home/alice/public_html',
  siteType: 'php',
  upstream: null,
  redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false,
  certificateId: null,
  suspended: false,
  expiresAt: null,
  pathQuotaMb: 'unlimited',
  ipv4: existingAccount.ipv4,
  ipv6: null,
}

const rootCaller = { principal: { kind: 'root', id: 'root-id', username: 'root' } } as unknown as AuthenticatedCaller
const resellerCaller = { principal: { kind: 'reseller', id: RESELLER_ID, username: 'partner' } } as unknown as AuthenticatedCaller
const userCaller = { principal: { kind: 'user', id: 'user-id', username: 'alice', accountId: existingAccount.id } } as unknown as AuthenticatedCaller

function ports() {
  return {
    findPrincipalByUsername: async (username: string) => username === 'alice' ? { id: 'p-1', username: 'alice' } : null,
    store: {
      getAccountByUsername: async (username: string) => username === 'alice' ? existingAccount : null,
      listAccounts: async () => [existingAccount],
      listPlans: async () => [plan, foreignPlan],
      listDomains: async () => [existingDomain],
      getDnsZone: async () => null,
      listResellers: async () => [reseller],
    },
    resolveReseller: async () => reseller,
    now: () => new Date('2026-11-20T12:00:00.000Z'),
  }
}

describe('account preflight evaluator', () => {
  it('validates available username, domain, root capacity, and builds candidate preview', async () => {
    const query = new URLSearchParams({ username: 'bob', primaryDomain: 'bob.example.test', planId: PLAN_ID })
    const result = await evaluateAccountPreflight(rootCaller, query, ports())
    expect(result.username.status).toBe('available')
    expect(result.primaryDomain.status).toBe('available')
    expect(result.capacity.status).toBe('fits')
    expect(result.capacity.ownerUsername).toBe('root')
    expect(result.preview.linuxUser).toBe('bob')
    expect(result.preview.home).toBe('/home/bob')
    expect(result.preview.dnsZone).toBe('bob.example.test')
    expect(result.preview.mailDomain).toBe('bob.example.test')
  })

  it('detects taken usernames, taken domains, and invalid formats', async () => {
    const taken = await evaluateAccountPreflight(rootCaller, new URLSearchParams({ username: 'alice', primaryDomain: 'alice.example.test', planId: PLAN_ID }), ports())
    expect(taken.username.status).toBe('taken')
    expect(taken.primaryDomain.status).toBe('taken')
    expect(taken.preview.linuxUser).toBeNull()
    expect(taken.preview.dnsZone).toBeNull()

    const invalid = await evaluateAccountPreflight(rootCaller, new URLSearchParams({ username: '9BAD!', primaryDomain: 'not a domain' }), ports())
    expect(invalid.username.status).toBe('invalid')
    expect(invalid.primaryDomain.status).toBe('invalid')
  })

  it('evaluates reseller disk capacity violations and hides foreign reseller plans', async () => {
    const overDisk = await evaluateAccountPreflight(resellerCaller, new URLSearchParams({ username: 'bob', primaryDomain: 'bob.example.test', planId: PLAN_ID }), ports())
    expect(overDisk.capacity.status).toBe('exceeds')
    expect(overDisk.capacity.accountsAfter).toBe(2)
    expect(overDisk.capacity.assignedDiskMbAfter).toBe(4096)

    const foreign = await evaluateAccountPreflight(resellerCaller, new URLSearchParams({ planId: PRIVATE_PLAN_ID }), ports())
    expect(foreign.capacity.status).toBe('unavailable')
  })

  it('refuses account owners and unknown query parameters', async () => {
    await expect(evaluateAccountPreflight(userCaller, new URLSearchParams(), ports())).rejects.toThrow(/cannot preflight/)
    await expect(evaluateAccountPreflight(rootCaller, new URLSearchParams({ unexpected: '1' }), ports())).rejects.toThrow(/unsupported preflight/)
  })
})
