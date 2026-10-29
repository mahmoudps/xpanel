import { randomUUID } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { sha256Hex } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { authorizeAccountOwner } from './account-ssh-workspace.ts'
import type { AccountOwnerPorts } from './account-ssh-workspace.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export interface AnnouncementsHelpers extends AccountOwnerPorts, Pick<ExtendedRouteHelpers, 'assertRoot' | 'emitAudit'> {
  /** ext.readOrDefault('accounts/announcements.json', null) */
  readSaved: () => Promise<unknown>
  /** ext.write('accounts/announcements.json', value) */
  writeSaved: (value: unknown) => Promise<unknown>
  /** ext.readOrDefault(`accounts/announcement-dismissals/${accountId}.json`, null) */
  readDismissed: (accountId: string) => Promise<unknown>
  /** ext.write(`accounts/announcement-dismissals/${accountId}.json`, value) */
  writeDismissed: (accountId: string, value: unknown) => Promise<unknown>
  now?: () => Date
}

export const ANNOUNCEMENT_SEVERITIES = ['info', 'warning', 'maintenance'] as const
export const ANNOUNCEMENT_LIMITS = { title: 140, body: 2000, usernames: 100, active: 50, records: 100 } as const
export type AnnouncementSeverity = typeof ANNOUNCEMENT_SEVERITIES[number]
export type AnnouncementAudience = { kind: 'all' } | { kind: 'plan'; planId: string } | { kind: 'reseller'; resellerId: string } | { kind: 'accounts'; usernames: string[] }
export interface LocalizedText { en: string; ar: string }
export interface Announcement {
  id: string; status: 'active' | 'archived'; severity: AnnouncementSeverity; title: LocalizedText; body: LocalizedText; audience: AnnouncementAudience
  startsAt: string | null; endsAt: string | null; createdAt: string; createdBy: string; updatedAt: string; updatedBy: string
}
export type AnnouncementPhase = 'scheduled' | 'live' | 'ended' | 'archived'
/** What an account owner receives: never the audience. */
export type AccountAnnouncement = Pick<Announcement, 'id' | 'severity' | 'title' | 'body' | 'startsAt' | 'endsAt'>

const MANAGE_ROUTE = /^\/api\/server\/announcements(?:\/([^/]+)(?:\/(archive))?)?$/
const ACCOUNT_ROUTE = /^\/api\/account\/announcements(?:\/([^/]+)\/(dismiss))?$/
const MAX_BODY_BYTES = 32 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ACTOR = /^[A-Za-z0-9_.@-]{1,64}$/
// C0/C1 controls (line feed only in bodies), bidi embedding/override/isolate controls and markup brackets.
const FORBIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202A-\u202E\u2066-\u2069<>]/
const INPUT_KEYS = 'audience,body,endsAt,expectedRevision,severity,startsAt,title'
const RECORD_KEYS = 'audience,body,createdAt,createdBy,endsAt,id,severity,startsAt,status,title,updatedAt,updatedBy'
const invalid = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>): string => Object.keys(value).sort().join()
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const revisionOf = (raw: unknown): string => sha256Hex(JSON.stringify(raw ?? null))

const textOf = (value: unknown, what: string, max: number, multiline: boolean): string => {
  if (typeof value !== 'string') return invalid(`${what} is required`)
  const text = value.replace(/\r\n?/g, '\n').trim(), length = [...text].length
  if (!length || length > max) return invalid(`${what} must be 1 to ${max} characters`)
  if (FORBIDDEN.test(text) || (!multiline && text.includes('\n'))) return invalid(`${what} must be plain text without HTML or control characters`)
  return text
}
const localizedOf = (value: unknown, what: string, max: number, multiline: boolean): LocalizedText => {
  if (!object(value) || keys(value) !== 'ar,en') return invalid(`${what} needs English and Arabic text`)
  return { en: textOf(value.en, `English ${what}`, max, multiline), ar: textOf(value.ar, `Arabic ${what}`, max, multiline) }
}
const timeOf = (value: unknown, what: string): string | null => {
  if (value === null) return null
  const parsed = typeof value === 'string' && STAMP.test(value) ? Date.parse(value) : NaN
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value as string : invalid(`${what} must be a UTC time such as 2026-11-01T09:00:00.000Z, or null`)
}
const audienceOf = (value: unknown): AnnouncementAudience => {
  if (object(value)) {
    const shape = keys(value)
    if (value.kind === 'all' && shape === 'kind') return { kind: 'all' }
    if (value.kind === 'plan' && shape === 'kind,planId' && typeof value.planId === 'string' && UUID.test(value.planId)) return { kind: 'plan', planId: value.planId }
    if (value.kind === 'reseller' && shape === 'kind,resellerId' && typeof value.resellerId === 'string' && UUID.test(value.resellerId)) return { kind: 'reseller', resellerId: value.resellerId }
    const names = value.usernames
    if (value.kind === 'accounts' && shape === 'kind,usernames' && Array.isArray(names) && names.length >= 1 && names.length <= ANNOUNCEMENT_LIMITS.usernames
      && names.every(name => typeof name === 'string' && USERNAME.test(name)) && new Set(names).size === names.length) return { kind: 'accounts', usernames: [...names as string[]] }
  }
  return invalid(`audience must be all accounts, one plan, one reseller, or 1 to ${ANNOUNCEMENT_LIMITS.usernames} different account usernames`)
}
type Fields = Pick<Announcement, 'title' | 'body' | 'severity' | 'audience' | 'startsAt' | 'endsAt'>
const fieldsOf = (value: Record<string, unknown>): Fields => {
  if (!(ANNOUNCEMENT_SEVERITIES as readonly unknown[]).includes(value.severity)) return invalid('severity must be info, warning or maintenance')
  const startsAt = timeOf(value.startsAt, 'startsAt'), endsAt = timeOf(value.endsAt, 'endsAt')
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) return invalid('the end must be after the start')
  return { title: localizedOf(value.title, 'title', ANNOUNCEMENT_LIMITS.title, false), body: localizedOf(value.body, 'body', ANNOUNCEMENT_LIMITS.body, true), severity: value.severity as AnnouncementSeverity, audience: audienceOf(value.audience), startsAt, endsAt }
}

export function parseAnnouncementInput(body: unknown): Fields & { expectedRevision: string } {
  if (!object(body) || keys(body) !== INPUT_KEYS) return invalid('exactly title, body, severity, audience, startsAt, endsAt and expectedRevision are required')
  if (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return invalid('the observed announcements revision is required')
  return { ...fieldsOf(body), expectedRevision: body.expectedRevision }
}

const recordOf = (raw: unknown): Announcement | null => {
  try {
    if (!object(raw) || keys(raw) !== RECORD_KEYS || typeof raw.id !== 'string' || !UUID.test(raw.id) || (raw.status !== 'active' && raw.status !== 'archived')
      || [raw.createdAt, raw.updatedAt].some(stamp => typeof stamp !== 'string' || timeOf(stamp, 'stamp') === null) || [raw.createdBy, raw.updatedBy].some(actor => typeof actor !== 'string' || !ACTOR.test(actor))) return null
    const fields = fieldsOf(raw)
    // Saved text must already be normalized; a file whose text would change on re-save is not shown as saved.
    const title = raw.title as LocalizedText, body = raw.body as LocalizedText
    if (fields.title.en !== title.en || fields.title.ar !== title.ar || fields.body.en !== body.en || fields.body.ar !== body.ar) return null
    return { id: raw.id, status: raw.status, ...fields, createdAt: raw.createdAt as string, createdBy: raw.createdBy as string, updatedAt: raw.updatedAt as string, updatedBy: raw.updatedBy as string }
  } catch { return null }
}

/** Strict saved-file reader, newest first. null input is "nothing saved"; anything unreadable returns null. */
export function readSavedAnnouncements(raw: unknown): Announcement[] | null {
  if (raw === null) return []
  if (!Array.isArray(raw) || raw.length > ANNOUNCEMENT_LIMITS.records) return null
  const records = raw.map(recordOf)
  if (records.some(record => record === null)) return null
  const list = records as Announcement[]
  return new Set(list.map(record => record.id)).size === list.length && list.filter(record => record.status === 'active').length <= ANNOUNCEMENT_LIMITS.active ? list : null
}

export const announcementPhase = (record: Announcement, now: number): AnnouncementPhase => record.status === 'archived' ? 'archived'
  : record.startsAt !== null && Date.parse(record.startsAt) > now ? 'scheduled' : record.endsAt !== null && Date.parse(record.endsAt) <= now ? 'ended' : 'live'
export const audienceIncludes = (audience: AnnouncementAudience, account: Pick<Account, 'username' | 'planId' | 'ownerId'>): boolean => audience.kind === 'all'
  || (audience.kind === 'plan' && account.planId === audience.planId) || (audience.kind === 'reseller' && account.ownerId === audience.resellerId)
  || (audience.kind === 'accounts' && audience.usernames.includes(account.username))
const dismissedOf = (raw: unknown): string[] => Array.isArray(raw) && raw.length <= ANNOUNCEMENT_LIMITS.records && raw.every(id => typeof id === 'string' && UUID.test(id)) ? [...new Set(raw as string[])] : []
/** Live announcements addressed to this account that it has not dismissed. */
export const accountAnnouncements = (list: readonly Announcement[], account: Pick<Account, 'username' | 'planId' | 'ownerId'>, dismissed: readonly string[], now: number): AccountAnnouncement[] =>
  list.filter(record => announcementPhase(record, now) === 'live' && audienceIncludes(record.audience, account) && !dismissed.includes(record.id))
    .map(({ id, severity, title, body, startsAt, endsAt }) => ({ id, severity, title, body, startsAt, endsAt }))

type Directory = { plans: { id: string; name: string }[]; resellers: { id: string; username: string }[]; usernames: Set<string> }
const directoryOf = async (helpers: AnnouncementsHelpers): Promise<Directory> => {
  const snapshot = await helpers.store.readSnapshot()
  return { plans: snapshot.plans.map(plan => ({ id: plan.id, name: plan.name })), resellers: snapshot.resellers.map(reseller => ({ id: reseller.id, username: reseller.username })), usernames: new Set(snapshot.accounts.map(account => account.username)) }
}
const assertAudienceKnown = (audience: AnnouncementAudience, directory: Directory): void => {
  if (audience.kind === 'plan' && !directory.plans.some(plan => plan.id === audience.planId)) invalid('the selected plan does not exist')
  if (audience.kind === 'reseller' && !directory.resellers.some(reseller => reseller.id === audience.resellerId)) invalid('the selected reseller does not exist')
  const missing = audience.kind === 'accounts' ? audience.usernames.filter(name => !directory.usernames.has(name)) : []
  if (missing.length) fail('VALIDATION', 'these accounts do not exist: ' + missing.slice(0, 10).join(', '), { stateChanged: false, missing: missing.slice(0, 10) })
}
const manageView = (raw: unknown, directory: Directory, now: number) => {
  const list = readSavedAnnouncements(raw)
  return { state: raw === null ? 'default' : list ? 'saved' : 'invalid', revision: revisionOf(raw), announcements: (list ?? []).map(record => ({ ...record, phase: announcementPhase(record, now) })), choices: { plans: directory.plans, resellers: directory.resellers } }
}

const readJson = async (request: Request): Promise<unknown> => {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return invalid('the request body is too large')
  try { return JSON.parse(text) } catch { return invalid('request body is not valid JSON') }
}
const sameAuthority = (a: AuthenticatedCaller, b: AuthenticatedCaller): boolean => a.principal.id === b.principal.id && a.sessionId === b.sessionId && a.apiTokenId === b.apiTokenId

// shortcut: in-process serialization only; one API process owns these extended state files.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(task: () => Promise<T>): Promise<T> => { const run = queue.then(task, task); queue = run.catch(() => undefined); return run }

/** Root announcement management (/api/server/announcements) and the signed-in owner's live announcements (/api/account/announcements). */
export async function handleAnnouncementsRoute(request: Request, url: URL, method: string, helpers: AnnouncementsHelpers): Promise<Response | null> {
  const now = (): number => (helpers.now?.() ?? new Date()).getTime()
  const account = ACCOUNT_ROUTE.exec(url.pathname)
  if (account) return accountRoute(request, url, method, helpers, account[1], now)
  const match = MANAGE_ROUTE.exec(url.pathname)
  if (!match) return null
  const [, id, archive] = match
  const operation = id === undefined ? (method === 'POST' ? 'create' : 'read') : archive ? 'archive' : 'update'
  const action = 'announcements.' + operation
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  const allow = id === undefined ? 'GET, POST' : archive ? 'POST' : 'PUT'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  if (id !== undefined && !UUID.test(id)) return fail('NOT_FOUND', 'announcement not found', { stateChanged: false })
  if (url.search) return invalid('announcements do not accept selectors')
  if (operation === 'read') return json(200, manageView(await helpers.readSaved(), await directoryOf(helpers), now()))
  const body = await readJson(request)
  let input: (Fields & { expectedRevision: string }) | null = null, expectedRevision: string
  if (operation === 'archive') {
    if (!object(body) || keys(body) !== 'expectedRevision' || typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return invalid('only the observed announcements revision is accepted')
    expectedRevision = body.expectedRevision
  } else { input = parseAnnouncementInput(body); expectedRevision = input.expectedRevision }
  if (input?.endsAt && Date.parse(input.endsAt) <= now()) return invalid('the end must be in the future')
  return serial(async () => {
    const raw = await helpers.readSaved()
    if (revisionOf(raw) !== expectedRevision) return fail('CONFLICT', 'announcements changed since they were read; reload before saving', { stateChanged: false })
    const list = readSavedAnnouncements(raw) ?? []
    const index = id === undefined ? -1 : list.findIndex(record => record.id === id)
    if (id !== undefined && index < 0) return fail('NOT_FOUND', 'announcement not found', { stateChanged: false })
    if (index >= 0 && list[index]!.status === 'archived') return fail('CONFLICT', 'the announcement is archived', { stateChanged: false })
    if (operation === 'create' && list.filter(record => record.status === 'active').length >= ANNOUNCEMENT_LIMITS.active) return invalid(`at most ${ANNOUNCEMENT_LIMITS.active} announcements can be active; archive one first`)
    const directory = await directoryOf(helpers)
    if (input) assertAudienceKnown(input.audience, directory)
    const actor = await helpers.requireCaller(request)
    await helpers.assertRoot(actor, action)
    if (!sameAuthority(actor, caller)) return fail('FORBIDDEN', 'announcement authority changed', { stateChanged: false })
    const stamp = new Date(now()).toISOString(), by = actor.principal.username
    const fields: Fields | null = input && { title: input.title, body: input.body, severity: input.severity, audience: input.audience, startsAt: input.startsAt, endsAt: input.endsAt }
    const next = [...list]
    let target: Announcement
    if (operation === 'create') {
      target = { id: randomUUID(), status: 'active', ...fields!, createdAt: stamp, createdBy: by, updatedAt: stamp, updatedBy: by }
      next.unshift(target)
      // Keep the newest records: active ones are capped above, so the oldest archived record is always the one dropped.
      while (next.length > ANNOUNCEMENT_LIMITS.records) next.splice(next.map(record => record.status).lastIndexOf('archived'), 1)
    } else {
      target = { ...list[index]!, ...(fields ?? { status: 'archived' as const }), updatedAt: stamp, updatedBy: by }
      next[index] = target
    }
    await helpers.writeSaved(next)
    const saved = await helpers.readSaved()
    if (revisionOf(saved) !== revisionOf(next) || !readSavedAnnouncements(saved)) return fail('SERVICE_UNAVAILABLE', 'the saved announcements could not be verified', { stateChanged: true, verificationRequired: true })
    const detail = fields ? { severity: fields.severity, audience: fields.audience.kind, startsAt: fields.startsAt, endsAt: fields.endsAt } : {}
    try { await helpers.emitAudit({ actor: by, action: `server.announcement.${operation === 'create' ? 'created' : operation === 'update' ? 'updated' : 'archived'}`, target: 'announcement:' + target.id, detail, outcome: 'ok', principalId: actor.principal.id }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the announcement is saved but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
    return json(200, { ...manageView(saved, directory, now()), changed: target.id })
  })
}

async function accountRoute(request: Request, url: URL, method: string, helpers: AnnouncementsHelpers, id: string | undefined, now: () => number): Promise<Response> {
  const { caller, account } = await authorizeAccountOwner(helpers, request, [], 'announcements')
  const allow = id === undefined ? 'GET' : 'POST'
  if (method !== allow) return new Response(null, { status: 405, headers: { allow } })
  if (id !== undefined && !UUID.test(id)) return fail('NOT_FOUND', 'announcement not found', { stateChanged: false })
  if (url.search) return invalid('announcements do not accept selectors')
  if (!UUID.test(account.id)) return fail('SERVICE_UNAVAILABLE', 'account announcements are unavailable', { stateChanged: false })
  const readList = async (): Promise<Announcement[]> => readSavedAnnouncements(await helpers.readSaved()) ?? fail('SERVICE_UNAVAILABLE', 'announcements could not be verified', { stateChanged: false })
  if (id === undefined) return json(200, { announcements: accountAnnouncements(await readList(), account, dismissedOf(await helpers.readDismissed(account.id)), now()) })
  if ((await request.text()).length) return invalid('dismissing an announcement takes no request body')
  return serial(async () => {
    const list = await readList()
    if (!accountAnnouncements(list, account, [], now()).some(record => record.id === id)) return fail('NOT_FOUND', 'announcement not found', { stateChanged: false })
    let dismissed = dismissedOf(await helpers.readDismissed(account.id))
    if (!dismissed.includes(id)) {
      const fresh = await authorizeAccountOwner(helpers, request, [], 'announcements')
      if (!sameAuthority(fresh.caller, caller) || fresh.account.id !== account.id) return fail('FORBIDDEN', 'announcement authority changed', { stateChanged: false })
      await helpers.writeDismissed(account.id, [...dismissed.filter(known => list.some(record => record.id === known)), id])
      dismissed = dismissedOf(await helpers.readDismissed(account.id))
      if (!dismissed.includes(id)) return fail('SERVICE_UNAVAILABLE', 'the dismissal could not be verified', { stateChanged: true, verificationRequired: true })
      try { await helpers.emitAudit({ actor: caller.principal.username, action: 'account.announcement.dismissed', target: 'announcement:' + id, outcome: 'ok', principalId: caller.principal.id }) }
      catch { return fail('SERVICE_UNAVAILABLE', 'the dismissal is saved but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
    }
    return json(200, { dismissed: id, announcements: accountAnnouncements(list, account, dismissed, now()) })
  })
}
