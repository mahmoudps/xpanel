import { fail } from '@xpanel/core'
import type { HostJobPlan } from './host-job-contract.ts'
import { buildPackageListRefreshJobPlan, buildSystemUpdateJobPlan, isSelectablePackage, readSystemUpdatePlan } from './package-manager.ts'
import type { SystemUpdateFamily, SystemUpdateMode, SystemUpdateRun } from './package-manager.ts'
import { isPackageSelection } from '../../../packages/os/src/package-manager-command.ts'
import { packageSafetyRefusal, withPackageSafety } from './ops-package-writers.ts'
import type { PackageSafety, PackageSafetyRefusal } from './ops-package-writers.ts'

export interface SystemUpdatesRouteContext {
  /** Re-authenticates the request caller and requires the current root principal. */
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** null when the host is not a supported native Linux package-manager host. */
  family: SystemUpdateFamily | null
  run: SystemUpdateRun
  readFile: (path: string) => Promise<string | null>
  /** null when the host job runner is unavailable. */
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<{ id: string; status: string }>) | null
  /** Competing package writers and package database state; null leaves every job unavailable as unverified. */
  safety: (() => Promise<PackageSafety>) | null
  now?: () => Date
}

const ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; action: string }>> = {
  '/host/system-updates/plan': { method: 'GET', action: 'host.system-updates.read' },
  '/host/system-updates/apply': { method: 'POST', action: 'host.system-updates.apply' },
  '/host/system-updates/refresh': { method: 'POST', action: 'host.system-updates.refresh' },
}
const JOB_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled'])
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const readBody = async (req: Request, fields: readonly string[]): Promise<Record<string, unknown>> => {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const text = await req.text()
  let body: unknown
  try { body = text.length <= 131_072 ? JSON.parse(text) : null } catch { body = null }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) return fail('VALIDATION', 'unsupported system update request', { stateChanged: false })
  return body as Record<string, unknown>
}

const UNVERIFIED: PackageSafety = { state: 'unavailable', writers: [], database: 'not-read' }
const readSafety = async (ctx: SystemUpdatesRouteContext): Promise<PackageSafety> => {
  if (!ctx.safety) return UNVERIFIED
  try { return await ctx.safety() } catch { return UNVERIFIED }
}
const refuseSafety = (reason: PackageSafetyRefusal): never => fail('PRECONDITION_FAILED', reason === 'competing-package-writer' ? 'another package manager is running; try again after it finishes' : reason === 'package-database-not-clean' ? 'the package database needs repair before updates' : 'competing package writers could not be checked', { stateChanged: false, reason })

const submit = async (ctx: SystemUpdatesRouteContext, family: SystemUpdateFamily, base: HostJobPlan, action: string): Promise<Response> => {
  const reason = packageSafetyRefusal(await readSafety(ctx))
  if (reason) return refuseSafety(reason)
  const plan = withPackageSafety(base, family, () => readSafety(ctx), refuseSafety)
  const { actor } = await ctx.assertRoot(action)
  const job = await ctx.submitJob!(plan, actor)
  if (!job || typeof job.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(job.id) || !JOB_STATUSES.has(job.status)) return fail('PRECONDITION_FAILED', 'the submitted update job could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  return json({ job: { id: job.id, status: job.status } }, 202)
}

/** Root-only update plan reads and reviewed job hand-off. Nothing here runs a mutating command directly. */
export async function handleSystemUpdatesRoute(req: Request, url: URL, method: string, ctx: SystemUpdatesRouteContext): Promise<Response | null> {
  const route = ROUTES[url.pathname]
  if (!route) return null
  await ctx.assertRoot(route.action)
  if (method !== route.method) return new Response(null, { status: 405, headers: { allow: route.method } })
  if (url.search && (route.method !== 'GET' || url.search !== '?excludeKernel=true')) return fail('VALIDATION', 'only the reviewed kernel exclusion option is accepted', { stateChanged: false })
  const read = (excludeKernel = false) => readSystemUpdatePlan({ run: ctx.run, family: ctx.family, readFile: ctx.readFile, ...(ctx.now ? { now: ctx.now } : {}), excludeKernel })
  if (route.method === 'GET') {
    const plan = await read(url.search === '?excludeKernel=true')
    const safety = ctx.family ? await readSafety(ctx) : UNVERIFIED
    const jobs = ctx.family !== null && ctx.submitJob !== null && packageSafetyRefusal(safety) === null
    await ctx.assertRoot(route.action)
    return json({ plan, safety, actions: { refresh: jobs, apply: jobs && plan.state === 'read' && plan.packages.some(entry => isSelectablePackage(entry) && (!plan.excludeKernel || !entry.kernel)) } })
  }
  const refresh = url.pathname.endsWith('/refresh')
  const body = await readBody(req, refresh ? [] : ['expectedRevision', 'mode', 'packages', 'excludeKernel'])
  const family = ctx.family
  if (!family || !ctx.submitJob) return fail('PRECONDITION_FAILED', 'system update jobs require a supported Linux host and the host job runner', { stateChanged: false })
  if (refresh) return submit(ctx, family, buildPackageListRefreshJobPlan(family), route.action)
  const mode = body.mode as SystemUpdateMode
  if (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision) || !['security', 'all', 'selected'].includes(mode)
    || body.excludeKernel !== undefined && typeof body.excludeKernel !== 'boolean' || (mode === 'selected' ? !isPackageSelection(family, body.packages) : body.packages !== undefined)) return fail('VALIDATION', 'a saved plan revision and a reviewed package selection are required', { stateChanged: false })
  const observed = await read(body.excludeKernel === true)
  if (observed.state !== 'read') return fail('PRECONDITION_FAILED', 'the update plan could not be re-read', { stateChanged: false, reason: observed.reason })
  if (observed.revision !== body.expectedRevision) return fail('CONFLICT', 'the update plan changed; read it again before applying', { stateChanged: false })
  const plan = buildSystemUpdateJobPlan({ family, observed, selection: mode === 'selected' ? { mode, packages: body.packages as string[] } : { mode }, ...(observed.excludeKernel ? { revalidate: { run: ctx.run, assertRoot: () => ctx.assertRoot(route.action) } } : {}) })
  if (observed.excludeKernel) for (const step of plan.steps) await plan.beforeStep!(step)
  return submit(ctx, family, plan, route.action)
}
