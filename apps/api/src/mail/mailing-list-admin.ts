import { fail, isXpanelError, normalizeMailboxMetadataAddress } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore, WriterLease } from '@xpanel/state'
import { hashPasswordArgon2id, verifyPasswordArgon2id } from '../auth.ts'
import type { AuthenticatedCaller } from '../auth.ts'
import { assertPasswordAllowed } from '../password-policy.ts'
import type { MailingListRecord } from '../extended-routes.ts'
import { mailboxJson, methodNotAllowed } from './folder-admin.ts'
import { freshMailboxTool, mailboxToolBody, mailboxToolFile, openMailboxTool, MAILBOX_TOOL_UNCHANGED } from './mailbox-spam-authority.ts'
import type { MailboxToolsPorts } from './mailbox-spam-authority.ts'
import type { MailboxSpamRouting } from './mailbox-spam.ts'

/**
 * Mailing list administrator passwords, as cPanel keeps one per Mailman list: the account owner sets or changes it
 * without the old one, root resets it from WHM, and whoever holds it administers the list's members from webmail.
 * Only an Argon2id hash is stored, apart from the list file that every list reader parses.
 */
interface ListSecret { hash: string; failures: number; lockedUntil: string | null; updatedAt: string }
export const LIST_ADMIN_MAX_FAILURES = 5
export const LIST_ADMIN_LOCK_MS = 15 * 60_000
const unchanged = { stateChanged: false }
const uncertain = { stateChanged: true, unknownOutcome: true, verificationRequired: true }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const listsPath = (root: string) => [root, 'extended', 'mail', 'mailing-lists.json'].join('/')
const secretsPath = (root: string) => [root, 'extended', 'mail', 'mailing-list-passwords.json'].join('/')
const review = (): never => fail('PRECONDITION_FAILED', 'saved mailing lists require review', { ...unchanged, reason: 'saved_lists_review' })

export async function readLists(root: string): Promise<MailingListRecord[]> {
  const raw = await readJsonIfExists<unknown>(listsPath(root))
  if (raw === null) return []
  if (!Array.isArray(raw) || raw.length > 10_000 || raw.some(item => !object(item) || typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.address !== 'string' || !Array.isArray(item.members) || !(item.accountId === null || typeof item.accountId === 'string'))) return review()
  return raw as MailingListRecord[]
}
async function readSecrets(root: string): Promise<Record<string, ListSecret>> {
  const raw = await readJsonIfExists<unknown>(secretsPath(root))
  if (raw === null) return {}
  if (!object(raw) || Object.entries(raw).some(([id, item]) => !UUID.test(id) || !object(item) || typeof item.hash !== 'string' || !item.hash.startsWith('$argon2id$')
    || !Number.isSafeInteger(item.failures) || !(item.lockedUntil === null || typeof item.lockedUntil === 'string') || typeof item.updatedAt !== 'string')) return review()
  return raw as unknown as Record<string, ListSecret>
}
async function writeSecrets(root: string, lease: WriterLease, lists: readonly MailingListRecord[], secrets: Record<string, ListSecret>): Promise<void> {
  // Entries of deleted lists are dropped on every write.
  const kept = Object.fromEntries(Object.entries(secrets).filter(([id]) => lists.some(list => list.id === id)).sort(([a], [b]) => a.localeCompare(b)))
  await atomicWriteJson(secretsPath(root), kept, 0o640, () => lease.assertFencingToken())
}
const passwordOf = (value: unknown): string => {
  if (typeof value !== 'string' || !value.isWellFormed() || /[\u0000-\u001f\u007f]/.test(value) || Buffer.byteLength(value) > 1024) return fail('VALIDATION', 'the list password is 8 to 1024 bytes on one line', { ...unchanged, fields: [{ field: 'password', code: 'password' }] })
  return assertPasswordAllowed(value, 'mail')
}
export interface ListAdminView { id: string; address: string; account: string | null; passwordSet: boolean; members: number }
const view = (list: MailingListRecord, secrets: Record<string, ListSecret>, accounts: ReadonlyMap<string, string>): ListAdminView =>
  ({ id: list.id, address: list.address, account: list.accountId ? accounts.get(list.accountId) ?? null : null, passwordSet: !!secrets[list.id], members: list.members.length })

export interface MailingListAdminPorts {
  store: StateStore
  requireCaller: (req: Request) => Promise<AuthenticatedCaller>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  assertCanAccessAccount: (caller: AuthenticatedCaller, account: Account, action: string) => Promise<void>
  emitAudit: (input: { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; principalId: string; detail?: Record<string, unknown> }) => Promise<unknown>
  /** Protected agent transport for the Postfix restart; null without a connected host agent. */
  callAgent: ((path: string, options: { caller: AuthenticatedCaller; method: string; body: unknown }) => Promise<Response>) | null
  now?: () => Date
}
const readBody = async (req: Request): Promise<Record<string, unknown>> => {
  const text = await req.text()
  if (text.length > 4096) return fail('LIMIT_EXCEEDED', 'request is too large', unchanged)
  try { const value = JSON.parse(text); return object(value) ? value : fail('VALIDATION', 'request body must be a JSON object', unchanged) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
}

/** Owner: PUT /api/mail/mailing-lists/:id/password. Root: GET /api/server/mailing-lists, PUT .../:id/password, POST .../restart. */
export async function handleMailingListAdminRoute(req: Request, url: URL, method: string, ports: MailingListAdminPorts): Promise<Response | null> {
  const owner = /^\/api\/mail\/mailing-lists\/([0-9a-f-]{36})\/password$/.exec(url.pathname)
  const root = /^\/api\/server\/mailing-lists(?:\/([0-9a-f-]{36})\/password|\/(restart))?$/.exec(url.pathname)
  if (!owner && !root) return null
  if (url.search) return fail('VALIDATION', 'mailing list administration accepts no query selectors', unchanged)
  const listing = !!root && !root[1] && !root[2], restart = root?.[2] === 'restart'
  const allowed = listing ? 'GET' : restart ? 'POST' : 'PUT'
  if (method !== allowed) return new Response(null, { status: 405, headers: { allow: allowed } })
  const caller = await ports.requireCaller(req)
  if (root) await ports.assertRoot(caller, 'mail.mailing_list.admin')
  const rootDir = ports.store.rootDir, now = ports.now ?? (() => new Date())
  if (listing) {
    const [lists, secrets, accounts] = await Promise.all([readLists(rootDir), readSecrets(rootDir), ports.store.listAccounts()])
    const names = new Map(accounts.map(account => [account.id, account.username]))
    return mailboxJson({ lists: lists.map(list => view(list, secrets, names)).sort((a, b) => a.address.localeCompare(b.address, 'en')) })
  }
  if (restart) {
    // The list manager here is Postfix: lists are delivered from its alias table, so a restart restarts Postfix after its configuration test.
    if (!(await readLists(rootDir)).length) return fail('PRECONDITION_FAILED', 'no mailing list exists, so no list delivery runs to restart', { ...unchanged, reason: 'no_mailing_lists' })
    if (!ports.callAgent) return fail('PRECONDITION_FAILED', 'restarting list delivery needs the protected host agent', { ...unchanged, reason: 'host_agent_unavailable' })
    const response = await ports.callAgent('/host/services/postfix/restart', { caller, method: 'POST', body: {} })
    const outcome = response.ok ? 'ok' : 'failed'
    try { await ports.emitAudit({ actor: caller.principal.username, action: 'mail.mailing_lists.restarted', target: 'service:postfix', outcome, principalId: caller.principal.id, detail: { status: response.status } }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'list delivery was restarted but its audit requires review', uncertain) }
    return response
  }
  const id = (owner?.[1] ?? root![1])!
  const body = await readBody(req)
  if (Object.keys(body).join() !== 'password') return fail('VALIDATION', 'a password change takes only the new password', unchanged)
  const password = passwordOf(body.password)
  const lease = await ports.store.getWriterLock().acquire()
  let attempted = false, address = ''
  try {
    const lists = await readLists(rootDir), list = lists.find(item => item.id === id)
    if (!list) return fail('NOT_FOUND', 'mailing list not found', unchanged)
    if (owner) {
      const account = list.accountId ? await ports.store.getAccount(list.accountId) : null
      if (!account) return fail('NOT_FOUND', 'mailing list not found', unchanged)
      await ports.assertCanAccessAccount(caller, account, 'mail.mailing_list.password')
    }
    const hash = await hashPasswordArgon2id(password), secrets = await readSecrets(rootDir)
    await lease.assertFencingToken(); attempted = true
    await writeSecrets(rootDir, lease, lists, { ...secrets, [id]: { hash, failures: 0, lockedUntil: null, updatedAt: now().toISOString() } })
    if ((await readSecrets(rootDir))[id]?.hash !== hash) throw new Error('list_password_readback_mismatch')
    address = list.address
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the list password outcome requires inspection', uncertain)
    throw error
  } finally { await lease.release() }
  try { await ports.emitAudit({ actor: caller.principal.username, action: root ? 'mail.mailing_list.password_reset' : 'mail.mailing_list.password_changed', target: 'mailing-list:' + address, outcome: 'ok', principalId: caller.principal.id }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the list password was saved but its audit requires review', uncertain) }
  return mailboxJson({ id, address, passwordSet: true })
}

/** A wrong password counts toward the lock, under the caller's writer lease; every list sign-in passes here. */
export async function unlockListAdmin(root: string, lease: WriterLease, lists: readonly MailingListRecord[], list: MailingListRecord, password: string, now: Date): Promise<void> {
  const secrets = await readSecrets(root), secret = secrets[list.id]
  if (!secret) return fail('PRECONDITION_FAILED', 'this list has no administrator password yet', { ...MAILBOX_TOOL_UNCHANGED, reason: 'list_password_unset' })
  if (secret.lockedUntil && Date.parse(secret.lockedUntil) > now.getTime()) return fail('FORBIDDEN', 'list sign-in is locked after repeated wrong passwords', { ...MAILBOX_TOOL_UNCHANGED, reason: 'list_admin_locked', lockedUntil: secret.lockedUntil })
  if (!await verifyPasswordArgon2id(password, secret.hash)) {
    const failures = secret.failures + 1, locked = failures >= LIST_ADMIN_MAX_FAILURES
    await lease.assertFencingToken()
    await writeSecrets(root, lease, lists, { ...secrets, [list.id]: { ...secret, failures: locked ? 0 : failures, lockedUntil: locked ? new Date(now.getTime() + LIST_ADMIN_LOCK_MS).toISOString() : secret.lockedUntil } })
    return fail('FORBIDDEN', 'the list password is not correct', { ...MAILBOX_TOOL_UNCHANGED, reason: locked ? 'list_admin_locked' : 'list_password_wrong' })
  }
  if (secret.failures || secret.lockedUntil) { await lease.assertFencingToken(); await writeSecrets(root, lease, lists, { ...secrets, [list.id]: { ...secret, failures: 0, lockedUntil: null } }) }
}

/**
 * Webmail list administration: POST /api/webmail/mailing-lists/admin naming the list and its password on every call,
 * like a Mailman admin sign-in. Five wrong passwords lock the list's sign-in for 15 minutes.
 */
export async function handleMailboxListAdminRoute(request: Request, url: URL, method: string, ports: MailboxToolsPorts & { routing: MailboxSpamRouting }): Promise<Response | null> {
  if (url.pathname !== '/api/webmail/mailing-lists/admin') return null
  if (method !== 'POST') return methodNotAllowed(['POST'])
  const body = await mailboxToolBody(request, url, ['list', 'password', 'op', 'member'])
  const address = normalizeMailboxMetadataAddress(body.list)
  if (!address) return fail('VALIDATION', 'the list is its email address', MAILBOX_TOOL_UNCHANGED)
  if (typeof body.password !== 'string' || !body.password || Buffer.byteLength(body.password) > 1024 || !['read', 'add', 'remove'].includes(body.op as string)) return fail('VALIDATION', 'list administration needs the list password and read, add or remove', MAILBOX_TOOL_UNCHANGED)
  const member = body.op === 'read' ? null : normalizeMailboxMetadataAddress(body.member)
  if (body.op === 'read' ? body.member !== null : !member) return fail('VALIDATION', 'a member is one email address', MAILBOX_TOOL_UNCHANGED)
  const selected = await openMailboxTool(request, ports), now = ports.now ?? (() => new Date())
  const root = ports.store.rootDir, lease = await ports.store.getWriterLock().acquire()
  let attempted = false, revision = 0, previous: unknown = null, result: { address: string; members: string[] } | null = null
  try {
    await freshMailboxTool(request, ports, selected)
    const lists = await readLists(root), list = lists.find(item => item.address.toLowerCase() === address)
    const domain = list ? await ports.store.getDomainByName(list.domain.toLowerCase()) : null
    // A list of another account, or on a suspended domain, is not visible to this mailbox.
    if (!list || list.accountId !== selected.authority.accountId || !domain || domain.accountId !== list.accountId || domain.suspended === true) return fail('NOT_FOUND', 'mailing list not found', MAILBOX_TOOL_UNCHANGED)
    await unlockListAdmin(root, lease, lists, list, body.password as string, now())
    const members = body.op === 'read' ? list.members : body.op === 'add' ? [...new Set([...list.members, member!])] : list.members.filter(item => item.toLowerCase() !== member)
    if (body.op === 'add' && members.length > 1000) return fail('LIMIT_EXCEEDED', 'the mailing list is full', MAILBOX_TOOL_UNCHANGED)
    if (body.op === 'read' || members.length === list.members.length) {
      await freshMailboxTool(request, ports, selected)
      return mailboxJson({ address: list.address, members: [...members].sort(), stateChanged: false })
    }
    // A member the administrator removes loses any self-subscription binding with it.
    const memberAuthorities = { ...list.memberAuthorities }
    if (body.op === 'remove') delete memberAuthorities[member!]
    const next = lists.map(item => item.id === list.id ? { ...list, members, ...(list.memberAuthorities ? { memberAuthorities } : {}) } : item)
    await freshMailboxTool(request, ports, selected); await lease.assertFencingToken(); attempted = true
    await atomicWriteJson(mailboxToolFile(ports, 'mail', 'mailing-lists.json'), next, 0o640, () => lease.assertFencingToken())
    if (JSON.stringify(await readLists(root)) !== JSON.stringify(next)) throw new Error('mailing_list_readback_mismatch')
    previous = lists; revision = await ports.routing.commit(lease); result = { address: list.address, members: [...members].sort() }
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the member change outcome requires inspection', uncertain)
    if (isXpanelError(error)) throw error
    return review()
  } finally { await lease.release() }
  const { nativeApplied } = await ports.routing.apply(request, revision, { path: mailboxToolFile(ports, 'mail', 'mailing-lists.json'), previous })
  try { await ports.audit(request, { action: body.op === 'add' ? 'webmail.mailing_list.member_added' : 'webmail.mailing_list.member_removed', mailbox: selected.authority.mailbox, detail: { address: result!.address, member, nativeApplied } }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the member change was saved but its audit requires review', uncertain) }
  return mailboxJson({ ...result!, stateChanged: true, nativeApplied })
}
