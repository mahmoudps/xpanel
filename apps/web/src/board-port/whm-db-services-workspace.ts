import { translator, type Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { DB_QUOTA_SECTION, PMA_ACCESS_SECTION, dbServiceSections } from '../models/db-services.ts'
import type { DbSection, DbSectionField, DbSectionPart, DbServiceEngine } from '../models/db-services.ts'

/** Classic drawing of the database service tools; whm-db-services-client.ts reads, validates and saves every value. */
const attr = (hook: string, value?: string): string => value === undefined ? hook : `${hook}="${escapeHtml(value)}"`
function field(t: ReturnType<typeof translator>, row: DbSectionField): string {
  const hook = attr(row.hook, row.value), dir = row.dir ? ` dir="${row.dir}"` : ''
  const control = row.options ? `<select id="${row.id}" class="xp-select" ${hook} disabled>${row.options.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(t(label))}</option>`).join('')}</select>`
    : row.textarea ? `<textarea id="${row.id}" class="xp-input xp-mono"${dir} rows="4" ${hook} disabled></textarea>`
      : `<input id="${row.id}" class="xp-input" type="${row.type ?? 'text'}"${dir} autocomplete="${row.type === 'password' ? 'new-password' : 'off'}" ${hook} disabled>`
  return `<div class="xp-whm-detail-field"><label for="${row.id}">${escapeHtml(t(row.label))}</label>${control}</div>`
}
function part(t: ReturnType<typeof translator>, row: DbSectionPart, key: string): string {
  switch (row.kind) {
    case 'facts': return `<dl class="xp-whm-detail-fields">${row.rows.map(([name, label]) => `<div class="xp-whm-detail-field"><dt>${escapeHtml(t(label))}</dt><dd dir="ltr" ${row.attribute}="${name}">${escapeHtml(t('Not read'))}</dd></div>`).join('')}</dl>`
    case 'fields': return `<div class="xp-whm-detail-fields">${row.fields.map(item => field(t, item)).join('')}</div>`
    case 'check': return `<label class="xp-check"><input type="checkbox" ${attr(row.hook, row.value)} disabled> <span>${escapeHtml(t(row.label))}</span></label>`
    case 'actions': return `<div class="xp-whm-detail-actions">${row.buttons.map(button => `<button type="button" class="xp-btn${button.primary ? ' xp-btn--primary' : ''}" ${attr(button.hook, button.value)} disabled>${escapeHtml(t(button.label))}</button>`).join('')}</div>`
    case 'table': return `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${escapeHtml(t(row.title))}"><table class="xp-table xp-whm-detail-table"><caption class="sr-only">${escapeHtml(t(row.title))}</caption><thead><tr>${row.headers.map(header => `<th scope="col">${escapeHtml(t(header))}</th>`).join('')}</tr></thead><tbody ${row.hook === 'data-dbs-rows' ? `data-dbs-rows="${row.value}"` : row.hook}><tr><td colspan="${row.headers.length}">${escapeHtml(t('Not read'))}</td></tr></tbody></table></div>`
    case 'note': return `<p class="xp-help">${escapeHtml(t(row.text))}</p>`
    case 'status': return `<p class="xp-whm-detail-status" ${row.hook} data-state="unread" role="status">${escapeHtml(t(row.text))}</p>`
    case 'editor': return `<div data-dbs-file="${row.file}"><div class="xp-whm-detail-field"><label for="db-file-${key}">${escapeHtml(t(row.label))}</label><textarea id="db-file-${key}" class="xp-input xp-mono" dir="ltr" rows="14" spellcheck="false" data-dbs-file-text disabled></textarea></div><div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-dbs-file-load disabled>${escapeHtml(t('Load file'))}</button><button type="button" class="xp-btn xp-btn--primary" data-dbs-file-save disabled>${escapeHtml(t('Save file'))}</button></div></div>`
    case 'upload': return `<div class="xp-whm-detail-field"><label for="${row.id}">${escapeHtml(t(row.label))}</label><input id="${row.id}" class="xp-input" type="file" accept=".gz" ${row.hook} disabled></div>`
    case 'log': return `<div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-dbs-log-read disabled>${escapeHtml(t('Read log'))}</button></div><pre class="xp-mono" dir="ltr" tabindex="0" data-dbs-log></pre>`
  }
}
const card = (t: ReturnType<typeof translator>, section: DbSection, attrs = ''): string => `<section class="xp-whm-detail-card" aria-labelledby="whm-db-${section.key}-heading"${attrs ? ' ' + attrs : ''}><h2 id="whm-db-${section.key}-heading">${escapeHtml(t(section.title))}</h2>${section.parts.map(row => part(t, row, section.key)).join('')}</section>`

export function renderDbServiceCards(locale: Locale, engine: DbServiceEngine, canManage: boolean): string {
  const t = translator(locale)
  return `<div data-db-service="${engine}" data-can-manage="${canManage}"><style>[data-db-service]{display:flex;flex-direction:column;gap:32px;min-inline-size:0}[data-db-service] [data-dbs-file]{display:flex;flex-direction:column;gap:16px}[data-db-service] pre{margin:0;max-block-size:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}</style>${dbServiceSections(engine).map(section => card(t, section)).join('')}</div>`
}
export const renderDbQuotaCard = (locale: Locale, canManage: boolean): string => card(translator(locale), DB_QUOTA_SECTION, `data-db-quota-tool data-can-manage="${canManage}"`)
export const renderPmaAccessCard = (locale: Locale, canManage: boolean): string => card(translator(locale), PMA_ACCESS_SECTION, `data-db-pma-access data-can-manage="${canManage}"`)
