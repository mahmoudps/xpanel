import { fail } from '@xpanel/core'
import type { HostJobRunner } from './host-jobs.ts'
import { HOST_JOB_ID_RE, HOST_JOB_KIND_RE, HOST_JOB_LIST_MAX, HOST_JOB_LOG_CAP_BYTES, HOST_JOB_LOG_READ_MAX, HOST_JOB_STATUSES } from './host-jobs.ts'
import type { HostJobView } from './host-job-contract.ts'

export interface HostJobsRouteContext {
  /** Re-reads the calling principal and requires root; resolves with its current actor name. */
  assertRoot(action: string): Promise<{ actor: string }>
  /** Null when this agent has no host job runner; reads and cancellation then stay unavailable. */
  runner: HostJobRunner | null
}

const ROUTE = /^\/host\/jobs(?:\/([^/]+)(?:\/(log|cancel))?)?$/
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const invalid = (message: string): never => fail('VALIDATION', message, { stateChanged: false })

/** One value per allowed name, no others; numbers are plain decimal integers. */
export const readHostJobsQuery = (url: URL, allowed: readonly string[]): Record<string, string> => {
  const values: Record<string, string> = {}
  for (const [name, value] of url.searchParams) {
    if (!allowed.includes(name) || Object.hasOwn(values, name)) return invalid('unsupported job request selector')
    values[name] = value
  }
  return values
}

const integer = (raw: string | undefined, fallback: number, min: number, max: number, what: string): number => {
  if (raw === undefined) return fallback
  if (!/^(?:0|[1-9][0-9]{0,8})$/.test(raw) || Number(raw) < min || Number(raw) > max) return invalid(`${what} must be an integer in ${min}..${max}`)
  return Number(raw)
}

/** GET /host/jobs, GET /host/jobs/:id, GET /host/jobs/:id/log, POST /host/jobs/:id/cancel. */
export async function handleHostJobsRoute(req: Request, url: URL, method: string, ctx: HostJobsRouteContext): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const [, id, action] = match
  const writing = action === 'cancel'
  const allow = writing ? 'POST' : 'GET'
  if (method !== allow) return new Response(null, { status: 405, headers: { allow } })
  const { actor } = await ctx.assertRoot(writing ? 'host.jobs.cancel' : 'host.jobs.read')
  if (id !== undefined && !HOST_JOB_ID_RE.test(id)) return invalid('a lowercase job id is required')
  const query = readHostJobsQuery(url, id === undefined ? ['status', 'kindPrefix', 'limit'] : action === 'log' ? ['offset', 'limit'] : [])
  if (writing && (await req.text()).length > 0) return invalid('job cancellation does not accept a body')
  const runner = ctx.runner
  if (!runner) return fail('SERVICE_UNAVAILABLE', 'the host job runner is unavailable on this agent', { stateChanged: false, reason: 'host_job_runner_unavailable' })
  if (id === undefined) {
    if (query.status !== undefined && !(HOST_JOB_STATUSES as readonly string[]).includes(query.status)) return invalid('job status filter is invalid')
    if (query.kindPrefix !== undefined && !HOST_JOB_KIND_RE.test(query.kindPrefix)) return invalid('job kind filter is invalid')
    const jobs = await runner.list({
      ...(query.status !== undefined ? { status: query.status as HostJobView['status'] } : {}),
      ...(query.kindPrefix !== undefined ? { kindPrefix: query.kindPrefix } : {}),
      limit: integer(query.limit, 50, 1, HOST_JOB_LIST_MAX, 'limit'),
    })
    return json({ jobs })
  }
  if (action === 'log') {
    return json(await runner.readLog(id, integer(query.offset, 0, 0, HOST_JOB_LOG_CAP_BYTES, 'offset'), integer(query.limit, 65_536, 1, HOST_JOB_LOG_READ_MAX, 'limit')))
  }
  if (writing) {
    const job = await runner.cancel(id, actor, async () => {
      const fresh = await ctx.assertRoot('host.jobs.cancel')
      if (fresh.actor !== actor) fail('FORBIDDEN', 'job cancellation authority changed', { stateChanged: false })
    })
    return json({ job })
  }
  const job = await runner.get(id)
  if (!job) return fail('NOT_FOUND', 'host job not found', { stateChanged: false })
  return json({ job })
}
