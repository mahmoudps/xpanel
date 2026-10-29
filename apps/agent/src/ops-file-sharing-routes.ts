import { join } from 'node:path'
import { fail } from '@xpanel/core'
import { readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { applyFileSharingConfig, FILE_SHARING_STATE_PATH, observeFileSharing, parseShareConfig, savedShareConfigRevision, shareConfigRevision } from './ops-file-sharing.ts'
import type { FileSharingNativeProvider, ShareConfig } from './ops-file-sharing.ts'

export interface FileSharingRouteContext {
  /** Re-authenticates the caller and requires root each time. */
  assertRoot: (action: string) => Promise<{ actor: string }>
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  /** Absent until the native NFS server, export table and re-export are qualified. */
  provider: FileSharingNativeProvider | null
}

const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const unchanged = { stateChanged: false }
const emptyConfig = (): ShareConfig => ({ shares: [] })
/** An absent or malformed saved file is an empty configuration; a malformed one never silently exports stale shares. */
const readSavedConfig = (raw: unknown): ShareConfig => {
  if (raw === null || raw === undefined) return emptyConfig()
  try { return parseShareConfig(raw) } catch { return emptyConfig() }
}

export async function handleFileSharingRoute(request: Request, url: URL, method: string, ctx: FileSharingRouteContext): Promise<Response | null> {
  if (url.pathname !== '/host/file-sharing' && url.pathname !== '/host/file-sharing/apply') return null
  const apply = url.pathname.endsWith('/apply')
  const action = apply ? 'server.file-sharing.apply' : 'server.file-sharing.read'
  const actor = await ctx.assertRoot(action)
  if (url.search) return fail('VALIDATION', 'file sharing operations accept no query selectors', unchanged)
  const statePath = join(ctx.store.rootDir, FILE_SHARING_STATE_PATH)
  if (!apply) {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const raw = await readJsonIfExists<unknown>(statePath)
    let invalid = false
    if (raw !== null && raw !== undefined) try { parseShareConfig(raw) } catch { invalid = true }
    const config = readSavedConfig(raw)
    const observed = await observeFileSharing(config, ctx.provider)
    if ((await ctx.assertRoot(action)).actor !== actor.actor) return fail('FORBIDDEN', 'root authority changed', unchanged)
    return json({ saved: { config, savedRevision: savedShareConfigRevision(raw), revision: shareConfigRevision(config), invalid }, observed })
  }
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const text = await request.text()
  if (Buffer.byteLength(text) > 1024) return fail('VALIDATION', 'file sharing request is too large', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'valid JSON is required', unchanged) }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== 'expectedActiveRevision,expectedRevision') return fail('VALIDATION', 'only expectedRevision and expectedActiveRevision are accepted', unchanged)
  const input = body as Record<string, unknown>
  if ([input.expectedRevision, input.expectedActiveRevision].some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) return fail('VALIDATION', 'exact observed revisions are required', unchanged)
  const lease = await ctx.store.getWriterLock().acquire()
  try {
    const authorize = async (): Promise<void> => { const fresh = await ctx.assertRoot(action); if (fresh.actor !== actor.actor) fail('FORBIDDEN', 'root authority changed', unchanged); await lease.assertFencingToken() }
    await authorize()
    const raw = await readJsonIfExists<unknown>(statePath)
    if (savedShareConfigRevision(raw) !== input.expectedRevision) return fail('CONFLICT', 'saved shares changed; reload before applying', unchanged)
    const config = parseShareConfig(raw === null || raw === undefined ? emptyConfig() : raw)
    const result = await applyFileSharingConfig(config, input.expectedActiveRevision as string, ctx.provider, authorize)
    return json({ ...result, savedRevision: input.expectedRevision, stateChanged: true, verificationRequired: false })
  } finally { await lease.release() }
}
