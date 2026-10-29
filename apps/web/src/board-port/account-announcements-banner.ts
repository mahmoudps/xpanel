import { localeDirection, localizedText, translator, type Locale, type LocalizedText, type MessageValues } from '../i18n.ts'
import { escapeHtml, formatDisplayDateTime } from '../tokens.ts'

/** One live announcement as /api/account/announcements returns it (apps/api/src/announcements-workspace.ts). */
export type AccountAnnouncementNotice = {
  id: string; severity: 'info' | 'warning' | 'maintenance'
  title: LocalizedText; body: LocalizedText; startsAt: string | null; endsAt: string | null
}

export const ACCOUNT_ANNOUNCEMENT_SEVERITY_LABELS: Readonly<Record<AccountAnnouncementNotice['severity'], string>> = {
  info: msgid('Notice'), warning: msgid('Warning'), maintenance: msgid('Maintenance'),
}

/** Shared by the banner and the WHM preview so both show the same notice. */
export const ACCOUNT_ANNOUNCEMENT_STYLES = `<style>.xp-account-announcements{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-account-announcements[hidden],.xp-account-announcements [hidden]{display:none}.xp-account-announcements__list{display:flex;flex-direction:column;gap:16px;min-inline-size:0}.xp-account-announcement{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px;border:1px solid var(--xp-accent-border,#c7d7f8);border-inline-start-width:4px;border-radius:8px;background:var(--xp-accent-soft,#e8effd);color:var(--xp-text-primary,#101828);text-align:start;min-inline-size:0}.xp-account-announcement[data-severity=warning]{border-color:var(--xp-status-warn-border,#fedf89);background:var(--xp-status-warn-bg,#fffaeb)}.xp-account-announcement[data-severity=maintenance]{border-color:var(--xp-status-reconciling-border,#d9d6fe);background:var(--xp-status-reconciling-bg,#f4f3ff)}.xp-account-announcement__text{display:flex;flex-direction:column;gap:8px;flex:1 1 240px;min-inline-size:0}.xp-account-announcement p{margin:0;overflow-wrap:anywhere}.xp-account-announcement__title{font-weight:600;line-height:1.6}.xp-account-announcement__severity{display:inline-block;margin-inline-end:8px;padding:0 8px;border-radius:999px;background:var(--xp-bg-surface,#fff);font-size:12px;line-height:22px}.xp-account-announcement__body{white-space:pre-line;line-height:1.7}.xp-account-announcement>.xp-btn{flex:none;min-block-size:44px}@media(min-width:801px){.xp-account-announcement{padding:24px}}</style>`

/** Server-rendered notice; buildAccountAnnouncementNotice (account-announcements-banner-client.ts) builds the same markup in the browser. */
export function renderAccountAnnouncementNotice(notice: AccountAnnouncementNotice, locale: Locale, dismissible: boolean): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(locale)(message, values))
  const title = localizedText(notice.title, locale)
  const until = notice.endsAt ? `<p class="xp-help">${t('Until {end}').split('{end}').join(`<bdi dir="ltr">${escapeHtml(formatDisplayDateTime(notice.endsAt))}</bdi>`)}</p>` : ''
  const dismiss = dismissible ? `<button class="xp-btn" type="button" data-account-announcement-dismiss="${escapeHtml(notice.id)}" aria-label="${t('Dismiss announcement: {title}', { title })}">${t('Dismiss')}</button>` : ''
  return `<div class="xp-account-announcement" data-account-announcement="${escapeHtml(notice.id)}" data-severity="${notice.severity}" role="status"><div class="xp-account-announcement__text"><p class="xp-account-announcement__title"><span class="xp-account-announcement__severity">${t(ACCOUNT_ANNOUNCEMENT_SEVERITY_LABELS[notice.severity])}</span><span>${escapeHtml(title)}</span></p><p class="xp-account-announcement__body">${escapeHtml(localizedText(notice.body, locale))}</p>${until}</div>${dismiss}</div>`
}

/** xPanel home banner: live announcements for this account, hidden when there are none. The client binding reads and repaints it. */
export function renderAccountAnnouncementsBanner(input: { locale: Locale; announcements: readonly AccountAnnouncementNotice[] }): string {
  return `${ACCOUNT_ANNOUNCEMENT_STYLES}<section class="xp-account-announcements" data-account-announcements data-state="unread" lang="${input.locale}" dir="${localeDirection(input.locale)}" aria-label="${escapeHtml(translator(input.locale)('Announcements'))}"${input.announcements.length ? '' : ' hidden'}><div class="xp-account-announcements__list" data-account-announcements-list>${input.announcements.map(notice => renderAccountAnnouncementNotice(notice, input.locale, true)).join('')}</div><p class="xp-help" data-account-announcements-status role="status" hidden></p></section>`
}
