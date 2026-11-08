import { fail } from '@xpanel/core'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import { edge } from '@xpanel/render'
import type { AgentCallerIdentity } from './server.ts'
import { GEOIP_SOURCE } from './geoip.ts'
import { WEBALIZER_FILE, entitledEngines } from './web-stats.ts'
import type { EngineRun, WebStats } from './web-stats.ts'
import { WEB_STATS_ENGINES, WEB_STATS_SCHEMES, isStatsSiteName } from './web-stats-format.ts'
import { choosableEngines, selectedEngines, webStatsRevision } from './web-stats-config.ts'
import type { AwstatsMonth, WebStatsEngine, WebStatsGenerator, WebStatsScheme } from './web-stats-format.ts'
import type { BandwidthReport } from './metering.ts'

export interface WebStatsRouteDeps {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; listDomains(filter: { accountId: string }): Promise<Domain[]>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  /** Null off a native host. */
  stats: WebStats | null
  now?: () => Date
}

export interface WebStatsMonthTotals { month: string; visits: number; unique: number; pages: number; hits: number; bytes: number; lastUpdate: string | null }
export interface WebStatsSchemeView { awstats: EngineRun | null; webalizer: EngineRun | null; droppedLines: number; lostBytes: number; pendingBytes: number }
export interface WebStatsView {
  context: { accountId: string; username: string }
  observedAt: string
  engines: Record<WebStatsGenerator, { installed: boolean; entitled: boolean }>
  geoip: { installed: boolean; month: string | null; source: string }
  schedule: { intervalHours: number | null; lastRunAt: string | null; nextRunAt: string | null }
  /** Metrics Editor: the engines this user may switch and the saved configuration the view was read from. */
  choice: { choosable: WebStatsGenerator[]; revision: string | null }
  sites: { site: string; names: string[]; selected: WebStatsGenerator[]; schemes: Record<WebStatsScheme, WebStatsSchemeView> }[]
  selection: { site: string; scheme: WebStatsScheme; month: string } | null
  /** Kept AWStats months of the selection, newest first. */
  months: WebStatsMonthTotals[]
  report: AwstatsMonth | null
}

const ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/web-stats(?:\/webalizer\/(https?)\/([a-z0-9.-]{1,253})\/([a-z_0-9.]{1,40}))?$/
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

/** The signed-in account owner reads the statistics of its own sites; sites and files come from saved state and fixed names only. */
export async function handleWebStatsRoute(req: Request, url: URL, method: string, deps: WebStatsRouteDeps): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (req.body !== null) return fail('VALIDATION', 'web statistics reads accept no body', { stateChanged: false })
  const username = match[1]!, caller = deps.caller
  if (caller.role !== 'user' || !caller.accountId) return fail('FORBIDDEN', 'web statistics are read by the signed-in account owner', { stateChanged: false })
  const account = await deps.store.getAccountByUsername(username), principal = await deps.currentPrincipal()
  if (!account || account.id !== caller.accountId || account.status !== 'active' || !principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== account.id || principal.username !== account.username) return fail('FORBIDDEN', 'the current account owner is not authorized', { stateChanged: false })
  const plan = await deps.store.getPlan(account.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
  const entitled = entitledEngines(features)
  if (!WEB_STATS_ENGINES.some(engine => entitled[engine])) return fail('FORBIDDEN', 'web statistics are disabled by the account plan', { stateChanged: false })
  let groups: ReturnType<typeof edge.groupSites>
  try { groups = edge.groupSites(account, await deps.store.listDomains({ accountId: account.id })) } catch { return fail('PRECONDITION_FAILED', 'the saved site configuration requires review', { stateChanged: false }) }
  const sites = groups.map(group => group.main.name).filter(isStatsSiteName)

  if (match[2]) {
    const scheme = match[2] as WebStatsScheme, site = match[3]!, file = match[4]!
    if (url.search) return fail('VALIDATION', 'report files accept no selectors', { stateChanged: false })
    if (!entitled.webalizer) return fail('FORBIDDEN', 'Webalizer is disabled by the account plan', { stateChanged: false })
    if (!sites.includes(site) || !WEBALIZER_FILE.test(file)) return fail('NOT_FOUND', 'report file not found', { stateChanged: false })
    if (!deps.stats || !deps.stats.engines().webalizer) return fail('PRECONDITION_FAILED', 'Webalizer is not installed on this server', { stateChanged: false, reason: 'web_stats_engine_unavailable' })
    const bytes = await deps.stats.readWebalizerFile(account, site, scheme, file)
    if (!bytes) return fail('NOT_FOUND', 'report file not found', { stateChanged: false })
    return Response.json({ context: { accountId: account.id, site, scheme, file }, contentType: file.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8', base64: bytes.toString('base64') }, { headers: { 'cache-control': 'no-store' } })
  }

  for (const name of url.searchParams.keys()) if (!['site', 'scheme', 'month'].includes(name) || url.searchParams.getAll(name).length !== 1) return fail('VALIDATION', 'unknown or repeated selector', { stateChanged: false })
  const site = url.searchParams.get('site') ?? sites[0] ?? null, scheme = (url.searchParams.get('scheme') ?? 'http') as WebStatsScheme
  const now = deps.now?.() ?? new Date(), month = url.searchParams.get('month') ?? now.toISOString().slice(0, 7)
  if (!(WEB_STATS_SCHEMES as readonly string[]).includes(scheme) || !MONTH.test(month)) return fail('VALIDATION', 'invalid scheme or month', { stateChanged: false })
  if (site !== null && !sites.includes(site)) return fail('NOT_FOUND', 'site not found', { stateChanged: false })
  const [reports, status, geoip, config] = await Promise.all([deps.stats?.reports(account.id) ?? null, deps.stats?.status() ?? null, deps.stats?.geoipStatus().catch(() => null) ?? null, deps.stats?.config() ?? null])
  const installed = deps.stats?.engines() ?? { awstats: null, webalizer: null }
  const view: WebStatsView = {
    context: { accountId: account.id, username: account.username },
    observedAt: now.toISOString(),
    // Analog is the panel's own traffic report, so it needs no program.
    engines: { analog: { installed: true, entitled: entitled.analog }, awstats: { installed: !!installed.awstats, entitled: entitled.awstats }, webalizer: { installed: !!installed.webalizer, entitled: entitled.webalizer } },
    geoip: { installed: geoip?.installed === true, month: geoip?.month ?? null, source: GEOIP_SOURCE },
    schedule: { intervalHours: config?.policy.intervalHours ?? null, lastRunAt: status?.lastRunAt ?? null, nextRunAt: status?.nextRunAt ?? null },
    choice: { choosable: config ? choosableEngines(config, account) : [], revision: config ? webStatsRevision(config) : null },
    sites: groups.filter(group => isStatsSiteName(group.main.name)).map(group => ({
      site: group.main.name, names: group.names.slice(0, 100), selected: config ? selectedEngines(config, account, group.main.name) : [],
      schemes: Object.fromEntries(WEB_STATS_SCHEMES.map(s => {
        const report = reports?.sites[group.main.name]?.[s], spool = status?.spools[`${account.id}/${group.main.name}/${s}`]
        return [s, { awstats: report?.awstats ?? null, webalizer: report?.webalizer ?? null, droppedLines: (report?.droppedLines ?? 0) + (spool?.dropped ?? 0), lostBytes: (report?.lostBytes ?? 0) + (spool?.lostBytes ?? 0), pendingBytes: spool?.bytes ?? 0 }]
      })) as Record<WebStatsScheme, WebStatsSchemeView>,
    })),
    selection: site === null ? null : { site, scheme, month },
    months: site === null ? [] : Object.values(reports?.sites[site]?.[scheme]?.months ?? {}).map(m => ({ month: m.month, visits: m.visits, unique: m.unique, pages: m.pages, hits: m.hits, bytes: m.bytes, lastUpdate: m.lastUpdate })).sort((a, b) => b.month.localeCompare(a.month)),
    report: site === null ? null : reports?.sites[site]?.[scheme]?.months[month] ?? null,
  }
  return Response.json(view, { headers: { 'cache-control': 'no-store' } })
}

export interface WebStatsHostStatusView {
  engines: Record<WebStatsEngine, boolean>
  geoip: { installed: boolean; month: string | null }
  lastRunAt: string | null; nextRunAt: string | null; running: boolean
  /** The meter's last recorded collection; null when it cannot be read. */
  bandwidth: { lastCollectedAt: string | null; pendingBytes: number } | null
  /** Accounts with lines waiting past the interval; minutes null means never processed. */
  behind: { username: string; minutes: number | null; pendingBytes: number }[]
}
export interface WebStatsHostRouteDeps {
  /** Re-authenticates the caller and requires root on every call. */
  assertRoot: (action: string) => Promise<unknown>
  store: { listAccounts(): Promise<readonly Account[]>; getAccountByUsername(username: string): Promise<Account | null> }
  stats: WebStats | null
  bandwidth: { report(): Promise<BandwidthReport> } | null
  now?: () => Date
}
const BEHIND_ROWS_MAX = 200

/** Root status of the statistics runs, and process-now for one saved account, in the background. */
export async function handleWebStatsHostRoute(req: Request, url: URL, method: string, deps: WebStatsHostRouteDeps): Promise<Response | null> {
  if (url.pathname !== '/host/web-stats/status' && url.pathname !== '/host/web-stats/process') return null
  const process = url.pathname.endsWith('/process')
  if (method !== (process ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: process ? 'POST' : 'GET' } })
  await deps.assertRoot(process ? 'statistics.process' : 'statistics.read')
  if (url.search) return fail('VALIDATION', 'statistics routes accept no selectors', { stateChanged: false })
  if (!deps.stats) return fail('PRECONDITION_FAILED', 'statistics runs exist on a native host only', { stateChanged: false, reason: 'web_stats_engine_unavailable' })
  if (process) {
    let raw: unknown
    try { raw = await req.json() } catch { return fail('VALIDATION', 'valid JSON is required', { stateChanged: false }) }
    const username = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).username : undefined
    const account = typeof username === 'string' ? await deps.store.getAccountByUsername(username) : null
    if (!account) return fail('NOT_FOUND', 'account not found', { stateChanged: false })
    if (account.status !== 'active') return fail('PRECONDITION_FAILED', 'a suspended account keeps its lines until it is active again', { stateChanged: false, reason: 'web_stats_account_inactive' })
    if (!await deps.stats.config()) return fail('PRECONDITION_FAILED', 'saved statistics configuration requires review', { stateChanged: false, reason: 'web_stats_config_review' })
    if (!deps.stats.processNow(account.id)) return fail('CONFLICT', 'a statistics run is in progress; retry when it finishes', { stateChanged: false, reason: 'web_stats_run_active' })
    return Response.json({ username: account.username, state: 'started' }, { status: 202, headers: { 'cache-control': 'no-store' } })
  }
  const [status, geoip, config, accounts, metered] = await Promise.all([deps.stats.status(), deps.stats.geoipStatus().catch(() => null), deps.stats.config(), deps.store.listAccounts(), deps.bandwidth?.report().catch(() => null) ?? null])
  const now = (deps.now?.() ?? new Date()).getTime(), installed = deps.stats.engines(), intervalMinutes = (config?.policy.intervalHours ?? 0) * 60
  const behind = accounts.flatMap(account => {
    const pendingBytes = Object.entries(status.spools).reduce((sum, [key, spool]) => key.startsWith(account.id + '/') ? sum + spool.bytes : sum, 0)
    const last = status.accounts[account.id], late = last ? Math.floor((now - Date.parse(last)) / 60_000 - intervalMinutes) : null
    return account.status === 'active' && pendingBytes > 0 && (late === null || late > 0) ? [{ username: account.username, minutes: late, pendingBytes }] : []
  }).sort((a, b) => (b.minutes ?? Infinity) - (a.minutes ?? Infinity)).slice(0, BEHIND_ROWS_MAX)
  const view: WebStatsHostStatusView = { engines: { awstats: !!installed.awstats, webalizer: !!installed.webalizer }, geoip: { installed: geoip?.installed === true, month: geoip?.month ?? null }, lastRunAt: status.lastRunAt, nextRunAt: status.nextRunAt, running: status.running, bandwidth: metered ? { lastCollectedAt: metered.updatedAt, pendingBytes: metered.pendingBytes } : null, behind }
  return Response.json(view, { headers: { 'cache-control': 'no-store' } })
}
