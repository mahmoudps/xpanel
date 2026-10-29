import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { Account, Plan, ServiceUser } from '@xpanel/core'
import { listAccountBackups } from './account-backup.ts'
import type { BackupAccountTarget } from './account-backup.ts'
import { inspectAccountBackupArchive } from './account-backup-workspace.ts'
import type { AccountArchiveInventory } from './account-backup-workspace.ts'
import { authorizeBackupRestore, observeDestinations, RESTORE_TIME_BUDGET_MS, writePlannedFiles } from './backup-file-restore.ts'
import type { BackupFileRestoreRouteDeps, RestorePlanRow } from './backup-file-restore.ts'
import { archiveCreatedAt, MAX_RESTORE_FILES } from './backup-file-restore-request.ts'
import type { RestoreResult } from './backup-file-restore-request.ts'
import { MAX_BINARY_BYTES, MAX_FILE_MODE } from './file-manager.ts'
import { archivedMessageMailbox, MAX_LISTED_MAILBOXES, parseComponentRestoreRequest } from './acct-restore-request.ts'
import type { ComponentRestoreRequest } from './acct-restore-request.ts'

const ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/backup-components\/(inventory|preview|restore)$/
const unchanged = { stateChanged: false }
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')

export interface ArchivedMailbox { address: string; messages: number; bytes: number; current: 'exists' | 'missing' }
export interface ComponentInventory {
  files: { state: 'available'; files: number; bytes: number }
  mail: { state: 'available' | 'unavailable'; mailboxes: ArchivedMailbox[]; truncated: boolean }
  /** Account mail settings are rendered from saved configuration; restoring archived copies would be overwritten. */
  mailSettings: { state: 'not-restorable'; files: number }
  databases: { state: 'not-in-archive' }
  dns: { state: 'not-in-archive' }
}

const mailboxesOf = (users: readonly ServiceUser[]): Set<string> => new Set(users.filter(user => user.services.email).map(user => user.login.toLowerCase()))

/** What one verified home archive holds, per restorable component. Server account archives contain the home only. */
export function componentInventory(inventory: AccountArchiveInventory, users: readonly ServiceUser[], writer: boolean): ComponentInventory {
  const current = mailboxesOf(users), boxes = new Map<string, ArchivedMailbox>()
  let files = 0, bytes = 0, settings = 0
  for (const file of inventory.files) {
    const address = archivedMessageMailbox(file.path)
    if (address) {
      const box = boxes.get(address) ?? { address, messages: 0, bytes: 0, current: current.has(address) ? 'exists' as const : 'missing' as const }
      box.messages++; box.bytes += file.bytes; boxes.set(address, box)
    } else if (file.path === 'etc' || file.path.startsWith('etc/')) settings++
    else if (!file.path.startsWith('mail/')) { files++; bytes += file.bytes }
  }
  const mailboxes = [...boxes.values()].sort((a, b) => a.address.localeCompare(b.address))
  return { files: { state: 'available', files, bytes }, mail: { state: writer ? 'available' : 'unavailable', mailboxes: mailboxes.slice(0, MAX_LISTED_MAILBOXES), truncated: mailboxes.length > MAX_LISTED_MAILBOXES },
    mailSettings: { state: 'not-restorable', files: settings }, databases: { state: 'not-in-archive' }, dns: { state: 'not-in-archive' } }
}

/** In-place rows for every archived message of the selected mailboxes; each must exist now, so mail never lands without a login. */
export function planMailboxRestore(inventory: AccountArchiveInventory, mailboxes: readonly string[], users: readonly ServiceUser[]): RestorePlanRow[] {
  const current = mailboxesOf(users), selected = new Set(mailboxes)
  const missing = mailboxes.filter(address => !current.has(address))
  if (missing.length) return fail('PRECONDITION_FAILED', 'a selected mailbox does not exist now; create it again before restoring its mail', { ...unchanged, missing })
  const rows = inventory.files.filter(file => { const address = archivedMessageMailbox(file.path); return address !== null && selected.has(address) })
    .map((file): RestorePlanRow => ({ path: file.path, destination: file.path, bytes: file.bytes, mode: (file.mode & MAX_FILE_MODE) || 0o600, sha256: file.sha256,
      action: file.bytes > MAX_BINARY_BYTES ? 'refuse' : 'restore', reason: file.bytes > MAX_BINARY_BYTES ? 'too-large' : null }))
  const found = new Set(rows.map(row => archivedMessageMailbox(row.path)))
  if (mailboxes.some(address => !found.has(address))) return fail('VALIDATION', 'a selected mailbox has no messages in this backup', unchanged)
  return rows
}

export interface ComponentRestoreRouteDeps extends Omit<BackupFileRestoreRouteDeps, 'store'> {
  store: BackupFileRestoreRouteDeps['store'] & { listServiceUsers(accountId: string): Promise<ServiceUser[]> }
}

const json = (value: unknown): Response => {
  const source = JSON.stringify(value)
  if (Buffer.byteLength(source) > 8 * 1024 * 1024) return fail('LIMIT_EXCEEDED', 'the bounded component restore response is too large', unchanged)
  return new Response(source, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
const readBody = async (req: Request): Promise<unknown> => {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) return fail('VALIDATION', 'a JSON component restore request is required', unchanged)
  const text = await req.text()
  if (Buffer.byteLength(text) > 64 * 1024) return fail('LIMIT_EXCEEDED', 'the component restore request is too large', unchanged)
  try { return JSON.parse(text) } catch { return fail('VALIDATION', 'the component restore request must be valid JSON', unchanged) }
}

/** /accounts/<username>/backup-components/(inventory|preview|restore): root, or a reseller for its own active accounts. */
export async function handleComponentRestoreRoute(req: Request, url: URL, method: string, deps: ComponentRestoreRouteDeps): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'component restore requests do not accept query selectors', unchanged)
  const username = match[1]!, caller = deps.caller
  if (caller.role !== 'root' && caller.role !== 'reseller') return fail('FORBIDDEN', 'component restore requires root or a reseller', unchanged)
  const request = parseComponentRestoreRequest(match[2] as ComponentRestoreRequest['op'], username, await readBody(req))
  const root = deps.root
  if (root === null) return fail('PRECONDITION_FAILED', 'host backup storage is unavailable on this server', unchanged)
  const now = deps.now ?? Date.now, deadline = now() + RESTORE_TIME_BUDGET_MS, expired = (): boolean => now() > deadline
  const targetOf = (account: Account): BackupAccountTarget => ({ username: account.username, home: account.home, uid: account.uid, status: account.status })
  const authorize = (account: Account, acl: 'list-accounts' | 'edit-account'): Promise<Plan> => authorizeBackupRestore(deps, username, account, acl)
  const inspect = async (account: Account): Promise<AccountArchiveInventory> => {
    if (!(await listAccountBackups(root, targetOf(account))).some(item => item.file === request.file)) fail('NOT_FOUND', 'the backup archive is not in the server backup store', unchanged)
    return inspectAccountBackupArchive({ root, account: targetOf(account), file: request.file })
  }
  const archiveView = (inventory: AccountArchiveInventory) => ({ file: inventory.file, bytes: inventory.bytes, sha256: inventory.sha256, createdAt: archiveCreatedAt(inventory.file), integrity: 'verified' as const })
  const context = (account: Account) => ({ accountId: account.id, username: account.username })
  /** One bounded batch: messages already present are left out, at most 500 files are planned per run. */
  const review = async (account: Account, plan: Plan, mailboxes: string[]) => {
    const inventory = await inspect(account), users = await deps.store.listServiceUsers(account.id)
    const all = planMailboxRestore(inventory, mailboxes, users), files = deps.files(account, plan)
    const exists = files ? await observeDestinations(files, all, expired) : new Map<string, 'unchecked'>()
    const open = all.filter(row => row.action === 'restore' && exists.get(row.path) !== 'yes'), rows = open.slice(0, MAX_RESTORE_FILES)
    const plannedBytes = rows.reduce((sum, row) => sum + row.bytes, 0)
    const quota = { limitMb: plan.resources.diskMb, plannedBytes, fits: plan.resources.diskMb === 'unlimited' || plannedBytes <= plan.resources.diskMb * 1024 * 1024 }
    const counts = { messages: all.length, present: all.filter(row => exists.get(row.path) === 'yes').length, batch: rows.length, remaining: open.length - rows.length, refused: all.filter(row => row.action === 'refuse').length }
    const revision = sha(JSON.stringify({ accountId: account.id, username: account.username, uid: account.uid, file: inventory.file, bytes: inventory.bytes, archiveSha256: inventory.sha256, mailboxes: [...mailboxes].sort(),
      rows: rows.map(row => [row.path, row.bytes, row.mode, row.sha256]) }))
    return { inventory, rows, counts, quota, writer: files ? 'available' as const : 'unavailable' as const, revision }
  }
  const initial = await deps.store.getAccountByUsername(username)
  if (!initial || initial.username !== username) return fail('NOT_FOUND', 'account not found', unchanged)

  if (request.op !== 'restore') {
    const plan = await authorize(initial, 'list-accounts')
    let body: Record<string, unknown>
    if (request.op === 'inventory') {
      const inventory = await inspect(initial)
      body = { context: context(initial), archive: archiveView(inventory), components: componentInventory(inventory, await deps.store.listServiceUsers(initial.id), deps.files(initial, plan) !== null) }
    } else {
      const reviewed = await review(initial, plan, request.mailboxes)
      body = { context: context(initial), archive: archiveView(reviewed.inventory), mailboxes: request.mailboxes, rows: reviewed.rows.map(row => ({ path: row.path, bytes: row.bytes })), counts: reviewed.counts,
        quota: reviewed.quota, writer: reviewed.writer, limits: { maxFiles: MAX_RESTORE_FILES, maxFileBytes: MAX_BINARY_BYTES, timeBudgetMs: RESTORE_TIME_BUDGET_MS }, revision: reviewed.revision }
    }
    // Authority may be revoked during a long archive read: re-check it before anything is returned.
    const after = await deps.store.getAccountByUsername(username)
    if (!after || after.id !== initial.id || after.uid !== initial.uid || after.home !== initial.home) return fail('CONFLICT', 'the account changed while its backup was read', unchanged)
    await authorize(after, 'list-accounts')
    return json(body)
  }

  return deps.store.withAccountLifecycleLease(initial.id, async fresh => {
    if (fresh.username !== username || fresh.uid !== initial.uid || fresh.home !== initial.home) return fail('CONFLICT', 'the account changed before the restore', unchanged)
    const plan = await authorize(fresh, 'edit-account'), reviewed = await review(fresh, plan, request.mailboxes)
    if (reviewed.revision !== request.expectedRevision) return fail('CONFLICT', 'the backup archive, mailboxes or messages changed; review the restore again', unchanged)
    if (!reviewed.quota.fits) return fail('LIMIT_EXCEEDED', 'the selected messages exceed the account plan disk quota', { ...unchanged, quota: reviewed.quota })
    if (!reviewed.rows.length) return fail('PRECONDITION_FAILED', 'every selected message is already present or cannot be restored here', unchanged)
    const files = deps.files(fresh, plan)
    if (!files) return fail('PRECONDITION_FAILED', 'the confined account file writer is not installed', unchanged)
    const run = await writePlannedFiles({ root, target: targetOf(fresh), inventory: reviewed.inventory, rows: reviewed.rows, files, expired, authorize: () => authorize(fresh, 'edit-account') })
    const counts: Record<RestoreResult, number> = { restored: 0, 'skipped-exists': 0, failed: 0, 'not-attempted': 0 }
    for (const row of run.results) counts[row.result]++
    const verificationRequired = run.results.some(row => row.verificationRequired)
    try { await deps.audit({ actor: caller.actor, action: 'backup.mail_restored', target: 'account:' + fresh.username, detail: { file: request.file, mailboxes: request.mailboxes, revision: reviewed.revision, counts, createdDirectories: run.createdDirectories, verificationRequired }, outcome: counts.failed || verificationRequired ? 'failed' : 'ok', principalId: caller.principalId }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the mail restore and its audit require inspection', { stateChanged: counts.restored > 0 || run.createdDirectories > 0, verificationRequired: true, counts }) }
    return json({ context: context(fresh), archive: archiveView(reviewed.inventory), mailboxes: request.mailboxes, results: run.results.map(row => ({ path: row.path, bytes: row.bytes, result: row.result, reason: row.reason, verificationRequired: row.verificationRequired })),
      counts, createdDirectories: run.createdDirectories, complete: run.complete, remaining: reviewed.counts.remaining, verificationRequired, revision: reviewed.revision })
  })
}
