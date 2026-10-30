import type { Translate } from '../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'

export interface BulkBarProps {
  /** Selection summary, such as "2 selected". */
  countLabel: string
  actions: readonly { label: string; tone?: 'warn' | 'bad'; href?: string; hooks?: HookAttributes }[]
  /** Hooks of the controller that clears the selection; without them no Clear button is shown. */
  clear?: HookAttributes
  /** Hidden until rows are selected; the selection controller toggles `hidden`. */
  hidden?: boolean
  hooks?: HookAttributes
}

export function bulkBar(t: Translate, props: BulkBarProps): string {
  const actions = props.actions.map(action => {
    const cls = `v2-btn${action.tone ? ` v2-bulk__${action.tone}` : ''}`
    return action.href
      ? `<a class="${cls}" href="${escapeHtml(action.href)}"${hookAttrs(action.hooks)}>${escapeHtml(action.label)}</a>`
      : `<button type="button" class="${cls}"${hookAttrs(action.hooks)}>${escapeHtml(action.label)}</button>`
  }).join('')
  const clear = props.clear ? `<button type="button" class="v2-btn v2-btn--ghost"${hookAttrs(props.clear)}>${escapeHtml(t('Clear'))}</button>` : ''
  return `<div class="v2-bulk" role="region" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Bulk actions')))}"${props.hidden ? ' hidden' : ''}${hookAttrs(props.hooks)}><span class="v2-bulk__count v2-num" role="status">${escapeHtml(props.countLabel)}</span><span class="v2-bulk__actions">${actions}${clear}</span></div>`
}

export const BULK_BAR_CSS = `.v2-bulk{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1) var(--space-2);padding:var(--space-1) var(--space-2);background:var(--accent-soft);border-block:1px solid var(--accent-line)}
.v2-bulk__count{font-size:13px;font-weight:600;color:var(--accent)}
.v2-bulk__actions{display:inline-flex;flex-wrap:wrap;gap:var(--space-1)}
.v2-bulk .v2-btn{font-size:13px;padding:0 14px}
.v2-bulk .v2-bulk__warn{border-color:var(--warn-line);color:var(--warn)}
.v2-bulk .v2-bulk__bad{border-color:var(--bad-line);color:var(--bad)}
`
