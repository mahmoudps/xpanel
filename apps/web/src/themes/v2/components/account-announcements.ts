import { localeDirection, type Translate } from '../../../i18n.ts'
import { escapeHtml } from '../html.ts'
import { v2AccountAnnouncementNoticeTemplates, V2_ACCOUNT_ANNOUNCEMENT_CSS } from './account-announcement-notice-templates.ts'

/** Core supplies read authority. The existing authenticated client supplies all notice facts. */
export function renderV2AccountAnnouncementsBanner(t: Translate, canRead: boolean): string {
  return `<section class="v2-account-announcements" data-account-announcements data-state="${canRead ? 'unread' : 'unavailable'}"${canRead ? ' hidden' : ' data-readonly="true"'} lang="${t.locale}" dir="${localeDirection(t.locale)}" aria-label="${escapeHtml(t('Announcements'))}">${v2AccountAnnouncementNoticeTemplates()}<div class="v2-account-announcements__list" data-account-announcements-list></div><p class="v2-muted" data-account-announcements-status role="status"${canRead ? ' hidden' : ''}>${canRead ? '' : escapeHtml(t('Announcements are unavailable here. Nothing was read or changed.'))}</p></section>`
}

export const V2_HOME_ANNOUNCEMENTS_CSS = V2_ACCOUNT_ANNOUNCEMENT_CSS.replaceAll('[data-whm-announcements-workspace]', '.v2-panel-home [data-account-announcements]') + `
.v2-panel-home [data-account-announcements]{display:flex;flex-direction:column;gap:var(--space-2);min-inline-size:0}
.v2-panel-home [data-account-announcements][hidden],.v2-panel-home [data-account-announcements] [hidden],.v2-panel-home .v2-account-announcements__list:empty{display:none}
.v2-panel-home .v2-account-announcements__list{display:flex;flex-direction:column;gap:var(--space-2);min-inline-size:0}
.v2-panel-home [data-account-announcements-status]{margin:0;overflow-wrap:anywhere}
.v2-panel-home [data-account-announcements][data-state=failed]>[data-account-announcements-status],.v2-panel-home [data-account-announcements][data-state=unavailable]>[data-account-announcements-status]{padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-card);background:var(--subtle);color:var(--text)}
`