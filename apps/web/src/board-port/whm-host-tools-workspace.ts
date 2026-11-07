import { type Locale, translator } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { HOST_TOOL_CARDS, hostToolSpec, type HostToolCardId, type HostToolField } from '@xpanel/core'

const STYLE = '<style>[data-host-tool] [hidden]{display:none!important}[data-host-tool] textarea{inline-size:100%;min-block-size:96px;box-sizing:border-box;font-family:var(--xp-font-mono)}[data-host-tool] pre[data-host-tool-log]{max-block-size:320px;overflow:auto;margin:0;padding:16px;border:1px solid var(--xp-border);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}[data-host-tool] code[data-host-tool-reveal]{display:block;overflow-wrap:anywhere}[data-host-tool-row-actions]{display:flex;flex-wrap:wrap;gap:8px}@media(max-width:600px){[data-host-tool] .xp-whm-detail-scroll{overflow:visible}[data-host-tool] .xp-whm-detail-table{min-inline-size:0}[data-host-tool] .xp-whm-detail-table thead{display:none}[data-host-tool] .xp-whm-detail-table tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 16px;padding:16px 0}[data-host-tool] .xp-whm-detail-table td{padding:0}[data-host-tool] .xp-whm-detail-table td:nth-child(n+3){grid-column:1}[data-host-tool] .xp-whm-detail-table td:is([colspan],:has([data-host-tool-row-actions])){grid-column:1/-1}}</style>'

/** Classic cards of the scheduler and host tools; controls stay disabled and inert until the client has read their state. */
export function renderWhmHostToolCards(input: { ids: readonly HostToolCardId[]; locale: Locale; canManage: boolean }): string {
  const translate = translator(input.locale), t = (copy: string): string => escapeHtml(translate(copy))
  const control = (id: string, field: HostToolField): string => {
    const name = `name="${escapeHtml(field.name)}"`, key = `whm-tool-${id}-${field.name}`, help = field.help ? `<p class="xp-help">${t(field.help)}</p>` : ''
    const when = field.when ? ` data-host-tool-when="${escapeHtml(`${field.when[0]}:${field.when[1].join(',')}`)}"` : ''
    if (field.kind === 'check') return `<div${when}><label class="xp-whm-detail-choice"><input id="${key}" type="checkbox" ${name} disabled> ${t(field.label)}</label>${help}</div>`
    const body = field.kind === 'select'
      ? `<select id="${key}" ${name}${field.from ? ` data-host-tool-from="${field.from}"` : ''} disabled>${(field.choices ?? []).map(([value, label]) => `<option value="${escapeHtml(value)}">${t(label)}</option>`).join('')}</select>`
      : field.kind === 'area'
        ? `<textarea id="${key}" ${name} rows="4" dir="ltr" spellcheck="false" autocomplete="off"${field.maxLength ? ` maxlength="${field.maxLength}"` : ''} disabled></textarea>`
        : `<input id="${key}" type="${field.kind === 'password' ? 'password' : 'text'}" ${name}${field.technical || field.kind === 'password' ? ' dir="ltr" spellcheck="false"' : ''}${field.maxLength ? ` maxlength="${field.maxLength}"` : ''}${field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : ''} autocomplete="${field.kind === 'password' ? 'new-password' : 'off'}" disabled>`
    return `<div class="xp-whm-detail-field"${when}><label for="${key}">${t(field.label)}</label>${body}${help}</div>`
  }
  return STYLE + input.ids.map(id => {
    const card = HOST_TOOL_CARDS[id], columns = card.columns ?? []
    const table = columns.length ? `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(card.title)}"><table class="xp-whm-detail-table"><caption class="sr-only">${t(card.title)}</caption><thead><tr>${columns.map(([title]) => `<th scope="col">${t(title)}</th>`).join('')}${card.actions?.length ? `<th scope="col">${t(msgid('Actions'))}</th>` : ''}</tr></thead><tbody data-host-tool-rows><tr><td colspan="${columns.length + (card.actions?.length ? 1 : 0)}">${t(msgid('Not read'))}</td></tr></tbody></table></div>` : ''
    const facts = card.facts?.length ? `<dl class="xp-whm-detail-fields">${card.facts.map(([key, label]) => `<div><dt>${t(label)}</dt><dd><bdi dir="ltr" data-host-tool-fact="${escapeHtml(key)}">${t(msgid('Not read'))}</bdi></dd></div>`).join('')}</dl>` : ''
    const fields = card.fields.length ? `<div class="xp-whm-detail-fields" data-host-tool-fields>${card.fields.map(field => control(id, field)).join('')}</div>` : ''
    const tools = (card.tools ?? []).map(([label, path]) => `<button type="button" class="xp-btn" data-host-tool-tool="${escapeHtml(path)}" disabled>${t(label)}</button>`).join('')
    const link = card.link ? `<a class="xp-btn" href="${escapeHtml(card.link[0])}">${t(card.link[1])}</a>` : ''
    const submit = card.submit ? `<button type="button" class="xp-btn${card.danger ? ' xp-btn--danger' : ' xp-btn--primary'}" data-host-tool-submit disabled>${t(card.submit)}</button><button type="button" class="xp-btn" data-host-tool-cancel hidden disabled>${t(msgid('Cancel'))}</button>` : ''
    const job = card.jobLink ? `<a class="xp-btn" href="/whm/jobs" data-host-tool-job hidden>${t(msgid('Open job'))}</a>` : ''
    return `<section class="xp-whm-detail-card" data-whm-detail-section="host-tool-${id}" aria-labelledby="whm-detail-host-tool-${id}"><h2 id="whm-detail-host-tool-${id}">${t(card.title)}</h2><div class="xp-form-group" role="group" aria-labelledby="whm-detail-host-tool-${id}" data-host-tool="${id}" data-host-tool-api="${escapeHtml(card.api)}" data-host-tool-can-manage="${input.canManage}" data-host-tool-spec="${escapeHtml(hostToolSpec(card, translate))}"><p class="xp-help">${t(card.lede)}</p>${facts}${table}${fields}<p class="xp-whm-detail-status" role="status" data-state="unread" data-host-tool-status>${t(msgid('Not read'))}</p><code data-host-tool-reveal dir="ltr" hidden></code><div class="xp-whm-detail-actions">${submit}${tools}${job}${link}</div>${card.log ? `<pre data-host-tool-log dir="ltr" tabindex="0" hidden></pre>` : ''}</div></section>`
  }).join('')
}
