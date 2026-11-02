import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { classicMailToolsClientTemplates } from './mailx-mail-tools-client-templates.ts'
import { MAILX_STYLE } from './mailx-whm-workspace.ts'
export type MailxMailToolsSection = 'spam' | 'lists'
export interface MailxMailToolsWorkspaceInput { locale: Locale; section: MailxMailToolsSection; canManage: boolean }

/**
 * Owner mail tools beside /email/spam-filters (per-mailbox native spam effect, filter training, BoxTrapper) and
 * /email/mailing-lists (list delivery read from the host, moderation). Capabilities this server lacks keep their
 * layout, disabled, with the missing native step stated.
 */
export function renderMailxMailToolsWorkspace({ locale, section, canManage }: MailxMailToolsWorkspaceInput): string {
  const t = (message: string, values?: MessageValues): string => translator(locale)(message, values)
  const card = (key: string, title: string, body: string): string => `<section class="xp-mailx__card" aria-labelledby="mailx-tools-${key}"><h2 id="mailx-tools-${key}">${title}</h2>${body}</section>`
  const fact = (label: string, value: string, key = ''): string => `<div><dt>${label}</dt><dd${key ? ` data-mailx-tools-fact="${key}"` : ''}>${value}</dd></div>`
  const check = (id: string, label: string): string => `<div class="xp-mailx__check"><input type="checkbox" id="${id}" disabled><label for="${id}">${label}</label></div>`
  const area = (id: string, label: string): string => `<div class="xp-mailx__field"><label for="${id}">${label}</label><textarea class="xp-input" id="${id}" rows="3" dir="ltr" disabled></textarea></div>`
  const unavailable = t('Unavailable')
  const body = section === 'spam' ? `
    ${card('native', t('Spam filter per mailbox'), `<div class="xp-mailx__heading"><p>${t('Saved mailbox spam preferences take effect on this server. Allowed senders and a mailbox that sets its own filtering or score go to the rspamd settings file. Blocked senders and moving flagged mail to Junk go to the mailbox Sieve policy script, which runs before the mailbox filters.')}</p><button type="button" class="xp-btn" data-mailx-tools-refresh${canManage ? '' : ' disabled'}>${t('Refresh')}</button></div>
      <p class="xp-whm-detail-status" data-mailx-tools-status data-state="unread" role="status">${t('Mailbox spam state has not been read.')}</p>
      <dl class="xp-mailx__facts">${fact(t('Detected filter'), t('Not read'), 'engine')}${fact(t('Postfix passes mail to the filter'), t('Not read'), 'wiring')}${fact(t('Observed at (UTC)'), t('Not read'), 'observed-at')}</dl>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Mailboxes')}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t('Mailboxes')}</caption>
        <thead><tr>${[t('Mailbox'), t('Saved preference'), t('Applied on this server'), t('Takes effect'), t('Train the filter')].map(header => `<th scope="col">${header}</th>`).join('')}</tr></thead>
        <tbody data-mailx-tools-rows><tr><td colspan="5">${t('Nothing has been read.')}</td></tr></tbody></table></div>
      <p class="xp-help">${t('Training reads the messages in the mailbox Inbox (as not spam) or Junk folder (as spam) and teaches the server-wide filter. It runs as a host job.')}</p>
      <p class="xp-help" data-mailx-tools-action-status role="status"></p>
      <div class="xp-mailx__actions"><button type="button" class="xp-btn xp-btn--primary" data-mailx-tools-apply disabled>${t('Apply saved preferences')}</button></div>`)}
    ${card('boxtrapper', 'BoxTrapper', `<p class="xp-whm-detail-status" data-state="unavailable" role="status">${t('BoxTrapper is unavailable on this server.')}</p>
      <dl class="xp-mailx__facts">${fact(t('Challenge-response verification'), unavailable)}${fact(t('Verification queue'), unavailable)}</dl>
      ${check('mailx-boxtrapper-enabled', t('Ask unknown senders to verify before delivery'))}${area('mailx-boxtrapper-allow', t('Senders delivered without verification'))}
      <p class="xp-help">${t('Missing native step: xPanel has no challenge-response provider for Postfix and Dovecot. Challenge mail sent to forged senders creates backscatter, so none is enabled. Use the spam filter and sender lists instead.')}</p>`)}`
    : card('lists', t('List delivery and moderation'), `<div class="xp-mailx__heading"><p>${t('Lists with open posting are delivered by expanding the list address to its members in the Postfix alias table. Lists that limit posting to members or hold posts for moderation are not delivered, because that needs a list manager.')}</p><button type="button" class="xp-btn" data-mailx-lists-refresh${canManage ? '' : ' disabled'}>${t('Refresh')}</button></div>
      <p class="xp-whm-detail-status" data-mailx-lists-status data-state="unread" role="status">${t('List delivery has not been read.')}</p>
      <dl class="xp-mailx__facts">${fact(t('Delivery to members'), t('Not read'), 'delivery')}${fact(t('Observed at (UTC)'), t('Not read'), 'observed-at')}${fact(t('Moderation queue'), unavailable)}${fact(t('Held messages'), t('None can be held'))}</dl>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Mailing lists')}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t('Mailing lists')}</caption>
        <thead><tr>${[t('Address'), t('Members'), t('Delivery state')].map(header => `<th scope="col">${header}</th>`).join('')}</tr></thead>
        <tbody data-mailx-lists-rows><tr><td colspan="3">${t('Nothing has been read.')}</td></tr></tbody></table></div>
      <p class="xp-help" data-mailx-lists-action-status role="status"></p>
      <div class="xp-mailx__actions"><button type="button" class="xp-btn xp-btn--primary" data-mailx-lists-apply disabled>${t('Apply saved lists')}</button></div>
      ${check('mailx-lists-hold', t('Hold posts from non-members for review'))}${area('mailx-lists-moderators', t('Moderators'))}
      <p class="xp-help">${t('Moderation needs a list manager (for example Mailman or mlmmj) that holds posts for approval. None is installed or connected.')}</p>`)
  return `<section class="xp-mailx" data-mailx-tools data-mailx-tools-section="${section}" data-mailx-can-manage="${canManage}" lang="${locale}" dir="${localeDirection(locale)}" aria-label="${t('Mail tools')}">${MAILX_STYLE}<style>[data-mailx-tools] .xp-mailx__field>label[for]{padding-inline:var(--xp-control-content-inset)}[data-mailx-tools] .xp-whm-detail-scroll{overflow-x:auto;max-inline-size:100%}</style>${body}${classicMailToolsClientTemplates(section)}</section>`
}
