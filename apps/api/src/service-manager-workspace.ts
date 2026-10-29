import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import type { ServiceManagerView, ServiceManagerRow } from '../../agent/src/service-manager.ts'
import { isServiceManagerBootUnit, isServiceManagerUnit, serviceManagerRestartTest } from '../../../packages/os/src/service-manager-command.ts'

export interface ServiceManagerWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  callHost: (caller: AuthenticatedCaller, path: string, input?: unknown, mutation?: boolean) => Promise<unknown>
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const token = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const bad = (mutation = false): never => fail(mutation ? 'SERVICE_UNAVAILABLE' : 'PRECONDITION_FAILED', 'service manager response could not be verified', { stateChanged: mutation, verificationRequired: true, ...(mutation ? { unknownOutcome: true } : {}) })
export function projectServiceManagerView(value: unknown): ServiceManagerView {
  if (!object(value) || !['read', 'unavailable'].includes(String(value.state)) || typeof value.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)) || typeof value.manage !== 'boolean'
    || value.bootTime !== null && !(typeof value.bootTime === 'number' && Number.isSafeInteger(value.bootTime) && value.bootTime > 0 && value.bootTime < 8640000000000) || !Array.isArray(value.units) || value.units.length > 4096) return bad()
  if (value.state === 'unavailable' ? value.revision !== null || value.units.length !== 0 || value.manage !== false : !hash(value.revision) || value.units.length === 0) return bad()
  const seen = new Set<string>(), units: ServiceManagerRow[] = value.units.map(raw => {
    if (!object(raw) || !isServiceManagerUnit(raw.unit) || seen.has(raw.unit) || ![raw.load, raw.active, raw.sub, raw.boot].every(item => item === null || token(item)) || [raw.load, raw.active, raw.sub].some(item => item === null) && ![raw.load, raw.active, raw.sub].every(item => item === null) || typeof raw.restart !== 'boolean' || typeof raw.bootEditable !== 'boolean') return bad()
    if (raw.restart && (raw.load !== 'loaded' || !serviceManagerRestartTest(raw.unit)) || raw.bootEditable && (raw.load !== 'loaded' || !isServiceManagerBootUnit(raw.unit) || !['enabled', 'disabled'].includes(String(raw.boot)))) return bad()
    seen.add(raw.unit)
    return { unit: raw.unit, load: raw.load as string | null, active: raw.active as string | null, sub: raw.sub as string | null, boot: raw.boot as string | null, restart: raw.restart, bootEditable: raw.bootEditable }
  })
  return { state: value.state as ServiceManagerView['state'], observedAt: value.observedAt, revision: value.revision as string | null, bootTime: value.bootTime as number | null, units, manage: value.manage }
}
export async function handleServiceManagerWorkspaceRoute(request: Request, url: URL, method: string, helpers: ServiceManagerWorkspaceHelpers): Promise<Response | null> {
  const mutation = url.pathname === '/api/server/service-manager/action'
  if (!mutation && url.pathname !== '/api/server/service-manager') return null
  const action = 'server.services.manager.' + (mutation ? 'action' : 'read'), caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  const fresh = async (changed = false) => {
    const current = await helpers.requireCaller(request); await helpers.assertRoot(current, action)
    if (current.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'service manager authority changed', { stateChanged: changed, verificationRequired: changed })
    return current
  }
  if (method !== (mutation ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: mutation ? 'POST' : 'GET' } })
  if (url.search) return fail('VALIDATION', 'service manager does not accept query fields', { stateChanged: false })
  if (!mutation) { const value = await helpers.callHost(caller, '/host/service-manager'); await fresh(); return json(projectServiceManagerView(value)) }
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const text = await request.text()
  if (text.length > 1024) return fail('VALIDATION', 'service action request exceeds the size limit', { stateChanged: false })
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'valid JSON is required', { stateChanged: false }) }
  if (!object(body) || !hash(body.expectedRevision)) return fail('VALIDATION', 'service action and revision are required', { stateChanged: false })
  const reboot = body.action === 'reboot', keys = reboot ? ['action', 'confirmation', 'expectedRevision'] : ['action', 'unit', 'expectedRevision']
  if (Object.keys(body).length !== keys.length || Object.keys(body).some(key => !keys.includes(key)) || (reboot ? body.confirmation !== 'REBOOT SERVER' : !['restart', 'enable', 'disable'].includes(String(body.action)) || !isServiceManagerUnit(body.unit))) return fail('VALIDATION', 'unsupported service action request', { stateChanged: false })
  await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'services.manager.requested', target: reboot ? 'server' : String(body.unit), detail: { action: body.action }, outcome: 'ok' })
  const submitter = await fresh()
  const result = await helpers.callHost(submitter, '/host/service-manager/action', body, true)
  if (!object(result) || result.action !== body.action || result.unit !== (reboot ? null : body.unit) || result.outcome !== (reboot ? 'attempted' : 'submitted') || result.verificationRequired !== true || !object(result.job) || typeof result.job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.job.id) || result.job.kind !== 'services.manager.' + body.action || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(result.job.status))) return bad(true)
  await fresh(true)
  return json({ action: body.action, unit: result.unit, outcome: result.outcome, verificationRequired: true, job: { id: result.job.id, kind: result.job.kind, status: result.job.status } }, 202)
}
