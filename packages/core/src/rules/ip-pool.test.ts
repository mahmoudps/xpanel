import { describe, expect, it } from 'vitest'
import {
  assertIpAssignableToAccount,
  assertIpAssignableToDomain,
  resolveDomainEffectiveIps,
  resolveDomainOutboundMailIp,
  validateMailIpConfig,
  validateServerIpEntry,
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
        pool,
      }),
    ).toBe('203.0.113.50')

    expect(
      assertIpAssignableToAccount('2001:db8::50', {
        expectedVersion: 6,
        callerKind: 'reseller',
        reseller: reseller1,
        pool,
      }),
    ).toBe('2001:db8::50')

    // Reseller cannot assign root's IP that was not delegated
    expect(() =>
      assertIpAssignableToAccount('203.0.113.10', {
        callerKind: 'reseller',
        reseller: reseller1,
        pool,
      }),
    ).toThrow(/not delegated/)

    // Dedicated IP in use by another account is rejected with CONFLICT
    expect(() =>
      assertIpAssignableToAccount('203.0.113.50', {
        callerKind: 'root',
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
    ).toThrow(/already in use/)
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
