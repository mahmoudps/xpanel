import { type Locale, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { classicWhmDiagnosticTemplates } from './whm-diagnostic-client-templates.ts'

export interface WhmServerHealthPageInput { locale: Locale; canRead: boolean }
type Copy = string

const STYLE = `<style>.xp-whm-server-health{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-server-health :is(h2,h3,h4,p,dl,dd,ul,pre){margin:0}.xp-whm-server-health__list{display:flex;flex-direction:column;gap:16px;padding:0;list-style:none;min-inline-size:0}.xp-whm-server-health__item{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;min-inline-size:0}.xp-whm-server-health__item[data-state="problem"]{border-color:var(--xp-danger,#b42318)}.xp-whm-server-health__item[data-state="warning"]{border-color:var(--xp-warning,#b54708)}.xp-whm-server-health__head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between}.xp-whm-server-health__head :is(h3,h4){font-size:16px;line-height:1.6;overflow-wrap:anywhere}.xp-whm-server-health__items{display:flex;flex-direction:column;gap:8px;padding:0;padding-inline-start:16px;list-style:none;border-inline-start:2px solid var(--xp-border,#e2e6ec)}.xp-whm-server-health__items li{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-server-health__evidence{max-block-size:240px;overflow:auto;padding:16px;border-radius:8px;background:var(--xp-bg-elevated);white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6;text-align:start}.xp-whm-server-health details{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-server-health summary{cursor:pointer;min-block-size:44px;align-content:center;font-weight:600;overflow-wrap:anywhere}.xp-whm-server-health details[open]>:not(summary){margin-block-start:16px}.xp-whm-server-health td[data-numeric],.xp-whm-server-health th[data-numeric]{text-align:end;font-variant-numeric:tabular-nums;white-space:nowrap}.xp-whm-server-health :is(button,a,summary,pre,input,select):focus-visible{outline:2px solid var(--xp-accent,#1d5bd6);outline-offset:2px}.xp-whm-server-health :disabled{cursor:not-allowed;opacity:.75}</style>`

const helpers = (input: WhmServerHealthPageInput) => {
  const on = input.canRead
  const t = (copy: Copy): string => escapeHtml(translator(input.locale)(copy))
  const page = (kind: 'health' | 'limits', body: string): string => `<div class="xp-whm-server-health" data-whm-server-health="${kind}" data-server-health-can-read="${on}" lang="${input.locale}" dir="${localeDirection(input.locale)}">${STYLE}${classicWhmDiagnosticTemplates()}${body}</div>`
  const card = (key: string, title: Copy, body: string): string => `<section class="xp-whm-detail-card" data-whm-server-health-section="${key}" aria-labelledby="whm-server-health-${key}"><h2 id="whm-server-health-${key}">${t(title)}</h2>${body}</section>`
  const status = (copy: Copy): string => `<p class="xp-whm-detail-status" data-whm-server-health-status data-state="${on ? 'unread' : 'unavailable'}" role="status">${t(copy)}</p>`
  const button = (copy: Copy, primary = false): string => `<button type="button" class="xp-btn${primary ? ' xp-btn--primary' : ''}" data-whm-server-health-refresh${on ? '' : ' disabled'}>${t(copy)}</button>`
  const link = (href: string, copy: Copy): string => `<a class="xp-btn" href="${href}">${t(copy)}</a>`
  const facts = (rows: readonly (readonly [string, Copy])[]): string => `<dl class="xp-whm-detail-fields">${rows.map(([key, label]) => `<div class="xp-whm-detail-field"><dt>${t(label)}</dt><dd><bdi dir="ltr" data-whm-server-health-${key}>${t(msgid('Not read'))}</bdi></dd></div>`).join('')}</dl>`
  const help = (copy: Copy): string => `<p class="xp-help">${t(copy)}</p>`
  const table = (label: Copy, marker: string, headers: readonly (readonly [Copy, boolean?])[], empty: Copy): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(label)}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t(label)}</caption><thead><tr>${headers.map(([header, numeric]) => `<th scope="col"${numeric ? ' data-numeric' : ''}>${t(header)}</th>`).join('')}</tr></thead><tbody data-whm-server-health-${marker}><tr><td colspan="${headers.length}">${t(empty)}</td></tr></tbody></table></div>`
  return { t, on, page, card, status, button, link, facts, help, table }
}

/** /whm/monitoring/health: fixed checks graded against documented thresholds. Read-only; each check links to the page that fixes it. */
export function renderWhmServerHealth(input: WhmServerHealthPageInput): string {
  const h = helpers(input)
  return h.page('health', h.card('summary', msgid('Health summary'),
    h.help(msgid('Each check reads one host observation and grades it against a fixed threshold. There is no combined score. A check that could not be read is shown as not verified, never as healthy.'))
    + `<div class="xp-whm-detail-actions">${h.button(msgid('Check again'), true)}</div>`
    + h.status(input.canRead ? msgid('Server health has not been read.') : msgid('Server health requires an authorized root administrator on a qualified host. Nothing was read or changed.'))
    + h.facts([['observed-at', msgid('Observed at (UTC)')], ['count-problem', msgid('Problems')], ['count-warning', msgid('Warnings')], ['count-unavailable', msgctxt('whm-server-health-workspace', 'Not verified')], ['count-ok', msgctxt('whm-server-health-workspace', 'No problem found')]]))
    + h.card('checks', msgid('Checks'), `<ul class="xp-whm-server-health__list" data-whm-server-health-checks aria-live="polite"><li class="xp-help" data-whm-server-health-empty>${h.t(msgid('No checks have been read.'))}</li></ul>`)
    + h.card('thresholds', msgid('Thresholds'), h.help(msgid('The thresholds are fixed values in the host agent. They are listed exactly as the last read applied them.'))
      + h.table(msgid('Thresholds'), 'thresholds', [[msgid('Check')], [msgid('Warning at'), true], [msgid('Problem at'), true]], msgid('Thresholds appear after a read.')))
    + h.card('related', msgid('Related diagnostics'), h.help(msgid('Pending package updates and package repair diagnostics are read on their own pages, because those reads are slower and can contact package mirrors.'))
      + `<div class="xp-whm-detail-actions">${h.link('/whm/software/updates', msgid('Review pending updates'))}${h.link('/whm/monitoring/repair', msgid('Open the repair center'))}${h.link('/whm/monitoring/server-info', msgid('Server information'))}</div>`))
}

/** /whm/monitoring/limits: plan limits versus kernel-enforced caps and observed usage per account. Read-only; limits are edited on plan pages. */
export function renderWhmServerLimits(input: WhmServerHealthPageInput): string {
  const h = helpers(input), disabled = h.on ? '' : ' disabled'
  const option = (value: string, copy: Copy): string => `<option value="${value}">${h.t(copy)}</option>`
  return h.page('limits', h.card('limits-summary', msgid('Resource limits'),
    h.help(msgid('Each account plan limit is compared with the cap the kernel enforces for the account (cgroup and disk quota) and with its observed usage. Usage at or above 90 percent of a limit is flagged. A cap that differs from the plan is drift. Nothing is changed here; limits are edited on the plan pages.'))
    + `<div class="xp-whm-detail-actions">${h.button(msgid('Read limits'), true)}${h.link('/whm/plans', msgid('Edit plan limits'))}</div>`
    + h.status(input.canRead ? msgid('Resource limits have not been read.') : msgid('Resource limits require an authorized root administrator on a qualified host. Nothing was read or changed.'))
    + h.facts([['observed-at', msgid('Observed at (UTC)')], ['sample-at', msgid('CPU and IO sample (UTC)')], ['count-accounts', msgid('Accounts read')], ['count-high', msgid('Accounts at or above 90%')], ['count-drift', msgid('Accounts with drift')]])
    + h.help(msgid('CPU and IO rates come from the resource sampler that runs every 5 seconds. Memory and processes are read from the account cgroup, and disk from the user quota report.')))
    + h.card('limits-accounts', msgid('Accounts'),
      `<div class="xp-whm-detail-fields" role="search" aria-label="${h.t(msgid('Filter accounts'))}"><div class="xp-whm-detail-field"><label for="whm-server-limits-filter">${h.t(msgctxt('whm-server-health-workspace', 'Show'))}</label><select id="whm-server-limits-filter" data-whm-server-health-filter${disabled}>${option('all', msgctxt('whm-server-health-workspace', 'All accounts'))}${option('high', msgid('At or above 90%'))}${option('drift', msgid('Limits differ from the plan'))}${option('unavailable', msgid('Not fully verified'))}${option('ok', msgid('No finding'))}</select></div><div class="xp-whm-detail-field"><label for="whm-server-limits-search">${h.t(msgid('Account'))}</label><input id="whm-server-limits-search" type="search" dir="ltr" maxlength="16" autocomplete="off" spellcheck="false" data-whm-server-health-search${disabled}></div></div>`
      + `<ul class="xp-whm-server-health__list" data-whm-server-health-accounts aria-live="polite"><li class="xp-help" data-whm-server-health-empty>${h.t(msgid('No accounts have been read.'))}</li></ul>`))
}
