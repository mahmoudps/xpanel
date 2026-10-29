import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail, isXpanelError } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { ExtendedFeaturesStore } from './extended-routes.ts'
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
  const calendarId = randomUUID()
  await new ExtendedFeaturesStore(state.rootDir).write('webmail/calendars.json', [{ id: calendarId, owner: inbox.login, ownerAuthority: { accountId: own.id, serviceUserId: inbox.id, mailbox: inbox.login }, name: 'Work', color: '#4f6bed', timezone: 'UTC', shares: [], events: [], createdAt: '2026-10-27T00:00:00Z' }])
  let current = { principal: { id: 'user-' + own.id, kind: 'user', username: own.username, accountId: own.id }, principalRecord: {}, sessionId: 's1', sessionToken: null, apiTokenId: null, scopes: [], csrfValid: true, mfaVerified: true } as unknown as AuthenticatedCaller
  const audits = vi.fn(async () => {})
  const route = createMailxCollectionsRoutes({ store: state.store, serverSecret: 'collections-synthetic-secret', requireCaller: async () => current, emitAudit: audits,
    assertCanAccessAccount: async (who, target) => { if ((who.principal as { accountId?: string }).accountId !== target.id) fail('FORBIDDEN', 'denied') } })
  const call = async (method = 'GET', body?: unknown, query = '') => {
    const request = new Request('http://localhost/api/account/mailx/collections' + query, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    try { const response = await route(request, new URL(request.url), method); return { status: response!.status, body: await response!.json() } }
    catch (error) { if (isXpanelError(error)) return { status: 0, code: error.code, detail: error.detail, body: null }; throw error }
  }
  return { call, calendarId, audits, root: () => { current = { ...current, principal: { id: 'root', kind: 'root', username: 'root' } } as unknown as AuthenticatedCaller } }
}

describe('mail collection settings', () => {
  it('saves defaults, descriptions, address books and task lists with server ids and states DAV truthfully', async () => {
    const f = await fixture(), first = await f.call()
    expect(first.body).toMatchObject({ dav: { caldav: 'unavailable', carddav: 'unavailable', reason: 'no_dav_server' }, application: { davServed: false } })
    const mailbox = first.body.mailboxes[0]
    expect(JSON.stringify(first.body)).not.toContain(f.calendarId)
    const calendar = mailbox.calendars[0].id
    const body = { mailbox: mailbox.mailbox, expectedRevision: mailbox.revision, defaultCalendar: calendar, descriptions: { [calendar]: 'Team meetings' },
      addressBooks: [{ id: null, name: 'Clients', description: '', isDefault: true }], taskLists: [{ id: null, name: 'Follow-ups', description: 'Open tasks', isDefault: true }, { id: null, name: 'Later', description: '', isDefault: false }] }
    const saved = await f.call('PUT', body)
    const after = saved.body.mailboxes[0]
    expect(after).toMatchObject({ defaultCalendar: calendar, calendars: [{ id: calendar, name: 'Work', description: 'Team meetings' }], addressBooks: [{ name: 'Clients', isDefault: true }] })
    expect(after.addressBooks[0].id).toMatch(/^[0-9a-f]{32}$/)
    expect((await f.call('PUT', body)).code).toBe('CONFLICT')
    const renamed = { ...body, expectedRevision: after.revision, addressBooks: [{ ...after.addressBooks[0], name: 'Customers' }], taskLists: after.taskLists }
    expect((await f.call('PUT', renamed)).body.mailboxes[0].addressBooks).toEqual([{ ...after.addressBooks[0], name: 'Customers' }])
    expect(f.audits).toHaveBeenCalledTimes(2)
  })
  it('rejects invented ids, two defaults, foreign calendars, selectors and non-owners', async () => {
    const f = await fixture(), mailbox = (await f.call()).body.mailboxes[0]
    const base = { mailbox: mailbox.mailbox, expectedRevision: mailbox.revision, defaultCalendar: null, descriptions: {}, addressBooks: [], taskLists: [] }
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
