import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

const styles = `<style>.xp-whm-trusted-proxies :is(p,dl,dd){margin:0}.xp-whm-trusted-proxies__form{display:flex;flex-direction:column;gap:24px}.xp-whm-trusted-proxies__technical>label{padding-inline:13px}.xp-whm-trusted-proxies__technical :is(input,textarea){direction:ltr;unicode-bidi:isolate;text-align:start}html[dir=rtl] .xp-whm-trusted-proxies__technical :is(input,textarea){text-align:end}.xp-whm-trusted-proxies [hidden]{display:none!important}</style>`
export function renderWhmTrustedProxiesWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values)), container = input.canManage ? 'form' : 'div'
  const fact = (key: string, message: string): string => `<div class="xp-whm-detail-field"><dt>${t(message)}</dt><dd data-trusted-proxies-field="${key}">${t('Not read')}</dd></div>`
  return `${styles}<section class="xp-whm-detail xp-whm-trusted-proxies" data-whm-detail-route="/whm/server/trusted-proxies" data-whm-trusted-proxies-workspace data-trusted-proxies-can-manage="${input.canManage}" data-capability-state="${input.canManage ? 'authorized' : 'unavailable'}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <header class="xp-whm-detail-heading"><h1>${t('Trusted proxies')}</h1><p>${t('Save a bounded list of remote proxy networks. Saving does not change active client-address trust.')}</p></header>
  <div class="xp-whm-detail-column">
    <section class="xp-whm-detail-card" aria-labelledby="trusted-proxies-state-heading"><h2 id="trusted-proxies-state-heading">${t('Saved and active configuration')}</h2>
      <p class="xp-whm-detail-status" data-trusted-proxies-status role="status">${t('Configuration has not been read. No proxy is assumed trusted.')}</p>
      <dl class="xp-whm-detail-fields">${fact('saved', 'Saved proxy networks')}${fact('updated', 'Last saved (UTC)')}${fact('active', 'Active native trust')}${fact('activation', 'Activation provider')}</dl>
      <div class="xp-whm-detail-scroll" tabindex="0" role="region" aria-label="${t('Saved proxy networks')}"><table class="xp-whm-detail-table"><thead><tr><th scope="col">${t('Network (CIDR)')}</th><th scope="col">${t('Client-address header')}</th></tr></thead><tbody data-trusted-proxies-rows><tr><td colspan="2">${t('No saved networks have been read.')}</td></tr></tbody></table></div>
    </section>
    <section class="xp-whm-detail-card" aria-labelledby="trusted-proxies-edit-heading"><h2 id="trusted-proxies-edit-heading">${t('Saved proxy policy')}</h2>
      <${container} class="xp-whm-trusted-proxies__form" data-trusted-proxies-form${input.canManage ? ' novalidate' : ''}>
        <div class="xp-whm-detail-fields"><div class="xp-whm-detail-field xp-whm-trusted-proxies__technical"><label for="trusted-proxies-cidrs">${t('Proxy networks, one CIDR per line')}</label><textarea id="trusted-proxies-cidrs" dir="ltr" rows="6" maxlength="2100" autocomplete="off" spellcheck="false" data-trusted-proxies-cidrs aria-describedby="trusted-proxies-cidrs-help" disabled></textarea><p class="xp-help" id="trusted-proxies-cidrs-help">${t('Up to 32 canonical public networks. IPv4 prefixes must be 16..32, IPv6 prefixes 32..128. Local, private, shared, overlapping and current management-client ranges are refused. An empty list trusts no proxy.')}</p></div><div class="xp-whm-detail-field xp-whm-trusted-proxies__technical"><label for="trusted-proxies-header">${t('Client-address header')}</label><input id="trusted-proxies-header" dir="ltr" value="X-Forwarded-For" readonly disabled><p class="xp-help">${t('The dedicated ingress must replace the header with one client address. Custom headers, appended chains and PROXY protocol are unavailable.')}</p></div></div>
        <div class="xp-whm-detail-actions"><button class="xp-btn xp-btn--primary" type="${input.canManage ? 'submit' : 'button'}" data-trusted-proxies-save disabled>${t('Save policy')}</button><button class="xp-btn" type="button" data-trusted-proxies-reload${input.canManage ? '' : ' disabled'}>${t('Reload')}</button></div><p class="xp-whm-detail-status" data-trusted-proxies-save-status role="status" hidden></p>
      </${container}>
    </section>
    <section class="xp-whm-detail-card" aria-labelledby="trusted-proxies-apply-heading"><h2 id="trusted-proxies-apply-heading">${t('Activate the saved policy')}</h2><p class="xp-help">${t('Activation is available only through a protected dedicated ingress provider with verified recovery and management access. Existing listener startup authority is preserved. This action applies the saved policy, not unsaved edits.')}</p>
      <div class="xp-whm-detail-field xp-whm-trusted-proxies__technical"><label for="trusted-proxies-confirm">${t('Type APPLY TRUSTED PROXIES to confirm')}</label><input id="trusted-proxies-confirm" dir="ltr" autocomplete="off" data-trusted-proxies-confirm disabled></div>
      <div class="xp-whm-detail-actions"><button class="xp-btn" type="button" data-trusted-proxies-apply disabled>${t('Activate saved policy')}</button></div><p class="xp-whm-detail-status" data-trusted-proxies-apply-status role="status" hidden></p>
    </section>
  </div></section>`
}
