import { v2MailClientTemplates } from './client-templates.ts'
import { msgctxt, msgid } from '@xpanel/core'
import type { Translate } from '../../../../i18n.ts'
import { card } from '../../components/card.ts'
import { escapeHtml, hookAttrs } from '../../html.ts'
import { mailIcon, type MailIcon } from './icons.ts'
import { renderV2MailVacation } from './vacation.ts'
import type { MailComposeView } from './types.ts'

const FORMAT: readonly { key: MailIcon; label: string; action?: boolean }[] = [
  { key: 'bold', label: msgid('Bold') }, { key: 'italic', label: msgid('Italic') },
  { key: 'underline', label: msgid('Underline') }, { key: 'bullets', label: msgid('Bulleted list') },
  { key: 'numbers', label: msgid('Numbered list') }, { key: 'quote', label: msgid('Quote') },
  { key: 'link', label: msgid('Insert link'), action: true }, { key: 'clear', label: msgid('Remove formatting'), action: true },
]

function recipient(t: Translate, name: 'to' | 'cc' | 'bcc', label: string, value: string, disabled = false): string {
  return `<div class="v2-field" data-mail-recip="${name}"><label for="compose-${name}">${escapeHtml(label)}</label><div class="v2-mail-recipient" data-mail-recip-box="${name}"><input id="compose-${name}" data-mail-recip-input="${name}" type="text" name="${name}" dir="ltr" inputmode="email" autocomplete="email" aria-describedby="recips-help" value="${escapeHtml(value)}"${disabled ? ' disabled' : ''}><ul aria-label="${escapeHtml(`${label} ${t('recipients')}`)}"></ul></div></div>`
}

const fact = (label: string, value: string, hooks: Record<`data-${string}`, string | boolean> = {}): string => `<div><dt>${escapeHtml(label)}</dt><dd${hookAttrs(hooks)}><bdi dir="ltr">${escapeHtml(value)}</bdi></dd></div>`

function identity(t: Translate, view: MailComposeView): string {
  const unread = t(msgctxt('xmail-compose', 'Not read'))
  return card({ title: t('Sending as'), titleId: 'v2-mail-sending-title', bodyHtml: `<dl class="v2-mail-facts">${fact(t('Address'), view.mailbox || unread, { 'data-mail-from-addr': true })}${fact(t('Sender name'), unread, { 'data-compose-identity-label': true })}${fact(t('Reply-To'), unread, { 'data-compose-reply-to': true })}${fact('DKIM', view.identity.dkim ?? unread)}${fact('SPF, DMARC', view.identity.spf ?? unread)}${fact(t('Size limit'), view.identity.size ?? unread)}</dl>` })
}

function rules(t: Translate, view: MailComposeView): string {
  const body = view.rules === null ? `<p role="status">${escapeHtml(t('Saved record not read.'))}</p>` : view.rules.length === 0 ? `<p role="status">${escapeHtml(t(msgctxt('theme:v2', 'No Sieve rules configured.')))}</p>` : `<ul class="v2-mail-rules">${view.rules.map(rule => `<li><h3>${escapeHtml(rule.name)}</h3><dl class="v2-mail-facts">${fact(t(msgctxt('theme:v2', 'Condition')), rule.condition)}${fact(t('Action'), rule.action)}${fact(t('Status'), t(rule.enabled ? 'Enabled' : 'Disabled'))}</dl></li>`).join('')}</ul>`
  return card({ id: 'filters', title: t('Filters'), titleId: 'v2-mail-filter-title', bodyHtml: body })
}

/** Real send/draft/identity/attachment controllers decide readiness; no renderer claims submission or persistence. */
export function renderV2MailCompose(t: Translate, view: MailComposeView & { readonly readOnly?: boolean }): string {
  if (view.readOnly === true) view = { ...view, canSend: false, canSaveDraft: false, canUseAttachments: false, canManageVacation: false }
  const format = FORMAT.map(item => `<button type="button" class="v2-btn v2-btn--icon" data-mail-format="${item.key}" data-mail-format-action="${item.action === true}" aria-label="${escapeHtml(t(item.label))}"${item.action ? '' : ' aria-pressed="false"'}${view.readOnly === true ? ' disabled' : ''}>${mailIcon(item.key)}</button>`).join('')
  const fields = `<div class="v2-field"><label for="compose-from">${escapeHtml(t('From'))}</label><select id="compose-from" dir="auto" disabled aria-describedby="compose-identities-status"><option value="" data-addr="${escapeHtml(view.mailbox)}">${escapeHtml(view.mailbox || t(msgctxt('xmail-compose', 'Not read')))}</option></select></div><div class="v2-mail-identity-tools" data-compose-identities-tools><div class="v2-mail-actions"><button type="button" class="v2-btn" data-compose-identities-refresh disabled>${escapeHtml(t('Read sender identities'))}</button><button type="button" class="v2-btn" data-compose-signature-insert disabled>${escapeHtml(t('Insert signature'))}</button></div><p id="compose-identities-status" data-compose-identities-status role="status">${escapeHtml(t('Saved sender identities have not been read.'))}</p></div>${recipient(t, 'to', t('To'), view.draft.to, view.readOnly === true)}${recipient(t, 'cc', t('Cc'), view.draft.cc, view.readOnly === true)}${recipient(t, 'bcc', t('Bcc'), view.draft.bcc, view.readOnly === true)}<p id="recips-help" class="v2-muted">${escapeHtml(t('Press Enter or type a comma after each address. Bcc recipients are hidden from everyone else.'))}</p><div class="v2-field"><label for="compose-subject">${escapeHtml(t('Subject'))}</label><input id="compose-subject" name="subject" dir="auto" value="${escapeHtml(view.draft.subject)}"${view.readOnly === true ? ' disabled' : ''}></div>`
  const attachments = `<section class="v2-mail-compose-attachments" data-compose-attachments data-compose-attachment-enabled="${view.canUseAttachments}" aria-labelledby="v2-compose-attachments-title">${v2MailClientTemplates('compose-attachments')}<div class="v2-mail-card-head"><h2 id="v2-compose-attachments-title">${escapeHtml(t('Attachments'))} <span class="v2-num" data-compose-attachment-summary></span></h2><button type="button" class="v2-btn" data-compose-attachment-open aria-controls="compose-file-input" aria-describedby="compose-attachment-status" disabled>${mailIcon('attach')}${escapeHtml(t('Attach files'))}</button></div><input id="compose-file-input" data-compose-attachment-input type="file" multiple hidden disabled><ul data-compose-attachment-list></ul><p id="compose-attachment-status" data-compose-attachment-status role="status">${escapeHtml(t('Choose up to 10 files, with a combined limit of 512 KiB. Files have not been read.'))}</p></section>`
  const editor = `<section class="v2-mail-compose-editor" data-compose-form="true" data-compose-identities="true" data-compose-mailbox="${escapeHtml(view.mailbox)}" data-compose-identities-state="unread" data-compose-send-enabled="${view.canSend}" data-compose-draft-enabled="${view.canSaveDraft}" aria-labelledby="compose-title"><header class="v2-mail-card-head"><h1 id="compose-title">${escapeHtml(t('New message'))}</h1><p id="mail-send-status" role="status">${escapeHtml(t('Send through the local mail server.'))}</p></header><div class="v2-mail-compose-fields">${fields}</div><div class="v2-mail-format" role="toolbar" aria-label="${escapeHtml(t('Formatting'))}" aria-controls="compose-body">${format}</div><div class="v2-field"><span id="compose-body-label" class="v2-mail-field-label">${escapeHtml(t('Message body'))}</span><div id="compose-body" class="v2-mail-editor-body" role="textbox" contenteditable="${view.readOnly === true ? 'false' : 'true'}"${view.readOnly === true ? ' aria-readonly="true"' : ''} dir="auto" aria-labelledby="compose-body-label" aria-multiline="true" spellcheck="true">${escapeHtml(view.draft.body)}</div></div>${attachments}<div data-mail-feedback hidden></div><footer class="v2-mail-compose-footer"><div data-mail-discard role="group" aria-label="${escapeHtml(t('Discard draft'))}"><button type="button" class="v2-btn v2-btn--ghost" data-mail-action="discard-ask"${view.readOnly === true ? ' disabled' : ''}>${escapeHtml(t('Discard'))}</button></div><div class="v2-mail-actions"><button type="button" class="v2-btn" data-mail-action="save-draft" disabled aria-describedby="mail-draft-status">${escapeHtml(t('Save draft'))}</button><span id="mail-draft-status" data-mail-draft-status role="status">${escapeHtml(t('Draft saving has not been checked.'))}</span></div><button type="button" class="v2-btn v2-btn--primary" data-mail-send="true" disabled aria-describedby="mail-send-status compose-identities-status">${mailIcon('send')}${escapeHtml(t('Send'))}</button></footer></section>`
  return `<div class="v2-mail-compose"${view.readOnly === true ? ' data-readonly="true"' : ''} data-board-port="xmail-compose" data-product="true" data-mailbox="${escapeHtml(view.mailbox)}" data-locale="${t.locale}">${editor}<aside class="v2-mail-compose-aside" aria-label="${escapeHtml(t('Sending as'))}">${identity(t, view)}${renderV2MailVacation(t, view)}${rules(t, view)}</aside></div>`
}


