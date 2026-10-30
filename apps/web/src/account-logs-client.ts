import { VIEW_RECORD_HELPERS, cloneViewRecord as canonicalCloneViewRecord } from './workspace-view-templates.ts'
import { clientTemplate as canonicalClientTemplate, cloneClientTemplate as canonicalCloneClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot } from './client-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord
const clientTemplate = canonicalClientTemplate
const cloneClientTemplate = canonicalCloneClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
const LOGS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export interface AccountAccessEntry { time: string; host: string; ip: string; method: string; uri: string; status: number; bytes: number; referer: string; agent: string }
export interface AccountErrorEntry { time: string | null; level: string | null; message: string }
export interface AccountLogsClientView {
  kind: 'access' | 'error'; domainName: string; site: string; exists: boolean; sizeBytes: number; truncated: boolean; linesDropped: number; observedAt: string
  entries: (AccountAccessEntry | AccountErrorEntry)[]; unparsedLines: number
}
export interface AccountLogsFilter { status: string; level: string; text: string }
export function logsObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
const logsText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\r\n]/.test(value)
const LOG_LEVELS = ['debug', 'info', 'notice', 'warn', 'error', 'crit', 'alert', 'emerg']
export function readAccountLogsView(value: unknown, accountId: string, domainId: string, kind: 'access' | 'error'): AccountLogsClientView {
  if (!LOGS_ID.test(accountId) || !LOGS_ID.test(domainId) || !logsObject(value) || !logsObject(value.context) || !logsObject(value.file) || !logsObject(value.limits) || !Array.isArray(value.entries)) throw new Error('invalid_logs_scope')
  const { context, file, limits } = value
  if (context.accountId !== accountId || context.domainId !== domainId || context.kind !== kind || !logsText(context.domainName, 253) || !logsText(context.site, 253) || typeof file.exists !== 'boolean' || typeof file.sizeBytes !== 'number' || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || typeof file.truncated !== 'boolean'
    || limits.maxLines !== 2000 || limits.maxBytes !== 262144 || typeof limits.linesDropped !== 'number' || !Number.isSafeInteger(limits.linesDropped) || limits.linesDropped < 0 || value.entries.length > 2000 || typeof value.unparsedLines !== 'number' || !Number.isSafeInteger(value.unparsedLines) || value.unparsedLines < 0 || value.unparsedLines > 2000 || !logsText(value.observedAt, 64)) throw new Error('invalid_logs_state')
  const entries = value.entries.map(raw => {
    if (!logsObject(raw)) throw new Error('invalid_log_entry')
    if (kind === 'access') {
      if (Object.keys(raw).length !== 9 || !logsText(raw.time, 64) || !logsText(raw.host, 255) || !logsText(raw.ip, 64) || !logsText(raw.method, 32) || !logsText(raw.uri, 8193) || !logsText(raw.referer, 8193) || !logsText(raw.agent, 8193)
        || typeof raw.status !== 'number' || !Number.isInteger(raw.status) || raw.status < 100 || raw.status > 599 || typeof raw.bytes !== 'number' || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0) throw new Error('invalid_access_entry')
      return { time: raw.time, host: raw.host, ip: raw.ip, method: raw.method, uri: raw.uri, status: raw.status, bytes: raw.bytes, referer: raw.referer, agent: raw.agent }
    }
    if (Object.keys(raw).length !== 3 || !logsText(raw.message, 8193) || !(raw.time === null && raw.level === null || logsText(raw.time, 32) && LOG_LEVELS.includes(raw.level as string))) throw new Error('invalid_error_entry')
    return { time: raw.time as string | null, level: raw.level as string | null, message: raw.message }
  })
  return { kind, domainName: context.domainName, site: context.site, exists: file.exists, sizeBytes: file.sizeBytes, truncated: file.truncated, linesDropped: limits.linesDropped, observedAt: value.observedAt, entries, unparsedLines: value.unparsedLines }
}
/** Newest first; status class, minimum severity and case-insensitive text all apply. */
export function filterAccountLogEntries(view: AccountLogsClientView, filter: AccountLogsFilter): (AccountAccessEntry | AccountErrorEntry)[] {
  const needle = filter.text.trim().toLowerCase(), order = ['debug', 'info', 'notice', 'warn', 'error', 'crit', 'alert', 'emerg']
  return view.entries.filter(entry => {
    if ('status' in entry) {
      if (filter.status !== 'all' && String(entry.status)[0] !== filter.status) return false
      return !needle || [entry.uri, entry.host, entry.ip, entry.method, entry.referer, entry.agent, String(entry.status)].some(part => part.toLowerCase().includes(needle))
    }
    if (filter.level !== 'all' && (entry.level === null || order.indexOf(entry.level) < order.indexOf(filter.level))) return false
    return !needle || entry.message.toLowerCase().includes(needle)
  }).reverse()
}

function bindAccountLogs(_askDialog: unknown): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-account-logs]').forEach(root => {
    if (root.dataset.logsBound === 'true') return
    root.dataset.logsBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const accountId = root.dataset.account ?? '', kinds: string[] = (root.dataset.logsKinds ?? '').split(' ').filter(kind => kind === 'access' || kind === 'error')
    const eligible = (): boolean => root.isConnected && root.dataset.logsManage === 'true' && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const find = <T extends HTMLElement>(key: string): T => root.querySelector<T>('[data-logs-' + key + ']')!
    const domain = find<HTMLSelectElement>('domain'), kind = find<HTMLSelectElement>('kind'), statusFilter = find<HTMLSelectElement>('class'), levelFilter = find<HTMLSelectElement>('level'), text = find<HTMLInputElement>('text')
    const read = find<HTMLButtonElement>('read'), rows = find('rows'), head = find('head'), summary = find('summary'), statusMessage = find('status')
    if (!domain || !kind || !statusFilter || !levelFilter || !text || !read || !rows || !head || !summary || !statusMessage) return
    let view: AccountLogsClientView | null = null, busy = false, generation = 0
    const note = (state: string, message: string): void => { statusMessage.dataset.state = state; statusMessage.textContent = message; statusMessage.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const lock = (): void => { const blocked = !eligible() || busy || !domain.value || !kinds.includes(kind.value); read.disabled = blocked; domain.disabled = !eligible() || busy; kind.disabled = !eligible() || busy; for (const control of [statusFilter, levelFilter, text]) control.disabled = !eligible() || !view; root.setAttribute('aria-busy', String(busy)) }
    try {
      for (const [name, tag, slots] of [
        ['account-logs-access', 'tr', ['time', 'status', 'request', 'client', 'bytes', 'referer', 'agent']],
        ['account-logs-error', 'tr', ['time', 'level', 'message']],
        ['account-logs-access-head', 'tr', []], ['account-logs-error-head', 'tr', []],
        ['account-logs-empty-access', 'tr', ['message']], ['account-logs-empty-error', 'tr', ['message']],
        ['account-logs-stamp', 'bdi', ['value']],
      ] as const) cloneClientTemplate(clientTemplate(root, name), tag, slots)
    } catch {
      for (const control of root.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>('button,select,input')) control.disabled = true
      note('unavailable', t('Site logs are unavailable here. Nothing was read.')); return
    }
    const header = (access: boolean): void => { head.replaceChildren(cloneClientTemplate(clientTemplate(root, access ? 'account-logs-access-head' : 'account-logs-error-head'), 'tr', [])) }
    const paint = (): void => {
      rows.textContent = ''
      if (!view) return
      const access = view.kind === 'access', shown = filterAccountLogEntries(view, { status: statusFilter.value, level: levelFilter.value, text: text.value })
      statusFilter.closest<HTMLElement>('[data-logs-field]')!.hidden = !access; levelFilter.closest<HTMLElement>('[data-logs-field]')!.hidden = access
      header(access)
      for (const entry of shown) {
        const accessTime = 'status' in entry ? formatDisplayDateTime(entry.time) : null
        const values: Record<string, string> = 'status' in entry
          ? { time: accessTime === '—' ? entry.time : accessTime!, status: String(entry.status), request: entry.method + ' ' + entry.host + entry.uri, client: entry.ip, bytes: String(entry.bytes), referer: entry.referer || '-', agent: entry.agent || '-' }
          : { time: entry.time ?? '-', level: entry.level ?? '-', message: entry.message }
        rows.append(cloneViewRecord(root, access ? 'account-logs-access' : 'account-logs-error', 'tr', values))
      }
      if (!shown.length) rows.replaceChildren(cloneViewRecord(root, access ? 'account-logs-empty-access' : 'account-logs-empty-error', 'tr', { message: view.entries.length ? t('No entries match the filters.') : view.exists ? t('The log is empty.') : t('The site has not written this log yet.') }))
      summary.textContent = t('Showing {shown} / {total} entries of the site {site}', { shown: shown.length, total: view.entries.length, site: view.site }) + (view.truncated ? ' · ' + t('older lines are not included') : '') + (view.unparsedLines ? ' · ' + t('{count} lines could not be parsed', { count: view.unparsedLines }) : '')
    }
    async function load(): Promise<void> {
      const domainId = domain.value, selected = kind.value as 'access' | 'error'
      if (!eligible() || busy || !send || !LOGS_ID.test(domainId) || !kinds.includes(selected)) return
      const ticket = ++generation
      busy = true; view = null; paint(); lock(); note('reading', t('Reading the log…'))
      try {
        const next = readAccountLogsView(await send('GET', '/api/account/logs/' + encodeURIComponent(domainId) + '/' + selected), accountId, domainId, selected)
        if (ticket !== generation) return
        view = next; paint(); const [before, after] = t('Log read at {time}.').split('{time}'); note('read', before ?? ''); const observed = cloneViewRecord(root, 'account-logs-stamp', 'bdi', { value: formatDisplayDateTime(next.observedAt) }); statusMessage.append(observed, after ?? '')
      } catch { if (ticket === generation) note('failed', t('The log could not be read. Nothing was changed.')) }
      finally { if (ticket === generation) { busy = false; lock() } }
    }
    if (!send || !eligible() || !LOGS_ID.test(accountId) || !kinds.length) {
      for (const control of root.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>('button,select,input')) control.disabled = true
      note('unavailable', t('Site logs are unavailable here. Nothing was read.')); return
    }
    read.addEventListener('click', () => { void load() })
    for (const control of [domain, kind]) control.addEventListener('change', () => { view = null; paint(); summary.textContent = t('No log has been read.'); note('unread', t('Read the selected log.')); lock() })
    for (const control of [statusFilter, levelFilter]) control.addEventListener('change', paint)
    text.addEventListener('input', paint)
    lock()
  })
}

export const ACCOUNT_LOGS_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const LOGS_ID=${LOGS_ID.toString()};const LOG_LEVELS=${JSON.stringify(LOG_LEVELS)};const logsObject=${logsObject.toString()};const logsText=${logsText.toString()};const readAccountLogsView=${readAccountLogsView.toString()};const filterAccountLogEntries=${filterAccountLogEntries.toString()};return ${bindAccountLogs.toString()};})()`
