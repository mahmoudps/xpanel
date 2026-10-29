import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_INDEX_FILES, fail } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { createDefaultIndexWorkspaceRoutes, parseDefaultIndexList, type DefaultIndexWorkspaceHelpers } from './default-index-workspace.ts'
import { settings } from '../../../packages/render/src/edge/testkit.ts'
import { TEST_SERVER_SECRET } from './testing.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const fixture = async () => {
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  await state.store.saveServerSettings({ ...settings(), defaultSite: { response: 'redirect', redirectTo: 'https://landing.example.test/', refuseHttps: true } })
  const feature = await state.store.createFeatureList({ name: 'Index policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Index plan', ownerId: null, featureListId: feature.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = await state.store.createAccount({ username: 'index9', passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g', primaryDomain: 'index.example.test', planId: plan.id, ownerId: null,
    contactEmail: 'owner@example.test', ipv4: '192.0.2.10', shell: 'none', php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const domain = (await state.store.getDomainByName(account.primaryDomain))!
  const caller = { principal: { kind: 'root', id: randomUUID(), username: 'root' }, apiTokenId: randomUUID() } as AuthenticatedCaller
  const helpers: DefaultIndexWorkspaceHelpers = { store: state.store, serverSecret: TEST_SERVER_SECRET, requireCaller: vi.fn(async () => caller), assertRoot: vi.fn(async () => {}), emitAudit: vi.fn(async () => {}), assertMutationQualified: vi.fn(async () => {}) }
  const route = createDefaultIndexWorkspaceRoutes(helpers), endpoint = '/api/server/default-index/' + domain.name
  const request = (method = 'GET', body?: unknown, path = endpoint) => {
    const url = new URL('http://localhost' + path)
    return route(new Request(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }) }), url, method)
  }
  const view = async () => await (await request())!.json() as { configuration: { indexFiles: string[]; revision: string; explicit: boolean }; actions: { save: boolean }; application: { status: string } }
  const write = async (indexFiles = 'home.html,index.php', reset = false) => request(reset ? 'POST' : 'PUT', { expectedRevision: (await view()).configuration.revision, confirmation: domain.name, ...(!reset ? { indexFiles } : {}) }, endpoint + (reset ? '/reset' : ''))
  return { state, domain, account, caller, helpers, request, view, write, endpoint, path: join(state.rootDir, 'accounts', account.username, 'domains', domain.name + '.json') }
}

describe('bounded root index workspace with real journaled desired state', () => {
  it('reads implicit defaults without creating metadata or changing the default-site policy', async () => {
    const f = await fixture(), before = await f.state.store.getRevision(), bytes = await readFile(f.path)
    expect((await f.view()).configuration).toMatchObject({ indexFiles: [...DEFAULT_INDEX_FILES], explicit: false })
    expect(await readFile(f.path)).toEqual(bytes); expect(await f.state.store.getRevision()).toBe(before)
    expect((await f.state.store.getServerSettings())!.defaultSite).toMatchObject({ response: 'redirect', refuseHttps: true })
  })
  it('previews ordered actual engine directives without writing or claiming native syntax checks', async () => {
    const f = await fixture(), current = await f.view(), before = await f.state.store.getRevision()
    expect(await (await f.request('POST', { expectedRevision: current.configuration.revision, indexFiles: 'home.html,index.php' }, f.endpoint + '/preview'))!.json()).toMatchObject({ preview: { lines: ['DirectoryIndex disabled', 'DirectoryIndex home.html index.php'], syntaxChecked: false } })
    expect(await f.state.store.getRevision()).toBe(before)
    await f.state.store.saveServerSettings({ ...settings({ engine: 'openlitespeed' }), defaultSite: { response: 'reject', redirectTo: null, refuseHttps: false } })
    const next = await f.view()
    expect(await (await f.request('POST', { expectedRevision: next.configuration.revision, indexFiles: 'home.html,index.php' }, f.endpoint + '/preview'))!.json()).toMatchObject({ preview: { lines: ['useServer 0', 'indexFiles home.html, index.php'] } })
  })
  it('saves and resets canonical order with exact persisted readback and retained full domain/settings', async () => {
    const f = await fixture(), originalSettings = await f.state.store.getServerSettings(), originalDomain = await f.state.store.getDomain(f.domain.id), before = await f.view()
    const response = await f.write(), saved = await response!.json()
    expect(saved).toMatchObject({ stateChanged: true, configuration: { indexFiles: ['home.html', 'index.php'], explicit: true }, application: { status: 'not_requested', targetVerified: false } })
    expect((await f.view()).configuration.revision).toBe(saved.configuration.revision)
    expect(saved.configuration.revision).not.toBe(before.configuration.revision)
    expect(await f.state.store.getDomain(f.domain.id)).toEqual({ ...originalDomain, indexFiles: ['home.html', 'index.php'] })
    expect(await f.state.store.getServerSettings()).toEqual(originalSettings)
    expect(await (await f.write('', true))!.json()).toMatchObject({ configuration: { indexFiles: [...DEFAULT_INDEX_FILES] }, stateChanged: true })
  })
  it.each(['user', 'reseller'] as const)('refuses %s before revealing domain data', async kind => {
    const f = await fixture(); vi.mocked(f.helpers.requireCaller).mockResolvedValue({ principal: { kind, id: randomUUID() } } as AuthenticatedCaller)
    await expect(f.request()).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    await expect(f.request('GET', undefined, '/api/server/default-index')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('refuses stale concurrent index changes using the existing domain workspace CAS', async () => {
    const f = await fixture(), old = await f.view(), revision = (await f.state.store.readDomainWorkspace(f.account.id)).revision
    await f.state.store.updateDomain(f.domain.id, { indexFiles: ['new.html'] })
    expect((await f.state.store.readDomainWorkspace(f.account.id)).revision).not.toBe(revision)
    await expect(f.request('PUT', { expectedRevision: old.configuration.revision, confirmation: f.domain.name, indexFiles: 'home.html' })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect((await f.state.store.getDomain(f.domain.id))!.indexFiles).toEqual(['new.html'])
  })
  it.each(['root', 'reseller'] as const)('reauthorizes root and rejects changed %s credentials under the writer guard before any change', async kind => {
    const f = await fixture(), current = await f.view(), bytes = await readFile(f.path)
    vi.mocked(f.helpers.requireCaller).mockReset().mockResolvedValueOnce(f.caller).mockResolvedValue({ ...f.caller, apiTokenId: randomUUID(), principal: { ...f.caller.principal, kind } } as AuthenticatedCaller)
    await expect(f.request('PUT', { expectedRevision: current.configuration.revision, confirmation: f.domain.name, indexFiles: 'home.html' })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(await readFile(f.path)).toEqual(bytes)
  })
  it('keeps unqualified mutations unavailable and rejects selector/grammar/confirmation injection', async () => {
    const f = await fixture(); vi.mocked(f.helpers.assertMutationQualified).mockImplementation(async () => fail('PRECONDITION_FAILED', 'Synthetic unqualified host', { stateChanged: false }))
    expect((await f.view()).actions.save).toBe(false)
    const current = await f.view(), valid = { expectedRevision: current.configuration.revision, confirmation: f.domain.name, indexFiles: 'home.html' }
    await expect(f.request('PUT', valid)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    await expect(f.request('PUT', { ...valid, path: '/etc/passwd' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.request('PUT', { ...valid, confirmation: 'other.example.test' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.request('GET', undefined, f.endpoint + '?path=/etc/passwd')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(() => parseDefaultIndexList('../index.html')).toThrow(); expect(() => parseDefaultIndexList('index.php,index.php')).toThrow()
  })
  it('uses exact file preimage compensation if the bounded index projection fails', async () => {
    const f = await fixture(), bytes = await readFile(f.path), current = await f.view(), rollback = vi.fn(async () => {})
    f.helpers.prepareProjection = async () => ({ apply: async () => { throw new Error('Synthetic projection failure') }, rollback })
    await expect(f.request('PUT', { expectedRevision: current.configuration.revision, confirmation: f.domain.name, indexFiles: 'home.html' })).rejects.toMatchObject({ detail: { stateChanged: false } })
    expect(await readFile(f.path)).toEqual(bytes); expect(rollback).toHaveBeenCalledOnce()
  })
  it.each([{ suspended: true }, { expiresAt: '2020-01-01T00:00:00Z' }, { redirect: { to: 'https://other.example.test/', code: 302 as const } }])('refuses index changes for non-serving domain %j', async patch => {
    const f = await fixture(); await f.state.store.updateDomain(f.domain.id, patch)
    const current = await f.view()
    expect(current.actions.save).toBe(false)
    await expect(f.request('PUT', { expectedRevision: current.configuration.revision, confirmation: f.domain.name, indexFiles: 'home.html' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
  it('keeps alias index order inherited from its serving vhost', async () => {
    const f = await fixture()
    const alias = await f.state.store.createDomain({ ...f.domain, name: 'alias.example.test', kind: 'alias', parentId: f.domain.id })
    const response = await f.request('GET', undefined, '/api/server/default-index/' + alias.name), saved = await response!.json()
    expect(saved.actions).toEqual({ preview: false, save: false, reset: false })
    await expect(f.request('POST', { expectedRevision: saved.configuration.revision, confirmation: alias.name }, '/api/server/default-index/' + alias.name + '/reset')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
  it('marks apply failures uncertain after a proven committed save without replay', async () => {
    const f = await fixture(); f.helpers.applyConfiguration = vi.fn(async () => { throw new Error('Synthetic interrupted apply') })
    await expect(f.write()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true, verificationRequired: true } })
    expect((await f.state.store.getDomain(f.domain.id))!.indexFiles).toEqual(['home.html', 'index.php'])
    expect(f.helpers.applyConfiguration).toHaveBeenCalledOnce()
  })
  it('pins native apply to its exact committed authority and validates the acknowledgement', async () => {
    const f = await fixture()
    f.helpers.applyConfiguration = vi.fn(async (_caller, account, revision) => { expect(account.id).toBe(f.account.id); expect(revision).toBe(await f.state.store.getRevision()); return { status: 'global_configuration_applied', targetVerified: false } as const })
    expect(await (await f.write())!.json()).toMatchObject({ application: { status: 'global_configuration_applied', targetVerified: false } })
  })
})
