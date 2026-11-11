import { DAV_CLIENT_GUIDES, type DavClientGuide } from '../../../../../models/dav-client-guide.ts'
import type { Translate } from '../../../../../i18n.ts'
import { escapeHtml as esc } from '../../../html.ts'

/** The V2 clone shapes of the shared Web Disk and device connection controller. */
export const V2_WEB_DISK_TEMPLATES = '<template data-xp-template="web-disk-login-row"><tr><td><bdi dir="ltr" class="v2-mono" data-xp-slot="login"></bdi><p class="v2-muted"><bdi dir="ltr" class="v2-mono" data-xp-slot="directory"></bdi></p></td><td><div class="v2-panel-settings__actions"><span data-xp-slot="access"></span><span class="v2-panel-settings__actions" data-xp-slot="actions"></span></div></td></tr></template><template data-xp-template="web-disk-login-action"><button type="button" class="v2-btn" data-xp-slot="label"></button></template><template data-xp-template="web-disk-address"><li><bdi dir="ltr" class="v2-mono" data-xp-slot="url"></bdi></li></template>'

const principalTemplate = (t: Translate, factsClass: string, actionsClass: string): string => {
  const fact = (label: string, slot: string): string => `<div><dt>${esc(label)}</dt><dd><bdi dir="ltr" class="v2-mono" data-xp-slot="${slot}"></bdi></dd></div>`
  return `<template data-xp-template="dav-principal-row"><tr><td><dl class="${factsClass} v2-dav-principal">${fact(t(msgid('Login')), 'login')}${fact(t(msgid('Server')), 'server')}${fact(t(msgid('Principal')), 'principal')}${fact(t(msgid('Calendar')), 'calendar')}${fact(t(msgid('Address book')), 'address-book')}</dl><div class="${actionsClass}"><a class="v2-btn" download="calendars-contacts.mobileconfig" data-xp-slot="profile">${esc(t(msgid('Download the device profile')))}</a></div></td></tr></template>`
}

// A flex row, so a guide left alone on the last row takes the whole row instead of one column.
export const v2DavGuide = (t: Translate, guides: readonly DavClientGuide[], factsClass: string): string =>
  `<dl class="${factsClass} v2-dav-guide">${guides.map(guide => `<div><dt>${esc(t(guide.name))}</dt><dd><ol>${guide.steps.map(step => `<li>${esc(t(step))}</li>`).join('')}</ol></dd></div>`).join('')}</dl>`

export interface V2DavConnectionInput {
  t: Translate
  /** the facts grid class of the surrounding page styles */
  factsClass: string
  actionsClass: string
  accountId?: string
  mailbox?: string
  canRead: boolean
  /** the surrounding page's table, its body carrying data-dav-rows */
  table: (columns: readonly string[], bodyHtml: string) => string
}

/** Server, principal and collection URLs for devices: every login of the account, or only the signed-in mailbox in xMail. */
export function v2DavConnection(input: V2DavConnectionInput): string {
  const { t, factsClass } = input, notRead = t(msgid('Device connection details have not been read.'))
  const fact = (label: string, value: string): string => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`
  return `<div class="v2-card__body" data-dav-connection${input.accountId === undefined ? '' : ` data-account="${esc(input.accountId)}"`}${input.mailbox === undefined ? '' : ` data-dav-mailbox="${esc(input.mailbox)}"`} data-dav-enabled="${input.canRead}">${principalTemplate(t, factsClass, input.actionsClass)}<p data-dav-status role="status" data-state="unread">${esc(notRead)}</p>`
    + input.table([t(msgid('Connection'))], `<tr><td>${esc(notRead)}</td></tr>`)
    + `<p class="v2-muted" data-dav-unsecured hidden></p><dl class="${factsClass}">${fact(t(msgid('Sign-in')), t(msgid('The full mailbox address and its password, or the account username and password.')))}${fact(t(msgid('Encryption')), t(msgid('HTTPS only. Devices must trust the certificate of the domain.')))}${fact(t(msgid('Storage')), t(msgid('Device calendars and contacts count toward the account disk quota. Two-factor sign-in does not apply to them.')))}${fact(t(msgid('Device profile')), t(msgid('Holds the server and the login, never a password. The device asks for the password when you install it.')))}</dl>`
    + `<p class="v2-muted">${esc(t(msgid('Calendars and contacts in xMail are the ones devices sync on this server.')))}</p>`
    + `<div class="${input.actionsClass}"><button type="button" class="v2-btn" data-dav-refresh${input.canRead ? '' : ' disabled'}>${esc(t(msgid('Read connection details')))}</button></div>`
    + v2DavGuide(t, DAV_CLIENT_GUIDES, factsClass) + '</div>'
}
