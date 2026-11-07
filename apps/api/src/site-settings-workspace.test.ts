import { describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleDomainBulkRoute, handleSiteSettingsRoute, type SiteSettingsPorts } from './site-settings-workspace.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111', DOMAIN = '22222222-2222-4222-8222-222222222222', OTHER = '33333333-3333-4333-8333-333333333333'
const REVISION = 'a'.repeat(64)
const caller = (kind: 'user' | 'root' | 'reseller', accountId: string = ACCOUNT): AuthenticatedCaller => ({ principal: { kind, id: 'p', username: 'owner', ...(kind === 'user' && { accountId }) }, scopes: [] }) as unknown as AuthenticatedCaller
const base = (over: Partial<Domain> = {}): Domain => ({ id: DOMAIN, accountId: ACCOUNT, name: 'a.example.test', kind: 'primary', parentId: null, docRoot: '/home/a/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3' }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ...over }) as Domain

const setup = (domain: Domain, options: { who?: AuthenticatedCaller; quota?: { state: string; reason?: string }; engine?: string; applyFails?: boolean; dependency?: object } = {}) => {
  const state = { domain, saved: [] as object[], actions: [] as string[], deleted: [] as string[] }
  const apply = async <T,>(mutate: (o: never) => Promise<T>, action: string) => {
    state.actions.push(action)
    const value = await mutate({} as never)
    if (options.applyFails) fail('CONFIG_TEST_FAILED', 'requires verification', { stateChanged: true })
    return { value, reconcile: null, view: { revision: REVISION } }
  }
  const ports: SiteSettingsPorts = {
    store: {
      getDomain: async id => id === state.domain.id ? state.domain : null,
      getAccount: async () => ({ id: ACCOUNT, username: 'owner' }) as Account,
      getServerSettings: async () => ({ engine: options.engine ?? 'apache' }) as never,
      updateDomain: async (_id, patch) => { state.saved.push(patch); state.domain = { ...state.domain, ...patch }; return state.domain },
      deleteDomain: async id => { state.deleted.push(id); return true },
      readDomainWorkspace: async () => ({ source: { dependencies: [{ domainId: DOMAIN, ...options.dependency }] } }) as never,
    },
    requireCaller: async () => options.who ?? caller('user'),
    assertCanAccessAccount: async () => undefined,
    assertFeatures: async () => undefined,
    readJsonBody: async req => await req.json() as Record<string, unknown>,
    readAgent: (async (_caller: unknown, path: string) => { if (path.includes('website-backups')) return { operationId: 'x' }; return options.quota ?? { state: 'ready' } }) as never,
    mutateDomainWorkspace: (async (_req: Request, _caller: AuthenticatedCaller, _account: Account, _expected: unknown, action: string, mutate: (o: never) => Promise<unknown>) => apply(mutate, action)) as never,
  }
  const call = async (method: string, body?: unknown, path = `/api/domains/${DOMAIN}/site-settings`) => {
    const url = new URL('http://localhost' + path)
    const request = new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const response = await (path.endsWith('bulk-actions') ? handleDomainBulkRoute : handleSiteSettingsRoute)(request, url, method, ports)
    return await response!.json() as Record<string, never>
  }
  return { state, call }
}
const refused = async (promise: Promise<unknown>): Promise<{ code: string; detail: Record<string, unknown> }> => {
  try { await promise } catch (error) { return error as { code: string; detail: Record<string, unknown> } }
  throw new Error('expected a refusal')
}

describe('site settings route', () => {
  it('saves settings through the domain workspace', async () => {
    const { state, call } = setup(base())
    const site = { runDirectory: 'public', denyRules: [{ name: 'u', directory: '/uploads', extensions: ['php'] }], traffic: { siteConnections: null, ipConnections: 2, rateKbPerConnection: null } }
    await call('PUT', { expectedRevision: REVISION, expiresAt: '2026-12-01', pathQuotaMb: 100, site })
    expect(state.actions).toEqual(['domain.updated'])
    expect(state.domain).toMatchObject({ expiresAt: '2026-12-01T00:00:00.000Z', pathQuotaMb: 100, site })
  })
  it('owner stop and start swap the state, and an administrator stop stays', async () => {
    const { state, call } = setup(base())
    await call('PUT', { expectedRevision: REVISION, suspended: true })
    expect(state.domain).toMatchObject({ suspended: true, site: { stoppedByOwner: true } })
    await call('PUT', { expectedRevision: REVISION, suspended: false })
    expect(state.domain.suspended).toBe(false)
    expect(state.domain.site).toBeUndefined()
    expect(state.actions).toEqual(['domain.site_stopped', 'domain.site_started'])
    expect((await refused(setup(base({ suspended: true })).call('PUT', { expectedRevision: REVISION, suspended: false }))).detail.reason).toBe('stopped_by_administrator')
  })
  it('refuses a path quota the filesystem cannot enforce, with the stable code', async () => {
    const failure = await refused(setup(base(), { quota: { state: 'unsupported', reason: 'filesystem' } }).call('PUT', { expectedRevision: REVISION, pathQuotaMb: 100 }))
    expect(failure).toMatchObject({ code: 'VALIDATION', detail: { reason: 'QUOTA_UNSUPPORTED_FS', stateChanged: false } })
  })
  it('keeps server-held keys out of owner reach', async () => {
    expect((await refused(setup(base()).call('PUT', { expectedRevision: REVISION, site: { category: 'x' } }))).code).toBe('VALIDATION')
    expect((await refused(setup(base()).call('PUT', { expectedRevision: REVISION, site: { stoppedByOwner: true } }))).code).toBe('VALIDATION')
    const { state, call } = setup(base({ site: { category: 'shop' } }))
    await call('PUT', { expectedRevision: REVISION, site: { isolated: true } })
    expect(state.domain.site).toEqual({ isolated: true, category: 'shop' })
  })
  it('matches each setting to the sites it can work on', async () => {
    expect((await refused(setup(base({ siteType: 'proxy' })).call('PUT', { expectedRevision: REVISION, site: { runDirectory: 'public' } }))).code).toBe('VALIDATION')
    expect((await refused(setup(base({ siteType: 'static' })).call('PUT', { expectedRevision: REVISION, site: { isolated: true } }))).code).toBe('VALIDATION')
    expect((await refused(setup(base(), { engine: 'openlitespeed' }).call('PUT', { expectedRevision: REVISION, site: { isolated: true } }))).detail.reason).toBe('isolation_engine')
    expect((await refused(setup(base({ kind: 'alias' })).call('PUT', { expectedRevision: REVISION, site: { visitorLogOff: true } }))).code).toBe('VALIDATION')
  })
  it('refuses a save with no change and answers a neighbour as missing', async () => {
    expect((await refused(setup(base({ expiresAt: '2026-12-01T00:00:00.000Z' })).call('PUT', { expectedRevision: REVISION, expiresAt: '2026-12-01' }))).code).toBe('VALIDATION')
    expect((await refused(setup(base({ accountId: OTHER })).call('GET'))).code).toBe('NOT_FOUND')
    expect((await refused(setup(base(), { who: caller('root') }).call('GET'))).code).toBe('FORBIDDEN')
  })
  it('rolls the saved settings back when the configuration test fails', async () => {
    const { state, call } = setup(base(), { applyFails: true })
    const failure = await refused(call('PUT', { expectedRevision: REVISION, site: { visitorLogOff: true } }))
    expect(failure).toMatchObject({ code: 'CONFIG_TEST_FAILED', detail: { rolledBack: true, stateChanged: false } })
    expect(state.domain.site).toBeUndefined()
  })
  it('reports the quota state', async () => {
    expect(await setup(base(), { quota: { state: 'unsupported', reason: 'mount_option' } }).call('GET')).toEqual({ quota: { state: 'unsupported', reason: 'mount_option' } })
  })
})

describe('bulk site actions', () => {
  const bulk = '/api/domains/bulk-actions', root = { who: caller('root') }
  it('is for root only', async () => {
    expect((await refused(setup(base(), { who: caller('reseller') }).call('POST', { action: 'stop', domains: [{ id: DOMAIN }] }, bulk))).code).toBe('FORBIDDEN')
  })
  it('sets the PHP version and reports every site', async () => {
    const { state, call } = setup(base(), root)
    const reply = await call('POST', { action: 'php', version: '8.2', domains: [{ id: DOMAIN }, { id: OTHER }] }, bulk) as unknown as { results: { outcome: string; code: string | null }[]; summary: Record<string, number> }
    expect(state.domain.php.version).toBe('8.2')
    expect(reply.results.map(item => item.outcome)).toEqual(['applied', 'refused'])
    expect(reply.results[1]!.code).toBe('NOT_FOUND')
    expect(reply.summary).toMatchObject({ applied: 1, refused: 1 })
  })
  it('root stop drops the owner mark, so the owner cannot lift it', async () => {
    const { state, call } = setup(base({ suspended: true, site: { stoppedByOwner: true } }), root)
    await call('POST', { action: 'stop', domains: [{ id: DOMAIN }] }, bulk)
    expect(state.domain.site).toBeUndefined()
  })
  it('deletes only on the typed name and never cascades', async () => {
    const typed = setup(base(), root)
    const wrong = await typed.call('POST', { action: 'delete', domains: [{ id: DOMAIN, confirmName: 'x' }] }, bulk) as unknown as { summary: { refused: number } }
    expect(wrong.summary.refused).toBe(1)
    await typed.call('POST', { action: 'delete', domains: [{ id: DOMAIN, confirmName: 'a.example.test' }] }, bulk)
    expect(typed.state.deleted).toEqual([DOMAIN])
    const parent = setup(base(), { ...root, dependency: { childCount: 1, serviceUserCount: 0 } })
    await parent.call('POST', { action: 'delete', domains: [{ id: DOMAIN, confirmName: 'a.example.test' }] }, bulk)
    expect(parent.state.deleted).toEqual([])
  })
  it('stops at the first unknown outcome', async () => {
    const reply = await setup(base(), { ...root, applyFails: true }).call('POST', { action: 'stop', domains: [{ id: DOMAIN }, { id: OTHER }] }, bulk) as unknown as { results: { outcome: string }[] }
    expect(reply.results.map(item => item.outcome)).toEqual(['review-required', 'not-attempted'])
  })
  it('sets a category and starts a backup', async () => {
    const { state, call } = setup(base(), root)
    await call('POST', { action: 'category', category: 'shops', domains: [{ id: DOMAIN }] }, bulk)
    expect(state.domain.site).toEqual({ category: 'shops' })
    const reply = await call('POST', { action: 'backup', domains: [{ id: DOMAIN }] }, bulk) as unknown as { summary: { applied: number } }
    expect(reply.summary.applied).toBe(1)
  })
})
