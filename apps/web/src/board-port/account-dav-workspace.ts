import { DAV_CLIENT_GUIDES, WEB_DISK_CLIENT_GUIDES, type DavClientGuide } from '../models/dav-client-guide.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

type T = (message: string, values?: MessageValues) => string
const translate = (locale: Locale): T => (message, values) => translator(locale)(message, values)

const guides = (t: T, list: readonly DavClientGuide[]): string =>
  `<dl class="xp-acct-tool__facts">${list.map(guide => `<div><dt>${t(guide.name)}</dt><dd><ol>${guide.steps.map(step => `<li>${t(step)}</li>`).join('')}</ol></dd></div>`).join('')}</dl>`

const WEB_DISK_TEMPLATES = '<template data-xp-template="web-disk-login-row"><tr><td><bdi dir="ltr" class="xp-mono" data-xp-slot="login"></bdi><p class="xp-help"><bdi dir="ltr" class="xp-mono" data-xp-slot="directory"></bdi></p></td><td><p data-xp-slot="access"></p><div class="xp-acct-tool__actions" data-xp-slot="actions"></div></td></tr></template><template data-xp-template="web-disk-login-action"><button type="button" class="xp-btn" data-xp-slot="label"></button></template><template data-xp-template="web-disk-address"><li><bdi dir="ltr" class="xp-mono" data-xp-slot="url"></bdi></li></template>'

const DAV_STYLE = '<style>.xp-acct-tool ol{margin:0;padding-inline-start:24px}.xp-acct-tool td>[data-xp-slot=actions]{margin-block-start:8px}.xp-acct-tool__check{display:flex;align-items:center;gap:8px;min-block-size:44px;font-weight:400}.xp-acct-tool__check input{inline-size:auto;min-block-size:0;margin:0}[data-web-disk-cancel][hidden],[data-web-disk-unsecured][hidden],[data-dav-unsecured][hidden]{display:none}</style>'

const principalTemplate = (t: T): string => {
  const fact = (label: string, slot: string): string => `<div><dt>${label}</dt><dd><bdi dir="ltr" class="xp-mono" data-xp-slot="${slot}"></bdi></dd></div>`
  return `<template data-xp-template="dav-principal-row"><tr><td><dl class="xp-acct-tool__facts">${fact(t('Login'), 'login')}${fact(t('Server'), 'server')}${fact(t('Principal'), 'principal')}${fact(t('Calendar'), 'calendar')}${fact(t('Address book'), 'address-book')}</dl><div class="xp-acct-tool__actions"><a class="xp-btn" download="calendars-contacts.mobileconfig" data-xp-slot="profile">${t('Download the device profile')}</a></div></td></tr></template>`
}

/** The Web Disk logins of the account, their addresses and client setup. Users are the User Manager's service users. */
export function renderAccountWebDiskWorkspace(input: { lang: Locale; accountId: string; home: string; canManage: boolean }): string {
  const t = translate(input.lang), off = input.canManage ? '' : ' disabled', notRead = t('Web Disk logins have not been read.')
  return `<div class="xp-acct-tool" data-account-web-disk data-account="${escapeHtml(input.accountId)}" data-web-disk-manage="${input.canManage}" data-web-disk-home="${escapeHtml(input.home)}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${WEB_DISK_TEMPLATES}${ACCOUNT_TOOL_STYLE}${DAV_STYLE}
    <section class="xp-acct-tool__card" aria-labelledby="web-disk-logins"><h2 id="web-disk-logins">${t('Web Disk logins')}</h2>
      <div class="xp-acct-tool__table" tabindex="0" role="region" aria-label="${t('Web Disk logins')}"><table class="xp-table"><thead><tr>${[t('Login'), t('Access')].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-web-disk-rows><tr><td colspan="2">${notRead}</td></tr></tbody></table></div>
      <p data-web-disk-status role="status" data-state="unread">${notRead}</p>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-web-disk-refresh${off}>${t('Read logins')}</button></div></section>
    <section class="xp-acct-tool__card" aria-labelledby="web-disk-form"><h2 id="web-disk-form" data-web-disk-form-title>${t('Add a Web Disk login')}</h2>
      <div class="xp-acct-tool__fields">
        <div class="xp-field"><label for="web-disk-local">${t('Username')}</label><input id="web-disk-local" class="xp-input" dir="ltr" autocomplete="off" spellcheck="false" maxlength="64" data-web-disk-local disabled></div>
        <div class="xp-field"><label for="web-disk-domain">${t('Domain')}</label><select id="web-disk-domain" class="xp-select" dir="ltr" data-web-disk-domain disabled></select></div>
        <div class="xp-field"><label for="web-disk-password">${t('Password')}</label><input id="web-disk-password" class="xp-input" type="password" dir="ltr" autocomplete="new-password" aria-describedby="web-disk-password-help" data-web-disk-password disabled><p class="xp-help" id="web-disk-password-help">${t('At least 8 characters. Leave it empty while changing a login to keep the current password.')}</p></div>
        <div class="xp-field"><label for="web-disk-directory">${t('Directory')}</label><input id="web-disk-directory" class="xp-input" dir="ltr" autocomplete="off" spellcheck="false" maxlength="240" value="public_html" aria-describedby="web-disk-directory-help" data-web-disk-directory disabled><p class="xp-help" id="web-disk-directory-help">${t('Relative to {home}. It is created if it does not exist and may not contain blanks. FTP uses the same directory for this login.', { home: escapeHtml(input.home) })}</p></div>
      </div>
      <label class="xp-acct-tool__check"><input type="checkbox" data-web-disk-read-only disabled><span>${t('Read only')}</span></label>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn xp-btn--primary" data-web-disk-save disabled>${t('Add login')}</button><button type="button" class="xp-btn" data-web-disk-cancel hidden disabled>${t('Cancel')}</button></div></section>
    <section class="xp-acct-tool__card" aria-labelledby="web-disk-connect"><h2 id="web-disk-connect">${t('Connection settings')}</h2>
      <dl class="xp-acct-tool__facts"><div><dt>${t('Web Disk address')}</dt><dd><ul data-web-disk-addresses></ul></dd></div><div><dt>${t('Sign-in')}</dt><dd>${t('The login and its password. The main login uses the account password.')}</dd></div><div><dt>${t('Encryption')}</dt><dd>${t('HTTPS only. Plain HTTP is not offered.')}</dd></div><div><dt>${t('Storage')}</dt><dd>${t('Files count toward the account disk quota.')}</dd></div></dl>
      <p class="xp-help" data-web-disk-unsecured hidden></p>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-web-disk-download disabled>${t('Download connection settings')}</button></div></section>
    <section class="xp-acct-tool__card" aria-labelledby="web-disk-clients"><h2 id="web-disk-clients">${t('Set up a client')}</h2>${guides(t, WEB_DISK_CLIENT_GUIDES)}</section>
    <section class="xp-acct-tool__card" aria-labelledby="web-disk-users"><h2 id="web-disk-users">${t('How service users work')}</h2><p>${t('Email, FTP and Web Disk credentials are separate from account control-panel access.')}</p>
      <div class="xp-acct-tool__actions"><a class="xp-btn" href="/email/accounts">${t('Open email and users')}</a></div></section>
  </div>`
}

/** Server, principal and collection URLs for devices: every login of the account, or only the signed-in mailbox in xMail. */
export function renderDavConnectionWorkspace(input: { locale: Locale; accountId?: string; mailbox?: string; canRead: boolean }): string {
  const t = translate(input.locale), notRead = t('Device connection details have not been read.')
  return `<div class="xp-acct-tool" data-dav-connection${input.accountId === undefined ? '' : ` data-account="${escapeHtml(input.accountId)}"`}${input.mailbox === undefined ? '' : ` data-dav-mailbox="${escapeHtml(input.mailbox)}"`} data-dav-enabled="${input.canRead}">${principalTemplate(t)}${ACCOUNT_TOOL_STYLE}${DAV_STYLE}
    <p data-dav-status role="status" data-state="unread">${notRead}</p>
    <div class="xp-acct-tool__table" tabindex="0" role="region" aria-label="${t('Device connection')}"><table class="xp-table"><thead><tr><th scope="col">${t('Connection')}</th></tr></thead><tbody data-dav-rows><tr><td>${notRead}</td></tr></tbody></table></div>
    <p class="xp-help" data-dav-unsecured hidden></p>
    <dl class="xp-acct-tool__facts"><div><dt>${t('Sign-in')}</dt><dd>${t('The full mailbox address and its password, or the account username and password.')}</dd></div><div><dt>${t('Encryption')}</dt><dd>${t('HTTPS only. Devices must trust the certificate of the domain.')}</dd></div><div><dt>${t('Storage')}</dt><dd>${t('Device calendars and contacts count toward the account disk quota. Two-factor sign-in does not apply to them.')}</dd></div><div><dt>${t('Device profile')}</dt><dd>${t('Holds the server and the login, never a password. The device asks for the password when you install it.')}</dd></div></dl>
    <p class="xp-help">${t('Calendars and contacts in xMail are the ones devices sync on this server.')}</p>
    <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-dav-refresh${input.canRead ? '' : ' disabled'}>${t('Read connection details')}</button></div>
    ${guides(t, DAV_CLIENT_GUIDES)}
  </div>`
}
