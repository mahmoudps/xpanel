import { fail } from '@xpanel/core'
import { parseDbMaintenanceRequest, parseRootPasswordRequest, ROOT_CLIENT_FILE } from '../../agent/src/db-maintenance.ts'
import type { DbMaintenanceReport, RootPasswordOutcome } from '../../agent/src/db-maintenance.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertPasswordAllowed } from './password-policy.ts'

export type WhmDbAdminHostPath = '/host/databases/maintenance' | '/host/databases/root-password'
export interface WhmDbAdminHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot'> {
  /** The authenticated agent runs the reviewed operation; the reply is checked again here before the browser sees it. */
  callHost: (caller: AuthenticatedCaller, path: WhmDbAdminHostPath, body: unknown) => Promise<unknown>
  readHost: (caller: AuthenticatedCaller, path: WhmDbAdminHostPath) => Promise<unknown>
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const iso = (value: unknown): boolean => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/u
const text = (value: unknown, max: number): boolean => typeof value === 'string' && value.length >= 1 && value.length <= max && value.isWellFormed() && !UNSAFE.test(value)
const RESULTS = ['ok', 'repaired', 'corrupt', 'not-supported', 'failed']

export function validateDbMaintenanceReport(raw: unknown, request: { database: string; action: string }): DbMaintenanceReport {
  const bad = (): never => fail('SERVICE_UNAVAILABLE', 'the maintenance result could not be verified', { stateChanged: request.action === 'repair', verificationRequired: true })
  if (!object(raw) || !exact(raw, ['database', 'action', 'observedAt', 'tables']) || raw.database !== request.database || raw.action !== request.action || !iso(raw.observedAt) || !Array.isArray(raw.tables) || raw.tables.length > 1000) return bad()
  for (const table of raw.tables) {
    if (!object(table) || !exact(table, ['name', 'engine', 'result', 'message']) || !text(table.name, 64) || table.engine !== null && !text(table.engine, 64) || !RESULTS.includes(String(table.result)) || table.message !== null && !text(table.message, 256)) return bad()
  }
  if (new Set(raw.tables.map(table => (table as { name: string }).name)).size !== raw.tables.length) return bad()
  return raw as unknown as DbMaintenanceReport
}
export function validateRootPasswordOutcome(raw: unknown): RootPasswordOutcome {
  const bad = (): never => fail('SERVICE_UNAVAILABLE', 'the root password outcome could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  if (!object(raw) || !exact(raw, ['observedAt', 'serverPassword', 'clientFile', 'socketAccess', 'verificationRequired']) || !iso(raw.observedAt) || raw.serverPassword !== 'verified' || !object(raw.clientFile) || !exact(raw.clientFile, ['path', 'state'])
    || raw.clientFile.path !== ROOT_CLIENT_FILE || !['written', 'failed'].includes(String(raw.clientFile.state)) || !['verified', 'unverified'].includes(String(raw.socketAccess))
    || raw.verificationRequired !== (raw.clientFile.state !== 'written' || raw.socketAccess !== 'verified')) return bad()
  return raw as unknown as RootPasswordOutcome
}

/** An unread host is reported as such; the file content itself never crosses the agent boundary. */
export function validateRootPasswordState(raw: unknown): { clientFile: { path: string; state: string }; mariadb: string } {
  if (object(raw) && exact(raw, ['clientFile', 'mariadb']) && object(raw.clientFile) && exact(raw.clientFile, ['path', 'state']) && raw.clientFile.path === ROOT_CLIENT_FILE
    && ['absent', 'managed', 'unmanaged', 'unreadable'].includes(String(raw.clientFile.state)) && ['connected', 'unavailable'].includes(String(raw.mariadb))) return raw as { clientFile: { path: string; state: string }; mariadb: string }
  return { clientFile: { path: ROOT_CLIENT_FILE, state: 'unreadable' }, mariadb: 'unavailable' }
}
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const ROUTES: Readonly<Record<string, { host: WhmDbAdminHostPath; target: string }>> = {
  '/api/server/databases/maintenance': { host: '/host/databases/maintenance', target: 'server.databases.maintenance' },
  '/api/server/databases/root-password': { host: '/host/databases/root-password', target: 'server.databases.root_password' },
}

export async function handleWhmDbAdminRoute(request: Request, url: URL, method: string, helpers: WhmDbAdminHelpers): Promise<Response | null> {
  const route = ROUTES[url.pathname]
  if (!route) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, route.target)
  const root = route.host === '/host/databases/root-password'
  if (method !== 'POST' && !(root && method === 'GET')) return new Response(null, { status: 405, headers: { allow: root ? 'GET, POST' : 'POST' } })
  if (url.search) return fail('VALIDATION', 'database administration does not accept selectors', { stateChanged: false })
  if (method === 'GET') {
    let state: unknown
    try { state = await helpers.readHost(caller, route.host) } catch { state = null }
    return json(validateRootPasswordState(state))
  }
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const raw = await request.text()
  let parsed: unknown
  try { if (raw.length > 1024) throw new Error('too_large'); parsed = JSON.parse(raw) } catch { return fail('VALIDATION', 'the request is not bounded JSON', { stateChanged: false }) }
  const body = root ? parseRootPasswordRequest(parsed) : parseDbMaintenanceRequest(parsed)
  if (root) assertPasswordAllowed((body as { password: string }).password, 'database')
  const fresh = await helpers.requireCaller(request)
  await helpers.assertRoot(fresh, route.target)
  if (fresh.principal.id !== caller.principal.id || fresh.sessionId !== caller.sessionId || fresh.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'database administration authority changed', { stateChanged: false })
  const reply = await helpers.callHost(fresh, route.host, body)
  return json(root ? validateRootPasswordOutcome(reply) : validateDbMaintenanceReport(reply, body as { database: string; action: string }))
}
