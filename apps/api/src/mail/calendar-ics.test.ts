import { describe, expect, it } from 'vitest'
import type { WebmailCalendar } from '../extended-routes.ts'
import { calendarLocalToUtc, foldCalendarLine, parseCalendarWorkspaceIcs, renderCalendarWorkspaceIcs } from './calendar-ics.ts'
const calendar = (): WebmailCalendar => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', owner: 'inbox@example.test', name: 'Work, notes; review', color: '#112233', timezone: 'UTC', shares: [], createdAt: '2026-10-26T12:00:00Z', events: [
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', uid: 'original-uid@example.test', summary: 'Review, notes; plans', description: 'Line one\nLine two \\ source', location: 'Office; room 1', dtstart: '20261102T080000Z', dtend: '20261102T090000Z', timezone: 'UTC' },
] })
describe('bounded iCalendar interchange', () => {
  it('round-trips supported text, UTC timestamps and original external UIDs', () => {
    const source = calendar(), output = renderCalendarWorkspaceIcs(source, new Date('2026-10-26T12:34:56Z'))
    expect(output).toContain('METHOD:PUBLISH\r\n')
    expect(output).toContain('DTSTAMP:20261026T123456Z')
    expect(output).toContain('DTSTART:20261102T080000Z')
    expect(output).not.toContain('DTSTART;TZID=UTC:')
    expect(output).toContain('SUMMARY:Review\\, notes\\; plans')
    const parsed = parseCalendarWorkspaceIcs(output, 'UTC')
    expect(parsed[0]).toMatchObject({ uid: source.events![0]!.uid, summary: source.events![0]!.summary, description: source.events![0]!.description, location: source.events![0]!.location, dtstart: source.events![0]!.dtstart, dtend: source.events![0]!.dtend })
  })
  it('folds by UTF-8 octets without splitting Arabic characters and unfolds correctly', () => {
    const source = calendar(); source.events![0]!.summary = 'مراجعة '.repeat(18).trim()
    const output = renderCalendarWorkspaceIcs(source)
    for (const line of output.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75)
    expect(parseCalendarWorkspaceIcs(output, 'UTC')[0]!.summary).toBe(source.events![0]!.summary)
    expect(foldCalendarLine('SUMMARY:' + 'x'.repeat(200))).toContain('\r\n ')
  })
  it('exports all-day dates with VALUE=DATE and converts civil timezone times to UTC', () => {
    const source = calendar(); source.events![0] = { ...source.events![0]!, dtstart: '20261102', dtend: '20261103' }
    expect(renderCalendarWorkspaceIcs(source)).toContain('DTSTART;VALUE=DATE:20261102')
    expect(calendarLocalToUtc('20261102T080000', 'Asia/Tokyo')).toBe('20261101T230000Z')
    expect(calendarLocalToUtc('20261101T013000', 'America/New_York')).toBe('20261101T053000Z')
    expect(() => calendarLocalToUtc('20260308T023000', 'America/New_York')).toThrow()
  })
  it('refuses recurrence, alarms, attachments and duplicate event properties without silently dropping them', () => {
    const original = renderCalendarWorkspaceIcs(calendar())
    for (const line of ['RRULE:FREQ=DAILY', 'ATTACH:file:///etc/passwd', 'ATTENDEE:mailto:a@example.test', 'BEGIN:VALARM', 'SUMMARY:Duplicate']) expect(() => parseCalendarWorkspaceIcs(original.replace('END:VEVENT', line + '\r\nEND:VEVENT'), 'UTC')).toThrow()
    expect(() => parseCalendarWorkspaceIcs(original.replace('DTSTART:20261102T080000Z', 'DTSTART;TZID=UTC:20261102T080000Z'), 'UTC')).toThrow()
  })
})
