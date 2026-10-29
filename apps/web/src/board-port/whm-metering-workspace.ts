import { localeDirection, translator, type Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

export interface WhmMeteringPageInput { locale: Locale; canRead: boolean }
type Copy = string

const STYLE = `<style>.xp-whm-metering{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-metering :is(h2,p,dl,dd){margin:0}.xp-whm-metering td[data-numeric],.xp-whm-metering th[data-numeric]{text-align:end;font-variant-numeric:tabular-nums;white-space:nowrap}.xp-whm-metering td{overflow-wrap:anywhere}.xp-whm-metering [data-level="warn"]{color:var(--xp-warning-text,#b54708)}.xp-whm-metering [data-level="critical"]{color:var(--xp-danger-text,#b42318)}.xp-whm-metering__table--io{min-inline-size:56rem}.xp-whm-metering__table--devices{min-inline-size:32rem}.xp-whm-metering__table--bandwidth{min-inline-size:64rem}</style>`

const helpers = (locale: Locale) => {
  const t = (copy: Copy): string => escapeHtml(translator(locale)(copy))
  const card = (key: string, title: Copy, body: string): string => `<section class="xp-whm-detail-card" aria-labelledby="whm-metering-${key}"><h2 id="whm-metering-${key}">${t(title)}</h2>${body}</section>`
  const facts = (rows: readonly (readonly [string, Copy])[]): string => `<dl class="xp-whm-detail-fields">${rows.map(([key, label]) => `<div class="xp-whm-detail-field"><dt>${t(label)}</dt><dd><bdi dir="ltr" data-whm-metering-fact="${key}">${t(msgid('Not read'))}</bdi></dd></div>`).join('')}</dl>`
  const table = (kind: string, label: Copy, headers: readonly (readonly [Copy, boolean?])[], empty: Copy): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(label)}"><table class="xp-whm-detail-table xp-table xp-whm-metering__table--${kind}"><caption class="xp-sr-only">${t(label)}</caption><thead><tr>${headers.map(([header, numeric]) => `<th scope="col"${numeric ? ' data-numeric' : ''}>${t(header)}</th>`).join('')}</tr></thead><tbody data-whm-metering-rows="${kind}"><tr><td colspan="${headers.length}">${t(empty)}</td></tr></tbody></table></div>`
  const controls = (button: Copy, unread: Copy, enabled: boolean): string => `<div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-whm-metering-refresh${enabled ? '' : ' disabled'}>${t(button)}</button></div><p class="xp-whm-detail-status" data-whm-metering-status data-state="${enabled ? 'unread' : 'unavailable'}" role="status">${t(enabled ? unread : msgid('Metering requires an authorized root administrator on a qualified host.'))}</p>`
  return { t, card, facts, table, controls }
}
const page = (kind: 'io' | 'bandwidth', input: WhmMeteringPageInput, body: string): string =>
  `<div class="xp-whm-metering" data-whm-metering="${kind}" data-metering-can-read="${input.canRead}" lang="${input.locale}" dir="${localeDirection(input.locale)}">${STYLE}${body}</div>`

/** /whm/monitoring/io: the latest cached per-account cgroup sample with plan limits, and disk latency from the host collector. No history is recorded. */
export function renderWhmIoWorkspace(input: WhmMeteringPageInput): string {
  const h = helpers(input.locale)
  return page('io', input, h.card('usage', msgid('Resource usage'), `<p class="xp-help">${h.t(msgid('Account resources and configured limits.'))}</p>`
    + h.controls(msgid('Read resources'), msgid('Resource usage has not been read.'), input.canRead)
    + h.facts([['observed', msgid('Sampled at (UTC)')], ['read', msgid('Account read total')], ['write', msgid('Account write total')], ['iops', msgid('Account IOPS total')], ['latency', msgid('Disk latency')], ['pressure', msgid('IO pressure')], ['host', msgid('Host CPU and memory')]]))
    + h.card('history', msgid('Read and write history'), `<p class="xp-help">${h.t(msgid('Account IO history is not recorded. Each read shows the latest sample; host history is in Performance history.'))}</p><a class="xp-btn" href="/whm/monitoring/performance">${h.t(msgid('Open performance history'))}</a>`)
    + h.card('devices', msgid('Disk devices'), `<p class="xp-help">${h.t(msgid('Average wait per completed operation and busy time over the last host sample interval, from /proc/diskstats.'))}</p>`
      + h.table('devices', msgid('Disk devices'), [[msgid('Device')], [msgid('Read wait'), true], [msgid('Write wait'), true], [msgid('Busy'), true]], msgid('No disk devices have been read.')))
    + h.card('accounts', msgid('Account resources'), `<p class="xp-help" data-whm-metering-count>${h.t(msgid('Not read'))}</p>`
      + h.table('io', msgid('Account resources'), [[msgid('Account')], [msgid('Read / write'), true], ['IOPS', true], [msgid('Memory'), true], [msgid('CPU (% of 1 core)'), true], [msgid('Processes'), true]], msgid('No account resources have been read.'))))
}

/** /whm/accounts/bandwidth: this UTC month's web, mail and FTP traffic per account against the plan's monthly limit. */
export function renderWhmBandwidthWorkspace(input: WhmMeteringPageInput): string {
  const h = helpers(input.locale)
  return page('bandwidth', input, h.card('bandwidth', msgid('Bandwidth per account'), `<p class="xp-help">${h.t(msgid('Traffic this month (UTC), counted from the saved site access logs, the Postfix delivery journal and the FTP transfer journal. Each source is sent plus received bytes.'))}</p>`
    + `<p class="xp-help">${h.t(msgid('A plan with bandwidth enforcement on serves a bandwidth-exceeded page on its websites once the monthly limit is used, until the next month (UTC) or until the limit is raised. Mail, FTP and the panels keep working. Other plans are only compared.'))}</p>`
    + h.controls(msgid('Read bandwidth'), msgid('Bandwidth has not been read.'), input.canRead)
    + h.facts([['month', msgid('Month (UTC)')], ['since', msgid('Counted since (UTC)')], ['updated', msgid('Last counted (UTC)')], ['pending', msgid('Log data not yet counted')], ['web', msgid('Web logs')], ['mail', msgid('Mail journal')], ['ftp', msgid('FTP journal')]])
    + h.table('bandwidth', msgid('Bandwidth per account'), [[msgid('Account')], [msgid('Domain')], [msgid('Status')], [msgid('Web'), true], [msgid('Mail'), true], ['FTP', true], [msgid('Total'), true], [msgid('Plan limit'), true]], msgid('No bandwidth has been read.'))))
}
