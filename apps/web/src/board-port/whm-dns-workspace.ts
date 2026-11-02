import { dnsEditorTemplates } from './data-client-templates.ts'
import type { Account, Principal } from '@xpanel/core'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** Existing DNS desired-state editor, with page-scoped layout and truthful host limits. */
export function renderWhmDnsWorkspace(input: { locale: Locale; accounts: readonly Account[]; principal: Principal; title: string }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  return `<section class="xp-card xp-whm-dns" data-dns-editor="true" aria-labelledby="whm-dns-heading" lang="${input.locale}" dir="${localeDirection(input.locale)}">
    <style>
    .xp-whm-dns [data-dns-remove]{white-space:nowrap;overflow-wrap:normal;word-break:normal;min-inline-size:max-content}.xp-whm-dns__table{min-inline-size:0}.xp-whm-dns__table:focus-visible{outline:2px solid var(--xp-accent,#1d5bd6);outline-offset:2px}
    .xp-whm-dns{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0}.xp-whm-dns :is(h1,p){margin:0}.xp-whm-dns__fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;min-inline-size:0}.xp-whm-dns .xp-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0;margin:0}.xp-whm-dns label{margin:0;text-align:start}.xp-whm-dns :is(input,select){inline-size:100%;box-sizing:border-box;min-inline-size:0;min-block-size:44px;margin:0}.xp-whm-dns[dir=rtl] [dir=ltr]{text-align:right}.xp-whm-dns__actions{display:flex;flex-wrap:wrap;gap:16px}.xp-whm-dns button{min-block-size:44px}.xp-whm-dns__table{max-inline-size:100%;overflow:auto}.xp-whm-dns table{inline-size:100%;border-collapse:collapse}.xp-whm-dns :is(th,td){text-align:start;padding:12px 8px}.xp-whm-dns td:nth-child(4){min-inline-size:180px}.xp-whm-dns td label{display:none}.xp-whm-dns td :is(input,select){min-inline-size:80px}.xp-whm-dns [data-dns-status]{overflow-wrap:anywhere}.xp-whm-dns [hidden]{display:none}
    [data-approved-whm-dns-supplement] .xp-whm-detail-table{inline-size:max-content;min-inline-size:100%;table-layout:auto}[data-approved-whm-dns-supplement] .xp-whm-detail-table th{white-space:nowrap;overflow-wrap:normal;word-break:normal}
    @media(min-width:601px){.xp-whm-dns{padding:24px}}@media(max-width:639px){.xp-whm-dns__fields{grid-template-columns:minmax(0,1fr)}.xp-whm-dns__table:has(tbody:empty){display:none}.xp-whm-dns :is(table,tbody,tr,td){display:block;inline-size:100%;box-sizing:border-box}.xp-whm-dns thead{display:none}.xp-whm-dns tr{display:grid;gap:16px;padding-block:16px;border-block-start:1px solid var(--xp-border)}.xp-whm-dns td{padding:0;min-inline-size:0!important;block-size:auto;height:auto;display:grid;gap:8px}.xp-whm-dns td label{display:block}.xp-whm-dns td :is(input,select){min-inline-size:0}.xp-whm-dns__actions>*{flex:1 1 auto}}
    </style>
    <h1 id="whm-dns-heading" class="xp-page-title">${escapeHtml(input.title)}</h1>
    <p class="xp-prose">${t('Edit saved DNS configuration. Saving and readback do not verify DNS serving or propagation. SOA serials are allocated by the server.')}</p>
    <div class="xp-whm-dns__fields">
      <div class="xp-field"><label for="dns-zone">${t('Zone')}</label><select id="dns-zone" class="xp-select" data-dns-zone="true" dir="ltr" disabled></select></div>
      <div class="xp-field"><label for="dns-account">${t('New zone account')}</label><select id="dns-account" class="xp-select" data-dns-account="true" disabled>${input.principal.kind === 'root' ? `<option value="">${t('Unassigned (server)')}</option>` : ''}${input.accounts.map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.username)}</option>`).join('')}</select></div>
      <div class="xp-field"><label for="dns-new-name">${t('New zone name')}</label><input id="dns-new-name" class="xp-input xp-mono" dir="ltr" data-dns-new-name="true" maxlength="253" disabled></div>
    </div>
    <div class="xp-whm-dns__table" role="region" tabindex="0" aria-labelledby="whm-dns-records-caption"><table class="xp-table"><caption id="whm-dns-records-caption" class="xp-sr-only">${t('Saved DNS record editor')}</caption><thead><tr>${[t('Name'), t('Type'), 'TTL', t('Content'), t('Priority'), t('Actions')].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-dns-records="true"></tbody></table></div>
    <p class="xp-help" data-dns-status data-state="unread" role="status">${t('Saved zones have not been read.')}</p>
    <div class="xp-whm-dns__actions">
      <button type="button" class="xp-btn" data-dns-refresh="true" disabled>${t('Read saved zones')}</button>
      <button type="button" class="xp-btn" data-dns-add-record="true" disabled>${t(msgctxt('whm-dns-workspace', 'Add record'))}</button>
      <button type="button" class="xp-btn" data-dns-add-zone="true" disabled>${t(msgctxt('whm-dns-workspace', 'Add zone'))}</button>
      <button type="button" class="xp-btn xp-btn--primary" data-dns-save="true" disabled>${t('Save zone')}</button>
      <button type="button" class="xp-btn" data-dns-delete="true" disabled>${t('Delete zone')}</button>
    </div>
  ${dnsEditorTemplates(t, true)}</section>`
}
