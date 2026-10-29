import { createHmac } from 'node:crypto'
import { assessMailboxMetadataAuthority, fail, isUuid, isXpanelError } from '@xpanel/core'
import type { Account, MailboxMetadataAuthority } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers, WebmailCalendar, WebmailContact } from './extended-routes.ts'
import { assertAccountFeatures, isMailboxPrincipal } from './authorization.ts'
import { calendarCollectionRevision, calendarColor, calendarTimezone, calendarWorkspaceRevision, CALENDAR_LIMITS } from './mail/calendar-workspace.ts'
import { MAILBOX_METADATA_REVIEW_REQUIRED } from './mail/metadata-authority.ts'

type Audit = Parameters<ExtendedRouteHelpers['emitAudit']>[0]
export interface AccountCollaborationHelpers {
  store: StateStore
  serverSecret: string
  requireCaller: (req: Request, options?: { allowUnverifiedMfa?: boolean; deferDeniedAudit?: (input: Audit) => void }) => Promise<AuthenticatedCaller>
  assertCanAccessAccount: ExtendedRouteHelpers['assertCanAccessAccount']
  emitAudit: ExtendedRouteHelpers['emitAudit']
  readCalendars: () => Promise<WebmailCalendar[]>
  readContacts: () => Promise<WebmailContact[]>
  /** Existing createCalendarWorkspaceRoutes handler; preserve original Request.url and identity. */
  calendarRoute: (req: Request, url: URL, method: string) => Promise<Response | null>
}
const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
const unchanged = { stateChanged: false } as const
const review = (): never => fail('PRECONDITION_FAILED', 'collaboration metadata requires review', unchanged)
const unknown = (): never => fail('SERVICE_UNAVAILABLE', 'calendar creation outcome requires saved-source inspection before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
const safeText = (raw: unknown, limit: number): raw is string => typeof raw === 'string' && !!raw.trim() && raw.length <= limit && raw.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(raw)
const sameCaller = (a: AuthenticatedCaller, b: AuthenticatedCaller) => a.principal.id === b.principal.id && a.principal.kind === b.principal.kind && a.sessionId === b.sessionId && a.apiTokenId === b.apiTokenId
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
async function boundedJson(req: Request, limit: number): Promise<Record<string, unknown>> {
  if (!req.body || req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); return fail('VALIDATION', 'collaboration request exceeds its bound', unchanged) } chunks.push(part.value) }
    let raw: unknown
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { return fail('VALIDATION', 'valid UTF-8 JSON is required', unchanged) }
    return object(raw) ? raw : fail('VALIDATION', 'an object is required', unchanged)
  } finally { reader.releaseLock() }
}

/** Public calendar ids are keyed to the mailbox binding, so internal record ids never leave the server. */
export const accountCollaborationCalendarId = (secret: string, authority: MailboxMetadataAuthority, id: string): string =>
  createHmac('sha256', secret).update('account-collaboration-calendar:v1\0').update(JSON.stringify(authority)).update(id).digest('hex').slice(0, 32)

export function createAccountCollaborationRoutes(helpers: AccountCollaborationHelpers) {
  const publicCalendarId = (authority: MailboxMetadataAuthority, id: string) => accountCollaborationCalendarId(helpers.serverSecret, authority, id)
  const publicRevision = (authority: MailboxMetadataAuthority, source: string) => createHmac('sha256', helpers.serverSecret).update('account-collaboration:v1\0').update(JSON.stringify(authority)).update(source).digest('hex')
  const authorize = async (req: Request, original?: AuthenticatedCaller, current?: Account, deferred?: Audit[]) => {
    const caller = await helpers.requireCaller(req, deferred ? { deferDeniedAudit: input => { deferred.push(input) } } : undefined)
    if (caller.principal.kind !== 'user' || isMailboxPrincipal(caller) || original && !sameCaller(original, caller)) return fail('FORBIDDEN', 'the current hosting account owner is required', unchanged)
    const account = current ?? await helpers.store.getAccount(caller.principal.accountId)
    if (!account || account.id !== caller.principal.accountId || account.username !== caller.principal.username || account.status !== 'active') return fail('FORBIDDEN', 'the active hosting account owner is required', unchanged)
    await helpers.assertCanAccessAccount(caller, account, 'account.collaboration')
    await assertAccountFeatures(helpers.store, caller, account, ['email-accounts', 'calendars-contacts-management', 'calendars-contacts-sharing', 'calendars-contacts-config'])
    return { caller, account }
  }
  const capture = async (req: Request, initial: Awaited<ReturnType<typeof authorize>>) => {
    const deferred: Audit[] = []
    try {
      return await helpers.store.withAccountLifecycleLease(initial.account.id, async account => {
        await authorize(req, initial.caller, account, deferred)
        const services = (await helpers.store.listServiceUsers(account.id)).filter(service => service.services.email)
        if (services.length > 1000 || new Set(services.map(service => service.login.toLowerCase())).size !== services.length) return review()
        const authorities = new Map(services.map(service => [service.login.toLowerCase(), { accountId: account.id, serviceUserId: service.id, mailbox: service.login.toLowerCase() } satisfies MailboxMetadataAuthority]))
        const [calendars, contacts] = await Promise.all([helpers.readCalendars(), helpers.readContacts()])
        if (!Array.isArray(calendars) || !Array.isArray(contacts) || calendars.length > 100000 || contacts.length > 100000) return review()
        const bindings = [...authorities.values()].map(authority => {
          const ownCalendars = calendars.filter(calendar => object(calendar) && assessMailboxMetadataAuthority(calendar.owner, calendar.ownerAuthority, authority) === 'match')
          const ownContacts = contacts.filter(contact => object(contact) && assessMailboxMetadataAuthority(contact.owner, contact.ownerAuthority, authority) === 'match')
          if (ownCalendars.length > CALENDAR_LIMITS.calendars || ownContacts.length > 10000) return review()
          const calendarRows = ownCalendars.map(calendar => {
            if (!isUuid(calendar.id) || !safeText(calendar.name, 200) || !Array.isArray(calendar.shares) || calendar.shares.length > 100 || calendar.events !== undefined && (!Array.isArray(calendar.events) || calendar.events.length > CALENDAR_LIMITS.events)) return review()
            calendarColor(calendar.color); calendarTimezone(calendar.timezone)
            const shares = calendar.shares.flatMap(share => {
              if (!object(share) || typeof share.principal !== 'string') return []
              const grantee = authorities.get(share.principal.toLowerCase())
              return grantee && grantee.mailbox !== authority.mailbox && assessMailboxMetadataAuthority(share.principal, share.granteeAuthority, grantee) === 'match' && ['read', 'read-write'].includes(share.permission) ? [{ mailbox: grantee.mailbox, permission: share.permission }] : []
            })
            return { id: publicCalendarId(authority, calendar.id), name: calendar.name, color: calendar.color, timezone: calendar.timezone, eventCount: calendar.events?.length ?? 0, shares }
          })
          if (new Set(ownCalendars.map(calendar => calendar.id)).size !== ownCalendars.length) return review()
          const groups = new Set<string>()
          for (const contact of ownContacts) { if (!Array.isArray(contact.groups) || contact.groups.length > 256 || contact.groups.some(group => !safeText(group, 64))) return review(); for (const group of contact.groups) groups.add(group) }
          const revision = calendarCollectionRevision(calendars, authority)
          return { authority, rawRevision: revision, public: { mailbox: authority.mailbox, revision: publicRevision(authority, revision), calendars: calendarRows, contacts: { count: ownContacts.length, groupCount: groups.size }, canCreateCalendar: ownCalendars.length < CALENDAR_LIMITS.calendars } }
        })
        await authorize(req, initial.caller, account, deferred)
        return { account, bindings, calendars }
      })
    } finally { for (const audit of deferred) await helpers.emitAudit(audit) }
  }
  const project = (saved: Awaited<ReturnType<typeof capture>>) => {
    const view = { context: { account: saved.account.username }, source: 'saved-mailbox-metadata', mailboxes: saved.bindings.map(binding => binding.public),
      limits: { mailboxes: 1000, calendarsPerMailbox: CALENDAR_LIMITS.calendars }, metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED,
      capabilities: { createCalendar: true, caldav: false, carddav: false, addressBookCollections: false, taskLists: false, protectedDefaults: false },
      application: { status: 'saved_metadata', nativeApplied: false, syncVerified: false } }
    if (Buffer.byteLength(JSON.stringify(view), 'utf8') > 2 * 1024 * 1024) return fail('LIMIT_EXCEEDED', 'the authorized collection overview exceeds its response bound', unchanged)
    return view
  }
  /** Owner edit and delete of one owned calendar, delegated to the existing calendar writer with its own revision, then read back. */
  const changeCalendar = async (req: Request, url: URL, method: string, id: string): Promise<Response> => {
    const initial = await authorize(req)
    if (url.searchParams.size) return fail('VALIDATION', 'collaboration accepts no account, mailbox, path or URL query selectors', unchanged)
    if (method !== 'PATCH' && method !== 'DELETE') return new Response(null, { status: 405, headers: { allow: 'PATCH, DELETE' } })
    const editing = method === 'PATCH', raw = await boundedJson(req, 8192), fieldNames = editing ? ['mailbox', 'name', 'color', 'timezone', 'expectedRevision'] : ['mailbox', 'expectedRevision']
    if (Object.keys(raw).length !== fieldNames.length || fieldNames.some(key => !Object.hasOwn(raw, key)) || !safeText(raw.mailbox, 254) || typeof raw.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.expectedRevision) || editing && !safeText(raw.name, 200))
      return fail('VALIDATION', 'the selected mailbox, current collection revision and supported calendar fields are required', unchanged)
    const fields = editing ? { name: (raw.name as string).trim(), color: calendarColor(raw.color), timezone: calendarTimezone(raw.timezone) } : null
    const before = await capture(req, initial), selected = before.bindings.find(binding => binding.authority.mailbox === raw.mailbox)
    if (!selected) return fail('NOT_FOUND', 'mailbox not found', unchanged)
    if (selected.public.revision !== raw.expectedRevision) return fail('CONFLICT', 'mailbox calendars changed; explicitly reload before changing', unchanged)
    const target = before.calendars.find(calendar => publicCalendarId(selected.authority, calendar.id) === id && assessMailboxMetadataAuthority(calendar.owner, calendar.ownerAuthority, selected.authority) === 'match')
    if (!target) return fail('NOT_FOUND', 'calendar not found', unchanged)
    await authorize(req, initial.caller)
    const inner = new Request(req, { method, body: JSON.stringify({ mailbox: selected.authority.mailbox, ...(fields ?? {}), expectedRevision: calendarWorkspaceRevision(target) }) })
    const unsure = (): never => fail('SERVICE_UNAVAILABLE', 'calendar change outcome requires saved-source inspection before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    let replied = false
    try {
      const response = await helpers.calendarRoute(inner, new URL('/api/webmail/calendars/' + target.id, req.url), method)
      replied = true
      if (!response || !response.ok) return unsure()
      const saved = await capture(req, initial), current = saved.bindings.find(binding => binding.authority.mailbox === selected.authority.mailbox), actual = saved.calendars.find(calendar => calendar.id === target.id)
      if (!current || current.authority.serviceUserId !== selected.authority.serviceUserId) return unsure()
      if (fields ? !actual || assessMailboxMetadataAuthority(actual.owner, actual.ownerAuthority, current.authority) !== 'match' || actual.name !== fields.name || actual.color !== fields.color || actual.timezone !== fields.timezone : actual) return unsure()
      return json({ ...project(saved), stateChanged: true, [fields ? 'updated' : 'deleted']: { mailbox: current.authority.mailbox, id, ...(fields ?? {}) } })
    } catch (error) { if (!replied && isXpanelError(error) && error.detail?.stateChanged === false) throw error; return unsure() }
  }
  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    const calendarId = /^\/api\/account\/collaboration\/calendars\/([0-9a-f]{32})$/.exec(url.pathname)?.[1]
    if (calendarId) return changeCalendar(req, url, method, calendarId)
    if (!['/api/account/collaboration', '/api/account/collaboration/calendars'].includes(url.pathname)) return null
    const initial = await authorize(req)
    if (url.searchParams.size) return fail('VALIDATION', 'collaboration accepts no account, mailbox, path or URL query selectors', unchanged)
    const creating = url.pathname.endsWith('/calendars')
    if (method !== (creating ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: creating ? 'POST' : 'GET' } })
    if (!creating) return json(project(await capture(req, initial)))
    const raw = await boundedJson(req, 8192)
    if (Object.keys(raw).some(key => !['mailbox', 'name', 'color', 'timezone', 'expectedRevision'].includes(key)) || !safeText(raw.mailbox, 254) || !safeText(raw.name, 200) || typeof raw.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.expectedRevision)) return fail('VALIDATION', 'the selected mailbox, current collection revision and supported calendar fields are required', unchanged)
    const color = calendarColor(raw.color), timezone = calendarTimezone(raw.timezone), name = raw.name.trim()
    const before = await capture(req, initial), selected = before.bindings.find(binding => binding.authority.mailbox === raw.mailbox)
    if (!selected) return fail('NOT_FOUND', 'mailbox not found', unchanged)
    if (selected.public.revision !== raw.expectedRevision) return fail('CONFLICT', 'mailbox calendars changed; explicitly reload before creating', unchanged)
    if (!selected.public.canCreateCalendar) return fail('LIMIT_EXCEEDED', 'mailbox calendar capacity reached', unchanged)
    await authorize(req, initial.caller)
    // Keep the outer authorization URL/caller; only the trusted handler's route selector changes.
    const inner = new Request(req, { method: 'POST', body: JSON.stringify({ owner: selected.authority.mailbox, name, color, timezone, expectedRevision: selected.rawRevision }) })
    let replied = false
    try {
      const response = await helpers.calendarRoute(inner, new URL('/api/webmail/calendars', req.url), 'POST')
      replied = true
      if (!response || response.status !== 201 || !response.body) return unknown()
      const reply = await boundedJson(new Request('http://internal.invalid/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: response.body, duplex: 'half' } as RequestInit), 512 * 1024)
      if (!object(reply.calendar) || !isUuid(reply.calendar.id) || reply.calendar.owner !== selected.authority.mailbox || reply.calendar.name !== name || reply.calendar.color !== color || reply.calendar.timezone !== timezone) return unknown()
      const created = reply.calendar
      const saved = await capture(req, initial), current = saved.bindings.find(binding => binding.authority.mailbox === selected.authority.mailbox)
      const actual = saved.calendars.find(calendar => calendar.id === created.id)
      if (!current || current.authority.serviceUserId !== selected.authority.serviceUserId || !actual || assessMailboxMetadataAuthority(actual.owner, actual.ownerAuthority, current.authority) !== 'match' || actual.name !== name || actual.color !== color || actual.timezone !== timezone || actual.shares.length !== 0 || (actual.events?.length ?? 0) !== 0) return unknown()
      return json({ ...project(saved), stateChanged: true, created: { mailbox: current.authority.mailbox, name, color, timezone } }, 201)
    } catch (error) { if (!replied && isXpanelError(error) && error.detail?.stateChanged === false) throw error; return unknown() }
  }
}
