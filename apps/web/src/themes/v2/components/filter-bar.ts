import { attr, escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { icon } from '../icons.ts'

export interface FilterSelect {
  id: string
  label: string
  name?: string
  options: readonly { value: string; label: string; selected?: boolean }[]
  hooks?: HookAttributes
}

export interface FilterBarProps {
  search?: { id: string; label: string; placeholder?: string; name?: string; value?: string; hooks?: HookAttributes }
  /** Applied filters; each removes itself. `removeLabel` names the action, such as "Remove filter Owner: reseller1". */
  chips?: readonly { label: string; removeLabel: string; hooks?: HookAttributes }[]
  selects?: readonly FilterSelect[]
  /** Segmented quick filters with optional counts; in a bar of fields the label also shows above the group. */
  segments?: { label: string; options: readonly { label: string; count?: number; pressed: boolean; hooks?: HookAttributes }[] }
  clear?: { label: string; hooks?: HookAttributes }
  /** Trailing actions built with the kit, such as "Columns" or "Export CSV". */
  actionsHtml?: string
  /** The bar's own controls are disabled, such as while the list has not been read; `actionsHtml` is the caller's. */
  disabled?: boolean
  hooks?: HookAttributes
}

// A bar with a search or a select is a row of labelled fields: each label sits 8px above its 44px control, as on
// the boards. A bar of segments alone (quick filters in a card header) names its group with aria-label.
const field = (cls: string, labelHtml: string, controlHtml: string): string => `<div class="v2-filter__field ${cls}">${labelHtml}${controlHtml}</div>`

const select = (item: FilterSelect, off: string): string =>
  field('v2-filter__select', `<label class="v2-filter__label" for="${escapeHtml(item.id)}">${escapeHtml(item.label)}</label>`, `<span class="v2-select"><select id="${escapeHtml(item.id)}"${attr('name', item.name)}${hookAttrs(item.hooks)}${off}>${item.options.map(option => `<option value="${escapeHtml(option.value)}"${option.selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select>${icon('chevDown', 16)}</span>`)

export function filterBar(props: FilterBarProps): string {
  const off = props.disabled ? ' disabled' : ''
  const fields = Boolean(props.search || props.selects?.length)
  const search = props.search
    ? field('v2-filter__search', `<label class="v2-filter__label" for="${escapeHtml(props.search.id)}">${escapeHtml(props.search.label)}</label>`, `<span class="v2-filter__input">${icon('search', 16)}<input id="${escapeHtml(props.search.id)}" type="search" autocomplete="off" spellcheck="false"${attr('name', props.search.name)}${attr('placeholder', props.search.placeholder)}${attr('value', props.search.value)}${hookAttrs(props.search.hooks)}${off}></span>`) : ''
  const chips = (props.chips ?? []).map(chip => `<button type="button" class="v2-chip v2-chip--applied" aria-label="${escapeHtml(chip.removeLabel)}"${hookAttrs(chip.hooks)}${off}>${escapeHtml(chip.label)}${icon('x', 12)}</button>`).join('')
  const segmentButtons = props.segments?.options.map(option => `<button type="button" aria-pressed="${option.pressed}"${hookAttrs(option.hooks)}${off}>${escapeHtml(option.label)}${option.count === undefined ? '' : `<span class="v2-count v2-num">${option.count}</span>`}</button>`).join('') ?? ''
  const segments = !props.segments ? ''
    : `<div class="v2-segmented" role="group" aria-label="${escapeHtml(props.segments.label)}">${segmentButtons}</div>`
  const group = fields && segments ? field('v2-filter__group', `<span class="v2-filter__label" aria-hidden="true">${escapeHtml(props.segments!.label)}</span>`, segments) : segments
  const clear = props.clear ? `<button type="button" class="v2-btn v2-btn--ghost v2-filter__clear"${hookAttrs(props.clear.hooks)}${off}>${escapeHtml(props.clear.label)}</button>` : ''
  return `<div class="v2-filter${fields ? ' v2-filter--fields' : ''}"${off ? ' aria-disabled="true"' : ''}${hookAttrs(props.hooks)}>${search}${(props.selects ?? []).map(item => select(item, off)).join('')}${group}${chips}${clear}${props.actionsHtml ? `<div class="v2-filter__actions">${props.actionsHtml}</div>` : ''}</div>`
}

export const FILTER_BAR_CSS = `.v2-filter{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1);padding:12px var(--space-2)}
.v2-filter--fields{align-items:flex-end;gap:var(--space-2);padding:0 var(--v2-panel-padding) 20px}
.v2-filter__field{display:flex;flex-direction:column;gap:var(--space-1);min-width:0}
.v2-filter__label{padding-inline:13px;font-size:13px;line-height:1.25;font-weight:600}
.v2-filter__search{flex:1 1 200px}
.v2-filter__select{flex:0 1 190px}
.v2-filter__select select{inline-size:100%}
.v2-filter__group{flex:0 1 auto}
.v2-filter__input{position:relative;display:block}
.v2-filter__input>.v2-icon{position:absolute;inset-inline-end:14px;top:50%;margin-top:-8px;color:var(--muted);pointer-events:none}
.v2-filter__input>input{inline-size:100%;padding-inline-end:40px}
.v2-filter__clear{padding:0 var(--space-1)}
.v2-filter__actions{display:flex;flex-wrap:wrap;gap:var(--space-1);margin-inline-start:auto}
.v2-chip{display:inline-flex;align-items:center;gap:var(--space-1);min-height:var(--target);padding-block:0;padding-inline:14px 12px;border-radius:var(--radius-pill);border:1px dashed var(--line-strong);background:var(--surface);color:var(--text-2);font-size:13px;cursor:pointer;transition:background-color .14s ease-out,border-color .14s ease-out}
.v2-chip:hover:not(:disabled){border-color:var(--muted);background:var(--subtle);color:var(--text)}
.v2-chip--applied{border-style:solid;border-color:var(--accent-line);background:var(--accent-soft);color:var(--accent);font-weight:600}
.v2-chip--applied:hover:not(:disabled){border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
.v2-segmented{display:inline-flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:var(--radius-control);border:1px solid var(--line);background:var(--sunken)}
.v2-segmented>button{display:inline-flex;align-items:center;gap:6px;min-height:var(--target);min-inline-size:var(--target);padding:0 12px;border:0;border-radius:var(--radius-chip);background:transparent;color:var(--muted);font-size:13px;font-weight:600;cursor:pointer;transition:background-color .14s ease-out,color .14s ease-out}
.v2-segmented>button:hover:not(:disabled){color:var(--text)}
.v2-segmented>button[aria-pressed="true"]{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.v2-segmented>button[aria-pressed="true"] .v2-count{background:var(--accent-soft);color:var(--accent)}
.v2-filter :is(.v2-chip,.v2-segmented>button):disabled{opacity:.55;cursor:not-allowed}
.v2-count{padding:1px 7px;border-radius:var(--radius-pill);background:var(--surface);color:var(--text-2);font-size:12px;font-weight:600;line-height:1.4}
`
