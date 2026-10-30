import { WHM_CLIENT_TEMPLATE_BINDING, whmClientNode as canonicalWhmClientNode } from './whm-client-templates.ts'
const whmClientNode = canonicalWhmClientNode
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatMailDateTime = formatDisplayDateTime

export type MaintenanceMailboxItem = { login: string; account: string; savedQuotaMb: number | null }
export type MaintenanceQuotaRow = { root: string; type: 'STORAGE' | 'MESSAGE'; value: number; limit: number | null; percent: number }
export type MaintenanceFolderRow = { name: string; messages: number; vsizeBytes: number }
export type MailboxMaintenanceView = {
  observedAt: string; fts: 'configured' | 'not_configured' | 'unavailable'; jobsAvailable: boolean; mailboxes: MaintenanceMailboxItem[]; mailboxesTruncated: boolean
  report: null | { mailbox: string; account: string; savedQuotaMb: number | null
    quota: { state: 'read' | 'unavailable'; reason: string | null; resources: MaintenanceQuotaRow[] }
    folders: { state: 'read' | 'unavailable'; reason: string | null; folders: MaintenanceFolderRow[]; truncated: boolean; totalMessages: number | null; totalVsizeBytes: number | null } }
}
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
type Ask = (options: Record<string, unknown>) => Promise<unknown>

/** Strict reader for GET /api/server/mail-maintenance; a report must belong to the requested mailbox and match its own totals. */
export function readMailboxMaintenanceView(value: unknown, mailbox: string | null): MailboxMaintenanceView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const int = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length >= 1 && item.length <= max
  const login = (item: unknown): item is string => typeof item === 'string' && item.length <= 254 && /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9_-])?@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(item) && item.split('@')[1]!.includes('.')
  const user = (item: unknown): item is string => typeof item === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(item)
  const reasons = ['user_unknown', 'command_failed', 'quota_error', 'malformed_output']
  if (!object(value) || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) || !['configured', 'not_configured', 'unavailable'].includes(String(value.fts)) || typeof value.jobsAvailable !== 'boolean'
    || !Array.isArray(value.mailboxes) || value.mailboxes.length > 2000 || typeof value.mailboxesTruncated !== 'boolean') throw new Error('invalid_mailbox_maintenance')
  const mailboxes = value.mailboxes.map(item => {
    if (!object(item) || !login(item.login) || !user(item.account) || item.savedQuotaMb !== null && !int(item.savedQuotaMb)) throw new Error('invalid_mailbox_maintenance_mailbox')
    return { login: item.login, account: item.account, savedQuotaMb: item.savedQuotaMb as number | null }
  })
  const base = { observedAt: value.observedAt, fts: value.fts as MailboxMaintenanceView['fts'], jobsAvailable: value.jobsAvailable, mailboxes, mailboxesTruncated: value.mailboxesTruncated }
  if (mailbox === null) { if (value.report !== null) throw new Error('invalid_mailbox_maintenance'); return { ...base, report: null } }
  const raw = value.report
  if (!object(raw) || raw.mailbox !== mailbox || mailboxes.length !== 1 || mailboxes[0]!.login !== mailbox || !user(raw.account) || raw.savedQuotaMb !== null && !int(raw.savedQuotaMb) || !object(raw.quota) || !object(raw.folders)) throw new Error('invalid_mailbox_maintenance_report')
  const quota = raw.quota, folders = raw.folders
  if (!Array.isArray(quota.resources) || quota.resources.length > 32 || (quota.state === 'read' ? quota.reason !== null : quota.state !== 'unavailable' || !reasons.includes(String(quota.reason)) || quota.resources.length)) throw new Error('invalid_mailbox_maintenance_quota')
  const resources = quota.resources.map(item => {
    if (!object(item) || !text(item.root, 128) || item.type !== 'STORAGE' && item.type !== 'MESSAGE' || !int(item.value) || item.limit !== null && !int(item.limit) || !int(item.percent)) throw new Error('invalid_mailbox_maintenance_quota')
    return { root: item.root, type: item.type as 'STORAGE' | 'MESSAGE', value: item.value, limit: item.limit as number | null, percent: item.percent }
  })
  if (!Array.isArray(folders.folders) || folders.folders.length > 200 || typeof folders.truncated !== 'boolean'
    || (folders.state === 'read' ? folders.reason !== null || !int(folders.totalMessages) || !int(folders.totalVsizeBytes) : folders.state !== 'unavailable' || !reasons.includes(String(folders.reason)) || folders.folders.length || folders.totalMessages !== null || folders.totalVsizeBytes !== null)) throw new Error('invalid_mailbox_maintenance_folders')
  const rows = folders.folders.map(item => {
    if (!object(item) || !text(item.name, 1024) || !int(item.messages) || !int(item.vsizeBytes)) throw new Error('invalid_mailbox_maintenance_folders')
    return { name: item.name, messages: item.messages, vsizeBytes: item.vsizeBytes }
  })
  if (folders.state === 'read' && !folders.truncated && (rows.reduce((sum, item) => sum + item.messages, 0) !== folders.totalMessages || rows.reduce((sum, item) => sum + item.vsizeBytes, 0) !== folders.totalVsizeBytes)) throw new Error('invalid_mailbox_maintenance_folders')
  return { ...base, report: { mailbox, account: raw.account, savedQuotaMb: raw.savedQuotaMb as number | null,
    quota: { state: quota.state as 'read' | 'unavailable', reason: quota.reason as string | null, resources },
    folders: { state: folders.state as 'read' | 'unavailable', reason: folders.reason as string | null, folders: rows, truncated: folders.truncated, totalMessages: folders.totalMessages as number | null, totalVsizeBytes: folders.totalVsizeBytes as number | null } } }
}

export function readMaintenanceJobAck(value: unknown, kind: string): { id: string; status: string } {
  const job = value && typeof value === 'object' ? (value as { job?: Record<string, unknown> }).job : undefined
  if (!job || typeof job.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(job.id) || job.kind !== kind || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(job.status))) throw new Error('invalid_job_ack')
  return { id: job.id, status: String(job.status) }
}

function bindWhmMailboxMaintenance(askDialog: Ask | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-mailbox-maintenance-workspace]').forEach(root => {
    if (root.dataset.mailboxMaintenanceBound === 'true') return
    root.dataset.mailboxMaintenanceBound = 'true'
    const q = <T extends Element = HTMLElement>(selector: string): T | null => root.querySelector<T>(selector)
    const status = q('[data-whm-mailbox-maintenance-status]'), refresh = q<HTMLButtonElement>('[data-whm-mailbox-maintenance-refresh]'), search = q<HTMLInputElement>('[data-whm-mailbox-maintenance-search]')
    const usage = q('[data-whm-mailbox-maintenance-usage-status]'), selectedNote = q('[data-whm-mailbox-maintenance-selected]'), banner = q('[data-whm-mailbox-maintenance-result]'), link = q<HTMLAnchorElement>('[data-whm-mailbox-maintenance-job-link]')
    const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    if (!status || !refresh) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.mailboxMaintenanceCanRead === 'true' && !root.closest(denied) && !!request
    const manageable = (): boolean => admitted() && root.dataset.mailboxMaintenanceCanManage === 'true'
    const kinds: Record<string, string> = { 'quota-recalc': 'mail.maintenance.quota-recalc', resync: 'mail.maintenance.resync', index: 'mail.maintenance.index' }
    const BULK_MAX = 32, SHOWN_MAX = 200
    let view: { observedAt: string; fts: string; jobsAvailable: boolean; mailboxes: MaintenanceMailboxItem[]; mailboxesTruncated: boolean } | null = null
    let report: MailboxMaintenanceView['report'] = null
    let busy = false
    const selected = new Set<string>()
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const show = (kind: string, message: string): void => { if (!banner) return; banner.hidden = false; banner.dataset.outcome = kind; banner.textContent = message; banner.setAttribute('role', ['unknown', 'denied'].includes(kind) ? 'alert' : 'status') }
    const technical = (value: string): HTMLElement => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; return bdi }
    const fact = (key: string, value: string | null): void => { const cell = q('[data-whm-mailbox-maintenance-fact="' + key + '"]'); if (cell) cell.textContent = value ?? t('Not read') }
    const toggle = (selector: string, visible: boolean): void => { const node = q(selector); if (node) node.hidden = !visible }
    const bytes = (value: number): string => value < 1024 ? value + ' B' : value < 1048576 ? (value / 1024).toFixed(1) + ' KB' : value < 1073741824 ? (value / 1048576).toFixed(1) + ' MB' : (value / 1073741824).toFixed(2) + ' GB'
    const fill = (key: string, rows: (string | Node)[][], empty: string, columns: number): void => {
      const body = q('[data-whm-mailbox-maintenance-rows="' + key + '"]')
      if (!body) return
      body.textContent = ''
      for (const cells of rows) { const row = document.createElement('tr'); for (const content of cells) { const td = document.createElement('td'); td.append(content); row.append(td) } body.append(row) }
      if (!rows.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns; td.textContent = empty; row.append(td); body.append(row) }
    }
    const outcome = (error: unknown): string => {
      const problem = error && typeof error === 'object' ? error as { status?: number; code?: string; details?: Record<string, unknown> } : {}, details = problem.details && typeof problem.details === 'object' ? problem.details : {}
      if (details.unknownOutcome === true || details.verificationRequired === true) return 'unknown'
      if (problem.status === 401 || problem.status === 403) return 'denied'
      if (problem.status === 404) return 'missing'
      if (problem.status === 412 || problem.code === 'PRECONDITION_FAILED') return 'refused'
      return details.stateChanged === false ? 'refused' : 'unknown'
    }
    const failure = (kind: string): string => kind === 'denied' ? t('Authorization is no longer valid. Nothing was changed.')
      : kind === 'missing' ? t('A selected mailbox is no longer saved with email. Nothing was changed; refresh and review.')
      : kind === 'refused' ? t('The request was refused. Nothing was changed.')
      : t('The outcome is unknown. Review host jobs before trying again.')
    const reasonText = (reason: string | null): string => reason === 'user_unknown' ? t('Dovecot does not know this user.') : reason === 'quota_error' ? t('The quota backend reported an error.')
      : reason === 'malformed_output' ? t('Dovecot returned output that could not be verified.') : t('The command did not complete.')
    const confirm = async (options: Record<string, unknown>): Promise<boolean> => {
      if (!askDialog) { show('refused', t('Confirmation is unavailable; nothing was changed.')); return false }
      try { return await askDialog(options) === true } catch { return false }
    }
    const controls = (): void => {
      refresh.disabled = busy || !admitted()
      if (search) search.disabled = !admitted()
      root.querySelectorAll<HTMLInputElement>('[data-whm-mailbox-maintenance-pick]').forEach(box => { box.disabled = busy || !manageable() || !box.checked && selected.size >= BULK_MAX })
      root.querySelectorAll<HTMLButtonElement>('[data-whm-mailbox-maintenance-inspect]').forEach(button => { button.disabled = busy || !admitted() })
      root.querySelectorAll<HTMLButtonElement>('[data-whm-mailbox-maintenance-run]').forEach(button => {
        button.disabled = busy || !manageable() || !view?.jobsAvailable || selected.size < 1 || selected.size > BULK_MAX || button.dataset.whmMailboxMaintenanceRun === 'index' && view?.fts !== 'configured'
      })
      if (selectedNote) selectedNote.textContent = t('Selected mailboxes: {n} / {max}', { n: selected.size, max: BULK_MAX })
      root.setAttribute('aria-busy', String(busy))
    }
    const paintList = (): void => {
      const current = view
      fact('count', current ? String(current.mailboxes.length) : null)
      fact('fts', current ? current.fts === 'configured' ? t(msgctxt('whm-mailbox-maintenance-client', 'Configured')) : current.fts === 'not_configured' ? t(msgctxt('whm-mailbox-maintenance-client', 'Not configured')) : t('Unknown') : null)
      fact('jobs', current ? current.jobsAvailable ? t(msgctxt('whm-mailbox-maintenance-client', 'Available')) : t(msgctxt('whm-mailbox-maintenance-client', 'Unavailable')) : null)
      fact('observed-at', current ? formatMailDateTime(current.observedAt) : null)
      toggle('[data-whm-mailbox-maintenance-truncated]', !!current?.mailboxesTruncated)
      toggle('[data-whm-mailbox-maintenance-fts-note]', current?.fts === 'not_configured')
      for (const login of [...selected]) if (!current?.mailboxes.some(item => item.login === login)) selected.delete(login)
      const needle = (search?.value ?? '').trim().toLowerCase()
      const matches = (current?.mailboxes ?? []).filter(item => !needle || item.login.includes(needle) || item.account.includes(needle))
      toggle('[data-whm-mailbox-maintenance-limited]', matches.length > SHOWN_MAX)
      fill('mailboxes', matches.slice(0, SHOWN_MAX).map(item => {
        const box = document.createElement('input'); box.type = 'checkbox'; box.checked = selected.has(item.login); box.dataset.whmMailboxMaintenancePick = item.login; box.setAttribute('aria-label', t('Select {mailbox}', { mailbox: item.login }))
        const inspect = whmClientNode(root, 'whm-mailbox-inspect', 'button'); inspect.type = 'button'; inspect.disabled = !admitted() || busy; inspect.textContent = t('Inspect'); inspect.dataset.whmMailboxMaintenanceInspect = item.login; inspect.setAttribute('aria-label', t('Inspect {mailbox}', { mailbox: item.login }))
        return [box, technical(item.login), technical(item.account), item.savedQuotaMb === null ? t('Unlimited') : technical(item.savedQuotaMb + ' MB'), inspect]
      }), !current ? t('No mailboxes have been read.') : current.mailboxes.length ? t('No mailboxes match.') : t('No saved email accounts exist.'), 5)
      controls()
    }
    const paintReport = (): void => {
      const current = report
      const storage = current?.quota.resources.find(item => item.type === 'STORAGE') ?? null, messages = current?.quota.resources.find(item => item.type === 'MESSAGE') ?? null
      fact('mailbox', current?.mailbox ?? null); fact('account', current?.account ?? null)
      fact('saved-quota', current ? current.savedQuotaMb === null ? t('Unlimited') : current.savedQuotaMb + ' MB' : null)
      // doveadm-quota(1): STORAGE values are kilobytes.
      fact('storage', current?.quota.state === 'read' && storage ? bytes(storage.value * 1024) + (storage.limit === null ? '' : ' / ' + bytes(storage.limit * 1024)) : current ? t('Not reported') : null)
      fact('messages', current?.folders.state === 'read' ? String(current.folders.totalMessages) : current?.quota.state === 'read' && messages ? String(messages.value) : current ? t('Not reported') : null)
      fact('size', current?.folders.state === 'read' ? bytes(current.folders.totalVsizeBytes!) : current ? t('Not reported') : null)
      toggle('[data-whm-mailbox-maintenance-folders-truncated]', !!current?.folders.truncated)
      fill('quota', current?.quota.state === 'read' ? current.quota.resources.map(item => [technical(item.root), item.type === 'STORAGE' ? t('Storage') : t('Messages'),
        technical(item.type === 'STORAGE' ? bytes(item.value * 1024) : String(item.value)), item.limit === null ? t('Unlimited') : technical(item.type === 'STORAGE' ? bytes(item.limit * 1024) : String(item.limit)), technical(item.percent + '%')]) : [],
        !current ? t('No quota has been read.') : current.quota.state === 'read' ? t('Dovecot reported no quota roots for this mailbox.') : t('Quota is unavailable.') + ' ' + reasonText(current.quota.reason), 5)
      fill('folders', current?.folders.state === 'read' ? current.folders.folders.map(item => [technical(item.name), technical(String(item.messages)), technical(bytes(item.vsizeBytes))]) : [],
        !current ? t('No folders have been read.') : current.folders.state === 'read' ? t('Dovecot reported no folders.') : t('Folder usage is unavailable.') + ' ' + reasonText(current.folders.reason), 3)
    }
    const accept = (next: MailboxMaintenanceView): void => { view = { observedAt: next.observedAt, fts: next.fts, jobsAvailable: next.jobsAvailable, mailboxes: next.mailboxes, mailboxesTruncated: next.mailboxesTruncated } }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; controls(); note('reading', t('Reading saved mailboxes…'))
      try {
        const next = readMailboxMaintenanceView(await request!('GET', '/api/server/mail-maintenance'), null)
        if (!admitted()) return
        accept(next)
        note('read', next.jobsAvailable ? t('Saved mailboxes read from the server.') : t('Mailboxes were read. Host jobs are unavailable, so maintenance cannot start.'))
      } catch { if (admitted()) note('failed', t('Mailboxes could not be read. Any rows shown are from the last successful read.')) }
      finally { busy = false; paintList() }
    }
    const inspect = async (login: string): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; controls()
      if (usage) usage.textContent = t('Reading mailbox usage…')
      try {
        const next = readMailboxMaintenanceView(await request!('GET', '/api/server/mail-maintenance?mailbox=' + encodeURIComponent(login)), login)
        if (!admitted()) return
        if (view) view = { ...view, observedAt: next.observedAt, fts: next.fts, jobsAvailable: next.jobsAvailable }
        report = next.report
        if (usage) usage.textContent = next.report!.quota.state === 'read' && next.report!.folders.state === 'read' ? t('Usage read from Dovecot.') : t('Some usage could not be read from Dovecot.')
      } catch (error) { if (usage) usage.textContent = outcome(error) === 'missing' ? t('This mailbox is no longer saved with email.') : t('Mailbox usage could not be read. Values shown are from the last successful read.') }
      finally { busy = false; paintList(); paintReport() }
    }
    const titles: Record<string, string> = { 'quota-recalc': t('Recalculate quota'), resync: t('Rebuild indexes'), index: t('Update search index') }
    const run = async (operation: string): Promise<void> => {
      const mailboxes = [...selected]
      if (busy || !manageable() || !kinds[operation] || mailboxes.length < 1 || mailboxes.length > BULK_MAX) return
      if (!await confirm({ title: titles[operation] + '?', body: mailboxes.join('\n') + '\n' + t('This runs as one host job with one step per mailbox.'), confirm: titles[operation] }) || !manageable()) return
      busy = true; controls()
      try {
        const ack = readMaintenanceJobAck(await request!('POST', '/api/server/mail-maintenance/jobs', { operation, mailboxes }), kinds[operation]!)
        if (link) { link.href = '/whm/jobs?job=' + encodeURIComponent(ack.id); link.hidden = false }
        show('submitted', t('Host job submitted. Open the job to follow each mailbox and the final verification.'))
      } catch (error) { const kind = error instanceof Error && error.message === 'invalid_job_ack' ? 'unknown' : outcome(error); show(kind, failure(kind)) }
      finally { busy = false; controls() }
    }
    q('[data-whm-mailbox-maintenance-rows="mailboxes"]')?.addEventListener('click', event => {
      const target = event.target as Element | null
      const button = target?.closest<HTMLButtonElement>('[data-whm-mailbox-maintenance-inspect]')
      if (button && !button.disabled) void inspect(button.dataset.whmMailboxMaintenanceInspect ?? '')
    })
    q('[data-whm-mailbox-maintenance-rows="mailboxes"]')?.addEventListener('change', event => {
      const box = (event.target as Element | null)?.closest<HTMLInputElement>('[data-whm-mailbox-maintenance-pick]')
      if (!box) return
      const login = box.dataset.whmMailboxMaintenancePick ?? ''
      if (box.checked && selected.size < BULK_MAX) selected.add(login); else { box.checked = false; selected.delete(login) }
      controls()
    })
    root.querySelectorAll<HTMLButtonElement>('[data-whm-mailbox-maintenance-run]').forEach(button => button.addEventListener('click', () => { if (!button.disabled) void run(button.dataset.whmMailboxMaintenanceRun ?? '') }))
    search?.addEventListener('input', () => { if (view) paintList() })
    refresh.addEventListener('click', () => { void load() })
    if (!admitted()) { controls(); note('unavailable', t('Mailbox maintenance is unavailable here. Nothing was read or changed.')); return }
    void load()
  })
}

export const WHM_MAILBOX_MAINTENANCE_CLIENT_BINDING = `(()=>{${WHM_CLIENT_TEMPLATE_BINDING}const formatMailDateTime=${DISPLAY_DATETIME_BINDING};const readMailboxMaintenanceView=${readMailboxMaintenanceView.toString()};const readMaintenanceJobAck=${readMaintenanceJobAck.toString()};return ${bindWhmMailboxMaintenance.toString()};})()`
