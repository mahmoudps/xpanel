import { describe, expect, it, vi } from 'vitest'
import { createTestStateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { createDynamicDnsRoutes } from './dynamic-dns.ts'

// Actual writer lock and local durable files. No host/agent operation is performed.
it('creates, rotates, updates, reads and deletes without reentering the real StateStore lifecycle lease', async () => {
  const handle = await createTestStateStore(), store = handle.store
  try {
    await store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: 'Synthetic DDNS fixture' })
    const features = await store.createFeatureList({ name: 'DDNS fixture', ownerId: null, disabled: [] })
    const plan = await store.createPlan({ name: 'DDNS fixture', ownerId: null, featureListId: features.id,
      resources: { diskMb: 1000, bandwidthMbMonth: 1000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
      caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
    const account = await store.createAccount({ username: 'ddnsuser', passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g', primaryDomain: 'example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.10', shell: 'none',
      php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
    const principalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await store.saveDnsZone({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', accountId: account.id, name: 'example.test', serial: 1, records: [] })
    const caller = { principal: { kind: 'user', id: principalId, accountId: account.id, username: account.username }, sessionId: 'fixture', apiTokenId: null, scopes: [] } as unknown as AuthenticatedCaller
    const routes = createDynamicDnsRoutes({ store, requireCaller: async () => caller, emitAudit: vi.fn(async () => undefined), readPrincipal: async () => ({ ...caller.principal, accountId: account.id, disabled: false }), assertUpdateAvailable: async () => undefined, reconcile: async () => { await store.readSnapshot(); return true } })
    const manage = async (method: string, path = '', body?: unknown) => { const url = new URL('https://panel.test/api/account/dynamic-dns' + path); return routes.manage(new Request(url, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }), url, method) }
    const before = await store.getRevision(), initial = await (await manage('GET'))!.json()
    const created = await (await manage('POST', '', { zone: 'example.test', hostname: 'home.example.test', type: 'A', description: '', expectedRevision: initial.revision }))!.json()
    expect(await store.getRevision()).toBe(before)
    const rotated = await (await manage('POST', '/' + created.issued.id + '/rotate', { expectedRevision: created.revision }))!.json()
    const url = new URL('https://panel.test/nic/update?hostname=home.example.test&myip=203.0.113.9'), request = new Request(url, { headers: { authorization: 'Basic ' + Buffer.from(rotated.issued.id + ':' + rotated.issued.secret).toString('base64') } })
    expect(await (await routes.update(request, url, '198.51.100.1'))!.text()).toBe('good 203.0.113.9\n')
    expect(await (await routes.update(request, url, '198.51.100.1'))!.text()).toBe('nochg 203.0.113.9\n')
    const view = await (await manage('GET'))!.json()
    expect((await manage('DELETE', '/' + created.issued.id, { expectedRevision: view.revision }))?.status).toBe(200)
    expect((await store.getDnsZone('example.test'))?.records[0]?.content).toBe('203.0.113.9')
    expect(await store.getWriterLock().readLockHolder()).toBeNull()
  } finally { await handle.close() }
})