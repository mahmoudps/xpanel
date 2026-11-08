import type { Translate } from '../../../../../i18n.ts'
import { card } from '../../../components/index.ts'
import { actions, button, esc, field, fields, status, table, toolCard } from '../account-tools/common.ts'

/** A session that cannot save keeps the layout and gets no native form, like every other administrator workspace. */
const formless = (editable: boolean, html: string): string => editable ? html : html.replace(/<form\b([^>]*) novalidate>/g, '<div$1>').replaceAll('</form>', '</div>')
const technical = (slot: string): string => `<bdi dir="ltr" class="v2-mono" data-xp-slot="${slot}"></bdi>`

/** WHM Force Password Change: rows are painted by WHM_ACCOUNT_ADMIN_CLIENT_BINDING. */
export function renderV2ForcePassword(t: Translate, editable: boolean): string {
  const row = `<template data-xp-template="force-password-row"><tr><td><label class="v2-account-tool__choice"><input type="checkbox" data-xp-slot="forced"${editable ? '' : ' disabled'}>${technical('username')}</label></td><td>${technical('domain')}</td><td data-xp-slot="state"></td></tr></template>`
  return toolCard('force-password', t(msgid('Force password change')), `<p>${esc(t(msgid('A selected user is signed out and can only change the password at the next sign-in. The mark stays until the password has been changed.')))}</p>${row}`
    + table(t(msgid('Force password change')), [t(msgid('Account')), t(msgid('Domain')), t(msgid('Status'))], { 'data-force-password-rows': true }, t(msgid('Accounts have not been read.')))
    + actions(button(t(msgid('Select all')), { 'data-force-password-all': true }, editable) + button(t(msgid('Clear all')), { 'data-force-password-none': true }, editable) + button(t(msgid('Save')), { 'data-force-password-save': true }, editable, true))
    + status(t(msgid('Accounts have not been read.')), { 'data-force-password-status': true }),
  { 'data-whm-force-password': true, 'data-account-admin-editable': String(editable) })
}

/** WHM Rearrange an Account: the destination comes from the home roots this server reports. */
export function renderV2Rearrange(t: Translate, editable: boolean): string {
  const off = editable ? '' : ' disabled'
  const select = (id: string, name: string, label: string, first: string): string => field(id, label, `<select id="${id}" name="${name}" dir="ltr"${off}><option value="">${esc(first)}</option></select>`)
  return formless(editable, toolCard('rearrange', t(msgid('Rearrange an account')), `<p>${esc(t(msgid('Moves an account to another home root, on the same disk or another one. The account stops serving while its files move, and every copied file is compared before the old directory is removed.')))}</p>`
    + `<form data-rearrange-form novalidate>${fields(select('v2-rearrange-account', 'account', t(msgid('Account')), t(msgid('Select an account'))) + select('v2-rearrange-root', 'root', t(msgid('Home root')), t(msgid('Select a home root'))))}`
    + `<label class="v2-account-tool__choice"><input type="checkbox" name="acknowledge"${off}><span>${esc(t(msgid('Scripts with the old home path written in them will break.')))}</span></label>`
    + actions(`<button type="submit" class="v2-btn v2-btn--primary" data-rearrange-submit${off}>${esc(t(msgid('Move account')))}</button><button type="button" class="v2-btn" data-rearrange-recover hidden${off}>${esc(t(msgid('Settle an interrupted move')))}</button>`) + '</form>'
    + status(t(msgid('Accounts have not been read.')), { 'data-rearrange-status': true }),
  { 'data-whm-rearrange': true, 'data-account-admin-editable': String(editable) }))
}

/** WHM Manage Shell Access: one choice per account and a bulk action; the package value stays visible. */
export function renderV2ShellAccess(t: Translate, editable: boolean): string {
  const row = `<template data-xp-template="shell-access-row"><tr><td>${technical('username')}</td><td><select data-xp-slot="shell"${editable ? '' : ' disabled'}><option value="jailed">${esc(t(msgid('Jailed')))}</option><option value="none">${esc(t(msgid('Disabled')))}</option></select></td><td data-xp-slot="source"></td></tr></template>`
  return toolCard('shell-access', t(msgid('Manage shell access')), `<p>${esc(t(msgid('Jailed gives a confined shell. Disabled blocks shell sign-in and also stops SFTP. Normal shells are not offered, because they would leave the account confinement.')))}</p>${row}`
    + table(t(msgid('Manage shell access')), [t(msgid('Account')), t(msgid('Shell')), t(msgid('Source'))], { 'data-shell-rows': true }, t(msgid('Accounts have not been read.')))
    + actions(button(t(msgid('Jail all accounts')), { 'data-shell-all': 'jailed' }, editable) + button(t(msgid('Disable all accounts')), { 'data-shell-all': 'none' }, editable))
    + status(t(msgid('Accounts have not been read.')), { 'data-shell-status': true }),
  { 'data-whm-shell-access': true, 'data-account-admin-editable': String(editable) })
}

/** WHM Email All Users: the first step reviews recipients, only the second sends. */
export function renderV2EmailUsers(t: Translate, editable: boolean): string {
  const off = editable ? '' : ' disabled'
  const input = (id: string, name: string, label: string, attrs: string): string => field(id, label, `<input id="${id}" name="${name}" autocomplete="off" ${attrs}${off}>`)
  return formless(editable, toolCard('email-users', t(msgid('Email all users')), `<p>${esc(t(msgid('One message per account contact address, through the local mail server. Review comes first; nothing is sent until you confirm it.')))}</p>`
    + `<form data-email-users-form novalidate>${fields(input('v2-email-users-name', 'fromName', t(msgid('Sender name')), 'dir="auto" maxlength="80"') + input('v2-email-users-address', 'fromAddress', t(msgid('Sender email')), 'type="email" dir="ltr" maxlength="254"') + input('v2-email-users-subject', 'subject', t(msgid('Subject')), 'dir="auto" maxlength="200"'))}`
    + field('v2-email-users-body', t(msgid('Message')), `<textarea id="v2-email-users-body" name="body" rows="6" dir="auto" maxlength="20000"${off}></textarea>`)
    + `<label class="v2-account-tool__choice"><input type="checkbox" name="includeResellerCustomers"${off}><span>${esc(t(msgid("Include resellers' customers")))}</span></label>`
    + actions(`<button type="submit" class="v2-btn" data-email-users-review${off}>${esc(t(msgid('Review recipients')))}</button>` + button(t(msgid('Send')), { 'data-email-users-send': true }, false, true)) + '</form>'
    + status(t(msgid('Nothing has been reviewed yet.')), { 'data-email-users-status': true }) + '<ul data-email-users-recipients hidden></ul>',
  { 'data-whm-email-users': true, 'data-account-admin-editable': String(editable) }))
}

/** A reseller's view of Account Enhancements: what root gave it, assigned per account. */
export function renderV2EnhancementAssign(t: Translate, editable: boolean): string {
  const off = editable ? '' : ' disabled'
  const select = (id: string, name: string, label: string, first: string): string => field(id, label, `<select id="${id}" name="${name}" dir="ltr"${off}><option value="">${esc(first)}</option></select>`)
  return formless(editable, toolCard('assign-enhancements', t(msgid('Assign enhancements')), `<p>${esc(t(msgid('Root sets which enhancements you may assign and how many.')))}</p>`
    + `<form data-enh-assign-form novalidate>${fields(select('v2-enh-account', 'account', t(msgid('Account')), t(msgid('Select an account'))) + select('v2-enh-enhancement', 'enhancement', t(msgid('Enhancement')), t(msgid('Select an enhancement'))) + field('v2-enh-value', t(msgid('Value')), `<input id="v2-enh-value" name="value" type="number" dir="ltr" min="0"${off}>`))}`
    + actions(`<button type="submit" class="v2-btn v2-btn--primary" data-enh-assign${off}>${esc(t(msgid('Assign')))}</button>` + button(t(msgid('Remove')), { 'data-enh-unassign': true }, editable)) + '</form>'
    + status(t(msgid('Enhancements have not been read.')), { 'data-enh-assign-status': true }),
  { 'data-whm-account-enhancements': true, 'data-account-admin-editable': String(editable) }))
}

/** WHM Home: the administrator's favorites and notifications, filled by WHM_HOME_CLIENT_BINDING. */
export function renderV2WhmHome(t: Translate): string {
  return `<div class="v2-whm-overview__secondary">${toolCard('favorites', t(msgid('Favorites')), `<p data-whm-favorites-empty>${esc(t(msgid('Star a page in the quick bar to keep it here and in the side menu.')))}</p><ul class="v2-whm-overview__services" data-whm-favorites-list></ul>`
    + `<label class="v2-account-tool__choice"><input type="checkbox" data-whm-favorites-descriptions checked><span>${esc(t(msgid('Show descriptions')))}</span></label><p role="status" data-whm-favorites-status hidden></p>`, { 'data-whm-favorites': true })}`
    + `${card({ title: t(msgid('Notifications')), titleId: 'whm-inbox-heading', hooks: { 'data-whm-inbox': true }, bodyHtml: status(t(msgid('Notifications have not been read.')), { 'data-whm-inbox-status': true }) + '<ul class="v2-whm-overview__services" data-whm-inbox-list></ul>' + actions(button(t(msgid('Mark all as read')), { 'data-whm-inbox-read': true })) })}</div>`
}

/** WHM Web Template Editor: one editor per page; the host publishes each save. */
export function renderV2WebTemplates(t: Translate, editable: boolean): string {
  const off = editable ? '' : ' disabled'
  const page = (kind: 'default' | 'suspended', label: string, help: string): string => `<form class="v2-account-tool__fields" data-web-template-form="${kind}" novalidate><h3>${esc(label)}</h3><p class="v2-muted">${esc(help)}</p><p class="v2-muted" data-web-template-state></p>`
    + field(`v2-web-template-${kind}`, label, `<textarea id="v2-web-template-${kind}" name="html" class="v2-mono" rows="12" dir="ltr" spellcheck="false"${off}></textarea>`)
    + actions(`<button type="submit" class="v2-btn v2-btn--primary"${off}>${esc(t(msgid('Save')))}</button>` + button(t(msgid('Revert to last saved')), { 'data-web-template-action': 'revert' }, editable) + button(t(msgid('Restore the shipped page')), { 'data-web-template-action': 'shipped' }, editable) + button(t(msgid('Preview')), { 'data-web-template-action': 'preview' }, editable)
      + `<label class="v2-btn">${esc(t(msgid('Upload a file')))}<input type="file" accept=".html,.htm,text/html" hidden data-web-template-upload${off}></label>`) + '</form>'
  return formless(editable, toolCard('web-templates', t(msgid('Web template editor')), `<p>${esc(t(msgid('Your pages apply to the accounts you own. %contact% becomes your contact address. Saving publishes the page through the web server.')))}</p>`
    + page('default', t(msgid('Default website page')), t(msgid('Shown for a site with an empty public_html instead of an access error.'))) + page('suspended', t(msgid('Suspended account page')), t(msgid('Shown while an account is suspended.')))
    + `<iframe title="${esc(t(msgid('Preview')))}" sandbox="" data-web-template-preview hidden></iframe>`
    + status(t(msgid('Templates have not been read.')), { 'data-web-template-status': true }),
  { 'data-whm-web-templates': true, 'data-account-admin-editable': String(editable) }))
}

/** WHM Skeleton Directory: files copied once, when an account is created. */
export function renderV2Skeleton(t: Translate, editable: boolean): string {
  const off = editable ? '' : ' disabled'
  const row = `<template data-xp-template="skeleton-row"><tr><td>${technical('path')}</td><td><bdi dir="ltr" data-xp-slot="size"></bdi></td><td><button type="button" class="v2-btn" data-xp-slot="remove"${off}>${esc(t(msgid('Remove')))}</button></td></tr></template>`
  return formless(editable, toolCard('skeleton', t(msgid('Skeleton directory')), `<p>${esc(t(msgid('Files here are copied into public_html or public_ftp of each new account you create. Existing accounts do not change.')))}</p>${row}`
    + table(t(msgid('Skeleton directory')), [t(msgid('File')), t(msgid('Size')), t(msgid('Actions'))], { 'data-skeleton-rows': true }, t(msgid('The skeleton has not been read.')))
    + `<form data-skeleton-form novalidate>${fields(field('v2-skeleton-path', t(msgid('File path')), `<input id="v2-skeleton-path" name="path" class="v2-mono" dir="ltr" maxlength="240" placeholder="public_html/index.html" autocomplete="off" spellcheck="false"${off}>`) + field('v2-skeleton-file', t(msgid('File')), `<input id="v2-skeleton-file" name="file" type="file"${off}>`))}`
    + field('v2-skeleton-text', t(msgid('Or type the content')), `<textarea id="v2-skeleton-text" name="text" class="v2-mono" rows="4" dir="ltr" spellcheck="false"${off}></textarea>`)
    + actions(`<button type="submit" class="v2-btn v2-btn--primary"${off}>${esc(t(msgid('Save file')))}</button>`) + '</form>'
    + status(t(msgid('The skeleton has not been read.')), { 'data-skeleton-status': true }),
  { 'data-whm-skeleton': true, 'data-account-admin-editable': String(editable) }))
}

/** WHM Copy a Locale: a new code starts as a full copy of a locale, then its catalog is uploaded like any other. */
export function renderV2LocaleCopy(t: Translate, editable: boolean): string {
  const off = editable ? '' : ' disabled'
  const row = `<template data-xp-template="locale-copy-row"><tr><td>${technical('tag')}</td><td data-xp-slot="name"></td><td>${technical('source')}</td><td>${technical('messages')}</td><td data-xp-slot="state"></td><td><button type="button" class="v2-btn" data-xp-slot="remove"${off}>${esc(t(msgid('Delete')))}</button></td></tr></template>`
  return formless(editable, toolCard('locale-copy', t(msgid('Copy a locale')), `<p>${esc(t(msgid('A copy holds every string of its source. It joins the panels at the next panel start, and can then be offered and translated like any other language.')))}</p>${row}`
    + table(t(msgid('Locale copies')), [t(msgid('Code')), t(msgid('Name')), t(msgid('Source')), t(msgid('Strings')), t(msgid('Status')), t(msgid('Actions'))], { 'data-locale-copy-rows': true }, t(msgid('Locale copies have not been read.')))
    + `<form data-locale-copy-form novalidate>${fields(field('v2-locale-copy-source', t(msgid('Source locale')), `<select id="v2-locale-copy-source" name="source" dir="ltr"${off}></select>`) + field('v2-locale-copy-tag', t(msgid('New code')), `<input id="v2-locale-copy-tag" name="tag" class="v2-mono" dir="ltr" maxlength="35" placeholder="pt-BR" autocomplete="off" spellcheck="false"${off}>`))}`
    + actions(`<button type="submit" class="v2-btn v2-btn--primary"${off}>${esc(t(msgid('Copy locale')))}</button>`) + '</form>'
    + status(t(msgid('Locale copies have not been read.')), { 'data-locale-copy-status': true }),
  { 'data-whm-locale-copy': true, 'data-account-admin-editable': String(editable) }))
}
