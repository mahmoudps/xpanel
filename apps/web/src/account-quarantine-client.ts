/// <reference lib="dom" />
import { createQuarantineIdentity } from '../../../packages/core/src/mail-quarantine.ts'
import type { QuarantineAvailable, QuarantineMessage, QuarantineLocator, QuarantineActionResult } from '../../../packages/core/src/mail-quarantine.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
type QuarantineTransport = (method: string, path: string, body?: unknown) => Promise<unknown>
const displayQuarantineDateTime = formatDisplayDateTime

function bindAccountQuarantine(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined, identity: ReturnType<typeof createQuarantineIdentity>): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const object = identity.object, hash = identity.hash, integer = identity.integer
  const text = (value: unknown, maximum = 16384): value is string => typeof value === 'string' && value.length <= maximum
  const address = identity.address
  const date = (value: unknown): boolean => value === null || text(value, 40) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
  const same = identity.sameLocator, locator = identity.locator
  document.querySelectorAll<HTMLElement>('[data-account-quarantine]').forEach(root => {
    if (root.dataset.quarantineBound === 'true') return
    root.dataset.quarantineBound = 'true'
    const accountId = root.dataset.account ?? '', manageable = root.dataset.quarantineManage === 'true'
    const send = (window as Window & { xpanelSessionRequest?: QuarantineTransport }).xpanelSessionRequest
    const mailbox = root.querySelector<HTMLSelectElement>('[data-quarantine-mailbox]')!
    const status = root.querySelector<HTMLElement>('[data-quarantine-status]')!
    const messages = root.querySelector<HTMLElement>('[data-quarantine-messages]')!
    const detail = root.querySelector<HTMLElement>('[data-quarantine-detail]')!
    const button = (name: string): HTMLButtonElement => root.querySelector<HTMLButtonElement>('[data-quarantine-' + name + ']')!
    if (!mailbox || !status || !messages || !detail || ['refresh', 'older', 'newest', 'release', 'delete', 'expire'].some(name => !button(name))) return
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && manageable && !root.closest(denied)
    let page: QuarantineAvailable | null = null, selected: QuarantineMessage | null = null, busy = false, review = false, cursor: number | undefined
    const announce = (state: string, message: string): void => {
      status.dataset.state = state; status.textContent = message
      status.setAttribute('role', ['failed', 'uncertain', 'unknown', 'partial', 'stale'].includes(state) ? 'alert' : 'status')
    }
    const controls = (): void => {
      const locked = !admitted() || busy
      mailbox.disabled = locked
      button('refresh').disabled = locked
      button('older').disabled = locked || review || page?.nextBeforeUid == null
      button('newest').disabled = locked || cursor === undefined
      button('release').disabled = locked || review || !selected?.releaseEligible
      button('delete').disabled = locked || review || !selected
      button('expire').disabled = locked || review || !page || page.messages.length === 0
      messages.querySelectorAll<HTMLButtonElement>('button').forEach(control => { control.disabled = locked })
      root.setAttribute('aria-busy', String(busy))
    }
    const value = (name: string, content: string, technical = false): void => {
      const field = root.querySelector<HTMLElement>('[data-quarantine-' + name + ']')
      if (!field) return
      field.textContent = ''
      const inner = document.createElement(technical ? 'bdi' : 'span')
      if (technical) inner.dir = 'ltr'
      inner.textContent = content; field.append(inner)
    }
    const paintDetail = (): void => {
      detail.hidden = selected === null
      if (!selected) return
      value('from', selected.from || t('Not supplied'), true)
      value('subject', selected.subject || t('(No subject)'))
      value('received', selected.receivedAt === null ? t('Not supplied') : displayQuarantineDateTime(selected.receivedAt), true)
      value('held', selected.heldAt === null ? t('Not supplied') : displayQuarantineDateTime(selected.heldAt), true)
      value('score', selected.score === null ? t('Not supplied') : String(selected.score), true)
      root.querySelector<HTMLElement>('[data-quarantine-headers]')!.textContent = selected.headers
      root.querySelector<HTMLElement>('[data-quarantine-release-limit]')!.hidden = selected.releaseEligible
      controls()
    }
    const paintMessages = (): void => {
      messages.textContent = ''
      if (!page) return
      for (const message of page.messages) {
        const item = document.createElement('li'), title = document.createElement('strong'), sender = document.createElement('bdi'), inspect = document.createElement('button')
        item.className = 'xp-quarantine__message'; title.textContent = message.subject || t('(No subject)')
        sender.dir = 'ltr'; sender.textContent = message.from || t('Sender not supplied')
        inspect.type = 'button'; inspect.className = 'xp-btn'; inspect.dataset.quarantineInspect = ''; inspect.textContent = t('Review message')
        inspect.setAttribute('aria-label', t('Review message: {subject}', { subject: message.subject || t('(No subject)') }))
        inspect.addEventListener('click', () => { if (!busy && admitted()) { selected = message; paintDetail(); const heading = detail.querySelector<HTMLElement>('h3'); if (heading) { heading.tabIndex = -1; heading.focus() } } })
        item.append(title, sender, inspect); messages.append(item)
      }
      if (!page.messages.length) { const empty = document.createElement('li'); empty.textContent = page.totalMessages === 0 ? t('The configured source reports no held messages.') : t('No messages were returned in this UID window. Earlier windows may contain messages.'); messages.append(empty) }
    }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => {
      if (!send || !admitted()) return Promise.reject({ stateChanged: false })
      return body === undefined ? send(method, path) : send(method, path, body)
    }
    const context = (raw: unknown, expectedMailbox?: string): { mailbox: string | null; mailboxes: string[] } => {
      if (!object(raw) || !object(raw.context) || raw.context.accountId !== accountId || !Array.isArray(raw.context.mailboxes)
        || raw.context.mailboxes.length > 1000 || !raw.context.mailboxes.every(address) || new Set(raw.context.mailboxes).size !== raw.context.mailboxes.length
        || raw.context.mailbox !== null && (!address(raw.context.mailbox) || !raw.context.mailboxes.includes(raw.context.mailbox))
        || expectedMailbox !== undefined && raw.context.mailbox !== expectedMailbox) throw new Error('invalid_quarantine_context')
      return { mailbox: raw.context.mailbox as string | null, mailboxes: raw.context.mailboxes as string[] }
    }
    const readPage = (raw: unknown, expectedMailbox?: string): { context: ReturnType<typeof context>; page: QuarantineAvailable | null } => {
      const scope = context(raw, expectedMailbox)
      if (!object(raw) || !object(raw.quarantine)) throw new Error('invalid_quarantine_read')
      const source = raw.quarantine
      if (source.state === 'unavailable') {
        if (!['native_profile_unavailable', 'no_mailboxes'].includes(String(source.reason))) throw new Error('invalid_quarantine_unavailability')
        return { context: scope, page: null }
      }
      if (source.state !== 'available' || !object(source.scope) || source.scope.accountId !== accountId || source.scope.mailbox !== scope.mailbox
        || !object(source.source) || source.source.kind !== 'dovecot' || !identity.folders.includes(source.source.folder as typeof identity.folders[number]) || typeof source.source.observedAt !== 'string' || !date(source.source.observedAt)
        || !hash(source.revision) || !Array.isArray(source.messages) || source.messages.length > 100 || !integer(source.totalMessages) || source.totalMessages < source.messages.length
        || source.nextBeforeUid !== null && !integer(source.nextBeforeUid, 1) || !object(source.policy) || !integer(source.policy.retentionDays, 1) || source.policy.retentionDays > 365
        || source.policy.retentionMode !== 'manual_expiry' || source.policy.digestAvailable !== false || source.policy.senderAllowAvailable !== false) throw new Error('invalid_quarantine_page')
      const seen = new Set<number>()
      for (const item of source.messages) {
        if (!object(item) || !locator(item.locator) || seen.has(item.locator.uid) || !hash(item.revision) || !text(item.from, 2048) || !text(item.to, 2048)
          || !text(item.subject, 2048) || !text(item.reason, 4096) || !text(item.headers) || !integer(item.sizeBytes) || !date(item.receivedAt) || !date(item.heldAt)
          || item.score !== null && (typeof item.score !== 'number' || !Number.isFinite(item.score)) || typeof item.releaseEligible !== 'boolean') throw new Error('invalid_quarantine_message')
        seen.add(item.locator.uid)
      }
      return { context: scope, page: source as unknown as QuarantineAvailable }
    }
    const install = (read: ReturnType<typeof readPage>): void => {
      const prior = selected
      page = read.page; review = false
      mailbox.textContent = ''
      for (const address of read.context.mailboxes) { const option = document.createElement('option'); option.value = address; option.textContent = address; mailbox.append(option) }
      mailbox.value = read.context.mailbox ?? ''
      selected = page?.messages.find(item => prior && same(item.locator, prior.locator)) ?? null
      value('total', page ? String(page.totalMessages) : t(msgctxt('account-quarantine-client', 'Not read')), true)
      value('observed', page ? displayQuarantineDateTime(page.source.observedAt) : t(msgctxt('account-quarantine-client', 'Not read')), true)
      value('retention', page ? String(page.policy.retentionDays) : t(msgctxt('account-quarantine-client', 'Not read')), true)
      paintMessages(); paintDetail()
    }
    const load = async (targetMailbox = mailbox.value): Promise<ReturnType<typeof readPage>> => {
      const query = new URLSearchParams()
      if (targetMailbox) query.set('mailbox', targetMailbox)
      if (cursor !== undefined) query.set('beforeUid', String(cursor))
      return readPage(await request('GET', '/api/mail/quarantine' + (query.size ? '?' + query.toString() : '')), targetMailbox || undefined)
    }
    const refresh = async (nextCursor?: number): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; cursor = nextCursor; controls(); announce('reading', t('Reading the configured quarantine source…'))
      try {
        const read = await load()
        if (!admitted()) return
        install(read)
        announce(page ? 'read' : 'unavailable', page ? t('Held messages were read from Dovecot. Actions require confirmation and native readback.') : t('Native quarantine is unavailable for this mailbox. No empty collection or mail operation is assumed.'))
      } catch { review = true; announce('failed', t('The source could not be read. Existing details are kept for inspection; actions remain locked until a successful read.')) }
      finally { busy = false; controls() }
    }
    const actionResult = (raw: unknown, target: QuarantineMessage, kind: 'release' | 'delete'): QuarantineActionResult => {
      context(raw, mailbox.value)
      if (!object(raw) || !object(raw.result)) throw new Error('invalid_quarantine_ack')
      const result = raw.result
      if (!object(result.scope) || result.scope.accountId !== accountId || result.scope.mailbox !== mailbox.value || !locator(result.locator) || !same(result.locator, target.locator)
        || result.sourceRevision !== target.revision || !['released', 'deleted', 'partial', 'unknown'].includes(String(result.state))
        || typeof result.stateChanged !== 'boolean' || typeof result.verificationRequired !== 'boolean') throw new Error('wrong_quarantine_ack')
      if (result.state === 'released' && (kind !== 'release' || result.correction !== 'applied' || result.deliveredToInbox !== true || result.sourcePresent !== false || result.verificationRequired)
        || result.state === 'deleted' && (kind !== 'delete' || result.deleted !== true || result.sourcePresent !== false || result.verificationRequired)) throw new Error('unverified_quarantine_ack')
      return result as unknown as QuarantineActionResult
    }
    const unchanged = (error: unknown): boolean => {
      if (!object(error)) return false
      const details = object(error.details) ? error.details : {}
      if ([error, details].some(value => value.stateChanged === true || value.unknownOutcome === true || value.verificationRequired === true)) return false
      return error.stateChanged === false || details.stateChanged === false || [400, 401, 403, 404, 409, 412, 413, 415, 422].includes(Number(error.status))
    }
    const run = async (kind: 'release' | 'delete' | 'expire'): Promise<void> => {
      if (busy || review || !admitted() || !page || kind !== 'expire' && !selected || kind === 'release' && !selected?.releaseEligible) return
      if (!askDialog) { announce('failed', t('Confirmation is unavailable. No action was sent.')); return }
      const captured = page, target = selected, mailboxValue = mailbox.value
      busy = true; controls(); let submitted = false
      try {
        const approved = await askDialog({ title: kind === 'release' ? t('Release held message?') : kind === 'delete' ? t('Permanently delete held message?') : t('Delete expired messages in this window?'),
          body: mailboxValue + (kind === 'expire' ? '\n' + t('{days} days; unknown held times are kept. This applies only to this displayed window.', { days: captured.policy.retentionDays }) : '\n' + (target!.subject || t('(No subject)'))), confirm: t('Confirm'), danger: kind !== 'release' })
        if (approved !== true || !admitted()) return
        submitted = true
        const body = kind === 'expire' ? { mailbox: mailboxValue, expectedRevision: captured.revision, ...(cursor === undefined ? {} : { beforeUid: cursor }) } : { mailbox: mailboxValue, locator: { ...target!.locator }, expectedRevision: target!.revision }
        const raw = await request('POST', '/api/mail/quarantine/' + kind, body)
        let removed: QuarantineMessage[]
        if (kind === 'expire') {
          context(raw, mailboxValue)
          if (!object(raw) || !object(raw.result) || raw.result.state !== 'expired' || !object(raw.result.scope) || raw.result.scope.accountId !== accountId || raw.result.scope.mailbox !== mailboxValue
            || !integer(raw.result.removed) || !Array.isArray(raw.result.results) || raw.result.results.length !== raw.result.removed || raw.result.results.length > captured.messages.length) throw new Error('unverified_expiry')
          removed = raw.result.results.map(item => {
            if (!object(item) || !locator(item.locator)) throw new Error('invalid_expiry_target')
            const message = captured.messages.find(message => same(message.locator, item.locator as unknown as QuarantineLocator) && message.revision === item.sourceRevision)
            if (!message) throw new Error('wrong_expiry_target')
            actionResult({ context: (raw as Record<string, unknown>).context, result: item }, message, 'delete')
            if (item.state !== 'deleted') throw new Error('partial_expiry')
            return message
          })
          if (new Set(removed.map(message => JSON.stringify(message.locator))).size !== removed.length) throw new Error('duplicate_expiry_target')
        } else {
          const result = actionResult(raw, target!, kind)
          if (result.state !== (kind === 'release' ? 'released' : 'deleted')) { review = true; announce(result.state, t('The native outcome needs review. No action was retried. Read the current source and inspect Inbox before continuing.')); return }
          removed = [target!]
        }
        const read = await load(mailboxValue)
        if (!read.page || removed.some(message => read.page!.messages.some(current => same(current.locator, message.locator)))) throw new Error('quarantine_readback_mismatch')
        install(read)
        announce(kind === 'release' ? 'released' : kind === 'delete' ? 'deleted' : 'expired', kind === 'release' ? t('The not-spam correction and delivery to Inbox were confirmed; the held source is absent on readback.') : kind === 'delete' ? t('The selected held message was deleted and absence was confirmed.') : t('{count} expired messages were deleted in this window and read back.', { count: removed.length }))
      } catch (error) {
        review = submitted && (!unchanged(error) || object(error) && [401, 403, 404, 409, 412].includes(Number(error.status)))
        announce(review ? 'uncertain' : 'failed', review ? t('The outcome requires review. Nothing was retried; read current quarantine and inspect Inbox before another action.') : t('The request was refused before a confirmed change. Existing details are kept; no retry was sent.'))
      } finally { busy = false; controls() }
    }
    if (!send || !admitted() || !identity.uuid.test(accountId)) {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true })
      announce('unavailable', t('Quarantine is unavailable here. No source or mail operation was read or changed.')); return
    }
    button('refresh').addEventListener('click', () => { void refresh(cursor) })
    button('older').addEventListener('click', () => { if (!button('older').disabled && page?.nextBeforeUid) void refresh(page.nextBeforeUid) })
    button('newest').addEventListener('click', () => { void refresh() })
    mailbox.addEventListener('change', () => { if (busy) { mailbox.value = page?.scope.mailbox ?? ''; return }; selected = null; void refresh() })
    for (const kind of ['release', 'delete', 'expire'] as const) button(kind).addEventListener('click', () => { void run(kind) })
    void refresh()
  })
}

export const ACCOUNT_QUARANTINE_CLIENT_BINDING = `(function(askDialog){const displayQuarantineDateTime=${DISPLAY_DATETIME_BINDING};return (${bindAccountQuarantine.toString()})(askDialog, (${createQuarantineIdentity.toString()})())})`
