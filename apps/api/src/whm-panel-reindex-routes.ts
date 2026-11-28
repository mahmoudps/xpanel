import { fail } from '@xpanel/core'
import { reindexFromState } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export interface WhmSearchIndexReindexHelpers
  extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  db: Db
  store: Pick<StateStore, 'readSnapshot'>
}

const ROUTE = '/api/server/search-index/rebuild'
const unchanged = { stateChanged: false }
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

async function assertConfirmOrEmptyBody(request: Request): Promise<void> {
  const raw = (await request.text()).trim()
  if (raw === '') return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fail('VALIDATION', 'request body must be valid JSON', unchanged)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('VALIDATION', 'request body must be a JSON object', unchanged)
  }
  const keys = Object.keys(parsed)
  if (keys.length === 0) return
  if (keys.length === 1 && (parsed as Record<string, unknown>).confirm === true) return
  return fail('VALIDATION', 'request body must be { confirm: true } or an empty JSON object', unchanged)
}

/**
 * Root-only search index rebuild (`POST /api/server/search-index/rebuild`).
 * Rebuilds the derived SQLite `idx_*` and `search_fts` tables from the authoritative desired-state tree.
 */
export async function handleWhmSearchIndexReindexRoute(
  request: Request,
  url: URL,
  method: string,
  helpers: WhmSearchIndexReindexHelpers,
): Promise<Response | null> {
  if (url.pathname !== ROUTE) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'server.search_index.rebuild')
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'search index rebuild accepts no query parameters', unchanged)
  await assertConfirmOrEmptyBody(request)

  const snapshot = await helpers.store.readSnapshot()
  const counts = await reindexFromState(helpers.db, snapshot)
  await helpers.emitAudit({
    actor: caller.principal.username,
    action: 'server.search_index.rebuilt',
    target: 'server:search-index',
    detail: { ...counts },
    outcome: 'ok',
    principalId: caller.principal.id,
  })
  return json({ ok: true, rebuilt: true, counts })
}
