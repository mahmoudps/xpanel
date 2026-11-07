import { translator, type Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

/** Email Disk Usage on the Email filters page; email-disk-usage-client.ts owns the behaviour. */
export function renderEmailDiskUsageCard(input: { locale: Locale; canManage: boolean; mailboxes: readonly string[] }): string {
  const translate = translator(input.locale), t = (copy: string): string => escapeHtml(translate(copy))
  const field = (id: string, label: string, control: string): string => `<div class="xp-field"><label for="${id}">${t(label)}</label>${control}</div>`
  const sort = (key: string, label: string): string => `<th scope="col"><button type="button" class="xp-btn" data-email-usage-sort="${key}" disabled>${t(label)}</button></th>`
  const presets = [['older-than-year', msgid('One year or older')], ['larger-than-30mb', msgid('30 MB or larger')], ['read', msgid('Already read')], ['all', msgid('All messages')], ['custom', msgid('Custom search')]].map(([value, label]) => `<option value="${value}">${t(label!)}</option>`).join('')
  return `${ACCOUNT_TOOL_STYLE}<section class="xp-extension__card" aria-labelledby="email-disk-usage" data-email-disk-usage data-email-usage-can-manage="${input.canManage}"><h2 id="email-disk-usage">${t(msgid('Email Disk Usage'))}</h2>
<p class="xp-help">${t(msgid('See what fills a mailbox and delete messages from one folder. Deleted messages cannot be recovered.'))}</p>
<div class="xp-acct-tool__fields">${field('email-usage-mailbox', msgid('Mailbox'), `<select id="email-usage-mailbox" class="xp-select" dir="ltr" data-email-usage-mailbox disabled>${input.mailboxes.map(login => `<option value="${escapeHtml(login)}">${escapeHtml(login)}</option>`).join('')}</select>`)}${field('email-usage-search', msgid('Filter folders'), '<input id="email-usage-search" class="xp-input" type="search" dir="ltr" autocomplete="off" data-email-usage-search disabled>')}</div>
<div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-email-usage-read disabled>${t(msgid('Read mailbox'))}</button></div>
<p data-email-usage-status data-state="unread" role="status">${t(msgid('The mailbox has not been read.'))}</p>
<div class="xp-acct-tool__table" role="region" tabindex="0" aria-label="${t(msgid('Folders'))}"><table class="xp-table"><thead><tr>${sort('name', msgid('Folder'))}${sort('messages', msgid('Messages'))}${sort('size', msgid('Size'))}</tr></thead><tbody data-email-usage-rows><tr><td colspan="3">${t(msgid('The mailbox has not been read.'))}</td></tr></tbody></table></div>
<h3>${t(msgid('Clean up'))}</h3><div class="xp-acct-tool__fields">${field('email-usage-folder', msgid('Folder'), '<select id="email-usage-folder" class="xp-select" dir="ltr" data-email-usage-folder disabled></select>')}${field('email-usage-preset', msgid('Delete'), `<select id="email-usage-preset" class="xp-select" data-email-usage-preset disabled>${presets}</select>`)}<div data-email-usage-custom hidden>${field('email-usage-query', msgid('Search terms'), '<input id="email-usage-query" class="xp-input" dir="ltr" maxlength="200" autocomplete="off" spellcheck="false" placeholder="LARGER 10M BEFORE 2025-01-01" data-email-usage-query disabled>')}</div></div>
<div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-email-usage-run disabled>${t(msgid('Delete messages'))}</button></div></section>`
}
