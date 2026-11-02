import { classicMailClientTemplates } from './mail-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** Search controls use the authenticated mailbox transport, never an example result list. */
export function renderMailSearchWorkspace(input: { locale: Locale; mailbox: string; available: boolean; folder?: string; /** Already rendered trusted server component; never request HTML. */ attachmentPanel?: string }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const disabled = input.available ? '' : ' disabled'
  const folders = [['INBOX', t('Inbox')], ['Sent', t('Sent')], ['Drafts', t('Drafts')], ['Junk', t('Spam')], ['Trash', t(msgctxt('xmail-search', 'Trash'))], ['Archive', t('Archive')]]
  const current = input.folder ?? 'INBOX'
  if (!folders.some(([name]) => name === current)) folders.push([current, current])
  return `<section class="xp-card xp-mail-search" data-mail-search-workspace data-search-mailbox="${escapeHtml(input.mailbox)}" data-search-enabled="${input.available}" lang="${input.locale}" dir="${localeDirection(input.locale)}" aria-labelledby="mail-search-heading">${classicMailClientTemplates('search')}
    <style>.xp-mail-search{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0}.xp-mail-search :is(h2,h3,p,dl,dd,ul){margin:0}.xp-mail-search form{display:flex;flex-direction:column;gap:var(--xp-space-group,24px);margin:0}.xp-mail-search__fields{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:16px}.xp-mail-search .xp-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-mail-search :is(input,select){inline-size:100%;min-inline-size:0;box-sizing:border-box;min-block-size:44px}.xp-mail-search[dir=rtl] :is(input,select){text-align:right}.xp-mail-search button{min-block-size:44px}.xp-mail-search__actions{display:flex;flex-wrap:wrap;gap:16px}.xp-mail-search__results:empty{display:none}.xp-mail-search__results{display:grid;gap:16px;padding:0;list-style:none;min-inline-size:0}.xp-mail-search__result{display:flex;flex-direction:column;gap:8px;inline-size:100%;text-align:start;white-space:normal;overflow-wrap:anywhere;padding:16px}.xp-mail-search__result[aria-pressed=true]{border-color:var(--xp-accent)}.xp-mail-search__message{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-mail-search__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:16px}.xp-mail-search__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-mail-search dd{overflow-wrap:anywhere}.xp-mail-search [data-mail-search-body]{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;min-inline-size:0}.xp-mail-search [hidden]{display:none}@media(min-width:601px){.xp-mail-search{padding:24px}}@media(max-width:639px){.xp-mail-search__fields{grid-template-columns:minmax(0,1fr)}}</style>
    <h2 id="mail-search-heading">${t('Search mail')}</h2>
    <p class="xp-help">${t('Search sender, subject or text in this mailbox. Open a result to read its plain text.')}</p>
    <form role="search" data-mail-search-form aria-labelledby="mail-search-heading">
      <div class="xp-mail-search__fields">
        <div class="xp-field"><label for="mail-search-query">${t('Search text')}</label><input id="mail-search-query" class="xp-input" type="search" dir="auto" maxlength="512" required data-mail-search-query${disabled}></div>
        <div class="xp-field"><label for="mail-search-folder">${t('Folder')}</label><select id="mail-search-folder" class="xp-select" data-mail-search-folder${disabled}>${folders.map(([name, label]) => `<option value="${escapeHtml(name!)}"${name === current ? ' selected' : ''}>${escapeHtml(label!)}</option>`).join('')}</select></div>
      </div>
      <div class="xp-mail-search__actions"><button type="submit" class="xp-btn xp-btn--primary" data-mail-search-submit${disabled}>${t('Search')}</button><button type="button" class="xp-btn" data-mail-search-clear${disabled}>${t('Clear search')}</button></div>
    </form>
    <p class="xp-help" data-mail-search-status role="status">${input.available ? t('Enter search text to read matching messages.') : t('Search is unavailable for this mailbox session.')}</p>
    <ul class="xp-mail-search__results" data-mail-search-results aria-label="${t('Search results')}"></ul>
    <div class="xp-mail-search__actions"><button type="button" class="xp-btn" data-mail-search-next disabled>${t('More results')}</button></div>
    <article class="xp-mail-search__message" data-mail-search-message hidden aria-labelledby="mail-search-message-heading">
      <h3 id="mail-search-message-heading" data-mail-search-subject></h3>
      <dl class="xp-mail-search__facts">
        <div><dt>${t('From')}</dt><dd><bdi dir="ltr" data-mail-search-from></bdi></dd></div>
        <div><dt>${t('To')}</dt><dd><bdi dir="ltr" data-mail-search-to></bdi></dd></div>
        <div><dt>${t('Received')}</dt><dd><bdi dir="ltr" data-mail-search-date></bdi></dd></div>
      </dl>
      <p class="xp-help" data-mail-search-truncated hidden>${t('This preview is limited to the first 256 KiB of plain text.')}</p>
      <div dir="auto" data-mail-search-body></div>
      ${input.attachmentPanel ?? ''}
    </article>
  </section>`
}
