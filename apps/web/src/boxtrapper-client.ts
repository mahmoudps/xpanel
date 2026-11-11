import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import { frameAccess as canonicalFrameAccess, withFrameRequest } from './read-only-frame.ts'
import { ASCII_BYTES_BINDING, formatIsolatedBytes as canonicalFormatClientBytes } from './display-format.ts'
// Module-local alias: the binding source defines it again from ASCII_BYTES_BINDING.
const formatClientBytes = canonicalFormatClientBytes
const frameAccess = canonicalFrameAccess
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
const formatTrapDateTime = formatDisplayDateTime
/// <reference lib="dom" />

/** BoxTrapper of one mailbox, from xPanel (the owner picks the mailbox) or xMail (the session's own mailbox). */
export type BoxTrapperTemplate = { subject: string; body: string }
type TemplateName = 'verify' | 'released' | 'failed' | 'deny'
export interface BoxTrapperConfig {
  enabled: boolean; extraAddresses: string[]; displayName: string; retentionDays: number; spamBypass: number; autoAllowSent: boolean; allowByAssociation: boolean; forward: string[]
  templates: Record<TemplateName, BoxTrapperTemplate | null>
}
export interface BoxTrapperClientView {
  revision: string; saved: boolean; config: BoxTrapperConfig; defaults: Record<TemplateName, BoxTrapperTemplate>; review: string | null
  host: { state: 'connected' | 'not-connected' | 'unverified'; ready: boolean | null; active: boolean | null }
  lists: { allow: string[]; ignore: string[]; deny: string[] } | null; listsRevision: string | null
}
export function boxTrapperObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function boxTrapperLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean)
}
export function readBoxTrapperView(value: unknown): BoxTrapperClientView {
  const bad = (): never => { throw new Error('invalid_boxtrapper_view') }
  if (!boxTrapperObject(value) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || typeof value.saved !== 'boolean' || !boxTrapperObject(value.config) || !boxTrapperObject(value.defaults) || !boxTrapperObject(value.host)) return bad()
  if (!['connected', 'not-connected', 'unverified'].includes(String(value.host.state)) || !(value.lists === null || boxTrapperObject(value.lists)) || !(value.review === null || typeof value.review === 'string')) return bad()
  return value as unknown as BoxTrapperClientView
}
export function readBoxTrapperQueue(value: unknown): { day: string | null; days: { day: string; count: number }[]; rows: { id: string; at: string; from: string; subject: string; size: number }[] } {
  if (!boxTrapperObject(value) || !Array.isArray(value.days) || !Array.isArray(value.rows)) throw new Error('invalid_boxtrapper_queue')
  return value as never
}

function bindBoxTrapper(askDialog?: (options: { title: string; body: string; confirm: string; danger?: boolean }) => Promise<unknown>): void {
  const copy = (message: string, values?: MessageValues): string => xpT(message, values)
  const reasons: Record<string, string> = {
    boxtrapper_token_required: copy('The verify subject must keep verify#{token}, or replies cannot be matched.'),
    boxtrapper_forward_loop: copy('The forward list cannot include this mailbox or its extra addresses.'),
    boxtrapper_rule_invalid: copy('A rule is from, to or subject followed by a pattern, or a sender pattern. Use one rule on each line.'),
    host_agent_unavailable: copy('No protected host agent is connected, so the queue cannot be read.'),
    sieve_extprograms_missing: copy('This server lacks the external programs module of Pigeonhole, so BoxTrapper cannot run.'),
    host_executor_unavailable: copy('The queue is only available on a native Linux host.'),
  }
  const failure = (error: unknown, fallback: string): string => {
    const problem = boxTrapperObject(error) ? error : {}, detail = boxTrapperObject(problem.details) ? problem.details : {}
    if (detail.unknownOutcome === true || detail.verificationRequired === true) return copy('The outcome is uncertain. Reload and inspect before retrying; nothing was retried.')
    if (problem.status === 409 || problem.code === 'CONFLICT') return copy('This changed since it was read. Reload before saving.')
    return typeof detail.reason === 'string' && reasons[detail.reason] ? reasons[detail.reason]! : fallback
  }
  document.querySelectorAll<HTMLElement>('[data-boxtrapper]').forEach(root => {
    if (root.dataset.boxtrapperBound === 'true') return
    root.dataset.boxtrapperBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-boxtrapper-status]'), owner = root.dataset.boxtrapperScope === 'owner'
    const box = root.querySelector<HTMLSelectElement>('select[data-boxtrapper-mailbox]'), enabled = root.querySelector<HTMLInputElement>('input[data-boxtrapper-enabled]')
    const name = root.querySelector<HTMLInputElement>('input[data-boxtrapper-name]'), days = root.querySelector<HTMLInputElement>('input[data-boxtrapper-days]'), score = root.querySelector<HTMLInputElement>('input[data-boxtrapper-score]')
    const sent = root.querySelector<HTMLInputElement>('input[data-boxtrapper-auto-sent]'), association = root.querySelector<HTMLInputElement>('input[data-boxtrapper-association]')
    const extra = root.querySelector<HTMLTextAreaElement>('textarea[data-boxtrapper-extra]'), forward = root.querySelector<HTMLTextAreaElement>('textarea[data-boxtrapper-forward]')
    const template = root.querySelector<HTMLSelectElement>('select[data-boxtrapper-template]'), subject = root.querySelector<HTMLInputElement>('input[data-boxtrapper-template-subject]'), body = root.querySelector<HTMLTextAreaElement>('textarea[data-boxtrapper-template-body]')
    const reset = root.querySelector<HTMLButtonElement>('button[data-boxtrapper-template-reset]'), save = root.querySelector<HTMLButtonElement>('button[data-boxtrapper-save]'), saveLists = root.querySelector<HTMLButtonElement>('button[data-boxtrapper-lists-save]')
    const allow = root.querySelector<HTMLTextAreaElement>('textarea[data-boxtrapper-list="allow"]'), ignore = root.querySelector<HTMLTextAreaElement>('textarea[data-boxtrapper-list="ignore"]'), deny = root.querySelector<HTMLTextAreaElement>('textarea[data-boxtrapper-list="deny"]')
    const day = root.querySelector<HTMLSelectElement>('select[data-boxtrapper-day]'), rows = root.querySelector<HTMLTableSectionElement>('tbody[data-boxtrapper-queue]'), shown = root.querySelector<HTMLElement>('pre[data-boxtrapper-message]')
    const logDay = root.querySelector<HTMLSelectElement>('select[data-boxtrapper-log-day]'), logText = root.querySelector<HTMLElement>('pre[data-boxtrapper-log]')
    const queueStatus = root.querySelector<HTMLElement>('[data-boxtrapper-queue-status]')
    if (!status || !enabled || !name || !days || !score || !sent || !association || !extra || !forward || !template || !subject || !body || !reset || !save || !saveLists || !allow || !ignore || !deny || !day || !rows || !shown || !logDay || !logText || owner && !box) return
    const say = (message: string, kind: string): void => { status.dataset.state = kind; status.setAttribute('role', kind === 'failed' ? 'alert' : 'status'); status.textContent = message }
    // Reads run in a read-only frame too; editing and every write need the manage flag outside one.
    const access = frameAccess(root, 'data-boxtrapper-can-read', 'data-boxtrapper-manage')
    const controls = root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-boxtrapper-control]')
    const disable = (off: boolean): void => controls.forEach(control => { control.disabled = off || !access.writable() })
    if (!access.readable()) {
      disable(true); say(copy('BoxTrapper is unavailable here. Nothing was read or changed.'), 'unavailable'); return
    }
    const request = access.request!
    let view: BoxTrapperClientView | null = null, listsRevision: string | null = null, drafts: BoxTrapperConfig['templates'] = { verify: null, released: null, failed: null, deny: null }, active: TemplateName = 'verify'
    const base = (): string => owner ? '/api/mail/boxtrapper/' + encodeURIComponent(box!.value) : '/api/webmail/boxtrapper'
    const keepDraft = (): void => {
      const fallback = view?.defaults[active]
      drafts[active] = fallback && subject.value === fallback.subject && body.value === fallback.body ? null : { subject: subject.value, body: body.value }
    }
    const showDraft = (): void => { const value = drafts[active] ?? view?.defaults[active]; subject.value = value?.subject ?? ''; body.value = value?.body ?? '' }
    const paintStatus = (next: BoxTrapperClientView): void => {
      if (next.review) say(copy('Saved settings belong to an earlier mailbox of this address. Defaults are shown until you save.'), 'partial')
      else if (next.host.state === 'not-connected') say(copy('No protected host agent is connected. Saved settings are shown; the lists and queue cannot be read.'), 'unavailable')
      else if (next.host.state === 'unverified') say(copy('The host could not be verified. Saved settings are shown; the lists and queue were not read.'), 'unavailable')
      else if (next.host.ready === false) say(copy('This server lacks the external programs module of Pigeonhole, so BoxTrapper cannot run. Settings can still be saved.'), 'partial')
      else if (next.config.enabled && !next.host.active) say(copy('BoxTrapper is saved as on, but its delivery script is not on this server yet.'), 'drift')
      else say(next.config.enabled ? copy('BoxTrapper is on. Mail from unknown senders is held until they verify.') : copy('BoxTrapper is off. Mail is delivered without verification.'), 'read')
    }
    const paint = (next: BoxTrapperClientView): void => {
      view = next; listsRevision = next.listsRevision
      const config = next.config
      enabled.checked = config.enabled; name.value = config.displayName; days.value = String(config.retentionDays); score.value = String(config.spamBypass)
      sent.checked = config.autoAllowSent; association.checked = config.allowByAssociation; extra.value = config.extraAddresses.join('\n'); forward.value = config.forward.join('\n')
      drafts = { ...config.templates }; showDraft()
      allow.value = next.lists?.allow.join('\n') ?? ''; ignore.value = next.lists?.ignore.join('\n') ?? ''; deny.value = next.lists?.deny.join('\n') ?? ''
      paintStatus(next)
      const listed = next.lists !== null
      for (const control of [allow, ignore, deny, saveLists, day, logDay]) control.disabled = !listed || !access.writable()
      root.querySelectorAll<HTMLButtonElement>('button[data-boxtrapper-act]').forEach(button => { button.disabled = !listed || !access.writable() })
    }
    const options = (select: HTMLSelectElement, values: { value: string; label: string }[], current: string | null): void => {
      select.textContent = ''
      for (const item of values) select.appendChild(new Option(item.label, item.value))
      if (current) select.value = current
    }
    const operate = (op: string, args: Record<string, unknown>): Promise<unknown> => request('POST', base() + '/queue', { op, args })
    const readQueue = async (wanted: string): Promise<void> => {
      const next = readBoxTrapperQueue(await operate('queue', { day: wanted }))
      options(day, next.days.map(item => ({ value: item.day, label: copy('{day} ({count})', { day: item.day, count: item.count }) })), next.day)
      rows.textContent = ''; shown.hidden = true
      for (const item of next.rows) {
        const row = cloneClientTemplate(clientTemplate(root, 'boxtrapper-row'), 'tr', ['select', 'at', 'from', 'subject', 'size', 'view'])
        const pick = clientTemplateSlot(row, 'select', 'input') as HTMLInputElement
        pick.value = item.id; pick.setAttribute('aria-label', copy('Select the message from {sender}', { sender: item.from }))
        clientTemplateSlot(row, 'at').textContent = formatTrapDateTime(item.at)
        clientTemplateSlot(row, 'from').textContent = item.from || copy('No sender')
        clientTemplateSlot(row, 'subject').textContent = item.subject
        clientTemplateSlot(row, 'size').textContent = formatClientBytes(item.size)
        const open = clientTemplateSlot(row, 'view', 'button') as HTMLButtonElement
        open.textContent = copy('View'); open.disabled = false
        open.addEventListener('click', () => {
          operate('message', { id: item.id }).then(reply => {
            const message = reply as { headers: string; body: string; truncated: boolean }
            shown.textContent = message.headers + '\n\n' + message.body + (message.truncated ? '\n\n' + copy('The rest of this message is not shown.') : ''); shown.hidden = false
          }).catch(error => say(failure(error, copy('The held message could not be read.')), 'failed'))
        })
        rows.appendChild(row)
      }
      if (!next.rows.length) { const row = cloneClientTemplate(clientTemplate(root, 'boxtrapper-empty'), 'tr', ['message']); clientTemplateSlot(row, 'message').textContent = copy('No messages are held for this day.'); rows.appendChild(row) }
    }
    const readLog = async (wanted: string): Promise<void> => {
      const next = await operate('log', { day: wanted }) as { day: string | null; days: string[]; lines: string[] }
      options(logDay, next.days.map(item => ({ value: item, label: item })), next.day)
      logText.textContent = next.lines.length ? next.lines.join('\n') : copy('The log has no entries for this day.')
    }
    const load = async (): Promise<void> => {
      disable(true); say(copy('Reading BoxTrapper…'), 'reading')
      try {
        const next = readBoxTrapperView(await request('GET', base()))
        disable(false); paint(next)
        // The queue and the log are read by POST, which a read-only frame refuses.
        if (next.lists !== null && access.writable()) {
          if (!queueStatus) await Promise.all([readQueue('latest'), readLog('latest')])
          else {
            // Settings and lists were read: a failed queue or log read is said beside the queue, not over the settings status.
            const failed: string[] = []
            await Promise.all([readQueue('latest').catch(error => { failed.push(failure(error, copy('The queue could not be read.'))) }), readLog('latest').catch(error => { failed.push(failure(error, copy('The log could not be read.'))) })])
            queueStatus.hidden = !failed.length; queueStatus.dataset.state = failed.length ? 'failed' : 'read'
            queueStatus.setAttribute('role', failed.length ? 'alert' : 'status'); queueStatus.textContent = [...new Set(failed)].join(' ')
          }
        }
      } catch (error) { say(failure(error, copy('BoxTrapper could not be read. Nothing was changed.')), 'failed') }
    }
    template.addEventListener('change', () => { keepDraft(); active = template.value as TemplateName; showDraft() })
    reset.addEventListener('click', () => { drafts[active] = null; showDraft() })
    save.addEventListener('click', () => {
      if (!view || !access.writable()) return
      keepDraft()
      const config: BoxTrapperConfig = { enabled: enabled.checked, extraAddresses: boxTrapperLines(extra.value), displayName: name.value.trim(), retentionDays: Number(days.value), spamBypass: Number(score.value), autoAllowSent: sent.checked, allowByAssociation: association.checked, forward: boxTrapperLines(forward.value), templates: drafts }
      disable(true); say(copy('Saving BoxTrapper…'), 'saving')
      request('PUT', base(), { config, expectedRevision: view.revision })
        .then(reply => { const next = readBoxTrapperView(reply); disable(false); paint(next); if ((reply as { nativeApplied?: boolean }).nativeApplied === false) say(copy('Saved, but this server did not confirm the change yet.'), 'drift') })
        .catch(error => { disable(false); say(failure(error, copy('BoxTrapper settings were refused. Nothing was changed.')), 'failed') })
    })
    saveLists.addEventListener('click', () => {
      if (listsRevision === null || !access.writable()) return
      disable(true); say(copy('Saving the sender lists…'), 'saving')
      operate('lists', { lists: { allow: boxTrapperLines(allow.value), ignore: boxTrapperLines(ignore.value), deny: boxTrapperLines(deny.value) }, revision: listsRevision })
        .then(reply => { const next = reply as { lists: { allow: string[]; ignore: string[]; deny: string[] }; listsRevision: string }; listsRevision = next.listsRevision; allow.value = next.lists.allow.join('\n'); ignore.value = next.lists.ignore.join('\n'); deny.value = next.lists.deny.join('\n'); say(copy('The sender lists were saved and read back.'), 'saved') })
        .catch(error => say(failure(error, copy('The sender lists were refused. Nothing was changed.')), 'failed'))
        .finally(() => disable(false))
    })
    root.querySelectorAll<HTMLButtonElement>('button[data-boxtrapper-act]').forEach(button => button.addEventListener('click', () => {
      void (async () => {
        if (!access.writable()) return
        const ids = [...rows.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value), action = button.dataset.boxtrapperAct!
        if (!ids.length) { say(copy('Select at least one held message. Nothing was changed.'), 'failed'); return }
        if (action !== 'deliver' && action !== 'allow' && askDialog) {
          const body = action === 'delete' ? copy('{count, plural, one {# held message will be removed.} other {# held messages will be removed.}}', { count: ids.length }) : copy('The senders of the selected messages join this list, and every message held from them is removed.')
          if (await askDialog({ title: copy('Change the held mail?'), body, confirm: button.textContent ?? '', danger: true }) !== true) return
        }
        disable(true); say(copy('Working on the held mail…'), 'saving')
        try {
          const reply = await operate('act', { action, ids }) as { done: number; failed: number }
          say(reply.failed ? copy('{done} done, {failed} could not be handed to the mail server and stay held.', { done: reply.done, failed: reply.failed }) : copy('{done} done.', { done: reply.done }), reply.failed ? 'partial' : 'saved')
          await Promise.all([readQueue(day.value || 'latest'), readLog('latest')])
          const lists = readBoxTrapperView(await request('GET', base()))
          if (lists.lists) { listsRevision = lists.listsRevision; allow.value = lists.lists.allow.join('\n'); ignore.value = lists.lists.ignore.join('\n'); deny.value = lists.lists.deny.join('\n') }
        } catch (error) { say(failure(error, copy('The queue action was refused. Nothing was changed.')), 'failed') }
        finally { disable(false) }
      })()
    }))
    day.addEventListener('change', () => { readQueue(day.value).catch(error => say(failure(error, copy('The queue could not be read.')), 'failed')) })
    logDay.addEventListener('change', () => { readLog(logDay.value).catch(error => say(failure(error, copy('The log could not be read.')), 'failed')) })
    if (!owner) { void load(); return }
    box!.addEventListener('change', () => { void load() })
    request('GET', '/api/mail/boxtrapper').then(reply => {
      const mailboxes = boxTrapperObject(reply) && Array.isArray(reply.mailboxes) ? reply.mailboxes.filter(boxTrapperObject).map(item => ({ value: String(item.mailbox), label: item.enabled === true ? copy('{mailbox} (on)', { mailbox: String(item.mailbox) }) : String(item.mailbox) })) : []
      options(box!, mailboxes, null)
      if (mailboxes.length) void load(); else { disable(true); say(copy('This account has no mailboxes.'), 'read') }
    }).catch(error => { disable(true); say(failure(error, copy('BoxTrapper could not be read. Nothing was changed.')), 'failed') })
  })
}

export const BOXTRAPPER_CLIENT_BINDING = withFrameRequest(`(function(askDialog){const formatClientBytes=${ASCII_BYTES_BINDING};const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const formatTrapDateTime=${DISPLAY_DATETIME_BINDING};const boxTrapperObject=${boxTrapperObject.toString()};const boxTrapperLines=${boxTrapperLines.toString()};const readBoxTrapperView=${readBoxTrapperView.toString()};const readBoxTrapperQueue=${readBoxTrapperQueue.toString()};(${bindBoxTrapper.toString()})(askDialog);})`)
