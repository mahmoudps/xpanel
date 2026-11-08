import { actions, button, check, context, esc, field, fields, note, page, section, status, table, type WhmDataPageInput } from '../software/common.ts'

const technical = (slot: string): string => `<td><bdi dir="ltr" class="v2-mono" data-xp-slot="${slot}"></bdi></td>`
const text = (slot: string): string => `<td data-xp-slot="${slot}"></td>`
const action = (name: string): string => `<button type="button" class="v2-btn" data-xp-action="${name}" disabled><span data-xp-slot="${name}-label"></span></button>`
/** Theme-owned records the manager's controller fills. */
const templates = `<template data-xp-template="nginx-proxy-rule"><tr>${technical('path')}${technical('target')}${text('host')}${text('websocket')}${text('state')}<td>${action('remove')}</td></tr></template>`
  + `<template data-xp-template="nginx-proxy-account"><tr>${technical('account')}${technical('domain')}${text('rules')}${text('cache')}${technical('purged')}<td>${action('toggle')} ${action('purge')}</td></tr></template>`
  + '<template data-xp-template="nginx-proxy-empty"><tr><td colspan="6" data-xp-slot="message"></td></tr></template>'

/** /whm/services/nginx-proxy: per-domain reverse proxy rules at the edge and the response cache of each account. */
export function renderV2WhmNginxProxy(input: WhmDataPageInput): string {
  const { t, canManage } = context(input)
  const rules = section('nginx-proxy-rules', t(msgid('Reverse proxy rules')), note(t(msgid('Send one path of a domain, or the whole domain, to another server. The rest of the site keeps serving from its web server.')))
    + fields(field('np-domain', t(msgid('Domain')), { kind: 'select', dir: 'ltr', disabled: true, hooks: { 'data-np-domain': true }, options: [{ value: '', label: t(msgid('No domains have been read')) }] })
      + field('np-path', t(msgid('Path')), { kind: 'input', type: 'text', dir: 'ltr', disabled: true, maxlength: 255, hooks: { 'data-np-path': true } }, t(msgid('Use / for the whole domain. The target receives the request path unchanged.')))
      + field('np-target', t(msgid('Target')), { kind: 'input', type: 'text', dir: 'ltr', disabled: true, maxlength: 512, hooks: { 'data-np-target': true } }, t(msgid('Loopback, this server, link-local addresses and panel ports are refused.')))
      + field('np-host', t(msgid('Host header sent to the target')), { kind: 'select', disabled: true, hooks: { 'data-np-host': true }, options: [{ value: 'client', label: t(msgid('Visitor host name')) }, { value: 'upstream', label: t(msgid('Target host name')) }] }))
    + check(t(msgid('Pass WebSocket upgrades')), { 'data-np-websocket': true })
    + '<p class="v2-field__error" data-np-error hidden></p>'
    + actions(button(t(msgid('Add rule')), { 'data-np-add': true }, true, true) + button(t(msgid('Read rules')), { 'data-np-refresh': true }, true))
    + status(t(msgid('The reverse proxy rules have not been read.')), { 'data-np-status': true })
    + `<p data-np-count>${esc(t(msgid('Not read')))}</p>`
    + table(t, t(msgid('Reverse proxy rules')), [msgid('Path'), msgid('Target'), msgid('Host header'), msgid('WebSocket'), msgid('State'), msgid('Actions')], { 'data-np-rows': true }))
  const cache = section('nginx-proxy-cache', t(msgid('Response cache by account')), note(t(msgid('Purging drops every cached response of the account at once. Turning the cache off sends every request to its sites.')))
    + fields(field('np-filter', t(msgid('Find an account')), { kind: 'input', type: 'search', dir: 'ltr', disabled: true, maxlength: 255, hooks: { 'data-np-filter': true } }))
    + actions(button(t(msgid('Turn on for listed accounts')), { 'data-np-all-enable': true }, true) + button(t(msgid('Turn off for listed accounts')), { 'data-np-all-disable': true }, true) + button(t(msgid('Purge listed accounts')), { 'data-np-all-purge': true }, true))
    + status(t(msgid('The cache settings have not been read.')), { 'data-np-cache-status': true })
    + table(t, t(msgid('Response cache by account')), [msgid('Account'), msgid('Primary domain'), msgid('Rules'), msgid('Cache'), msgid('Last purge'), msgid('Actions')], { 'data-np-accounts': true }))
  const limits = section('nginx-proxy-limits', t(msgid('Limits of this page')), `<ul>${[msgid('Every change passes the nginx configuration test before reload; a failed test keeps the previous configuration.'), msgid('A path the server already answers, such as an application route, keeps its own route and the rule is left out.'), msgid('A named target is checked when it is saved. nginx resolves it again for each request.'), msgid('All accounts share one cache size. nginx has no per-account limit inside one cache.')].map(item => `<li>${esc(t(item))}</li>`).join('')}</ul>`)
  return page(input, '/whm/services/nginx-proxy', t(msgid('NGINX reverse proxy')), t(msgid('Manage reverse proxy rules for each domain and the response cache for each account.')), rules + cache + limits + templates, { 'data-nginx-proxy': true, 'data-np-manage': String(canManage) })
}
