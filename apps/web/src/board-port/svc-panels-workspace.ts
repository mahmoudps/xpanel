import { type Locale, localeDirection, translator } from '../i18n.ts'
import { SVC_COPY, SVC_PANELS, svcHooks } from '../models/svc-panels.ts'
import type { SvcFact, SvcForm, SvcInput, SvcPanel, SvcSection, SvcTable } from '../models/svc-panels.ts'
import { escapeHtml } from '../tokens.ts'

const STYLE = `<style>.xp-svc{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-svc :is(h2,h3,p,dl,dd){margin:0}.xp-svc__panel{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-svc__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:16px;min-inline-size:0}.xp-svc textarea{min-block-size:96px;inline-size:100%}.xp-svc td>button{margin-inline-end:8px}</style>`

/** Classic drawing of the services and security centre panels of one route; the shared schema decides the content. */
export function renderClassicSvcPanels(route: string, input: { locale: Locale; canRead: boolean; canManage: (tool: string) => boolean }): string {
  const panels = SVC_PANELS[route]
  if (!panels?.length || !input.canRead) return ''
  const t = (text: string): string => escapeHtml(translator(input.locale)(text)), plain = (text: string): string => translator(input.locale)(text)
  const fact = (item: SvcFact): string => `<div class="xp-whm-detail-field"><dt>${t(item.label)}</dt><dd><bdi dir="ltr"${svcHooks.fact(plain, item)}>${t(SVC_COPY.notRead)}</bdi></dd></div>`
  const control = (panel: SvcPanel, form: SvcForm, field: SvcInput): string => {
    const id = `svc-${panel.id}-${form.role}-${field.key.replaceAll('.', '-')}`, hooks = svcHooks.input(form, field), dir = field.technical || field.kind === 'number' ? ' dir="ltr"' : ''
    if (field.kind === 'check') return `<label class="xp-whm-detail-choice"><input id="${id}" type="checkbox"${hooks} disabled><span>${t(field.label)}</span></label>`
    const body = field.kind === 'select' ? `<select id="${id}"${hooks}${dir} disabled>${(field.choices ?? []).map(([value, label]) => `<option value="${escapeHtml(value)}">${t(label)}</option>`).join('')}</select>`
      : field.kind === 'lines' || field.kind === 'area' ? `<textarea id="${id}"${hooks}${dir} disabled></textarea>`
      : `<input id="${id}" type="${field.kind === 'number' ? 'number' : 'text'}"${hooks}${dir}${field.min === undefined ? '' : ` min="${field.min}"`}${field.max === undefined ? '' : ` max="${field.max}"`} disabled>`
    return `<div class="xp-whm-detail-field"><label for="${id}">${t(field.label)}</label>${body}${field.help ? `<p class="xp-help">${t(field.help)}</p>` : ''}</div>`
  }
  const tableOf = (item: SvcTable): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(item.title)}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t(item.title)}</caption><thead><tr>${item.columns.map(column => `<th scope="col">${t(column.label)}</th>`).join('')}${item.ops?.length ? `<th scope="col">${t(SVC_COPY.actions)}</th>` : ''}</tr></thead><tbody${svcHooks.rows(plain, item)}><tr><td colspan="${item.columns.length + (item.ops?.length ? 1 : 0)}">${t(SVC_COPY.notRead)}</td></tr></tbody></table></div>`
  const section = (panel: SvcPanel, item: SvcSection, first: boolean): string => `<section class="xp-whm-detail-card" data-svc-section aria-labelledby="whm-detail-svc-${item.id}"><h2 id="whm-detail-svc-${item.id}">${t(item.title)}</h2>${item.help ? `<p class="xp-help">${t(item.help)}</p>` : ''}
${(item.forms ?? []).map(form => `<div class="xp-svc__grid">${form.inputs.map(field => control(panel, form, field)).join('')}</div>`).join('')}
${item.facts?.length ? `<dl class="xp-whm-detail-fields">${item.facts.map(fact).join('')}</dl>` : ''}
${(item.tables ?? []).map(tableOf).join('')}
${item.buttons?.length ? `<div class="xp-whm-detail-actions">${item.buttons.map(button => `<button type="button" class="xp-btn${button.op === 'save' || ('primary' in button && button.primary) ? ' xp-btn--primary' : ''}"${svcHooks.button(plain, button)} disabled>${t(button.label)}</button>`).join('')}</div>` : ''}
${first ? `<p class="xp-whm-detail-status" data-svc-status data-state="unread" role="status">${t(SVC_COPY.unread)}</p>` : ''}</section>`
  const panel = (item: SvcPanel): string => `<div class="xp-svc__panel"${svcHooks.panel(item, input.canRead, input.canManage(item.tool))}><template data-svc-row-button><button type="button" class="xp-btn"></button></template>${item.sections.map((part, index) => section(item, part, index === 0)).join('')}</div>`
  return `${STYLE}<div class="xp-svc" lang="${input.locale}" dir="${localeDirection(input.locale)}">${panels.map(panel).join('')}</div>`
}
