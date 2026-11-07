import { escapeHtml } from '../tokens.ts'
import { localeDirection, type Locale } from '../i18n.ts'
import type { MailCard, MailCardField } from '../mail-cards.ts'

const styles = `<style>.xp-mail-cards{display:flex;flex-direction:column;gap:32px;min-inline-size:0;text-align:start}.xp-mail-card{display:flex;flex-direction:column;gap:24px;padding:24px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:12px;background:var(--xp-bg-surface)}.xp-mail-card :is(h2,p,dl,dd){margin:0}.xp-mail-card :is(dt,.xp-mail-card__fields>div:not(.xp-mail-card__check)>label){font-size:var(--xp-type-label);line-height:var(--xp-leading-label)}.xp-mail-card__fields,.xp-mail-card__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:16px;min-inline-size:0}.xp-mail-card__fields>div,.xp-mail-card__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-mail-card__facts dd{overflow-wrap:anywhere}.xp-mail-card__actions{display:flex;flex-wrap:wrap;gap:8px}.xp-mail-card__scroll{overflow-x:auto;min-inline-size:0}.xp-mail-card__list{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(180px,100%),1fr));gap:8px;max-block-size:320px;overflow-y:auto}.xp-mail-card__check,.xp-mail-card__check>label{display:flex;align-items:center;gap:8px;min-block-size:44px}.xp-mail-card [hidden]{display:none!important}@media(max-width:640px){.xp-mail-card{padding:16px}}</style>`

const control = (card: MailCard, field: MailCardField): string => {
  const id = `mail-card-${card.id}-${field.key}`, off = card.canRead ? '' : ' disabled', ltr = field.ltr ? ' dir="ltr"' : ''
  const help = field.help ? `<p class="xp-help">${escapeHtml(field.help)}</p>` : ''
  if (field.kind === 'check') return `<div class="xp-mail-card__check"><input type="checkbox" id="${id}" data-mail-card-field="${field.key}"${off}><label for="${id}">${escapeHtml(field.label)}</label>${help}</div>`
  const input = field.kind === 'select' ? `<select class="xp-select" id="${id}" data-mail-card-field="${field.key}"${off}>${(field.options ?? []).map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('')}</select>`
    : field.kind === 'lines' ? `<textarea class="xp-textarea" id="${id}" rows="5" spellcheck="false" data-mail-card-field="${field.key}"${ltr}${off}></textarea>`
      : `<input class="xp-input" id="${id}" type="${field.kind}" autocomplete="off" spellcheck="false" data-mail-card-field="${field.key}"${ltr}${field.min === undefined ? '' : ` min="${field.min}"`}${field.max === undefined ? '' : ` max="${field.max}"`}${field.accept ? ` accept="${escapeHtml(field.accept)}"` : ''}${off}>`
  return `<div><label for="${id}">${escapeHtml(field.label)}</label>${input}${help}</div>`
}
const template = (name: string, html: string): string => `<template data-xp-template="${name}">${html}</template>`

/** The classic theme's cards. Nothing here is styled by a controller: rows and inline controls come from these templates. */
export function renderClassicMailCards(cards: readonly MailCard[], locale: Locale): string {
  if (!cards.length) return ''
  return `${styles}<div class="xp-mail-cards" lang="${locale}" dir="${localeDirection(locale)}">${cards.map(card => {
    const heading = `mail-card-${card.id}-title`, interactive = card.fields.length + card.tables.length + card.actions.length > 0
    return `<section class="xp-mail-card" aria-labelledby="${heading}"${interactive ? ` data-mail-card="${card.id}" data-mail-card-can-read="${card.canRead}" data-mail-card-can-act="${card.canAct}"` : ''}>
      <h2 id="${heading}">${escapeHtml(card.title)}</h2><p class="xp-help">${escapeHtml(card.lede)}</p>
      ${card.fields.length ? `<div class="xp-mail-card__fields">${card.fields.map(field => control(card, field)).join('')}</div>` : ''}
      ${card.list ? `<div class="xp-mail-card__list" role="group" aria-label="${escapeHtml(card.list.label)}" data-mail-card-list="${card.list.key}"></div>` : ''}
      ${card.actions.length ? `<div class="xp-mail-card__actions">${card.actions.map(action => `<button type="button" class="xp-btn${action.tone === 'primary' ? ' xp-btn--primary' : action.tone === 'danger' ? ' xp-btn--danger' : ''}" data-mail-card-action="${action.key}"${action.write ? ' data-mail-card-write' : ''} disabled>${escapeHtml(action.label)}</button>`).join('')}</div>` : ''}
      ${interactive ? `<p class="xp-whm-detail-status" data-mail-card-status data-state="unread" role="status">${escapeHtml(card.unread)}</p>` : ''}
      ${card.facts.length ? `<dl class="xp-mail-card__facts">${card.facts.map(([key, label]) => `<div><dt>${escapeHtml(label)}</dt><dd data-mail-card-fact="${key}"></dd></div>`).join('')}</dl>` : ''}
      ${card.tables.map(table => `<div class="xp-mail-card__scroll" role="region" tabindex="0" aria-label="${escapeHtml(table.caption)}"><table class="xp-table"><caption class="xp-sr-only">${escapeHtml(table.caption)}</caption><thead><tr>${table.columns.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody data-mail-card-rows="${table.key}"></tbody></table></div>${template(`mail-card-${table.key}`, `<tr>${table.slots.map(slot => `<td data-xp-slot="${slot}"></td>`).join('')}</tr>`)}`).join('')}
      ${card.notes.map(note => `<p class="xp-help">${escapeHtml(note)}</p>`).join('')}
      ${interactive ? template('mail-card-button', '<button type="button" class="xp-btn" data-xp-slot="content" disabled></button>') + template('mail-card-link', '<a data-xp-slot="content"></a>') + template('mail-card-select', '<select class="xp-select" data-xp-slot="content" disabled></select>') + template('mail-card-check', '<label class="xp-mail-card__check"><input type="checkbox" data-xp-slot="control" disabled><span data-xp-slot="label"></span></label>') : ''}
    </section>`
  }).join('')}</div>`
}
