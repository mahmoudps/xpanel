import { describe, expect, it } from 'vitest'
import {
  assertIpAssignableToAccount,
  assertIpAssignableToDomain,
  resolveDomainEffectiveIps,
  resolveDomainOutboundMailIp,
  validateMailIpConfig,
  validateServerIpEntry,
  validateServerIpPool,
  resolveAccountIpAssignment,
  projectAccountIpAvailability,
} from './ip-pool.ts'

describe('Multi-IPv4 / Multi-IPv6 hierarchy (root, reseller, account, domain, mail server)', () => {
  const pool = [
    validateServerIpEntry({
      id: '00000000-0000-4000-8000-000000000001',
      address: '203.0.113.10',
      version: 4,
      prefixLength: 24,
      interfaceName: 'eth0',
      role: 'shared',
      ownerKind: 'root',
      ownerId: null,
      ptrHostname: 'srv1.example.com',
      isPrimary: true,
      notes: 'Primary shared IPv4',
    }),
    validateServerIpEntry({
      id: '00000000-0000-4000-8000-000000000002',
      address: '2001:db8::10',
      version: 6,
      prefixLength: 64,
      interfaceName: 'eth0',
      role: 'shared',
      ownerKind: 'root',
      ownerId: null,
      ptrHostname: 'srv1.example.com',
      isPrimary: true,
      notes: 'Primary shared IPv6',
    }),
    validateServerIpEntry({
      id: '00000000-0000-4000-8000-000000000003',
      address: '203.0.113.50',
      version: 4,
      prefixLength: 24,
      interfaceName: 'eth0',
      role: 'dedicated',
      ownerKind: 'reseller',
      ownerId: '00000000-0000-4000-8000-0000000000aa',
      ptrHostname: 'reseller1.example.com',
      isPrimary: false,
      notes: 'Delegated to reseller1',
    }),
    validateServerIpEntry({ id: '00000000-0000-4000-8000-000000000004', address: '2001:db8::50', version: 6, prefixLength: 64, interfaceName: 'eth0', role: 'dedicated', ownerKind: 'reseller', ownerId: '00000000-0000-4000-8000-0000000000aa', ptrHostname: null, isPrimary: false, notes: '' }),
  ]

  it('enforces reseller IP delegation boundaries and dedicated IP exclusivity across accounts', () => {
    const reseller1 = {
      id: '00000000-0000-4000-8000-0000000000aa',
      delegatedIps: ['203.0.113.50', '2001:db8::50'],
    }

    // Reseller can assign its own delegated IPv4 and IPv6
    expect(
      assertIpAssignableToAccount('203.0.113.50', {
        callerKind: 'reseller',
        reseller: reseller1,
        planDedicatedIp: true,
        pool,
      }),
    ).toBe('203.0.113.50')

    expect(
      assertIpAssignableToAccount('2001:db8::50', {
        expectedVersion: 6,
        callerKind: 'reseller',
        reseller: reseller1,
        planDedicatedIp: true,
        pool,
      }),
    ).toBe('2001:db8::50')

    // The root-owned shared primary is intentionally available to authorized resellers.
    expect(
      assertIpAssignableToAccount('203.0.113.10', {
        callerKind: 'reseller',
        reseller: reseller1,
        pool,
      }),
    ).toBe('203.0.113.10')

    // Dedicated IP in use by another account is rejected with CONFLICT
    expect(() =>
      assertIpAssignableToAccount('203.0.113.50', {
        callerKind: 'root',
        ownerId: reseller1.id,
        reseller: reseller1,
        planDedicatedIp: true,
        accountId: '00000000-0000-4000-8000-0000000000bb',
        pool,
        allAccounts: [
          {
            id: '00000000-0000-4000-8000-0000000000cc',
            ipv4: '203.0.113.50',
            ipv6: null,
            extraIps: [],
          },
        ],
      }),
    ).toThrow(/already reserved/)
  })

  it('validates domain-specific IPv4/IPv6 overrides and resolves effective domain IPs', () => {
    const account = {
      id: '00000000-0000-4000-8000-0000000000cc',
      ownerId: '00000000-0000-4000-8000-0000000000aa',
      ipv4: '203.0.113.10',
      ipv6: '2001:db8::10',
      extraIps: ['203.0.113.77', '2001:db8::77'],
    }

    expect(assertIpAssignableToDomain('203.0.113.77', { expectedVersion: 4, account })).toBe('203.0.113.77')
    expect(assertIpAssignableToDomain('2001:db8::77', { expectedVersion: 6, account })).toBe('2001:db8::77')
    expect(() => assertIpAssignableToDomain('198.51.100.99', { expectedVersion: 4, account })).toThrow(/not assigned/)

    // Domain inherits account IP when null, or uses its own override when set
    expect(resolveDomainEffectiveIps({ ipv4: null, ipv6: null }, account)).toEqual({
      ipv4: '203.0.113.10',
      ipv6: '2001:db8::10',
    })
    expect(resolveDomainEffectiveIps({ ipv4: '203.0.113.77', ipv6: '2001:db8::77' }, account)).toEqual({
      ipv4: '203.0.113.77',
      ipv6: '2001:db8::77',
    })
  })

  it('resolves outbound mail server IPv4, IPv6, HELO, and Postfix transport per domain', () => {
    const account = { ipv4: '203.0.113.20', ipv6: '2001:db8::20' }
    const domain = { name: 'shop.example.com', ipv4: '203.0.113.88', ipv6: '2001:db8::88' }
    const serverFallback = { ipv4: '203.0.113.10', ipv6: '2001:db8::10', hostname: 'srv1.example.com' }

    const byDomainCfg = validateMailIpConfig({
      mode: 'domain-ip',
      defaultIpv4: '203.0.113.10',
      defaultIpv6: '2001:db8::10',
      defaultHelo: 'srv1.example.com',
      domainOverrides: [],
    })
    expect(resolveDomainOutboundMailIp(domain, account, byDomainCfg, serverFallback)).toEqual({
      ipv4: '203.0.113.88',
      ipv6: '2001:db8::88',
      heloHostname: 'mail.shop.example.com',
      transportName: 'xpanel-smtp-203-0-113-88',
    })

    const customOverrideCfg = validateMailIpConfig({
      mode: 'server-default',
      defaultIpv4: '203.0.113.10',
      defaultIpv6: '2001:db8::10',
      defaultHelo: 'srv1.example.com',
      domainOverrides: [
        {
          domainName: 'shop.example.com',
          ipv4: '198.51.100.44',
          ipv6: '2001:db8::44',
          heloHostname: 'out44.shop.example.com',
        },
      ],
    })
    expect(resolveDomainOutboundMailIp(domain, account, customOverrideCfg, serverFallback)).toEqual({
      ipv4: '198.51.100.44',
      ipv6: '2001:db8::44',
      heloHostname: 'out44.shop.example.com',
      transportName: 'xpanel-smtp-198-51-100-44',
    })
  })
})

describe('strict IP assignment and advisory allocation projection', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const entry = (n: number, over = {}) => validateServerIpEntry({ id: id(n), address: `192.0.2.${n}`, version: 4, prefixLength: 24, interfaceName: 'test0', role: 'dedicated', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '', ...over })
  const shared = entry(10, { role: 'shared', isPrimary: true }), free = entry(11)
  const context = (over = {}) => ({ ownerId: null, planDedicatedIp: true, reseller: null, pool: [shared, free], allAccounts: [], ...over })
  it('selects the shared default and exact or automatic dedicated inventory without allocating IDs on preview', () => {
    expect(resolveAccountIpAssignment({}, context())).toEqual({ ipv4: shared.address })
    expect(resolveAccountIpAssignment({ ipAssignment: { mode: 'dedicated' } }, context())).toEqual({ ipv4: free.address })
    expect(resolveAccountIpAssignment({ ipAssignment: { mode: 'dedicated', poolId: free.id } }, context())).toEqual({ ipv4: free.address })
    expect(projectAccountIpAvailability(context())).toEqual({ scope: 'desired-state', hostBinding: 'unverified', defaultSharedIpv4: { poolId: shared.id, address: shared.address }, dedicated: { entitled: true, unallocated: [{ poolId: free.id, address: free.address, version: 4 }], count: 1 } })
  })
  it('only shares an undelegated root PRIMARY with a reseller; other shared/dedicated owners stay private', () => {
    const reseller = { id: id(20), delegatedIps: [] }, other = entry(12, { role: 'shared' }), foreign = entry(13, { ownerKind: 'reseller', ownerId: id(21) })
    const ctx = context({ ownerId: reseller.id, reseller, pool: [shared, free, other, foreign] })
    expect(resolveAccountIpAssignment({}, ctx).ipv4).toBe(shared.address)
    for (const address of [other.address, free.address, foreign.address]) expect(() => resolveAccountIpAssignment({ ipv4: address }, ctx)).toThrow(/assignable/)
    expect(projectAccountIpAvailability(ctx).dedicated.count).toBe(0)
    expect(() => assertIpAssignableToAccount(other.address, { callerKind: 'reseller', reseller, pool: ctx.pool, planDedicatedIp: true })).toThrow(/assignable/)
  })
  it.each([null, 12, '', 'wrong', '00000000-0000-4000-8000-00000000000A'])('rejects malformed poolId %s as validation before foreign-ID authorization', poolId => {
    expect(() => resolveAccountIpAssignment({ ipAssignment: { mode: 'dedicated', poolId } } as never, context())).toThrowError(expect.objectContaining({ code: 'VALIDATION' }))
  })
  it('rejects mode ambiguity, unknown selector keys, non-entitled plans and unavailable inventory', () => {
    for (const request of [{ ipAssignment: { mode: 'other' } }, { ipAssignment: { mode: 'shared', poolId: free.id } }, { ipAssignment: { mode: 'shared' }, ipv4: shared.address }]) expect(() => resolveAccountIpAssignment(request as never, context())).toThrowError(expect.objectContaining({ code: 'VALIDATION' }))
    expect(() => resolveAccountIpAssignment({ ipAssignment: { mode: 'dedicated' } }, context({ planDedicatedIp: false }))).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(projectAccountIpAvailability(context({ planDedicatedIp: false })).dedicated).toEqual({ entitled: false, unallocated: [], count: 0 })
    expect(() => resolveAccountIpAssignment({}, context({ pool: [free] }))).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
    expect(() => resolveAccountIpAssignment({ ipAssignment: { mode: 'dedicated' } }, context({ pool: [shared] }))).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
  })
  it('treats account, explicit domain and mail references as reservations', () => {
    for (const over of [
      { allAccounts: [{ id: id(40), ipv4: free.address, ipv6: null, extraIps: [] }] },
      { domains: [{ accountId: id(40), ipv4: free.address, ipv6: null }] },
      { mailIpConfig: validateMailIpConfig({ mode: 'server-default', defaultIpv4: free.address, domainOverrides: [] }) },
    ]) {
      expect(projectAccountIpAvailability(context(over)).dedicated.count).toBe(0)
      expect(() => resolveAccountIpAssignment({ ipv4: free.address }, context(over))).toThrowError(expect.objectContaining({ code: 'CONFLICT' }))
    }
  })
  it('does not allow a domain to claim merely delegated or unallocated pool inventory', () => {
    const account = { id: id(30), ownerId: id(20), ipv4: shared.address, ipv6: null, extraIps: [] }
    expect(() => assertIpAssignableToDomain(free.address, { account, reseller: { id: id(20), delegatedIps: [free.address] }, pool: [free] })).toThrow(/not assigned/)
  })
  it('canonicalizes IPv6 aliases and rejects duplicate address identities/family lies/nonboolean defaults', () => {
    const six = entry(14, { address: '2001:db8::10', version: 6, prefixLength: 64 })
    expect(resolveAccountIpAssignment({ ipv6: '2001:0db8:0:0:0:0:0:10' }, context({ pool: [shared, six] })).ipv6).toBe('2001:db8::10')
    expect(() => validateServerIpPool([six, { ...six, id: id(15), address: '2001:0db8:0:0:0:0:0:10' }])).toThrow(/duplicate/)
    expect(() => validateServerIpPool([{ ...shared, version: 6 }])).toThrow(/family/)
    expect(() => validateServerIpPool([{ ...shared, isPrimary: 'true' }])).toThrow(/boolean/)
    expect(() => resolveAccountIpAssignment({ ipv6: '::ffff:192.0.2.10' }, context())).toThrow(/family/)
    expect(() => resolveAccountIpAssignment({ ipv6: six.address, extraIps: [six.address] }, context({ pool: [shared, six] }))).toThrow(/repeated/)
  })
  it('rejects duplicate IDs, duplicate defaults and mail-only account selection', () => {
    expect(() => validateServerIpPool([shared, { ...free, id: shared.id }])).toThrow(/duplicate/)
    expect(() => validateServerIpPool([shared, { ...free, role: 'shared', isPrimary: true }])).toThrow(/one default/)
    expect(() => resolveAccountIpAssignment({ ipv4: free.address }, context({ pool: [shared, { ...free, role: 'mail' }] }))).toThrow(/assignable/)
    for (const address of ['127.0.0.1', '0.0.0.0', '169.254.1.1', '224.0.0.1', '255.255.255.255']) {
      expect(() => projectAccountIpAvailability(context({ pool: [shared, { ...free, address }] }))).toThrow(/hosting/)
    }
    expect(() => resolveAccountIpAssignment({ extraIps: [free.address, free.address] }, context())).toThrow(/repeated/)
  })
})
