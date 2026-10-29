import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { assertAcl, fail, isXpanelError } from '@xpanel/core'
import type { Account, FeatureList, Plan, Reseller } from '@xpanel/core'
import { walkTar } from '@xpanel/lifecycle'
import { listAccountBackups, MAX_BACKUP_BYTES, openAccountBackupArchive } from './account-backup.ts'
import type { BackupAccountTarget } from './account-backup.ts'
import { inspectAccountBackupArchive, MAX_ACCOUNT_BACKUP_ENTRIES } from './account-backup-workspace.ts'
import type { AccountArchiveInventory } from './account-backup-workspace.ts'
import { MAX_BINARY_BYTES, MAX_DIR_MODE, MAX_FILE_MODE } from './file-manager.ts'
import type { JailedFileManager } from './file-manager.ts'
import type { AgentCallerIdentity } from './server.ts'
import { archiveCreatedAt, MAX_LISTED_ARCHIVES, MAX_RESTORE_FILES, MAX_RESTORE_PATH_BYTES, MAX_RESTORE_SELECTION, parseBackupFileRequest, restoreFolderName } from './backup-file-restore-request.ts'
import type { BackupFileRequest, RestoreDestination, RestoreRefusal, RestoreResult } from './backup-file-restore-request.ts'

export { parseBackupFileRequest } from './backup-file-restore-request.ts'

/** The API reaches the agent over a socket with a 30 s idle timeout; no new file starts after this budget. */
export const RESTORE_TIME_BUDGET_MS = 20_000
const MAX_DESTINATION_CHECKS = 100
const ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/backup-files(?:\/(browse|preview|restore))?$/
const unchanged = { stateChanged: false }

export interface RestorePlanRow { path: string; destination: string; bytes: number; mode: number; sha256: string; action: 'restore' | 'refuse'; reason: RestoreRefusal | null }
export interface RestoreFileResult { path: string; destination: string; bytes: number; result: RestoreResult; reason: string | null; verificationRequired: boolean }
export type BackupRestoreFiles = Pick<JailedFileManager, 'list' | 'mkdir' | 'putBytes' | 'getBytes'>

const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const mailPath = (path: string): boolean => ['mail', 'etc'].some(name => path === name || path.startsWith(name + '/'))

/** Expands folders to their archived files; refused rows are kept so the review shows every selected file. */
export function planBackupFileRestore(inventory: AccountArchiveInventory, paths: readonly string[], destination: RestoreDestination): RestorePlanRow[] {
  const byPath = new Map(inventory.files.map(file => [file.path, file])), chosen = new Map<string, AccountArchiveInventory['files'][number]>()
  for (const path of paths) {
    const exact = byPath.get(path), under = exact ? [exact] : inventory.files.filter(file => file.path.startsWith(path + '/'))
    if (!under.length) return fail('VALIDATION', 'a selected path is not in the backup archive', { ...unchanged, path })
    for (const file of under) chosen.set(file.path, file)
    if (chosen.size > MAX_RESTORE_FILES) return fail('LIMIT_EXCEEDED', `one restore is limited to ${MAX_RESTORE_FILES} files; select fewer folders`, unchanged)
  }
  const folder = restoreFolderName(inventory.file)
  return [...chosen.values()].sort((a, b) => a.path.localeCompare(b.path)).map(file => {
    const target = destination === 'new-folder' ? folder + '/' + file.path : file.path
    const reason: RestoreRefusal | null = file.bytes > MAX_BINARY_BYTES ? 'too-large' : Buffer.byteLength(target, 'utf8') > MAX_RESTORE_PATH_BYTES ? 'path-too-long'
      : destination === 'in-place' && mailPath(file.path) ? 'mail-preserved' : destination === 'in-place' && (file.path === '.trash' || file.path.startsWith('.trash/')) ? 'reserved' : null
    // The confined writer accepts regular files up to 0640; group/other execute and write bits are never restored.
    return { path: file.path, destination: target, bytes: file.bytes, mode: (file.mode & MAX_FILE_MODE) || 0o600, sha256: file.sha256, action: reason ? 'refuse' : 'restore', reason }
  })
}

const revisionOf = (account: Account, inventory: AccountArchiveInventory, destination: RestoreDestination, rows: readonly RestorePlanRow[]): string =>
  sha(JSON.stringify({ accountId: account.id, username: account.username, uid: account.uid, file: inventory.file, bytes: inventory.bytes, archiveSha256: inventory.sha256, destination,
    rows: rows.map(row => [row.path, row.destination, row.bytes, row.mode, row.sha256, row.action, row.reason]) }))

const quotaOf = (plan: Plan, plannedBytes: number) => ({ limitMb: plan.resources.diskMb, plannedBytes, fits: plan.resources.diskMb === 'unlimited' || plannedBytes <= plan.resources.diskMb * 1024 * 1024 })

/** Bounded confined listing; a missing ancestor answers for its whole subtree, anything unread stays unchecked. */
export async function observeDestinations(files: BackupRestoreFiles, rows: readonly RestorePlanRow[], expired: () => boolean): Promise<Map<string, 'yes' | 'no' | 'unchecked'>> {
  const listed = new Map<string, Set<string> | null | undefined>()
  let checks = 0
  const names = async (directory: string): Promise<Set<string> | null | undefined> => {
    if (listed.has(directory)) return listed.get(directory)
    if (directory) {
      const cut = directory.lastIndexOf('/'), parent = await names(cut < 0 ? '' : directory.slice(0, cut))
      if (parent === undefined) return undefined
      if (parent === null || !parent.has(directory.slice(cut + 1))) { listed.set(directory, null); return null }
    }
    if (checks >= MAX_DESTINATION_CHECKS || expired()) return undefined
    checks++
    let value: Set<string> | null | undefined
    try { value = new Set((await files.list(directory, { showHidden: true })).map(entry => entry.name)) }
    catch (error) { value = isXpanelError(error) && error.code === 'NOT_FOUND' ? null : undefined }
    listed.set(directory, value)
    return value
  }
  const result = new Map<string, 'yes' | 'no' | 'unchecked'>()
  for (const row of rows) {
    if (row.action !== 'restore') { result.set(row.path, 'unchecked'); continue }
    const cut = row.destination.lastIndexOf('/'), parent = await names(cut < 0 ? '' : row.destination.slice(0, cut))
    result.set(row.path, parent === undefined ? 'unchecked' : parent !== null && parent.has(row.destination.slice(cut + 1)) ? 'yes' : 'no')
  }
  return result
}

async function* archiveBytes(handle: FileHandle, size: number): AsyncGenerator<Buffer> {
  const buffer = Buffer.alloc(64 * 1024)
  for (let offset = 0; offset < size;) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
    if (bytesRead <= 0) fail('CONFLICT', 'the backup archive was truncated during restore', unchanged)
    offset += bytesRead
    yield Buffer.from(buffer.subarray(0, bytesRead))
  }
}

const collect = async (body: AsyncIterable<Buffer>, cap: number): Promise<Buffer | null> => {
  const parts: Buffer[] = []
  let size = 0
  for await (const chunk of body) { size += chunk.length; if (size > cap) return null; parts.push(chunk) }
  return Buffer.concat(parts)
}

/** Confined runner refusals that prove nothing was written; anything else leaves the file outcome unproven. */
const writerRefusal = (error: unknown): string | null => {
  if (!isXpanelError(error)) return null
  if (error.code === 'LIMIT_EXCEEDED') return 'quota'
  if (error.code === 'NOT_FOUND') return 'parent-not-directory'
  if (error.code === 'FORBIDDEN') return 'refused-by-writer'
  if (error.code === 'CONFLICT') return 'busy'
  if (error.code === 'VALIDATION' || error.code === 'PRECONDITION_FAILED') return 'refused-by-writer'
  return null
}

export interface RestoreRun { results: RestoreFileResult[]; createdDirectories: number; complete: boolean }
export async function writePlannedFiles(input: { root: string; target: BackupAccountTarget; inventory: AccountArchiveInventory; rows: readonly RestorePlanRow[]; files: BackupRestoreFiles; expired: () => boolean; authorize: () => Promise<unknown> }): Promise<RestoreRun> {
  const results = new Map<string, RestoreFileResult>(), pending = new Map<string, RestorePlanRow>()
  const record = (row: RestorePlanRow, result: RestoreResult, reason: string | null, verificationRequired = false): void => { results.set(row.path, { path: row.path, destination: row.destination, bytes: row.bytes, result, reason, verificationRequired }) }
  for (const row of input.rows) { if (row.action === 'restore') pending.set(row.path, row); else record(row, 'failed', row.reason) }
  const ensured = new Set<string>()
  let createdDirectories = 0, stopped = false, attempted = false, archiveFailure: string | null = null
  const stop = Symbol('stop')
  const writeOne = async (row: RestorePlanRow, bytes: Buffer | null): Promise<void> => {
    if (!bytes || bytes.length !== row.bytes || sha(bytes) !== row.sha256) return record(row, 'failed', 'archive-changed')
    // Fresh authority immediately before each host change; the lease pins the account itself.
    await input.authorize()
    attempted = true
    const parts = row.destination.split('/')
    for (let index = 1; index < parts.length; index++) {
      const directory = parts.slice(0, index).join('/')
      if (ensured.has(directory)) continue
      try { await input.files.mkdir(directory, MAX_DIR_MODE); createdDirectories++ }
      // mkdirat(2) EEXIST: something is already there; the file write below proves whether it is a usable directory.
      catch (error) { if (!isXpanelError(error) || error.code !== 'CONFLICT') { const reason = writerRefusal(error); return record(row, 'failed', reason ?? 'directory-unknown', reason === null) } }
      ensured.add(directory)
    }
    try { await input.files.putBytes(row.destination, bytes.toString('base64'), { overwrite: false, mode: row.mode }) }
    catch (error) {
      // The helper publishes with RENAME_NOREPLACE: EEXIST/EISDIR mean the existing entry was left untouched.
      if (isXpanelError(error) && error.code === 'CONFLICT' && ['EEXIST', 'EISDIR'].includes(String(error.detail?.errnoName))) return record(row, 'skipped-exists', null)
      const reason = writerRefusal(error)
      return record(row, 'failed', reason ?? 'write-unknown', reason === null)
    }
    try {
      const back = await input.files.getBytes(row.destination)
      if (back.sizeBytes !== row.bytes || sha(Buffer.from(back.contentBase64, 'base64')) !== row.sha256) return record(row, 'failed', 'readback-mismatch', true)
    } catch { return record(row, 'failed', 'readback-unavailable', true) }
    record(row, 'restored', null)
  }
  if (pending.size) {
    const opened = await openAccountBackupArchive(input.root, input.target, input.inventory.file)
    try {
      if (opened.bytes !== input.inventory.bytes) fail('CONFLICT', 'the backup archive changed after review', unchanged)
      await walkTar(archiveBytes(opened.handle, opened.bytes), async (entry, body) => {
        const row = entry.type === 'file' ? pending.get(entry.path) : undefined
        if (!row) return
        if (input.expired()) { stopped = true; throw stop }
        await writeOne(row, await collect(body, row.bytes))
        pending.delete(row.path)
        if (!pending.size) throw stop
      }, { maxEntries: MAX_ACCOUNT_BACKUP_ENTRIES, maxTotalBytes: MAX_BACKUP_BYTES, linkScope: () => null,
        onSkip: () => fail('VALIDATION', 'the backup archive contains an unsupported or unsafe entry') })
    } catch (error) {
      if (error !== stop) {
        // Before any host change the request simply fails; afterwards the verified per-file results are still reported.
        if (!attempted) throw error
        archiveFailure = isXpanelError(error) && error.code === 'FORBIDDEN' ? 'authorization-changed' : 'archive-read'
      }
    } finally { await opened.handle.close() }
  }
  for (const row of pending.values()) record(row, stopped ? 'not-attempted' : 'failed', stopped ? 'time-budget' : archiveFailure ?? 'archive-changed')
  return { results: input.rows.map(row => results.get(row.path)!), createdDirectories, complete: !stopped && archiveFailure === null }
}

export interface BackupFileRestoreRouteDeps {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; withAccountLifecycleLease<T>(accountId: string, operation: (account: Account) => Promise<T>): Promise<T>
    getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>; getReseller(id: string): Promise<Reseller | null> }
  /** Direct local principal read; no API self-RPC inside the lease. */
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; disabled: boolean } | null>
  /** Confined account writer, or null when the native file runner is not installed. */
  files(account: Account, plan: Plan): BackupRestoreFiles | null
  audit(entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed'; principalId: string }): Promise<unknown>
  /** Server backup store (the /api/backups/accounts archives), or null when host storage is unavailable. */
  root: string | null
  now?: () => number
}

const json = (value: unknown): Response => {
  const source = JSON.stringify(value)
  if (Buffer.byteLength(source) > 8 * 1024 * 1024) return fail('LIMIT_EXCEEDED', 'the bounded file restore response is too large', unchanged)
  return new Response(source, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
const readBody = async (req: Request): Promise<unknown> => {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) return fail('VALIDATION', 'a JSON file restore request is required', unchanged)
  const text = await req.text()
  if (Buffer.byteLength(text) > 1024 * 1024) return fail('LIMIT_EXCEEDED', 'the file restore request is too large', unchanged)
  try { return JSON.parse(text) } catch { return fail('VALIDATION', 'the file restore request must be valid JSON', unchanged) }
}
const rejectedReason = (code: string): 'unsafe' | 'changed' | 'size' | 'file' => code === 'VALIDATION' ? 'unsafe' : code === 'CONFLICT' ? 'changed' : code === 'LIMIT_EXCEEDED' ? 'size' : 'file'

/** Fresh restore authority: the same active principal, the selected active account, its plan and, for a reseller, ownership, ACL and the file-restore feature. */
export async function authorizeBackupRestore(deps: Pick<BackupFileRestoreRouteDeps, 'caller' | 'store' | 'currentPrincipal'>, username: string, account: Account, acl: 'list-accounts' | 'edit-account'): Promise<Plan> {
  const caller = deps.caller, principal = await deps.currentPrincipal()
  if (caller.role !== 'root' && caller.role !== 'reseller') return fail('FORBIDDEN', 'file restore requires root or a reseller', unchanged)
  if (!principal || principal.disabled || principal.id !== caller.principalId || principal.kind !== caller.role) return fail('FORBIDDEN', 'the current administrator is no longer authorized', unchanged)
  if (account.username !== username || account.status !== 'active') return fail('FORBIDDEN', 'file restore requires the active selected account', unchanged)
  const plan = await deps.store.getPlan(account.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
  if (!plan || !features) return fail('PRECONDITION_FAILED', 'the account plan is unavailable', unchanged)
  if (principal.kind === 'reseller') {
    if (account.ownerId !== principal.id) return fail('FORBIDDEN', 'the account is not owned by this reseller', unchanged)
    assertAcl({ kind: 'reseller', id: principal.id, username: principal.username }, await deps.store.getReseller(principal.id), acl)
    if (features.disabled.includes('file-restore')) return fail('FORBIDDEN', 'file restore is disabled by the account plan', unchanged)
  }
  return plan
}

/** Root, or a reseller for its own active accounts (list-accounts to read, edit-account to restore). */
export async function handleBackupFileRestoreRoute(req: Request, url: URL, method: string, deps: BackupFileRestoreRouteDeps): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const username = match[1]!, op = match[2] as BackupFileRequest['op'] | undefined
  if (method !== (op ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: op ? 'POST' : 'GET' } })
  if (url.search) return fail('VALIDATION', 'file restore requests do not accept query selectors', unchanged)
  const caller = deps.caller
  if (caller.role !== 'root' && caller.role !== 'reseller') return fail('FORBIDDEN', 'file restore requires root or a reseller', unchanged)
  const request = op ? parseBackupFileRequest(op, username, await readBody(req)) : null
  const root = deps.root
  if (root === null) return fail('PRECONDITION_FAILED', 'host backup storage is unavailable on this server', unchanged)
  const now = deps.now ?? Date.now, deadline = now() + RESTORE_TIME_BUDGET_MS, expired = (): boolean => now() > deadline
  const authorize = (account: Account, acl: 'list-accounts' | 'edit-account'): Promise<Plan> => authorizeBackupRestore(deps, username, account, acl)
  const targetOf = (account: Account): BackupAccountTarget => ({ username: account.username, home: account.home, uid: account.uid, status: account.status })
  const contextOf = (account: Account) => ({ accountId: account.id, username: account.username })
  const archived = async (account: Account, file: string): Promise<void> => {
    if (!(await listAccountBackups(root, targetOf(account))).some(item => item.file === file)) fail('NOT_FOUND', 'the backup archive is not in the server backup store', unchanged)
  }
  const reviewed = async (account: Account, plan: Plan, input: Extract<BackupFileRequest, { paths: string[] }>) => {
    await archived(account, input.file)
    const inventory = await inspectAccountBackupArchive({ root, account: targetOf(account), file: input.file })
    const rows = planBackupFileRestore(inventory, input.paths, input.destination)
    const plannedBytes = rows.filter(row => row.action === 'restore').reduce((sum, row) => sum + row.bytes, 0)
    return { inventory, rows, revision: revisionOf(account, inventory, input.destination, rows), quota: quotaOf(plan, plannedBytes) }
  }
  const archiveView = (inventory: AccountArchiveInventory) => ({ file: inventory.file, bytes: inventory.bytes, sha256: inventory.sha256, createdAt: archiveCreatedAt(inventory.file), integrity: 'verified' as const })
  const initial = await deps.store.getAccountByUsername(username)
  if (!initial || initial.username !== username) return fail('NOT_FOUND', 'account not found', unchanged)

  if (request?.op !== 'restore') {
    const plan = await authorize(initial, 'list-accounts')
    let body: Record<string, unknown>
    if (!request) {
      const archives = (await listAccountBackups(root, targetOf(initial))).reverse()
      const listed = []
      for (const archive of archives.slice(0, MAX_LISTED_ARCHIVES)) {
        const createdAt = archiveCreatedAt(archive.file)
        try {
          const opened = await openAccountBackupArchive(root, targetOf(initial), archive.file)
          try {
            const signature = Buffer.alloc(2), read = await opened.handle.read(signature, 0, 2, 0)
            const gzip = read.bytesRead === 2 && signature[0] === 0x1f && signature[1] === 0x8b
            listed.push({ file: archive.file, bytes: opened.bytes, createdAt, integrity: gzip ? 'unverified' : 'rejected', reason: gzip ? null : 'format' })
          } finally { await opened.handle.close() }
        } catch (error) {
          if (!isXpanelError(error)) throw error
          listed.push({ file: archive.file, bytes: archive.bytes, createdAt, integrity: 'rejected', reason: rejectedReason(error.code) })
        }
      }
      body = { context: contextOf(initial), archives: listed, total: archives.length, truncated: archives.length > MAX_LISTED_ARCHIVES }
    } else if (request.op === 'browse') {
      await archived(initial, request.file)
      try {
        const inventory = await inspectAccountBackupArchive({ root, account: targetOf(initial), file: request.file })
        body = { context: contextOf(initial), archive: archiveView(inventory), folder: restoreFolderName(request.file), entries: inventory.files.map(file => ({ path: file.path, bytes: file.bytes, mode: file.mode })) }
      } catch (error) {
        if (!isXpanelError(error) || !['VALIDATION', 'CONFLICT', 'LIMIT_EXCEEDED', 'PRECONDITION_FAILED'].includes(error.code)) throw error
        body = { context: contextOf(initial), archive: { file: request.file, integrity: 'rejected', reason: rejectedReason(error.code) }, folder: restoreFolderName(request.file), entries: [] }
      }
    } else {
      const review = await reviewed(initial, plan, request), files = deps.files(initial, plan)
      const exists = files ? await observeDestinations(files, review.rows, expired) : new Map<string, 'unchecked'>()
      const rows = review.rows.map(row => ({ path: row.path, destination: row.destination, bytes: row.bytes, action: row.action, reason: row.reason, exists: exists.get(row.path) ?? 'unchecked' }))
      const count = (test: (row: typeof rows[number]) => boolean): number => rows.filter(test).length
      body = { context: contextOf(initial), archive: archiveView(review.inventory), destination: { mode: request.destination, folder: request.destination === 'new-folder' ? restoreFolderName(request.file) : null },
        rows, counts: { restore: count(row => row.action === 'restore' && row.exists !== 'yes'), present: count(row => row.action === 'restore' && row.exists === 'yes'), refused: count(row => row.action === 'refuse') },
        quota: review.quota, writer: files ? 'available' : 'unavailable', limits: { maxSelection: MAX_RESTORE_SELECTION, maxFiles: MAX_RESTORE_FILES, maxFileBytes: MAX_BINARY_BYTES, timeBudgetMs: RESTORE_TIME_BUDGET_MS }, revision: review.revision }
    }
    // Authority may be revoked during a long archive read: re-check it before anything is returned.
    const after = await deps.store.getAccountByUsername(username)
    if (!after || after.id !== initial.id || after.uid !== initial.uid || after.home !== initial.home) return fail('CONFLICT', 'the account changed while its backup was read', unchanged)
    await authorize(after, 'list-accounts')
    return json(body)
  }

  return deps.store.withAccountLifecycleLease(initial.id, async fresh => {
    if (fresh.username !== username || fresh.uid !== initial.uid || fresh.home !== initial.home) return fail('CONFLICT', 'the account changed before the restore', unchanged)
    const plan = await authorize(fresh, 'edit-account'), review = await reviewed(fresh, plan, request)
    if (review.revision !== request.expectedRevision) return fail('CONFLICT', 'the backup archive or selection changed; review it again', unchanged)
    if (!review.quota.fits) return fail('LIMIT_EXCEEDED', 'the selected files exceed the account plan disk quota', { ...unchanged, quota: review.quota })
    if (!review.rows.some(row => row.action === 'restore')) return fail('PRECONDITION_FAILED', 'no selected file can be restored', unchanged)
    const files = deps.files(fresh, plan)
    if (!files) return fail('PRECONDITION_FAILED', 'the confined account file writer is not installed', unchanged)
    const run = await writePlannedFiles({ root, target: targetOf(fresh), inventory: review.inventory, rows: review.rows, files, expired, authorize: () => authorize(fresh, 'edit-account') })
    const counts: Record<RestoreResult, number> = { restored: 0, 'skipped-exists': 0, failed: 0, 'not-attempted': 0 }
    for (const row of run.results) counts[row.result]++
    const verificationRequired = run.results.some(row => row.verificationRequired)
    try { await deps.audit({ actor: caller.actor, action: 'backup.files_restored', target: 'account:' + fresh.username, detail: { file: request.file, destination: request.destination, revision: review.revision, counts, createdDirectories: run.createdDirectories, verificationRequired }, outcome: counts.failed || verificationRequired ? 'failed' : 'ok', principalId: caller.principalId }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the file restore and its audit require inspection', { stateChanged: counts.restored > 0 || run.createdDirectories > 0, verificationRequired: true, counts }) }
    return json({ context: contextOf(fresh), archive: archiveView(review.inventory), destination: { mode: request.destination, folder: request.destination === 'new-folder' ? restoreFolderName(request.file) : null },
      results: run.results, counts, createdDirectories: run.createdDirectories, complete: run.complete, verificationRequired, revision: review.revision })
  })
}
