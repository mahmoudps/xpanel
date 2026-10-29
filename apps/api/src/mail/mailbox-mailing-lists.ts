import { createHash } from 'node:crypto'
import { assessMailboxMetadataAuthority, fail, isUuid, isXpanelError, normalizeMailboxMetadataAddress } from '@xpanel/core'
import type { MailboxMetadataAuthority } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { MailingListRecord } from '../extended-routes.ts'
import { mailboxJson, methodNotAllowed } from './folder-admin.ts'
import { MAILBOX_METADATA_REVIEW_REQUIRED } from './metadata-authority.ts'
import { freshMailboxTool, mailboxToolBody, mailboxToolFile, mailboxToolObject, mailboxToolRevision, openMailboxTool, MAILBOX_TOOL_UNCHANGED } from './mailbox-spam-authority.ts'
import type { BoundMailboxTool, MailboxToolsPorts } from './mailbox-spam-authority.ts'

/** Additional policy/lifetime metadata lives on the existing mailing-list record. */
export interface MailboxMailingListRecord extends MailingListRecord { selfSubscription?: 'open' | 'closed'; memberAuthorities?: Record<string, MailboxMetadataAuthority> }
export interface MailboxMailingListRow {
  id: string; address: string; name: string; revision: string
  subscriptionPolicy: 'open' | 'closed'; postingPolicy: 'open' | 'members' | 'moderated'
  membership: 'subscribed' | 'not_subscribed' | 'review_required'
  canSubscribe: boolean; canUnsubscribe: boolean
}
export interface MailboxMailingListsView {
  context: { mailbox: string }; revision: string; lists: MailboxMailingListRow[]
  metadataReview: typeof MAILBOX_METADATA_REVIEW_REQUIRED
  capabilities: { moderation: false; archive: false; delivery: 'unverified' }
  application: { status: 'configuration_only'; nativeApplied: false }
}
const application = { status: 'configuration_only' as const, nativeApplied: false as const }
const review = (): never => fail('PRECONDITION_FAILED', 'mailing list configuration requires provider review', MAILBOX_TOOL_UNCHANGED)
const listPath = (ports: MailboxToolsPorts) => mailboxToolFile(ports, 'mail', 'mailing-lists.json')
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function readLists(ports: MailboxToolsPorts): Promise<MailboxMailingListRecord[]> {
  const raw = await readJsonIfExists<unknown>(listPath(ports))
  if (raw === null) return []
  if (!Array.isArray(raw) || raw.length > 10_000 || raw.some(item => !mailboxToolObject(item) || !isUuid(item.id) || typeof item.address !== 'string' || !normalizeMailboxMetadataAddress(item.address) || typeof item.domain !== 'string' || item.address.toLowerCase().split('@')[1] !== item.domain.toLowerCase() || typeof item.name !== 'string' || item.name.length > 128 || /[\u0000-\u001f\u007f]/.test(item.name) || !(item.accountId === null || isUuid(item.accountId)) || !Array.isArray(item.members) || item.members.length > 1000 || item.members.some(member => !normalizeMailboxMetadataAddress(member)) || new Set(item.members.map(member => String(member).toLowerCase())).size !== item.members.length || !['open', 'members', 'moderated'].includes(String(item.moderation)) || typeof item.archiveEnabled !== 'boolean' || item.selfSubscription !== undefined && !['open', 'closed'].includes(String(item.selfSubscription)) || item.memberAuthorities !== undefined && !mailboxToolObject(item.memberAuthorities)) || new Set(raw.map(item => item.id)).size !== raw.length) return review()
  return raw as MailboxMailingListRecord[]
}
const member = (list: MailboxMailingListRecord, selected: BoundMailboxTool): 'subscribed' | 'not_subscribed' | 'review_required' => {
  const mailbox = selected.authority.mailbox, present = list.members.some(address => normalizeMailboxMetadataAddress(address) === mailbox), binding = list.memberAuthorities?.[mailbox]
  if (!present) return binding === undefined ? 'not_subscribed' : 'review_required'
  return assessMailboxMetadataAuthority(mailbox, binding, selected.authority) === 'match' ? 'subscribed' : 'review_required'
}
const listRevision = (list: MailboxMailingListRecord, selected: BoundMailboxTool): string => digest({ namespace: 'mailbox-list:v1', authority: selected.authority, list })
async function eligible(list: MailboxMailingListRecord, ports: MailboxToolsPorts, selected: BoundMailboxTool): Promise<boolean> {
  if (list.accountId !== selected.authority.accountId) return false
  const domain = await ports.store.getDomainByName(list.domain.toLowerCase())
  return !!domain && domain.accountId === selected.authority.accountId && domain.name.toLowerCase() === list.domain.toLowerCase() && domain.suspended !== true
}
async function viewLists(lists: MailboxMailingListRecord[], ports: MailboxToolsPorts, selected: BoundMailboxTool): Promise<MailboxMailingListsView> {
  const rows: MailboxMailingListRow[] = []
  for (const list of lists) {
    if (!await eligible(list, ports, selected)) continue
    const membership = member(list, selected), policy = list.selfSubscription ?? 'closed'
    // Unbound legacy membership must not reveal a private list to a recreated mailbox.
    if (policy !== 'open' && membership !== 'subscribed') continue
    rows.push({ id: list.id, address: list.address, name: list.name, revision: listRevision(list, selected), subscriptionPolicy: policy, postingPolicy: list.moderation, membership, canSubscribe: policy === 'open' && membership === 'not_subscribed' && list.members.length < 1000, canUnsubscribe: membership === 'subscribed' })
  }
  rows.sort((a, b) => a.address.localeCompare(b.address, 'en'))
  return { context: { mailbox: selected.authority.mailbox }, revision: digest({ namespace: 'mailbox-lists:v1', authority: selected.authority, rows }), lists: rows, metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED, capabilities: { moderation: false, archive: false, delivery: 'unverified' }, application }
}
/** Changes only the current mailbox's member entry on the canonical account list collection. */
export async function handleMailboxMailingListsRoute(request: Request, url: URL, method: string, ports: MailboxToolsPorts): Promise<Response | null> {
  const match = /^\/api\/webmail\/mailing-lists(?:\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/subscription)?$/.exec(url.pathname)
  if (!match) return null
  const id = match[1]
  if (method !== (id ? 'PUT' : 'GET')) return methodNotAllowed([id ? 'PUT' : 'GET'])
  if (url.search) return fail('VALIDATION', 'mailbox list operations accept no selectors', MAILBOX_TOOL_UNCHANGED)
  const body = id ? await mailboxToolBody(request, url, ['subscribed', 'expectedRevision']) : null
  if (body && (typeof body.subscribed !== 'boolean' || !mailboxToolRevision(body.expectedRevision))) return fail('VALIDATION', 'subscription requires a boolean and captured revision', MAILBOX_TOOL_UNCHANGED)
  const selected = await openMailboxTool(request, ports), lease = await ports.store.getWriterLock().acquire()
  let attempted = false, result: MailboxMailingListsView, listAddress = ''
  try {
    await freshMailboxTool(request, ports, selected)
    const lists = await readLists(ports)
    if (!id) { const view = await viewLists(lists, ports, selected); await freshMailboxTool(request, ports, selected); return mailboxJson(view) }
    const target = lists.find(list => list.id === id)
    if (!target || !await eligible(target, ports, selected)) return fail('NOT_FOUND', 'mailing list not found', MAILBOX_TOOL_UNCHANGED)
    const membership = member(target, selected)
    if (membership === 'review_required') return fail('PRECONDITION_FAILED', 'membership requires verified mailbox ownership review', { ...MAILBOX_TOOL_UNCHANGED, reason: MAILBOX_METADATA_REVIEW_REQUIRED.reason })
    if (membership === 'not_subscribed' && target.selfSubscription !== 'open') return fail('NOT_FOUND', 'mailing list not found', MAILBOX_TOOL_UNCHANGED)
    if (body!.expectedRevision !== listRevision(target, selected)) return fail('CONFLICT', 'mailing list changed; reload before saving', MAILBOX_TOOL_UNCHANGED)
    if (body!.subscribed === (membership === 'subscribed')) return mailboxJson({ ...await viewLists(lists, ports, selected), stateChanged: false })
    if (body!.subscribed && target.selfSubscription !== 'open') return fail('FORBIDDEN', 'the list owner has not enabled self subscription', MAILBOX_TOOL_UNCHANGED)
    if (body!.subscribed && target.members.length >= 1000) return fail('LIMIT_EXCEEDED', 'the mailing list is full', MAILBOX_TOOL_UNCHANGED)
    const mailbox = selected.authority.mailbox, members = body!.subscribed ? [...target.members, mailbox] : target.members.filter(address => normalizeMailboxMetadataAddress(address) !== mailbox), memberAuthorities = { ...target.memberAuthorities }
    if (body!.subscribed) memberAuthorities[mailbox] = selected.authority
    else delete memberAuthorities[mailbox]
    const changed = { ...target, members, memberAuthorities }, next = lists.map(list => list.id === id ? changed : list)
    await freshMailboxTool(request, ports, selected); await lease.assertFencingToken(); attempted = true
    await atomicWriteJson(listPath(ports), next, 0o640, () => lease.assertFencingToken())
    const after = await readLists(ports)
    if (JSON.stringify(after) !== JSON.stringify(next)) throw new Error('mailing_list_readback_mismatch')
    result = await viewLists(after, ports, selected); listAddress = target.address
    await freshMailboxTool(request, ports, selected)
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'subscription outcome requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    if (isXpanelError(error)) throw error
    return review()
  } finally { await lease.release() }
  try { await ports.audit(request, { action: body!.subscribed ? 'webmail.mailing_list.subscribed' : 'webmail.mailing_list.unsubscribed', mailbox: selected.authority.mailbox, detail: { address: listAddress, nativeApplied: false } }) } catch { return fail('SERVICE_UNAVAILABLE', 'subscription was saved but its audit requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  return mailboxJson({ ...result!, stateChanged: true })
}
