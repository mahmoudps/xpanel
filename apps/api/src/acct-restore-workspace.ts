import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { isMailboxPrincipal } from './authorization.ts'
import { readReply } from './backup-file-restore-workspace.ts'
import type { BackupFileRestoreWorkspacePorts } from './backup-file-restore-workspace.ts'
import { MAX_RESTORE_FILES, RESTORE_REVISION } from '../../agent/src/backup-file-restore-request.ts'
import { archivedMessageMailbox, MAILBOX_ADDRESS, MAX_LISTED_MAILBOXES, parseComponentRestoreRequest } from '../../agent/src/acct-restore-request.ts'
import type { ComponentRestoreRequest } from '../../agent/src/acct-restore-request.ts'

export type ComponentRestoreWorkspacePorts = Omit<BackupFileRestoreWorkspacePorts, 'visibleAccounts'>
const ROUTE = /^\/api\/backups\/components\/([a-z][a-z0-9]{0,15})\/(inventory|preview|restore)$/
const unchanged = { stateChanged: false }
const STATES = ['restored', 'skipped-exists', 'failed', 'not-attempted'] as const
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const readBody = async (req: Request): Promise<unknown> => {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) return fail('VALIDATION', 'a JSON component restore request is required', unchanged)
  const text = await req.text()
  if (Buffer.byteLength(text) > 64 * 1024) return fail('LIMIT_EXCEEDED', 'the component restore request is too large', unchanged)
  try { return JSON.parse(text) } catch { return fail('VALIDATION', 'the component restore request must be valid JSON', unchanged) }
}

/** The agent reply must stay bound to the selected account, archive, mailboxes and reviewed revision. */
export function verifiedComponentReply(request: ComponentRestoreRequest, value: unknown, account: Account): boolean {
  if (!object(value) || !exact(value.context, ['accountId', 'username']) || value.context.accountId !== account.id || value.context.username !== account.username) return false
  const archive = value.archive
  if (!object(archive) || archive.file !== request.file || archive.integrity !== 'verified' || typeof archive.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(archive.sha256) || !count(archive.bytes)) return false
  if (request.op === 'inventory') {
    const c = value.components
    if (!exact(c, ['files', 'mail', 'mailSettings', 'databases', 'dns']) || !exact(c.files, ['state', 'files', 'bytes']) || c.files.state !== 'available' || !count(c.files.files) || !count(c.files.bytes)
      || !exact(c.mailSettings, ['state', 'files']) || c.mailSettings.state !== 'not-restorable' || !count(c.mailSettings.files)
      || !exact(c.databases, ['state']) || c.databases.state !== 'not-in-archive' || !exact(c.dns, ['state']) || c.dns.state !== 'not-in-archive'
      || !exact(c.mail, ['state', 'mailboxes', 'truncated']) || !['available', 'unavailable'].includes(c.mail.state as string) || typeof c.mail.truncated !== 'boolean' || !Array.isArray(c.mail.mailboxes) || c.mail.mailboxes.length > MAX_LISTED_MAILBOXES) return false
    return new Set(c.mail.mailboxes.map(box => object(box) ? box.address : null)).size === c.mail.mailboxes.length
      && c.mail.mailboxes.every(box => exact(box, ['address', 'messages', 'bytes', 'current']) && typeof box.address === 'string' && MAILBOX_ADDRESS.test(box.address) && count(box.messages) && count(box.bytes) && (box.current === 'exists' || box.current === 'missing'))
  }
  const selected = new Set(request.mailboxes)
  const mine = (path: unknown): boolean => typeof path === 'string' && selected.has(archivedMessageMailbox(path) ?? '')
  if (!Array.isArray(value.mailboxes) || value.mailboxes.length !== request.mailboxes.length || value.mailboxes.some((item, index) => item !== request.mailboxes[index]) || typeof value.revision !== 'string' || !RESTORE_REVISION.test(value.revision)) return false
  if (request.op === 'preview') {
    const counts = value.counts
    return Array.isArray(value.rows) && value.rows.length <= MAX_RESTORE_FILES && value.rows.every(row => exact(row, ['path', 'bytes']) && mine(row.path) && count(row.bytes))
      && exact(counts, ['messages', 'present', 'batch', 'remaining', 'refused']) && [counts.messages, counts.present, counts.remaining, counts.refused].every(count) && counts.batch === value.rows.length
      && object(value.quota) && typeof value.quota.fits === 'boolean' && (value.writer === 'available' || value.writer === 'unavailable')
  }
  const results = value.results, counts = value.counts
  return value.revision === request.expectedRevision && Array.isArray(results) && results.length <= MAX_RESTORE_FILES && object(counts) && typeof value.verificationRequired === 'boolean' && typeof value.complete === 'boolean' && count(value.remaining)
    && results.every(row => exact(row, ['path', 'bytes', 'result', 'reason', 'verificationRequired']) && mine(row.path) && STATES.includes(row.result as typeof STATES[number]) && typeof row.verificationRequired === 'boolean')
    && STATES.every(state => counts[state] === results.filter(row => (row as Record<string, unknown>).result === state).length)
    && value.verificationRequired === results.some(row => (row as Record<string, unknown>).verificationRequired === true)
}

/** /api/backups/components/<username>/(inventory|preview|restore): root, or a reseller for its own active accounts. */
export async function handleComponentRestoreWorkspaceRoute(req: Request, url: URL, method: string, ports: ComponentRestoreWorkspacePorts): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'component restore requests do not accept query selectors', unchanged)
  const username = match[1]!, op = match[2] as ComponentRestoreRequest['op']
  const authorize = async (): Promise<{ caller: AuthenticatedCaller; account: Account }> => {
    const caller = await ports.requireCaller(req)
    if (isMailboxPrincipal(caller) || caller.principal.kind !== 'root' && caller.principal.kind !== 'reseller') return fail('FORBIDDEN', 'component restore requires root or a reseller', unchanged)
    const account = await ports.getAccountByUsername(username)
    if (!account || account.username !== username) return fail('NOT_FOUND', 'account not found', unchanged)
    await ports.assertCanAccessAccount(caller, account, 'backup.components.' + op)
    if (account.status !== 'active') return fail('PRECONDITION_FAILED', 'component restore requires an active account', unchanged)
    return { caller, account }
  }
  const first = await authorize()
  const request = parseComponentRestoreRequest(op, first.account.username, await readBody(req))
  if (!ports.callAgent) return fail('PRECONDITION_FAILED', 'privileged host agent is not connected', unchanged)
  let caller = first.caller
  if (request.op === 'restore') {
    // Fresh authority immediately before the mutation; the agent re-checks again inside its account lease.
    const fresh = await authorize()
    if (fresh.account.id !== first.account.id || fresh.account.uid !== first.account.uid || fresh.account.home !== first.account.home || fresh.caller.principal.id !== first.caller.principal.id) return fail('CONFLICT', 'the account or administrator changed before the restore', unchanged)
    caller = fresh.caller
  }
  const { op: _op, ...body } = request
  const response = await ports.callAgent('/accounts/' + first.account.username + '/backup-components/' + op, { caller, method: 'POST', body })
  if (response.status !== 200) return response
  const value = await readReply(response)
  if (!verifiedComponentReply(request, value, first.account)) return request.op === 'restore'
    ? fail('PRECONDITION_FAILED', 'the mail restore outcome requires review; inspect the mailboxes', { stateChanged: true, verificationRequired: true })
    : fail('PRECONDITION_FAILED', 'the host backup response could not be verified', unchanged)
  return json(value)
}
