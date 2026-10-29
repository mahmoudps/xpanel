import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import type { ComposeAttachmentPayload } from '@xpanel/core'

export interface MailSendPayload { to: string; cc: string; bcc: string; subject: string; text: string; html?: string; identityId?: string; expectedIdentityRevision?: string; expectedDraft?: { uid: number; uidValidity: number; revision: string }; attachments?: ComposeAttachmentPayload[] }

/** Serializes authored rich content without assigning or reading innerHTML. */
export function readMailBodyHtml(body: Element): string {
  return Array.from(body.childNodes, node => {
    if (node.nodeType === 1) return (node as Element).outerHTML
    if (node.nodeType === 3) return (node.nodeValue ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    return new XMLSerializer().serializeToString(node)
  }).join('')
}

/** Recipients stay in separate envelope fields; Bcc is never copied into a visible header. */
export function readMailSendPayload(root: Document = document, metadata?: Pick<MailSendPayload, 'expectedDraft'>): MailSendPayload {
  const recipients = (kind: 'to' | 'cc' | 'bcc'): string => {
    const values = Array.from(root.querySelectorAll<HTMLElement>(`[data-mail-chip="${kind}"]`)).map(chip => chip.dataset.addr ?? '').filter(Boolean)
    const input = root.getElementById(`compose-${kind}`) as HTMLInputElement | null
    if (input?.value.trim()) values.push(input.value.trim())
    return values.join(', ')
  }
  const subject = root.getElementById('compose-subject') as HTMLInputElement | null
  const body = root.getElementById('compose-body')
  const plainInput = body instanceof HTMLTextAreaElement || body instanceof HTMLInputElement
  const text = body ? plainInput ? body.value : (body.innerText || body.textContent || '') : ''
  const payload: MailSendPayload = { to: recipients('to'), cc: recipients('cc'), bcc: recipients('bcc'), subject: subject?.value.trim() ?? '', text }
  const identities = root.querySelector<HTMLElement>('[data-compose-identities]')
  if (identities) {
    if (identities.dataset.composeIdentitiesState !== 'ready') throw new Error('sender_identity_not_ready')
    const sender = identities.querySelector<HTMLSelectElement>('#compose-from')
    const option = sender?.selectedOptions[0]
    if (!sender || !option) throw new Error('sender_identity_not_ready')
    if (sender.value !== '') {
      const id = option.dataset.identityId, revision = option.dataset.identityRevision
      if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || !revision || !/^[0-9a-f]{64}$/.test(revision)) throw new Error('invalid_sender_identity')
      payload.identityId = id; payload.expectedIdentityRevision = revision
    }
  }
  if (metadata?.expectedDraft) payload.expectedDraft = { ...metadata.expectedDraft }
  if (body && !plainInput) payload.html = readMailBodyHtml(body)
  if (identities?.querySelector('[data-compose-attachments]')) {
    const getter = (identities as HTMLElement & { xpanelReadComposeAttachments?: (payload: MailSendPayload) => readonly ComposeAttachmentPayload[] }).xpanelReadComposeAttachments
    if (typeof getter !== 'function') throw new Error('compose_attachments_not_ready')
    const attachments = getter(payload)
    if (!Array.isArray(attachments)) throw new Error('compose_attachments_not_ready')
    payload.attachments = [...attachments]
  }
  return payload
}

export function mailSubmissionAcknowledged(value: unknown): value is { mailbox: string; messageId: string; savedToSent: boolean; identityId?: string; identityRevision?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return typeof result.mailbox === 'string' && /^[^\s<>@]+@[^\s<>@]+$/.test(result.mailbox)
    && typeof result.messageId === 'string' && /^<[^<>\s\r\n]+@[^<>\s\r\n]+>$/.test(result.messageId)
    && typeof result.savedToSent === 'boolean'
}

function bindMailSend(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-mail-send="true"]')
  if (!button || button.dataset.mailSendBound === 'true') return
  button.dataset.mailSendBound = 'true'
  let busy = false, reviewRequired = false
  const copy = (message: string, values?: MessageValues) => xpT(message, values)
  const compose = button.closest<HTMLElement>('[data-compose-identities]')
  const signalState = (): void => {
    button.dataset.mailSendBusy = String(busy); button.dataset.mailSendReview = String(reviewRequired)
    button.dispatchEvent(new CustomEvent('xpanel:mail-send-state', { bubbles: true }))
  }
  const note = (message: string, state: string) => {
    const status = document.getElementById('mail-send-status')
    if (status) { status.textContent = message; status.hidden = false; status.dataset.state = state; status.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status') }
  }
  button.addEventListener('click', async () => {
    if (busy || reviewRequired || button.disabled || compose?.dataset.composeSendEnabled === 'false' || compose?.dataset.composeDraftBusy === 'true' || button.closest('[data-wiring="soon"],[data-wiring="unavailable"],fieldset:disabled,[aria-disabled="true"]')) return
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (typeof request !== 'function') { note(copy('Sending is unavailable. Your draft has been kept.'), 'failed'); return }
    let payload: MailSendPayload
    try { payload = readMailSendPayload() }
    catch { note(copy('Review the sender, attachments and draft before sending. Nothing was sent.'), 'failed'); return }
    busy = true; button.disabled = true; note(copy('Sending…'), 'pending')
    signalState()
    try {
      const result = await request('POST', '/api/webmail/send', payload)
      if (!mailSubmissionAcknowledged(result) || compose && result.mailbox.toLowerCase() !== compose.dataset.composeMailbox?.toLowerCase()
        || payload.identityId && (result.identityId !== payload.identityId || result.identityRevision !== payload.expectedIdentityRevision)) {
        reviewRequired = true
        note(copy('The send acknowledgement could not be verified. Your draft is kept; verify submission before retrying.'), 'uncertain')
        return
      }
      note(copy('The mail server accepted the message.') + ' ' + (result.savedToSent
        ? copy('A copy is in Sent.')
        : copy('A Sent copy was not saved.')), 'accepted')
      let draftCleared = false
      try { draftCleared = JSON.stringify(readMailSendPayload()) === JSON.stringify(payload) } catch { /* Keep any newer or unreadable draft. */ }
      if (draftCleared) {
        const body = document.getElementById('compose-body')
        if (body instanceof HTMLTextAreaElement || body instanceof HTMLInputElement) body.value = ''
        else if (body) body.textContent = ''
        document.querySelectorAll('[data-mail-chip="to"],[data-mail-chip="cc"],[data-mail-chip="bcc"]').forEach(chip => chip.remove())
        for (const id of ['compose-to', 'compose-cc', 'compose-bcc', 'compose-subject']) {
          const field = document.getElementById(id) as HTMLInputElement | null
          if (field) field.value = ''
        }
      } else {
        note(copy('The mail server accepted that message. Your newer draft is kept in the editor.') + ' ' + (result.savedToSent ? copy('A copy is in Sent.') : copy('A Sent copy was not saved.')), 'accepted')
      }
      button.dispatchEvent(new CustomEvent('xpanel:mail-send-accepted', { bubbles: true, detail: { draftCleared } }))
    } catch (error) {
      const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {}
      const details = failure.details && typeof failure.details === 'object' ? failure.details as Record<string, unknown> : {}
      if (details.identitySelectionRequired === true && details.stateChanged === false) button.dispatchEvent(new CustomEvent('xpanel:compose-identity-stale', { bubbles: true }))
      const uncertain = failure.verificationRequired === true || failure.stateChanged === true || failure.unknownOutcome === true || failure.needsAttention === true || details.verificationRequired === true || details.stateChanged === true || details.unknownOutcome === true || details.needsAttention === true
      const refused = !uncertain && (details.stateChanged === false || (typeof failure.status === 'number' && failure.status >= 400 && failure.status < 500 && failure.status !== 408))
      reviewRequired = !refused
      note(reviewRequired
        ? copy('The send outcome is unknown. Your draft is kept; verify submission before retrying.')
        : copy('The mail server refused the request. Your draft has been kept.'), reviewRequired ? 'uncertain' : 'failed')
    } finally { busy = false; button.disabled = reviewRequired || !!compose && (compose.dataset.composeSendEnabled === 'false' || compose.dataset.composeDraftBusy === 'true' || compose.dataset.composeIdentitiesState !== 'ready'); signalState() }
  })
}

/** One content/recipient collector is shared by native Send and native Draft save. */
export const MAIL_COMPOSE_PAYLOAD_RUNTIME = `${readMailBodyHtml.toString()}; ${readMailSendPayload.toString()};`
export const MAIL_SEND_CLIENT_BINDING = `(() => { ${MAIL_COMPOSE_PAYLOAD_RUNTIME} ${mailSubmissionAcknowledged.toString()}; (${bindMailSend.toString()})(); })();`
