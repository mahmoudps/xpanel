import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApiToken, createRootPrincipal, createSession, createTestDb, createUserPrincipal } from '@xpanel/db'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import { deriveCsrfToken, sha256Hex } from '../auth.ts'
import { createApiApp, listenApiServer } from '../server.ts'
import type { WebmailCalendar } from '../extended-routes.ts'
import { CALENDAR_LIMITS, calendarCollectionRevision, calendarWorkspaceRevision } from './calendar-workspace.ts'

// Real loopback HTTP and authoritative disposable JSON/SQLite persistence. Credentials are
// synthetic; no CalDAV synchronization, mailbox login or service qualification is claimed.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'calendar-workspace-synthetic-server-secret'
const cleanup: Array<() => Promise<unknown>> = []
const fixture = async () => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Calendar fixtures', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Calendar fixtures', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 5, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.29', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null, contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.29', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const own = await account('calown'), other = await account('calother')
  const mailbox = (accountId: string, login: string) => state.store.createServiceUser({ accountId, login, passwordHash: HASH, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const inbox = await mailbox(own.id, `inbox@${own.primaryDomain}`), sibling = await mailbox(own.id, `sibling@${own.primaryDomain}`), foreign = await mailbox(other.id, `foreign@${other.primaryDomain}`)
  const ownerPrincipal = await createUserPrincipal(database.db, { username: own.username, accountId: own.id, passwordHash: HASH })
  const foreignPrincipal = await createUserPrincipal(database.db, { username: other.username, accountId: other.id, passwordHash: HASH })
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  const token = async (principalId: string, scopes: string[]) => {
    const raw = 'xp_' + randomUUID()
    await createApiToken(database.db, { principalId, name: 'Synthetic calendars', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const inboxToken = await token(ownerPrincipal.id, [`mailbox:${inbox.id}`, 'webmail:read', 'webmail:write'])
  const readOnlyToken = await token(ownerPrincipal.id, [`mailbox:${inbox.id}`, 'webmail:read'])
  const siblingToken = await token(ownerPrincipal.id, [`mailbox:${sibling.id}`, 'webmail:read', 'webmail:write'])
  const foreignToken = await token(foreignPrincipal.id, [`mailbox:${foreign.id}`, 'webmail:read', 'webmail:write'])
  const rootToken = await token(root.id, ['*'])
  const authorityFor = (service: typeof inbox) => ({ accountId: service.accountId, serviceUserId: service.id, mailbox: service.login })
  const calendar = (owner: string, name: string): WebmailCalendar => ({ id: randomUUID(), owner, ownerAuthority: authorityFor([inbox, sibling, foreign].find(service => service.login === owner)!), name, color: '#4f6bed', timezone: 'UTC', shares: [], events: [], createdAt: '2026-10-26T12:00:00.000Z' })
  const ownCalendar = calendar(inbox.login, 'Own calendar'), siblingCalendar = calendar(sibling.login, 'Sibling private'), foreignCalendar = calendar(foreign.login, 'Foreign private')
  const path = join(state.rootDir, 'extended', 'webmail', 'calendars.json')
  await atomicWriteJson(path, [ownCalendar, siblingCalendar, foreignCalendar])
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET })
  const server = await listenApiServer(app); cleanup.push(() => server.close())
  const request = (path: string, method = 'GET', body?: unknown, bearer: string | null = inboxToken, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${server.port}` + path, {
    method, headers: { ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const persisted = async () => JSON.parse(await readFile(path, 'utf8')) as WebmailCalendar[]
  const bytes = () => readFile(path, 'utf8')
  const workspace = async (bearer = inboxToken) => { const response = await request('/api/webmail/calendars', 'GET', undefined, bearer); expect(response.status).toBe(200); return await response.json() as { context: { mailbox: string }; calendars: Array<WebmailCalendar & { revision: string; canWrite: boolean; canManage: boolean }>; revision: string } }
  const ownRevision = async () => (await workspace()).calendars.find(calendar => calendar.id === ownCalendar.id)!.revision
  const audit = (action: string) => database.db.query('SELECT action FROM audit_log WHERE action = $1', [action])
  return { database, state, own, other, inbox, sibling, foreign, root, inboxToken, readOnlyToken, siblingToken, foreignToken, rootToken, request, path, persisted, bytes, workspace, ownRevision, ownCalendar, siblingCalendar, foreignCalendar, calendar, authorityFor, audit }
}

describe('calendar workspace real-loopback security and persistence', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Calendar fixture cleanup failed')
  })
  const item = () => '/api/webmail/calendars/' + f.ownCalendar.id
  const ics = (summary = 'Imported event') => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:original-uid@example.test', 'SUMMARY:' + summary, 'DTSTART:20261102T080000Z', 'DTEND:20261102T090000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')

  it('reads the sealed mailbox only without altering bytes or allocating a record', async () => {
    const before = await f.bytes(), workspace = await f.workspace()
    expect(workspace.context.mailbox).toBe(f.inbox.login)
    expect(workspace.calendars.map(calendar => calendar.name)).toEqual(['Own calendar'])
    expect(workspace.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(workspace.calendars[0]).toMatchObject({ canWrite: true, canManage: true, revision: calendarWorkspaceRevision(f.ownCalendar) })
    expect(await f.bytes()).toBe(before)
    expect((await f.request('/api/webmail/calendars', 'GET', undefined, null)).status).toBe(401)
  })
  it('enforces actual middleware write scopes before delegated calendar mutations', async () => {
    expect((await f.request('/api/webmail/calendars', 'GET', undefined, f.readOnlyToken)).status).toBe(200)
    const before = await f.bytes(), revision = await f.ownRevision()
    for (const [path, method, body] of [
      ['/api/webmail/calendars', 'POST', { name: 'Denied create', expectedRevision: (await f.workspace()).revision }],
      [item(), 'PATCH', { name: 'Denied edit', expectedRevision: revision }],
      [item(), 'DELETE', { expectedRevision: revision }],
      [item() + '/events', 'POST', { summary: 'Denied event', dtstart: '20261102', expectedRevision: revision }],
      [item() + '/share', 'POST', { principal: f.sibling.login, permission: 'read', expectedRevision: revision }],
      [item() + '/import', 'POST', { ics: ics(), expectedRevision: revision }],
    ] as const) expect((await f.request(path, method, body, f.readOnlyToken)).status).toBe(403)
    expect(await f.bytes()).toBe(before)
  })
  it('keeps storage authority pins out of administrative list, item and mutation responses', async () => {
    expect((await f.request(item() + '/share', 'POST', { principal: f.sibling.login, permission: 'read', expectedRevision: await f.ownRevision() })).status).toBe(200)
    const response = await f.request(item(), 'PATCH', { mailbox: f.inbox.login, name: 'Admin shape' }, f.rootToken)
    expect(response.status).toBe(200)
    const ack = await response.json() as { calendar: Record<string, unknown> }
    expect(Object.keys(ack.calendar).sort()).toEqual(['id', 'owner', 'name', 'color', 'timezone', 'shares', 'events', 'createdAt'].sort())
    expect(ack.calendar.shares).toEqual([{ principal: f.sibling.login, permission: 'read', sharedAt: expect.any(String) }])
    for (const path of [item(), '/api/webmail/calendars?mailbox=' + encodeURIComponent(f.inbox.login)]) {
      const read = await f.request(path, 'GET', undefined, f.rootToken)
      expect(read.status).toBe(200)
      const source = JSON.stringify(await read.json())
      expect(source).not.toContain('ownerAuthority')
      expect(source).not.toContain('granteeAuthority')
      expect(source).not.toContain(f.inbox.id)
      expect(source).not.toContain(f.sibling.id)
    }
    expect((await f.persisted()).find(calendar => calendar.id === f.ownCalendar.id)).toMatchObject({ ownerAuthority: f.authorityFor(f.inbox), shares: [{ granteeAuthority: f.authorityFor(f.sibling) }] })
  })
  it('creates an actual stored calendar with audit and persisted readback', async () => {
    const response = await f.request('/api/webmail/calendars', 'POST', { name: 'Personal', color: '#112233', timezone: 'Asia/Hebron', expectedRevision: (await f.workspace()).revision })
    expect(response.status).toBe(201)
    const body = await response.json() as { calendar: WebmailCalendar & { revision: string }; application: { nativeApplied: boolean } }
    expect(body.calendar).toMatchObject({ name: 'Personal', owner: f.inbox.login, color: '#112233', timezone: 'Asia/Hebron' })
    expect(body.application.nativeApplied).toBe(false)
    expect((await f.persisted()).find(calendar => calendar.id === body.calendar.id)).toMatchObject({ name: 'Personal', owner: f.inbox.login, ownerAuthority: f.authorityFor(f.inbox) })
    expect(body.calendar.ownerAuthority).toBeUndefined()
    expect((await f.workspace()).calendars.some(calendar => calendar.id === body.calendar.id)).toBe(true)
    expect((await f.audit('webmail.calendar.created')).length).toBe(1)
  })
  it('refuses sealed selectors and server metadata injection without writing', async () => {
    const before = await f.bytes(), revision = (await f.workspace()).revision
    for (const request of [
      () => f.request('/api/webmail/calendars?mailbox=' + encodeURIComponent(f.foreign.login)),
      () => f.request('/api/webmail/calendars', 'POST', { name: 'Injected', owner: f.foreign.login, expectedRevision: revision }),
      () => f.request('/api/webmail/calendars', 'POST', { name: 'Injected pin', ownerAuthority: f.authorityFor(f.inbox), expectedRevision: revision }),
      () => f.request(item(), 'PATCH', { shares: [], expectedRevision: calendarWorkspaceRevision(f.ownCalendar) }),
      () => f.request(item(), 'PATCH', { name: 'Missing revision' }),
    ]) expect([400, 422]).toContain((await request()).status)
    expect(await f.bytes()).toBe(before)
  })
  it('preserves unbound historical ownership without exposing or adopting its content', async () => {
    const records = await f.persisted(), target = records.find(calendar => calendar.id === f.ownCalendar.id)!
    delete target.ownerAuthority
    await atomicWriteJson(f.path, records)
    const before = await f.bytes(), listed = await f.workspace()
    expect(listed.calendars).toEqual([])
    expect(listed.revision).toBe(calendarCollectionRevision([], f.authorityFor(f.inbox)))
    expect((await f.request(item())).status).toBe(412)
    expect((await f.request(item(), 'PATCH', { name: 'Do not adopt', expectedRevision: calendarWorkspaceRevision(target) })).status).toBe(412)
    expect((await f.request(item(), 'DELETE', { expectedRevision: calendarWorkspaceRevision(target) })).status).toBe(412)
    expect(await f.bytes()).toBe(before)
  })
  it('ignores former owner lifetimes for names, quotas and collection revisions while preserving them', async () => {
    const records = await f.persisted(), target = records.find(calendar => calendar.id === f.ownCalendar.id)!
    target.ownerAuthority = { ...f.authorityFor(f.inbox), serviceUserId: randomUUID() }
    const historical = [target, ...Array.from({ length: CALENDAR_LIMITS.calendars }, (_, index) => ({ ...structuredClone(target), id: randomUUID(), name: 'Former ' + index }))]
    await atomicWriteJson(f.path, [...records.filter(calendar => calendar.id !== target.id), ...historical])
    const before = await f.bytes(), listed = await f.workspace()
    expect(listed.calendars).toEqual([])
    expect(listed.revision).toBe(calendarCollectionRevision([], f.authorityFor(f.inbox)))
    expect((await f.request(item())).status).toBe(404)
    expect((await f.request(item(), 'PATCH', { name: 'Do not inherit', expectedRevision: calendarWorkspaceRevision(target) })).status).toBe(404)
    expect(await f.bytes()).toBe(before)
    const created = await f.request('/api/webmail/calendars', 'POST', { name: target.name, expectedRevision: listed.revision })
    expect(created.status).toBe(201)
    const persisted = await f.persisted()
    for (const old of historical) expect(persisted.find(calendar => calendar.id === old.id)).toEqual(old)
    expect((await f.workspace()).calendars).toHaveLength(1)
  })
  it('withholds unbound shares until a verified owner explicitly grants the current recipient', async () => {
    const records = await f.persisted(), target = records.find(calendar => calendar.id === f.ownCalendar.id)!
    target.shares = [{ principal: f.sibling.login, permission: 'read-write', sharedAt: '2026-10-26T12:00:00Z' }]
    await atomicWriteJson(f.path, records)
    const before = await f.bytes()
    expect((await f.workspace(f.siblingToken)).calendars.some(calendar => calendar.id === target.id)).toBe(false)
    expect((await f.request(item(), 'GET', undefined, f.siblingToken)).status).toBe(412)
    const ownerView = (await f.workspace()).calendars[0]!
    expect(ownerView.shares).toEqual([{ principal: f.sibling.login, permission: 'read-write', sharedAt: target.shares[0]!.sharedAt, effective: false }])
    expect(await f.bytes()).toBe(before)
    expect((await f.request(item() + '/share', 'POST', { principal: f.sibling.login, permission: 'read-write', expectedRevision: ownerView.revision })).status).toBe(200)
    const stored = (await f.persisted()).find(calendar => calendar.id === target.id)!
    expect(stored.shares[0]!.granteeAuthority).toEqual(f.authorityFor(f.sibling))
    expect((await f.workspace(f.siblingToken)).calendars.find(calendar => calendar.id === target.id)).toMatchObject({ canWrite: true, canManage: false })
  })
  it('requires both owner and recipient lifetimes for shared content after address reuse', async () => {
    const records = await f.persisted(), target = records.find(calendar => calendar.id === f.ownCalendar.id)!
    target.shares = [{ principal: f.sibling.login, granteeAuthority: { ...f.authorityFor(f.sibling), serviceUserId: randomUUID() }, permission: 'read-write', sharedAt: '2026-10-26T12:00:00Z' }]
    await atomicWriteJson(f.path, records)
    let before = await f.bytes()
    expect((await f.workspace(f.siblingToken)).calendars.some(calendar => calendar.id === target.id)).toBe(false)
    expect((await f.request(item(), 'GET', undefined, f.siblingToken)).status).toBe(404)
    expect(await f.bytes()).toBe(before)
    target.shares[0]!.granteeAuthority = f.authorityFor(f.sibling)
    target.ownerAuthority = { ...f.authorityFor(f.inbox), serviceUserId: randomUUID() }
    await atomicWriteJson(f.path, records)
    before = await f.bytes()
    expect((await f.workspace(f.siblingToken)).calendars.some(calendar => calendar.id === target.id)).toBe(false)
    expect((await f.request(item(), 'GET', undefined, f.siblingToken)).status).toBe(404)
    expect(await f.bytes()).toBe(before)
  })
  it('updates calendar settings and real event drafts while preserving external UID identity', async () => {
    const revision = await f.ownRevision()
    const response = await f.request(item(), 'PATCH', { name: 'Renamed', events: [{ summary: 'Review', dtstart: '20261102T080000Z', dtend: '20261102T090000Z', location: 'Office', description: 'Review source' }], expectedRevision: revision })
    expect(response.status).toBe(200)
    const updated = (await f.workspace()).calendars[0]!, event = updated.events![0]!
    expect(event).toMatchObject({ summary: 'Review', location: 'Office', timezone: 'UTC' })
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/)
    const edited = await f.request(item(), 'PATCH', { events: [{ id: event.id, summary: 'Updated', dtstart: event.dtstart, dtend: event.dtend }], expectedRevision: updated.revision })
    expect(edited.status).toBe(200)
    expect((await f.workspace()).calendars[0]!.events![0]).toMatchObject({ id: event.id, uid: event.uid, summary: 'Updated' })
    expect((await f.persisted()).find(calendar => calendar.id === f.ownCalendar.id)?.name).toBe('Renamed')
  })
  it('creates, partially edits and deletes one event through narrow revision-bound routes', async () => {
    const hostingRevision = (await f.state.store.readSnapshot()).revision
    const created = await f.request(item() + '/events', 'POST', { summary: 'One event', description: 'Original notes', dtstart: '20261102T080000Z', dtend: '20261102T090000Z', expectedRevision: await f.ownRevision() })
    expect(created.status).toBe(200)
    const event = (await created.json() as { event: NonNullable<WebmailCalendar['events']>[number] }).event
    expect(event).toMatchObject({ summary: 'One event', description: 'Original notes', timezone: 'UTC' })
    const stale = await f.ownRevision()
    const updated = await f.request(item() + '/events/' + event.id, 'PATCH', { summary: 'Updated', expectedRevision: stale })
    expect(updated.status).toBe(200)
    const current = (await updated.json() as { event: typeof event }).event
    expect(current).toMatchObject({ id: event.id, uid: event.uid, summary: 'Updated', description: event.description, dtstart: event.dtstart, dtend: event.dtend })
    const before = await f.bytes()
    expect((await f.request(item() + '/events/' + event.id, 'DELETE', { expectedRevision: stale })).status).toBe(409)
    expect(await f.bytes()).toBe(before)
    const deleted = await f.request(item() + '/events/' + event.id, 'DELETE', { expectedRevision: await f.ownRevision() })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({ ok: true, deletedEventId: event.id })
    expect((await f.workspace()).calendars[0]!.events).toEqual([])
    expect((await f.audit('webmail.calendar.event_created')).length).toBe(1)
    expect((await f.audit('webmail.calendar.event_updated')).length).toBe(1)
    expect((await f.audit('webmail.calendar.event_deleted')).length).toBe(1)
    expect((await f.state.store.readSnapshot()).revision).toBe(hostingRevision)
  })
  it('refuses new oversized state before publication while preserving every existing record', async () => {
    const before = await f.bytes()
    const events = Array.from({ length: 150 }, (_, index) => ({ summary: 'Large ' + index, description: 'x'.repeat(4000), dtstart: '20261102', dtend: '20261103' }))
    const response = await f.request(item(), 'PATCH', { events, expectedRevision: await f.ownRevision() })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
    expect(await f.bytes()).toBe(before)
  })
  it('allows narrow non-increasing repairs of oversized legacy data without rewriting other events', async () => {
    const records = await f.persisted(), target = records.find(calendar => calendar.id === f.ownCalendar.id)!
    target.events = Array.from({ length: 150 }, (_, index) => ({ id: randomUUID(), uid: 'legacy-' + index + '@example.test', summary: 'Legacy ' + index, description: 'x'.repeat(4000), location: '', dtstart: '20261102', dtend: '20261103', timezone: 'UTC' }))
    expect(Buffer.byteLength(JSON.stringify(target))).toBeGreaterThan(CALENDAR_LIMITS.calendarBytes)
    await atomicWriteJson(f.path, records)
    const before = await f.bytes(), first = target.events[0]!, untouched = target.events.slice(1)
    expect((await f.request(item() + '/events', 'POST', { summary: 'Overflow', dtstart: '20261102', expectedRevision: await f.ownRevision() })).status).toBe(422)
    expect(await f.bytes()).toBe(before)
    const repaired = await f.request(item() + '/events/' + first.id, 'PATCH', { description: 'Reduced notes', expectedRevision: await f.ownRevision() })
    expect(repaired.status).toBe(200)
    const after = (await f.persisted()).find(calendar => calendar.id === target.id)!
    expect(after.events![0]).toMatchObject({ id: first.id, uid: first.uid, description: 'Reduced notes' })
    expect(after.events!.slice(1)).toEqual(untouched)
    const second = after.events![1]!
    expect((await f.request(item() + '/events/' + second.id, 'DELETE', { expectedRevision: await f.ownRevision() })).status).toBe(200)
    const final = await f.persisted()
    expect(final.find(calendar => calendar.id === target.id)!.events).toHaveLength(149)
    expect(final.find(calendar => calendar.id === f.siblingCalendar.id)).toEqual(f.siblingCalendar)
    expect(final.find(calendar => calendar.id === f.foreignCalendar.id)).toEqual(f.foreignCalendar)
  })
  it('refuses stale concurrent updates and deletes without losing another write', async () => {
    const expectedRevision = await f.ownRevision()
    const responses = await Promise.all([f.request(item(), 'PATCH', { name: 'First', expectedRevision }), f.request(item(), 'PATCH', { name: 'Second', expectedRevision })])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    const before = await f.bytes()
    expect((await f.request(item(), 'DELETE', { expectedRevision })).status).toBe(409)
    expect(await f.bytes()).toBe(before)
  })
  it('imports and exports actual stored events and makes UID-based reimport idempotent', async () => {
    let response = await f.request(item() + '/import', 'POST', { ics: ics(), expectedRevision: await f.ownRevision() })
    expect(response.status).toBe(201)
    const first = (await f.workspace()).calendars[0]!.events![0]!
    expect(first.uid).toBe('original-uid@example.test')
    response = await f.request(item() + '/import', 'POST', { ics: ics('Updated import'), expectedRevision: await f.ownRevision() })
    expect(response.status).toBe(201)
    const current = (await f.workspace()).calendars[0]!
    expect(current.events).toHaveLength(1)
    expect(current.events![0]).toMatchObject({ id: first.id, uid: first.uid, summary: 'Updated import' })
    const exported = await f.request(item() + '/export')
    expect(exported.status).toBe(200)
    const output = await exported.json() as { calendarId: string; ics: string; eventsCount: number }
    expect(output.calendarId).toBe(f.ownCalendar.id)
    expect(output.eventsCount).toBe(1)
    expect(output.ics).toContain('UID:original-uid@example.test')
    expect(output.ics).toContain('SUMMARY:Updated import')
  })
  it('refuses invalid dates, unsupported ICS recurrence and oversized event collections without writing', async () => {
    const before = await f.bytes(), expectedRevision = await f.ownRevision()
    for (const body of [
      { events: [{ summary: 'Invalid', dtstart: '20260230' }], expectedRevision },
      { events: Array.from({ length: CALENDAR_LIMITS.events + 1 }, () => ({ summary: 'Too many', dtstart: '20261102' })), expectedRevision },
      { timezone: 'Fake/Nowhere', expectedRevision },
      { color: 'red;display:none', expectedRevision },
    ]) expect((await f.request(item(), 'PATCH', body)).status).toBe(422)
    expect((await f.request(item() + '/import', 'POST', { ics: ics().replace('SUMMARY:', 'RRULE:FREQ=DAILY\r\nSUMMARY:'), expectedRevision })).status).toBe(422)
    expect(await f.bytes()).toBe(before)
  })
  it('enforces same-account sharing, read-only roles and owner-only settings and deletion', async () => {
    let response = await f.request(item() + '/share', 'POST', { principal: f.foreign.login, permission: 'read', expectedRevision: await f.ownRevision() })
    expect(response.status).toBe(404)
    response = await f.request(item() + '/share', 'POST', { principal: f.sibling.login, permission: 'read', expectedRevision: await f.ownRevision() })
    expect(response.status).toBe(200)
    let shared = (await f.workspace(f.siblingToken)).calendars.find(calendar => calendar.id === f.ownCalendar.id)!
    expect(shared).toMatchObject({ canWrite: false, canManage: false, shares: [] })
    expect((await f.request(item(), 'PATCH', { events: [], expectedRevision: shared.revision }, f.siblingToken)).status).toBe(403)
    response = await f.request(item() + '/share', 'POST', { principal: f.sibling.login, permission: 'read-write', expectedRevision: await f.ownRevision() })
    expect(response.status).toBe(200)
    shared = (await f.workspace(f.siblingToken)).calendars.find(calendar => calendar.id === f.ownCalendar.id)!
    expect((await f.request(item(), 'PATCH', { events: [{ summary: 'Shared event', dtstart: '20261102' }], expectedRevision: shared.revision }, f.siblingToken)).status).toBe(200)
    shared = (await f.workspace(f.siblingToken)).calendars.find(calendar => calendar.id === f.ownCalendar.id)!
    expect((await f.request(item(), 'PATCH', { name: 'Forbidden', expectedRevision: shared.revision }, f.siblingToken)).status).toBe(403)
    expect((await f.request(item(), 'DELETE', { expectedRevision: shared.revision }, f.siblingToken)).status).toBe(403)
    expect((await f.request(item() + '/share', 'DELETE', { principal: f.sibling.login, expectedRevision: await f.ownRevision() })).status).toBe(200)
    expect((await f.workspace(f.siblingToken)).calendars.some(calendar => calendar.id === f.ownCalendar.id)).toBe(false)
  })
  it('hides foreign calendars even if an old cross-account share exists', async () => {
    const records = await f.persisted()
    records.find(calendar => calendar.id === f.foreignCalendar.id)!.shares.push({ principal: f.inbox.login, permission: 'read-write', sharedAt: '2026-10-26T12:00:00Z' })
    await atomicWriteJson(f.path, records)
    const before = await f.bytes()
    expect((await f.workspace()).calendars.map(calendar => calendar.name)).not.toContain('Foreign private')
    expect((await f.request('/api/webmail/calendars/' + f.foreignCalendar.id + '/export')).status).toBe(404)
    expect((await f.request('/api/webmail/calendars/' + f.foreignCalendar.id, 'DELETE', { expectedRevision: calendarWorkspaceRevision(f.foreignCalendar) })).status).toBe(404)
    expect(await f.bytes()).toBe(before)
  })
  it('enforces calendar capacity under the lease and preserves all existing records', async () => {
    const records = await f.persisted()
    for (let index = 1; index < CALENDAR_LIMITS.calendars; index++) records.push(f.calendar(f.inbox.login, 'Calendar ' + index))
    await atomicWriteJson(f.path, records)
    const before = await f.bytes()
    expect((await f.request('/api/webmail/calendars', 'POST', { name: 'Overflow', expectedRevision: (await f.workspace()).revision })).status).toBe(422)
    expect(await f.bytes()).toBe(before)
  })
  it('deletes only the exact reviewed owned calendar with audit and absence readback', async () => {
    expect((await f.request(item(), 'DELETE', { expectedRevision: await f.ownRevision() })).status).toBe(200)
    expect((await f.persisted()).find(calendar => calendar.id === f.ownCalendar.id)).toBeUndefined()
    expect((await f.persisted()).find(calendar => calendar.id === f.siblingCalendar.id)).toEqual(f.siblingCalendar)
    expect((await f.audit('webmail.calendar.deleted')).length).toBe(1)
  })
  it('preserves administrative selector/alias grammar and mandatory session CSRF', async () => {
    const created = await f.request('/api/webmail/calendars', 'POST', { owner: f.inbox.login, name: 'Admin calendar' }, f.rootToken)
    expect(created.status).toBe(201)
    const admin = (await created.json() as { calendar: WebmailCalendar }).calendar
    expect((await f.request('/api/webmail/calendars/' + admin.id + '/share', 'POST', { grantee: f.sibling.login, permission: 'read' }, f.rootToken)).status).toBe(200)
    const raw = randomUUID() + randomUUID()
    await createSession(f.database.db, { principalId: f.root.id, tokenHash: sha256Hex(raw), expiresAt: new Date(Date.now() + 60000).toISOString() })
    const before = await f.bytes(), headers = { cookie: 'xpanel_session=' + raw }
    expect((await f.request('/api/webmail/calendars/' + admin.id, 'DELETE', {}, null, headers)).status).toBe(403)
    expect(await f.bytes()).toBe(before)
    expect((await f.request('/api/webmail/calendars/' + admin.id, 'DELETE', {}, null, { ...headers, 'x-csrf-token': deriveCsrfToken(raw, SECRET) })).status).toBe(200)
  })
})
