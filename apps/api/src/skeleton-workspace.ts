import { fail } from '@xpanel/core'
import { sha256Hex } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'

export const SKELETON_LIMITS = { files: 100, fileBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024, pathBytes: 240 } as const
const ROUTE = '/api/accounts/skeleton', FILE_ROUTE = '/api/accounts/skeleton/file'
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const unchanged = { stateChanged: false }
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const revisionOf = (raw: unknown): string => sha256Hex(JSON.stringify(raw ?? null))

export interface SkeletonFile { path: string; contentBase64: string; bytes: number }
export interface SkeletonPorts {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>
  /** null for root: its skeleton serves accounts it creates itself. */
  resellerOf: (caller: AuthenticatedCaller) => Promise<string | null>
  /** ExtendedFeaturesStore `accounts/skeletons/<scope>.json`. */
  read: (scope: string) => Promise<unknown>
  write: (scope: string, value: unknown) => Promise<unknown>
  audit: (caller: AuthenticatedCaller, action: 'saved' | 'removed', path: string) => Promise<void>
}

/** public_html or public_ftp, then plain segments: nothing can leave the folder or hide as a dot file. */
export const assertSkeletonPath = (value: unknown): string => {
  const parts = typeof value === 'string' ? value.split('/') : []
  if (parts.length < 2 || parts.length > 8 || (parts[0] !== 'public_html' && parts[0] !== 'public_ftp') || Buffer.byteLength(value as string) > SKELETON_LIMITS.pathBytes || !parts.slice(1).every(part => SEGMENT.test(part))) return fail('VALIDATION', 'the path must be inside public_html or public_ftp', { ...unchanged, reason: 'skeleton_path' })
  return value as string
}
export const readSkeleton = (raw: unknown): SkeletonFile[] => Array.isArray(raw) ? raw.filter((file): file is SkeletonFile => !!file && typeof file.path === 'string' && typeof file.contentBase64 === 'string' && Number.isSafeInteger(file.bytes)).slice(0, SKELETON_LIMITS.files) : []

/** Parent folders of the files, shallowest first, without the two folders every new account has or gets from its first file. */
export const skeletonFolders = (files: readonly SkeletonFile[]): string[] => {
  const folders = new Set<string>()
  for (const { path } of files) { const parts = path.split('/'); for (let depth = 1; depth < parts.length; depth++) folders.add(parts.slice(0, depth).join('/')) }
  return [...folders].filter(folder => folder !== 'public_html').sort((left, right) => left.split('/').length - right.split('/').length)
}

// shortcut: in-process serialization only; one API process owns these extended state files.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(task: () => Promise<T>): Promise<T> => { const run = queue.then(task, task); queue = run.catch(() => undefined); return run }
const view = (raw: unknown, scope: string) => { const files = readSkeleton(raw); return { scope, revision: revisionOf(raw), files: files.map(({ path, bytes }) => ({ path, bytes })), limits: SKELETON_LIMITS } }

/** WHM Skeleton Directory: GET lists the caller's files; PUT and DELETE .../file change one. Copied only at account creation. */
export async function handleSkeletonRoute(request: Request, url: URL, method: string, ports: SkeletonPorts): Promise<Response | null> {
  if (url.pathname !== ROUTE && url.pathname !== FILE_ROUTE) return null
  const caller = await ports.requireCaller(request)
  if (caller.principal.kind !== 'root' && caller.principal.kind !== 'reseller') return fail('FORBIDDEN', 'hosting administrator permission is required', unchanged)
  const allow = url.pathname === ROUTE ? 'GET' : 'PUT, DELETE'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  if (url.search) return fail('VALIDATION', 'the skeleton takes no selectors', unchanged)
  const scope = await ports.resellerOf(caller) ?? 'root'
  if (url.pathname === ROUTE) return json(view(await ports.read(scope), scope))
  const body = await ports.readJsonBody(request), path = assertSkeletonPath(body.path)
  let content: string | null = null, bytes = 0
  if (method === 'PUT') {
    if (typeof body.contentBase64 !== 'string' || body.contentBase64.length % 4 !== 0 || !BASE64.test(body.contentBase64)) return fail('VALIDATION', 'the file content must be base64', unchanged)
    content = body.contentBase64; bytes = Buffer.from(content, 'base64').byteLength
    if (bytes > SKELETON_LIMITS.fileBytes) return fail('LIMIT_EXCEEDED', 'one skeleton file is at most 1 MiB', { ...unchanged, reason: 'skeleton_file_size' })
  }
  return serial(async () => {
    const raw = await ports.read(scope)
    if (revisionOf(raw) !== body.expectedRevision) return fail('CONFLICT', 'the skeleton changed since it was read; reload before saving', unchanged)
    const others = readSkeleton(raw).filter(file => file.path !== path)
    if (content === null && others.length === readSkeleton(raw).length) return fail('NOT_FOUND', 'this file is not in the skeleton', unchanged)
    if (content !== null && (others.length >= SKELETON_LIMITS.files || others.reduce((sum, file) => sum + file.bytes, bytes) > SKELETON_LIMITS.totalBytes)) return fail('LIMIT_EXCEEDED', `the skeleton holds at most ${SKELETON_LIMITS.files} files and 4 MiB`, { ...unchanged, reason: 'skeleton_full' })
    if (content !== null && others.some(file => file.path.startsWith(path + '/') || path.startsWith(file.path + '/'))) return fail('CONFLICT', 'a file and a folder cannot share this name', unchanged)
    const next = content === null ? others : [...others, { path, contentBase64: content, bytes }].sort((left, right) => left.path.localeCompare(right.path))
    await ports.write(scope, next)
    await ports.audit(caller, content === null ? 'removed' : 'saved', path)
    return json(view(next, scope))
  })
}

export interface SkeletonCopyPorts {
  readFiles: () => Promise<SkeletonFile[]>
  /** The agent's confined per-account file route: writes as the account, against its quota. */
  op: (body: Record<string, unknown>) => Promise<boolean>
}

/** Copies a skeleton into a new account as the account itself; a file that fails is reported, the account stays created. */
export async function copySkeleton(ports: SkeletonCopyPorts): Promise<{ copied: number; failed: string[] }> {
  const files = await ports.readFiles(), failed: string[] = []
  for (const folder of skeletonFolders(files)) await ports.op({ op: 'mkdir', path: folder, mode: 0o750 }).catch(() => false)
  let copied = 0
  for (const file of files) { if (await ports.op({ op: 'put-bytes', path: file.path, contentBase64: file.contentBase64, overwrite: false, mode: 0o640 }).catch(() => false)) copied++; else failed.push(file.path) }
  return { copied, failed }
}
