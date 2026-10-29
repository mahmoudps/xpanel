import { describe, expect, it } from 'vitest'
import type { MailboxMetadataAuthority } from '@xpanel/core'
import type { WebmailCalendar } from '../extended-routes.ts'
import { CALENDAR_LIMITS, calendarCollectionRevision, calendarColor, calendarEventsFromDraft, calendarTimestamp, calendarTimezone, calendarWorkspaceRevision, projectCalendarWorkspace } from './calendar-workspace.ts'

const id = (value: number): string => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(value).padStart(12, '0')
const authority = (mailbox = 'inbox@example.test', service = 21): MailboxMetadataAuthority => ({ accountId: id(20), serviceUserId: id(service), mailbox })
const calendar = (patch: Partial<WebmailCalendar> = {}): WebmailCalendar => ({ id: id(1), owner: 'inbox@example.test', ownerAuthority: authority(), name: 'Work', color: '#4f6bed', timezone: 'UTC', shares: [],
  events: [{ id: id(2), uid: 'official-source-uid@example.test', summary: 'Review', description: '', location: '', dtstart: '20261102T080000Z', dtend: '20261102T090000Z', timezone: 'UTC' }], createdAt: '2026-10-26T12:00:00.000Z', ...patch })

describe('mail calendar workspace validation and revisions', () => {
  it('accepts bounded HEX and the existing OKLCH representation without CSS injection', () => {
    expect(calendarColor('#4F6BED')).toBe('#4f6bed')
    expect(calendarColor('oklch(0.65 0.18 250)')).toBe('oklch(0.65 0.18 250)')
    for (const value of ['red;display:none', '#fff"><script>', 'oklch(2 0.18 250)', 'oklch(0.6 1 250)', 'oklch(0.6 0.2 400)', null]) expect(() => calendarColor(value)).toThrow()
  })
  it('requires recognized ASCII timezones', () => {
    expect(calendarTimezone('UTC')).toBe('UTC')
    expect(calendarTimezone('Asia/Hebron')).toBe('Asia/Hebron')
    for (const value of ['Fake/Nowhere', 'UTC\nX-Injected:yes', 'UTC;evil', 'توقيت', null]) expect(() => calendarTimezone(value)).toThrow()
  })
  it('validates actual dates and time components rather than only the timestamp grammar', () => {
    for (const value of ['20260228', '20280229', '20261102T080000Z', '20261102T080000']) expect(calendarTimestamp(value, 'date')).toBe(value)
    for (const value of ['20260230', '20260229', '20261301', '20261102T250000Z', '20261102T126099Z', '\u0662\u0660\u0662\u0666\u0661\u0661\u0660\u0662', '00000101', '2026-11-02']) expect(() => calendarTimestamp(value, 'date')).toThrow()
  })
  it('preserves existing external UIDs and rejects sealed metadata injection or foreign event IDs', () => {
    const source = calendar().events!
    const draft = { id: id(2), summary: 'Updated', description: 'Source stays text', location: '', dtstart: '20261102T080000Z', dtend: '20261102T090000Z', timezone: 'UTC' }
    expect(calendarEventsFromDraft([draft], source, 'UTC', true)[0]).toMatchObject({ id: id(2), uid: source[0]!.uid, summary: 'Updated' })
    expect(() => calendarEventsFromDraft([{ ...draft, uid: 'forged' }], source, 'UTC', true)).toThrow()
    expect(() => calendarEventsFromDraft([{ ...draft, id: id(9) }], source, 'UTC', true)).toThrow()
    expect(() => calendarEventsFromDraft([{ ...draft, dtend: '20261101T080000Z' }], source, 'UTC', true)).toThrow()
    expect(() => calendarEventsFromDraft([draft, draft], source, 'UTC', true)).toThrow()
  })
  it('allocates fresh event identities only for new drafts and enforces capacity', () => {
    const draft = { summary: 'New event', dtstart: '20261102', dtend: '20261103' }
    const events = calendarEventsFromDraft([draft], [], 'UTC', true)
    expect(events[0]!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(events[0]!.uid).toMatch(/^[0-9a-f-]{36}$/)
    expect(events[0]!.timezone).toBe('UTC')
    expect(() => calendarEventsFromDraft(Array.from({ length: CALENDAR_LIMITS.events + 1 }, () => draft), [], 'UTC', true)).toThrow()
  })
  it('binds revisions to the persisted calendar while ignoring other mailbox collections', () => {
    const own = calendar(), foreign = calendar({ id: id(7), owner: 'other@example.test' })
    expect(calendarWorkspaceRevision(own)).toMatch(/^[0-9a-f]{64}$/)
    expect(calendarWorkspaceRevision({ ...own, name: 'Changed' })).not.toBe(calendarWorkspaceRevision(own))
    expect(calendarCollectionRevision([own, foreign], authority())).toBe(calendarCollectionRevision([own], authority()))
    expect(calendarCollectionRevision([{ ...own, name: 'Changed' }], authority())).not.toBe(calendarCollectionRevision([own], authority()))
    const unbound = calendar({ id: id(8), ownerAuthority: undefined }), former = calendar({ id: id(9), ownerAuthority: authority(own.owner, 99) })
    expect(calendarCollectionRevision([own, unbound, former], authority())).toBe(calendarCollectionRevision([own], authority()))
    expect(calendarWorkspaceRevision(unbound)).not.toBe(calendarWorkspaceRevision({ ...unbound, ownerAuthority: authority() }))
    expect(calendarCollectionRevision([], authority())).not.toBe(calendarCollectionRevision([], authority(own.owner, 99)))
  })
  it('projects only owner-visible sharing and explicit read/write permissions', () => {
    const sibling = authority('sibling@example.test', 22), reader = authority('private@example.test', 23)
    const source = calendar({ shares: [{ principal: sibling.mailbox, granteeAuthority: sibling, permission: 'read-write', sharedAt: '2026-10-26T12:00:00Z' }, { principal: reader.mailbox, granteeAuthority: reader, permission: 'read', sharedAt: '2026-10-26T12:00:00Z' }] })
    const projected = projectCalendarWorkspace(source, authority(), authority(), new Map([[sibling.mailbox, true], [reader.mailbox, true]]))
    expect(projected).toMatchObject({ canWrite: true, canManage: true, shares: [{ principal: sibling.mailbox, effective: true }, { principal: reader.mailbox, effective: true }] })
    expect(JSON.stringify(projected)).not.toContain(authority().serviceUserId)
    expect(projectCalendarWorkspace(source, sibling, authority())).toMatchObject({ canWrite: true, canManage: false, shares: [] })
    expect(projectCalendarWorkspace(source, reader, authority())).toMatchObject({ canWrite: false, canManage: false, shares: [] })
    expect(() => projectCalendarWorkspace({ ...source, ownerAuthority: undefined }, authority())).toThrow()
    expect(() => projectCalendarWorkspace(source, authority(source.owner, 99))).toThrow()
    expect(() => projectCalendarWorkspace({ ...source, shares: [{ ...source.shares[0]!, granteeAuthority: undefined }] }, sibling, authority())).toThrow()
    expect(() => projectCalendarWorkspace({ ...source, ownerAuthority: authority(source.owner, 99) }, sibling, authority())).toThrow()
  })
})
