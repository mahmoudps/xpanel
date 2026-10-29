import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** /mail/settings/forwarders: the sealed mailbox's own forwarder record; other sources are never shown or editable. */
export function renderMailForwarders(input: { locale: Locale; mailbox: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const mailbox = `<bdi dir="ltr">${escapeHtml(input.mailbox)}</bdi>`
  const [introBefore = '', introAfter = ''] = t('Send a copy of mail that arrives at {mailbox} to up to 10 other addresses. Forwarding set for other addresses is not shown here.').split('{mailbox}')
  return `<section class="xp-card xp-mail-forwarders" data-mail-forwarders data-forwarders-mailbox="${escapeHtml(input.mailbox)}" data-forwarders-can-manage="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}" aria-labelledby="mail-forwarders-heading">
    <style>.xp-mail-forwarders{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0}.xp-mail-forwarders :is(h2,h3,p){margin:0}.xp-mail-forwarders__header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}.xp-mail-forwarders__intro,.xp-mail-forwarders__add{display:flex;flex-direction:column;gap:16px;min-inline-size:0}.xp-mail-forwarders .xp-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-mail-forwarders .xp-input{inline-size:100%;min-block-size:44px;box-sizing:border-box}.xp-mail-forwarders[dir=rtl] .xp-input{text-align:right}.xp-mail-forwarders__check{display:flex;align-items:center;gap:8px;min-block-size:44px}.xp-mail-forwarders__check input{inline-size:16px;block-size:16px;flex:none}.xp-mail-forwarders__actions{display:flex;flex-wrap:wrap;gap:16px;align-items:center}.xp-mail-forwarders .xp-btn{min-block-size:44px}.xp-mail-forwarders td{overflow-wrap:anywhere}.xp-mail-forwarders [hidden]{display:none}@media(min-width:601px){.xp-mail-forwarders{padding:24px}}</style>
    <div class="xp-mail-forwarders__header"><h2 id="mail-forwarders-heading">${t('Forward this mailbox')}</h2><span class="xp-help xp-tabular" data-forwarders-count>${t('Not read')}</span></div>
    <div class="xp-mail-forwarders__intro">
      <p class="xp-help">${escapeHtml(introBefore)}${mailbox}${escapeHtml(introAfter)}</p>
      <p class="xp-help" data-forwarders-status data-state="unread" role="status">${input.canManage ? t('Forwarders have not been read.') : t('Forwarders are unavailable for this mailbox session. Nothing was read.')}</p>
      <p class="xp-help" data-forwarders-application role="note">${t('Forwarders take effect when the mail server applies them; each save reports whether it did.')}</p>
    </div>
    <div class="xp-table-wrap" role="region" tabindex="0" aria-label="${t('Forwarding destinations')}"><table class="xp-table"><caption class="sr-only">${t('Forwarding destinations of this mailbox')}</caption><thead><tr><th scope="col">${t(msgctxt('xmail-mailbox-forwarders', 'Destination'))}</th><th scope="col">${t('Action')}</th></tr></thead><tbody data-forwarders-rows><tr><td colspan="2">${t('Forwarders have not been read.')}</td></tr></tbody></table></div>
    <div class="xp-mail-forwarders__add" role="group" aria-labelledby="mail-forwarders-add-heading">
      <h3 id="mail-forwarders-add-heading">${t('Add a destination')}</h3>
      <div class="xp-field"><label for="mail-forwarders-address">${t('Destination address')}</label><input id="mail-forwarders-address" name="destination" type="email" class="xp-input" dir="ltr" autocomplete="off" spellcheck="false" maxlength="254" aria-describedby="mail-forwarders-rules" disabled></div>
      <label class="xp-mail-forwarders__check"><input type="checkbox" name="keepCopy" checked disabled aria-describedby="mail-forwarders-copy"> ${t('Keep a copy in this mailbox')}</label>
      <p class="xp-help" id="mail-forwarders-copy">${t('The mail server always keeps a copy of forwarded mail in this mailbox. Forwarding without a copy is not supported.')}</p>
      <p class="xp-help" id="mail-forwarders-rules">${t('This mailbox itself and addresses that send mail back to it are refused.')}</p>
      <div class="xp-mail-forwarders__actions"><button type="button" class="xp-btn" data-forwarders-refresh disabled>${t('Refresh')}</button><button type="button" class="xp-btn xp-btn--primary" data-forwarders-add disabled>${t(msgctxt('xmail-mailbox-forwarders', 'Add forwarder'))}</button></div>
    </div>
  </section>`
}
