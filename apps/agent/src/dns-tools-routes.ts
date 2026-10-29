import { fail, isXpanelError } from '@xpanel/core'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { HOST_JOB_ID_RE } from './host-jobs.ts'
import {
  DNS_CHECK_JOBS_MAX, DNS_CHECK_JOB_KIND, DNS_CHECK_ZONES_PER_JOB, buildDnsCheckPlans, checkDnsNameservers, compareDnsZones, dnsCheckJobSummary, hostAddresses, localAuthoritativeResolver,
  parseDnsCheckJob, readDnsCheckLog, savedDnsZones,
} from './dns-tools.ts'
import type { DnsToolsJobs, DnsToolsResolver, DnsToolsState } from './dns-tools.ts'
import type { ServiceDetailHost } from './service-detail.ts'

export interface DnsToolsAuditEntry { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }
export interface DnsToolsRouteContext {
  /** Re-authenticates the current caller and requires root on every call. */
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** Native Linux host executor only; null keeps every route unavailable instead of simulating PowerDNS. */
  host: ServiceDetailHost | null
  readState: () => Promise<DnsToolsState>
  jobs: DnsToolsJobs | null
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  resolver?: DnsToolsResolver
  localAddresses?: () => readonly string[]
  audit?: (entry: DnsToolsAuditEntry) => Promise<unknown>
  now?: () => Date
}

const ROUTE = /^\/host\/dns-tools\/(check-jobs|compare|nameservers)(?:\/([^/]+))?$/
const unchanged = { stateChanged: false }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** Root-only DNS tools: paged check-zone host jobs, published-versus-saved comparison and nameserver checks against the local listener. */
export async function handleDnsToolsRoute(req: Request, url: URL, method: string, ctx: DnsToolsRouteContext): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match || match[2] !== undefined && match[1] !== 'check-jobs') return null
  const [, tool, id] = match, submitting = tool === 'check-jobs' && id === undefined && method === 'POST'
  const action = submitting ? 'dns.tools.check' : 'dns.tools.read'
  const { actor } = await ctx.assertRoot(action)
  const allow = tool === 'check-jobs' && id === undefined ? 'GET, POST' : 'GET'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  const paged = tool !== 'check-jobs', query = [...url.searchParams]
  if (paged ? query.length !== 1 || query[0]![0] !== 'page' || !/^[1-9][0-9]{0,3}$/.test(query[0]![1]) : url.search) return fail('VALIDATION', paged ? 'exactly one page number is required' : 'check jobs do not accept selectors', unchanged)
  if (id !== undefined && !HOST_JOB_ID_RE.test(id)) return fail('VALIDATION', 'a lowercase job id is required', unchanged)
  if (submitting) {
    const body = await req.text()
    if (body.length > 64) return fail('VALIDATION', 'check jobs accept only an empty JSON object', unchanged)
    let parsed: unknown = {}
    try { if (body.trim()) parsed = JSON.parse(body) } catch { parsed = null }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length) return fail('VALIDATION', 'check jobs accept only an empty JSON object', unchanged)
  }
  const host = ctx.host
  if (!host) return fail('PRECONDITION_FAILED', 'DNS tools require the native Linux host executor', unchanged)
  const confirm = async (): Promise<string> => {
    const fresh = await ctx.assertRoot(action)
    return fresh.actor === actor ? actor : fail('FORBIDDEN', 'DNS tools authority changed', unchanged)
  }
  const read = async (): Promise<DnsToolsState> => { try { return await ctx.readState() } catch { return fail('PRECONDITION_FAILED', 'saved DNS state could not be read', unchanged) } }

  if (paged) {
    const state = await read(), resolver = ctx.resolver ?? localAuthoritativeResolver(), pageNumber = Number(query[0]![1]), now = ctx.now ? { now: ctx.now } : {}
    const result = tool === 'compare' ? await compareDnsZones({ host, state, resolver, page: pageNumber, ...now })
      : await checkDnsNameservers({ state, resolver, localAddresses: ctx.localAddresses ?? hostAddresses, page: pageNumber, ...now })
    await confirm()
    return json(result)
  }
  const jobs = ctx.jobs
  if (!submitting) {
    if (!jobs) return fail('SERVICE_UNAVAILABLE', 'the host job runner is unavailable on this agent', { ...unchanged, reason: 'host_job_runner_unavailable' })
    if (id === undefined) {
      const listed = (await jobs.list({ kindPrefix: DNS_CHECK_JOB_KIND, limit: DNS_CHECK_JOBS_MAX })).filter(job => job.kind === DNS_CHECK_JOB_KIND)
      await confirm()
      return json({ jobs: listed.map(dnsCheckJobSummary) })
    }
    const job = await jobs.get(id)
    if (!job || job.kind !== DNS_CHECK_JOB_KIND) return fail('NOT_FOUND', 'DNS check job not found', unchanged)
    const log = await readDnsCheckLog(jobs, id).catch(() => null)
    const results = await parseDnsCheckJob(job, log?.text ?? '')
    await confirm()
    return json({ job: dnsCheckJobSummary(job), logAvailable: !!log, logTruncated: log?.truncated ?? false, results })
  }

  if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable, so nothing was started', unchanged)
  const zones = savedDnsZones(await read()).map(zone => zone.name), limit = DNS_CHECK_ZONES_PER_JOB * DNS_CHECK_JOBS_MAX
  if (!zones.length) return fail('PRECONDITION_FAILED', 'no saved DNS zones exist, so nothing was started', { ...unchanged, reason: 'no_zones' })
  const plans = buildDnsCheckPlans(zones.slice(0, limit))
  const current = await confirm()
  const queued: { id: string; kind: string; status: string; zones: number }[] = []
  let incomplete = false
  for (const plan of plans) {
    try { const job = await ctx.submitJob(plan, current); queued.push({ id: job.id, kind: job.kind, status: job.status, zones: plan.steps.length }) } catch (error) {
      if (!queued.length) {
        if (isXpanelError(error)) throw error
        return fail('SERVICE_UNAVAILABLE', 'job submission outcome is unknown; review host jobs before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
      }
      incomplete = true
      break
    }
  }
  await ctx.audit?.({ actor: current, action: 'dns.tools.check_submitted', target: 'zones:' + zones.length, outcome: incomplete ? 'failed' : 'ok', detail: { jobIds: queued.map(job => job.id), incomplete } }).catch(() => {})
  return json({ jobs: queued, zones: zones.length, notQueued: Math.max(0, zones.length - limit), incomplete }, 202)
}
