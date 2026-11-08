import { translator } from '../i18n.ts'
import type { Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

const off = (connected: boolean) => connected ? '' : ' disabled'

/** Classic held message table of one list; the controller fills it after the surface's own sign-in. */
export function renderClassicModerationQueue(locale: Locale): string {
  const t = (message: string) => escapeHtml(translator(locale)(message))
  return `<div class="xp-list-moderation__queue" data-moderation-queue><style>.xp-list-moderation__queue{display:grid;gap:var(--xp-space-field);min-inline-size:0}.xp-list-moderation__message{max-block-size:24rem;margin:0;padding:var(--xp-space-field);overflow:auto;border:1px solid var(--xp-border);border-radius:var(--xp-radius-sm);background:var(--xp-bg-surface);white-space:pre-wrap;overflow-wrap:anywhere}</style><p class="xp-help" data-moderation-status role="status"></p>`
    + `<div class="xp-table-wrap" tabindex="0" role="region" aria-label="${t(msgid('Moderation queue'))}"><table class="xp-table"><thead><tr><th scope="col"><span class="xp-sr-only">${t(msgid('Select'))}</span></th><th scope="col">${t(msgid('Message'))}</th><th scope="col">${t(msgid('Reason'))}</th><th scope="col">${t(msgid('Action'))}</th></tr></thead><tbody data-moderation-rows></tbody></table></div>`
    + `<div class="xp-field"><label for="list-moderation-reason">${t(msgid('Rejection reason sent to the sender (optional)'))}</label><input id="list-moderation-reason" class="xp-input" maxlength="500" autocomplete="off" data-moderation-reason disabled></div>`
    + `<div class="xp-mailing-lists__actions"><button type="button" class="xp-btn xp-btn--primary" data-moderation-approve disabled>${t(msgid('Approve'))}</button><button type="button" class="xp-btn" data-moderation-reject disabled>${t(msgid('Reject'))}</button><button type="button" class="xp-btn" data-moderation-discard disabled>${t(msgid('Discard'))}</button></div>`
    + `<pre class="xp-list-moderation__message" dir="ltr" tabindex="0" data-moderation-message hidden></pre>`
    + `<template data-xp-template="list-moderation-row"><tr><td><input type="checkbox" data-xp-slot="select"></td><td><bdi dir="ltr" class="xp-mono" data-xp-slot="from"></bdi><br><span data-xp-slot="subject"></span></td><td><span data-xp-slot="reason"></span><br><bdi dir="ltr" data-xp-slot="at"></bdi></td><td><button type="button" class="xp-btn" data-xp-slot="open" disabled></button></td></tr></template></div>`
}

/** Classic xPanel: who may post to one list, its sender rules, and its queue. */
export function renderClassicListModerationSection(locale: Locale, connected: boolean): string {
  const t = (message: string) => escapeHtml(translator(locale)(message))
  const dis = off(connected)
  const field = (id: string, label: string, control: string) => `<div class="xp-field"><label for="${id}">${label}</label>${control}</div>`
  const pick = (id: string, hook: string, options: readonly (readonly [string, string])[]) => `<select id="${id}" class="xp-select" ${hook}${dis}>${options.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>`
  const area = (id: string, hook: string, label: string) => field(id, label, `<textarea id="${id}" class="xp-textarea xp-mono" dir="ltr" rows="3" ${hook}${dis}></textarea>`)
  const number = (id: string, hook: string, label: string, max: number) => field(id, label, `<input id="${id}" class="xp-input" type="number" min="0" max="${max}" dir="ltr" ${hook}${dis}>`)
  const check = (id: string, hook: string, label: string) => `<label class="xp-check" for="${id}"><input id="${id}" type="checkbox" ${hook}${dis}> ${label}</label>`
  const actions = [['hold', t(msgid('Hold for review'))], ['reject', t(msgid('Reject with a notice'))], ['discard', t(msgid('Discard silently'))]] as const
  return `<section class="xp-card xp-mailing-lists__form xp-list-moderation" aria-labelledby="list-moderation-heading" data-list-moderation data-moderation-can-manage="${connected}"><style>.xp-list-moderation__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr));gap:var(--xp-space-field);min-inline-size:0}</style>`
    + `<h2 id="list-moderation-heading">${t(msgid('Posting moderation'))}</h2><p class="xp-help">${t(msgid('Choose who may post. Posts the rules stop wait here until a moderator approves, rejects or discards them. The check runs as this account when mail arrives, and a list without rules stays a plain alias.'))}</p>`
    + `<div class="xp-list-moderation__grid">${field('list-moderation-list', t(msgid('List')), `<select id="list-moderation-list" class="xp-select xp-mono" dir="ltr" data-moderation-list${dis}></select>`)}`
    + `${field('list-moderation-posting', t(msgid('Moderation')), pick('list-moderation-posting', 'data-moderation-posting', [['open', t(msgid('Open'))], ['members', t(msgid('Members'))], ['moderated', t(msgid('Moderated'))]]))}`
    + `${field('list-moderation-subscription', t(msgid('Self subscription')), pick('list-moderation-subscription', 'data-moderation-subscription', [['closed', t(msgid('Closed'))], ['open', t(msgid('Open'))]]))}`
    + `${field('list-moderation-non-member', t(msgid('Posts from non-members')), pick('list-moderation-non-member', 'data-moderation-non-member', actions))}`
    + `${field('list-moderation-member', t(msgid('Posts from moderated members')), pick('list-moderation-member', 'data-moderation-member', actions))}`
    + `${number('list-moderation-size', 'data-moderation-size', t(msgid('Hold messages larger than (KB, 0 for no limit)')), 1048576)}${number('list-moderation-retention', 'data-moderation-retention', t(msgid('Remove held messages after (days, 0 to keep)')), 365)}</div>`
    + `<div class="xp-list-moderation__grid">${area('list-moderation-moderators', 'data-moderation-moderators', t(msgid('Moderators (one address per line)')))}${area('list-moderation-moderated', 'data-moderation-moderated', t(msgid('Moderated members (one address per line)')))}`
    + `${area('list-moderation-accept', 'data-moderation-accept', t(msgid('Always accept from')))}${area('list-moderation-hold', 'data-moderation-hold', t(msgid('Always hold from')))}${area('list-moderation-reject', 'data-moderation-reject-senders', t(msgid('Always reject from')))}${area('list-moderation-discard', 'data-moderation-discard-senders', t(msgid('Always discard from')))}</div>`
    + `<p class="xp-help">${t(msgid('Sender rules take one address per line, where * and ? match any text, and apply to non-members. A moderator mailbox of this account opens the queue from webmail with its own sign-in.'))}</p>`
    + `<div class="xp-list-moderation__grid">${check('list-moderation-notify-moderators', 'data-moderation-notify-moderators', t(msgid('Tell moderators about each held message')))}${check('list-moderation-notify-sender', 'data-moderation-notify-sender', t(msgid('Tell senders their message is held')))}</div>`
    + `<div class="xp-mailing-lists__actions"><button type="button" class="xp-btn xp-btn--primary" data-moderation-save${dis}>${t(msgid('Save posting policy'))}</button></div>`
    + `<dl class="xp-extension__facts"><div class="xp-extension__fact"><dt>${t(msgid('Moderation queue'))}</dt><dd data-moderation-state>${t(msgid('Not read'))}</dd></div><div class="xp-extension__fact"><dt>${t(msgid('Held messages'))}</dt><dd data-moderation-held>${t(msgid('Not read'))}</dd></div></dl>`
    + `${renderClassicModerationQueue(locale)}</section>`
}
