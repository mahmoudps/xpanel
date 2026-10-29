import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

const STYLE = '<style>@media(min-width:601px){.xp-rp .xp-acct-tool__card{padding:24px}}.xp-rp .xp-acct-tool__card>h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:var(--xp-weight-semibold)}.xp-rp ol{display:grid;gap:16px;margin:0;padding-inline-start:24px}.xp-rp [data-rp-warning]{padding:16px;border:1px solid var(--xp-status-warn-border,var(--xp-border));border-radius:8px;background:var(--xp-status-warn-bg,var(--xp-bg-elevated))}.xp-rp [data-rp-error]{margin:0;color:var(--xp-status-critical-fg)}.xp-rp [hidden]{display:none}</style>'

/** Owner page over the saved domain workspace: switch a domain between a loopback reverse proxy and file serving. */
export function renderAccountReverseProxyWorkspace(input: { lang: Locale; accountId: string; home: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.lang)(message, values)), unread = t(msgctxt('account-reverse-proxy-workspace', 'Not read'))
  return `<div class="xp-acct-tool xp-rp" data-reverse-proxy data-rp-account="${escapeHtml(input.accountId)}" data-rp-home="${escapeHtml(input.home)}" data-rp-manage="${input.canManage}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}${STYLE}
    <section class="xp-acct-tool__card" aria-labelledby="rp-sites"><h2 id="rp-sites">${t('Your sites')}</h2>
      <p>${t('Choose a domain to forward its requests to an application running on this server, or to serve its files again.')}</p>
      <div class="xp-acct-tool__table" tabindex="0" role="region" aria-label="${t('Domains and serving modes')}"><table class="xp-table"><thead><tr>${[t('Domain'), t('Kind'), t('Serving mode'), t('Upstream'), t('Actions')].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-rp-rows><tr><td colspan="5">${t('Domains have not been read.')}</td></tr></tbody></table></div>
      <p data-rp-status role="status" data-state="unread">${t('Saved domain configuration has not been read.')}</p>
      <p class="xp-help" data-rp-application>${t('Whether a site answers through its upstream has not been checked.')}</p>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-rp-refresh disabled>${t('Read domains')}</button></div></section>
    <section class="xp-acct-tool__card" aria-labelledby="rp-change"><h2 id="rp-change">${t('Change serving mode')}</h2>
      <dl class="xp-acct-tool__facts"><div><dt>${t('Domain')}</dt><dd><bdi dir="ltr" data-rp-selected>${t('None selected')}</bdi></dd></div><div><dt>${t('Current mode')}</dt><dd data-rp-current>${unread}</dd></div><div><dt>${t('Document root (kept)')}</dt><dd><bdi dir="ltr" data-rp-root>${unread}</bdi></dd></div></dl>
      <div class="xp-acct-tool__fields">
        <div class="xp-field"><label for="rp-mode">${t('Serve this domain with')}</label><select id="rp-mode" class="xp-select" data-rp-mode disabled><option value="proxy">${t('Reverse proxy to an application')}</option><option value="php">${t('PHP files from the document root')}</option><option value="static">${t('Static files from the document root')}</option></select></div>
        <div class="xp-field" data-rp-upstream-field><label for="rp-upstream">${t('Upstream address')}</label><input id="rp-upstream" class="xp-input xp-mono" dir="ltr" type="text" maxlength="512" spellcheck="false" autocomplete="off" data-rp-upstream aria-describedby="rp-upstream-help rp-upstream-error" disabled><p class="xp-help" id="rp-upstream-help">${t('An application listening on this server, for example')} <bdi dir="ltr">http://127.0.0.1:3000</bdi> ${t('or')} <bdi dir="ltr">http://[::1]:3000</bdi>. ${t('Use port 1024 or higher. Ports used by server services and remote addresses are refused.')}</p><p id="rp-upstream-error" data-rp-error hidden></p></div>
      </div>
      <p role="note" data-rp-warning>${t('While a domain is proxied, its document root and PHP settings are kept but not used. Switching back to PHP or static files serves the saved document root again.')}</p>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-rp-cancel disabled>${t('Cancel')}</button><button type="button" class="xp-btn xp-btn--primary" data-rp-save disabled>${t('Save serving mode')}</button></div></section>
    <section class="xp-acct-tool__card" aria-labelledby="rp-steps"><h2 id="rp-steps">${t('What happens when you save')}</h2><ol>
      <li>${t('The saved domain configuration is read again; if it changed elsewhere, nothing is sent.')}</li>
      <li>${t('The server re-checks your access, the address and the captured revision, then saves the new mode.')}</li>
      <li>${t('The server configuration is applied where available and the saved state is read back. The page reports saved and applied separately.')}</li></ol></section>
    <section class="xp-acct-tool__card" role="note" aria-labelledby="rp-limits"><h2 id="rp-limits">${t('Limits of this page')}</h2><ul>
      <li>${t('Only applications on this server can be proxied in this version:')} <bdi dir="ltr">127.0.0.1</bdi> ${t('or')} <bdi dir="ltr">::1</bdi>.</li>
      <li>${t('An alias follows the domain it points at. A domain that has aliases cannot change its mode here.')}</li>
      <li>${t('Node and Python application sites, and domains with a redirect, keep their current mode.')}</li>
      <li>${t('This page does not start your application or check that it answers.')}</li></ul></section>
  </div>`
}
