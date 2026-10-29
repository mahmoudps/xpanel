import { type Locale, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

export interface WhmServerObservationPageInput { locale: Locale; canRead: boolean }
type Copy = string

const STYLE = `<style>.xp-whm-server-observation{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-server-observation :is(h2,h3,p,dl,dd){margin:0}.xp-whm-server-observation td[data-numeric],.xp-whm-server-observation th[data-numeric]{text-align:end;font-variant-numeric:tabular-nums;white-space:nowrap}.xp-whm-server-observation td bdi{unicode-bidi:isolate}.xp-whm-server-observation .xp-whm-detail-table th{white-space:nowrap}.xp-whm-server-observation [data-whm-server-observation-drift="missing"]{font-weight:600}</style>`

const helpers = (input: WhmServerObservationPageInput) => {
  const on = input.canRead
  const t = (copy: Copy): string => escapeHtml(translator(input.locale)(copy))
  const page = (kind: string, body: string): string => `<div class="xp-whm-server-observation" data-whm-server-observation="${kind}" data-server-observation-can-read="${on}" lang="${input.locale}" dir="${localeDirection(input.locale)}">${STYLE}${body}</div>`
  const card = (key: string, title: Copy, body: string): string => `<section class="xp-whm-detail-card" data-whm-server-observation-section="${key}" aria-labelledby="whm-server-observation-${key}"><h2 id="whm-server-observation-${key}">${t(title)}</h2>${body}</section>`
  const status = (copy: Copy, marker = 'status'): string => `<p class="xp-whm-detail-status" data-whm-server-observation-${marker} data-state="unread" role="status">${t(copy)}</p>`
  const actions = (refresh: Copy, extra = ''): string => `<div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-whm-server-observation-refresh${on ? '' : ' disabled'}>${t(refresh)}</button>${extra}</div>`
  const facts = (rows: readonly (readonly [string, Copy, boolean?])[]): string => `<dl class="xp-whm-detail-fields">${rows.map(([key, label, technical]) => `<div class="xp-whm-detail-field"><dt>${t(label)}</dt><dd>${technical ? `<bdi dir="ltr" data-whm-server-observation-${key}>` : `<span data-whm-server-observation-${key}>`}${t(msgid('Not read'))}${technical ? '</bdi>' : '</span>'}</dd></div>`).join('')}</dl>`
  const field = (id: string, label: Copy, control: string): string => `<div class="xp-whm-detail-field"><label for="${id}">${t(label)}</label>${control}</div>`
  const table = (label: Copy, marker: string, headers: readonly (readonly [Copy, boolean?])[], empty: Copy): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(label)}"><table class="xp-whm-detail-table"><caption class="sr-only">${t(label)}</caption><thead><tr>${headers.map(([header, numeric]) => `<th scope="col"${numeric ? ' data-numeric' : ''}>${t(header)}</th>`).join('')}</tr></thead><tbody data-whm-server-observation-${marker}><tr><td colspan="${headers.length}">${t(empty)}</td></tr></tbody></table></div>`
  const help = (copy: Copy): string => `<p class="xp-help">${t(copy)}</p>`
  return { t, on, page, card, status, actions, facts, field, table, help }
}

/** /whm/server/cron: systemd timers (system, panel, account cron) and /etc/cron.d names. Read-only. */
export function renderWhmServerTimers(input: WhmServerObservationPageInput): string {
  const h = helpers(input)
  const owners: readonly (readonly [string, Copy])[] = [['', msgid('All timers')], ['system', msgid('System')], ['panel', msgid('Panel')], ['account-cron', msgid('Account cron')]]
  return h.page('timers', h.card('timers', msgid('Scheduled timers'),
    h.help(msgid('Timers are read from systemd. Account cron jobs run as xpanel-cron timers and are managed by each account owner on the xPanel Cron jobs page.'))
    + h.actions(msgid('Read timers'), `<a class="xp-btn" href="/whm/accounts" data-whm-server-observation-accounts>${h.t(msgid('Open accounts'))}</a>`)
    + h.status(msgid('Timers have not been read.'))
    + h.facts([['observed-at', msgid('Observed at (UTC)'), true], ['timer-total', msgid('Timers'), true], ['timer-panel', msgid('Panel timers'), true], ['timer-account', msgid('Account cron timers'), true]])
    + `<div class="xp-whm-detail-fields">${h.field('whm-server-observation-owner', msgid('Owner'), `<select id="whm-server-observation-owner" data-whm-server-observation-owner${h.on ? '' : ' disabled'}>${owners.map(([value, label]) => `<option value="${value}">${h.t(label)}</option>`).join('')}</select>`)}${h.field('whm-server-observation-search', msgid('Search timer or unit'), `<input id="whm-server-observation-search" type="search" dir="ltr" maxlength="255" autocomplete="off" data-whm-server-observation-search${h.on ? '' : ' disabled'}>`)}</div>`
    + h.table(msgid('Systemd timers'), 'timer-rows', [[msgid('Timer')], [msgid('Owner')], [msgid('Activates')], [msgid('Next run (UTC)')], [msgid('Last run (UTC)')]], msgid('No timers have been read.'))
    + h.help(msgid('Running, creating or changing system timers is not available here.')))
  + h.card('cron-directory', msgid('Cron directory'),
    h.help(msgid('Only file names in /etc/cron.d are listed. File contents are never read.'))
    + h.status(msgid('The cron directory has not been read.'), 'cron-status')
    + h.table(msgid('Cron directory entries'), 'cron-rows', [[msgid('Name')], [msgid('Type')]], msgid('No entries have been read.'))))
}

/** /whm/server/networking: interfaces, routes, static hostname, resolvers and IP pool drift. Read-only. */
export function renderWhmServerNetwork(input: WhmServerObservationPageInput): string {
  const h = helpers(input)
  return h.page('network', h.card('identity', msgid('Host identity'),
    h.help(msgid('Read-only. Hostname, resolver, route and address changes are not available here.'))
    + h.actions(msgid('Read network'))
    + h.status(msgid('The network configuration has not been read.'))
    + h.facts([['observed-at', msgid('Observed at (UTC)'), true], ['static-hostname', msgid('Static hostname (/etc/hostname)'), true], ['saved-hostname', msgid('Saved hostname'), true],
      ['hostname-comparison', msgid('Hostname comparison')], ['resolvers', msgid('Resolvers (/etc/resolv.conf)'), true]]))
  + h.card('interfaces', msgid('Interfaces'),
    h.table(msgid('Network interfaces'), 'interface-rows', [[msgid('Interface')], [msgid('State')], ['MTU', true], [msgid('Addresses')]], msgid('No interfaces have been read.')))
  + h.card('pool', msgid('IP pool drift'),
    h.help(msgid('Saved pool addresses are compared with the addresses configured on interfaces. A saved address on no interface is drift.'))
    + h.table(msgid('Saved IP pool'), 'pool-rows', [[msgid('Address')], [msgid('Saved interface')], [msgid('Role')], [msgid('Observed interface')], [msgid('Status')]], msgid('The IP pool has not been compared.'))
    + `<h3>${h.t(msgid('Interface addresses not in the pool'))}</h3>`
    + h.help(msgid('Informational: global addresses configured on this host that the saved pool does not list.'))
    + h.table(msgid('Addresses not in the pool'), 'unpooled-rows', [[msgid('Address')], [msgid('Interface')], [msgid('Prefix'), true]], msgid('No addresses have been compared.')))
  + h.card('routes', msgid('Routes'),
    h.table(msgid('Routes'), 'route-rows', [[msgid('Family')], [msgid('Destination')], [msgid('Gateway')], [msgid('Device')], [msgid('Protocol')], [msgid('Metric'), true]], msgid('No routes have been read.'))))
}

/** /whm/server/role: desired role from saved settings beside observed service states. Read-only. */
export function renderWhmServerRole(input: WhmServerObservationPageInput): string {
  const h = helpers(input)
  return h.page('role', h.card('saved', msgctxt('whm-server-observation-workspace', 'Saved configuration'),
    h.help(msgid('What this server is configured to run, from the saved setup and inventory. Changing the server role is not available.'))
    + h.actions(msgid('Read role'))
    + h.status(msgid('The server role has not been read.'))
    + h.facts([['saved-hostname', msgid('Saved hostname'), true], ['engine', msgid('Web engine'), true], ['setup-completed', msgid('Setup completed (UTC)'), true], ['php-versions', msgid('PHP versions in use'), true],
      ['count-accounts', msgid('Accounts'), true], ['count-domains', msgid('Domains'), true], ['count-mailboxes', msgid('Mailboxes'), true], ['count-databases', msgid('Databases'), true], ['count-zones', msgid('DNS zones'), true]]))
  + h.card('components', msgid('Role components'),
    h.help(msgid('Saved configuration and observed services are shown side by side; neither is inferred from the other.'))
    + h.table(msgid('Role components'), 'component-rows', [[msgid('Component')], [msgid('Saved configuration')], [msgid('Observed services')]], msgid('No role has been read.')))
  + h.card('services', msgid('Observed services'),
    h.facts([['observed-at', msgid('Observed at (UTC)'), true]])
    + h.table(msgid('Observed services'), 'service-rows', [[msgid('Service')], [msgid('Unit')], [msgid('State')]], msgctxt('whm-server-observation-workspace', 'No services have been read.'))))
}
