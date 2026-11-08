import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail, isXpanelError } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { createMailboxLocks, davStoreTooLarge, openDavSession } from './mail/dav-store.ts'
import { createMemoryDav } from './mail/dav-testkit.ts'
import { createMailxCollectionsRoutes } from './mailx-collections.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Collections', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Collections', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 5, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.43', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const own = await state.store.createAccount({ username: 'colown', passwordHash: HASH, primaryDomain: 'colown.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@colown.example.test', ipv4: '192.0.2.43', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const inbox = await state.store.createServiceUser({ accountId: own.id, login: 'inbox@colown.example.test', passwordHash: HASH, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  await state.store.createServiceUser({ accountId: own.id, login: 'large@colown.example.test', passwordHash: HASH, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const calendarId = randomUUID(), dav = createMemoryDav(), tooLarge = new Set<string>()
  dav.seedCalendars([{ id: calendarId, owner: inbox.login, ownerAuthority: { accountId: own.id, serviceUserId: inbox.id, mailbox: inbox.login }, name: 'Work', color: '#4f6bed', timezone: 'UTC', shares: [], events: [], createdAt: '2026-01-01T00:00:00.000Z' }], () => own.username)
  let current = { principal: { id: 'user-' + own.id, kind: 'user', username: own.username, accountId: own.id }, principalRecord: {}, sessionId: 's1', sessionToken: null, apiTokenId: null, scopes: [], csrfValid: true, mfaVerified: true } as unknown as AuthenticatedCaller
  const audits = vi.fn(async () => {})
  const route = createMailxCollectionsRoutes({ store: state.store, serverSecret: 'collections-synthetic-secret', requireCaller: async () => current, emitAudit: audits,
    dav: { open: (caller, account, authority) => { const session = openDavSession({ exchange: dav.exchange, listServiceUsers: id => state.store.listServiceUsers(id) }, caller, account, authority); return tooLarge.has(authority.mailbox) ? { ...session, collections: davStoreTooLarge } : session }, lock: createMailboxLocks() },
    assertCanAccessAccount: async (who, target) => { if ((who.principal as { accountId?: string }).accountId !== target.id) fail('FORBIDDEN', 'denied') } })
  const call = async (method = 'GET', body?: unknown, query = '') => {
    const request = new Request('http://localhost/api/account/mailx/collections' + query, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    try { const response = await route(request, new URL(request.url), method); return { status: response!.status, body: await response!.json() } }
    catch (error) { if (isXpanelError(error)) return { status: 0, code: error.code, detail: error.detail, body: null }; throw error }
  }
  return { call, calendarId, audits, dav, own, inbox, tooLarge, root: () => { current = { ...current, principal: { id: 'root', kind: 'root', username: 'root' } } as unknown as AuthenticatedCaller } }
}

const plain = ({ removable: _removable, ...item }: { removable: boolean; id: string; name: string; description: string; isDefault: boolean }) => item
describe('mail collection settings', () => {
  it('refuses only the oversized mailbox and still saves the others', async () => {
    const f = await fixture(), large = 'large@colown.example.test'; f.tooLarge.add(large)
    const read = await f.call(), mailbox = read.body.mailboxes.find((item: { mailbox: string }) => item.mailbox === f.inbox.login)
    expect(read.body.mailboxes.find((item: { mailbox: string }) => item.mailbox === large)).toEqual({ mailbox: large, refused: 'dav_store_too_large' })
    const base = { expectedRevision: mailbox.revision, defaultCalendar: null, descriptions: {}, addressBooks: mailbox.addressBooks.map(plain), taskLists: [] }
    expect((await f.call('PUT', { ...base, mailbox: large })).detail).toMatchObject({ reason: 'dav_store_too_large', stateChanged: false })
    expect((await f.call('PUT', { ...base, mailbox: mailbox.mailbox })).status).toBe(200)
  })
  it('saves defaults, descriptions, address books and task lists as the collections devices sync', async () => {
    const f = await fixture(), first = await f.call()
    expect(first.body).toMatchObject({ application: { status: 'dav_store', davServed: true } })
    const mailbox = first.body.mailboxes[0]
    expect(JSON.stringify(first.body)).not.toContain(f.calendarId)
    const calendar = mailbox.calendars[0].id
    const body = { mailbox: mailbox.mailbox, expectedRevision: mailbox.revision, defaultCalendar: calendar, descriptions: { [calendar]: 'Team meetings' },
      addressBooks: [{ id: mailbox.addressBooks[0].id, name: 'Contacts', description: '', isDefault: false }, { id: null, name: 'Clients', description: '', isDefault: true }], taskLists: [{ id: null, name: 'Follow-ups', description: 'Open tasks', isDefault: true }, { id: null, name: 'Later', description: '', isDefault: false }] }
    const saved = await f.call('PUT', body)
    const after = saved.body.mailboxes[0]
    expect(after).toMatchObject({ defaultCalendar: calendar, calendars: [{ id: calendar, name: 'Work', description: 'Team meetings' }], addressBooks: [{ name: 'Clients', isDefault: true, removable: true }, { name: 'Contacts', isDefault: false, removable: false }] })
    expect(after.addressBooks[0].id).toMatch(/^[0-9a-f]{32}$/)
    expect(after.taskLists.map((item: { name: string }) => item.name)).toEqual(['Follow-ups', 'Later'])
    expect(f.dav.collections(f.own.username, f.inbox.id)).toHaveLength(5)
    expect((await f.call('PUT', body)).code).toBe('CONFLICT')
    const renamed = { ...body, expectedRevision: after.revision, addressBooks: [{ ...plain(after.addressBooks[0]), name: 'Customers' }, plain(after.addressBooks[1])], taskLists: [plain(after.taskLists[0])] }
    const changed = (await f.call('PUT', renamed)).body.mailboxes[0]
    expect(changed.addressBooks[1]).toEqual({ ...after.addressBooks[0], name: 'Customers' })
    expect(changed.taskLists.map((item: { name: string }) => item.name)).toEqual(['Follow-ups'])
    expect(f.dav.collections(f.own.username, f.inbox.id)).toHaveLength(4)
    expect(f.audits).toHaveBeenCalledTimes(2)
  })
  it('keeps the default address book, which devices are told to use', async () => {
    const f = await fixture(), mailbox = (await f.call()).body.mailboxes[0]
    const refused = await f.call('PUT', { mailbox: mailbox.mailbox, expectedRevision: mailbox.revision, defaultCalendar: null, descriptions: {}, addressBooks: [], taskLists: [] })
    expect(refused).toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'dav_default_collection', stateChanged: false } })
    expect(f.dav.collections(f.own.username, f.inbox.id)).toContain('addressbook')
  })
  it('reports an unknown outcome when the store refuses a change it has started', async () => {
    const f = await fixture(), mailbox = (await f.call()).body.mailboxes[0]
    f.dav.failNext(500, 'MKCOL')
    const failed = await f.call('PUT', { mailbox: mailbox.mailbox, expectedRevision: mailbox.revision, defaultCalendar: null, descriptions: {}, addressBooks: [plain(mailbox.addressBooks[0]), { id: null, name: 'Clients', description: '', isDefault: false }], taskLists: [] })
    expect(failed).toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
  })
  it('rejects invented ids, two defaults, foreign calendars, selectors and non-owners', async () => {
    const f = await fixture(), mailbox = (await f.call()).body.mailboxes[0]
    const base = { mailbox: mailbox.mailbox, expectedRevision: mailbox.revision, defaultCalendar: null, descriptions: {}, addressBooks: mailbox.addressBooks.map(plain), taskLists: [] }
    for (const [patch, field] of [[{ addressBooks: [{ id: 'a'.repeat(32), name: 'X', description: '', isDefault: true }] }, 'addressBooks'],
      [{ taskLists: [{ id: null, name: 'A', description: '', isDefault: true }, { id: null, name: 'B', description: '', isDefault: true }] }, 'taskLists'],
      [{ taskLists: [{ id: null, name: 'A', description: '', isDefault: true }, { id: null, name: 'a', description: '', isDefault: false }] }, 'taskLists'],
      [{ defaultCalendar: 'b'.repeat(32) }, 'defaultCalendar'], [{ descriptions: { ['c'.repeat(32)]: 'x' } }, 'descriptions']] as const)
      expect((await f.call('PUT', { ...base, ...patch })).detail).toMatchObject({ field })
    expect((await f.call('PUT', { ...base, extra: 1 })).code).toBe('VALIDATION')
    expect((await f.call('PUT', { ...base, mailbox: 'other@colown.example.test' })).code).toBe('NOT_FOUND')
    expect((await f.call('GET', undefined, '?account=x')).code).toBe('VALIDATION')
    f.root(); expect((await f.call()).code).toBe('FORBIDDEN')
  })
})
