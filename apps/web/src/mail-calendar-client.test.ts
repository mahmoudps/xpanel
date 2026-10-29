// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMailCalendarWorkspace } from './board-port/xmail-calendar.ts'
import { MAIL_CALENDAR_CLIENT_BINDING } from './mail-calendar-client.ts'

const mailbox = 'inbox@example.test'
const id = (number: number): string => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(number).padStart(12, '0')
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const button = (key: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>('[data-calendar-' + key + ']')!
const field = (key: string): HTMLInputElement => document.querySelector<HTMLInputElement>('[data-calendar-' + key + ']')!
const status = (): HTMLElement => document.querySelector<HTMLElement>('[data-calendar-status]')!
const set = (key: string, value: string): void => { field(key).value = value; field(key).dispatchEvent(new Event('input', { bubbles: true })) }
const calendar = (patch: Record<string, unknown> = {}) => ({ id: id(1), owner: mailbox, name: 'Work', color: '#4f6bed', timezone: 'UTC', revision: '1'.padStart(64, '0'), storedBytes: 300, canWrite: true, canManage: true,
  events: [] as Array<{ id: string; uid: string; summary: string; description: string; location: string; dtstart: string; dtend: string; timezone: string }>,
  shares: [] as Array<{ principal: string; permission: string; sharedAt: string; effective: boolean }>, createdAt: '2026-10-26T12:00:00Z', ...patch })
let unload: EventListener[]
beforeEach(() => {
  unload = []
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, listener, options) => { if (name === 'beforeunload') unload.push(listener as EventListener); add(name, listener, options) })
  document.body.innerHTML = renderMailCalendarWorkspace({ locale: 'en', mailbox, canManage: true })
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})
afterEach(() => { for (const listener of unload) window.removeEventListener('beforeunload', listener); vi.restoreAllMocks(); document.body.replaceChildren() })

const model = () => {
  let records = [calendar()], serial = 1, mode = 'normal', contextMailbox = mailbox
  const application = { status: 'stored_configuration', nativeApplied: false, syncVerified: false }
  const envelope = () => ({ context: { mailbox: contextMailbox }, application })
  const send = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (method === 'GET' && path === '/api/webmail/calendars') return { ...envelope(), calendars: clone(records), revision: String(serial).padStart(64, '0'), limits: { calendars: 25, events: 1000, shares: 100, icsBytes: 262144, calendarBytes: 524288 } }
    const targetId = path.split('/')[4], target = records.find(record => record.id === targetId), value = body as Record<string, unknown>
    if (method === 'GET' && path.endsWith('/export')) return { ...envelope(), calendarId: target!.id, revision: target!.revision, eventsCount: target!.events.length, ics: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n' }
    if (mode === 'denied') throw { status: 422, details: { stateChanged: false } }
    if (mode === 'too-large') throw { status: 413, details: { stateChanged: false } }
    if (mode === 'uncertain') throw { status: 503, details: { stateChanged: true, unknownOutcome: true } }
    if (mode === 'stale') throw { status: 409, details: { stateChanged: false } }
    serial++
    if (method === 'DELETE' && !path.endsWith('/share') && !path.includes('/events/')) { records = records.filter(record => record.id !== targetId); return { ...envelope(), ok: true, calendarId: targetId } }
    let saved = target ? clone(target) : calendar({ id: id(2), owner: mailbox, name: value.name, color: value.color, timezone: value.timezone })
    let responseEvent: typeof saved.events[number] | undefined, deletedEventId: string | undefined
    if (path.includes('/events')) {
      const eventId = path.split('/')[6], previous = saved.events.find(event => event.id === eventId)
      if (method === 'DELETE') { saved.events = saved.events.filter(event => event.id !== eventId); deletedEventId = eventId }
      else {
        responseEvent = { id: previous?.id ?? id(10), uid: previous?.uid ?? 'new-event@example.test', summary: value.summary as string,
          description: (value.description as string | undefined) ?? '', location: (value.location as string | undefined) ?? '', dtstart: value.dtstart as string,
          dtend: (value.dtend as string | undefined) ?? value.dtstart as string, timezone: (value.timezone as string | undefined) ?? saved.timezone }
        saved.events = previous ? saved.events.map(event => event.id === previous.id ? responseEvent! : event) : [...saved.events, responseEvent]
      }
    } else if (path.endsWith('/share')) {
      saved.shares = saved.shares.filter(share => share.principal !== value.principal)
      if (method !== 'DELETE') saved.shares.push({ principal: value.principal as string, permission: value.permission as string, effective: true, sharedAt: '2026-10-26T12:30:00Z' })
    } else if (path.endsWith('/import')) {
      saved.events.push({ id: id(9), uid: 'imported@example.test', summary: 'Imported', description: '', location: '', dtstart: '20261102', dtend: '20261103', timezone: 'UTC' })
    } else {
      for (const key of ['name', 'color', 'timezone'] as const) if (value[key] !== undefined) saved[key] = value[key] as string
      if (Array.isArray(value.events)) saved.events = value.events.map((event, index) => ({ ...event, id: event.id ?? id(10 + index), uid: saved.events.find(previous => previous.id === event.id)?.uid ?? 'new-' + index + '@example.test' }))
    }
    saved.revision = String(serial).padStart(64, '0')
    records = [...records.filter(record => record.id !== saved.id), saved]
    return { ...envelope(), calendar: clone(mode === 'wrong-ack' ? { ...saved, id: id(99) } : saved), ...(responseEvent ? { event: clone(responseEvent) } : {}), ...(deletedEventId ? { ok: true, deletedEventId } : {}) }
  })
  const ask = vi.fn(async () => true)
  const boot = (): void => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + MAIL_CALENDAR_CLIENT_BINDING)()(ask) }
  return { send, ask, boot, setMode: (value: string) => { mode = value }, setContext: (value: string) => { contextMailbox = value }, setRecords: (value: ReturnType<typeof calendar>[]) => { records = value }, writes: () => send.mock.calls.filter(call => call[0] !== 'GET') }
}

describe('mail calendar workspace browser binding', () => {
  it('constructs without browser imports and reads initially without a discard prompt or fabricated data', async () => {
    expect(() => new Function('return ' + MAIL_CALENDAR_CLIENT_BINDING)()).not.toThrow()
    expect(MAIL_CALENDAR_CLIENT_BINDING).not.toContain('innerHTML')
    expect(MAIL_CALENDAR_CLIENT_BINDING).not.toContain('fetch(')
    const f = model(); f.boot(); await tick()
    expect(status().dataset.state).toBe('read')
    expect(document.querySelector('[data-calendar-capacity]')!.textContent).toMatch(/^\d+ \/ \d+ owned calendars( · \d+ \/ \d+ events · \d+ \/ \d+ bytes)?$/)
    expect(f.ask).not.toHaveBeenCalled()
    expect(field('name').value).toBe('Work')
    expect(document.body.textContent).not.toContain(id(1))
    expect(button('event-save').disabled).toBe(true)
  })
  it('shows standing ownership guidance and withheld historical shares without claiming current access', async () => {
    const f = model()
    f.setRecords([calendar({ shares: [{ principal: 'sibling@example.test', permission: 'read-write', sharedAt: '2026-10-26T12:00:00Z', effective: false }] })])
    f.boot(); await tick()
    expect(document.querySelector('[data-calendar-authority-guidance]')?.textContent).toContain('Older records without verified mailbox ownership are preserved')
    expect(document.querySelector('[data-calendar-shares]')?.textContent).toContain('Access withheld')
    expect(f.writes()).toEqual([])
    set('share-principal', 'sibling@example.test')
    const permission = document.querySelector<HTMLSelectElement>('[data-calendar-share-permission]')!
    permission.value = 'read-write'; permission.dispatchEvent(new Event('change', { bubbles: true }))
    button('share').click(); await tick()
    expect(status().dataset.state).toBe('saved')
    expect(document.querySelector('[data-calendar-shares]')?.textContent).not.toContain('Access withheld')
  })
  it('does not call the transport from an unavailable capability or missing session transport', async () => {
    new Function('return ' + MAIL_CALENDAR_CLIENT_BINDING)()(undefined)
    expect(status().dataset.state).toBe('unavailable')
    expect(button('save').disabled).toBe(true)
    document.querySelector<HTMLElement>('[data-mail-calendar]')!.removeAttribute('data-calendar-bound')
    document.querySelector<HTMLElement>('[data-mail-calendar]')!.dataset.calendarManage = 'false'
    const f = model(); f.boot(); await tick(); expect(f.send).not.toHaveBeenCalled()
  })
  it('pins response context to the mailbox and keeps malformed reads unavailable', async () => {
    const f = model(); f.setContext('other@example.test'); f.boot(); await tick()
    expect(status().dataset.state).toBe('failed')
    expect(button('save').disabled).toBe(true)
    expect(f.writes()).toHaveLength(0)
  })
  it('saves real settings with captured revision, lowercase HEX and coherent readback', async () => {
    const f = model(); f.boot(); await tick(); set('name', 'Renamed'); set('color', '#AABBCC')
    button('save').click(); await tick(); await tick()
    expect(f.writes()).toHaveLength(1)
    expect(f.writes()[0]).toEqual(['PATCH', '/api/webmail/calendars/' + id(1), { name: 'Renamed', color: '#aabbcc', timezone: 'UTC', expectedRevision: '1'.padStart(64, '0') }])
    expect(status().dataset.state).toBe('saved')
    expect(field('name').value).toBe('Renamed')
  })
  it('creates and deletes an owned calendar without exposing internal IDs as labels', async () => {
    const f = model(); f.boot(); await tick(); button('new').click(); await tick()
    set('name', 'Personal'); button('save').click(); await tick(); await tick()
    expect(f.writes()[0]).toEqual(['POST', '/api/webmail/calendars', { name: 'Personal', color: '#4f6bed', timezone: 'UTC', expectedRevision: '1'.padStart(64, '0') }])
    expect(status().dataset.state).toBe('saved')
    button('delete').click(); await tick(); await tick()
    expect(f.writes()[1]).toEqual(['DELETE', '/api/webmail/calendars/' + id(2), { expectedRevision: '2'.padStart(64, '0') }])
    expect(status().dataset.state).toBe('deleted')
    expect(document.body.textContent).not.toContain(id(2))
  })
  it('retains settings and new-event drafts when confirmation is cancelled', async () => {
    const f = model(); f.boot(); await tick(); f.ask.mockResolvedValue(false)
    set('name', 'Pending'); button('save').click(); await tick()
    expect(f.writes()).toHaveLength(0); expect(field('name').value).toBe('Pending')
    set('event-summary', 'Pending event'); set('event-start', '20261102'); button('event-new').click(); await tick()
    expect(field('event-summary').value).toBe('Pending event')
    expect(f.ask).toHaveBeenCalledTimes(2)
  })
  it('adds, edits and removes event records without injecting an external UID', async () => {
    const f = model(); f.boot(); await tick()
    set('event-summary', 'Review'); set('event-start', '20261102T080000Z'); set('event-end', '20261102T090000Z'); set('event-description', 'Line one\nLine two')
    button('event-save').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('saved')
    expect(f.writes()[0]!.slice(0, 2)).toEqual(['POST', '/api/webmail/calendars/' + id(1) + '/events'])
    const first = f.writes()[0]![2] as Record<string, unknown>
    expect(first).toMatchObject({ summary: 'Review', description: 'Line one\nLine two' })
    expect(first).not.toHaveProperty('uid'); expect(first).not.toHaveProperty('events')
    const select = document.querySelector<HTMLSelectElement>('[data-calendar-event-select]')!
    select.value = id(10); select.dispatchEvent(new Event('change', { bubbles: true })); await tick()
    set('event-summary', 'Updated'); button('event-save').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('saved')
    select.value = id(10); select.dispatchEvent(new Event('change', { bubbles: true })); await tick()
    button('event-delete').click(); await tick(); await tick()
    expect(f.writes()[1]!.slice(0, 2)).toEqual(['PATCH', '/api/webmail/calendars/' + id(1) + '/events/' + id(10)])
    expect(f.writes()[2]).toEqual(['DELETE', '/api/webmail/calendars/' + id(1) + '/events/' + id(10), { expectedRevision: '3'.padStart(64, '0') }])
    expect(status().dataset.state).toBe('saved')
  })
  it.each(['uncertain', 'wrong-ack', 'stale'])('preserves the draft and refuses retry after %s', async mode => {
    const f = model(); f.boot(); await tick(); set('name', 'Pending'); f.setMode(mode)
    button('save').click(); await tick(); await tick()
    expect(status().dataset.state).toBe(mode === 'stale' ? 'stale' : 'uncertain')
    expect(field('name').value).toBe('Pending'); expect(button('save').disabled).toBe(true)
    button('save').click(); expect(f.writes()).toHaveLength(1)
    f.ask.mockResolvedValue(false); button('refresh').click(); await tick()
    expect(field('name').value).toBe('Pending'); expect(button('save').disabled).toBe(true)
  })
  it('leaves a definitely refused draft editable', async () => {
    const f = model(); f.boot(); await tick(); set('name', 'Pending'); f.setMode('denied')
    button('save').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('failed'); expect(field('name').value).toBe('Pending'); expect(button('save').disabled).toBe(false)
  })
  it('treats a transport size refusal as definite and keeps the draft editable', async () => {
    const f = model(); f.boot(); await tick(); set('name', 'Pending'); f.setMode('too-large')
    button('save').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('failed'); expect(button('save').disabled).toBe(false)
    expect(field('name').value).toBe('Pending')
  })
  it('edits one event in an oversized legacy calendar without resending the other events', async () => {
    const event = { id: id(10), uid: 'legacy@example.test', summary: 'Legacy', description: 'Preserved note', location: '', dtstart: '20261102T080000Z', dtend: '20261102T090000Z', timezone: 'UTC' }
    const f = model(); f.setRecords([calendar({ storedBytes: 600000, events: [event] })]); f.boot(); await tick()
    expect(button('event-new').disabled).toBe(true)
    const select = document.querySelector<HTMLSelectElement>('[data-calendar-event-select]')!; select.value = event.id; select.dispatchEvent(new Event('change', { bubbles: true })); await tick()
    set('event-summary', 'Shorter'); set('event-timezone', 'Asia/Tokyo'); button('event-save').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('saved')
    expect(f.writes()[0]!.slice(0, 2)).toEqual(['PATCH', '/api/webmail/calendars/' + id(1) + '/events/' + event.id])
    expect(f.writes()[0]![2]).not.toHaveProperty('events')
    expect(JSON.stringify(f.writes()[0]![2]).length).toBeLessThan(10000)
  })
  it('stores sharing, imports events and reads the actual exported source without rendering HTML', async () => {
    const f = model(); f.boot(); await tick()
    set('share-principal', 'sibling@example.test'); button('share').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('saved')
    expect(document.querySelector('[data-calendar-shares]')!.textContent).toContain('sibling@example.test')
    expect(f.writes()[0]![2]).toEqual({ principal: 'sibling@example.test', permission: 'read', expectedRevision: '1'.padStart(64, '0') })
    set('ics', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR'); button('import').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('saved')
    expect((f.writes()[1]![2] as Record<string, unknown>).ics).toContain('BEGIN:VCALENDAR')
    button('export').click(); await tick()
    expect(status().dataset.state).toBe('exported')
    expect(field('exported').value).toContain('BEGIN:VCALENDAR')
    expect(button('download').disabled).toBe(false)
    expect(document.querySelector('script')).toBeNull()
  })
  it('keeps shared read-only calendars selectable and exportable while refusing mutations', async () => {
    const f = model(); f.setRecords([calendar({ owner: 'sibling@example.test', canManage: false, canWrite: false })]); f.boot(); await tick()
    expect(status().dataset.state).toBe('read')
    for (const key of ['save', 'delete', 'event-new', 'event-save', 'event-delete', 'share', 'import']) expect(button(key).disabled).toBe(true)
    expect(button('export').disabled).toBe(false)
    expect(f.writes()).toHaveLength(0)
  })
})
