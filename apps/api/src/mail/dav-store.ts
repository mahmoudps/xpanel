import { createHash, randomUUID } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, MailboxMetadataAuthority } from '@xpanel/core'
import { system } from '@xpanel/render'
import type { AuthenticatedCaller } from '../auth.ts'
import type { WebmailCalendar, WebmailCalendarEvent, WebmailContact } from '../extended-routes.ts'
import { calendarLocalToUtc, foldCalendarLine } from './calendar-ics.ts'
import { calendarColor, calendarTimestamp, calendarTimezone } from './calendar-workspace.ts'
import { escapeContactVcardText, MAX_STORED_CARD_BYTES, readContactVcards, rewriteContactVcard } from './contact-vcard.ts'
import { normalizeContactGroupName } from './contact-workspace.ts'

/**
 * xMail's calendars and contacts live in the account's Radicale store, the one devices sync, so an event made on
 * either side is the same item (docs/decisions/2026-11-07-dav-servers.md). Reads come from the launcher's file
 * view; writes go through Radicale. Item content is the account's own and is treated as untrusted: anything this
 * model cannot show is left out, never rewritten.
 */
export interface DavExchangeInput {
  /** the store identity the request runs as: main or a service user id */
  principal: string
  method: 'GET' | 'PUT' | 'DELETE' | 'PROPPATCH' | 'MKCALENDAR' | 'MKCOL'
  path: string
  body?: string
  contentType?: string
  ifMatch?: string
  ifNoneMatch?: boolean
}
export interface DavExchangeReply { status: number; etag: string | null; body: string }
export type DavExchange = (caller: AuthenticatedCaller, account: Pick<Account, 'username'>, input: DavExchangeInput) => Promise<DavExchangeReply>

export interface ContactGroupRecord { owner: string; ownerAuthority?: MailboxMetadataAuthority; name: string; createdAt: string | null }
export interface DavCollectionView { id: string; collection: string; owner: string; name: string; description: string }
export interface DavCollections { calendars: DavCollectionView[]; addressBooks: DavCollectionView[]; taskLists: DavCollectionView[] }
export interface DavSession {
  calendars(): Promise<WebmailCalendar[]>
  publishCalendars(next: readonly WebmailCalendar[]): Promise<void>
  contacts(): Promise<WebmailContact[]>
  publishContacts(next: readonly WebmailContact[]): Promise<void>
  groups(): Promise<ContactGroupRecord[]>
  publishGroups(next: readonly ContactGroupRecord[]): Promise<void>
  collections(): Promise<DavCollections>
  /** returns the new collection's id in collections() */
  createCollection(kind: 'addressbook' | 'tasks', name: string, description: string): Promise<string>
  updateCollection(collection: string, kind: 'calendar' | 'addressbook' | 'tasks', changes: { name?: string; description?: string }): Promise<void>
  deleteCollection(collection: string): Promise<void>
  isDefaultCalendar(id: string): boolean
}
export interface DavSessionPorts {
  exchange: DavExchange
  /** the account's service users, the only owners a collection can have */
  listServiceUsers(accountId: string): Promise<readonly { id: string; login: string; services: { email: boolean } }[]>
}

export const DEFAULT_CALENDAR = 'calendar'
export const DEFAULT_ADDRESS_BOOK = 'addressbook'
const X = 'urn:xpanel:dav'
const TIMEZONE = `{${X}}timezone`, CREATED = `{${X}}created`, SHARES = `{${X}}shares`, CONTACT_SHARES = `{${X}}contact-shares`, GROUPS = `{${X}}contact-groups`
const GRANTEES = system.CALDAV_GRANTEES_PROP
const EPOCH = '1970-01-01T00:00:00.000Z'
/** What one request may hold in memory on a 1 GB server; a store beyond it is refused, never shown in part. */
export const DAV_STORE_READ_BYTES = 16 * 1024 * 1024
const DAV_STORE_READ_PAGES = 64
const DEFAULT_COLOR = 'oklch(0.65 0.18 250)'

const unavailable = (): never => fail('SERVICE_UNAVAILABLE', 'the calendar store is not available', { stateChanged: false, reason: 'dav_store_unavailable' })
export const davStoreTooLarge = (): never => fail('PRECONDITION_FAILED', 'this mailbox store is too large to open here', { stateChanged: false, reason: 'dav_store_too_large' })
export const isDavStoreTooLarge = (error: unknown): boolean => isXpanelError(error) && error.detail?.reason === 'dav_store_too_large'
const conflict = (): never => fail('CONFLICT', 'the item changed on another device; reload before saving', { stateChanged: false, reason: 'dav_item_changed' })
const refused = (): never => fail('SERVICE_UNAVAILABLE', 'the calendar store refused the change', { stateChanged: true, verificationRequired: true, unknownOutcome: true, reason: 'dav_write_refused' })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const tryOr = <T>(work: () => T, fallback: T): T => { try { return work() } catch { return fallback } }

/** A panel-made name is its own id; a device's is hashed into the same shape, so ids stay stable either way. */
export const davItemId = (owner: string, collection: string, name: string): string => {
  const stem = name.replace(/\.(?:ics|vcf)$/i, '').toLowerCase()
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(stem)) return stem
  const hex = createHash('sha256').update([owner, collection, name].join('\0')).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/g
const clip = (value: string, maximum: number): string => {
  let result = value
  while (Buffer.byteLength(result, 'utf8') > maximum) result = result.slice(0, Math.floor(result.length * 0.9))
  return result.isWellFormed() ? result : result.toWellFormed()
}
const line = (value: unknown, maximum: number): string => typeof value === 'string' ? clip(value.replace(CONTROL, '').replace(/\s+/g, ' ').trim(), maximum) : ''
const multiline = (value: unknown, maximum: number): string => typeof value === 'string' ? clip(value.replace(/\r\n|\r/g, '\n').replace(CONTROL, '').trim(), maximum) : ''

// ---------------------------------------------------------------- iCalendar items

interface ContentLine { name: string; params: Record<string, string>; value: string }
const CONTENT_LINE = /^([A-Za-z0-9-]+)((?:;[A-Za-z0-9-]+=(?:"[^"]*"|[^;:]*))*):(.*)$/s
const unfold = (text: string): string[] => {
  const lines: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && lines.length) lines[lines.length - 1] += raw.slice(1)
    else if (raw) lines.push(raw)
  }
  return lines
}
const parseLine = (raw: string): ContentLine | null => {
  const match = CONTENT_LINE.exec(raw)
  if (!match) return null
  const params: Record<string, string> = {}
  for (const part of match[2]!.split(';').slice(1)) {
    const at = part.indexOf('=')
    params[part.slice(0, at).toUpperCase()] = part.slice(at + 1).replace(/^"|"$/g, '')
  }
  return { name: match[1]!.toUpperCase(), params, value: match[3]! }
}
const decodeText = (value: string): string => value.replace(/\\([nN,;\\])/g, (_all, escaped: string) => /[nN]/.test(escaped) ? '\n' : escaped)
const encodeText = (value: string): string => value.replaceAll('\\', '\\\\').replace(/\r\n|\r|\n/g, '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;')

/** The properties of the event itself: the first VEVENT without a RECURRENCE-ID, nested alarms left out. */
const masterEvent = (text: string): Map<string, ContentLine> | null => {
  let depth = 0, current: Map<string, ContentLine> | null = null, first: Map<string, ContentLine> | null = null
  for (const raw of unfold(text)) {
    const parsed = parseLine(raw)
    if (!parsed) continue
    if (parsed.name === 'BEGIN') {
      if (current) depth++
      else if (parsed.value.toUpperCase() === 'VEVENT') { current = new Map(); depth = 0 }
    } else if (parsed.name === 'END') {
      if (!current) continue
      if (depth > 0) { depth--; continue }
      if (parsed.value.toUpperCase() === 'VEVENT') {
        if (!current.has('RECURRENCE-ID')) return current
        first ??= current
        current = null
      }
    } else if (current && depth === 0 && !current.has(parsed.name)) current.set(parsed.name, parsed)
  }
  return first
}
const DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/
const addDuration = (start: string, duration: string): string | null => {
  const match = DURATION.exec(duration)
  if (!match) return null
  const seconds = (Number(match[1] ?? 0) * 7 + Number(match[2] ?? 0)) * 86400 + Number(match[3] ?? 0) * 3600 + Number(match[4] ?? 0) * 60 + Number(match[5] ?? 0)
  const at = new Date(0)
  at.setUTCFullYear(Number(start.slice(0, 4)), Number(start.slice(4, 6)) - 1, Number(start.slice(6, 8)))
  if (start.length > 8) at.setUTCHours(Number(start.slice(9, 11)), Number(start.slice(11, 13)), Number(start.slice(13, 15)))
  const shifted = new Date(at.getTime() + seconds * 1000).toISOString().replace(/[-:]/g, '').slice(0, 15)
  return start.length === 8 ? shifted.slice(0, 8) : shifted + (start.endsWith('Z') ? 'Z' : '')
}

/** Null for an item without a usable event, a task for example. */
export const parseDavEvent = (text: string, href: string, id: string, fallbackZone: string): WebmailCalendarEvent | null => {
  const event = masterEvent(text)
  const start = event?.get('DTSTART')
  if (!event || !start) return null
  const dtstart = tryOr(() => calendarTimestamp(start.value, 'DTSTART'), null)
  if (!dtstart) return null
  const endLine = event.get('DTEND')
  const proposed = endLine ? tryOr(() => calendarTimestamp(endLine.value, 'DTEND'), null) : event.has('DURATION') ? addDuration(dtstart, event.get('DURATION')!.value) : dtstart
  const dtend = proposed && proposed.length === dtstart.length && proposed >= dtstart ? proposed : dtstart
  const zone = dtstart.endsWith('Z') ? 'UTC' : tryOr(() => calendarTimezone(start.params.TZID ?? fallbackZone), fallbackZone)
  return { id, uid: line(event.get('UID')?.value, 512) || href, summary: line(decodeText(event.get('SUMMARY')?.value ?? ''), 300) || 'Untitled event',
    description: multiline(decodeText(event.get('DESCRIPTION')?.value ?? ''), 5000), location: line(decodeText(event.get('LOCATION')?.value ?? ''), 500), dtstart, dtend, timezone: zone }
}

const utcNumber = (value: string): number => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)), Number(value.slice(9, 11)), Number(value.slice(11, 13)), Number(value.slice(13, 15)))
const offsetText = (local: string, zone: string): string => {
  const minutes = Math.round((utcNumber(local) - utcNumber(calendarLocalToUtc(local, zone))) / 60000), size = Math.abs(minutes)
  return (minutes < 0 ? '-' : '+') + String(Math.floor(size / 60)).padStart(2, '0') + String(size % 60).padStart(2, '0')
}
// shortcut: one fixed offset per event, the offset at its start; a repeating event from a device keeps its own VTIMEZONE.
const timezoneBlock = (zone: string, local: string): string[] => {
  const offset = offsetText(local, zone)
  return ['BEGIN:VTIMEZONE', 'TZID:' + zone, 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:' + offset, 'TZOFFSETTO:' + offset, 'END:STANDARD', 'END:VTIMEZONE']
}
const needsZone = (value: string, zone: string): boolean => value.length > 8 && !value.endsWith('Z') && zone !== 'UTC'
const dateLine = (name: string, value: string, zone: string): string => value.length === 8 ? `${name};VALUE=DATE:${value}`
  : value.endsWith('Z') ? `${name}:${value}` : zone === 'UTC' ? `${name}:${value}Z` : `${name};TZID=${zone}:${value}`
const stamp = (at: Date): string => at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
const eventProperties = (event: WebmailCalendarEvent): string[] => [
  'SUMMARY:' + encodeText(event.summary), dateLine('DTSTART', event.dtstart, event.timezone), dateLine('DTEND', event.dtend, event.timezone),
  ...(event.description ? ['DESCRIPTION:' + encodeText(event.description)] : []), ...(event.location ? ['LOCATION:' + encodeText(event.location)] : []),
]

export const renderDavEvent = (event: WebmailCalendarEvent, at = new Date()): string => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//xPanel//xMail//EN', ...(needsZone(event.dtstart, event.timezone) ? timezoneBlock(event.timezone, event.dtstart) : []),
  'BEGIN:VEVENT', 'UID:' + encodeText(event.uid), 'DTSTAMP:' + stamp(at), ...eventProperties(event), 'END:VEVENT', 'END:VCALENDAR',
].map(foldCalendarLine).join('\r\n') + '\r\n'

/** Writes the changed fields into the stored item and keeps everything else: alarms, attendees, repeat rules. */
export const rewriteDavEvent = (source: string, before: WebmailCalendarEvent, after: WebmailCalendarEvent, at = new Date()): string => {
  const blocks: string[] = []
  for (const raw of source.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && blocks.length) blocks[blocks.length - 1] += '\r\n' + raw
    else if (raw) blocks.push(raw)
  }
  const name = (block: string): string => (/^[A-Za-z0-9-]+/.exec(block)?.[0] ?? '').toUpperCase()
  let start = -1, end = -1
  for (let index = 0; index < blocks.length && start < 0; index++) {
    if (blocks[index]!.toUpperCase() !== 'BEGIN:VEVENT') continue
    let depth = 0, close = index + 1, override = false
    for (; close < blocks.length; close++) {
      const upper = blocks[close]!.toUpperCase()
      if (upper.startsWith('BEGIN:')) depth++
      else if (upper.startsWith('END:')) { if (depth === 0) break; depth-- }
      else if (depth === 0 && name(blocks[close]!) === 'RECURRENCE-ID') override = true
    }
    if (override) index = close
    else { start = index; end = close }
  }
  if (start < 0) return renderDavEvent(after, at)
  const dates = before.dtstart !== after.dtstart || before.dtend !== after.dtend || before.timezone !== after.timezone
  const replaced = new Set(['DTSTAMP', ...(before.summary !== after.summary ? ['SUMMARY'] : []), ...(before.description !== after.description ? ['DESCRIPTION'] : []),
    ...(before.location !== after.location ? ['LOCATION'] : []), ...(dates ? ['DTSTART', 'DTEND', 'DURATION'] : [])])
  const kept: string[] = []
  let depth = 0
  for (const block of blocks.slice(start + 1, end)) {
    const upper = block.toUpperCase()
    if (upper.startsWith('BEGIN:')) depth++
    else if (upper.startsWith('END:')) depth--
    else if (depth === 0 && replaced.has(name(block))) continue
    kept.push(block)
  }
  const fresh = eventProperties(after).filter(property => replaced.has(property.slice(0, /[;:]/.exec(property)!.index))).map(foldCalendarLine)
  const zone = dates && needsZone(after.dtstart, after.timezone) && !source.includes('TZID:' + after.timezone) ? timezoneBlock(after.timezone, after.dtstart) : []
  return [...blocks.slice(0, start), ...zone, blocks[start]!, ...kept, 'DTSTAMP:' + stamp(at), ...fresh, ...blocks.slice(end)].join('\r\n') + '\r\n'
}

// ---------------------------------------------------------------- vCard items

export const parseDavContact = (text: string): Omit<WebmailContact, 'id' | 'owner' | 'ownerAuthority' | 'shares' | 'createdAt'> | null => {
  const card = tryOr(() => readContactVcards(text, MAX_STORED_CARD_BYTES)[0] ?? null, null)
  if (!card) return null
  const email = line(card.email, 254).toLowerCase(), organization = line(card.organization.replaceAll(';', ' '), 200)
  return { fullName: line(card.fullName, 200) || organization || email || 'Unnamed contact', email: /^[^\s@/\\]+@[^\s@/\\]+$/.test(email) ? email : '', phone: line(card.phone, 100), organization,
    title: line(card.title, 200), groups: [...new Set(card.groups.map(group => tryOr(() => normalizeContactGroupName(group), '')).filter(Boolean))], vcard: text }
}
const CONTACT_FIELDS = { fullName: 'FN', email: 'EMAIL', phone: 'TEL', organization: 'ORG', title: 'TITLE' } as const
const rewriteContact = (source: string, before: WebmailContact, after: WebmailContact): string => {
  const replacements: Record<string, string | null> = {}
  for (const field of Object.keys(CONTACT_FIELDS) as (keyof typeof CONTACT_FIELDS)[]) {
    if (before[field] !== after[field]) replacements[CONTACT_FIELDS[field]] = after[field] ? escapeContactVcardText(after[field]) : null
  }
  if (JSON.stringify(before.groups) !== JSON.stringify(after.groups)) replacements.CATEGORIES = after.groups.length ? after.groups.map(group => group.replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,')).join(',') : null
  return Object.keys(replacements).length ? rewriteContactVcard(source, replacements) : source
}

// ---------------------------------------------------------------- the store document

interface RawItem { href: string; text: string }
interface RawCollection { owner: string; name: string; props: Record<string, unknown>; items: RawItem[] }
interface RawStore { collections: RawCollection[]; omitted: number; next: string | null }
const readDocument = (body: string): RawStore => {
  let raw: unknown
  try { raw = JSON.parse(body) } catch { return unavailable() }
  if (!object(raw) || !Array.isArray(raw.collections) || typeof raw.omitted !== 'number' || !(raw.next === null || typeof raw.next === 'string')) return unavailable()
  const collections: RawCollection[] = []
  for (const entry of raw.collections) {
    if (!object(entry) || typeof entry.owner !== 'string' || typeof entry.name !== 'string' || !object(entry.props) || !Array.isArray(entry.items)) return unavailable()
    collections.push({ owner: entry.owner, name: entry.name, props: entry.props, items: entry.items.filter((item): item is RawItem => object(item) && typeof item.href === 'string' && typeof item.text === 'string') })
  }
  return { collections, omitted: raw.omitted, next: raw.next }
}
const kindOf = (collection: RawCollection): 'calendar' | 'tasks' | 'addressbook' | null => {
  if (collection.props.tag === 'VADDRESSBOOK') return 'addressbook'
  if (collection.props.tag !== 'VCALENDAR') return null
  const components = String(collection.props['C:supported-calendar-component-set'] ?? 'VEVENT').split(',')
  return components.includes('VEVENT') ? 'calendar' : 'tasks'
}
type Share = WebmailCalendar['shares'][number]
const readShares = (value: unknown): Share[] => {
  const parsed = tryOr(() => JSON.parse(String(value ?? '[]')) as unknown, [])
  return Array.isArray(parsed) ? parsed.filter((share): share is Share => object(share) && typeof share.principal === 'string' && (share.permission === 'read' || share.permission === 'read-write') && typeof share.sharedAt === 'string') : []
}
const readContactShares = (value: unknown): Record<string, Share[]> => {
  const parsed = tryOr(() => JSON.parse(String(value ?? '{}')) as unknown, {})
  return object(parsed) ? Object.fromEntries(Object.entries(parsed).map(([id, shares]) => [id, readShares(JSON.stringify(shares))])) : {}
}
const granteeIds = (shares: readonly Share[]): string[] => shares.flatMap(share => share.granteeAuthority ? [share.granteeAuthority.serviceUserId] : [])

const ELEMENTS: Readonly<Record<string, string>> = { 'D:displayname': 'D:displayname', 'ICAL:calendar-color': 'I:calendar-color', 'C:calendar-description': 'C:calendar-description', 'CR:addressbook-description': 'CR:addressbook-description' }
const xmlText = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const propertyXml = (props: Readonly<Record<string, string>>): string => Object.entries(props).map(([key, value]) => {
  const element = ELEMENTS[key] ?? 'X:' + key.slice(key.indexOf('}') + 1)
  return `<${element}>${xmlText(value)}</${element}>`
}).join('')
const NAMESPACES = `xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CR="urn:ietf:params:xml:ns:carddav" xmlns:I="http://apple.com/ns/ical/" xmlns:X="${X}"`
const propertyUpdate = (props: Readonly<Record<string, string>>): string => `<?xml version="1.0"?><D:propertyupdate ${NAMESPACES}><D:set><D:prop>${propertyXml(props)}</D:prop></D:set></D:propertyupdate>`
const mkCalendar = (component: 'VEVENT' | 'VTODO', props: Readonly<Record<string, string>>): string => `<?xml version="1.0"?><C:mkcalendar ${NAMESPACES}><D:set><D:prop>${propertyXml(props)}<C:supported-calendar-component-set><C:comp name="${component}"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>`
const mkAddressBook = (props: Readonly<Record<string, string>>): string => `<?xml version="1.0"?><D:mkcol ${NAMESPACES}><D:set><D:prop><D:resourcetype><D:collection/><CR:addressbook/></D:resourcetype>${propertyXml(props)}</D:prop></D:set></D:mkcol>`

const sameEvent = (a: WebmailCalendarEvent, b: WebmailCalendarEvent): boolean => JSON.stringify(a) === JSON.stringify(b)
const zoneless = (value: string): string => value.replace(/Z$/, '')
const canonicalCalendar = (calendar: WebmailCalendar): unknown => [calendar.id, calendar.name, calendar.color, calendar.timezone, calendar.shares.map(share => [share.principal, share.permission]).sort(),
  (calendar.events ?? []).map(event => [event.id, event.uid, event.summary, event.description, event.location, zoneless(event.dtstart), zoneless(event.dtend)]).sort()]
/** Read-back check: the fields both sides model, in any order; a local time and its UTC spelling count as written. */
export const sameCalendars = (left: readonly WebmailCalendar[], right: readonly WebmailCalendar[]): boolean =>
  JSON.stringify(left.map(canonicalCalendar).sort()) === JSON.stringify(right.map(canonicalCalendar).sort())
const canonicalContact = (contact: WebmailContact): unknown => [contact.id, contact.fullName, contact.email, contact.phone, contact.organization, contact.title, [...contact.groups].sort(), (contact.shares ?? []).map(share => [share.principal, share.permission]).sort()]
export const sameContacts = (left: readonly WebmailContact[], right: readonly WebmailContact[]): boolean =>
  JSON.stringify(left.map(canonicalContact).sort()) === JSON.stringify(right.map(canonicalContact).sort())

/** One request's view of one mailbox's store; publishing compares against what this session last read. */
export const openDavSession = (ports: DavSessionPorts, caller: AuthenticatedCaller, account: Pick<Account, 'id' | 'username'>, authority: MailboxMetadataAuthority): DavSession => {
  const self = authority.serviceUserId
  let lastCalendars: WebmailCalendar[] = [], lastContacts: WebmailContact[] = []
  const calendarPlace = new Map<string, { owner: string; collection: string }>()
  const eventPlace = new Map<string, string>(), contactPlace = new Map<string, { owner: string; collection: string; href: string }>()
  const exchange = (input: DavExchangeInput): Promise<DavExchangeReply> => ports.exchange(caller, account, input)
  const expect = async (input: DavExchangeInput): Promise<DavExchangeReply> => {
    const reply = await exchange(input)
    if (reply.status === 412) return conflict()
    if (reply.status < 200 || reply.status > 299) return refused()
    return reply
  }
  const authorities = async (): Promise<Map<string, MailboxMetadataAuthority>> => new Map((await ports.listServiceUsers(account.id)).filter(user => user.services.email)
    .map(user => [user.id, { accountId: account.id, serviceUserId: user.id, mailbox: user.login.toLowerCase() }]))
  // Every read is whole or refused, so no view can be partial and no write can start from one.
  const load = async (): Promise<{ collections: RawCollection[] }> => {
    const collections = new Map<string, RawCollection>()
    let after: string | null = null, bytes = 0
    for (let pages = 0; pages < DAV_STORE_READ_PAGES; pages++) {
      const reply: DavExchangeReply = await exchange({ principal: self, method: 'GET', path: system.CALDAV_STORE_PATH + (after ? '?after=' + after : '') })
      if (reply.status !== 200) return unavailable()
      bytes += Buffer.byteLength(reply.body, 'utf8')
      const page = readDocument(reply.body)
      if (page.omitted > 0 || bytes > DAV_STORE_READ_BYTES) return davStoreTooLarge()
      for (const collection of page.collections) {
        const key = collection.owner + '/' + collection.name, seen = collections.get(key)
        if (seen) seen.items.push(...collection.items)
        else collections.set(key, collection)
      }
      if (!page.next) return { collections: [...collections.values()] }
      after = page.next
    }
    return davStoreTooLarge()
  }
  const path = (owner: string, collection: string, href?: string): string => `/${owner}/${encodeURIComponent(collection)}/${href ? encodeURIComponent(href) : ''}`
  const replaceItem = async (owner: string, itemPath: string, contentType: string, rewrite: (stored: string) => string): Promise<void> => {
    const stored = await expect({ principal: owner, method: 'GET', path: itemPath })
    await expect({ principal: owner, method: 'PUT', path: itemPath, contentType, body: rewrite(stored.body), ...(stored.etag ? { ifMatch: stored.etag } : {}) })
  }
  const setProps = (owner: string, collection: string, props: Record<string, string>): Promise<DavExchangeReply> =>
    expect({ principal: owner, method: 'PROPPATCH', path: path(owner, collection), contentType: 'application/xml', body: propertyUpdate(props) })
  const removeItem = (owner: string, itemPath: string): Promise<DavExchangeReply> => expect({ principal: owner, method: 'DELETE', path: itemPath })
  const collectionId = (collection: string): string => createHash('sha256').update([account.id, self, collection].join('\0')).digest('hex').slice(0, 32)

  const session: DavSession = {
    async calendars() {
      const [document, owners] = await Promise.all([load(), authorities()])
      calendarPlace.clear(); eventPlace.clear()
      const records: WebmailCalendar[] = []
      for (const collection of document.collections) {
        const owner = owners.get(collection.owner)
        if (!owner || kindOf(collection) !== 'calendar') continue
        const id = davItemId(collection.owner, collection.name, collection.name)
        const timezone = tryOr(() => calendarTimezone(collection.props[TIMEZONE]), 'UTC')
        const color = tryOr(() => calendarColor(String(collection.props['ICAL:calendar-color'] ?? '').replace(/^(#[0-9a-fA-F]{6})[0-9a-fA-F]{2}$/, '$1')), DEFAULT_COLOR)
        const events: WebmailCalendarEvent[] = []
        const uids = new Set<string>()
        for (const item of collection.items) {
          const event = parseDavEvent(item.text, item.href, davItemId(collection.owner, collection.name, item.href), timezone)
          if (!event || uids.has(event.uid)) continue
          uids.add(event.uid); events.push(event); eventPlace.set(`${id}/${event.id}`, item.href)
        }
        events.sort((a, b) => a.id.localeCompare(b.id))
        calendarPlace.set(id, { owner: collection.owner, collection: collection.name })
        records.push({ id, owner: owner.mailbox, ownerAuthority: owner, name: line(collection.props['D:displayname'], 200) || collection.name.slice(0, 200), color, timezone,
          shares: readShares(collection.props[SHARES]), events, createdAt: typeof collection.props[CREATED] === 'string' ? collection.props[CREATED] : EPOCH })
      }
      records.sort((a, b) => a.id.localeCompare(b.id))
      lastCalendars = structuredClone(records)
      return records
    },
    async publishCalendars(next) {
      const before = new Map(lastCalendars.map(calendar => [calendar.id, calendar]))
      for (const calendar of next) {
        const previous = before.get(calendar.id)
        const owner = previous ? calendarPlace.get(calendar.id)!.owner : calendar.ownerAuthority?.serviceUserId
        if (!owner) return refused()
        const collection = previous ? calendarPlace.get(calendar.id)!.collection : calendar.id
        if (!previous) {
          await expect({ principal: owner, method: 'MKCALENDAR', path: path(owner, collection), contentType: 'application/xml',
            body: mkCalendar('VEVENT', { 'D:displayname': calendar.name, 'ICAL:calendar-color': calendar.color, [TIMEZONE]: calendar.timezone, [CREATED]: calendar.createdAt }) })
        } else {
          const props: Record<string, string> = {}
          if (previous.name !== calendar.name) props['D:displayname'] = calendar.name
          if (previous.color !== calendar.color) props['ICAL:calendar-color'] = calendar.color
          if (previous.timezone !== calendar.timezone) props[TIMEZONE] = calendar.timezone
          if (JSON.stringify(previous.shares) !== JSON.stringify(calendar.shares)) { props[SHARES] = JSON.stringify(calendar.shares); props[GRANTEES] = granteeIds(calendar.shares).join(',') }
          if (Object.keys(props).length) await setProps(owner, collection, props)
        }
        const events = new Map((previous?.events ?? []).map(event => [event.id, event]))
        for (const event of calendar.events ?? []) {
          const old = events.get(event.id)
          events.delete(event.id)
          if (!old) await expect({ principal: owner, method: 'PUT', path: path(owner, collection, event.id + '.ics'), contentType: 'text/calendar', ifNoneMatch: true, body: renderDavEvent(event) })
          else if (!sameEvent(old, event)) await replaceItem(owner, path(owner, collection, eventPlace.get(`${calendar.id}/${event.id}`)!), 'text/calendar', stored => rewriteDavEvent(stored, old, event))
        }
        for (const gone of events.keys()) await removeItem(owner, path(owner, collection, eventPlace.get(`${calendar.id}/${gone}`)!))
      }
      const kept = new Set(next.map(calendar => calendar.id))
      for (const previous of lastCalendars) {
        if (kept.has(previous.id)) continue
        const place = calendarPlace.get(previous.id)!
        await expect({ principal: place.owner, method: 'DELETE', path: path(place.owner, place.collection) })
      }
    },
    async contacts() {
      const [document, owners] = await Promise.all([load(), authorities()])
      contactPlace.clear()
      const records: WebmailContact[] = []
      for (const collection of document.collections) {
        const owner = owners.get(collection.owner)
        if (!owner || kindOf(collection) !== 'addressbook') continue
        const shares = readContactShares(collection.props[CONTACT_SHARES])
        for (const item of collection.items) {
          const card = parseDavContact(item.text)
          if (!card) continue
          const id = davItemId(collection.owner, collection.name, item.href)
          contactPlace.set(id, { owner: collection.owner, collection: collection.name, href: item.href })
          records.push({ id, owner: owner.mailbox, ownerAuthority: owner, ...card, shares: shares[id] ?? [], createdAt: EPOCH })
        }
      }
      records.sort((a, b) => a.id.localeCompare(b.id))
      lastContacts = structuredClone(records)
      return records
    },
    async publishContacts(next) {
      const before = new Map(lastContacts.map(contact => [contact.id, contact]))
      const sharesChanged = new Map<string, { owner: string; collection: string }>()
      for (const contact of next) {
        const previous = before.get(contact.id)
        if (!previous) {
          const owner = contact.ownerAuthority?.serviceUserId
          if (!owner) return refused()
          const vcard = /^UID[;:]/im.test(contact.vcard) ? contact.vcard : rewriteContactVcard(contact.vcard, { UID: contact.id })
          await expect({ principal: owner, method: 'PUT', path: path(owner, DEFAULT_ADDRESS_BOOK, contact.id + '.vcf'), contentType: 'text/vcard', ifNoneMatch: true, body: vcard })
          if (contact.shares?.length) sharesChanged.set(`${owner}/${DEFAULT_ADDRESS_BOOK}`, { owner, collection: DEFAULT_ADDRESS_BOOK })
          continue
        }
        const place = contactPlace.get(contact.id)!
        if (canonicalFields(previous) !== canonicalFields(contact)) await replaceItem(place.owner, path(place.owner, place.collection, place.href), 'text/vcard', stored => rewriteContact(stored, previous, contact))
        if (JSON.stringify(previous.shares ?? []) !== JSON.stringify(contact.shares ?? [])) sharesChanged.set(`${place.owner}/${place.collection}`, place)
      }
      for (const place of sharesChanged.values()) {
        const shared = next.filter(contact => contact.ownerAuthority?.serviceUserId === place.owner && contact.shares?.length && (contactPlace.get(contact.id)?.collection ?? DEFAULT_ADDRESS_BOOK) === place.collection)
        await setProps(place.owner, place.collection, { [CONTACT_SHARES]: JSON.stringify(Object.fromEntries(shared.map(contact => [contact.id, contact.shares]))), [GRANTEES]: [...new Set(shared.flatMap(contact => granteeIds(contact.shares ?? [])))].join(',') })
      }
      const kept = new Set(next.map(contact => contact.id))
      for (const previous of lastContacts) {
        if (kept.has(previous.id)) continue
        const place = contactPlace.get(previous.id)!
        await removeItem(place.owner, path(place.owner, place.collection, place.href))
      }
    },
    async groups() {
      const document = await load()
      const book = document.collections.find(collection => collection.owner === self && collection.name === DEFAULT_ADDRESS_BOOK)
      const parsed = tryOr(() => JSON.parse(String(book?.props[GROUPS] ?? '[]')) as unknown, [])
      return Array.isArray(parsed) ? parsed.filter((group): group is { name: string; createdAt: string | null } => object(group) && typeof group.name === 'string').map(group => ({ owner: authority.mailbox, ownerAuthority: authority, name: group.name, createdAt: typeof group.createdAt === 'string' ? group.createdAt : null })) : []
    },
    async publishGroups(next) {
      await setProps(self, DEFAULT_ADDRESS_BOOK, { [GROUPS]: JSON.stringify(next.map(group => ({ name: group.name, createdAt: group.createdAt }))) })
    },
    async collections() {
      const document = await load()
      const result: DavCollections = { calendars: [], addressBooks: [], taskLists: [] }
      for (const collection of document.collections) {
        const kind = kindOf(collection)
        if (collection.owner !== self || !kind) continue
        const view = (key: string, displayFallback: string): DavCollectionView => ({ id: collectionId(collection.name), collection: collection.name, owner: authority.mailbox,
          name: line(collection.props['D:displayname'], 200) || displayFallback, description: line(collection.props[key], 500) })
        if (kind === 'calendar') result.calendars.push({ ...view('C:calendar-description', collection.name), id: davItemId(self, collection.name, collection.name) })
        else if (kind === 'tasks') result.taskLists.push(view('C:calendar-description', collection.name))
        else result.addressBooks.push(view('CR:addressbook-description', collection.name))
      }
      return result
    },
    async createCollection(kind, name, description) {
      const collection = randomUUID()
      if (kind === 'tasks') await expect({ principal: self, method: 'MKCALENDAR', path: path(self, collection), contentType: 'application/xml', body: mkCalendar('VTODO', { 'D:displayname': name, 'C:calendar-description': description }) })
      else await expect({ principal: self, method: 'MKCOL', path: path(self, collection), contentType: 'application/xml', body: mkAddressBook({ 'D:displayname': name, 'CR:addressbook-description': description }) })
      return collectionId(collection)
    },
    async updateCollection(collection, kind, changes) {
      const props: Record<string, string> = {}
      if (changes.name !== undefined) props['D:displayname'] = changes.name
      if (changes.description !== undefined) props[kind === 'addressbook' ? 'CR:addressbook-description' : 'C:calendar-description'] = changes.description
      if (Object.keys(props).length) await setProps(self, collection, props)
    },
    async deleteCollection(collection) {
      await expect({ principal: self, method: 'DELETE', path: path(self, collection) })
    },
    isDefaultCalendar: id => calendarPlace.get(id)?.collection === DEFAULT_CALENDAR,
  }
  return session
}
const canonicalFields = (contact: WebmailContact): string => JSON.stringify([contact.fullName, contact.email, contact.phone, contact.organization, contact.title, contact.groups])

/** Panel writes to one mailbox run one at a time; a tenant's slow store must not hold the shared state lease. */
export const createMailboxLocks = () => {
  const tails = new Map<string, Promise<void>>()
  return async (key: string): Promise<() => void> => {
    const previous = tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => current)
    tails.set(key, tail)
    await previous
    return () => { if (tails.get(key) === tail) tails.delete(key); release() }
  }
}
