import type { Translate } from '../../../i18n.ts'
import { attr, escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { icon } from '../icons.ts'

export interface DataTableColumn {
  label: string
  /** Visually hidden header (the label still names the column for assistive technology). */
  srOnly?: boolean
  align?: 'start' | 'end'
}

export interface DataTableRow {
  /** One cell per column, built with the kit (icon-led first cell, pills, meters). */
  cellsHtml: readonly string[]
  /** Row actions for the sticky last column: "Manage" plus a row menu. */
  actionsHtml?: string
  /** Row checkbox; the label names the row, such as "Select alice". */
  select?: { label: string; checked?: boolean; hooks?: HookAttributes }
  hooks?: HookAttributes
}

export type DataTableState = 'ready' | 'loading' | 'empty' | 'error'

export interface DataTableProps {
  id: string
  /** Names the table and its scroll region. Hidden by default because the card header shows the title. */
  caption: string
  showCaption?: boolean
  columns: readonly DataTableColumn[]
  rows: readonly DataTableRow[]
  state?: DataTableState
  emptyText?: string
  error?: { lead: string; detail?: string; retry?: HookAttributes }
  loadingRows?: number
  /** Adds the sticky, visually labelled actions column. */
  actions?: boolean
  /** Adds the checkbox column with a "select all" control. */
  selectAll?: { label: string; hooks?: HookAttributes }
  minWidth?: number
  regionHooks?: HookAttributes
  /** Hooks on <tbody>, where controllers paint their rows. */
  bodyHooks?: HookAttributes
}

export function dataTable(t: Translate, props: DataTableProps): string {
  const state = props.state ?? (props.rows.length ? 'ready' : 'empty')
  const captionId = `${props.id}-caption`
  const span = props.columns.length + (props.actions ? 1 : 0) + (props.selectAll ? 1 : 0)
  const head = [
    props.selectAll ? `<th scope="col" class="v2-table__check"><input type="checkbox" aria-label="${escapeHtml(props.selectAll.label)}"${hookAttrs(props.selectAll.hooks)}></th>` : '',
    ...props.columns.map(column => `<th scope="col"${column.align === 'end' ? ' class="v2-table__end"' : ''}>${column.srOnly ? `<span class="v2-sr">${escapeHtml(column.label)}</span>` : escapeHtml(column.label)}</th>`),
    props.actions ? `<th scope="col" class="v2-table__actions"><span class="v2-sr">${escapeHtml(t('Actions'))}</span></th>` : '',
  ].join('')
  const row = (item: DataTableRow): string => dataTableRow(props, item)
  const stateRow = (kind: Exclude<DataTableState, 'ready'>, content: string): string => `<tr class="v2-table__state" data-table-state="${kind}"><td colspan="${span}">${content}</td></tr>`
  const skeleton = `<span class="v2-skeleton v2-skeleton--tile"></span><span class="v2-skeleton-lines"><span class="v2-skeleton" style="inline-size:40%"></span><span class="v2-skeleton v2-skeleton--thin" style="inline-size:24%"></span></span><span class="v2-skeleton v2-skeleton--pill"></span>`
  const body = state === 'ready' ? props.rows.map(row).join('')
    : state === 'empty' ? stateRow('empty', `<p role="status">${escapeHtml(props.emptyText ?? t(msgctxt('theme:v2', 'Nothing to show yet.')))}</p>`)
    : state === 'loading' ? Array.from({ length: props.loadingRows ?? 3 }, (_, i) => i === 0
      ? stateRow('loading', `<span class="v2-sr">${escapeHtml(t('Loading'))}</span><div class="v2-skeleton-row" aria-hidden="true">${skeleton}</div>`)
      : `<tr class="v2-table__state" aria-hidden="true"><td colspan="${span}"><div class="v2-skeleton-row">${skeleton}</div></td></tr>`).join('')
    : stateRow('error', `<div class="v2-table__error" role="alert"><p><strong>${escapeHtml(props.error?.lead ?? t(msgctxt('theme:v2', 'This list could not be read.')))}</strong></p>${props.error?.detail ? `<code>${escapeHtml(props.error.detail)}</code>` : ''}${props.error?.retry ? `<button type="button" class="v2-btn"${hookAttrs(props.error.retry)}>${icon('refresh', 16)}${escapeHtml(t('Retry'))}</button>` : ''}</div>`)
  return `<div class="v2-table-scroll" role="region" aria-labelledby="${escapeHtml(captionId)}" tabindex="0"${state === 'loading' ? ' aria-busy="true"' : ''}${hookAttrs(props.regionHooks)}><table id="${escapeHtml(props.id)}" class="v2-table"${attr('style', props.minWidth ? `min-inline-size:${props.minWidth}px` : undefined)}><caption id="${escapeHtml(captionId)}"${props.showCaption ? '' : ' class="v2-sr"'}>${escapeHtml(props.caption)}</caption><thead><tr>${head}</tr></thead><tbody${hookAttrs(props.bodyHooks)}>${body}</tbody></table></div>`
}

/** One body row in the table's column layout; layouts also use it for the row templates core controllers clone. */
export function dataTableRow(props: Pick<DataTableProps, 'columns' | 'actions' | 'selectAll'>, item: DataTableRow): string {
  const cellClass = (index: number): string => props.columns[index]?.align === 'end' ? ' class="v2-table__end"' : ''
  return `<tr${hookAttrs(item.hooks)}>${props.selectAll ? `<td class="v2-table__check">${item.select ? `<input type="checkbox" aria-label="${escapeHtml(item.select.label)}"${item.select.checked ? ' checked' : ''}${hookAttrs(item.select.hooks)}>` : ''}</td>` : ''}${item.cellsHtml.map((cell, index) => `<td${cellClass(index)}>${cell}</td>`).join('')}${props.actions ? `<td class="v2-table__actions">${item.actionsHtml ?? ''}</td>` : ''}</tr>`
}

// A selected row (its checkbox checked, so no class to toggle) layers the accent tint over the surface so the sticky actions cell stays opaque in the dark scheme,
// whose tint is translucent.
export const DATA_TABLE_CSS = `.v2-table th.v2-table__end,.v2-table td.v2-table__end{text-align:end}
.v2-table .v2-table__check{inline-size:48px;padding-inline-end:0}
.v2-table .v2-table__actions{position:sticky;inset-inline-end:0;text-align:end;white-space:nowrap;background:var(--surface)}
.v2-table th.v2-table__actions{background:var(--subtle)}
.v2-table tbody tr:hover>td.v2-table__actions{background:var(--subtle)}
.v2-table .v2-table__actions>*{display:inline-flex;gap:var(--space-1);vertical-align:middle}
.v2-table tr:has(>.v2-table__check>input:checked)>td{background:linear-gradient(var(--accent-soft),var(--accent-soft)),var(--surface)}
.v2-table tbody .v2-table__state:hover>td{background:transparent}
.v2-table__state>td{padding:var(--space-3);text-align:center;color:var(--muted);font-size:13px}
.v2-table__state:is([aria-hidden],[data-table-state=loading])>td{padding-block:12px;text-align:start}
.v2-table__error{display:flex;flex-direction:column;align-items:center;gap:12px;color:var(--text)}
.v2-table__error strong{color:var(--bad);font-weight:600}
.v2-table__error code{padding:8px 12px;border-radius:var(--radius-chip);border:1px solid var(--bad-line);background:var(--bad-soft);overflow-wrap:anywhere}
.v2-table .v2-meter{min-inline-size:120px}
.v2-table .v2-meter__row{white-space:nowrap}
.v2-cell-lead{display:flex;align-items:center;gap:12px;min-width:0}
.v2-cell-lead__mark{flex:none;display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;background:var(--accent-soft);color:var(--accent);font-family:var(--font-mono);font-weight:600}
.v2-cell-lead__text{display:flex;flex-direction:column;min-width:0}
.v2-cell-lead__text>:first-child{font-weight:600}
.v2-cell-lead__text>:nth-child(2){font-size:12px;color:var(--muted)}
`

/** Icon-led first cell: a 34px mark (an initial, or an icon from the kit) with a primary and an optional meta line. */
export const leadCell = (props: { initial?: string; iconHtml?: string; title: string; meta?: string; mono?: boolean }): string =>
  `<div class="v2-cell-lead"><span class="v2-cell-lead__mark" aria-hidden="true">${props.iconHtml ?? escapeHtml(props.initial ?? '')}</span><span class="v2-cell-lead__text"><span${props.mono ? ' class="v2-mono"' : ''}>${escapeHtml(props.title)}</span>${props.meta ? `<span${props.mono ? ' class="v2-mono"' : ''}>${escapeHtml(props.meta)}</span>` : ''}</span></div>`
