import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, chown, mkdir, rm, stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import { createGzip } from 'node:zlib'
import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { runBackupCommand } from './backup-low-priority.ts'
import type { BackupCommandRunner } from './backup-low-priority.ts'

/** Per-database export, import and rename on the host. The API authorizes the caller and owns the saved record. */
export const DATABASE_TRANSFER_ROOT = '/var/lib/xpanel-agent/database-transfer'
const ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/databases\/([A-Za-z0-9_]{1,64})\/(dump|import|copy|drop)$/
const MAX_DUMP_BYTES = 8 * 1024 ** 3, READ_TIMEOUT_MS = 1_800_000
const unchanged = { stateChanged: false }

export interface DatabaseTransferEngine {
  dump(account: Account, database: string, outputPath: string): Promise<{ bytes: number; sha256: string }>
  /** Trusted input only: our own dump of the same database, restored as the administrator. */
  restore(account: Account, database: string, inputPath: string, sha256: string): Promise<void>
  /** Untrusted input: runs as a temporary user limited to this one database. */
  importUntrusted(account: Account, database: string, inputPath: string): Promise<void>
  drop(account: Account, database: string): Promise<void>
}
export interface DatabaseTransferContext {
  caller: { role: string; accountId?: string | null }
  store: { getAccountByUsername(username: string): Promise<Account | null> }
  engine: DatabaseTransferEngine | null
  run?: BackupCommandRunner
  root?: string
}

const running = new Set<string>()
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** Home-relative dump path. It is opened as the account, so a planted link cannot reach a file root alone may read. */
export function dumpReadArgv(home: string, path: unknown): string[] {
  if (typeof path !== 'string' || path.length > 1024 || !/\.sql(?:\.gz)?$/.test(path) || path.startsWith('/') || path.split('/').some(part => part === '' || part === '.' || part === '..') || /[\u0000-\u001f\u007f]/.test(path)) return fail('VALIDATION', 'enter a .sql or .sql.gz file inside your home', unchanged)
  const absolute = posix.join(home, path)
  return path.endsWith('.gz') ? ['/usr/bin/gzip', '-dc', '--', absolute] : ['/usr/bin/cat', '--', absolute]
}

async function stagingDir(root: string): Promise<void> { await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700); if (process.getuid?.() === 0) await chown(root, 0, 0) }

export async function handleDatabaseTransferRoute(request: Request, url: URL, method: string, ctx: DatabaseTransferContext): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const [, username, database, action] = match as unknown as [string, string, string, 'dump' | 'import' | 'copy' | 'drop']
  if (method !== (action === 'dump' ? 'GET' : 'POST')) return new Response(null, { status: 405, headers: { allow: action === 'dump' ? 'GET' : 'POST' } })
  const account = await ctx.store.getAccountByUsername(username)
  if (!account || ctx.caller.role === 'user' && ctx.caller.accountId !== account.id) return fail('FORBIDDEN', 'the account does not match the current owner', unchanged)
  if (!ctx.engine) return fail('PRECONDITION_FAILED', 'database transfers are unavailable on this host', { ...unchanged, reason: 'database_unavailable' })
  const engine = ctx.engine, root = ctx.root ?? DATABASE_TRANSFER_ROOT, run = ctx.run ?? runBackupCommand
  if (action === 'drop') {
    const body = await request.json().catch(() => null) as { name?: unknown } | null
    if (body?.name !== database) return fail('VALIDATION', 'name the database to drop', unchanged)
    await engine.drop(account, database)
    return json({ dropped: database })
  }
  if (running.has(account.username)) return fail('CONFLICT', 'another database transfer of this account is running', { ...unchanged, reason: 'transfer_running' })
  running.add(account.username)
  const staged = posix.join(root, randomUUID() + '.sql'), cleanup = (): Promise<void> => rm(staged, { force: true })
  try {
    await stagingDir(root)
    if (action === 'dump') {
      await engine.dump(account, database, staged)
      running.delete(account.username)
      const stream = createReadStream(staged).pipe(createGzip({ level: 6 }))
      stream.once('close', () => { void cleanup() }).once('error', () => { void cleanup() })
      return new Response(Readable.toWeb(stream) as ReadableStream, { headers: { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${database}.sql.gz"`, 'cache-control': 'no-store' } })
    }
    const body = await request.json().catch(() => null) as { path?: unknown; to?: unknown } | null
    if (action === 'import') {
      const argv = dumpReadArgv(account.home, body?.path)
      const read = await run({ argv, runAsUser: account.username, stdoutPath: staged, maxStdoutBytes: MAX_DUMP_BYTES, timeoutMs: READ_TIMEOUT_MS })
      if (read.killed || !read.ok || !(await stat(staged)).size) return fail('PRECONDITION_FAILED', 'the dump file could not be read', { ...unchanged, reason: 'dump_unreadable' })
      await engine.importUntrusted(account, database, staged)
      return json({ imported: database })
    }
    if (typeof body?.to !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(body.to) || body.to === database) return fail('VALIDATION', 'a new database name is required', unchanged)
    const dumped = await engine.dump(account, database, staged)
    await engine.restore(account, body.to, staged, dumped.sha256)
    return json({ copied: body.to, bytes: dumped.bytes })
  } finally {
    running.delete(account.username)
    if (action !== 'dump') await cleanup()
  }
}
