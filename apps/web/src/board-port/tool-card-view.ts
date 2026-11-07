import { type Locale, type MessageValues, translator } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import type { ToolBlock, ToolCard, ToolField, ToolHooks } from '../models/tool-cards.ts'

/** The classic skin of the shared runtime, developer and panel-data cards; every control waits for its controller. */
const hooks = (value: ToolHooks): string => Object.entries(value).map(([name, item]) => item === true ? ' ' + name : ` ${name}="${escapeHtml(item)}"`).join('')
type Text = (message: string, values?: MessageValues) => string
const field = (t: Text, item: ToolField): string => {
  const id = escapeHtml(item.id), label = t(item.label)
  if (item.kind === 'check') return `<label class="xp-check"><input id="${id}" type="checkbox"${hooks(item.hooks)} disabled> ${label}</label>`
  const help = 'help' in item && item.help ? `<p class="xp-help" id="${id}-help">${t(item.help)}</p>` : ''
  const described = 'help' in item && item.help ? ` aria-describedby="${id}-help"` : ''
  const ltr = 'ltr' in item && item.ltr ? ' dir="ltr"' : ''
  const control = item.kind === 'select' ? `<select class="xp-select" id="${id}"${hooks(item.hooks)}${described} disabled>${item.options.map(([value, text]) => `<option value="${escapeHtml(value)}">${t(text)}</option>`).join('')}</select>`
    : item.kind === 'area' ? `<textarea class="xp-input" id="${id}" rows="${item.rows ?? 3}"${ltr}${hooks(item.hooks)}${described} spellcheck="false" disabled></textarea>`
      : item.kind === 'file' ? `<input class="xp-input" id="${id}" type="file"${item.accept ? ` accept="${escapeHtml(item.accept)}"` : ''}${hooks(item.hooks)} disabled>`
        : `<input class="xp-input" id="${id}" type="${escapeHtml(item.type ?? 'text')}"${ltr}${item.placeholder ? ` placeholder="${escapeHtml(item.placeholder)}"` : ''} autocomplete="${escapeHtml(item.autocomplete ?? 'off')}"${hooks(item.hooks)}${described} disabled>`
  return `<div class="xp-whm-detail-field"><label for="${id}">${label}</label>${control}${help}</div>`
}
const block = (t: Text, item: ToolBlock): string => {
  switch (item.kind) {
    case 'note': return `<p class="xp-help">${t(item.text)}</p>`
    case 'warning': return `<p class="xp-whm-detail-status" data-state="failed" role="note">${t(item.text)}</p>`
    case 'facts': return `<dl class="xp-whm-detail-fields">${item.rows.map(row => `<div class="xp-whm-detail-field"><dt>${t(row.label)}</dt><dd${hooks(row.hooks)}${row.technical ? ' dir="ltr"' : ''}>${t('Not read')}</dd></div>`).join('')}</dl>`
    case 'fields': return `<div class="xp-whm-detail-fields">${item.fields.map(entry => field(t, entry)).join('')}</div>`
    case 'table': return `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(item.label)}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t(item.label)}</caption><thead><tr>${item.columns.map(name => `<th scope="col">${t(name)}</th>`).join('')}</tr></thead><tbody${hooks(item.hooks)}><tr><td colspan="${item.columns.length}">${t(item.empty)}</td></tr></tbody></table></div>`
    case 'actions': return `<div class="xp-whm-detail-actions">${item.buttons.map(button => `<button type="button" class="xp-btn${button.primary ? ' xp-btn--primary' : ''}${button.danger ? ' xp-btn--danger' : ''}"${hooks(button.hooks)} disabled>${t(button.label)}</button>`).join('')}</div>`
    case 'status': return `<p class="xp-whm-detail-status" role="status" data-state="unread"${hooks(item.hooks)}>${t(item.text)}</p>`
    case 'output': return `<pre class="xp-whm-detail-scroll" tabindex="0" dir="ltr" aria-label="${t(item.label)}"${hooks(item.hooks)}${item.hidden ? ' hidden' : ''}></pre>`
    case 'tree': return `<div${hooks(item.hooks)} dir="ltr"></div>`
  }
}
export function renderToolCard(input: { locale: Locale; canManage: boolean }, spec: ToolCard): string {
  const translate = translator(input.locale), t: Text = (message, values) => escapeHtml(translate(message, values))
  return `<section class="xp-whm-detail-card" aria-labelledby="whm-tool-${spec.id}"${hooks(spec.root)} data-tool-can-manage="${input.canManage}"><h2 id="whm-tool-${spec.id}">${t(spec.title)}</h2>${spec.blocks.map(item => block(t, item)).join('')}</section>`
}
