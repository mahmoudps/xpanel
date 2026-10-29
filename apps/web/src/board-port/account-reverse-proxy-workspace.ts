import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

const STYLE = '<style>.xp-rp{gap:var(--xp-space-section)}.xp-rp .xp-acct-tool__card{gap:var(--xp-space-group);padding:var(--xp-space-field)}@media(min-width:601px){.xp-rp .xp-acct-tool__card{padding:var(--xp-space-card)}}.xp-rp .xp-acct-tool__card>h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:var(--xp-weight-semibold)}.xp-rp .xp-field,.xp-rp .xp-acct-tool__facts>div{gap:var(--xp-space-label)}.xp-rp .xp-field>label[for]{text-box-trim:trim-end;text-box-edge:text}.xp-rp .xp-acct-tool__fields,.xp-rp .xp-acct-tool__facts,.xp-rp .xp-acct-tool__actions{gap:var(--xp-space-field)}.xp-rp ol{display:grid;gap:var(--xp-space-field);margin:0;padding-inline-start:var(--xp-space-card)}.xp-rp [data-rp-warning]{padding:var(--xp-space-field);border:1px solid var(--xp-status-warn-border,var(--xp-border));border-radius:8px;background:var(--xp-status-warn-bg,var(--xp-bg-elevated))}.xp-rp [data-rp-error]{margin:0;color:var(--xp-status-critical-fg)}.xp-rp [hidden]{display:none}.xp-rp [data-rp-options]{display:grid;gap:var(--xp-space-field)}.xp-rp [data-rp-header-rows] input{inline-size:100%}.xp-rp [data-rp-websocket-label]{display:flex;gap:var(--xp-space-label);align-items:center;min-block-size:var(--xp-hit-target)}.xp-rp input[data-rp-websocket]{inline-size:20px;block-size:20px;min-block-size:20px;margin:0;padding:0;flex:none}.xp-rp .xp-acct-tool__table :is(th,td,p,span,bdi,button){overflow-wrap:normal;word-break:normal}.xp-rp .xp-acct-tool__table bdi{white-space:nowrap}.xp-rp .xp-acct-tool__table .xp-btn{white-space:nowrap;inline-size:max-content;max-inline-size:none;min-inline-size:var(--xp-hit-target);flex:none}body:has(.xp-rp) [data-xp-prompt] .xp-dialog__footer{gap:var(--xp-space-field)}</style>'

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
        <div class="xp-field" data-rp-upstream-field><label for="rp-upstream">${t('Upstream address')}</label><input id="rp-upstream" class="xp-input xp-mono" dir="ltr" type="text" maxlength="512" spellcheck="false" autocomplete="off" data-rp-upstream aria-describedby="rp-upstream-help rp-upstream-error" disabled><p class="xp-help" id="rp-upstream-help">${t('An application listening on this server, for example')} <bdi dir="ltr">http://127.0.0.1:3000</bdi> ${t('or')} <bdi dir="ltr">http://[::1]:3000</bdi>. ${t('Use port 1024 or higher. Ports used by server services or by another account are refused. A remote address works only when the server administrator allowed its host.')}</p><p id="rp-upstream-error" data-rp-error hidden></p></div>
      </div>
      <div data-rp-options>
        <div class="xp-field"><label data-rp-websocket-label><input type="checkbox" data-rp-websocket disabled> ${t('Relay WebSocket connections')}</label><p class="xp-help">${t('Keep this on for applications that use live connections, such as chat or dashboards.')}</p></div>
        <div class="xp-field"><label for="rp-host">${t('Host header sent')}</label><select id="rp-host" class="xp-select" data-rp-host disabled><option value="client">${t('The visitor’s domain name')}</option><option value="upstream">${t('The upstream address host')}</option></select></div>
        <div class="xp-field"><span class="xp-label" id="rp-headers-label">${t('Headers to the upstream')}</span>
          <div class="xp-acct-tool__table" tabindex="0" role="region" aria-labelledby="rp-headers-label"><table class="xp-table"><thead><tr><th scope="col">${t('Header')}</th><th scope="col">${t('Value')}</th><th scope="col">${t('Action')}</th></tr></thead><tbody data-rp-header-rows><tr data-rp-header-empty><td colspan="3">${t('No extra headers.')}</td></tr></tbody></table></div>
          <p class="xp-help">${t('Up to 8 headers. Letters, digits and "-" in names; plain text values without "$". Forwarding and connection headers are set by the server.')}</p>
          <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-rp-add-header disabled>${t('Add header')}</button></div><p data-rp-headers-error data-rp-error hidden></p></div>
      </div>
      <p role="note" data-rp-warning>${t('While a domain is proxied, its document root and PHP settings are kept but not used. Switching back to PHP or static files serves the saved document root again.')}</p>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-rp-cancel disabled>${t('Cancel')}</button><button type="button" class="xp-btn xp-btn--primary" data-rp-save disabled>${t('Save serving mode')}</button></div></section>
    <section class="xp-acct-tool__card" aria-labelledby="rp-steps"><h2 id="rp-steps">${t('What happens when you save')}</h2><ol>
      <li>${t('The saved domain configuration is read again; if it changed elsewhere, nothing is sent.')}</li>
      <li>${t('The server re-checks your access, the address and the captured revision, then saves the new mode.')}</li>
      <li>${t('The server configuration is applied where available and the saved state is read back. The page reports saved and applied separately.')}</li></ol></section>
    <section class="xp-acct-tool__card" role="note" aria-labelledby="rp-limits"><h2 id="rp-limits">${t('Limits of this page')}</h2><ul>
      <li>${t('Applications on this server use')} <bdi dir="ltr">127.0.0.1</bdi> ${t('or')} <bdi dir="ltr">::1</bdi>. ${t('Remote hosts need the server administrator’s approval.')}</li>
      <li>${t('The whole site is proxied. Proxying one path and caching proxied responses are not available on this page.')}</li>
      <li>${t('An alias follows the domain it points at. A domain that has aliases cannot change its mode here.')}</li>
      <li>${t('Node and Python application sites, and domains with a redirect, keep their current mode.')}</li>
      <li>${t('This page does not start your application or check that it answers.')}</li></ul></section>
  </div>`
}
