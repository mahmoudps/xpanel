import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />

/**
 * Mailing list moderation controllers: the owner's posting policy and queue (xPanel), and the same queue from webmail for a
 * moderator mailbox or the holder of the list password (xMail). Each theme owns the markup under one set of hooks.
 */
export interface ModerationRow { id: string; at: string; from: string; subject: string; size: number; reason: string }
export interface ModerationQueue { total: number; rows: ModerationRow[] }
export interface HeldMessage extends ModerationRow { headers: string; body: string; truncated: boolean }
export interface ListPolicyView {
  moderators: string[]; moderatedMembers: string[]; nonMemberAction: string; memberAction: string
  acceptSenders: string[]; holdSenders: string[]; rejectSenders: string[]; discardSenders: string[]
  maxMessageKb: number; notifyModerators: boolean; notifySender: boolean; retentionDays: number
}
export interface ListModerationView {
  id: string; address: string; moderation: string; selfSubscription: string; policy: ListPolicyView; revision: string; gated: boolean
  host: { state: string; ready: boolean | null; active: boolean | null }
}
export function moderationObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function moderationRow(value: unknown): ModerationRow {
  if (!moderationObject(value) || typeof value.id !== 'string' || !/^\d{8}-[0-9a-f]{32}$/.test(value.id) || typeof value.at !== 'string' || typeof value.from !== 'string' || typeof value.subject !== 'string' || !Number.isSafeInteger(value.size) || typeof value.reason !== 'string') throw new Error('invalid_moderation_row')
  return { id: value.id, at: value.at, from: value.from, subject: value.subject, size: value.size as number, reason: value.reason }
}
export function readModerationQueue(value: unknown): ModerationQueue {
  if (!moderationObject(value) || !Number.isSafeInteger(value.total) || !Array.isArray(value.rows) || value.rows.length > 500) throw new Error('invalid_moderation_queue')
  return { total: value.total as number, rows: value.rows.map(moderationRow) }
}
export function readHeldMessage(value: unknown): HeldMessage {
  if (!moderationObject(value) || typeof value.headers !== 'string' || typeof value.body !== 'string' || typeof value.truncated !== 'boolean') throw new Error('invalid_held_message')
  return { ...moderationRow(value), headers: value.headers, body: value.body, truncated: value.truncated }
}
export function readListModeration(value: unknown): ListModerationView {
  if (!moderationObject(value) || typeof value.id !== 'string' || typeof value.address !== 'string' || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || typeof value.gated !== 'boolean' || !moderationObject(value.policy) || !moderationObject(value.host) || !['open', 'members', 'moderated'].includes(String(value.moderation)) || !['open', 'closed'].includes(String(value.selfSubscription))) throw new Error('invalid_list_moderation')
  return value as unknown as ListModerationView
}
/** One address or pattern per line; the server validates each entry. */
export function moderationLines(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map(line => line.trim().toLowerCase()).filter(Boolean))]
}
export function moderationWhole(value: string, max: number): number {
  const text = value.trim()
  if (!/^\d{1,7}$/.test(text) || Number(text) > max) throw new Error('invalid_moderation_number')
  return Number(text)
}
/** `YYYY-MM-DD HH:mm` of an ISO time, always read as UTC. */
export function moderationTime(value: string): string {
  return value.slice(0, 16).replace('T', ' ') + ' UTC'
}

function bindListModeration(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const copy = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const denied = (root: HTMLElement): boolean => root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled') !== null
  const refusals: Record<string, string> = {
    list_password_wrong: copy('The list password is not correct.'),
    list_admin_locked: copy('List sign-in is locked for 15 minutes after repeated wrong passwords.'),
    list_password_unset: copy('This list has no administrator password yet. The account owner sets it in xPanel.'),
    list_moderator_required: copy('This mailbox is not a moderator of the list. Enter the list password.'),
    list_member_unknown: copy('A moderated member must be a member of the list.'),
    sieve_extprograms_missing: copy("This server lacks Pigeonhole's external programs module, so it cannot limit who posts."),
    host_agent_unavailable: copy('No host agent is connected, so the queue cannot be read.'),
  }
  const failure = (error: unknown, fallback: string): string => {
    const detail = moderationObject(error) && moderationObject(error.details) ? error.details : {}
    if (detail.stateChanged !== false || detail.verificationRequired === true) return copy('The outcome is uncertain. Reload and inspect before retrying; nothing was retried.')
    return typeof detail.reason === 'string' && refusals[detail.reason] ? refusals[detail.reason]! : fallback
  }
  const heldReasons: Record<string, string> = {
    non_member: copy('Sender is not a member'), moderated_member: copy('Member is moderated'), moderated_list: copy('Every post needs approval'), sender_filter: copy('Matches a sender rule'),
    too_large: copy('Larger than the size limit'), automated: copy('Looks automated'), gate_failed: copy('The delivery check failed'),
  }
  const stateText = (view: ListModerationView): string => view.host.state !== 'connected' ? copy('Not read')
    : view.host.ready === false ? copy('Unavailable: this server lacks the external programs module')
      : !view.gated ? copy('Not needed: this list has no posting rules')
        : view.host.active ? copy('Checking posts') : copy('Saved, not applied yet')

  type Say = (message: string, kind: string) => void
  type Call = (op: 'queue' | 'message' | 'act', args: Record<string, unknown>) => Promise<unknown>
  /** The held message table, shared by both surfaces; `call` carries the surface's own sign-in. */
  const queuePanel = (root: HTMLElement, say: Say): { read: (call: Call) => Promise<void>; clear: () => void } | null => {
    const rows = root.querySelector<HTMLTableSectionElement>('tbody[data-moderation-rows]'), approve = root.querySelector<HTMLButtonElement>('button[data-moderation-approve]')
    const reject = root.querySelector<HTMLButtonElement>('button[data-moderation-reject]'), discard = root.querySelector<HTMLButtonElement>('button[data-moderation-discard]')
    const reason = root.querySelector<HTMLInputElement>('input[data-moderation-reason]'), message = root.querySelector<HTMLElement>('pre[data-moderation-message]'), held = root.querySelector<HTMLElement>('[data-moderation-held]')
    if (!rows || !approve || !reject || !discard || !reason || !message) return null
    let call: Call | null = null
    const picked = (): string[] => [...rows.querySelectorAll<HTMLInputElement>('input[data-xp-slot="select"]:checked')].map(item => item.value)
    const buttons = (busy = false): void => { const none = busy || !picked().length; approve.disabled = none; reject.disabled = none; discard.disabled = none; reason.disabled = none }
    const paint = (queue: ModerationQueue): void => {
      rows.textContent = ''; message.textContent = ''; message.hidden = true
      if (held) held.textContent = String(queue.total)
      for (const item of queue.rows) {
        const row = cloneClientTemplate(clientTemplate(root, 'list-moderation-row'), 'tr', ['select', 'from', 'subject', 'reason', 'at', 'open'])
        const select = clientTemplateSlot(row, 'select', 'input') as HTMLInputElement
        select.value = item.id; select.setAttribute('aria-label', item.subject || item.from); select.addEventListener('change', () => buttons())
        clientTemplateSlot(row, 'from').textContent = item.from || copy('Unknown sender')
        clientTemplateSlot(row, 'subject').textContent = item.subject || copy('No subject')
        clientTemplateSlot(row, 'reason').textContent = heldReasons[item.reason] ?? item.reason
        clientTemplateSlot(row, 'at').textContent = moderationTime(item.at) + ' · ' + copy('{size} KB', { size: Math.ceil(item.size / 1024) })
        const open = clientTemplateSlot(row, 'open', 'button') as HTMLButtonElement
        open.textContent = copy('Read message'); open.disabled = false
        open.addEventListener('click', () => { void show(item.id) })
        rows.appendChild(row)
      }
      buttons()
    }
    const show = async (id: string): Promise<void> => {
      if (!call) return
      try {
        const item = readHeldMessage(await call('message', { id }))
        message.textContent = item.headers + '\n\n' + item.body + (item.truncated ? '\n\n' + copy('This view stops at 256 KB.') : ''); message.hidden = false
      } catch (error) { say(failure(error, copy('The held message could not be read.')), 'failed') }
    }
    const read = async (next: Call): Promise<void> => {
      call = next
      paint(readModerationQueue(await next('queue', {})))
    }
    const decide = async (action: 'approve' | 'reject' | 'discard'): Promise<void> => {
      const ids = picked(), current = call
      if (!current || !ids.length) return
      if (action === 'discard') {
        if (typeof askDialog !== 'function') { say(copy('Discarding needs confirmation; nothing was sent.'), 'failed'); return }
        if (await askDialog({ title: copy('Discard held messages'), body: copy('{count, plural, one {# message will be deleted without telling its sender.} other {# messages will be deleted without telling their senders.}}', { count: ids.length }), confirm: copy('Discard'), danger: true }) !== true) { say(copy('Nothing was discarded.'), 'cancelled'); return }
      }
      buttons(true); say(copy('Sending the decision…'), 'saving')
      try {
        const reply = await current('act', { action, ids, reason: action === 'reject' ? reason.value.trim() : '' })
        if (!moderationObject(reply) || !Number.isSafeInteger(reply.done) || !Number.isSafeInteger(reply.failed)) throw Object.assign(new Error('invalid_moderation_ack'), { details: { stateChanged: true } })
        reason.value = ''
        await read(current)
        say(reply.failed ? copy('{done} decided. {failed} could not be sent and stay held.', { done: reply.done as number, failed: reply.failed as number }) : copy('{done} decided.', { done: reply.done as number }), reply.failed ? 'failed' : 'saved')
      } catch (error) { say(failure(error, copy('The decision was refused. Nothing changed.')), 'failed') }
      finally { buttons() }
    }
    approve.addEventListener('click', () => { void decide('approve') })
    reject.addEventListener('click', () => { void decide('reject') })
    discard.addEventListener('click', () => { void decide('discard') })
    return { read, clear: () => { call = null; rows.textContent = ''; message.textContent = ''; message.hidden = true; if (held) held.textContent = copy('Not read'); buttons() } }
  }
  const sayIn = (root: HTMLElement): Say => {
    const status = root.querySelector<HTMLElement>('[data-moderation-status]')
    return (message, kind) => { if (!status) return; status.hidden = !message; status.dataset.state = kind; status.setAttribute('role', kind === 'failed' ? 'alert' : 'status'); status.textContent = message }
  }

  // xPanel: the owner picks a list, edits its policy and works its queue.
  document.querySelectorAll<HTMLElement>('[data-list-moderation]').forEach(root => {
    if (root.dataset.listModerationBound === 'true') return
    root.dataset.listModerationBound = 'true'
    const say = sayIn(root), own = root.querySelector<HTMLElement>('[data-moderation-queue]'), panel = own && queuePanel(own, say)
    const list = root.querySelector<HTMLSelectElement>('select[data-moderation-list]'), save = root.querySelector<HTMLButtonElement>('button[data-moderation-save]')
    const posting = root.querySelector<HTMLSelectElement>('select[data-moderation-posting]'), subscription = root.querySelector<HTMLSelectElement>('select[data-moderation-subscription]')
    const nonMember = root.querySelector<HTMLSelectElement>('select[data-moderation-non-member]'), member = root.querySelector<HTMLSelectElement>('select[data-moderation-member]')
    const moderators = root.querySelector<HTMLTextAreaElement>('textarea[data-moderation-moderators]'), moderated = root.querySelector<HTMLTextAreaElement>('textarea[data-moderation-moderated]')
    const accept = root.querySelector<HTMLTextAreaElement>('textarea[data-moderation-accept]'), hold = root.querySelector<HTMLTextAreaElement>('textarea[data-moderation-hold]')
    const reject = root.querySelector<HTMLTextAreaElement>('textarea[data-moderation-reject-senders]'), discard = root.querySelector<HTMLTextAreaElement>('textarea[data-moderation-discard-senders]')
    const size = root.querySelector<HTMLInputElement>('input[data-moderation-size]'), retention = root.querySelector<HTMLInputElement>('input[data-moderation-retention]')
    const notifyModerators = root.querySelector<HTMLInputElement>('input[data-moderation-notify-moderators]'), notifySender = root.querySelector<HTMLInputElement>('input[data-moderation-notify-sender]')
    const state = root.querySelector<HTMLElement>('[data-moderation-state]')
    if (!panel || !list || !save || !posting || !subscription || !nonMember || !member || !moderators || !moderated || !accept || !hold || !reject || !discard || !size || !retention || !notifyModerators || !notifySender) return
    const form = [posting, subscription, nonMember, member, moderators, moderated, accept, hold, reject, discard, size, retention, notifyModerators, notifySender, save]
    const off = (value: boolean): void => { for (const control of form) control.disabled = value }
    if (typeof transport !== 'function' || root.dataset.moderationCanManage !== 'true' || denied(root)) {
      off(true); list.disabled = true; say(copy('List moderation is unavailable here. Nothing was read or changed.'), 'unavailable'); return
    }
    let view: ListModerationView | null = null
    const call = (id: string): Call => (op, args) => transport('POST', '/api/mail/mailing-lists/' + encodeURIComponent(id) + '/moderation/queue', { op, args })
    const fill = (next: ListModerationView): void => {
      view = next
      const policy = next.policy
      posting.value = next.moderation; subscription.value = next.selfSubscription; nonMember.value = policy.nonMemberAction; member.value = policy.memberAction
      moderators.value = policy.moderators.join('\n'); moderated.value = policy.moderatedMembers.join('\n'); accept.value = policy.acceptSenders.join('\n')
      hold.value = policy.holdSenders.join('\n'); reject.value = policy.rejectSenders.join('\n'); discard.value = policy.discardSenders.join('\n')
      size.value = String(policy.maxMessageKb); retention.value = String(policy.retentionDays); notifyModerators.checked = policy.notifyModerators; notifySender.checked = policy.notifySender
      if (state) state.textContent = stateText(next)
    }
    const open = async (): Promise<void> => {
      panel.clear(); off(true)
      if (!list.value) return
      try {
        fill(readListModeration(await transport('GET', '/api/mail/mailing-lists/' + encodeURIComponent(list.value) + '/moderation')))
        off(false)
        say('', 'read')
        if (view?.host.state === 'connected' && view.host.ready) await panel.read(call(list.value))
      } catch (error) { say(failure(error, copy('The list moderation settings could not be read. Nothing was changed.')), 'failed') }
    }
    list.addEventListener('change', () => { void open() })
    save.addEventListener('click', () => {
      if (!view) return
      let body: Record<string, unknown>
      try {
        body = { moderation: posting.value, selfSubscription: subscription.value, expectedRevision: view.revision, policy: { moderators: moderationLines(moderators.value), moderatedMembers: moderationLines(moderated.value), nonMemberAction: nonMember.value, memberAction: member.value, acceptSenders: moderationLines(accept.value), holdSenders: moderationLines(hold.value), rejectSenders: moderationLines(reject.value), discardSenders: moderationLines(discard.value), maxMessageKb: moderationWhole(size.value, 1048576), notifyModerators: notifyModerators.checked, notifySender: notifySender.checked, retentionDays: moderationWhole(retention.value, 365) } }
      } catch { say(copy('The size limit and the retention days are whole numbers. Nothing was sent.'), 'failed'); return }
      off(true); say(copy('Saving the posting policy…'), 'saving')
      transport('PUT', '/api/mail/mailing-lists/' + encodeURIComponent(view.id) + '/moderation', body)
        .then(reply => { fill(readListModeration(reply)); say(copy('The posting policy was saved and read back.'), 'saved') })
        .catch(error => say(failure(error, copy('The posting policy was refused. Nothing was changed.')), 'failed'))
        .finally(() => off(false))
    })
    void (async () => {
      try {
        const value = await transport('GET', '/api/mail/mailing-lists')
        const rows = moderationObject(value) && Array.isArray(value.mailingLists) ? value.mailingLists.filter(moderationObject).map(item => ({ id: String(item.id), address: String(item.address) })) : []
        list.textContent = ''
        for (const row of rows) list.appendChild(new Option(row.address, row.id))
        if (rows.length) await open(); else { off(true); list.disabled = true; say(copy('Create a mailing list first.'), 'read') }
      } catch { off(true); say(copy('Saved mailing lists could not be read. Nothing was changed.'), 'failed') }
    })()
  })

  // xMail: a moderator mailbox, or whoever holds the list password, works the queue.
  document.querySelectorAll<HTMLElement>('[data-list-admin]').forEach(root => {
    const own = root.querySelector<HTMLElement>('[data-moderation-queue]'), start = root.querySelector<HTMLButtonElement>('button[data-moderation-open]')
    if (!own || !start || own.dataset.moderationBound === 'true') return
    own.dataset.moderationBound = 'true'
    const say = sayIn(own), panel = queuePanel(own, say)
    const address = root.querySelector<HTMLInputElement>('input[data-list-admin-address]'), password = root.querySelector<HTMLInputElement>('input[data-list-admin-password]')
    if (!panel || !address || !password) return
    if (typeof transport !== 'function' || denied(root)) { start.disabled = true; return }
    start.disabled = false
    start.addEventListener('click', () => {
      const list = address.value.trim().toLowerCase()
      if (!/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(list)) { say(copy('Enter the list address. Nothing was sent.'), 'failed'); return }
      const secret = password.value || null
      say(copy('Opening the moderation queue…'), 'saving'); start.disabled = true
      panel.clear()
      panel.read((op, args) => transport('POST', '/api/webmail/mailing-lists/moderation', { list, password: secret, op, args }))
        .then(() => say('', 'read'))
        .catch(error => say(failure(error, copy('The moderation queue could not be opened. Nothing was changed.')), 'failed'))
        .finally(() => { start.disabled = false })
    })
  })
}

export const LIST_MODERATION_CLIENT_BINDING = `(function(askDialog){const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const moderationObject=${moderationObject.toString()};const moderationRow=${moderationRow.toString()};const readModerationQueue=${readModerationQueue.toString()};const readHeldMessage=${readHeldMessage.toString()};const readListModeration=${readListModeration.toString()};const moderationLines=${moderationLines.toString()};const moderationWhole=${moderationWhole.toString()};const moderationTime=${moderationTime.toString()};(${bindListModeration.toString()})(askDialog);})`
