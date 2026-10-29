import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** /mail/folders: the sealed mailbox's IMAP folders; system and special-use folders stay protected. */
export function renderMailFolders(input: { locale: Locale; mailbox: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const columns = [t('Folder'), t('Messages'), t('Unread'), t('Shown in mail apps'), t('Actions')]
  return `<section class="xp-card xp-mail-folders" data-mail-folders data-folders-mailbox="${escapeHtml(input.mailbox)}" data-folders-can-manage="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}" aria-labelledby="mail-folders-heading">
    <style>.xp-mail-folders{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0}.xp-mail-folders :is(h2,h3,p,dl,dd){margin:0}.xp-mail-folders form{display:flex;flex-direction:column;gap:16px;margin:0}.xp-mail-folders__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.xp-mail-folders .xp-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-mail-folders :is(input:not([type=checkbox]),select){inline-size:100%;min-block-size:44px;box-sizing:border-box}.xp-mail-folders[dir=rtl] :is(input:not([type=checkbox]),select){text-align:right}.xp-mail-folders button{min-block-size:44px}.xp-mail-folders__actions{display:flex;flex-wrap:wrap;gap:16px;align-items:center}.xp-mail-folders__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:16px}.xp-mail-folders__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-mail-folders dd,.xp-mail-folders td{overflow-wrap:anywhere}.xp-mail-folders__name{display:flex;flex-direction:column;gap:8px}.xp-mail-folders__row-actions{display:flex;flex-wrap:wrap;gap:8px}.xp-mail-folders__check{display:flex;gap:8px;align-items:flex-start}.xp-mail-folders__editor{padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px}.xp-mail-folders [hidden]{display:none}@media(min-width:601px){.xp-mail-folders{padding:24px}}@media(max-width:639px){.xp-mail-folders__fields{grid-template-columns:minmax(0,1fr)}}</style>
    <h2 id="mail-folders-heading">${t('Mail folders')}</h2>
    <p class="xp-help">${t('Create, rename, show or hide and delete your own folders. Inbox, Sent, Drafts, Junk, Trash, Archive and other system folders cannot be renamed or deleted.')}</p>
    <p class="xp-help" data-mail-folders-status data-state="unread" role="status">${input.canManage ? t('Folders have not been read.') : t('Folder management is unavailable for this mailbox session. Nothing was read.')}</p>
    <dl class="xp-mail-folders__facts"><div><dt>${t('Mailbox')}</dt><dd><bdi dir="ltr">${escapeHtml(input.mailbox)}</bdi></dd></div><div><dt>${t('Observed at (UTC)')}</dt><dd><bdi dir="ltr" data-mail-folders-fact="observed">${t('Not read')}</bdi></dd></div><div><dt>${t('Folders')}</dt><dd><bdi dir="ltr" data-mail-folders-fact="count">${t('Not read')}</bdi></dd></div></dl>
    <form data-mail-folders-create aria-labelledby="mail-folders-create-heading">
      <h3 id="mail-folders-create-heading">${t('Create folder')}</h3>
      <div class="xp-mail-folders__fields">
        <div class="xp-field"><label for="mail-folders-name">${t('Folder name')}</label><input id="mail-folders-name" name="name" class="xp-input" maxlength="64" autocomplete="off" dir="auto" required disabled aria-describedby="mail-folders-name-help"><p id="mail-folders-name-help" class="xp-help">${t('Up to 64 characters. Slashes, quotes, wildcards and the folder separator are not allowed.')}</p></div>
        <div class="xp-field"><label for="mail-folders-parent">${t('Create inside')}</label><select id="mail-folders-parent" name="parent" class="xp-select" disabled><option value="">${t('Top level')}</option></select></div>
      </div>
      <div class="xp-mail-folders__actions"><button type="submit" class="xp-btn xp-btn--primary" data-mail-folders-submit disabled>${t('Create folder')}</button><button type="button" class="xp-btn" data-mail-folders-reload disabled>${t('Read folders again')}</button></div>
    </form>
    <p class="xp-help" data-mail-folders-incomplete hidden role="note">${t('Some message counts could not be read. They are shown as not read.')}</p>
    <div class="xp-table-wrap" role="region" tabindex="0" aria-label="${t('Folders')}"><table class="xp-table"><caption class="sr-only">${t('Mail folders')}</caption><thead><tr>${columns.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-mail-folders-rows><tr><td colspan="${columns.length}">${t('Folders have not been read.')}</td></tr></tbody></table></div>
    <form class="xp-mail-folders__editor" data-mail-folders-editor hidden tabindex="-1" aria-labelledby="mail-folders-editor-heading">
      <h3 id="mail-folders-editor-heading" data-mail-folders-editor-heading></h3>
      <p class="xp-help" data-mail-folders-editor-text></p>
      <div class="xp-field" data-mail-folders-rename-field><label for="mail-folders-rename">${t('New name')}</label><input id="mail-folders-rename" name="rename" class="xp-input" maxlength="64" autocomplete="off" dir="auto"></div>
      <label class="xp-mail-folders__check" data-mail-folders-confirm-field><input type="checkbox" name="confirm"><span data-mail-folders-confirm-text></span></label>
      <div class="xp-mail-folders__actions"><button type="submit" class="xp-btn xp-btn--primary" data-mail-folders-editor-submit></button><button type="button" class="xp-btn" data-mail-folders-editor-cancel>${t('Cancel')}</button></div>
    </form>
  </section>`
}
