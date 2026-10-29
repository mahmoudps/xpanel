import { afterEach, describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import type { Domain, ServerSettings } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { assertReverseProxyUpstream, handleReverseProxyRoute, type ReverseProxyPorts } from './reverse-proxy-workspace.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const settings: ServerSettings = {
  hostname: 'host.example.test', nameservers: ['ns1.example.test'], adminEmail: 'ops@example.test',
  engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443,
  nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 65535, multiAccept: false, keepaliveTimeoutSec: 65 },
  apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 6, maxRequestWorkers: 100, maxConnectionsPerChild: 1000, serverLimit: 100 },
}
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const caller = (principal: Record<string, unknown>, extra: Record<string, unknown> = {}): AuthenticatedCaller => ({ principal, principalRecord: {}, sessionId: 'session',
  sessionToken: null, apiTokenId: null, scopes: [], csrfValid: true, mfaVerified: true, ...extra } as unknown as AuthenticatedCaller)

const fixture = async (withSettings = true) => {
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const store = state.store
  const feature = await store.createFeatureList({ name: 'Reverse proxy policy', ownerId: null, disabled: [] })
  const plan = await store.createPlan({ name: 'Reverse proxy plan', ownerId: null, featureListId: feature.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 3, aliasDomains: 3, subdomains: 3, mailboxes: 4, forwarders: 4, mailingLists: 4, ftpAccounts: 4, databases: 4, phpWorkers: 4 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await store.saveServerIp({ address: '192.0.2.72', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = (username: string) => store.createAccount({ username, passwordHash: HASH, primaryDomain: username + '.example.test', planId: plan.id, ownerId: null,
    contactEmail: 'owner@' + username + '.example.test', ipv4: '192.0.2.72', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: { memory_limit: '64M' } } })
  const owner = await account('proxya'), other = await account('proxyb')
  if (withSettings) await store.saveServerSettings(settings)
  const primary = (await store.getDomainByName(owner.primaryDomain))!, otherPrimary = (await store.getDomainByName(other.primaryDomain))!
  const add = (name: string, extra: Partial<Domain> = {}) => store.createDomain({ accountId: owner.id, name, kind: 'addon', parentId: null, docRoot: owner.home + '/domains/' + name + '/public_html',
    siteType: 'php', upstream: null, redirect: null, php: primary.php, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ...extra })
  const self = caller({ kind: 'user', id: 'principal-a', username: owner.username, accountId: owner.id })
  const neighbour = caller({ kind: 'user', id: 'principal-b', username: other.username, accountId: other.id })
  let current = self, revoked = false
  const mutations: string[] = []
  const ports: ReverseProxyPorts = {
    store,
    requireCaller: async () => current,
    assertCanAccessAccount: async (who, target) => { if (who.principal.kind !== 'user' || who.principal.accountId !== target.id) fail('FORBIDDEN', 'synthetic account boundary') },
    readJsonBody: async req => { const body = await req.json(); if (!body || typeof body !== 'object' || Array.isArray(body)) fail('VALIDATION', 'object body'); return body as Record<string, unknown> },
    // Test double of server.ts mutateDomainWorkspace: the public revision is the private one, so the store's own guard decides staleness.
    mutateDomainWorkspace: async (_req, _caller, target, expected, action, mutate) => {
      if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) fail('VALIDATION', 'invalid domain workspace revision', { stateChanged: false })
      mutations.push(action)
      const value = await mutate({ domainGuard: { accountId: target.id, expectedRevision: expected as string, safeLeaf: true,
        authorize: async () => { if (revoked) fail('FORBIDDEN', 'domain authorization changed', { stateChanged: false }) } } })
      const workspace = await store.readDomainWorkspace(target.id)
      return { value, reconcile: null, view: { revision: workspace.revision, domains: workspace.source.domains, application: { status: 'not_requested', targetVerified: false } } }
    },
  }
  const revision = async () => (await store.readDomainWorkspace(owner.id)).revision
  const put = async (domainId: string, body: unknown, options: { method?: string; query?: string } = {}) => {
    const url = new URL('http://localhost/api/domains/' + domainId + '/reverse-proxy' + (options.query ?? ''))
    const response = await handleReverseProxyRoute(new Request(url, { method: options.method ?? 'PUT', body: JSON.stringify(body) }), url, options.method ?? 'PUT', ports)
    return await response!.json() as { domain: Domain; stateChanged: boolean; revision: string; domains: Domain[]; reconcile: unknown; application: { status: string } }
  }
  return { store, owner, other, primary, otherPrimary, add, self, neighbour, ports, mutations, revision, put,
    as: (who: AuthenticatedCaller) => { current = who }, revoke: () => { revoked = true } }
}

describe('reverse proxy upstream validation', () => {
  const domain = { id: '11111111-1111-4111-8111-111111111111', name: 'site.example.test', siteType: 'php' } as Domain
  const code = (value: unknown): string | null => {
    try { assertReverseProxyUpstream(value, domain, settings); return null }
    catch (error) { const detail = (error as { code?: string; detail?: { fields?: { code: string }[]; stateChanged?: boolean } }); expect(detail.code).toBe('VALIDATION'); expect(detail.detail?.stateChanged).toBe(false); return detail.detail!.fields![0]!.code }
  }
  it('accepts loopback IP literals on unprivileged ports with an optional path', () => {
    for (const ok of ['http://127.0.0.1:3000', 'http://127.0.0.1:3000/', 'https://[::1]:3443/app/v1', 'http://127.0.0.1:65535']) expect(code(ok), ok).toBeNull()
  })
  it('refuses malformed, credentialed, query, dot-segment, metadata and mapped forms', () => {
    for (const bad of [42, null, '', 'ftp://127.0.0.1:3000', 'http://user:pass@127.0.0.1:3000', 'http://127.0.0.1:3000/?next=1', 'http://127.0.0.1:3000#x', 'http://127.0.0.1:3000/a/../b',
      'http://127.0.0.1:3000;proxy_pass', 'http://127.0.0.1:3000 ', 'HTTP://127.0.0.1:3000', 'http://0177.0.0.1:3000', 'http://127.000.0.1:3000', 'http://[::ffff:127.0.0.1]:3000',
      'http://169.254.169.254:8000', 'http://[fd00:ec2::254]:3000', 'http://0.0.0.0:3000', 'http://127.0.0.1:70000', 'http://127.0.0.1:3000/' + 'a'.repeat(600)]) expect(code(bad), String(bad)).toBe('invalid')
  })
  it('keeps the upstream on loopback: private, public, named and other 127/8 hosts are refused', () => {
    for (const remote of ['http://10.0.0.5:3000', 'http://192.0.2.10:3000', 'http://[2001:db8::1]:3000', 'http://example.com:3000', 'http://localhost:3000', 'http://127.0.0.2:3000', 'http://[0:0:0:0:0:0:0:1]:3000'])
      expect(code(remote), remote).toBe('not_loopback')
  })
  it('refuses privileged ports and every port the edge renderer reserves', () => {
    for (const port of [80, 443, 1023, 22, 2087, 8080, 8443, 2083, 2096, 12083, 12087, 3306, 5432, 6379, 11211, 8081, 4190, 7080, 8088])
      expect(code('http://127.0.0.1:' + port), String(port)).toBe('reserved_port')
    expect(code('http://127.0.0.1')).toBe('reserved_port')
  })
})

describe('reverse proxy workspace route over the real desired-state store', () => {
  it('switches an owned domain to a loopback proxy and back, keeping its document root and PHP settings', async () => {
    const f = await fixture()
    const before = (await f.store.getDomain(f.primary.id))!
    const proxied = await f.put(f.primary.id, { expectedRevision: await f.revision(), siteType: 'proxy', upstream: 'http://127.0.0.1:3000' })
    expect(proxied.stateChanged).toBe(true)
    expect(proxied.domain).toMatchObject({ id: before.id, siteType: 'proxy', upstream: 'http://127.0.0.1:3000', docRoot: before.docRoot, php: before.php })
    expect(proxied.revision).toBe(await f.revision()); expect(proxied.application.status).toBe('not_requested'); expect(proxied.reconcile).toBeNull()
    expect(await f.store.getDomain(f.primary.id)).toEqual(proxied.domain)
    const moved = await f.put(f.primary.id, { expectedRevision: await f.revision(), siteType: 'proxy', upstream: 'https://[::1]:3443/app' })
    expect(moved.domain.upstream).toBe('https://[::1]:3443/app')
    const restored = await f.put(f.primary.id, { expectedRevision: await f.revision(), siteType: 'php' })
    expect(await f.store.getDomain(f.primary.id)).toEqual(before); expect(restored.domain).toEqual(before)
    await f.put(f.primary.id, { expectedRevision: await f.revision(), siteType: 'static' })
    expect(await f.store.getDomain(f.primary.id)).toEqual({ ...before, siteType: 'static' })
    expect(f.mutations).toEqual(['domain.updated', 'domain.updated', 'domain.updated', 'domain.updated'])
    expect(await f.store.getDomain(f.otherPrimary.id)).toEqual(f.otherPrimary)
  })

  it('refuses a stale captured revision with CONFLICT and a revoked fresh authorization with FORBIDDEN, leaving state unchanged', async () => {
    const f = await fixture()
    const stale = await f.revision()
    await f.add('extra.example.test')
    const snapshot = await f.store.getDomain(f.primary.id)
    await expect(f.put(f.primary.id, { expectedRevision: stale, siteType: 'proxy', upstream: 'http://127.0.0.1:3000' })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    f.revoke()
    await expect(f.put(f.primary.id, { expectedRevision: await f.revision(), siteType: 'proxy', upstream: 'http://127.0.0.1:3000' })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(await f.store.getDomain(f.primary.id)).toEqual(snapshot)
  })

  it('is owner-only and answers a neighbour domain exactly like a missing one', async () => {
    const f = await fixture()
    const body = { expectedRevision: await f.revision(), siteType: 'proxy', upstream: 'http://127.0.0.1:3000' }
    for (const who of [caller({ kind: 'root', id: 'root', username: 'root' }), caller({ kind: 'reseller', id: 'reseller', username: 'res' }),
      caller({ kind: 'user', id: 'principal-a', username: f.owner.username, accountId: f.owner.id }, { principalKind: 'mailbox', mailbox: 'inbox@proxya.example.test' })]) {
      f.as(who)
      await expect(f.put(f.primary.id, body)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    f.as(f.neighbour)
    await expect(f.put(f.primary.id, body)).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'domain not found' })
    await expect(f.put('99999999-9999-4999-8999-999999999999', body)).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'domain not found' })
    expect(f.mutations).toEqual([]); expect(await f.store.getDomain(f.primary.id)).toEqual(f.primary)
  })

  it('enforces the strict request grammar before any mutation', async () => {
    const f = await fixture()
    const expectedRevision = await f.revision()
    const url = new URL('http://localhost/api/domains/' + f.primary.id + '/reverse-proxy/x')
    expect(await handleReverseProxyRoute(new Request(url), url, 'GET', f.ports)).toBeNull()
    await expect(f.put(f.primary.id, { expectedRevision, siteType: 'php' }, { query: '?accountId=' + f.other.id })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.put(f.primary.id, { expectedRevision, siteType: 'php' }, { method: 'PATCH' })).rejects.toMatchObject({ code: 'VALIDATION' })
    for (const bad of [{ expectedRevision, siteType: 'node', upstream: 'http://127.0.0.1:3000' }, { expectedRevision, siteType: 'php', upstream: null }, { expectedRevision, siteType: 'proxy' },
      { expectedRevision, siteType: 'proxy', upstream: 'http://127.0.0.1:3000', docRoot: '/tmp' }, { siteType: 'proxy', upstream: 'http://127.0.0.1:3000' }, { expectedRevision, siteType: 'php' }])
      await expect(f.put(f.primary.id, bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    await expect(f.put(f.primary.id, { expectedRevision, siteType: 'proxy', upstream: 'http://10.0.0.5:3000' })).rejects.toMatchObject({ code: 'VALIDATION', detail: { fields: [{ field: 'upstream', code: 'not_loopback' }] } })
    expect(f.mutations).toEqual([])
  })

  it('refuses aliases, parents of aliases, application sites, redirects and a server without settings', async () => {
    const f = await fixture()
    const parent = await f.add('parent.example.test')
    const alias = await f.store.createDomain({ ...parent, id: undefined, name: 'mirror.example.test', kind: 'alias', parentId: parent.id } as never)
    const app = await f.add('node.example.test', { siteType: 'node', upstream: 'http://127.0.0.1:3001' })
    const redirected = await f.add('moved.example.test', { redirect: { to: 'https://example.org/', code: 301 } })
    const expectedRevision = await f.revision(), proxy = { expectedRevision, siteType: 'proxy', upstream: 'http://127.0.0.1:3000' }
    await expect(f.put(alias.id, proxy)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.put(parent.id, proxy)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'has_aliases', stateChanged: false } })
    await expect(f.put(app.id, { expectedRevision, siteType: 'php' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.put(redirected.id, proxy)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'domain_redirect' } })
    expect(f.mutations).toEqual([])
    const bare = await fixture(false)
    await expect(bare.put(bare.primary.id, { expectedRevision: await bare.revision(), siteType: 'proxy', upstream: 'http://127.0.0.1:3000' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'server_settings_unavailable' } })
  })
})
