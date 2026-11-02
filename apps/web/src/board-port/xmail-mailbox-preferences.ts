import { classicMailClientTemplates } from './mail-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** /mail/settings/preferences: UI preferences saved for the sealed mailbox only; address and routing changes live elsewhere. */
export function renderMailPreferences(input: { locale: Locale; mailbox: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const [introBefore = '', introAfter = ''] = t('These preferences are saved for {mailbox} only. Your address and mail routing are not changed here.').split('{mailbox}')
  const select = (name: string, label: string, options: string[][], help = ''): string => `<div class="xp-field"><label for="mail-preferences-${name}">${label}</label><select id="mail-preferences-${name}" name="${name}" class="xp-select"${help ? ` aria-describedby="mail-preferences-${name}-help"` : ''} disabled>${options.map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select>${help ? `<p class="xp-help" id="mail-preferences-${name}-help">${help}</p>` : ''}</div>`
  return `<section class="xp-card xp-mail-preferences" data-mail-preferences data-preferences-mailbox="${escapeHtml(input.mailbox)}" data-preferences-can-manage="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}" aria-labelledby="mail-preferences-heading">${classicMailClientTemplates('preferences')}
    <style>.xp-mail-preferences{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0}.xp-mail-preferences :is(h2,h3,p){margin:0}.xp-mail-preferences__group{display:flex;flex-direction:column;gap:16px;min-inline-size:0}.xp-mail-preferences__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;min-inline-size:0}.xp-mail-preferences .xp-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-mail-preferences select{inline-size:100%;min-block-size:44px;box-sizing:border-box}.xp-mail-preferences__actions{display:flex;flex-wrap:wrap;gap:16px;align-items:center}.xp-mail-preferences .xp-btn{min-block-size:44px}.xp-mail-preferences p{overflow-wrap:anywhere}.xp-mail-preferences [hidden]{display:none}@media(min-width:601px){.xp-mail-preferences{padding:24px}}@media(max-width:639px){.xp-mail-preferences__fields{grid-template-columns:minmax(0,1fr)}}</style>
    <div class="xp-mail-preferences__group">
      <h2 id="mail-preferences-heading">${t('Mailbox preferences')}</h2>
      <p class="xp-help">${escapeHtml(introBefore)}<bdi dir="ltr">${escapeHtml(input.mailbox)}</bdi>${escapeHtml(introAfter)}</p>
      <p class="xp-help" data-preferences-status data-state="unread" role="status">${input.canManage ? t('Preferences have not been read.') : t('Preferences are unavailable for this mailbox session. Nothing was read.')}</p>
      <p class="xp-help" data-preferences-application role="note">${t('Saved preferences are stored for this mailbox. The inbox and compose pages do not apply them yet.')}</p>
    </div>
    <div class="xp-mail-preferences__group" data-preferences-form role="group" aria-labelledby="mail-preferences-heading">
      <div class="xp-mail-preferences__fields">
        ${select('density', t('Display density'), [['comfortable', t(msgctxt('xmail-mailbox-preferences', 'Comfortable'))], ['compact', t(msgctxt('xmail-mailbox-preferences', 'Compact'))]])}
        ${select('messagesPerPage', t('Messages per page'), [['25', '25'], ['50', '50'], ['100', '100']])}
        ${select('replyIdentityId', t('Default reply identity'), [['', t('This mailbox address')]], t('Choose from your saved identities.'))}
        ${select('dateFormat', t('Date format'), [['utc', t('UTC, the same for everyone')], ['local', t('Local time of this browser')]])}
      </div>
      <p class="xp-help" data-preferences-record>${t('Saved record not read.')}</p>
      <div class="xp-mail-preferences__actions"><button type="button" class="xp-btn" data-preferences-refresh disabled>${t('Reload saved preferences')}</button><button type="button" class="xp-btn" data-preferences-discard disabled>${t('Discard changes')}</button><button type="button" class="xp-btn xp-btn--primary" data-preferences-save disabled>${t('Save preferences')}</button></div>
    </div>
    <section class="xp-mail-preferences__group" aria-labelledby="mail-preferences-plus-heading">
      <h3 id="mail-preferences-plus-heading">${t('Plus addressing')}</h3>
      <p class="xp-help" data-preferences-plus data-state="unread">${t('Plus addressing support has not been read.')}</p>
    </section>
  </section>`
}
