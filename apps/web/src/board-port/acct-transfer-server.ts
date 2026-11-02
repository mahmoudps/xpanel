import { type Locale, type MessageValues, localeDirection, translator } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { renderWhmTransferWorkspace } from './whm-transfer-workspace.ts'
import { classicTransferCredentialTemplates } from './transfer-client-templates.ts'

const styles = `<style>.xp-acct-transfer-server{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-acct-transfer-server :is(h2,h3,p,ol){margin:0}.xp-acct-transfer-server .xp-whm-detail-fields{gap:16px}.xp-acct-transfer-server .xp-whm-detail-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0;text-align:start}.xp-acct-transfer-server__loading,.xp-acct-transfer-server__empty{display:flex;flex-direction:column;gap:8px;align-items:flex-start}.xp-acct-transfer-server .xp-whm-detail-table th{white-space:nowrap}.xp-acct-transfer-server__actions{display:flex;flex-wrap:wrap;gap:8px}.xp-acct-transfer-server[dir=rtl] :is(input,textarea)[dir=auto]{text-align:right}@media (max-width:600px){.xp-acct-transfer-server .xp-whm-detail-card{padding:16px}}@media (min-width:601px){.xp-acct-transfer-server .xp-whm-detail-card{padding:24px}}</style>`

/** /whm/transfers/server body: wizard steps, write-once source credentials and the saved session workspace in whole-server scope. */
export function renderAcctTransferServerWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const disabled = input.canManage ? '' : ' disabled'
  const container = input.canManage ? 'form' : 'div'
  const steps = [t('Connect'), t('Accounts'), t('Review'), t('Transfer')]
  const headers = [t('Label'), t('Token fingerprint'), t('Added (UTC)'), t('Added by'), t('Actions')]
  return `${styles}<div class="xp-acct-transfer-server" data-acct-transfer-server lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <ol class="xp-whm-detail-steps" aria-label="${t('Migration steps')}">${steps.map((step, index) => `<li><strong>${index + 1}</strong>${step}</li>`).join('')}</ol>
  <section class="xp-whm-detail-card" data-whm-detail-section="transfer-server-credentials" data-acct-transfer-credentials data-can-manage="${input.canManage}" aria-labelledby="acct-transfer-credentials-heading">
    <h2 id="acct-transfer-credentials-heading">${t('Source API tokens')}</h2>
    <p class="xp-help">${t('On the source server, create a root API token with lifecycle read access in API tokens, then paste it here once. It is stored on this server with owner-only access and is never shown again; sessions refer to it by label.')}</p>
    <p class="xp-whm-detail-status" data-acct-transfer-credentials-status data-state="unread" role="status">${t('Stored source tokens have not been read.')}</p>
    <div class="xp-acct-transfer-server__loading" data-acct-transfer-credentials-loading aria-busy="true" aria-label="${t('Loading stored source tokens')}" hidden><span class="xp-skeleton-line"></span><span class="xp-skeleton-line xp-skeleton-line--short"></span></div>
    <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Stored source tokens')}"><table class="xp-whm-detail-table"><caption class="sr-only">${t('Stored source tokens')}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-acct-transfer-credentials-rows><tr><td colspan="5">${t('Not read')}</td></tr></tbody></table></div>
    <div class="xp-acct-transfer-server__empty" data-acct-transfer-credentials-empty hidden><h3>${t('No source tokens stored')}</h3><p>${t('Add the token from the source server below before you connect.')}</p></div>
    ${classicTransferCredentialTemplates()}
    <${container} class="xp-whm-detail-fields" data-acct-transfer-credentials-form${input.canManage ? ' novalidate' : ''}>
      <div class="xp-whm-detail-field"><label for="acct-transfer-credential-label">${t('Label')}</label><input class="xp-input" id="acct-transfer-credential-label" type="text" maxlength="80" autocomplete="off" dir="auto" data-acct-transfer-credential-input="label"${disabled}></div>
      <div class="xp-whm-detail-field"><label for="acct-transfer-credential-token">${t('API token from the source')}</label><input class="xp-input" id="acct-transfer-credential-token" type="password" maxlength="64" autocomplete="off" spellcheck="false" dir="ltr" aria-describedby="acct-transfer-credential-token-help" data-acct-transfer-credential-input="token"${disabled}><p class="xp-help" id="acct-transfer-credential-token-help">${t('The complete token starts with xp_.')}</p></div>
      <div class="xp-acct-transfer-server__actions"><button type="${input.canManage ? 'submit' : 'button'}" class="xp-btn xp-btn--primary" data-acct-transfer-credential-save${disabled}>${t('Store token')}</button><button type="button" class="xp-btn" data-acct-transfer-credentials-refresh${disabled}>${t('Refresh')}</button></div>
    </${container}>
  </section>
  <section class="xp-whm-detail-card" data-whm-detail-section="transfer-server-channel" aria-labelledby="acct-transfer-channel-heading">
    <h2 id="acct-transfer-channel-heading">${t('Authenticated channel')}</h2>
    <p class="xp-help">${t("Enter the source's HTTPS API address, for example https://source.example.com. Pin the SHA-256 fingerprint of its certificate, or leave the fingerprint empty to rely on the system certificate store. Redirects are never followed and the token is sent only after the certificate is accepted.")}</p>
  </section>
  ${renderWhmTransferWorkspace({ lang: input.locale, canManage: input.canManage, scope: 'server', readCredentials: true })}
</div>`
}
