import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { createApiToken, createRootPrincipal, createTestDb, createUserPrincipal } from '@xpanel/db'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import { authenticateRequest, sha256Hex } from './auth.ts'
import { assertAccountAuthorized, assertRequestAuthorized, isMailboxPrincipal } from './authorization.ts'
import { ExtendedFeaturesStore, type WebmailCalendar, type WebmailContact } from './extended-routes.ts'
import { createCalendarWorkspaceRoutes } from './mail/calendar-workspace.ts'
import { parseCalendarWorkspaceIcs, renderCalendarWorkspaceIcs } from './mail/calendar-ics.ts'
import { createAccountCollaborationRoutes, type AccountCollaborationHelpers } from './account-collaboration-workspace.ts'
import { TEST_SERVER_SECRET } from './testing.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const fixture = async () => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const feature = await state.store.createFeatureList({ name: 'Collaboration fixtures', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Collaboration fixtures', ownerId: null, featureListId: feature.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 5, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.29', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const makeAccount = (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null, contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.29', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const own = await makeAccount('collabown'), other = await makeAccount('collabother')
  const makeMailbox = (accountId: string, login: string) => state.store.createServiceUser({ accountId, login, passwordHash: HASH, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const inbox = await makeMailbox(own.id, 'inbox@' + own.primaryDomain), sibling = await makeMailbox(own.id, 'sibling@' + own.primaryDomain), foreign = await makeMailbox(other.id, 'foreign@' + other.primaryDomain)
  const authority = (service = inbox) => ({ accountId: service.accountId, serviceUserId: service.id, mailbox: service.login })
  const calendar = (service = inbox, name = 'Work'): WebmailCalendar => ({ id: randomUUID(), owner: service.login, ownerAuthority: authority(service), name, color: '#4f6bed', timezone: 'UTC', events: [], shares: [], createdAt: '2026-10-27T00:00:00Z' })
  const ownCalendar = calendar(), siblingCalendar = calendar(sibling, 'Sibling'), foreignCalendar = calendar(foreign, 'Foreign secret')
  ownCalendar.shares = [{ principal: sibling.login, granteeAuthority: authority(sibling), permission: 'read', sharedAt: '2026-10-27T00:00:00Z' }, { principal: foreign.login, granteeAuthority: authority(foreign), permission: 'read-write', sharedAt: '2026-10-27T00:00:00Z' }]
  const legacy = { ...calendar(), ownerAuthority: undefined, name: 'Legacy secret' }, oldLifetime = { ...calendar(), ownerAuthority: { ...authority(), serviceUserId: randomUUID() }, name: 'Old lifetime secret' }
  const contact: WebmailContact = { id: randomUUID(), owner: inbox.login, ownerAuthority: authority(), fullName: 'Contact private details', email: 'private@example.test', phone: '', organization: '', title: '', groups: ['Team'], shares: [], vcard: 'BEGIN:VCARD\r\nEND:VCARD', createdAt: '2026-10-27T00:00:00Z' }
  const ext = new ExtendedFeaturesStore(state.rootDir)
  await ext.write('webmail/calendars.json', [ownCalendar, siblingCalendar, foreignCalendar, legacy, oldLifetime]); await ext.write('webmail/contacts.json', [contact, { ...contact, id: randomUUID(), ownerAuthority: undefined }, { ...contact, id: randomUUID(), owner: foreign.login, ownerAuthority: authority(foreign) }])
  const principal = await createUserPrincipal(database.db, { username: own.username, accountId: own.id, passwordHash: HASH }), root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  const token = async (principalId: string, scopes: string[]) => { const raw = 'xp_' + randomUUID(); await createApiToken(database.db, { principalId, name: 'Synthetic collaboration', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() }); return raw }
  const ownerToken = await token(principal.id, ['webmail:read', 'webmail:write']), sealedToken = await token(principal.id, ['webmail:read', 'webmail:write', 'mailbox:' + inbox.id]), rootToken = await token(root.id, ['*'])
  const requireCaller: AccountCollaborationHelpers['requireCaller'] = async req => { const caller = await authenticateRequest(database.db, req, { serverSecret: TEST_SERVER_SECRET }); if (!caller) return fail('UNAUTHENTICATED', 'authentication required'); await assertRequestAuthorized(state.store, caller, req); return caller }
  const shared = { store: state.store, requireCaller, assertCanAccessAccount: (caller: Parameters<typeof assertAccountAuthorized>[1], account: typeof own, action: string) => assertAccountAuthorized(state.store, caller, account, action), emitAudit: vi.fn(async () => {}) }
  const readCalendars = () => ext.readOrDefault<WebmailCalendar[]>('webmail/calendars.json', [])
  const nativeRoute = createCalendarWorkspaceRoutes({ helpers: shared, readRecords: readCalendars, publishRecords: (records, lease) => atomicWriteJson(join(ext.baseDir, 'webmail', 'calendars.json'), records, 0o640, () => lease.assertFencingToken()), parseIcs: parseCalendarWorkspaceIcs, renderIcs: renderCalendarWorkspaceIcs })
  const helpers: AccountCollaborationHelpers = { ...shared, serverSecret: TEST_SERVER_SECRET, readCalendars, readContacts: () => ext.readOrDefault<WebmailContact[]>('webmail/contacts.json', []), calendarRoute: vi.fn(async (req, url, method) => { expect(new URL(req.url).pathname).toMatch(/^\/api\/account\/collaboration\/calendars(?:\/[0-9a-f]{32})?$/); expect(isMailboxPrincipal((await authenticateRequest(database.db, req, { serverSecret: TEST_SERVER_SECRET }))!)).toBe(false); return nativeRoute(req, url, method) }) }
  const route = createAccountCollaborationRoutes(helpers)
  const request = (method = 'GET', body?: unknown, bearer = ownerToken, path = '/api/account/collaboration') => { const url = new URL('http://localhost' + path); return route(new Request(url, { method, headers: { authorization: 'Bearer ' + bearer, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, method) }
  const view = async () => await (await request())!.json() as { context: { account: string }; mailboxes: Array<{ mailbox: string; revision: string; calendars: Array<{ name: string; shares: Array<{ mailbox: string; permission: string }> }>; contacts: { count: number; groupCount: number } }> }
  const createBody = async (name = 'Created') => ({ mailbox: inbox.login, expectedRevision: (await view()).mailboxes.find(item => item.mailbox === inbox.login)!.revision, name, color: '#4f6bed', timezone: 'UTC' })
  return { database, state, helpers, ext, own, inbox, sibling, foreign, ownCalendar, calendar, readCalendars, request, view, createBody, ownerToken, sealedToken, rootToken, feature, principal }
}

describe('account collaboration using actual authority and existing calendar writer', () => {
  it('edits and deletes an owned calendar by its public id through the existing writer and reads it back', async () => {
    const f = await fixture(), before = await f.view() as unknown as { mailboxes: Array<{ mailbox: string; revision: string; calendars: Array<{ id: string; name: string }> }> }
    const inbox = before.mailboxes.find(item => item.mailbox === f.inbox.login)!, publicId = inbox.calendars[0]!.id
    expect(publicId).toMatch(/^[0-9a-f]{32}$/); expect(publicId).not.toContain(f.ownCalendar.id.slice(0, 8))
    const path = '/api/account/collaboration/calendars/' + publicId
    // The shared policy row for /calendars/{publicId} is integrated by ROOT; until then authorize under the same calendars family.
    const family = (req: Request) => new Request(new URL('/api/account/collaboration/calendars', req.url), { method: req.method, headers: req.headers, ...(req.body ? { body: req.body, duplex: 'half' } : {}) } as RequestInit)
    const route = createAccountCollaborationRoutes({ ...f.helpers, requireCaller: (req, options) => f.helpers.requireCaller(new Request(new URL('/api/account/collaboration/calendars', req.url), { method: req.method, headers: req.headers }), options), calendarRoute: (req, url, method) => f.helpers.calendarRoute(family(req), url, method) })
    const request = (method: string, body: unknown, _token: string, target: string) => { const url = new URL('http://localhost' + target); return route(new Request(url, { method, headers: { authorization: 'Bearer ' + f.ownerToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, method) }
    const edited = await request('PATCH', { mailbox: f.inbox.login, name: 'Renamed', color: '#112233', timezone: 'Europe/Berlin', expectedRevision: inbox.revision }, f.ownerToken, path)
    expect(await edited!.json()).toMatchObject({ stateChanged: true, updated: { mailbox: f.inbox.login, id: publicId, name: 'Renamed', color: '#112233', timezone: 'Europe/Berlin' } })
    expect((await f.readCalendars()).find(calendar => calendar.id === f.ownCalendar.id)).toMatchObject({ name: 'Renamed', color: '#112233' })
    await expect(request('DELETE', { mailbox: f.inbox.login, expectedRevision: inbox.revision }, f.ownerToken, path)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(request('DELETE', { mailbox: f.sibling.login, expectedRevision: (await f.view()).mailboxes.find(item => item.mailbox === f.sibling.login)!.revision }, f.ownerToken, path)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const current = (await f.view()).mailboxes.find(item => item.mailbox === f.inbox.login)!
    const deleted = await request('DELETE', { mailbox: f.inbox.login, expectedRevision: current.revision }, f.ownerToken, path)
    expect(await deleted!.json()).toMatchObject({ stateChanged: true, deleted: { mailbox: f.inbox.login, id: publicId } })
    expect((await f.readCalendars()).some(calendar => calendar.id === f.ownCalendar.id)).toBe(false)
    await expect(request('PATCH', { mailbox: f.inbox.login, name: 'X', color: '#112233', timezone: 'UTC', expectedRevision: current.revision, extra: 1 }, f.ownerToken, path)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('returns only current owned metadata and effective same-account sharing, without content or internal identities', async () => {
    const f = await fixture(), current = await f.view(), text = JSON.stringify(current)
    expect(current.context.account).toBe(f.own.username); expect(current.mailboxes).toHaveLength(2)
    const inbox = current.mailboxes.find(item => item.mailbox === f.inbox.login)!
    expect(inbox.contacts).toEqual({ count: 1, groupCount: 1 }); expect(inbox.calendars.map(item => item.name)).toEqual(['Work'])
    expect(inbox.calendars[0]!.shares).toEqual([{ mailbox: f.sibling.login, permission: 'read' }])
    for (const secret of [f.foreign.login, 'Foreign secret', 'Legacy secret', 'Old lifetime secret', 'Contact private details', 'private@example.test', f.own.id, f.inbox.id, f.ownCalendar.id, 'ownerAuthority', 'granteeAuthority']) expect(text).not.toContain(secret)
  })
  it('creates through the real guarded handler as the original account actor and verifies canonical readback', async () => {
    const f = await fixture(), response = await f.request('POST', await f.createBody(), f.ownerToken, '/api/account/collaboration/calendars')
    expect(response!.status).toBe(201); expect(await response!.json()).toMatchObject({ stateChanged: true, created: { mailbox: f.inbox.login, name: 'Created' }, application: { syncVerified: false, nativeApplied: false } })
    const created = (await f.readCalendars()).find(calendar => calendar.name === 'Created')!
    expect(created.ownerAuthority).toEqual({ accountId: f.own.id, serviceUserId: f.inbox.id, mailbox: f.inbox.login }); expect(f.helpers.calendarRoute).toHaveBeenCalledOnce()
  })
  it.each(['root', 'sealed'])('refuses %s identity without granting account portal access', async kind => {
    const f = await fixture(); await expect(f.request('GET', undefined, kind === 'root' ? f.rootToken : f.sealedToken)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('rejects foreign mailbox creation and account/path/URL selector injection before dispatch', async () => {
    const f = await fixture(), body = await f.createBody()
    await expect(f.request('POST', { ...body, mailbox: f.foreign.login }, f.ownerToken, '/api/account/collaboration/calendars')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(f.request('POST', { ...body, accountId: f.own.id }, f.ownerToken, '/api/account/collaboration/calendars')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.request('GET', undefined, f.ownerToken, '/api/account/collaboration?mailbox=' + f.foreign.login)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(f.helpers.calendarRoute).not.toHaveBeenCalled()
  })
  it('refuses stale collection revisions and preserves concurrent canonical calendar records', async () => {
    const f = await fixture(), body = await f.createBody(), records = await f.readCalendars()
    records.push(f.calendar(f.inbox, 'Concurrent')); await f.ext.write('webmail/calendars.json', records)
    await expect(f.request('POST', body, f.ownerToken, '/api/account/collaboration/calendars')).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(f.helpers.calendarRoute).not.toHaveBeenCalled(); expect((await f.readCalendars()).some(calendar => calendar.name === 'Concurrent')).toBe(true)
  })
  it('rechecks actual feature policy before overview and create without revealing rows', async () => {
    const f = await fixture(), body = await f.createBody()
    await f.state.store.updateFeatureList(f.feature.id, { disabled: ['calendars-contacts-management'] })
    await expect(f.request()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(f.request('POST', body, f.ownerToken, '/api/account/collaboration/calendars')).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(f.helpers.calendarRoute).not.toHaveBeenCalled()
  })
  it('does not label malformed post-dispatch acknowledgements unchanged or retry them', async () => {
    const f = await fixture(); f.helpers.calendarRoute = vi.fn(async () => new Response('{bad', { status: 201 }))
    await expect(f.request('POST', await f.createBody(), f.ownerToken, '/api/account/collaboration/calendars')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true, verificationRequired: true } })
    expect(f.helpers.calendarRoute).toHaveBeenCalledOnce()
  })
})
