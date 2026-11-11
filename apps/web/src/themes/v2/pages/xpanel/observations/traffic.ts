import type { WebsiteTopEntry } from '@xpanel/core'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { formatAsciiBytes, formatAsciiNumber, formatDisplayDateTime } from '../../../../../display-format.ts'
import { parseWebsiteAnalyticsSnapshot, WEBSITE_ANALYTICS_WINDOWS, type WebsiteAnalyticsWindow } from '../../../../../models/website-analytics.ts'
import { kpiCard, lineChart, notice, statusPill } from '../../../components/index.ts'
import { actions, button, emailContext, esc, facts, field, fields, header, missingAccount, page, section, select, table, technical, unread } from '../email-tools/common.ts'
import { blankState, pair, strip, tableCard, type PanelObservationAuthority } from './common.ts'

export function renderV2PanelTraffic(props: PanelSurfaceProps, authority?: PanelObservationAuthority): string {
  const route = '/metrics/traffic'
  const { locale, t, account, domains } = emailContext(props, authority)
  const title = t(msgctxt('theme:v2', 'Traffic & bandwidth'))
  const requestedDomain = props.activeDomain ?? (account?.primaryDomain ?? '')
  const selected = domains?.find(row => row.name === requestedDomain) ?? (props.activeDomain === undefined ? domains?.[0] : undefined)
  const factTools = ['traffic-monitor-account', 'bandwidth']
  const factsAuthorized = authority?.presentation !== 'read-only' || factTools.some(id => authority.authorizedTools?.has(id))
  const snapshot = factsAuthorized && selected && props.websiteAnalytics !== undefined
    ? parseWebsiteAnalyticsSnapshot(props.websiteAnalytics, { accountId: (account?.id ?? ''), domain: selected.name }) : null
  const readState = props.websiteAnalyticsUnavailable || props.websiteAnalytics !== undefined && !snapshot
    ? 'unavailable' : snapshot ? snapshot.series.length ? 'loaded' : 'empty' : 'unread'
  const observed = readState === 'loaded' ? snapshot! : undefined
  // The Analog switch withholds these lists, so they read as not read rather than empty.
  const report = observed?.analog === 'off' ? undefined : observed
  const window = props.websiteAnalyticsWindow && WEBSITE_ANALYTICS_WINDOWS.includes(props.websiteAnalyticsWindow) ? props.websiteAnalyticsWindow : undefined
  const windowLabel = (value: WebsiteAnalyticsWindow): string => value === '1h' ? t(msgid('Last hour')) : value === '24h' ? t(msgid('Last 24 hours')) : value === '7d' ? t(msgid('Last 7 days')) : t(msgid('Last 30 days'))
  const params = new URLSearchParams({ lang: locale, theme: props.theme ?? 'dark', ...(selected ? { domain: selected.name } : {}) })
  const windowLinks = `<div class="v2-panel-obs-seg" role="group" aria-label="${esc(t(msgid('Range')))}">${WEBSITE_ANALYTICS_WINDOWS.map(value => {
    const query = new URLSearchParams(params); query.set('window', value)
    return `<a href="${esc(`${route}?${query}`)}"${value === window ? ' aria-current="true"' : ''}>${esc(windowLabel(value))}</a>`
  }).join('')}</div>`
  const domainField = field('v2-traffic-domain', t(msgid('Domain')), select('v2-traffic-domain', (domains ?? []).map(domain => [domain.name, domain.name] as const), undefined, !authority?.domainSelectionAvailable, ' name="domain" dir="ltr"', selected?.name))
  const domainForm = authority?.domainSelectionAvailable
    ? `<form method="get" action="${route}" class="v2-panel-extra__groups"${!authority?.canRead || authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''}>${domainField}<input type="hidden" name="lang" value="${esc(locale)}"><input type="hidden" name="theme" value="${esc(props.theme ?? 'dark')}">${window ? `<input type="hidden" name="window" value="${window}">` : ''}<div class="v2-panel-extra__actions"><button type="submit" class="v2-btn">${esc(t(msgid('Show')))}</button></div></form>`
    : domainField
  const scope = section('v2-traffic-selection', t(msgid('Traffic selection')),
    `<div class="v2-panel-obs-select">${domainForm}<div class="v2-field"><span class="v2-label">${esc(t(msgid('Range')))}</span>${windowLinks}</div></div>`)
  const meta = `<ul class="v2-panel-obs-meta"><li>${esc(t(msgid('Observed at')))} ${snapshot ? technical(formatDisplayDateTime(snapshot.at)) : esc(t(msgid('Not read')))}</li><li>${esc(readState === 'empty' ? t(msgid('Empty observation')) : readState === 'loaded' ? t(msgctxt('theme:v2', 'Account-scoped log observation')) : t(msgid('Not read')))}</li></ul>`
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
    if (!observed) return blankState(statusCopy, readState)
    const series = observed.series.map(row => row[kind])
    const caption = kind === 'requests' ? t(msgid('Requests')) : t(msgid('Transferred'))
    return lineChart({ label: caption, series: [{ label: caption, values: series }], max: Math.max(1, ...series), xTicks: observed.series.length ? [formatDisplayDateTime(observed.series[0]!.at), formatDisplayDateTime(observed.series[observed.series.length - 1]!.at)] : [], yTicks: [value(Math.max(0, ...series), kind === 'bytes' ? 'bytes' : undefined), '0'], height: kind === 'bytes' ? 150 : 230 })
  }
  const notRead = esc(t(msgid('Not read')))
  const requests = section('v2-traffic-requests', t(msgid('Requests')), chartBody('requests'))
  const bandwidthChart = section('v2-traffic-bandwidth-chart', t(msgid('Bandwidth')), chartBody('bytes'))
  const bandwidth = tableCard('v2-traffic-bandwidth', t(msgid('Bandwidth by domain')), [t(msgid('Domain')), t(msgid('Transferred'))],
    `<tr><td>${selected ? technical(selected.name) : notRead}</td><td>${totals ? technical(formatAsciiBytes(totals.bytes)) : notRead}</td></tr>`,
    { description: window ? windowLabel(window) : t(msgctxt('theme:v2', 'The observation window was not supplied.')), afterHtml: `<p>${esc(t(msgctxt('theme:v2', 'Only the selected domain is read. Other domains and the plan month total are not part of this observation.')))}</p>` })
  const entries = (rows: readonly WebsiteTopEntry[] | undefined, columns: number, errorOnly = false): string => rows === undefined ? unread(t, columns) : rows.length === 0
    ? `<tr><td colspan="${columns}">${esc(t(msgid('No records were returned.')))}</td></tr>`
    : rows.map(row => `<tr><td>${technical(row.country ? `${row.key} ${row.country}` : row.key)}</td>${errorOnly ? `<td>${statusPill({ tone: 'bad', label: '5xx' })}</td>` : ''}<td>${technical(errorOnly ? row.errors5xx! : formatAsciiNumber(row.requests))}</td>${errorOnly ? '' : `<td>${technical(formatAsciiBytes(row.bytes))}</td>`}</tr>`).join('')
  const paths = tableCard('v2-traffic-page', t(msgid('Top pages')), [t(msgid('Path')), t(msgid('Requests')), t(msgid('Transferred'))], entries(report?.topPaths, 3))
  const codes = (['2xx', '3xx', '4xx', '5xx'] as const).map((code, index) => ({ code, tone: (['ok', 'info', 'warn', 'bad'] as const)[index]!, count: totals?.[`status${code}`] }))
  const responsesTotal = codes.reduce((sum, row) => sum + (row.count ?? 0), 0)
  const statusRows = codes.map(row => `<tr><td><span class="v2-panel-obs-tone" data-tone="${row.tone}">${technical(row.code)}</span></td><td>${row.count === undefined ? notRead : technical(formatAsciiNumber(row.count))}</td><td>${row.count === undefined ? notRead : responsesTotal > 0 ? technical(`${formatAsciiNumber(row.count / responsesTotal * 100, { decimals: 1 })}%`) : '—'}</td></tr>`).join('')
  const statusBar = totals && responsesTotal > 0 ? `<div class="v2-panel-obs-bar" aria-hidden="true">${codes.filter(row => row.count).map(row => `<span data-tone="${row.tone}" style="flex-grow:${row.count}"></span>`).join('')}</div>` : ''
  const responses = tableCard('v2-traffic-status', t(msgid('Responses by status')), [t(msgid('Status')), t(msgid('Requests')), t(msgid('Share'))], statusRows, statusBar ? { beforeHtml: statusBar } : {})
  const errors = tableCard('v2-traffic-error', t(msgid('Errors by path')), [t(msgid('Path')), t(msgid('Status')), t(msgid('Errors'))], entries(report?.topPaths.filter(row => (row.errors5xx ?? 0) > 0), 3, true))
  const referrers = tableCard('v2-traffic-referrer', t(msgid('Top Referrers')), [t(msgid('Referrer')), t(msgid('Requests')), t(msgid('Transferred'))], entries(report?.topReferrers, 3))
  const clients = tableCard('v2-traffic-client', t(msgid('Top Client IP Addresses')), [t(msgid('Client')), t(msgid('Requests')), t(msgid('Transferred'))], entries(report?.topClientIps, 3))
  const visitors = section('v2-traffic-visitors', t(msgid('Unique visitors per day')),
    blankState(t(msgid('Daily visitor readings have not been read. Request totals do not establish a daily visitor series.')), 'unread')
    + facts([{ label: t(msgid('Unique visitors')), valueHtml: totals ? technical(totals.uniqueVisitors) : notRead }]))
  const latency = section('v2-traffic-cache-latency', t(msgid('Avg / P95 Latency')),
    facts([{ label: t(msgid('Cache Hit Ratio')), valueHtml: totals ? technical(value(totals.cacheHitRatioPercent, 'percent')) : notRead }, { label: t(msgctxt('theme:v2', 'Average request latency')), valueHtml: totals ? technical(value(totals.avgRequestTimeMs, 'ms')) : notRead }, { label: t(msgctxt('theme:v2', 'P95 request latency')), valueHtml: totals ? technical(value(totals.p95RequestTimeMs, 'ms')) : notRead }]))
  const logs = section('v2-traffic-raw-logs', t(msgid('Raw access logs')),
    `<p>${esc(t(msgctxt('theme:v2', 'Read the bounded access log in the site log workspace. Archived log downloads have not been qualified.')))}</p>`
    + actions(authority?.relatedRoutes?.has('/metrics/logs') ? `<a class="v2-btn" href="/metrics/logs?${esc(params.toString())}">${esc(t(msgid('Read log')))}</a>` : `<button type="button" class="v2-btn" disabled>${esc(t(msgid('Read log')))}</button>`))
  const readonly = !authority?.canRead || authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''
  return page(locale, route, header(t, route, title, t(msgctxt('theme:v2', 'Visitors, requests, bandwidth and errors for your domains, counted from the Nginx access logs.'))) + meta
    + `<div class="v2-panel-extra__groups"${readonly} data-surface-widget="website-analytics" data-chart-state="${readState}"${selected ? ` data-domain="${esc(selected.name)}"` : ''}>${scope}${status}${summary}${requests}${pair(bandwidthChart, bandwidth)}${pair(`<div class="v2-panel-extra__groups">${paths}${errors}</div>`, responses)}${pair(referrers, clients, true)}${strip(latency + visitors + logs)}</div>`)
}

export const ftpReport = (props: PanelSurfaceProps, authority: PanelObservationAuthority | undefined): string => {
  const { t } = emailContext(props, authority), fact = (key: string, label: string): { label: string; valueHtml: string } => ({ label, valueHtml: `<bdi dir="ltr" data-ftp-report-fact="${key}">${esc(t(msgid('Not read')))}</bdi>` })
  const rows = (id: string, label: string, heads: readonly string[], hook: string): string => table(id, label, heads, '', { [hook]: true })
  return `<div data-ftp-report${authority?.canRead && authority.presentation !== 'read-only' ? '' : ' data-readonly="true"'}>` + section('v2-ftp-report', t(msgid('FTP statistics')),
    `<div class="v2-panel-obs-select">${field('v2-ftp-report-month', t(msgid('Month')), '<input id="v2-ftp-report-month" type="month" dir="ltr" data-ftp-report-month>')}${actions(button(t(msgid('Read FTP report')), { 'data-ftp-report-read': true }, false))}</div>`
    + `<p role="status" data-state="unread" data-ftp-report-status>${esc(t(msgid('The FTP report has not been read.')))}</p>` + facts([fact('transfers', t(msgid('Transfers'))), fact('downloads', t(msgid('Downloads'))), fact('uploads', t(msgid('Uploads'))), fact('bytes', t(msgid('Data transferred')))])
    + rows('v2-ftp-report-days', t(msgid('Transfers by day')), [t(msgid('Day')), t(msgid('Transfers')), t(msgid('Data transferred'))], 'data-ftp-report-days')
    + rows('v2-ftp-report-hours', t(msgid('Transfers by hour (UTC)')), [t(msgid('Hour')), t(msgid('Transfers')), t(msgid('Data transferred'))], 'data-ftp-report-hours')
    + rows('v2-ftp-report-users', t(msgid('Transfers by FTP login')), [t(msgid('Login')), t(msgid('Downloads')), t(msgid('Uploads')), t(msgid('Data transferred'))], 'data-ftp-report-users')) + '</div>'
}
