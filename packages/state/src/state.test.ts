import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { createTestStateStore, type TestStateStoreHandle } from './store.ts'

const ARGON2 =
  '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const SERVICE_ARGON2 = `{ARGON2ID}${ARGON2}`

let h: TestStateStoreHandle

beforeAll(async () => {
  h = await createTestStateStore()
  for (const address of ['203.0.113.10', '203.0.113.11', '2001:db8::10']) await h.store.saveServerIp({ address, version: address.includes(':') ? 6 : 4, prefixLength: address.includes(':') ? 64 : 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: address === '203.0.113.10', notes: 'Diagnostic inventory' })
})

afterAll(async () => {
  await h?.close()
})

describe('@xpanel/state — Argon2id m=65536 enforcement, userdata custom configs, and multi-IP mail state', () => {
  it('enforces Argon2id m >= 65536 on accounts, resellers, and service users and persists userdata & mail IP configs', async () => {
    const fl = await h.store.createFeatureList({ name: 'Default', ownerId: null, disabled: [] })
    const plan = await h.store.createPlan({
      name: 'Standard',
      ownerId: null,
      featureListId: fl.id,
      resources: {
        diskMb: 10_240,
        bandwidthMbMonth: 102_400,
        ioReadBps: 50_000_000,
        ioWriteBps: 50_000_000,
        ioReadIops: 2000,
        ioWriteIops: 2000,
        memoryMb: 1024,
        maxProcesses: 64,
        cpuPercent: 100,
      },
      caps: {
        addonDomains: 5,
        aliasDomains: 5,
        subdomains: 10,
        mailboxes: 10,
        forwarders: 10,
        mailingLists: 2,
        ftpAccounts: 5,
        databases: 5,
        phpWorkers: 8,
      },
      dedicatedIp: false,
      shell: 'jailed',
      defaultMailboxQuotaMb: 512,
    })

    // Reject weak Argon2 memory cost (m=4096) on account creation
    await expect(
      h.store.createAccount({
        username: 'weakuser',
        passwordHash: '$argon2id$v=19$m=4096,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g',
        primaryDomain: 'weak.example.com',
        planId: plan.id,
        ownerId: null,
        contactEmail: 'admin@weak.example.com',
        ipv4: '203.0.113.10',
        shell: 'none',
        php: {
          version: '8.3',
          handler: 'fpm',
          fpm: {
            mode: 'ondemand',
            maxChildren: 4,
            startServers: 2,
            minSpareServers: 1,
            maxSpareServers: 3,
            maxRequests: 500,
            processIdleTimeoutSec: 10,
          },
          ini: {},
        },
      }),
    ).rejects.toSatisfy((e: unknown) => isXpanelError(e) && e.code === 'VALIDATION')

    const account = await h.store.createAccount({
      username: 'secuser',
      passwordHash: ARGON2,
      primaryDomain: 'secuser.example.com',
      planId: plan.id,
      ownerId: null,
      contactEmail: 'admin@secuser.example.com',
      ipv4: '203.0.113.10',
      ipv6: '2001:db8::10',
      extraIps: ['203.0.113.11'],
      shell: 'jailed',
      php: {
        version: '8.3',
        handler: 'fpm',
        fpm: {
          mode: 'ondemand',
          maxChildren: 4,
          startServers: 2,
          minSpareServers: 1,
          maxSpareServers: 3,
          maxRequests: 500,
          processIdleTimeoutSec: 10,
        },
        ini: {},
      },
    })

    // Service user with {ARGON2ID} m=65536 succeeds; {ARGON2I} is rejected
    await expect(
      h.store.createServiceUser({
        accountId: account.id,
        login: 'bad@secuser.example.com',
        services: { email: true, ftp: false, webdisk: false },
        mailboxQuotaMb: 256,
        ftpDir: 'public_html',
        passwordHash: '{ARGON2I}$argon2i$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g',
      }),
    ).rejects.toSatisfy((e: unknown) => isXpanelError(e) && e.code === 'VALIDATION')

    const su = await h.store.createServiceUser({
      accountId: account.id,
      login: 'mail@secuser.example.com',
      services: { email: true, ftp: true, webdisk: false },
      mailboxQuotaMb: 256,
      ftpDir: 'public_html',
      passwordHash: SERVICE_ARGON2,
    })
    expect(su.login).toBe('mail@secuser.example.com')

    // Save and read domain custom config & mail IP config
    const domains = await h.store.listDomains({ accountId: account.id })
    const primary = domains[0]!
    const savedCfg = await h.store.saveDomainCustomConfig({
      domainId: primary.id,
      accountId: account.id,
      nginxInclude: 'expires 14d;',
      apacheInclude: 'Header set X-Sec "1"',
      userIni: { memory_limit: '256M' },
      customHeaders: { 'X-Content-Type-Options': 'nosniff' },
      cacheBypassPaths: ['/admin'],
    })
    expect(savedCfg.domainName).toBe('secuser.example.com')

    await h.store.saveMailIpConfig({
      mode: 'domain-ip',
      defaultIpv4: '203.0.113.10',
      defaultIpv6: '2001:db8::10',
      defaultHelo: 'mail.secuser.example.com',
      domainOverrides: [],
    })

    const snap = await h.store.readSnapshot()
    expect(snap.domainCustomConfigs).toHaveLength(1)
    expect(snap.mailIpConfig?.mode).toBe('domain-ip')
  })
})
