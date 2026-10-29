import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

/** /software/optimize: the observed edge compression and response-cache policy for the account's sites. */
export function renderSwOptimizeWorkspace(input: { lang: Locale; canRead: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.lang)(message, values)
  const fact = (key: string, label: string): string => `<div><dt>${label}</dt><dd><bdi dir="ltr" data-human data-sw-optimize-${key}>${t('Not read')}</bdi></dd></div>`
  return `<div class="xp-acct-tool" data-sw-optimize data-sw-can-read="${input.canRead}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}<style>[data-sw-optimize] .xp-acct-tool__table table{min-inline-size:32rem}[data-sw-optimize] bdi:not([data-human]){font-family:var(--xp-font-mono);font-size:var(--xp-type-label);line-height:var(--xp-leading-label)}[data-sw-optimize] .xp-acct-tool__table:focus-visible{outline:var(--xp-focus-width) solid var(--xp-border-focus);outline-offset:var(--xp-focus-offset)}@media(min-width:601px){[data-sw-optimize] .xp-acct-tool__card{padding:var(--xp-space-card)}}</style>
  <section class="xp-acct-tool__card" aria-labelledby="sw-optimize-policy"><h2 id="sw-optimize-policy">${t('Compression')}</h2>
    <p>${t('Your sites are served through the server edge. This shows the compression and response cache it actually applies, read from its managed configuration.')}</p>
    <dl class="xp-acct-tool__facts">${fact('compression', t('Compression'))}${fact('min', t('Minimum response size'))}${fact('proxied', t('Compress proxied responses'))}${fact('cache', t('Response cache'))}</dl>
    <div><h3>${t('Compressed content types')}</h3><p data-sw-optimize-types>${t('Not read')}</p></div>
    <p data-sw-optimize-status role="status" data-state="unread">${t('The optimization policy has not been read.')}</p>
    <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-sw-optimize-refresh${input.canRead ? '' : ' disabled'}>${t('Read policy')}</button></div>
  </section>
  <section class="xp-acct-tool__card" aria-labelledby="sw-optimize-sites"><h2 id="sw-optimize-sites">${t('Your sites')}</h2>
    <div class="xp-acct-tool__table" role="region" tabindex="0" aria-label="${t('Your sites')}"><table class="xp-table"><thead><tr><th scope="col">${t('Domain')}</th><th scope="col">${t('Compression')}</th><th scope="col">${t('Response cache')}</th></tr></thead><tbody data-sw-optimize-domains><tr><td colspan="3">${t('Not read.')}</td></tr></tbody></table></div>
    <p class="xp-help">${t('The cache stores GET and HEAD responses that carry no cookies or authorization. Redirected and suspended domains are not cached.')}</p>
  </section>
  <section class="xp-acct-tool__card" aria-labelledby="sw-optimize-controls"><h2 id="sw-optimize-controls">${t('Per-site rules and cache purge')}</h2>
    <p>${t('Per-site compression choices, cache rules and purging cached pages are unavailable: no reviewed per-site edge setting or confined purge operation is connected. Nothing is changed here.')}</p>
    <div class="xp-acct-tool__actions"><button type="button" class="xp-btn xp-btn--primary" disabled>${t('Review & apply')}</button><button type="button" class="xp-btn" disabled>${t('Purge cache')}</button></div>
  </section>
</div>`
}
