import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { WebmailCalendar, WebmailCalendarEvent, WebmailContact } from '../extended-routes.ts'
import { createMailboxLocks, davItemId, openDavSession, parseDavContact, parseDavEvent, renderDavEvent, rewriteDavEvent, sameCalendars } from './dav-store.ts'
import { createMemoryDav } from './dav-testkit.ts'

const ACCOUNT = { id: 'account-1', username: 'alice' }, OTHER = { id: 'account-2', username: 'bobby' }
const inbox = { id: randomUUID(), login: 'inbox@alice.test', services: { email: true } }
const support = { id: randomUUID(), login: 'support@alice.test', services: { email: true } }
const foreign = { id: randomUUID(), login: 'inbox@bob.test', services: { email: true } }
const authority = (service: typeof inbox, account = ACCOUNT) => ({ accountId: account.id, serviceUserId: service.id, mailbox: service.login })
const fixture = () => {
  const dav = createMemoryDav({ defaults: true })
  const open = (service = inbox, account = ACCOUNT) => openDavSession({ exchange: dav.exchange, listServiceUsers: async accountId => accountId === ACCOUNT.id ? [inbox, support] : [foreign] }, {} as never, account, authority(service, account))
  return { dav, open }
}
const event = (patch: Partial<WebmailCalendarEvent> = {}): WebmailCalendarEvent => ({ id: randomUUID(), uid: randomUUID() + '@xpanel', summary: 'Review', description: '', location: '', dtstart: '20261102T080000Z', dtend: '20261102T090000Z', timezone: 'UTC', ...patch })
const contact = (patch: Partial<WebmailContact> = {}): WebmailContact => ({ id: randomUUID(), owner: inbox.login, ownerAuthority: authority(inbox), fullName: 'Layla', email: 'layla@example.test', phone: '', organization: '', title: '', groups: [], shares: [],
  vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Layla\r\nEMAIL:layla@example.test\r\nEND:VCARD', createdAt: '2026-01-01T00:00:00.000Z', ...patch })
const deviceEvent = (uid: string, summary: string, extra: readonly string[] = []) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Phone//EN', 'BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:20261101T000000Z', 'DTSTART:20261103T100000Z', 'DTEND:20261103T110000Z', 'SUMMARY:' + summary, ...extra, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n'

describe('one store for xMail and devices', () => {
  it('writes an xMail event as the item a device syncs', async () => {
    const f = fixture(), session = f.open(), [calendar] = await session.calendars(), added = event({ summary: 'From xMail', location: 'Office, 2nd floor' })
    await session.publishCalendars([{ ...calendar!, events: [added] }])
    const item = f.dav.item('alice', inbox.id, 'calendar', added.id + '.ics')!
    expect(item).toContain('UID:' + added.uid)
    expect(item).toContain('SUMMARY:From xMail')
    expect(item).toContain('LOCATION:Office\\, 2nd floor')
    expect(item).toContain('DTSTART:20261102T080000Z')
  })
  it('shows an event made on a phone in xMail and keeps its id across reads', async () => {
    const f = fixture()
    f.dav.put('alice', inbox.id, 'calendar', 'phone-event.ics', deviceEvent('phone@device', 'From the phone'))
    const first = (await f.open().calendars())[0]!, second = (await f.open().calendars())[0]!
    expect(first.events).toMatchObject([{ uid: 'phone@device', summary: 'From the phone', dtstart: '20261103T100000Z' }])
    expect(first.events![0]!.id).toBe(second.events![0]!.id)
  })
  it('keeps alarms, attendees and repeat rules when xMail edits a phone event', async () => {
    const f = fixture(), extra = ['RRULE:FREQ=WEEKLY', 'ATTENDEE:mailto:guest@example.test', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'SUMMARY:Alarm text', 'END:VALARM']
    f.dav.put('alice', inbox.id, 'calendar', 'phone-event.ics', deviceEvent('phone@device', 'Standup', extra))
    const session = f.open(), [calendar] = await session.calendars(), original = calendar!.events![0]!
    await session.publishCalendars([{ ...calendar!, events: [{ ...original, summary: 'Daily standup' }] }])
    const stored = f.dav.item('alice', inbox.id, 'calendar', 'phone-event.ics')!
    expect(stored).toContain('SUMMARY:Daily standup')
    expect(stored).not.toContain('SUMMARY:Standup')
    for (const line of [...extra, 'UID:phone@device', 'PRODID:-//Phone//EN']) expect(stored).toContain(line)
  })
  it('refuses to overwrite a change a device made after the read', async () => {
    const f = fixture()
    f.dav.put('alice', inbox.id, 'calendar', 'phone-event.ics', deviceEvent('phone@device', 'Original'))
    const session = f.open(), [calendar] = await session.calendars()
    const write = session.publishCalendars([{ ...calendar!, events: [{ ...calendar!.events![0]!, summary: 'From xMail' }] }])
    // the store answers the conditional write, as Radicale does for a stale ETag
    f.dav.failNext(412, 'PUT')
    await expect(write).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'dav_item_changed', stateChanged: false } })
  })
  it('removes an event and a calendar from the store, and keeps the default calendar', async () => {
    const f = fixture()
    f.dav.put('alice', inbox.id, 'calendar', 'phone-event.ics', deviceEvent('phone@device', 'Gone'))
    const session = f.open(), [calendar] = await session.calendars()
    expect(session.isDefaultCalendar(calendar!.id)).toBe(true)
    await session.publishCalendars([{ ...calendar!, events: [] }])
    expect(f.dav.item('alice', inbox.id, 'calendar', 'phone-event.ics')).toBeUndefined()
    const created: WebmailCalendar = { id: randomUUID(), owner: inbox.login, ownerAuthority: authority(inbox), name: 'Work', color: '#112233', timezone: 'Asia/Hebron', shares: [], events: [], createdAt: '2026-11-07T00:00:00.000Z' }
    await session.calendars()
    await session.publishCalendars([{ ...calendar!, events: [] }, created])
    expect((await session.calendars()).find(entry => entry.id === created.id)).toMatchObject({ name: 'Work', color: '#112233', timezone: 'Asia/Hebron', createdAt: created.createdAt })
    expect(session.isDefaultCalendar(created.id)).toBe(false)
    await session.publishCalendars([(await session.calendars()).find(entry => entry.id === calendar!.id)!])
    expect(f.dav.collections('alice', inbox.id)).not.toContain(created.id)
  })
  it('writes an xMail contact as the card a device syncs and reads a phone card without an address', async () => {
    const f = fixture(), session = f.open(), added = contact()
    await session.contacts()
    await session.publishContacts([added])
    expect(f.dav.item('alice', inbox.id, 'addressbook', added.id + '.vcf')).toContain('UID:' + added.id)
    f.dav.put('alice', inbox.id, 'addressbook', 'phone.vcf', 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Phone only\r\nTEL:+123\r\nEND:VCARD\r\n')
    expect((await session.contacts()).find(entry => entry.fullName === 'Phone only')).toMatchObject({ email: '', phone: '+123', owner: inbox.login })
  })
  it('edits only the changed fields of a card and writes groups as categories', async () => {
    const f = fixture(), card = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:phone-card\r\nFN:Layla\r\nEMAIL:layla@example.test\r\nNOTE:Keep this\r\nX-PHONE:unchanged\r\nEND:VCARD\r\n'
    f.dav.put('alice', inbox.id, 'addressbook', 'phone.vcf', card)
    const session = f.open(), [stored] = await session.contacts()
    await session.publishContacts([{ ...stored!, title: 'Engineer', groups: ['Friends, team'] }])
    const text = f.dav.item('alice', inbox.id, 'addressbook', 'phone.vcf')!
    expect(text).toContain('TITLE:Engineer')
    expect(text).toContain('CATEGORIES:Friends\\, team')
    for (const line of ['UID:phone-card', 'NOTE:Keep this', 'X-PHONE:unchanged']) expect(text).toContain(line)
  })
  it('keeps a device category this model cannot name out of the groups, not out of the card', () => {
    expect(parseDavContact('BEGIN:VCARD\r\nFN:Layla\r\nCATEGORIES:Work,' + 'x'.repeat(65) + '\r\nEND:VCARD')).toMatchObject({ groups: ['Work'], fullName: 'Layla' })
    expect(parseDavContact('not a card')).toBeNull()
    // Exports of older phones, and a card with a large embedded photo, reach xMail like any other card.
    expect(parseDavContact('BEGIN:VCARD\r\nVERSION:2.1\r\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D9=84=D9=8A=\r\n=D9=84=D9=89\r\nEND:VCARD\r\n')).toMatchObject({ fullName: '\u0644\u064a\u0644\u0649' })
    expect(parseDavContact('BEGIN:VCARD\r\nFN:Layla\r\nPHOTO;ENCODING=b;TYPE=JPEG:' + 'A'.repeat(300 * 1024) + '\r\nEND:VCARD\r\n')).toMatchObject({ fullName: 'Layla' })
  })
  it('shows a mailbox only its own collections and what was shared with it', async () => {
    const f = fixture(), owner = f.open(), [calendar] = await owner.calendars()
    expect((await f.open(support).calendars()).map(entry => entry.owner)).toEqual([support.login])
    const shares = [{ principal: support.login, permission: 'read' as const, sharedAt: '2026-11-07T00:00:00.000Z', granteeAuthority: authority(support) }]
    await owner.publishCalendars([{ ...calendar!, shares }])
    expect((await f.open(support).calendars()).map(entry => entry.owner).sort()).toEqual([inbox.login, support.login].sort())
    await owner.calendars()
    await owner.publishCalendars([{ ...calendar!, shares: [] }])
    expect((await f.open(support).calendars()).map(entry => entry.owner)).toEqual([support.login])
  })
  it('never crosses accounts, and ignores a tree whose mailbox no longer exists', async () => {
    const f = fixture()
    f.dav.put('alice', inbox.id, 'calendar', 'mine.ics', deviceEvent('mine@device', 'ALICE_PRIVATE'))
    expect(JSON.stringify(await f.open(foreign, OTHER).calendars())).not.toContain('ALICE_PRIVATE')
    const retired = randomUUID()
    f.dav.seedCalendars([{ id: randomUUID(), owner: inbox.login, ownerAuthority: { accountId: ACCOUNT.id, serviceUserId: retired }, name: 'FORMER_OWNER', color: '#112233', timezone: 'UTC', shares: [{ principal: inbox.login, permission: 'read', sharedAt: '2026-11-07T00:00:00.000Z', granteeAuthority: authority(inbox) }], events: [], createdAt: '2026-11-07T00:00:00.000Z' }], () => 'alice')
    expect(JSON.stringify(await f.open().calendars())).not.toContain('FORMER_OWNER')
  })
  it('reports a stopped store as unavailable and a refused write as an unknown outcome', async () => {
    const f = fixture(), session = f.open(), [calendar] = await session.calendars()
    f.dav.failNext(503, 'GET')
    await expect(f.open().calendars()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { reason: 'dav_store_unavailable', stateChanged: false } })
    f.dav.failNext(500, 'PUT')
    await expect(session.publishCalendars([{ ...calendar!, events: [event()] }])).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { reason: 'dav_write_refused', unknownOutcome: true } })
  })
  it('reads a store larger than one agent reply, page by page', async () => {
    const dav = createMemoryDav({ defaults: true, pageBytes: 1000 })
    for (let index = 0; index < 20; index++) dav.put('alice', inbox.id, 'calendar', 'phone-' + index + '.ics', deviceEvent('phone-' + index + '@device', 'Event ' + index))
    const session = openDavSession({ exchange: dav.exchange, listServiceUsers: async () => [inbox, support] }, {} as never, ACCOUNT, authority(inbox))
    expect((await session.calendars())[0]!.events).toHaveLength(20)
    expect(dav.requests.length).toBeGreaterThan(3)
  })
  it('refuses a store over the read bound instead of showing part of it', async () => {
    const f = fixture(), large = deviceEvent('large@device', 'Large', ['DESCRIPTION:' + 'x'.repeat(4 * 1024 * 1024)])
    for (let index = 0; index < 5; index++) f.dav.put('alice', inbox.id, 'calendar', 'large-' + index + '.ics', large)
    const refused = { code: 'PRECONDITION_FAILED', detail: { reason: 'dav_store_too_large', stateChanged: false } }
    await expect(f.open().calendars()).rejects.toMatchObject(refused)
    await expect(f.open().contacts()).rejects.toMatchObject(refused)
    await expect(f.open().groups()).rejects.toMatchObject(refused)
    await expect(f.open().collections()).rejects.toMatchObject(refused)
  })
  it('refuses a store holding an item no page can carry, and a store that never ends', async () => {
    const f = fixture()
    f.dav.omit(1)
    await expect(f.open().calendars()).rejects.toMatchObject({ detail: { reason: 'dav_store_too_large' } })
    const endless = openDavSession({ exchange: async () => ({ status: 200, etag: null, body: JSON.stringify({ collections: [], omitted: 0, next: '00' }) }), listServiceUsers: async () => [inbox] }, {} as never, ACCOUNT, authority(inbox))
    await expect(endless.calendars()).rejects.toMatchObject({ detail: { reason: 'dav_store_too_large' } })
  })
  it('stores groups, collections and their descriptions in the store', async () => {
    const f = fixture(), session = f.open()
    await session.publishGroups([{ owner: inbox.login, name: 'Friends', createdAt: null }])
    expect(await session.groups()).toEqual([{ owner: inbox.login, ownerAuthority: authority(inbox), name: 'Friends', createdAt: null }])
    const book = await session.createCollection('addressbook', 'Clients', 'People we work for'), tasks = await session.createCollection('tasks', 'Follow-ups', '')
    const first = await session.collections()
    expect(first.addressBooks.find(entry => entry.id === book)).toMatchObject({ name: 'Clients', description: 'People we work for' })
    expect(first.taskLists.find(entry => entry.id === tasks)).toMatchObject({ name: 'Follow-ups' })
    expect(first.calendars.map(entry => entry.collection)).toEqual(['calendar'])
    const collection = first.addressBooks.find(entry => entry.id === book)!.collection
    await session.updateCollection(collection, 'addressbook', { name: 'Customers' })
    expect((await session.collections()).addressBooks.find(entry => entry.id === book)?.name).toBe('Customers')
    await session.deleteCollection(collection)
    expect((await session.collections()).addressBooks.some(entry => entry.id === book)).toBe(false)
  })
})

describe('item parsing', () => {
  it('names a device item stably and keeps a panel id as it is', () => {
    const id = randomUUID()
    expect(davItemId('owner', 'calendar', id + '.ics')).toBe(id)
    expect(davItemId('owner', 'calendar', 'phone.ics')).toBe(davItemId('owner', 'calendar', 'phone.ics'))
    expect(davItemId('owner', 'calendar', 'phone.ics')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(davItemId('owner', 'calendar', 'phone.ics')).not.toBe(davItemId('other', 'calendar', 'phone.ics'))
  })
  it('reads the first date of a repeating event, a DURATION end and all-day dates', () => {
    const text = deviceEvent('uid', 'Weekly', ['RRULE:FREQ=WEEKLY'])
    expect(parseDavEvent(text, 'x.ics', 'id', 'UTC')).toMatchObject({ dtstart: '20261103T100000Z', dtend: '20261103T110000Z', timezone: 'UTC' })
    const timed = text.replace('DTEND:20261103T110000Z\r\n', 'DURATION:PT90M\r\n')
    expect(parseDavEvent(timed, 'x.ics', 'id', 'UTC')?.dtend).toBe('20261103T113000Z')
    const allDay = text.replace('DTSTART:20261103T100000Z', 'DTSTART;VALUE=DATE:20261103').replace('DTEND:20261103T110000Z', 'DTEND;VALUE=DATE:20261104')
    expect(parseDavEvent(allDay, 'x.ics', 'id', 'UTC')).toMatchObject({ dtstart: '20261103', dtend: '20261104' })
  })
  it('leaves a task out and reads the master of an overridden repeating event', () => {
    expect(parseDavEvent('BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:t\r\nSUMMARY:Task\r\nEND:VTODO\r\nEND:VCALENDAR\r\n', 'x.ics', 'id', 'UTC')).toBeNull()
    const text = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:u', 'RECURRENCE-ID:20261110T100000Z', 'DTSTART:20261110T120000Z', 'SUMMARY:Moved once', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:u', 'DTSTART:20261103T100000Z', 'SUMMARY:Master', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    const master = parseDavEvent(text, 'x.ics', 'id', 'UTC')!
    expect(master.summary).toBe('Master')
    const rewritten = rewriteDavEvent(text, master, { ...master, summary: 'Renamed' })
    expect(rewritten).toContain('SUMMARY:Moved once')
    expect(rewritten).toContain('SUMMARY:Renamed')
    expect(rewritten).not.toContain('SUMMARY:Master')
  })
  it('renders a zoned event a device can place, and folds a long line', () => {
    const text = renderDavEvent(event({ dtstart: '20261102T080000', dtend: '20261102T090000', timezone: 'Asia/Hebron', summary: 'x'.repeat(200) }))
    expect(text).toContain('DTSTART;TZID=Asia/Hebron:20261102T080000')
    expect(text).toContain('BEGIN:VTIMEZONE')
    expect(text.split('\r\n').every(line => Buffer.byteLength(line, 'utf8') <= 75)).toBe(true)
  })
  it('counts a local time and its UTC spelling as the same read-back', () => {
    const record = (dtstart: string): WebmailCalendar => ({ id: 'c', owner: 'o', name: 'n', color: '#000000', timezone: 'UTC', shares: [], events: [event({ id: 'e', uid: 'u', dtstart, dtend: dtstart })], createdAt: '' })
    expect(sameCalendars([record('20261102T080000')], [record('20261102T080000Z')])).toBe(true)
    expect(sameCalendars([record('20261102T080000')], [record('20261102T090000Z')])).toBe(false)
  })
})

describe('mailbox locks', () => {
  it('runs writers to one mailbox in order and leaves another mailbox free', async () => {
    const lock = createMailboxLocks(), order: string[] = []
    const first = await lock('a')
    const queued = lock('a').then(release => { order.push('second'); release() })
    const other = await lock('b')
    order.push('other'); other()
    await Promise.resolve()
    order.push('first'); first()
    await queued
    expect(order).toEqual(['other', 'first', 'second'])
  })
})
