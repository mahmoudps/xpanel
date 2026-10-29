import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { isMailboxPrincipal } from './authorization.ts'
import { BACKUP_ARCHIVE_NAME, MAX_LISTED_ARCHIVES, MAX_RESTORE_FILES, parseBackupFileRequest, RESTORE_REVISION, restorePath } from '../../agent/src/backup-file-restore-request.ts'
import type { BackupFileRequest } from '../../agent/src/backup-file-restore-request.ts'

export interface BackupFileRestoreWorkspacePorts {
  /** Authenticates and applies the declared route policy (reseller list-accounts to read, edit-account to restore). */
  requireCaller(req: Request): Promise<AuthenticatedCaller>
  getAccountByUsername(username: string): Promise<Account | null>
  /** Existing ownership scoping (ownedAccounts): every account for root, owned accounts for a reseller. */
  visibleAccounts(caller: AuthenticatedCaller): Promise<readonly Account[]>
  /** Existing account authorization: reseller ownership, ACL and plan features. */
  assertCanAccessAccount(caller: AuthenticatedCaller, account: Account, action: string): Promise<void>
  /** Protected agent RPC; absent when the host agent is not connected. */
  callAgent?: (path: string, options: { caller: AuthenticatedCaller; method?: string; body?: unknown }) => Promise<Response>
}

const ROUTE = /^\/api\/backups\/files(?:\/([a-z][a-z0-9]{0,15})(?:\/(browse|preview|restore))?)?$/
const MAX_REPLY_BYTES = 8 * 1024 * 1024
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const path = (value: unknown): boolean => { try { restorePath(value); return true } catch { return false } }
// A refused row may name a destination longer than a selectable path (restored-<stamp>/ prefix).
const target = (value: unknown): boolean => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 8192 && value.split('/').every(path)
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const readBody = async (req: Request): Promise<unknown> => {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) return fail('VALIDATION', 'a JSON file restore request is required', unchanged)
  const text = await req.text()
  if (Buffer.byteLength(text) > 1024 * 1024) return fail('LIMIT_EXCEEDED', 'the file restore request is too large', unchanged)
  try { return JSON.parse(text) } catch { return fail('VALIDATION', 'the file restore request must be valid JSON', unchanged) }
}
export const readReply = async (response: Response): Promise<unknown> => {
  if (!response.body) return null
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_REPLY_BYTES) { await reader.cancel(); return null }
      chunks.push(next.value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch { return null } finally { reader.releaseLock() }
}

/** The agent reply must stay bound to the selected account, archive, selection and reviewed revision. */
const verified = (op: BackupFileRequest['op'] | 'list', value: unknown, account: Account, request: BackupFileRequest | null): boolean => {
  if (!object(value) || !object(value.context) || value.context.accountId !== account.id || value.context.username !== account.username) return false
  const archiveName = (file: unknown): boolean => typeof file === 'string' && BACKUP_ARCHIVE_NAME.test(file) && file.startsWith('xpanel-backup-' + account.username + '-')
  if (op === 'list') return Array.isArray(value.archives) && value.archives.length <= MAX_LISTED_ARCHIVES && count(value.total) && value.total >= value.archives.length && typeof value.truncated === 'boolean'
    && new Set(value.archives.map(item => object(item) ? item.file : null)).size === value.archives.length
    && value.archives.every(item => object(item) && archiveName(item.file) && count(item.bytes) && (item.integrity === 'unverified' || item.integrity === 'rejected'))
  const archive = value.archive
  if (!object(archive) || archive.file !== request?.file) return false
  const digest = archive.integrity === 'verified' && typeof archive.sha256 === 'string' && /^[0-9a-f]{64}$/.test(archive.sha256) && count(archive.bytes)
  if (op === 'browse') return Array.isArray(value.entries) && (digest && value.entries.length <= 10_000 || archive.integrity === 'rejected' && value.entries.length === 0)
    && value.entries.every(entry => object(entry) && path(entry.path) && count(entry.bytes))
  if (!digest || !object(value.destination) || value.destination.mode !== (request as Extract<BackupFileRequest, { paths: string[] }>).destination || typeof value.revision !== 'string' || !RESTORE_REVISION.test(value.revision)) return false
  if (op === 'preview') return Array.isArray(value.rows) && value.rows.length <= MAX_RESTORE_FILES
    && value.rows.every(row => object(row) && path(row.path) && target(row.destination) && count(row.bytes) && (row.action === 'restore' || row.action === 'refuse') && ['yes', 'no', 'unchecked'].includes(String(row.exists)))
  const results = value.results, counts = value.counts
  if (value.revision !== (request as Extract<BackupFileRequest, { op: 'restore' }>).expectedRevision || !Array.isArray(results) || results.length > MAX_RESTORE_FILES || !object(counts)) return false
  const states = ['restored', 'skipped-exists', 'failed', 'not-attempted']
  return results.every(row => object(row) && path(row.path) && target(row.destination) && states.includes(String(row.result)) && typeof row.verificationRequired === 'boolean')
    && states.every(state => counts[state] === results.filter(row => (row as Record<string, unknown>).result === state).length)
}

/** /api/backups/files[/<username>[/browse|preview|restore]]: root, or a reseller for its own active accounts. */
export async function handleBackupFileRestoreWorkspaceRoute(req: Request, url: URL, method: string, ports: BackupFileRestoreWorkspacePorts): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const username = match[1], op = match[2] as BackupFileRequest['op'] | undefined
  if (method !== (op ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: op ? 'POST' : 'GET' } })
  if (url.search) return fail('VALIDATION', 'file restore requests do not accept query selectors', unchanged)
  const authorize = async (): Promise<{ caller: AuthenticatedCaller; account: Account | null }> => {
    const caller = await ports.requireCaller(req)
    if (isMailboxPrincipal(caller) || caller.principal.kind !== 'root' && caller.principal.kind !== 'reseller') return fail('FORBIDDEN', 'file restore requires root or a reseller', unchanged)
    if (!username) return { caller, account: null }
    const account = await ports.getAccountByUsername(username)
    if (!account || account.username !== username) return fail('NOT_FOUND', 'account not found', unchanged)
    await ports.assertCanAccessAccount(caller, account, 'backup.files.' + (op ?? 'list'))
    if (account.status !== 'active') return fail('PRECONDITION_FAILED', 'file restore requires an active account', unchanged)
    return { caller, account }
  }
  const first = await authorize()
  if (!first.account) {
    const accounts = (await ports.visibleAccounts(first.caller)).filter(account => account.status === 'active').map(account => ({ username: account.username, primaryDomain: account.primaryDomain }))
    return json({ accounts: accounts.sort((a, b) => a.username.localeCompare(b.username)).slice(0, 10_000) })
  }
  const request = op ? parseBackupFileRequest(op, first.account.username, await readBody(req)) : null
  if (!ports.callAgent) return fail('PRECONDITION_FAILED', 'privileged host agent is not connected', unchanged)
  let caller = first.caller
  if (request?.op === 'restore') {
    // Fresh authority immediately before the mutation; the agent re-checks again inside its account lease.
    const fresh = await authorize()
    if (!fresh.account || fresh.account.id !== first.account.id || fresh.account.uid !== first.account.uid || fresh.account.home !== first.account.home || fresh.caller.principal.id !== first.caller.principal.id) return fail('CONFLICT', 'the account or administrator changed before the restore', unchanged)
    caller = fresh.caller
  }
  const { op: _op, ...body } = request ?? { op: 'list' }
  const response = await ports.callAgent('/accounts/' + first.account.username + '/backup-files' + (op ? '/' + op : ''), { caller, ...(op ? { method: 'POST', body } : {}) })
  if (response.status !== 200) return response
  const value = await readReply(response)
  if (!verified(op ?? 'list', value, first.account, request)) return request?.op === 'restore'
    ? fail('PRECONDITION_FAILED', 'the file restore outcome requires review; inspect the account home', { stateChanged: true, verificationRequired: true })
    : fail('PRECONDITION_FAILED', 'the host backup response could not be verified', unchanged)
  return json(value)
}
