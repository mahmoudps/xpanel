import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import type { Account, MailboxMetadataAuthority } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertAccountFeatures, isMailboxPrincipal } from './authorization.ts'
import { accountCollaborationCalendarId } from './account-collaboration-workspace.ts'
import { isDavStoreTooLarge } from './mail/dav-store.ts'
import { DEFAULT_ADDRESS_BOOK } from './mail/dav-store.ts'
import type { DavCollectionView } from './mail/dav-store.ts'

/**
 * Owner collection settings for /email/calendars-contacts. Calendars, address books and task lists are the account's
 * DAV collections, the ones devices sync, so a change here reaches a phone. Only the choice of default is saved here.
 */
export interface MailxCollectionsHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertCanAccessAccount' | 'emitAudit' | 'dav'> { store: StateStore; serverSecret: string; now?: () => Date }
export interface MailxCollectionItem { id: string; name: string; description: string; isDefault: boolean }
type RequestedItem = Omit<MailxCollectionItem, 'id'> & { id: string | null }
interface MailboxCollections { serviceUserId: string; defaultCalendar: string | null; defaultAddressBook: string | null; defaultTaskList: string | null }
interface CollectionsFile { accountId: string; mailboxes: Record<string, MailboxCollections>; updatedAt: string; updatedBy: string }

export const MAILX_COLLECTION_LIMITS = { items: 50, calendars: 25, description: 500, name: 200, mailboxes: 1000 } as const
const TOOLS = ['email-accounts', 'calendars-contacts-management', 'calendars-contacts-config']
const unchanged = { stateChanged: false }
const review = { stateChanged: true, unknownOutcome: true, verificationRequired: true }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const text = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && value.length <= max && (empty || !!value.trim()) && value.isWellFormed() && !CONTROL.test(value) && value === value.trim()
const ID = /^[0-9a-f]{32}$/
const invalid = (field: string): never => fail('VALIDATION', `invalid collection field: ${field}`, { ...unchanged, field })
const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

function items(raw: unknown, saved: readonly MailxCollectionItem[], field: string): RequestedItem[] {
  if (!Array.isArray(raw) || raw.length > MAILX_COLLECTION_LIMITS.items) return invalid(field)
  const list = raw.map(item => {
    if (!object(item) || Object.keys(item).length !== 4 || !['id', 'name', 'description', 'isDefault'].every(key => Object.hasOwn(item, key)) || !text(item.name, MAILX_COLLECTION_LIMITS.name)
      || !text(item.description, MAILX_COLLECTION_LIMITS.description, true) || typeof item.isDefault !== 'boolean') return invalid(field)
    // A new collection has no id yet; an existing id must name a collection of this mailbox.
    if (item.id !== null && (typeof item.id !== 'string' || !ID.test(item.id) || !saved.some(entry => entry.id === item.id))) return invalid(field)
    return { id: item.id as string | null, name: item.name as string, description: item.description as string, isDefault: item.isDefault as boolean }
  })
  const ids = list.flatMap(item => item.id ?? [])
  if (new Set(list.map(item => item.name.toLocaleLowerCase('en'))).size !== list.length || new Set(ids).size !== ids.length || list.length && list.filter(item => item.isDefault).length !== 1) return invalid(field)
  return list
}
function readFile(raw: unknown, accountId: string): CollectionsFile | null {
  if (raw === null) return null
  const chosen = (value: unknown): boolean => value === null || typeof value === 'string' && ID.test(value)
  if (!object(raw) || raw.accountId !== accountId || !object(raw.mailboxes) || typeof raw.updatedAt !== 'string' || typeof raw.updatedBy !== 'string' || Object.keys(raw.mailboxes).length > MAILX_COLLECTION_LIMITS.mailboxes
    || Object.values(raw.mailboxes).some(entry => !object(entry) || typeof entry.serviceUserId !== 'string' || ![entry.defaultCalendar, entry.defaultAddressBook, entry.defaultTaskList].every(chosen)))
    return fail('PRECONDITION_FAILED', 'saved collection settings require review', { ...unchanged, reason: 'saved_collections_review' })
  return raw as unknown as CollectionsFile
}

export function createMailxCollectionsRoutes(helpers: MailxCollectionsHelpers) {
  const path = (accountId: string) => join(helpers.store.rootDir, 'extended', 'mailx', 'collection-defaults', accountId + '.json')
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
  /** The mailboxes' collections as devices see them. Each session is one store read, so they run one at a time. */
  const capture = async (caller: AuthenticatedCaller, account: Account, only?: string, tooLarge?: string[]) => {
    const services = (await helpers.store.listServiceUsers(account.id)).filter(service => service.accountId === account.id && service.services.email && (!only || service.id === only)).slice(0, MAILX_COLLECTION_LIMITS.mailboxes)
    const saved = readFile(await readJsonIfExists<unknown>(path(account.id)), account.id)
    const mailboxes = []
    for (const service of services) {
      const authority: MailboxMetadataAuthority = { accountId: account.id, serviceUserId: service.id, mailbox: service.login.toLowerCase() }
      const session = helpers.dav.open(caller, account, authority)
      let stored: Awaited<ReturnType<typeof session.collections>>
      try { stored = await session.collections() } catch (error) { if (!tooLarge || !isDavStoreTooLarge(error)) throw error; tooLarge.push(authority.mailbox); continue }
      const calendars = stored.calendars.slice(0, MAILX_COLLECTION_LIMITS.calendars).map(view => ({ ...view, id: accountCollaborationCalendarId(helpers.serverSecret, authority, view.id) }))
      // Settings saved for an earlier mailbox with the same address are not carried over to a new service user.
      const entry = saved?.mailboxes[authority.mailbox]?.serviceUserId === service.id ? saved.mailboxes[authority.mailbox]! : null
      const listed = (views: readonly DavCollectionView[], chosen: string | null | undefined): (MailxCollectionItem & { removable: boolean })[] => {
        const shown = [...views].sort((left, right) => left.name.localeCompare(right.name)).slice(0, MAILX_COLLECTION_LIMITS.items)
        const selected = (shown.find(view => view.id === chosen) ?? shown.find(view => view.collection === DEFAULT_ADDRESS_BOOK) ?? shown[0])?.id
        return shown.map(view => ({ id: view.id, name: view.name, description: view.description, isDefault: view.id === selected, removable: view.collection !== DEFAULT_ADDRESS_BOOK }))
      }
      const current = { defaultCalendar: entry?.defaultCalendar && calendars.some(item => item.id === entry.defaultCalendar) ? entry.defaultCalendar : null,
        calendars: calendars.map(({ id, name, description }) => ({ id, name, description })), addressBooks: listed(stored.addressBooks, entry?.defaultAddressBook), taskLists: listed(stored.taskLists, entry?.defaultTaskList) }
      const places = new Map([...calendars, ...stored.addressBooks, ...stored.taskLists].map(view => [view.id, view.collection]))
      mailboxes.push({ authority, session, places, view: { mailbox: authority.mailbox, revision: createHash('sha256').update('mailx-collections:v1\0').update(JSON.stringify([service.id, current])).digest('hex'), ...current } })
    }
    return mailboxes
  }
  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    if (url.pathname !== '/api/account/mailx/collections') return null
    const initial = await authorize(req)
    if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
    if (url.search) return fail('VALIDATION', 'collections accept no account, mailbox or path selectors', unchanged)
    const view = async (account: Account) => {
      const tooLarge: string[] = [], mailboxes = await capture(initial.caller, account, undefined, tooLarge)
      return { context: { account: account.username }, mailboxes: [...mailboxes.map(item => item.view), ...tooLarge.map(mailbox => ({ mailbox, refused: 'dav_store_too_large' }))], limits: MAILX_COLLECTION_LIMITS,
        application: { status: 'dav_store', davServed: true } }
    }
    if (method === 'GET') { const body = await view(initial.account); await authorize(req, initial.caller); return json(body) }
    if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
    const raw = await req.text()
    if (raw.length > 128 * 1024) return fail('VALIDATION', 'collection request exceeds its bound', unchanged)
    let body: unknown
    try { body = JSON.parse(raw) } catch { return fail('VALIDATION', 'valid JSON is required', unchanged) }
    const keys = ['mailbox', 'expectedRevision', 'defaultCalendar', 'descriptions', 'addressBooks', 'taskLists']
    if (!object(body) || Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key)) || typeof body.mailbox !== 'string' || typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision))
      return fail('VALIDATION', 'the selected mailbox, its current revision and supported collection fields are required', unchanged)
    const service = (await helpers.store.listServiceUsers(initial.account.id)).find(item => item.services.email && item.login.toLowerCase() === body.mailbox)
    if (!service) return fail('NOT_FOUND', 'mailbox not found', unchanged)
    const release = await helpers.dav.lock(service.id)
    let wrote = false, caller = initial.caller, counts = { addressBooks: 0, taskLists: 0 }
    try {
      const fresh = await authorize(req, initial.caller); caller = fresh.caller
      const selected = (await capture(caller, fresh.account, service.id))[0]
      if (!selected) return fail('NOT_FOUND', 'mailbox not found', unchanged)
      if (selected.view.revision !== body.expectedRevision) return fail('CONFLICT', 'mailbox collections changed; reload before saving', unchanged)
      const ids = selected.view.calendars.map(item => item.id)
      if (!(body.defaultCalendar === null || typeof body.defaultCalendar === 'string' && ids.includes(body.defaultCalendar))) return invalid('defaultCalendar')
      if (!object(body.descriptions) || Object.entries(body.descriptions).some(([key, value]) => !ids.includes(key) || !text(value, MAILX_COLLECTION_LIMITS.description, true))) return invalid('descriptions')
      const addressBooks = items(body.addressBooks, selected.view.addressBooks, 'addressBooks'), taskLists = items(body.taskLists, selected.view.taskLists, 'taskLists')
      if (selected.view.addressBooks.some(item => !item.removable && !addressBooks.some(kept => kept.id === item.id))) return fail('PRECONDITION_FAILED', 'the default address book cannot be removed', { ...unchanged, reason: 'dav_default_collection' })
      const collection = (id: string): string => selected.places.get(id)!
      const apply = async (kind: 'addressbook' | 'tasks', requested: readonly RequestedItem[], existing: readonly MailxCollectionItem[]): Promise<string | null> => {
        let chosen: string | null = null
        for (const item of requested) {
          const previous = existing.find(entry => entry.id === item.id)
          const id = previous?.id ?? await selected.session.createCollection(kind, item.name, item.description)
          if (previous && (previous.name !== item.name || previous.description !== item.description)) await selected.session.updateCollection(collection(id), kind, { name: item.name, description: item.description })
          if (item.isDefault) chosen = id
        }
        for (const entry of existing) if (!requested.some(item => item.id === entry.id)) await selected.session.deleteCollection(collection(entry.id))
        return chosen
      }
      await authorize(req, initial.caller); wrote = true
      const descriptions = body.descriptions as Record<string, string>
      for (const calendar of selected.view.calendars) {
        const description = descriptions[calendar.id] ?? ''
        if (description !== calendar.description) await selected.session.updateCollection(collection(calendar.id), 'calendar', { description })
      }
      const entry: MailboxCollections = { serviceUserId: service.id, defaultCalendar: body.defaultCalendar as string | null, defaultAddressBook: await apply('addressbook', addressBooks, selected.view.addressBooks), defaultTaskList: await apply('tasks', taskLists, selected.view.taskLists) }
      const lease = await helpers.store.getWriterLock().acquire()
      try {
        const saved = readFile(await readJsonIfExists<unknown>(path(fresh.account.id)), fresh.account.id)
        const next: CollectionsFile = { accountId: fresh.account.id, mailboxes: { ...(saved?.mailboxes ?? {}), [selected.authority.mailbox]: entry }, updatedAt: (helpers.now ?? (() => new Date()))().toISOString(), updatedBy: caller.principal.username }
        await lease.assertFencingToken()
        await atomicWriteJson(path(fresh.account.id), next, 0o640, () => lease.assertFencingToken())
        if (JSON.stringify(readFile(await readJsonIfExists<unknown>(path(fresh.account.id)), fresh.account.id)) !== JSON.stringify(next)) throw new Error('collections_readback_mismatch')
      } finally { await lease.release() }
      counts = { addressBooks: addressBooks.length, taskLists: taskLists.length }
    } catch (error) {
      if (wrote) return fail('SERVICE_UNAVAILABLE', 'collection save outcome requires inspection', review)
      throw error
    } finally { release() }
    try { await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'account.collections.saved', target: 'mailbox:' + body.mailbox, outcome: 'ok', detail: counts }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'saved collections require audit review', review) }
    return json({ ...await view(initial.account), stateChanged: true })
  }
}
