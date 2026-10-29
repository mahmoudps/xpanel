import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as dbApi from '@xpanel/db'
import type { Domain } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import { sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'
import { TEST_SERVER_SECRET } from './testing.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: Array<() => Promise<unknown>> = []
const endpoint = '/api/domains'
interface View {
  context: { accountId: string; home: string }; revision: string; domains: Domain[]
  removals: Array<{ domainId: string; canRemove: boolean }>
  application: { status: string; targetVerified: boolean }
}

const fixture = async () => {
  const database = await dbApi.createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const feature = await state.store.createFeatureList({ name: 'WHM domain policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'WHM domain plan', ownerId: null, featureListId: feature.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 3, aliasDomains: 3, subdomains: 3, mailboxes: 4, forwarders: 4, mailingLists: 4, ftpAccounts: 4, databases: 4, phpWorkers: 4 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.73', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const seller = await state.store.createReseller({ username: 'whmdomainseller', passwordHash: HASH, acl: ['list-accounts', 'edit-account'], maxAccounts: 5,
    totalDiskMb: 10000, totalBandwidthMb: 'unlimited', oversell: false, nameservers: [], delegatedIps: [] })
  const account = (username: string, ownerId: string | null) => state.store.createAccount({ username, ownerId, passwordHash: HASH, primaryDomain: username + '.example.test', planId: plan.id,
    contactEmail: 'owner@' + username + '.example.test', ipv4: '192.0.2.73', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const owner = await account('whmdomaina', seller.id), other = await account('whmdomainb', null)
  const primary = (await state.store.getDomainByName(owner.primaryDomain))!
  const root = await dbApi.createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  const reseller = await dbApi.createResellerPrincipal(database.db, { id: seller.id, username: seller.username, passwordHash: HASH })
  const user = await dbApi.createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  await dbApi.reindexFromState(database.db, await state.store.readSnapshot())
  const token = async (principalId: string, scopes = ['domains:read', 'domains:write']) => {
    const raw = 'xp_' + randomUUID()
    const saved = await dbApi.createApiToken(database.db, { principalId, name: 'Synthetic WHM domains', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return { raw, id: saved.id }
  }
  const rootToken = await token(root.id), resellerToken = await token(reseller.id), userToken = await token(user.id)
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET })
  const request = (method: string, body?: unknown, options: { path?: string; token?: string } = {}) => app.fetch(new Request('http://localhost' + (options.path ?? endpoint), {
    method, headers: { authorization: 'Bearer ' + (options.token ?? rootToken.raw), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const view = async (selected = owner.id, credential = rootToken.raw): Promise<View> => {
    const response = await request('GET', undefined, { path: endpoint + '?accountId=' + selected + '&workspace=1', token: credential })
    expect(response.status).toBe(200)
    return await response.json() as View
  }
  const create = async (name: string, extra: Record<string, unknown> = {}, credential = rootToken.raw) => {
    const current = await view(owner.id, credential)
    const response = await request('POST', { accountId: owner.id, name, kind: 'addon', expectedRevision: current.revision, ...extra }, { token: credential })
    expect(response.status).toBe(201)
    return await response.json() as View & { domain: Domain; stateChanged: boolean }
  }
  const images = async () => ({
    accounts: (await state.store.readSnapshot()).accounts,
    domains: (await state.store.readSnapshot()).domains,
    index: await database.db.query('SELECT * FROM idx_domains ORDER BY id'),
    search: await database.db.query('SELECT rowid, kind, entity_id, account_id, owner_id, title, subtitle, keywords FROM search_fts ORDER BY rowid'),
  })
  return { database, state, owner, other, primary, root, reseller, seller, rootToken, resellerToken, userToken, token, request, view, create, images }
}

describe('account-pinned WHM domain workspace over real state and SQLite', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    vi.restoreAllMocks()
    const failures: unknown[] = []
    for (const close of cleanup.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
    if (failures.length) throw new AggregateError(failures, 'Synthetic WHM domain cleanup failed')
  })

  it.each(['root', 'reseller'] as const)('reads one authorized %s account workspace without exposing its neighbor', async role => {
    const current = await f.view(f.owner.id, role === 'root' ? f.rootToken.raw : f.resellerToken.raw)
    expect(current.context).toEqual({ accountId: f.owner.id, home: f.owner.home })
    expect(current.domains).toEqual([f.primary])
    expect(current.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(current.removals).toEqual([{ domainId: f.primary.id, childCount: 0, serviceUserCount: 0, canRemove: false }])
    expect(current.application).toEqual({ status: 'unverified', targetVerified: false })
  })

  it('keeps legacy admin list grammar and owner query-selector refusal', async () => {
    const legacy = await f.request('GET', undefined, { path: endpoint + '?accountId=' + f.owner.id })
    expect(await legacy.json()).toEqual({ domains: [f.primary] })
    expect((await f.request('GET', undefined, { path: endpoint + '?accountId=' + f.owner.id + '&workspace=1', token: f.userToken.raw })).status).toBe(422)
  })

  it.each(['?workspace=1', '?workspace=0', '?workspace=1&accountId=SELECTED&accountId=SELECTED', '?workspace=1&accountId=SELECTED&extra=1'])('refuses ambiguous workspace selector %s', async query => {
    const before = await f.images()
    expect((await f.request('GET', undefined, { path: endpoint + query.replaceAll('SELECTED', f.owner.id) })).status).toBe(422)
    expect(await f.images()).toEqual(before)
  })

  it('refuses foreign reseller reads and writes before returning workspace data', async () => {
    const before = await f.images()
    const response = await f.request('GET', undefined, { path: endpoint + '?accountId=' + f.other.id + '&workspace=1', token: f.resellerToken.raw })
    expect(response.status).toBe(404)
    expect(await response.json()).not.toHaveProperty('domains')
    const foreign = await f.view(f.other.id)
    expect((await f.request('POST', { accountId: f.other.id, name: 'foreign.example.test', kind: 'addon', expectedRevision: foreign.revision }, { token: f.resellerToken.raw })).status).toBe(404)
    expect(await f.images()).toEqual(before)
  })

  it.each(['root', 'reseller'] as const)('creates, updates with alias fanout and removes a confirmed %s leaf', async role => {
    const token = role === 'root' ? f.rootToken.raw : f.resellerToken.raw
    const neighbor = (await f.images()).domains.filter(domain => domain.accountId === f.other.id)
    const parent = await f.create('parent.example.test', { siteType: 'static', docRoot: 'parent-root' }, token)
    const alias = await f.create('alias.example.test', { kind: 'alias', parentId: parent.domain.id }, token)
    expect(alias.domain).toMatchObject({ parentId: parent.domain.id, docRoot: parent.domain.docRoot, siteType: 'static', php: parent.domain.php })
    const current = await f.view(f.owner.id, token)
    const response = await f.request('PATCH', { docRoot: 'next-root', expectedRevision: current.revision }, { path: endpoint + '/' + parent.domain.id, token })
    expect(response.status).toBe(200)
    const saved = await response.json() as View & { domain: Domain }
    expect(saved.domain.docRoot).toBe(f.owner.home + '/next-root')
    expect(saved.domains.find(domain => domain.id === alias.domain.id)?.docRoot).toBe(saved.domain.docRoot)
    expect(saved.application).toEqual({ status: 'not_requested', targetVerified: false })
    const removed = await f.request('DELETE', { confirmName: alias.domain.name, expectedRevision: saved.revision }, { path: endpoint + '/' + alias.domain.id, token })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ ok: true, stateChanged: true, removed: { id: alias.domain.id, name: alias.domain.name } })
    expect(await f.state.store.getDomain(alias.domain.id)).toBeNull()
    expect(await f.database.db.query('SELECT id FROM idx_domains WHERE id=$1', [alias.domain.id])).toEqual([])
    expect((await f.images()).domains.filter(domain => domain.accountId === f.other.id)).toEqual(neighbor)
  })

  it.each([null, 42, 'bad'])('rejects malformed admin revision %j without effects', async expectedRevision => {
    const before = await f.images()
    expect((await f.request('POST', { accountId: f.owner.id, name: 'bad-revision.example.test', kind: 'addon', expectedRevision })).status).toBe(422)
    expect(await f.images()).toEqual(before)
  })

  it('refuses stale and cross-account revisions while preserving legacy unguarded administration', async () => {
    const old = await f.view(), foreign = await f.view(f.other.id)
    await f.create('first.example.test')
    const before = await f.images()
    for (const expectedRevision of [old.revision, foreign.revision]) expect((await f.request('POST', { accountId: f.owner.id, name: 'stale.example.test', kind: 'addon', expectedRevision })).status).toBe(409)
    expect(await f.images()).toEqual(before)
    expect((await f.request('POST', { accountId: f.owner.id, name: 'legacy.example.test', kind: 'addon' })).status).toBe(201)
  })

  it('enforces exact confirmation and dependencies for guarded administrative deletion', async () => {
    const parent = await f.create('parent.example.test')
    const alias = await f.create('alias.example.test', { kind: 'alias', parentId: parent.domain.id })
    const current = await f.view(), before = await f.images()
    for (const confirmName of [undefined, 'wrong.example.test']) expect((await f.request('DELETE', { confirmName, expectedRevision: current.revision }, { path: endpoint + '/' + alias.domain.id })).status).toBe(422)
    expect((await f.request('DELETE', { confirmName: parent.domain.name, expectedRevision: current.revision }, { path: endpoint + '/' + parent.domain.id })).status).toBe(412)
    expect((await f.request('DELETE', { confirmName: f.primary.name, expectedRevision: current.revision }, { path: endpoint + '/' + f.primary.id })).status).toBe(412)
    expect(await f.images()).toEqual(before)
  })

  it('does not accept owner-only selectors, foreign parents or runtime injection in a guarded admin request', async () => {
    const current = await f.view(), otherPrimary = (await f.state.store.getDomainByName(f.other.primaryDomain))!, before = await f.images()
    for (const extra of [{ certificateId: randomUUID() }, { kind: 'alias', parentId: otherPrimary.id }, { kind: 'alias', parentId: f.primary.id, docRoot: 'independent' }, { siteType: 'proxy' }]) {
      expect((await f.request('POST', { accountId: f.owner.id, name: 'injected.example.test', kind: 'addon', expectedRevision: current.revision, ...extra })).status).toBe(422)
    }
    expect((await f.request('PATCH', { name: 'renamed.example.test', expectedRevision: current.revision }, { path: endpoint + '/' + f.primary.id })).status).toBe(422)
    expect(await f.images()).toEqual(before)
  })

  it('retains read permission without allowing a read-only token or inactive account to mutate', async () => {
    const readOnly = await f.token(f.root.id, ['domains:read']), current = await f.view(f.owner.id, readOnly.raw), before = await f.images()
    expect((await f.request('POST', { accountId: f.owner.id, name: 'readonly.example.test', kind: 'addon', expectedRevision: current.revision }, { token: readOnly.raw })).status).toBe(403)
    expect(await f.images()).toEqual(before)
    await f.state.store.suspendAccount(f.owner.id, 'Synthetic inactive workspace')
    const inactive = await f.view(), suspended = await f.images()
    expect((await f.request('POST', { accountId: f.owner.id, name: 'inactive.example.test', kind: 'addon', expectedRevision: inactive.revision })).status).toBe(403)
    expect(await f.images()).toEqual(suspended)
  })

  it('admits one concurrent guarded write for a single administrative revision', async () => {
    const current = await f.view()
    const results = await Promise.all(['one.example.test', 'two.example.test'].map(name => f.request('POST', { accountId: f.owner.id, name, kind: 'addon', expectedRevision: current.revision })))
    expect(results.map(response => response.status).sort()).toEqual([201, 409])
    expect((await f.view()).domains.filter(domain => domain.kind === 'addon')).toHaveLength(1)
  })

  it('rechecks administrator credentials inside the writer lease', async () => {
    const current = await f.view(), before = await f.images(), read = f.state.store.readDomainWorkspace.bind(f.state.store)
    vi.spyOn(f.state.store, 'readDomainWorkspace').mockImplementationOnce(async (...args: Parameters<typeof read>) => {
      const workspace = await read(...args)
      await dbApi.revokeApiToken(f.database.db, f.rootToken.id)
      return workspace
    })
    expect((await f.request('POST', { accountId: f.owner.id, name: 'revoked.example.test', kind: 'addon', expectedRevision: current.revision })).status).toBe(401)
    expect(await f.images()).toEqual(before)
  })

  it('rechecks reseller scope against the account actually returned by the workspace read', async () => {
    const read = f.state.store.readDomainWorkspace.bind(f.state.store)
    vi.spyOn(f.state.store, 'readDomainWorkspace').mockImplementationOnce(async (...args: Parameters<typeof read>) => {
      await f.state.store.changeOwner(f.owner.id, null)
      return read(...args)
    })
    const response = await f.request('GET', undefined, { path: endpoint + '?accountId=' + f.owner.id + '&workspace=1', token: f.resellerToken.raw })
    expect(response.status).toBe(404)
    expect(await response.json()).not.toHaveProperty('domains')
  })

  it('refuses a reseller transfer that occurs before the mutation writer lease', async () => {
    const current = await f.view(), before = await f.images(), read = f.state.store.readDomainWorkspace.bind(f.state.store)
    vi.spyOn(f.state.store, 'readDomainWorkspace').mockImplementationOnce(async (...args: Parameters<typeof read>) => {
      const workspace = await read(...args)
      await f.state.store.changeOwner(f.owner.id, null)
      return workspace
    })
    const response = await f.request('POST', { accountId: f.owner.id, name: 'transferred.example.test', kind: 'addon', expectedRevision: current.revision }, { token: f.resellerToken.raw })
    expect(response.status).toBe(404)
    const after = await f.images()
    expect(after.domains).toEqual(before.domains)
    expect(after.index).toEqual(before.index)
    expect(after.search).toEqual(before.search)
  })

  it('restores state and SQL projection after a guarded admin index failure', async () => {
    const current = await f.view(), before = await f.images(), prepare = dbApi.prepareDomainIndexTransition
    vi.spyOn(dbApi, 'prepareDomainIndexTransition').mockImplementationOnce(async (...args: Parameters<typeof prepare>) => {
      const projection = await prepare(...args)
      return { apply: async () => { await projection.apply(); throw new Error('Synthetic admin projection interruption') }, rollback: () => projection.rollback() }
    })
    const response = await f.request('POST', { accountId: f.owner.id, name: 'failed.example.test', kind: 'addon', expectedRevision: current.revision })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ details: { stateChanged: false, verificationRequired: true } })
    expect(await f.images()).toEqual(before)
  })
})
