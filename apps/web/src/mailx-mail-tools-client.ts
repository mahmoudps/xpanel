/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatToolsDateTime = formatDisplayDateTime

export type MailxMailToolsView = {
  host: 'connected' | 'not-connected' | 'unverified'
  observedAt: string | null
  engine: { engine: 'rspamd' | 'spamassassin' | null; wiring: 'wired' | 'not-wired' | 'unknown' } | null
  compositeRevision: string
  mailboxes: { mailbox: string; preference: 'none' | 'saved' | 'review'; native: 'not-saved' | 'applied' | 'pending' | 'unavailable'; effects: Record<'allowlist' | 'filtering' | 'score' | 'blocklist' | 'spamBox', boolean> | null }[]
  learning: boolean
}
export type MailxListState = 'delivering' | 'pending' | 'disabled' | 'restricted' | 'empty' | 'review' | 'conflict'
export type MailxListDeliveryView = {
  host: 'connected' | 'not-connected' | 'unverified'
  observedAt: string | null
  aliases: 'read' | 'unavailable' | null
  compositeRevision: string
  lists: { address: string; members: number; state: MailxListState }[]
}
type Ask = (options: { title: string; body: string; confirm: string; danger?: boolean }) => Promise<unknown>
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>

/** Strict reader for GET /api/account/mailx/mail-tools/lists; moderation and archives must stay unavailable. */
export function readMailxListDelivery(value: unknown): MailxListDeliveryView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_mailx_list_delivery_view') }
  const iso = (item: unknown): item is string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) && Number.isFinite(Date.parse(item))
  if (!object(value) || !['connected', 'not-connected', 'unverified'].includes(String(value.host)) || !(value.observedAt === null || iso(value.observedAt)) || ![null, 'read', 'unavailable'].includes(value.aliases as string)
    || typeof value.compositeRevision !== 'string' || !/^[0-9a-f]{64}$/.test(value.compositeRevision) || !object(value.capabilities) || value.capabilities.moderation !== false || value.capabilities.archive !== false
    || !Array.isArray(value.lists) || value.lists.length > 1000 || (value.host === 'connected') !== (value.observedAt !== null) || (value.observedAt === null) !== (value.aliases === null)) return bad()
  const lists = value.lists.map(raw => object(raw) && typeof raw.address === 'string' && raw.address.length <= 254 && Number.isSafeInteger(raw.members) && (raw.members as number) >= 0 && (raw.members as number) <= 10000
    && ['delivering', 'pending', 'disabled', 'restricted', 'empty', 'review', 'conflict'].includes(String(raw.state)) && !(raw.state === 'delivering' && value.aliases !== 'read')
    ? { address: raw.address, members: raw.members as number, state: raw.state as MailxListState } : bad())
  return { host: value.host as 'connected', observedAt: value.observedAt as string | null, aliases: value.aliases as 'read' | null, compositeRevision: value.compositeRevision, lists }
}

/** Strict reader for GET /api/account/mailx/mail-tools; BoxTrapper must stay unavailable. */
export function readMailxMailTools(value: unknown): MailxMailToolsView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_mailx_mail_tools_view') }
  const iso = (item: unknown): item is string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) && Number.isFinite(Date.parse(item))
  if (!object(value) || !['connected', 'not-connected', 'unverified'].includes(String(value.host)) || !(value.observedAt === null || iso(value.observedAt)) || typeof value.compositeRevision !== 'string' || !/^[0-9a-f]{64}$/.test(value.compositeRevision)
    || !object(value.capabilities) || typeof value.capabilities.learning !== 'boolean' || value.capabilities.boxTrapper !== false || !Array.isArray(value.mailboxes) || value.mailboxes.length > 1000) return bad()
  const engine = value.engine === null ? null : object(value.engine) && [null, 'rspamd', 'spamassassin'].includes(value.engine.engine as string) && ['wired', 'not-wired', 'unknown'].includes(String(value.engine.wiring)) ? { engine: value.engine.engine as 'rspamd' | null, wiring: value.engine.wiring as 'wired' } : bad()
  const keys = ['allowlist', 'filtering', 'score', 'blocklist', 'spamBox'] as const
  const mailboxes = value.mailboxes.map(raw => {
    if (!object(raw) || typeof raw.mailbox !== 'string' || raw.mailbox.length > 254 || !['none', 'saved', 'review'].includes(String(raw.preference)) || !['not-saved', 'applied', 'pending', 'unavailable'].includes(String(raw.native))) return bad()
    const effects = raw.effects === null ? null : object(raw.effects) && keys.every(key => typeof (raw.effects as Record<string, unknown>)[key] === 'boolean') ? Object.fromEntries(keys.map(key => [key, (raw.effects as Record<string, boolean>)[key]])) as Record<typeof keys[number], boolean> : bad()
    if ((raw.preference === 'saved') !== (effects !== null)) return bad()
    return { mailbox: raw.mailbox, preference: raw.preference as 'saved', native: raw.native as 'applied', effects }
  })
  if ((value.host === 'connected') !== (engine !== null) || value.capabilities.learning && !engine?.engine) return bad()
  return { host: value.host as 'connected', observedAt: value.observedAt as string | null, engine, compositeRevision: value.compositeRevision, mailboxes, learning: value.capabilities.learning }
}

function bindMailxMailTools(askDialog: Ask | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const note = (target: HTMLElement, state: string, message: string): void => { target.dataset.state = state; target.textContent = message; target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
  const failure = (error: unknown): string => {
    const problem = error && typeof error === 'object' ? error as { status?: number; code?: string; details?: Record<string, unknown> } : {}, details = problem.details && typeof problem.details === 'object' ? problem.details : {}
    return details.unknownOutcome === true || details.verificationRequired === true ? t('The outcome is unknown. Reload and review before retrying.')
      : problem.status === 409 || problem.code === 'CONFLICT' ? t('The saved policy changed. Reload before retrying.') : t('The request was refused. Nothing was started.')
  }
  const applied = (reply: unknown): [string, string] => {
    const application = reply && typeof reply === 'object' ? (reply as { application?: { outcome?: unknown; reconcile?: unknown } }).application : undefined
    const outcome = String(application?.outcome ?? 'unknown'), reconcile = String(application?.reconcile ?? '')
    if (outcome === 'unknown') return ['failed', t('The outcome is unknown. Reload and review before retrying.')]
    if (outcome === 'not-connected') return ['failed', t('Saved. No host agent is connected, so it is not applied yet.')]
    if (outcome !== 'applied' && outcome !== 'nothing') return ['failed', t('Saved, but the host did not apply it. Check the state above.')]
    return reconcile === 'applied' || reconcile === 'unchanged' ? ['saved', t('Applied. The configuration generation confirmed the change.')]
      : reconcile === 'failed' ? ['partial', t('The configuration generation failed and was rolled back. Check the generation history.')] : ['partial', t('Postfix applied the policy, but the configuration generation is unavailable here.')]
  }
  document.querySelectorAll<HTMLElement>('[data-mailx-tools][data-mailx-tools-section="lists"]').forEach(root => {
    if (root.dataset.mailxListsBound === 'true') return
    root.dataset.mailxListsBound = 'true'
    const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    const status = root.querySelector<HTMLElement>('[data-mailx-lists-status]'), rows = root.querySelector<HTMLElement>('[data-mailx-lists-rows]'), refresh = root.querySelector<HTMLButtonElement>('[data-mailx-lists-refresh]')
    const apply = root.querySelector<HTMLButtonElement>('[data-mailx-lists-apply]'), action = root.querySelector<HTMLElement>('[data-mailx-lists-action-status]')
    if (!status || !rows || !refresh || !apply || !action) return
    const admitted = (): boolean => root.isConnected && root.dataset.mailxCanManage === 'true' && !root.closest(denied) && !!request
    let view: MailxListDeliveryView | null = null, busy = false
    const fact = (key: string, value: string): void => { const cell = root.querySelector<HTMLElement>('[data-mailx-tools-fact="' + key + '"]'); if (cell) cell.textContent = value }
    const controls = (): void => { refresh.disabled = busy || !admitted(); apply.disabled = busy || !admitted() || view?.host !== 'connected' }
    const labels: Record<MailxListState, string> = { delivering: t('Delivering to members'), pending: t('Not applied yet'), disabled: t('Turned off by the account plan'),
      restricted: t('Not delivered: posting is limited to members or moderated, which needs a list manager'), empty: t('Not delivered: the list has no members'),
      review: t('Not delivered: the saved list needs review'), conflict: t('Not delivered: the address is already in use or its members forward back to it') }
    const paint = (next: MailxListDeliveryView): void => {
      view = next
      fact('delivery', next.host !== 'connected' ? t('Not read') : t('{total, plural, one {{delivering} of # list delivers} other {{delivering} of # lists deliver}}', { total: next.lists.length, delivering: next.lists.filter(item => item.state === 'delivering').length }))
      fact('observed-at', next.observedAt === null ? t('Not read') : formatToolsDateTime(next.observedAt))
      rows.textContent = ''
      if (!next.lists.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 3; td.textContent = next.host === 'connected' ? t('This account has no mailing lists.') : t('Nothing has been read.'); tr.append(td); rows.append(tr) }
      for (const item of next.lists) {
        const tr = document.createElement('tr'), head = document.createElement('th'), bdi = document.createElement('bdi')
        head.scope = 'row'; bdi.dir = 'ltr'; bdi.textContent = item.address; head.append(bdi); tr.append(head)
        for (const text of [String(item.members), labels[item.state]]) { const td = document.createElement('td'); td.textContent = text; tr.append(td) }
        tr.dataset.state = item.state; rows.append(tr)
      }
      if (next.host !== 'connected') note(status, 'unavailable', next.host === 'not-connected' ? t('No protected host agent is connected. List delivery cannot be read.') : t('List delivery could not be verified.'))
      else if (next.aliases !== 'read') note(status, 'partial', t('The Postfix alias table could not be read, so no list is shown as delivering.'))
      else if (next.lists.some(item => item.state === 'pending')) note(status, 'drift', t('Some lists are not applied on this server yet.'))
      else note(status, 'read', t('List delivery read from this server.'))
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; controls(); note(status, 'reading', t('Reading list delivery…'))
      try { const next = readMailxListDelivery(await request!('GET', '/api/account/mailx/mail-tools/lists')); if (admitted()) paint(next) }
      catch { if (admitted()) note(status, 'failed', t('List delivery could not be read. Values shown are from the last successful read.')) }
      finally { busy = false; controls() }
    }
    apply.addEventListener('click', () => {
      if (busy || !admitted() || !view) return
      busy = true; controls(); note(action, 'saving', t('Applying the saved lists…'))
      void (async () => {
        try {
          const reply = await request!('POST', '/api/account/mailx/mail-tools/lists', { expectedRevision: view!.compositeRevision })
          const [state, message] = applied(reply); note(action, state, message)
          try { if (admitted()) paint(readMailxListDelivery(reply)) } catch { /* the next read repaints */ }
        } catch (error) { note(action, 'failed', failure(error)) }
        finally { busy = false; controls() }
      })()
    })
    refresh.addEventListener('click', () => { void load() })
    if (!admitted()) { controls(); note(status, 'unavailable', t('List delivery is unavailable here. Nothing was read.')); return }
    void load()
  })
  document.querySelectorAll<HTMLElement>('[data-mailx-tools][data-mailx-tools-section="spam"]').forEach(root => {
    if (root.dataset.mailxToolsBound === 'true') return
    root.dataset.mailxToolsBound = 'true'
    const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    const status = root.querySelector<HTMLElement>('[data-mailx-tools-status]'), rows = root.querySelector<HTMLElement>('[data-mailx-tools-rows]'), refresh = root.querySelector<HTMLButtonElement>('[data-mailx-tools-refresh]')
    const apply = root.querySelector<HTMLButtonElement>('[data-mailx-tools-apply]'), action = root.querySelector<HTMLElement>('[data-mailx-tools-action-status]')
    if (!status || !rows || !refresh || !apply || !action) return
    const admitted = (): boolean => root.isConnected && root.dataset.mailxCanManage === 'true' && !root.closest(denied) && !!request
    let view: MailxMailToolsView | null = null, busy = false
    const fact = (key: string, value: string): void => { const cell = root.querySelector<HTMLElement>('[data-mailx-tools-fact="' + key + '"]'); if (cell) cell.textContent = value }
    const controls = (): void => {
      refresh.disabled = busy || !admitted(); apply.disabled = busy || !admitted() || view?.host !== 'connected'
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy || !admitted() || !view?.learning || !askDialog })
    }
    const paint = (next: MailxMailToolsView): void => {
      view = next
      fact('engine', next.engine === null ? t('Not read') : next.engine.engine === null ? t('No supported filter is running') : next.engine.engine)
      fact('wiring', next.engine === null || next.engine.wiring === 'unknown' ? t('Not verified') : next.engine.wiring === 'wired' ? t('Yes') : t('No. Postfix gets the filter after the saved policy is applied with filtering on and a supported filter installed.'))
      fact('observed-at', next.observedAt === null ? t('Not read') : formatToolsDateTime(next.observedAt))
      const preference: Record<string, string> = { none: t('None saved'), saved: t('Saved'), review: t('Needs review') }
      const native: Record<string, string> = { 'not-saved': t('Nothing to apply'), applied: t('Applied'), pending: t('Not applied yet'), unavailable: t('Unavailable with this filter') }
      const labels: Record<string, string> = { allowlist: t('Allowed senders'), filtering: t('Filtering turned off'), score: t('Own spam score'), blocklist: t('Blocked senders to Junk'), spamBox: t('Spam to Junk') }
      rows.textContent = ''
      if (!next.mailboxes.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 5; td.textContent = t('This account has no mailboxes.'); tr.append(td); rows.append(tr) }
      for (const item of next.mailboxes) {
        const tr = document.createElement('tr')
        const head = document.createElement('th'); head.scope = 'row'; const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = item.mailbox; head.append(bdi); tr.append(head)
        const cell = (content: string | Node): void => { const td = document.createElement('td'); td.append(content); tr.append(td) }
        cell(preference[item.preference]!); cell(native[item.native]!)
        const effects = item.effects ? Object.entries(labels).filter(([key]) => item.effects![key as 'allowlist']).map(([, label]) => label) : []
        cell(effects.length ? effects.join(', ') : t('No native effect'))
        const buttons = document.createElement('div'); buttons.className = 'xp-mailx__actions'
        for (const [direction, label] of [['spam', t('Learn spam from Junk')], ['ham', t('Learn not spam from Inbox')]] as const) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'xp-btn'; button.textContent = label; button.dataset.direction = direction
          button.addEventListener('click', () => { void learn(item.mailbox, direction) }); buttons.append(button)
        }
        cell(buttons); rows.append(tr)
      }
      if (next.host !== 'connected') note(status, 'unavailable', next.host === 'not-connected' ? t('No protected host agent is connected. Saved preferences are shown without a host observation.') : t('The host observation could not be verified. Saved preferences are shown without it.'))
      else if (!next.engine?.engine) note(status, 'partial', t('No supported spam filter is running, so preferences cannot take effect and training is unavailable.'))
      else if (next.mailboxes.some(item => item.native === 'pending')) note(status, 'drift', t('Some saved preferences are not applied on this server yet.'))
      else note(status, 'read', t('Mailbox spam state read from this server.'))
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; controls(); note(status, 'reading', t('Reading mailbox spam state…'))
      try { const next = readMailxMailTools(await request!('GET', '/api/account/mailx/mail-tools')); if (admitted()) paint(next) }
      catch { if (admitted()) note(status, 'failed', t('Mailbox spam state could not be read. Values shown are from the last successful read.')) }
      finally { busy = false; controls() }
    }
    const learn = async (mailbox: string, direction: 'spam' | 'ham'): Promise<void> => {
      if (busy || !admitted() || !view?.learning || !askDialog) return
      const confirmed = await askDialog({ title: t('Train the spam filter?'), body: direction === 'spam' ? t('Every message in the Junk folder of {mailbox} will be learned as spam by the server-wide filter.', { mailbox }) : t('Every message in the Inbox of {mailbox} will be learned as not spam by the server-wide filter.', { mailbox }), confirm: t('Start training') }).catch(() => false)
      if (confirmed !== true || !view) return
      busy = true; controls()
      try { await request!('POST', '/api/account/mailx/mail-tools/learn', { mailbox, direction, expectedRevision: view.compositeRevision }); note(action, 'saved', t('Training started as a host job. Open Jobs to follow it.')) }
      catch (error) { note(action, 'failed', failure(error)) }
      finally { busy = false; controls() }
    }
    apply.addEventListener('click', () => {
      if (busy || !admitted() || !view) return
      busy = true; controls(); note(action, 'saving', t('Applying the saved policy…'))
      void (async () => {
        try {
          const [state, message] = applied(await request!('POST', '/api/account/mailx/mail-tools/apply', { expectedRevision: view!.compositeRevision }))
          note(action, state, message)
        } catch (error) { note(action, 'failed', failure(error)) }
        finally { busy = false; controls() }
        await load()
      })()
    })
    refresh.addEventListener('click', () => { void load() })
    if (!admitted()) { controls(); note(status, 'unavailable', t('Mailbox spam state is unavailable here. Nothing was read.')); return }
    void load()
  })
}

export const MAILX_MAIL_TOOLS_CLIENT_BINDING = `(()=>{const formatToolsDateTime=${DISPLAY_DATETIME_BINDING};const readMailxMailTools=${readMailxMailTools.toString()};const readMailxListDelivery=${readMailxListDelivery.toString()};return ${bindMailxMailTools.toString()};})()`
