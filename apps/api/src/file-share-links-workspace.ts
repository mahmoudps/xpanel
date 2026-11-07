import { randomBytes } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { panelConfigRevision, readPanelConfigBody } from './panel-config-file.ts'
import type { PanelConfigFile } from './panel-config-file.ts'
import { MAX_SHARE_LINKS, SHARE_LINK_MAX_HOURS, SHARE_TOKEN, findShareLink, shareTokenHash } from '../../agent/src/file-share-links.ts'
import type { FileShareLink, FileShareLinks, ShareFileIdentity } from '../../agent/src/file-share-links.ts'

export const FILE_SHARE_LINKS_NAMESPACE = 'file-share-links'
const ROUTE = '/api/server/file-sharing/links'
const LINK_ROUTE = /^\/api\/server\/file-sharing\/links\/(fsl_[0-9a-f]{16})$/
const unchanged = { stateChanged: false }
type AuditEntry = { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok'; principalId: string | null }
type AuditScope = { accountId: string | null; resellerId: string | null }

export interface FileShareLinksHelpers {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  file: PanelConfigFile<FileShareLinks>
  /** Protected agent check that the path is one regular file inside an active account. */
  inspect: (caller: AuthenticatedCaller, path: string) => Promise<ShareFileIdentity>
  emitAudit: (entry: AuditEntry, scope: AuditScope) => Promise<unknown>
  now?: () => Date
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const view = (row: FileShareLink, now: Date) => ({ id: row.id, username: row.username, file: row.file, sizeBytes: row.sizeBytes, expiresAt: row.expiresAt, createdAt: row.createdAt, createdBy: row.createdBy, state: Date.parse(row.expiresAt) > now.getTime() ? 'active' as const : 'expired' as const })

/** Root management of share links. The token is returned once, at creation, and never saved. */
export async function handleFileShareLinksRoute(request: Request, url: URL, method: string, helpers: FileShareLinksHelpers): Promise<Response | null> {
  const target = LINK_ROUTE.exec(url.pathname)
  if (!target && url.pathname !== ROUTE) return null
  const caller = await helpers.requireCaller(request)
  const action = target ? 'server.file-sharing.links.revoke' : method === 'POST' ? 'server.file-sharing.links.create' : 'server.file-sharing.links.read'
  await helpers.assertRoot(caller, action)
  if (url.search) return fail('VALIDATION', 'file share links accept no selectors', unchanged)
  const now = (helpers.now ?? (() => new Date()))(), authority = async (): Promise<void> => { await helpers.assertRoot(await helpers.requireCaller(request), action) }
  const load = async () => { const { raw, value } = await helpers.file.read(); return { rows: value?.links ?? [], revision: panelConfigRevision(FILE_SHARE_LINKS_NAMESPACE, raw), invalid: value === null } }
  const audit = (name: string, row: FileShareLink, detail: Record<string, unknown>) => helpers.emitAudit({ actor: caller.principal.username, action: name, target: `file:${row.username}:${row.file}`.slice(0, 256), detail: { linkId: row.id, ...detail }, outcome: 'ok', principalId: caller.principal.id }, { accountId: row.accountId, resellerId: null })
  if (target) {
    if (method !== 'DELETE') return new Response(null, { status: 405, headers: { allow: 'DELETE' } })
    const { rows, revision } = await load(), row = rows.find(item => item.id === target[1])
    if (!row) return fail('NOT_FOUND', 'link not found', unchanged)
    await helpers.file.write({ links: rows.filter(item => item.id !== row.id) }, revision, authority)
    // The row is gone, so a failed record still leaves the link dead; the reply says what is unknown.
    try { await audit('file_share.link_revoked', row, {}) } catch { return fail('SERVICE_UNAVAILABLE', 'the link is revoked, but the revocation could not be recorded', { stateChanged: true, verificationRequired: true }) }
    return json(200, { revoked: row.id })
  }
  if (method === 'GET') {
    const { rows, revision, invalid } = await load()
    return json(200, { revision, invalid, links: rows.map(row => view(row, now)) })
  }
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  const body = await readPanelConfigBody(request, 4096)
  if (Object.keys(body).sort().join() !== 'expectedRevision,expiresHours,path' || typeof body.path !== 'string' || typeof body.expectedRevision !== 'string') return fail('VALIDATION', 'one file path, an expiry and the current revision are required', unchanged)
  if (typeof body.expiresHours !== 'number' || !Number.isSafeInteger(body.expiresHours) || body.expiresHours < 1 || body.expiresHours > SHARE_LINK_MAX_HOURS) return fail('VALIDATION', `the expiry is required, 1 to ${SHARE_LINK_MAX_HOURS} hours`, unchanged)
  const identity = await helpers.inspect(caller, body.path), { rows } = await load()
  const live = rows.filter(row => Date.parse(row.expiresAt) > now.getTime())
  if (live.length >= MAX_SHARE_LINKS) return fail('LIMIT_EXCEEDED', `at most ${MAX_SHARE_LINKS} links can be active`, unchanged)
  const token = randomBytes(32).toString('base64url')
  const row: FileShareLink = { id: 'fsl_' + randomBytes(8).toString('hex'), tokenHash: shareTokenHash(token), ...identity, expiresAt: new Date(now.getTime() + body.expiresHours * 3_600_000).toISOString(), createdAt: now.toISOString(), createdBy: caller.principal.username, createdById: caller.principal.id }
  const saved = await helpers.file.write({ links: [...live, row] }, body.expectedRevision, authority)
  try { await audit('file_share.link_created', row, { expiresAt: row.expiresAt, sizeBytes: row.sizeBytes }) }
  catch {
    // An unrecorded link must not exist, so it is withdrawn and its token is never shown.
    await helpers.file.write({ links: saved.value.links.filter(item => item.id !== row.id) }, panelConfigRevision(FILE_SHARE_LINKS_NAMESPACE, saved.raw), authority)
    return fail('SERVICE_UNAVAILABLE', 'the link could not be recorded, so it was withdrawn', unchanged)
  }
  return json(201, { link: view(row, now), path: '/share/' + token })
}

export const SHARE_MISS_LIMIT = 20
export const SHARE_MISS_WINDOW_MS = 600_000
export const SHARE_USE_LIMIT = 120
const SHARE_MISS_CLIENTS = 4096
export interface ShareMissLimiter { blocked(client: string): boolean; miss(client: string): void }
/** Misses per client address. A full table refuses new addresses, as Dynamic DNS does, so it cannot be flushed by rotation. */
export function createShareMissLimiter(now: () => number = Date.now, limit = SHARE_MISS_LIMIT): ShareMissLimiter {
  const seen = new Map<string, { count: number; until: number }>()
  const sweep = (): void => { const time = now(); for (const [client, item] of seen) if (item.until <= time) seen.delete(client) }
  return {
    blocked: client => { sweep(); return (seen.get(client)?.count ?? 0) >= limit || seen.size >= SHARE_MISS_CLIENTS && !seen.has(client) },
    miss: client => { const before = seen.get(client); seen.set(client, { count: (before?.count ?? 0) + 1, until: before?.until ?? now() + SHARE_MISS_WINDOW_MS }) },
  }
}

export interface FileShareDownloadPorts {
  limiter: ShareMissLimiter
  /** Served files per client: a leaked link cannot flood the audit log or the uplink. */
  uses: ShareMissLimiter
  clientAddress: () => string | null
  readLinks: () => Promise<readonly FileShareLink[]>
  /** The agent re-checks the saved link and walks the home; the request names no path. */
  openFile: (link: FileShareLink) => Promise<Response>
  emitAudit: (entry: AuditEntry, scope: AuditScope) => Promise<unknown>
  now?: () => Date
}
const baseHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' }
const plain = (status: number, text: string, extra: Record<string, string> = {}): Response => new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...baseHeaders, ...extra } })

/** GET /share/<token>. Unknown, malformed, expired, revoked and unreadable all take this one answer. */
export async function handleFileShareDownload(request: Request, url: URL, method: string, ports: FileShareDownloadPorts): Promise<Response> {
  if (method !== 'GET') return plain(405, 'Method not allowed', { allow: 'GET' })
  const client = ports.clientAddress() ?? 'unknown'
  // Before any lookup, and for live tokens too: a different answer here would tell a guess that it hit.
  if (ports.limiter.blocked(client) || ports.uses.blocked(client)) return plain(429, 'Too many requests', { 'retry-after': String(SHARE_MISS_WINDOW_MS / 1000) })
  const miss = (): Response => { ports.limiter.miss(client); return plain(404, 'Not found') }
  const token = url.pathname.slice('/share/'.length)
  if (url.search || !SHARE_TOKEN.test(token)) return miss()
  let link: FileShareLink | null
  try { link = findShareLink(await ports.readLinks(), shareTokenHash(token), (ports.now ?? (() => new Date()))()) } catch { return miss() }
  if (!link) return miss()
  let file: Response
  try { file = await ports.openFile(link) } catch (error) { if (isXpanelError(error) || error instanceof Error) return miss(); throw error }
  if (!file.ok || !file.body) { await file.body?.cancel().catch(() => undefined); return miss() }
  // Recorded before the first byte leaves, so a use that cannot be recorded does not happen.
  try { await ports.emitAudit({ actor: 'anonymous', action: 'file_share.link_used', target: `file:${link.username}:${link.file}`.slice(0, 256), detail: { linkId: link.id, client }, outcome: 'ok', principalId: null }, { accountId: link.accountId, resellerId: null }) }
  catch { await file.body.cancel().catch(() => undefined); return plain(503, 'Temporarily unavailable') }
  ports.uses.miss(client)
  return new Response(file.body, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': file.headers.get('content-disposition') ?? 'attachment', ...(file.headers.get('content-length') ? { 'content-length': file.headers.get('content-length')! } : {}), 'content-security-policy': "default-src 'none'; sandbox", ...baseHeaders } })
}
