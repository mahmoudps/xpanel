import { localeDirection, translator, type Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

const HOURS: readonly (readonly [string, string])[] = [['1', msgid('1 hour')], ['24', msgid('24 hours')], ['168', msgid('7 days')], ['720', msgid('30 days')]]

/** /whm/server/file-sharing: expiring public downloads of one file. file-share-links-client.ts owns the behaviour. */
export function renderFileShareLinks(input: { locale: Locale; canManage: boolean }): string {
  const translate = translator(input.locale), t = (copy: string): string => escapeHtml(translate(copy))
  const heads = [msgid('File'), msgid('Account'), msgid('Expires (UTC)'), msgid('Status'), msgid('Actions')]
  return `<section class="xp-whm-detail-card" aria-labelledby="file-share-links" data-file-share-links data-file-share-can-manage="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}"><h2 id="file-share-links">${t(msgid('Share links'))}</h2>
<template data-xp-template="file-share-action"><button type="button" class="xp-btn" disabled><span data-xp-slot="label"></span></button></template>
<p class="xp-help">${t(msgid('A link lets anyone who has it download one file from an account, with no sign-in, until it expires or you revoke it. Every link, download and revocation is in the audit log.'))}</p>
<div class="xp-whm-detail-fields"><div class="xp-whm-detail-field"><label for="file-share-path">${t(msgid('File path'))}</label><input id="file-share-path" class="xp-input" dir="ltr" maxlength="1200" autocomplete="off" spellcheck="false" placeholder="/home/example/public_html/report.pdf" data-file-share-path disabled></div>
<div class="xp-whm-detail-field"><label for="file-share-hours">${t(msgid('Expires after'))}</label><select id="file-share-hours" class="xp-input" data-file-share-hours disabled>${HOURS.map(([value, label]) => `<option value="${value}"${value === '24' ? ' selected' : ''}>${t(label)}</option>`).join('')}</select></div></div>
<div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-file-share-create disabled>${t(msgid('Create link'))}</button><button type="button" class="xp-btn" data-file-share-read disabled>${t(msgid('Read links'))}</button></div>
<p class="xp-whm-detail-status" data-file-share-status data-state="unread" role="status">${t(msgid('Share links have not been read.'))}</p>
<div data-file-share-result hidden><label for="file-share-url">${t(msgid('New link, shown only once'))}</label><input id="file-share-url" class="xp-input" dir="ltr" readonly data-file-share-url disabled> <button type="button" class="xp-btn" data-file-share-copy disabled>${t(msgid('Copy link'))}</button></div>
<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(msgid('Share links'))}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t(msgid('Share links'))}</caption><thead><tr>${heads.map(head => `<th scope="col">${t(head)}</th>`).join('')}</tr></thead><tbody data-file-share-rows><tr><td colspan="5">${t(msgid('Share links have not been read.'))}</td></tr></tbody></table></div></section>`
}
