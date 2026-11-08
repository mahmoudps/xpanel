import type { ToolBlock, ToolCard, ToolField, ToolHooks } from '../../models/tool-cards.ts'
import { card } from './components/card.ts'
import { escapeHtml, hookAttrs } from './html.ts'

/** The V2 skin of the shared runtime, developer and panel-data cards; every control waits for its controller. */
export const TOOL_CARD_CSS = `.v2-tool-card__stack{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-tool-card__fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:var(--space-2);min-inline-size:0}
.v2-tool-card__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:var(--space-2);margin:0;min-inline-size:0}
.v2-tool-card__facts dt{font-size:13px;font-weight:600;color:var(--text-2)}
.v2-tool-card__facts dd{margin:0;overflow-wrap:anywhere}
.v2-tool-card__actions{display:flex;flex-wrap:wrap;gap:var(--space-2)}
.v2-tool-card__check{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-tool-card__warning{padding:var(--space-2);border:1px solid var(--bad-line);border-radius:var(--radius-control);color:var(--bad);background:var(--bad-soft)}
.v2-tool-card__table{overflow-x:auto;min-inline-size:0}
.v2-tool-card__table table{inline-size:100%;border-collapse:collapse}
.v2-tool-card__table :is(th,td){padding:var(--space-1) var(--space-2);text-align:start;border-block-end:1px solid var(--line)}
.v2-tool-card__output{margin:0;padding:var(--space-2);max-block-size:320px;overflow:auto;border:1px solid var(--line);border-radius:var(--radius-control);white-space:pre-wrap;overflow-wrap:anywhere}
.v2-tool-card__stack ul{margin:0;padding-inline-start:var(--space-3)}
`

type Translate = (message: string) => string
const hooks = (value: ToolHooks): string => hookAttrs(value)
const field = (t: Translate, item: ToolField): string => {
  const id = escapeHtml(item.id), label = escapeHtml(t(item.label))
  if (item.kind === 'check') return `<label class="v2-tool-card__check"><input id="${id}" type="checkbox"${hooks(item.hooks)} disabled><span>${label}</span></label>`
  const help = 'help' in item && item.help ? `<p id="${id}-help" class="v2-field__help">${escapeHtml(t(item.help))}</p>` : ''
  const described = 'help' in item && item.help ? ` aria-describedby="${id}-help"` : ''
  const ltr = 'ltr' in item && item.ltr ? ' dir="ltr"' : ''
  const control = item.kind === 'select' ? `<select id="${id}"${hooks(item.hooks)}${described} disabled>${item.options.map(([value, text]) => `<option value="${escapeHtml(value)}">${escapeHtml(t(text))}</option>`).join('')}</select>`
    : item.kind === 'area' ? `<textarea id="${id}" rows="${item.rows ?? 3}"${ltr}${hooks(item.hooks)}${described} spellcheck="false" disabled></textarea>`
      : item.kind === 'file' ? `<input id="${id}" type="file"${item.accept ? ` accept="${escapeHtml(item.accept)}"` : ''}${hooks(item.hooks)} disabled>`
        : `<input id="${id}" type="${escapeHtml(item.type ?? 'text')}"${ltr}${item.placeholder ? ` placeholder="${escapeHtml(item.placeholder)}"` : ''} autocomplete="${escapeHtml(item.autocomplete ?? 'off')}"${hooks(item.hooks)}${described} disabled>`
  return `<div class="v2-field"><label for="${id}">${label}</label>${control}${help}</div>`
}
const block = (t: Translate, cardId: string, item: ToolBlock, index: number): string => {
  switch (item.kind) {
    case 'note': return `<p class="v2-muted">${escapeHtml(t(item.text))}</p>`
    case 'warning': return `<p class="v2-tool-card__warning" role="note">${escapeHtml(t(item.text))}</p>`
    case 'facts': return `<dl class="v2-tool-card__facts">${item.rows.map(row => `<div><dt>${escapeHtml(t(row.label))}</dt><dd${hooks(row.hooks)}${row.technical ? ' dir="ltr"' : ''}>${escapeHtml(t(msgid('Not read')))}</dd></div>`).join('')}</dl>`
    case 'fields': return `<div class="v2-tool-card__fields">${item.fields.map(entry => field(t, entry)).join('')}</div>`
    case 'table': { const caption = `v2-${cardId}-table-${index}`; return `<div class="v2-tool-card__table" role="region" tabindex="0" aria-labelledby="${caption}"><table><caption id="${caption}" class="v2-sr">${escapeHtml(t(item.label))}</caption><thead><tr>${item.columns.map(name => `<th scope="col">${escapeHtml(t(name))}</th>`).join('')}</tr></thead><tbody${hooks(item.hooks)}><tr><td colspan="${item.columns.length}">${escapeHtml(t(item.empty))}</td></tr></tbody></table></div>` }
    case 'actions': return `<div class="v2-tool-card__actions">${item.buttons.map(button => `<button type="button" class="v2-btn${button.primary ? ' v2-btn--primary' : ''}${button.danger ? ' v2-btn--danger' : ''}"${hooks(button.hooks)} disabled>${escapeHtml(t(button.label))}</button>`).join('')}</div>`
    case 'status': return `<p role="status" data-state="unread"${hooks(item.hooks)}>${escapeHtml(t(item.text))}</p>`
    case 'output': return `<pre class="v2-tool-card__output" tabindex="0" dir="ltr" aria-label="${escapeHtml(t(item.label))}"${hooks(item.hooks)}${item.hidden ? ' hidden' : ''}></pre>`
    case 'tree': return `<div${hooks(item.hooks)} dir="ltr"></div>`
  }
}
export function renderV2ToolCard(t: Translate, spec: ToolCard, canManage: boolean): string {
  return card({ id: 'v2-' + spec.id, title: t(spec.title), titleId: `v2-${spec.id}-heading`, hooks: { ...spec.root, 'data-tool-can-manage': String(canManage) }, bodyHtml: `<div class="v2-tool-card__stack">${spec.blocks.map((item, index) => block(t, spec.id, item, index)).join('')}</div>` })
}
