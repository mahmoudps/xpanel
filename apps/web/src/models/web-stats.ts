// Account-scoped web statistics (AWStats and Webalizer runs) as the agent reports them; both themes and the API read only this shape.

export type WebStatsEngine = 'awstats' | 'webalizer'
/** Analog is the edge-log traffic report: it has a switch and no run of its own. */
export type WebStatsGenerator = WebStatsEngine | 'analog'
export type WebStatsScheme = 'http' | 'https'
export type WebStatsRunState = 'updated' | 'failed' | 'unavailable' | 'not-entitled' | 'not-selected'
export interface WebStatsRun { state: WebStatsRunState; at: string; reason?: string }
export interface WebStatsSchemeState { awstats: WebStatsRun | null; webalizer: WebStatsRun | null; droppedLines: number; lostBytes: number; pendingBytes: number }
export interface WebStatsMonthTotals { month: string; visits: number; unique: number; pages: number; hits: number; bytes: number; lastUpdate: string | null }
export interface WebStatsReport extends WebStatsMonthTotals {
  days: [string, number, number, number, number][]
  hours: [number, number, number, number][]
  countries: [string, number, number, number][]
  os: [string, number][]
  browsers: [string, number][]
  status: [string, number, number][]
  urls: [string, number, number, number, number][]
  referrers: [string, number, number][]
  robots: [string, number, number][]
}
export interface WebStatsView {
  context: { accountId: string; username: string }
  observedAt: string
  engines: Record<WebStatsGenerator, { installed: boolean; entitled: boolean }>
  geoip: { installed: boolean; month: string | null; source: string }
  schedule: { intervalHours: number | null; lastRunAt: string | null; nextRunAt: string | null }
  choice: { choosable: WebStatsGenerator[]; revision: string | null }
  sites: { site: string; names: string[]; selected: WebStatsGenerator[]; schemes: Record<WebStatsScheme, WebStatsSchemeState> }[]
  selection: { site: string; scheme: WebStatsScheme; month: string } | null
  months: WebStatsMonthTotals[]
  report: WebStatsReport | null
}

/** The agent's root status of the statistics runs. */
export interface WebStatsHostStatus {
  engines: Record<WebStatsEngine, boolean>
  geoip: { installed: boolean; month: string | null }
  lastRunAt: string | null; nextRunAt: string | null; running: boolean
  bandwidth: { lastCollectedAt: string | null; pendingBytes: number } | null
  behind: { username: string; minutes: number | null; pendingBytes: number }[]
}

export const WEB_STATS_ENGINES: readonly WebStatsEngine[] = ['awstats', 'webalizer']
export const WEB_STATS_GENERATORS: readonly WebStatsGenerator[] = ['analog', ...WEB_STATS_ENGINES]
export const WEB_STATS_SCHEMES: readonly WebStatsScheme[] = ['http', 'https']
export const WEB_STATS_ROWS_MAX = 31

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const instant = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v))
const month = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v)
const site = (v: unknown): v is string => typeof v === 'string' && v.length <= 253 && /^[a-z0-9*.-]+$/.test(v)
const key = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)
const run = (v: unknown): v is WebStatsRun | null => v === null || record(v) && ['updated', 'failed', 'unavailable', 'not-entitled', 'not-selected'].includes(v.state as string) && instant(v.at) && (v.reason === undefined || key(v.reason, 200))
const engineList = (v: unknown): v is WebStatsGenerator[] => Array.isArray(v) && v.length <= WEB_STATS_GENERATORS.length && v.every(e => WEB_STATS_GENERATORS.includes(e))
const scheme = (v: unknown): v is WebStatsSchemeState => record(v) && run(v.awstats) && run(v.webalizer) && count(v.droppedLines) && count(v.lostBytes) && count(v.pendingBytes)
const totals = (v: unknown): v is WebStatsMonthTotals => record(v) && month(v.month) && count(v.visits) && count(v.unique) && count(v.pages) && count(v.hits) && count(v.bytes) && (v.lastUpdate === null || instant(v.lastUpdate))
const rows = (v: unknown, width: number, keyed: (k: unknown) => boolean): boolean => Array.isArray(v) && v.length <= WEB_STATS_ROWS_MAX
  && v.every(row => Array.isArray(row) && row.length === width && keyed(row[0]) && row.slice(1).every(count))
const report = (raw: unknown): raw is WebStatsReport => { const v = raw as Record<string, unknown>; return totals(raw)
  && rows(v.days, 5, k => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k)) && rows(v.hours, 4, k => count(k) && (k as number) < 24)
  && rows(v.countries, 4, k => key(k, 64)) && rows(v.os, 2, k => key(k, 64)) && rows(v.browsers, 2, k => key(k, 64)) && rows(v.status, 3, k => typeof k === 'string' && /^\d{3}$/.test(k))
  && rows(v.urls, 5, k => key(k)) && rows(v.referrers, 3, k => key(k)) && rows(v.robots, 3, k => key(k, 64)) }

/** The reply for one account, or null when any part is malformed or belongs to another account. */
export function parseWebStatsView(raw: unknown, owner: { accountId: string; username?: string }): WebStatsView | null {
  if (!record(raw) || !record(raw.context) || raw.context.accountId !== owner.accountId || owner.username !== undefined && raw.context.username !== owner.username || !instant(raw.observedAt)) return null
  const engines = raw.engines, geoip = raw.geoip, schedule = raw.schedule
  if (!record(engines) || !WEB_STATS_GENERATORS.every(e => record(engines[e]) && typeof engines[e].installed === 'boolean' && typeof engines[e].entitled === 'boolean')) return null
  if (!record(geoip) || typeof geoip.installed !== 'boolean' || !(geoip.month === null || month(geoip.month)) || !key(geoip.source, 100)) return null
  if (!record(raw.choice) || !engineList(raw.choice.choosable) || !(raw.choice.revision === null || typeof raw.choice.revision === 'string' && /^[0-9a-f]{64}$/.test(raw.choice.revision))) return null
  if (!record(schedule) || !(schedule.intervalHours === null || typeof schedule.intervalHours === 'number' && schedule.intervalHours > 0) || !(schedule.lastRunAt === null || instant(schedule.lastRunAt)) || !(schedule.nextRunAt === null || instant(schedule.nextRunAt))) return null
  if (!Array.isArray(raw.sites) || raw.sites.length > 2000 || !raw.sites.every(s => record(s) && site(s.site) && Array.isArray(s.names) && s.names.length <= 100 && s.names.every(site) && engineList(s.selected) && record(s.schemes) && scheme(s.schemes.http) && scheme(s.schemes.https))) return null
  const selection = raw.selection
  if (!(selection === null || record(selection) && site(selection.site) && (selection.scheme === 'http' || selection.scheme === 'https') && month(selection.month) && raw.sites.some(s => s.site === selection.site))) return null
  if (!Array.isArray(raw.months) || raw.months.length > 24 || !raw.months.every(totals) || !(raw.report === null || report(raw.report))) return null
  return raw as unknown as WebStatsView
}

/** The status reply for root, or null when any part is malformed. */
export function parseWebStatsHostStatus(raw: unknown): WebStatsHostStatus | null {
  if (!record(raw) || !record(raw.engines) || typeof raw.engines.awstats !== 'boolean' || typeof raw.engines.webalizer !== 'boolean' || !record(raw.geoip) || typeof raw.geoip.installed !== 'boolean' || !(raw.geoip.month === null || month(raw.geoip.month))) return null
  if (!(raw.lastRunAt === null || instant(raw.lastRunAt)) || !(raw.nextRunAt === null || instant(raw.nextRunAt)) || typeof raw.running !== 'boolean') return null
  if (!(raw.bandwidth === null || record(raw.bandwidth) && (raw.bandwidth.lastCollectedAt === null || instant(raw.bandwidth.lastCollectedAt)) && count(raw.bandwidth.pendingBytes))) return null
  if (!Array.isArray(raw.behind) || raw.behind.length > 200 || !raw.behind.every(row => record(row) && typeof row.username === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(row.username) && (row.minutes === null || count(row.minutes)) && count(row.pendingBytes))) return null
  return raw as unknown as WebStatsHostStatus
}

/** Source text for an engine's last run, shared by both themes. */
export const webStatsRunLabel = (run: WebStatsRun | null): string => run === null ? msgid('Not generated yet')
  : run.state === 'updated' ? msgid('Updated') : run.state === 'failed' ? msgid('Last run failed') : run.state === 'unavailable' ? msgid('Not installed on this server') : run.state === 'not-selected' ? msgid('Turned off for this site') : msgid('Not included in your plan')
/** The engine's own report page, served by the panel as a sandboxed document. */
export const webalizerReportHref = (site: string, scheme: WebStatsScheme): string => `/api/account/web-stats/webalizer/${scheme}/${encodeURIComponent(site)}/index.html`
