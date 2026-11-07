import { translator } from '../i18n.ts'
import type { Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { renderClassicModerationQueue } from './list-moderation-section.ts'

const gate = (connected: boolean) => connected ? '' : ' data-capability-unavailable="true"'
const off = (connected: boolean) => connected ? '' : ' disabled'

/** Classic xPanel: the owner sets a list's administrator password without the old one. */
export function renderClassicListPasswordSection(locale: Locale, connected: boolean): string {
  const t = (message: string) => escapeHtml(translator(locale)(message))
  return `<div class="xp-mailing-lists__form" data-list-password${gate(connected)} role="group" aria-labelledby="mailing-list-password-heading"><h3 id="mailing-list-password-heading">${t(msgid('List administrator password'))}</h3>`
    + `<div class="xp-mailing-lists__fields"><div class="xp-field"><label for="mailing-list-password-list">${t(msgid('List'))}</label><select id="mailing-list-password-list" class="xp-select xp-mono" dir="ltr" data-list-password-list${off(connected)}></select></div>`
    + `<div class="xp-field"><label for="mailing-list-password-input">${t(msgid('New password (minimum 8 characters)'))}</label><input id="mailing-list-password-input" class="xp-input" type="password" dir="ltr" autocomplete="new-password" data-list-password-input${off(connected)}></div></div>`
    + `<p class="xp-help">${t(msgid('Whoever holds the list password can add and remove members from webmail. A new password replaces the old one.'))}</p><p class="xp-help" data-list-admin-status role="status"></p>`
    + `<div class="xp-mailing-lists__actions"><button type="button" class="xp-btn" data-list-password-save${off(connected)}>${t(msgid('Save list password'))}</button></div></div>`
}

/** Classic xMail List administration card: members of one list, unlocked by its administrator password. */
export function renderClassicListAdminSection(locale: Locale, connected: boolean): string {
  const t = (message: string) => escapeHtml(translator(locale)(message))
  return `<section class="xp-card xp-mail-tools__card" aria-labelledby="mail-lists-admin-heading" data-list-admin${gate(connected)}><h2 id="mail-lists-admin-heading">${t(msgid('List administration'))}</h2>`
    + `<p class="xp-help">${t(msgid('Enter the list address and its administrator password to manage its members or work its moderation queue. A moderator mailbox opens the queue with an empty password. Archives and storage measurements are unavailable here.'))}</p>`
    + `<div class="xp-mail-tools__actions"><div class="xp-field"><label for="mail-list-admin-address">${t(msgid('List address'))}</label><input id="mail-list-admin-address" class="xp-input" dir="ltr" autocomplete="off" data-list-admin-address${off(connected)}></div>`
    + `<div class="xp-field"><label for="mail-list-admin-password">${t(msgid('List password'))}</label><input id="mail-list-admin-password" class="xp-input" type="password" dir="ltr" autocomplete="current-password" data-list-admin-password${off(connected)}></div></div>`
    + `<div class="xp-mail-tools__actions"><button type="button" class="xp-btn" data-list-admin-open${off(connected)}>${t(msgid('Open administration'))}</button><button type="button" class="xp-btn" data-moderation-open disabled>${t(msgid('Moderation queue'))}</button></div>`
    + `<p class="xp-help" data-list-admin-status role="status"></p><div class="xp-mail-tools__table" role="region" tabindex="0" aria-label="${t(msgid('List members'))}"><table class="xp-table"><thead><tr><th scope="col">${t(msgid('Member'))}</th><th scope="col">${t(msgid('Actions'))}</th></tr></thead><tbody data-list-admin-members></tbody></table></div>`
    + `<div class="xp-mail-tools__actions"><div class="xp-field"><label for="mail-list-admin-member">${t(msgid('New member'))}</label><input id="mail-list-admin-member" class="xp-input" dir="ltr" autocomplete="off" data-list-admin-member${off(connected)}></div><button type="button" class="xp-btn" data-list-admin-add disabled>${t(msgid('Add member'))}</button></div>`
    + `<template data-xp-template="list-admin-member"><tr><td><bdi dir="ltr" data-xp-slot="address"></bdi></td><td><button type="button" class="xp-btn" data-xp-slot="action" disabled></button></td></tr></template>${renderClassicModerationQueue(locale)}</section>`
}

/** Classic xWHM: every list with its password state, the reset form and the list delivery restart. */
export function renderClassicListResetSection(locale: Locale, connected: { reset: boolean; restart: boolean }): string {
  const t = (message: string) => escapeHtml(translator(locale)(message))
  const any = connected.reset || connected.restart
  return `<section class="xp-panel-detail__card" data-workspace-section="mailing-list-admin" data-list-reset${gate(any)}><h2>${t(msgid('Mailing list administration'))}</h2>`
    + `<div class="xp-table-wrap" tabindex="0" role="region" aria-label="${t(msgid('Mailing lists'))}"><table class="xp-table"><thead><tr><th scope="col">${t(msgid('List address'))}</th><th scope="col">${t(msgid('Account'))}</th><th scope="col">${t(msgid('Administrator password'))}</th></tr></thead><tbody data-list-reset-rows></tbody></table></div>`
    + `<div class="xp-panel-detail__fields"><div class="xp-field"><label for="whm-list-reset-list">${t(msgid('List'))}</label><select id="whm-list-reset-list" class="xp-select xp-mono" dir="ltr" data-list-reset-list${off(connected.reset)}></select></div><div class="xp-field"><label for="whm-list-reset-password">${t(msgid('New password (minimum 8 characters)'))}</label><input id="whm-list-reset-password" class="xp-input" type="password" dir="ltr" autocomplete="new-password" data-list-reset-password${off(connected.reset)}></div></div>`
    + `<p class="xp-help" data-list-admin-status role="status"></p><div class="xp-panel-detail__actions"><button type="button" class="xp-btn xp-btn--primary" data-list-reset-save${off(connected.reset)}>${t(msgid('Reset list password'))}</button><button type="button" class="xp-btn" data-list-restart${off(connected.restart)}>${t(msgid('Restart mailing list delivery'))}</button></div>`
    + `<p class="xp-help">${t(msgid('Lists are delivered from the Postfix alias table, so a restart tests the Postfix configuration and restarts Postfix.'))}</p>`
    + `<template data-xp-template="list-reset-row"><tr><td><bdi dir="ltr" data-xp-slot="address"></bdi></td><td><bdi dir="ltr" data-xp-slot="account"></bdi></td><td data-xp-slot="password"></td></tr></template></section>`
}
