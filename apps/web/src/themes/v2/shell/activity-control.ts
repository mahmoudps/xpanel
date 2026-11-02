import { msgctxt } from '@xpanel/core'
import type { Translate } from '../../../i18n.ts'
import { activateAssembledActivityControl } from '../../../models/theme-surface.ts'
import { escapeHtml } from '../html.ts'
import { icon } from '../icons.ts'

export function activityControl(t: Translate, props: { available: boolean; unread?: number }): string {
  const unread = props.available && Number.isSafeInteger(props.unread) && props.unread! >= 0 ? props.unread : undefined
  const label = unread === undefined ? t('Activity & Jobs')
    : t(msgctxt('theme:v2', '{count, plural, =0 {Notifications, none unread} one {Notifications, # unread} other {Notifications, # unread}}'), { count: unread })
  const admission = props.available
    ? ' data-action="open-activity-drawer" aria-controls="xp-activity-drawer"'
    : ` disabled aria-disabled="true" title="${escapeHtml(t('Unavailable'))}"`
  return `<button type="button" class="v2-btn v2-btn--icon v2-top__bell" data-xp-activity-control="${props.available ? 'available' : 'unavailable'}"${admission} aria-label="${escapeHtml(label)}">${icon('bell')}${unread !== undefined && unread > 0 ? `<span class="v2-top__badge v2-num" aria-hidden="true">${unread > 99 ? '99+' : unread}</span>` : ''}</button>`
}

export function assembleActivityControl(t: Translate, documentHtml: string, activityHtml: string): string {
  return activateAssembledActivityControl({ documentHtml, activityHtml,
    placeholderHtml: activityControl(t, { available: false }), availableHtml: activityControl(t, { available: true }) })
}
