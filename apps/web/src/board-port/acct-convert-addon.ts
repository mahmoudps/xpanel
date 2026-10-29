import { type Locale, type MessageValues, localeDirection, translator } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

const styles = `<style>.xp-acct-convert-addon{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-acct-convert-addon :is(h2,h3,p,ol,ul){margin:0}.xp-acct-convert-addon .xp-whm-detail-fields{gap:16px}.xp-acct-convert-addon .xp-whm-detail-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0;text-align:start}.xp-acct-convert-addon__group{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-acct-convert-addon__loading,.xp-acct-convert-addon__empty{display:flex;flex-direction:column;gap:8px;align-items:flex-start}.xp-acct-convert-addon__actions{display:flex;flex-wrap:wrap;gap:8px}.xp-acct-convert-addon .xp-whm-detail-table th{white-space:nowrap}.xp-acct-convert-addon [data-acct-convert-facts]:empty{display:none}@media (max-width:600px){.xp-acct-convert-addon .xp-whm-detail-card{padding:16px}}@media (min-width:601px){.xp-acct-convert-addon .xp-whm-detail-card{padding:24px}}</style>`

/** /whm/transfers/convert-addon body: choose the addon domain and new account, review what moves, then the guarded convert step. */
export function renderAcctConvertAddonWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const disabled = input.canManage ? '' : ' disabled'
  const container = input.canManage ? 'form' : 'div'
  const table = (key: string, caption: string, headers: string[]): string => `<h3 id="acct-convert-${key}-heading">${caption}</h3><div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-labelledby="acct-convert-${key}-heading"><table class="xp-whm-detail-table"><caption class="sr-only">${caption}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-acct-convert-rows="${key}"><tr><td colspan="${headers.length}">${t('Not read')}</td></tr></tbody></table></div>`
  const field = (key: string, label: string, control: string, help = ''): string => `<div class="xp-whm-detail-field"><label for="acct-convert-${key}">${label}</label>${control}${help ? `<p class="xp-help" id="acct-convert-${key}-help">${help}</p>` : ''}</div>`
  return `${styles}<div class="xp-acct-convert-addon" data-acct-convert-addon data-can-manage="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <ol class="xp-whm-detail-steps" aria-label="${t('Conversion steps')}">${[t('Addon domain'), t('New account'), t('Review'), t('Convert')].map((step, index) => `<li><strong>${index + 1}</strong>${step}</li>`).join('')}</ol>
  <p class="xp-whm-detail-status" data-acct-convert-status data-state="unread" role="status">${t('Addon domains have not been read.')}</p>
  <div class="xp-acct-convert-addon__loading" data-acct-convert-loading aria-busy="true" aria-label="${t('Loading addon domains')}" hidden><span class="xp-skeleton-line"></span><span class="xp-skeleton-line xp-skeleton-line--short"></span></div>
  <div class="xp-acct-convert-addon__empty" data-acct-convert-empty hidden><h3>${t('No addon domains')}</h3><p>${t('Only an addon domain of an existing account can become its own account.')}</p></div>
  <section class="xp-whm-detail-card" data-whm-detail-section="convert-addon-choice" aria-labelledby="acct-convert-choice-heading">
    <h2 id="acct-convert-choice-heading">${t('Addon domain and new account')}</h2>
    <${container} class="xp-acct-convert-addon__group" data-acct-convert-form${input.canManage ? ' novalidate' : ''}>
      <div class="xp-whm-detail-fields">
        ${field('domain', t('Addon domain'), `<select class="xp-select" id="acct-convert-domain" dir="ltr" data-acct-convert-input="domainId"${disabled}><option value="">${t('Not read')}</option></select>`)}
        ${field('username', t('New account username'), `<input class="xp-input" id="acct-convert-username" type="text" maxlength="16" autocomplete="off" spellcheck="false" dir="ltr" aria-describedby="acct-convert-username-help" data-acct-convert-input="username"${disabled}>`, t('Lower-case letters and digits, starting with a letter.'))}
        ${field('plan', t('Plan'), `<select class="xp-select" id="acct-convert-plan" data-acct-convert-input="planId"${disabled}><option value="">${t('Not read')}</option></select>`)}
      </div>
      <div class="xp-acct-convert-addon__actions"><button type="${input.canManage ? 'submit' : 'button'}" class="xp-btn xp-btn--primary" data-acct-convert-preview${disabled}>${t('Review conversion')}</button><button type="button" class="xp-btn" data-acct-convert-refresh${disabled}>${t('Refresh')}</button></div>
    </${container}>
  </section>
  <section class="xp-whm-detail-card" data-whm-detail-section="convert-addon-review" aria-labelledby="acct-convert-review-heading">
    <h2 id="acct-convert-review-heading">${t('What moves to the new account')}</h2>
    <p class="xp-whm-detail-status" data-acct-convert-review-status data-state="unread" role="status">${t('No conversion has been reviewed.')}</p>
    <dl class="xp-whm-detail-fields" data-acct-convert-facts></dl>
    ${table('domains', t('Domains'), [t('Domain'), t('Kind'), t('Document root')])}
    ${table('mail', t('Mail and service users'), [t('Login'), t('Service')])}
    ${table('dns', t('DNS zones'), [t('Zone'), t('Records')])}
    ${table('conflicts', t('Conflicts'), [t('Conflict'), t('Value')])}
  </section>
  <section class="xp-whm-detail-card" data-whm-detail-section="convert-addon-apply" aria-labelledby="acct-convert-apply-heading">
    <h2 id="acct-convert-apply-heading">${t('Convert')}</h2>
    <p class="xp-help" data-acct-convert-capability>${t('Conversion availability has not been read.')}</p>
    ${field('confirm', t('Type the confirmation'), `<input class="xp-input" id="acct-convert-confirm" type="text" autocomplete="off" spellcheck="false" dir="ltr" aria-describedby="acct-convert-confirm-help" data-acct-convert-input="confirm" disabled>`, t('Type convert followed by the domain name, for example convert shop.example.com.'))}
    <div class="xp-acct-convert-addon__actions"><button type="button" class="xp-btn xp-btn--primary" data-acct-convert-apply disabled>${t('Convert to account')}</button></div>
  </section>
</div>`
}
