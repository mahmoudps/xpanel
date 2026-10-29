import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
export interface MailboxForwardersSnapshot { mailbox: string; revision: string; limit: number; review: 'managed_elsewhere' | 'duplicate_records' | null; destinations: string[]; application: { state: 'applied' | 'pending' | 'failed'; reason: string | null } | null }

/** The same conservative grammar as the API (apps/api/src/mail/forwarder-validation.ts); the server stays authoritative. */
export function forwardAddress(value: unknown): string | null {
  const address = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const at = address.indexOf('@'), local = address.slice(0, at), domain = address.slice(at + 1)
  return address.length <= 254 && at > 0 && at === address.lastIndexOf('@') && local.length <= 64 && /^[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*$/.test(local)
    && /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(domain) ? address : null
}

/** Strict reader: only the sealed mailbox's own record and its host state, no other source. */
export function readMailboxForwarders(value: unknown, mailbox: string): MailboxForwardersSnapshot {
  const bad = (): never => { throw new Error('invalid_mailbox_forwarders') }
  const record = value as Record<string, unknown> | null
  if (!record || typeof record !== 'object' || Array.isArray(record)) return bad()
  const context = record.context as Record<string, unknown> | null, application = record.application as Record<string, unknown> | null, review = record.review
  if (!context || typeof context !== 'object' || context.mailbox !== mailbox || Object.keys(context).length !== 1 || typeof record.revision !== 'string' || !/^[0-9a-f]{64}$/.test(record.revision)
    || record.limit !== 10 || (record.forwarding === null ? application !== null : !application || typeof application !== 'object' || !['applied', 'pending', 'failed'].includes(String(application.state)) || !(application.reason === null || typeof application.reason === 'string'))
    || !(review === null || review === 'managed_elsewhere' || review === 'duplicate_records')) return bad()
  const forwarding = record.forwarding as Record<string, unknown> | null
  if (forwarding !== null && (review !== null || !forwarding || typeof forwarding !== 'object' || typeof forwarding.id !== 'string' || forwarding.keepCopy !== true
    || typeof forwarding.createdAt !== 'string' || !Array.isArray(forwarding.destinations) || forwarding.destinations.length < 1 || forwarding.destinations.length > 100)) return bad()
  const destinations = forwarding === null ? [] : (forwarding.destinations as unknown[]).map(item => typeof item === 'string' && forwardAddress(item) === item && item !== mailbox ? item : bad())
  if (new Set(destinations).size !== destinations.length) return bad()
  return { mailbox, revision: record.revision, limit: 10, review: review as MailboxForwardersSnapshot['review'], destinations,
    application: application ? { state: application.state as 'applied' | 'pending' | 'failed', reason: application.reason as string | null } : null }
}

function bindMailForwarders(askDialog: (options: Record<string, unknown>) => Promise<unknown>): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  document.querySelectorAll<HTMLElement>('[data-mail-forwarders]').forEach(root => {
    if (root.dataset.forwardersBound === 'true') return
    root.dataset.forwardersBound = 'true'
    const mailbox = root.dataset.forwardersMailbox ?? ''
    const status = root.querySelector<HTMLElement>('[data-forwarders-status]'), rows = root.querySelector<HTMLElement>('[data-forwarders-rows]'), count = root.querySelector<HTMLElement>('[data-forwarders-count]')
    const input = root.querySelector<HTMLInputElement>('input[name="destination"]'), add = root.querySelector<HTMLButtonElement>('[data-forwarders-add]'), refresh = root.querySelector<HTMLButtonElement>('[data-forwarders-refresh]')
    if (!status || !rows || !count || !input || !add || !refresh) return
    const admitted = (): boolean => root.isConnected && root.dataset.forwardersCanManage === 'true' && root.dataset.forwardersMailbox === mailbox && !!mailbox && !root.closest(denied) && !!send
    let snapshot: MailboxForwardersSnapshot | null = null, busy = false, lock = ''
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status') }
    const sync = (): void => {
      const editable = admitted() && !!snapshot && !busy && !lock && snapshot.review === null
      input.disabled = !editable; add.disabled = !editable || snapshot!.destinations.length >= snapshot!.limit; refresh.disabled = busy || !admitted()
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = !editable })
      root.setAttribute('aria-busy', String(busy))
    }
    const message = (text: string): void => { rows.textContent = ''; const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 2; cell.textContent = text; row.append(cell); rows.append(row) }
    const paint = (view: MailboxForwardersSnapshot): void => {
      count.textContent = t('{count} of {limit} addresses', { count: view.destinations.length, limit: view.limit })
      if (!view.destinations.length) { message(view.review ? t('Forwarding for this address is managed by the account owner.') : t('No forwarders. Mail stays in this mailbox only.')); return }
      rows.textContent = ''
      for (const destination of view.destinations) {
        const row = document.createElement('tr'), name = document.createElement('td'), action = document.createElement('td'), bdi = document.createElement('bdi'), remove = document.createElement('button')
        bdi.dir = 'ltr'; bdi.textContent = destination; name.append(bdi)
        remove.type = 'button'; remove.className = 'xp-btn'; remove.dataset.forwardersRemove = destination; remove.textContent = t('Remove')
        remove.setAttribute('aria-label', t('Remove forwarding to {destination}', { destination }))
        action.append(remove); row.append(name, action); rows.append(row)
      }
    }
    const read = async (): Promise<MailboxForwardersSnapshot> => readMailboxForwarders(await send!('GET', '/api/webmail/forwarders'), mailbox)
    const load = async (): Promise<void> => {
      if (!admitted() || busy) return
      busy = true; sync(); note('reading', t('Reading forwarders…'))
      try {
        const view = await read()
        if (!admitted()) { snapshot = null; message(t('Nothing is shown.')); note('unavailable', t('Forwarders are unavailable for this mailbox session. Nothing is shown.')); return }
        snapshot = view; lock = ''; paint(view)
        note(view.review ? 'review' : 'read', view.review ? t('Forwarding for this address is managed by the account owner, so it cannot be changed here.') : t('Saved forwarders read.'))
      } catch (error) {
        snapshot = null; message(t('Forwarders could not be read. Nothing is shown.'))
        note('failed', (error as { status?: unknown })?.status === 403 ? t('Forwarders are not available for this mailbox. Nothing is shown.') : t('Forwarders could not be read or verified. Nothing is shown.'))
      } finally { busy = false; sync() }
    }
    const reasons: Record<string, string> = {
      FORWARD_LOOP: t('That address would send mail back to this mailbox, so it was refused. Nothing changed.'),
      forward_limit: t('A mailbox forwards to at most 10 addresses. Nothing changed.'),
      account_forwarder_limit: t('The hosting account has reached its forwarder limit. Nothing changed.'),
      managed_elsewhere: t('Forwarding for this address is managed by the account owner. Nothing changed.'),
    }
    const hostState = (view: MailboxForwardersSnapshot): string => !view.application || view.application.state === 'applied' ? t('Saved and applied on the mail server.')
      : view.application.state === 'pending' ? t('Saved. The mail server has not applied it yet.')
      : view.application.reason ? t('Saved, but the mail server did not apply it: {reason}', { reason: view.application.reason }) : t('Saved, but the mail server did not apply it.')
    const write = async (destinations: string[], success: string): Promise<void> => {
      if (!admitted() || !snapshot || busy || lock) return
      const captured = snapshot
      busy = true; sync(); note('saving', t('Saving forwarders and verifying the saved result…'))
      try {
        const ack = await send!('PUT', '/api/webmail/forwarders', { destinations, keepCopy: true, expectedRevision: captured.revision }) as Record<string, unknown> | null
        if (!ack || ack.stateChanged !== true) throw new Error('invalid_forwarders_acknowledgement')
        const accepted = readMailboxForwarders(ack, mailbox), verified = await read()
        if (accepted.destinations.join('\n') !== destinations.join('\n') || verified.revision !== accepted.revision || verified.destinations.join('\n') !== destinations.join('\n')) throw new Error('forwarders_readback_mismatch')
        snapshot = verified; paint(verified); input.value = ''; note('saved', success + ' ' + hostState(verified))
      } catch (error) {
        const failure = error as { status?: unknown; details?: Record<string, unknown> } | null, details = failure && typeof failure.details === 'object' && failure.details ? failure.details : null
        if (!details || details.stateChanged !== false || details.verificationRequired === true || details.unknownOutcome === true) {
          lock = 'uncertain'; note('uncertain', t('The change outcome requires review. Do not retry; refresh to see the saved forwarders.'))
        } else if (failure!.status === 409) {
          lock = 'stale'; note('stale', t('Forwarders changed since they were read. Refresh before another change.'))
        } else note('failed', reasons[String(details.reason)] ?? t('The change was refused. Nothing changed.'))
      } finally { busy = false; sync() }
    }
    add.addEventListener('click', () => {
      if (!admitted() || !snapshot || busy || lock) return
      const address = forwardAddress(input.value)
      const refusal = !address ? t('Enter one valid email address, for example name@example.org.')
        : address === mailbox ? reasons.FORWARD_LOOP! : snapshot.destinations.includes(address) ? t('That address is already a destination. Nothing changed.')
        : snapshot.destinations.length >= snapshot.limit ? reasons.forward_limit! : ''
      if (refusal) { note('failed', refusal); input.focus(); return }
      void write([...snapshot.destinations, address!], t('Forwarder saved and read back.'))
    })
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); add.click() } })
    rows.addEventListener('click', event => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-forwarders-remove]'), destination = button?.dataset.forwardersRemove
      if (!button || !destination || button.disabled || !snapshot || !snapshot.destinations.includes(destination)) return
      void askDialog({ title: t('Remove forwarder?'), body: t('Mail will no longer be forwarded to {destination}. Mail already forwarded is not affected.', { destination }), confirm: t('Remove'), danger: true })
        .then(confirmed => { if (confirmed === true && snapshot) void write(snapshot.destinations.filter(item => item !== destination), t('Forwarder removed and read back.')) })
    })
    refresh.addEventListener('click', () => { void load() })
    if (!admitted()) { sync(); note('unavailable', t('Forwarders are unavailable for this mailbox session. Nothing was read.')); return }
    void load()
  })
}

export const MAIL_MAILBOX_FORWARDERS_CLIENT_BINDING = `(()=>{const forwardAddress=${forwardAddress.toString()};const readMailboxForwarders=${readMailboxForwarders.toString()};return ${bindMailForwarders.toString()};})()`
