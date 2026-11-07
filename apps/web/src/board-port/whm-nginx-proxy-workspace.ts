import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

const technical = (slot: string): string => `<td><bdi dir="ltr" class="xp-mono" data-xp-slot="${slot}"></bdi></td>`
const text = (slot: string): string => `<td data-xp-slot="${slot}"></td>`
const action = (name: string): string => `<button type="button" class="xp-btn" data-xp-action="${name}" disabled><span data-xp-slot="${name}-label"></span></button>`
const table = (id: string, title: string, headers: readonly string[], rows: string, empty: string): string => `<div class="xp-acct-tool__table" role="region" tabindex="0" aria-labelledby="${id}"><table class="xp-table"><thead><tr>${headers.map(header => `<th scope="col">${header}</th>`).join('')}</tr></thead><tbody ${rows}><tr><td colspan="${headers.length}">${empty}</td></tr></tbody></table></div>`

/** Theme-owned records the manager's controller fills. */
export const classicNginxProxyTemplates = (): string => `<template data-xp-template="nginx-proxy-rule"><tr>${technical('path')}${technical('target')}${text('host')}${text('websocket')}${text('state')}<td>${action('remove')}</td></tr></template>`
  + `<template data-xp-template="nginx-proxy-account"><tr>${technical('account')}${technical('domain')}${text('rules')}${text('cache')}${technical('purged')}<td><div class="xp-acct-tool__actions">${action('toggle')}${action('purge')}</div></td></tr></template>`
  + '<template data-xp-template="nginx-proxy-empty"><tr><td colspan="6" data-xp-slot="message"></td></tr></template>'

/** /whm/services/nginx-proxy: per-domain reverse proxy rules at the edge and the response cache of each account. */
export function renderWhmNginxProxyWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const notRead = t('Not read.')
  return `<div class="xp-acct-tool" data-nginx-proxy data-np-manage="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}">${ACCOUNT_TOOL_STYLE}<style>[data-nginx-proxy] .xp-acct-tool__table table{min-inline-size:44rem}[data-nginx-proxy] .xp-acct-tool__table:focus-visible{outline:var(--xp-focus-width) solid var(--xp-border-focus);outline-offset:var(--xp-focus-offset)}[data-nginx-proxy] [data-np-error]{color:var(--xp-status-critical-fg)}[data-nginx-proxy] [dir=ltr]{unicode-bidi:isolate}@media(min-width:601px){[data-nginx-proxy] .xp-acct-tool__card{padding:24px}}</style>
  <section class="xp-acct-tool__card" aria-labelledby="np-rules"><h2 id="np-rules">${t('Reverse proxy rules')}</h2>
    <p>${t('Send one path of a domain, or the whole domain, to another server. The rest of the site keeps serving from its web server.')}</p>
    <div class="xp-acct-tool__fields"><div class="xp-field"><label for="np-domain">${t('Domain')}</label><select id="np-domain" class="xp-select" dir="ltr" data-np-domain disabled><option value="">${t('No domains have been read')}</option></select></div>
      <div class="xp-field"><label for="np-path">${t('Path')}</label><input id="np-path" class="xp-input xp-mono" dir="ltr" type="text" maxlength="255" spellcheck="false" autocomplete="off" placeholder="/app" data-np-path disabled aria-describedby="np-path-help"><p class="xp-help" id="np-path-help">${t('Use / for the whole domain. The target receives the request path unchanged.')}</p></div>
      <div class="xp-field"><label for="np-target">${t('Target')}</label><input id="np-target" class="xp-input xp-mono" dir="ltr" type="text" maxlength="512" spellcheck="false" autocomplete="off" placeholder="https://203.0.113.10:8443" data-np-target disabled aria-describedby="np-target-help np-error"><p class="xp-help" id="np-target-help">${t('Loopback, this server, link-local addresses and panel ports are refused.')}</p></div>
      <div class="xp-field"><label for="np-host">${t('Host header sent to the target')}</label><select id="np-host" class="xp-select" data-np-host disabled><option value="client">${t('Visitor host name')}</option><option value="upstream">${t('Target host name')}</option></select></div>
      <div class="xp-field"><label class="xp-check"><input type="checkbox" data-np-websocket disabled> ${t('Pass WebSocket upgrades')}</label></div></div>
    <p id="np-error" data-np-error hidden></p>
    <div class="xp-acct-tool__actions"><button type="button" class="xp-btn xp-btn--primary" data-np-add disabled>${t('Add rule')}</button><button type="button" class="xp-btn" data-np-refresh disabled>${t('Read rules')}</button></div>
    <p data-np-status role="status" data-state="unread">${t('The reverse proxy rules have not been read.')}</p>
    <p data-np-count>${t('Not read')}</p>
    ${table('np-rules', t('Reverse proxy rules'), [t('Path'), t('Target'), t('Host header'), t('WebSocket'), t('State'), t('Actions')], 'data-np-rows', notRead)}
  </section>
  <section class="xp-acct-tool__card" aria-labelledby="np-cache"><h2 id="np-cache">${t('Response cache by account')}</h2>
    <p>${t('Purging drops every cached response of the account at once. Turning the cache off sends every request to its sites.')}</p>
    <div class="xp-acct-tool__fields"><div class="xp-field"><label for="np-filter">${t('Find an account')}</label><input id="np-filter" class="xp-input" dir="ltr" type="search" maxlength="255" autocomplete="off" data-np-filter disabled></div></div>
    <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-np-all-enable disabled>${t('Turn on for listed accounts')}</button><button type="button" class="xp-btn" data-np-all-disable disabled>${t('Turn off for listed accounts')}</button><button type="button" class="xp-btn" data-np-all-purge disabled>${t('Purge listed accounts')}</button></div>
    <p data-np-cache-status role="status" data-state="unread">${t('The cache settings have not been read.')}</p>
    ${table('np-cache', t('Response cache by account'), [t('Account'), t('Primary domain'), t('Rules'), t('Cache'), t('Last purge'), t('Actions')], 'data-np-accounts', notRead)}
  </section>
  <section class="xp-acct-tool__card" role="note" aria-labelledby="np-notes"><h2 id="np-notes">${t('Limits of this page')}</h2><ul><li>${t('Every change passes the nginx configuration test before reload; a failed test keeps the previous configuration.')}</li><li>${t('A path the server already answers, such as an application route, keeps its own route and the rule is left out.')}</li><li>${t('A named target is checked when it is saved. nginx resolves it again for each request.')}</li><li>${t('All accounts share one cache size. nginx has no per-account limit inside one cache.')}</li></ul></section>
${classicNginxProxyTemplates()}</div>`
}
