import { createHash, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fail, isAccountHome } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { readJsonIfExists } from '@xpanel/state'

/** One expiring public download of one file in an account home. Only the hash of a token is ever saved. */
export const FILE_SHARE_LINKS_STATE_PATH = 'extended/file-sharing/links.json'
export const MAX_SHARE_LINKS = 500
export const SHARE_LINK_MAX_HOURS = 720
export const SHARE_LINK_MAX_BYTES = 2 * 1024 * 1024 * 1024
/** 32 random bytes in base64url. */
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/
const LINK_ID = /^fsl_[0-9a-f]{16}$/
const HASH = /^[0-9a-f]{64}$/
const FILE_ID = /^[0-9]{1,20}:[0-9]{1,20}$/
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const CONTENT_ROUTE = /^\/host\/file-sharing\/links\/([0-9a-f]{64})\/content$/
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const instant = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))

export interface FileShareLink { id: string; tokenHash: string; accountId: string; username: string; file: string; fileId: string; sizeBytes: number; expiresAt: string; createdAt: string; createdBy: string; createdById: string }
export interface FileShareLinks { links: FileShareLink[] }
export interface ShareFileIdentity { accountId: string; username: string; file: string; fileId: string; sizeBytes: number }

export const shareTokenHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')
/** A path below the home: never absolute, never `.` or `..`, and no control characters. */
export const isShareFile = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value) && !value.split('/').some(part => part === '' || part === '.' || part === '..')

export function parseShareLinks(raw: unknown): FileShareLinks | null {
  if (!object(raw) || Object.keys(raw).join() !== 'links' || !Array.isArray(raw.links) || raw.links.length > MAX_SHARE_LINKS) return null
  const fields = 'accountId,createdAt,createdBy,createdById,expiresAt,file,fileId,id,sizeBytes,tokenHash,username'
  const valid = raw.links.every(row => object(row) && Object.keys(row).sort().join() === fields && typeof row.id === 'string' && LINK_ID.test(row.id) && typeof row.tokenHash === 'string' && HASH.test(row.tokenHash)
    && typeof row.accountId === 'string' && typeof row.username === 'string' && USERNAME.test(row.username) && isShareFile(row.file) && typeof row.fileId === 'string' && FILE_ID.test(row.fileId)
    && typeof row.sizeBytes === 'number' && Number.isSafeInteger(row.sizeBytes) && row.sizeBytes >= 0 && instant(row.expiresAt) && instant(row.createdAt) && typeof row.createdBy === 'string' && typeof row.createdById === 'string')
  return valid ? raw as unknown as FileShareLinks : null
}

/** Every saved row is compared, so the time taken does not depend on where a hash sits; an expired row is not a match. */
export function findShareLink(rows: readonly FileShareLink[], tokenHash: string, now: Date): FileShareLink | null {
  const wanted = Buffer.from(tokenHash, 'hex')
  let found: FileShareLink | null = null
  for (const row of rows) if (timingSafeEqual(wanted, Buffer.from(row.tokenHash, 'hex'))) found = row
  return found && Date.parse(found.expiresAt) > now.getTime() ? found : null
}

export interface OpenedShareFile { handle: FileHandle; sizeBytes: number; fileId: string }
/**
 * Walks the home one component at a time, each opened relative to its parent's descriptor with O_NOFOLLOW, so a symlink at
 * any depth, or one swapped in during the walk, is refused. Nothing the account does can move the read outside its home.
 */
export async function openShareFile(home: string, file: string, uid: number): Promise<OpenedShareFile> {
  const refuse = (): never => fail('NOT_FOUND', 'the shared file is not available', unchanged)
  if (!isShareFile(file)) return refuse()
  const parts = file.split('/'), name = parts.pop()!, flags = constants.O_RDONLY | constants.O_NOFOLLOW
  const start = await open(home, flags | constants.O_DIRECTORY).catch(() => null)
  if (!start) return refuse()
  let directory: FileHandle = start
  try {
    if ((await directory.stat()).uid !== uid) return refuse()
    for (const part of parts) {
      const next: FileHandle | null = await open(`/proc/self/fd/${directory.fd}/${part}`, flags | constants.O_DIRECTORY).catch(() => null)
      if (!next) return refuse()
      await directory.close(); directory = next
      if ((await directory.stat()).uid !== uid) return refuse()
    }
    // O_NONBLOCK: a FIFO must not hold the request open, and the check below then refuses it.
    const handle = await open(`/proc/self/fd/${directory.fd}/${name}`, flags | constants.O_NONBLOCK).catch(() => null)
    if (!handle) return refuse()
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== uid || info.nlink !== 1 || info.size > SHARE_LINK_MAX_BYTES) { await handle.close(); return refuse() }
    return { handle, sizeBytes: info.size, fileId: `${info.dev}:${info.ino}` }
  } finally { await directory.close() }
}

export interface FileShareLinkRouteContext {
  assertRoot: (action: string) => Promise<unknown>
  /** The verified caller: the content route serves only links this principal created. */
  principalId: string
  rootDir: string
  readAccounts: () => Promise<readonly Pick<Account, 'id' | 'username' | 'uid' | 'home' | 'status'>[]>
  /** Null off a native host: no file is ever read. */
  openFile: typeof openShareFile | null
  now?: () => Date
}
const attachmentName = (file: string): string => file.slice(file.lastIndexOf('/') + 1).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 200) || 'download'

/** POST /host/file-sharing/links/inspect names one file for a new link; GET .../links/<hash>/content reads only a saved live link. */
export async function handleFileShareLinkRoute(req: Request, url: URL, method: string, ctx: FileShareLinkRouteContext): Promise<Response | null> {
  const content = CONTENT_ROUTE.exec(url.pathname)
  if (!content && url.pathname !== '/host/file-sharing/links/inspect') return null
  await ctx.assertRoot(content ? 'server.file-sharing.links.read' : 'server.file-sharing.links.create')
  if (method !== (content ? 'GET' : 'POST')) return new Response(null, { status: 405, headers: { allow: content ? 'GET' : 'POST' } })
  if (url.search) return fail('VALIDATION', 'file share links accept no selectors', unchanged)
  if (!ctx.openFile) return fail('PRECONDITION_FAILED', 'account files cannot be read on this host', unchanged)
  const accounts = await ctx.readAccounts()
  if (!content) {
    const text = await req.text()
    if (text.length > 2048) return fail('VALIDATION', 'the request is too large', unchanged)
    let body: unknown
    try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
    if (!object(body) || Object.keys(body).join() !== 'path' || typeof body.path !== 'string') return fail('VALIDATION', 'exactly one file path is required', unchanged)
    const path = body.path, account = accounts.find(row => path.startsWith(row.home + '/'))
    if (!account || account.status !== 'active' || !isAccountHome(account.home, account.username)) return fail('NOT_FOUND', 'the path is not inside an active account', unchanged)
    const file = path.slice(account.home.length + 1)
    if (!isShareFile(file)) return fail('VALIDATION', 'the path must name one file inside the account home', unchanged)
    const { handle, sizeBytes, fileId } = await ctx.openFile(account.home, file, account.uid)
    await handle.close()
    const identity: ShareFileIdentity = { accountId: account.id, username: account.username, file, fileId, sizeBytes }
    return Response.json(identity, { headers: { 'cache-control': 'no-store' } })
  }
  const unavailable = (): never => fail('NOT_FOUND', 'the shared file is not available', unchanged)
  const saved = parseShareLinks(await readJsonIfExists<unknown>(join(ctx.rootDir, FILE_SHARE_LINKS_STATE_PATH)))
  const link = saved && findShareLink(saved.links, content[1]!, (ctx.now ?? (() => new Date()))())
  if (!link || link.createdById !== ctx.principalId) return unavailable()
  const account = accounts.find(row => row.id === link.accountId)
  if (!account || account.username !== link.username || account.status !== 'active' || !isAccountHome(account.home, account.username)) return unavailable()
  const { handle, sizeBytes, fileId } = await ctx.openFile(account.home, link.file, account.uid)
  // The link names that file, not whatever later takes its name.
  if (fileId !== link.fileId) { await handle.close(); return unavailable() }
  const headers = { 'content-type': 'application/octet-stream', 'content-length': String(sizeBytes), 'content-disposition': `attachment; filename="${attachmentName(link.file)}"`, 'cache-control': 'no-store' }
  if (sizeBytes === 0) { await handle.close(); return new Response(new Uint8Array(0), { headers }) }
  return new Response(Readable.toWeb(handle.createReadStream({ start: 0, end: sizeBytes - 1 })) as ReadableStream<Uint8Array>, { headers })
}
