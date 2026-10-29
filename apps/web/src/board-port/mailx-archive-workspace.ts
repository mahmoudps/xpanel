import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
export interface MailxArchiveWorkspaceInput { locale: Locale; canManage: boolean }

/** Owner email archive for /email/archive: per-domain copies into one of the owner's own mailboxes, with retention. Rows come only from an authorized read. */
export function renderMailxArchiveWorkspace({ locale, canManage }: MailxArchiveWorkspaceInput): string {
  const t = (message: string, values?: MessageValues): string => translator(locale)(message, values)
  const notRead = t('Not read')
  const fact = (label: string, key: string): string => `<div><dt>${label}</dt><dd data-mailx-archive-fact="${key}">${notRead}</dd></div>`
  const headers = [t('Domain'), t('Archive mailbox'), t('Incoming'), t('Outgoing'), t('Keep for days'), t('State'), t('Retention')]
  return `<section class="xp-mailx-archive" data-mailx-archive data-mailx-can-manage="${canManage}" lang="${locale}" dir="${localeDirection(locale)}" aria-labelledby="mailx-archive-summary">
    <style>.xp-mailx-archive{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-mailx-archive :is(h2,p,dl,dd){margin:0}.xp-mailx-archive h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:var(--xp-weight-semibold)}
    .xp-mailx-archive__card{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface)}
    .xp-mailx-archive__heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}.xp-mailx-archive__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:16px}
    .xp-mailx-archive__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-mailx-archive dt{font-weight:600}.xp-mailx-archive dd{overflow-wrap:anywhere}.xp-mailx-archive .xp-whm-detail-scroll{overflow-x:auto;max-inline-size:100%}
    .xp-mailx-archive :is(button,select,.xp-input){min-block-size:44px}.xp-mailx-archive input[type=checkbox]{inline-size:20px;block-size:20px}.xp-mailx-archive input[type=number]{inline-size:8em}
    .xp-mailx-archive__actions{display:flex;flex-wrap:wrap;gap:16px}.xp-mailx-archive :focus-visible{outline:2px solid var(--xp-accent);outline-offset:2px}@media(min-width:601px){.xp-mailx-archive__card{padding:24px}}</style>
    <section class="xp-mailx-archive__card" aria-labelledby="mailx-archive-summary"><h2 id="mailx-archive-summary">${t('Archive state')}</h2>
      <div class="xp-mailx-archive__heading"><p>${t('A copy of each archived message is delivered to the mailbox you choose and counts toward its quota.')}</p><button type="button" class="xp-btn" data-mailx-archive-refresh${canManage ? '' : ' disabled'}>${t('Refresh')}</button></div>
      <p class="xp-whm-detail-status" data-mailx-archive-status data-state="unread" role="status">${t('The email archive has not been read.')}</p>
      <dl class="xp-mailx-archive__facts">${fact(t('Saved policy'), 'saved')}${fact(t('Host agent'), 'host')}${fact(t('Applied on this server'), 'state')}${fact(t('Observed at (UTC)'), 'observed-at')}${fact(t('Last saved'), 'updated')}</dl>
      <p class="xp-help">${t('Retention removes archived messages older than the number of days you set; 0 keeps them until you delete them. Retention runs only when you start it.')}</p>
    </section>
    <section class="xp-mailx-archive__card" aria-labelledby="mailx-archive-domains"><h2 id="mailx-archive-domains">${t('Archived domains')}</h2>
      <${canManage ? 'form' : 'div'} data-mailx-archive-form${canManage ? ' novalidate' : ''}>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Archived domains')}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t('Archived domains')}</caption>
        <thead><tr>${headers.map(header => `<th scope="col">${header}</th>`).join('')}</tr></thead><tbody data-mailx-archive-rows><tr><td colspan="${headers.length}">${t('Nothing has been read.')}</td></tr></tbody></table></div>
      <p class="xp-help" data-mailx-archive-form-status role="status"></p>
      <div class="xp-mailx-archive__actions"><button type="${canManage ? 'submit' : 'button'}" class="xp-btn xp-btn--primary" data-mailx-archive-save disabled>${t('Save and apply')}</button></div></${canManage ? 'form' : 'div'}>
    </section>
  </section>`
}
