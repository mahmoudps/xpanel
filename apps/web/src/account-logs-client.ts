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

export interface RawAccessSettings { archive: boolean; removePreviousMonthArchive: boolean; retentionDays: number | null }
export interface RawAccessArchive { name: string; day: string; sizeBytes: number }
/** Archives the server holds because their copy into ~/logs failed: stable code archive_pending, count, size, oldest and the last failure. */
export interface RawAccessPending { code: 'archive_pending'; count: number; bytes: number; oldest: string; reason: string }
/** GET/PUT /api/account/logs/settings, pinned to the signed-in account. */
export function readRawAccessSettings(value: unknown, accountId: string): { settings: RawAccessSettings; source: 'account' | 'server' } {
  const valid = (v: unknown): v is RawAccessSettings => logsObject(v) && typeof v.archive === 'boolean' && typeof v.removePreviousMonthArchive === 'boolean' && (v.retentionDays === null || typeof v.retentionDays === 'number' && Number.isSafeInteger(v.retentionDays) && v.retentionDays >= 1 && v.retentionDays <= 3650)
  if (!logsObject(value) || !logsObject(value.context) || value.context.accountId !== accountId || !valid(value.settings) || !valid(value.serverDefaults) || !['account', 'server'].includes(String(value.source))) throw new Error('invalid_raw_access_settings')
  return { settings: { archive: value.settings.archive, removePreviousMonthArchive: value.settings.removePreviousMonthArchive, retentionDays: value.settings.retentionDays }, source: value.source as 'account' | 'server' }
}
/** GET /api/account/logs/archives: archives null when the account has no ~/logs directory the agent can read. */
export function readRawAccessArchives(value: unknown, accountId: string): { archives: RawAccessArchive[] | null; pending: RawAccessPending | null } {
  if (!logsObject(value) || !logsObject(value.context) || value.context.accountId !== accountId || typeof value.available !== 'boolean' || !Array.isArray(value.archives) || value.archives.length > 2000) throw new Error('invalid_raw_access_archives')
  const archives = value.archives.map(v => {
    if (!logsObject(v) || typeof v.name !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,252}-\d{4}-\d{2}-\d{2}(?:-[2-9])?\.gz$/.test(v.name) || typeof v.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.day) || typeof v.sizeBytes !== 'number' || !Number.isSafeInteger(v.sizeBytes) || v.sizeBytes < 0) throw new Error('invalid_raw_access_archive')
    return { name: v.name, day: v.day, sizeBytes: v.sizeBytes }
  })
  const held = value.pending
  if (held !== null && (!logsObject(held) || held.code !== 'archive_pending' || typeof held.count !== 'number' || !Number.isSafeInteger(held.count) || held.count < 1 || typeof held.bytes !== 'number' || !Number.isSafeInteger(held.bytes) || held.bytes < 0
    || typeof held.oldest !== 'string' || !Number.isFinite(Date.parse(held.oldest)) || typeof held.reason !== 'string' || !/^[a-z_]{1,40}$/.test(held.reason))) throw new Error('invalid_raw_access_pending')
  return { archives: value.available ? archives : null, pending: held === null ? null : { code: 'archive_pending', count: held.count as number, bytes: held.bytes as number, oldest: held.oldest as string, reason: held.reason as string } }
}

function bindAccountLogs(_askDialog: unknown): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  // cPanel Raw Access: archive settings and the archives the agent keeps in ~/logs.
  document.querySelectorAll<HTMLElement>('[data-account-raw-access]').forEach(root => {
    if (root.dataset.rawAccessBound === 'true') return
    root.dataset.rawAccessBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const accountId = root.dataset.account ?? '', form = root.querySelector<HTMLElement>('[data-raw-access-form]'), saveButton = root.querySelector<HTMLButtonElement>('[data-raw-access-save]')
    const archive = root.querySelector<HTMLInputElement>('[data-raw-access="archive"]'), previous = root.querySelector<HTMLInputElement>('[data-raw-access="removePreviousMonthArchive"]'), days = root.querySelector<HTMLInputElement>('[data-raw-access="retentionDays"]')
    const source = root.querySelector<HTMLElement>('[data-raw-access-source]'), status = root.querySelector<HTMLElement>('[data-raw-access-status]')
    const rows = root.querySelector<HTMLElement>('[data-raw-access-rows]'), listStatus = root.querySelector<HTMLElement>('[data-raw-access-list-status]'), defaults = root.querySelector<HTMLButtonElement>('[data-raw-access-defaults]')
    const pendingStatus = root.querySelector<HTMLElement>('[data-raw-access-pending]')
    const controls = [...root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')]
    const say = (node: HTMLElement | null, state: string, message: string): void => { if (!node) return; node.hidden = false; node.dataset.state = state; node.textContent = message; node.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    if (!send || root.dataset.rawAccessManage !== 'true' || !LOGS_ID.test(accountId) || !form || !saveButton || !archive || !previous || !days || !rows || root.closest('[data-readonly="true"],[data-wiring="unavailable"],[data-capability-unavailable="true"],fieldset:disabled')) {
      for (const control of controls) control.disabled = true
      say(status, 'unavailable', t('Raw access archives are unavailable here. Nothing was read.')); return
    }
    const show = (view: { settings: RawAccessSettings; source: 'account' | 'server' }): void => {
      archive.checked = view.settings.archive; previous.checked = view.settings.removePreviousMonthArchive; days.value = view.settings.retentionDays === null ? '' : String(view.settings.retentionDays)
      if (source) source.textContent = view.source === 'account' ? t('These are your own settings.') : t('These are the server defaults; saving makes them your own settings.')
    }
    const size = (value: number): string => value >= 1048576 ? (value / 1048576).toFixed(1) + ' MiB' : value >= 1024 ? (value / 1024).toFixed(1) + ' KiB' : value + ' B'
    const list = async (): Promise<void> => {
      say(listStatus, 'reading', t('Reading archives…'))
      try {
        const { archives, pending } = readRawAccessArchives(await send('GET', '/api/account/logs/archives'), accountId)
        const reasons: Record<string, string> = { archive_quota_exceeded: t('the account is over its disk quota'), archive_home_unavailable: t('the home directory is unavailable'), archive_unverified: t('the copy could not be verified') }
        if (pending) say(pendingStatus, 'failed', t('{count, plural, one {# archive waits} other {# archives wait}} on the server to be copied into ~/logs ({size}, oldest from {oldest}): {reason}. Each daily rotation tries again.', { count: pending.count, size: size(pending.bytes), oldest: formatDisplayDateTime(pending.oldest), reason: reasons[pending.reason] ?? t('the copy failed') }))
        else if (pendingStatus) pendingStatus.hidden = true
        rows.replaceChildren()
        const columns = rows.closest('table')?.querySelectorAll('thead th').length ?? 1
        if (!archives?.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns; td.textContent = archives ? t('No archives yet. A site log is archived after its first daily rotation.') : t('There is no ~/logs directory yet. It is created with the first archive.'); row.append(td); rows.append(row) }
        for (const item of archives ?? []) {
          const row = document.createElement('tr')
          for (const value of [item.name, item.day, size(item.sizeBytes)]) { const td = document.createElement('td'), bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; td.append(bdi); row.append(td) }
          const cell = document.createElement('td'), link = document.createElement('a')
          link.href = '/api/account/logs/archives/' + encodeURIComponent(item.name); link.setAttribute('download', item.name); link.textContent = t('Download'); link.className = 'xp-btn v2-btn'
          cell.append(link); row.append(cell); rows.append(row)
        }
        say(listStatus, 'read', t('{count, plural, one {# archive in ~/logs.} other {# archives in ~/logs.}}', { count: archives?.length ?? 0 }))
      } catch { say(listStatus, 'failed', t('The archives could not be read. Nothing was changed.')) }
    }
    const save = async (settings: RawAccessSettings | null): Promise<void> => {
      for (const control of controls) control.disabled = true
      say(status, 'reading', t('Saving…'))
      try { show(readRawAccessSettings(await send('PUT', '/api/account/logs/settings', { settings }), accountId)); say(status, 'read', settings ? t('Settings saved. They apply from the next daily rotation.') : t('The server defaults apply from the next daily rotation.')) }
      catch { say(status, 'failed', t('The settings were not saved. Reload the page before retrying.')) }
      finally { for (const control of controls) control.disabled = false; days.disabled = false }
    }
    saveButton.addEventListener('click', () => {
      const text = days.value.trim()
      if (text && !/^[1-9][0-9]{0,3}$/.test(text) || Number(text) > 3650) { say(status, 'failed', t('Enter 1 to 3650 days, or leave it empty to keep archives until you remove them.')); return }
      void save({ archive: archive.checked, removePreviousMonthArchive: previous.checked, retentionDays: text ? Number(text) : null })
    })
    defaults?.addEventListener('click', () => { void save(null) })
    void (async () => {
      try { show(readRawAccessSettings(await send('GET', '/api/account/logs/settings'), accountId)); say(status, 'read', t('Settings read.')) }
      catch { say(status, 'failed', t('The settings could not be read. Nothing was changed.')); for (const control of controls) control.disabled = true }
      await list()
    })()
  })
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

export const ACCOUNT_LOGS_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const LOGS_ID=${LOGS_ID.toString()};const LOG_LEVELS=${JSON.stringify(LOG_LEVELS)};const logsObject=${logsObject.toString()};const logsText=${logsText.toString()};const readAccountLogsView=${readAccountLogsView.toString()};const filterAccountLogEntries=${filterAccountLogEntries.toString()};const readRawAccessSettings=${readRawAccessSettings.toString()};const readRawAccessArchives=${readRawAccessArchives.toString()};return ${bindAccountLogs.toString()};})()`
