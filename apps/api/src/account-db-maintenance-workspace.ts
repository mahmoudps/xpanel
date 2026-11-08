import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { parseDbMaintenanceRequest } from '../../agent/src/db-maintenance.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { validateDbMaintenanceReport } from './whm-db-admin-workspace.ts'

const ROUTE = /^\/api\/databases\/([^/]+)\/maintenance$/
export type AccountDbMaintenanceHost = (caller: AuthenticatedCaller, account: Account, body: { database: string; action: string }) => Promise<unknown>

/** The account check and repair of its own MariaDB databases, for its owner, reseller or root. Without an agent nothing can run. */
export async function handleAccountDbMaintenanceRoute(req: Request, url: URL, method: string, helpers: Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertCanAccessAccount' | 'resolveAccountParam'> & { maintainDatabase?: AccountDbMaintenanceHost }): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (method !== 'POST' || !match && url.pathname !== '/api/databases/repair') return null
  const caller = await helpers.requireCaller(req), raw = await req.json().catch(() => null) as { accountId?: string; database?: unknown; engine?: unknown; operation?: unknown } | null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('VALIDATION', 'a JSON object is required', { stateChanged: false })
  const id = match?.[1] ?? raw.accountId ?? (caller.principal.kind === 'user' ? caller.principal.accountId : null)
  if (!id) return fail('VALIDATION', 'accountId is required')
  const account = await helpers.resolveAccountParam(id)
  await helpers.assertCanAccessAccount(caller, account, 'database.maintenance')
  if (match?.[1] && raw.accountId && raw.accountId !== account.id && raw.accountId !== account.username) return fail('NOT_FOUND', `account "${raw.accountId}" not found`)
  const database = raw.database
  if (database !== undefined && (typeof database !== 'string' || !database.startsWith(`${account.username}_`))) return fail('FORBIDDEN', `database is outside account "${account.username}" namespace`)
  const operation = raw.operation ?? (match ? 'check' : 'repair')
  // OPTIMIZE and PostgreSQL have no executor: running a check in their place would report work nobody asked for.
  if (!helpers.maintainDatabase || operation !== 'check' && operation !== 'repair' || (raw.engine ?? 'mariadb') !== 'mariadb') return fail('PRECONDITION_FAILED', 'this database maintenance is not available here; nothing was run', { reason: 'database_maintenance_unavailable', stateChanged: false, nativeApplied: false })
  const request = parseDbMaintenanceRequest({ database, action: operation })
  await helpers.assertCanAccessAccount(await helpers.requireCaller(req), account, 'database.maintenance')
  const report = validateDbMaintenanceReport(await helpers.maintainDatabase(caller, account, request), request)
  return new Response(JSON.stringify(report), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
