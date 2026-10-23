// Interactive SVG charts and dense resource ranking tables for Real-Time Server IO Monitor
// (cgroup v2 + Linux PSI) and Real-Time Website Traffic/Cache/Status Analytics.

import type {
  AccountIoRank,
  IoAnalyticsSnapshot,
  WebsiteAnalyticsSnapshot,
  WebsiteTopEntry,
  WebsiteTrafficBucket,
} from '@xpanel/core'
import { dirForLocale, t, type Locale } from './i18n.ts'
import {
  escapeHtml,
  formatAsciiNumber,
  formatBytes,
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

const suppliedPositive = (value: number): number | undefined =>
  Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined

const suppliedPositiveCounter = (value: number): number | undefined => Number.isSafeInteger(value) ? suppliedPositive(value) : undefined

const suppliedRate = (value: number, divisor: number, unit: string, locale: Locale): string => {
  if (suppliedPositive(value) === undefined) return locale === 'ar' ? 'غير متاح' : 'Unavailable'
  const scaled = value / divisor
  // Preserve a positive supplied rate when binary-unit scaling underflows.
  return scaled === 0 && divisor === 1024 * 1024 ? `${formatAsciiNumber(value)} B/s` : `${formatAsciiNumber(scaled)} ${unit}`
}

function renderIoAccountRow(rank: AccountIoRank, locale: Locale): string {
  const text = (en: string, ar: string) => locale === 'ar' ? ar : en
  const unavailable = text('Unavailable', 'غير متاح')
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
    <td data-numeric="true" class="xp-tabular">${renderThresholdMeter(memory === undefined ? undefined : memory / (1024 * 1024), memoryLimit, { locale, unit: 'MiB', label: text('Memory', 'الذاكرة'), configuredLimit: true })}</td>
    <td data-numeric="true" class="xp-tabular">${suppliedPositive(rank.cpuPercent) === undefined ? escapeHtml(unavailable) : renderLtrValue(`${formatAsciiNumber(rank.cpuPercent)}% (1 core)`, 'xp-chart-technical-value')}</td>
    <td data-numeric="true" class="xp-tabular">${renderThresholdMeter(suppliedPositiveCounter(rank.pidsCurrent), pidsLimit, { locale, unit: 'PIDs', label: text('Processes', 'العمليات'), configuredLimit: true })}</td>
  </tr>`
}

/** Supplied account values and configured caps; no host observation or enforcement attestation. */
export function renderServerIoMonitorChart(snapshot: IoAnalyticsSnapshot, locale: Locale = 'en'): string {
  const text = (en: string, ar: string) => locale === 'ar' ? ar : en
  const unavailable = text('Unavailable', 'غير متاح')
  const rate = (value: number, divisor: number, unit: string) => suppliedRate(value, divisor, unit, locale)
  const current = snapshot.current
  const kpi = (label: string, value: string, key?: string) => `<div class="xp-card xp-field"><div class="xp-label">${escapeHtml(label)}</div><div class="xp-kpi__value xp-tabular"${key ? ` data-resource-observation="${key}"` : ''}>${value === unavailable ? escapeHtml(value) : renderLtrValue(value)}</div></div>`
  const rows = snapshot.accounts.map(account => renderIoAccountRow(account, locale)).join('')
  // The old wire shape supplies synthetic defaults for host RAM/PSI/await and no
  // rate-availability metadata. Keep those observations unavailable until cutover.
  return `<section class="xp-io-monitor" dir="${dirForLocale(locale)}" data-surface-widget="io-monitor" aria-label="${text('Resource usage', 'استخدام الموارد')}">
    <header class="xp-card__header"><div><h2>${text('Resource usage', 'استخدام الموارد')}</h2><p class="xp-prose">${text('Account resources and configured limits.', 'موارد الحسابات والحدود المعيّنة.')}</p></div><time class="xp-mono xp-tabular" datetime="${escapeHtml(snapshot.at)}">${renderLtrValue(snapshot.at)}</time></header>
    <p class="xp-help" role="status" data-resource-observation-state="incomplete">${text('Some measurements are unavailable.', 'بعض القياسات غير متاحة.')}</p>
    <div class="xp-kpi-grid">
      ${kpi(text('Account read total', 'إجمالي قراءة الحسابات'), rate(current.readBytesPerSec, 1024 * 1024, 'MiB/s'), 'io-read')}
      ${kpi(text('Account write total', 'إجمالي كتابة الحسابات'), rate(current.writeBytesPerSec, 1024 * 1024, 'MiB/s'), 'io-write')}
      ${kpi(text('Account IOPS total', 'إجمالي عمليات الحسابات'), current.readIops > 0 && current.writeIops > 0 ? rate(current.readIops + current.writeIops, 1, 'IOPS') : unavailable, 'io-iops')}
      ${kpi(text('Disk latency', 'زمن استجابة القرص'), unavailable)}
      ${kpi(text('IO pressure', 'ضغط عمليات القرص'), unavailable)}
      ${kpi(text('Host CPU and memory', 'معالج الخادم والذاكرة'), unavailable)}
    </div>
    <div class="xp-card xp-field"><h3>${text('Read and write history', 'سجل القراءة والكتابة')}</h3><p class="xp-resource-history-unavailable" role="status">${escapeHtml(unavailable)}</p></div>
    <div class="xp-card"><div class="xp-card__header"><h3>${text('Account resources', 'موارد الحسابات')}</h3></div><div class="xp-table-wrap"><table class="xp-table"><thead><tr>
      <th>${text('Account', 'الحساب')}</th><th>${text('Read / write', 'القراءة / الكتابة')}</th><th>IOPS</th><th>${text('Memory', 'الذاكرة')}</th><th>${text('CPU (% of 1 core)', 'المعالج (% من نواة واحدة)')}</th><th>${text('Processes', 'العمليات')}</th>
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
      : `<tr><td colspan="4" style="text-align:center;color:var(--xp-text-muted);">${escapeHtml(t(locale, 'common.empty'))}</td></tr>`

  return (
    `<div class="xp-card">` +
    `<div class="xp-card__header"><strong>${escapeHtml(title)}</strong></div>` +
    `<div class="xp-table-wrap">` +
    `<table class="xp-table xp-table--compact">` +
    `<thead>` +
    `<tr>` +
    `<th>${escapeHtml(t(locale, 'analytics.col.key'))}</th>` +
    `<th>${escapeHtml(t(locale, 'analytics.col.requests'))}</th>` +
    `<th>${escapeHtml(t(locale, 'analytics.col.bytes'))}</th>` +
    `<th>${escapeHtml(t(locale, 'analytics.col.errors5xx'))}</th>` +
    `</tr>` +
    `</thead>` +
    `<tbody>${rows}</tbody>` +
    `</table>` +
    `</div>` +
    `</div>`
  )
}

/**
 * Renders the Real-Time Website Traffic, Cache & HTTP Status Analytics view:
 * 1. KPI summary cards (Total Requests, Bandwidth, Unique Visitors, Cache Hit Ratio %, 5xx Error Rate %, Avg & P95 Latency ms)
 * 2. Interactive SVG Traffic & HTTP Status Breakdown chart (`2xx`, `3xx`, `4xx`, `5xx` + Cache Hit/Miss/Bypass + P95 latency overlay)
 * 3. Top Paths, Top Referrers, and Top Client IPs tables with tabular numerals and 5xx error badges
 */
export function renderWebsiteAnalyticsChart(
  snapshot: WebsiteAnalyticsSnapshot,
  locale: Locale = 'en',
): string {
  const dir = dirForLocale(locale)
  const { totals } = snapshot

  const fallbackBucket: WebsiteTrafficBucket = {
    at: snapshot.at,
    requests: totals.requests,
    bytes: totals.bytes,
    status2xx: totals.status2xx,
    status3xx: totals.status3xx,
    status4xx: totals.status4xx,
    status5xx: totals.status5xx,
    cacheHit: Math.round((totals.requests * totals.cacheHitRatioPercent) / 100),
    cacheMiss: Math.max(
      0,
      totals.requests -
        Math.round((totals.requests * totals.cacheHitRatioPercent) / 100),
    ),
    cacheBypass: 0,
    avgRequestTimeMs: totals.avgRequestTimeMs,
    p95RequestTimeMs: totals.p95RequestTimeMs,
    avgUpstreamTimeMs: totals.avgUpstreamTimeMs,
  }

  const buckets = snapshot.series.length > 0 ? snapshot.series : [fallbackBucket]
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
      const bucket = buckets[idx] ?? fallbackBucket
      const tip = `${bucket.at} — 2xx: ${bucket.status2xx}, 3xx: ${bucket.status3xx}, 4xx: ${bucket.status4xx}, 5xx: ${bucket.status5xx} | Hit: ${bucket.cacheHit}, Miss: ${bucket.cacheMiss} | P95: ${bucket.p95RequestTimeMs.toFixed(1)} ms`
      return `<circle cx="${pt.x}" cy="${pt.y}" r="3.2" fill="var(--xp-chart-2xx)" data-tooltip="${escapeHtml(tip)}"><title>${escapeHtml(tip)}</title></circle>`
    })
    .join('')

  return (
    `<section class="xp-website-analytics" dir="${dir}" data-surface-widget="website-analytics" data-domain="${escapeHtml(snapshot.domain)}" aria-label="${escapeHtml(t(locale, 'analytics.title'))}">` +
    `<header class="xp-card__header">` +
    `<div>` +
    `<h2 style="margin:0;font-size:1.2rem;">${escapeHtml(t(locale, 'analytics.title'))} — <span class="xp-mono">${renderLtrValue(snapshot.domain)}</span></h2>` +
    `<p class="xp-prose" style="margin:4px 0 0;color:var(--xp-text-secondary);font-size:0.88rem;">${escapeHtml(t(locale, 'analytics.subtitle'))}</p>` +
    `</div>` +
    `<time class="xp-mono xp-tabular" datetime="${escapeHtml(snapshot.at)}">${renderLtrValue(snapshot.at)}</time>` +
    `</header>` +
    `<div class="xp-kpi-grid" style="margin-block-end:var(--xp-space-card);">` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'analytics.kpi.requests'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" data-live-kpi="web-requests" style="font-size:1.45rem;font-weight:700;margin-block:6px;">${renderLtrValue(`${totals.requests.toLocaleString('en-US')}`)}</div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.78rem;color:var(--xp-text-muted);">${renderLtrValue(`2xx: ${totals.status2xx} · 3xx: ${totals.status3xx} · 4xx: ${totals.status4xx} · 5xx: ${totals.status5xx}`)}</div>` +
    `</div>` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'analytics.kpi.bandwidth'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" style="font-size:1.45rem;font-weight:700;margin-block:6px;">${renderLtrValue(`${formatBytes(totals.bytes)}`)}</div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.78rem;color:var(--xp-text-muted);">${renderLtrValue(`${totals.bytes.toLocaleString('en-US')} B`)}</div>` +
    `</div>` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'analytics.kpi.visitors'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" style="font-size:1.45rem;font-weight:700;margin-block:6px;">${renderLtrValue(`${totals.uniqueVisitors.toLocaleString('en-US')}`)}</div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.78rem;color:var(--xp-text-muted);">Edge log cardinality</div>` +
    `</div>` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'analytics.kpi.cacheHit'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" data-live-kpi="web-cache-hit" style="font-size:1.45rem;font-weight:700;margin-block:6px;">${renderLtrValue(`${totals.cacheHitRatioPercent.toFixed(1)}%`)}</div>` +
    `<div>${renderStatusBadge(cacheLevel, `Hit ${totalCacheHit} · Miss ${totalCacheMiss} · Bypass ${totalCacheBypass}`)}</div>` +
    `</div>` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'analytics.kpi.errorRate'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" style="font-size:1.45rem;font-weight:700;margin-block:6px;">${renderLtrValue(`${totals.errorRatePercent.toFixed(2)}%`)}</div>` +
    `<div>${renderStatusBadge(errorLevel, `${totals.status5xx} 5xx responses`)}</div>` +
    `</div>` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'analytics.kpi.latency'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" data-live-kpi="web-p95" style="font-size:1.35rem;font-weight:700;margin-block:6px;">${renderLtrValue(`${totals.avgRequestTimeMs.toFixed(1)} / ${totals.p95RequestTimeMs.toFixed(1)} ms`)}</div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.78rem;color:var(--xp-text-muted);">${renderLtrValue(`Upstream avg: ${totals.avgUpstreamTimeMs.toFixed(1)} ms`)}</div>` +
    `</div>` +
    `</div>` +
    `<div class="xp-card" style="margin-block-end:var(--xp-space-card);">` +
    `<div class="xp-card__header">` +
    `<strong>${escapeHtml(t(locale, 'analytics.chart.title'))}</strong>` +
    `<div class="xp-chart-legend">` +
    `<span><span class="xp-chart-swatch" style="background:var(--xp-chart-2xx);"></span>${escapeHtml(t(locale, 'analytics.status.2xx'))}</span>` +
    `<span><span class="xp-chart-swatch" style="background:var(--xp-chart-4xx);"></span>${escapeHtml(t(locale, 'analytics.status.4xx'))}</span>` +
    `<span><span class="xp-chart-swatch" style="background:var(--xp-chart-5xx);"></span>${escapeHtml(t(locale, 'analytics.status.5xx'))}</span>` +
    `<span><span class="xp-chart-swatch" style="background:var(--xp-chart-latency);"></span>P95 ms</span>` +
    `</div>` +
    `</div>` +
    `<div class="xp-chart-container">` +
    `<svg class="xp-chart-svg" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="${escapeHtml(t(locale, 'analytics.chart.title'))}">` +
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
    renderTopEntriesTable(t(locale, 'analytics.topPaths'), snapshot.topPaths, locale) +
    renderTopEntriesTable(t(locale, 'analytics.topReferrers'), snapshot.topReferrers, locale) +
    renderTopEntriesTable(t(locale, 'analytics.topClientIps'), snapshot.topClientIps, locale) +
    `</div>` +
    `</section>`
  )
}
