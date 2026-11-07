import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail, isXpanelError } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { createMailxWorkspaceRoutes, projectMailxHostStatus } from './mailx-workspace.ts'
import type { MailxWorkspaceHelpers } from './mailx-workspace.ts'
import { MAILX_SECTIONS, mailxRevision } from '../../agent/src/mailx-policy.ts'
import { readMailxSaved } from '../../agent/src/mailx-routes.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const task of cleanup.splice(0)) await task() })
const hostStatus = (geoip: boolean) => ({ observedAt: '2026-11-07T10:00:00.000Z', revision: 'a'.repeat(64), postfix: 'read', engine: { engine: 'rspamd', units: { 'rspamd.service': 'active', 'spamassassin.service': 'not-installed', 'spamd.service': 'not-installed' }, wiring: 'wired' },
  sections: Object.fromEntries(MAILX_SECTIONS.map(section => [section, 'not-saved'])), archive: { accounts: 0, state: 'not-saved', conflicts: [] }, geoip: { installed: geoip, month: geoip ? '2026-11' : null } })

async function fixture(options: { geoip?: boolean } = {}) {
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Mail', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Mail', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 5, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.41', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null, contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.41', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const own = await account('ownera'), other = await account('ownerb')
  const zone = (name: string, mx: string) => state.store.saveDnsZone({ id: crypto.randomUUID(), accountId: own.id, name, serial: 1, records: [{ id: crypto.randomUUID(), zone: name, name: 'mail', type: 'A', ttl: 300, content: '192.0.2.41', priority: null }, { id: crypto.randomUUID(), zone: name, name: '@', type: 'MX', ttl: 300, content: mx, priority: 10 }] })
  await zone('ownera.example.test', 'mail.ownera.example.test')
  const owner: AuthenticatedCaller = { principal: { id: 'user-' + own.id, kind: 'user', username: own.username, accountId: own.id }, principalRecord: {}, sessionId: 's1', sessionToken: null, apiTokenId: null, scopes: [], csrfValid: true, mfaVerified: true } as unknown as AuthenticatedCaller
  const root = { ...owner, principal: { id: 'root-id', kind: 'root', username: 'root' } } as unknown as AuthenticatedCaller
  let current = owner
  const audits: string[] = []
  const callHost = vi.fn(async (_caller: AuthenticatedCaller, path: string, body?: unknown): Promise<unknown> => {
    if (path === '/host/mailx/state') return hostStatus(options.geoip === true)
    if (path.endsWith('/mailboxes')) return { observedAt: '2026-11-07T10:00:00.000Z', engine: { engine: 'rspamd', wiring: 'wired' }, jobsAvailable: true, greylist: 'pending', mailboxes: [] }
    if (path.startsWith('/host/mail/log/account/')) return { scope: 'account', account: own.username, state: 'read', messages: [] }
    return { outcome: 'applied', revision: (body as { revision: string }).revision, verificationRequired: false, spam: 'not-saved', mailboxes: 'not-saved', reloads: ['postfix'], reconcile: 'applied' }
  })
  const helpers: MailxWorkspaceHelpers = { store: state.store, requireCaller: async () => current, assertRoot: async who => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root required') },
    assertCanAccessAccount: async (who, target) => { if (who.principal.kind !== 'root' && (who.principal as { accountId?: string }).accountId !== target.id) fail('FORBIDDEN', 'denied') },
    emitAudit: async entry => { audits.push((entry as { action: string }).action) }, callHost, now: () => new Date('2026-11-07T10:00:00.000Z'),
    resolver: { resolveMx: async () => [], resolveTxt: async () => [], resolve4: async () => [], resolve6: async () => [], reverse: async () => [] } }
  const routes = createMailxWorkspaceRoutes(helpers)
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const request = new Request('http://localhost' + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    try { const response = await routes(request, new URL(request.url), method); return { status: response!.status, body: response!.status === 405 ? {} as Record<string, any> : await response!.json() as Record<string, any> } }
    catch (error) { if (isXpanelError(error)) return { status: 0, code: error.code, detail: error.detail as Record<string, unknown>, body: {} as Record<string, any> }; throw error }
  }
  return { state, own, other, call, callHost, audits, as: (who: 'owner' | 'root') => { current = who === 'owner' ? owner : root } }
}

describe('owner greylisting', () => {
  it('lists only the owner\'s domains and saves them', async () => {
    const f = await fixture()
    const view = await f.call('/api/account/mailx/greylisting')
    expect(view.body.domains).toEqual([{ domain: 'ownera.example.test', enabled: false }])
    const saved = await f.call('/api/account/mailx/greylisting', 'PUT', { domains: ['ownera.example.test'], expectedRevision: view.body.revision })
    expect(saved.body).toMatchObject({ stateChanged: true, domains: [{ domain: 'ownera.example.test', enabled: true }], state: 'pending' })
    expect(f.callHost).toHaveBeenCalledWith(expect.anything(), '/host/mailx/accounts/ownera/apply', expect.anything())
    expect(f.audits).toEqual(['mail.greylisting.saved'])
  })
  it('refuses another account\'s domain and a stale revision', async () => {
    const f = await fixture(), { body } = await f.call('/api/account/mailx/greylisting')
    expect(await f.call('/api/account/mailx/greylisting', 'PUT', { domains: ['ownerb.example.test'], expectedRevision: body.revision })).toMatchObject({ code: 'VALIDATION' })
    expect(await f.call('/api/account/mailx/greylisting', 'PUT', { domains: [], expectedRevision: 'f'.repeat(64) })).toMatchObject({ code: 'CONFLICT' })
  })
  it('keeps other accounts\' saved domains when an owner saves', async () => {
    const f = await fixture()
    f.as('root')
    const first = await f.call('/api/server/mailx/greylist')
    expect((await f.call('/api/server/mailx/greylist', 'PUT', { policy: { domains: ['ownerb.example.test'] }, expectedRevision: first.body.revision })).status).toBe(200)
    f.as('owner')
    const view = await f.call('/api/account/mailx/greylisting')
    await f.call('/api/account/mailx/greylisting', 'PUT', { domains: ['ownera.example.test'], expectedRevision: view.body.revision })
    expect((await readMailxSaved(f.state.store.rootDir)).sections.greylist?.policy.domains).toEqual(['ownera.example.test', 'ownerb.example.test'])
  })
})

describe('owner email routing', () => {
  it('detects the route once from the saved zone and records that it was automatic', async () => {
    const f = await fixture(), { body } = await f.call('/api/account/mailx/routing')
    expect(body.domains).toEqual([{ domain: 'ownera.example.test', mode: 'local', auto: false, detected: 'local', mx: [{ priority: 10, host: 'mail.ownera.example.test' }] }])
    const saved = await f.call('/api/account/mailx/routing', 'PUT', { domain: 'ownera.example.test', mode: 'auto', expectedRevision: body.revision })
    expect(saved.body.domains[0]).toMatchObject({ mode: 'local', auto: true })
  })
  it('stores remote and removes the row when set back to local', async () => {
    const f = await fixture(), first = await f.call('/api/account/mailx/routing')
    const remote = await f.call('/api/account/mailx/routing', 'PUT', { domain: 'ownera.example.test', mode: 'remote', expectedRevision: first.body.revision })
    expect(remote.body.domains[0]).toMatchObject({ mode: 'remote', auto: false })
    await f.call('/api/account/mailx/routing', 'PUT', { domain: 'ownera.example.test', mode: 'local', expectedRevision: remote.body.revision })
    expect((await readMailxSaved(f.state.store.rootDir)).sections.routing?.policy.domains).toEqual([])
  })
  it('refuses another account\'s domain, an unknown mode and auto without an MX', async () => {
    const f = await fixture(), { body } = await f.call('/api/account/mailx/routing')
    expect(await f.call('/api/account/mailx/routing', 'PUT', { domain: 'ownerb.example.test', mode: 'remote', expectedRevision: body.revision })).toMatchObject({ code: 'NOT_FOUND' })
    expect(await f.call('/api/account/mailx/routing', 'PUT', { domain: 'ownera.example.test', mode: 'elsewhere', expectedRevision: body.revision })).toMatchObject({ code: 'VALIDATION' })
    const zone = await f.state.store.getDnsZone('ownera.example.test')
    await f.state.store.saveDnsZone({ ...zone!, records: zone!.records.filter(record => record.type !== 'MX') })
    expect(await f.call('/api/account/mailx/routing', 'PUT', { domain: 'ownera.example.test', mode: 'auto', expectedRevision: body.revision })).toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'no_saved_mx' } })
  })
})

describe('owner deliverability and track delivery', () => {
  it('checks only the owner\'s domains', async () => {
    const f = await fixture()
    expect((await f.call('/api/account/mailx/deliverability')).body.domains.map((row: { domain: string }) => row.domain)).toEqual(['ownera.example.test'])
    expect((await f.call('/api/account/mailx/deliverability', 'POST', { domains: ['ownera.example.test'] })).body.results).toHaveLength(1)
    expect(await f.call('/api/account/mailx/deliverability', 'POST', { domains: ['ownerb.example.test'] })).toMatchObject({ code: 'VALIDATION' })
  })
  it('asks the agent for the session account only and verifies the reply scope', async () => {
    const f = await fixture()
    expect((await f.call('/api/account/mailx/track-delivery?recipient=a%40b.test&statuses=deferred')).body).toMatchObject({ scope: 'account', account: 'ownera' })
    expect(String(f.callHost.mock.calls.at(-1)![1])).toMatch(/^\/host\/mail\/log\/account\/ownera\?since=.*recipient=a%40b\.test&statuses=deferred$/)
    expect(await f.call('/api/account/mailx/track-delivery?account=ownerb')).toMatchObject({ code: 'VALIDATION' })
    f.callHost.mockImplementationOnce(async () => ({ scope: 'account', account: 'ownerb', state: 'read', messages: [] }))
    expect(await f.call('/api/account/mailx/track-delivery')).toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
})

describe('server sections', () => {
  it('refuses 0 child processes before anything is saved', async () => {
    const f = await fixture(); f.as('root')
    const { body } = await f.call('/api/server/mailx/spamd')
    expect(body.policy).toMatchObject({ children: 1, maxConnPerChild: 200 })
    expect(await f.call('/api/server/mailx/spamd', 'PUT', { policy: { ...body.policy, children: 0 }, expectedRevision: body.revision })).toMatchObject({ code: 'VALIDATION', detail: { field: 'children' } })
  })
  it('keeps the country filter refused while no database is installed, and allows an empty list', async () => {
    const f = await fixture(); f.as('root')
    const { body } = await f.call('/api/server/mailx/country')
    expect(body.geoip).toEqual({ installed: false, month: null })
    expect(await f.call('/api/server/mailx/country', 'PUT', { policy: { blocked: ['RU'] }, expectedRevision: body.revision })).toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'geoip_unavailable', stateChanged: false } })
    expect((await f.call('/api/server/mailx/country', 'PUT', { policy: { blocked: [] }, expectedRevision: body.revision })).status).toBe(200)
  })
  it('saves a blocked country once the database is installed', async () => {
    const f = await fixture({ geoip: true }); f.as('root')
    const { body } = await f.call('/api/server/mailx/country')
    expect((await f.call('/api/server/mailx/country', 'PUT', { policy: { blocked: ['RU'] }, expectedRevision: body.revision })).body).toMatchObject({ geoip: { installed: true, month: '2026-11' } })
  })
  it('hands a removed advanced option back to the Postfix default', async () => {
    const f = await fixture(); f.as('root')
    const first = await f.call('/api/server/mailx/advanced')
    const saved = await f.call('/api/server/mailx/advanced', 'PUT', { policy: { postfix: { smtp_connect_timeout: '10s' } }, expectedRevision: first.body.revision })
    await f.call('/api/server/mailx/advanced', 'PUT', { policy: { postfix: {} }, expectedRevision: saved.body.revision })
    expect(f.callHost.mock.calls.at(-2)![2]).toMatchObject({ unset: ['smtp_connect_timeout'] })
  })
  it('reports why the host refused an apply', async () => {
    const f = await fixture(); f.as('root')
    const { body } = await f.call('/api/server/mailx/advanced')
    f.callHost.mockImplementationOnce(async () => fail('PRECONDITION_FAILED', 'refused', { stateChanged: false, reason: 'unknown_postfix_parameter' }))
    const saved = await f.call('/api/server/mailx/advanced', 'PUT', { policy: { postfix: { smtp_made_up: '1' } }, expectedRevision: body.revision })
    expect(saved.body.application).toMatchObject({ outcome: 'refused', reason: 'unknown_postfix_parameter' })
  })
  it('accepts a host status with the database fields and refuses a malformed month', () => {
    expect(projectMailxHostStatus(hostStatus(true)).geoip).toEqual({ installed: true, month: '2026-11' })
    expect(() => projectMailxHostStatus({ ...hostStatus(true), geoip: { installed: true, month: 'soon' } })).toThrow()
    expect(mailxRevision('greylist', null)).toMatch(/^[0-9a-f]{64}$/)
  })
})
