import type { PanelSurfaceProps } from '../../../../contract.ts'
import { formatAsciiBytes, formatAsciiNumber, formatDisplayDateTime } from '../../../../../display-format.ts'
import { parseWebStatsView, webalizerReportHref, webStatsRunLabel, WEB_STATS_GENERATORS, WEB_STATS_SCHEMES, type WebStatsGenerator, type WebStatsRun, type WebStatsScheme } from '../../../../../models/web-stats.ts'
import { kpiCard, lineChart, notice } from '../../../components/index.ts'
import { check, emailContext, esc, facts, field, fields, header, page, section, select, table, technical } from '../email-tools/common.ts'
import type { PanelObservationAuthority } from './common.ts'
import { ftpReport } from './traffic.ts'

const ROUTE = '/metrics/web-stats'

/** cPanel Metrics: AWStats as a dashboard of the selected site, entry and month; Webalizer as its own report pages. */
export function renderV2PanelWebStatistics(props: PanelSurfaceProps, authority?: PanelObservationAuthority): string {
  const { locale, t, account } = emailContext(props, authority)
  const readOnly = !authority?.canRead || authority.presentation === 'read-only' || !account
  const authorized = authority?.presentation !== 'read-only' || ['web-stats-awstats', 'web-stats-webalizer'].some(id => authority.authorizedTools?.has(id))
  const view = authorized && account && props.webStats !== undefined ? parseWebStatsView(props.webStats, { accountId: account.id }) : null
  const readState = !authorized ? 'unread' : props.webStatsUnavailable || props.webStats !== undefined && !view ? 'unavailable' : view ? view.report ? 'loaded' : 'empty' : 'unread'
  const selection = view?.selection ?? null, report = readState === 'loaded' ? view!.report! : null
  const site = selection ? view!.sites.find(row => row.site === selection.site) : undefined
  const schemeLabel = (scheme: WebStatsScheme): string => scheme === 'https' ? t(msgid('SSL (https)')) : t(msgid('Non-SSL (http)'))
  const number = (value: number | undefined): string => value === undefined ? esc(t(msgid('Not read'))) : technical(formatAsciiNumber(value))
  const bytes = (value: number | undefined): string => value === undefined ? esc(t(msgid('Not read'))) : technical(formatAsciiBytes(value))
  const when = (value: string | null | undefined): string => value ? technical(formatDisplayDateTime(value)) : esc(t(msgid('Not yet')))
  const run = (value: WebStatsRun | null): string => esc(t(webStatsRunLabel(value))) + (value ? ` <span>${technical(formatDisplayDateTime(value.at))}</span>` : '')

  const params = new URLSearchParams({ lang: locale, theme: props.theme ?? 'dark' })
  const months = [...new Set([...(view?.months ?? []).map(row => row.month), ...(selection ? [selection.month] : [])])].sort().reverse()
  const selector = view && selection
    ? `<form method="get" action="${ROUTE}" class="v2-panel-extra__groups"${readOnly ? ' data-readonly="true"' : ''}><input type="hidden" name="lang" value="${esc(locale)}"><input type="hidden" name="theme" value="${esc(props.theme ?? 'dark')}">${fields(
      field('v2-web-stats-site', t(msgid('Domain')), select('v2-web-stats-site', view.sites.map(row => [row.site, row.site] as const), undefined, readOnly, ' name="site" dir="ltr"', selection.site))
      + field('v2-web-stats-scheme', t(msgid('Entry')), select('v2-web-stats-scheme', WEB_STATS_SCHEMES.map(scheme => [scheme, schemeLabel(scheme)] as const), undefined, readOnly, ' name="scheme"', selection.scheme))
      + field('v2-web-stats-month', t(msgid('Month')), select('v2-web-stats-month', months.map(month => [month, month] as const), undefined, readOnly, ' name="month" dir="ltr"', selection.month)))}<div class="v2-panel-extra__actions"><button type="submit" class="v2-btn"${readOnly ? ' disabled' : ''}>${esc(t(msgid('Show')))}</button></div></form>`
    : `<p data-state="${readState}" role="status">${esc(t(view ? msgid('No site of this account is served yet.') : msgid('Not read')))}</p>`
  const scope = section('v2-web-stats-selection', t(msgid('Report selection')), selector)

  const installed = view ? (['awstats', 'webalizer'] as const).filter(engine => view.engines[engine].installed && view.engines[engine].entitled) : []
  const statusCopy = readState === 'unavailable' ? t(msgid('The web statistics could not be read. No report or total is shown.'))
    : readState === 'unread' ? t(msgid('The web statistics have not been read. No report or total is shown.'))
      : !installed.length ? t(msgid('Neither AWStats nor Webalizer is available to this account on this server, so no report is generated.'))
        : readState === 'empty' ? t(msgid('No AWStats report exists for this month and entry yet. Reports are generated once a day from the Nginx access logs; the next run is shown under Schedule.'))
          : t(msgid('AWStats report generated from the Nginx access logs of this site. Today is complete only after the next daily run.'))
  const status = notice(t, { tone: readState === 'loaded' ? 'info' : 'warn', lead: readState === 'loaded' ? t(msgid('AWStats report')) : t(msgid('No report shown')), text: statusCopy })

  const summary = `<section class="v2-kpi-row" aria-label="${esc(t(msgid('Month summary')))}">${[
    { label: t(msgid('Unique visitors')), value: report?.unique, icon: 'users' as const },
    { label: t(msgid('Visits')), value: report?.visits, icon: 'activity' as const },
    { label: t(msgid('Pages')), value: report?.pages, icon: 'files' as const },
    { label: t(msgid('Hits')), value: report?.hits, icon: 'layers' as const },
    { label: t(msgid('Bandwidth')), value: report?.bytes, icon: 'globe' as const, unit: 'bytes' as const },
  ].map(item => kpiCard({ label: item.label, value: item.value === undefined ? t(msgid('Not read')) : item.unit ? formatAsciiBytes(item.value) : formatAsciiNumber(item.value), headingLevel: 2, icon: item.icon, tone: item.value === undefined ? 'neutral' : 'info', note: selection?.month ?? t(msgid('Not read')) })).join('')}</section>`

  const empty = (columns: number): string => `<tr><td colspan="${columns}">${esc(t(report ? msgid('No records were returned.') : msgid('Nothing has been read.')))}</td></tr>`
  const tableOf = (id: string, title: string, columns: string[], rows: string[][] | undefined): string =>
    section(id, title, table(id + '-records', title, columns, rows?.length ? rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('') : empty(columns.length)))
  const daysChart = report?.days.length
    ? lineChart({ label: t(msgid('Pages per day')), series: [{ label: t(msgid('Pages')), values: report.days.map(day => day[1]) }, { label: t(msgid('Hits')), values: report.days.map(day => day[2]) }],
      max: Math.max(1, ...report.days.map(day => day[2])), xTicks: [report.days[0]![0], report.days[report.days.length - 1]![0]], yTicks: [formatAsciiNumber(Math.max(0, ...report.days.map(day => day[2]))), '0'], height: 230 })
    : `<p data-chart-state="${readState}" role="status">${esc(statusCopy)}</p>`
  const days = section('v2-web-stats-days', t(msgid('Days of month')), daysChart + table('v2-web-stats-day-records', t(msgid('Days of month')), [t(msgid('Day')), t(msgid('Visits')), t(msgid('Pages')), t(msgid('Hits')), t(msgid('Bandwidth'))],
    report?.days.length ? report.days.map(([day, pages, hits, size, visits]) => `<tr><td>${technical(day)}</td><td>${number(visits)}</td><td>${number(pages)}</td><td>${number(hits)}</td><td>${bytes(size)}</td></tr>`).join('') : empty(5)))
  const history = tableOf('v2-web-stats-history', t(msgid('Monthly history')), [t(msgid('Month')), t(msgid('Unique visitors')), t(msgid('Visits')), t(msgid('Pages')), t(msgid('Hits')), t(msgid('Bandwidth'))],
    view?.months.map(row => {
      const query = new URLSearchParams(params); query.set('site', selection!.site); query.set('scheme', selection!.scheme); query.set('month', row.month)
      return [`<a href="${esc(`${ROUTE}?${query}`)}"${row.month === selection?.month ? ' aria-current="true"' : ''}>${technical(row.month)}</a>`, number(row.unique), number(row.visits), number(row.pages), number(row.hits), bytes(row.bytes)]
    }))
  const hours = tableOf('v2-web-stats-hours', t(msgid('Hours (UTC)')), [t(msgid('Hour')), t(msgid('Pages')), t(msgid('Hits')), t(msgid('Bandwidth'))], report?.hours.map(([hour, pages, hits, size]) => [technical(String(hour).padStart(2, '0') + ':00'), number(pages), number(hits), bytes(size)]))
  const countries = tableOf('v2-web-stats-countries', t(msgid('Countries')), [t(msgid('Country')), t(msgid('Pages')), t(msgid('Hits')), t(msgid('Bandwidth'))], report?.countries.map(([code, pages, hits, size]) => [technical(code), number(pages), number(hits), bytes(size)]))
  const browsers = tableOf('v2-web-stats-browsers', t(msgid('Browsers')), [t(msgid('Browser')), t(msgid('Hits'))], report?.browsers.map(([code, hits]) => [technical(code), number(hits)]))
  const systems = tableOf('v2-web-stats-os', t(msgid('Operating systems')), [t(msgid('Operating system')), t(msgid('Hits'))], report?.os.map(([code, hits]) => [technical(code), number(hits)]))
  const codes = tableOf('v2-web-stats-status', t(msgid('HTTP status codes')), [t(msgid('Status')), t(msgid('Hits')), t(msgid('Bandwidth'))], report?.status.map(([code, hits, size]) => [technical(code), number(hits), bytes(size)]))
  const urls = tableOf('v2-web-stats-pages', t(msgid('Pages and URLs')), [t(msgid('Path')), t(msgid('Pages')), t(msgid('Bandwidth')), t(msgid('Entry')), t(msgid('Exit'))], report?.urls.map(([url, pages, size, entry, exit]) => [technical(url), number(pages), bytes(size), number(entry), number(exit)]))
  const referrers = tableOf('v2-web-stats-referrers', t(msgid('Referring pages')), [t(msgid('Referrer')), t(msgid('Pages')), t(msgid('Hits'))], report?.referrers.map(([url, pages, hits]) => [technical(url), number(pages), number(hits)]))
  const robots = tableOf('v2-web-stats-robots', t(msgid('Robots and spiders')), [t(msgid('Robot')), t(msgid('Hits')), t(msgid('Bandwidth'))], report?.robots.map(([code, hits, size]) => [technical(code), number(hits), bytes(size)]))

  const scheme = selection && site ? site.schemes[selection.scheme] : undefined
  const engineFacts = (engine: 'awstats' | 'webalizer'): string => !view ? esc(t(msgid('Not read')))
    : !view.engines[engine].entitled ? esc(t(msgid('Not included in your plan'))) : !view.engines[engine].installed ? esc(t(msgid('Not installed on this server'))) : scheme ? run(scheme[engine]) : esc(t(msgid('Not read')))
  const webalizerOpen = !readOnly && view && selection && scheme?.webalizer?.state === 'updated' && view.engines.webalizer.installed && view.engines.webalizer.entitled
  const analogFact = esc(t(!view ? msgid('Not read') : !view.engines.analog.entitled ? msgid('Not included in your plan') : view.sites.find(row => row.site === selection?.site)?.selected.includes('analog') === false ? msgid('Turned off for this site') : msgid('Shown on the Traffic page')))
  const engines = section('v2-web-stats-engines', t(msgid('Statistics engines')), facts([
    { label: 'Analog', valueHtml: analogFact },
    { label: 'AWStats', valueHtml: engineFacts('awstats') },
    { label: 'Webalizer', valueHtml: engineFacts('webalizer') },
  ]) + (webalizerOpen ? `<a class="v2-btn" href="${esc(webalizerReportHref(selection.site, selection.scheme))}" target="_blank" rel="noopener noreferrer">${esc(t(msgid('Open Webalizer report')))}</a>`
    : ''))
  const schedule = section('v2-web-stats-schedule', t(msgid('Schedule')), facts([
    { label: t(msgid('Processing interval (hours)')), valueHtml: view?.schedule.intervalHours != null ? technical(view.schedule.intervalHours) : esc(t(msgid('Not read'))) },
    { label: t(msgid('Last run')), valueHtml: view ? when(view.schedule.lastRunAt) : esc(t(msgid('Not read'))) },
    { label: t(msgid('Next run')), valueHtml: view ? when(view.schedule.nextRunAt) : esc(t(msgid('Not read'))) },
    { label: t(msgid('Waiting for the next run')), valueHtml: bytes(scheme?.pendingBytes) },
    { label: t(msgid('Lines not processed')), valueHtml: scheme ? technical(formatAsciiNumber(scheme.droppedLines)) : esc(t(msgid('Not read'))) },
    { label: t(msgid('Log not read')), valueHtml: bytes(scheme?.lostBytes) },
  ]))
  const geoip = section('v2-web-stats-geoip', t(msgid('Visitor countries')), facts([
    { label: t(msgid('Location database')), valueHtml: view ? view.geoip.installed ? `${esc(view.geoip.source)} ${technical(view.geoip.month ?? '')}` : esc(t(msgid('Not installed; countries are not resolved'))) : esc(t(msgid('Not read'))) },
  ]) + `<p><a href="https://db-ip.com" rel="noopener noreferrer" target="_blank">${esc(t(msgid('IP Geolocation by DB-IP')))}</a></p>`)
  const sites = section('v2-web-stats-sites', t(msgid('Sites')), table('v2-web-stats-site-records', t(msgid('Sites')), [t(msgid('Domain')), t(msgid('Entry')), 'AWStats', 'Webalizer'],
    view?.sites.length ? view.sites.flatMap(row => WEB_STATS_SCHEMES.map(entry => {
      const query = new URLSearchParams(params); query.set('site', row.site); query.set('scheme', entry); if (selection) query.set('month', selection.month)
      return `<tr><td><a href="${esc(`${ROUTE}?${query}`)}">${technical(row.site)}</a></td><td>${esc(schemeLabel(entry))}</td><td>${run(row.schemes[entry].awstats)}</td><td>${run(row.schemes[entry].webalizer)}</td></tr>`
    })).join('') : empty(4)))

  const editable = !readOnly && authority?.authorizedTools?.has('metrics-editor') === true && view?.choice.revision != null
  const label = (engine: WebStatsGenerator): string => engine === 'analog' ? 'Analog' : engine === 'awstats' ? 'AWStats' : 'Webalizer'
  const locks = (engine: WebStatsGenerator): boolean => !view!.choice.choosable.includes(engine) || !view!.engines[engine].installed || !view!.engines[engine].entitled
  const editorRows = view?.sites.length ? view.sites.map(row => `<tr><td>${technical(row.site)}</td>${WEB_STATS_GENERATORS.map(engine => `<td>${check(`v2-web-stats-choice-${engine}-${row.site}`, label(engine), { 'data-web-stats-choice': true, 'data-site': row.site, 'data-engine': engine, 'data-locked': String(locks(engine)) }, true, row.selected.includes(engine))}</td>`).join('')}</tr>`).join('') : empty(4)
  const editor = section('v2-web-stats-metrics', t(msgid('Metrics Editor')), `<p>${esc(t(view && WEB_STATS_GENERATORS.some(engine => !view.choice.choosable.includes(engine)) ? msgid('The server administrator controls at least one engine; it stays as set.') : msgid('Choose which statistics engines run for each site. A change applies to the next run.')))}</p>`
    + table('v2-web-stats-metrics-records', t(msgid('Metrics Editor')), [t(msgid('Domain')), 'Analog', 'AWStats', 'Webalizer'], editorRows)
    + `<div class="v2-panel-extra__actions"><button type="button" class="v2-btn v2-btn--primary" data-web-stats-metrics-save disabled>${esc(t(msgid('Save')))}</button></div><p role="status" data-web-stats-metrics-status data-state="idle"></p>`,
    { 'data-web-stats-metrics': true, 'data-web-stats-enabled': String(editable), 'data-web-stats-revision': view?.choice.revision ?? '' })

  return page(locale, ROUTE, header(t, ROUTE, t(msgid('Web statistics')), t(msgid('AWStats and Webalizer reports for your sites, generated daily from the Nginx access logs.')))
    + `<div class="v2-panel-extra__groups"${readOnly ? ' data-readonly="true"' : ''} data-surface-widget="web-stats" data-chart-state="${readState}">${scope}${status}${summary}${days}${ftpReport(props, authority)}<div class="v2-panel-extra__split"><div class="v2-panel-extra__groups">${history}${hours}${countries}${browsers}${systems}${codes}${urls}${referrers}${robots}</div><aside class="v2-panel-extra__groups" aria-label="${esc(t(msgid('Workspace information')))}">${engines}${editor}${schedule}${geoip}${sites}</aside></div></div>`)
}
