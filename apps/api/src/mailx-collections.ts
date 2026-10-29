import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { assessMailboxMetadataAuthority, fail } from '@xpanel/core'
import type { Account, MailboxMetadataAuthority } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers, WebmailCalendar } from './extended-routes.ts'
import { assertAccountFeatures, isMailboxPrincipal } from './authorization.ts'
import { accountCollaborationCalendarId } from './account-collaboration-workspace.ts'

/**
 * Owner collection settings for /email/calendars-contacts: the default calendar, calendar descriptions, and named
 * address books and task lists per mailbox. These are saved collection records; no CalDAV/CardDAV server serves them.
 */
export interface MailxCollectionsHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertCanAccessAccount' | 'emitAudit'> { store: StateStore; serverSecret: string; now?: () => Date }
export interface MailxCollectionItem { id: string; name: string; description: string; isDefault: boolean }
interface MailboxCollections { serviceUserId: string; defaultCalendar: string | null; descriptions: Record<string, string>; addressBooks: MailxCollectionItem[]; taskLists: MailxCollectionItem[] }
interface CollectionsFile { accountId: string; mailboxes: Record<string, MailboxCollections>; updatedAt: string; updatedBy: string }

export const MAILX_COLLECTION_LIMITS = { items: 50, calendars: 25, description: 500, name: 200, mailboxes: 1000 } as const
// No DAV server is part of xPanel; this is the exact native step that remains.
export const MAILX_DAV_STATE = { caldav: 'unavailable', carddav: 'unavailable', reason: 'no_dav_server', missingStep: 'install_and_qualify_dav_server' } as const
const TOOLS = ['email-accounts', 'calendars-contacts-management', 'calendars-contacts-config']
const unchanged = { stateChanged: false }
const review = { stateChanged: true, unknownOutcome: true, verificationRequired: true }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const text = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && value.length <= max && (empty || !!value.trim()) && value.isWellFormed() && !CONTROL.test(value) && value === value.trim()
const ID = /^[0-9a-f]{32}$/
const invalid = (field: string): never => fail('VALIDATION', `invalid collection field: ${field}`, { ...unchanged, field })
const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

function items(raw: unknown, saved: readonly MailxCollectionItem[], field: string): MailxCollectionItem[] {
  if (!Array.isArray(raw) || raw.length > MAILX_COLLECTION_LIMITS.items) return invalid(field)
  const list = raw.map(item => {
    if (!object(item) || Object.keys(item).length !== 4 || !['id', 'name', 'description', 'isDefault'].every(key => Object.hasOwn(item, key)) || !text(item.name, MAILX_COLLECTION_LIMITS.name)
      || !text(item.description, MAILX_COLLECTION_LIMITS.description, true) || typeof item.isDefault !== 'boolean') return invalid(field)
    // A new collection has no id yet; the server allocates it. An existing id must already be saved for this mailbox.
    if (item.id !== null && (typeof item.id !== 'string' || !ID.test(item.id) || !saved.some(entry => entry.id === item.id))) return invalid(field)
    return { id: (item.id as string | null) ?? randomBytes(16).toString('hex'), name: item.name as string, description: item.description as string, isDefault: item.isDefault as boolean }
  })
  if (new Set(list.map(item => item.name.toLocaleLowerCase('en'))).size !== list.length || new Set(list.map(item => item.id)).size !== list.length || list.length && list.filter(item => item.isDefault).length !== 1) return invalid(field)
  return list
}
function readFile(raw: unknown, accountId: string): CollectionsFile | null {
  if (raw === null) return null
  try {
    if (!object(raw) || raw.accountId !== accountId || !object(raw.mailboxes) || typeof raw.updatedAt !== 'string' || typeof raw.updatedBy !== 'string' || Object.keys(raw.mailboxes).length > MAILX_COLLECTION_LIMITS.mailboxes) throw new Error()
    const mailboxes: Record<string, MailboxCollections> = {}
    for (const [mailbox, entry] of Object.entries(raw.mailboxes)) {
      if (!object(entry) || typeof entry.serviceUserId !== 'string' || !(entry.defaultCalendar === null || typeof entry.defaultCalendar === 'string' && ID.test(entry.defaultCalendar)) || !object(entry.descriptions)
        || Object.entries(entry.descriptions).some(([key, value]) => !ID.test(key) || !text(value, MAILX_COLLECTION_LIMITS.description, true))) throw new Error()
      // Saved items pass the same grammar as a request; only their stored ids are kept instead of allocated.
      const keep = (value: unknown): MailxCollectionItem[] => {
        if (!Array.isArray(value)) throw new Error()
        return items(value.map(item => object(item) ? { ...item, id: null } : item), [], 'saved').map((item, index) => ({ ...item, id: String((value[index] as Record<string, unknown>).id) }))
      }
      const addressBooks = keep(entry.addressBooks), taskLists = keep(entry.taskLists)
      if ([...addressBooks, ...taskLists].some(item => !ID.test(item.id))) throw new Error()
      mailboxes[mailbox] = { serviceUserId: entry.serviceUserId, defaultCalendar: entry.defaultCalendar as string | null, descriptions: { ...entry.descriptions } as Record<string, string>, addressBooks, taskLists }
    }
    return { accountId, mailboxes, updatedAt: raw.updatedAt, updatedBy: raw.updatedBy }
  } catch { return fail('PRECONDITION_FAILED', 'saved collection settings require review', { ...unchanged, reason: 'saved_collections_review' }) }
}

export function createMailxCollectionsRoutes(helpers: MailxCollectionsHelpers) {
  const path = (accountId: string) => join(helpers.store.rootDir, 'extended', 'mailx', 'collections', accountId + '.json')
  const sameCaller = (a: AuthenticatedCaller, b: AuthenticatedCaller): boolean => a.principal.id === b.principal.id && a.sessionId === b.sessionId && a.apiTokenId === b.apiTokenId
  const authorize = async (req: Request, original?: AuthenticatedCaller) => {
    const caller = await helpers.requireCaller(req)
    if (caller.principal.kind !== 'user' || isMailboxPrincipal(caller) || original && !sameCaller(original, caller)) return fail('FORBIDDEN', 'the current hosting account owner is required', unchanged)
    const account = await helpers.store.getAccount(caller.principal.accountId)
    if (!account || account.id !== caller.principal.accountId || account.username !== caller.principal.username || account.status !== 'active') return fail('FORBIDDEN', 'the active hosting account owner is required', unchanged)
    await helpers.assertCanAccessAccount(caller, account, 'account.collaboration')
    await assertAccountFeatures(helpers.store, caller, account, TOOLS)
    return { caller, account }
  }
  /** Current mailboxes with their owned calendars (by public id), read from the saved calendar records. */
  const capture = async (account: Account) => {
    const services = (await helpers.store.listServiceUsers(account.id)).filter(service => service.accountId === account.id && service.services.email).slice(0, MAILX_COLLECTION_LIMITS.mailboxes)
    const calendars = await readJsonIfExists<WebmailCalendar[]>(join(helpers.store.rootDir, 'extended', 'webmail', 'calendars.json')) ?? []
    if (!Array.isArray(calendars) || calendars.length > 100000) return fail('PRECONDITION_FAILED', 'collaboration metadata requires review', unchanged)
    const saved = readFile(await readJsonIfExists<unknown>(path(account.id)), account.id)
    const mailboxes = services.map(service => {
      const authority: MailboxMetadataAuthority = { accountId: account.id, serviceUserId: service.id, mailbox: service.login.toLowerCase() }
      const owned = calendars.filter(calendar => object(calendar) && assessMailboxMetadataAuthority(calendar.owner, calendar.ownerAuthority, authority) === 'match').slice(0, MAILX_COLLECTION_LIMITS.calendars)
        .map(calendar => ({ id: accountCollaborationCalendarId(helpers.serverSecret, authority, calendar.id), name: String(calendar.name) }))
      // Settings saved for an earlier mailbox with the same address are not carried over to a new service user.
      const entry = saved?.mailboxes[authority.mailbox]?.serviceUserId === service.id ? saved.mailboxes[authority.mailbox]! : null
      const current = { defaultCalendar: entry?.defaultCalendar && owned.some(item => item.id === entry.defaultCalendar) ? entry.defaultCalendar : null,
        calendars: owned.map(item => ({ ...item, description: entry?.descriptions[item.id] ?? '' })), addressBooks: entry?.addressBooks ?? [], taskLists: entry?.taskLists ?? [] }
      return { authority, entry, view: { mailbox: authority.mailbox, revision: createHash('sha256').update('mailx-collections:v1\0').update(JSON.stringify([service.id, current])).digest('hex'), ...current } }
    })
    return { saved, mailboxes }
  }
  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    if (url.pathname !== '/api/account/mailx/collections') return null
    const initial = await authorize(req)
    if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
    if (url.search) return fail('VALIDATION', 'collections accept no account, mailbox or path selectors', unchanged)
    const view = async (account: Account) => ({ context: { account: account.username }, mailboxes: (await capture(account)).mailboxes.map(item => item.view), limits: MAILX_COLLECTION_LIMITS, dav: MAILX_DAV_STATE,
      application: { status: 'saved_collections', davServed: false } })
    if (method === 'GET') { const body = await view(initial.account); await authorize(req, initial.caller); return json(body) }
    if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
    const raw = await req.text()
    if (raw.length > 128 * 1024) return fail('VALIDATION', 'collection request exceeds its bound', unchanged)
    let body: unknown
    try { body = JSON.parse(raw) } catch { return fail('VALIDATION', 'valid JSON is required', unchanged) }
    const keys = ['mailbox', 'expectedRevision', 'defaultCalendar', 'descriptions', 'addressBooks', 'taskLists']
    if (!object(body) || Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key)) || typeof body.mailbox !== 'string' || typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision))
      return fail('VALIDATION', 'the selected mailbox, its current revision and supported collection fields are required', unchanged)
    const lease = await helpers.store.getWriterLock().acquire()
    let wrote = false, caller = initial.caller, next: CollectionsFile | null = null
    try {
      const fresh = await authorize(req, initial.caller); caller = fresh.caller
      const current = await capture(fresh.account), selected = current.mailboxes.find(item => item.authority.mailbox === body.mailbox)
      if (!selected) return fail('NOT_FOUND', 'mailbox not found', unchanged)
      if (selected.view.revision !== body.expectedRevision) return fail('CONFLICT', 'mailbox collections changed; reload before saving', unchanged)
      const ids = selected.view.calendars.map(item => item.id)
      if (!(body.defaultCalendar === null || typeof body.defaultCalendar === 'string' && ids.includes(body.defaultCalendar))) return invalid('defaultCalendar')
      if (!object(body.descriptions) || Object.entries(body.descriptions).some(([key, value]) => !ids.includes(key) || !text(value, MAILX_COLLECTION_LIMITS.description, true))) return invalid('descriptions')
      const entry: MailboxCollections = { serviceUserId: selected.authority.serviceUserId, defaultCalendar: body.defaultCalendar as string | null,
        descriptions: Object.fromEntries(Object.entries(body.descriptions as Record<string, string>).filter(([, value]) => value !== '')),
        addressBooks: items(body.addressBooks, selected.entry?.addressBooks ?? [], 'addressBooks'), taskLists: items(body.taskLists, selected.entry?.taskLists ?? [], 'taskLists') }
      next = { accountId: fresh.account.id, mailboxes: { ...(current.saved?.mailboxes ?? {}), [selected.authority.mailbox]: entry }, updatedAt: (helpers.now ?? (() => new Date()))().toISOString(), updatedBy: caller.principal.username }
      await authorize(req, initial.caller); await lease.assertFencingToken(); wrote = true
      await atomicWriteJson(path(fresh.account.id), next, 0o640, () => lease.assertFencingToken())
      if (JSON.stringify(readFile(await readJsonIfExists<unknown>(path(fresh.account.id)), fresh.account.id)) !== JSON.stringify(next)) throw new Error('collections_readback_mismatch')
    } catch (error) {
      if (wrote) return fail('SERVICE_UNAVAILABLE', 'collection save outcome requires inspection', review)
      throw error
    } finally { await lease.release() }
    try { await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'account.collections.saved', target: 'mailbox:' + body.mailbox, outcome: 'ok', detail: { addressBooks: next!.mailboxes[body.mailbox]!.addressBooks.length, taskLists: next!.mailboxes[body.mailbox]!.taskLists.length } }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'saved collections require audit review', review) }
    return json({ ...await view(initial.account), stateChanged: true })
  }
}
