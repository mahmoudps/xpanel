import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as dbApi from '@xpanel/db'
import { domainWorkspaceRevision, type Domain, type Limit } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import type { AgentApp } from '@xpanel/agent'
import { sha256Hex } from './auth.ts'
import { policyForRequest } from './authorization.ts'
import { createApiApp } from './server.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const endpoint = '/api/domains'
const cleanup: Array<() => Promise<unknown>> = []
interface DomainView {
  context: { accountId: string; home: string }
  domains: Domain[]
  revision: string
  limits: { addonDomains: Limit; aliasDomains: Limit; subdomains: Limit }
  removals: Array<{ domainId: string; canRemove: boolean; childCount: number; serviceUserCount: number }>
  application: { status: string; targetVerified: boolean }
}
type AgentMode = 'none' | 'applied' | 'rejected' | 'malformed' | 'transport'
const fixture = async () => {
  const database = await dbApi.createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const feature = await state.store.createFeatureList({ name: 'Domain workspace policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Domain workspace plan', ownerId: null, featureListId: feature.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 3, aliasDomains: 3, subdomains: 3, mailboxes: 4, forwarders: 4, mailingLists: 4, ftpAccounts: 4, databases: 4, phpWorkers: 4 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.72', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = async (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: username + '.example.test', planId: plan.id, ownerId: null,
    contactEmail: 'owner@' + username + '.example.test', ipv4: '192.0.2.72', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const owner = await account('domaina'), other = await account('domainb')
  const primary = (await state.store.getDomainByName(owner.primaryDomain))!, otherPrimary = (await state.store.getDomainByName(other.primaryDomain))!
  const principal = await dbApi.createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  const neighbor = await dbApi.createUserPrincipal(database.db, { username: other.username, accountId: other.id, passwordHash: HASH })
  const seedIndex = async () => dbApi.reindexFromState(database.db, await state.store.readSnapshot())
  await seedIndex()
  const token = async (scopes: string[], principalId = principal.id) => {
    const raw = 'xp_' + randomUUID()
    await dbApi.createApiToken(database.db, { principalId, name: 'Synthetic domain workspace', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const credential = await token(['domains:read', 'domains:write'])
  const calls: Array<{ path: string; method: string; principalId: string | null }> = []
  const makeApp = (mode: AgentMode = 'none') => {
    const agent: AgentApp = { subscribe: () => () => {}, fetch: async req => {
      calls.push({ path: new URL(req.url).pathname, method: req.method, principalId: req.headers.get('x-xpanel-principal-id') })
      if (mode === 'transport') throw new Error('Synthetic global-apply transport interruption')
      if (mode === 'rejected') return Response.json({ error: 'FORBIDDEN', message: 'Synthetic agent rejected the caller' }, { status: 403 })
      if (mode === 'malformed') return Response.json({ status: 'applied', generation: { id: 1, checksum: 'not-a-checksum' } })
      return Response.json({ status: 'applied', generation: { id: 1, createdAt: '2026-01-01T00:00:00Z', status: 'active', checksum: 'a'.repeat(64), error: null, actor: owner.username, testedAt: '2026-01-01T00:00:00Z', activatedAt: '2026-01-01T00:00:00Z' }, filesCount: 2, durationMs: 1 })
    } }
    return createApiApp({ db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET, ...(mode === 'none' ? {} : { agentApp: agent, agentToken: TEST_AGENT_TOKEN }) })
  }
  const app = makeApp()
  const request = (method = 'GET', body?: unknown, options: { token?: string | null; path?: string; application?: ReturnType<typeof createApiApp>; headers?: Record<string, string>; rawBody?: string } = {}) => {
    const payload = options.rawBody ?? (body === undefined ? undefined : JSON.stringify(body))
    return (options.application ?? app).fetch(new Request('http://localhost' + (options.path ?? endpoint), { method,
      headers: { ...(options.token === null ? {} : { authorization: 'Bearer ' + (options.token ?? credential) }), ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
      ...(payload === undefined ? {} : { body: payload }) }))
  }
  const view = async (options?: Parameters<typeof request>[2]): Promise<DomainView> => {
    const response = await request('GET', undefined, options)
    expect(response.status).toBe(200)
    return await response.json() as DomainView
  }
  const tree = async () => {
    const result: Record<string, string> = {}
    const walk = async (path: string, relative = '') => {
      for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const key = relative ? relative + '/' + item.name : item.name, full = join(path, item.name)
        if (item.isDirectory()) await walk(full, key)
        else result[key] = createHash('sha256').update(await readFile(full)).digest('hex')
      }
    }
    await walk(join(state.rootDir, 'accounts'))
    return result
  }
  const images = async () => ({
    tree: await tree(),
    accounts: await database.db.query('SELECT CAST(rowid AS TEXT) AS saved_rowid, * FROM idx_accounts ORDER BY id'),
    domains: await database.db.query('SELECT CAST(rowid AS TEXT) AS saved_rowid, * FROM idx_domains ORDER BY id'),
    search: await database.db.query('SELECT CAST(rowid AS TEXT) AS saved_rowid, kind, entity_id, account_id, owner_id, title, subtitle, keywords FROM search_fts ORDER BY rowid'),
  })
  const legacy = async (name: string, options: { kind?: 'addon' | 'subdomain' | 'alias'; parentId?: string; accountId?: string } = {}) => {
    const target = options.accountId === other.id ? other : owner, base = target.id === other.id ? otherPrimary : primary
    const kind = options.kind ?? 'addon', parentId = kind === 'addon' ? null : options.parentId ?? base.id
    const parent = parentId ? (await state.store.getDomain(parentId))! : base
    const domain = await state.store.createDomain({ accountId: target.id, name, kind, parentId, docRoot: kind === 'alias' ? parent.docRoot : target.home + '/domains/' + name + '/public_html',
      siteType: parent.siteType, upstream: parent.upstream, redirect: parent.redirect, php: parent.php, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' })
    await seedIndex()
    return domain
  }
  const corrupt = async (domain: Domain, patch: Partial<Domain>) => {
    const target = domain.accountId === other.id ? other : owner
    await writeFile(join(state.rootDir, 'accounts', target.username, 'domains', domain.name + '.json'), JSON.stringify({ ...domain, ...patch }, null, 2) + '\n')
  }
  const mailbox = (login = 'inbox@' + owner.primaryDomain) => state.store.createServiceUser({ accountId: owner.id, login, passwordHash: HASH,
    services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  return { database, state, feature, plan, owner, other, primary, otherPrimary, principal, neighbor, token, credential, calls, makeApp, request, view, images, tree, legacy, corrupt, mailbox }
}

describe('domain workspace policy resource', () => {
  it.each(['GET', 'POST', 'PATCH', 'DELETE'])('keeps domain %s scoped to the existing resource and tool', method => {
    expect(policyForRequest(endpoint, method)).toMatchObject({ resource: 'domains', toolIds: ['domains'], acl: method === 'GET' ? 'list-accounts' : 'edit-account' })
  })
})

describe('conditional domain workspace API with isolated real SQLite and desired state', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    vi.restoreAllMocks()
    const failures: unknown[] = []
    for (const close of cleanup.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
    if (failures.length) throw new AggregateError(failures, 'Synthetic domain fixture cleanup failed')
  })
  const unchanged = async (before: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['images']>>) => {
    expect(await f.images()).toEqual(before)
    expect(f.calls).toEqual([])
  }
  const create = async (name: string, extra: Record<string, unknown> = {}) => {
    const current = await f.view()
    const response = await f.request('POST', { name, kind: 'addon', expectedRevision: current.revision, ...extra })
    expect(response.status).toBe(201)
    return await response.json() as DomainView & { domain: Domain; stateChanged: boolean }
  }

  it('returns a coherent owned view with opaque revision, real caps and primary removal refusal', async () => {
    const current = await f.view()
    expect(current.context).toEqual({ accountId: f.owner.id, home: f.owner.home })
    expect(current.domains).toEqual([f.primary])
    expect(current.limits).toEqual({ addonDomains: 3, aliasDomains: 3, subdomains: 3 })
    expect(current.removals).toEqual([{ domainId: f.primary.id, canRemove: false, childCount: 0, serviceUserCount: 0 }])
    expect(current.application).toEqual({ status: 'unverified', targetVerified: false })
    expect(current.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(current.revision).toHaveLength(64)
    expect(current).not.toHaveProperty('managedConfigDigests')
    const raw = domainWorkspaceRevision((await f.state.store.readDomainWorkspace(f.owner.id)).source)
    expect(current.revision).not.toBe(raw)
    const before = await f.images()
    expect((await f.request('POST', { name: 'raw-tag.example.test', kind: 'addon', expectedRevision: raw })).status).toBe(409)
    await unchanged(before)
  })

  it.each(['default', 'relative', 'absolute'] as const)('saves a canonical addon with %s root and no native transport', async root => {
    const before = await f.images(), current = await f.view()
    const docRoot = root === 'relative' ? 'custom-root' : root === 'absolute' ? f.owner.home + '/absolute-root' : undefined
    const response = await f.request('POST', { name: 'MiXeD.Example.Test.', kind: 'addon', ...(docRoot === undefined ? {} : { docRoot }), siteType: 'static', expectedRevision: current.revision })
    expect(response.status).toBe(201)
    const saved = await response.json() as DomainView & { domain: Domain; stateChanged: boolean }
    const expectedRoot = root === 'relative' ? f.owner.home + '/custom-root' : root === 'absolute' ? f.owner.home + '/absolute-root' : f.owner.home + '/domains/mixed.example.test/public_html'
    expect(saved.domain).toMatchObject({ accountId: f.owner.id, name: 'mixed.example.test', kind: 'addon', parentId: null, docRoot: expectedRoot, siteType: 'static' })
    expect(saved.stateChanged).toBe(true)
    expect(saved.application).toEqual({ status: 'not_requested', targetVerified: false })
    expect(saved.domains.find(domain => domain.id === saved.domain.id)).toEqual(saved.domain)
    const readback = await f.view()
    expect(readback.revision).toBe(saved.revision)
    expect(readback.domains).toEqual(saved.domains)
    const after = await f.images()
    expect(after.accounts).toEqual(before.accounts)
    expect(after.domains.filter(row => row.account_id === f.other.id)).toEqual(before.domains.filter(row => row.account_id === f.other.id))
    expect(after.search.filter(row => row.account_id === f.other.id)).toEqual(before.search.filter(row => row.account_id === f.other.id))
    expect(after.domains.find(row => row.id === saved.domain.id)).toMatchObject({ account_id: f.owner.id, name: saved.domain.name, doc_root: expectedRoot })
    expect(after.search.some(row => row.kind === 'domain' && row.entity_id === saved.domain.id)).toBe(true)
    const audit = (await dbApi.listAudit(f.database.db)).find(row => row.action === 'domain.created')!
    expect(audit).toMatchObject({ target: 'domain:' + saved.domain.name, outcome: 'ok' })
    expect(await f.database.db.query('SELECT principal_id FROM audit_log WHERE id=$1', [audit.id])).toEqual([{ principal_id: f.principal.id }])
    expect(f.calls).toEqual([])
  })

  it('creates owned subdomains and aliases with coupled parent settings', async () => {
    const parent = await create('parent.example.test', { siteType: 'static', docRoot: 'parent-root' })
    const sub = await create('blog.parent.example.test', { kind: 'subdomain', parentId: parent.domain.id })
    expect(sub.domain).toMatchObject({ kind: 'subdomain', parentId: parent.domain.id, accountId: f.owner.id })
    const alias = await create('alias.example.test', { kind: 'alias', parentId: parent.domain.id })
    expect(alias.domain).toMatchObject({ kind: 'alias', parentId: parent.domain.id, docRoot: parent.domain.docRoot, siteType: parent.domain.siteType, php: parent.domain.php, upstream: parent.domain.upstream, redirect: parent.domain.redirect })
    expect(alias.application.targetVerified).toBe(false)
    const current = await f.view(), before = await f.images()
    expect((await f.request('PATCH', { docRoot: 'independent-alias-root', expectedRevision: current.revision }, { path: endpoint + '/' + alias.domain.id })).status).toBe(422)
    await unchanged(before)
  })

  it('updates an addon root and its aliases atomically without moving identity or neighbor state', async () => {
    const parent = await create('parent.example.test'), alias = await create('alias.example.test', { kind: 'alias', parentId: parent.domain.id })
    const current = await f.view(), before = await f.images()
    const response = await f.request('PATCH', { docRoot: 'next-root', expectedRevision: current.revision }, { path: endpoint + '/' + parent.domain.id })
    expect(response.status).toBe(200)
    const changed = await response.json() as DomainView & { domain: Domain; stateChanged: boolean }
    expect(changed.domain).toMatchObject({ id: parent.domain.id, name: parent.domain.name, kind: 'addon', parentId: null, accountId: f.owner.id, docRoot: f.owner.home + '/next-root' })
    expect(changed.domains.find(domain => domain.id === alias.domain.id)?.docRoot).toBe(changed.domain.docRoot)
    expect(changed.stateChanged).toBe(true)
    expect(changed.application).toEqual({ status: 'not_requested', targetVerified: false })
    expect((await f.view()).revision).toBe(changed.revision)
    const after = await f.images()
    expect(after.accounts).toEqual(before.accounts)
    expect(after.domains.filter(row => row.account_id === f.other.id)).toEqual(before.domains.filter(row => row.account_id === f.other.id))
    for (const id of [parent.domain.id, alias.domain.id]) expect(after.domains.find(row => row.id === id)?.doc_root).toBe(changed.domain.docRoot)
    expect(f.calls).toEqual([])
  })

  it('removes only the confirmed nonprimary leaf and its domain projection', async () => {
    const saved = await create('leaf.example.test'), current = await f.view(), before = await f.images()
    expect(current.removals.find(row => row.domainId === saved.domain.id)).toMatchObject({ canRemove: true, childCount: 0, serviceUserCount: 0 })
    const response = await f.request('DELETE', { confirmName: saved.domain.name, expectedRevision: current.revision }, { path: endpoint + '/' + saved.domain.id })
    expect(response.status).toBe(200)
    const removed = await response.json() as DomainView & { ok: boolean; stateChanged: boolean; removed: { id: string; name: string } }
    expect(removed).toMatchObject({ ok: true, stateChanged: true, removed: { id: saved.domain.id, name: saved.domain.name }, application: { status: 'not_requested', targetVerified: false } })
    expect(removed.domains.some(domain => domain.id === saved.domain.id)).toBe(false)
    const after = await f.images()
    expect(after.accounts).toEqual(before.accounts)
    expect(after.domains.some(row => row.id === saved.domain.id)).toBe(false)
    expect(after.search.some(row => row.kind === 'domain' && row.entity_id === saved.domain.id)).toBe(false)
    expect(after.domains.filter(row => row.account_id === f.other.id)).toEqual(before.domains.filter(row => row.account_id === f.other.id))
    expect(await f.state.store.getDomain(f.primary.id)).toEqual(f.primary)
    expect((await f.view()).revision).toBe(removed.revision)
    expect(f.calls).toEqual([])
  })

  it('requires a namespace-specific token and keeps read-only access nonmutating', async () => {
    const current = await f.view(), before = await f.images(), readOnly = await f.token(['domains:read'])
    expect((await f.request('GET', undefined, { token: readOnly })).status).toBe(200)
    expect((await f.request('POST', { name: 'denied.example.test', kind: 'addon', expectedRevision: current.revision }, { token: readOnly })).status).toBe(403)
    const unrelated = await f.token(['accounts:read', 'accounts:write'])
    expect((await f.request('GET', undefined, { token: unrelated })).status).toBe(403)
    expect((await f.request('POST', { name: 'denied.example.test', kind: 'addon', expectedRevision: current.revision }, { token: unrelated })).status).toBe(403)
    expect((await f.request('GET', undefined, { token: null })).status).toBe(401)
    await unchanged(before)
  })

  it('rejects mailbox-bound hosting access and foreign item targets', async () => {
    const mailbox = await f.mailbox(), current = await f.view(), before = await f.images()
    const raw = await f.token(['mailbox:' + mailbox.id, 'domains:read', 'domains:write'])
    expect((await f.request('GET', undefined, { token: raw })).status).toBe(403)
    expect((await f.request('POST', { name: 'denied.example.test', kind: 'addon', expectedRevision: current.revision }, { token: raw })).status).toBe(403)
    for (const method of ['PATCH', 'DELETE']) {
      const body = method === 'PATCH' ? { docRoot: 'foreign-root', expectedRevision: current.revision } : { confirmName: f.otherPrimary.name, expectedRevision: current.revision }
      expect((await f.request(method, body, { path: endpoint + '/' + f.otherPrimary.id })).status).toBe(404)
    }
    await unchanged(before)
  })

  it('derives owner selection from authentication and rejects all owner query selectors', async () => {
    const current = await f.view({ headers: { 'x-account-id': f.other.id, 'x-xpanel-principal-id': f.neighbor.id, 'x-role': 'root' } })
    expect(current.context.accountId).toBe(f.owner.id)
    expect(current.domains.every(domain => domain.accountId === f.owner.id)).toBe(true)
    const before = await f.images()
    for (const query of ['accountId=' + f.other.id, 'kind=addon', 'ignored=1&ignored=2']) expect((await f.request('GET', undefined, { path: endpoint + '?' + query })).status).toBe(422)
    await unchanged(before)
  })

  it('rejects another account public tag instead of accepting a global revision', async () => {
    const raw = await f.token(['domains:read'], f.neighbor.id), other = await f.view({ token: raw }), before = await f.images()
    expect((await f.request('POST', { name: 'foreign-tag.example.test', kind: 'addon', expectedRevision: other.revision })).status).toBe(409)
    await unchanged(before)
  })

  it.each(['feature', 'status', 'principal'] as const)('rechecks fresh %s after initial authorization before the writer executes', async kind => {
    const current = await f.view(), original = f.state.store.createDomain.bind(f.state.store)
    const writer = vi.spyOn(f.state.store, 'createDomain').mockImplementationOnce(async (...args: Parameters<typeof original>) => {
      if (kind === 'feature') await f.state.store.updateFeatureList(f.feature.id, { disabled: ['domains'] })
      else if (kind === 'status') await f.state.store.suspendAccount(f.owner.id, 'Synthetic queued domain hold')
      else await dbApi.deletePrincipal(f.database.db, f.principal.id)
      return original(...args)
    })
    const beforeTree = await f.tree(), beforeIndex = await f.database.db.query('SELECT * FROM idx_domains ORDER BY id')
    const response = await f.request('POST', { name: 'revoked.example.test', kind: 'addon', expectedRevision: current.revision })
    expect(response.status).toBe(kind === 'principal' ? 401 : 403)
    expect(writer).toHaveBeenCalledTimes(1)
    expect((await f.state.store.listDomains({ accountId: f.owner.id })).some(domain => domain.name === 'revoked.example.test')).toBe(false)
    expect(await f.database.db.query('SELECT * FROM idx_domains ORDER BY id')).toEqual(beforeIndex)
    if (kind === 'principal') expect(await f.tree()).toEqual(beforeTree)
    expect(f.calls).toEqual([])
  })

  it.each(['POST', 'PATCH', 'DELETE'])('requires owner expectedRevision for %s before effects', async method => {
    const saved = await create('leaf.example.test'), before = await f.images()
    const body = method === 'POST' ? { name: 'another.example.test', kind: 'addon' } : method === 'PATCH' ? { docRoot: 'new-root' } : { confirmName: saved.domain.name }
    expect((await f.request(method, body, { path: method === 'POST' ? endpoint : endpoint + '/' + saved.domain.id })).status).toBe(412)
    await unchanged(before)
  })

  it.each([null, 1, true, {}, [], 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(64) + '\n'].map(revision => ({ revision })))('rejects malformed owner revision $revision', async ({ revision }) => {
    const before = await f.images()
    expect((await f.request('POST', { name: 'invalid-tag.example.test', kind: 'addon', expectedRevision: revision })).status).toBe(422)
    await unchanged(before)
  })

  const malformedCreates: Array<[string, (revision: string) => unknown]> = [
    ['null', () => null], ['array', () => []], ['primitive', () => 'domain'],
    ['missing name', revision => ({ kind: 'addon', expectedRevision: revision })], ['missing kind', revision => ({ name: 'missing.example.test', expectedRevision: revision })],
    ['primary kind', revision => ({ name: 'primary.example.test', kind: 'primary', expectedRevision: revision })],
    ['nonprimitive kind', revision => ({ name: 'object-kind.example.test', kind: { toString: 'addon' }, expectedRevision: revision })],
    ['name number', revision => ({ name: 1, kind: 'addon', expectedRevision: revision })],
    ['leading whitespace', revision => ({ name: ' leading.example.test', kind: 'addon', expectedRevision: revision })],
    ['wildcard name', revision => ({ name: '*.example.test', kind: 'addon', expectedRevision: revision })],
    ['control name', revision => ({ name: 'bad\u0000.example.test', kind: 'addon', expectedRevision: revision })],
    ['invalid parent id', revision => ({ name: 'sub.example.test', kind: 'subdomain', parentId: 'not-a-uuid', expectedRevision: revision })],
    ['unavailable runtime', revision => ({ name: 'proxy.example.test', kind: 'addon', siteType: 'proxy', expectedRevision: revision })],
  ]
  it.each(malformedCreates)('rejects malformed creation %s without writes', async (_name, make) => {
    const current = await f.view(), before = await f.images()
    expect((await f.request('POST', make(current.revision))).status).toBe(422)
    await unchanged(before)
  })

  it.each(['accountId', 'id', 'certificateId', 'php', 'upstream', 'redirect', 'wildcard', 'suspended', 'pathQuotaMb', 'ipv4', '__proto__'])('rejects owner creation extra field %s', async key => {
    const current = await f.view(), before = await f.images()
    const body = Object.fromEntries([['name', 'extra.example.test'], ['kind', 'addon'], ['expectedRevision', current.revision], [key, 'untrusted']])
    expect((await f.request('POST', body)).status).toBe(422)
    await unchanged(before)
  })

  it.each(['docRoot', 'siteType'] as const)('refuses independently supplied alias %s', async field => {
    const current = await f.view(), before = await f.images()
    expect((await f.request('POST', { name: 'alias.example.test', kind: 'alias', parentId: f.primary.id, expectedRevision: current.revision, [field]: field === 'docRoot' ? f.primary.docRoot : 'php' })).status).toBe(422)
    await unchanged(before)
  })

  it.each(['foreign', 'alias'] as const)('refuses a %s parent without leaking or modifying other records', async kind => {
    const parent = kind === 'alias' ? await f.legacy('existing-alias.example.test', { kind: 'alias', parentId: f.primary.id }) : f.otherPrimary
    const current = await f.view(), before = await f.images()
    const response = await f.request('POST', { name: 'bad.' + parent.name, kind: 'subdomain', parentId: parent.id, expectedRevision: current.revision })
    expect(response.status).toBeGreaterThanOrEqual(400); expect(response.status).toBeLessThan(500)
    expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
    await unchanged(before)
  })

  it.each(['', '.', '../escape', '/etc/site', 'mail/site', 'site/../escape', 'site\\escape'])('rejects unsafe document root %j', async docRoot => {
    const current = await f.view(), before = await f.images()
    expect((await f.request('POST', { name: 'root.example.test', kind: 'addon', docRoot, expectedRevision: current.revision })).status).toBe(422)
    await unchanged(before)
  })

  it.each(['name', 'kind', 'parentId', 'accountId', 'siteType', 'php'])('keeps owner PATCH limited to document root, rejecting %s', async key => {
    const saved = await create('leaf.example.test'), current = await f.view(), before = await f.images()
    expect((await f.request('PATCH', { docRoot: 'new-root', expectedRevision: current.revision, [key]: 'untrusted' }, { path: endpoint + '/' + saved.domain.id })).status).toBe(422)
    await unchanged(before)
  })

  it('rejects malformed JSON without changing any tenant state or index', async () => {
    const before = await f.images()
    expect((await f.request('POST', undefined, { rawBody: '{' })).status).toBe(422)
    await unchanged(before)
  })

  it('enforces the current cap and does not over-admit concurrent writes with one revision', async () => {
    const current = await f.view()
    const results = await Promise.all(['first.example.test', 'second.example.test'].map(name => f.request('POST', { name, kind: 'addon', expectedRevision: current.revision })))
    expect(results.map(response => response.status).sort()).toEqual([201, 409])
    expect((await f.view()).domains.filter(domain => domain.kind === 'addon')).toHaveLength(1)
    await create('third.example.test'); await create('fourth.example.test')
    const full = await f.view(), before = await f.images()
    const response = await f.request('POST', { name: 'over-cap.example.test', kind: 'addon', expectedRevision: full.revision })
    expect(response.status).toBeGreaterThanOrEqual(400); expect(response.status).toBeLessThan(500)
    expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
    await unchanged(before)
  })

  it('rejects stale mutation tags while unrelated contact changes do not invalidate the workspace', async () => {
    const initial = await f.view()
    await f.state.store.updateAccount(f.owner.id, { contactEmail: 'changed-contact@example.test' })
    const stable = await f.view()
    expect(stable.revision).toBe(initial.revision)
    const response = await f.request('POST', { name: 'fresh.example.test', kind: 'addon', expectedRevision: initial.revision })
    expect(response.status).toBe(201)
    const before = await f.images()
    expect((await f.request('POST', { name: 'stale.example.test', kind: 'addon', expectedRevision: initial.revision })).status).toBe(409)
    await unchanged(before)
  })

  it('refuses primary deletion and exact-name mismatch before effects', async () => {
    const saved = await create('leaf.example.test'), current = await f.view(), before = await f.images()
    expect((await f.request('DELETE', { confirmName: f.primary.name, expectedRevision: current.revision }, { path: endpoint + '/' + f.primary.id })).status).toBe(412)
    const response = await f.request('DELETE', { confirmName: 'wrong.example.test', expectedRevision: current.revision }, { path: endpoint + '/' + saved.domain.id })
    expect(response.status).toBeGreaterThanOrEqual(400); expect(response.status).toBeLessThan(500)
    expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
    await unchanged(before)
  })

  it.each(['child', 'current-user', 'legacy-user'] as const)('refuses non-leaf removal with a %s dependency', async dependency => {
    const parent = await create('parent.example.test')
    if (dependency === 'child') await create('sub.parent.example.test', { kind: 'subdomain', parentId: parent.domain.id })
    else {
      const user = await f.mailbox(dependency === 'current-user' ? 'mail@parent.example.test' : 'mail@' + f.primary.name)
      if (dependency === 'legacy-user') {
        const directory = join(f.state.rootDir, 'accounts', f.owner.username, 'users')
        const records = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.json')).map(async name => {
          const path = join(directory, name)
          return { path, value: JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> }
        }))
        const stored = records.find(record => record.value.id === user.id)
        expect(stored).toBeDefined()
        await writeFile(stored!.path, JSON.stringify({ ...stored!.value, domainId: parent.domain.id }, null, 2) + '\n')
      }
    }
    const current = await f.view(), before = await f.images(), removal = current.removals.find(row => row.domainId === parent.domain.id)!
    expect(removal.canRemove).toBe(false)
    expect(dependency === 'child' ? removal.childCount : removal.serviceUserCount).toBeGreaterThan(0)
    expect((await f.request('DELETE', { confirmName: parent.domain.name, expectedRevision: current.revision }, { path: endpoint + '/' + parent.domain.id })).status).toBe(412)
    await unchanged(before)
  })

  it.each(['missing-parent', 'foreign-parent', 'foreign-incoming', 'cycle', 'duplicate-id'] as const)('fails closed on %s legacy graph corruption with zero writes', async kind => {
    const child = await f.legacy('one.' + f.primary.name, { kind: 'subdomain' }), current = await f.view()
    if (kind === 'missing-parent') await f.corrupt(child, { parentId: randomUUID() })
    else if (kind === 'foreign-parent') await f.corrupt(child, { parentId: f.otherPrimary.id })
    else if (kind === 'foreign-incoming') {
      const foreign = await f.legacy('incoming.' + f.otherPrimary.name, { kind: 'subdomain', accountId: f.other.id })
      await f.corrupt(foreign, { parentId: f.primary.id })
    } else {
      const second = await f.legacy('two.' + f.primary.name, { kind: 'subdomain' })
      if (kind === 'cycle') { await f.corrupt(child, { parentId: second.id }); await f.corrupt(second, { parentId: child.id }) }
      else await f.corrupt(second, { id: child.id })
    }
    const before = await f.images()
    for (const [method, body] of [['GET', undefined], ['POST', { name: 'blocked.example.test', kind: 'addon', expectedRevision: current.revision }]] as const) {
      const response = await f.request(method, body)
      expect(response.status).toBe(412)
      const error = await response.json()
      expect(error).toMatchObject({ details: { reason: 'domain_graph_invalid', stateChanged: false } })
      expect(JSON.stringify(error)).not.toContain(f.other.id)
      expect(JSON.stringify(error)).not.toContain(f.otherPrimary.name)
    }
    await unchanged(before)
  })

  it('checks DELETE confirmation against the name current under the writer lease', async () => {
    const saved = await create('before-confirm.example.test')
    let initialRead!: () => void
    const initial = new Promise<void>(resolve => { initialRead = resolve })
    const getDomain = f.state.store.getDomain.bind(f.state.store)
    let captured = false
    const lookup = vi.spyOn(f.state.store, 'getDomain').mockImplementation(async (...args: Parameters<typeof getDomain>) => {
      const domain = await getDomain(...args)
      if (!captured && args[0] === saved.domain.id) { captured = true; initialRead() }
      return domain
    })
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    const request = new Request('http://localhost' + endpoint + '/' + saved.domain.id, {
      method: 'DELETE', headers: { authorization: 'Bearer ' + f.credential, 'content-type': 'application/json' }, body, duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    const deleting = f.makeApp().fetch(request)
    let released = false
    try {
      await initial
      await f.state.store.renameDomain(saved.domain.id, 'after-confirm.example.test')
      await dbApi.reindexFromState(f.database.db, await f.state.store.readSnapshot())
      const current = await f.view(), before = await f.images()
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ confirmName: saved.domain.name, expectedRevision: current.revision })))
      controller.close(); released = true
      const response = await deleting
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
      await unchanged(before)
      expect(await f.state.store.getDomain(saved.domain.id)).toMatchObject({ name: 'after-confirm.example.test' })
      expect((await dbApi.listAudit(f.database.db)).filter(row => row.action === 'domain.deleted' && row.outcome === 'ok')).toEqual([])
    } finally {
      lookup.mockRestore()
      if (!released) { controller.error(new Error('Synthetic confirmation fixture cancelled')); await deleting.catch(() => undefined) }
    }
  })

  it('does not acknowledge a second concurrent owner DELETE after its target disappears', async () => {
    const saved = await create('double-delete.example.test'), current = await f.view()
    const getDomain = f.state.store.getDomain.bind(f.state.store)
    let arrivals = 0, release!: () => void
    const bothInitialReads = new Promise<void>(resolve => { release = resolve })
    const lookup = vi.spyOn(f.state.store, 'getDomain').mockImplementation(async (...args: Parameters<typeof getDomain>) => {
      const domain = await getDomain(...args)
      if (args[0] === saved.domain.id && domain && arrivals < 2) {
        arrivals++
        if (arrivals === 2) release()
        await bothInitialReads
      }
      return domain
    })
    try {
      const responses = await Promise.all([1, 2].map(() => f.request('DELETE', { confirmName: saved.domain.name, expectedRevision: current.revision }, { path: endpoint + '/' + saved.domain.id })))
      expect(arrivals).toBe(2)
      expect(responses.map(response => response.status).sort()).toEqual([200, 409])
      const accepted = responses.find(response => response.status === 200)!, refused = responses.find(response => response.status === 409)!
      expect(await accepted.json()).toMatchObject({ ok: true, stateChanged: true, removed: { id: saved.domain.id, name: saved.domain.name } })
      expect(await refused.json()).toMatchObject({ details: { stateChanged: false } })
      expect(await f.state.store.getDomain(saved.domain.id)).toBeNull()
      expect(await f.database.db.query('SELECT id FROM idx_domains WHERE id=$1', [saved.domain.id])).toEqual([])
      const audit = (await dbApi.listAudit(f.database.db)).filter(row => row.action === 'domain.deleted' && row.outcome === 'ok')
      expect(audit).toHaveLength(1)
      expect(audit[0]!.target).toBe('domain:' + saved.domain.name)
      expect(f.calls).toEqual([])
    } finally { release(); lookup.mockRestore() }
  })

  it('does not rebind an old immutable ID when the same name is later reused', async () => {
    const saved = await create('reused.example.test')
    await f.state.store.deleteDomain(saved.domain.id)
    const replacement = await f.legacy(saved.domain.name), current = await f.view(), before = await f.images()
    expect(replacement.id).not.toBe(saved.domain.id)
    expect((await f.request('DELETE', { confirmName: saved.domain.name, expectedRevision: current.revision }, { path: endpoint + '/' + saved.domain.id })).status).toBe(404)
    await unchanged(before)
    expect(await f.state.store.getDomain(replacement.id)).not.toBeNull()
  })

  it('does not create or modify an account index while projecting domain changes', async () => {
    await f.database.db.query('DELETE FROM idx_accounts WHERE id=$1', [f.owner.id])
    const accounts = await f.database.db.query('SELECT * FROM idx_accounts ORDER BY id')
    await create('without-parent-index.example.test')
    expect(await f.database.db.query('SELECT * FROM idx_accounts ORDER BY id')).toEqual(accounts)
    expect(f.calls).toEqual([])
  })

  it('preserves root and reseller legacy create grammar while refusing foreign reseller selection', async () => {
    const root = await dbApi.createRootPrincipal(f.database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
    const rootToken = await f.token(['domains:read', 'domains:write'], root.id)
    const response = await f.request('POST', { accountId: f.other.id, name: 'admin.example.test', kind: 'addon' }, { token: rootToken })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ domain: { accountId: f.other.id, name: 'admin.example.test' } })
    const reseller = await f.state.store.createReseller({ username: 'domainseller', passwordHash: HASH, acl: ['list-accounts', 'edit-account'], maxAccounts: 5,
      totalDiskMb: 10000, totalBandwidthMb: 'unlimited', oversell: false, nameservers: [], delegatedIps: [] })
    await f.state.store.changeOwner(f.owner.id, reseller.id)
    const principal = await dbApi.createResellerPrincipal(f.database.db, { id: reseller.id, username: reseller.username, passwordHash: HASH })
    const raw = await f.token(['domains:read', 'domains:write'], principal.id)
    expect((await f.request('POST', { accountId: f.owner.id, name: 'reseller.example.test', kind: 'addon' }, { token: raw })).status).toBe(201)
    const before = await f.images()
    expect((await f.request('POST', { accountId: f.other.id, name: 'foreign.example.test', kind: 'addon' }, { token: raw })).status).toBe(404)
    await unchanged(before)
  })

  it.each(['create', 'fanout', 'remove'] as const)('restores exact state and SQL preimages after %s projection fails after effects', async action => {
    let target: Domain | null = null
    if (action !== 'create') {
      const saved = await create('parent.example.test'); target = saved.domain
      if (action === 'fanout') await create('alias.example.test', { kind: 'alias', parentId: target.id })
    }
    const current = await f.view(), before = await f.images(), prepare = dbApi.prepareDomainIndexTransition
    vi.spyOn(dbApi, 'prepareDomainIndexTransition').mockImplementationOnce(async (...args: Parameters<typeof prepare>) => {
      const projection = await prepare(...args)
      return { apply: async () => { await projection.apply(); throw new Error('Synthetic post-projection outage') }, rollback: () => projection.rollback() }
    })
    const response = action === 'create' ? await f.request('POST', { name: 'failed.example.test', kind: 'addon', expectedRevision: current.revision })
      : action === 'fanout' ? await f.request('PATCH', { docRoot: 'failed-root', expectedRevision: current.revision }, { path: endpoint + '/' + target!.id })
        : await f.request('DELETE', { confirmName: target!.name, expectedRevision: current.revision }, { path: endpoint + '/' + target!.id })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ details: { stateChanged: false, verificationRequired: true } })
    await unchanged(before)
    expect((await f.view()).revision).toBe(current.revision)
  })

  it('retains journal evidence and unknown outcome when prepared projection restoration fails', async () => {
    const current = await f.view(), prepare = dbApi.prepareDomainIndexTransition
    vi.spyOn(dbApi, 'prepareDomainIndexTransition').mockImplementationOnce(async (...args: Parameters<typeof prepare>) => {
      const projection = await prepare(...args)
      return { apply: async () => { await projection.apply(); throw new Error('Synthetic projection interruption') }, rollback: async () => { throw new Error('Synthetic rollback interruption') } }
    })
    const response = await f.request('POST', { name: 'unknown.example.test', kind: 'addon', expectedRevision: current.revision })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ details: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    expect((await stat(f.state.store.getWriterLock().intentFilePath)).isFile()).toBe(true)
    expect(f.calls).toEqual([])
  })

  it('keeps a post-commit audit failure changed and unverified', async () => {
    const current = await f.view()
    vi.spyOn(dbApi, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic domain audit outage'))
    const response = await f.request('POST', { name: 'audit-failed.example.test', kind: 'addon', expectedRevision: current.revision })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ details: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    expect(await f.state.store.getDomainByName('audit-failed.example.test')).not.toBeNull()
    expect((await f.database.db.query('SELECT * FROM idx_domains WHERE name=$1', ['audit-failed.example.test']))).toHaveLength(1)
    expect(f.calls).toEqual([])
  })

  it('preserves configured synthetic global apply without claiming served-target proof or changing the agent caller', async () => {
    const application = f.makeApp('applied'), current = await f.view({ application })
    const response = await f.request('POST', { name: 'global-applied.example.test', kind: 'addon', expectedRevision: current.revision }, { application })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ stateChanged: true, application: { status: 'global_configuration_applied', targetVerified: false } })
    expect(f.calls).toEqual([{ path: '/state/apply', method: 'POST', principalId: f.principal.id }])
  })

  it.each(['rejected', 'malformed', 'transport'] as const)('keeps committed configuration after a configured %s application outcome', async mode => {
    const application = f.makeApp(mode), current = await f.view({ application })
    const response = await f.request('POST', { name: mode + '.example.test', kind: 'addon', expectedRevision: current.revision }, { application })
    expect(response.status).toBeGreaterThanOrEqual(400)
    const error = await response.json()
    expect(error).toMatchObject({ details: { stateChanged: true, verificationRequired: true } })
    if (mode !== 'rejected') expect(error).toMatchObject({ details: { unknownOutcome: true } })
    expect(await f.state.store.getDomainByName(mode + '.example.test')).not.toBeNull()
    expect(await f.database.db.query('SELECT * FROM idx_domains WHERE name=$1', [mode + '.example.test'])).toHaveLength(1)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toMatchObject({ principalId: f.principal.id })
  })

  it('rechecks credentials after commit before any configured native dispatch', async () => {
    const application = f.makeApp('applied'), current = await f.view({ application }), prepare = dbApi.prepareDomainIndexTransition
    vi.spyOn(dbApi, 'prepareDomainIndexTransition').mockImplementationOnce(async (...args: Parameters<typeof prepare>) => {
      const projection = await prepare(...args)
      return { apply: async () => { await projection.apply(); await dbApi.deletePrincipal(f.database.db, f.principal.id) }, rollback: () => projection.rollback() }
    })
    const response = await f.request('POST', { name: 'revoked-after-commit.example.test', kind: 'addon', expectedRevision: current.revision }, { application })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await response.json()).toMatchObject({ details: { stateChanged: true, verificationRequired: true } })
    expect(await f.state.store.getDomainByName('revoked-after-commit.example.test')).not.toBeNull()
    expect(f.calls).toEqual([])
  })
})
