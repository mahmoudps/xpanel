import { createHash } from 'node:crypto'
import { assessMailboxMetadataAuthority, fail, isXpanelError } from '@xpanel/core'
import type { MailboxMetadataAuthority } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { SpamSettingsState } from '../extended-routes.ts'
import { mailboxJson, methodNotAllowed } from './folder-admin.ts'
import { assertMailboxMetadataAuthority } from './metadata-authority.ts'
import { freshMailboxTool, mailboxToolBody, mailboxToolFile, mailboxToolObject, mailboxToolRevision, openMailboxTool, MAILBOX_TOOL_UNCHANGED } from './mailbox-spam-authority.ts'
import type { BoundMailboxTool, MailboxToolsPorts } from './mailbox-spam-authority.ts'

export interface MailboxSpamFields extends Pick<SpamSettingsState, 'enabled' | 'addHeaderScore' | 'spamBoxEnabled' | 'allowlist' | 'blocklist'> { inherit: boolean }
interface MailboxSpamRecord extends MailboxSpamFields { mailbox: string; ownerAuthority: MailboxMetadataAuthority; updatedAt: string }
export interface MailboxSpamView {
  context: { mailbox: string }
  revision: string
  inherited: { source: 'account' | 'default'; enabled: boolean; addHeaderScore: number; spamBoxEnabled: boolean }
  preferences: (MailboxSpamFields & { updatedAt: string }) | null
  effective: { enabled: boolean; addHeaderScore: number; spamBoxEnabled: boolean; source: 'account' | 'mailbox' }
  review: 'mailbox_metadata_binding_unverified' | null
  capabilities: { canSave: boolean; mta: 'unverified'; sieve: 'unverified'; boxTrapper: false }
  application: { status: 'saved_only'; applied: false }
}
const FIELDS = ['inherit', 'enabled', 'addHeaderScore', 'spamBoxEnabled', 'allowlist', 'blocklist'] as const
const application = { status: 'saved_only' as const, applied: false as const }
const review = (): never => fail('PRECONDITION_FAILED', 'saved spam preferences require provider review', MAILBOX_TOOL_UNCHANGED)
const ownPath = (ports: MailboxToolsPorts, selected: BoundMailboxTool) => mailboxToolFile(ports, 'webmail', 'spam-preferences', encodeURIComponent(selected.authority.mailbox) + '.json')
function inheritedSpam(raw: unknown): MailboxSpamView['inherited'] {
  if (raw === null) return { source: 'default', enabled: true, addHeaderScore: 5, spamBoxEnabled: true }
  if (!mailboxToolObject(raw)) return review()
  const { enabled, spamBoxEnabled, addHeaderScore } = raw
  if (typeof enabled !== 'boolean' || typeof spamBoxEnabled !== 'boolean' || typeof addHeaderScore !== 'number' || !Number.isFinite(addHeaderScore) || addHeaderScore < 0 || addHeaderScore > 100) return review()
  return { source: 'account', enabled, addHeaderScore, spamBoxEnabled }
}
function addresses(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) return fail('VALIDATION', 'sender lists permit at most 100 exact addresses', MAILBOX_TOOL_UNCHANGED)
  const list = value.map(item => typeof item === 'string' ? item.trim().toLowerCase() : '')
  if (list.some(item => !item || item.length > 254 || /[*?]/.test(item) || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(item)) || new Set(list).size !== list.length) return fail('VALIDATION', 'sender lists require unique exact email addresses', MAILBOX_TOOL_UNCHANGED)
  return list
}
export function parseMailboxSpamFields(value: Record<string, unknown>): MailboxSpamFields {
  if (typeof value.inherit !== 'boolean' || typeof value.enabled !== 'boolean' || typeof value.spamBoxEnabled !== 'boolean' || typeof value.addHeaderScore !== 'number' || !Number.isFinite(value.addHeaderScore) || value.addHeaderScore < 0 || value.addHeaderScore > 100) return fail('VALIDATION', 'spam preferences require booleans and a score from 0 through 100', MAILBOX_TOOL_UNCHANGED)
  const allowlist = addresses(value.allowlist), blocklist = addresses(value.blocklist)
  if (allowlist.some(address => blocklist.includes(address))) return fail('VALIDATION', 'an address cannot appear in both sender lists', MAILBOX_TOOL_UNCHANGED)
  return { inherit: value.inherit, enabled: value.enabled, addHeaderScore: value.addHeaderScore, spamBoxEnabled: value.spamBoxEnabled, allowlist, blocklist }
}
async function readMailboxSpam(ports: MailboxToolsPorts, selected: BoundMailboxTool): Promise<{ view: MailboxSpamView; stored: Record<string, unknown> | null }> {
  const authority = selected.authority, raw = await readJsonIfExists<unknown>(mailboxToolFile(ports, 'mail', 'accounts', authority.accountId, 'spam-settings.json'))
  const inherited = inheritedSpam(raw)
  const stored = await readJsonIfExists<unknown>(ownPath(ports, selected))
  if (stored !== null && !mailboxToolObject(stored)) return review()
  const matched = stored !== null && assessMailboxMetadataAuthority(stored.mailbox, stored.ownerAuthority, authority) === 'match'
  let preferences: MailboxSpamView['preferences'] = null
  if (matched) {
    if (typeof stored.updatedAt !== 'string' || !Number.isFinite(Date.parse(stored.updatedAt)) || new Date(stored.updatedAt).toISOString() !== stored.updatedAt) return review()
    try { preferences = { ...parseMailboxSpamFields(stored), updatedAt: stored.updatedAt } } catch { return review() }
  }
  const custom = !!preferences && !preferences.inherit, effective = { enabled: inherited.enabled && (custom ? preferences!.enabled : true), addHeaderScore: custom ? preferences!.addHeaderScore : inherited.addHeaderScore, spamBoxEnabled: custom ? preferences!.spamBoxEnabled : inherited.spamBoxEnabled, source: custom ? 'mailbox' as const : 'account' as const }
  const revision = createHash('sha256').update(JSON.stringify({ namespace: 'mailbox-spam:v1', authority, inherited, preferences, review: stored !== null && !matched })).digest('hex')
  return { stored, view: { context: { mailbox: authority.mailbox }, revision, inherited, preferences, effective, review: stored !== null && !matched ? 'mailbox_metadata_binding_unverified' : null, capabilities: { canSave: stored === null || matched, mta: 'unverified', sieve: 'unverified', boxTrapper: false }, application } }
}
/** Mailbox overrides share the existing account policy; MTA/Sieve activation is deliberately unclaimed. */
export async function handleMailboxSpamRoute(request: Request, url: URL, method: string, ports: MailboxToolsPorts): Promise<Response | null> {
  if (url.pathname !== '/api/webmail/spam-preferences') return null
  if (!['GET', 'PUT'].includes(method)) return methodNotAllowed(['GET', 'PUT'])
  if (url.search) return fail('VALIDATION', 'spam preferences accept no selectors', MAILBOX_TOOL_UNCHANGED)
  const body = method === 'PUT' ? await mailboxToolBody(request, url, [...FIELDS, 'expectedRevision']) : null
  const fields = body ? parseMailboxSpamFields(body) : null
  if (body && !mailboxToolRevision(body.expectedRevision)) return fail('VALIDATION', 'expectedRevision must be the captured revision', MAILBOX_TOOL_UNCHANGED)
  const selected = await openMailboxTool(request, ports), lease = await ports.store.getWriterLock().acquire()
  let attempted = false, result: MailboxSpamView, changed = false
  try {
    await freshMailboxTool(request, ports, selected)
    const before = await readMailboxSpam(ports, selected)
    if (!body) { await freshMailboxTool(request, ports, selected); return mailboxJson(before.view) }
    if (before.stored) assertMailboxMetadataAuthority(before.stored.mailbox, before.stored.ownerAuthority, selected.authority)
    if (body.expectedRevision !== before.view.revision) return fail('CONFLICT', 'spam policy changed; reload before saving', MAILBOX_TOOL_UNCHANGED)
    const currentFields = before.view.preferences ? Object.fromEntries(FIELDS.map(key => [key, before.view.preferences![key]])) : null
    if (JSON.stringify(currentFields) === JSON.stringify(fields)) return mailboxJson({ ...before.view, stateChanged: false })
    const record: MailboxSpamRecord = { ...fields!, mailbox: selected.authority.mailbox, ownerAuthority: selected.authority, updatedAt: (ports.now ?? (() => new Date()))().toISOString() }
    await freshMailboxTool(request, ports, selected); await lease.assertFencingToken(); attempted = true
    await atomicWriteJson(ownPath(ports, selected), record, 0o640, () => lease.assertFencingToken())
    const after = await readMailboxSpam(ports, selected)
    if (JSON.stringify(after.view.preferences) !== JSON.stringify({ ...fields!, updatedAt: record.updatedAt }) || after.view.review !== null) throw new Error('spam_readback_mismatch')
    await freshMailboxTool(request, ports, selected); result = after.view; changed = true
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'spam preference outcome requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    if (isXpanelError(error)) throw error
    return review()
  } finally { await lease.release() }
  try { await ports.audit(request, { action: 'webmail.spam_preferences.updated', mailbox: selected.authority.mailbox, detail: { inherit: fields!.inherit, allowCount: fields!.allowlist.length, blockCount: fields!.blocklist.length, applied: false } }) } catch { return fail('SERVICE_UNAVAILABLE', 'saved spam preferences require audit review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  return mailboxJson({ ...result!, stateChanged: changed })
}
