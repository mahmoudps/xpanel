import { icon } from '../icons.ts'

/** V2 owns notice identity and layout independently of the Classic banner. */
export function v2AccountAnnouncementNoticeTemplates(): string {
  return (['info', 'warning', 'maintenance'] as const).map(severity => `<template data-xp-template="account-announcement-notice-${severity}"><div class="v2-notice v2-notice--${severity === 'warning' ? 'warn' : 'info'} v2-account-announcement" data-account-announcement="" data-severity="" role="status">${icon(severity === 'warning' ? 'alert' : severity === 'maintenance' ? 'clock' : 'info')}<div class="v2-notice__body v2-account-announcement__text"><p class="v2-account-announcement__title"><span class="v2-account-announcement__severity" data-xp-slot="severity"></span><span data-xp-slot="title"></span></p><p class="v2-account-announcement__body" data-xp-slot="body"></p><p class="v2-muted" data-xp-slot="expiry"><bdi dir="ltr" class="v2-mono" data-xp-slot="end"></bdi></p></div><button class="v2-notice__dismiss" type="button" data-account-announcement-dismiss="" aria-label="" data-xp-slot="dismiss" disabled>${icon('x', 16)}</button></div></template>`).join('')
}

/** Used only by the existing account-announcement preview route. */
export const V2_ACCOUNT_ANNOUNCEMENT_CSS = `:where([data-ui-theme="v2"]) [data-whm-announcements-workspace] .v2-account-announcement{flex-wrap:wrap;gap:var(--space-2);padding:var(--v2-panel-padding);min-inline-size:0}
:where([data-ui-theme="v2"]) [data-whm-announcements-workspace] .v2-account-announcement__text{flex:1 1 200px;gap:var(--space-1);min-inline-size:0}
:where([data-ui-theme="v2"]) [data-whm-announcements-workspace] .v2-account-announcement p{margin:0;overflow-wrap:anywhere}
:where([data-ui-theme="v2"]) [data-whm-announcements-workspace] .v2-account-announcement__title{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--space-1);font-weight:600}
:where([data-ui-theme="v2"]) [data-whm-announcements-workspace] .v2-account-announcement__severity{padding-inline:var(--space-1);border-radius:var(--radius-control);background:var(--surface);font-size:12px}
:where([data-ui-theme="v2"]) [data-whm-announcements-workspace] .v2-account-announcement__body{white-space:pre-line}
:where([data-ui-theme="v2"]) [data-whm-announcements-workspace] .v2-account-announcement .v2-notice__dismiss{inline-size:auto;min-inline-size:var(--target);margin:0;padding-inline:var(--space-1);gap:var(--space-1);color:var(--tone);font:inherit}
:where([data-ui-theme="v2"]) [data-whm-announcements-workspace] .v2-account-announcement .v2-notice__dismiss:disabled{cursor:not-allowed;color:var(--muted)}
`
