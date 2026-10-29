// Interactive SVG charts and dense resource ranking tables for Real-Time Server IO Monitor
// (cgroup v2 + Linux PSI) and Real-Time Website Traffic/Cache/Status Analytics.

import type {
  AccountIoRank,
  IoAnalyticsSnapshot,
  WebsiteAnalyticsSnapshot,
  WebsiteTopEntry,
  WebsiteTrafficBucket,
} from '@xpanel/core'
import { localeDirection, translator, type Locale, type MessageValues } from './i18n.ts'
import {
  escapeHtml,
  formatAsciiNumber,
  formatBytes,
  formatDisplayDateTime,
  getThresholdLevel,
  renderLtrValue,
  renderStatusBadge,
  renderThresholdMeter,
} from './tokens.ts'

const CHART_WIDTH = 760
const CHART_HEIGHT = 220
const PAD_LEFT = 48
const PAD_RIGHT = 24
const PAD_TOP = 20
const PAD_BOTTOM = 32

function buildSvgPolylineAndArea(
  values: number[],
  maxVal: number,
): { linePoints: string; areaPoints: string; coords: { x: number; y: number; value: number }[] } {
  const safeMax = maxVal > 0 ? maxVal : 1
  const plotW = CHART_WIDTH - PAD_LEFT - PAD_RIGHT
  const plotH = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM
  const baselineY = PAD_TOP + plotH

  const normalized =
    values.length === 0
      ? [0, 0]
      : values.length === 1
        ? [values[0] ?? 0, values[0] ?? 0]
        : values

  const stepX = plotW / Math.max(1, normalized.length - 1)
  const coords = normalized.map((raw, idx) => {
    const val = Number.isFinite(raw) && raw >= 0 ? raw : 0
    const ratio = Math.min(1, val / safeMax)
    const x = Math.round((PAD_LEFT + idx * stepX) * 10) / 10
    const y = Math.round((baselineY - ratio * plotH) * 10) / 10
    return { x, y, value: val }
  })

  const linePoints = coords.map((pt) => `${pt.x},${pt.y}`).join(' ')
  const firstX = coords[0]?.x ?? PAD_LEFT
  const lastX = coords[coords.length - 1]?.x ?? PAD_LEFT + plotW
  const areaPoints = `${firstX},${baselineY} ${linePoints} ${lastX},${baselineY}`

  return { linePoints, areaPoints, coords }
}

/** Accepted account-scoped traffic read windows; the same values the agent route accepts. */
export type WebsiteAnalyticsWindow = '1h' | '24h' | '7d' | '30d'

export const WEBSITE_ANALYTICS_WINDOWS: readonly WebsiteAnalyticsWindow[] = ['1h', '24h', '7d', '30d']

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null

const suppliedCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER

const suppliedInstant = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value))

const bucketKeys = [
  'requests', 'bytes', 'status2xx', 'status3xx', 'status4xx', 'status5xx',
  'cacheHit', 'cacheMiss', 'cacheBypass', 'avgRequestTimeMs', 'p95RequestTimeMs', 'avgUpstreamTimeMs',
] as const

const parseTrafficBucket = (value: unknown): WebsiteTrafficBucket | null => {
  const row = asRecord(value)
  if (!row || !suppliedInstant(row.at) || !bucketKeys.every(key => suppliedCount(row[key]))) return null
  return {
    at: row.at,
    requests: row.requests as number, bytes: row.bytes as number,
    status2xx: row.status2xx as number, status3xx: row.status3xx as number,
    status4xx: row.status4xx as number, status5xx: row.status5xx as number,
    cacheHit: row.cacheHit as number, cacheMiss: row.cacheMiss as number, cacheBypass: row.cacheBypass as number,
    avgRequestTimeMs: row.avgRequestTimeMs as number, p95RequestTimeMs: row.p95RequestTimeMs as number,
    avgUpstreamTimeMs: row.avgUpstreamTimeMs as number,
  }
}

const parseTopEntries = (value: unknown): WebsiteTopEntry[] | null => {
  if (!Array.isArray(value) || value.length > 500) return null
  const entries: WebsiteTopEntry[] = []
  for (const item of value) {
    const row = asRecord(item)
    if (!row || typeof row.key !== 'string' || row.key.length === 0 || row.key.length > 2048) return null
    if (!suppliedCount(row.requests) || !suppliedCount(row.bytes)) return null
    if (row.errors5xx !== undefined && !suppliedCount(row.errors5xx)) return null
    entries.push({ key: row.key, requests: row.requests, bytes: row.bytes, ...(row.errors5xx !== undefined ? { errors5xx: row.errors5xx } : {}) })
  }
  return entries
}

const totalKeys = [
  'requests', 'bytes', 'uniqueVisitors', 'cacheHitRatioPercent', 'errorRatePercent',
  'avgRequestTimeMs', 'p95RequestTimeMs', 'avgUpstreamTimeMs',
  'status2xx', 'status3xx', 'status4xx', 'status5xx',
] as const

/**
 * Strictly validates an account-scoped website analytics observation.
 * A malformed, foreign-account or partial response is unavailable, never repaired,
 * and an empty series stays an explicit empty observation rather than synthetic samples.
 */
export const parseWebsiteAnalyticsSnapshot = (
  input: unknown,
  expected: { domain?: string; accountId?: string } = {},
): WebsiteAnalyticsSnapshot | null => {
  const row = asRecord(input)
  if (!row || typeof row.domain !== 'string' || row.domain.length === 0 || row.domain.length > 253) return null
  if (row.accountId !== null && typeof row.accountId !== 'string') return null
  if (expected.domain !== undefined && row.domain !== expected.domain) return null
  if (expected.accountId !== undefined && row.accountId !== expected.accountId) return null
  if (!suppliedInstant(row.at)) return null
  const totals = asRecord(row.totals)
  if (!totals || !totalKeys.every(key => suppliedCount(totals[key]))) return null
  if ((totals.cacheHitRatioPercent as number) > 100 || (totals.errorRatePercent as number) > 100) return null
  if (!Array.isArray(row.series) || row.series.length > 2000) return null
  const series: WebsiteTrafficBucket[] = []
  for (const item of row.series) {
    const bucket = parseTrafficBucket(item)
    if (!bucket) return null
    series.push(bucket)
  }
  const topPaths = parseTopEntries(row.topPaths)
  const topReferrers = parseTopEntries(row.topReferrers)
  const topClientIps = parseTopEntries(row.topClientIps)
  if (topPaths === null || topReferrers === null || topClientIps === null) return null
  return {
    domain: row.domain, accountId: row.accountId as string | null, at: row.at,
    totals: Object.fromEntries(totalKeys.map(key => [key, totals[key]])) as WebsiteAnalyticsSnapshot['totals'],
    series, topPaths, topReferrers, topClientIps,
  }
}

const suppliedPositive = (value: number): number | undefined =>
  Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined

const suppliedPositiveCounter = (value: number): number | undefined => Number.isSafeInteger(value) ? suppliedPositive(value) : undefined

const suppliedRate = (value: number, divisor: number, unit: string, locale: Locale): string => {
  if (suppliedPositive(value) === undefined) return translator(locale)('Unavailable')
  const scaled = value / divisor
  // Preserve a positive supplied rate when binary-unit scaling underflows.
  return scaled === 0 && divisor === 1024 * 1024 ? `${formatAsciiNumber(value)} B/s` : `${formatAsciiNumber(scaled)} ${unit}`
}

function renderIoAccountRow(rank: AccountIoRank, locale: Locale): string {
  const text = (message: string, values?: MessageValues) => translator(locale)(message, values)
  const unavailable = text('Unavailable')
  const number = (value: number) => suppliedPositive(value) === undefined ? unavailable : formatAsciiNumber(value)
  const directional = (read: number, write: number, unit: string) => renderLtrValue(`R: ${number(read)} / W: ${number(write)} ${unit}`, 'xp-chart-technical-value')
  // Current producer zeroes cannot distinguish missing counters from measured zero.
  // Its unlimited fallback cannot distinguish a missing plan from explicit policy.
  const memoryLimit = typeof rank.memoryLimitMb === 'number' && Number.isSafeInteger(rank.memoryLimitMb) ? rank.memoryLimitMb : undefined
  const pidsLimit = typeof rank.pidsLimit === 'number' && Number.isSafeInteger(rank.pidsLimit) ? rank.pidsLimit : undefined
  const memory = suppliedPositiveCounter(rank.memoryCurrentBytes)
  return `<tr data-account-id="${escapeHtml(rank.accountId)}" data-uid="${rank.uid}">
    <td><strong>${escapeHtml(rank.username)}</strong><div class="xp-mono xp-tabular">${renderLtrValue(`xpanel-${rank.uid}.slice (UID ${rank.uid})`, 'xp-chart-technical-value')}</div></td>
    <td data-numeric="true" class="xp-tabular"><div class="xp-mono">${renderLtrValue(`R: ${suppliedRate(rank.readBytesPerSec, 1024 * 1024, 'MiB/s', locale)} / W: ${suppliedRate(rank.writeBytesPerSec, 1024 * 1024, 'MiB/s', locale)}`, 'xp-chart-technical-value')}</div></td>
    <td data-numeric="true" class="xp-tabular xp-mono">${directional(rank.readIops, rank.writeIops, 'IOPS')}</td>
    <td data-numeric="true" class="xp-tabular">${renderThresholdMeter(memory === undefined ? undefined : memory / (1024 * 1024), memoryLimit, { locale, unit: 'MiB', label: text('Memory'), configuredLimit: true })}</td>
    <td data-numeric="true" class="xp-tabular">${suppliedPositive(rank.cpuPercent) === undefined ? escapeHtml(unavailable) : renderLtrValue(`${formatAsciiNumber(rank.cpuPercent)}% (1 core)`, 'xp-chart-technical-value')}</td>
    <td data-numeric="true" class="xp-tabular">${renderThresholdMeter(suppliedPositiveCounter(rank.pidsCurrent), pidsLimit, { locale, unit: 'PIDs', label: text('Processes'), configuredLimit: true })}</td>
  </tr>`
}

/** Supplied account values and configured caps; no host observation or enforcement attestation. */
export function renderServerIoMonitorChart(snapshot: IoAnalyticsSnapshot, locale: Locale = 'en'): string {
  const text = (message: string, values?: MessageValues) => translator(locale)(message, values)
  const unavailable = text('Unavailable')
  const rate = (value: number, divisor: number, unit: string) => suppliedRate(value, divisor, unit, locale)
  const current = snapshot.current
  const kpi = (label: string, value: string, key?: string) => `<div class="xp-card xp-field"><div class="xp-label">${escapeHtml(label)}</div><div class="xp-kpi__value xp-tabular"${key ? ` data-resource-observation="${key}"` : ''}>${value === unavailable ? escapeHtml(value) : renderLtrValue(value)}</div></div>`
  const rows = snapshot.accounts.map(account => renderIoAccountRow(account, locale)).join('')
  // The old wire shape supplies synthetic defaults for host RAM/PSI/await and no
  // rate-availability metadata. Keep those observations unavailable until cutover.
  return `<style>.xp-io-monitor .xp-card>.xp-card__header{margin-block-end:var(--xp-space-group,24px)}.xp-io-monitor__history{gap:var(--xp-space-group,24px)}</style><section class="xp-io-monitor" dir="${localeDirection(locale)}" data-surface-widget="io-monitor" aria-label="${text('Resource usage')}">
    <header class="xp-card__header"><div><h2>${text('Resource usage')}</h2><p class="xp-prose">${text('Account resources and configured limits.')}</p></div><time class="xp-mono xp-tabular" datetime="${escapeHtml(snapshot.at)}">${renderLtrValue(formatDisplayDateTime(snapshot.at))}</time></header>
    <p class="xp-help" role="status" data-resource-observation-state="incomplete">${text('Some measurements are unavailable.')}</p>
    <div class="xp-kpi-grid">
      ${kpi(text('Account read total'), rate(current.readBytesPerSec, 1024 * 1024, 'MiB/s'), 'io-read')}
      ${kpi(text('Account write total'), rate(current.writeBytesPerSec, 1024 * 1024, 'MiB/s'), 'io-write')}
      ${kpi(text('Account IOPS total'), current.readIops > 0 && current.writeIops > 0 ? rate(current.readIops + current.writeIops, 1, 'IOPS') : unavailable, 'io-iops')}
      ${kpi(text('Disk latency'), unavailable)}
      ${kpi(text('IO pressure'), unavailable)}
      ${kpi(text('Host CPU and memory'), unavailable)}
    </div>
    <div class="xp-card xp-field xp-io-monitor__history"><h3>${text('Read and write history')}</h3><p class="xp-resource-history-unavailable" role="status">${escapeHtml(unavailable)}</p></div>
    <div class="xp-card"><div class="xp-card__header"><h3>${text('Account resources')}</h3></div><div class="xp-table-wrap"><table class="xp-table"><thead><tr>
      <th>${text('Account')}</th><th>${text('Read / write')}</th><th>IOPS</th><th>${text('Memory')}</th><th>${text('CPU (% of 1 core)')}</th><th>${text('Processes')}</th>
    </tr></thead><tbody>${rows || `<tr><td colspan="6">${escapeHtml(unavailable)}</td></tr>`}</tbody></table></div></div>
  </section>`
}

function renderTopEntriesTable(
  title: string,
  entries: WebsiteTopEntry[],
  locale: Locale,
): string {
  const rows =
    entries.length > 0
      ? entries
          .map((item) => {
            const err5xx = item.errors5xx ?? 0
            const errBadge =
              err5xx > 0
                ? renderStatusBadge('critical', `${err5xx} 5xx`)
                : renderStatusBadge('ok', '0 5xx')
            return (
              `<tr>` +
              `<td class="xp-mono xp-tabular">${renderLtrValue(item.key, 'xp-chart-technical-value')}</td>` +
              `<td data-numeric="true" class="xp-tabular">${item.requests.toLocaleString('en-US')}</td>` +
              `<td data-numeric="true" class="xp-tabular">${renderLtrValue(formatBytes(item.bytes), 'xp-chart-technical-value')}</td>` +
              `<td data-numeric="true" class="xp-tabular">${errBadge}</td>` +
              `</tr>`
            )
          })
          .join('')
      : `<tr><td colspan="4" style="text-align:center;color:var(--xp-text-muted);">${escapeHtml(translator(locale)('No records match the current filter.'))}</td></tr>`

  return (
    `<div class="xp-card">` +
    `<div class="xp-card__header"><strong>${escapeHtml(title)}</strong></div>` +
    `<div class="xp-table-wrap">` +
    `<table class="xp-table xp-table--compact">` +
    `<thead>` +
    `<tr>` +
    `<th>${escapeHtml(translator(locale)('Resource / Identifier'))}</th>` +
    `<th>${escapeHtml(translator(locale)('Requests'))}</th>` +
    `<th>${escapeHtml(translator(locale)(msgctxt('analytics', 'Bandwidth')))}</th>` +
    `<th>${escapeHtml(translator(locale)('5xx Faults'))}</th>` +
    `</tr>` +
    `</thead>` +
    `<tbody>${rows}</tbody>` +
    `</table>` +
    `</div>` +
    `</div>`
  )
}

const windowCopy = (window: WebsiteAnalyticsWindow, locale: Locale): string => {
  const labels: Record<WebsiteAnalyticsWindow, string> = {
    '1h': msgid('last hour'),
    '24h': msgid('last 24 hours'),
    '7d': msgid('last 7 days'),
    '30d': msgid('last 30 days'),
  }
  return translator(locale)(labels[window])
}

const analyticsShell = (
  snapshot: { domain: string; at: string },
  locale: Locale,
  state: 'loaded' | 'empty',
): { dir: string; open: string; close: string } => {
  const dir = localeDirection(locale)
  return {
    dir,
    open: `<style>.xp-website-analytics{display:flex;flex-direction:column;gap:var(--xp-space-group,24px);min-inline-size:0}.xp-website-analytics>.xp-card__header{margin-block-end:0}.xp-website-analytics .xp-card>.xp-card__header{margin-block-end:var(--xp-space-group,24px)}.xp-website-analytics>.xp-kpi-grid{align-items:start}.xp-website-analytics .xp-kpi__value{margin:0}</style><section class="xp-website-analytics" dir="${dir}" data-surface-widget="website-analytics" data-domain="${escapeHtml(snapshot.domain)}" data-chart-state="${state}" aria-label="${escapeHtml(translator(locale)('Real-Time Website Traffic, Cache & Upstream Analytics'))}">`,
    close: '</section>',
  }
}

const analyticsHeader = (
  snapshot: { domain: string; at: string },
  locale: Locale,
  window?: WebsiteAnalyticsWindow,
): string => {
  const text = (message: string, values?: MessageValues) => translator(locale)(message, values)
  const range = window
    ? `<p class="xp-help" data-analytics-range="${window}">${escapeHtml(text('Range: {value}.', { value: windowCopy(window, locale) }))}</p>`
    : ''
  return `<header class="xp-card__header"><div><h2 style="margin:0;font-size:1.2rem;">${escapeHtml(translator(locale)('Real-Time Website Traffic, Cache & Upstream Analytics'))} — <span class="xp-mono">${renderLtrValue(snapshot.domain)}</span></h2><p class="xp-prose" style="margin:8px 0 0;color:var(--xp-text-secondary);font-size:0.88rem;">${escapeHtml(translator(locale)('Derived incrementally from Nginx edge access logs without external tracking scripts.'))}</p>${range}</div><time class="xp-mono xp-tabular" datetime="${escapeHtml(snapshot.at)}">${renderLtrValue(formatDisplayDateTime(snapshot.at))}</time></header>`
}

const analyticsInvalid = (locale: Locale): string => {
  const text = (message: string, values?: MessageValues) => translator(locale)(message, values)
  return `<section class="xp-card xp-screen-state" dir="${localeDirection(locale)}" data-surface-widget="website-analytics" data-chart-state="unavailable" role="status"><h3>${escapeHtml(text('Traffic analytics unavailable'))}</h3><p class="xp-prose">${escapeHtml(text('The supplied traffic observation is incomplete or invalid, so no series, totals or chart is shown. An empty read is not assumed.'))}</p></section>`
}

/**
 * Renders the Real-Time Website Traffic, Cache & HTTP Status Analytics view:
 * 1. KPI summary cards (Total Requests, Bandwidth, Unique Visitors, Cache Hit Ratio %, 5xx Error Rate %, Avg & P95 Latency ms)
 * 2. Interactive SVG Traffic & HTTP Status Breakdown chart (`2xx`, `3xx`, `4xx`, `5xx` + Cache Hit/Miss/Bypass + P95 latency overlay)
 * 3. Top Paths, Top Referrers, and Top Client IPs tables with tabular numerals and 5xx badges
 *
 * Only supplied observations are rendered. A malformed read is unavailable and an
 * empty series is an explicit empty state; no fallback point is synthesized from totals.
 */
export function renderWebsiteAnalyticsChart(
  snapshot: WebsiteAnalyticsSnapshot,
  locale: Locale = 'en',
  window?: WebsiteAnalyticsWindow,
): string {
  const text = (message: string, values?: MessageValues) => translator(locale)(message, values)
  const parsed = parseWebsiteAnalyticsSnapshot(snapshot)
  if (!parsed) return analyticsInvalid(locale)
  const { totals } = parsed
  const shell = analyticsShell(parsed, locale, 'empty')
  if (parsed.series.length === 0) {
    const observed = Number.isFinite(Date.parse(parsed.at)) ? renderLtrValue(formatDisplayDateTime(parsed.at)) : escapeHtml(text('Unavailable'))
    return shell.open +
      analyticsHeader(parsed, locale, window) +
      `<div class="xp-card" data-analytics-empty="true" role="status" ><style>[data-analytics-empty]{display:flex;flex-direction:column;gap:var(--xp-space-group,24px)}[data-analytics-empty] .xp-panel-detail__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:var(--xp-space-field,16px);margin:0}[data-analytics-empty] .xp-panel-detail__facts>div{display:flex;flex-direction:column;gap:var(--xp-space-label,8px);min-inline-size:0}[data-analytics-empty] dd{margin:0}</style><h3 style="margin:0;font-size:1rem;">${escapeHtml(text('No traffic rows were observed'))}</h3>` +
      `<p class="xp-prose" style="margin:0;">${escapeHtml(text('The account-scoped analytics read returned no hourly rows for this range. Request, bandwidth and visitor totals are not shown because a missing row is not a measured zero.'))}</p>` +
      `<dl class="xp-panel-detail__facts"><div><dt>${escapeHtml(text('Observed at'))}</dt><dd><time class="xp-mono xp-tabular" datetime="${escapeHtml(parsed.at)}">${observed}</time></dd></div>` +
      (window ? `<div><dt>${escapeHtml(text('Range'))}</dt><dd>${escapeHtml(windowCopy(window, locale))}</dd></div>` : '') +
      `<div><dt>${escapeHtml(text('Series'))}</dt><dd>${escapeHtml(text('Empty observation'))}</dd></div></dl></div>` +
      shell.close
  }
  const buckets = parsed.series
  const maxRequests = Math.max(10, ...buckets.map((b) => b.requests)) * 1.15
  const maxP95 = Math.max(20, ...buckets.map((b) => b.p95RequestTimeMs)) * 1.15

  const s2xxGeom = buildSvgPolylineAndArea(
    buckets.map((b) => b.status2xx),
    maxRequests,
  )
  const s4xxGeom = buildSvgPolylineAndArea(
    buckets.map((b) => b.status4xx),
    maxRequests,
  )
  const s5xxGeom = buildSvgPolylineAndArea(
    buckets.map((b) => b.status5xx),
    maxRequests,
  )
  const p95Geom = buildSvgPolylineAndArea(
    buckets.map((b) => b.p95RequestTimeMs),
    maxP95,
  )

  const totalCacheHit = buckets.reduce((acc, b) => acc + b.cacheHit, 0)
  const totalCacheMiss = buckets.reduce((acc, b) => acc + b.cacheMiss, 0)
  const totalCacheBypass = buckets.reduce((acc, b) => acc + b.cacheBypass, 0)

  const errorLevel =
    totals.errorRatePercent >= 5
      ? 'critical'
      : totals.errorRatePercent >= 1
        ? 'warn'
        : 'ok'
  const cacheLevel =
    totals.cacheHitRatioPercent >= 70
      ? 'ok'
      : totals.cacheHitRatioPercent >= 40
        ? 'warn'
        : 'critical'

  const interactivePoints = s2xxGeom.coords
    .map((pt, idx) => {
      const bucket = buckets[idx] ?? buckets[0]
      if (!bucket) return ''
      const tip = `${formatDisplayDateTime(bucket.at)} — 2xx: ${bucket.status2xx}, 3xx: ${bucket.status3xx}, 4xx: ${bucket.status4xx}, 5xx: ${bucket.status5xx} | Hit: ${bucket.cacheHit}, Miss: ${bucket.cacheMiss} | P95: ${bucket.p95RequestTimeMs.toFixed(1)} ms`
      return `<circle cx="${pt.x}" cy="${pt.y}" r="3.2" fill="var(--xp-chart-2xx)" data-tooltip="${escapeHtml(tip)}"><title>${escapeHtml(tip)}</title></circle>`
    })
    .join('')

  return (
    analyticsShell(parsed, locale, 'loaded').open +
    analyticsHeader(parsed, locale, window) +
    `<div class="xp-kpi-grid" >` +
    `<div class="xp-card xp-field">` +
    `<div class="xp-label" style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(translator(locale)('Total Requests'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" data-live-kpi="web-requests" style="font-size:1.45rem;font-weight:700;margin:0;">${renderLtrValue(`${totals.requests.toLocaleString('en-US')}`)}</div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.78rem;color:var(--xp-text-muted);">${renderLtrValue(`2xx: ${totals.status2xx} · 3xx: ${totals.status3xx} · 4xx: ${totals.status4xx} · 5xx: ${totals.status5xx}`)}</div>` +
    `</div>` +
    `<div class="xp-card xp-field">` +
    `<div class="xp-label" style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(translator(locale)('Edge Bandwidth'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" style="font-size:1.45rem;font-weight:700;margin:0;">${renderLtrValue(`${formatBytes(totals.bytes)}`)}</div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.78rem;color:var(--xp-text-muted);">${renderLtrValue(`${totals.bytes.toLocaleString('en-US')} B`)}</div>` +
    `</div>` +
    `<div class="xp-card xp-field">` +
    `<div class="xp-label" style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(translator(locale)('Unique Visitors'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" style="font-size:1.45rem;font-weight:700;margin:0;">${renderLtrValue(`${totals.uniqueVisitors.toLocaleString('en-US')}`)}</div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.78rem;color:var(--xp-text-muted);">Edge log cardinality</div>` +
    `</div>` +
    `<div class="xp-card xp-field">` +
    `<div class="xp-label" style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(translator(locale)('Cache Hit Ratio'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" data-live-kpi="web-cache-hit" style="font-size:1.45rem;font-weight:700;margin:0;">${renderLtrValue(`${totals.cacheHitRatioPercent.toFixed(1)}%`)}</div>` +
    `<div>${renderStatusBadge(cacheLevel, `Hit ${totalCacheHit} · Miss ${totalCacheMiss} · Bypass ${totalCacheBypass}`)}</div>` +
    `</div>` +
    `<div class="xp-card xp-field">` +
    `<div class="xp-label" style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(translator(locale)('5xx Error Rate'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" style="font-size:1.45rem;font-weight:700;margin:0;">${renderLtrValue(`${totals.errorRatePercent.toFixed(2)}%`)}</div>` +
    `<div>${renderStatusBadge(errorLevel, `${totals.status5xx} 5xx responses`)}</div>` +
    `</div>` +
    `<div class="xp-card xp-field">` +
    `<div class="xp-label" style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(translator(locale)('Avg / P95 Latency'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" data-live-kpi="web-p95" style="font-size:1.35rem;font-weight:700;margin:0;">${renderLtrValue(`${totals.avgRequestTimeMs.toFixed(1)} / ${totals.p95RequestTimeMs.toFixed(1)} ms`)}</div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.78rem;color:var(--xp-text-muted);">${renderLtrValue(`Upstream avg: ${totals.avgUpstreamTimeMs.toFixed(1)} ms`)}</div>` +
    `</div>` +
    `</div>` +
    `<div class="xp-card" >` +
    `<div class="xp-card__header">` +
    `<strong>${escapeHtml(translator(locale)('HTTP Status Breakdown (2xx / 3xx / 4xx / 5xx), Cache Ratio & P95 Response Time'))}</strong>` +
    `<div class="xp-chart-legend">` +
    `<span><span class="xp-chart-swatch" style="background:var(--xp-chart-2xx);"></span>${escapeHtml(translator(locale)('2xx OK'))}</span>` +
    `<span><span class="xp-chart-swatch" style="background:var(--xp-chart-4xx);"></span>${escapeHtml(translator(locale)('4xx Client Error'))}</span>` +
    `<span><span class="xp-chart-swatch" style="background:var(--xp-chart-5xx);"></span>${escapeHtml(translator(locale)('5xx Server Error'))}</span>` +
    `<span><span class="xp-chart-swatch" style="background:var(--xp-chart-latency);"></span>P95 ms</span>` +
    `</div>` +
    `</div>` +
    `<div class="xp-chart-container">` +
    `<svg class="xp-chart-svg" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="${escapeHtml(translator(locale)('HTTP Status Breakdown (2xx / 3xx / 4xx / 5xx), Cache Ratio & P95 Response Time'))}">` +
    `<defs>` +
    `<linearGradient id="xp-web-2xx-grad" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="var(--xp-chart-2xx)" stop-opacity="0.30"/>` +
    `<stop offset="100%" stop-color="var(--xp-chart-2xx)" stop-opacity="0.02"/>` +
    `</linearGradient>` +
    `</defs>` +
    `<line x1="${PAD_LEFT}" y1="${PAD_TOP}" x2="${CHART_WIDTH - PAD_RIGHT}" y2="${PAD_TOP}" stroke="var(--xp-chart-grid)" stroke-dasharray="4 4"/>` +
    `<line x1="${PAD_LEFT}" y1="${(PAD_TOP + CHART_HEIGHT - PAD_BOTTOM) / 2}" x2="${CHART_WIDTH - PAD_RIGHT}" y2="${(PAD_TOP + CHART_HEIGHT - PAD_BOTTOM) / 2}" stroke="var(--xp-chart-grid)" stroke-dasharray="4 4"/>` +
    `<line x1="${PAD_LEFT}" y1="${CHART_HEIGHT - PAD_BOTTOM}" x2="${CHART_WIDTH - PAD_RIGHT}" y2="${CHART_HEIGHT - PAD_BOTTOM}" stroke="var(--xp-border-strong)"/>` +
    `<polygon points="${s2xxGeom.areaPoints}" fill="url(#xp-web-2xx-grad)"/>` +
    `<polyline points="${s2xxGeom.linePoints}" fill="none" stroke="var(--xp-chart-2xx)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<polyline points="${s4xxGeom.linePoints}" fill="none" stroke="var(--xp-chart-4xx)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<polyline points="${s5xxGeom.linePoints}" fill="none" stroke="var(--xp-chart-5xx)" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<polyline points="${p95Geom.linePoints}" fill="none" stroke="var(--xp-chart-latency)" stroke-width="1.8" stroke-dasharray="5 3" stroke-linecap="round"/>` +
    interactivePoints +
    `</svg>` +
    `</div>` +
    `</div>` +
    `<div class="xp-kpi-grid">` +
    renderTopEntriesTable(translator(locale)('Top Requested Paths'), parsed.topPaths, locale) +
    renderTopEntriesTable(translator(locale)('Top Referrers'), parsed.topReferrers, locale) +
    renderTopEntriesTable(translator(locale)('Top Client IP Addresses'), parsed.topClientIps, locale) +
    `</div>` +
    `</section>`
  )
}
