import { randomUUID } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { Id } from '@xpanel/core'
import { sanitizeEmailHtml } from './mime.ts'

export type SharePermission = 'read' | 'read-write'
export type EffectiveAccessRole = 'owner' | 'read-write' | 'read' | 'none'

export interface ResourceShareGrant {
  principal: string
  permission: SharePermission
  sharedAt: string
}

export interface CalendarEventRecord {
  /** Internal panel ID (independent of external ICS UID) */
  id: Id
  /** External RFC 5545 UID preserved verbatim across import/export round-trips */
  externalUid: string
  calendarId: Id
  summary: string
  description: string
  location: string
  dtstart: string
  dtend: string
  timezone: string
  rrule: string | null
  exdates: string[]
  recurrenceId: string | null
  unsupportedProperties: Record<string, string>
  revision: number
  updatedAt: string
}

export interface CalendarCollection {
  id: Id
  owner: string
  name: string
  color: string
  timezone: string
  shares: ResourceShareGrant[]
  revision: number
  createdAt: string
  updatedAt: string
}

export interface ContactRecord {
  /** Internal panel ID */
  id: Id
  /** External vCard UID preserved verbatim across import/export round-trips */
  externalUid: string
  owner: string
  version: '3.0' | '4.0'
  fullName: string
  structuredName: string
  emails: string[]
  phones: string[]
  organization: string
  title: string
  note: string
  groups: string[]
  shares: ResourceShareGrant[]
  unsupportedProperties: Record<string, string>
  revision: number
  createdAt: string
  updatedAt: string
}

export interface ImportLimits {
  maxBytes?: number
  maxItems?: number
  maxRecurrenceCount?: number
}

export interface IcsImportResult {
  imported: CalendarEventRecord[]
  updated: CalendarEventRecord[]
  conflicts: {
    externalUid: string
    existingRevision: number
    existingSummary: string
    incomingSummary: string
  }[]
  unsupportedPreview: { externalUid: string; properties: string[] }[]
  blockedHostileFields: string[]
}

export interface VcardImportResult {
  imported: ContactRecord[]
  updated: ContactRecord[]
  conflicts: {
    externalUid: string
    existingRevision: number
    existingFullName: string
    incomingFullName: string
  }[]
  unsupportedPreview: { externalUid: string; properties: string[] }[]
  blockedHostileFields: string[]
}

const DEFAULT_MAX_IMPORT_BYTES = 2 * 1024 * 1024 // 2 MiB
const DEFAULT_MAX_IMPORT_ITEMS = 500
const DEFAULT_MAX_RECURRENCE_COUNT = 730

const ARABIC_INDIC_DIGITS_MAP: Readonly<Record<string, string>> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
}

/**
 * Normalizes Eastern Arabic / Persian numerals to ASCII digits `0-9` for UI and export consistency.
 */
export const toAsciiDigits = (input: string): string =>
  input.replace(/[٠-٩۰-۹]/g, (ch) => ARABIC_INDIC_DIGITS_MAP[ch] ?? ch)

const normalizePrincipal = (mailbox: string): string => {
  const clean = mailbox.trim().toLowerCase()
  if (!clean.includes('@') || /[\s\r\n\u0000]/.test(clean)) {
    fail('VALIDATION', `invalid mailbox principal "${mailbox}"`)
  }
  return clean
}

const unfoldRfcLines = (raw: string): string[] =>
  raw
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)

const unescapeIcsText = (val: string): string =>
  val
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')

const escapeIcsText = (val: string): string =>
  val
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')

const decodeQuotedPrintableUtf8 = (input: string): string => {
  const joined = input.replace(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=' && i + 2 < joined.length) {
      const hex = joined.slice(i + 1, i + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16))
        i += 2
        continue
      }
    }
    bytes.push(joined.charCodeAt(i) & 0xff)
  }
  return Buffer.from(bytes).toString('utf8')
}

const sanitizeFieldValue = (
  raw: string,
  blockedOut: string[],
  fieldLabel: string,
): string => {
  let cleaned = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  const lower = cleaned.toLowerCase()
  if (
    lower.includes('<script') ||
    lower.includes('<iframe') ||
    lower.includes('<object') ||
    lower.includes('<embed') ||
    lower.includes('javascript:') ||
    lower.includes('vbscript:') ||
    lower.includes('data:text/html') ||
    lower.includes('file://') ||
    /\bon[a-z]+\s*=/.test(lower)
  ) {
    blockedOut.push(fieldLabel)
    const report = sanitizeEmailHtml(cleaned)
    cleaned = report.sanitizedHtml
      .replace(/<[^>]+>/g, '')
      .replace(/javascript:/gi, '')
      .replace(/vbscript:/gi, '')
      .replace(/file:\/\/[^\s]*/gi, '')
      .trim()
  }
  return toAsciiDigits(cleaned)
}

/**
 * M05 PersonalDataAuthority:
 * Unified, owner-scoped authority for contacts (vCard 3.0/4.0) and calendars (iCalendar RFC 5545)
 * with strict ACLs (`private`, `read`, `read-write`, `owner`), immediate share revocation,
 * revision CAS conflict detection, external UID preservation, and Arabic UTF-8 round-trip fidelity.
 */
export class PersonalDataAuthority {
  private readonly calendars = new Map<Id, CalendarCollection>()
  private readonly eventsByCalendar = new Map<Id, Map<Id, CalendarEventRecord>>()
  private readonly contacts = new Map<Id, ContactRecord>()

  /**
   * Explicitly reports network CalDAV/CardDAV protocol status as unavailable until
   * a dedicated DAV network daemon is separately qualified (per M05 requirement #10).
   */
  getNetworkDavCapabilityStatus(): {
    networkDavServerActive: false
    status: 'unavailable_until_qualified'
    supportedLocalFormats: readonly ['vcard-3.0', 'vcard-4.0', 'icalendar-2.0']
  } {
    return {
      networkDavServerActive: false,
      status: 'unavailable_until_qualified',
      supportedLocalFormats: ['vcard-3.0', 'vcard-4.0', 'icalendar-2.0'],
    }
  }

  private resolveCalendarRole(cal: CalendarCollection, callerPrincipal: string): EffectiveAccessRole {
    const caller = normalizePrincipal(callerPrincipal)
    if (cal.owner === caller) return 'owner'
    const share = cal.shares.find((s) => s.principal === caller)
    if (!share) return 'none'
    return share.permission
  }

  private resolveContactRole(contact: ContactRecord, callerPrincipal: string): EffectiveAccessRole {
    const caller = normalizePrincipal(callerPrincipal)
    if (contact.owner === caller) return 'owner'
    const share = contact.shares.find((s) => s.principal === caller)
    if (!share) return 'none'
    return share.permission
  }

  // ===========================================================================
  // Calendars & Events (RFC 5545)
  // ===========================================================================

  createCalendar(
    callerPrincipal: string,
    input: { name: string; color?: string; timezone?: string },
  ): CalendarCollection {
    const owner = normalizePrincipal(callerPrincipal)
    const name = toAsciiDigits(input.name.trim())
    if (!name) fail('VALIDATION', 'calendar name is required')
    const now = new Date().toISOString()
    const cal: CalendarCollection = {
      id: randomUUID(),
      owner,
      name,
      color: input.color ?? 'oklch(0.65 0.18 250)',
      timezone: input.timezone ?? 'UTC',
      shares: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    this.calendars.set(cal.id, cal)
    this.eventsByCalendar.set(cal.id, new Map())
    return structuredClone(cal)
  }

  listCalendars(callerPrincipal: string): CalendarCollection[] {
    const caller = normalizePrincipal(callerPrincipal)
    const out: CalendarCollection[] = []
    for (const cal of this.calendars.values()) {
      const role = this.resolveCalendarRole(cal, caller)
      if (role !== 'none') {
        out.push(structuredClone(cal))
      }
    }
    return out
  }

  getCalendar(callerPrincipal: string, calendarId: Id): CalendarCollection {
    const cal = this.calendars.get(calendarId)
    if (!cal) return fail('NOT_FOUND', 'calendar not found')
    const role = this.resolveCalendarRole(cal, callerPrincipal)
    // Zero metadata leak for unauthorized callers
    if (role === 'none') return fail('NOT_FOUND', 'calendar not found')
    return structuredClone(cal)
  }

  /**
   * Grants or updates a share on a calendar.
   * Only the calendar `owner` may grant or modify shares (`read-write` participants are strictly forbidden).
   */
  shareCalendar(
    callerPrincipal: string,
    calendarId: Id,
    targetPrincipal: string,
    permission: SharePermission,
  ): CalendarCollection {
    const cal = this.calendars.get(calendarId)
    if (!cal) return fail('NOT_FOUND', 'calendar not found')
    const role = this.resolveCalendarRole(cal, callerPrincipal)
    if (role === 'none') return fail('NOT_FOUND', 'calendar not found')
    if (role !== 'owner') {
      return fail('FORBIDDEN', 'only the calendar owner can grant or escalate sharing permissions')
    }

    const target = normalizePrincipal(targetPrincipal)
    if (target === cal.owner) {
      return fail('VALIDATION', 'cannot share calendar with its own owner')
    }
    if (permission !== 'read' && permission !== 'read-write') {
      return fail('VALIDATION', 'share permission must be read or read-write')
    }

    const existingIdx = cal.shares.findIndex((s) => s.principal === target)
    const grant: ResourceShareGrant = {
      principal: target,
      permission,
      sharedAt: new Date().toISOString(),
    }
    if (existingIdx >= 0) cal.shares[existingIdx] = grant
    else cal.shares.push(grant)

    cal.revision++
    cal.updatedAt = new Date().toISOString()
    return structuredClone(cal)
  }

  /**
   * Revokes a principal's share on a calendar. Immediately blocks all subsequent reads, writes, and exports.
   */
  revokeCalendarShare(
    callerPrincipal: string,
    calendarId: Id,
    targetPrincipal: string,
  ): CalendarCollection {
    const cal = this.calendars.get(calendarId)
    if (!cal) return fail('NOT_FOUND', 'calendar not found')
    const role = this.resolveCalendarRole(cal, callerPrincipal)
    if (role === 'none') return fail('NOT_FOUND', 'calendar not found')
    if (role !== 'owner') {
      return fail('FORBIDDEN', 'only the calendar owner can revoke sharing permissions')
    }
    const target = normalizePrincipal(targetPrincipal)
    cal.shares = cal.shares.filter((s) => s.principal !== target)
    cal.revision++
    cal.updatedAt = new Date().toISOString()
    return structuredClone(cal)
  }

  upsertEvent(
    callerPrincipal: string,
    calendarId: Id,
    input: {
      id?: Id
      externalUid?: string
      summary: string
      description?: string
      location?: string
      dtstart: string
      dtend: string
      timezone?: string
      rrule?: string | null
      exdates?: readonly string[]
      recurrenceId?: string | null
      expectedRevision?: number
    },
  ): CalendarEventRecord {
    const cal = this.calendars.get(calendarId)
    if (!cal) return fail('NOT_FOUND', 'calendar not found')
    const role = this.resolveCalendarRole(cal, callerPrincipal)
    if (role === 'none') return fail('NOT_FOUND', 'calendar not found')
    if (role === 'read') {
      return fail('FORBIDDEN', 'calendar is shared read-only; write access denied')
    }

    const eventsMap = this.eventsByCalendar.get(calendarId)!
    const blocked: string[] = []
    const summary = sanitizeFieldValue(input.summary, blocked, 'SUMMARY')
    const description = sanitizeFieldValue(input.description ?? '', blocked, 'DESCRIPTION')
    const location = sanitizeFieldValue(input.location ?? '', blocked, 'LOCATION')
    const dtstart = toAsciiDigits(input.dtstart.trim())
    const dtend = toAsciiDigits(input.dtend.trim())
    const timezone = input.timezone?.trim() || cal.timezone

    if (!summary || !dtstart || !dtend) {
      return fail('VALIDATION', 'event summary, dtstart, and dtend are required')
    }

    let existing: CalendarEventRecord | undefined
    if (input.id) {
      existing = eventsMap.get(input.id)
      if (!existing) return fail('NOT_FOUND', 'calendar event not found')
    } else if (input.externalUid) {
      for (const ev of eventsMap.values()) {
        if (ev.externalUid === input.externalUid) {
          existing = ev
          break
        }
      }
    }

    if (existing) {
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== existing.revision
      ) {
        fail(
          'CONFLICT',
          `calendar event revision conflict: expected ${input.expectedRevision}, actual ${existing.revision}`,
          {
            eventId: existing.id,
            externalUid: existing.externalUid,
            expectedRevision: input.expectedRevision,
            actualRevision: existing.revision,
          },
        )
      }
      const updated: CalendarEventRecord = {
        ...existing,
        summary,
        description,
        location,
        dtstart,
        dtend,
        timezone,
        rrule: input.rrule !== undefined ? input.rrule : existing.rrule,
        exdates: input.exdates ? [...input.exdates] : existing.exdates,
        recurrenceId:
          input.recurrenceId !== undefined ? input.recurrenceId : existing.recurrenceId,
        revision: existing.revision + 1,
        updatedAt: new Date().toISOString(),
      }
      eventsMap.set(updated.id, updated)
      cal.revision++
      cal.updatedAt = updated.updatedAt
      return structuredClone(updated)
    }

    const created: CalendarEventRecord = {
      id: randomUUID(),
      externalUid: input.externalUid?.trim() || `${randomUUID()}@xpanel.internal`,
      calendarId,
      summary,
      description,
      location,
      dtstart,
      dtend,
      timezone,
      rrule: input.rrule ?? null,
      exdates: input.exdates ? [...input.exdates] : [],
      recurrenceId: input.recurrenceId ?? null,
      unsupportedProperties: {},
      revision: 1,
      updatedAt: new Date().toISOString(),
    }
    eventsMap.set(created.id, created)
    cal.revision++
    cal.updatedAt = created.updatedAt
    return structuredClone(created)
  }

  listEvents(callerPrincipal: string, calendarId: Id): CalendarEventRecord[] {
    const cal = this.calendars.get(calendarId)
    if (!cal) return fail('NOT_FOUND', 'calendar not found')
    const role = this.resolveCalendarRole(cal, callerPrincipal)
    if (role === 'none') return fail('NOT_FOUND', 'calendar not found')
    const eventsMap = this.eventsByCalendar.get(calendarId) ?? new Map()
    return [...eventsMap.values()].map((e) => structuredClone(e))
  }

  /**
   * Imports an RFC 5545 iCalendar (`.ics`) payload into `calendarId`, preserving external `UID`s,
   * `TZID` timezones, `RRULE` / `EXDATE` / `RECURRENCE-ID`, Arabic UTF-8 summaries/locations,
   * and reporting revision conflicts and unsupported properties without silent data loss.
   */
  importIcs(
    callerPrincipal: string,
    calendarId: Id,
    icsText: string,
    options: {
      limits?: ImportLimits
      expectedRevisionsByExternalUid?: Readonly<Record<string, number>>
    } = {},
  ): IcsImportResult {
    const cal = this.calendars.get(calendarId)
    if (!cal) return fail('NOT_FOUND', 'calendar not found')
    const role = this.resolveCalendarRole(cal, callerPrincipal)
    if (role === 'none') return fail('NOT_FOUND', 'calendar not found')
    if (role === 'read') return fail('FORBIDDEN', 'cannot import ICS into a read-only shared calendar')

    const maxBytes = options.limits?.maxBytes ?? DEFAULT_MAX_IMPORT_BYTES
    const maxItems = options.limits?.maxItems ?? DEFAULT_MAX_IMPORT_ITEMS
    const maxRecurrenceCount = options.limits?.maxRecurrenceCount ?? DEFAULT_MAX_RECURRENCE_COUNT

    if (Buffer.byteLength(icsText, 'utf8') > maxBytes) {
      fail('VALIDATION', `ICS payload exceeds maximum allowed size (${maxBytes} bytes)`)
    }

    const lines = unfoldRfcLines(icsText)
    if (!lines.some((l) => l.toUpperCase() === 'BEGIN:VCALENDAR')) {
      fail('VALIDATION', 'invalid iCalendar payload: missing BEGIN:VCALENDAR')
    }

    const imported: CalendarEventRecord[] = []
    const updated: CalendarEventRecord[] = []
    const conflicts: IcsImportResult['conflicts'] = []
    const unsupportedPreview: IcsImportResult['unsupportedPreview'] = []
    const blockedHostileFields: string[] = []

    const eventsMap = this.eventsByCalendar.get(calendarId)!
    let inEvent = false
    let currentProps: { name: string; params: Record<string, string>; value: string }[] = []
    let calendarDefaultTz = cal.timezone
    let itemsCount = 0

    for (const line of lines) {
      const upper = line.toUpperCase()
      if (upper.startsWith('X-WR-TIMEZONE:')) {
        calendarDefaultTz = line.slice('X-WR-TIMEZONE:'.length).trim() || calendarDefaultTz
        continue
      }
      if (upper === 'BEGIN:VEVENT') {
        inEvent = true
        currentProps = []
        continue
      }
      if (upper === 'END:VEVENT') {
        if (!inEvent) continue
        inEvent = false
        itemsCount++
        if (itemsCount > maxItems) {
          fail('VALIDATION', `ICS import exceeds maximum VEVENT count (${maxItems})`)
        }

        let externalUid = ''
        let summary = ''
        let description = ''
        let location = ''
        let dtstart = ''
        let dtend = ''
        let timezone = calendarDefaultTz
        let rrule: string | null = null
        const exdates: string[] = []
        let recurrenceId: string | null = null
        const unsupportedProps: Record<string, string> = {}

        for (const prop of currentProps) {
          switch (prop.name) {
            case 'UID':
              externalUid = prop.value.trim()
              break
            case 'SUMMARY':
              summary = sanitizeFieldValue(unescapeIcsText(prop.value), blockedHostileFields, 'VEVENT.SUMMARY')
              break
            case 'DESCRIPTION':
              description = sanitizeFieldValue(unescapeIcsText(prop.value), blockedHostileFields, 'VEVENT.DESCRIPTION')
              break
            case 'LOCATION':
              location = sanitizeFieldValue(unescapeIcsText(prop.value), blockedHostileFields, 'VEVENT.LOCATION')
              break
            case 'DTSTART':
              dtstart = toAsciiDigits(prop.value.trim())
              if (prop.params['TZID']) timezone = prop.params['TZID']
              break
            case 'DTEND':
              dtend = toAsciiDigits(prop.value.trim())
              if (prop.params['TZID'] && !timezone) timezone = prop.params['TZID']
              break
            case 'RRULE': {
              const rruleVal = toAsciiDigits(prop.value.trim())
              const countMatch = /\bCOUNT=(\d+)/i.exec(rruleVal)
              if (countMatch && Number.parseInt(countMatch[1]!, 10) > maxRecurrenceCount) {
                fail('VALIDATION', `RRULE COUNT exceeds maximum limit (${maxRecurrenceCount})`)
              }
              rrule = rruleVal
              break
            }
            case 'EXDATE':
              for (const part of prop.value.split(',')) {
                if (part.trim()) exdates.push(toAsciiDigits(part.trim()))
              }
              break
            case 'RECURRENCE-ID':
              recurrenceId = toAsciiDigits(prop.value.trim())
              break
            case 'ATTACH':
            case 'URL': {
              const lowerVal = prop.value.trim().toLowerCase()
              if (
                lowerVal.startsWith('javascript:') ||
                lowerVal.startsWith('vbscript:') ||
                lowerVal.startsWith('data:') ||
                lowerVal.startsWith('file:') ||
                lowerVal.startsWith('http://') ||
                lowerVal.startsWith('https://')
              ) {
                blockedHostileFields.push(`VEVENT.${prop.name}`)
              }
              break
            }
            case 'DTSTAMP':
            case 'CREATED':
            case 'LAST-MODIFIED':
            case 'SEQUENCE':
            case 'STATUS':
            case 'TRANSP':
              break
            default:
              unsupportedProps[prop.name] = sanitizeFieldValue(prop.value, blockedHostileFields, `VEVENT.${prop.name}`)
              break
          }
        }

        if (!externalUid) {
          fail('VALIDATION', 'VEVENT is missing required UID property')
        }
        if (!summary || !dtstart) {
          fail('VALIDATION', `VEVENT "${externalUid}" is missing required SUMMARY or DTSTART`)
        }
        if (!dtend) dtend = dtstart

        if (Object.keys(unsupportedProps).length > 0) {
          unsupportedPreview.push({
            externalUid,
            properties: Object.keys(unsupportedProps),
          })
        }

        let existing: CalendarEventRecord | undefined
        for (const ev of eventsMap.values()) {
          if (ev.externalUid === externalUid) {
            existing = ev
            break
          }
        }

        if (existing) {
          const expectedRev = options.expectedRevisionsByExternalUid?.[externalUid]
          if (expectedRev !== undefined && expectedRev !== existing.revision) {
            conflicts.push({
              externalUid,
              existingRevision: existing.revision,
              existingSummary: existing.summary,
              incomingSummary: summary,
            })
            continue
          }
          // Idempotent update if content changed, or preserve revision if identical
          const isIdentical =
            existing.summary === summary &&
            existing.description === description &&
            existing.location === location &&
            existing.dtstart === dtstart &&
            existing.dtend === dtend &&
            existing.timezone === timezone &&
            existing.rrule === rrule &&
            existing.exdates.join(',') === exdates.join(',') &&
            existing.recurrenceId === recurrenceId

          const nextRecord: CalendarEventRecord = {
            ...existing,
            summary,
            description,
            location,
            dtstart,
            dtend,
            timezone,
            rrule,
            exdates,
            recurrenceId,
            unsupportedProperties: { ...existing.unsupportedProperties, ...unsupportedProps },
            revision: isIdentical ? existing.revision : existing.revision + 1,
            updatedAt: isIdentical ? existing.updatedAt : new Date().toISOString(),
          }
          eventsMap.set(nextRecord.id, nextRecord)
          updated.push(structuredClone(nextRecord))
        } else {
          const created: CalendarEventRecord = {
            id: randomUUID(),
            externalUid,
            calendarId,
            summary,
            description,
            location,
            dtstart,
            dtend,
            timezone,
            rrule,
            exdates,
            recurrenceId,
            unsupportedProperties: unsupportedProps,
            revision: 1,
            updatedAt: new Date().toISOString(),
          }
          eventsMap.set(created.id, created)
          imported.push(structuredClone(created))
        }
        continue
      }

      if (inEvent) {
        const parsed = this.parsePropertyLine(line)
        if (parsed) currentProps.push(parsed)
      }
    }

    return {
      imported,
      updated,
      conflicts,
      unsupportedPreview,
      blockedHostileFields,
    }
  }

  /**
   * Exports `calendarId` to a standards-compliant RFC 5545 `.ics` string,
   * preserving external `UID`s, `TZID`, `RRULE`, `EXDATE`, `RECURRENCE-ID`, and Arabic UTF-8 fields.
   * Immediately rejects if `callerPrincipal`'s access was revoked or never granted.
   */
  exportIcs(callerPrincipal: string, calendarId: Id): string {
    const cal = this.calendars.get(calendarId)
    if (!cal) return fail('NOT_FOUND', 'calendar not found')
    const role = this.resolveCalendarRole(cal, callerPrincipal)
    if (role === 'none') return fail('NOT_FOUND', 'calendar not found')

    const events = this.listEvents(callerPrincipal, calendarId)
    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//xPanel//PersonalDataAuthority//EN',
      'CALSCALE:GREGORIAN',
      `X-WR-CALNAME:${escapeIcsText(cal.name)}`,
      `X-WR-TIMEZONE:${cal.timezone}`,
    ]

    for (const ev of events) {
      lines.push('BEGIN:VEVENT')
      lines.push(`UID:${ev.externalUid}`)
      lines.push(`SUMMARY:${escapeIcsText(ev.summary)}`)
      if (ev.description) lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`)
      if (ev.location) lines.push(`LOCATION:${escapeIcsText(ev.location)}`)
      if (ev.timezone && !ev.dtstart.endsWith('Z')) {
        lines.push(`DTSTART;TZID=${ev.timezone}:${toAsciiDigits(ev.dtstart)}`)
        lines.push(`DTEND;TZID=${ev.timezone}:${toAsciiDigits(ev.dtend)}`)
      } else {
        lines.push(`DTSTART:${toAsciiDigits(ev.dtstart)}`)
        lines.push(`DTEND:${toAsciiDigits(ev.dtend)}`)
      }
      if (ev.rrule) lines.push(`RRULE:${toAsciiDigits(ev.rrule)}`)
      for (const ex of ev.exdates) {
        lines.push(`EXDATE;TZID=${ev.timezone}:${toAsciiDigits(ex)}`)
      }
      if (ev.recurrenceId) {
        lines.push(`RECURRENCE-ID;TZID=${ev.timezone}:${toAsciiDigits(ev.recurrenceId)}`)
      }
      for (const [k, v] of Object.entries(ev.unsupportedProperties)) {
        lines.push(`${k}:${escapeIcsText(v)}`)
      }
      lines.push(`SEQUENCE:${ev.revision}`)
      lines.push('END:VEVENT')
    }

    lines.push('END:VCALENDAR')
    return `${lines.join('\r\n')}\r\n`
  }

  // ===========================================================================
  // Contacts (vCard 3.0 / 4.0)
  // ===========================================================================

  upsertContact(
    callerPrincipal: string,
    input: {
      id?: Id
      externalUid?: string
      owner?: string
      version?: '3.0' | '4.0'
      fullName: string
      structuredName?: string
      emails: readonly string[]
      phones?: readonly string[]
      organization?: string
      title?: string
      note?: string
      groups?: readonly string[]
      expectedRevision?: number
    },
  ): ContactRecord {
    const caller = normalizePrincipal(callerPrincipal)
    const blocked: string[] = []
    const fullName = sanitizeFieldValue(input.fullName, blocked, 'FN')
    const structuredName = sanitizeFieldValue(input.structuredName ?? `${fullName};;;;`, blocked, 'N')
    const organization = sanitizeFieldValue(input.organization ?? '', blocked, 'ORG')
    const title = sanitizeFieldValue(input.title ?? '', blocked, 'TITLE')
    const note = sanitizeFieldValue(input.note ?? '', blocked, 'NOTE')
    const emails = input.emails.map((e) => e.trim().toLowerCase()).filter(Boolean)
    const phones = (input.phones ?? []).map((p) => toAsciiDigits(p.trim())).filter(Boolean)
    const groups = (input.groups ?? []).map((g) => sanitizeFieldValue(g, blocked, 'CATEGORIES')).filter(Boolean)

    if (!fullName || emails.length === 0) {
      fail('VALIDATION', 'contact fullName and at least one email are required')
    }

    let existing: ContactRecord | undefined
    if (input.id) {
      existing = this.contacts.get(input.id)
      if (!existing) fail('NOT_FOUND', 'contact not found')
    } else if (input.externalUid) {
      const targetOwner = input.owner ? normalizePrincipal(input.owner) : caller
      for (const c of this.contacts.values()) {
        if (c.owner === targetOwner && c.externalUid === input.externalUid) {
          existing = c
          break
        }
      }
    }

    if (existing) {
      const role = this.resolveContactRole(existing, caller)
      if (role === 'none') fail('NOT_FOUND', 'contact not found')
      if (role === 'read') fail('FORBIDDEN', 'contact is shared read-only; write access denied')
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== existing.revision
      ) {
        fail(
          'CONFLICT',
          `contact revision conflict: expected ${input.expectedRevision}, actual ${existing.revision}`,
          {
            contactId: existing.id,
            externalUid: existing.externalUid,
            expectedRevision: input.expectedRevision,
            actualRevision: existing.revision,
          },
        )
      }

      const updated: ContactRecord = {
        ...existing,
        version: input.version ?? existing.version,
        fullName,
        structuredName,
        emails,
        phones,
        organization,
        title,
        note,
        groups,
        revision: existing.revision + 1,
        updatedAt: new Date().toISOString(),
      }
      this.contacts.set(updated.id, updated)
      return structuredClone(updated)
    }

    if (input.owner && normalizePrincipal(input.owner) !== caller) {
      fail('FORBIDDEN', 'cannot create contact owned by another principal')
    }

    const now = new Date().toISOString()
    const created: ContactRecord = {
      id: randomUUID(),
      externalUid: input.externalUid?.trim() || `urn:uuid:${randomUUID()}`,
      owner: caller,
      version: input.version ?? '3.0',
      fullName,
      structuredName,
      emails,
      phones,
      organization,
      title,
      note,
      groups,
      shares: [],
      unsupportedProperties: {},
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    this.contacts.set(created.id, created)
    return structuredClone(created)
  }

  getContact(callerPrincipal: string, contactId: Id): ContactRecord {
    const contact = this.contacts.get(contactId)
    if (!contact) return fail('NOT_FOUND', 'contact not found')
    const role = this.resolveContactRole(contact, callerPrincipal)
    if (role === 'none') return fail('NOT_FOUND', 'contact not found')
    return structuredClone(contact)
  }

  listContacts(callerPrincipal: string): ContactRecord[] {
    const caller = normalizePrincipal(callerPrincipal)
    const out: ContactRecord[] = []
    for (const c of this.contacts.values()) {
      if (this.resolveContactRole(c, caller) !== 'none') {
        out.push(structuredClone(c))
      }
    }
    return out
  }

  shareContact(
    callerPrincipal: string,
    contactId: Id,
    targetPrincipal: string,
    permission: SharePermission,
  ): ContactRecord {
    const contact = this.contacts.get(contactId)
    if (!contact) return fail('NOT_FOUND', 'contact not found')
    const role = this.resolveContactRole(contact, callerPrincipal)
    if (role === 'none') return fail('NOT_FOUND', 'contact not found')
    if (role !== 'owner') {
      return fail('FORBIDDEN', 'only the contact owner can grant or escalate sharing permissions')
    }
    const target = normalizePrincipal(targetPrincipal)
    const idx = contact.shares.findIndex((s) => s.principal === target)
    const grant: ResourceShareGrant = {
      principal: target,
      permission,
      sharedAt: new Date().toISOString(),
    }
    if (idx >= 0) contact.shares[idx] = grant
    else contact.shares.push(grant)
    contact.revision++
    contact.updatedAt = new Date().toISOString()
    return structuredClone(contact)
  }

  revokeContactShare(
    callerPrincipal: string,
    contactId: Id,
    targetPrincipal: string,
  ): ContactRecord {
    const contact = this.contacts.get(contactId)
    if (!contact) return fail('NOT_FOUND', 'contact not found')
    const role = this.resolveContactRole(contact, callerPrincipal)
    if (role === 'none') return fail('NOT_FOUND', 'contact not found')
    if (role !== 'owner') {
      return fail('FORBIDDEN', 'only the contact owner can revoke sharing permissions')
    }
    const target = normalizePrincipal(targetPrincipal)
    contact.shares = contact.shares.filter((s) => s.principal !== target)
    contact.revision++
    contact.updatedAt = new Date().toISOString()
    return structuredClone(contact)
  }

  /**
   * Imports vCard 3.0 / 4.0 contacts for `callerPrincipal`, supporting UTF-8 and Quoted-Printable
   * Arabic names, preserving external `UID`, enforcing revision conflict checks, and stripping hostile fields.
   */
  importVcards(
    callerPrincipal: string,
    vcardText: string,
    options: {
      limits?: ImportLimits
      expectedRevisionsByExternalUid?: Readonly<Record<string, number>>
    } = {},
  ): VcardImportResult {
    const owner = normalizePrincipal(callerPrincipal)
    const maxBytes = options.limits?.maxBytes ?? DEFAULT_MAX_IMPORT_BYTES
    const maxItems = options.limits?.maxItems ?? DEFAULT_MAX_IMPORT_ITEMS

    if (Buffer.byteLength(vcardText, 'utf8') > maxBytes) {
      fail('VALIDATION', `vCard payload exceeds maximum allowed size (${maxBytes} bytes)`)
    }

    const lines = unfoldRfcLines(vcardText)
    if (!lines.some((l) => l.toUpperCase() === 'BEGIN:VCARD')) {
      fail('VALIDATION', 'invalid vCard payload: missing BEGIN:VCARD')
    }

    const imported: ContactRecord[] = []
    const updated: ContactRecord[] = []
    const conflicts: VcardImportResult['conflicts'] = []
    const unsupportedPreview: VcardImportResult['unsupportedPreview'] = []
    const blockedHostileFields: string[] = []

    let inCard = false
    let currentProps: { name: string; params: Record<string, string>; value: string }[] = []
    let itemsCount = 0

    for (const line of lines) {
      const upper = line.toUpperCase()
      if (upper === 'BEGIN:VCARD') {
        inCard = true
        currentProps = []
        continue
      }
      if (upper === 'END:VCARD') {
        if (!inCard) continue
        inCard = false
        itemsCount++
        if (itemsCount > maxItems) {
          fail('VALIDATION', `vCard import exceeds maximum item count (${maxItems})`)
        }

        let version: '3.0' | '4.0' = '3.0'
        let externalUid = ''
        let fullName = ''
        let structuredName = ''
        const emails: string[] = []
        const phones: string[] = []
        let organization = ''
        let title = ''
        let note = ''
        const groups: string[] = []
        const unsupportedProps: Record<string, string> = {}

        for (const prop of currentProps) {
          const isQp =
            (prop.params['ENCODING'] ?? '').toUpperCase() === 'QUOTED-PRINTABLE'
          const rawVal = isQp ? decodeQuotedPrintableUtf8(prop.value) : prop.value

          switch (prop.name) {
            case 'VERSION':
              version = rawVal.trim() === '4.0' ? '4.0' : '3.0'
              break
            case 'UID':
              externalUid = rawVal.trim()
              break
            case 'FN':
              fullName = sanitizeFieldValue(unescapeIcsText(rawVal), blockedHostileFields, 'VCARD.FN')
              break
            case 'N':
              structuredName = sanitizeFieldValue(rawVal, blockedHostileFields, 'VCARD.N')
              break
            case 'EMAIL':
              if (rawVal.trim().includes('@')) {
                emails.push(rawVal.trim().toLowerCase())
              }
              break
            case 'TEL':
              phones.push(toAsciiDigits(rawVal.trim()))
              break
            case 'ORG':
              organization = sanitizeFieldValue(unescapeIcsText(rawVal), blockedHostileFields, 'VCARD.ORG')
              break
            case 'TITLE':
              title = sanitizeFieldValue(unescapeIcsText(rawVal), blockedHostileFields, 'VCARD.TITLE')
              break
            case 'NOTE':
              note = sanitizeFieldValue(unescapeIcsText(rawVal), blockedHostileFields, 'VCARD.NOTE')
              break
            case 'CATEGORIES':
              for (const g of rawVal.split(',')) {
                const cleanG = sanitizeFieldValue(g.trim(), blockedHostileFields, 'VCARD.CATEGORIES')
                if (cleanG) groups.push(cleanG)
              }
              break
            case 'PHOTO':
            case 'LOGO':
            case 'SOUND':
            case 'KEY':
            case 'URL': {
              const lowerVal = rawVal.trim().toLowerCase()
              if (
                lowerVal.startsWith('http://') ||
                lowerVal.startsWith('https://') ||
                lowerVal.startsWith('javascript:') ||
                lowerVal.startsWith('vbscript:') ||
                lowerVal.startsWith('data:text/html') ||
                lowerVal.startsWith('file:') ||
                (prop.params['VALUE'] ?? '').toUpperCase() === 'URI'
              ) {
                blockedHostileFields.push(`VCARD.${prop.name}`)
              }
              break
            }
            case 'PRODID':
            case 'REV':
              break
            default:
              unsupportedProps[prop.name] = sanitizeFieldValue(rawVal, blockedHostileFields, `VCARD.${prop.name}`)
              break
          }
        }

        if (!fullName || emails.length === 0) {
          fail('VALIDATION', 'vCard entry requires FN and at least one EMAIL')
        }
        if (!externalUid) {
          externalUid = `urn:uuid:${randomUUID()}`
        }
        if (!structuredName) {
          structuredName = `${fullName};;;;`
        }

        if (Object.keys(unsupportedProps).length > 0) {
          unsupportedPreview.push({
            externalUid,
            properties: Object.keys(unsupportedProps),
          })
        }

        let existing: ContactRecord | undefined
        for (const c of this.contacts.values()) {
          if (c.owner === owner && c.externalUid === externalUid) {
            existing = c
            break
          }
        }

        if (existing) {
          const expectedRev = options.expectedRevisionsByExternalUid?.[externalUid]
          if (expectedRev !== undefined && expectedRev !== existing.revision) {
            conflicts.push({
              externalUid,
              existingRevision: existing.revision,
              existingFullName: existing.fullName,
              incomingFullName: fullName,
            })
            continue
          }

          const isIdentical =
            existing.fullName === fullName &&
            existing.structuredName === structuredName &&
            existing.emails.join(',') === emails.join(',') &&
            existing.phones.join(',') === phones.join(',') &&
            existing.organization === organization &&
            existing.title === title &&
            existing.note === note

          const nextContact: ContactRecord = {
            ...existing,
            version,
            fullName,
            structuredName,
            emails,
            phones,
            organization,
            title,
            note,
            groups,
            unsupportedProperties: { ...existing.unsupportedProperties, ...unsupportedProps },
            revision: isIdentical ? existing.revision : existing.revision + 1,
            updatedAt: isIdentical ? existing.updatedAt : new Date().toISOString(),
          }
          this.contacts.set(nextContact.id, nextContact)
          updated.push(structuredClone(nextContact))
        } else {
          const now = new Date().toISOString()
          const created: ContactRecord = {
            id: randomUUID(),
            externalUid,
            owner,
            version,
            fullName,
            structuredName,
            emails,
            phones,
            organization,
            title,
            note,
            groups,
            shares: [],
            unsupportedProperties: unsupportedProps,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          }
          this.contacts.set(created.id, created)
          imported.push(structuredClone(created))
        }
        continue
      }

      if (inCard) {
        const parsed = this.parsePropertyLine(line)
        if (parsed) currentProps.push(parsed)
      }
    }

    return {
      imported,
      updated,
      conflicts,
      unsupportedPreview,
      blockedHostileFields,
    }
  }

  /**
   * Exports all contacts owned by or shared with `callerPrincipal` (or a specific list of contact IDs)
   * as RFC 6350 / RFC 2426 vCard text, preserving `UID`, Arabic UTF-8 `FN`/`N`/`ORG`/`TITLE`, and ASCII phone digits.
   */
  exportVcards(callerPrincipal: string, contactIds?: readonly Id[]): string {
    const caller = normalizePrincipal(callerPrincipal)
    const selected: ContactRecord[] = []

    if (contactIds && contactIds.length > 0) {
      for (const id of contactIds) {
        selected.push(this.getContact(caller, id))
      }
    } else {
      selected.push(...this.listContacts(caller))
    }

    const blocks: string[] = []
    for (const c of selected) {
      const lines: string[] = [
        'BEGIN:VCARD',
        `VERSION:${c.version}`,
        `UID:${c.externalUid}`,
        `FN:${escapeIcsText(c.fullName)}`,
        `N:${c.structuredName}`,
      ]
      for (const em of c.emails) {
        lines.push(`EMAIL;TYPE=INTERNET:${em}`)
      }
      for (const tel of c.phones) {
        lines.push(`TEL;TYPE=CELL:${toAsciiDigits(tel)}`)
      }
      if (c.organization) lines.push(`ORG:${escapeIcsText(c.organization)}`)
      if (c.title) lines.push(`TITLE:${escapeIcsText(c.title)}`)
      if (c.note) lines.push(`NOTE:${escapeIcsText(c.note)}`)
      if (c.groups.length > 0) lines.push(`CATEGORIES:${c.groups.join(',')}`)
      for (const [k, v] of Object.entries(c.unsupportedProperties)) {
        lines.push(`${k}:${escapeIcsText(v)}`)
      }
      lines.push('END:VCARD')
      blocks.push(lines.join('\r\n'))
    }

    return blocks.length > 0 ? `${blocks.join('\r\n')}\r\n` : ''
  }

  private parsePropertyLine(
    line: string,
  ): { name: string; params: Record<string, string>; value: string } | null {
    const colonIdx = line.indexOf(':')
    if (colonIdx <= 0) return null
    const left = line.slice(0, colonIdx)
    const value = line.slice(colonIdx + 1)
    const parts = left.split(';')
    const rawName = (parts[0] ?? '').trim()
    // Strip optional vCard group prefix like `item1.EMAIL`
    const dotIdx = rawName.lastIndexOf('.')
    const name = (dotIdx >= 0 ? rawName.slice(dotIdx + 1) : rawName).toUpperCase()
    const params: Record<string, string> = {}

    for (let i = 1; i < parts.length; i++) {
      const p = parts[i]!
      const eq = p.indexOf('=')
      if (eq > 0) {
        const k = p.slice(0, eq).trim().toUpperCase()
        const v = p.slice(eq + 1).trim().replace(/^"|"$/g, '')
        params[k] = v
      } else if (p.trim()) {
        params[p.trim().toUpperCase()] = 'TRUE'
      }
    }

    return { name, params, value }
  }
}
