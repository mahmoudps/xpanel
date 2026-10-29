// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMailCalendarView } from './board-port/xmail-calendar-view.ts'
import {
  MAIL_CALENDAR_VIEW_CLIENT_BINDING, calendarDayNumber, calendarDayString, calendarEventSpan, calendarInstant, calendarIsoWeek, calendarPlaceEvents,
  calendarRange, calendarShift, calendarWeekday, readCalendarViewWorkspace,
} from './mail-calendar-view-client.ts'

const MAILBOX = 'owner@example.test'
const hostZone = process.env.TZ
const day = (value: string): number => calendarDayNumber(value)
const range = (mode: 'month' | 'week' | 'day', anchor: string) => { const { first, last } = calendarRange(mode, day(anchor)); return [calendarDayString(first), calendarDayString(last), last - first + 1] }
const id = (number: number): string => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(number).padStart(12, '0')
const rev = (number: number): string => String(number).padStart(64, '0')
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const tick = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
type StoredEvent = { id: string; uid: string; summary: string; description: string; location: string; dtstart: string; dtend: string; timezone: string }
const event = (number: number, patch: Partial<StoredEvent> = {}): StoredEvent => ({ id: id(100 + number), uid: 'uid-' + number + '@example.test', summary: 'Event ' + number, description: '', location: '', dtstart: '20261102T090000', dtend: '20261102T110000', timezone: 'America/New_York', ...patch })
const calendar = (patch: Record<string, unknown> = {}) => ({ id: id(1), owner: MAILBOX, name: 'Work', color: '#4f6bed', timezone: 'UTC', revision: rev(1), storedBytes: 300, canWrite: true, canManage: true,
  events: [event(1)], shares: [] as unknown[], createdAt: '2026-10-26T12:00:00Z', ...patch })
const envelope = { context: { mailbox: MAILBOX }, application: { status: 'stored_configuration', nativeApplied: false, syncVerified: false } }

/** In-memory model of the sealed event routes, including the API's expectedRevision 409 rule. */
const server = (initial = [calendar()]) => {
  let records = clone(initial), serial = 10
  const send = vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
    if (method === 'GET' && path === '/api/webmail/calendars') return { ...envelope, calendars: clone(records), revision: rev(serial), limits: { calendars: 25, events: 1000, shares: 100, icsBytes: 262144, calendarBytes: 524288 } }
    const match = /^\/api\/webmail\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path), target = match ? records.find(record => record.id === match[1]) : undefined
    if (!match || !target || !body) throw Object.assign(new Error('not found'), { status: 404, details: { stateChanged: false } })
    if (body.expectedRevision !== target.revision) throw Object.assign(new Error('calendar changed; reload and review before retrying'), { status: 409, details: { stateChanged: false } })
    if (!target.canWrite) throw Object.assign(new Error('calendar share is read-only'), { status: 403, details: { stateChanged: false } })
    const fields = { summary: body.summary, description: body.description, location: body.location, dtstart: body.dtstart, dtend: body.dtend, timezone: body.timezone } as Omit<StoredEvent, 'id' | 'uid'>
    let result: StoredEvent | undefined
    if (method === 'DELETE') target.events = target.events.filter(item => item.id !== match[2])
    else if (method === 'PATCH') { const index = target.events.findIndex(item => item.id === match[2]); result = { ...target.events[index]!, ...fields }; target.events[index] = result }
    else { result = { id: id(500 + serial), uid: 'new-' + serial + '@example.test', ...fields }; target.events.push(result) }
    target.revision = rev(++serial)
    return { ...envelope, calendar: clone(target), ...(result ? { event: clone(result) } : { ok: true, deletedEventId: match[2] }) }
  })
  return { send, records: () => records, writes: () => send.mock.calls.filter(call => call[0] !== 'GET'), elsewhere: () => { records[0]!.revision = rev(++serial); records[0]!.events[0]!.summary = 'Changed elsewhere' } }
}
const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const cell = (value: string) => $(`[data-calview-day="${value}"]`)
const status = () => $('[data-calview-status]')
const set = (key: string, value: string) => { $<HTMLInputElement>(`[data-calview-field="${key}"]`).value = value }
const key = (target: Element, name: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
const boot = (send?: unknown, options: { locale?: 'en' | 'ar'; canManage?: boolean } = {}) => {
  const ask = vi.fn(async () => true)
  document.documentElement.lang = options.locale ?? 'en'; document.documentElement.dir = options.locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = renderMailCalendarView({ locale: options.locale ?? 'en', mailbox: MAILBOX, canManage: options.canManage ?? true })
  const host = window as Window & { xpanelSessionRequest?: unknown }
  if (send) host.xpanelSessionRequest = send; else delete host.xpanelSessionRequest
  new Function('return ' + MAIL_CALENDAR_VIEW_CLIENT_BINDING)()(ask)
  return ask
}

beforeAll(() => { process.env.TZ = 'UTC' })
afterAll(() => { if (hostZone === undefined) delete process.env.TZ; else process.env.TZ = hostZone })
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-04T12:00:00Z')); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('calendar date grid math', () => {
  it('validates dates with leap-year rules and round-trips day numbers', () => {
    for (const value of ['20240229', '20000229', '00010101', '99991231', '20261231']) expect(calendarDayString(day(value))).toBe(value)
    for (const value of ['20230229', '21000229', '19000229', '20261301', '20261100', '20260431', '00000101']) expect(day(value)).toBeNaN()
    expect(day('19700101')).toBe(0)
    expect(calendarWeekday(0)).toBe(3)
    expect(calendarWeekday(day('20261102'))).toBe(0)
    expect(calendarWeekday(day('20261108'))).toBe(6)
  })
  it('starts every view on an ISO Monday and covers month boundaries in whole weeks', () => {
    expect(range('month', '20261104')).toEqual(['20261026', '20261206', 42])
    expect(range('month', '20270215')).toEqual(['20270201', '20270228', 28])
    expect(range('month', '20240210')).toEqual(['20240129', '20240303', 35])
    expect(range('week', '20261104')).toEqual(['20261102', '20261108', 7])
    expect(range('week', '20261108')).toEqual(['20261102', '20261108', 7])
    expect(range('day', '20261104')).toEqual(['20261104', '20261104', 1])
  })
  it('moves by month with day-of-month clamping, and by week or day', () => {
    const shift = (mode: 'month' | 'week' | 'day', value: string, delta: number) => calendarDayString(calendarShift(mode, day(value), delta))
    expect(shift('month', '20240131', 1)).toBe('20240229')
    expect(shift('month', '20230131', 1)).toBe('20230228')
    expect(shift('month', '20260331', -1)).toBe('20260228')
    expect(shift('month', '20261215', 1)).toBe('20270115')
    expect(shift('month', '20260115', -1)).toBe('20251215')
    expect(shift('week', '20261229', 1)).toBe('20270105')
    expect(shift('day', '20240228', 1)).toBe('20240229')
  })
  it('numbers ISO 8601 weeks across year boundaries', () => {
    expect(calendarIsoWeek(day('20260101'))).toEqual({ year: 2026, week: 1 })
    expect(calendarIsoWeek(day('20251229'))).toEqual({ year: 2026, week: 1 })
    expect(calendarIsoWeek(day('20270101'))).toEqual({ year: 2026, week: 53 })
    expect(calendarIsoWeek(day('20241230'))).toEqual({ year: 2025, week: 1 })
    expect(calendarIsoWeek(day('20210103'))).toEqual({ year: 2020, week: 53 })
    expect(calendarIsoWeek(day('20261102'))).toEqual({ year: 2026, week: 45 })
  })
  it('builds the same grid in any host timezone, including daylight saving months', () => {
    const grids = () => ['20260315', '20261025', '20261101', '20240310'].map(value => range('month', value))
    const baseline = grids()
    for (const zone of ['America/New_York', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Lord_Howe']) { process.env.TZ = zone; expect(grids()).toEqual(baseline) }
    process.env.TZ = 'UTC'
    const { first, last } = calendarRange('month', day('20260315'))
    const labels = Array.from({ length: last - first + 1 }, (_, index) => calendarDayString(first + index))
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels).toContain('20260329')
  })
})

describe('calendar event placement', () => {
  it('converts wall times in the event timezone, with the API rule for skipped and repeated local times', () => {
    expect(calendarInstant('20261102T090000', 'America/New_York')).toBe(Date.UTC(2026, 10, 2, 14))
    expect(calendarInstant('20261102T090000Z', 'America/New_York')).toBe(Date.UTC(2026, 10, 2, 9))
    expect(calendarInstant('20261102T090000', 'UTC')).toBe(Date.UTC(2026, 10, 2, 9))
    expect(calendarInstant('20260308T023000', 'America/New_York')).toBeNaN()
    expect(calendarInstant('20261101T013000', 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 5, 30))
    expect(calendarInstant('20261102T250000', 'UTC')).toBeNaN()
  })
  it('places all-day dates with an exclusive end and timed events in the viewer timezone', () => {
    const span = (dtstart: string, dtend: string, timezone = 'UTC', viewer = 'UTC') => calendarEventSpan({ dtstart, dtend, timezone }, viewer)
    expect(span('20261102', '20261103')).toMatchObject({ allDay: true, startDay: day('20261102'), endDay: day('20261102') })
    expect(span('20261102', '20261102')).toMatchObject({ allDay: true, startDay: day('20261102'), endDay: day('20261102') })
    expect(span('20261102', '20261105')).toMatchObject({ endDay: day('20261104') })
    expect(span('20261102T090000', '20261102T110000', 'America/New_York', 'Asia/Tokyo')).toMatchObject({ allDay: false, startDay: day('20261102'), startMinutes: 23 * 60, endDay: day('20261103'), endMinutes: 60 })
    expect(span('20261102T220000Z', '20261103T000000Z')).toMatchObject({ startDay: day('20261102'), endDay: day('20261102'), endMinutes: 1440 })
    expect(span('20261102', '20261102T100000')).toBeNull()
    expect(span('20261102T100000', '20261102T090000')).toBeNull()
    expect(span('20261102T100000', '20261102T110000', 'Mars/Olympus')).toBeNull()
    expect(span('20260308T023000', '20260308T033000', 'America/New_York')).toBeNull()
  })
  it('orders all-day first, splits overlaps into lanes and continues multi-day segments', () => {
    const items = [['a', '20261102T090000Z', '20261102T100000Z'], ['b', '20261102T093000Z', '20261102T110000Z'], ['c', '20261102T130000Z', '20261102T140000Z'], ['d', '20261102', '20261103'], ['e', '20261103T220000Z', '20261104T020000Z']]
      .map(([item, dtstart, dtend]) => ({ item: item!, span: calendarEventSpan({ dtstart: dtstart!, dtend: dtend!, timezone: 'UTC' }, 'UTC')! }))
    const [monday, tuesday, wednesday] = calendarPlaceEvents(items, day('20261102'), day('20261104'))
    expect(monday!.allDay.map(entry => entry.item)).toEqual(['d'])
    expect(monday!.timed.map(entry => [entry.item, entry.lane, entry.lanes])).toEqual([['a', 0, 2], ['b', 1, 2], ['c', 0, 1]])
    expect(tuesday!.timed.map(entry => [entry.item, entry.from, entry.to])).toEqual([['e', 1320, 1440]])
    expect(wednesday!.timed.map(entry => [entry.item, entry.from, entry.to])).toEqual([['e', 0, 120]])
  })
  it('accepts only the sealed mailbox workspace', () => {
    const value = { ...envelope, calendars: [calendar()], revision: rev(10), limits: { calendars: 25, events: 1000, shares: 100, icsBytes: 262144, calendarBytes: 524288 } }
    expect(readCalendarViewWorkspace(value, MAILBOX).calendars[0]!.events).toHaveLength(1)
    for (const bad of [{ ...value, context: { mailbox: 'other@example.test' } }, { ...value, application: { ...envelope.application, nativeApplied: true } }, { ...value, calendars: [calendar({ canManage: false })] }, { ...value, calendars: [calendar({ events: [event(1), event(1)] })] }, { ...value, unknownOutcome: true }])
      expect(() => readCalendarViewWorkspace(bad, MAILBOX)).toThrow()
  })
})

describe('xMail calendar view', () => {
  it('renders English and Arabic with Monday-first headers, RTL and ASCII digits only', async () => {
    expect(MAIL_CALENDAR_VIEW_CLIENT_BINDING).not.toContain('innerHTML')
    expect(MAIL_CALENDAR_VIEW_CLIENT_BINDING).not.toContain('fetch(')
    for (const locale of ['en', 'ar'] as const) {
      const html = renderMailCalendarView({ locale, mailbox: MAILBOX, canManage: true })
      expect(html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`)
      expect(html).not.toMatch(/[٠-٩۰-۹]/)
      boot(server().send, { locale }); await tick()
      const headers = [...document.querySelectorAll('[role="columnheader"] .xp-mail-calview__long')].map(node => node.textContent)
      expect(headers[0]).toBe(locale === 'ar' ? 'الاثنين' : 'Monday')
      expect(headers[6]).toBe(locale === 'ar' ? 'الأحد' : 'Sunday')
      expect($('[data-calview-range]').textContent).toBe(locale === 'ar' ? 'نوفمبر 2026' : 'November 2026')
      expect($('[data-calview-range] bdi').getAttribute('dir')).toBe('ltr')
      expect(cell('20261104').getAttribute('aria-label')).toBe(locale === 'ar' ? 'الأربعاء 2026-11-04، اليوم، لا أحداث' : 'Wednesday 2026-11-04, today, no events')
      expect(cell('20261102').getAttribute('aria-label')).toBe(locale === 'ar' ? 'الاثنين 2026-11-02، حدث واحد' : 'Monday 2026-11-02, 1 event')
      expect($('[data-calview-legend]').textContent).toContain(locale === 'ar' ? ' · الأحداث: 1' : ' · 1 events')
      expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
      expect(status().dataset.state).toBe('read')
    }
    expect(renderMailCalendarView({ locale: 'en', mailbox: '"><x>', canManage: false })).not.toContain('"><x>')
  })

  it('places events in the grid and shows the event time beside the viewer time', async () => {
    boot(server().send); await tick()
    expect(document.querySelectorAll('[role="gridcell"]')).toHaveLength(42)
    expect(cell('20261102').getAttribute('aria-label')).toBe('Monday 2026-11-02, 1 event')
    const chip = cell('20261102').querySelector<HTMLButtonElement>('[data-calview-item]')!
    expect(chip.textContent).toBe('14:00Event 1')
    expect(chip.querySelector('bdi')!.getAttribute('dir')).toBe('ltr')
    chip.click()
    expect($('[data-calview-event]').hidden).toBe(false)
    const facts = $('[data-calview-event-facts]').textContent
    expect(facts).toContain('Your time (UTC)2026-11-02 14:00 – 16:00')
    expect(facts).toContain('Event time (America/New_York)2026-11-02 09:00 – 11:00')
    expect($('[data-calview-event]').textContent).toContain('Recurrence, attendees and alarms are not supported here')
    $<HTMLButtonElement>('[data-calview-mode="week"]').click()
    expect(document.querySelectorAll('[role="gridcell"]')).toHaveLength(7)
    expect($('[data-calview-range]').textContent).toBe('Week 45 · 2026-11-02 – 2026-11-08')
    const timed = cell('20261102').querySelector<HTMLElement>('[data-calview-item]')!
    expect(timed.style.getPropertyValue('--calview-top')).toMatch(/^58\.33/)
    $<HTMLButtonElement>('[data-calview-mode="day"]').click()
    expect(document.querySelectorAll('[role="gridcell"]')).toHaveLength(1)
  })

  it('moves between days with arrow keys, mirrors them in RTL and opens a day with Enter', async () => {
    boot(server().send); await tick()
    expect(document.querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1)
    key(cell('20261104'), 'ArrowRight'); expect((document.activeElement as HTMLElement).dataset.calviewDay).toBe('20261105')
    key(document.activeElement!, 'ArrowDown'); expect((document.activeElement as HTMLElement).dataset.calviewDay).toBe('20261112')
    for (let index = 0; index < 4; index++) key(document.activeElement!, 'ArrowUp')
    expect((document.activeElement as HTMLElement).dataset.calviewDay).toBe('20261015')
    expect($('[data-calview-range]').textContent).toBe('October 2026')
    key(cell('20261015'), 'ArrowRight'); key(document.activeElement!, 'ArrowLeft')
    key(document.activeElement!, 'Enter')
    expect($('[data-calview-agenda]').hidden).toBe(false)
    expect($('[data-calview-detail-heading]').textContent).toBe('Thursday 2026-10-15')
    expect(document.activeElement).toBe($('[data-calview-detail]'))
    key(document.activeElement!, 'Escape')
    expect($('[data-calview-detail]').hidden).toBe(true)
    $<HTMLButtonElement>('[data-calview-nav="today"]').click()
    key(cell('20261102'), 'Enter')
    expect($('[data-calview-agenda-list]').textContent).toContain('Event 1')
    boot(server().send, { locale: 'ar' }); await tick()
    key(cell('20261104'), 'ArrowLeft'); expect((document.activeElement as HTMLElement).dataset.calviewDay).toBe('20261105')
    key(document.activeElement!, 'ArrowRight'); expect((document.activeElement as HTMLElement).dataset.calviewDay).toBe('20261104')
    $<HTMLButtonElement>('[data-calview-mode="week"]').click()
    expect($('[data-calview-range]').textContent).toBe('الأسبوع 45 · 2026-11-02 – 2026-11-08')
  })

  it('creates, edits and deletes single events with the revision read from the workspace', async () => {
    const api = server(), ask = boot(api.send); await tick()
    $<HTMLButtonElement>('[data-calview-new]').click()
    expect($<HTMLSelectElement>('[data-calview-field="calendar"]').value).toBe(id(1))
    expect($<HTMLInputElement>('[data-calview-field="start-date"]').value).toBe('2026-11-04')
    set('summary', 'Planning'); $<HTMLButtonElement>('[data-calview-save]').click(); await tick()
    expect(api.writes()[0]).toEqual(['POST', `/api/webmail/calendars/${id(1)}/events`, { summary: 'Planning', description: '', location: '', timezone: 'UTC', dtstart: '20261104T090000Z', dtend: '20261104T100000Z', expectedRevision: rev(1) }])
    expect(status().dataset.state).toBe('saved')
    expect(cell('20261104').textContent).toContain('Planning')
    $<HTMLButtonElement>('[data-calview-edit]').click()
    expect($<HTMLInputElement>('[data-calview-field="summary"]').value).toBe('Planning')
    $<HTMLInputElement>('[data-calview-field="all-day"]').click()
    expect($<HTMLInputElement>('[data-calview-field="start-time"]').disabled).toBe(true)
    set('start-date', '2026-11-05'); set('end-date', '2026-11-06'); $<HTMLButtonElement>('[data-calview-save]').click(); await tick()
    const created = api.records()[0]!.events[1]!
    expect(api.writes()[1]).toEqual(['PATCH', `/api/webmail/calendars/${id(1)}/events/${created.id}`, { summary: 'Planning', description: '', location: '', timezone: 'UTC', dtstart: '20261105', dtend: '20261107', expectedRevision: rev(11) }])
    expect(cell('20261106').textContent).toContain('Planning')
    expect(cell('20261107').textContent).not.toContain('Planning')
    $<HTMLButtonElement>('[data-calview-delete]').click(); await tick()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(api.writes()[2]).toEqual(['DELETE', `/api/webmail/calendars/${id(1)}/events/${created.id}`, { expectedRevision: rev(12) }])
    expect(status().dataset.state).toBe('deleted')
    expect(document.querySelector('[data-calview-grid]')!.textContent).not.toContain('Planning')
  })

  it('reports a revision conflict, keeps edits and never overwrites or retries', async () => {
    const api = server(), ask = boot(api.send); await tick()
    api.elsewhere()
    cell('20261102').querySelector<HTMLButtonElement>('[data-calview-item]')!.click()
    $<HTMLButtonElement>('[data-calview-edit]').click()
    set('summary', 'Mine'); $<HTMLButtonElement>('[data-calview-save]').click(); await tick()
    expect(status().dataset.state).toBe('stale')
    expect(status().getAttribute('role')).toBe('alert')
    expect(status().textContent).toContain('nothing was overwritten')
    expect($<HTMLInputElement>('[data-calview-field="summary"]').value).toBe('Mine')
    expect($<HTMLButtonElement>('[data-calview-save]').disabled).toBe(true)
    $<HTMLButtonElement>('[data-calview-save]').click(); await tick()
    expect(api.writes()).toHaveLength(1)
    expect(api.records()[0]!.events[0]!.summary).toBe('Changed elsewhere')
    $<HTMLButtonElement>('[data-calview-refresh]').click(); await tick()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(status().dataset.state).toBe('read')
    expect($('[data-calview-editor]').hidden).toBe(true)
    expect(cell('20261102').textContent).toContain('Changed elsewhere')
  })

  it('refuses a local time skipped by daylight saving before sending', async () => {
    const api = server(); boot(api.send); await tick()
    $<HTMLButtonElement>('[data-calview-new]').click()
    set('summary', 'Gap'); set('timezone', 'America/New_York'); set('start-date', '2026-03-08'); set('start-time', '02:30'); set('end-date', '2026-03-08'); set('end-time', '03:30')
    $<HTMLButtonElement>('[data-calview-save]').click(); await tick()
    expect(api.writes()).toHaveLength(0)
    expect(status().dataset.state).toBe('failed')
    expect(status().textContent).toContain('daylight saving')
    set('timezone', 'Not a zone'); $<HTMLButtonElement>('[data-calview-save]').click(); await tick()
    expect(api.writes()).toHaveLength(0)
  })

  it('stays inert without qualification or transport and read-only for shared calendars', async () => {
    const api = server()
    boot(api.send, { canManage: false }); await tick()
    expect(api.send).not.toHaveBeenCalled()
    expect(status().dataset.state).toBe('unavailable')
    expect([...document.querySelectorAll<HTMLButtonElement>('[data-mail-calendar-view] button')].every(control => control.disabled)).toBe(true)
    expect(document.querySelectorAll('[role="gridcell"]')).toHaveLength(42)
    boot(undefined); await tick()
    expect(status().dataset.state).toBe('unavailable')
    const shared = server([calendar({ owner: 'boss@example.test', canManage: false, canWrite: false })])
    boot(shared.send); await tick()
    expect($<HTMLButtonElement>('[data-calview-new]').disabled).toBe(true)
    cell('20261102').querySelector<HTMLButtonElement>('[data-calview-item]')!.click()
    expect($('[data-calview-event-facts]').textContent).toContain('Shared: read only')
    expect($<HTMLButtonElement>('[data-calview-edit]').disabled).toBe(true)
    expect($<HTMLButtonElement>('[data-calview-delete]').disabled).toBe(true)
    expect(shared.writes()).toHaveLength(0)
  })
})
