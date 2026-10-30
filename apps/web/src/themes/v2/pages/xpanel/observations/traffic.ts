import type { WebsiteTopEntry } from '@xpanel/core'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { formatAsciiBytes, formatAsciiNumber, formatDisplayDateTime } from '../../../../../display-format.ts'
import { parseWebsiteAnalyticsSnapshot, WEBSITE_ANALYTICS_WINDOWS, type WebsiteAnalyticsWindow } from '../../../../../models/website-analytics.ts'
import { kpiCard, lineChart, notice } from '../../../components/index.ts'
import { emailContext, esc, facts, field, fields, header, missingAccount, page, section, select, table, technical, unread } from '../email-tools/common.ts'
import type { PanelObservationAuthority } from './common.ts'

export function renderV2PanelTraffic(props: PanelSurfaceProps, authority?: PanelObservationAuthority, route: '/metrics/traffic' | '/metrics/web-stats' = '/metrics/traffic'): string {
  const { locale, t, account, domains } = emailContext(props, authority)
  const title = route === '/metrics/web-stats' ? t(msgid('Web statistics')) : t(msgctxt('theme:v2', 'Traffic & bandwidth'))
  const requestedDomain = props.activeDomain ?? (account?.primaryDomain ?? '')
  const selected = domains?.find(row => row.name === requestedDomain) ?? (props.activeDomain === undefined ? domains?.[0] : undefined)
  const factTools = route === '/metrics/web-stats' ? ['web-stats-awstats', 'web-stats-webalizer', 'web-stats-analog', 'web-stats-ftp', 'metrics-editor'] : ['traffic-monitor-account', 'bandwidth']
  const factsAuthorized = authority?.presentation !== 'read-only' || factTools.some(id => authority.authorizedTools?.has(id))
  const snapshot = factsAuthorized && selected && props.websiteAnalytics !== undefined
    ? parseWebsiteAnalyticsSnapshot(props.websiteAnalytics, { accountId: (account?.id ?? ''), domain: selected.name }) : null
  const readState = props.websiteAnalyticsUnavailable || props.websiteAnalytics !== undefined && !snapshot
    ? 'unavailable' : snapshot ? snapshot.series.length ? 'loaded' : 'empty' : 'unread'
  const observed = readState === 'loaded' ? snapshot! : undefined
  const window = props.websiteAnalyticsWindow && WEBSITE_ANALYTICS_WINDOWS.includes(props.websiteAnalyticsWindow) ? props.websiteAnalyticsWindow : undefined
  const windowLabel = (value: WebsiteAnalyticsWindow): string => value === '1h' ? t(msgid('Last hour')) : value === '24h' ? t(msgid('Last 24 hours')) : value === '7d' ? t(msgid('Last 7 days')) : t(msgid('Last 30 days'))
  const params = new URLSearchParams({ lang: locale, theme: props.theme ?? 'dark', ...(selected ? { domain: selected.name } : {}) })
  const windowLinks = `<div class="v2-panel-extra__actions" role="group" aria-label="${esc(t(msgid('Range')))}">${WEBSITE_ANALYTICS_WINDOWS.map(value => {
    const query = new URLSearchParams(params); query.set('window', value)
    return `<a class="v2-btn${value === window ? ' v2-btn--primary' : ''}" href="${esc(`${route}?${query}`)}"${value === window ? ' aria-current="true"' : ''}>${esc(windowLabel(value))}</a>`
  }).join('')}</div>`
  const domainField = field('v2-traffic-domain', t(msgid('Domain')), select('v2-traffic-domain', (domains ?? []).map(domain => [domain.name, domain.name] as const), undefined, !authority?.domainSelectionAvailable, ' name="domain" dir="ltr"', selected?.name))
  const domainForm = authority?.domainSelectionAvailable
    ? `<form method="get" action="${route}" class="v2-panel-extra__groups"${!authority?.canRead || authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''}>${domainField}<input type="hidden" name="lang" value="${esc(locale)}"><input type="hidden" name="theme" value="${esc(props.theme ?? 'dark')}">${window ? `<input type="hidden" name="window" value="${window}">` : ''}<div class="v2-panel-extra__actions"><button type="submit" class="v2-btn">${esc(t(msgid('Show')))}</button></div></form>`
    : domainField
  const scope = section('v2-traffic-selection', t(msgid('Traffic selection')),
    fields(domainForm + `<div class="v2-field"><span class="v2-label">${esc(t(msgid('Range')))}</span>${windowLinks}</div>`)
    + facts([{ label: t(msgid('Observed at')), valueHtml: snapshot ? technical(formatDisplayDateTime(snapshot.at)) : esc(t(msgid('Not read'))) }, { label: t(msgctxt('theme:v2', 'Observation')), valueHtml: esc(readState === 'empty' ? t(msgid('Empty observation')) : readState === 'loaded' ? t(msgctxt('theme:v2', 'Account-scoped log observation')) : t(msgid('Not read'))) }]))
  const statusCopy = readState === 'empty'
    ? t(msgid('The account-scoped analytics read returned no hourly rows for this range. Request, bandwidth and visitor totals are not shown because a missing row is not a measured zero.'))
    : readState === 'unavailable'
      ? t(msgid('The account traffic records could not be read. An empty result is not assumed and no totals or time series are shown.'))
      : readState === 'unread' ? t(msgctxt('theme:v2', 'Account traffic has not been read. No totals, series or delivery state is assumed.'))
        : t(msgid('Derived incrementally from Nginx edge access logs without external tracking scripts.'))
  const status = notice(t, { tone: readState === 'loaded' ? 'info' : 'warn', lead: readState === 'empty' ? t(msgid('No traffic rows were observed')) : readState === 'loaded' ? t(msgctxt('theme:v2', 'Observed traffic')) : t(msgid('Traffic analytics unavailable')), text: statusCopy })
  const totals = observed?.totals
  const value = (number: number | undefined, unit?: 'bytes' | 'percent' | 'ms'): string => number === undefined ? t(msgid('Not read')) : unit === 'bytes' ? formatAsciiBytes(number) : unit === 'percent' ? `${formatAsciiNumber(number, { decimals: 1 })}%` : unit === 'ms' ? `${formatAsciiNumber(number, { decimals: 1 })} ms` : formatAsciiNumber(number)
  const summary = `<section class="v2-kpi-row" aria-label="${esc(t(msgctxt('theme:v2', 'Totals for the selection')))}">${[
    { label: t(msgid('Unique Visitors')), count: totals?.uniqueVisitors, icon: 'users' as const },
    { label: t(msgid('Total Requests')), count: totals?.requests, icon: 'activity' as const },
    { label: t(msgid('Edge Bandwidth')), count: totals?.bytes, icon: 'globe' as const, unit: 'bytes' as const },
    { label: t(msgid('5xx Error Rate')), count: totals?.errorRatePercent, icon: 'alert' as const, unit: 'percent' as const },
  ].map(item => kpiCard({ label: item.label, value: value(item.count, item.unit), headingLevel: 2, icon: item.icon, tone: item.count === undefined ? 'neutral' : 'info', note: window ? windowLabel(window) : t(msgctxt('theme:v2', 'The observation window was not supplied.')) })).join('')}</section>`
  const chartBody = (kind: 'requests' | 'bytes'): string => {
    if (!observed) return `<p data-chart-state="${readState}" role="status">${esc(statusCopy)}</p>`
    const series = observed.series.map(row => row[kind])
    const caption = kind === 'requests' ? t(msgid('Requests')) : t(msgid('Transferred'))
    return lineChart({ label: caption, series: [{ label: caption, values: series }], max: Math.max(1, ...series), xTicks: observed.series.length ? [formatDisplayDateTime(observed.series[0]!.at), formatDisplayDateTime(observed.series[observed.series.length - 1]!.at)] : [], yTicks: [value(Math.max(0, ...series), kind === 'bytes' ? 'bytes' : undefined), '0'], height: 230 })
  }
  const requests = section('v2-traffic-requests', t(msgid('Requests')), chartBody('requests'))
  const bandwidth = section('v2-traffic-bandwidth', t(msgid('Bandwidth by domain')), chartBody('bytes')
    + facts([{ label: t(msgid('Domain')), valueHtml: selected ? technical(selected.name) : esc(t(msgid('Not read'))) }, { label: t(msgid('Transferred')), valueHtml: totals ? technical(formatAsciiBytes(totals.bytes)) : esc(t(msgid('Not read'))) }]))
  const visitors = section('v2-traffic-visitors', t(msgid('Unique visitors per day')),
    `<p data-chart-state="unread">${esc(t(msgid('Daily visitor readings have not been read. Request totals do not establish a daily visitor series.')))}</p>`
    + facts([{ label: t(msgid('Unique visitors')), valueHtml: totals ? technical(totals.uniqueVisitors) : esc(t(msgid('Not read'))) }]))
  const entries = (rows: readonly WebsiteTopEntry[] | undefined, columns: number, errorOnly = false): string => rows === undefined ? unread(t, columns) : rows.length === 0
    ? `<tr><td colspan="${columns}">${esc(t(msgid('No records were returned.')))}</td></tr>`
    : rows.map(row => `<tr><td>${technical(row.key)}</td><td>${technical(errorOnly ? row.errors5xx! : formatAsciiNumber(row.requests))}</td>${errorOnly ? '' : `<td>${technical(formatAsciiBytes(row.bytes))}</td>`}</tr>`).join('')
  const paths = section('v2-traffic-pages', t(msgid('Top pages')),
    table('v2-traffic-page-records', t(msgid('Top pages')), [t(msgid('Path')), t(msgid('Requests')), t(msgid('Transferred'))], entries(observed?.topPaths, 3)))
  const statusRows = ['2xx', '3xx', '4xx', '5xx'].map(code => {
    const count = totals?.[`status${code}` as 'status2xx' | 'status3xx' | 'status4xx' | 'status5xx']
    return `<tr><td>${technical(code)}</td><td>${count === undefined ? esc(t(msgid('Not read'))) : technical(formatAsciiNumber(count))}</td></tr>`
  }).join('')
  const responses = section('v2-traffic-status', t(msgid('Responses by status')),
    table('v2-traffic-status-records', t(msgid('Responses by status')), [t(msgid('Status')), t(msgid('Requests'))], statusRows))
  const errors = section('v2-traffic-errors', t(msgid('Errors by path')),
    table('v2-traffic-error-records', t(msgid('Errors by path')), [t(msgid('Path')), t(msgid('Errors'))], entries(observed?.topPaths.filter(row => (row.errors5xx ?? 0) > 0), 2, true)))
  const referrers = section('v2-traffic-referrers', t(msgid('Top Referrers')),
    table('v2-traffic-referrer-records', t(msgid('Top Referrers')), [t(msgid('Referrer')), t(msgid('Requests')), t(msgid('Transferred'))], entries(observed?.topReferrers, 3)))
  const clients = section('v2-traffic-clients', t(msgid('Top Client IP Addresses')),
    table('v2-traffic-client-records', t(msgid('Top Client IP Addresses')), [t(msgid('Client')), t(msgid('Requests')), t(msgid('Transferred'))], entries(observed?.topClientIps, 3)))
  const latency = section('v2-traffic-cache-latency', t(msgid('Avg / P95 Latency')),
    facts([{ label: t(msgid('Cache Hit Ratio')), valueHtml: totals ? technical(value(totals.cacheHitRatioPercent, 'percent')) : esc(t(msgid('Not read'))) }, { label: t(msgctxt('theme:v2', 'Average request latency')), valueHtml: totals ? technical(value(totals.avgRequestTimeMs, 'ms')) : esc(t(msgid('Not read'))) }, { label: t(msgctxt('theme:v2', 'P95 request latency')), valueHtml: totals ? technical(value(totals.p95RequestTimeMs, 'ms')) : esc(t(msgid('Not read'))) }]))
  const logs = section('v2-traffic-raw-logs', t(msgid('Raw access logs')),
    `<p>${esc(t(msgctxt('theme:v2', 'Read the bounded access log in the site log workspace. Archived log downloads have not been qualified.')))}</p>`
    + (authority?.relatedRoutes?.has('/metrics/logs') ? `<a class="v2-btn" href="/metrics/logs?${esc(params.toString())}">${esc(t(msgid('Read log')))}</a>` : `<button type="button" class="v2-btn" disabled>${esc(t(msgid('Read log')))}</button>`)
    + `<button type="button" class="v2-btn" disabled>${esc(t(msgid('Download logs')))}</button>`)
  return page(locale, route, header(t, route, title, t(msgctxt('theme:v2', 'Visitors, requests, bandwidth and errors for your domains, counted from the Nginx access logs.')))
    + `<div class="v2-panel-extra__groups"${!authority?.canRead || authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''} data-surface-widget="website-analytics" data-chart-state="${readState}"${selected ? ` data-domain="${esc(selected.name)}"` : ''}>${scope}${status}${summary}${requests}<div class="v2-panel-extra__split"><div class="v2-panel-extra__groups"${!authority?.canRead || authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''}>${visitors}${paths}${responses}${errors}${referrers}${clients}</div><aside class="v2-panel-extra__groups"${!authority?.canRead || authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''} aria-label="${esc(t(msgid('Workspace information')))}">${bandwidth}${latency}${logs}</aside></div></div>`)
}

export function renderV2PanelWebStatistics(props: PanelSurfaceProps, authority?: PanelObservationAuthority): string {
  return renderV2PanelTraffic(props, authority, '/metrics/web-stats')
}
