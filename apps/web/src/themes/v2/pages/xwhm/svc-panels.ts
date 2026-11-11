import { localeDirection } from '../../../../i18n.ts'
import type { Locale, Translate } from '../../../../i18n.ts'
import { SVC_COPY, SVC_PANELS, svcHooks } from '../../../../models/svc-panels.ts'
import type { SvcFact, SvcForm, SvcInput, SvcPanel, SvcSection, SvcTable } from '../../../../models/svc-panels.ts'
import { card } from '../../components/card.ts'
import { escapeHtml as esc } from '../../html.ts'
import { whmPolish } from './monitoring/common.ts'
import { phoneColumns, phoneRows } from './lifecycle/shared.ts'

export const WHM_SVC_ROUTES = Object.freeze(Object.keys(SVC_PANELS))
/** Used only on the routes in WHM_SVC_ROUTES. */
export const WHM_SVC_CSS = `.v2-svc{display:flex;flex-direction:column;gap:32px;min-inline-size:0}
.v2-svc :is(h2,h3,p,dl,dd){margin:0}
.v2-svc__panel{display:flex;flex-direction:column;gap:32px;min-inline-size:0}
.v2-svc .v2-card__body{gap:24px}
.v2-svc__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,240px),1fr));gap:16px;min-inline-size:0}
.v2-svc__grid>.v2-field:has(textarea){grid-column:1/-1}
.v2-svc__grid>div,.v2-svc__grid dd{display:flex;flex-direction:column;gap:8px;min-inline-size:0;text-align:start;overflow-wrap:break-word}
.v2-svc__grid dt{font-size:13px;color:var(--muted)}
.v2-svc__grid dd{align-items:flex-start}
.v2-svc dl.v2-svc__grid{grid-template-columns:repeat(auto-fill,minmax(min(200px,calc(50% - 8px)),1fr))}
.v2-svc__check{display:flex;align-items:flex-start;gap:8px;min-block-size:var(--target)}
.v2-svc__check>input{flex:none;margin:0}
.v2-svc :is(input:not([type=checkbox]),select,textarea){inline-size:100%;min-inline-size:0}
.v2-svc textarea{min-block-size:96px}
.v2-svc__actions{display:flex;flex-wrap:wrap;align-items:center;gap:16px}
.v2-svc__scroll{max-inline-size:100%;overflow:auto;min-inline-size:0}
.v2-svc :is(th,td){text-align:start;vertical-align:top;padding:12px 16px;overflow-wrap:break-word}
.v2-svc td>button{margin-inline-end:8px}
@media(max-width:600px){${phoneRows('.v2-svc .v2-svc__scroll>table')}
.v2-svc .v2-svc__scroll>table>tbody>tr:nth-child(n)>:nth-child(n){overflow-wrap:break-word}
.v2-svc__scroll:has(td[colspan])::before{content:attr(aria-label);display:block;margin-block-end:8px;font-size:13px;color:var(--muted)}.v2-svc__scroll td[colspan]{padding-inline:0;font-weight:600}}
.v2-svc__status{color:var(--muted)}
${whmPolish('.v2-svc')}`

/** V2 drawing of the services and security centre panels of one route; the shared schema decides the content. */
export function renderV2SvcPanels(route: string, t: Translate, locale: Locale, canRead: boolean, canManage: (tool: string) => boolean): string {
  const panels = SVC_PANELS[route]
  if (!panels?.length || !canRead) return ''
  const text = (value: string): string => esc(t(value))
  // The primary action ends the row, on the inline end.
  const isPrimary = (button: NonNullable<SvcSection['buttons']>[number]): boolean => button.op === 'save' || ('primary' in button && !!button.primary)
  const fact = (item: SvcFact): string => `<div><dt>${text(item.label)}</dt><dd><bdi dir="ltr"${svcHooks.fact(t, item)}>${text(SVC_COPY.notRead)}</bdi></dd></div>`
  const control = (panel: SvcPanel, form: SvcForm, field: SvcInput): string => {
    const id = `v2-svc-${panel.id}-${form.role}-${field.key.replaceAll('.', '-')}`, hooks = svcHooks.input(form, field), dir = field.technical || field.kind === 'number' ? ' dir="ltr"' : ''
    if (field.kind === 'check') return `<label class="v2-svc__check"><input id="${id}" type="checkbox"${hooks} disabled><span>${text(field.label)}</span></label>`
    const body = field.kind === 'select' ? `<span class="v2-select"><select id="${id}"${hooks}${dir} disabled>${(field.choices ?? []).map(([value, label]) => `<option value="${esc(value)}">${text(label)}</option>`).join('')}</select></span>`
      : field.kind === 'lines' || field.kind === 'area' ? `<textarea id="${id}"${hooks}${dir} disabled></textarea>`
      : `<input id="${id}" type="${field.kind === 'number' ? 'number' : 'text'}"${hooks}${dir}${field.min === undefined ? '' : ` min="${field.min}"`}${field.max === undefined ? '' : ` max="${field.max}"`} disabled>`
    return `<div class="v2-field"><label for="${id}">${text(field.label)}</label>${body}${field.help ? `<p class="v2-muted">${text(field.help)}</p>` : ''}</div>`
  }
  const tableOf = (item: SvcTable): string => `<div class="v2-svc__scroll" role="region" tabindex="0" aria-label="${text(item.title)}"><table${phoneColumns([...item.columns.map(column => t(column.label)), ...(item.ops?.length ? [t(SVC_COPY.actions)] : [])])}><caption class="v2-sr">${text(item.title)}</caption><thead><tr>${item.columns.map(column => `<th scope="col">${text(column.label)}</th>`).join('')}${item.ops?.length ? `<th scope="col">${text(SVC_COPY.actions)}</th>` : ''}</tr></thead><tbody${svcHooks.rows(t, item)}><tr><td data-table-empty colspan="${item.columns.length + (item.ops?.length ? 1 : 0)}">${text(SVC_COPY.notRead)}</td></tr></tbody></table></div>`
  const section = (panel: SvcPanel, item: SvcSection, first: boolean): string => {
    const body = `${item.help ? `<p class="v2-muted">${text(item.help)}</p>` : ''}${(item.forms ?? []).map(form => `<div class="v2-svc__grid">${form.inputs.map(field => control(panel, form, field)).join('')}</div>`).join('')}${item.facts?.length ? `<dl class="v2-svc__grid">${item.facts.map(fact).join('')}</dl>` : ''}${(item.tables ?? []).map(tableOf).join('')}${item.buttons?.length ? `<div class="v2-svc__actions">${[...item.buttons].sort((a, b) => Number(isPrimary(a)) - Number(isPrimary(b))).map(button => `<button type="button" class="v2-btn${isPrimary(button) ? ' v2-btn--primary' : ''}"${svcHooks.button(t, button)} disabled>${text(button.label)}</button>`).join('')}</div>` : ''}${first ? `<p class="v2-svc__status" data-svc-status data-state="unread" role="status">${text(SVC_COPY.unread)}</p>` : ''}`
    return `<div data-svc-section>${card({ title: t(item.title), titleId: `v2-svc-${item.id}`, bodyHtml: body })}</div>`
  }
  const panel = (item: SvcPanel): string => `<div class="v2-svc__panel"${svcHooks.panel(item, canRead, canManage(item.tool))}><template data-svc-row-button><button type="button" class="v2-btn"></button></template>${item.sections.map((part, index) => section(item, part, index === 0)).join('')}</div>`
  return `<div class="v2-svc" lang="${esc(locale)}" dir="${localeDirection(locale)}">${panels.map(panel).join('')}</div>`
}
