import { translator, type Locale } from '../i18n.ts'
import { escapeHtml } from '../html.ts'

/** Classic owns the columns, action controls and empty-row spans used by transfer controllers. */
export function classicTransferClientTemplates(locale: Locale): string {
  const t = translator(locale)
  const row = (name: string, fields: readonly string[]) => `<template data-xp-template="${name}-row"><tr>${fields.map(key => `<td><bdi dir="auto" data-xp-slot="${key}"></bdi></td>`).join('')}</tr></template><template data-xp-template="${name}-empty"><tr><td colspan="${fields.length}" data-xp-slot="message"></td></tr></template>`
  const grid = (name: string, headers: readonly string[]) => `<template data-xp-template="${name}-table"><div class="xp-transfer-workspace__scroll" role="region" tabindex="0" aria-label="${escapeHtml(t(msgid('Transfer tool')))}"><table class="xp-table"><thead><tr>${headers.map(label => `<th scope="col">${escapeHtml(t(label))}</th>`).join('')}</tr></thead><tbody data-xp-slot="rows"></tbody></table></div></template>`
  const review = [msgid('Source account'), msgid('Destination account'), msgid('Plan'), msgid('Domains'), msgid('Mailboxes')]
  return `<template data-xp-template="transfer-choice"><label class="xp-transfer-workspace__choice"><input type="checkbox" data-xp-action="select" disabled><bdi dir="ltr" data-xp-slot="name"></bdi></label></template>`
    + row('transfer-inventory', ['selected', 'username', 'domain', 'plan', 'disk', 'databases', 'mailboxes', 'conflict', 'resolution'])
    + row('transfer-progress', ['account', 'home', 'databases', 'mail', 'dns', 'state'])
    + row('transfer-plans', ['source', 'target', 'owner', 'conflict'])
    + row('transfer-import-part', ['item', 'source', 'target', 'state'])
    + row('transfer-import-warnings', ['state', 'detail', 'path'])
    + row('transfer-review', ['source', 'target', 'plan', 'domains', 'mailboxes']) + grid('transfer-review', review)
    + row('transfer-archive-summary', ['part', 'count']) + grid('transfer-archive-summary', [msgctxt('whm-transfer-client', 'Part'), msgid('Count')])
    + row('transfer-archive-conflicts', ['kind', 'value']) + grid('transfer-archive-conflicts', [msgid('Conflict'), msgid('Value')])
    + row('transfer-archive-unmapped', ['state', 'detail', 'path']) + grid('transfer-archive-unmapped', [msgid('Not imported or changed'), msgid('Detail'), msgid('Path')])
}

export const classicTransferCredentialTemplates = (): string => `<template data-xp-template="transfer-credential-row"><tr><td><bdi dir="auto" data-xp-slot="label"></bdi></td><td><bdi dir="ltr" data-xp-slot="fingerprint"></bdi></td><td><bdi dir="ltr" data-xp-slot="created"></bdi></td><td><bdi dir="ltr" data-xp-slot="actor"></bdi></td><td><button type="button" class="xp-btn" data-xp-action="remove" disabled><span data-xp-slot="remove-label"></span></button></td></tr></template>`
