import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

const technical = (slot: string): string => `<td><bdi dir="ltr" class="xp-mono" data-xp-slot="${slot}"></bdi></td>`
/** Theme-owned records the account edge controller fills. */
export const classicAccountEdgeTemplates = (): string => `<template data-xp-template="ip-blocker-row"><tr>${technical('entry')}${technical('first')}${technical('last')}<td><button type="button" class="xp-btn" data-xp-action="remove" disabled><span data-xp-slot="remove-label"></span></button></td></tr></template><template data-xp-template="ip-blocker-empty"><tr><td colspan="4" data-xp-slot="message"></td></tr></template>`

/** /security/ip-blocker: addresses refused by every site of the account at the server edge (cPanel IP Blocker). */
export function renderAccountIpBlockerWorkspace(input: { lang: Locale; accountId: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.lang)(message, values))
  return `<div class="xp-acct-tool" data-ip-blocker data-ipb-account="${escapeHtml(input.accountId)}" data-ipb-manage="${input.canManage}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}<style>[data-ip-blocker] .xp-acct-tool__table table{min-inline-size:32rem}[data-ip-blocker] .xp-acct-tool__table:focus-visible{outline:var(--xp-focus-width) solid var(--xp-border-focus);outline-offset:var(--xp-focus-offset)}[data-ip-blocker] [data-ipb-error]{color:var(--xp-status-critical-fg)}[data-ip-blocker] [dir=ltr]{unicode-bidi:isolate}@media(min-width:601px){[data-ip-blocker] .xp-acct-tool__card{padding:24px}}</style>
  <section class="xp-acct-tool__card" aria-labelledby="ipb-add"><h2 id="ipb-add">${t('Block an address')}</h2>
    <p>${t('Requests from these addresses get HTTP 403 on every website of this account. Mail, FTP and the panels are not affected.')}</p>
    <div class="xp-acct-tool__fields"><div class="xp-field"><label for="ipb-input">${t('Address, range or host name')}</label><input id="ipb-input" class="xp-input xp-mono" dir="ltr" type="text" maxlength="255" spellcheck="false" autocomplete="off" data-ipb-input aria-describedby="ipb-help ipb-error" disabled><p class="xp-help" id="ipb-help">${t('For example 192.0.2.7, 10.5.3.3-40, 192.0.2.0/24, 10. or bad.example.com. Ranges are saved as the exact CIDR blocks that cover them; a host name is saved as the addresses it resolves to now.')}</p><p id="ipb-error" data-ipb-error hidden></p></div></div>
    <div class="xp-acct-tool__actions"><button type="button" class="xp-btn xp-btn--primary" data-ipb-add disabled>${t('Add')}</button><button type="button" class="xp-btn" data-ipb-refresh disabled>${t('Read blocked addresses')}</button></div>
    <p data-ipb-status role="status" data-state="unread">${t('The blocked addresses have not been read.')}</p>
  </section>
  <section class="xp-acct-tool__card" aria-labelledby="ipb-list"><h2 id="ipb-list">${t('Currently blocked addresses')}</h2>
    <p data-ipb-count>${t('Not read')}</p>
    <div class="xp-acct-tool__table" role="region" tabindex="0" aria-labelledby="ipb-list"><table class="xp-table"><thead><tr><th scope="col">${t('Server setting')}</th><th scope="col">${t('First address')}</th><th scope="col">${t('Last address')}</th><th scope="col">${t('Actions')}</th></tr></thead><tbody data-ipb-rows><tr><td colspan="4">${t('Not read.')}</td></tr></tbody></table></div>
  </section>
  <section class="xp-acct-tool__card" role="note" aria-labelledby="ipb-notes"><h2 id="ipb-notes">${t('Limits of this page')}</h2><ul><li>${t('At most 1000 blocks per account. Loopback addresses that the server uses to reach its own sites cannot be blocked.')}</li><li>${t('Behind a CDN or another proxy, the edge sees the visitor address only when the server trusts that proxy (Trusted proxies). Otherwise the proxy address is what is blocked.')}</li><li>${t('A host name is resolved once, when it is added. Later changes to its addresses are not followed.')}</li></ul></section>
${classicAccountEdgeTemplates()}</div>`
}

/** Cache controls for /software/optimize: the account's switch and purge for the server edge response cache. */
export function renderAccountEdgeCacheCard(input: { lang: Locale; accountId: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.lang)(message, values))
  return `<section class="xp-acct-tool__card" data-edge-cache data-ec-account="${escapeHtml(input.accountId)}" data-ec-manage="${input.canManage}" aria-labelledby="ec-title"><h2 id="ec-title">${t('Response cache for your sites')}</h2>
    <p>${t('Purging drops every cached response of your sites at once: the next visit to each page asks your site again. Turning the cache off sends every request to your sites.')}</p>
    <dl class="xp-acct-tool__facts"><div><dt>${t('Cache')}</dt><dd data-edge-cache-state>${t('Not read')}</dd></div><div><dt>${t('Last purge')}</dt><dd><bdi dir="ltr" data-edge-cache-purged>${t('Not read')}</bdi></dd></div></dl>
    <div class="xp-acct-tool__actions"><button type="button" class="xp-btn xp-btn--primary" data-edge-cache-purge disabled>${t('Purge cache')}</button><button type="button" class="xp-btn" data-edge-cache-toggle disabled>${t('Turn the cache off')}</button></div>
    <p data-edge-cache-status role="status" data-state="unread">${t('The cache settings have not been read.')}</p>
  </section>`
}
