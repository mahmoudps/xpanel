import { translator, type Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

/** cPanel User Manager: one login across email, FTP and Web Disk. service-users-client.ts owns the behaviour. */
export function renderServiceUsersManager(input: { locale: Locale; canManage: boolean; owner: string }): string {
  const translate = translator(input.locale), t = (copy: string): string => escapeHtml(translate(copy))
  const field = (id: string, label: string, control: string): string => `<div class="xp-field"><label for="${id}">${t(label)}</label>${control}</div>`
  const check = (hook: string, label: string): string => `<label class="xp-check"><input type="checkbox" ${hook} disabled> ${t(label)}</label>`
  const heads = [msgid('Login'), msgid('Email enabled'), 'FTP', msgid('Web Disk'), msgid('Actions')]
  return `${ACCOUNT_TOOL_STYLE}<div style="min-inline-size:0" data-service-users data-service-users-can-manage="${input.canManage}" data-service-users-owner="${escapeHtml(input.owner)}">
<template data-xp-template="service-user-action"><button type="button" class="xp-btn"><span data-xp-slot="label"></span></button></template>
<p data-service-users-status data-state="unread" role="status">${t(input.canManage ? msgid('Service users have not been read.') : msgid('Service users can only be changed by the account owner.'))}</p>
<div class="xp-acct-tool__table" role="region" tabindex="0" aria-label="${t(msgid('Service users'))}"><table class="xp-table"><thead><tr>${heads.map(head => `<th scope="col">${t(head)}</th>`).join('')}</tr></thead><tbody data-service-users-rows><tr><td colspan="5">${t(msgid('Service users have not been read.'))}</td></tr></tbody></table></div>
<h3>${t(msgid('Add or edit a user'))}</h3><p class="xp-help">${t(msgid('One login for the services you turn on, with the same password. These users cannot sign in to this panel.'))}</p>
<div class="xp-acct-tool__fields">${field('service-user-local', msgid('Username'), '<input id="service-user-local" class="xp-input" dir="ltr" maxlength="64" autocomplete="off" spellcheck="false" data-service-user-local disabled>')}${field('service-user-domain', msgid('Domain'), `<select id="service-user-domain" class="xp-select" dir="ltr" data-service-user-domain disabled><option value="">${t(msgid('Choose a domain'))}</option></select>`)}${field('service-user-password', msgid('Password'), '<input id="service-user-password" class="xp-input" type="password" dir="ltr" autocomplete="new-password" data-service-user-password disabled>')}</div>
<button type="button" class="xp-btn" data-service-user-generate disabled>${t(msgid('Generate password'))}</button>
<div class="xp-acct-tool__fields">${check('data-service-user-email', msgid('Email'))}${field('service-user-quota', msgid('Mailbox quota (MB)'), '<input id="service-user-quota" class="xp-input" type="number" min="1" step="1" dir="ltr" data-service-user-quota disabled>')}${check('data-service-user-ftp', 'FTP')}${check('data-service-user-webdisk', msgid('Web Disk'))}${field('service-user-dir', msgid('FTP and Web Disk folder, relative to home'), '<input id="service-user-dir" class="xp-input" dir="ltr" maxlength="240" autocomplete="off" spellcheck="false" data-service-user-dir disabled>')}${check('data-service-user-readonly', msgid('Web Disk is read-only'))}</div>
<div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-service-user-save disabled>${t(msgid('Create user'))}</button><button type="button" class="xp-btn" data-service-user-cancel hidden disabled>${t(msgid('Cancel'))}</button></div></div>`
}
