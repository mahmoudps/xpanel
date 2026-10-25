/// <reference lib="dom" />

export interface MailSendPayload { to: string; cc: string; bcc: string; subject: string; text: string; html?: string }

/** Recipients stay in separate envelope fields; Bcc is never copied into a visible header. */
export function readMailSendPayload(root: Document = document): MailSendPayload {
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
  const payload: MailSendPayload = { to: recipients('to'), cc: recipients('cc'), bcc: recipients('bcc'), subject: subject?.value.trim() ?? '', text: text.trim() }
  if (body && !plainInput) payload.html = body.innerHTML
  return payload
}

export function mailSubmissionAcknowledged(value: unknown): value is { mailbox: string; messageId: string; savedToSent: boolean } {
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
  const ar = document.documentElement.lang === 'ar'
  const copy = (en: string, arabic: string) => ar ? arabic : en
  const note = (message: string, state: string) => {
    const status = document.getElementById('mail-send-status')
    if (status) { status.textContent = message; status.hidden = false; status.dataset.state = state; status.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status') }
  }
  button.addEventListener('click', async () => {
    if (busy || reviewRequired || button.disabled || button.closest('[data-wiring="soon"],[data-wiring="unavailable"],fieldset:disabled,[aria-disabled="true"]')) return
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (typeof request !== 'function') { note(copy('Sending is unavailable. Your draft has been kept.', 'الإرسال غير متاح. احتُفظ بمسودتك.'), 'failed'); return }
    const payload = readMailSendPayload()
    busy = true; button.disabled = true; note(copy('Sending…', 'جار الإرسال…'), 'pending')
    try {
      const result = await request('POST', '/api/webmail/send', payload)
      if (!mailSubmissionAcknowledged(result)) {
        reviewRequired = true
        note(copy('The send acknowledgement could not be verified. Your draft is kept; verify submission before retrying.', 'تعذر التحقق من إقرار الإرسال. احتُفظ بالمسودة؛ تحقق من الإرسال قبل المحاولة مجددًا.'), 'uncertain')
        return
      }
      note(copy('The mail server accepted the message.', 'قبل خادم البريد الرسالة.') + (result.savedToSent
        ? copy(' A copy is in Sent.', ' توجد نسخة في المرسل.')
        : copy(' A Sent copy was not saved.', ' لم تُحفظ نسخة في المرسل.')), 'accepted')
      const body = document.getElementById('compose-body')
      if (body instanceof HTMLTextAreaElement || body instanceof HTMLInputElement) body.value = ''
      else if (body) body.textContent = ''
      document.querySelectorAll('[data-mail-chip="to"],[data-mail-chip="cc"],[data-mail-chip="bcc"]').forEach(chip => chip.remove())
      for (const id of ['compose-to', 'compose-cc', 'compose-bcc', 'compose-subject']) {
        const field = document.getElementById(id) as HTMLInputElement | null
        if (field) field.value = ''
      }
    } catch (error) {
      const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {}
      const details = failure.details && typeof failure.details === 'object' ? failure.details as Record<string, unknown> : {}
      const uncertain = failure.verificationRequired === true || failure.stateChanged === true || failure.unknownOutcome === true || failure.needsAttention === true || details.verificationRequired === true || details.stateChanged === true || details.unknownOutcome === true || details.needsAttention === true
      const refused = !uncertain && (details.stateChanged === false || (typeof failure.status === 'number' && failure.status >= 400 && failure.status < 500 && failure.status !== 408))
      reviewRequired = !refused
      note(reviewRequired
        ? copy('The send outcome is unknown. Your draft is kept; verify submission before retrying.', 'نتيجة الإرسال غير معروفة. احتُفظ بالمسودة؛ تحقق من الإرسال قبل المحاولة مجددًا.')
        : copy('The mail server refused the request. Your draft has been kept.', 'رفض خادم البريد الطلب. احتُفظ بمسودتك.'), reviewRequired ? 'uncertain' : 'failed')
    } finally { busy = false; button.disabled = reviewRequired }
  })
}

export const MAIL_SEND_CLIENT_BINDING = `(() => { ${readMailSendPayload.toString()}; ${mailSubmissionAcknowledged.toString()}; (${bindMailSend.toString()})(); })();`
