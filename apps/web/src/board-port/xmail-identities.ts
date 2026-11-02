import { classicMailClientTemplates } from './mail-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/**
 * Mailbox identities and signatures workspace (`/mail/settings/identities`).
 * Presentation only: the controller reads/writes the real identities route and
 * states that this is stored identity configuration, not delivery behaviour.
 */
export function renderMailIdentitiesWorkspace(input: { locale: Locale; mailbox: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const disabled = input.canManage ? '' : ' disabled'
  return `<section class="xp-card xp-mail-identities" data-mail-identities data-identities-mailbox="${escapeHtml(input.mailbox)}" data-identities-manage="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}" aria-labelledby="mail-identities-heading">${classicMailClientTemplates('identities')}
    <style>.xp-mail-identities{display:grid;gap:24px;min-inline-size:0;padding:var(--xp-space-field,16px)}.xp-mail-identities>.xp-card__header{margin-block-end:0}.xp-mail-identities__rows:empty{display:none}.xp-mail-identities[dir=rtl] :is(input:not([type=checkbox]),textarea){text-align:right}.xp-mail-identities__rows{display:grid;gap:16px;min-inline-size:0}.xp-mail-identities__form{display:grid;gap:16px;min-inline-size:0;padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px}.xp-mail-identities__form h3{margin:0;font-size:15px;line-height:22px}.xp-mail-identities .xp-mail-identities__fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:16px;min-inline-size:0}.xp-mail-identities textarea{inline-size:100%;min-inline-size:0;box-sizing:border-box;min-block-size:96px}.xp-mail-identities__actions{display:flex;flex-wrap:wrap;gap:8px}.xp-mail-identities__row{display:grid;gap:16px;padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;min-inline-size:0;overflow-wrap:anywhere}.xp-mail-identities__row header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}.xp-mail-identities__row dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:var(--xp-space-field,16px);margin:0;min-inline-size:0;text-align:left}.xp-mail-identities__datum{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--xp-space-label,8px);min-inline-size:0;align-content:start}.xp-mail-identities[dir=rtl] .xp-mail-identities__row dl{text-align:right}.xp-mail-identities__row dt{margin:0;min-inline-size:0;font-size:13px;color:var(--xp-text-muted,#5d6b7e)}.xp-mail-identities__row dd{margin:0;min-inline-size:0;max-inline-size:100%;overflow-wrap:anywhere;text-align:inherit}.xp-mail-identities__datum dd>bdi{min-inline-size:0;max-inline-size:100%;overflow-wrap:anywhere;white-space:normal}@media(min-width:601px){.xp-mail-identities,.xp-mail-identities__form,.xp-mail-identities__row{padding:var(--xp-space-card,24px)}}</style>
    <div class="xp-card__header"><div><h2 id="mail-identities-heading">${t('Identities & signatures')}</h2><p class="xp-help">${t('Stored identity configuration for this mailbox: display name, reply-to and signatures. Only identities with verified mailbox ownership are listed; older metadata may need review. Choosing an identity does not verify delivery.')}</p></div></div>
    <div class="xp-mail-identities__rows" data-identities-rows></div>
    <p class="xp-help" data-identities-status role="status" hidden></p>
    <div class="xp-mail-identities__form" data-identities-form role="group" aria-labelledby="mail-identities-heading">
      <h3 data-identities-form-title>${t('Add identity')}</h3>
      <div class="xp-mail-identities__fields">
        <div class="xp-field"><label for="identities-email">${t(msgctxt('xmail-identities', 'Email'))}</label><input id="identities-email" class="xp-input xp-mono" dir="ltr" value="${escapeHtml(input.mailbox)}" readonly></div>
        <div class="xp-field"><label for="identities-display-name">${t('Display name')}</label><input id="identities-display-name" class="xp-input" dir="auto" maxlength="200" data-identities-display-name${disabled}></div>
        <div class="xp-field"><label for="identities-reply-to">${t('Reply-to')}</label><input id="identities-reply-to" class="xp-input xp-mono" dir="ltr" data-identities-reply-to${disabled}></div>
        <div class="xp-field"><label for="identities-default">${t('Default identity')}</label><label class="xp-check" for="identities-default"><input id="identities-default" type="checkbox" data-identities-default${disabled}> ${t('Use as default')}</label></div>
      </div>
      <div class="xp-field"><label for="identities-text-signature">${t('Plain signature')}</label><textarea id="identities-text-signature" class="xp-textarea" dir="auto" maxlength="20000" data-identities-text-signature${disabled}></textarea></div>
      <div class="xp-field"><label for="identities-html-signature">${t('HTML signature (source only)')}</label><textarea id="identities-html-signature" class="xp-textarea xp-mono" dir="ltr" maxlength="20000" spellcheck="false" data-identities-html-signature${disabled}></textarea></div>
      <p class="xp-help">${t('HTML is stored as source and is not rendered on this page.')}</p>
      <div class="xp-mail-identities__actions">
        <button type="button" class="xp-btn xp-btn--primary" data-identities-save${disabled}>${t('Save identity')}</button>
        <button type="button" class="xp-btn" data-identities-reset${disabled}>${t('New identity')}</button>
      </div>
    </div>
  </section>`
}
