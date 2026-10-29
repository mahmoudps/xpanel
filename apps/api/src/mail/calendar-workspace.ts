import { createHash, randomUUID } from 'node:crypto'
import { assessMailboxMetadataAuthority, fail } from '@xpanel/core'
import type { Account, MailboxMetadataAuthority } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from '../auth.ts'
import type { ExtendedRouteHelpers, WebmailCalendar, WebmailCalendarEvent } from '../extended-routes.ts'
import { assertAccountFeatures, isMailboxPrincipal, requireMailbox, requireMailboxPrincipalAccess } from '../authorization.ts'
import { assertMailboxMetadataAuthority, captureMailboxMetadataAuthority, resolveMailboxMetadataAuthority } from './metadata-authority.ts'

export const CALENDAR_LIMITS = { calendars: 25, events: 1000, shares: 100, icsBytes: 256 * 1024, calendarBytes: 512 * 1024 } as const
const revisionPattern = /^[0-9a-f]{64}$/
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
// Same script/handler refusal as the legacy calendar and vCard routes (extended-routes UNSAFE_CAL_VCARD_PATTERN).
const markup = /<script\b|javascript:|vbscript:|data:text\/html|on[a-z]+\s*=/i
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
const text = (value: unknown, field: string, maximum: number, required = false, multiline = false): string => {
  if (typeof value !== 'string' || !value.isWellFormed() || unsafe.test(multiline ? value.replace(/[\r\n]/g, '') : value) || Buffer.byteLength(value, 'utf8') > maximum) return invalid(`${field} must be bounded text`)
  if (markup.test(value)) return invalid(`${field} contains unsafe script or handler content`)
  const result = (multiline ? value.replace(/\r\n|\r/g, '\n') : value).trim()
  if (required && !result) return invalid(`${field} is required`)
  return result
}
const keys = (value: Record<string, unknown>, allowed: readonly string[], strict: boolean): void => {
  if (strict && Object.keys(value).some(key => !allowed.includes(key))) invalid('unsupported calendar workspace field')
}
export const calendarTimezone = (value: unknown): string => {
  const result = text(value, 'timezone', 100, true)
  if (!/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(result)) return invalid('timezone must be an ASCII IANA identifier')
  try { new Intl.DateTimeFormat('en', { timeZone: result }).format(0) } catch { return invalid('timezone is not recognized') }
  return result
}
export const calendarColor = (value: unknown): string => {
  const result = text(value, 'color', 80, true)
  if (/^#[0-9a-f]{6}$/i.test(result)) return result.toLowerCase()
  const match = /^oklch\((\d*(?:\.\d+)?|\d+) (\d*(?:\.\d+)?|\d+) (\d*(?:\.\d+)?|\d+)\)$/.exec(result)
  if (!match || match.slice(1).some(value => value === '') || Number(match[1]) > 1 || Number(match[2]) > 0.5 || Number(match[3]) > 360) return invalid('color must be a HEX or bounded OKLCH value')
  return result
}
export const calendarTimestamp = (value: unknown, field: string): string => {
  const result = text(value, field, 16, true)
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(result)
  if (!match) return invalid(`${field} must use ASCII iCalendar timestamp format`)
  const [year, month, day, hour, minute, second] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0)] as const
  const instant = new Date(0); instant.setUTCFullYear(year, month - 1, day); instant.setUTCHours(hour, minute, second, 0)
  if (year < 1 || instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day || instant.getUTCHours() !== hour || instant.getUTCMinutes() !== minute || instant.getUTCSeconds() !== second) return invalid(`${field} is not a valid calendar date`)
  return result
}
const eventDates = (start: unknown, end: unknown): { dtstart: string; dtend: string } => {
  const dtstart = calendarTimestamp(start, 'DTSTART'), dtend = calendarTimestamp(end ?? start, 'DTEND')
  if (dtstart.length !== dtend.length || dtend < dtstart) return invalid('DTEND must match the DTSTART form and may not precede it')
  return { dtstart, dtend }
}
export const calendarWorkspaceRevision = (calendar: WebmailCalendar): string => createHash('sha256').update(JSON.stringify([
  calendar.id, calendar.owner, calendar.ownerAuthority ?? null, calendar.name, calendar.color, calendar.timezone, calendar.shares,
  calendar.events ?? [], calendar.createdAt,
])).digest('hex')
export const calendarCollectionRevision = (calendars: readonly WebmailCalendar[], current: MailboxMetadataAuthority): string => createHash('sha256').update(JSON.stringify([
  [current.accountId, current.serviceUserId, current.mailbox],
  calendars.filter(calendar => assessMailboxMetadataAuthority(calendar.owner, calendar.ownerAuthority, current) === 'match').map(calendar => [calendar.id, calendarWorkspaceRevision(calendar)]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
])).digest('hex')
export const projectCalendarWorkspace = (calendar: WebmailCalendar, current: MailboxMetadataAuthority, currentOwner: MailboxMetadataAuthority = current, effectiveGrants: ReadonlyMap<string, boolean> = new Map()) => {
  if (currentOwner.accountId !== current.accountId) return fail('NOT_FOUND', 'calendar not found', { stateChanged: false })
  assertMailboxMetadataAuthority(calendar.owner, calendar.ownerAuthority, currentOwner)
  const owner = assessMailboxMetadataAuthority(calendar.owner, calendar.ownerAuthority, current) === 'match'
  const shared = calendar.shares.find(share => assessMailboxMetadataAuthority(share.principal, share.granteeAuthority, current) === 'match')
  if (!owner && !shared) return fail('NOT_FOUND', 'calendar not found', { stateChanged: false })
  return { id: calendar.id, owner: calendar.owner, name: calendar.name, color: calendar.color, timezone: calendar.timezone,
    events: calendar.events ?? [], shares: owner ? calendar.shares.map(share => ({ principal: share.principal, permission: share.permission, sharedAt: share.sharedAt, effective: effectiveGrants.get(share.principal.toLowerCase()) === true })) : [], createdAt: calendar.createdAt,
    revision: calendarWorkspaceRevision(calendar), storedBytes: Buffer.byteLength(JSON.stringify(calendar), 'utf8'), canWrite: owner || shared?.permission === 'read-write', canManage: owner }
}
export const calendarEventsFromDraft = (value: unknown, current: readonly WebmailCalendarEvent[], timezone: string, strict: boolean): WebmailCalendarEvent[] => {
  if (!Array.isArray(value) || value.length > CALENDAR_LIMITS.events && value.length > current.length) return invalid('calendar events exceed the supported capacity')
  const ids = new Set<string>(), uids = new Set<string>()
  return value.map(raw => {
    if (!object(raw)) return invalid('calendar event must be an object')
    keys(raw, ['id', 'summary', 'description', 'location', 'dtstart', 'dtend', 'timezone'], strict)
    const previous = typeof raw.id === 'string' ? current.find(event => event.id === raw.id) : undefined
    if (raw.id !== undefined && (typeof raw.id !== 'string' || !idPattern.test(raw.id) || strict && !previous)) return invalid('event identity does not belong to this calendar')
    const id = previous?.id ?? (typeof raw.id === 'string' ? raw.id : randomUUID())
    const uid = strict ? previous?.uid ?? randomUUID() : text(raw.uid ?? previous?.uid ?? randomUUID(), 'UID', 512, true)
    if (ids.has(id) || uids.has(uid)) return invalid('event identities may not repeat')
    ids.add(id); uids.add(uid)
    return { id, uid, summary: text(raw.summary, 'summary', 300, true), description: text(raw.description ?? '', 'description', 5000, false, true),
      location: text(raw.location ?? '', 'location', 500), ...eventDates(raw.dtstart, raw.dtend), timezone: calendarTimezone(raw.timezone ?? timezone) }
  })
}
const expectedRevision = (body: Record<string, unknown>, expected: string, mandatory: boolean): void => {
  if (!mandatory && body.expectedRevision === undefined) return
  if (typeof body.expectedRevision !== 'string' || !revisionPattern.test(body.expectedRevision)) return invalid('expectedRevision is required')
  if (body.expectedRevision !== expected) fail('CONFLICT', 'calendar changed; reload and review before retrying', { stateChanged: false })
}
const readStore = (value: unknown): WebmailCalendar[] => {
  if (!Array.isArray(value) || value.some(calendar => !object(calendar) || typeof calendar.id !== 'string' || !idPattern.test(calendar.id) || typeof calendar.owner !== 'string' || !Array.isArray(calendar.shares) || calendar.events !== undefined && !Array.isArray(calendar.events))) return fail('PRECONDITION_FAILED', 'calendar storage requires review', { stateChanged: false })
  if (new Set(value.map(calendar => calendar.id)).size !== value.length) return fail('PRECONDITION_FAILED', 'calendar storage has duplicate identities', { stateChanged: false })
  return value as WebmailCalendar[]
}
type CalendarLease = Awaited<ReturnType<ReturnType<StateStore['getWriterLock']>['acquire']>>
export interface CalendarWorkspaceDependencies {
  helpers: Pick<ExtendedRouteHelpers, 'store' | 'requireCaller' | 'assertCanAccessAccount' | 'emitAudit'>
  readRecords: () => Promise<WebmailCalendar[]>
  /** The API binds the single calendars.json path and the writer lease fencing callback. */
  publishRecords: (records: WebmailCalendar[], lease: CalendarLease) => Promise<void>
  parseIcs: (source: string, timezone: string) => WebmailCalendarEvent[]
  renderIcs: (calendar: WebmailCalendar) => string
}
const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const sameCaller = (before: AuthenticatedCaller, after: AuthenticatedCaller): boolean => before.principal.id === after.principal.id && before.principal.kind === after.principal.kind && before.sessionId === after.sessionId && before.apiTokenId === after.apiTokenId
const application = { status: 'stored_configuration', nativeApplied: false, syncVerified: false } as const
const publicCalendarRecord = (calendar: WebmailCalendar) => ({
  id: calendar.id, owner: calendar.owner, name: calendar.name, color: calendar.color, timezone: calendar.timezone,
  shares: calendar.shares.map(share => ({ principal: share.principal, permission: share.permission, sharedAt: share.sharedAt })),
  events: calendar.events, createdAt: calendar.createdAt,
})

export const createCalendarWorkspaceRoutes = (deps: CalendarWorkspaceDependencies) => {
  const { helpers } = deps
  const accessible = async (calendar: WebmailCalendar, current: MailboxMetadataAuthority, account: Account, write = false, review = false): Promise<boolean> => {
    const ownsAddress = calendar.owner.toLowerCase() === current.mailbox
    const share = calendar.shares.find(share => share.principal.toLowerCase() === current.mailbox)
    if (!ownsAddress && !share) return false
    const owner = await resolveMailboxMetadataAuthority(helpers.store, calendar.owner)
    if (!owner || owner.accountId !== account.id) return false
    if (review) assertMailboxMetadataAuthority(calendar.owner, calendar.ownerAuthority, owner)
    else if (assessMailboxMetadataAuthority(calendar.owner, calendar.ownerAuthority, owner) !== 'match') return false
    if (ownsAddress) return assessMailboxMetadataAuthority(calendar.owner, calendar.ownerAuthority, current) === 'match'
    if (review) assertMailboxMetadataAuthority(share!.principal, share!.granteeAuthority, current)
    return assessMailboxMetadataAuthority(share!.principal, share!.granteeAuthority, current) === 'match' && (!write || share!.permission === 'read-write')
  }
  const project = async (calendar: WebmailCalendar, current: MailboxMetadataAuthority) => {
    const owner = await resolveMailboxMetadataAuthority(helpers.store, calendar.owner)
    if (!owner) return fail('NOT_FOUND', 'calendar not found', { stateChanged: false })
    const effective = new Map<string, boolean>()
    if (assessMailboxMetadataAuthority(calendar.owner, calendar.ownerAuthority, current) === 'match') {
      for (const share of calendar.shares) {
        const grantee = await resolveMailboxMetadataAuthority(helpers.store, share.principal)
        effective.set(share.principal.toLowerCase(), !!grantee && grantee.accountId === owner.accountId && assessMailboxMetadataAuthority(share.principal, share.granteeAuthority, grantee) === 'match')
      }
    }
    return projectCalendarWorkspace(calendar, current, owner, effective)
  }
  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    const match = /^\/api\/webmail\/calendars(?:\/([^/]+)(?:\/(share|import|export|ics|events)(?:\/([^/]+))?)?)?$/.exec(url.pathname)
    if (!match) return null
    if (match[3] && match[2] !== 'events') return null
    const caller = await helpers.requireCaller(req), sealed = isMailboxPrincipal(caller)
    if (sealed && url.searchParams.size) return invalid('calendar workspace does not accept selectors')
    const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)
    if (!mutating && method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET, POST, PATCH, PUT, DELETE' } })
    let body: Record<string, unknown> = {}
    if (mutating && req.body !== null) {
      let raw: unknown
      try { raw = await req.json() } catch { return invalid('calendar body must be valid JSON') }
      if (!object(raw)) return invalid('calendar body must be an object')
      body = raw
    }
    const segment = match[1], operation = match[2] ?? (segment === 'import' ? 'import' : '')
    const eventId = match[3]
    if (eventId && !idPattern.test(eventId)) return fail('NOT_FOUND', 'calendar event not found', { stateChanged: false })
    if (operation === 'events' && method !== 'GET' && (eventId ? !['PATCH', 'DELETE'].includes(method) : method !== 'POST')) return new Response(null, { status: 405, headers: { allow: eventId ? 'GET, PATCH, DELETE' : 'GET, POST' } })
    const creating = !segment && method === 'POST'
    const globalImport = segment === 'import' && !match[2]
    const targetId = globalImport ? body.calendarId ?? url.searchParams.get('calendarId') : segment
    if (targetId !== undefined && targetId !== null && (typeof targetId !== 'string' || !idPattern.test(targetId))) {
      if (!sealed && typeof targetId === 'string') return fail('NOT_FOUND', 'calendar not found', { stateChanged: false })
      return invalid('calendar identity is invalid')
    }
    const initial = readStore(await deps.readRecords())
    const initialCalendar = typeof targetId === 'string' ? initial.find(calendar => calendar.id === targetId) : undefined
    const requestedMailbox = sealed ? undefined : creating ? body.owner ?? url.searchParams.get('mailbox') : body.mailbox ?? url.searchParams.get('mailbox') ?? initialCalendar?.owner
    if (requestedMailbox !== undefined && requestedMailbox !== null && typeof requestedMailbox !== 'string') return invalid('mailbox selector must be text')
    const mailbox = await requireMailbox(helpers.store, caller, requestedMailbox as string | null | undefined)
    const selectedService = await helpers.store.getServiceUserByLogin(mailbox)
    if (!selectedService?.services.email) return fail('NOT_FOUND', 'mailbox not found', { stateChanged: false })
    const account = await helpers.store.getAccount(selectedService.accountId)
    if (!account || account.status !== 'active') return fail('FORBIDDEN', 'hosting account is unavailable', { stateChanged: false })
    const authority = await captureMailboxMetadataAuthority(helpers.store, mailbox)
    if (authority.accountId !== account.id || authority.serviceUserId !== selectedService.id) return fail('NOT_FOUND', 'mailbox not found', { stateChanged: false })
    const context = { mailbox }
    const visible = async (calendars: WebmailCalendar[]): Promise<WebmailCalendar[]> => {
      const selected: WebmailCalendar[] = []
      for (const calendar of calendars) if (await accessible(calendar, authority, account)) selected.push(calendar)
      return selected
    }
    if (method === 'GET') {
      if (!segment) {
        const calendars = await visible(initial)
        return sealed ? json({ context, calendars: await Promise.all(calendars.map(calendar => project(calendar, authority))), revision: calendarCollectionRevision(initial, authority), limits: CALENDAR_LIMITS, application }) : json({ calendars: calendars.map(publicCalendarRecord) })
      }
      if (!initialCalendar || !await accessible(initialCalendar, authority, account, false, true)) return fail('NOT_FOUND', 'calendar not found', { stateChanged: false })
      if (operation === 'events') {
        const event = eventId ? initialCalendar.events?.find(event => event.id === eventId) : undefined
        if (eventId && !event) return fail('NOT_FOUND', 'calendar event not found', { stateChanged: false })
        const response = { ...(eventId ? { event } : { events: initialCalendar.events ?? [] }), revision: calendarWorkspaceRevision(initialCalendar) }
        return json(sealed ? { ...response, context, application } : response)
      }
      if (operation === 'export' || operation === 'ics') {
        const response = { calendarId: initialCalendar.id, ics: deps.renderIcs(initialCalendar), eventsCount: (initialCalendar.events ?? []).length }
        return json(sealed ? { ...response, context, revision: calendarWorkspaceRevision(initialCalendar), application } : response)
      }
      if (operation) return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } })
      return json(sealed ? { context, calendar: await project(initialCalendar, authority), application } : { calendar: publicCalendarRecord(initialCalendar) })
    }
    if (operation === 'events') {
      keys(body, method === 'DELETE' ? ['expectedRevision'] : ['summary', 'description', 'location', 'dtstart', 'dtend', 'timezone', 'expectedRevision'], true)
      if (['summary', 'description', 'location', 'dtstart', 'dtend', 'timezone'].some(key => Object.hasOwn(body, key) && typeof body[key] !== 'string')) return invalid('event fields must be text')
    }
    else if (creating) keys(body, ['name', 'color', 'timezone', 'expectedRevision'], sealed)
    else if (operation === 'import') keys(body, ['ics', 'expectedRevision', ...(globalImport ? ['calendarId'] : [])], sealed)
    else if (operation === 'share') keys(body, ['principal', 'permission', 'expectedRevision'], sealed)
    else if (method === 'DELETE') keys(body, ['expectedRevision'], sealed)
    else keys(body, ['name', 'color', 'timezone', 'events', 'expectedRevision'], sealed)
    const lease = await helpers.store.getWriterLock().acquire()
    let writeAttempted = false, result: WebmailCalendar | null = null, importedCount = 0, auditAction = '', committed = false
    let previousCalendar: WebmailCalendar | null = null, eventResult: WebmailCalendarEvent | null = null, deletedEventId: string | null = null
    let sealedResult: ReturnType<typeof projectCalendarWorkspace> | null = null
    let auditCaller = caller, auditAccount = account
    try {
      const fresh = await helpers.requireCaller(req)
      if (!sameCaller(caller, fresh)) return fail('FORBIDDEN', 'calendar authorization changed', { stateChanged: false })
      const service = await helpers.store.getServiceUserByLogin(mailbox)
      if (!service?.services.email || service.id !== selectedService.id || service.accountId !== account.id) return fail('NOT_FOUND', 'mailbox not found', { stateChanged: false })
      const currentAccount = await helpers.store.getAccount(account.id)
      if (!currentAccount || currentAccount.status !== 'active') return fail('FORBIDDEN', 'hosting account is unavailable', { stateChanged: false })
      if (isMailboxPrincipal(fresh)) {
        const binding = await requireMailboxPrincipalAccess(helpers.store, fresh)
        if (binding.mailbox !== mailbox || binding.serviceUserId !== selectedService.id) return fail('NOT_FOUND', 'mailbox not found', { stateChanged: false })
      } else {
        await helpers.assertCanAccessAccount(fresh, currentAccount, 'mailbox.access')
        await assertAccountFeatures(helpers.store, fresh, currentAccount, ['email-accounts'])
      }
      auditCaller = fresh
      auditAccount = currentAccount
      const currentAuthority = await captureMailboxMetadataAuthority(helpers.store, mailbox)
      if (currentAuthority.accountId !== account.id || currentAuthority.serviceUserId !== selectedService.id) return fail('NOT_FOUND', 'mailbox not found', { stateChanged: false })
      const calendars = readStore(await deps.readRecords())
      const target = typeof targetId === 'string' ? calendars.find(calendar => calendar.id === targetId) : undefined
      let next = [...calendars]
      if (creating) {
        expectedRevision(body, calendarCollectionRevision(calendars, currentAuthority), sealed)
        const ownedCalendars = calendars.filter(calendar => assessMailboxMetadataAuthority(calendar.owner, calendar.ownerAuthority, currentAuthority) === 'match')
        if (ownedCalendars.length >= CALENDAR_LIMITS.calendars) return invalid('mailbox calendar capacity reached')
        const name = text(body.name, 'calendar name', 200, true)
        if (ownedCalendars.some(calendar => calendar.name.toLocaleLowerCase('en') === name.toLocaleLowerCase('en'))) return fail('CONFLICT', 'calendar name already exists', { stateChanged: false })
        result = { id: randomUUID(), owner: mailbox, ownerAuthority: currentAuthority, name, color: calendarColor(body.color ?? 'oklch(0.65 0.18 250)'), timezone: calendarTimezone(body.timezone ?? 'UTC'), shares: [], events: [], createdAt: new Date().toISOString() }
        next.push(result); auditAction = 'webmail.calendar.created'
      } else {
        if (!target || !await accessible(target, currentAuthority, currentAccount, false, true)) return fail('NOT_FOUND', 'calendar not found', { stateChanged: false })
        previousCalendar = target
        const owned = assessMailboxMetadataAuthority(target.owner, target.ownerAuthority, currentAuthority) === 'match'
        if (operation === 'share' && !owned || method === 'DELETE' && !['share', 'events'].includes(operation) && !owned) return fail('FORBIDDEN', 'only the calendar owner may manage this calendar', { stateChanged: false })
        if ((['import', 'events'].includes(operation) || method === 'PATCH' || method === 'PUT') && !await accessible(target, currentAuthority, currentAccount, true, true)) return fail('FORBIDDEN', 'calendar share is read-only', { stateChanged: false })
        if (operation !== 'events' && (method === 'PATCH' || method === 'PUT') && sealed && !owned && ['name', 'color', 'timezone'].some(key => body[key] !== undefined)) return fail('FORBIDDEN', 'only the calendar owner may modify calendar settings', { stateChanged: false })
        expectedRevision(body, calendarWorkspaceRevision(target), sealed || operation === 'events')
        result = structuredClone(target)
        if (operation === 'events') {
          const currentEvents = target.events ?? []
          const selectedEvents = eventId ? currentEvents.filter(event => event.id === eventId) : []
          if (eventId && selectedEvents.length !== 1) return fail(selectedEvents.length ? 'CONFLICT' : 'NOT_FOUND', 'calendar event identity requires review', { stateChanged: false })
          const existing = selectedEvents[0]
          if (method === 'DELETE') {
            result.events = currentEvents.filter(event => event.id !== eventId)
            deletedEventId = eventId!; auditAction = 'webmail.calendar.event_deleted'
          } else {
            if (!existing && currentEvents.length >= CALENDAR_LIMITS.events) return invalid('calendar event capacity reached')
            const fields = { ...(existing ? { id: existing.id } : {}), summary: body.summary ?? existing?.summary,
              description: body.description ?? existing?.description ?? '', location: body.location ?? existing?.location ?? '',
              dtstart: body.dtstart ?? existing?.dtstart, dtend: body.dtend ?? existing?.dtend ?? body.dtstart, timezone: body.timezone ?? existing?.timezone ?? result.timezone }
            eventResult = calendarEventsFromDraft([fields], currentEvents, result.timezone, true)[0]!
            result.events = existing ? currentEvents.map(event => event.id === existing.id ? eventResult! : event) : [...currentEvents, eventResult]
            auditAction = existing ? 'webmail.calendar.event_updated' : 'webmail.calendar.event_created'
          }
        } else if (operation === 'share') {
          if (!owned) return fail('FORBIDDEN', 'only the calendar owner may modify sharing', { stateChanged: false })
          const principal = text(body.principal ?? (sealed ? undefined : body.grantee ?? url.searchParams.get('principal') ?? url.searchParams.get('grantee')), 'share principal', 254, true).toLowerCase()
          if (!/^[^\s@/\\]+@[^\s@/\\]+$/.test(principal) || principal === mailbox) return invalid('share principal must be another mailbox')
          const revoke = method === 'DELETE' || !sealed && (body.revoke === true || body.permission === 'none' || body.permission === 'revoke')
          if (revoke) {
            result.shares = result.shares.filter(share => share.principal.toLowerCase() !== principal)
            auditAction = 'webmail.calendar.share_revoked'
          } else {
            if (body.permission !== undefined && body.permission !== 'read' && body.permission !== 'read-write') return invalid('share permission must be read or read-write')
            const shareTarget = await helpers.store.getServiceUserByLogin(principal)
            if (!shareTarget?.services.email || shareTarget.accountId !== account.id) return fail('NOT_FOUND', 'share target mailbox not found in account', { stateChanged: false })
            const granteeAuthority = await captureMailboxMetadataAuthority(helpers.store, principal)
            if (granteeAuthority.accountId !== currentAccount.id || granteeAuthority.serviceUserId !== shareTarget.id) return fail('NOT_FOUND', 'share target mailbox not found in account', { stateChanged: false })
            const share = { principal, granteeAuthority, permission: body.permission === 'read-write' ? 'read-write' as const : 'read' as const, sharedAt: new Date().toISOString() }
            const previous = result.shares.findIndex(share => share.principal.toLowerCase() === principal)
            if (previous >= 0) result.shares[previous] = share
            else {
              if (result.shares.length >= CALENDAR_LIMITS.shares) return invalid('calendar sharing capacity reached')
              result.shares.push(share)
            }
            auditAction = 'webmail.calendar.shared'
          }
        } else if (operation === 'import') {
          if (!await accessible(target, currentAuthority, currentAccount, true, true)) return fail('FORBIDDEN', 'calendar share is read-only', { stateChanged: false })
          if (typeof body.ics !== 'string' || Buffer.byteLength(body.ics, 'utf8') > CALENDAR_LIMITS.icsBytes) return invalid('ICS content exceeds the supported bound')
          const imported = deps.parseIcs(body.ics, result.timezone)
          const unique = new Set<string>(), events = [...result.events ?? []]
          for (const event of imported) {
            const uid = text(event.uid, 'UID', 512, true)
            if (unique.has(uid)) return invalid('imported event UIDs may not repeat')
            unique.add(uid)
            const existingIndex = events.findIndex(current => current.uid === uid)
            const checked: WebmailCalendarEvent = { id: existingIndex >= 0 ? events[existingIndex]!.id : randomUUID(), uid,
              summary: text(event.summary, 'summary', 300, true), description: text(event.description ?? '', 'description', 5000, false, true), location: text(event.location ?? '', 'location', 500),
              ...eventDates(event.dtstart, event.dtend), timezone: calendarTimezone(event.timezone ?? result.timezone) }
            if (existingIndex >= 0) events[existingIndex] = checked; else events.push(checked)
          }
          if (events.length > CALENDAR_LIMITS.events && events.length > (target.events?.length ?? 0)) return invalid('calendar event capacity reached')
          result.events = events; importedCount = imported.length; auditAction = 'webmail.calendar.imported'
        } else if (method === 'DELETE') {
          if (!owned) return fail('FORBIDDEN', 'only the calendar owner may delete the calendar', { stateChanged: false })
          next = calendars.filter(calendar => calendar.id !== target.id); auditAction = 'webmail.calendar.deleted'
        } else if (method === 'PATCH' || method === 'PUT') {
          if (!await accessible(target, currentAuthority, currentAccount, true, true)) return fail('FORBIDDEN', 'calendar share is read-only', { stateChanged: false })
          if (sealed && !owned && ['name', 'color', 'timezone'].some(key => body[key] !== undefined)) return fail('FORBIDDEN', 'only the calendar owner may modify calendar settings', { stateChanged: false })
          if (body.name !== undefined) result.name = text(body.name, 'calendar name', 200, true)
          if (body.color !== undefined) result.color = calendarColor(body.color)
          if (body.timezone !== undefined) result.timezone = calendarTimezone(body.timezone)
          if (body.events !== undefined) result.events = calendarEventsFromDraft(body.events, target.events ?? [], result.timezone, sealed)
          if (calendars.some(calendar => calendar.id !== target.id && assessMailboxMetadataAuthority(calendar.owner, calendar.ownerAuthority, target.ownerAuthority!) === 'match' && calendar.name.toLocaleLowerCase('en') === result!.name.toLocaleLowerCase('en'))) return fail('CONFLICT', 'calendar name already exists', { stateChanged: false })
          auditAction = 'webmail.calendar.updated'
        } else return new Response(null, { status: 405, headers: { allow: 'GET, PATCH, PUT, DELETE' } })
        if (auditAction !== 'webmail.calendar.deleted') next = calendars.map(calendar => calendar.id === target.id ? result! : calendar)
      }
      if (result && auditAction !== 'webmail.calendar.deleted') {
        const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8'), previousBytes = previousCalendar ? Buffer.byteLength(JSON.stringify(previousCalendar), 'utf8') : 0
        if (bytes > CALENDAR_LIMITS.calendarBytes && bytes > previousBytes) return invalid('calendar data capacity reached; reduce event content before increasing this record')
      }
      writeAttempted = true
      await deps.publishRecords(next, lease)
      const persisted = readStore(await deps.readRecords())
      if (JSON.stringify(persisted) !== JSON.stringify(next)) return fail('PRECONDITION_FAILED', 'calendar publication readback requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
      if (sealed && result && auditAction !== 'webmail.calendar.deleted') sealedResult = await project(result, currentAuthority)
      await lease.commitAuthority({ incrementRevision: false })
      committed = true
    } catch (error) {
      if (writeAttempted) return fail('PRECONDITION_FAILED', 'calendar write outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
      throw error
    } finally { await lease.release() }
    if (!committed || !result) return fail('PRECONDITION_FAILED', 'calendar write requires review', { stateChanged: true, unknownOutcome: true })
    try {
      await helpers.emitAudit({ actor: auditCaller.principal.username, action: auditAction, target: `calendar:${result.name}`,
        detail: { eventsCount: result.events?.length ?? 0, sharesCount: result.shares.length }, outcome: 'ok', principalId: auditCaller.principal.id }, { accountId: auditAccount.id, resellerId: auditAccount.ownerId })
    } catch { return fail('PRECONDITION_FAILED', 'calendar saved but audit outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
    if (auditAction === 'webmail.calendar.deleted') return json(sealed ? { ok: true, context, calendarId: result.id, application } : { ok: true })
    const response = { calendar: sealed ? sealedResult : publicCalendarRecord(result),
      ...(eventResult ? { event: eventResult } : {}), ...(deletedEventId ? { deletedEventId, ok: true } : {}),
      ...(auditAction === 'webmail.calendar.imported' ? { importedCount, events: result.events ?? [] } : {}) }
    return json(sealed ? { ...response, context, application } : response, creating || auditAction === 'webmail.calendar.imported' ? 201 : 200)
  }
}
