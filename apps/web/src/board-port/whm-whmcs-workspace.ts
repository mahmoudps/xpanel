import { localeDirection, translator, type Locale, type MessageValues } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

const styles = `<style>.xp-whm-whmcs :is(h3,p,ul,dl,dd,fieldset){margin:0}.xp-whm-whmcs__form{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-whmcs__fieldset{display:flex;flex-direction:column;gap:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;padding:16px;min-inline-size:0}.xp-whm-whmcs__fieldset legend{padding-inline:8px;font-weight:600}.xp-whm-whmcs__card-head{display:flex;flex-wrap:wrap;gap:8px 24px;align-items:flex-start;justify-content:space-between}.xp-whm-whmcs__card-head>div{display:flex;flex-direction:column;gap:8px}.xp-whm-whmcs__ops{list-style:none;padding:0;display:flex;flex-direction:column}.xp-whm-whmcs__ops li{display:flex;gap:16px;justify-content:space-between;align-items:center;min-block-size:44px;border-block-start:1px solid var(--xp-border,#e2e6ec)}.xp-whm-whmcs__ops li:first-child{border-block-start:0}.xp-whm-whmcs__reveal{display:flex;flex-direction:column;gap:16px;padding:16px;border:1px solid var(--xp-border-strong,#d0d5dd);border-radius:8px;background:var(--xp-bg-elevated,#f7f8fa)}.xp-whm-whmcs__secret{display:block;padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;background:var(--xp-bg-surface,#fff);font-family:var(--xp-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:14px;line-height:1.6;overflow-wrap:anywhere;text-align:left;user-select:all}.xp-whm-whmcs .xp-whm-detail-table th{white-space:nowrap}.xp-whm-whmcs .xp-whm-detail-table :is(input,select){inline-size:100%;box-sizing:border-box;min-block-size:44px;font:inherit;border:1px solid var(--xp-border-strong,#d0d5dd);border-radius:8px;background:var(--xp-bg-surface);color:inherit;padding:8px 12px}.xp-whm-whmcs__loading{display:flex;flex-direction:column;gap:8px}.xp-whm-whmcs [hidden]{display:none!important}</style>`

/** Complete /whm/panel/whmcs page body: integration settings, API token, provisioning module, plan mapping and activity. */
export function renderWhmWhmcsWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const disabled = ' disabled', off = input.canManage ? '' : disabled, container = input.canManage ? 'form' : 'div'
  const available = `<span class="xp-badge xp-badge--ok">${t('Available')}</span>`, missing = `<span class="xp-badge xp-badge--suspended">${t('Not available')}</span>`
  const ops = [[t('Test connection'), available], [t('Create'), available], [t('Suspend'), available], [t('Unsuspend'), available], [t('Terminate'), available],
    [t('Change package'), available], [t('Change password'), missing], [t('Usage update'), missing], [t('Single sign-on'), missing]]
  const field = (key: string, label: string, control: string, help = ''): string => `<div class="xp-whm-detail-field"><label for="whm-whmcs-${key}">${label}</label>${control}${help ? `<p class="xp-help" id="whm-whmcs-${key}-help">${help}</p>` : ''}</div>`
  return `${styles}<section class="xp-whm-detail xp-whm-whmcs" data-whm-detail-route="/whm/panel/whmcs" data-whm-whmcs-workspace data-whmcs-can-manage="${input.canManage}" data-capability-state="${input.canManage ? 'authorized' : 'unavailable'}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <header class="xp-whm-detail-heading"><h1>WHMCS</h1><p>${t('Provision and manage hosting from WHMCS with xPanel\'s provisioning module and a scoped API token.')}</p></header>
  <p class="xp-whm-detail-status" data-whm-whmcs-status data-state="unread" role="status">${t('The WHMCS integration has not been read. No connection or setting is assumed.')}</p>
  <div class="xp-whm-whmcs__loading" data-whm-whmcs-loading aria-label="${t('Loading the WHMCS integration')}" hidden><span class="xp-skeleton-line"></span><span class="xp-skeleton-line xp-skeleton-line--short"></span></div>
  <div class="xp-whm-detail-grid">
    <${container} class="xp-whm-whmcs__form" data-whm-whmcs-form aria-label="${t('WHMCS connection')}"${input.canManage ? ' novalidate' : ''}>
      <section class="xp-whm-detail-card" aria-labelledby="whm-whmcs-config-heading">
        <div class="xp-whm-whmcs__card-head"><div><h2 id="whm-whmcs-config-heading">${t('Configuration')}</h2><p>${t('Settings take effect for the next call from WHMCS.')}</p></div>
          <dl><div class="xp-whm-detail-field"><dt>${t('Last saved (UTC)')}</dt><dd data-whm-whmcs-updated>${t('Not read')}</dd></div></dl></div>
        <fieldset class="xp-whm-whmcs__fieldset">
          <legend>${t('WHMCS connection')}</legend>
          <label class="xp-whm-detail-choice"><input type="checkbox" role="switch" data-whm-whmcs-input="enabled" aria-describedby="whm-whmcs-enabled-help"${disabled}><span>${t('Integration enabled')}</span></label>
          <p class="xp-help" id="whm-whmcs-enabled-help">${t('While off, xPanel refuses every call from WHMCS. Turning it on needs an API token, the WHMCS URL and at least one allowed address.')}</p>
          <div class="xp-whm-detail-fields">
            ${field('url', t('WHMCS URL'), `<input id="whm-whmcs-url" type="url" dir="ltr" maxlength="512" autocomplete="off" spellcheck="false" placeholder="https://billing.example.com" data-whm-whmcs-input="whmcsUrl"${disabled}>`)}
            ${field('identifier', t('API identifier'), `<input id="whm-whmcs-identifier" dir="ltr" readonly aria-describedby="whm-whmcs-identifier-help" data-whm-whmcs-identifier value=""${input.canManage ? '' : ' disabled'}>`, t('Enter it as the server Username in WHMCS. It is created with the first API token.'))}
          </div>
          ${field('addresses', t('Allowed addresses, one per line'), `<textarea id="whm-whmcs-addresses" rows="3" dir="ltr" spellcheck="false" aria-describedby="whm-whmcs-addresses-help" data-whm-whmcs-input="allowedAddresses"${disabled}></textarea>`, t('IPv4 or IPv6 addresses or CIDR ranges of the WHMCS server, up to 32. Calls from any other address are refused.'))}
          ${field('sso', t('Single sign-on opens'), `<select id="whm-whmcs-sso" aria-describedby="whm-whmcs-sso-help" data-whm-whmcs-input="ssoTarget"${disabled}><option value="xpanel">xPanel</option><option value="xwhm">xWHM</option><option value="xmail">xMail</option></select>`, t('Saved for later use. Single sign-on links are not available in this version.'))}
          <label class="xp-whm-detail-choice"><input type="checkbox" data-whm-whmcs-input="autoCreate" aria-describedby="whm-whmcs-create-help"${disabled}><span>${t('Create the account when WHMCS receives a new order')}</span></label>
          <p class="xp-help" id="whm-whmcs-create-help">${t('While off, xPanel refuses create calls from WHMCS. Suspend, unsuspend, terminate and package changes still work.')}</p>
        </fieldset>
        <div class="xp-whm-detail-actions"><button type="${input.canManage ? 'submit' : 'button'}" class="xp-btn xp-btn--primary" data-whm-whmcs-save${disabled}>${t('Save connection')}</button><button type="button" class="xp-btn" data-whm-whmcs-reload${off}>${t('Reload')}</button></div>
        <p class="xp-whm-detail-status" data-whm-whmcs-save-status role="status" hidden></p>
      </section>
      <section class="xp-whm-detail-card" aria-labelledby="whm-whmcs-plans-heading">
        <div class="xp-whm-whmcs__card-head"><div><h2 id="whm-whmcs-plans-heading">${t('Plan mapping')}</h2><p>${t('Each WHMCS package name maps to one xPanel plan. Calls with an unmapped package are refused. Mapping changes are saved with Save connection.')}</p></div></div>
        <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Plan mapping')}"><table class="xp-whm-detail-table"><caption class="sr-only">${t('Plan mapping')}</caption><thead><tr><th scope="col">${t('WHMCS package')}</th><th scope="col">${t('xPanel plan')}</th><th scope="col">${t('Accounts')}</th><th scope="col">${t('Action')}</th></tr></thead><tbody data-whm-whmcs-plan-rows><tr><td colspan="4">${t('This information has not been read.')}</td></tr></tbody></table></div>
        <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-whm-whmcs-plan-add${disabled}>${t('Add mapping')}</button></div>
      </section>
    </${container}>
    <aside class="xp-whm-detail-column" aria-label="${t('Provisioning module')}">
      <section class="xp-whm-detail-card" aria-labelledby="whm-whmcs-module-heading">
        <div class="xp-whm-whmcs__card-head"><div><h2 id="whm-whmcs-module-heading">${t('Provisioning module')}</h2><p>${t('Install the file as {path} in WHMCS, then add a server of type xPanel with Secure turned on.', { path: 'modules/servers/xpanel/xpanel.php' })}</p></div></div>
        <ul class="xp-whm-whmcs__ops" aria-label="${t('Module operations')}">${ops.map(([name, badge]) => `<li><span>${name}</span>${badge}</li>`).join('')}</ul>
        <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-whm-whmcs-download${off}>${t('Download module')}</button></div>
        <p class="xp-whm-detail-status" data-whm-whmcs-download-status role="status" hidden></p>
      </section>
      <section class="xp-whm-detail-card" aria-labelledby="whm-whmcs-access-heading">
        <h2 id="whm-whmcs-access-heading">${t('Access')}</h2>
        <h3>${t('Scoped API token per WHMCS install')}</h3>
        <p>${t('Enter the token as the server Access Hash in WHMCS. Only its hash is stored, and it can only run the provisioning calls listed here.')}</p>
        <dl class="xp-whm-detail-fields"><div class="xp-whm-detail-field"><dt>${t('Current token')}</dt><dd data-whm-whmcs-token>${t('Not read')}</dd></div><div class="xp-whm-detail-field"><dt>${t('Created (UTC)')}</dt><dd data-whm-whmcs-token-created>${t('Not read')}</dd></div></dl>
        <div class="xp-whm-whmcs__reveal" data-whm-whmcs-reveal role="status" hidden>
          <p>${t('Copy the token now. It is shown once; after you leave this page only its hash remains.')}</p>
          <code class="xp-whm-whmcs__secret" dir="ltr" data-whm-whmcs-secret></code>
          <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-whm-whmcs-copy>${t('Copy token')}</button><button type="button" class="xp-btn" data-whm-whmcs-done>${t('Done')}</button></div>
          <p class="xp-help" data-whm-whmcs-copy-status role="status" hidden></p>
        </div>
        <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-whm-whmcs-rotate${disabled}>${t('Create a new token')}</button></div>
        <p class="xp-whm-detail-status" data-whm-whmcs-token-status role="status" hidden></p>
        <h3>${t('Single sign-on links')}</h3>
        <p>${t('Single sign-on links are not available in this version.')}</p>
      </section>
    </aside>
  </div>
  <section class="xp-whm-detail-card" aria-labelledby="whm-whmcs-log-heading">
    <div class="xp-whm-whmcs__card-head"><div><h2 id="whm-whmcs-log-heading">${t('Activity log')}</h2><p>${t('The newest 100 calls from WHMCS, including refused ones. Passwords and tokens are never recorded.')}</p></div></div>
    <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('WHMCS activity log')}"><table class="xp-whm-detail-table"><caption class="sr-only">${t('WHMCS activity log')}</caption><thead><tr><th scope="col">${t('Time (UTC)')}</th><th scope="col">${t('Call')}</th><th scope="col">${t('Account')}</th><th scope="col">${t('Result')}</th><th scope="col">${t('From')}</th></tr></thead><tbody data-whm-whmcs-log-rows><tr><td colspan="5">${t('This information has not been read.')}</td></tr></tbody></table></div>
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-whm-whmcs-log-refresh${off}>${t('Refresh')}</button></div>
    <p class="xp-whm-detail-status" data-whm-whmcs-log-status role="status" hidden></p>
  </section>
</section>`
}
