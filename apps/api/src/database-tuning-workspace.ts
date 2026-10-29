import { fail } from '@xpanel/core'
import { buildDatabaseTuningView, projectDatabaseTuningView } from '../../agent/src/database-tuning.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export interface DatabaseTuningWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot'> {
  readHost(caller: AuthenticatedCaller, path: '/host/databases/tuning'): Promise<unknown>
}
/** A read-only advisory plan: no persisted tuning model or MariaDB configuration writer exists. */
export async function handleDatabaseTuningWorkspaceRoute(req: Request, url: URL, method: string, helpers: DatabaseTuningWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname !== '/api/server/databases/tuning') return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'database tuning does not accept selectors or statements', { stateChanged: false })
  const caller = await helpers.requireCaller(req)
  await helpers.assertRoot(caller, 'server.databases.tuning.read')
  let view
  try { view = projectDatabaseTuningView(await helpers.readHost(caller, '/host/databases/tuning')) }
  catch { view = buildDatabaseTuningView({ engine: 'mariadb', state: 'unavailable', observedAt: null, version: null, variables: null, status: null }) }
  const fresh = await helpers.requireCaller(req)
  await helpers.assertRoot(fresh, 'server.databases.tuning.read')
  if (fresh.principal.id !== caller.principal.id || fresh.sessionId !== caller.sessionId || fresh.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'database tuning authority changed', { stateChanged: false })
  return new Response(JSON.stringify(view), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
