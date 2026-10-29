/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatArchiveDateTime = formatDisplayDateTime

export type MailxArchiveRowView = { domain: string; mailbox: string; incoming: boolean; outgoing: boolean; retentionDays: number }
export type MailxArchiveView = {
  saved: boolean
  revision: string
  choices: { domain: string; mailboxes: string[] }[]
  policy: { domains: MailxArchiveRowView[] }
  updatedAt: string | null
  host: 'connected' | 'not-connected' | 'unverified'
  observedAt: string | null
  state: 'not-saved' | 'applied' | 'pending' | 'unavailable'
  rows: { domain: string; admission: 'eligible' | 'account-inactive' | 'domain-missing' | 'mailbox-missing' | null; conflicts: ('incoming' | 'outgoing')[] }[]
  retentionJobs: boolean
}
type Ask = (options: { title: string; body: string; confirm: string; danger?: boolean }) => Promise<unknown>
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>

/** Strict reader for /api/account/mailx/archive; every saved row must be one of the offered domain/mailbox choices. */
export function readMailxArchiveView(value: unknown): MailxArchiveView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_mailx_archive_view') }
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length > 0 && item.length <= max
  const iso = (item: unknown): item is string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) && Number.isFinite(Date.parse(item))
  const list = <T>(item: unknown, max: number, read: (raw: Record<string, unknown>) => T): T[] => Array.isArray(item) && item.length <= max ? item.map(raw => object(raw) ? read(raw) : bad()) : bad()
  if (!object(value) || typeof value.saved !== 'boolean' || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || !object(value.policy) || !object(value.capabilities)
    || !['connected', 'not-connected', 'unverified'].includes(String(value.host)) || !(value.observedAt === null || iso(value.observedAt)) || !(value.updatedAt === null || iso(value.updatedAt))
    || !['not-saved', 'applied', 'pending', 'unavailable'].includes(String(value.state)) || (value.state === 'not-saved') === value.saved || typeof value.capabilities.retentionJobs !== 'boolean') return bad()
  const choices = list(value.choices, 200, raw => text(raw.domain, 253) && Array.isArray(raw.mailboxes) && raw.mailboxes.length <= 1000 && raw.mailboxes.every(item => text(item, 254)) ? { domain: raw.domain, mailboxes: [...raw.mailboxes] as string[] } : bad())
  const domains = list(value.policy.domains, 200, raw => text(raw.domain, 253) && text(raw.mailbox, 254) && typeof raw.incoming === 'boolean' && typeof raw.outgoing === 'boolean'
    && Number.isSafeInteger(raw.retentionDays) && (raw.retentionDays as number) >= 0 && (raw.retentionDays as number) <= 3650 ? { domain: raw.domain, mailbox: raw.mailbox, incoming: raw.incoming, outgoing: raw.outgoing, retentionDays: raw.retentionDays as number } : bad())
  const rows = list(value.rows, 200, raw => text(raw.domain, 253) && (raw.admission === null || ['eligible', 'account-inactive', 'domain-missing', 'mailbox-missing'].includes(String(raw.admission))) && Array.isArray(raw.conflicts) && raw.conflicts.every(item => item === 'incoming' || item === 'outgoing')
    ? { domain: raw.domain, admission: raw.admission as MailxArchiveView['rows'][number]['admission'], conflicts: [...raw.conflicts] as ('incoming' | 'outgoing')[] } : bad())
  // A saved row may name a mailbox that was deleted since; its admission row says so.
  if (!domains.every(row => rows.some(item => item.domain === row.domain))) return bad()
  return { saved: value.saved, revision: value.revision, choices, policy: { domains }, updatedAt: value.updatedAt as string | null, host: value.host as 'connected', observedAt: value.observedAt as string | null, state: value.state as 'applied', rows, retentionJobs: value.capabilities.retentionJobs }
}

function bindMailxArchive(askDialog: Ask | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-mailx-archive]').forEach(root => {
    if (root.dataset.mailxArchiveBound === 'true') return
    root.dataset.mailxArchiveBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-mailx-archive-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-mailx-archive-refresh]'), body = root.querySelector<HTMLElement>('[data-mailx-archive-rows]')
    const form = root.querySelector<HTMLElement>('[data-mailx-archive-form]'), save = root.querySelector<HTMLButtonElement>('[data-mailx-archive-save]'), formStatus = root.querySelector<HTMLElement>('[data-mailx-archive-form-status]')
    const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    if (!status || !refresh || !body || !form || !save || !formStatus) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.mailxCanManage === 'true' && !root.closest(denied) && !!request
    let view: MailxArchiveView | null = null, busy = false
    const note = (target: HTMLElement, state: string, message: string): void => { target.dataset.state = state; target.textContent = message; target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const fact = (key: string, value: string): void => { const cell = root.querySelector<HTMLElement>('[data-mailx-archive-fact="' + key + '"]'); if (cell) cell.textContent = value }
    const controls = (): void => {
      refresh.disabled = busy || !admitted(); save.disabled = busy || !admitted() || !view
      body.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = busy || !admitted() || control.dataset.locked === 'true' })
    }
    const technical = (value: string): HTMLElement => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; return bdi }
    const cell = (row: HTMLTableRowElement, content: Node | string): HTMLTableCellElement => { const td = document.createElement('td'); td.append(content); row.append(td); return td }
    const labelled = (control: HTMLElement, label: string): HTMLElement => { control.setAttribute('aria-label', label); return control }
    const admissions: Record<string, string> = { eligible: t('Ready'), 'account-inactive': t('Account is not active'), 'domain-missing': t('Domain no longer exists'), 'mailbox-missing': t('Mailbox no longer exists') }
    const paint = (next: MailxArchiveView): void => {
      view = next
      fact('saved', next.saved ? t('Saved') : t('Not saved'))
      fact('host', next.host === 'connected' ? t('Connected') : next.host === 'not-connected' ? t('Not connected') : t('Not verified'))
      fact('state', ({ 'not-saved': t('Not archiving'), applied: t('Applied'), pending: t('Not applied yet'), unavailable: t('Unavailable') } as Record<string, string>)[next.state]!)
      fact('observed-at', next.observedAt === null ? t('Not read') : formatArchiveDateTime(next.observedAt))
      fact('updated', next.updatedAt === null ? t('Never') : formatArchiveDateTime(next.updatedAt))
      body.textContent = ''
      if (!next.choices.length) { const row = document.createElement('tr'); cell(row, t('This account has no domains.')).colSpan = 7; body.append(row) }
      for (const choice of next.choices) {
        const saved = next.policy.domains.find(item => item.domain === choice.domain), info = next.rows.find(item => item.domain === choice.domain)
        const row = document.createElement('tr'); row.dataset.domain = choice.domain
        const head = document.createElement('th'); head.scope = 'row'; head.append(technical(choice.domain)); row.append(head)
        const select = document.createElement('select'); select.className = 'xp-input'; select.dataset.archiveMailbox = ''
        const none = document.createElement('option'); none.value = ''; none.textContent = choice.mailboxes.length ? t('Choose a mailbox') : t('No mailbox on this domain'); select.append(none)
        for (const mailbox of choice.mailboxes) { const option = document.createElement('option'); option.value = mailbox; option.textContent = mailbox; option.dir = 'ltr'; select.append(option) }
        select.value = saved?.mailbox ?? ''
        cell(row, labelled(select, t('Archive mailbox for {domain}', { domain: choice.domain })))
        for (const [key, label] of [['incoming', t('Archive incoming mail for {domain}', { domain: choice.domain })], ['outgoing', t('Archive outgoing mail for {domain}', { domain: choice.domain })]] as const) {
          const box = document.createElement('input'); box.type = 'checkbox'; box.dataset.archiveDirection = key; box.checked = saved?.[key] === true; cell(row, labelled(box, label))
        }
        const days = document.createElement('input'); days.type = 'number'; days.className = 'xp-input'; days.min = '0'; days.max = '3650'; days.step = '1'; days.inputMode = 'numeric'; days.dir = 'ltr'; days.dataset.archiveDays = ''; days.value = String(saved?.retentionDays ?? 0)
        cell(row, labelled(days, t('Days to keep archived mail for {domain}', { domain: choice.domain })))
        const conflicts = info?.conflicts.length ? t('A server copy rule already covers this domain, so part of its archive is not applied.') : ''
        cell(row, !saved ? t('Not archived') : conflicts || (info?.admission ? admissions[info.admission]! : t('Not verified')))
        const run = document.createElement('button'); run.type = 'button'; run.className = 'xp-btn'; run.textContent = t('Run retention now')
        run.dataset.locked = String(!saved || saved.retentionDays === 0 || !next.retentionJobs || info?.admission !== 'eligible')
        run.addEventListener('click', () => { void retention(choice.domain, saved?.mailbox ?? '', saved?.retentionDays ?? 0) })
        cell(row, run)
        body.append(row)
      }
      if (next.host !== 'connected') note(status, 'unavailable', next.host === 'not-connected' ? t('No protected host agent is connected. The saved archive is shown without a host observation.') : t('The host observation could not be verified. The saved archive is shown without it.'))
      else if (next.state === 'pending') note(status, 'drift', t('The saved archive is not applied on this server yet.'))
      else if (next.state === 'unavailable') note(status, 'partial', t('The host configuration could not be read.'))
      else note(status, 'read', next.saved ? t('The saved archive is applied on this server.') : t('No domain is archived.'))
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; controls(); root.setAttribute('aria-busy', 'true'); note(status, 'reading', t('Reading the email archive…'))
      try { const next = readMailxArchiveView(await request!('GET', '/api/account/mailx/archive')); if (admitted()) paint(next) }
      catch { if (admitted()) note(status, 'failed', t('The email archive could not be read. Values shown are from the last successful read.')) }
      finally { busy = false; controls(); root.setAttribute('aria-busy', 'false') }
    }
    const problemText = (error: unknown): string => {
      const problem = error && typeof error === 'object' ? error as { status?: number; code?: string; details?: Record<string, unknown> } : {}, details = problem.details && typeof problem.details === 'object' ? problem.details : {}
      return details.unknownOutcome === true || details.verificationRequired === true ? t('The outcome is unknown. Reload and review before retrying.')
        : problem.status === 409 || problem.code === 'CONFLICT' ? t('The archive changed since it was read. Reload and review before saving.')
          : problem.status === 422 || problem.code === 'VALIDATION' ? t('Choose one of your mailboxes on the same domain and 0 to 3650 days. Nothing was saved.') : t('The request failed. Reload to see what was saved.')
    }
    const retention = async (domain: string, mailbox: string, days: number): Promise<void> => {
      if (busy || !admitted() || !view) return
      if (!askDialog) { note(formStatus, 'failed', t('Confirmation is unavailable; nothing was changed.')); return }
      const confirmed = await askDialog({ title: t('Run archive retention'), body: t('Archived messages older than {days} days will be permanently deleted from {mailbox}.', { days, mailbox }), confirm: t('Delete old archived messages'), danger: true }).catch(() => false)
      if (confirmed !== true || !view) return
      busy = true; controls()
      try { await request!('POST', '/api/account/mailx/archive/retention', { domain, expectedRevision: view.revision }); note(formStatus, 'saved', t('Retention started as a host job. Open Jobs to follow it.')) }
      catch (error) { note(formStatus, 'failed', problemText(error)) }
      finally { busy = false; controls() }
    }
    if (form instanceof HTMLFormElement) form.addEventListener('submit', event => {
      event.preventDefault()
      if (busy || !admitted() || !view) return
      const domains = [...body.querySelectorAll<HTMLTableRowElement>('tr[data-domain]')].flatMap(row => {
        const mailbox = row.querySelector<HTMLSelectElement>('[data-archive-mailbox]')!.value, incoming = row.querySelector<HTMLInputElement>('[data-archive-direction="incoming"]')!.checked
        const outgoing = row.querySelector<HTMLInputElement>('[data-archive-direction="outgoing"]')!.checked, days = Number(row.querySelector<HTMLInputElement>('[data-archive-days]')!.value || '0')
        return mailbox && (incoming || outgoing) ? [{ domain: row.dataset.domain!, mailbox, incoming, outgoing, retentionDays: days }] : []
      })
      busy = true; controls(); note(formStatus, 'saving', t('Saving and applying…'))
      void (async () => {
        try {
          const reply = await request!('PUT', '/api/account/mailx/archive', { policy: { domains }, expectedRevision: view!.revision }) as { application?: { outcome?: string } } | null
          const outcome = String(reply?.application?.outcome ?? 'unknown')
          note(formStatus, outcome === 'applied' || outcome === 'nothing' ? 'saved' : outcome === 'unknown' ? 'failed' : 'partial', outcome === 'applied' ? t('Saved and applied. Postfix confirmed the change.') : outcome === 'nothing' ? t('Saved. There was nothing to apply.')
            : outcome === 'not-connected' ? t('Saved. No host agent is connected, so it is not applied yet.') : outcome === 'refused' || outcome === 'rolled-back' ? t('Saved, but the host did not apply it. Check the state above.') : t('Saved, but the apply outcome is unknown. Review the mail service before retrying.'))
        } catch (error) { note(formStatus, 'failed', problemText(error)) }
        finally { busy = false; controls() }
        await load()
      })()
    })
    refresh.addEventListener('click', () => { void load() })
    if (!admitted()) { controls(); note(status, 'unavailable', t('The email archive is unavailable here. Nothing was read.')); return }
    void load()
  })
}

export const MAILX_ARCHIVE_CLIENT_BINDING = `(()=>{const formatArchiveDateTime=${DISPLAY_DATETIME_BINDING};const readMailxArchiveView=${readMailxArchiveView.toString()};return ${bindMailxArchive.toString()};})()`
