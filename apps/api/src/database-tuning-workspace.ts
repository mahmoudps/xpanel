import { fail, isXpanelError } from '@xpanel/core'
import {
  buildDatabaseTuningView,
  projectDatabaseTuningView,
  validateDatabaseTuningSettings,
} from '../../agent/src/database-tuning.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { readPanelConfigBody } from './panel-config-file.ts'

export interface DatabaseTuningWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot'> {
  readHost(caller: AuthenticatedCaller, path: '/host/databases/tuning'): Promise<unknown>
  callHost?(caller: AuthenticatedCaller, path: string, body: unknown): Promise<unknown>
  emitAudit?: ExtendedRouteHelpers['emitAudit']
}

const unchanged = { stateChanged: false }
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const sameAuthority = (first: AuthenticatedCaller, fresh: AuthenticatedCaller): boolean =>
  fresh.principal.id === first.principal.id && fresh.sessionId === first.sessionId && fresh.apiTokenId === first.apiTokenId
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

const MUTATIONS: Readonly<Record<string, { hostPath: string; permission: string; auditAction: string | null }>> = {
  '/api/server/databases/tuning/preview': {
    hostPath: '/host/databases/tuning/preview',
    permission: 'server.databases.tuning.preview',
    auditAction: null,
  },
  '/api/server/databases/tuning/apply': {
    hostPath: '/host/databases/tuning/apply',
    permission: 'server.databases.tuning.apply',
    auditAction: 'server.databases.tuning_applied',
  },
  '/api/server/databases/tuning/rollback': {
    hostPath: '/api/server/databases/tuning/rollback',
    permission: 'server.databases.tuning.rollback',
    auditAction: 'server.databases.tuning_rolled_back',
  },
}

/** Root-only MariaDB tuning workspace: observation, drop-in preview, validated apply and rollback. */
export async function handleDatabaseTuningWorkspaceRoute(req: Request, url: URL, method: string, helpers: DatabaseTuningWorkspaceHelpers): Promise<Response | null> {
  const mutation = MUTATIONS[url.pathname]
  if (mutation) {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    if (url.search) return fail('VALIDATION', 'database tuning does not accept selectors or statements', unchanged)
    const caller = await helpers.requireCaller(req)
    await helpers.assertRoot(caller, mutation.permission)
    const body = await readPanelConfigBody(req, 16 * 1024)
    let payload: Record<string, unknown>
    if (url.pathname === '/api/server/databases/tuning/preview') {
      if (!Object.hasOwn(body, 'settings') || Object.keys(body).some(key => key !== 'settings' && key !== 'expectedRevision')) {
        return fail('VALIDATION', 'tuning preview requires settings', unchanged)
      }
      payload = { settings: validateDatabaseTuningSettings(body.settings) }
    } else if (url.pathname === '/api/server/databases/tuning/apply') {
      if (!exact(body, ['settings', 'expectedRevision']) || typeof body.expectedRevision !== 'string' || !body.expectedRevision) {
        return fail('VALIDATION', 'exactly settings and expectedRevision are required', unchanged)
      }
      payload = { settings: validateDatabaseTuningSettings(body.settings), expectedRevision: body.expectedRevision }
    } else {
      if (!exact(body, ['expectedRevision']) || typeof body.expectedRevision !== 'string' || !body.expectedRevision) {
        return fail('VALIDATION', 'expectedRevision is required for rollback', unchanged)
      }
      payload = { expectedRevision: body.expectedRevision }
    }
    if (!helpers.callHost) return fail('PRECONDITION_FAILED', 'host database tuning mutations are not connected', { ...unchanged, reason: 'native_host_required' })
    const fresh = await helpers.requireCaller(req)
    await helpers.assertRoot(fresh, mutation.permission)
    if (!sameAuthority(caller, fresh)) return fail('FORBIDDEN', 'database tuning authority changed', unchanged)
    const auditDetail = url.pathname === '/api/server/databases/tuning/apply' ? { settings: payload.settings } : { expectedRevision: payload.expectedRevision }
    try {
      const reply = await helpers.callHost(fresh, mutation.hostPath, payload)
      if (mutation.auditAction && helpers.emitAudit) {
        await Promise.resolve(helpers.emitAudit({ actor: caller.principal.username, action: mutation.auditAction, target: 'mariadb:tuning', detail: auditDetail, outcome: 'ok', principalId: caller.principal.id })).catch(() => undefined)
      }
      return json(reply)
    } catch (error) {
      if (mutation.auditAction && helpers.emitAudit && !(isXpanelError(error) && error.code === 'VALIDATION')) {
        await Promise.resolve(helpers.emitAudit({ actor: caller.principal.username, action: mutation.auditAction, target: 'mariadb:tuning', detail: auditDetail, outcome: 'failed', principalId: caller.principal.id })).catch(() => undefined)
      }
      throw error
    }
  }

  if (url.pathname !== '/api/server/databases/tuning') return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'database tuning does not accept selectors or statements', unchanged)
  const caller = await helpers.requireCaller(req)
  await helpers.assertRoot(caller, 'server.databases.tuning.read')
  let view
  try { view = projectDatabaseTuningView(await helpers.readHost(caller, '/host/databases/tuning')) }
  catch { view = buildDatabaseTuningView({ engine: 'mariadb', state: 'unavailable', observedAt: null, version: null, variables: null, status: null }) }
  const fresh = await helpers.requireCaller(req)
  await helpers.assertRoot(fresh, 'server.databases.tuning.read')
  if (!sameAuthority(caller, fresh)) return fail('FORBIDDEN', 'database tuning authority changed', unchanged)
  return json(view)
}
