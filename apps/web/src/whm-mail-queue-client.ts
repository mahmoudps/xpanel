/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatMailDateTime = formatDisplayDateTime

export type MailQueueName = 'maildrop' | 'incoming' | 'active' | 'deferred' | 'hold'
export type MailQueueMessageView = { queueId: string; queue: MailQueueName; arrivalTime: string; sizeBytes: number; sender: string; recipients: { address: string; delayReason: string | null }[]; recipientCount: number; forcedExpire: boolean }
export type MailQueueView = { state: 'read' | 'unavailable'; observedAt: string; revision: string | null; truncated: boolean; counts: Record<MailQueueName, number>; messages: MailQueueMessageView[]; reason: string | null }
export type MailQueueActionView = { action: string; queueId: string; queue: string; outcome: 'confirmed' | 'attempted' | 'unknown'; after: { present: boolean | null; queue: MailQueueName | null } }
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
type Ask = (options: Record<string, unknown>) => Promise<unknown>

/** Strict reader for GET /api/server/mail-queue; unknown fields are dropped and any inconsistency is refused. */
export function readMailQueueView(value: unknown): MailQueueView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const names = ['maildrop', 'incoming', 'active', 'deferred', 'hold']
  const id = (item: unknown): item is string => typeof item === 'string' && (/^[0-9A-F]{6,20}$/.test(item) || /^[0-9B-DF-HJ-NP-TV-Zb-df-hj-np-tv-z]{10,26}$/.test(item))
  const iso = (item: unknown): item is string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) && Number.isFinite(Date.parse(item))
  const text = (item: unknown): item is string => typeof item === 'string' && item.length <= 512
  const int = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
  if (!object(value) || !['read', 'unavailable'].includes(String(value.state)) || !iso(value.observedAt) || typeof value.truncated !== 'boolean' || !object(value.counts) || !Array.isArray(value.messages) || value.messages.length > 5000) throw new Error('invalid_mail_queue')
  if (value.state === 'read' ? typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) : value.revision !== null || value.messages.length !== 0) throw new Error('invalid_mail_queue')
  const counts: Record<string, number> = { maildrop: 0, incoming: 0, active: 0, deferred: 0, hold: 0 }, seen = new Set<string>()
  const messages = value.messages.map(raw => {
    if (!object(raw) || !id(raw.queueId) || seen.has(raw.queueId) || !names.includes(String(raw.queue)) || !iso(raw.arrivalTime) || !int(raw.sizeBytes) || !text(raw.sender) || !Array.isArray(raw.recipients) || raw.recipients.length > 100 || !int(raw.recipientCount) || raw.recipientCount < raw.recipients.length || typeof raw.forcedExpire !== 'boolean') throw new Error('invalid_mail_queue_message')
    seen.add(raw.queueId); counts[String(raw.queue)]! += 1
    const recipients = raw.recipients.map(item => {
      if (!object(item) || !text(item.address) || item.delayReason !== null && !text(item.delayReason)) throw new Error('invalid_mail_queue_recipient')
      return { address: item.address, delayReason: item.delayReason as string | null }
    })
    return { queueId: raw.queueId, queue: raw.queue as MailQueueName, arrivalTime: raw.arrivalTime, sizeBytes: raw.sizeBytes, sender: raw.sender, recipients, recipientCount: raw.recipientCount, forcedExpire: raw.forcedExpire }
  })
  const reported = value.counts
  if (names.some(name => reported[name] !== counts[name])) throw new Error('invalid_mail_queue_counts')
  return { state: value.state as 'read' | 'unavailable', observedAt: value.observedAt, revision: value.revision as string | null, truncated: value.truncated, counts: counts as Record<MailQueueName, number>, messages, reason: typeof value.reason === 'string' ? value.reason : null }
}

/** Accepts an action result only when its outcome matches the re-read it reports; deliver is never "confirmed". */
export function readMailQueueActionResult(value: unknown, input: { action: string; queueId: string; queue: string }): MailQueueActionView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || value.action !== input.action || value.queueId !== input.queueId || value.queue !== input.queue || !['confirmed', 'attempted', 'unknown'].includes(String(value.outcome)) || !object(value.after)) throw new Error('invalid_mail_queue_result')
  const present = value.after.present, queue = value.after.queue
  if (![true, false, null].includes(present as boolean | null) || queue !== null && !['maildrop', 'incoming', 'active', 'deferred', 'hold'].includes(String(queue)) || (present === true) !== (queue !== null)) throw new Error('invalid_mail_queue_result')
  const proven = input.action === 'delete' ? present === false : input.action === 'hold' ? queue === 'hold' : input.action === 'release' ? present !== null && queue !== 'hold' : present !== null && queue !== input.queue
  if (value.outcome === 'attempted' ? input.action !== 'deliver' || present === null : value.outcome === 'confirmed' && (input.action === 'deliver' || !proven)) throw new Error('invalid_mail_queue_result')
  return { action: input.action, queueId: input.queueId, queue: input.queue, outcome: value.outcome as MailQueueActionView['outcome'], after: { present: present as boolean | null, queue: queue as MailQueueName | null } }
}

function bindWhmMailQueue(askDialog: Ask | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-mail-queue-workspace]').forEach(root => {
    if (root.dataset.mailQueueBound === 'true') return
    root.dataset.mailQueueBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-whm-mail-queue-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-whm-mail-queue-refresh]')
    const rows = root.querySelector<HTMLElement>('[data-whm-mail-queue-rows]'), banner = root.querySelector<HTMLElement>('[data-whm-mail-queue-result]'), results = root.querySelector<HTMLElement>('[data-whm-mail-queue-results]')
    const selectAll = root.querySelector<HTMLInputElement>('[data-whm-mail-queue-select-all]'), selectedLabel = root.querySelector<HTMLElement>('[data-whm-mail-queue-selected]')
    const filter = (name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>('[data-whm-mail-queue-filter="' + name + '"]')
    const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    if (!status || !refresh || !rows || !banner || !results || !selectAll || !selectedLabel) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.mailQueueCanRead === 'true' && !root.closest(denied) && !!request
    const manageable = (): boolean => admitted() && root.dataset.mailQueueCanManage === 'true'
    const names: Record<string, string> = { incoming: t('Incoming'), active: t(msgctxt('whm-mail-queue-client', 'Active')), deferred: t(msgctxt('whm-mail-queue-client', 'Deferred')), hold: t('Hold'), maildrop: t('Maildrop') }
    const labels: Record<string, string> = { deliver: t('Retry now'), hold: t(msgctxt('whm-mail-queue-client', 'Hold')), release: t('Release'), delete: t('Delete') }
    const eligible = (action: string, queue: string): boolean => action === 'deliver' ? queue === 'deferred' : action === 'release' ? queue === 'hold' : action === 'hold' ? ['incoming', 'active', 'deferred'].includes(queue) : ['incoming', 'active', 'deferred', 'hold'].includes(queue)
    let view: MailQueueView | null = null, busy = false
    const selected = new Set<string>()
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const technical = (value: string): HTMLElement => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; return bdi }
    const size = (bytes: number): string => bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB'
    const age = (message: MailQueueMessageView): number => Math.max(0, Math.floor((Date.parse(view?.observedAt ?? message.arrivalTime) - Date.parse(message.arrivalTime)) / 1000))
    const ageText = (seconds: number): string => seconds < 3600 ? t('{n} min', { n: Math.floor(seconds / 60) }) : seconds < 86400 ? t('{n} h', { n: Math.floor(seconds / 3600) }) : t('{n} d', { n: Math.floor(seconds / 86400) })
    const shown = (): MailQueueMessageView[] => {
      const queue = filter('queue')?.value ?? '', needle = (filter('text')?.value ?? '').trim().toLowerCase(), minimum = Number(filter('age')?.value ?? '0') || 0
      return (view?.messages ?? []).filter(item => (!queue || item.queue === queue) && age(item) >= minimum
        && (!needle || item.sender.toLowerCase().includes(needle) || item.recipients.some(recipient => recipient.address.toLowerCase().includes(needle))))
    }
    const controls = (): void => {
      const visible = shown(), manage = manageable() && !busy && !!view?.revision
      refresh.disabled = busy || !admitted()
      selectedLabel.textContent = t('Selected: {n}', { n: selected.size })
      root.querySelectorAll<HTMLButtonElement>('[data-whm-mail-queue-bulk]').forEach(button => { button.disabled = !manage || selected.size === 0 })
      root.querySelectorAll<HTMLButtonElement>('[data-whm-mail-queue-row-action]').forEach(button => { button.disabled = !manage || !eligible(button.dataset.whmMailQueueRowAction ?? '', button.dataset.queue ?? '') })
      root.querySelectorAll<HTMLInputElement>('[data-whm-mail-queue-select]').forEach(box => { box.disabled = !manage; box.checked = selected.has(box.dataset.whmMailQueueSelect ?? '') })
      selectAll.disabled = !manage || visible.length === 0
      selectAll.checked = visible.length > 0 && visible.every(item => selected.has(item.queueId))
      root.setAttribute('aria-busy', String(busy))
    }
    const paint = (): void => {
      const current = view
      for (const name of Object.keys(names)) { const cell = root.querySelector<HTMLElement>('[data-whm-mail-queue-count="' + name + '"]'); if (cell) cell.textContent = current ? String(current.counts[name as MailQueueName]) : t('Not read') }
      const total = root.querySelector<HTMLElement>('[data-whm-mail-queue-total-size]'), observed = root.querySelector<HTMLElement>('[data-whm-mail-queue-observed-at]'), truncated = root.querySelector<HTMLElement>('[data-whm-mail-queue-truncated]')
      if (total) total.textContent = current ? size(current.messages.reduce((sum, item) => sum + item.sizeBytes, 0)) : t('Not read')
      if (observed) observed.textContent = current ? formatMailDateTime(current.observedAt) : t('Not read')
      if (truncated) truncated.hidden = !current?.truncated
      rows.textContent = ''
      const visible = shown()
      for (const item of visible) {
        const row = document.createElement('tr'), cell = (content: (string | Node)[]): void => { const td = document.createElement('td'); td.append(...content); row.append(td) }
        const box = document.createElement('input'); box.type = 'checkbox'; box.dataset.whmMailQueueSelect = item.queueId; box.setAttribute('aria-label', t('Select message {id}', { id: item.queueId }))
        cell([box]); cell([technical(item.queueId)]); cell([names[item.queue] ?? item.queue, ...(item.forcedExpire ? [' · ' + t('Forced to expire')] : [])])
        cell([technical(formatMailDateTime(item.arrivalTime))]); cell([ageText(age(item))]); cell([technical(size(item.sizeBytes))])
        cell([item.sender ? technical(item.sender) : t('Null sender (bounce)')])
        const first = item.recipients[0]
        cell([String(item.recipientCount), ...(first ? [' · ', technical(first.address)] : []), ...(item.recipientCount > 1 ? [technical(' +' + (item.recipientCount - 1))] : [])])
        const reason = item.recipients.find(recipient => recipient.delayReason)?.delayReason
        cell([reason ? technical(reason) : t('None reported')])
        const actions = document.createElement('div'); actions.className = 'xp-whm-mail-queue__row-actions'
        for (const action of ['deliver', 'hold', 'release', 'delete']) {
          const button = document.createElement('button'); button.type = 'button'; button.className = action === 'delete' ? 'xp-btn xp-btn--danger' : 'xp-btn'
          button.dataset.whmMailQueueRowAction = action; button.dataset.queueId = item.queueId; button.dataset.queue = item.queue; button.textContent = labels[action]!
          button.setAttribute('aria-label', labels[action] + ' ' + item.queueId); actions.append(button)
        }
        cell([actions]); rows.append(row)
      }
      if (!visible.length) {
        const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 10
        td.textContent = !current ? t('No messages have been read.') : current.state !== 'read' ? t('The queue listing is unavailable.') : current.messages.length ? t('No messages match the filters.') : t('The queue is empty.')
        row.append(td); rows.append(row)
      }
      controls()
    }
    const describe = (action: string, kind: string, after?: MailQueueActionView['after']): string => {
      if (kind === 'confirmed') return t('{action}: confirmed by a fresh queue read.', { action: labels[action]! })
      if (kind === 'attempted') return after?.queue ? t('Retry requested. Postfix accepted it; the message is now in the {queue} queue. Delivery is not verified.', { queue: names[after.queue]! })
        : t('Retry requested. The message is no longer queued; delivery is not verified.')
      if (kind === 'conflict') return t('The message moved or left the queue. Nothing was changed.')
      if (kind === 'refused') return t('The action was refused. Nothing was changed.')
      if (kind === 'skipped') return t('Not applicable to this queue; nothing was sent.')
      if (kind === 'denied') return t('Authorization is no longer valid. Nothing further was sent.')
      return t('Outcome unknown. Postfix may have changed this message; reload the queue before acting again.')
    }
    const show = (kind: string, message: string): void => { banner.hidden = false; banner.dataset.outcome = kind; banner.textContent = message; banner.setAttribute('role', ['unknown', 'denied'].includes(kind) ? 'alert' : 'status') }
    const send = async (action: string, item: MailQueueMessageView, revision: string): Promise<{ kind: string; after?: MailQueueActionView['after'] }> => {
      const input = { action, queueId: item.queueId, queue: item.queue }
      let value: unknown
      try { value = await request!('POST', '/api/server/mail-queue/action', { ...input, expectedRevision: revision }) }
      catch (error) {
        const problem = error && typeof error === 'object' ? error as { status?: number; code?: string; details?: Record<string, unknown> } : {}, details = problem.details && typeof problem.details === 'object' ? problem.details : {}
        if (details.unknownOutcome === true || details.verificationRequired === true) return { kind: 'unknown' }
        if (problem.status === 401 || problem.status === 403) return { kind: 'denied' }
        if (problem.status === 409 || problem.code === 'CONFLICT') return { kind: 'conflict' }
        return { kind: details.stateChanged === false ? 'refused' : 'unknown' }
      }
      try { const result = readMailQueueActionResult(value, input); return { kind: result.outcome, after: result.after } } catch { return { kind: 'unknown' } }
    }
    const confirm = async (options: Record<string, unknown>): Promise<boolean> => {
      if (!askDialog) { show('refused', t('Confirmation is unavailable; nothing was changed.')); return false }
      busy = true; controls()
      try { return await askDialog(options) === true } catch { return false } finally { busy = false; controls() }
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; controls(); note('reading', t('Reading the Postfix queue…'))
      try {
        const next = readMailQueueView(await request!('GET', '/api/server/mail-queue'))
        if (!admitted()) return
        view = next
        for (const queueId of [...selected]) if (!next.messages.some(item => item.queueId === queueId)) selected.delete(queueId)
        const reasons: Record<string, string> = { command_failed: t('Postfix did not return a queue listing. Nothing was changed.'), output_limit: t('The queue listing exceeded the bounded read size. Nothing was changed.'), malformed_output: t('The queue listing could not be parsed, so nothing is shown. Nothing was changed.') }
        note(next.state === 'read' ? next.messages.length ? 'read' : 'empty' : 'unavailable', next.state === 'read' ? next.messages.length ? t('Queue read from Postfix.') : t('The queue is empty.') : reasons[next.reason ?? ''] ?? reasons.command_failed!)
      } catch { if (admitted()) note('failed', t('The queue could not be read. Any rows shown are from the last successful read.')) }
      finally { busy = false; paint() }
    }
    const single = async (action: string, item: MailQueueMessageView): Promise<void> => {
      const revision = view?.revision
      if (busy || !manageable() || !revision || !eligible(action, item.queue)) return
      if (action === 'delete' || action === 'hold') {
        const body = item.queueId + '\n' + (action === 'delete' ? t('The message is removed from the Postfix queue and is not delivered. This cannot be undone.') : t('Delivery stops until the message is released.'))
        if (!await confirm({ title: action === 'delete' ? t('Delete queued message?') : t('Hold queued message?'), body, confirm: action === 'delete' ? t('Delete message') : t('Hold message'), danger: action === 'delete' }) || !manageable()) return
      }
      busy = true; controls(); results.hidden = true; results.textContent = ''
      const outcome = await send(action, item, revision)
      busy = false
      show(outcome.kind, describe(action, outcome.kind, outcome.after))
      await load()
    }
    const bulk = async (action: string): Promise<void> => {
      const revision = view?.revision
      if (busy || !manageable() || !revision) return
      const targets = (view?.messages ?? []).filter(item => selected.has(item.queueId))
      if (!targets.length) return
      if (targets.length > 50) { show('refused', t('Select at most 50 messages for one bulk run. Nothing was sent.')); return }
      if (!await confirm({ title: labels[action] + ' · ' + targets.length, body: t('Each message is processed in sequence and re-read before its result is reported.'), confirm: labels[action], danger: action === 'delete' }) || !manageable()) return
      busy = true; controls(); results.textContent = ''; results.hidden = false
      const tally: Record<string, number> = {}
      for (const item of targets) {
        if (!manageable()) break
        const outcome = eligible(action, item.queue) ? await send(action, item, revision) : { kind: 'skipped' }
        tally[outcome.kind] = (tally[outcome.kind] ?? 0) + 1
        const entry = document.createElement('li'); entry.dataset.outcome = outcome.kind; entry.append(technical(item.queueId), ': ' + describe(action, outcome.kind, 'after' in outcome ? outcome.after : undefined)); results.append(entry)
        if (outcome.kind === 'denied') break
      }
      const count = (kind: string): number => tally[kind] ?? 0
      const worst = count('denied') ? 'denied' : count('unknown') ? 'unknown' : count('confirmed') + count('attempted') === targets.length ? 'confirmed' : 'refused'
      show(worst, t('Bulk run finished: {confirmed} confirmed, {attempted} attempted, {unknown} unknown, {refused} refused or skipped.', { confirmed: count('confirmed'), attempted: count('attempted'), unknown: count('unknown'), refused: count('refused') + count('conflict') + count('skipped') + count('denied') }) + (targets.length > results.childElementCount ? ' ' + t('Remaining messages were not sent.') : ''))
      busy = false; selected.clear()
      await load()
    }
    rows.addEventListener('click', event => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-whm-mail-queue-row-action]')
      const item = view?.messages.find(message => message.queueId === button?.dataset.queueId)
      if (button && item && !button.disabled) void single(button.dataset.whmMailQueueRowAction ?? '', item)
    })
    rows.addEventListener('change', event => {
      const box = event.target as HTMLInputElement
      const queueId = box?.dataset?.whmMailQueueSelect
      if (!queueId || busy || !manageable()) return
      if (box.checked) selected.add(queueId); else selected.delete(queueId)
      controls()
    })
    selectAll.addEventListener('change', () => { if (busy || !manageable()) return; for (const item of shown()) { if (selectAll.checked) selected.add(item.queueId); else selected.delete(item.queueId) } controls() })
    root.querySelectorAll<HTMLButtonElement>('[data-whm-mail-queue-bulk]').forEach(button => button.addEventListener('click', () => { void bulk(button.dataset.whmMailQueueBulk ?? '') }))
    for (const name of ['queue', 'text', 'age']) filter(name)?.addEventListener(name === 'text' ? 'input' : 'change', () => { if (view) paint() })
    refresh.addEventListener('click', () => { void load() })
    if (!admitted()) { refresh.disabled = true; note('unavailable', t('The mail queue is unavailable here. Nothing was read or changed.')); return }
    void load()
  })
}

export const WHM_MAIL_QUEUE_CLIENT_BINDING = `(()=>{const formatMailDateTime=${DISPLAY_DATETIME_BINDING};const readMailQueueView=${readMailQueueView.toString()};const readMailQueueActionResult=${readMailQueueActionResult.toString()};return ${bindWhmMailQueue.toString()};})()`
