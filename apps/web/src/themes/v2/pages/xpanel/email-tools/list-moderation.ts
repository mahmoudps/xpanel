import { escapeHtml } from '../../../html.ts'

type Translate = (message: string) => string
const dis = (connected: boolean) => connected ? '' : ' disabled'
const field = (id: string, label: string, control: string) => `<div class="v2-field"><label for="${id}">${escapeHtml(label)}</label>${control}</div>`

/** v2 held message table of one list; the controller fills it after the surface's own sign-in. */
export function v2ModerationQueue(t: Translate): string {
  const button = (label: string, hook: string, primary = false) => `<button type="button" class="v2-btn${primary ? ' v2-btn--primary' : ''}" ${hook} disabled>${escapeHtml(label)}</button>`
  return `<div class="v2-list-moderation__queue" data-moderation-queue><p data-moderation-status role="status"></p>`
    + `<div class="v2-table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(t(msgid('Moderation queue')))}"><table class="v2-table"><thead><tr><th scope="col"><span class="v2-sr">${escapeHtml(t(msgid('Select')))}</span></th><th scope="col">${escapeHtml(t(msgid('Message')))}</th><th scope="col">${escapeHtml(t(msgid('Reason')))}</th><th scope="col">${escapeHtml(t(msgid('Action')))}</th></tr></thead><tbody data-moderation-rows></tbody></table></div>`
    + field('v2-list-moderation-reason', t(msgid('Rejection reason sent to the sender (optional)')), '<input id="v2-list-moderation-reason" maxlength="500" autocomplete="off" data-moderation-reason disabled>')
    + `<div class="v2-actions">${button(t(msgid('Approve')), 'data-moderation-approve', true)}${button(t(msgid('Reject')), 'data-moderation-reject')}${button(t(msgid('Discard')), 'data-moderation-discard')}</div>`
    + `<pre class="v2-list-moderation__message" dir="ltr" tabindex="0" data-moderation-message hidden></pre>`
    + `<template data-xp-template="list-moderation-row"><tr><td><input type="checkbox" data-xp-slot="select"></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="from"></bdi><br><span data-xp-slot="subject"></span></td><td><span data-xp-slot="reason"></span><br><bdi dir="ltr" data-xp-slot="at"></bdi></td><td><button type="button" class="v2-btn" data-xp-slot="open" disabled></button></td></tr></template></div>`
}

/** v2 xPanel: who may post to one list, its sender rules, and its queue. */
export function v2ListModerationSection(t: Translate, connected: boolean): string {
  const off = dis(connected)
  const pick = (id: string, hook: string, options: readonly (readonly [string, string])[]) => `<select id="${id}" ${hook}${off}>${options.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('')}</select>`
  const area = (id: string, hook: string, label: string) => field(id, label, `<textarea id="${id}" dir="ltr" rows="3" ${hook}${off}></textarea>`)
  const number = (id: string, hook: string, label: string, max: number) => field(id, label, `<input id="${id}" type="number" min="0" max="${max}" dir="ltr" ${hook}${off}>`)
  const check = (id: string, hook: string, label: string) => `<label class="v2-check" for="${id}"><input id="${id}" type="checkbox" ${hook}${off}> ${escapeHtml(label)}</label>`
  const actions = [['hold', t(msgid('Hold for review'))], ['reject', t(msgid('Reject with a notice'))], ['discard', t(msgid('Discard silently'))]] as const
  return `<section class="v2-card" aria-labelledby="v2-list-moderation-heading" data-list-moderation data-moderation-can-read="${connected}" data-moderation-can-manage="${connected}">`
    + `<div class="v2-card__head"><div class="v2-card__title"><h2 id="v2-list-moderation-heading">${escapeHtml(t(msgid('Posting moderation')))}</h2><p>${escapeHtml(t(msgid('Choose who may post. Posts the rules stop wait here until a moderator approves, rejects or discards them. The check runs as this account when mail arrives, and a list without rules stays a plain alias.')))}</p></div></div><div class="v2-card__body v2-list-moderation__stack">`
    + `<div class="v2-list-moderation__grid">${field('v2-list-moderation-list', t(msgid('List')), `<select id="v2-list-moderation-list" dir="ltr" data-moderation-list${off}></select>`)}`
    + field('v2-list-moderation-posting', t(msgid('Moderation')), pick('v2-list-moderation-posting', 'data-moderation-posting', [['open', t(msgid('Open'))], ['members', t(msgid('Members'))], ['moderated', t(msgid('Moderated'))]]))
    + field('v2-list-moderation-subscription', t(msgid('Self subscription')), pick('v2-list-moderation-subscription', 'data-moderation-subscription', [['closed', t(msgid('Closed'))], ['open', t(msgid('Open'))]]))
    + field('v2-list-moderation-non-member', t(msgid('Posts from non-members')), pick('v2-list-moderation-non-member', 'data-moderation-non-member', actions))
    + field('v2-list-moderation-member', t(msgid('Posts from moderated members')), pick('v2-list-moderation-member', 'data-moderation-member', actions))
    + number('v2-list-moderation-size', 'data-moderation-size', t(msgid('Hold messages larger than (KB, 0 for no limit)')), 1048576) + number('v2-list-moderation-retention', 'data-moderation-retention', t(msgid('Remove held messages after (days, 0 to keep)')), 365) + '</div>'
    + `<div class="v2-list-moderation__grid">${area('v2-list-moderation-moderators', 'data-moderation-moderators', t(msgid('Moderators (one address per line)')))}${area('v2-list-moderation-moderated', 'data-moderation-moderated', t(msgid('Moderated members (one address per line)')))}`
    + `${area('v2-list-moderation-accept', 'data-moderation-accept', t(msgid('Always accept from')))}${area('v2-list-moderation-hold', 'data-moderation-hold', t(msgid('Always hold from')))}${area('v2-list-moderation-reject', 'data-moderation-reject-senders', t(msgid('Always reject from')))}${area('v2-list-moderation-discard', 'data-moderation-discard-senders', t(msgid('Always discard from')))}</div>`
    + `<p>${escapeHtml(t(msgid('Sender rules take one address per line, where * and ? match any text, and apply to non-members. A moderator mailbox of this account opens the queue from webmail with its own sign-in.')))}</p>`
    + `<div class="v2-list-moderation__grid">${check('v2-list-moderation-notify-moderators', 'data-moderation-notify-moderators', t(msgid('Tell moderators about each held message')))}${check('v2-list-moderation-notify-sender', 'data-moderation-notify-sender', t(msgid('Tell senders their message is held')))}</div>`
    + `<div class="v2-actions"><button type="button" class="v2-btn v2-btn--primary" data-moderation-save${off}>${escapeHtml(t(msgid('Save posting policy')))}</button></div>`
    + `<dl class="v2-list-moderation__grid"><div><dt>${escapeHtml(t(msgid('Moderation queue')))}</dt><dd data-moderation-state>${escapeHtml(t(msgid('Not read')))}</dd></div><div><dt>${escapeHtml(t(msgid('Held messages')))}</dt><dd data-moderation-held>${escapeHtml(t(msgid('Not read')))}</dd></div></dl>`
    + `${v2ModerationQueue(t)}</div></section>`
}
