import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import type { AgentExecutor } from './executor.ts'
import { assertBackupFileName, backupFileName, createAccountBackup, MAX_BACKUP_BYTES } from './account-backup.ts'
import { downloadAccountBackup, previewAccountBackup } from './account-backup-workspace.ts'
import { localBackupArchiveSource, storeRecoveredBackupArchive } from './acct-backup-runs.ts'

/**
 * Server-to-server account archives. Source: create one home archive (mail included) and stream it.
 * Destination: store a streamed archive only after its size and SHA-256 match, then compare the restored
 * home with it. The restore itself is the existing root route /accounts/<username>/backups (op restore).
 */
export interface TransferArchiveDeps {
  /** assertRootCaller for this request. */
  authorize: (action: string) => Promise<void>
  /** Linux host executor; null where account archives cannot be created. */
  executor: AgentExecutor | null
  root: string
  store: { getAccountByUsername(username: string): Promise<Account | null> }
  now?: () => Date
}
export interface TransferArchiveReceipt { file: string; bytes: number; sha256: string }

const ROUTE = /^\/transfers\/(source|destination)\/accounts\/([a-z][a-z0-9]{0,15})\/(archives|verify)(?:\/([^/]+))?$/
const SHA = /^[0-9a-f]{64}$/
const unchanged = { stateChanged: false }
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const stampOf = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
const target = (account: Account) => ({ username: account.username, home: account.home, uid: account.uid, status: account.status })

export async function handleTransferArchiveRoute(req: Request, url: URL, method: string, deps: TransferArchiveDeps): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const [, side, username, kind, file] = match as unknown as [string, 'source' | 'destination', string, 'archives' | 'verify', string | undefined]
  const expected = kind === 'verify' || file === undefined ? 'POST' : 'GET'
  if (side === 'destination' && file !== undefined || kind === 'verify' && side !== 'destination') return null
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if (url.search) return fail('VALIDATION', 'transfer archives accept no selectors', unchanged)
  await deps.authorize('transfer.archive.' + side + '.' + kind)
  const executor = deps.executor
  if (!executor) return fail('PRECONDITION_FAILED', 'account archives need the Linux host executor', unchanged)
  const ensureDirectory = async (): Promise<void> => {
    await executor.runAction({ kind: 'ensure-dir', path: deps.root, mode: 0o700, owner: 'root', group: 'root' })
    await executor.runAction({ kind: 'ensure-dir', path: posix.join(deps.root, username), mode: 0o700, owner: 'root', group: 'root' })
  }

  if (side === 'source') {
    const account = await deps.store.getAccountByUsername(username)
    if (!account || account.username !== username || account.status === 'terminating') return fail('NOT_FOUND', 'account not found', unchanged)
    if (file !== undefined) {
      let name: string
      try { name = assertBackupFileName(username, decodeURIComponent(file)) } catch { return fail('VALIDATION', 'the archive name is invalid', unchanged) }
      return downloadAccountBackup({ root: deps.root, account: target(account), file: name })
    }
    // The whole home, mail and mail settings included: the destination restores it as a new account.
    const created = await createAccountBackup({ executor, root: deps.root, account: target(account), nonce: randomBytes(6).toString('hex') })
    const digest = await localBackupArchiveSource(deps.root, target(account), created.file)
    return json({ file: created.file, bytes: digest.bytes, sha256: digest.sha256 } satisfies TransferArchiveReceipt, 201)
  }

  if (kind === 'verify') {
    const account = await deps.store.getAccountByUsername(username)
    if (!account || account.username !== username || account.status !== 'active') return fail('NOT_FOUND', 'account not found', unchanged)
    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'file' || typeof body.file !== 'string') return fail('VALIDATION', 'exactly the archive file is required', unchanged)
    const preview = await previewAccountBackup({ root: deps.root, account: { ...target(account), id: account.id, gid: account.gid }, file: assertBackupFileName(username, body.file) })
    // Mail paths are not compared by the home preview; they are reported as restored without a content comparison.
    return json({ file: preview.file, archiveSha256: preview.archiveSha256, verified: preview.counts.add === 0 && preview.counts.replace === 0, counts: preview.counts, mailCompared: false })
  }

  // Destination import: the name must still be free; a conflicting account is refused before anything is stored.
  if (await deps.store.getAccountByUsername(username)) return fail('CONFLICT', 'an account with this name already exists on this server', unchanged)
  const bytes = Number(req.headers.get('x-xpanel-archive-bytes')), sha256 = req.headers.get('x-xpanel-archive-sha256') ?? ''
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_BACKUP_BYTES || !SHA.test(sha256)) return fail('VALIDATION', 'the archive size and SHA-256 are required', unchanged)
  if (req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/gzip' || !req.body) return fail('VALIDATION', 'a gzip archive body is required', unchanged)
  await ensureDirectory()
  const name = backupFileName(username, stampOf(deps.now?.() ?? new Date()), randomBytes(6).toString('hex'))
  const outcome = await storeRecoveredBackupArchive(deps.root, username, name, req.body, { bytes, sha256 })
  if (outcome === 'mismatch') return fail('PRECONDITION_FAILED', 'the received archive does not match its size and SHA-256; nothing was stored', unchanged)
  if (outcome === 'exists') return fail('CONFLICT', 'an archive with this name already exists', unchanged)
  return json({ file: name, bytes, sha256 } satisfies TransferArchiveReceipt, 201)
}
