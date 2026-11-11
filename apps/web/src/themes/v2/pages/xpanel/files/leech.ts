import type { Translate } from '../../../../../i18n.ts'
import { card } from '../../../components/card.ts'
import { formField, switchRow } from '../../../components/form-field.ts'
import { escapeHtml, hookAttrs } from '../../../html.ts'

const technical = (slot: string): string => `<bdi dir="ltr" class="v2-mono" data-xp-slot="${slot}"></bdi>`
const stack = (body: string): string => `<td><div class="v2-leech-stack">${body}</div></td>`
/** Theme-owned records the leech protection controller fills. */
export const v2LeechTemplates = (): string => `<template data-xp-template="leech-row"><tr>${stack(technical('path') + '<span data-xp-slot="limit"></span>' + technical('redirect'))}${stack('<span data-xp-slot="state"></span><span data-xp-slot="flagged"></span><span data-xp-slot="disabled"></span>')}<td><div class="v2-file-actions"><button type="button" class="v2-btn" data-xp-action="edit" disabled><span data-xp-slot="edit-label"></span></button><button type="button" class="v2-btn" data-xp-action="remove" disabled><span data-xp-slot="remove-label"></span></button></div></td></tr></template><template data-xp-template="leech-empty"><tr><td colspan="3" data-xp-slot="message"></td></tr></template>`

/** Leech Protection on /files/directory-privacy: a login limit for each protected folder (cPanel Leech Protect). */
export function renderV2LeechSection(t: Translate, input: { username: string; canManage: boolean }): string {
  const heading = t(msgid('Leech protection')), heads = [t(msgid('Folder')), t(msgid('State')), t(msgid('Actions'))]
  const fields = [
    formField({ id: 'v2-lp-folder', label: t(msgid('Protected folder')), control: { kind: 'select', dir: 'ltr', disabled: true, options: [], hooks: { 'data-lp-folder': true } } }),
    formField({ id: 'v2-lp-max', label: t(msgid('Logins per user in two hours')), control: { kind: 'input', type: 'number', dir: 'ltr', value: '4', min: 1, max: 1000, step: 1, disabled: true, hooks: { 'data-lp-max': true } } }),
    formField({ id: 'v2-lp-url', label: t(msgid('Redirect URL')), control: { kind: 'input', type: 'url', mono: true, dir: 'ltr', maxlength: 2048, spellcheck: false, autocomplete: 'off', disabled: true, hooks: { 'data-lp-url': true } } }),
    formField({ id: 'v2-lp-email', label: t(msgid('Alert email (optional)')), control: { kind: 'input', type: 'email', mono: true, dir: 'ltr', maxlength: 254, spellcheck: false, autocomplete: 'off', disabled: true, hooks: { 'data-lp-email': true } } }),
  ].join('')
  const disable = switchRow({ id: 'v2-lp-disable', label: t(msgid('Disable users who pass the limit')), disabled: true, hooks: { 'data-lp-disable': true } })
  const table = `<div class="v2-table-scroll" role="region" tabindex="0" aria-labelledby="v2-lp-list-heading"><table class="v2-table"><thead><tr>${heads.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody data-lp-rows><tr><td colspan="3"><p role="status">${escapeHtml(t(msgid('Not read.')))}</p></td></tr></tbody></table></div>`
  const limits = `<ul>${[msgid('Each different address of a user counts once within two hours. Refused sign-ins do not count.'), msgid('The server reads the sign-in log once a minute, so the redirect starts within about a minute after the limit is passed.'), msgid('A disabled user signs in again after you set a new password for that user in the list above.')].map(line => `<li>${escapeHtml(t(line))}</li>`).join('')}</ul>`
  const body = `<p class="v2-muted">${escapeHtml(t(msgid('Stops one password from being shared: a user who signs in from more addresses than allowed within two hours is redirected, and can be disabled.')))}</p><div class="v2-file-fields">${fields}</div>${disable}<p class="v2-field__error" data-lp-error hidden></p><p role="status" data-state="unread" data-lp-status>${escapeHtml(t(msgid('The login limits have not been read.')))}</p>${limits}`
  const buttons = `<button type="button" class="v2-btn v2-btn--primary" data-lp-save disabled>${escapeHtml(t(msgid('Save')))}</button><button type="button" class="v2-btn" data-lp-refresh disabled>${escapeHtml(t(msgid('Read login limits')))}</button>`
  const form = card({ title: heading, titleId: 'v2-lp-heading', bodyHtml: body, footerHtml: buttons })
  const list = card({ title: t(msgid('Login limits')), titleId: 'v2-lp-list-heading', flush: true, bodyHtml: table })
  return `<div class="v2-files"${hookAttrs({ 'data-leech-protection': true, 'data-lp-username': input.username, 'data-lp-manage': String(input.canManage) })}>${form}${list}${v2LeechTemplates()}</div>`
}
