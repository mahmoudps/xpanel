import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as dbApi from '@xpanel/db'
import { accountContactRevision } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import type { AgentApp } from '@xpanel/agent'
import { deriveCsrfToken, sha256Hex } from './auth.ts'
import { policyForRequest } from './authorization.ts'
import { entryPointAllowsApiRoute, sessionCookieName, sessionTokenHash } from './entry-points.ts'
import { createApiApp } from './server.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const endpoint = '/api/account/preferences'
const changedEmail = 'Case+contact@example.test'
const cleanup: Array<() => Promise<unknown>> = []
interface ContactView { context: { accountId: string }; preferences: { contactEmail: string }; revision: string }

const fixture = async () => {
  const database = await dbApi.createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Contact metadata policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Contact metadata plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 4, aliasDomains: 4, subdomains: 4, mailboxes: 4, forwarders: 4, mailingLists: 4, ftpAccounts: 4, databases: 4, phpWorkers: 4 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.64', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = async (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: username + '.example.test', planId: plan.id, ownerId: null,
    contactEmail: 'owner@' + username + '.example.test', ipv4: '192.0.2.64', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  // This valid hosting username also exercises audit attribution's mailbox-like prefix.
  const owner = await account('mbxdeadbeef'), other = await account('contactother')
  const principal = await dbApi.createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  const neighbor = await dbApi.createUserPrincipal(database.db, { username: other.username, accountId: other.id, passwordHash: HASH })
  const mailbox = await state.store.createServiceUser({ accountId: owner.id, login: 'inbox@' + owner.primaryDomain, passwordHash: HASH,
    services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  await dbApi.syncAccountContactIndex(database.db, owner)
  await dbApi.syncAccountContactIndex(database.db, other)
  const token = async (scopes: string[], principalId = principal.id) => {
    const raw = 'xp_' + randomUUID()
    await dbApi.createApiToken(database.db, { principalId, name: 'Synthetic contact metadata', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const credential = await token(['account-preferences:read', 'account-preferences:write'])
  let agentCalls = 0
  const agent: AgentApp = { subscribe: () => () => {}, fetch: async () => { agentCalls++; return Response.json({ error: 'unexpected_synthetic_agent_call' }, { status: 503 }) } }
  const makeApp = (attachAgent = true) => createApiApp({ db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET,
    ...(attachAgent ? { agentApp: agent, agentToken: TEST_AGENT_TOKEN } : {}) })
  const app = makeApp()
  const request = (method = 'GET', body?: unknown, options: { token?: string | null; path?: string; headers?: Record<string, string>; application?: ReturnType<typeof createApiApp>; rawBody?: string } = {}) => {
    const payload = options.rawBody ?? (body === undefined ? undefined : JSON.stringify(body))
    return (options.application ?? app).fetch(new Request('http://localhost' + (options.path ?? endpoint), { method,
      headers: { ...(options.token === null ? {} : { authorization: 'Bearer ' + (options.token ?? credential) }), ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
      ...(payload === undefined ? {} : { body: payload }) }))
  }
  const view = async (options?: Parameters<typeof request>[2]): Promise<ContactView> => {
    const response = await request('GET', undefined, options)
    expect(response.status).toBe(200)
    return await response.json() as ContactView
  }
  const images = async () => ({
    accounts: (await state.store.readSnapshot()).accounts,
    index: await database.db.query('SELECT * FROM idx_accounts ORDER BY id'),
    search: await database.db.query('SELECT CAST(rowid AS TEXT) AS saved_rowid, kind, entity_id, account_id, owner_id, title, subtitle, keywords FROM search_fts ORDER BY rowid'),
  })
  return { database, state, features, plan, owner, other, principal, neighbor, mailbox, token, credential, app, makeApp, request, view, images, agentCalls: () => agentCalls }
}

describe('contact preferences route admission', () => {
  it.each(['GET', 'PATCH'])('uses its dedicated policy and xPanel admission for %s', method => {
    expect(policyForRequest(endpoint, method)).toMatchObject({ resource: 'account-preferences', toolIds: ['account-preferences'] })
    expect(entryPointAllowsApiRoute('xpanel', endpoint, method)).toBe(true)
    expect(entryPointAllowsApiRoute('xwhm', endpoint, method)).toBe(false)
    expect(entryPointAllowsApiRoute('xmail', endpoint, method)).toBe(false)
  })
  it.each(['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'])('does not admit unsupported %s through xPanel', method => {
    expect(entryPointAllowsApiRoute('xpanel', endpoint, method)).toBe(false)
  })
  it.each(['/api/account', '/api/account/preferences/extra', '/api/account/other'])('does not open a singular account route family: %s', path => {
    for (const method of ['GET', 'PATCH']) expect(entryPointAllowsApiRoute('xpanel', path, method)).toBe(false)
  })
})

describe('trusted-self contact metadata API with real synthetic SQLite', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    vi.restoreAllMocks()
    const failures: unknown[] = []
    for (const close of cleanup.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
    if (failures.length) throw new AggregateError(failures, 'Synthetic contact fixture cleanup failed')
  })
  const unchanged = async (before: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['images']>>) => {
    expect(await f.images()).toEqual(before)
    expect(f.agentCalls()).toBe(0)
  }

  it.each(['absent', 'attached'] as const)('reads and saves canonical metadata, index, search and audit with agent %s', async mode => {
    const application = f.makeApp(mode === 'attached')
    const before = (await f.state.store.getAccount(f.owner.id))!
    const neighbor = (await f.state.store.getAccount(f.other.id))!
    const beforeImages = await f.images()
    const initial = await f.view({ application })
    expect(initial).toEqual({ context: { accountId: f.owner.id }, preferences: { contactEmail: before.contactEmail }, revision: accountContactRevision(before) })
    const response = await f.request('PATCH', { contactEmail: 'Case+contact@EXAMPLE.TEST', expectedRevision: initial.revision }, { application })
    expect(response.status).toBe(200)
    const saved = await response.json() as ContactView & { ok: boolean; stateChanged: boolean }
    const current = (await f.state.store.getAccount(f.owner.id))!
    expect(current).toEqual({ ...before, contactEmail: changedEmail })
    expect(saved).toEqual({ ok: true, stateChanged: true, context: { accountId: f.owner.id }, preferences: { contactEmail: changedEmail }, revision: accountContactRevision(current) })
    expect(await f.view({ application })).toEqual({ context: saved.context, preferences: saved.preferences, revision: saved.revision })
    expect(await f.state.store.getAccount(f.other.id)).toEqual(neighbor)
    const afterImages = await f.images()
    expect(afterImages.index.filter(row => row.id === f.other.id)).toEqual(beforeImages.index.filter(row => row.id === f.other.id))
    expect(afterImages.search.filter(row => row.entity_id === f.other.id)).toEqual(beforeImages.search.filter(row => row.entity_id === f.other.id))
    expect((await f.database.db.query<{ contact_email: string }>('SELECT contact_email FROM idx_accounts WHERE id = $1', [f.owner.id]))[0]?.contact_email).toBe(changedEmail)
    const search = await f.database.db.query<{ keywords: string }>("SELECT keywords FROM search_fts WHERE kind = 'account' AND entity_id = $1", [f.owner.id])
    expect(search).toHaveLength(1)
    expect(search[0]!.keywords).toContain(changedEmail)
    expect(search[0]!.keywords).not.toContain(before.contactEmail)
    expect(await dbApi.findPrincipalByUsername(f.database.db, f.owner.username)).toMatchObject({ id: f.principal.id, accountId: f.owner.id, passwordHash: HASH })
    const audits = await dbApi.listAudit(f.database.db)
    expect(audits.filter(row => row.action === 'account.contact.updated')).toHaveLength(1)
    const audit = audits.find(row => row.action === 'account.contact.updated')!
    expect(audit).toMatchObject({ actor: 'Unavailable mailbox', target: 'account:Unavailable mailbox', outcome: 'ok' })
    expect(await f.database.db.query<{ principal_id: string | null }>('SELECT principal_id FROM audit_log WHERE id=$1', [audit.id])).toEqual([{ principal_id: f.principal.id }])
    expect(f.agentCalls()).toBe(0)
  })

  it('takes the account only from the authenticated principal despite hostile identity headers', async () => {
    const owner = await f.view({ headers: { 'x-account-id': f.other.id, 'x-xpanel-account-id': f.other.id, 'x-xpanel-principal-id': f.neighbor.id, 'x-role': 'root' } })
    expect(owner.context.accountId).toBe(f.owner.id)
    const raw = await f.token(['account-preferences:read'], f.neighbor.id)
    const other = await f.view({ token: raw, headers: { 'x-account-id': f.owner.id } })
    expect(other.context.accountId).toBe(f.other.id)
    expect(other.preferences.contactEmail).toBe(f.other.contactEmail)
  })

  it('requires authentication before exposing contact data', async () => {
    const before = await f.images()
    expect((await f.request('GET', undefined, { token: null })).status).toBe(401)
    await unchanged(before)
  })

  it('allows read-only contact tokens to read but never mutate', async () => {
    const raw = await f.token(['account-preferences:read'])
    const current = await f.view({ token: raw }), before = await f.images()
    expect((await f.request('PATCH', { contactEmail: changedEmail, expectedRevision: current.revision }, { token: raw })).status).toBe(403)
    await unchanged(before)
  })

  it.each([{ scopes: ['accounts:read', 'accounts:write'] }, { scopes: ['files:read', 'files:write'] }, { scopes: [] as string[] }])('denies unrelated or empty token scopes $scopes', async ({ scopes }) => {
    const current = await f.view(), before = await f.images(), raw = await f.token(scopes)
    expect((await f.request('GET', undefined, { token: raw })).status).toBe(403)
    expect((await f.request('PATCH', { contactEmail: changedEmail, expectedRevision: current.revision }, { token: raw })).status).toBe(403)
    await unchanged(before)
  })

  it('excludes a mailbox-bound token from hosting preferences', async () => {
    const current = await f.view(), before = await f.images()
    const raw = await f.token(['mailbox:' + f.mailbox.id, 'account-preferences:read', 'account-preferences:write'])
    expect((await f.request('GET', undefined, { token: raw })).status).toBe(403)
    expect((await f.request('PATCH', { contactEmail: changedEmail, expectedRevision: current.revision }, { token: raw })).status).toBe(403)
    await unchanged(before)
  })

  it('keeps root out of the trusted-self endpoint even with matching token scopes', async () => {
    const root = await dbApi.createRootPrincipal(f.database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
    const raw = await f.token(['account-preferences:read', 'account-preferences:write'], root.id), before = await f.images()
    expect((await f.request('GET', undefined, { token: raw })).status).toBe(403)
    expect((await f.request('PATCH', { contactEmail: changedEmail, expectedRevision: '0'.repeat(64) }, { token: raw })).status).toBe(403)
    await unchanged(before)
  })

  it('keeps a reseller out of the trusted-self endpoint for an account it owns', async () => {
    const reseller = await f.state.store.createReseller({ username: 'contactseller', passwordHash: HASH, acl: ['list-accounts', 'edit-account'], maxAccounts: 5,
      totalDiskMb: 10000, totalBandwidthMb: 'unlimited', oversell: false, nameservers: [], delegatedIps: [] })
    await f.state.store.changeOwner(f.owner.id, reseller.id)
    const principal = await dbApi.createResellerPrincipal(f.database.db, { id: reseller.id, username: reseller.username, passwordHash: HASH })
    const raw = await f.token(['account-preferences:read', 'account-preferences:write'], principal.id), before = await f.images()
    expect((await f.request('GET', undefined, { token: raw })).status).toBe(403)
    expect((await f.request('PATCH', { contactEmail: changedEmail, expectedRevision: '0'.repeat(64) }, { token: raw })).status).toBe(403)
    await unchanged(before)
  })

  it.each(['feature', 'status'] as const)('rechecks current account %s before a later request', async kind => {
    const current = await f.view()
    if (kind === 'feature') await f.state.store.updateFeatureList(f.features.id, { disabled: ['account-preferences'] })
    else await f.state.store.suspendAccount(f.owner.id, 'Synthetic contact hold')
    const before = await f.images()
    expect((await f.request('GET')).status).toBe(403)
    expect((await f.request('PATCH', { contactEmail: changedEmail, expectedRevision: current.revision })).status).toBe(403)
    await unchanged(before)
  })

  it('rechecks principal revocation after initial authentication before the metadata writer runs', async () => {
    const current = await f.view()
    const before = await f.images()
    const update = f.state.store.updateAccountContactEmail.bind(f.state.store)
    const mutation = vi.spyOn(f.state.store, 'updateAccountContactEmail').mockImplementationOnce(async (...args: Parameters<typeof update>) => {
      await dbApi.deletePrincipal(f.database.db, f.principal.id)
      return update(...args)
    })
    expect((await f.request('PATCH', { contactEmail: changedEmail, expectedRevision: current.revision })).status).toBe(401)
    expect(mutation).toHaveBeenCalledTimes(1)
    await unchanged(before)
  })

  it.each(['accountId=foreign', 'contactEmail=foreign%40example.test', 'ignored=1&ignored=2'])('rejects all query selectors without effects: %s', async query => {
    const current = await f.view(), before = await f.images()
    for (const method of ['GET', 'PATCH']) {
      const response = await f.request(method, method === 'PATCH' ? { contactEmail: changedEmail, expectedRevision: current.revision } : undefined, { path: endpoint + '?' + query })
      expect(response.status).toBe(422)
    }
    await unchanged(before)
  })

  const invalidBodies: Array<[string, (revision: string) => unknown]> = [
    ['null', () => null], ['array', () => []], ['string', () => 'contact'], ['number', () => 1],
    ['missing email', revision => ({ expectedRevision: revision })], ['missing revision', () => ({ contactEmail: changedEmail })],
    ['email number', revision => ({ contactEmail: 7, expectedRevision: revision })], ['email null', revision => ({ contactEmail: null, expectedRevision: revision })],
    ['empty email', revision => ({ contactEmail: '', expectedRevision: revision })], ['missing at', revision => ({ contactEmail: 'not-an-address', expectedRevision: revision })],
    ['leading whitespace', revision => ({ contactEmail: ' owner@example.test', expectedRevision: revision })],
    ['doubled local dots', revision => ({ contactEmail: 'a..b@example.test', expectedRevision: revision })],
    ['local part too long', revision => ({ contactEmail: 'a'.repeat(65) + '@example.test', expectedRevision: revision })],
    ['local control', revision => ({ contactEmail: 'owner\u0000@example.test', expectedRevision: revision })],
    ['unpaired surrogate', revision => ({ contactEmail: '\ud800@example.test', expectedRevision: revision })],
  ]
  it.each(invalidBodies)('refuses malformed contact payload %s before mutation', async (_name, make) => {
    const current = await f.view(), before = await f.images()
    expect((await f.request('PATCH', make(current.revision))).status).toBe(422)
    await unchanged(before)
  })

  it.each(['accountId', 'username', 'ownerId', 'planId', 'status', 'ipv4', 'shell', 'revision', '__proto__'])('rejects the extra field %s rather than broadening account edits', async key => {
    const current = await f.view(), before = await f.images()
    const body = Object.fromEntries([['contactEmail', changedEmail], ['expectedRevision', current.revision], [key, 'untrusted']])
    expect((await f.request('PATCH', body)).status).toBe(422)
    await unchanged(before)
  })

  it.each([null, 1, true, {}, [], '0'.repeat(63), '0'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), '0'.repeat(64) + '\n'].map(revision => ({ revision })))('requires an exact lowercase 64-hex revision: $revision', async ({ revision }) => {
    const before = await f.images()
    expect((await f.request('PATCH', { contactEmail: changedEmail, expectedRevision: revision })).status).toBe(422)
    await unchanged(before)
  })

  it('rejects malformed JSON and an absent PATCH body without mutation', async () => {
    const before = await f.images()
    expect((await f.request('PATCH', undefined, { rawBody: '{' })).status).toBe(422)
    expect((await f.request('PATCH')).status).toBe(422)
    await unchanged(before)
  })

  it('refuses a stale representation without changing account, index or search rows', async () => {
    const initial = await f.view()
    expect((await f.request('PATCH', { contactEmail: 'first@example.test', expectedRevision: initial.revision })).status).toBe(200)
    const before = await f.images()
    expect((await f.request('PATCH', { contactEmail: 'stale@example.test', expectedRevision: initial.revision })).status).toBe(409)
    await unchanged(before)
  })

  it('does not couple a contact revision to unrelated account changes', async () => {
    const initial = await f.view()
    const other = await f.state.store.updateAccount(f.other.id, { contactEmail: 'neighbor-changed@example.test' })
    await dbApi.syncAccountContactIndex(f.database.db, other)
    expect((await f.request('PATCH', { contactEmail: changedEmail, expectedRevision: initial.revision })).status).toBe(200)
    expect((await f.state.store.getAccount(f.other.id))!.contactEmail).toBe(other.contactEmail)
    expect(f.agentCalls()).toBe(0)
  })

  it('intentionally accepts an identical current representation after A to B to A', async () => {
    const initial = await f.view()
    expect((await f.request('PATCH', { contactEmail: 'temporary@example.test', expectedRevision: initial.revision })).status).toBe(200)
    const temporary = await f.view()
    expect((await f.request('PATCH', { contactEmail: initial.preferences.contactEmail, expectedRevision: temporary.revision })).status).toBe(200)
    expect((await f.view()).revision).toBe(initial.revision)
    expect((await f.request('PATCH', { contactEmail: changedEmail, expectedRevision: initial.revision })).status).toBe(200)
    expect(f.agentCalls()).toBe(0)
  })

  it('keeps the old administrative account PATCH denied to the owner', async () => {
    const raw = await f.token(['accounts:write']), before = await f.images()
    expect((await f.request('PATCH', { contactEmail: changedEmail }, { token: raw, path: '/api/accounts/' + f.owner.id })).status).toBe(403)
    await unchanged(before)
  })

  it('preserves root contact-only administration without an owner revision field or agent call', async () => {
    const root = await dbApi.createRootPrincipal(f.database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
    const raw = await f.token(['accounts:write'], root.id)
    const response = await f.request('PATCH', { contactEmail: 'Admin+contact@EXAMPLE.TEST' }, { token: raw, path: '/api/accounts/' + f.owner.id })
    expect(response.status).toBe(200)
    expect((await f.state.store.getAccount(f.owner.id))!.contactEmail).toBe('Admin+contact@example.test')
    expect((await f.database.db.query<{ contact_email: string }>('SELECT contact_email FROM idx_accounts WHERE id=$1', [f.owner.id]))[0]?.contact_email).toBe('Admin+contact@example.test')
    expect(f.agentCalls()).toBe(0)
  })

  it.each(['present', 'absent'] as const)('restores the exact %s SQL preimage after a committed partial index update fails', async initialIndex => {
    if (initialIndex === 'absent') {
      await f.database.db.query("DELETE FROM search_fts WHERE kind='account' AND entity_id=$1", [f.owner.id])
      await f.database.db.query('DELETE FROM idx_accounts WHERE id=$1', [f.owner.id])
    }
    const current = await f.view(), before = await f.images(), original = dbApi.syncAccountContactIndex
    vi.spyOn(dbApi, 'syncAccountContactIndex').mockImplementationOnce(async (...args: Parameters<typeof original>) => { await original(...args); throw new Error('Synthetic post-index outage') })
    const response = await f.request('PATCH', { contactEmail: changedEmail, expectedRevision: current.revision })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ details: { reason: 'contact_index_failed', verificationRequired: true, stateChanged: false } })
    await unchanged(before)
    expect((await dbApi.listAudit(f.database.db)).some(row => row.action === 'account.contact.updated' && row.outcome === 'ok')).toBe(false)
  })

  it('preserves legacy administrator index-failure safety through the guarded metadata method', async () => {
    const root = await dbApi.createRootPrincipal(f.database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
    const raw = await f.token(['accounts:write'], root.id), before = await f.images(), original = dbApi.syncAccountContactIndex
    vi.spyOn(dbApi, 'syncAccountContactIndex').mockImplementationOnce(async (...args: Parameters<typeof original>) => { await original(...args); throw new Error('Synthetic administrator index outage') })
    const response = await f.request('PATCH', { contactEmail: changedEmail }, { token: raw, path: '/api/accounts/' + f.owner.id })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ details: { reason: 'contact_index_failed', verificationRequired: true, stateChanged: false } })
    await unchanged(before)
  })

  it('reports a post-commit audit failure as changed and unverified', async () => {
    const current = await f.view()
    vi.spyOn(dbApi, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic contact audit outage'))
    const response = await f.request('PATCH', { contactEmail: changedEmail, expectedRevision: current.revision })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ details: { reason: 'contact_audit_failed', stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    expect((await f.state.store.getAccount(f.owner.id))!.contactEmail).toBe(changedEmail)
    expect((await f.database.db.query<{ contact_email: string }>('SELECT contact_email FROM idx_accounts WHERE id=$1', [f.owner.id]))[0]?.contact_email).toBe(changedEmail)
    expect(f.agentCalls()).toBe(0)
  })

  it.each(['origin', 'csrf'] as const)('defers fresh cookie %s denial audit until after releasing the writer lease', async kind => {
    const current = await f.view(), before = await f.images()
    const origin = 'https://panel.example.test:2083', raw = 'contact-session-' + randomUUID()
    await dbApi.createSession(f.database.db, { principalId: f.principal.id, tokenHash: sessionTokenHash(raw, 'xpanel'), expiresAt: new Date(Date.now() + 60000).toISOString(), mfaVerified: true })
    const application = createApiApp({ db: f.database.db, store: f.state.store, serverSecret: TEST_SERVER_SECRET, entryPoint: 'xpanel', publicOrigin: origin, allowedOrigins: [origin], secureCookies: true, requireOriginHeader: true })
    const request = new Request(origin + endpoint, { method: 'PATCH', headers: { origin, cookie: sessionCookieName('xpanel', true) + '=' + raw,
      'x-csrf-token': deriveCsrfToken(raw, TEST_SERVER_SECRET, 'xpanel'), 'content-type': 'application/json' }, body: JSON.stringify({ contactEmail: changedEmail, expectedRevision: current.revision }) })
    const update = f.state.store.updateAccountContactEmail.bind(f.state.store)
    const mutation = vi.spyOn(f.state.store, 'updateAccountContactEmail').mockImplementationOnce((...args: Parameters<typeof update>) => {
      request.headers.set(kind === 'origin' ? 'origin' : 'x-csrf-token', kind === 'origin' ? 'https://hostile.example.test' : 'synthetic-invalid-csrf')
      return update(...args)
    })
    const action = kind === 'origin' ? 'auth.origin_rejected' : 'auth.csrf_rejected'
    const append = dbApi.appendAudit
    let auditedAfterRelease = false
    vi.spyOn(dbApi, 'appendAudit').mockImplementation(async (...args: Parameters<typeof append>) => {
      if (args[1].action === action) {
        // A snapshot here deadlocks if denial auditing still holds the writer lease.
        const snapshot = await f.state.store.readSnapshot()
        expect(snapshot.accounts.find(account => account.id === f.owner.id)?.contactEmail).toBe(f.owner.contactEmail)
        auditedAfterRelease = true
      }
      return append(...args)
    })
    const response = await application.fetch(request)
    expect(response.status).toBe(403)
    expect(mutation).toHaveBeenCalledTimes(1)
    expect(auditedAfterRelease).toBe(true)
    expect((await dbApi.listAudit(f.database.db)).filter(row => row.action === action)).toHaveLength(1)
    await unchanged(before)
  })
})
