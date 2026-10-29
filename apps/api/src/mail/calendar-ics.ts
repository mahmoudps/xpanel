import { randomUUID } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { WebmailCalendar, WebmailCalendarEvent } from '../extended-routes.ts'
import { CALENDAR_LIMITS, calendarTimestamp, calendarTimezone } from './calendar-workspace.ts'

// Bounded RFC 5545 event subset. Unsupported semantic properties are refused, never dropped.
const invalid = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
const safeText = (value: string, maximum: number, multiline = false): string => {
  if (!value.isWellFormed() || Buffer.byteLength(value, 'utf8') > maximum || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(multiline ? value.replace(/[\r\n]/g, '') : value)) return invalid('iCalendar text is invalid or exceeds its bound')
  return (multiline ? value.replace(/\r\n|\r/g, '\n') : value).trim()
}
const decodeText = (value: string): string => {
  let result = ''
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    if (character !== '\\') { result += character; continue }
    const escaped = value[++index]
    if (!escaped || !'nN,;\\'.includes(escaped)) return invalid('unsupported iCalendar text escape')
    result += /[nN]/.test(escaped) ? '\n' : escaped
  }
  return result
}
const encodeText = (value: string): string => value.replaceAll('\\', '\\\\').replace(/\r\n|\r|\n/g, '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;')
const stamp = (instant: Date): string => instant.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
const asUtcNumber = (value: string): number => {
  const date = new Date(0)
  date.setUTCFullYear(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)))
  date.setUTCHours(Number(value.slice(9, 11)), Number(value.slice(11, 13)), Number(value.slice(13, 15)), 0)
  return date.getTime()
}
export const calendarLocalToUtc = (value: string, timezone: string): string => {
  const checked = calendarTimestamp(value, 'event date')
  if (checked.length === 8 || checked.endsWith('Z')) return checked
  const zone = calendarTimezone(timezone), desired = asUtcNumber(checked)
  if (zone === 'UTC') return checked + 'Z'
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  const local = (instant: number): string => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
    return parts.year!.padStart(4, '0') + parts.month + parts.day + 'T' + parts.hour + parts.minute + parts.second
  }
  const offsets = new Set<number>()
  for (let hour = -36; hour <= 36; hour += 6) { const instant = desired + hour * 3600000; offsets.add(asUtcNumber(local(instant)) - instant) }
  const matches = [...offsets].map(offset => desired - offset).filter(instant => local(instant) === checked).sort((a, b) => a - b)
  if (!matches.length) return invalid('the local event time does not exist in its timezone; choose an unambiguous valid time')
  return calendarTimestamp(stamp(new Date(matches[0]!)), 'UTC event date')
}
export const foldCalendarLine = (value: string): string => {
  const lines: string[] = []; let line = '', bytes = 0
  for (const character of value) {
    const length = Buffer.byteLength(character, 'utf8')
    if (bytes + length > 75) { lines.push(line); line = ' '; bytes = 1 }
    line += character; bytes += length
  }
  lines.push(line)
  return lines.join('\r\n')
}
export const parseCalendarWorkspaceIcs = (source: string, defaultTimezone: string): WebmailCalendarEvent[] => {
  if (typeof source !== 'string' || !source.trim() || !source.isWellFormed() || Buffer.byteLength(source, 'utf8') > CALENDAR_LIMITS.icsBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)) return invalid('valid bounded ICS content is required')
  const lines: string[] = []
  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith(' ') || line.startsWith('\t')) { if (!lines.length) return invalid('ICS continuation has no parent line'); lines[lines.length - 1] += line.slice(1) }
    else if (line) lines.push(line)
  }
  if (lines.shift()?.toUpperCase() !== 'BEGIN:VCALENDAR' || lines.pop()?.toUpperCase() !== 'END:VCALENDAR') return invalid('ICS must contain one complete VCALENDAR')
  let timezone = calendarTimezone(defaultTimezone), event: Partial<WebmailCalendarEvent> | null = null
  let startZone: string | undefined, endZone: string | undefined
  let seen = new Set<string>(); const events: WebmailCalendarEvent[] = []
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon < 1) return invalid('malformed ICS content line')
    const [rawName, ...parameters] = line.slice(0, colon).split(';'), name = rawName!.toUpperCase(), value = line.slice(colon + 1)
    if (name === 'BEGIN') {
      if (value.toUpperCase() !== 'VEVENT' || event) return invalid('unsupported or nested ICS component')
      event = { id: randomUUID(), uid: randomUUID(), description: '', location: '', timezone }; seen = new Set(); startZone = undefined; endZone = undefined; continue
    }
    if (name === 'END') {
      if (value.toUpperCase() !== 'VEVENT' || !event || !event.summary || !event.dtstart) return invalid('ICS requires complete supported VEVENT records')
      const start = calendarTimestamp(event.dtstart, 'DTSTART'), end = calendarTimestamp(event.dtend ?? event.dtstart, 'DTEND')
      if (start.length !== end.length || end < start) return invalid('ICS event end must match and follow its start')
      if (startZone && endZone && startZone !== endZone) return invalid('event start and end must use the same timezone')
      events.push({ id: event.id!, uid: event.uid!, summary: event.summary, description: event.description ?? '', location: event.location ?? '', dtstart: start, dtend: end, timezone: event.timezone! })
      if (events.length > CALENDAR_LIMITS.events) return invalid('ICS event capacity exceeded')
      event = null; continue
    }
    if (!event) {
      if (parameters.length) return invalid('unsupported calendar property parameter')
      if (name === 'X-WR-TIMEZONE') timezone = calendarTimezone(value)
      else if (name === 'VERSION' && value !== '2.0' || name === 'CALSCALE' && value.toUpperCase() !== 'GREGORIAN' || name === 'METHOD' && value.toUpperCase() !== 'PUBLISH') return invalid('unsupported ICS calendar version, scale or method')
      else if (!['VERSION', 'CALSCALE', 'METHOD', 'PRODID', 'X-WR-CALNAME', 'X-WR-TIMEZONE'].includes(name)) return invalid('unsupported ICS calendar property')
      continue
    }
    if (!['UID', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'DTSTART', 'DTEND', 'DTSTAMP'].includes(name) || seen.has(name)) return invalid('unsupported or duplicate event property; recurrence, attendees, alarms and attachments are not imported')
    seen.add(name)
    let eventZone: string | undefined, declaredDate = false
    for (const parameter of parameters) {
      const separator = parameter.indexOf('='), key = parameter.slice(0, separator).toUpperCase(), raw = parameter.slice(separator + 1), decoded = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
      if (separator < 1 || !['DTSTART', 'DTEND'].includes(name)) return invalid('unsupported event property parameter')
      if (key === 'TZID' && eventZone === undefined) eventZone = calendarTimezone(decoded)
      else if (key === 'VALUE' && decoded.toUpperCase() === 'DATE' && !declaredDate) declaredDate = true
      else return invalid('unsupported or duplicate date parameter')
    }
    if (name === 'DTSTART' || name === 'DTEND' || name === 'DTSTAMP') {
      const date = calendarTimestamp(value, name)
      if (declaredDate && date.length !== 8 || eventZone && (date.length === 8 || date.endsWith('Z')) || name === 'DTSTAMP' && !date.endsWith('Z')) return invalid('invalid date/timezone parameter combination')
      if (name === 'DTSTAMP') continue
      const zone = date.endsWith('Z') ? 'UTC' : eventZone ?? timezone
      if (name === 'DTSTART') { event.dtstart = date; event.timezone = zone; startZone = zone } else { event.dtend = date; endZone = zone }
    } else if (name === 'UID') { event.uid = safeText(decodeText(value), 512); if (!event.uid) return invalid('UID may not be empty') }
    else if (name === 'SUMMARY') event.summary = safeText(decodeText(value), 300)
    else if (name === 'DESCRIPTION') event.description = safeText(decodeText(value), 5000, true)
    else event.location = safeText(decodeText(value), 500)
  }
  if (event || !events.length || new Set(events.map(event => event.uid)).size !== events.length) return invalid('ICS requires complete events with unique UIDs')
  return events
}
export const renderCalendarWorkspaceIcs = (calendar: WebmailCalendar, at = new Date()): string => {
  const timezone = calendarTimezone(calendar.timezone), atUtc = calendarTimestamp(stamp(at), 'DTSTAMP')
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//xPanel//Stored Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + encodeText(safeText(calendar.name, 200)), 'X-WR-TIMEZONE:' + timezone]
  for (const event of calendar.events ?? []) {
    const start = calendarLocalToUtc(event.dtstart, event.timezone), end = calendarLocalToUtc(event.dtend, event.timezone)
    if (start.length !== end.length || end < start) return invalid('stored event dates require review before export')
    const dateLine = (name: string, value: string): string => name + (value.length === 8 ? ';VALUE=DATE:' : ':') + value
    lines.push('BEGIN:VEVENT', 'UID:' + encodeText(safeText(event.uid, 512)), 'DTSTAMP:' + atUtc,
      'SUMMARY:' + encodeText(safeText(event.summary, 300)), dateLine('DTSTART', start), dateLine('DTEND', end),
      ...(event.description ? ['DESCRIPTION:' + encodeText(safeText(event.description, 5000, true))] : []),
      ...(event.location ? ['LOCATION:' + encodeText(safeText(event.location, 500))] : []), 'END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldCalendarLine).join('\r\n') + '\r\n'
}
