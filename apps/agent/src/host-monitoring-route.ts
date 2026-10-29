import { fail, isXpanelError } from '@xpanel/core'
import { parseMonitoringLogQuery, parseMonitoringSignalRequest } from '../../../packages/os/src/monitoring-command.ts'
import { readDisk, readLogs, readProcesses, signalProcess } from './host-monitoring.ts'
import type { MonitoringAccount, MonitoringRun } from './host-monitoring.ts'

export interface HostMonitoringCaller { principalId: string; actor: string; role: string }
export interface HostMonitoringRouteContext<C extends HostMonitoringCaller = HostMonitoringCaller> {
  caller: C
  /** Re-reads the principal from the control database (authenticateCaller). */
  reauthenticate: () => Promise<C>
  assertRoot: (caller: C, target: string) => Promise<void>
  /** Present only with the native Linux executor; reviewed argv only. */
  run?: MonitoringRun
  readFile?: (path: string) => Promise<string | null>
  listAccounts: () => Promise<readonly MonitoringAccount[]>
  audit: (entry: { actor: string; principalId: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed' }) => Promise<unknown>
  self?: { pid: number; ppid: number }
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

const ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; target: string }>> = {
  '/host/monitoring/processes': { method: 'GET', target: 'host.monitoring.processes' },
  '/host/monitoring/disk': { method: 'GET', target: 'host.monitoring.disk' },
  '/host/monitoring/logs': { method: 'GET', target: 'host.monitoring.logs' },
  '/host/monitoring/processes/signal': { method: 'POST', target: 'host.monitoring.processes.signal' },
}
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const observedNow = (ctx: { now?: () => Date }): string => (ctx.now ?? (() => new Date()))().toISOString()
/** An authority refusal happens before any host effect; say so for the API's mutation mapping. */
const beforeEffect = async <T>(check: () => Promise<T>): Promise<T> => {
  try { return await check() } catch (error) { if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, stateChanged: false }); throw error }
}

/** Root-only host monitoring reads and one identity-bound process signal. Returns null for other paths. */
export async function handleHostMonitoringRoute<C extends HostMonitoringCaller>(req: Request, url: URL, method: string, ctx: HostMonitoringRouteContext<C>): Promise<Response | null> {
  const route = ROUTES[url.pathname]
  if (!route) return null
  await beforeEffect(() => ctx.assertRoot(ctx.caller, route.target))
  if (method !== route.method) return new Response(null, { status: 405, headers: { allow: route.method } })
  const self = ctx.self ?? { pid: process.pid, ppid: process.ppid }
  if (url.pathname === '/host/monitoring/logs') {
    const query = parseMonitoringLogQuery(url.searchParams)
    if (!ctx.run) return json({ state: 'unavailable', unit: query.unit, lines: query.lines, since: query.since, priority: query.priority, observedAt: observedNow(ctx), order: 'newest-first', truncated: false, items: [], reason: 'journal-unavailable' })
    return json(await readLogs(ctx.run, query, ctx.now))
  }
  if (url.search) return fail('VALIDATION', 'host monitoring does not accept selectors here', { stateChanged: false })
  if (url.pathname === '/host/monitoring/processes') {
    if (!ctx.run) return json({ state: 'unavailable', observedAt: observedNow(ctx), total: 0, truncated: false, items: [], accounts: [], reason: 'process-list-unavailable' })
    return json(await readProcesses(ctx.run, await ctx.listAccounts(), self, ctx.now))
  }
  if (url.pathname === '/host/monitoring/disk') {
    if (!ctx.run) return json({ observedAt: observedNow(ctx), filesystems: { state: 'unavailable', items: [], inodes: 'unavailable', reason: 'filesystems-unavailable' }, accounts: { state: 'unavailable', source: 'repquota', mount: null, items: [], reason: 'quota-mount-unavailable' } })
    return json(await readDisk(ctx.run, ctx.readFile, await ctx.listAccounts(), ctx.now))
  }
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  let body: unknown
  try { body = await req.json() } catch { return fail('VALIDATION', 'request body must be valid JSON', { stateChanged: false }) }
  const request = parseMonitoringSignalRequest(body)
  if (!ctx.run) return fail('PRECONDITION_FAILED', 'process signals require the native Linux host executor', { stateChanged: false })
  const target = 'process:' + String(request.pid)
  const detail = { pid: request.pid, uid: request.uid, comm: request.comm, signal: request.signal }
  let actor = ctx.caller
  const outcome = await signalProcess(ctx.run, request, {
    self, ...(ctx.now ? { now: ctx.now } : {}), ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    beforeDispatch: async () => {
      const fresh = await beforeEffect(() => ctx.reauthenticate())
      if (fresh.principalId !== ctx.caller.principalId || fresh.actor !== ctx.caller.actor) return fail('FORBIDDEN', 'process signal authority changed', { stateChanged: false })
      await beforeEffect(() => ctx.assertRoot(fresh, route.target))
      actor = fresh
      try { await ctx.audit({ actor: fresh.actor, principalId: fresh.principalId, action: 'host.process.signal_requested', target, detail, outcome: 'ok' }) }
      catch { return fail('PRECONDITION_FAILED', 'the process signal could not be audited before dispatch', { stateChanged: false }) }
    },
  })
  try { await ctx.audit({ actor: actor.actor, principalId: actor.principalId, action: 'host.process.signal', target, detail: { ...detail, state: outcome.state, commandOk: outcome.commandOk }, outcome: outcome.state === 'confirmed' ? 'ok' : 'failed' }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the process signal outcome requires audit review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  return json(outcome)
}
