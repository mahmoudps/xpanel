import './i18n.ts'
/// <reference lib="dom" />

export interface HandoffGrant { action: string; token: string; expiresAt: string }

/** The issue request a control names on this listener; null when it names no valid target. */
export function handoffRequest(audience: string | undefined, target: { accountId?: string; mailbox?: string; landing?: string }): { path: string; body: Record<string, string> } | null {
  if (audience === 'xpanel') {
    return typeof target.accountId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.accountId)
      ? { path: '/api/handoff/xpanel', body: { accountId: target.accountId } } : null
  }
  if (audience !== 'xmail') return null
  const mailbox = typeof target.mailbox === 'string' ? target.mailbox.trim().toLowerCase() : ''
  if (mailbox.length > 254 || !/^[^\s@/\\]+@[^\s@/\\]+$/.test(mailbox)) return null
  const landing = target.landing === 'calendar' || target.landing === 'contacts' ? target.landing : null
  return { path: '/api/handoff/xmail', body: landing ? { mailbox, landing } : { mailbox } }
}

/** Only a grant for the fixed /login/handoff path of another exact HTTPS origin is posted anywhere. */
export function readHandoffGrant(raw: unknown, here: string, now: number): HandoffGrant | 'expired' | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value.action !== 'string' || typeof value.token !== 'string' || typeof value.expiresAt !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) return null
  let url: URL
  try { url = new URL(value.action) } catch { return null }
  if (url.protocol !== 'https:' || url.origin === here || url.href !== url.origin + '/login/handoff') return null
  const expires = Date.parse(value.expiresAt)
  if (!Number.isFinite(expires)) return null
  return expires <= now ? 'expired' : { action: url.href, token: value.token, expiresAt: value.expiresAt }
}

/** A server refusal of the target or permission is "refused"; transport and unknown failures are "failed". */
export function handoffFailureState(error: unknown): 'refused' | 'failed' {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined
  return status === 403 || status === 404 || status === 409 || status === 412 ? 'refused' : 'failed'
}

/**
 * Posts the one-time link to a new tab; the secret exists only in this form for one submit. No `noreferrer`:
 * a no-referrer policy makes browsers send `Origin: null` on this cross-origin POST, and the target requires the exact Origin.
 */
export function submitHandoff(doc: Document, grant: HandoffGrant): void {
  const form = doc.createElement('form')
  form.method = 'post'
  form.action = grant.action
  form.target = '_blank'
  form.rel = 'noopener'
  form.enctype = 'application/x-www-form-urlencoded'
  form.hidden = true
  const input = doc.createElement('input')
  input.type = 'hidden'
  input.name = 'token'
  input.value = grant.token
  form.append(input)
  doc.body.append(form)
  try { form.submit() } finally { form.remove() }
}

function bindHandoffControls(): void {
  const copy = {
    loading: xpT('Opening with a one-time sign-in…'),
    opened: xpT('Opened in a new tab. The sign-in link worked once and is now spent.'),
    refused: xpT('This was refused. The account or mailbox may be inactive, or you may not have access.'),
    expired: xpT('The one-time sign-in expired before it was used. Try again.'),
    failed: xpT('The one-time sign-in could not be created. Try again.'),
    select: xpT('Select a mailbox first.'),
  }
  const selectOf = (button: HTMLButtonElement): HTMLSelectElement | null => {
    const id = button.dataset.handoffMailboxSelect
    const select = id ? document.getElementById(id) : null
    return select instanceof HTMLSelectElement ? select : null
  }
  const show = (button: HTMLButtonElement, state: string, text: string) => {
    button.dataset.handoffState = state
    const status = button.closest('[data-handoff-control]')?.querySelector<HTMLElement>('[data-handoff-status]')
    if (!status) return
    status.dataset.state = state
    status.textContent = text
    status.hidden = !text
  }
  // A select-bound control follows its select: enabled only when a mailbox is chosen and the select is usable.
  const follow = (button: HTMLButtonElement) => {
    const select = selectOf(button)
    if (!select || button.dataset.handoffState === 'loading') return
    button.disabled = select.disabled || !select.value
  }
  document.querySelectorAll<HTMLButtonElement>('button[data-handoff][data-handoff-mailbox-select]').forEach(button => {
    const select = selectOf(button)
    if (!select) { button.disabled = true; return }
    follow(button)
    select.addEventListener('change', () => follow(button))
    new MutationObserver(() => follow(button)).observe(select, { attributes: true, attributeFilter: ['disabled'], childList: true })
  })
  document.addEventListener('click', async event => {
    const button = event.target instanceof Element ? event.target.closest('button[data-handoff]') as HTMLButtonElement | null : null
    if (!button || event.defaultPrevented || button.disabled || button.dataset.handoffState === 'loading') return
    event.preventDefault()
    const select = selectOf(button)
    const request = handoffRequest(button.dataset.handoff, {
      ...(button.dataset.handoffAccount ? { accountId: button.dataset.handoffAccount } : {}),
      ...(button.dataset.handoffMailbox || select ? { mailbox: button.dataset.handoffMailbox ?? select?.value ?? '' } : {}),
      ...(button.dataset.handoffLanding ? { landing: button.dataset.handoffLanding } : {}),
    })
    if (!request) { show(button, 'failed', select ? copy.select : copy.failed); return }
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (typeof transport !== 'function') { show(button, 'failed', copy.failed); return }
    button.disabled = true
    show(button, 'loading', copy.loading)
    try {
      const grant = readHandoffGrant(await transport('POST', request.path, request.body), window.location.origin, Date.now())
      if (grant === 'expired') show(button, 'expired', copy.expired)
      else if (!grant) show(button, 'failed', copy.failed)
      else { submitHandoff(document, grant); show(button, 'opened', copy.opened) }
    } catch (error) {
      const state = handoffFailureState(error)
      show(button, state, state === 'refused' ? copy.refused : copy.failed)
    } finally {
      button.disabled = false
      follow(button)
    }
  })
}

export const HANDOFF_CLIENT_BINDING = `(()=>{const handoffRequest=${handoffRequest.toString()};const readHandoffGrant=${readHandoffGrant.toString()};const handoffFailureState=${handoffFailureState.toString()};const submitHandoff=${submitHandoff.toString()};return ${bindHandoffControls.toString()};})()`
