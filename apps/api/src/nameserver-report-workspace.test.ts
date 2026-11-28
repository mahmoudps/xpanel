import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import {
  handleNameserverReportRoute,
  type NameserverReportHelpers,
  type NameserverReportResult,
} from './nameserver-report-workspace.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const root = {
  principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' },
} as unknown as AuthenticatedCaller
const resellerCaller = {
  principal: { kind: 'reseller', id: '22222222-2222-4222-8222-222222222222', username: 'reseller1' },
} as unknown as AuthenticatedCaller

const handles: TestStateStoreHandle[] = []
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close()
})

const setup = async (caller: AuthenticatedCaller = root) => {
  const h = await createTestStateStore()
  handles.push(h)

  await h.store.saveServerSettings({
    hostname: 'panel.example.test',
    nameservers: ['ns1.example.test', 'ns2.example.test'],
    adminEmail: 'ops@example.test',
    engine: 'apache',
    apacheMpm: 'itk',
    panelPort: 2087,
    sshPort: 22,
    nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 4096, multiAccept: true, keepaliveTimeoutSec: 65 },
    apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 4, maxRequestWorkers: 64, maxConnectionsPerChild: 1000, serverLimit: 64 },
    backendPort: 8080,
    backendTlsPort: 8443,
  })
  await h.store.saveServerIp({
    address: '192.0.2.10',
    version: 4,
    prefixLength: 24,
    interfaceName: 'eth0',
    role: 'shared',
    ownerKind: 'root',
    ownerId: null,
    ptrHostname: null,
    isPrimary: true,
    notes: '',
  })
  const feature = await h.store.createFeatureList({ name: 'Base', ownerId: null, disabled: [] })
  const plan = await h.store.createPlan({
    name: 'Basic',
    ownerId: null,
    featureListId: feature.id,
    resources: {
      diskMb: 1000,
      bandwidthMbMonth: 10000,
      ioReadBps: 1048576,
      ioWriteBps: 1048576,
      ioReadIops: 100,
      ioWriteIops: 100,
      memoryMb: 128,
      maxProcesses: 16,
      cpuPercent: 100,
    },
    caps: {
      addonDomains: 2,
      aliasDomains: 2,
      subdomains: 2,
      mailboxes: 2,
      forwarders: 2,
      mailingLists: 2,
      ftpAccounts: 2,
      databases: 2,
      phpWorkers: 2,
    },
    dedicatedIp: false,
    shell: 'none',
    defaultMailboxQuotaMb: 100,
  })
  const reseller = await h.store.createReseller({
    username: 'resdns',
    passwordHash: HASH,
    acl: ['list-accounts'],
    maxAccounts: 10,
    totalDiskMb: 'unlimited',
    totalBandwidthMb: 'unlimited',
    oversell: { disk: false, bandwidth: false },
    nameservers: ['ns1.reseller.test', 'ns2.reseller.test'],
    delegatedIps: [],
  })

  const makeAccount = (username: string, primaryDomain: string, ownerId: string | null) =>
    h.store.createAccount({
      username,
      ownerId,
      passwordHash: HASH,
      primaryDomain,
      planId: plan.id,
      contactEmail: `${username}@example.test`,
      ipv4: '192.0.2.10',
      shell: 'none',
      php: {
        version: '8.3',
        handler: 'fpm',
        fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 },
        ini: {},
      },
    })

  const alice = await makeAccount('alice', 'alice.example.test', null)
  const bob = await makeAccount('bob', 'bob.example.test', null)
  const carol = await makeAccount('carol', 'carol.example.test', null)
  const dave = await makeAccount('dave', 'dave.example.test', reseller.id)

  await h.store.saveDnsZone({
    id: '11111111-1111-4111-8111-111111111100',
    name: 'alice.example.test',
    accountId: alice.id,
    serial: 2026112701,
    records: [
      { id: '11111111-1111-4111-8111-111111111101', zone: 'alice.example.test', name: '@', type: 'NS', ttl: 3600, content: 'NS1.EXAMPLE.TEST.', priority: null },
      { id: '11111111-1111-4111-8111-111111111102', zone: 'alice.example.test', name: '@', type: 'NS', ttl: 3600, content: 'ns2.example.test', priority: null },
      { id: '11111111-1111-4111-8111-111111111103', zone: 'alice.example.test', name: '@', type: 'A', ttl: 3600, content: '192.0.2.10', priority: null },
    ],
  })
  await h.store.saveDnsZone({
    id: '22222222-2222-4222-8222-222222222200',
    name: 'bob.example.test',
    accountId: bob.id,
    serial: 2026112701,
    records: [
      { id: '22222222-2222-4222-8222-222222222201', zone: 'bob.example.test', name: '@', type: 'NS', ttl: 3600, content: 'ns9.custom.test.', priority: null },
      { id: '22222222-2222-4222-8222-222222222202', zone: 'bob.example.test', name: 'sub', type: 'NS', ttl: 3600, content: 'ns1.example.test', priority: null },
    ],
  })
  await h.store.saveDnsZone({
    id: '33333333-3333-4333-8333-333333333300',
    name: 'carol.example.test',
    accountId: carol.id,
    serial: 2026112701,
    records: [
      { id: '33333333-3333-4333-8333-333333333301', zone: 'carol.example.test', name: '@', type: 'A', ttl: 3600, content: '192.0.2.10', priority: null },
    ],
  })
  await h.store.saveDnsZone({
    id: '44444444-4444-4444-8444-444444444400',
    name: 'dave.example.test',
    accountId: dave.id,
    serial: 2026112701,
    records: [
      { id: '44444444-4444-4444-8444-444444444401', zone: 'dave.example.test', name: '@', type: 'NS', ttl: 3600, content: 'ns1.reseller.test.', priority: null },
      { id: '44444444-4444-4444-8444-444444444402', zone: 'dave.example.test', name: '@', type: 'NS', ttl: 3600, content: 'ns2.reseller.test.', priority: null },
    ],
  })

  const assertRoot = vi.fn(async (c: AuthenticatedCaller, action: string) => {
    if (c.principal.kind !== 'root') fail('FORBIDDEN', `root required for ${action}`, { stateChanged: false })
  })
  const helpers: NameserverReportHelpers = {
    store: h.store,
    requireCaller: vi.fn(async () => caller),
    assertRoot,
    now: () => new Date('2026-11-27T12:00:00.000Z'),
  }
  const send = (method = 'GET', path = '/api/server/dns/nameserver-report') => {
    const url = new URL('http://localhost' + path)
    return handleNameserverReportRoute(new Request(url, { method }), url, method, helpers)
  }
  return { h, assertRoot, send }
}

describe('Cross-zone nameserver delegation report route', { tags: ['feature'] }, () => {
  it('returns null for other paths and 405 for non-GET methods', async () => {
    const f = await setup()
    expect(await f.send('GET', '/api/server/dns/other')).toBeNull()
    const postRes = await f.send('POST')
    expect(postRes?.status).toBe(405)
    expect(postRes?.headers.get('allow')).toBe('GET')
  })

  it('requires root server.dns.read privilege and rejects query parameters', async () => {
    const resellerSetup = await setup(resellerCaller)
    await expect(resellerSetup.send('GET')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(resellerSetup.assertRoot).toHaveBeenCalledWith(resellerCaller, 'server.dns.read')

    const rootSetup = await setup(root)
    await expect(rootSetup.send('GET', '/api/server/dns/nameserver-report?zone=alice.example.test')).rejects.toMatchObject({
      code: 'VALIDATION',
    })
  })

  it('computes per-zone apex NS targets, statuses, reseller/account attribution, and summary counts', async () => {
    const f = await setup()
    const res = await f.send('GET')
    expect(res?.status).toBe(200)
    const report = (await res!.json()) as NameserverReportResult

    expect(report.observedAt).toBe('2026-11-27T12:00:00.000Z')
    expect(report.serverNameservers).toEqual(['ns1.example.test', 'ns2.example.test'])
    expect(report.totalZones).toBe(4)
    expect(report.matchedZones).toBe(2)
    expect(report.customZones).toBe(1)
    expect(report.missingZones).toBe(1)

    expect(report.rows).toEqual([
      expect.objectContaining({
        zone: 'alice.example.test',
        accountUsername: 'alice',
        resellerUsername: null,
        nameservers: ['ns1.example.test', 'ns2.example.test'],
        expectedNameservers: ['ns1.example.test', 'ns2.example.test'],
        expectedSource: 'server',
        status: 'matched',
      }),
      expect.objectContaining({
        zone: 'bob.example.test',
        accountUsername: 'bob',
        nameservers: ['ns9.custom.test'],
        expectedNameservers: ['ns1.example.test', 'ns2.example.test'],
        expectedSource: 'server',
        status: 'custom',
      }),
      expect.objectContaining({
        zone: 'carol.example.test',
        accountUsername: 'carol',
        nameservers: [],
        expectedNameservers: ['ns1.example.test', 'ns2.example.test'],
        expectedSource: 'server',
        status: 'missing',
      }),
      expect.objectContaining({
        zone: 'dave.example.test',
        accountUsername: 'dave',
        resellerUsername: 'resdns',
        nameservers: ['ns1.reseller.test', 'ns2.reseller.test'],
        expectedNameservers: ['ns1.reseller.test', 'ns2.reseller.test'],
        expectedSource: 'reseller',
        status: 'matched',
      }),
    ])
  })
})
