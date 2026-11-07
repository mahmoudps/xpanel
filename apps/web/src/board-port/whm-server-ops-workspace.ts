import { type Locale, translator } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { SERVER_OPS_API, SERVER_OPS_CARDS, type ServerOpsCardId, type ServerOpsField } from '@xpanel/core'

/** Classic cards of the server operation tools; controls stay disabled and inert until the client has read their state. */
export function renderWhmServerOpsCards(input: { ids: readonly ServerOpsCardId[]; locale: Locale; canManage: boolean }): string {
  const t = (copy: string): string => escapeHtml(translator(input.locale)(copy))
  const control = (id: string, field: ServerOpsField): string => {
    const name = `name="${escapeHtml(field.name)}"`, key = `whm-ops-${id}-${field.name}`
    const help = field.help ? `<p class="xp-help">${t(field.help)}</p>` : ''
    if (field.kind === 'check') return `<label class="xp-whm-detail-choice"><input id="${key}" type="checkbox" ${name} disabled> ${t(field.label)}</label>${help}`
    const body = field.kind === 'select'
      ? `<select id="${key}" ${name} disabled>${(field.choices ?? []).map(([value, label]) => `<option value="${escapeHtml(value)}">${t(label)}</option>`).join('')}</select>`
      : `<input id="${key}" type="text" ${name}${field.technical ? ' dir="ltr" spellcheck="false"' : ''}${field.maxLength ? ` maxlength="${field.maxLength}"` : ''}${field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : ''} autocomplete="off" disabled>`
    return `<div class="xp-whm-detail-field"><label for="${key}">${t(field.label)}</label>${body}${help}</div>`
  }
  return input.ids.map(id => {
    const card = SERVER_OPS_CARDS[id]
    const table = card.columns ? `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(card.title)}"><table class="xp-whm-detail-table"><caption class="sr-only">${t(card.title)}</caption><thead><tr>${card.columns.map(title => `<th scope="col">${t(title)}</th>`).join('')}</tr></thead><tbody data-server-ops-rows><tr><td colspan="${card.columns.length}">${t(msgid('Not read'))}</td></tr></tbody></table></div>` : ''
    const fields = card.fields.length ? `<div class="xp-whm-detail-fields">${card.fields.map(field => control(id, field)).join('')}</div>` : ''
    const job = card.jobLink ? `<a class="xp-btn" href="/whm/jobs" data-server-ops-job hidden>${t(msgid('Open job'))}</a>` : ''
    return `<section class="xp-whm-detail-card" data-whm-detail-section="server-ops-${id}" aria-labelledby="whm-detail-server-ops-${id}"><h2 id="whm-detail-server-ops-${id}">${t(card.title)}</h2><div class="xp-form-group" role="group" aria-labelledby="whm-detail-server-ops-${id}" data-server-ops="${id}" data-server-ops-api="${SERVER_OPS_API[id]}" data-server-ops-can-manage="${input.canManage}"><p class="xp-help">${t(card.lede)}</p>${fields}${table}<p class="xp-whm-detail-status" data-server-ops-status data-state="unread" role="status">${t(msgid('Not read'))}</p><div class="xp-whm-detail-actions"><button type="button" class="xp-btn${card.danger ? ' xp-btn--danger' : ' xp-btn--primary'}" data-server-ops-submit disabled>${t(card.submit)}</button>${job}</div></div></section>`
  }).join('')
}
