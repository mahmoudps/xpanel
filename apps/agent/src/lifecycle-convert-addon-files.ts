import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, Plan } from '@xpanel/core'
import type { FileEntry, JailedFileManager } from './file-manager.ts'
import { MAX_BINARY_BYTES, MAX_DIR_MODE, MAX_FILE_MODE } from './file-manager.ts'

/** Confined tenant I/O only: every byte is read as the source account and written as the target account. */
export type TreeFiles = Pick<JailedFileManager, 'list' | 'getBytes' | 'putBytes' | 'mkdir' | 'moveToTrash'>
export interface TreeItem { from: string; to: string }
export interface TreeCopyResult { files: number; bytes: number; directories: number; skipped: string[]; created: string[]; digest: string }
export const TREE_COPY_LIMITS = { items: 64, entries: 50_000, bytes: 4 * 1024 * 1024 * 1024 } as const

const unchanged = { stateChanged: false }
const sha = (base64: string): string => createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex')
const RELATIVE = /^(?!\.trash(?:\/|$))(?!\.xpanel(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/
export const assertTreePath = (path: unknown): string => typeof path === 'string' && path.length <= 1024 && RELATIVE.test(path) && !path.split('/').some(part => part === '.' || part === '..') ? path : fail('VALIDATION', 'a copy path is invalid', unchanged)
const missing = (error: unknown): boolean => isXpanelError(error) && error.code === 'NOT_FOUND'

interface Walked { directories: FileEntry[]; files: FileEntry[] }
/** Lists one tree completely before anything is written; links and oversized files refuse the whole copy. */
async function walk(files: TreeFiles, root: string, budget: { entries: number; bytes: number }): Promise<Walked | null> {
  const out: Walked = { directories: [], files: [] }
  const queue = [root]
  let first = true
  while (queue.length) {
    const path = queue.shift()!
    let entries: FileEntry[]
    try { entries = await files.list(path, { showHidden: true }) } catch (error) { if (first && missing(error)) return null; throw error }
    first = false
    for (const entry of entries) {
      if (++budget.entries > TREE_COPY_LIMITS.entries) fail('LIMIT_EXCEEDED', 'the domain has too many files for one bounded copy', unchanged)
      if (entry.kind === 'symlink') fail('PRECONDITION_FAILED', 'the domain files contain a symbolic link; replace it with a file before converting', { ...unchanged, path: entry.path })
      if (entry.kind === 'directory') { out.directories.push(entry); queue.push(entry.path); continue }
      if (entry.sizeBytes > MAX_BINARY_BYTES) fail('PRECONDITION_FAILED', 'a file is larger than the 2 MiB limit of the confined file copy', { ...unchanged, path: entry.path })
      budget.bytes += entry.sizeBytes
      if (budget.bytes > TREE_COPY_LIMITS.bytes) fail('LIMIT_EXCEEDED', 'the domain files are larger than one bounded copy', unchanged)
      out.files.push(entry)
    }
  }
  return out
}
/**
 * Copies each source tree to its target path, never over an existing target file, and reads every written file
 * back. `check` re-proves both account identities between files. Every path this run creates is pushed to
 * `created` as it is made, so a caller can undo a partial copy.
 */
export async function copyAccountTrees(input: { source: TreeFiles; target: TreeFiles; items: readonly TreeItem[]; check: () => Promise<void>; created: string[] }): Promise<TreeCopyResult> {
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > TREE_COPY_LIMITS.items) return fail('VALIDATION', 'between 1 and 64 copy items are required', unchanged)
  const items = input.items.map(item => ({ from: assertTreePath(item.from), to: assertTreePath(item.to) }))
  const budget = { entries: 0, bytes: 0 }, plans: { item: TreeItem; tree: Walked }[] = [], skipped: string[] = []
  const present = new Map<string, FileEntry['kind']>()
  for (const item of items) {
    const tree = await walk(input.source, item.from, budget)
    if (!tree) { skipped.push(item.from); continue }
    const current = await walk(input.target, item.to, { entries: 0, bytes: 0 })
    if (current) { present.set(item.to, 'directory'); for (const entry of [...current.directories, ...current.files]) present.set(entry.path, entry.kind) }
    for (const file of tree.files) { const path = item.to + file.path.slice(item.from.length); if (present.has(path)) fail('CONFLICT', 'a target file already exists; nothing was overwritten', { ...unchanged, path }) }
    plans.push({ item, tree })
  }
  const created = input.created, digest = createHash('sha256')
  let files = 0, bytes = 0, directories = 0
  const ensureDirectory = async (path: string, mode: number): Promise<void> => {
    if (present.get(path) === 'directory') return
    if (present.has(path)) fail('CONFLICT', 'a target path is not a directory', { stateChanged: created.length > 0, path })
    const parent = posix.dirname(path)
    if (parent !== '.') await ensureDirectory(parent, MAX_DIR_MODE)
    // The parent of the top target (for example mail/) may already exist outside the walked tree.
    try { await input.target.mkdir(path, (mode & MAX_DIR_MODE) || MAX_DIR_MODE); created.push(path); directories++ }
    catch (error) { if (!isXpanelError(error) || error.code !== 'CONFLICT' || parent !== '.' && present.has(parent)) throw error }
    present.set(path, 'directory')
  }
  for (const { item, tree } of plans) {
    await ensureDirectory(item.to, MAX_DIR_MODE)
    for (const directory of tree.directories) await ensureDirectory(item.to + directory.path.slice(item.from.length), directory.mode)
    for (const file of tree.files) {
      await input.check()
      const destination = item.to + file.path.slice(item.from.length)
      const read = await input.source.getBytes(file.path), hash = sha(read.contentBase64)
      await input.target.putBytes(destination, read.contentBase64, { overwrite: false, mode: (file.mode & MAX_FILE_MODE) || 0o600 })
      created.push(destination)
      const back = await input.target.getBytes(destination)
      if (back.sizeBytes !== read.sizeBytes || sha(back.contentBase64) !== hash) fail('PRECONDITION_FAILED', 'a copied file did not read back with the same bytes', { stateChanged: true, path: destination })
      files++; bytes += read.sizeBytes; digest.update(destination + '\0' + hash + '\n')
    }
  }
  return { files, bytes, directories, skipped, created: [...created], digest: digest.digest('hex') }
}

/** Rollback of a failed copy: what this run created goes to the target trash, newest first, so nothing is destroyed. */
export async function trashCreated(target: TreeFiles, created: readonly string[]): Promise<{ trashed: number; failed: string[] }> {
  const failed: string[] = []
  let trashed = 0
  for (const path of [...created].reverse()) {
    try { await target.moveToTrash(path); trashed++ } catch (error) { if (!missing(error)) failed.push(path) }
  }
  return { trashed, failed }
}

export interface ConvertAddonFilesDeps {
  authorize: (action: string) => Promise<void>
  store: { getAccountByUsername(username: string): Promise<Account | null>; getPlan(id: string): Promise<Plan | null> }
  /** Confined runner for one account; null where the helper is not installed. */
  files: ((account: Account, plan: Plan) => TreeFiles) | null
  audit: (entry: { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown>; principalId: string }) => Promise<unknown>
  caller: { actor: string; principalId: string }
}
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** POST /transfers/convert-addon/(copy|cleanup), root only. The API journals each call around it. */
export async function handleConvertAddonFilesRoute(req: Request, url: URL, method: string, deps: ConvertAddonFilesDeps): Promise<Response | null> {
  const match = /^\/transfers\/convert-addon\/(copy|cleanup)$/.exec(url.pathname)
  if (!match) return null
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'addon conversion files accept no selectors', unchanged)
  const op = match[1] as 'copy' | 'cleanup'
  await deps.authorize('transfer.convert-addon.' + op)
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const keys = op === 'copy' ? 'items,source,target' : 'paths,source'
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== keys) return fail('VALIDATION', 'unsupported addon conversion file request', unchanged)
  if (!deps.files) return fail('PRECONDITION_FAILED', 'the confined account file runner is not installed', unchanged)
  const open = async (key: 'source' | 'target') => {
    const username = body[key]
    const account = typeof username === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(username) ? await deps.store.getAccountByUsername(username) : null
    if (!account || account.username !== username || account.status !== 'active') return fail('NOT_FOUND', 'account not found', unchanged)
    const plan = await deps.store.getPlan(account.planId)
    if (!plan) return fail('PRECONDITION_FAILED', 'the account plan is missing', unchanged)
    return { account, files: deps.files!(account, plan) }
  }
  const same = async (expected: Account): Promise<void> => {
    const now = await deps.store.getAccountByUsername(expected.username)
    if (!now || now.id !== expected.id || now.uid !== expected.uid || now.home !== expected.home || now.status !== 'active') fail('CONFLICT', 'an account changed during the file copy', { stateChanged: true })
  }
  const paths = (value: unknown): string[] => Array.isArray(value) && value.length <= TREE_COPY_LIMITS.entries ? value.map(assertTreePath) : fail('VALIDATION', 'a bounded path list is required', unchanged)
  if (op === 'copy') {
    const source = await open('source'), target = await open('target')
    if (source.account.id === target.account.id) return fail('VALIDATION', 'the source and target accounts must differ', unchanged)
    const items = Array.isArray(body.items) ? body.items as TreeItem[] : fail('VALIDATION', 'copy items are required', unchanged)
    const created: string[] = []
    let result: TreeCopyResult
    try { result = await copyAccountTrees({ source: source.files, target: target.files, items, created, check: async () => { await same(source.account); await same(target.account) } }) }
    catch (error) {
      if (!created.length) throw error
      const undo = await trashCreated(target.files, created)
      return fail('PRECONDITION_FAILED', 'the file copy failed; what it created was moved to the target trash', { stateChanged: undo.failed.length > 0, verificationRequired: undo.failed.length > 0, rolledBack: undo.trashed, rollbackFailed: undo.failed.slice(0, 50), reason: isXpanelError(error) ? error.message : 'copy_failed' })
    }
    await deps.audit({ actor: deps.caller.actor, action: 'transfer.convert_addon.files_copied', target: 'account:' + target.account.username, outcome: 'ok', detail: { source: source.account.username, files: result.files, bytes: result.bytes, digest: result.digest }, principalId: deps.caller.principalId }).catch(() => undefined)
    return json(result)
  }
  const side = await open('source')
  // Cleanup moves the copied-from trees to the source trash: recoverable, never a permanent delete.
  const result = await trashCreated(side.files, [...paths(body.paths)].reverse())
  return json({ ...result, complete: result.failed.length === 0 })
}
