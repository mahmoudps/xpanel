import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { dirname, posix } from 'node:path'
import { fail, isUuid } from '@xpanel/core'
import { hashing, walkTar } from '@xpanel/lifecycle'
import type { AgentExecutor } from './executor.ts'
import { withPinnedHostTargetParent } from './host-target-parent.ts'
import { assertBackupFileName, createAccountBackup, DEFAULT_BACKUP_DIR, listAccountBackups, MAX_BACKUP_BYTES, openAccountBackupArchive, restoreAccountBackup } from './account-backup.ts'
import type { BackupAccountTarget, BackupArchive } from './account-backup.ts'

export const MAX_ACCOUNT_BACKUP_ENTRIES = 10000
export interface AccountBackupIdentity extends BackupAccountTarget { id: string; gid: number }
export interface AccountArchiveFile { path: string; bytes: number; sha256: string; mode: number }
export interface AccountArchiveInventory { file: string; bytes: number; sha256: string; files: AccountArchiveFile[] }
export interface AccountHomeEntry { path: string; type: 'file' | 'directory' | 'symlink' | 'other'; bytes: number; mode: number; uid: number; gid: number; links: number; mtimeMs: number; sha256: string | null }
export type AccountBackupDifference = 'add' | 'replace' | 'unchanged' | 'keep' | 'preserve-mail'
export interface AccountBackupDifferenceRow { path: string; state: AccountBackupDifference; archiveBytes: number | null; currentBytes: number | null }
export interface AccountBackupPreview {
  file: string; bytes: number; archiveSha256: string; revision: string; scope: 'home'; mailPreserved: true
  rows: AccountBackupDifferenceRow[]; counts: Record<AccountBackupDifference, number>
}
const mailPath = (path: string): boolean => ['mail', 'etc'].some(name => path === name || path.startsWith(name + '/'))
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const identity = (account: AccountBackupIdentity) => {
  if (!isUuid(account.id) || !Number.isSafeInteger(account.gid) || account.gid < 20000 || account.gid > 60000) fail('PRECONDITION_FAILED', 'backup account identity is not panel-managed')
  return { id: account.id, username: account.username, home: account.home, uid: account.uid, gid: account.gid, status: account.status }
}

/** Every member is inspected; skipped links, devices and unsupported names reject the archive. */
export async function inspectAccountBackupArchive(input: { root?: string; account: BackupAccountTarget; file: string }): Promise<AccountArchiveInventory> {
  const opened = await openAccountBackupArchive(input.root ?? DEFAULT_BACKUP_DIR, input.account, input.file)
  try {
    const signature = Buffer.alloc(2)
    if ((await opened.handle.read(signature, 0, 2, 0)).bytesRead !== 2 || signature[0] !== 0x1f || signature[1] !== 0x8b) fail('VALIDATION', 'the account archive must be gzip-compressed tar data')
    const before = await opened.handle.stat(), digest = createHash('sha256'), files: AccountArchiveFile[] = []
    const names = new Set<string>()
    let compressedBytes = 0
    async function* source() {
      const buffer = Buffer.alloc(64 * 1024)
      while (compressedBytes < opened.bytes) {
        const next = await opened.handle.read(buffer, 0, Math.min(buffer.length, opened.bytes - compressedBytes), compressedBytes)
        if (next.bytesRead <= 0) fail('CONFLICT', 'the archive was truncated during inspection', { stateChanged: false })
        const chunk = Buffer.from(buffer.subarray(0, next.bytesRead))
        compressedBytes += chunk.byteLength; digest.update(chunk); yield chunk
      }
    }
    await walkTar(source(), async (entry, body) => {
      if (entry.type === 'directory') return
      if (entry.type !== 'file') return fail('VALIDATION', 'account home restore does not accept archive links')
      if (names.has(entry.path)) return fail('VALIDATION', 'the account archive contains duplicate file paths')
      names.add(entry.path)
      const content = await hashing(body).finish()
      files.push({ path: entry.path, bytes: content.size, sha256: content.sha256, mode: entry.mode & 0o777 })
    }, { maxEntries: MAX_ACCOUNT_BACKUP_ENTRIES, maxTotalBytes: MAX_BACKUP_BYTES, linkScope: () => null,
      onSkip: () => fail('VALIDATION', 'the account archive contains an unsupported or unsafe entry') })
    if (compressedBytes !== opened.bytes) fail('VALIDATION', 'the complete compressed archive was not inspected')
    const after = await opened.handle.stat()
    if (after.size !== opened.bytes || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev) fail('CONFLICT', 'the archive changed while it was inspected', { stateChanged: false })
    return { file: input.file, bytes: opened.bytes, sha256: digest.digest('hex'), files: files.sort((a, b) => a.path.localeCompare(b.path)) }
  } finally { await opened.handle.close() }
}

const hashHomeFile = async (path: string, expected: { size: number; ino: number | bigint; dev: number | bigint; mtimeMs: number }): Promise<string> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_BACKUP_BYTES || info.ino !== expected.ino || info.dev !== expected.dev) fail('CONFLICT', 'a home file changed while the restore was reviewed', { stateChanged: false })
    const digest = createHash('sha256')
    let bytes = 0
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) { bytes += chunk.byteLength; if (bytes > expected.size || bytes > MAX_BACKUP_BYTES) fail('CONFLICT', 'a home file grew during inspection', { stateChanged: false }); digest.update(chunk) }
    const after = await handle.stat()
    if (after.size !== expected.size || after.mtimeMs !== expected.mtimeMs) fail('CONFLICT', 'a home file changed while the restore was reviewed', { stateChanged: false })
    return digest.digest('hex')
  } finally { await handle.close() }
}

/** Reads metadata for kept paths and hashes only files that the selected archive can replace. */
export async function readAccountBackupHome(account: AccountBackupIdentity, archivedPaths: ReadonlySet<string>): Promise<AccountHomeEntry[]> {
  identity(account)
  const result: AccountHomeEntry[] = []
  let inspectedBytes = 0
  await withPinnedHostTargetParent(posix.join(account.home, '.backup-inventory'), async pinned => {
    const walk = async (directory: string, prefix: string): Promise<void> => {
      for (const name of (await readdir(directory)).sort()) {
        if (!name || name.includes('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name)) fail('VALIDATION', 'the home contains an unsupported entry name')
        const path = prefix ? prefix + '/' + name : name
        if (mailPath(path) || !prefix && name.startsWith('.xpanel-backup-')) continue
        if (result.length >= MAX_ACCOUNT_BACKUP_ENTRIES) fail('LIMIT_EXCEEDED', 'the home contains too many entries for a bounded restore review')
        const absolute = posix.join(directory, name), metadata = await lstat(absolute)
        const type = metadata.isSymbolicLink() ? 'symlink' : metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'other'
        const entry: AccountHomeEntry = { path, type, bytes: metadata.size, mode: metadata.mode & 0o777, uid: metadata.uid, gid: metadata.gid, links: metadata.nlink, mtimeMs: metadata.mtimeMs, sha256: null }
        if (type === 'file' && archivedPaths.has(path)) {
          if (metadata.uid !== account.uid || metadata.nlink !== 1) fail('PRECONDITION_FAILED', 'a restore target is not an exclusively owned account file', { stateChanged: false })
          inspectedBytes += metadata.size
          if (!Number.isSafeInteger(inspectedBytes) || inspectedBytes > MAX_BACKUP_BYTES) fail('LIMIT_EXCEEDED', 'current restore targets exceed the 2 GiB bounded comparison limit', { stateChanged: false })
          entry.sha256 = await hashHomeFile(absolute, metadata)
        }
        result.push(entry)
        if (type === 'directory') {
          const child = await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          try { await walk(process.platform === 'linux' ? '/proc/self/fd/' + child.fd : absolute, path) }
          finally { await child.close() }
        }
      }
    }
    await walk(dirname(pinned), '')
  })
  return result.sort((a, b) => a.path.localeCompare(b.path))
}

export function accountBackupPreview(account: AccountBackupIdentity, archive: AccountArchiveInventory, current: readonly AccountHomeEntry[]): AccountBackupPreview {
  const target = identity(account), now = new Map(current.map(entry => [entry.path, entry])), files = new Map(archive.files.map(file => [file.path, file]))
  const rows: AccountBackupDifferenceRow[] = []
  const counts: Record<AccountBackupDifference, number> = { add: 0, replace: 0, unchanged: 0, keep: 0, 'preserve-mail': 0 }
  for (const path of [...new Set([...files.keys(), ...current.filter(entry => entry.type !== 'directory').map(entry => entry.path)])].sort()) {
    const stored = files.get(path), present = now.get(path)
    if (stored && !mailPath(path)) {
      const parts = path.split('/')
      for (let index = 1; index < parts.length; index++) {
        const parent = now.get(parts.slice(0, index).join('/'))
        if (parent && parent.type !== 'directory') fail('PRECONDITION_FAILED', 'a restore target parent is not a normal directory', { stateChanged: false })
      }
      if (present && (present.type !== 'file' || present.uid !== account.uid || present.links !== 1 || present.sha256 === null)) fail('PRECONDITION_FAILED', 'a restore target cannot be replaced safely', { stateChanged: false })
    }
    const state: AccountBackupDifference = mailPath(path) ? 'preserve-mail' : !stored ? 'keep' : !present ? 'add' : present.sha256 === stored.sha256 && present.mode === stored.mode ? 'unchanged' : 'replace'
    rows.push({ path, state, archiveBytes: stored?.bytes ?? null, currentBytes: present?.bytes ?? null }); counts[state]++
  }
  const revision = sha(JSON.stringify({ target, file: archive.file, bytes: archive.bytes, archiveSha256: archive.sha256, archived: archive.files, current: [...current].sort((a, b) => a.path.localeCompare(b.path)) }))
  return { file: archive.file, bytes: archive.bytes, archiveSha256: archive.sha256, revision, scope: 'home', mailPreserved: true, rows, counts }
}

export async function previewAccountBackup(input: { root?: string; account: AccountBackupIdentity; file: string;
  readCurrent?: (account: AccountBackupIdentity, paths: ReadonlySet<string>) => Promise<AccountHomeEntry[]> }): Promise<AccountBackupPreview> {
  const archive = await inspectAccountBackupArchive(input)
  const current = await (input.readCurrent ?? readAccountBackupHome)(input.account, new Set(archive.files.filter(file => !mailPath(file.path)).map(file => file.path)))
  return accountBackupPreview(input.account, archive, current)
}

/** Streams an existing file; it never buffers a 2 GiB archive or fabricates download bytes. */
export async function downloadAccountBackup(input: { root?: string; account: BackupAccountTarget; file: string }): Promise<Response> {
  const opened = await openAccountBackupArchive(input.root ?? DEFAULT_BACKUP_DIR, input.account, input.file)
  let offset = 0, closed = false
  const close = async () => { if (!closed) { closed = true; await opened.handle.close() } }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (offset === opened.bytes) { await close(); controller.close(); return }
        const bytes = Buffer.alloc(Math.min(65536, opened.bytes - offset))
        const read = await opened.handle.read(bytes, 0, bytes.length, offset)
        if (read.bytesRead <= 0) fail('PRECONDITION_FAILED', 'the archive was truncated during download')
        offset += read.bytesRead; controller.enqueue(bytes.subarray(0, read.bytesRead))
      } catch (error) { await close(); controller.error(error) }
    },
    async cancel() { await close() },
  })
  return new Response(body, { headers: { 'content-type': 'application/gzip', 'content-length': String(opened.bytes),
    'content-disposition': `attachment; filename="${input.file}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' } })
}

export async function restoreAccountBackupWithRecovery(input: { executor: AgentExecutor; root?: string; account: AccountBackupIdentity; file: string; expectedRevision: string; confirmation: string;
  readCurrent?: (account: AccountBackupIdentity, paths: ReadonlySet<string>) => Promise<AccountHomeEntry[]>;
  /** Trusted fixture/recovery port; never deserialized by the dispatcher. */
  createRecovery?: () => Promise<BackupArchive> }): Promise<{ file: string; recovery: BackupArchive; scope: 'home'; mailPreserved: true; contentReadback: 'matched' }> {
  if (input.confirmation !== input.account.username || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) fail('VALIDATION', 'the exact account confirmation and reviewed backup revision are required', { stateChanged: false })
  const reviewed = await previewAccountBackup(input)
  if (reviewed.revision !== input.expectedRevision) fail('CONFLICT', 'archive or home files changed after review', { stateChanged: false })
  if (reviewed.counts.add + reviewed.counts.replace === 0) fail('PRECONDITION_FAILED', 'the reviewed archive requires no home-file changes', { stateChanged: false })
  const recovery = input.createRecovery ? await input.createRecovery() : await createAccountBackup({ executor: input.executor, root: input.root, account: input.account, nonce: randomBytes(6).toString('hex'), excludeMail: true })
  if (recovery.file === input.file) fail('PRECONDITION_FAILED', 'a separate recovery archive is required', { stateChanged: false })
  const savedRecovery = await inspectAccountBackupArchive({ root: input.root, account: input.account, file: recovery.file })
  if (savedRecovery.bytes !== recovery.bytes) fail('PRECONDITION_FAILED', 'recovery archive size could not be verified', { stateChanged: false, recoveryFile: recovery.file })
  const exactArchive = await inspectAccountBackupArchive(input)
  const currentHome = await (input.readCurrent ?? readAccountBackupHome)(input.account, new Set(exactArchive.files.filter(entry => !mailPath(entry.path)).map(entry => entry.path)))
  const current = accountBackupPreview(input.account, exactArchive, currentHome)
  if (current.revision !== reviewed.revision) fail('CONFLICT', 'home files changed while the recovery archive was prepared', { stateChanged: false, recoveryFile: recovery.file })
  const recoveryFiles = new Map(savedRecovery.files.map(entry => [entry.path, entry])), currentFiles = new Map(currentHome.map(entry => [entry.path, entry]))
  for (const row of current.rows.filter(entry => entry.state === 'replace')) {
    const before = currentFiles.get(row.path), saved = recoveryFiles.get(row.path)
    if (!before || !saved || before.sha256 !== saved.sha256 || before.bytes !== saved.bytes || before.mode !== saved.mode) fail('PRECONDITION_FAILED', 'recovery bytes do not match a file that would be replaced', { stateChanged: false, recoveryFile: recovery.file })
  }
  try {
    await restoreAccountBackup({ ...input, preserveMail: true, inspectSource: async () => {
      const exact = await inspectAccountBackupArchive(input)
      if (exact.sha256 !== reviewed.archiveSha256) fail('CONFLICT', 'the selected archive changed', { stateChanged: false })
    } })
    const after = await previewAccountBackup(input)
    if (after.rows.some(row => row.state === 'add' || row.state === 'replace')) fail('PRECONDITION_FAILED', 'restored file readback does not match the archive')
    return { file: input.file, recovery, scope: 'home', mailPreserved: true, contentReadback: 'matched' }
  } catch {
    return fail('PRECONDITION_FAILED', 'restore requires inspection; the recovery archive is retained', { stateChanged: true, verificationRequired: true, recoveryFile: recovery.file })
  }
}

const agentJson = (value: unknown, status = 200): Response => { const source = JSON.stringify(value); if (Buffer.byteLength(source) > 8 * 1024 * 1024) return fail('LIMIT_EXCEEDED', 'the bounded backup response is too large', { stateChanged: false }); return new Response(source, { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }) }
const agentBody = async (req: Request, allowed: readonly string[]): Promise<Record<string, unknown>> => {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) return fail('VALIDATION', 'a JSON backup request is required', { stateChanged: false })
  let value: unknown
  try { const body = await req.text(); if (body.length > 4096) return fail('VALIDATION', 'the backup request is too large', { stateChanged: false }); value = JSON.parse(body) }
  catch { return fail('VALIDATION', 'the backup request must contain valid JSON', { stateChanged: false }) }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) return fail('VALIDATION', 'unsupported backup request field', { stateChanged: false })
  return value as Record<string, unknown>
}

/** The dispatcher must resolve the current account and authorize the trusted principal first. */
async function handleLockedAccountBackupRequest(req: Request, input: { executor: AgentExecutor; account: AccountBackupIdentity; root?: string }): Promise<Response> {
  const url = new URL(req.url), base = '/accounts/' + input.account.username + '/backup-workspace'
  if (!url.pathname.startsWith(base)) return fail('NOT_FOUND', 'account backup route not found')
  const suffix = url.pathname.slice(base.length), storageRoot = input.root ?? DEFAULT_BACKUP_DIR
  const root = posix.join(storageRoot, 'account-workspaces', input.account.id)
  const operationInput = { ...input, root }
  if (!suffix && req.method === 'GET') {
    if (url.search) return fail('VALIDATION', 'backup selectors are not accepted')
    return agentJson({ backups: await listAccountBackups(root, input.account) })
  }
  const match = /^\/([^/]+)\/(preview|restore|download|preview\.csv)$/.exec(suffix)
  let file: string | undefined
  if (match) {
    try { file = assertBackupFileName(input.account.username, decodeURIComponent(match[1]!)) }
    catch { return fail('VALIDATION', 'backup file name is invalid', { stateChanged: false }) }
    if (req.method === 'GET' && match[2] === 'download' && !url.search) return downloadAccountBackup({ root, account: input.account, file })
    if (req.method === 'GET' && match[2] === 'preview.csv') {
      if ([...url.searchParams.keys()].some(key => key !== 'revision') || !/^[a-f0-9]{64}$/.test(url.searchParams.get('revision') ?? '')) return fail('VALIDATION', 'the reviewed backup revision is required')
      const preview = await previewAccountBackup({ ...operationInput, file })
      if (preview.revision !== url.searchParams.get('revision')) return fail('CONFLICT', 'the restore comparison changed; review it again', { stateChanged: false })
      const cell = (value: unknown): string => '"' + String(value ?? '').replace(/^\s*[=+@-]/, "'$&").replaceAll('"', '""') + '"'
      const csv = ['Path,Result,Archive bytes,Current bytes', ...preview.rows.map(row => [row.path, row.state, row.archiveBytes, row.currentBytes].map(cell).join(','))].join('\r\n')
      if (Buffer.byteLength(csv) > 8 * 1024 * 1024) return fail('LIMIT_EXCEEDED', 'the restore difference export is too large', { stateChanged: false })
      return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-length': String(Buffer.byteLength(csv)), 'content-disposition': 'attachment; filename="restore-differences.csv"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
    }
  }
  if (url.search || req.method !== 'POST') return fail('NOT_FOUND', 'account backup route not found')
  const operation = !suffix ? 'create' : match?.[2]
  if (!['create', 'preview', 'restore'].includes(operation ?? '')) return fail('NOT_FOUND', 'account backup route not found')
  const body = await agentBody(req, operation === 'restore' ? ['expectedRevision', 'confirmation'] : [])
  if (operation === 'create') {
    await input.executor.runAction({ kind: 'ensure-dir', path: storageRoot, mode: 0o700, owner: 'root', group: 'root' })
    await input.executor.runAction({ kind: 'ensure-dir', path: posix.join(storageRoot, 'account-workspaces'), mode: 0o700, owner: 'root', group: 'root' })
    return agentJson({ backup: await createAccountBackup({ ...operationInput, nonce: randomBytes(6).toString('hex'), excludeMail: true }), scope: 'home' }, 201)
  }
    if (operation === 'preview') return agentJson({ preview: await previewAccountBackup({ ...operationInput, file: file! }) })
    if (typeof body.expectedRevision !== 'string' || typeof body.confirmation !== 'string') return fail('VALIDATION', 'restore revision and confirmation are required', { stateChanged: false })
    return agentJson({ backup: await restoreAccountBackupWithRecovery({ ...operationInput, file: file!, expectedRevision: body.expectedRevision, confirmation: body.confirmation }) })
}

export interface AccountBackupAgentContext {
  executor: AgentExecutor; account: AccountBackupIdentity; root?: string
  /** Hold the existing state/lifecycle lease through fresh authorization and the operation. */
  withAccountLease<T>(operation: (current: AccountBackupIdentity) => Promise<T>): Promise<T>
}

/** Private namespaces bind archives to account identity, including after username reuse. */
export async function handleAccountBackupAgentRequest(req: Request, input: AccountBackupAgentContext): Promise<Response> {
  identity(input.account)
  if (typeof input.withAccountLease !== 'function') return fail('PRECONDITION_FAILED', 'an authorized account lifecycle lease is required', { stateChanged: false })
  return input.withAccountLease(async current => {
    if (JSON.stringify(identity(current)) !== JSON.stringify(identity(input.account))) return fail('CONFLICT', 'the account identity changed before the backup operation', { stateChanged: false })
    return handleLockedAccountBackupRequest(req, { ...input, account: current })
  })
}
