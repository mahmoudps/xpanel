import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, chown, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises'
import { dirname, join, posix, relative } from 'node:path'
import { Readable } from 'node:stream'
import { fail } from '@xpanel/core'
import { fsyncDir } from '@xpanel/state'
import { backupCodecOf, DEFAULT_BACKUP_DIR } from './account-backup.ts'
import { listControlSnapshot } from './acct-backup-archive.ts'
import type { BackupCommandRunner } from './backup-low-priority.ts'

/**
 * Panel data backups: on-demand control snapshots beside the scheduled ones, download, upload, restore and delete. A
 * restore copies the state tree file by file under the writer lease. Without overwrite an existing file stays and is
 * reported as skipped. The SQLite copy stays in the archive for manual recovery: principals and audit live there, and a
 * live index is rebuilt from the restored state instead.
 */
export const PANEL_BACKUP_DIR = '_control'
const FILE = /^xpanel-control-[0-9]{8}T[0-9]{6}Z(?:-[a-f0-9]{12})?\.tar\.(?:gz|zst)$/
const unchanged = { stateChanged: false }
const MAX_UPLOAD_BYTES = 2 * 1024 ** 3, MAX_CHUNK_BYTES = 2 * 1024 * 1024, MAX_REPORTED = 200
// The writer lock and the lease authority belong to this process, never to an archive.
const NEVER_RESTORED = new Set(['.lock', 'authority.json', 'control.db'])
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const assertFile = (value: unknown): string => typeof value === 'string' && FILE.test(value) ? value : fail('VALIDATION', 'invalid snapshot name', unchanged)

export interface PanelBackupRow { file: string; bytes: number; createdAt: string }
export interface PanelBackupsContext {
  assertRoot(action: string): Promise<{ actor: string; principalId?: string }>
  root?: string
  stateDir: string
  run: BackupCommandRunner
  build: (() => Promise<{ file: string; bytes: number }>) | null
  /** Runs the copy inside one state mutation, so the revision moves and the next reconcile sees it. */
  mutate(write: (assertFencing: () => Promise<void>) => Promise<void>): Promise<void>
  reconcile: ((actor: string) => Promise<{ status: 'noop' | 'applied' | 'failed' }>) | null
  audit(entry: { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }): Promise<unknown>
}

const stamp = (file: string): string => { const m = /([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z/.exec(file)!; return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` }
export async function listPanelBackups(directory: string): Promise<PanelBackupRow[]> {
  const names = await readdir(directory).catch(() => [] as string[]), rows: PanelBackupRow[] = []
  for (const file of names.filter(name => FILE.test(name))) { const info = await lstat(join(directory, file)).catch(() => null); if (info?.isFile()) rows.push({ file, bytes: info.size, createdAt: stamp(file) }) }
  return rows.sort((a, b) => a.file < b.file ? 1 : -1)
}

async function walk(root: string, at = root): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const path = join(at, entry.name), rel = relative(root, path)
    if (NEVER_RESTORED.has(rel.split(/[\\/]/)[0]!)) continue
    if (entry.isDirectory()) out.push(...await walk(root, path))
    // A link in an archive could point out of the tree; only regular files are restored.
    else if (entry.isFile()) out.push(rel)
  }
  return out
}
/** Same-directory rename, so a reader sees the old file or the new one. */
async function copyInto(source: string, target: string): Promise<void> {
  // The API service reads and writes this tree too, so each file keeps the owner and mode it had when it was saved.
  const info = await stat(source), parent = await stat(dirname(source))
  if (await mkdir(dirname(target), { recursive: true, mode: parent.mode & 0o777 })) await chown(dirname(target), parent.uid, parent.gid)
  const temporary = target + '.restore-' + randomUUID(), handle = await open(temporary, 'wx', info.mode & 0o777)
  try { await handle.chown(info.uid, info.gid); await handle.writeFile(await readFile(source)); await handle.sync() } catch (error) { await handle.close(); await rm(temporary, { force: true }); throw error }
  await handle.close()
  await rename(temporary, target)
  await fsyncDir(dirname(target))
}

export interface PanelRestoreReport { restored: number; skipped: number; skippedItems: string[]; total: number }
export async function restorePanelSnapshot(input: { directory: string; file: string; stateDir: string; overwrite: boolean; run: BackupCommandRunner; assertFencing: () => Promise<void> }): Promise<PanelRestoreReport> {
  const stage = await mkdtemp(join(input.directory, '.restore-'))
  try {
    const path = join(input.directory, input.file)
    const extracted = await input.run({ argv: ['/usr/bin/tar', '--extract', backupCodecOf(path).tar, `--file=${path}`, `--directory=${stage}`, '--same-owner', '--numeric-owner', '--same-permissions', '--exclude=./control.db', '--exclude=control.db'], maxStdoutBytes: 64 * 1024 })
    if (!extracted.ok) return fail('PRECONDITION_FAILED', 'the snapshot could not be extracted', unchanged)
    const files = await walk(stage)
    const report: PanelRestoreReport = { restored: 0, skipped: 0, skippedItems: [], total: files.length }
    for (const rel of files) {
      const target = join(input.stateDir, rel)
      if (!input.overwrite && await lstat(target).then(() => true, () => false)) {
        report.skipped++
        if (report.skippedItems.length < MAX_REPORTED) report.skippedItems.push(rel.split('\\').join('/'))
        continue
      }
      await input.assertFencing()
      await copyInto(join(stage, rel), target)
      report.restored++
    }
    return report
  } finally { await rm(stage, { recursive: true, force: true }) }
}

export async function handlePanelBackupsRoute(req: Request, url: URL, method: string, ctx: PanelBackupsContext): Promise<Response | null> {
  const download = /^\/host\/panel-backups\/([^/]+)$/.exec(url.pathname)
  if (url.pathname !== '/host/panel-backups' && !download) return null
  const directory = posix.join(ctx.root ?? DEFAULT_BACKUP_DIR, PANEL_BACKUP_DIR)
  if (download) {
    await ctx.assertRoot('panel.backups.download')
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const file = assertFile(decodeURIComponent(download[1]!)), path = join(directory, file)
    const info = await lstat(path).catch(() => null)
    if (!info?.isFile()) return fail('NOT_FOUND', 'the snapshot is not on this server', unchanged)
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, { headers: { 'content-type': backupCodecOf(file).mediaType, 'content-length': String(info.size), 'content-disposition': `attachment; filename="${file}"`, 'cache-control': 'no-store' } })
  }
  if (method === 'GET') {
    await ctx.assertRoot('panel.backups.read')
    return json(200, { folder: directory, canBuild: ctx.build !== null, backups: await listPanelBackups(directory) })
  }
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  const { actor } = await ctx.assertRoot('panel.backups.change')
  const text = await req.text()
  if (text.length > MAX_CHUNK_BYTES * 2) return fail('VALIDATION', 'the request is too large', unchanged)
  let body: Record<string, unknown>
  try { body = JSON.parse(text) as Record<string, unknown> } catch { return fail('VALIDATION', 'the request must be valid JSON', unchanged) }
  const audit = (action: string, target: string, detail: Record<string, unknown>, outcome: 'ok' | 'failed' = 'ok') => ctx.audit({ actor, action: 'panel.backups.' + action, target, detail, outcome }).catch(() => undefined)
  if (body.op === 'create') {
    if (!ctx.build) return fail('PRECONDITION_FAILED', 'control snapshots are unavailable on this host', { ...unchanged, reason: 'snapshot_unavailable' })
    const built = await ctx.build()
    await listControlSnapshot({ root: ctx.root, file: built.file, run: ctx.run })
    await audit('created', built.file, { bytes: built.bytes })
    return json(200, built)
  }
  if (body.op === 'delete') {
    const file = assertFile(body.file)
    await rm(join(directory, file), { force: true })
    await audit('deleted', file, {})
    return json(200, { deleted: true })
  }
  if (body.op === 'upload') {
    const file = assertFile(body.file), offset = body.offset, part = join(directory, file + '.part')
    if (typeof body.data !== 'string' || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || typeof body.done !== 'boolean') return fail('VALIDATION', 'invalid upload chunk', unchanged)
    const bytes = Buffer.from(body.data, 'base64'), had = await stat(part).then(info => info.size, () => 0)
    if (bytes.length > MAX_CHUNK_BYTES || offset + bytes.length > MAX_UPLOAD_BYTES) return fail('LIMIT_EXCEEDED', 'the upload exceeds its limit', unchanged)
    if (offset !== had) return fail('CONFLICT', 'the upload is out of order; start it again', { ...unchanged, expectedOffset: had })
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await appendFile(part, bytes, { mode: 0o600 })
    if (!body.done) return json(200, { received: offset + bytes.length })
    if (await lstat(join(directory, file)).then(() => true, () => false)) { await rm(part, { force: true }); return fail('CONFLICT', 'a snapshot with this name exists', unchanged) }
    const expected = body.sha256, actual = createHash('sha256').update(await readFile(part)).digest('hex')
    if (actual !== expected) { await rm(part, { force: true }); return fail('VALIDATION', 'the uploaded file does not match its digest', { ...unchanged, reason: 'upload_digest' }) }
    await rename(part, join(directory, file))
    try { await listControlSnapshot({ root: ctx.root, file, run: ctx.run }) }
    catch { await rm(join(directory, file), { force: true }); return fail('VALIDATION', 'the file is not an xPanel control snapshot', { ...unchanged, reason: 'INVALID_PACKAGE' }) }
    await utimes(join(directory, file), new Date(), new Date())
    await audit('uploaded', file, { bytes: actual.length })
    return json(200, { file })
  }
  if (body.op !== 'restore' || typeof body.overwrite !== 'boolean') return fail('VALIDATION', 'unknown panel backup operation', unchanged)
  const file = assertFile(body.file), overwrite = body.overwrite
  if (!ctx.reconcile) return fail('PRECONDITION_FAILED', 'a restore needs the reconciler on this host', unchanged)
  await listControlSnapshot({ root: ctx.root, file, run: ctx.run })
  let report: PanelRestoreReport | null = null
  await ctx.mutate(async assertFencing => { report = await restorePanelSnapshot({ directory, file, stateDir: ctx.stateDir, overwrite, run: ctx.run, assertFencing }) })
  const applied = await ctx.reconcile(actor).catch(() => ({ status: 'failed' as const }))
  await audit('restored', file, { overwrite, restored: report!.restored, skipped: report!.skipped, reconcile: applied.status }, applied.status === 'failed' ? 'failed' : 'ok')
  return json(200, { ...report!, overwrite, reconcile: applied.status })
}
