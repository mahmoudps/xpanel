// Interactive SVG charts and dense resource ranking tables for Real-Time Server IO Monitor
// (cgroup v2 + Linux PSI) and Real-Time Website Traffic/Cache/Status Analytics.

import type {
  AccountIoRank,
  IoAnalyticsPoint,
  IoAnalyticsSnapshot,
  WebsiteAnalyticsSnapshot,
  WebsiteTopEntry,
  WebsiteTrafficBucket,
} from '@xpanel/core'
import { dirForLocale, t, type Locale } from './i18n.ts'
import {
  escapeHtml,
  formatBytes,
  getThresholdLevel,
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

function renderIoAccountRow(rank: AccountIoRank, locale: Locale): string {
  const sliceUnit = `xpanel-${rank.uid}.slice`
  const readMbPerSec = Math.round((rank.readBytesPerSec / (1024 * 1024)) * 100) / 100
  const writeMbPerSec = Math.round((rank.writeBytesPerSec / (1024 * 1024)) * 100) / 100
  const combinedThroughputMb = Math.round((readMbPerSec + writeMbPerSec) * 100) / 100
  const memUsedMb = Math.round((rank.memoryCurrentBytes / (1024 * 1024)) * 10) / 10

  const statusLabel =
    rank.statusLevel === 'ok'
      ? t(locale, 'common.status.ok')
      : rank.statusLevel === 'warn'
        ? t(locale, 'common.status.warn')
        : t(locale, 'common.status.critical')

  return (
    `<tr data-account-id="${escapeHtml(rank.accountId)}" data-uid="${rank.uid}">` +
    `<td>` +
    `<div><strong>${escapeHtml(rank.username)}</strong></div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.78rem;color:var(--xp-text-muted);">${escapeHtml(sliceUnit)} (UID ${rank.uid})</div>` +
    `</td>` +
    `<td data-numeric="true" class="xp-tabular">` +
    `<div class="xp-mono" style="margin-block-end:4px;">R: ${readMbPerSec.toFixed(2)} MB/s · W: ${writeMbPerSec.toFixed(2)} MB/s</div>` +
    renderThresholdMeter(combinedThroughputMb, 100, 'MB/s') +
    `</td>` +
    `<td data-numeric="true" class="xp-tabular xp-mono">` +
    `R: ${Math.round(rank.readIops)} / W: ${Math.round(rank.writeIops)} IOPS` +
    `</td>` +
    `<td data-numeric="true" class="xp-tabular">` +
    renderThresholdMeter(memUsedMb, rank.memoryLimitMb, 'MB') +
    `</td>` +
    `<td data-numeric="true" class="xp-tabular">` +
    renderThresholdMeter(Math.round(rank.cpuPercent * 10) / 10, 100, '%') +
    `</td>` +
    `<td data-numeric="true" class="xp-tabular">` +
    renderThresholdMeter(rank.pidsCurrent, rank.pidsLimit, 'PIDs') +
    `</td>` +
    `<td>${renderStatusBadge(rank.statusLevel, statusLabel)}</td>` +
    `</tr>`
  )
}

/**
 * Renders the Real-Time Server IO Monitor view:
 * 1. Summary KPI cards (Read MB/s, Write MB/s, IOPS, Disk `await` ms, Linux PSI `some/full avg10`, Host CPU & Memory)
 * 2. Dual-series SVG area/line chart for Read MB/s vs Write MB/s + `await` latency overlay
 * 3. Per-Account cgroup v2 (`xpanel-<uid>.slice`) IO & Resource Ranking table with 80%/95% threshold meters
 */
export function renderServerIoMonitorChart(
  snapshot: IoAnalyticsSnapshot,
  locale: Locale = 'en',
): string {
  const dir = dirForLocale(locale)
  const cur = snapshot.current
  const points: IoAnalyticsPoint[] =
    snapshot.history.length > 0 ? snapshot.history : [cur]

  const readMbSeries = points.map((p) => p.readBytesPerSec / (1024 * 1024))
  const writeMbSeries = points.map((p) => p.writeBytesPerSec / (1024 * 1024))
  const awaitSeries = points.map((p) => p.awaitMs)

  const maxThroughputMb = Math.max(10, ...readMbSeries, ...writeMbSeries) * 1.15
  const maxAwaitMs = Math.max(10, ...awaitSeries) * 1.2

  const readGeom = buildSvgPolylineAndArea(readMbSeries, maxThroughputMb)
  const writeGeom = buildSvgPolylineAndArea(writeMbSeries, maxThroughputMb)
  const awaitGeom = buildSvgPolylineAndArea(awaitSeries, maxAwaitMs)

  const curReadMb = (cur.readBytesPerSec / (1024 * 1024)).toFixed(2)
  const curWriteMb = (cur.writeBytesPerSec / (1024 * 1024)).toFixed(2)
  const curTotalIops = Math.round(cur.readIops + cur.writeIops)
  const psiLevel = getThresholdLevel(Math.max(cur.psiSomeAvg10, cur.psiFullAvg10) * 2)
  const awaitLevel = cur.awaitMs >= 50 ? 'critical' : cur.awaitMs >= 20 ? 'warn' : 'ok'
  const memUsedGb = (cur.memoryUsedBytes / (1024 * 1024 * 1024)).toFixed(2)
  const memTotalGb = (Math.max(1, cur.memoryTotalBytes) / (1024 * 1024 * 1024)).toFixed(2)

  const accountRows =
    snapshot.accounts.length > 0
      ? snapshot.accounts.map((acc) => renderIoAccountRow(acc, locale)).join('')
      : `<tr><td colspan="7" style="text-align:center;color:var(--xp-text-muted);">${escapeHtml(t(locale, 'io.table.empty'))}</td></tr>`

  const circlesHtml = readGeom.coords
    .map((pt, idx) => {
      const wPt = writeGeom.coords[idx]
      const pointData = points[idx] ?? cur
      const tooltip = `Read ${pt.value.toFixed(2)} MB/s | Write ${(wPt?.value ?? 0).toFixed(2)} MB/s | await ${pointData.awaitMs.toFixed(1)} ms | PSI ${pointData.psiSomeAvg10.toFixed(1)}%`
      return `<circle cx="${pt.x}" cy="${pt.y}" r="3.2" fill="var(--xp-chart-read)" data-tooltip="${escapeHtml(tooltip)}"><title>${escapeHtml(tooltip)}</title></circle>`
    })
    .join('')

  return (
    `<section class="xp-io-monitor" dir="${dir}" data-surface-widget="io-monitor" aria-label="${escapeHtml(t(locale, 'io.title'))}">` +
    `<header class="xp-card__header">` +
    `<div>` +
    `<h2 style="margin:0;font-size:1.2rem;">${escapeHtml(t(locale, 'io.title'))}</h2>` +
    `<p class="xp-prose" style="margin:4px 0 0;color:var(--xp-text-secondary);font-size:0.88rem;">${escapeHtml(t(locale, 'io.subtitle'))}</p>` +
    `</div>` +
    `<time class="xp-mono xp-tabular" datetime="${escapeHtml(snapshot.at)}">${escapeHtml(snapshot.at)}</time>` +
    `</header>` +
    `<div class="xp-kpi-grid" style="margin-block-end:var(--xp-space-card);">` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'io.kpi.readRate'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" data-live-kpi="io-read" style="font-size:1.45rem;font-weight:700;margin-block:6px;">${curReadMb} MB/s</div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.8rem;color:var(--xp-text-muted);">${Math.round(cur.readIops)} read IOPS</div>` +
    `</div>` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'io.kpi.writeRate'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" data-live-kpi="io-write" style="font-size:1.45rem;font-weight:700;margin-block:6px;">${curWriteMb} MB/s</div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.8rem;color:var(--xp-text-muted);">${Math.round(cur.writeIops)} write IOPS</div>` +
    `</div>` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'io.kpi.iops'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" data-live-kpi="io-iops" style="font-size:1.45rem;font-weight:700;margin-block:6px;">${curTotalIops} IOPS</div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.8rem;color:var(--xp-text-muted);">Load 1m: ${cur.loadAvg1m.toFixed(2)}</div>` +
    `</div>` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'io.kpi.await'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" data-live-kpi="io-await" style="font-size:1.45rem;font-weight:700;margin-block:6px;">${cur.awaitMs.toFixed(2)} ms</div>` +
    `<div>${renderStatusBadge(awaitLevel, `${cur.awaitMs.toFixed(1)} ms await`)}</div>` +
    `</div>` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'io.kpi.psi'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" style="font-size:1.35rem;font-weight:700;margin-block:6px;">${cur.psiSomeAvg10.toFixed(2)}% / ${cur.psiFullAvg10.toFixed(2)}%</div>` +
    `<div>${renderStatusBadge(psiLevel, `some ${cur.psiSomeAvg10.toFixed(1)}% · full ${cur.psiFullAvg10.toFixed(1)}%`)}</div>` +
    `</div>` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'io.kpi.cpuMemory'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" style="font-size:1.35rem;font-weight:700;margin-block:6px;">CPU ${cur.cpuPercent.toFixed(1)}%</div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.8rem;color:var(--xp-text-muted);">RAM ${memUsedGb} / ${memTotalGb} GB</div>` +
    `</div>` +
    `</div>` +
    `<div class="xp-card" style="margin-block-end:var(--xp-space-card);">` +
    `<div class="xp-card__header">` +
    `<strong>${escapeHtml(t(locale, 'io.chart.title'))}</strong>` +
    `<div class="xp-chart-legend">` +
    `<span><span class="xp-chart-swatch" style="background:var(--xp-chart-read);"></span>${escapeHtml(t(locale, 'io.chart.readSeries'))}</span>` +
    `<span><span class="xp-chart-swatch" style="background:var(--xp-chart-write);"></span>${escapeHtml(t(locale, 'io.chart.writeSeries'))}</span>` +
    `<span><span class="xp-chart-swatch" style="background:var(--xp-chart-latency);"></span>${escapeHtml(t(locale, 'io.chart.awaitMs'))}</span>` +
    `</div>` +
    `</div>` +
    `<div class="xp-chart-container">` +
    `<svg class="xp-chart-svg" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="${escapeHtml(t(locale, 'io.chart.title'))}">` +
    `<defs>` +
    `<linearGradient id="xp-io-read-grad" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="var(--xp-chart-read)" stop-opacity="0.32"/>` +
    `<stop offset="100%" stop-color="var(--xp-chart-read)" stop-opacity="0.02"/>` +
    `</linearGradient>` +
    `<linearGradient id="xp-io-write-grad" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="var(--xp-chart-write)" stop-opacity="0.28"/>` +
    `<stop offset="100%" stop-color="var(--xp-chart-write)" stop-opacity="0.02"/>` +
    `</linearGradient>` +
    `</defs>` +
    `<line x1="${PAD_LEFT}" y1="${PAD_TOP}" x2="${CHART_WIDTH - PAD_RIGHT}" y2="${PAD_TOP}" stroke="var(--xp-chart-grid)" stroke-dasharray="4 4"/>` +
    `<line x1="${PAD_LEFT}" y1="${(PAD_TOP + CHART_HEIGHT - PAD_BOTTOM) / 2}" x2="${CHART_WIDTH - PAD_RIGHT}" y2="${(PAD_TOP + CHART_HEIGHT - PAD_BOTTOM) / 2}" stroke="var(--xp-chart-grid)" stroke-dasharray="4 4"/>` +
    `<line x1="${PAD_LEFT}" y1="${CHART_HEIGHT - PAD_BOTTOM}" x2="${CHART_WIDTH - PAD_RIGHT}" y2="${CHART_HEIGHT - PAD_BOTTOM}" stroke="var(--xp-border-strong)"/>` +
    `<polygon points="${readGeom.areaPoints}" fill="url(#xp-io-read-grad)"/>` +
    `<polygon points="${writeGeom.areaPoints}" fill="url(#xp-io-write-grad)"/>` +
    `<polyline points="${readGeom.linePoints}" fill="none" stroke="var(--xp-chart-read)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<polyline points="${writeGeom.linePoints}" fill="none" stroke="var(--xp-chart-write)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<polyline points="${awaitGeom.linePoints}" fill="none" stroke="var(--xp-chart-latency)" stroke-width="1.8" stroke-dasharray="5 3" stroke-linecap="round"/>` +
    circlesHtml +
    `</svg>` +
    `</div>` +
    `</div>` +
    `<div class="xp-card">` +
    `<div class="xp-card__header">` +
    `<strong>${escapeHtml(t(locale, 'io.table.title'))}</strong>` +
    `</div>` +
    `<div class="xp-table-wrap">` +
    `<table class="xp-table">` +
    `<thead>` +
    `<tr>` +
    `<th>${escapeHtml(t(locale, 'io.table.account'))}</th>` +
    `<th>${escapeHtml(t(locale, 'io.table.readWrite'))}</th>` +
    `<th>${escapeHtml(t(locale, 'io.table.iops'))}</th>` +
    `<th>${escapeHtml(t(locale, 'io.table.memory'))}</th>` +
    `<th>${escapeHtml(t(locale, 'io.table.cpu'))}</th>` +
    `<th>${escapeHtml(t(locale, 'io.table.pids'))}</th>` +
    `<th>${escapeHtml(t(locale, 'io.table.status'))}</th>` +
    `</tr>` +
    `</thead>` +
    `<tbody>${accountRows}</tbody>` +
    `</table>` +
    `</div>` +
    `</div>` +
    `</section>`
  )
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
              `<td class="xp-mono xp-tabular">${escapeHtml(item.key)}</td>` +
              `<td data-numeric="true" class="xp-tabular">${item.requests.toLocaleString('en-US')}</td>` +
              `<td data-numeric="true" class="xp-tabular">${escapeHtml(formatBytes(item.bytes))}</td>` +
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
    `<h2 style="margin:0;font-size:1.2rem;">${escapeHtml(t(locale, 'analytics.title'))} — <span class="xp-mono">${escapeHtml(snapshot.domain)}</span></h2>` +
    `<p class="xp-prose" style="margin:4px 0 0;color:var(--xp-text-secondary);font-size:0.88rem;">${escapeHtml(t(locale, 'analytics.subtitle'))}</p>` +
    `</div>` +
    `<time class="xp-mono xp-tabular" datetime="${escapeHtml(snapshot.at)}">${escapeHtml(snapshot.at)}</time>` +
    `</header>` +
    `<div class="xp-kpi-grid" style="margin-block-end:var(--xp-space-card);">` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'analytics.kpi.requests'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" data-live-kpi="web-requests" style="font-size:1.45rem;font-weight:700;margin-block:6px;">${totals.requests.toLocaleString('en-US')}</div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.78rem;color:var(--xp-text-muted);">2xx: ${totals.status2xx} · 3xx: ${totals.status3xx} · 4xx: ${totals.status4xx} · 5xx: ${totals.status5xx}</div>` +
    `</div>` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'analytics.kpi.bandwidth'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" style="font-size:1.45rem;font-weight:700;margin-block:6px;">${escapeHtml(formatBytes(totals.bytes))}</div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.78rem;color:var(--xp-text-muted);">${totals.bytes.toLocaleString('en-US')} B</div>` +
    `</div>` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'analytics.kpi.visitors'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" style="font-size:1.45rem;font-weight:700;margin-block:6px;">${totals.uniqueVisitors.toLocaleString('en-US')}</div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.78rem;color:var(--xp-text-muted);">Edge log cardinality</div>` +
    `</div>` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'analytics.kpi.cacheHit'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" data-live-kpi="web-cache-hit" style="font-size:1.45rem;font-weight:700;margin-block:6px;">${totals.cacheHitRatioPercent.toFixed(1)}%</div>` +
    `<div>${renderStatusBadge(cacheLevel, `Hit ${totalCacheHit} · Miss ${totalCacheMiss} · Bypass ${totalCacheBypass}`)}</div>` +
    `</div>` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'analytics.kpi.errorRate'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" style="font-size:1.45rem;font-weight:700;margin-block:6px;">${totals.errorRatePercent.toFixed(2)}%</div>` +
    `<div>${renderStatusBadge(errorLevel, `${totals.status5xx} 5xx responses`)}</div>` +
    `</div>` +
    `<div class="xp-card">` +
    `<div style="font-size:0.82rem;color:var(--xp-text-secondary);">${escapeHtml(t(locale, 'analytics.kpi.latency'))}</div>` +
    `<div class="xp-kpi__value xp-tabular" data-live-kpi="web-p95" style="font-size:1.35rem;font-weight:700;margin-block:6px;">${totals.avgRequestTimeMs.toFixed(1)} / ${totals.p95RequestTimeMs.toFixed(1)} ms</div>` +
    `<div class="xp-mono xp-tabular" style="font-size:0.78rem;color:var(--xp-text-muted);">Upstream avg: ${totals.avgUpstreamTimeMs.toFixed(1)} ms</div>` +
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
