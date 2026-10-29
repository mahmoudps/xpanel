import type { MessageValues } from './i18n.ts'
import './i18n.ts'
/// <reference lib="dom" />
export interface CalendarViewEvent { id: string; uid: string; summary: string; description: string; location: string; dtstart: string; dtend: string; timezone: string }
export interface CalendarViewCalendar { id: string; owner: string; name: string; color: string; timezone: string; revision: string; storedBytes: number; canWrite: boolean; canManage: boolean; createdAt: string; events: CalendarViewEvent[]; shares: { principal: string; permission: 'read' | 'read-write'; sharedAt: string; effective: boolean }[] }
export interface CalendarViewWorkspace { calendars: CalendarViewCalendar[]; revision: string; limits: { calendars: number; events: number; shares: number; icsBytes: number; calendarBytes: number } }
/** Viewer-zone placement: day numbers count days since 1970-01-01; minutes are wall-clock minutes of the first and last day. */
export interface CalendarSpan { allDay: boolean; start: number; end: number; startDay: number; endDay: number; startMinutes: number; endMinutes: number }
export interface CalendarDaySlot<T> { day: number; allDay: { item: T; span: CalendarSpan }[]; timed: { item: T; span: CalendarSpan; from: number; to: number; lane: number; lanes: number }[] }
export type CalendarMode = 'month' | 'week' | 'day'
interface CalendarViewEntry { calendar: CalendarViewCalendar; event: CalendarViewEvent; key: string }

/** Day number of an ASCII YYYYMMDD prefix, NaN when that date does not exist. Pure UTC arithmetic: no host zone or DST input. */
export function calendarDayNumber(value: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value)
  if (!match) return NaN
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]), date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.getTime() / 86400000 : NaN
}
export function calendarDayString(day: number): string {
  const date = new Date(day * 86400000)
  return String(date.getUTCFullYear()).padStart(4, '0') + String(date.getUTCMonth() + 1).padStart(2, '0') + String(date.getUTCDate()).padStart(2, '0')
}
/** ISO 8601 weekday: 0 is Monday, 6 is Sunday (1970-01-01 was a Thursday). */
export function calendarWeekday(day: number): number { return ((day + 3) % 7 + 7) % 7 }
/** ISO 8601 week: week 1 holds the year's first Thursday, so early January can belong to the previous year's week 52 or 53. */
export function calendarIsoWeek(day: number): { year: number; week: number } {
  const thursday = day - calendarWeekday(day) + 3, year = Number(calendarDayString(thursday).slice(0, 4))
  return { year, week: Math.floor((thursday - calendarDayNumber(String(year).padStart(4, '0') + '0101')) / 7) + 1 }
}
/** Moves by whole views; a month move keeps the day of month, clamped to the target month length (31 January + 1 month is the last day of February). */
export function calendarShift(mode: CalendarMode, anchor: number, delta: number): number {
  if (mode !== 'month') return anchor + delta * (mode === 'week' ? 7 : 1)
  const value = calendarDayString(anchor), index = Number(value.slice(0, 4)) * 12 + Number(value.slice(4, 6)) - 1 + delta
  const year = Math.floor(index / 12), month = index - year * 12, last = new Date(0)
  last.setUTCFullYear(year, month + 1, 0)
  return calendarDayNumber(String(year).padStart(4, '0') + String(month + 1).padStart(2, '0') + String(Math.min(Number(value.slice(6, 8)), last.getUTCDate())).padStart(2, '0'))
}
/** Visible days, Monday first: whole ISO weeks covering the anchor's month, the anchor's ISO week, or the anchor day. */
export function calendarRange(mode: CalendarMode, anchor: number): { first: number; last: number } {
  if (mode === 'day') return { first: anchor, last: anchor }
  if (mode === 'week') { const first = anchor - calendarWeekday(anchor); return { first, last: first + 6 } }
  const start = calendarDayNumber(calendarDayString(anchor).slice(0, 6) + '01'), end = calendarShift('month', start, 1) - 1
  return { first: start - calendarWeekday(start), last: end + 6 - calendarWeekday(end) }
}
/** Wall-clock day and time of an instant in an IANA zone, read with Latin digits and the Gregorian calendar. Throws for an unknown zone. */
export function calendarZoneParts(instant: number, zone: string, cache: Map<string, Intl.DateTimeFormat> = new Map()): { day: number; minutes: number; seconds: number } {
  let format = cache.get(zone)
  if (!format) { format = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); cache.set(zone, format) }
  const parts: Record<string, string> = {}
  for (const part of format.formatToParts(instant)) parts[part.type] = part.value
  return { day: calendarDayNumber((parts.year ?? '').padStart(4, '0') + parts.month + parts.day), minutes: Number(parts.hour) * 60 + Number(parts.minute), seconds: Number(parts.second) }
}
/** UTC milliseconds of an iCalendar date-time: a Z suffix is UTC, otherwise wall time in `zone`. An ambiguous wall time takes the earlier instant and a skipped one is NaN, the rule the API applies on export. */
export function calendarInstant(value: string, zone: string, cache: Map<string, Intl.DateTimeFormat> = new Map()): number {
  const match = /^(\d{8})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value)
  const day = match ? calendarDayNumber(match[1]!) : NaN
  if (!match || Number.isNaN(day) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return NaN
  const desired = day * 86400000 + ((Number(match[2]) * 60 + Number(match[3])) * 60 + Number(match[4])) * 1000
  if (match[5] || zone === 'UTC') return desired
  const wall = (instant: number): number => { const parts = calendarZoneParts(instant, zone, cache); return parts.day * 86400000 + (parts.minutes * 60 + parts.seconds) * 1000 }
  const offsets = new Set<number>()
  for (let hours = -36; hours <= 36; hours += 6) offsets.add(wall(desired + hours * 3600000) - desired - hours * 3600000)
  const matches = [...offsets].map(offset => desired - offset).filter(instant => wall(instant) === desired)
  return matches.length ? Math.min(...matches) : NaN
}
/** Places a stored event for the viewer. All-day dates float with an exclusive end (RFC 5545 VALUE=DATE); timed events are instants. Null when unplaceable. */
export function calendarEventSpan(event: { dtstart: string; dtend: string; timezone: string }, viewerZone: string, cache: Map<string, Intl.DateTimeFormat> = new Map()): CalendarSpan | null {
  if (event.dtstart.length !== event.dtend.length) return null
  if (event.dtstart.length === 8) {
    const startDay = calendarDayNumber(event.dtstart), endDay = calendarDayNumber(event.dtend)
    if (Number.isNaN(startDay) || Number.isNaN(endDay) || endDay < startDay) return null
    const exclusive = Math.max(endDay, startDay + 1)
    return { allDay: true, start: startDay * 86400000, end: exclusive * 86400000, startDay, endDay: exclusive - 1, startMinutes: 0, endMinutes: 1440 }
  }
  try {
    const start = calendarInstant(event.dtstart, event.timezone, cache), end = calendarInstant(event.dtend, event.timezone, cache)
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null
    const from = calendarZoneParts(start, viewerZone, cache), to = calendarZoneParts(end, viewerZone, cache)
    const midnight = to.day > from.day && to.minutes === 0 && to.seconds === 0
    return { allDay: false, start, end, startDay: from.day, endDay: midnight ? to.day - 1 : to.day, startMinutes: from.minutes, endMinutes: midnight ? 1440 : to.minutes }
  } catch { return null }
}
/** Events per visible day: all-day first, then timed by start; overlapping timed segments share the day width in lanes per overlap cluster. */
export function calendarPlaceEvents<T>(entries: readonly { item: T; span: CalendarSpan }[], first: number, last: number): CalendarDaySlot<T>[] {
  const days: CalendarDaySlot<T>[] = []
  for (let day = first; day <= last; day++) days.push({ day, allDay: [], timed: [] })
  const ordered = [...entries].sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end)
  for (const { item, span } of ordered) for (let day = Math.max(first, span.startDay); day <= Math.min(last, span.endDay); day++) {
    const slot = days[day - first]!
    if (span.allDay) { slot.allDay.push({ item, span }); continue }
    const from = day === span.startDay ? span.startMinutes : 0, until = day === span.endDay ? span.endMinutes : 1440
    // Layout keeps a visible 30-minute minimum; the stated times always come from the span.
    slot.timed.push({ item, span, from, to: Math.min(1440, Math.max(until, from + 30)), lane: 0, lanes: 1 })
  }
  for (const slot of days) {
    slot.timed.sort((a, b) => a.from - b.from || b.to - a.to)
    let cluster: CalendarDaySlot<T>['timed'] = [], end = -1
    const close = (): void => { const lanes = cluster.reduce((count, segment) => Math.max(count, segment.lane + 1), 1); for (const segment of cluster) segment.lanes = lanes; cluster = [] }
    for (const segment of slot.timed) {
      if (segment.from >= end) close()
      const used = new Set(cluster.filter(other => other.to > segment.from).map(other => other.lane))
      let lane = 0
      while (used.has(lane)) lane++
      segment.lane = lane; cluster.push(segment); end = Math.max(end, segment.to)
    }
    close()
  }
  return days
}
/** Sealed calendar envelope: the session mailbox, stored-record application only, and no unknown outcome. */
export function calendarViewContext(value: unknown, mailbox: string): Record<string, unknown> {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || !object(value.context) || value.context.mailbox !== mailbox || !object(value.application) || value.application.nativeApplied !== false || value.application.syncVerified !== false) throw new Error('calendar_context_mismatch')
  if (value.unknownOutcome === true || value.verificationRequired === true || object(value.details) && (value.details.unknownOutcome === true || value.details.verificationRequired === true)) throw new Error('calendar_unknown_ack')
  return value
}
export function readCalendarViewCalendar(value: unknown, mailbox: string): CalendarViewCalendar {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const safe = (item: unknown, maximum: number, multiline = false): item is string => typeof item === 'string' && item.isWellFormed() && item.length <= maximum && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(multiline ? item.replace(/[\r\n]/g, '') : item)
  const email = (item: unknown): item is string => safe(item, 254) && /^[^\s@/\\]+@[^\s@/\\]+$/.test(item)
  const stamp = (item: unknown): item is string => typeof item === 'string' && /^\d{8}(?:T\d{6}Z?)?$/.test(item)
  const instant = (item: unknown): item is string => typeof item === 'string' && Number.isFinite(Date.parse(item))
  if (!object(value) || typeof value.id !== 'string' || !id.test(value.id) || !email(value.owner) || !safe(value.name, 200) || !value.name.trim() || !safe(value.color, 80) || !safe(value.timezone, 100)
    || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || typeof value.canWrite !== 'boolean' || typeof value.canManage !== 'boolean' || !instant(value.createdAt)
    || !Array.isArray(value.events) || value.events.length > 10000 || !Array.isArray(value.shares) || value.shares.length > 1000 || typeof value.storedBytes !== 'number' || !Number.isSafeInteger(value.storedBytes) || value.storedBytes < 1) throw new Error('invalid_calendar')
  // Only the session mailbox owns and manages; share details are disclosed to the owner alone.
  if (value.canManage !== (value.owner.toLowerCase() === mailbox.toLowerCase()) || value.canManage && !value.canWrite || !value.canManage && value.shares.length) throw new Error('invalid_calendar_scope')
  const events = value.events.map(raw => {
    if (!object(raw) || typeof raw.id !== 'string' || !id.test(raw.id) || !safe(raw.uid, 512) || !safe(raw.summary, 300) || !safe(raw.description, 5000, true) || !safe(raw.location, 500) || !stamp(raw.dtstart) || !stamp(raw.dtend) || !safe(raw.timezone, 100)) throw new Error('invalid_event')
    return { id: raw.id, uid: raw.uid, summary: raw.summary, description: raw.description, location: raw.location, dtstart: raw.dtstart, dtend: raw.dtend, timezone: raw.timezone }
  })
  if (new Set(events.map(event => event.id)).size !== events.length || new Set(events.map(event => event.uid)).size !== events.length) throw new Error('duplicate_event')
  const shares = value.shares.map(raw => {
    if (!object(raw) || !email(raw.principal) || raw.permission !== 'read' && raw.permission !== 'read-write' || !instant(raw.sharedAt) || typeof raw.effective !== 'boolean') throw new Error('invalid_share')
    return { principal: raw.principal, permission: raw.permission as 'read' | 'read-write', sharedAt: raw.sharedAt, effective: raw.effective }
  })
  if (new Set(shares.map(share => share.principal.toLowerCase())).size !== shares.length) throw new Error('duplicate_share')
  return { id: value.id, owner: value.owner, name: value.name, color: value.color, timezone: value.timezone, revision: value.revision, storedBytes: value.storedBytes, canWrite: value.canWrite, canManage: value.canManage, createdAt: value.createdAt, events, shares }
}
export function readCalendarViewWorkspace(value: unknown, mailbox: string): CalendarViewWorkspace {
  const data = calendarViewContext(value, mailbox), limits = data.limits as Record<string, unknown> | undefined
  if (!Array.isArray(data.calendars) || data.calendars.length > 1000 || typeof data.revision !== 'string' || !/^[0-9a-f]{64}$/.test(data.revision) || !limits || typeof limits !== 'object'
    || ['calendars', 'events', 'shares', 'icsBytes', 'calendarBytes'].some(key => typeof limits[key] !== 'number' || !Number.isSafeInteger(limits[key]) || (limits[key] as number) < 1)) throw new Error('invalid_calendar_workspace')
  const calendars = data.calendars.map(calendar => readCalendarViewCalendar(calendar, mailbox))
  if (new Set(calendars.map(calendar => calendar.id)).size !== calendars.length) throw new Error('duplicate_calendar')
  return { calendars, revision: data.revision, limits: { calendars: limits.calendars as number, events: limits.events as number, shares: limits.shares as number, icsBytes: limits.icsBytes as number, calendarBytes: limits.calendarBytes as number } }
}

/** Month, week and day views over the sealed calendar workspace; single-event writes carry the revision read with the workspace. */
function bindMailCalendarView(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const iso = (day: number): string => { const value = calendarDayString(day); return value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6, 8) }
  const clock = (minutes: number): string => pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60)
  const weekdays = [t('Monday'), t('Tuesday'), t('Wednesday'), t('Thursday'), t('Friday'), t('Saturday'), t('Sunday')]
  const shortWeekdays = [t(msgctxt('mail-calendar-view-client', 'Mon')), t(msgctxt('mail-calendar-view-client', 'Tue')), t(msgctxt('mail-calendar-view-client', 'Wed')), t(msgctxt('mail-calendar-view-client', 'Thu')),
    t(msgctxt('mail-calendar-view-client', 'Fri')), t(msgctxt('mail-calendar-view-client', 'Sat')), t(msgctxt('mail-calendar-view-client', 'Sun'))]
  const months = [t('January'), t('February'), t('March'), t('April'), t('May'), t('June'), t('July'), t('August'), t('September'), t('October'), t('November'), t('December')]
  const email = (value: string): boolean => value.length <= 254 && /^[^\s@/\\]+@[^\s@/\\]+$/.test(value)
  const plain = (value: string, maximum: number, multiline = false): boolean => value.isWellFormed() && new TextEncoder().encode(value).length <= maximum && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(multiline ? value.replace(/\n/g, '') : value)
  const paint = /^(?:#[0-9a-f]{6}|oklch\(\d*(?:\.\d+)? \d*(?:\.\d+)? \d*(?:\.\d+)?\))$/i
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node }
  const ltr = (text: string): HTMLElement => { const node = document.createElement('bdi'); node.dir = 'ltr'; node.textContent = text; return node }
  document.querySelectorAll<HTMLElement>('[data-mail-calendar-view]').forEach(root => {
    if (root.dataset.calendarViewBound === 'true') return
    root.dataset.calendarViewBound = 'true'
    const mailbox = (root.dataset.calendarViewMailbox ?? '').trim().toLowerCase()
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.calendarViewManage === 'true' && email(mailbox) && !root.closest(denied)
    const part = <T extends HTMLElement = HTMLElement>(key: string): T => root.querySelector<T>('[data-calview-' + key + ']')!
    const field = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement = HTMLInputElement>(key: string): T => root.querySelector<T>('[data-calview-field="' + key + '"]')!
    const button = (key: string): HTMLButtonElement => part<HTMLButtonElement>(key)
    const parts = ['grid', 'scroll', 'status', 'range', 'zone', 'legend', 'unplaced', 'detail', 'detail-heading', 'agenda', 'agenda-list', 'event', 'event-facts', 'editor']
    const controls = ['nav="prev"', 'nav="today"', 'nav="next"', 'mode="month"', 'mode="week"', 'mode="day"', 'new', 'refresh', 'close', 'agenda-new', 'edit', 'delete', 'save', 'cancel']
    const inputs = ['calendar', 'summary', 'all-day', 'start-date', 'start-time', 'end-date', 'end-time', 'timezone', 'location', 'notes']
    if (parts.some(key => !part(key)) || controls.some(key => !button(key)) || inputs.some(key => !field(key))) return
    const grid = part('grid'), status = part('status'), detail = part('detail'), heading = part('detail-heading'), agenda = part('agenda'), eventPane = part('event'), editor = part('editor')
    const select = field<HTMLSelectElement>('calendar'), allDay = field('all-day')
    const cache = new Map<string, Intl.DateTimeFormat>()
    const validZone = (zone: string): boolean => { if (zone.length > 100 || !/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)) return false; try { calendarZoneParts(0, zone, cache); return true } catch { return false } }
    const resolved = ((): string => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '' } catch { return '' } })()
    const viewer = validZone(resolved) ? resolved : 'UTC'
    const today = (): number => calendarZoneParts(Date.now(), viewer, cache).day
    const lowest = calendarDayNumber('00010201'), highest = calendarDayNumber('99991130')
    let mode: CalendarMode = 'month', anchor = today(), focus = anchor
    let workspace: CalendarViewWorkspace | null = null, busy = false, review = false
    let spans = new Map<string, CalendarSpan | null>()
    let panel: { kind: 'agenda'; day: number } | { kind: 'event'; key: string } | { kind: 'editor'; key: string | null; initial: string } | null = null
    part('zone').textContent = viewer
    const announce = (state: string, value: string): void => { status.dataset.state = state; status.textContent = value; status.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => {
      if (!transport || !admitted()) return Promise.reject({ status: 403, details: { stateChanged: false } })
      return body === undefined ? transport(method, path) : transport(method, path, body)
    }
    const confirm = async (title: string, message: string, danger = false): Promise<boolean> => {
      if (!askDialog) { announce('failed', t('Confirmation is unavailable; nothing was sent.')); return false }
      try { return await askDialog({ title, body: message, danger, confirm: t('Confirm') }) === true } catch { return false }
    }
    const lookup = (key: string): CalendarViewEntry | null => {
      const [calendarId, eventId] = key.split(':')
      const calendar = workspace?.calendars.find(item => item.id === calendarId), event = calendar?.events.find(item => item.id === eventId)
      return calendar && event ? { calendar, event, key } : null
    }
    const spanOf = (entry: CalendarViewEntry): CalendarSpan | null => {
      if (!spans.has(entry.key)) spans.set(entry.key, calendarEventSpan(entry.event, viewer, cache))
      return spans.get(entry.key) ?? null
    }
    const entries = (first: number, last: number): { placed: { item: CalendarViewEntry; span: CalendarSpan }[]; skipped: number } => {
      const placed: { item: CalendarViewEntry; span: CalendarSpan }[] = []
      let skipped = 0
      for (const calendar of workspace?.calendars ?? []) for (const event of calendar.events) {
        // A stored wall time is at most two days from its viewer-zone date, so exact zone math runs only near the range.
        if (calendarDayNumber(event.dtend) + 2 < first || calendarDayNumber(event.dtstart) - 2 > last) continue
        const entry = { calendar, event, key: calendar.id + ':' + event.id }, span = spanOf(entry)
        if (!span) skipped++
        else if (span.endDay >= first && span.startDay <= last) placed.push({ item: entry, span })
      }
      return { placed, skipped }
    }
    const editable = (): CalendarViewCalendar[] => workspace ? workspace.calendars.filter(calendar => calendar.canWrite && calendar.events.length < workspace!.limits.events && calendar.storedBytes < workspace!.limits.calendarBytes) : []
    const draft = () => ({ calendar: select.value, summary: field('summary').value.trim(), allDay: allDay.checked, startDate: field('start-date').value.trim(), startTime: field('start-time').value.trim(),
      endDate: field('end-date').value.trim(), endTime: field('end-time').value.trim(), timezone: field('timezone').value.trim(), location: field('location').value.trim(), notes: field<HTMLTextAreaElement>('notes').value.replace(/\r\n?/g, '\n').trim() })
    const dirty = (): boolean => panel?.kind === 'editor' && JSON.stringify(draft()) !== panel.initial
    const lock = (): void => {
      const ready = admitted() && !!workspace && !busy && !review, entry = panel?.kind === 'event' ? lookup(panel.key) : null
      const editing = admitted() && !!workspace && !busy && panel?.kind === 'editor'
      for (const key of controls) button(key).disabled = !admitted()
      button('refresh').disabled = busy || !admitted()
      button('new').disabled = button('agenda-new').disabled = !ready || !editable().length
      button('edit').disabled = button('delete').disabled = !ready || !entry?.calendar.canWrite
      for (const key of inputs) field(key).disabled = !editing
      select.disabled = !editing || panel?.kind === 'editor' && panel.key !== null
      field('start-time').disabled = field('end-time').disabled = !editing || allDay.checked
      button('save').disabled = !editing || review
      button('cancel').disabled = busy
      root.setAttribute('aria-busy', String(busy))
    }
    const show = (pane: HTMLElement | null): void => {
      for (const item of [agenda, eventPane, editor]) item.hidden = item !== pane
      detail.hidden = !pane
      if (!pane) panel = null
    }
    const chip = (entry: CalendarViewEntry, span: CalendarSpan, day: number): HTMLButtonElement => {
      const node = element('button', 'xp-mail-calview__chip'), summary = element('span', '', entry.event.summary)
      node.type = 'button'; node.tabIndex = -1; node.dataset.calviewItem = entry.key; node.title = entry.event.summary; summary.dir = 'auto'
      if (paint.test(entry.calendar.color)) node.style.setProperty('--calview-chip', entry.calendar.color)
      node.append(span.allDay ? element('span', '', t('All day')) : day === span.startDay ? ltr(clock(span.startMinutes)) : element('span', '', t('Continues')), summary)
      return node
    }
    const row = (): HTMLElement => { const node = element('div', 'xp-mail-calview__row'); node.setAttribute('role', 'row'); return node }
    const columnHeader = (index: number): HTMLElement => { const node = element('div', 'xp-mail-calview__head'); node.setAttribute('role', 'columnheader'); node.append(element('span', 'xp-mail-calview__long', weekdays[index]!), element('span', 'xp-mail-calview__short', shortWeekdays[index]!)); return node }
    const dayCell = (day: number, count: number, now: number): HTMLElement => {
      const node = element('div', 'xp-mail-calview__day')
      node.setAttribute('role', 'gridcell'); node.dataset.calviewDay = calendarDayString(day); node.tabIndex = day === focus ? 0 : -1; node.setAttribute('aria-selected', String(day === focus))
      if (day === now) node.setAttribute('aria-current', 'date')
      const values = { weekday: weekdays[calendarWeekday(day)]!, date: iso(day), count }
      node.setAttribute('aria-label', day === now
        ? t('{weekday} {date}, today, {count, plural, =0 {no events} one {{count} event} other {{count} events}}', values)
        : t('{weekday} {date}, {count, plural, =0 {no events} one {{count} event} other {{count} events}}', values))
      return node
    }
    const renderMonth = (first: number, last: number, days: CalendarDaySlot<CalendarViewEntry>[], now: number): void => {
      const month = calendarDayString(anchor).slice(0, 6), header = row(), corner = element('div', 'xp-mail-calview__week', t(msgctxt('mail-calendar-view-client', 'Week')))
      corner.setAttribute('role', 'columnheader'); header.append(corner)
      for (let index = 0; index < 7; index++) header.append(columnHeader(index))
      grid.append(header)
      for (let start = first; start <= last; start += 7) {
        const line = row(), week = calendarIsoWeek(start).week, label = element('div', 'xp-mail-calview__week')
        label.setAttribute('role', 'rowheader'); label.setAttribute('aria-label', t('Week {week}', { week })); label.append(ltr('W' + pad(week))); line.append(label)
        for (let day = start; day < start + 7; day++) {
          const slot = days[day - first]!, all = [...slot.allDay, ...slot.timed], cell = dayCell(day, all.length, now), date = ltr(String(Number(calendarDayString(day).slice(6))))
          if (calendarDayString(day).slice(0, 6) !== month) cell.dataset.outside = 'true'
          date.className = 'xp-mail-calview__date'; cell.append(date)
          for (const placed of all.slice(0, 3)) cell.append(chip(placed.item, placed.span, day))
          if (all.length > 3) { const more = element('span', 'xp-mail-calview__more'); const [before = '', after = ''] = t('{count} more').split('{count}'); more.append(before, ltr('+' + (all.length - 3)), after); cell.append(more) }
          line.append(cell)
        }
        grid.append(line)
      }
    }
    const renderTimeline = (first: number, last: number, days: CalendarDaySlot<CalendarViewEntry>[], now: number): void => {
      const header = row(), body = row(), corner = element('div', 'xp-mail-calview__gutter'), gutter = element('div', 'xp-mail-calview__gutter')
      corner.setAttribute('aria-hidden', 'true'); gutter.setAttribute('aria-hidden', 'true'); header.append(corner); body.append(gutter)
      grid.style.setProperty('--calview-days', String(last - first + 1))
      for (let hour = 0; hour < 24; hour++) gutter.append(ltr(pad(hour) + ':00'))
      for (let day = first; day <= last; day++) {
        // All-day chips sit in the header row so every timeline starts at the same height as the hour gutter.
        const slot = days[day - first]!, head = columnHeader(calendarWeekday(day)), date = ltr(iso(day)), cell = dayCell(day, slot.allDay.length + slot.timed.length, now), timeline = element('div', 'xp-mail-calview__timeline')
        date.className = 'xp-mail-calview__date'; head.append(date)
        if (day === now) head.setAttribute('aria-current', 'date')
        for (const placed of slot.allDay) head.append(chip(placed.item, placed.span, day))
        for (const segment of slot.timed) {
          const node = chip(segment.item, segment.span, day)
          node.style.setProperty('--calview-top', segment.from / 14.4 + '%'); node.style.setProperty('--calview-height', (segment.to - segment.from) / 14.4 + '%')
          node.style.setProperty('--calview-start', segment.lane / segment.lanes * 100 + '%'); node.style.setProperty('--calview-width', 100 / segment.lanes + '%')
          timeline.append(node)
        }
        cell.append(timeline); header.append(head); body.append(cell)
      }
      grid.append(header, body)
    }
    const render = (): void => {
      const { first, last } = calendarRange(mode, anchor)
      if (focus < first || focus > last) focus = anchor
      const now = today(), { placed, skipped } = entries(first, last), days = calendarPlaceEvents(placed, first, last), range = part('range'), value = calendarDayString(anchor)
      range.textContent = ''
      if (mode === 'month') range.append(months[Number(value.slice(4, 6)) - 1] + ' ', ltr(value.slice(0, 4)))
      else if (mode === 'week') { const nodes: Record<string, Node> = { '{week}': ltr(pad(calendarIsoWeek(first).week)), '{range}': ltr(iso(first) + ' – ' + iso(last)) }; range.append(...t('Week {week} · {range}').split(/(\{\w+\})/).filter(Boolean).map(part => nodes[part] ?? part)) }
      else range.append(weekdays[calendarWeekday(anchor)] + ' ', ltr(iso(anchor)))
      grid.textContent = ''; grid.dataset.mode = mode
      if (mode === 'month') renderMonth(first, last, days, now); else renderTimeline(first, last, days, now)
      const unplaced = part('unplaced')
      unplaced.hidden = !skipped
      unplaced.textContent = skipped ? t('{count} stored events near these dates cannot be placed, for example a local time skipped by a daylight saving change. Review them in Calendars and events.', { count: skipped }) : ''
      for (const key of ['month', 'week', 'day']) button('mode="' + key + '"').setAttribute('aria-pressed', String(key === mode))
    }
    const move = (day: number): void => {
      if (!(day >= lowest && day <= highest)) return
      const { first, last } = calendarRange(mode, anchor)
      if (mode === 'month' ? calendarDayString(day).slice(0, 6) !== calendarDayString(anchor).slice(0, 6) : day < first || day > last) anchor = day
      focus = day; render()
      grid.querySelector<HTMLElement>('[data-calview-day="' + calendarDayString(day) + '"]')?.focus()
    }
    const when = (span: CalendarSpan, zone: string): string => {
      if (span.allDay) return iso(span.startDay) + (span.endDay > span.startDay ? ' – ' + iso(span.endDay) : '')
      const from = calendarZoneParts(span.start, zone, cache), to = calendarZoneParts(span.end, zone, cache)
      return iso(from.day) + ' ' + clock(from.minutes) + ' – ' + (to.day === from.day ? '' : iso(to.day) + ' ') + clock(to.minutes)
    }
    const title = (...content: (string | Node)[]): void => { heading.textContent = ''; heading.append(...content) }
    const openAgenda = (day: number): void => {
      const list = part('agenda-list'), slot = calendarPlaceEvents(entries(day, day).placed, day, day)[0]!
      title(weekdays[calendarWeekday(day)] + ' ', ltr(iso(day))); list.textContent = ''
      for (const placed of [...slot.allDay, ...slot.timed]) {
        const item = element('li'), open = chip(placed.item, placed.span, day), name = element('span', 'xp-help', placed.item.calendar.name)
        open.tabIndex = 0; name.dir = 'auto'; open.append(name); item.append(open); list.append(item)
      }
      if (!list.children.length) list.append(element('li', 'xp-help', t('No events on this day.')))
      show(agenda); panel = { kind: 'agenda', day }; lock(); detail.focus()
    }
    const openEvent = (key: string): void => {
      const entry = lookup(key), span = entry ? spanOf(entry) : null, facts = part('event-facts')
      if (!entry || !span) { announce('failed', t('This event cannot be shown from the saved records that were read.')); return }
      const fact = (label: (string | Node)[], value: (string | Node)[], className = ''): void => { const box = element('div'), term = element('dt'), data = element('dd', className); term.append(...label); data.append(...value); box.append(term, data); facts.append(box) }
      const named = (text: string, className = ''): HTMLElement => { const node = element('span', className, text); node.dir = 'auto'; return node }
      title(named(entry.event.summary)); facts.textContent = ''
      fact([t('Calendar')], entry.calendar.canManage ? [named(entry.calendar.name)] : [named(entry.calendar.name), ' · ', ltr(entry.calendar.owner)])
      fact([t('Access')], [entry.calendar.canManage ? t('Owner') : entry.calendar.canWrite ? t('Shared: event editing') : t('Shared: read only')])
      if (span.allDay) fact([t('Date (all day)')], [ltr(when(span, viewer))])
      else {
        const zoned = (message: string, zone: string): (string | Node)[] => { const [before = '', after = ''] = message.split('{zone}'); return [before, ltr(zone), after] }
        fact(zoned(t('Your time ({zone})'), viewer), [ltr(when(span, viewer))])
        if (entry.event.timezone !== viewer) fact(zoned(t('Event time ({zone})'), entry.event.timezone), [validZone(entry.event.timezone) ? ltr(when(span, entry.event.timezone)) : t('This timezone is not recognized by this browser.')])
      }
      if (entry.event.location) fact([t('Location')], [named(entry.event.location)])
      if (entry.event.description) fact([t('Notes')], [named(entry.event.description)], 'xp-mail-calview__notes')
      show(eventPane); panel = { kind: 'event', key }; lock(); detail.focus()
    }
    const wall = (value: string, zone: string): [string, string] => {
      let local = value
      if (value.endsWith('Z') && zone !== 'UTC' && validZone(zone)) { const parts = calendarZoneParts(calendarInstant(value, 'UTC'), zone, cache); local = calendarDayString(parts.day) + 'T' + pad(Math.floor(parts.minutes / 60)) + pad(parts.minutes % 60) + pad(parts.seconds) }
      return [iso(calendarDayNumber(local)), local.slice(9, 11) + ':' + local.slice(11, 13) + (local.slice(13, 15) === '00' ? '' : ':' + local.slice(13, 15))]
    }
    const openEditor = (key: string | null, day: number): void => {
      const entry = key ? lookup(key) : null, targets = entry ? [entry.calendar] : editable()
      if (key && !entry?.calendar.canWrite || !targets.length) return
      select.textContent = ''
      for (const calendar of targets) { const option = element('option', '', calendar.name + (calendar.canManage ? '' : ' · ' + calendar.owner)); option.value = calendar.id; select.append(option) }
      const span = entry ? spanOf(entry) : null, event = entry?.event
      let values = { allDay: false, startDate: iso(day), startTime: '09:00', endDate: iso(day), endTime: '10:00' }
      if (event && event.dtstart.length === 8) values = { allDay: true, startDate: iso(calendarDayNumber(event.dtstart)), startTime: '09:00', endDate: iso(span?.endDay ?? calendarDayNumber(event.dtstart)), endTime: '10:00' }
      else if (event) { const [startDate, startTime] = wall(event.dtstart, event.timezone), [endDate, endTime] = wall(event.dtend, event.timezone); values = { allDay: false, startDate, startTime, endDate, endTime } }
      allDay.checked = values.allDay
      field('summary').value = event?.summary ?? ''; field('start-date').value = values.startDate; field('start-time').value = values.startTime; field('end-date').value = values.endDate; field('end-time').value = values.endTime
      field('timezone').value = event?.timezone ?? viewer; field('location').value = event?.location ?? ''; field<HTMLTextAreaElement>('notes').value = event?.description ?? ''
      title(entry ? t('Edit event') : t('New event'))
      show(editor); panel = { kind: 'editor', key, initial: JSON.stringify(draft()) }; lock(); field('summary').focus()
    }
    /** Builds the single-event body. Only fields the API accepts are sent; nothing is derived from an unchecked value. */
    const fields = (): Record<string, string> | 'invalid' | 'skipped' => {
      const value = draft()
      const day = (text: string): number => /^\d{4}-\d{2}-\d{2}$/.test(text) ? calendarDayNumber(text.replace(/-/g, '')) : NaN
      const time = (text: string): string => { const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text); return match && Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3] ?? 0) < 60 ? match[1]! + match[2]! + (match[3] ?? '00') : '' }
      const start = day(value.startDate), end = day(value.endDate)
      if (!value.summary || !plain(value.summary, 300) || !plain(value.location, 500) || !plain(value.notes, 5000, true) || !validZone(value.timezone) || Number.isNaN(start) || Number.isNaN(end)) return 'invalid'
      const base = { summary: value.summary, description: value.notes, location: value.location, timezone: value.timezone }
      // RFC 5545: an all-day DTEND is the day after the last day, so the inclusive end date shown here is stored plus one.
      if (value.allDay) return end < start ? 'invalid' : { ...base, dtstart: calendarDayString(start), dtend: calendarDayString(end + 1) }
      const from = time(value.startTime), to = time(value.endTime), suffix = value.timezone === 'UTC' ? 'Z' : ''
      if (!from || !to) return 'invalid'
      const dtstart = calendarDayString(start) + 'T' + from + suffix, dtend = calendarDayString(end) + 'T' + to + suffix
      const startAt = calendarInstant(dtstart, value.timezone, cache), endAt = calendarInstant(dtend, value.timezone, cache)
      if (Number.isNaN(startAt) || Number.isNaN(endAt)) return 'skipped'
      return endAt < startAt ? 'invalid' : { ...base, dtstart, dtend }
    }
    const install = (value: CalendarViewWorkspace): void => {
      workspace = value; spans = new Map(); review = false
      const legend = part('legend')
      legend.textContent = ''
      for (const calendar of value.calendars) {
        const item = element('li'), swatch = element('span', 'xp-mail-calview__swatch'), name = element('span', '', calendar.name)
        swatch.setAttribute('aria-hidden', 'true'); name.dir = 'auto'
        if (paint.test(calendar.color)) swatch.style.setProperty('--calview-chip', calendar.color)
        item.append(swatch, name, ' · ' + (calendar.canManage ? t('Owner') : calendar.canWrite ? t('Shared: event editing') : t('Shared: read only')))
        if (!calendar.canManage) item.append(' · ', ltr(calendar.owner))
        const [before = '', after = ''] = t('{count} events').split('{count}')
        item.append(' · ' + before, ltr(String(calendar.events.length)), after)
        legend.append(item)
      }
      if (!value.calendars.length) {
        const item = element('li', 'xp-help'), link = element('a', '', t('Calendars and events')), [before = '', after = ''] = t('No calendars are available to this mailbox yet. Create one in {link}.').split('{link}')
        link.href = '/mail/settings/calendars'; item.append(before, link, after); legend.append(item)
      }
      show(null); render()
    }
    const refresh = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; lock()
      try {
        if ((dirty() || review) && !await confirm(t('Discard edits and read calendars?'), t('Unsaved edits are discarded only after a successful authorized read. A previous write is never retried.'), true)) return
        announce('reading', t('Reading saved calendar records…'))
        install(readCalendarViewWorkspace(await request('GET', '/api/webmail/calendars'), mailbox))
        announce('read', t('Saved calendars read. Device synchronization remains unverified.'))
      } catch { announce(review ? 'uncertain' : 'failed', t('Calendars could not be read. Your edits are kept and no change was sent.')) }
      finally { busy = false; lock() }
    }
    const mutate = async (method: 'POST' | 'PATCH' | 'DELETE', target: CalendarViewCalendar, eventId: string | null, body: Record<string, string>): Promise<void> => {
      if (busy || review || !workspace || !admitted()) return
      busy = true; lock(); let submitted = false
      try {
        announce('saving', t('Saving and reading back the event…'))
        submitted = true
        const reply = calendarViewContext(await request(method, '/api/webmail/calendars/' + encodeURIComponent(target.id) + '/events' + (eventId ? '/' + encodeURIComponent(eventId) : ''), body), mailbox)
        const acknowledged = readCalendarViewCalendar(reply.calendar, mailbox)
        let changed = eventId
        if (acknowledged.id !== target.id) throw new Error('wrong_calendar_ack')
        if (method === 'DELETE') {
          if (reply.ok !== true || reply.deletedEventId !== eventId || acknowledged.events.some(event => event.id === eventId)) throw new Error('calendar_event_delete_mismatch')
        } else {
          const replyEvent = object(reply.event) ? reply.event : {}, event = acknowledged.events.find(item => item.id === replyEvent.id)
          if (!event || (eventId ? event.id !== eventId : target.events.some(item => item.id === event.id))) throw new Error('calendar_event_ack_mismatch')
          for (const key of ['summary', 'description', 'location', 'dtstart', 'dtend', 'timezone'] as const) if (event[key] !== body[key]) throw new Error('calendar_event_value_mismatch')
          changed = event.id
        }
        if (acknowledged.events.length !== target.events.length + (method === 'POST' ? 1 : method === 'DELETE' ? -1 : 0)) throw new Error('calendar_event_count_mismatch')
        for (const previous of target.events) if (previous.id !== changed && JSON.stringify(acknowledged.events.find(event => event.id === previous.id)) !== JSON.stringify(previous)) throw new Error('unrelated_calendar_event_changed')
        const observed = readCalendarViewWorkspace(await request('GET', '/api/webmail/calendars'), mailbox), found = observed.calendars.find(calendar => calendar.id === acknowledged.id)
        if (!found || JSON.stringify(found) !== JSON.stringify(acknowledged)) throw new Error('calendar_persisted_readback_mismatch')
        install(observed)
        if (method === 'DELETE') openAgenda(focus)
        else { const key = acknowledged.id + ':' + changed, saved = lookup(key), span = saved ? spanOf(saved) : null; if (span) move(span.startDay); openEvent(key) }
        announce(method === 'DELETE' ? 'deleted' : 'saved', method === 'DELETE' ? t('Event deleted and calendars read back. Device synchronization remains unverified.') : t('Event saved and read back. Device synchronization remains unverified.'))
      } catch (error) {
        const failure = object(error) ? error : {}, detail = object(failure.details) ? failure.details : {}
        const noChange = detail.stateChanged === false || failure.stateChanged === false || typeof failure.status === 'number' && [400, 401, 403, 404, 412, 413, 422].includes(failure.status) && detail.stateChanged !== true && detail.unknownOutcome !== true && detail.verificationRequired !== true
        // A revision conflict is never overwritten or retried: the saved version must be read and reviewed first.
        review = submitted && (!noChange || failure.status === 409)
        announce(review ? failure.status === 409 ? 'stale' : 'uncertain' : 'failed', review
          ? failure.status === 409 ? t('This calendar changed after it was read, so nothing was overwritten. Your edits are kept. Reload calendars to review the saved version before trying again.')
            : t('The result requires review. Your edits are kept; no retry was sent. Reload calendars before continuing.')
          : t('The request was refused or could not be sent. Your edits are kept; nothing was retried.'))
      } finally { busy = false; lock() }
    }
    if (!transport || !admitted()) {
      render()
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button').forEach(control => { control.disabled = true })
      announce('unavailable', t('Calendar records are unavailable here. Nothing was read or changed.'))
      return
    }
    grid.addEventListener('click', event => {
      const target = event.target as Element, cell = target.closest<HTMLElement>('[data-calview-day]'), key = target.closest<HTMLElement>('[data-calview-item]')?.dataset.calviewItem
      if (!admitted() || !cell && !key) return
      if (cell) { focus = calendarDayNumber(cell.dataset.calviewDay ?? ''); render() }
      if (key) openEvent(key); else openAgenda(focus)
    })
    grid.addEventListener('keydown', event => {
      const cell = (event.target as Element).closest<HTMLElement>('[data-calview-day]')
      if (!cell) return
      const day = calendarDayNumber(cell.dataset.calviewDay ?? ''), forward = root.dir === 'rtl' ? -1 : 1
      const step = event.key === 'ArrowRight' ? forward : event.key === 'ArrowLeft' ? -forward : event.key === 'ArrowDown' ? 7 : event.key === 'ArrowUp' ? -7 : 0
      if (step) { event.preventDefault(); move(day + step) }
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focus = day; openAgenda(day) }
    })
    part('agenda-list').addEventListener('click', event => { const item = (event.target as Element).closest<HTMLElement>('[data-calview-item]'); if (item?.dataset.calviewItem) openEvent(item.dataset.calviewItem) })
    for (const delta of [-1, 1]) button('nav="' + (delta < 0 ? 'prev' : 'next') + '"').addEventListener('click', () => { const next = calendarShift(mode, anchor, delta); if (next >= lowest && next <= highest) { anchor = focus = next; render() } })
    button('nav="today"').addEventListener('click', () => { anchor = focus = today(); render() })
    for (const key of ['month', 'week', 'day'] as const) button('mode="' + key + '"').addEventListener('click', () => { mode = key; anchor = focus; render(); if (key !== 'month') part('scroll').scrollTop = 8 * 48 })
    button('refresh').addEventListener('click', () => { void refresh() })
    button('new').addEventListener('click', () => { if (!button('new').disabled) openEditor(null, focus) })
    button('agenda-new').addEventListener('click', () => { if (!button('agenda-new').disabled && panel?.kind === 'agenda') openEditor(null, panel.day) })
    button('edit').addEventListener('click', () => { if (!button('edit').disabled && panel?.kind === 'event') openEditor(panel.key, focus) })
    button('delete').addEventListener('click', () => {
      const entry = panel?.kind === 'event' ? lookup(panel.key) : null
      if (button('delete').disabled || !entry?.calendar.canWrite) return
      void confirm(t('Delete this event?'), entry.event.summary + '\n' + t('The saved event is removed from this calendar and the calendars are read back. Device synchronization remains unverified.'), true)
        .then(accepted => { if (accepted) return mutate('DELETE', entry.calendar, entry.event.id, { expectedRevision: entry.calendar.revision }) })
    })
    button('save').addEventListener('click', () => {
      if (button('save').disabled || panel?.kind !== 'editor') return
      const entry = panel.key ? lookup(panel.key) : null, calendar = entry ? entry.calendar : editable().find(item => item.id === select.value), value = fields()
      if (panel.key && !entry || !calendar?.canWrite || typeof value === 'string') {
        announce('failed', value === 'skipped' ? t('That local time does not exist in the event timezone because of a daylight saving change. Choose another time. Nothing was sent.')
          : t('Check the summary, ASCII dates (YYYY-MM-DD), 24-hour times (HH:MM), timezone and event order. Nothing was sent.'))
        return
      }
      // The expected revision is the one read with this workspace; any later change makes the API refuse with 409.
      void mutate(entry ? 'PATCH' : 'POST', calendar, entry?.event.id ?? null, { ...value, expectedRevision: calendar.revision })
    })
    button('cancel').addEventListener('click', () => { if (panel?.kind !== 'editor') return; if (panel.key && lookup(panel.key)) openEvent(panel.key); else openAgenda(focus) })
    const close = async (): Promise<void> => {
      if (dirty() && !await confirm(t('Discard event edits?'), t('Unsaved event edits will be discarded.'), true)) return
      show(null); lock(); grid.querySelector<HTMLElement>('[data-calview-day][tabindex="0"]')?.focus()
    }
    button('close').addEventListener('click', () => { void close() })
    detail.addEventListener('keydown', event => { if (event.key === 'Escape' && panel?.kind !== 'editor') { event.preventDefault(); void close() } })
    allDay.addEventListener('change', lock)
    window.addEventListener('beforeunload', event => { if (dirty() || review) { event.preventDefault(); event.returnValue = '' } })
    render(); lock(); void refresh()
  })
}

const helpers = [calendarDayNumber, calendarDayString, calendarWeekday, calendarIsoWeek, calendarShift, calendarRange, calendarZoneParts, calendarInstant, calendarEventSpan, calendarPlaceEvents, calendarViewContext, readCalendarViewCalendar, readCalendarViewWorkspace]
export const MAIL_CALENDAR_VIEW_CLIENT_BINDING = `(()=>{${helpers.map(helper => helper.toString()).join('\n')}\nreturn ${bindMailCalendarView.toString()};})()`
