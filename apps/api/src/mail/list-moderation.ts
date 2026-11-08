import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fail, normalizeMailboxMetadataAddress } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { atomicWriteJson } from '@xpanel/state'
import type { StateStore, WriterLease } from '@xpanel/state'
import { LIST_POLICY_DEFAULTS, listGated, parseListPolicy } from '../../../agent/src/list-moderation-policy.ts'
import type { ListPolicy } from '../../../agent/src/list-moderation-policy.ts'
import { LIST_GATE_ACTIONS, LIST_GATE_ID, LIST_GATE_MAX_IDS } from '../../../../packages/os/src/list-gate-command.ts'
import type { AuthenticatedCaller } from '../auth.ts'
import { assertAccountFeatures } from '../authorization.ts'
import type { MailingListRecord } from '../extended-routes.ts'
import { mailboxJson, methodNotAllowed } from './folder-admin.ts'
import { freshMailboxTool, mailboxToolBody, mailboxToolObject, mailboxToolRevision, openMailboxTool, MAILBOX_TOOL_UNCHANGED } from './mailbox-spam-authority.ts'
import type { MailboxToolsPorts } from './mailbox-spam-authority.ts'
import type { MailboxSpamRouting } from './mailbox-spam.ts'
import { readLists, unlockListAdmin } from './mailing-list-admin.ts'

/**
 * Posting moderation of a mailing list, as cPanel's Mailman offers it: the owner sets who may post and works the queue in
 * xPanel; a moderator mailbox of the account, or whoever holds the list password, works it from webmail. The policy lives on
 * the list record. The queue belongs to the account, so every read and change goes to the host, which runs the delivery
 * program as the account, and every answer is re-validated because the account can edit those files.
 */
const FEATURES = ['mailing-lists']
const REASONS = ['non_member', 'moderated_member', 'moderated_list', 'sender_filter', 'too_large', 'automated', 'gate_failed']
const unchanged = MAILBOX_TOOL_UNCHANGED
const uncertain = { stateChanged: true, unknownOutcome: true, verificationRequired: true }
const object = mailboxToolObject
const short = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const hostReview = (): never => fail('SERVICE_UNAVAILABLE', 'the list moderation answer from the host requires review', unchanged)
type HostCall = (call: Record<string, unknown>, mutation: boolean) => Promise<unknown>

export interface ListModerationView {
  id: string; address: string; members: string[]
  moderation: MailingListRecord['moderation']; selfSubscription: 'open' | 'closed'; policy: ListPolicy; revision: string
  /** gated: posts pass the delivery check. host.ready: Pigeonhole's external programs module exists. host.active: the check is on the host. */
  gated: boolean
  host: { state: 'connected' | 'not-connected' | 'unverified'; ready: boolean | null; active: boolean | null }
}
const policyOf = (list: MailingListRecord): ListPolicy => {
  try { return list.policy === undefined ? LIST_POLICY_DEFAULTS : parseListPolicy(list.policy) }
  catch { return fail('PRECONDITION_FAILED', 'saved mailing lists require review', { ...unchanged, reason: 'saved_lists_review' }) }
}
const revisionOf = (list: MailingListRecord): string => createHash('sha256').update(JSON.stringify({ namespace: 'list-moderation:v1', id: list.id, members: list.members, moderation: list.moderation, selfSubscription: list.selfSubscription ?? 'closed', policy: policyOf(list) })).digest('hex')
async function readHost(host: HostCall | null, address: string): Promise<ListModerationView['host']> {
  if (!host) return { state: 'not-connected', ready: null, active: null }
  try {
    const status = await host({ address, call: { op: 'status' } }, false)
    return object(status) && typeof status.ready === 'boolean' && typeof status.active === 'boolean' ? { state: 'connected', ready: status.ready, active: status.active } : { state: 'unverified', ready: null, active: null }
  } catch { return { state: 'unverified', ready: null, active: null } }
}
const view = async (list: MailingListRecord, host: HostCall | null): Promise<ListModerationView> => {
  const policy = policyOf(list)
  return { id: list.id, address: list.address, members: list.members, moderation: list.moderation, selfSubscription: list.selfSubscription ?? 'closed', policy, revision: revisionOf(list), gated: listGated(list.moderation, policy), host: await readHost(host, list.address) }
}
const readRow = (row: unknown) => object(row) && typeof row.id === 'string' && LIST_GATE_ID.test(row.id) && short(row.at, 30) && short(row.from, 254) && short(row.subject, 300) && count(row.size) && REASONS.includes(String(row.reason))
  ? { id: row.id, at: row.at, from: row.from, subject: row.subject, size: row.size, reason: row.reason } : hostReview()
const readQueue = (value: unknown) => object(value) && count(value.total) && Array.isArray(value.rows) && value.rows.length <= 500 ? { total: value.total, rows: value.rows.map(readRow) } : hostReview()
const readHeld = (value: unknown) => {
  if (!object(value) || typeof value.found !== 'boolean') return hostReview()
  if (!value.found) return fail('NOT_FOUND', 'the held message is gone', unchanged)
  return short(value.headers, 300_000) && short(value.body, 300_000) && typeof value.truncated === 'boolean' ? { ...readRow(value), headers: value.headers, body: value.body, truncated: value.truncated } : hostReview()
}

/** Queue, message and decision calls of one list; `args` holds the one operation's fields. */
async function moderate(body: Record<string, unknown>, address: string, host: HostCall | null, fresh: () => Promise<void>, audit: (detail: Record<string, unknown>) => Promise<unknown>): Promise<Response> {
  const op = body.op, args = object(body.args) ? body.args : fail('VALIDATION', 'operation arguments are required', unchanged)
  if (!host) return fail('PRECONDITION_FAILED', 'the queue is read on the host, and no host agent is connected', { ...unchanged, reason: 'host_agent_unavailable' })
  await fresh()
  if (op === 'queue') return mailboxJson(readQueue(await host({ address, call: { op: 'queue' } }, false)))
  if (op === 'message') {
    if (typeof args.id !== 'string' || !LIST_GATE_ID.test(args.id)) return fail('VALIDATION', 'a held message id is required', unchanged)
    return mailboxJson(readHeld(await host({ address, call: { op: 'message', id: args.id } }, false)))
  }
  if (op !== 'act') return fail('VALIDATION', 'unknown queue operation', unchanged)
  const ids = args.ids, reason = args.reason ?? ''
  if (!(LIST_GATE_ACTIONS as readonly unknown[]).includes(args.action) || !Array.isArray(ids) || !ids.length || ids.length > LIST_GATE_MAX_IDS || ids.some(id => typeof id !== 'string' || !LIST_GATE_ID.test(id)) || new Set(ids).size !== ids.length) return fail('VALIDATION', `a decision applies to 1 to ${LIST_GATE_MAX_IDS} held messages`, unchanged)
  if (!short(reason, 500) || /[\u0000-\u001f\u007f]/.test(reason) || reason && args.action !== 'reject') return fail('VALIDATION', 'a rejection reason is one line of at most 500 characters', unchanged)
  const reply = await host({ address, call: { op: 'act', action: args.action, reason: reason ? Buffer.from(reason).toString('base64') : '-', ids } }, true)
  if (!object(reply) || !count(reply.done) || !count(reply.failed)) return hostReview()
  try { await audit({ address, action: args.action, requested: ids.length, done: reply.done, failed: reply.failed }) } catch { return fail('SERVICE_UNAVAILABLE', 'the moderation decision requires audit review', uncertain) }
  return mailboxJson({ done: reply.done, failed: reply.failed, stateChanged: reply.done > 0 })
}

export interface ListModerationPorts {
  store: StateStore
  requireCaller: (req: Request) => Promise<AuthenticatedCaller>
  assertCanAccessAccount: (caller: AuthenticatedCaller, account: Account, action: string) => Promise<void>
  emitAudit: (input: { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; principalId: string; detail?: Record<string, unknown> }) => Promise<unknown>
  routing: MailboxSpamRouting
  /** Null without a connected host agent. */
  callHost: ((caller: AuthenticatedCaller, username: string, body: unknown, mutation: boolean) => Promise<unknown>) | null
  now?: () => Date
}
const ROUTE = /^\/api\/mail\/mailing-lists\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/moderation(\/queue)?$/
const POSTINGS = ['open', 'members', 'moderated']
/** xPanel: GET and PUT .../moderation for the policy, POST .../moderation/queue for the queue. */
export async function handleListModerationRoute(req: Request, url: URL, method: string, ports: ListModerationPorts): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const queued = !!match[2], allowed = queued ? ['POST'] : ['GET', 'PUT'], id = match[1]!, root = ports.store.rootDir
  if (!allowed.includes(method)) return methodNotAllowed(allowed)
  if (url.search) return fail('VALIDATION', 'list moderation accepts no selectors', unchanged)
  const authorize = async (): Promise<{ caller: AuthenticatedCaller; account: Account; lists: MailingListRecord[]; list: MailingListRecord }> => {
    const caller = await ports.requireCaller(req), lists = await readLists(root), list = lists.find(item => item.id === id)
    const account = list?.accountId ? await ports.store.getAccount(list.accountId) : null
    if (!list || !account) return fail('NOT_FOUND', 'mailing list not found', unchanged)
    await ports.assertCanAccessAccount(caller, account, 'mail.mailing_list.moderation')
    await assertAccountFeatures(ports.store, caller, account, FEATURES)
    return { caller, account, lists, list }
  }
  const { caller, account, list } = await authorize(), callHost = ports.callHost
  const body = method === 'GET' ? null : await mailboxToolBody(req, url, queued ? ['op', 'args'] : ['moderation', 'selfSubscription', 'policy', 'expectedRevision'])
  const host: HostCall | null = callHost ? (call, mutation) => callHost(caller, account.username, call, mutation) : null
  const audit = (action: string, detail: Record<string, unknown>) => ports.emitAudit({ actor: caller.principal.username, action, target: 'mailing-list:' + list.address, outcome: 'ok', principalId: caller.principal.id, detail })
  if (body === null) return mailboxJson(await view(list, host))
  if (queued) return moderate(body, list.address, host, async () => { await authorize() }, detail => audit('mail.mailing_list.moderated', detail))
  if (!POSTINGS.includes(String(body.moderation)) || !['open', 'closed'].includes(String(body.selfSubscription))) return fail('VALIDATION', 'the posting and subscription policies are invalid', unchanged)
  const moderation = body.moderation as MailingListRecord['moderation'], selfSubscription = body.selfSubscription as 'open' | 'closed', policy = parseListPolicy(body.policy)
  if (!mailboxToolRevision(body.expectedRevision)) return fail('VALIDATION', 'expectedRevision must be the captured revision', unchanged)
  const members = new Set(list.members.map(member => member.toLowerCase()))
  if (policy.moderatedMembers.some(member => !members.has(member))) return fail('VALIDATION', 'a moderated member must be a member of the list', { ...unchanged, field: 'moderatedMembers', reason: 'list_member_unknown' })
  // A limited list without the module is not delivered at all, so an open list must not silently stop.
  if (listGated(moderation, policy) && (await readHost(host, list.address)).ready === false) return fail('PRECONDITION_FAILED', "limiting who posts needs Pigeonhole's external programs module", { ...unchanged, reason: 'sieve_extprograms_missing' })
  const listsFile = join(root, 'extended', 'mail', 'mailing-lists.json'), lease: WriterLease = await ports.store.getWriterLock().acquire()
  let attempted = false, revision = 0, previous: MailingListRecord[] = [], saved: MailingListRecord | null = null
  try {
    const current = await authorize()
    if (revisionOf(current.list) !== body.expectedRevision) return fail('CONFLICT', 'the list changed; reload before saving', unchanged)
    const next = { ...current.list, moderation, selfSubscription, policy }
    if (revisionOf(next) === revisionOf(current.list)) return mailboxJson({ ...await view(current.list, host), stateChanged: false })
    const lists = current.lists.map(item => item.id === id ? next : item)
    await lease.assertFencingToken(); attempted = true
    await atomicWriteJson(listsFile, lists, 0o640, () => lease.assertFencingToken())
    if (JSON.stringify(await readLists(root)) !== JSON.stringify(lists)) throw new Error('mailing_list_readback_mismatch')
    previous = current.lists; saved = next; revision = await ports.routing.commit(lease)
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the list policy outcome requires inspection', uncertain)
    throw error
  } finally { await lease.release() }
  const { nativeApplied } = await ports.routing.apply(req, revision, { path: listsFile, previous })
  try { await audit('mail.mailing_list.policy_saved', { moderation, gated: listGated(moderation, policy), moderators: policy.moderators.length, revision, nativeApplied }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the list policy was saved but its audit requires review', uncertain) }
  return mailboxJson({ ...await view(saved!, host), stateChanged: true, nativeApplied })
}

export interface MailboxListModerationPorts extends MailboxToolsPorts {
  store: Omit<MailboxToolsPorts['store'], 'getAccount'> & { getAccount(id: string): Promise<Account | null> }
  callHost: ((request: Request, username: string, body: unknown, mutation: boolean) => Promise<unknown>) | null
}
/**
 * xMail: POST /api/webmail/mailing-lists/moderation naming the list on every call. A moderator mailbox of the same account
 * signs in with its own session, as a cPanel delegate does; anyone else names the list password, under its lockout.
 */
export async function handleMailboxListModerationRoute(request: Request, url: URL, method: string, ports: MailboxListModerationPorts): Promise<Response | null> {
  if (url.pathname !== '/api/webmail/mailing-lists/moderation') return null
  if (method !== 'POST') return methodNotAllowed(['POST'])
  const body = await mailboxToolBody(request, url, ['list', 'password', 'op', 'args'])
  const address = normalizeMailboxMetadataAddress(body.list)
  if (!address) return fail('VALIDATION', 'the list is its email address', unchanged)
  if (!(body.password === null || typeof body.password === 'string' && body.password && Buffer.byteLength(body.password) <= 1024)) return fail('VALIDATION', 'the list password is a string or null', unchanged)
  const selected = await openMailboxTool(request, ports), mailbox = selected.authority.mailbox, root = ports.store.rootDir, now = ports.now ?? (() => new Date())
  const lease = await ports.store.getWriterLock().acquire()
  let list: MailingListRecord | undefined
  try {
    await freshMailboxTool(request, ports, selected)
    const lists = await readLists(root)
    list = lists.find(item => item.address.toLowerCase() === address)
    const domain = list ? await ports.store.getDomainByName(list.domain.toLowerCase()) : null
    // A list of another account, or on a suspended domain, is not visible to this mailbox.
    if (!list || list.accountId !== selected.authority.accountId || !domain || domain.accountId !== list.accountId || domain.suspended === true) return fail('NOT_FOUND', 'mailing list not found', unchanged)
    if (!policyOf(list).moderators.includes(mailbox)) {
      if (body.password === null) return fail('FORBIDDEN', 'this mailbox is not a moderator of the list', { ...unchanged, reason: 'list_moderator_required' })
      await unlockListAdmin(root, lease, lists, list, body.password as string, now())
    }
  } finally { await lease.release() }
  const account = await ports.store.getAccount(selected.authority.accountId), callHost = ports.callHost
  if (!account) return fail('FORBIDDEN', 'mailbox account is unavailable', unchanged)
  const host: HostCall | null = callHost ? (call, mutation) => callHost(request, account.username, call, mutation) : null
  return moderate(body, list.address, host, () => freshMailboxTool(request, ports, selected), detail => ports.audit(request, { action: 'webmail.mailing_list.moderated', mailbox, detail }))
}
