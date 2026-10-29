/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatMailDateTime = formatDisplayDateTime

type TrackStatus = 'sent' | 'deferred' | 'bounced' | 'expired' | 'rejected' | 'queued'
type TrackRecipient = { address: string; status: Exclude<TrackStatus, 'queued'>; dsn: string | null; relay: string | null; response: string | null; at: string; attempts: number }
type TrackEvent = { at: string; kind: string; status: TrackStatus | null; dsn: string | null }
export type TrackDeliveryMessage = { queueId: string | null; role: 'sender' | 'recipient' | 'both'; firstSeen: string; lastSeen: string; sender: string | null; size: number | null; status: TrackStatus; dsn: string | null; recipients: TrackRecipient[]; otherRecipients: number; events: TrackEvent[]; eventsOmitted: number }
export type TrackDeliveryView = { state: 'read' | 'unavailable'; reason: string | null; observedAt: string; window: { since: string; until: string }; complete: boolean; omittedMessages: number; messages: TrackDeliveryMessage[] }

/** Strict reader: every disclosed address must be the sealed mailbox, except the sender of mail it received. */
export function readTrackDeliveryView(value: unknown, mailbox: string): TrackDeliveryView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const text = (item: unknown, max: number): string => { if (typeof item !== 'string' || new TextEncoder().encode(item).length > max || /[\u0000-\u001f\u007f]/.test(item)) throw new Error('invalid_track_text'); return item }
  const nullable = (item: unknown, max: number): string | null => item === null ? null : text(item, max)
  const instant = (item: unknown): string => { if (typeof item !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(item) || Number.isNaN(Date.parse(item))) throw new Error('invalid_track_instant'); return item }
  const count = (item: unknown, max: number): number => { if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0 || item > max) throw new Error('invalid_track_count'); return item }
  const dsn = (item: unknown): string | null => { if (item !== null && (typeof item !== 'string' || !/^[245]\.[0-9]{1,3}\.[0-9]{1,3}$/.test(item))) throw new Error('invalid_track_dsn'); return item as string | null }
  const statuses = ['sent', 'deferred', 'bounced', 'expired', 'rejected', 'queued'], kinds = ['received', 'queued', 'delivery', 'rejected', 'expired', 'notification', 'removed']
  if (!object(value) || value.scope !== 'mailbox' || value.mailbox !== mailbox || !['read', 'unavailable'].includes(value.state as string) || typeof value.complete !== 'boolean'
    || !object(value.window) || !Array.isArray(value.messages) || value.messages.length > 20000) throw new Error('invalid_track_view')
  const reason = value.reason === undefined ? null : value.reason
  if (value.state === 'read' ? reason !== null : !['journal_unavailable', 'output_limit'].includes(reason as string) || value.messages.length !== 0 || value.complete) throw new Error('invalid_track_view')
  const messages = value.messages.map(raw => {
    if (!object(raw) || raw.queueId !== null && (typeof raw.queueId !== 'string' || !/^[0-9A-Za-z]{6,26}$/.test(raw.queueId)) || !['sender', 'recipient', 'both'].includes(raw.role as string) || !statuses.includes(raw.status as string)
      || !Array.isArray(raw.recipients) || raw.recipients.length > 200 || !Array.isArray(raw.events) || raw.events.length > 200) throw new Error('invalid_track_message')
    const recipients = raw.recipients.map(item => {
      if (!object(item) || item.address !== mailbox || !statuses.slice(0, 5).includes(item.status as string) || count(item.attempts, 20000) < 1) throw new Error('invalid_track_recipient')
      return { address: mailbox, status: item.status as TrackRecipient['status'], dsn: dsn(item.dsn), relay: nullable(item.relay, 300), response: nullable(item.response, 1024), at: instant(item.at), attempts: item.attempts as number }
    })
    const sender = nullable(raw.sender, 254), role = raw.role as TrackDeliveryMessage['role']
    if ((role === 'sender') !== (recipients.length === 0) || role !== 'recipient' && (sender ?? '').toLowerCase() !== mailbox) throw new Error('invalid_track_role')
    const events = raw.events.map(item => {
      if (!object(item) || !kinds.includes(item.kind as string) || item.status !== undefined && !statuses.includes(item.status as string)) throw new Error('invalid_track_event')
      return { at: instant(item.at), kind: item.kind as string, status: (item.status ?? null) as TrackStatus | null, dsn: item.dsn === undefined ? null : dsn(item.dsn) }
    })
    return { queueId: raw.queueId as string | null, role, firstSeen: instant(raw.firstSeen), lastSeen: instant(raw.lastSeen), sender, size: raw.size === null ? null : count(raw.size, Number.MAX_SAFE_INTEGER), status: raw.status as TrackStatus, dsn: dsn(raw.dsn), recipients, otherRecipients: count(raw.otherRecipients, 20000), events, eventsOmitted: count(raw.eventsOmitted, 20000) }
  })
  return { state: value.state as TrackDeliveryView['state'], reason: reason as string | null, observedAt: instant(value.observedAt), window: { since: instant(value.window.since), until: instant(value.window.until) }, complete: value.complete, omittedMessages: count(value.omittedMessages, 20000), messages }
}

function bindMailTrackDelivery(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const statusLabel: Record<string, string> = { sent: t('Delivered'), deferred: t('Deferred'), bounced: t('Bounced'), expired: t('Expired'), rejected: t('Rejected'), queued: t('Queued') }
  const kindLabel: Record<string, string> = { received: t('Received by the server'), queued: t('Queued for delivery'), delivery: t('Delivery attempt to this mailbox'), rejected: t('Rejected'), expired: t('Expired and returned to the sender'), notification: t('Notification sent to the sender'), removed: t('Removed from the queue') }
  const direction: Record<string, string> = { sender: t(msgctxt('mail-track-delivery-client', 'Sent')), recipient: t(msgctxt('mail-track-delivery-client', 'Received')), both: t('Sent to yourself') }
  const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
  const time = formatMailDateTime
  const bdi = (value: string): HTMLElement => { const item = document.createElement('bdi'); item.dir = 'ltr'; item.textContent = value; return item }
  const cell = (row: HTMLTableRowElement, value: string | Node, technical = false): HTMLTableCellElement => { const td = document.createElement('td'); td.append(typeof value === 'string' ? (technical ? bdi(value) : value) : value); row.append(td); return td }
  const empty = (body: Element, columns: number, message: string): void => { body.textContent = ''; const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns; td.textContent = message; row.append(td); body.append(row) }
  document.querySelectorAll<HTMLElement>('[data-mail-track-delivery]').forEach(root => {
    if (root.dataset.trackBound === 'true') return
    root.dataset.trackBound = 'true'
    const mailbox = root.dataset.trackMailbox ?? ''
    const form = root.querySelector<HTMLFormElement>('[data-mail-track-form]'), status = root.querySelector<HTMLElement>('[data-mail-track-status]'), rows = root.querySelector<HTMLElement>('[data-mail-track-rows]'), detail = root.querySelector<HTMLElement>('[data-mail-track-detail]')
    const range = form?.elements.namedItem('range') as HTMLSelectElement | null, filter = form?.elements.namedItem('status') as HTMLSelectElement | null
    if (!form || !status || !rows || !detail || !range || !filter) return
    const admitted = (): boolean => root.isConnected && root.dataset.trackCanRead === 'true' && root.dataset.trackMailbox === mailbox && !!mailbox && !root.closest(denied) && !!send
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const fact = (key: string, value: string): void => { const node = root.querySelector<HTMLElement>('[data-mail-track-fact="' + key + '"]'); if (node) node.textContent = value }
    let busy = false, generation = 0, messages: TrackDeliveryMessage[] = [], page = 0
    const sync = (): void => { const blocked = !admitted() || busy; form.querySelectorAll<HTMLSelectElement | HTMLButtonElement>('select,button').forEach(control => { control.disabled = blocked }); root.setAttribute('aria-busy', String(busy)) }
    const counterpart = (message: TrackDeliveryMessage): Node => {
      const node = document.createElement('span')
      if (message.role === 'recipient') node.append(message.sender ? bdi(message.sender) : t('Null sender (bounce)'))
      else node.append(message.role === 'sender' ? t('{count} other recipients', { count: message.otherRecipients }) : message.otherRecipients ? t('This mailbox and {count} other recipients', { count: message.otherRecipients }) : t('This mailbox'))
      return node
    }
    const showDetail = (message: TrackDeliveryMessage): void => {
      if (!admitted()) return
      const facts = detail.querySelector<HTMLElement>('[data-mail-track-detail-facts]')!, recipients = detail.querySelector<HTMLElement>('[data-mail-track-detail-recipients]')!, events = detail.querySelector<HTMLElement>('[data-mail-track-detail-events]')!
      const notLogged = t('Not logged')
      facts.textContent = ''
      for (const [label, value, technical] of [[t('Queue ID'), message.queueId ?? t('None (rejected before queueing)'), !!message.queueId], [t('Direction'), direction[message.role]!, false], [t('Sender'), message.sender === null ? notLogged : message.sender || t('Null sender (bounce)'), !!message.sender], [t('Status'), statusLabel[message.status]!, false], [t('DSN'), message.dsn ?? notLogged, !!message.dsn], [t('First seen (UTC)'), time(message.firstSeen), true], [t('Last seen (UTC)'), time(message.lastSeen), true], [t('Size (bytes)'), message.size === null ? notLogged : String(message.size), message.size !== null], [t('Other recipients'), String(message.otherRecipients), true]] as const) {
        const item = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.append(technical ? bdi(value) : value); item.append(dt, dd); facts.append(item)
      }
      recipients.textContent = ''
      for (const item of message.recipients) { const row = document.createElement('tr'); cell(row, statusLabel[item.status]!); cell(row, item.dsn ?? notLogged, !!item.dsn); cell(row, item.relay ?? notLogged, !!item.relay); cell(row, String(item.attempts), true); cell(row, item.response ?? notLogged, !!item.response); recipients.append(row) }
      if (!message.recipients.length) empty(recipients, 5, t('This mailbox is the sender. Delivery details for other recipients are not shown.'))
      events.textContent = ''
      for (const event of message.events) { const item = document.createElement('li'), heading = document.createElement('strong'); heading.append(bdi(time(event.at)), ' · ', kindLabel[event.kind] ?? event.kind); item.append(heading); if (event.status) { const line = document.createElement('span'); line.append(statusLabel[event.status] ?? event.status); if (event.dsn) line.append(' · ', bdi(event.dsn)); item.append(line) } events.append(item) }
      if (message.eventsOmitted) { const item = document.createElement('li'); item.textContent = t('Earlier events not shown: {count}', { count: message.eventsOmitted }); events.prepend(item) }
      detail.hidden = false; detail.focus()
    }
    const paint = (): void => {
      const visible = messages.filter(message => !filter.value || message.status === filter.value), pages = Math.max(1, Math.ceil(visible.length / 50))
      page = Math.min(page, pages - 1); rows.textContent = ''
      for (const message of visible.slice(page * 50, page * 50 + 50)) {
        const row = document.createElement('tr'), view = document.createElement('button')
        view.type = 'button'; view.className = 'xp-btn'; view.textContent = t('View timeline'); view.addEventListener('click', () => showDetail(message))
        cell(row, time(message.lastSeen), true); cell(row, direction[message.role]!); cell(row, counterpart(message)); cell(row, statusLabel[message.status]!); cell(row, message.dsn ?? '-', true); cell(row, view); rows.append(row)
      }
      if (!visible.length) empty(rows, 6, messages.length ? t('No messages have this status in the window.') : t('No mail was sent or received by this mailbox in this window.'))
      const label = root.querySelector<HTMLElement>('[data-mail-track-page-label]')
      if (label) label.textContent = visible.length ? t('Page {page} of {pages}', { page: page + 1, pages }) : ''
      root.querySelectorAll<HTMLButtonElement>('[data-mail-track-page]').forEach(button => { button.disabled = !admitted() || busy || (button.dataset.mailTrackPage === 'newer' ? page === 0 : page >= pages - 1) })
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !send) return
      const end = Math.floor(Date.now() / 1000) * 1000, iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + 'Z'
      const params = new URLSearchParams({ since: iso(end - Number(range.value) * 3600000), until: iso(end) }), token = ++generation
      busy = true; sync(); detail.hidden = true; note('reading', t('Reading delivery attempts for this mailbox…'))
      try {
        const view = readTrackDeliveryView(await send('GET', '/api/webmail/track-delivery?' + params), mailbox)
        if (token !== generation) return
        if (!admitted()) { messages = []; paint(); note('unavailable', t('Delivery tracking is unavailable for this mailbox session. Nothing is shown.')); return }
        messages = view.messages; page = 0
        fact('observed', time(view.observedAt)); fact('window', time(view.window.since) + ' – ' + time(view.window.until))
        const incomplete = root.querySelector<HTMLElement>('[data-mail-track-incomplete]'); if (incomplete) incomplete.hidden = view.state !== 'read' || view.complete && !view.omittedMessages
        paint()
        if (view.state === 'unavailable') note('unavailable', view.reason === 'output_limit' ? t('The server log window is too large to read. Choose a shorter time range.') : t('The server mail log is unavailable. Nothing is shown.'))
        else note('read', t('Delivery attempts read: {count}', { count: messages.length }))
      } catch (error) {
        if (token !== generation) return
        messages = []; paint()
        const code = !!error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined
        note('failed', code === 403 ? t('Delivery tracking is not available for this mailbox. Nothing is shown.') : t('Delivery attempts could not be read or verified. Nothing is shown.'))
      } finally { if (token === generation) { busy = false; sync(); paint() } }
    }
    if (!admitted()) { sync(); note('unavailable', t('Delivery tracking is unavailable for this mailbox session. Nothing was read.')); return }
    form.addEventListener('submit', event => { event.preventDefault(); void load() })
    filter.addEventListener('change', () => { page = 0; detail.hidden = true; paint() })
    root.querySelectorAll<HTMLButtonElement>('[data-mail-track-page]').forEach(button => button.addEventListener('click', () => { page += button.dataset.mailTrackPage === 'newer' ? -1 : 1; paint() }))
    sync(); void load()
  })
}

export const MAIL_TRACK_DELIVERY_CLIENT_BINDING = `(()=>{const formatMailDateTime=${DISPLAY_DATETIME_BINDING};const readTrackDeliveryView=${readTrackDeliveryView.toString()};return ${bindMailTrackDelivery.toString()};})()`
