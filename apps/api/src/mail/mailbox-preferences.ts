import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { assessMailboxMetadataAuthority, fail, isUuid, isXpanelError } from '@xpanel/core'
import type { MailboxMetadataAuthority, OsProfile } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { WebmailIdentity } from '../extended-routes.ts'
import { renderedMailServerDesired } from '../mail-server-workspace.ts'
import { mailboxJson, methodNotAllowed, strictMailboxBody } from './folder-admin.ts'
import type { SealedMailboxAuditEvent, SealedMailboxSession } from './folder-admin.ts'
import { assertMailboxMetadataAuthority, captureMailboxMetadataAuthority, readBoundMailboxIdentityRecords } from './metadata-authority.ts'
import type { MailboxMetadataAuthorityStore } from './metadata-authority.ts'

export const MAILBOX_DENSITIES = ['comfortable', 'compact'] as const
export const MAILBOX_PAGE_SIZES = [25, 50, 100] as const
export const MAILBOX_DATE_FORMATS = ['utc', 'local'] as const
export interface MailboxPreferenceFields {
  density: typeof MAILBOX_DENSITIES[number]
  messagesPerPage: typeof MAILBOX_PAGE_SIZES[number]
  replyIdentityId: string | null
  dateFormat: typeof MAILBOX_DATE_FORMATS[number]
}
export interface MailboxPreferencesRecord extends MailboxPreferenceFields { mailbox: string; ownerAuthority?: MailboxMetadataAuthority; updatedAt: string }
export type MailboxPreferencesProjection = Omit<MailboxPreferencesRecord, 'ownerAuthority'>
export interface PlusAddressingView { state: 'supported' | 'not-supported' | 'unknown'; delimiter: string | null; source: 'rendered-postfix-local-delivery' }
export interface MailboxPreferencesView {
  context: { mailbox: string }
  preferences: MailboxPreferencesProjection | null
  revision: string
  identities: { id: string; displayName: string; email: string }[]
  plusAddressing: PlusAddressingView
  /** Saved for this mailbox only; no inbox or compose consumer reads these preferences yet. */
  application: { status: 'saved_only'; applied: false }
  review: 'mailbox_metadata_binding_unverified' | null
}
export interface MailboxPreferencesPorts {
  /** Fresh sealed-mailbox authority (server: authorizeNativeMailboxRequest with webmail-preferences); never request input. */
  open: (request: Request) => Promise<SealedMailboxSession>
  store: MailboxMetadataAuthorityStore & Pick<StateStore, 'rootDir' | 'getWriterLock'>
  audit: (request: Request, event: SealedMailboxAuditEvent) => Promise<void>
  /** The host OS profile the reconciler renders mail configuration for; absent when unknown. */
  os?: OsProfile
  now?: () => Date
}

const KEYS = ['density', 'messagesPerPage', 'replyIdentityId', 'dateFormat', 'expectedRevision'] as const
const APPLICATION = Object.freeze({ status: 'saved_only' as const, applied: false as const })
const unchanged = { stateChanged: false }
const SOURCE = 'rendered-postfix-local-delivery' as const
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const sameSession = (left: SealedMailboxSession, right: SealedMailboxSession): boolean => !!right?.record
  && (['sessionId', 'mailbox', 'accountId', 'serviceUserId'] as const).every(key => left.record[key] === right.record[key]) && left.password === right.password
const review = (): never => fail('PRECONDITION_FAILED', 'saved preferences require review', { ...unchanged, reason: 'preferences_unreadable' })

export function parseMailboxPreferenceFields(value: Record<string, unknown>): MailboxPreferenceFields {
  const { density, messagesPerPage, replyIdentityId, dateFormat } = value
  if (!(MAILBOX_DENSITIES as readonly unknown[]).includes(density)) return fail('VALIDATION', 'density must be comfortable or compact', unchanged)
  if (!(MAILBOX_PAGE_SIZES as readonly unknown[]).includes(messagesPerPage)) return fail('VALIDATION', 'messagesPerPage must be 25, 50 or 100', unchanged)
  if (!(MAILBOX_DATE_FORMATS as readonly unknown[]).includes(dateFormat)) return fail('VALIDATION', 'dateFormat must be utc or local', unchanged)
  if (replyIdentityId !== null && (!isUuid(replyIdentityId) || replyIdentityId !== replyIdentityId.toLowerCase())) return fail('VALIDATION', 'replyIdentityId must be null or a saved identity id', unchanged)
  return { density: density as MailboxPreferenceFields['density'], messagesPerPage: messagesPerPage as MailboxPreferenceFields['messagesPerPage'], replyIdentityId, dateFormat: dateFormat as MailboxPreferenceFields['dateFormat'] }
}
const project = (stored: Record<string, unknown>): MailboxPreferencesProjection => {
  const updatedAt = stored.updatedAt
  if (typeof stored.mailbox !== 'string' || typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt)) || new Date(updatedAt).toISOString() !== updatedAt) return review()
  let fields: MailboxPreferenceFields
  try { fields = parseMailboxPreferenceFields(stored) } catch { return review() }
  return { mailbox: stored.mailbox, ...fields, updatedAt }
}
/** Current-value identity (including absence), intentionally not a monotonic counter. */
export const mailboxPreferencesRevision = (authority: MailboxMetadataAuthority | null, preferences: MailboxPreferencesProjection | null): string => createHash('sha256')
  .update(JSON.stringify({ namespace: 'xpanel-mailbox-preferences:v1', ownerAuthority: authority, preferences })).digest('hex')

/** postconf(5) recipient_delimiter separates user from extension (user+tag@domain); empty means no extensions. */
export function plusAddressingFromMain(main: ReadonlyMap<string, string> | null): PlusAddressingView {
  if (!main) return { state: 'unknown', delimiter: null, source: SOURCE }
  const delimiter = main.get('recipient_delimiter')?.trim() ?? ''
  return delimiter ? { state: 'supported', delimiter, source: SOURCE } : { state: 'not-supported', delimiter: null, source: SOURCE }
}

const path = (store: MailboxPreferencesPorts['store'], mailbox: string): string => join(store.rootDir, 'extended', 'webmail', 'preferences', `${encodeURIComponent(mailbox)}.json`)
const sealed = (session: SealedMailboxSession): SealedMailboxSession & { mailbox: string } => {
  const mailbox = typeof session?.record?.mailbox === 'string' ? session.record.mailbox.trim().toLowerCase() : ''
  return /^[^\s@]+@[^\s@]+$/.test(mailbox) ? { ...session, mailbox } : fail('PRECONDITION_FAILED', 'mailbox access is unavailable', unchanged)
}
/** The mailbox lifetime from current state must be the one the sealed session was opened for. */
async function bound(ports: MailboxPreferencesPorts, session: SealedMailboxSession & { mailbox: string }): Promise<MailboxMetadataAuthority> {
  const authority = await captureMailboxMetadataAuthority(ports.store, session.mailbox)
  return authority.accountId === session.record.accountId.toLowerCase() && authority.serviceUserId === session.record.serviceUserId.toLowerCase() && authority.mailbox === session.mailbox
    ? authority : fail('FORBIDDEN', 'mailbox lifetime changed; sign in again', unchanged)
}
const identities = (ports: MailboxPreferencesPorts, mailbox: string, authority: MailboxMetadataAuthority) => readBoundMailboxIdentityRecords(ports.store, mailbox,
  async () => (await readJsonIfExists<WebmailIdentity[]>(join(ports.store.rootDir, 'extended', 'webmail', 'identities.json'))) ?? [], authority)

async function readView(ports: MailboxPreferencesPorts, session: SealedMailboxSession & { mailbox: string }): Promise<MailboxPreferencesView> {
  const authority = await bound(ports, session)
  const stored = await readJsonIfExists<unknown>(path(ports.store, session.mailbox))
  if (stored !== null && !object(stored)) return review()
  const visible = stored !== null && assessMailboxMetadataAuthority(stored.mailbox, stored.ownerAuthority, authority) === 'match' ? project(stored) : null
  return { context: { mailbox: session.mailbox }, preferences: visible, revision: mailboxPreferencesRevision(visible ? authority : null, visible),
    identities: (await identities(ports, session.mailbox, authority)).map(item => ({ id: item.id, displayName: item.displayName, email: item.email })),
    plusAddressing: plusAddressingFromMain(renderedMailServerDesired(ports.os)?.main ?? null), application: APPLICATION,
    review: stored !== null && visible === null ? 'mailbox_metadata_binding_unverified' : null }
}

/** /api/webmail/preferences: the sealed mailbox's own UI preferences, bound to its mailbox lifetime. */
export async function handleMailboxPreferencesRoute(request: Request, url: URL, method: string, ports: MailboxPreferencesPorts): Promise<Response | null> {
  if (url.pathname !== '/api/webmail/preferences') return null
  if (method !== 'GET' && method !== 'PUT') return methodNotAllowed(['GET', 'PUT'])
  if (method === 'GET') {
    if (url.search) return fail('VALIDATION', 'mailbox preferences accept no query selectors', unchanged)
    const session = sealed(await ports.open(request)), result = await readView(ports, session)
    if (!sameSession(session, await ports.open(request))) return fail('FORBIDDEN', 'mailbox session changed; sign in again', unchanged)
    return mailboxJson(result)
  }
  let fields: MailboxPreferenceFields, expectedRevision: string
  try {
    const body = await strictMailboxBody(request, url, KEYS, KEYS)
    fields = parseMailboxPreferenceFields(body)
    expectedRevision = typeof body.expectedRevision === 'string' && /^[0-9a-f]{64}$/.test(body.expectedRevision) ? body.expectedRevision
      : fail('VALIDATION', 'expectedRevision must be an exact lowercase SHA-256 revision', unchanged)
  } catch (error) {
    if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, ...unchanged })
    throw error
  }
  const session = sealed(await ports.open(request)), { mailbox } = session
  const fresh = async (): Promise<void> => { if (!sameSession(session, await ports.open(request))) fail('FORBIDDEN', 'mailbox session changed; sign in again', unchanged) }
  const lease = await ports.store.getWriterLock().acquire()
  let attempted = false
  try {
    await fresh()
    const authority = await bound(ports, session)
    const current = await readJsonIfExists<unknown>(path(ports.store, mailbox))
    if (current !== null && !object(current)) return review()
    if (current !== null) assertMailboxMetadataAuthority(current.mailbox, current.ownerAuthority, authority)
    const visible = current === null ? null : project(current)
    if (expectedRevision !== mailboxPreferencesRevision(visible ? authority : null, visible)) return fail('CONFLICT', 'preferences changed; reload before saving', unchanged)
    if (fields.replyIdentityId !== null && !(await identities(ports, mailbox, authority)).some(item => item.id === fields.replyIdentityId)) {
      return fail('VALIDATION', 'the reply identity is not a saved identity of this mailbox', { ...unchanged, reason: 'identity_unavailable' })
    }
    const record: MailboxPreferencesRecord = { mailbox, ownerAuthority: authority, ...fields, updatedAt: (ports.now ?? (() => new Date()))().toISOString() }
    await fresh()
    await lease.assertFencingToken()
    attempted = true
    await atomicWriteJson(path(ports.store, mailbox), record, 0o640, () => lease.assertFencingToken())
    if (JSON.stringify(await readJsonIfExists<unknown>(path(ports.store, mailbox))) !== JSON.stringify(record)) throw new Error('preferences readback mismatch')
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the preferences change could not be verified; review it before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, ...unchanged })
    throw error
  } finally { await lease.release() }
  let result: MailboxPreferencesView
  try {
    await ports.audit(request, { action: 'webmail.preferences.updated', mailbox, detail: { ...fields } })
    result = await readView(ports, session)
  } catch { return fail('SERVICE_UNAVAILABLE', 'the preferences were saved but could not be recorded or re-read; review them before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
  return mailboxJson({ ...result, stateChanged: true })
}
