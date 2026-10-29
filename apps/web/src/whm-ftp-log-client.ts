/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
type FtpLogKindView = 'connect' | 'login' | 'login-failed' | 'upload' | 'download' | 'delete' | 'logout' | 'timeout'
export type FtpLogEventView = { at: string; kind: FtpLogKindView; client: string; user: string | null; account: string | null; path: string | null; pathBase: 'home' | 'host' | null; bytes: number | null }
export type FtpLogSummaryView = {
  events: number; connections: number; logins: { succeeded: number; failed: number }
  transfers: { uploads: number; uploadBytes: number; downloads: number; downloadBytes: number; deletes: number }
  topUsers: { user: string; account: string | null; events: number; logins: number; failures: number; uploads: number; downloads: number; bytes: number }[]
  topClients: { client: string; events: number; connections: number; logins: number; failures: number }[]
  failureBursts: { client: string; failures: number; users: number; firstAt: string; lastAt: string }[]
}
export type FtpLogView = {
  state: 'read' | 'unavailable'; reason: 'journal_unavailable' | 'output_limit' | null; observedAt: string; window: { since: string; until: string }; lineLimitReached: boolean
  accountMapping: 'read' | 'unavailable' | 'not-read'; counts: { records: number; events: number; skipped: number; unparsed: number; untrusted: number }
  summary: FtpLogSummaryView; filters: { user?: string; client?: string; kind?: FtpLogKindView; text?: string }; matched: number; matchedSummary: FtpLogSummaryView | null; events: FtpLogEventView[]; omittedEvents: number
}

function ftpLogObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function ftpLogText(value: unknown, max: number): string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('invalid_ftp_log_text')
  return value
}
function ftpLogNullable(value: unknown, max: number): string | null { return value === null ? null : ftpLogText(value, max) }
function ftpLogAccount(value: unknown): string | null {
  if (value !== null && (typeof value !== 'string' || !/^[a-z][a-z0-9]{1,15}$/.test(value))) throw new Error('invalid_ftp_log_account')
  return value as string | null
}
function ftpLogInstant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) throw new Error('invalid_ftp_log_instant')
  return value
}
function ftpLogCount(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('invalid_ftp_log_count')
  return value
}
function ftpLogClient(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-z.:%_-]{1,253}$/.test(value)) throw new Error('invalid_ftp_log_client')
  return value
}

export function readFtpLogEvent(raw: unknown): FtpLogEventView {
  const kinds = ['connect', 'login', 'login-failed', 'upload', 'download', 'delete', 'logout', 'timeout']
  if (!ftpLogObject(raw) || !kinds.includes(raw.kind as string)) throw new Error('invalid_ftp_log_event')
  const kind = raw.kind as FtpLogKindView, path = ftpLogNullable(raw.path, 4096), transfer = kind === 'upload' || kind === 'download'
  const bytes = raw.bytes === null ? null : ftpLogCount(raw.bytes, Number.MAX_SAFE_INTEGER)
  if ((path === null) !== (raw.pathBase === null) || raw.pathBase !== null && raw.pathBase !== 'home' && raw.pathBase !== 'host' || (path !== null) !== (transfer || kind === 'delete') || (bytes !== null) !== transfer) throw new Error('invalid_ftp_log_event')
  return { at: ftpLogInstant(raw.at), kind, client: ftpLogClient(raw.client), user: ftpLogNullable(raw.user, 254), account: ftpLogAccount(raw.account), path, pathBase: raw.pathBase as FtpLogEventView['pathBase'], bytes }
}

export function readFtpLogSummary(value: unknown): FtpLogSummaryView {
  if (!ftpLogObject(value) || !ftpLogObject(value.logins) || !ftpLogObject(value.transfers) || !Array.isArray(value.topUsers) || value.topUsers.length > 10 || !Array.isArray(value.topClients) || value.topClients.length > 10
    || !Array.isArray(value.failureBursts) || value.failureBursts.length > 20) throw new Error('invalid_ftp_log_summary')
  const n = (item: unknown): number => ftpLogCount(item, 20000), bytes = (item: unknown): number => ftpLogCount(item, Number.MAX_SAFE_INTEGER)
  const row = (item: unknown): Record<string, unknown> => { if (!ftpLogObject(item)) throw new Error('invalid_ftp_log_row'); return item }
  const logins = value.logins as Record<string, unknown>, transfers = value.transfers as Record<string, unknown>
  const summary: FtpLogSummaryView = {
    events: n(value.events), connections: n(value.connections), logins: { succeeded: n(logins.succeeded), failed: n(logins.failed) },
    transfers: { uploads: n(transfers.uploads), uploadBytes: bytes(transfers.uploadBytes), downloads: n(transfers.downloads), downloadBytes: bytes(transfers.downloadBytes), deletes: n(transfers.deletes) },
    topUsers: value.topUsers.map(item => { const v = row(item); return { user: ftpLogText(v.user, 254), account: ftpLogAccount(v.account), events: n(v.events), logins: n(v.logins), failures: n(v.failures), uploads: n(v.uploads), downloads: n(v.downloads), bytes: bytes(v.bytes) } }),
    topClients: value.topClients.map(item => { const v = row(item); return { client: ftpLogClient(v.client), events: n(v.events), connections: n(v.connections), logins: n(v.logins), failures: n(v.failures) } }),
    failureBursts: value.failureBursts.map(item => { const v = row(item), firstAt = ftpLogInstant(v.firstAt), lastAt = ftpLogInstant(v.lastAt); if (Date.parse(firstAt) > Date.parse(lastAt)) throw new Error('invalid_ftp_log_burst'); return { client: ftpLogClient(v.client), failures: n(v.failures), users: n(v.users), firstAt, lastAt } }),
  }
  const { connections, logins: { succeeded, failed }, transfers: { uploads, downloads, deletes } } = summary
  if (connections + succeeded + failed + uploads + downloads + deletes > summary.events) throw new Error('invalid_ftp_log_summary')
  return summary
}

export function readFtpLogView(value: unknown): FtpLogView {
  if (!ftpLogObject(value) || value.scope !== 'server' || !['read', 'unavailable'].includes(value.state as string) || !ftpLogObject(value.window) || !ftpLogObject(value.counts) || !ftpLogObject(value.filters)
    || typeof value.lineLimitReached !== 'boolean' || !['read', 'unavailable', 'not-read'].includes(value.accountMapping as string) || !Array.isArray(value.events) || value.events.length > 20000) throw new Error('invalid_ftp_log_view')
  const reason = value.reason === undefined ? null : value.reason
  if (value.state === 'read' ? reason !== null : !['journal_unavailable', 'output_limit'].includes(reason as string)) throw new Error('invalid_ftp_log_view')
  const since = ftpLogInstant(value.window.since), until = ftpLogInstant(value.window.until)
  if (Date.parse(since) >= Date.parse(until) || Date.parse(until) - Date.parse(since) > 7 * 86400000) throw new Error('invalid_ftp_log_window')
  const raw = value.counts as Record<string, unknown>
  const counts = { records: ftpLogCount(raw.records, 20000), events: ftpLogCount(raw.events, 20000), skipped: ftpLogCount(raw.skipped, 20000), unparsed: ftpLogCount(raw.unparsed, 20000), untrusted: ftpLogCount(raw.untrusted, 20000) }
  if (counts.events + counts.skipped + counts.unparsed + counts.untrusted !== counts.records) throw new Error('invalid_ftp_log_counts')
  const f = value.filters as Record<string, unknown>, filters: FtpLogView['filters'] = {}
  if (f.user !== undefined) filters.user = ftpLogText(f.user, 254)
  if (f.client !== undefined) filters.client = ftpLogClient(f.client)
  if (f.kind !== undefined) { if (!['connect', 'login', 'login-failed', 'upload', 'download', 'delete', 'logout', 'timeout'].includes(f.kind as string)) throw new Error('invalid_ftp_log_filters'); filters.kind = f.kind as FtpLogKindView }
  if (f.text !== undefined) filters.text = ftpLogText(f.text, 254)
  const summary = readFtpLogSummary(value.summary), matchedSummary = value.matchedSummary === null ? null : readFtpLogSummary(value.matchedSummary)
  const matched = ftpLogCount(value.matched, 20000), omittedEvents = ftpLogCount(value.omittedEvents, 20000)
  if (value.events.length + omittedEvents !== matched || summary.events !== counts.events || (matchedSummary === null) !== (Object.keys(filters).length === 0) || matchedSummary !== null && matchedSummary.events !== matched
    || value.state === 'unavailable' && counts.records !== 0) throw new Error('invalid_ftp_log_view')
  return { state: value.state as FtpLogView['state'], reason: reason as FtpLogView['reason'], observedAt: ftpLogInstant(value.observedAt), window: { since, until }, lineLimitReached: value.lineLimitReached, accountMapping: value.accountMapping as FtpLogView['accountMapping'], counts, summary, filters, matched, matchedSummary, events: value.events.map(readFtpLogEvent), omittedEvents }
}

function bindWhmFtpLog(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const kindLabel: Record<string, string> = { connect: t('Connected'), login: t('Signed in'), 'login-failed': t('Sign-in failed'), upload: t('Uploaded'), download: t('Downloaded'), delete: t('Deleted'), logout: t('Signed out'), timeout: t('Timed out') }
  const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + 'Z'
  const utc = (raw: string): string | null => {
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(raw.trim())
    const value = match ? match[1] + 'T' + match[2] + ':00Z' : ''
    return match && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value.replace('Z', '.000Z') ? value : null
  }
  const bdi = (value: string): HTMLElement => { const item = document.createElement('bdi'); item.dir = 'ltr'; item.textContent = value; return item }
  const cell = (row: HTMLTableRowElement, value: string | Node, technical = false): HTMLTableCellElement => { const td = document.createElement('td'); td.append(typeof value === 'string' ? (technical ? bdi(value) : value) : value); row.append(td); return td }
  const empty = (body: Element, columns: number, message: string): void => { body.textContent = ''; const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns; td.textContent = message; row.append(td); body.append(row) }
  const userText = (user: string | null): string => user === null ? '-' : user === '' ? t('(empty user name)') : user
  const notMapped = t('Not mapped')
  document.querySelectorAll<HTMLElement>('[data-whm-ftp-log]').forEach(root => {
    if (root.dataset.ftpLogBound === 'true') return
    root.dataset.ftpLogBound = 'true'
    const form = root.querySelector<HTMLFormElement>('[data-ftp-log-form]'), status = root.querySelector<HTMLElement>('[data-ftp-log-status]'), range = root.querySelector<HTMLSelectElement>('[data-ftp-log-range]')
    if (!form || !status || !range || !root.querySelector('[data-ftp-log-submit]')) return
    const admitted = (): boolean => root.isConnected && root.dataset.ftpLogCanRead === 'true' && !root.closest(denied) && !!send
    const fact = (key: string, value: string): void => { const node = root.querySelector<HTMLElement>('[data-ftp-log-fact="' + key + '"]'); if (node) node.textContent = value }
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const controls = form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')
    const custom = form.querySelectorAll<HTMLInputElement>('[data-ftp-log-custom]')
    const input = (name: string): HTMLInputElement | HTMLSelectElement | null => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null
    let busy = false, generation = 0, events: FtpLogEventView[] = [], page = 0
    const sync = (): void => {
      const blocked = !admitted() || busy
      controls.forEach(control => { control.disabled = blocked })
      custom.forEach(item => { item.disabled = blocked || range.value !== 'custom' })
      root.querySelectorAll<HTMLButtonElement>('[data-ftp-log-pick]').forEach(button => { button.disabled = blocked })
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
    const fill = (key: string, rows: readonly (readonly (string | Node | readonly [string, boolean])[])[], columns: number, none: string): void => {
      const body = root.querySelector<HTMLElement>('[data-ftp-log-table="' + key + '"]')
      if (!body) return
      body.textContent = ''
      for (const values of rows) { const row = document.createElement('tr'); for (const value of values) Array.isArray(value) ? cell(row, value[0] as string, value[1] as boolean) : cell(row, value as string | Node); body.append(row) }
      if (!rows.length) empty(body, columns, none)
    }
    const pick = (label: string, apply: () => void): HTMLButtonElement => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'xp-btn'; button.dataset.ftpLogPick = 'true'; button.textContent = label
      button.addEventListener('click', () => { if (busy || !admitted()) return; for (const name of ['user', 'client', 'kind', 'text']) { const control = input(name); if (control) control.value = '' } apply(); void load() })
      return button
    }
    const detail = root.querySelector<HTMLElement>('[data-ftp-log-detail]')
    const paintDetail = (view: FtpLogView | null): void => {
      if (!detail) return
      const user = view?.filters.user, summary = view?.matchedSummary
      const show = view !== null && view.state === 'read' && user !== undefined && !!summary
      detail.querySelector<HTMLElement>('[data-ftp-log-detail-empty]')!.hidden = show
      detail.querySelector<HTMLElement>('[data-ftp-log-detail-body]')!.hidden = !show
      if (!show) return
      const facts = detail.querySelector<HTMLElement>('[data-ftp-log-detail-facts]')!, clients = detail.querySelector<HTMLElement>('[data-ftp-log-detail-clients]')!
      const own = summary.topUsers.find(item => item.user === user)
      facts.textContent = ''
      for (const [label, value, technical] of [[t('User'), userText(user), user !== ''], [t('Account'), own?.account ?? notMapped, !!own?.account], [t('Successful sign-ins'), String(summary.logins.succeeded), true], [t(msgctxt('whm-ftp-log-client', 'Failed sign-ins')), String(summary.logins.failed), true], [t('Uploads'), String(summary.transfers.uploads), true], [t('Uploaded bytes'), String(summary.transfers.uploadBytes), true], [t('Downloads'), String(summary.transfers.downloads), true], [t('Downloaded bytes'), String(summary.transfers.downloadBytes), true], [t('Deletions'), String(summary.transfers.deletes), true]] as const) {
        const item = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.append(technical ? bdi(value) : value); item.append(dt, dd); facts.append(item)
      }
      clients.textContent = ''
      for (const item of summary.topClients) { const row = document.createElement('tr'); cell(row, item.client, true); cell(row, String(item.events), true); cell(row, String(item.logins), true); cell(row, String(item.failures), true); clients.append(row) }
      if (!summary.topClients.length) empty(clients, 4, t('No activity was logged for this user in this window.'))
    }
    const paintRows = (): void => {
      const body = root.querySelector<HTMLElement>('[data-ftp-log-rows]'), pages = Math.max(1, Math.ceil(events.length / 50))
      if (!body) return
      page = Math.min(page, pages - 1); body.textContent = ''
      for (const event of events.slice(page * 50, page * 50 + 50)) {
        const row = document.createElement('tr')
        cell(row, formatDisplayDateTime(event.at), true); cell(row, kindLabel[event.kind]!); cell(row, userText(event.user), event.user !== null && event.user !== ''); cell(row, event.account ?? '-', !!event.account); cell(row, event.client, true)
        cell(row, event.path === null ? '-' : event.pathBase === 'home' ? '~/' + event.path : event.path, event.path !== null); cell(row, event.bytes === null ? '-' : String(event.bytes), event.bytes !== null)
        body.append(row)
      }
      if (!events.length) empty(body, 7, t('No FTP events match these filters in this window. Widen the range or clear a filter.'))
      const label = root.querySelector<HTMLElement>('[data-ftp-log-page-label]')
      if (label) label.textContent = events.length ? t('Page {page} of {pages}', { page: page + 1, pages }) : ''
      root.querySelectorAll<HTMLButtonElement>('[data-ftp-log-page]').forEach(button => { button.disabled = !admitted() || busy || (button.dataset.ftpLogPage === 'newer' ? page === 0 : page >= pages - 1) })
    }
    const paintSummary = (view: FtpLogView | null): void => {
      const summary = view && view.state === 'read' ? view.summary : null, none = summary ? t('Nothing was logged in this window.') : t('Unavailable')
      const values: Record<string, number> | null = summary ? { succeeded: summary.logins.succeeded, failed: summary.logins.failed, connections: summary.connections, ...summary.transfers } : null
      root.querySelectorAll<HTMLElement>('[data-ftp-log-count]').forEach(node => { node.textContent = values ? String(values[node.dataset.ftpLogCount!] ?? 0) : t('Unavailable') })
      fill('users', (summary?.topUsers ?? []).map(item => [[userText(item.user), item.user !== ''], [item.account ?? notMapped, !!item.account], [String(item.events), true], [String(item.logins), true], [String(item.failures), true], [String(item.uploads), true], [String(item.downloads), true], [String(item.bytes), true], pick(t('View activity'), () => { input('user')!.value = item.user })] as const), 9, none)
      fill('clients', (summary?.topClients ?? []).map(item => [[item.client, true], [String(item.events), true], [String(item.connections), true], [String(item.logins), true], [String(item.failures), true], pick(t('Show events'), () => { input('client')!.value = item.client })] as const), 6, none)
      fill('bursts', (summary?.failureBursts ?? []).map(item => [[item.client, true], [String(item.failures), true], [String(item.users), true], [formatDisplayDateTime(item.firstAt), true], [formatDisplayDateTime(item.lastAt), true]] as const), 5, summary ? t('No failed sign-in bursts in this window.') : none)
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !send) return
      const selected = windowQuery()
      if (!selected) { note('failed', t('Enter a UTC start and end as YYYY-MM-DD HH:MM, at most 7 days apart. Nothing was read.')); return }
      const params = new URLSearchParams(selected)
      for (const name of ['user', 'client', 'kind', 'text']) { const raw = input(name)?.value ?? '', value = name === 'user' ? raw : raw.trim(); if (value.trim()) params.set(name, value) }
      const token = ++generation
      busy = true; sync(); note('reading', t('Reading pure-ftpd activity from the journal…'))
      try {
        const raw = await send('GET', '/api/server/ftp-log/activity?' + params)
        if (token !== generation || !admitted()) return
        const view = readFtpLogView(raw)
        fact('observed', formatDisplayDateTime(view.observedAt)); fact('window', formatDisplayDateTime(view.window.since) + ' – ' + formatDisplayDateTime(view.window.until)); fact('records', String(view.counts.records)); fact('matched', String(view.matched))
        const integrity = root.querySelector<HTMLElement>('[data-ftp-log-integrity]'), limit = root.querySelector<HTMLElement>('[data-ftp-log-limit]'), omitted = root.querySelector<HTMLElement>('[data-ftp-log-omitted]')
        if (integrity) { const c = view.counts; integrity.hidden = false; integrity.textContent = t('Journal records read: {records}. Activity events: {events}. Other pure-ftpd lines skipped: {skipped}. Unparsed: {unparsed}. Not written by the pure-ftpd service: {untrusted}. Unparsed and untrusted records are counted, never shown as activity.', c) + (view.accountMapping === 'unavailable' ? ' ' + t('Saved FTP accounts could not be read, so paths are shown as logged.') : '') }
        if (limit) limit.hidden = !view.lineLimitReached
        if (omitted) { omitted.hidden = !view.omittedEvents; omitted.textContent = t('Older matching events not shown because of the response size limit: {n}. Narrow the time range to see them.', { n: view.omittedEvents }) }
        events = view.events; page = 0; paintSummary(view); paintDetail(view); paintRows()
        if (view.state === 'unavailable') note('unavailable', view.reason === 'output_limit' ? t('The journal window produced more output than the bounded read allows. Narrow the time range; nothing is shown.') : t('The pure-ftpd journal is unavailable on this host. Nothing is shown and nothing was changed.'))
        else note('read', t('FTP activity read from the journal window. Events are newest first.'))
      } catch (error) {
        if (token !== generation) return
        events = []; paintSummary(null); paintDetail(null); paintRows()
        const code = ftpLogObject(error) ? error.status : undefined
        note('failed', code === 422 ? t('The filters were refused. Check the values; nothing was read.') : code === 403 ? t('Root authorization is required to read FTP logs.') : t('FTP activity could not be read or verified. Nothing is shown.'))
      } finally { if (token === generation) { busy = false; sync(); paintRows() } }
    }
    if (!admitted()) { sync(); note('unavailable', t('FTP log analysis is unavailable here. Nothing was read.')); return }
    form.addEventListener('submit', event => { event.preventDefault(); void load() })
    range.addEventListener('change', sync)
    root.querySelector<HTMLButtonElement>('[data-ftp-log-clear]')?.addEventListener('click', () => { if (busy) return; form.reset(); range.value = '24'; sync(); void load() })
    root.querySelectorAll<HTMLButtonElement>('[data-ftp-log-page]').forEach(button => button.addEventListener('click', () => { page += button.dataset.ftpLogPage === 'newer' ? -1 : 1; paintRows() }))
    sync(); void load()
  })
}

export const WHM_FTP_LOG_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const ftpLogObject=${ftpLogObject.toString()};const ftpLogText=${ftpLogText.toString()};const ftpLogNullable=${ftpLogNullable.toString()};const ftpLogAccount=${ftpLogAccount.toString()};const ftpLogInstant=${ftpLogInstant.toString()};const ftpLogCount=${ftpLogCount.toString()};const ftpLogClient=${ftpLogClient.toString()};const readFtpLogEvent=${readFtpLogEvent.toString()};const readFtpLogSummary=${readFtpLogSummary.toString()};const readFtpLogView=${readFtpLogView.toString()};return ${bindWhmFtpLog.toString()};})()`
