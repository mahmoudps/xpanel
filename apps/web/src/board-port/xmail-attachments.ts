import { classicMailClientTemplates } from './mail-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

export const MAIL_ATTACHMENTS_STYLE = '.xp-mail-attachments{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-mail-attachments :is(h3,p,ul){margin:0}.xp-mail-attachments ul{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:16px}.xp-mail-attachments li{display:flex;min-inline-size:0;max-inline-size:100%}.xp-mail-attachments__download{display:flex;align-items:center;gap:16px;padding:8px 12px;max-inline-size:100%;text-align:start;white-space:normal}.xp-mail-attachments__badge{display:grid;place-items:center;flex:none;inline-size:34px;block-size:34px;border-radius:8px;background:var(--xp-bg-elevated);font:600 10px monospace}.xp-mail-attachments__download svg{flex:none}.xp-mail-attachments__file{display:grid;gap:8px;min-inline-size:0;flex:1 1 180px;overflow-wrap:anywhere;text-align:start}.xp-mail-attachments__file bdi{unicode-bidi:isolate}.xp-mail-attachments__size{font-variant-numeric:tabular-nums}.xp-mail-attachments :is(button,a){min-block-size:44px;box-sizing:border-box}.xp-mail-attachments [hidden]{display:none}'

/** The attachment list is read from native MIME; message-summary metadata is never a download. */
export function renderMailAttachments(input: { lang: Locale; mailbox: string; uid?: number; uidValidity?: number; folder?: string; canRead: boolean }): string {
  const t = (message: string, values?: MessageValues) => translator(input.lang)(message, values)
  const uid = Number.isSafeInteger(input.uid) && input.uid! > 0 && input.uid! <= 0xffffffff ? String(input.uid) : ''
  const validity = Number.isSafeInteger(input.uidValidity) && input.uidValidity! > 0 && input.uidValidity! <= 0xffffffff ? String(input.uidValidity) : ''
  return `<section class="xp-mail-attachments" data-mail-attachments data-mailbox="${escapeHtml(input.mailbox)}" data-uid="${uid}" data-uid-validity="${validity}" data-folder="${escapeHtml(input.folder ?? 'INBOX')}" data-attachment-can-read="${input.canRead}" lang="${input.lang}" dir="${localeDirection(input.lang)}" aria-label="${t('Message attachments')}">${classicMailClientTemplates('attachments')}
    <style>${MAIL_ATTACHMENTS_STYLE}</style>
    <h3 data-attachment-heading>${t('Attachments')}</h3>
    <p class="xp-help" data-attachment-status data-state="unread" role="status">${t('Select a message to read its attachments.')}</p>
    <ul data-attachment-list></ul>
    <div><button type="button" class="xp-btn" data-attachment-refresh disabled>${t('Read attachments')}</button></div>
  </section>`
}
