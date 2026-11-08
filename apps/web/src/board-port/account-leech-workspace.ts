import { type Locale, type MessageValues, translator } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

const LIMITS = [msgid('Each different address of a user counts once within two hours. Refused sign-ins do not count.'),
  msgid('The server reads the sign-in log once a minute, so the redirect starts within about a minute after the limit is passed.'),
  msgid('A disabled user signs in again after you set a new password for that user in the list above.')] as const
const technical = (slot: string): string => `<bdi dir="ltr" class="xp-mono" data-xp-slot="${slot}"></bdi>`
const stack = (body: string): string => `<td><div style="display:flex;flex-direction:column;align-items:flex-start;gap:8px;min-inline-size:0;overflow-wrap:anywhere">${body}</div></td>`
/** Theme-owned records the leech protection controller fills. */
export const classicLeechTemplates = (): string => `<template data-xp-template="leech-row"><tr>${stack(technical('path') + '<span data-xp-slot="limit"></span>' + technical('redirect'))}${stack('<span data-xp-slot="state"></span><span data-xp-slot="flagged"></span><span data-xp-slot="disabled"></span>')}<td><div class="xp-panel-detail__actions"><button type="button" class="xp-btn" data-xp-action="edit" disabled><span data-xp-slot="edit-label"></span></button><button type="button" class="xp-btn" data-xp-action="remove" disabled><span data-xp-slot="remove-label"></span></button></div></td></tr></template><template data-xp-template="leech-empty"><tr><td colspan="3" data-xp-slot="message"></td></tr></template>`

/** Leech Protection on /files/directory-privacy: a login limit for each protected folder (cPanel Leech Protect). */
export function renderAccountLeechSection(input: { lang: Locale; username: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.lang)(message, values))
  const heads = [t('Folder'), t('State'), t('Actions')]
  return `<section class="xp-panel-detail__card" data-leech-protection data-lp-username="${escapeHtml(input.username)}" data-lp-manage="${input.canManage}" data-workspace-section="leech-protection" aria-labelledby="lp-title"><style>@media(max-width:600px){[data-leech-protection] tr{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}[data-leech-protection] tr>:last-child{grid-column:1/-1}[data-leech-protection] td{height:auto}[data-leech-protection] th:last-child{display:none}}</style><h2 id="lp-title">${t('Leech protection')}</h2>
    <p class="xp-help">${t('Stops one password from being shared: a user who signs in from more addresses than allowed within two hours is redirected, and can be disabled.')}</p>
    <div class="xp-panel-detail__fields"><div class="xp-field"><label for="lp-folder">${t('Protected folder')}</label><select id="lp-folder" class="xp-select" dir="ltr" data-lp-folder disabled></select></div>
    <div class="xp-field"><label for="lp-max">${t('Logins per user in two hours')}</label><input id="lp-max" class="xp-input" dir="ltr" type="number" min="1" max="1000" step="1" value="4" data-lp-max disabled></div>
    <div class="xp-field"><label for="lp-url">${t('Redirect URL')}</label><input id="lp-url" class="xp-input xp-mono" dir="ltr" type="url" maxlength="2048" spellcheck="false" autocomplete="off" data-lp-url disabled></div>
    <div class="xp-field"><label for="lp-email">${t('Alert email (optional)')}</label><input id="lp-email" class="xp-input xp-mono" dir="ltr" type="email" maxlength="254" spellcheck="false" autocomplete="off" data-lp-email disabled></div>
    <label style="display:flex;align-items:center;gap:8px;min-block-size:44px" for="lp-disable"><input id="lp-disable" type="checkbox" data-lp-disable disabled><span>${t('Disable users who pass the limit')}</span></label></div>
    <p class="xp-help" data-lp-error hidden></p>
    <div class="xp-panel-detail__actions"><button type="button" class="xp-btn xp-btn--primary" data-lp-save disabled>${t('Save')}</button><button type="button" class="xp-btn" data-lp-refresh disabled>${t('Read login limits')}</button></div>
    <p class="xp-help" data-lp-status role="status" data-state="unread">${t('The login limits have not been read.')}</p>
    <div class="xp-table-wrap" tabindex="0" role="region" aria-labelledby="lp-title"><table class="xp-table"><thead><tr>${heads.map(head => `<th scope="col">${head}</th>`).join('')}</tr></thead><tbody data-lp-rows><tr><td colspan="3">${t('Not read.')}</td></tr></tbody></table></div>
    <ul>${LIMITS.map(line => `<li>${t(line)}</li>`).join('')}</ul>
    ${classicLeechTemplates()}</section>`
}
