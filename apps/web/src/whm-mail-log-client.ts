/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatMailDateTime = formatDisplayDateTime

type MailLogStatusView = 'sent' | 'deferred' | 'bounced' | 'expired' | 'rejected' | 'queued'
type MailLogBaseView = { state: 'read' | 'unavailable'; reason: 'journal_unavailable' | 'output_limit' | null; observedAt: string; window: { since: string; until: string } }
type MailLogCountsView = { records: number; events: number; skipped: number; unparsed: number; untrusted: number }
type MailLogRecipientView = { address: string; originalAddress: string | null; status: Exclude<MailLogStatusView, 'queued'>; dsn: string | null; relay: string | null; response: string | null; at: string; attempts: number }
type MailLogEventView = { at: string; source: string; kind: string; text: string }
export type MailLogMessageView = { queueId: string | null; firstSeen: string; lastSeen: string; sender: string | null; size: number | null; recipientCount: number | null; messageId: string | null; client: string | null; saslUsername: string | null; status: MailLogStatusView; dsn: string | null; recipients: MailLogRecipientView[]; recipientsOmitted: number; events: MailLogEventView[]; eventsOmitted: number }
export type MailDeliveryView = MailLogBaseView & { counts: MailLogCountsView; lineLimitReached: boolean; matched: number; omittedMessages: number; messages: MailLogMessageView[] }
export type MailMonitorView = MailLogBaseView & { counts: MailLogCountsView; lineLimitReached: boolean; summary: { messages: number; statuses: Record<MailLogStatusView, number>; topSenders: { address: string; messages: number }[]; topRecipientDomains: { domain: string; recipients: number }[]; deferralReasons: { dsn: string | null; reason: string; count: number }[] } }

function mailLogObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function mailLogText(value: unknown, max: number): string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('invalid_mail_log_text')
  return value
}
function mailLogNullable(value: unknown, max: number): string | null { return value === null ? null : mailLogText(value, max) }
function mailLogInstant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) throw new Error('invalid_mail_log_instant')
  return value
}
function mailLogCount(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('invalid_mail_log_count')
  return value
}
function mailLogDsn(value: unknown): string | null {
  if (value !== null && (typeof value !== 'string' || !/^[245]\.[0-9]{1,3}\.[0-9]{1,3}$/.test(value))) throw new Error('invalid_mail_log_dsn')
  return value as string | null
}
function mailLogBase(value: unknown, scope: string): MailLogBaseView {
  if (!mailLogObject(value) || value.scope !== scope || !['read', 'unavailable'].includes(value.state as string) || !mailLogObject(value.window)) throw new Error('invalid_mail_log_view')
  const reason = value.reason === undefined ? null : value.reason
  if (value.state === 'read' ? reason !== null : !['journal_unavailable', 'output_limit'].includes(reason as string)) throw new Error('invalid_mail_log_view')
  const since = mailLogInstant(value.window.since), until = mailLogInstant(value.window.until)
  if (Date.parse(since) >= Date.parse(until) || Date.parse(until) - Date.parse(since) > 7 * 86400000) throw new Error('invalid_mail_log_window')
  return { state: value.state as 'read' | 'unavailable', reason: reason as MailLogBaseView['reason'], observedAt: mailLogInstant(value.observedAt), window: { since, until } }
}
function mailLogCounts(value: unknown): MailLogCountsView {
  if (!mailLogObject(value)) throw new Error('invalid_mail_log_counts')
  const counts = { records: mailLogCount(value.records, 20000), events: mailLogCount(value.events, 20000), skipped: mailLogCount(value.skipped, 20000), unparsed: mailLogCount(value.unparsed, 20000), untrusted: mailLogCount(value.untrusted, 20000) }
  if (counts.events + counts.skipped + counts.unparsed + counts.untrusted !== counts.records) throw new Error('invalid_mail_log_counts')
  return counts
}

export function readMailLogMessage(raw: unknown): MailLogMessageView {
  const statuses = ['sent', 'deferred', 'bounced', 'expired', 'rejected', 'queued'], kinds = ['client', 'message-id', 'queued', 'delivery', 'rejected', 'expired', 'notification', 'removed'], sources = ['smtp', 'lmtp', 'local', 'qmgr', 'smtpd', 'cleanup', 'bounce', 'error', 'virtual', 'pipe']
  if (!mailLogObject(raw) || raw.queueId !== null && (typeof raw.queueId !== 'string' || !/^[0-9A-Za-z]{6,26}$/.test(raw.queueId)) || !statuses.includes(raw.status as string)
    || !Array.isArray(raw.recipients) || raw.recipients.length > 200 || !Array.isArray(raw.events) || raw.events.length > 200) throw new Error('invalid_mail_log_message')
  const nullableCount = (value: unknown): number | null => value === null ? null : mailLogCount(value, Number.MAX_SAFE_INTEGER)
  const recipients = raw.recipients.map(item => {
    if (!mailLogObject(item) || !statuses.slice(0, 5).includes(item.status as string)) throw new Error('invalid_mail_log_recipient')
    const attempts = mailLogCount(item.attempts, 20000)
    if (attempts < 1) throw new Error('invalid_mail_log_recipient')
    return { address: mailLogText(item.address, 254), originalAddress: mailLogNullable(item.originalAddress, 254), status: item.status as MailLogRecipientView['status'], dsn: mailLogDsn(item.dsn), relay: mailLogNullable(item.relay, 300), response: mailLogNullable(item.response, 1024), at: mailLogInstant(item.at), attempts }
  })
  const events = raw.events.map(item => {
    if (!mailLogObject(item) || !kinds.includes(item.kind as string) || !sources.includes(item.source as string)) throw new Error('invalid_mail_log_event')
    return { at: mailLogInstant(item.at), source: item.source as string, kind: item.kind as string, text: mailLogText(item.text, 1024) }
  })
  const firstSeen = mailLogInstant(raw.firstSeen), lastSeen = mailLogInstant(raw.lastSeen)
  if (Date.parse(firstSeen) > Date.parse(lastSeen)) throw new Error('invalid_mail_log_message')
  return { queueId: raw.queueId as string | null, firstSeen, lastSeen, sender: mailLogNullable(raw.sender, 254), size: nullableCount(raw.size), recipientCount: nullableCount(raw.recipientCount), messageId: mailLogNullable(raw.messageId, 998), client: mailLogNullable(raw.client, 300), saslUsername: mailLogNullable(raw.saslUsername, 254), status: raw.status as MailLogStatusView, dsn: mailLogDsn(raw.dsn), recipients, recipientsOmitted: mailLogCount(raw.recipientsOmitted, 20000), events, eventsOmitted: mailLogCount(raw.eventsOmitted, 20000) }
}

export function readMailDeliveryView(value: unknown): MailDeliveryView {
  const base = mailLogBase(value, 'server'), raw = value as Record<string, unknown>
  if (!Array.isArray(raw.messages) || raw.messages.length > 20000 || typeof raw.lineLimitReached !== 'boolean') throw new Error('invalid_mail_delivery_view')
  const matched = mailLogCount(raw.matched, 20000), omittedMessages = mailLogCount(raw.omittedMessages, 20000)
  if (raw.messages.length + omittedMessages !== matched || base.state === 'unavailable' && matched !== 0) throw new Error('invalid_mail_delivery_view')
  return { ...base, counts: mailLogCounts(raw.counts), lineLimitReached: raw.lineLimitReached, matched, omittedMessages, messages: raw.messages.map(readMailLogMessage) }
}

export function readMailMonitorView(value: unknown): MailMonitorView {
  const base = mailLogBase(value, 'server'), raw = value as Record<string, unknown>, summary = raw.summary
  if (typeof raw.lineLimitReached !== 'boolean' || !mailLogObject(summary) || !mailLogObject(summary.statuses) || !Array.isArray(summary.topSenders) || summary.topSenders.length > 10
    || !Array.isArray(summary.topRecipientDomains) || summary.topRecipientDomains.length > 10 || !Array.isArray(summary.deferralReasons) || summary.deferralReasons.length > 10) throw new Error('invalid_mail_monitor_view')
  const counts = summary.statuses as Record<string, unknown>
  const statuses = { sent: mailLogCount(counts.sent, 20000), deferred: mailLogCount(counts.deferred, 20000), bounced: mailLogCount(counts.bounced, 20000), expired: mailLogCount(counts.expired, 20000), rejected: mailLogCount(counts.rejected, 20000), queued: mailLogCount(counts.queued, 20000) }
  const messages = mailLogCount(summary.messages, 20000)
  if (Object.values(statuses).reduce((sum, item) => sum + item, 0) !== messages || base.state === 'unavailable' && messages !== 0) throw new Error('invalid_mail_monitor_view')
  const row = (item: unknown): Record<string, unknown> => { if (!mailLogObject(item)) throw new Error('invalid_mail_monitor_row'); return item }
  return { ...base, counts: mailLogCounts(raw.counts), lineLimitReached: raw.lineLimitReached, summary: {
    messages, statuses,
    topSenders: summary.topSenders.map(item => { const value = row(item); return { address: mailLogText(value.address, 254), messages: mailLogCount(value.messages, 20000) } }),
    topRecipientDomains: summary.topRecipientDomains.map(item => { const value = row(item); return { domain: mailLogText(value.domain, 254), recipients: mailLogCount(value.recipients, 20000) } }),
    deferralReasons: summary.deferralReasons.map(item => { const value = row(item); return { dsn: mailLogDsn(value.dsn), reason: mailLogText(value.reason, 256), count: mailLogCount(value.count, 20000) } }),
  } }
}

function bindWhmMailLog(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const statusLabel: Record<string, string> = { sent: t('Delivered'), deferred: t('Deferred'), bounced: t('Bounced'), expired: t('Expired'), rejected: t('Rejected'), queued: t('Queued') }
  const kindLabel: Record<string, string> = { client: t('Received from client'), 'message-id': t('Message-ID recorded'), queued: t('Queued for delivery'), delivery: t('Delivery attempt'), rejected: t('Rejected'), expired: t('Expired and returned to sender'), notification: t('Notification sent to the sender'), removed: t('Removed from the queue') }
  const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
  const time = formatMailDateTime
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + 'Z'
  const utc = (raw: string): string | null => {
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(raw.trim())
    const value = match ? match[1] + 'T' + match[2] + ':00Z' : ''
    return match && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value.replace('Z', '.000Z') ? value : null
  }
  const bdi = (value: string): HTMLElement => { const item = document.createElement('bdi'); item.dir = 'ltr'; item.textContent = value; return item }
  const cell = (row: HTMLTableRowElement, value: string | Node, technical = false): HTMLTableCellElement => { const td = document.createElement('td'); td.append(typeof value === 'string' ? (technical ? bdi(value) : value) : value); row.append(td); return td }
  const empty = (body: Element, columns: number, message: string): void => { body.textContent = ''; const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns; td.textContent = message; row.append(td); body.append(row) }
  const reasonText = (reason: string | null): string => reason === 'output_limit' ? t('The journal window produced more output than the bounded read allows. Narrow the time range; nothing is shown.') : t('The mail journal is unavailable on this host. Nothing is shown and nothing was changed.')
  document.querySelectorAll<HTMLElement>('[data-whm-mail-log]').forEach(root => {
    if (root.dataset.mailLogBound === 'true') return
    root.dataset.mailLogBound = 'true'
    const delivery = root.dataset.whmMailLog === 'delivery'
    const form = root.querySelector<HTMLFormElement>('[data-mail-log-form]'), status = root.querySelector<HTMLElement>('[data-mail-log-status]'), range = root.querySelector<HTMLSelectElement>('[data-mail-log-range]'), submit = root.querySelector<HTMLButtonElement>('[data-mail-log-submit]')
    if (!form || !status || !range || !submit) return
    const admitted = (): boolean => root.isConnected && root.dataset.mailLogCanRead === 'true' && !root.closest(denied) && !!send
    const fact = (key: string, value: string): void => { const node = root.querySelector<HTMLElement>('[data-mail-log-fact="' + key + '"]'); if (node) node.textContent = value }
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const controls = form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')
    const custom = form.querySelectorAll<HTMLInputElement>('[data-mail-log-custom]')
    let busy = false, generation = 0, messages: MailLogMessageView[] = [], page = 0
    const sync = (): void => {
      const blocked = !admitted() || busy
      controls.forEach(control => { control.disabled = blocked })
      custom.forEach(input => { input.disabled = blocked || range.value !== 'custom' })
      root.setAttribute('aria-busy', String(busy))
    }
    const windowQuery = (): { since: string; until: string } | null => {
      if (range.value === 'custom') {
        const since = utc(custom[0]?.value ?? ''), until = utc(custom[1]?.value ?? '')
        return since && until && Date.parse(since) < Date.parse(until) && Date.parse(until) - Date.parse(since) <= 7 * 86400000 ? { since, until } : null
      }
      const end = Math.floor(Date.now() / 1000) * 1000
      return { since: iso(end - Number(range.value) * 3600000), until: iso(end) }
    }
    const integrity = (counts: MailLogCountsView, limited: boolean): void => {
      const node = root.querySelector<HTMLElement>('[data-mail-log-integrity]'), limit = root.querySelector<HTMLElement>('[data-mail-log-limit]')
      if (node) { node.hidden = false; node.textContent = t('Journal records read: {records}. Delivery events: {events}. Other Postfix lines skipped: {skipped}. Unparsed: {unparsed}. Not written by a Postfix binary: {untrusted}. Unparsed and untrusted records are counted, never shown as deliveries.', counts) }
      if (limit) limit.hidden = !limited
    }
    const detail = root.querySelector<HTMLElement>('[data-mail-log-detail]')
    const clearDetail = (): void => {
      if (!detail) return
      detail.querySelector<HTMLElement>('[data-mail-log-detail-empty]')!.hidden = false
      detail.querySelector<HTMLElement>('[data-mail-log-detail-body]')!.hidden = true
    }
    const showDetail = (message: MailLogMessageView): void => {
      if (!detail || !admitted()) return
      const facts = detail.querySelector<HTMLElement>('[data-mail-log-detail-facts]')!, recipients = detail.querySelector<HTMLElement>('[data-mail-log-detail-recipients]')!, events = detail.querySelector<HTMLElement>('[data-mail-log-detail-events]')!
      facts.textContent = ''
      const notLogged = t('Not logged')
      for (const [label, value, technical] of [[t('Queue ID'), message.queueId ?? t('None (rejected before queueing)'), !!message.queueId], [t('Sender'), message.sender === null ? notLogged : message.sender || t('Null sender (bounce)'), !!message.sender], [t('Status'), statusLabel[message.status]!, false], [t('First seen (UTC)'), time(message.firstSeen), true], [t('Last seen (UTC)'), time(message.lastSeen), true], [t('Size (bytes)'), message.size === null ? notLogged : String(message.size), message.size !== null], [t('Message-ID'), message.messageId ?? notLogged, message.messageId !== null], [t('Client'), message.client ?? notLogged, message.client !== null], [t('Authenticated user'), message.saslUsername ?? notLogged, message.saslUsername !== null]] as const) {
        const item = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.append(technical ? bdi(value) : value); item.append(dt, dd); facts.append(item)
      }
      recipients.textContent = ''
      for (const item of message.recipients) {
        const row = document.createElement('tr'), address = document.createElement('span'); address.append(bdi(item.address)); if (item.originalAddress) { const [before = '', after = ''] = t('(sent to {address})').split('{address}'); address.append(' ', before, bdi(item.originalAddress), after) }
        cell(row, address); cell(row, statusLabel[item.status]!); cell(row, item.dsn ?? notLogged, !!item.dsn); cell(row, item.relay ?? notLogged, !!item.relay); cell(row, String(item.attempts), true); cell(row, item.response ?? notLogged, !!item.response); recipients.append(row)
      }
      if (!message.recipients.length) empty(recipients, 6, t('No recipient delivery was logged in this window.'))
      if (message.recipientsOmitted) { const row = document.createElement('tr'); cell(row, t('Further recipients not shown: {n}', { n: message.recipientsOmitted })).colSpan = 6; recipients.append(row) }
      events.textContent = ''
      for (const event of message.events) { const item = document.createElement('li'), heading = document.createElement('strong'), text = document.createElement('bdi'); heading.append(bdi(time(event.at)), ' · ', kindLabel[event.kind] ?? event.kind, ' · ', bdi('postfix/' + event.source)); text.dir = 'ltr'; text.textContent = event.text; item.append(heading, text); events.append(item) }
      if (message.eventsOmitted) { const item = document.createElement('li'); item.textContent = t('Earlier events not shown: {n}', { n: message.eventsOmitted }); events.prepend(item) }
      detail.querySelector<HTMLElement>('[data-mail-log-detail-empty]')!.hidden = true
      detail.querySelector<HTMLElement>('[data-mail-log-detail-body]')!.hidden = false
      detail.focus()
    }
    const paintRows = (): void => {
      const body = root.querySelector<HTMLElement>('[data-mail-log-rows]'), pages = Math.max(1, Math.ceil(messages.length / 50))
      if (!body) return
      page = Math.min(page, pages - 1); body.textContent = ''
      for (const message of messages.slice(page * 50, page * 50 + 50)) {
        const row = document.createElement('tr'), list = document.createElement('span'), view = document.createElement('button')
        message.recipients.slice(0, 3).forEach((item, index) => { if (index) list.append(', '); list.append(bdi(item.address)) })
        const more = message.recipients.length - 3 + message.recipientsOmitted
        if (more > 0) list.append(' ', t('and {n} more', { n: more }))
        if (!message.recipients.length) list.append(t('None logged'))
        view.type = 'button'; view.className = 'xp-btn'; view.textContent = t('View timeline'); view.addEventListener('click', () => showDetail(message))
        cell(row, time(message.lastSeen), true); cell(row, message.queueId ?? t('Not queued'), !!message.queueId); cell(row, message.sender === null ? t('Not logged') : message.sender || '<>', true); cell(row, list); cell(row, statusLabel[message.status]!); cell(row, message.dsn ?? '-', true); cell(row, view)
        body.append(row)
      }
      if (!messages.length) empty(body, 7, t('No messages match these filters in this window. Widen the range or clear a filter.'))
      const label = root.querySelector<HTMLElement>('[data-mail-log-page-label]')
      if (label) label.textContent = messages.length ? t('Page {page} of {pages}', { page: page + 1, pages }) : ''
      root.querySelectorAll<HTMLButtonElement>('[data-mail-log-page]').forEach(button => { button.disabled = !admitted() || busy || (button.dataset.mailLogPage === 'newer' ? page === 0 : page >= pages - 1) })
    }
    const paintMonitor = (view: MailMonitorView | null): void => {
      root.querySelectorAll<HTMLElement>('[data-mail-monitor-count]').forEach(node => { node.textContent = view && view.state === 'read' ? String(view.summary.statuses[node.dataset.mailMonitorCount as MailLogStatusView] ?? 0) : t('Unavailable') })
      const fill = (key: string, rows: readonly (readonly (readonly [string, boolean])[])[], columns: number): void => {
        const body = root.querySelector<HTMLElement>('[data-mail-monitor-table="' + key + '"]')
        if (!body) return
        body.textContent = ''
        for (const values of rows) { const row = document.createElement('tr'); for (const [value, technical] of values) cell(row, value, technical); body.append(row) }
        if (!rows.length) empty(body, columns, view && view.state === 'read' ? t(msgctxt('whm-mail-log-client', 'Nothing was logged in this window.')) : t('Unavailable'))
      }
      const summary = view && view.state === 'read' ? view.summary : null
      fill('senders', (summary?.topSenders ?? []).map(item => [[item.address, true], [String(item.messages), true]] as const), 2)
      fill('domains', (summary?.topRecipientDomains ?? []).map(item => [[item.domain, true], [String(item.recipients), true]] as const), 2)
      fill('deferrals', (summary?.deferralReasons ?? []).map(item => [[item.dsn ?? '-', true], [item.reason || t('No reason logged'), !!item.reason], [String(item.count), true]] as const), 3)
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !send) return
      const selected = windowQuery()
      if (!selected) { note('failed', t('Enter a UTC start and end as YYYY-MM-DD HH:MM, at most 7 days apart. Nothing was read.')); return }
      const params = new URLSearchParams(selected)
      if (delivery) for (const name of ['sender', 'recipient', 'domain', 'status', 'dsn']) { const value = (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value.trim() ?? ''; if (value) params.set(name, value) }
      const token = ++generation
      busy = true; sync(); note('reading', t('Reading Postfix delivery events from the journal…'))
      try {
        const raw = await send('GET', '/api/server/mail-log/' + (delivery ? 'delivery' : 'monitor') + '?' + params)
        if (token !== generation || !admitted()) return
        const view = delivery ? readMailDeliveryView(raw) : readMailMonitorView(raw)
        fact('observed', time(view.observedAt)); fact('window', time(view.window.since) + ' – ' + time(view.window.until))
        integrity(view.counts, view.lineLimitReached)
        if (delivery) {
          const result = view as MailDeliveryView
          messages = result.messages; page = 0; clearDetail(); paintRows(); fact('matched', String(result.matched))
          const omitted = root.querySelector<HTMLElement>('[data-mail-log-omitted]')
          if (omitted) { omitted.hidden = !result.omittedMessages; omitted.textContent = t('Older matching messages not shown because of the response size limit: {n}. Narrow the time range to see them.', { n: result.omittedMessages }) }
        } else { paintMonitor(view as MailMonitorView); fact('messages', String((view as MailMonitorView).summary.messages)); fact('records', String(view.counts.records)) }
        if (view.state === 'unavailable') note('unavailable', reasonText(view.reason))
        else note('read', delivery ? t('Delivery events read. Messages are grouped by queue ID, newest first.') : t('Mail flow read from the journal window.'))
      } catch (error) {
        if (token !== generation) return
        messages = []; if (delivery) { paintRows(); clearDetail() } else paintMonitor(null)
        const code = mailLogObject(error) ? error.status : undefined
        note('failed', code === 422 ? t('The filters were refused. Check the values; nothing was read.') : code === 403 ? t('Root authorization is required to read mail logs.') : t('Delivery events could not be read or verified. Nothing is shown.'))
      } finally { if (token === generation) { busy = false; sync(); if (delivery) paintRows() } }
    }
    if (!admitted()) { sync(); note('unavailable', delivery ? t('Delivery reports are unavailable here. Nothing was read.') : t('The mail monitor is unavailable here. Nothing was read.')); return }
    form.addEventListener('submit', event => { event.preventDefault(); void load() })
    range.addEventListener('change', sync)
    root.querySelector<HTMLButtonElement>('[data-mail-log-clear]')?.addEventListener('click', () => { if (busy) return; form.reset(); range.value = '24'; sync(); void load() })
    root.querySelectorAll<HTMLButtonElement>('[data-mail-log-page]').forEach(button => button.addEventListener('click', () => { page += button.dataset.mailLogPage === 'newer' ? -1 : 1; paintRows() }))
    sync(); void load()
  })
}

export const WHM_MAIL_LOG_CLIENT_BINDING = `(()=>{const formatMailDateTime=${DISPLAY_DATETIME_BINDING};const mailLogObject=${mailLogObject.toString()};const mailLogText=${mailLogText.toString()};const mailLogNullable=${mailLogNullable.toString()};const mailLogInstant=${mailLogInstant.toString()};const mailLogCount=${mailLogCount.toString()};const mailLogDsn=${mailLogDsn.toString()};const mailLogBase=${mailLogBase.toString()};const mailLogCounts=${mailLogCounts.toString()};const readMailLogMessage=${readMailLogMessage.toString()};const readMailDeliveryView=${readMailDeliveryView.toString()};const readMailMonitorView=${readMailMonitorView.toString()};return ${bindWhmMailLog.toString()};})()`
