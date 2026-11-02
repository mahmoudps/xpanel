import { classicMailClientTemplates } from './mail-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/**
 * Import, export and sharing tools for the mailbox Contacts page.
 * Presentation only: the browser controller performs every read/write and states
 * explicitly that importing/sharing here is stored contact configuration.
 */
export function renderMailContactsTools(input: { locale: Locale; mailbox: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const disabled = input.canManage ? '' : ' disabled'
  return `<section class="xp-card" data-mail-contacts-tools data-contacts-tools-mailbox="${escapeHtml(input.mailbox)}" data-contacts-tools-manage="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}" aria-labelledby="mail-contacts-tools-heading">${classicMailClientTemplates('contact-tools')}
    <style>[data-mail-contacts-tools]{padding:var(--xp-space-field,16px)}[data-mail-contacts-tools]>.xp-card__header{margin-block-end:var(--xp-space-group,24px)}.xp-contacts-tools{display:grid;gap:24px;min-inline-size:0}.xp-contacts-tools__group{display:grid;gap:16px;min-inline-size:0;padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px}.xp-contacts-tools__group h3{margin:0;font-size:15px;line-height:22px}.xp-contacts-tools__fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:16px;min-inline-size:0}.xp-contacts-tools textarea{inline-size:100%;min-inline-size:0;box-sizing:border-box;min-block-size:96px}.xp-contacts-tools__actions{display:flex;flex-wrap:wrap;gap:8px}.xp-contacts-tools__shares{display:grid;gap:8px;margin:0;padding:0;list-style:none}.xp-contacts-tools__shares li{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;overflow-wrap:anywhere}@media(min-width:601px){[data-mail-contacts-tools],[data-mail-contacts-tools] .xp-contacts-tools__group{padding:var(--xp-space-card,24px)}}</style>
    <div class="xp-card__header"><div><h2 id="mail-contacts-tools-heading">${t('Import, export and sharing')}</h2><p class="xp-help">${t('These actions store contact configuration for this mailbox. Delivery, synchronisation and CardDAV are not claimed.')}</p></div></div>
    <div class="xp-contacts-tools">
      <div class="xp-contacts-tools__group" data-contacts-tools-section="import">
        <h3>${t('Import contacts')}</h3>
        <div class="xp-contacts-tools__fields">
          <div class="xp-field"><label for="contacts-import-file">${t('vCard file')}</label><input id="contacts-import-file" class="xp-input" type="file" accept=".vcf,text/vcard,text/x-vcard" data-contacts-import-file${disabled}></div>
          <div class="xp-field" style="grid-column:1/-1"><label for="contacts-import-text">${t('Or paste vCard content')}</label><textarea id="contacts-import-text" class="xp-textarea xp-mono" dir="ltr" spellcheck="false" data-contacts-import-text placeholder="BEGIN:VCARD"${disabled}></textarea></div>
        </div>
        <p class="xp-help">${t('Each card needs a formatted name (FN) and an email address. Nothing is imported until you confirm.')}</p>
        <p class="xp-help" data-contacts-import-preview role="status">${t('No vCard content has been read.')}</p>
        <div class="xp-contacts-tools__actions"><button type="button" class="xp-btn xp-btn--primary" data-contacts-import${disabled}>${t('Import reviewed cards')}</button></div>
        <p class="xp-help" data-contacts-import-status role="status" hidden></p>
      </div>
      <div class="xp-contacts-tools__group" data-contacts-tools-section="export">
        <h3>${t('Export contacts')}</h3>
        <p class="xp-help">${t('Downloads the vCard document the server returns for this mailbox.')}</p>
        <div class="xp-contacts-tools__actions"><button type="button" id="contacts-export" class="xp-btn" data-contacts-export${disabled}>${t('Export vCard')}</button></div>
        <p class="xp-help" data-contacts-export-status role="status" hidden></p>
      </div>
      <div class="xp-contacts-tools__group" data-contacts-tools-section="share">
        <h3>${t('Share a contact')}</h3>
        <div class="xp-contacts-tools__fields">
          <div class="xp-field"><label for="contacts-share-contact">${t('Your contact')}</label><select id="contacts-share-contact" class="xp-select" data-contacts-share-contact${disabled}><option value="">${t('Reading contacts…')}</option></select></div>
          <div class="xp-field"><label for="contacts-share-principal">${t('Mailbox to share with')}</label><input id="contacts-share-principal" class="xp-input" dir="ltr" autocomplete="off" data-contacts-share-principal placeholder="teammate@example.test"${disabled}></div>
          <div class="xp-field"><label for="contacts-share-permission">${t('Permission')}</label><select id="contacts-share-permission" class="xp-select" data-contacts-share-permission${disabled}><option value="read">${t('Read only')}</option><option value="read-write">${t('Read and edit')}</option></select></div>
        </div>
        <div class="xp-contacts-tools__actions"><button type="button" class="xp-btn" data-contacts-share-add${disabled}>${t('Add sharing')}</button></div>
        <ul class="xp-contacts-tools__shares" data-contacts-shares aria-label="${t('Current sharing')}"></ul>
        <p class="xp-help" data-contacts-share-status role="status" hidden></p>
      </div>
    </div>
  </section>`
}
