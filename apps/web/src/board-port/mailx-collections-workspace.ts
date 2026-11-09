import { mailxCollectionsClientTemplates } from './mailx-collection-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { MAILX_STYLE } from './mailx-whm-workspace.ts'
import { renderDavConnectionWorkspace } from './account-dav-workspace.ts'
export interface MailxCollectionsWorkspaceInput { locale: Locale; canManage: boolean; accountId?: string; canReadDav?: boolean }

/**
 * Calendar edit/delete, collection defaults and descriptions, address books, task lists and the device connection for
 * /email/calendars-contacts. Rows come only from authorized reads; read-only documents carry no <form>.
 */
export function renderMailxCollectionsWorkspace({ locale, canManage, accountId, canReadDav }: MailxCollectionsWorkspaceInput): string {
  const t = (message: string, values?: MessageValues): string => translator(locale)(message, values)
  const off = canManage ? '' : ' disabled', tag = canManage ? 'form' : 'div'
  const field = (id: string, label: string, control: string, help = ''): string => `<div class="xp-mailx__field"><label for="${id}">${label}</label>${control}${help ? `<p class="xp-help">${help}</p>` : ''}</div>`
  const select = (id: string, key: string): string => `<select class="xp-input" id="${id}" dir="ltr" data-mailx-${key} disabled></select>`
  const input = (id: string, key: string, extra = ''): string => `<input class="xp-input" id="${id}" type="text" data-mailx-${key} autocomplete="off"${extra} disabled>`
  const card = (key: string, title: string, body: string): string => `<section class="xp-mailx__card" aria-labelledby="mailx-collections-${key}"><h2 id="mailx-collections-${key}">${title}</h2>${body}</section>`
  const list = (kind: 'address-books' | 'task-lists', title: string, add: string): string => `<div class="xp-mailx__fields"><h3>${title}</h3>
    <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${title}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${title}</caption>
    <thead><tr>${[t('Name'), t('Description'), t('Default'), t('Actions')].map(header => `<th scope="col">${header}</th>`).join('')}</tr></thead><tbody data-mailx-${kind}><tr><td colspan="4">${t('Nothing has been read.')}</td></tr></tbody></table></div>
    <div class="xp-mailx__actions"><button type="button" class="xp-btn" data-mailx-add="${kind}" disabled>${add}</button></div></div>`
  return `<section class="xp-mailx" data-mailx-collections data-mailx-collections-can-read="${canManage}" data-mailx-can-manage="${canManage}" lang="${locale}" dir="${localeDirection(locale)}" aria-label="${t('Collection settings')}">
    ${MAILX_STYLE}<style>[data-mailx-collections] .xp-mailx__field>label[for]{padding-inline:var(--xp-control-content-inset)}[data-mailx-collections] h3{margin:0}[data-mailx-collections] .xp-whm-detail-scroll{overflow-x:auto;max-inline-size:100%}</style>
    ${card('calendar', t('Edit or delete a calendar'), `<${tag} class="xp-mailx__fields" data-mailx-calendar-editor${canManage ? ' novalidate' : ''}>
      ${field('mailx-calendar-mailbox', t('Owner mailbox'), select('mailx-calendar-mailbox', 'calendar-mailbox'))}
      ${field('mailx-calendar-target', t('Calendar'), select('mailx-calendar-target', 'calendar-target'))}
      ${field('mailx-calendar-name', t('Calendar name'), input('mailx-calendar-name', 'calendar-name', ' maxlength="200"'))}
      ${field('mailx-calendar-color', t('Color (HEX)'), input('mailx-calendar-color', 'calendar-color', ' dir="ltr" maxlength="7" spellcheck="false"'))}
      ${field('mailx-calendar-timezone', t('Time zone'), input('mailx-calendar-timezone', 'calendar-timezone', ' dir="ltr" maxlength="100" spellcheck="false"'))}
      <p class="xp-help" data-mailx-calendar-status role="status">${t('Saved calendars have not been read.')}</p>
      <div class="xp-mailx__actions"><button type="button" class="xp-btn xp-btn--primary" data-mailx-calendar-save disabled>${t('Edit collection')}</button><button type="button" class="xp-btn xp-btn--danger" data-mailx-calendar-delete disabled>${t('Delete collection')}</button></div>
    </${tag}>`)}
    ${card('settings', t('Collection settings'), `<${tag} class="xp-mailx__fields" data-mailx-collections-form${canManage ? ' novalidate' : ''}>
      <p class="xp-help">${t('Calendar and contact apps sync these same address books, task lists and descriptions. Defaults are saved for each mailbox.')}</p>
      ${field('mailx-collections-mailbox', t('Mailbox'), select('mailx-collections-mailbox', 'collections-mailbox'))}
      ${field('mailx-collections-default', t('Default calendar'), select('mailx-collections-default', 'collections-default'))}
      <div class="xp-mailx__fields" data-mailx-descriptions><p class="xp-help">${t('Nothing has been read.')}</p></div>
      ${list('address-books', t('Address books'), t('Add address book'))}
      ${list('task-lists', t('Task lists'), t('Add task list'))}
      <p class="xp-help" data-mailx-collections-status role="status">${t('Collection settings have not been read.')}</p>
      <div class="xp-mailx__actions"><button type="${canManage ? 'submit' : 'button'}" class="xp-btn xp-btn--primary" data-mailx-collections-save disabled>${t('Save collection settings')}</button><button type="button" class="xp-btn" data-mailx-collections-refresh${off}>${t('Refresh')}</button></div>
    </${tag}>`)}
    ${card('dav', t('Calendar and contact sync (CalDAV and CardDAV)'), renderDavConnectionWorkspace({ locale, accountId: accountId ?? '', canRead: canReadDav === true }))}
    ${mailxCollectionsClientTemplates()}
  </section>`
}
