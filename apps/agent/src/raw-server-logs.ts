import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import { fail } from '@xpanel/core'
import { edge } from '@xpanel/render'

/** WHM Raw NGINX / Raw Apache Log Download: the web servers' own logs, read-only, from fixed directories only. */
export const RAW_SERVER_LOG_DIRS = { nginx: '/var/log/nginx', apache: edge.XP_PATHS.apacheLogDir } as const
export type RawLogServer = keyof typeof RAW_SERVER_LOG_DIRS
/** Larger files are refused rather than cut: an operator reads those on the host. */
export const RAW_SERVER_LOG_MAX_BYTES = 1024 * 1024 * 1024
const RAW_LOG_NAME = /^(?:access|error)\.log(?:\.[1-9][0-9]?)?(?:\.gz)?$/
const LIST_MAX = 200
const ROUTE = /^\/host\/logs\/raw\/(nginx|apache)(?:\/([^/]{1,64}))?$/
export interface RawServerLog { name: string; sizeBytes: number; mtime: string; compressed: boolean; downloadable: boolean }
export interface RawServerLogsView { server: RawLogServer; directory: string; state: 'read' | 'unavailable'; files: RawServerLog[]; maxBytes: number; observedAt: string }

const realDir = async (path: string): Promise<boolean> => {
  for (let current = path; current !== '/'; current = posix.dirname(current)) {
    const info = await lstat(current).catch(() => null)
    // The directory itself may belong to the web server user (EL nginx); every component must be a real directory.
    if (!info?.isDirectory() || info.isSymbolicLink() || current !== path && info.uid !== 0) return false
  }
  return true
}

/** The current and rotated access and error logs of one web server; anything else in its directory is not listed. */
export async function listRawServerLogs(server: RawLogServer, now = new Date()): Promise<RawServerLogsView> {
  const directory = RAW_SERVER_LOG_DIRS[server], base = { server, directory, maxBytes: RAW_SERVER_LOG_MAX_BYTES, observedAt: now.toISOString() }
  if (!await realDir(directory)) return { ...base, state: 'unavailable', files: [] }
  const files: RawServerLog[] = []
  for (const name of (await readdir(directory)).filter(name => RAW_LOG_NAME.test(name)).sort()) {
    const info = await lstat(posix.join(directory, name)).catch(() => null)
    if (info?.isFile() && info.nlink === 1) files.push({ name, sizeBytes: info.size, mtime: info.mtime.toISOString(), compressed: name.endsWith('.gz'), downloadable: info.size <= RAW_SERVER_LOG_MAX_BYTES })
    if (files.length >= LIST_MAX) break
  }
  return { ...base, state: 'read', files }
}

/** Opens one listed log read-only without following a link; the open file must still be the named regular file. */
export async function openRawServerLog(server: RawLogServer, name: string) {
  if (!RAW_LOG_NAME.test(name)) return fail('NOT_FOUND', 'log file not found', { stateChanged: false })
  const directory = RAW_SERVER_LOG_DIRS[server], path = posix.join(directory, name)
  if (!await realDir(directory)) return fail('PRECONDITION_FAILED', 'the log directory is not a real directory', { stateChanged: false })
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null)
  if (!handle) return fail('NOT_FOUND', 'log file not found', { stateChanged: false })
  const [file, named] = await Promise.all([handle.stat(), lstat(path).catch(() => null)])
  if (!file.isFile() || file.nlink !== 1 || !named || named.ino !== file.ino || named.dev !== file.dev) { await handle.close(); return fail('NOT_FOUND', 'log file not found', { stateChanged: false }) }
  if (file.size > RAW_SERVER_LOG_MAX_BYTES) { await handle.close(); return fail('LIMIT_EXCEEDED', 'the log file is larger than the download bound', { stateChanged: false, maxBytes: RAW_SERVER_LOG_MAX_BYTES }) }
  return { handle, sizeBytes: file.size }
}

/** GET /host/logs/raw/<nginx|apache> lists, GET …/<file> streams one file; root only, no caller-chosen path. */
export async function handleRawServerLogsRoute(req: Request, url: URL, method: string, ctx: { assertRoot: (action: string) => Promise<unknown>; available: boolean }): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  await ctx.assertRoot('server.logs.raw.read')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search || req.body !== null) return fail('VALIDATION', 'raw log reads accept no selectors or body', { stateChanged: false })
  if (!ctx.available) return fail('PRECONDITION_FAILED', 'raw web server logs are unavailable on this host', { stateChanged: false })
  const server = match[1] as RawLogServer, name = match[2]
  if (!name) return Response.json(await listRawServerLogs(server), { headers: { 'cache-control': 'no-store' } })
  const { handle, sizeBytes } = await openRawServerLog(server, name)
  if (sizeBytes === 0) { await handle.close(); return fail('NOT_FOUND', 'the log file is empty', { stateChanged: false }) }
  return new Response(Readable.toWeb(handle.createReadStream({ start: 0, end: sizeBytes - 1 })) as ReadableStream<Uint8Array>, {
    headers: { 'content-type': name.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream', 'content-length': String(sizeBytes), 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' },
  })
}
