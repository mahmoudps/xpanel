import { fail } from '@xpanel/core'
import { latestActive, listMetricsHistory } from '@xpanel/db'
import type { Db, MetricsSample } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertExpectedRevision, exactKeys, panelConfigFile, panelConfigRevision, panelJson, readPanelConfigBody } from './panel-config-file.ts'
import { canonicalIp } from '../../../packages/os/src/network-tools-command.ts'

/**
 * OpenMetrics scrape of the samples the agent already stores: the latest host row and the latest row per account.
 * A scrape adds a few index reads and no collection. The switch and the optional source list live in a root file;
 * the token is an ordinary panel API token limited to metrics:read.
 */
export interface MetricsExportConfig { enabled: boolean; allow: string[] }
export const METRICS_ROUTE = '/api/metrics'
const SETTINGS_ROUTE = '/api/server/metrics-export', NAMESPACE = 'metrics-export'
const unchanged = { stateChanged: false }
const MAX_ALLOW = 32
const metricsFile = (store: Pick<StateStore, 'rootDir' | 'getWriterLock'>) => panelConfigFile(store, 'metrics-export.json', NAMESPACE, parseMetricsConfig, () => ({ enabled: false, allow: [] }))

export function parseMetricsConfig(raw: unknown): MetricsExportConfig | null {
  if (!raw || typeof raw !== 'object' || !exactKeys(raw as Record<string, unknown>, ['enabled', 'allow'])) return null
  const { enabled, allow } = raw as Record<string, unknown>
  if (typeof enabled !== 'boolean' || !Array.isArray(allow) || allow.length > MAX_ALLOW || !allow.every(item => typeof item === 'string' && canonicalIp(item)?.address === item)) return null
  return { enabled, allow: allow as string[] }
}

const label = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
type Line = readonly [labels: Record<string, string>, value: number]
const family = (name: string, kind: 'gauge' | 'counter', help: string, unit: string, lines: readonly Line[]): string[] => lines.length === 0 ? [] : [
  `# TYPE ${name} ${kind}`, ...(unit ? [`# UNIT ${name} ${unit}`] : []), `# HELP ${name} ${help}`,
  ...lines.map(([labels, value]) => { const text = Object.entries(labels).map(([key, item]) => `${key}="${label(item)}"`).join(','); return `${name}${text ? `{${text}}` : ''} ${value}` }),
]

export interface MetricsFacts {
  host: MetricsSample | null; accounts: { username: string; sample: MetricsSample; limits: { memoryMb: number | null; cpuPercent: number | null; maxProcesses: number | null } }[]
  generation: number | null; services: { name: string; up: boolean }[]
}
/** OpenMetrics 1.0 text. A value the sample does not hold is left out, never reported as zero. */
export function renderOpenMetrics(facts: MetricsFacts): string {
  const o = facts.host?.hostObservation
  const one = (value: number | null | undefined): Line[] => value === null || value === undefined ? [] : [[{}, value]]
  const each = (read: (row: MetricsFacts['accounts'][number]) => number | null): Line[] => facts.accounts.flatMap(row => { const value = read(row); return value === null ? [] : [[{ account: row.username }, value] as const] })
  return [
    ...family('xpanel_cpu_usage_percent', 'gauge', 'Whole host CPU busy share.', 'percent', one(o?.cpuPercent)),
    ...family('xpanel_load1', 'gauge', 'One minute load average.', '', one(o?.load1)),
    ...family('xpanel_load5', 'gauge', 'Five minute load average.', '', one(o?.load5)),
    ...family('xpanel_load15', 'gauge', 'Fifteen minute load average.', '', one(o?.load15)),
    ...family('xpanel_memory_total_bytes', 'gauge', 'Host memory total.', 'bytes', one(o?.memoryTotalBytes)),
    ...family('xpanel_memory_available_bytes', 'gauge', 'Host memory available.', 'bytes', one(o?.memoryAvailableBytes)),
    ...family('xpanel_disk_total_bytes', 'gauge', 'State disk total.', 'bytes', one(o?.diskTotalBytes)),
    ...family('xpanel_disk_used_bytes', 'gauge', 'State disk used.', 'bytes', one(o?.diskUsedBytes)),
    ...family('xpanel_processes', 'gauge', 'Host process count.', '', one(o?.processes)),
    ...family('xpanel_service_up', 'gauge', 'One when the service is active.', '', facts.services.map(service => [{ service: service.name }, service.up ? 1 : 0] as const)),
    ...family('xpanel_reconcile_generation', 'gauge', 'Active configuration generation.', '', one(facts.generation)),
    ...family('xpanel_account_cpu_percent', 'gauge', 'Account slice CPU share.', 'percent', each(row => row.sample.cpuPercent)),
    ...family('xpanel_account_memory_bytes', 'gauge', 'Account slice memory.', 'bytes', each(row => row.sample.memoryMb * 1048576)),
    ...family('xpanel_account_disk_bytes', 'gauge', 'Account disk use.', 'bytes', each(row => row.sample.diskMb * 1048576)),
    ...family('xpanel_account_bandwidth_bytes', 'gauge', 'Account bandwidth in the sample.', 'bytes', each(row => row.sample.bandwidthBytes)),
    ...family('xpanel_account_io_read_bytes_per_second', 'gauge', 'Account read rate.', '', each(row => row.sample.ioReadBps)),
    ...family('xpanel_account_io_write_bytes_per_second', 'gauge', 'Account write rate.', '', each(row => row.sample.ioWriteBps)),
    ...family('xpanel_account_processes', 'gauge', 'Account process count.', '', each(row => row.sample.processes)),
    ...family('xpanel_account_memory_limit_bytes', 'gauge', 'Plan memory limit.', 'bytes', each(row => row.limits.memoryMb === null ? null : row.limits.memoryMb * 1048576)),
    ...family('xpanel_account_cpu_limit_percent', 'gauge', 'Plan CPU limit.', 'percent', each(row => row.limits.cpuPercent)),
    ...family('xpanel_account_processes_limit', 'gauge', 'Plan process limit.', '', each(row => row.limits.maxProcesses)),
    '# EOF', '',
  ].join('\n')
}

export interface MetricsExportHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: StateStore
  db: Db
  clientIp: (request: Request) => string | null
  /** Service states from the agent's existing health read; empty when it cannot answer. */
  readServices: (caller: AuthenticatedCaller) => Promise<{ name: string; up: boolean }[]>
}
const limitOf = (value: unknown): number | null => typeof value === 'number' ? value : null

export async function handleMetricsExportRoute(request: Request, url: URL, method: string, helpers: MetricsExportHelpers): Promise<Response | null> {
  if (url.pathname === METRICS_ROUTE) {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const caller = await helpers.requireCaller(request)
    await helpers.assertRoot(caller, 'metrics.scrape')
    if (url.search) return fail('VALIDATION', 'the metrics endpoint accepts no selectors', unchanged)
    const config = await metricsFile(helpers.store).current()
    if (!config.enabled) return fail('PRECONDITION_FAILED', 'the metrics endpoint is turned off', { ...unchanged, reason: 'metrics_disabled' })
    if (config.allow.length && !config.allow.includes(canonicalIp(helpers.clientIp(request) ?? '')?.address ?? '')) return fail('FORBIDDEN', 'this source address may not read metrics', { ...unchanged, reason: 'metrics_source_refused' })
    const [host, accounts, generation, services] = await Promise.all([listMetricsHistory(helpers.db, { scope: 'host', limit: 1 }), helpers.store.listAccounts(), latestActive(helpers.db), helpers.readServices(caller).catch(() => [])])
    const rows = await Promise.all(accounts.slice(0, 10000).map(async account => {
      const [sample] = await listMetricsHistory(helpers.db, { scope: 'account', accountId: account.id, limit: 1 })
      if (!sample) return []
      const plan = await helpers.store.getPlan(account.planId)
      return [{ username: account.username, sample, limits: { memoryMb: limitOf(plan?.resources.memoryMb), cpuPercent: limitOf(plan?.resources.cpuPercent), maxProcesses: limitOf(plan?.resources.maxProcesses) } }]
    }))
    return new Response(renderOpenMetrics({ host: host[0] ?? null, accounts: rows.flat(), generation: generation ? Number(generation.id) : null, services }), { headers: { 'content-type': 'application/openmetrics-text; version=1.0.0; charset=utf-8', 'cache-control': 'no-store' } })
  }
  if (url.pathname !== SETTINGS_ROUTE) return null
  const action = method === 'PUT' ? 'server.metrics_export.save' : 'server.metrics_export.read'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (url.search) return fail('VALIDATION', 'metrics settings accept no selectors', unchanged)
  const file = metricsFile(helpers.store)
  const view = (saved: { raw: unknown; value: MetricsExportConfig | null }) => ({ config: saved.value, invalid: saved.value === null, revision: panelConfigRevision(NAMESPACE, saved.raw), path: METRICS_ROUTE, scope: 'metrics:read' })
  if (method === 'GET') { const saved = await file.read(); await helpers.assertRoot(await helpers.requireCaller(request), action); return panelJson(view(saved)) }
  if (method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
  const body = await readPanelConfigBody(request, 4096)
  if (!exactKeys(body, ['config', 'expectedRevision'])) return fail('VALIDATION', 'a config and the observed revision are required', unchanged)
  const expected = assertExpectedRevision(body.expectedRevision), config = parseMetricsConfig(body.config)
  if (!config) return fail('VALIDATION', 'the switch or a source address is invalid', { ...unchanged, reason: 'invalid_metrics_config' })
  const saved = await file.write(config, expected, async () => { await helpers.assertRoot(await helpers.requireCaller(request), action) })
  await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.metrics_export.saved', target: 'server:metrics-export', detail: { enabled: config.enabled, sources: config.allow.length }, outcome: 'ok' })
  return panelJson(view(saved))
}
