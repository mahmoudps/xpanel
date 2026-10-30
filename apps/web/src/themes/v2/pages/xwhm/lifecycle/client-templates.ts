import type { Translate } from '../../../../../i18n.ts'
import { escapeHtml } from '../../../html.ts'
import { lifecycleCard, lifecycleField, lifecycleTable, text } from './shared.ts'

/** V2 owns its four-column inventory and all dynamic transfer presentation. */
export function v2TransferClientTemplates(t: Translate): string {
  const row = (name: string, fields: readonly string[]) => `<template data-xp-template="${name}-row"><tr>${fields.map(key => `<td><bdi dir="auto" data-xp-slot="${key}"></bdi></td>`).join('')}</tr></template><template data-xp-template="${name}-empty"><tr><td colspan="${fields.length}" data-xp-slot="message"></td></tr></template>`
  const grid = (name: string, headers: readonly string[]) => `<template data-xp-template="${name}-table"><div class="v2-lifecycle__scroll" role="region" tabindex="0" aria-label="${text(t, msgctxt('theme:v2', 'Transfer review'))}"><table class="v2-lifecycle__table"><thead><tr>${headers.map(label => `<th scope="col">${text(t, label)}</th>`).join('')}</tr></thead><tbody data-xp-slot="rows"></tbody></table></div></template>`
  return `<template data-xp-template="transfer-choice"><label class="v2-lifecycle__choice"><input type="checkbox" data-xp-action="select" disabled><bdi dir="ltr" data-xp-slot="name"></bdi></label></template>`
    + row('transfer-inventory', ['username', 'domain', 'uid', 'conflict'])
    + row('transfer-progress', ['account', 'home', 'databases', 'mail', 'dns', 'state'])
    + row('transfer-plans', ['source', 'target', 'owner', 'conflict'])
    + row('transfer-import-part', ['item', 'source', 'target', 'state'])
    + row('transfer-import-warnings', ['state', 'detail', 'path'])
    + row('transfer-review', ['source', 'target', 'plan', 'domains', 'mailboxes']) + grid('transfer-review', [msgid('Source account'), msgid('Destination account'), msgid('Plan'), msgid('Domains'), msgid('Mailboxes')])
    + row('transfer-archive-summary', ['part', 'count']) + grid('transfer-archive-summary', [msgctxt('whm-transfer-client', 'Part'), msgid('Count')])
    + row('transfer-archive-conflicts', ['kind', 'value']) + grid('transfer-archive-conflicts', [msgid('Conflict'), msgid('Value')])
    + row('transfer-archive-unmapped', ['state', 'detail', 'path']) + grid('transfer-archive-unmapped', [msgid('Not imported or changed'), msgid('Detail'), msgid('Path')])
}

export const v2TransferCredentialTemplates = (): string => `<template data-xp-template="transfer-credential-row"><tr><td><bdi dir="auto" data-xp-slot="label"></bdi></td><td><bdi dir="ltr" data-xp-slot="fingerprint"></bdi></td><td><bdi dir="ltr" data-xp-slot="created"></bdi></td><td><bdi dir="ltr" data-xp-slot="actor"></bdi></td><td><button type="button" class="v2-btn" data-xp-action="remove" disabled><span data-xp-slot="remove-label"></span></button></td></tr></template>`

/** The existing API accepts a source token once and returns labels/fingerprints, never its value. */
export function renderV2TransferCredentials(t: Translate, canManage: boolean): string {
  const control = (name: string, label: string, type: string, max: number) => lifecycleField(t, `acct-transfer-credential-${name}`, label, `<input id="acct-transfer-credential-${name}" type="${type}" maxlength="${max}" autocomplete="off" spellcheck="false" dir="${type === 'password' ? 'ltr' : 'auto'}" data-acct-transfer-credential-input="${name}"${canManage ? '' : ' disabled'}>`)
  const body = `<p>${text(t, msgid('On the source server, create a root API token with lifecycle read access in API tokens, then paste it here once. It is stored on this server with owner-only access and is never shown again; sessions refer to it by label.'))}</p><p role="status" data-acct-transfer-credentials-status data-state="unread">${text(t, msgid('Stored source tokens have not been read.'))}</p><div data-acct-transfer-credentials-loading aria-busy="true" hidden>${text(t, msgid('Loading stored source tokens'))}</div>${lifecycleTable(t, msgid('Stored source tokens'), [msgid('Label'), msgid('Token fingerprint'), msgid('Added (UTC)'), msgid('Added by'), msgid('Actions')], { 'data-acct-transfer-credentials-rows': true }, msgid('Not read'))}<div class="v2-lifecycle__column" data-acct-transfer-credentials-empty hidden><h3>${text(t, msgid('No source tokens stored'))}</h3><p>${text(t, msgid('Add the token from the source server below before you connect.'))}</p></div><${canManage ? 'form' : 'div'} class="v2-lifecycle__column" data-acct-transfer-credentials-form${canManage ? ' novalidate' : ''}>${control('label', msgid('Label'), 'text', 80)}${control('token', msgid('API token from the source'), 'password', 64)}<p>${text(t, msgid('The complete token starts with xp_.'))}</p><div class="v2-lifecycle__actions"><button type="${canManage ? 'submit' : 'button'}" class="v2-btn v2-btn--primary" data-acct-transfer-credential-save${canManage ? '' : ' disabled'}>${text(t, msgid('Store token'))}</button><button type="button" class="v2-btn" data-acct-transfer-credentials-refresh${canManage ? '' : ' disabled'}>${text(t, msgid('Refresh'))}</button></div></${canManage ? 'form' : 'div'}>${v2TransferCredentialTemplates()}`
  return lifecycleCard(t, 'transfer-server-credentials', msgid('Source API tokens'), body, { 'data-acct-transfer-credentials': true, 'data-can-manage': String(canManage), 'data-whm-detail-section': 'transfer-server-credentials' })
}
