import type { Translate } from '../../../../../i18n.ts'
import { esc, field, fields, section } from './common.ts'

/** Email Disk Usage; email-disk-usage-client.ts owns the behaviour. */
export function renderV2EmailDiskUsage(t: Translate, canManage: boolean, mailboxes: readonly string[]): string {
  const sort = (key: string, label: string): string => `<th scope="col"><button type="button" class="v2-btn" data-email-usage-sort="${key}" disabled>${esc(t(label))}</button></th>`
  const presets = [['older-than-year', msgid('One year or older')], ['larger-than-30mb', msgid('30 MB or larger')], ['read', msgid('Already read')], ['all', msgid('All messages')], ['custom', msgid('Custom search')]].map(([value, label]) => `<option value="${value}">${esc(t(label!))}</option>`).join('')
  const unread = esc(t(msgid('The mailbox has not been read.')))
  return `<div data-email-disk-usage data-email-usage-can-manage="${canManage}">${section('v2-email-disk-usage', t(msgid('Email Disk Usage')),
    `<p>${esc(t(msgid('See what fills a mailbox and delete messages from one folder. Deleted messages cannot be recovered.')))}</p>${fields(field('v2-email-usage-mailbox', t(msgid('Mailbox')), `<select id="v2-email-usage-mailbox" dir="ltr" data-email-usage-mailbox disabled>${mailboxes.map(login => `<option value="${esc(login)}">${esc(login)}</option>`).join('')}</select>`) + field('v2-email-usage-search', t(msgid('Filter folders')), '<input id="v2-email-usage-search" type="search" dir="ltr" autocomplete="off" data-email-usage-search disabled>'))}`
    + `<button type="button" class="v2-btn" data-email-usage-read disabled>${esc(t(msgid('Read mailbox')))}</button><p data-email-usage-status data-state="unread" role="status">${unread}</p>`
    + `<div role="region" tabindex="0" aria-label="${esc(t(msgid('Folders')))}"><table><thead><tr>${sort('name', msgid('Folder'))}${sort('messages', msgid('Messages'))}${sort('size', msgid('Size'))}</tr></thead><tbody data-email-usage-rows><tr><td colspan="3">${unread}</td></tr></tbody></table></div>`
    + `<h3>${esc(t(msgid('Clean up')))}</h3>${fields(field('v2-email-usage-folder', t(msgid('Folder')), '<select id="v2-email-usage-folder" dir="ltr" data-email-usage-folder disabled></select>') + field('v2-email-usage-preset', t(msgid('Delete')), `<select id="v2-email-usage-preset" data-email-usage-preset disabled>${presets}</select>`))}`
    + `<div data-email-usage-custom hidden>${field('v2-email-usage-query', t(msgid('Search terms')), '<input id="v2-email-usage-query" dir="ltr" maxlength="200" autocomplete="off" spellcheck="false" placeholder="LARGER 10M BEFORE 2025-01-01" data-email-usage-query disabled>')}</div>`
    + `<button type="button" class="v2-btn" data-email-usage-run disabled>${esc(t(msgid('Delete messages')))}</button>`)}</div>`
}
