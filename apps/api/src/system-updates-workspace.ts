import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { SystemUpdatePackage, SystemUpdatePlan } from '../../agent/src/package-manager.ts'
import { isKernelPackageName, isPackageName, isPackageSelection } from '../../../packages/os/src/package-manager-command.ts'
import type { PackageSafety } from '../../agent/src/ops-package-writers.ts'

export interface SystemUpdatesWorkspaceHelpers {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  /** Protected agent transport; a body sends a mutation POST. No caller-selected command, path or host is forwarded. */
  callHost: (caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => Promise<unknown>
}
export interface SystemUpdatesPlanResponse { plan: SystemUpdatePlan; safety: PackageSafety; actions: { refresh: boolean; apply: boolean } }

const ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; action: string; host: string }>> = {
  '/api/server/updates/plan': { method: 'GET', action: 'server.updates.read', host: '/host/system-updates/plan' },
  '/api/server/updates/apply': { method: 'POST', action: 'server.updates.apply', host: '/host/system-updates/apply' },
  '/api/server/updates/refresh': { method: 'POST', action: 'server.updates.refresh', host: '/host/system-updates/refresh' },
}
const REASONS = ['unsupported-host', 'package-manager-busy', 'package-manager-unavailable', 'invalid-package-manager-output']
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const version = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9.+~:^_-]{1,256}$/.test(value)
const safeText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(value)
const count = (value: unknown, expected: number): boolean => Number.isSafeInteger(value) && value === expected
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const unverified = (): never => fail('PRECONDITION_FAILED', 'the host update plan could not be verified', { stateChanged: false, verificationRequired: true })

/** Whitelists the host boundary; counts must agree with the returned entries. */
export function projectSystemUpdatesPlan(value: unknown): SystemUpdatesPlanResponse {
  if (!object(value) || !object(value.plan) || !object(value.actions) || typeof value.actions.refresh !== 'boolean' || typeof value.actions.apply !== 'boolean') return unverified()
  const raw = value.plan
  const read = raw.state === 'read'
  if (raw.excludeKernel !== undefined && raw.excludeKernel !== true || !['read', 'unavailable'].includes(String(raw.state)) || !['apt', 'dnf', null].includes(raw.source as string | null) || typeof raw.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.observedAt) || !Number.isFinite(Date.parse(raw.observedAt))) return unverified()
  if (read ? typeof raw.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.revision) || raw.source === null || raw.reason !== undefined : raw.revision !== null || !REASONS.includes(String(raw.reason))) return unverified()
  if (!Array.isArray(raw.packages) || raw.packages.length > 5000 || !read && raw.packages.length !== 0 || raw.holds !== null && (!Array.isArray(raw.holds) || raw.holds.length > 5000 || raw.source !== 'apt') || ![true, false, 'not-read'].includes(raw.rebootRequired as boolean | 'not-read') || !object(raw.counts)) return unverified()
  const family = raw.source === 'dnf' ? 'rhel' : 'debian'
  const seen = new Set<string>()
  const packages: SystemUpdatePackage[] = raw.packages.map(item => {
    if (!object(item) || !isPackageName(family, item.name) || seen.has(item.name) || item.current !== null && !version(item.current) || !version(item.candidate) || !safeText(item.origin, 1024)
      || [item.security, item.kernel, item.held, item.newInstall].some(flag => typeof flag !== 'boolean') || item.kernel !== isKernelPackageName(family, item.name) || item.newInstall === true && item.current !== null) return unverified()
    seen.add(item.name)
    return { name: item.name, current: item.current as string | null, candidate: item.candidate, origin: item.origin, security: item.security as boolean, kernel: item.kernel as boolean, held: item.held as boolean, newInstall: item.newInstall as boolean }
  })
  const holds = raw.holds === null ? null : (raw.holds as unknown[]).map(name => isPackageName('debian', name) ? name : unverified())
  const counts = raw.counts
  if (!count(counts.total, packages.length) || !count(counts.security, packages.filter(item => item.security).length) || !count(counts.kernel, packages.filter(item => item.kernel).length) || (holds === null ? counts.held !== null : !count(counts.held, holds.length))) return unverified()
  if (value.actions.apply && !read) return unverified()
  const safety = projectPackageSafety(value.safety)
  if ((value.actions.apply || value.actions.refresh) && (safety.state !== 'read' || safety.writers.length || safety.database !== 'clean')) return unverified()
  const plan: SystemUpdatePlan = { state: raw.state as SystemUpdatePlan['state'], source: raw.source as SystemUpdatePlan['source'], observedAt: raw.observedAt, revision: raw.revision as string | null, packages, holds, rebootRequired: raw.rebootRequired as SystemUpdatePlan['rebootRequired'], counts: { total: packages.length, security: counts.security as number, kernel: counts.kernel as number, held: holds ? holds.length : null }, ...(read ? {} : { reason: raw.reason as SystemUpdatePlan['reason'] }), ...(raw.excludeKernel ? { excludeKernel: true } : {}) }
  return { plan, safety, actions: { refresh: value.actions.refresh, apply: value.actions.apply } }
}

/** Competing package writers and database state; jobs may be offered only for an idle, clean package manager. */
export function projectPackageSafety(value: unknown): PackageSafety {
  if (!object(value) || Object.keys(value).sort().join() !== 'database,state,writers' || !['read', 'unavailable'].includes(String(value.state)) || !['clean', 'interrupted', 'damaged', 'not-read'].includes(String(value.database)) || !Array.isArray(value.writers) || value.writers.length > 256) return unverified()
  const writers = value.writers.map(item => object(item) && Object.keys(item).sort().join() === 'command,pid' && Number.isSafeInteger(item.pid) && (item.pid as number) > 0 && typeof item.command === 'string' && /^[a-z][a-z0-9.+-]{0,14}$/.test(item.command) ? { pid: item.pid as number, command: item.command } : unverified())
  if (value.state === 'unavailable' && (writers.length || value.database !== 'not-read')) return unverified()
  return { state: value.state as PackageSafety['state'], writers, database: value.database as PackageSafety['database'] }
}

const parseBody = async (request: Request, refresh: boolean): Promise<Record<string, unknown>> => {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  let body: unknown
  try { body = await request.json() } catch { return fail('VALIDATION', 'request body is not valid JSON', { stateChanged: false }) }
  const fields = refresh ? [] : ['expectedRevision', 'mode', 'packages', 'excludeKernel']
  if (!object(body) || Object.keys(body).some(key => !fields.includes(key))) return fail('VALIDATION', 'unsupported system update field', { stateChanged: false })
  if (refresh) return {}
  const selected = body.mode === 'selected'
  if (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision) || !['security', 'all', 'selected'].includes(String(body.mode))
    || body.excludeKernel !== undefined && typeof body.excludeKernel !== 'boolean' || (selected ? !isPackageSelection('debian', body.packages) && !isPackageSelection('rhel', body.packages) : body.packages !== undefined)) return fail('VALIDATION', 'a saved plan revision and a reviewed package selection are required', { stateChanged: false })
  return { expectedRevision: body.expectedRevision, mode: body.mode, ...(selected ? { packages: [...body.packages as string[]] } : {}), ...(body.excludeKernel ? { excludeKernel: true } : {}) }
}

export async function handleSystemUpdatesWorkspaceRoute(request: Request, url: URL, method: string, helpers: SystemUpdatesWorkspaceHelpers): Promise<Response | null> {
  const route = ROUTES[url.pathname]
  if (!route) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, route.action)
  if (method !== route.method) return new Response(null, { status: 405, headers: { allow: route.method } })
  if (url.search && (route.method !== 'GET' || url.search !== '?excludeKernel=true')) return fail('VALIDATION', 'only the reviewed kernel exclusion option is accepted', { stateChanged: false })
  if (route.method === 'GET') {
    const projected = projectSystemUpdatesPlan(await helpers.callHost(caller, route.host + url.search))
    if (Boolean(projected.plan.excludeKernel) !== (url.search === '?excludeKernel=true')) return unverified()
    const fresh = await helpers.requireCaller(request)
    await helpers.assertRoot(fresh, route.action)
    if (fresh.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'system update authority changed while reading the plan', { stateChanged: false })
    return json(projected)
  }
  const body = await parseBody(request, route.host.endsWith('/refresh'))
  const fresh = await helpers.requireCaller(request)
  await helpers.assertRoot(fresh, route.action)
  if (fresh.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'system update authority changed', { stateChanged: false })
  const result = await helpers.callHost(fresh, route.host, body)
  const job = object(result) && object(result.job) ? result.job : null
  if (!job || typeof job.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(job.id) || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(job.status))) return fail('PRECONDITION_FAILED', 'the submitted update job could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  try {
    const after = await helpers.requireCaller(request)
    await helpers.assertRoot(after, route.action)
    if (after.principal.id !== caller.principal.id) throw new Error('authority_changed')
  } catch { return fail('FORBIDDEN', 'root authorization changed after the update job was submitted', { stateChanged: true, verificationRequired: true }) }
  return json({ job: { id: job.id, status: job.status } }, 202)
}
