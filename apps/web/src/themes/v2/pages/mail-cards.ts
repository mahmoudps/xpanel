import type { MailCard, MailCardField } from '../../../mail-cards.ts'
import { localeDirection, type Locale } from '../../../i18n.ts'
import { card as surface } from '../components/card.ts'
import { formField } from '../components/form-field.ts'
import { escapeHtml, xpTemplate } from '../html.ts'

export const V2_MAIL_CARD_CSS = `.v2-mail-cards{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0;text-align:start}
.v2-mail-card{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-mail-card :is(p,dl,dd){margin:0}
.v2-mail-card__fields,.v2-mail-card__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:var(--space-2);min-inline-size:0}
.v2-mail-card__facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-mail-card__facts dt{font-size:13px;font-weight:600;color:var(--text-2)}
.v2-mail-card__facts dd{overflow-wrap:anywhere}
.v2-mail-card__actions{display:flex;flex-wrap:wrap;gap:var(--space-1)}
.v2-mail-card__scroll{overflow-x:auto;min-inline-size:0}
.v2-mail-card__list{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(180px,100%),1fr));gap:var(--space-1);max-block-size:320px;overflow-y:auto}
.v2-mail-card__check{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-mail-card [hidden]{display:none!important}
`

const control = (card: MailCard, field: MailCardField): string => {
  const id = `mail-card-${card.id}-${field.key}`, hooks = { 'data-mail-card-field': field.key }, disabled = !card.canRead
  if (field.kind === 'check') return `<label class="v2-mail-card__check" for="${id}"><input id="${id}" type="checkbox" data-mail-card-field="${field.key}"${disabled ? ' disabled' : ''}><span>${escapeHtml(field.label)}</span></label>`
  if (field.kind === 'select') return formField({ id, label: field.label, ...(field.help ? { help: field.help } : {}), control: { kind: 'select', disabled, hooks, options: (field.options ?? []).map(([value, label]) => ({ value, label })) } })
  if (field.kind === 'lines') return formField({ id, label: field.label, ...(field.help ? { help: field.help } : {}), control: { kind: 'textarea', rows: 5, dir: 'ltr', mono: true, spellcheck: false, disabled, hooks } })
  if (field.kind === 'file') return `<div class="v2-field"><label for="${id}">${escapeHtml(field.label)}</label><input id="${id}" type="file" data-mail-card-field="${field.key}"${field.accept ? ` accept="${escapeHtml(field.accept)}"` : ''}${disabled ? ' disabled' : ''}>${field.help ? `<p class="v2-field__help">${escapeHtml(field.help)}</p>` : ''}</div>`
  return formField({ id, label: field.label, ...(field.help ? { help: field.help } : {}), control: { kind: 'input', type: field.kind, ...(field.ltr ? { dir: 'ltr' as const } : {}), autocomplete: 'off', spellcheck: false, disabled, hooks,
    ...(field.min === undefined ? {} : { min: field.min }), ...(field.max === undefined ? {} : { max: field.max }), ...(field.accept ? { accept: field.accept } : {}) } })
}

/** The v2 theme's cards over the same view model and hooks as the classic theme. */
export function renderV2MailCards(cards: readonly MailCard[], locale: Locale): string {
  if (!cards.length) return ''
  return `<div class="v2-mail-cards" lang="${locale}" dir="${localeDirection(locale)}">${cards.map(card => {
    const interactive = card.fields.length + card.tables.length + card.actions.length > 0
    const body = `<div class="v2-mail-card"${interactive ? ` data-mail-card="${card.id}" data-mail-card-can-read="${card.canRead}" data-mail-card-can-act="${card.canAct}"` : ''}>
<p>${escapeHtml(card.lede)}</p>
${card.fields.length ? `<div class="v2-mail-card__fields">${card.fields.map(field => control(card, field)).join('')}</div>` : ''}
${card.list ? `<div class="v2-mail-card__list" role="group" aria-label="${escapeHtml(card.list.label)}" data-mail-card-list="${card.list.key}"></div>` : ''}
${card.actions.length ? `<div class="v2-mail-card__actions">${card.actions.map(action => `<button type="button" class="v2-btn${action.tone ? ` v2-btn--${action.tone}` : ''}" data-mail-card-action="${action.key}"${action.write ? ' data-mail-card-write' : ''} disabled>${escapeHtml(action.label)}</button>`).join('')}</div>` : ''}
${interactive ? `<p data-mail-card-status data-state="unread" role="status">${escapeHtml(card.unread)}</p>` : ''}
${card.facts.length ? `<dl class="v2-mail-card__facts">${card.facts.map(([key, label]) => `<div><dt>${escapeHtml(label)}</dt><dd data-mail-card-fact="${key}"></dd></div>`).join('')}</dl>` : ''}
${card.tables.map(table => `<div class="v2-mail-card__scroll" role="region" tabindex="0" aria-label="${escapeHtml(table.caption)}"><table class="v2-table"><caption class="v2-sr">${escapeHtml(table.caption)}</caption><thead><tr>${table.columns.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody data-mail-card-rows="${table.key}"></tbody></table></div>${xpTemplate(`mail-card-${table.key}`, `<tr>${table.slots.map(slot => `<td data-xp-slot="${slot}"></td>`).join('')}</tr>`)}`).join('')}
${card.notes.map(note => `<p>${escapeHtml(note)}</p>`).join('')}
${interactive ? xpTemplate('mail-card-button', '<button type="button" class="v2-btn" data-xp-slot="content" disabled></button>') + xpTemplate('mail-card-link', '<a data-xp-slot="content"></a>') + xpTemplate('mail-card-select', '<select data-xp-slot="content" disabled></select>') + xpTemplate('mail-card-check', '<label class="v2-mail-card__check"><input type="checkbox" data-xp-slot="control" disabled><span data-xp-slot="label"></span></label>') : ''}
</div>`
    return surface({ title: card.title, titleId: `v2-mail-card-${card.id}`, bodyHtml: body })
  }).join('')}</div>`
}
