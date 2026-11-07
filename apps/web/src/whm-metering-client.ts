import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import type { IoWorkspaceView } from '../../api/src/metering-workspace.ts'
import type { BandwidthReport } from '../../agent/src/metering.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime

export function readWhmIoView(raw: unknown): IoWorkspaceView {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  const limit = (v: unknown): boolean => v === 'unlimited' || typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  const instant = (v: unknown): boolean => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))
  const bad = (): never => { throw new Error('invalid_io_response') }
  if (!object(raw) || !['read', 'partial', 'unavailable'].includes(String(raw.state)) || !Array.isArray(raw.accounts) || !number(raw.unmeasuredAccounts) || raw.observedAt !== null && !instant(raw.observedAt)) return bad()
  if (raw.state === 'unavailable' ? raw.host !== null || raw.accounts.length > 0 : !object(raw.host) || !instant(raw.observedAt)) return bad()
  if (object(raw.host)) for (const key of ['cpuPercent', 'memoryUsedBytes', 'memoryTotalBytes', 'loadAvg1m', 'psiSomeAvg10', 'psiFullAvg10', 'awaitMs']) if (raw.host[key] !== null && !number(raw.host[key])) return bad()
  const disk = raw.disk
  if (!object(disk) || !['read', 'idle', 'unavailable'].includes(String(disk.state)) || !Array.isArray(disk.devices) || disk.awaitMs !== null && !number(disk.awaitMs) || disk.state !== 'unavailable' && !instant(disk.observedAt)) return bad()
  for (const v of disk.devices) if (!object(v) || typeof v.name !== 'string' || !/^[a-z0-9]{2,16}$/.test(v.name) || v.readAwaitMs !== null && !number(v.readAwaitMs) || v.writeAwaitMs !== null && !number(v.writeAwaitMs) || !number(v.utilPercent)) return bad()
  for (const v of raw.accounts) {
    if (!object(v) || typeof v.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(v.username) || !Number.isSafeInteger(v.uid) || !['readBytesPerSec', 'writeBytesPerSec', 'readIops', 'writeIops', 'cpuPercent', 'memoryCurrentBytes', 'pidsCurrent'].every(key => number(v[key])) || !limit(v.memoryLimitMb) || !limit(v.pidsLimit)) return bad()
  }
  return raw as unknown as IoWorkspaceView
}

export function readWhmBandwidthView(raw: unknown): BandwidthReport {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  const instant = (v: unknown): boolean => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))
  const sources = ['web', 'mail', 'ftp']
  const bad = (): never => { throw new Error('invalid_bandwidth_response') }
  if (!object(raw) || !['read', 'partial', 'unavailable'].includes(String(raw.state)) || typeof raw.month !== 'string' || !/^\d{4}-\d{2}$/.test(raw.month) || !object(raw.sources) || !Array.isArray(raw.accounts) || !count(raw.pendingBytes) || !count(raw.unavailableSites) || !count(raw.skippedLines)) return bad()
  if (raw.state === 'unavailable' ? raw.since !== null || raw.updatedAt !== null : !instant(raw.since) || !instant(raw.updatedAt)) return bad()
  for (const source of sources) { const v = raw.sources[source]; if (!object(v) || !['read', 'partial', 'unavailable'].includes(String(v.state)) || v.since !== null && !instant(v.since)) return bad() }
  for (const v of raw.accounts) {
    if (!object(v) || typeof v.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(v.username) || typeof v.domain !== 'string' || typeof v.status !== 'string' || !object(v.month) || !['within', 'near', 'over', 'unlimited', 'unmeasured'].includes(String(v.limitState)) || typeof v.enforced !== 'boolean' || typeof v.limited !== 'boolean'
      || typeof v.customLimit !== 'boolean' || v.reliefThrough !== null && !(typeof v.reliefThrough === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.reliefThrough))) return bad()
    const month = v.month
    for (const source of sources) { const totals = month[source]; if (totals !== null && (!object(totals) || !count(totals.count) || !count(totals.receivedBytes) || !count(totals.sentBytes))) return bad() }
    if (v.totalBytes !== null && !count(v.totalBytes) || v.limitBytes !== null && !count(v.limitBytes) || v.usedPercent !== null && !(typeof v.usedPercent === 'number' && v.usedPercent >= 0)) return bad()
    if ((v.totalBytes === null) !== sources.every(source => month[source] === null)) return bad()
  }
  return raw as unknown as BandwidthReport
}

export interface CustomBandwidthRow { accountId: string; username: string; domain: string; planName: string | null; packageLimitMb: number | 'unlimited' | null; customLimitMb: number | 'unlimited' }
/** GET /api/accounts/bandwidth/custom: accounts whose bandwidth limit differs from their package. */
export function readCustomBandwidthView(raw: unknown): CustomBandwidthRow[] {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const limit = (v: unknown): boolean => v === 'unlimited' || typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  if (!object(raw) || !Array.isArray(raw.accounts) || raw.accounts.length > 4096) throw new Error('invalid_custom_bandwidth')
  return raw.accounts.map(v => {
    if (!object(v) || typeof v.accountId !== 'string' || !/^[0-9a-f-]{36}$/.test(v.accountId) || typeof v.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(v.username) || typeof v.domain !== 'string' || v.domain.length > 253
      || v.planName !== null && typeof v.planName !== 'string' || v.packageLimitMb !== null && !limit(v.packageLimitMb) || !limit(v.customLimitMb)) throw new Error('invalid_custom_bandwidth')
    return { accountId: v.accountId, username: v.username, domain: v.domain, planName: v.planName as string | null, packageLimitMb: v.packageLimitMb as CustomBandwidthRow['packageLimitMb'], customLimitMb: v.customLimitMb as CustomBandwidthRow['customLimitMb'] }
  })
}
export interface LogRetentionView {
  serverDefaults: { archive: boolean; removePreviousMonthArchive: boolean; retentionDays: number | null }; panelRotateDays: number
  rotation: { state: 'unavailable' } | { state: 'read'; lastRun: { at: string; rotated: number; archived: number; deleted: number; removedArchives: number; failures: number; held: number; lost: number } | null; failures: { username: string; site: string; reason: string; at: string }[]
    pending: { username: string; code: 'archive_pending'; count: number; bytes: number; oldest: string; reason: string }[]; hold: { days: number; maxBytes: number } }
  accounts: { username: string; domain: string; settings: { archive: boolean; removePreviousMonthArchive: boolean; retentionDays: number | null }; source: 'account' | 'server' }[]
}
/** GET /api/server/logs/retention (WHM Web Log Retention). */
export function readLogRetentionView(raw: unknown): LogRetentionView {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  const settings = (v: unknown): boolean => object(v) && typeof v.archive === 'boolean' && typeof v.removePreviousMonthArchive === 'boolean' && (v.retentionDays === null || count(v.retentionDays))
  const bad = (): never => { throw new Error('invalid_log_retention') }
  if (!object(raw) || !settings(raw.serverDefaults) || !count(raw.panelRotateDays) || !object(raw.rotation) || !Array.isArray(raw.accounts) || raw.accounts.length > 4096) return bad()
  const rotation = raw.rotation
  if (rotation.state === 'read') {
    const run = rotation.lastRun
    if (run !== null && (!object(run) || typeof run.at !== 'string' || !['rotated', 'archived', 'deleted', 'removedArchives', 'failures', 'held', 'lost'].every(key => count(run[key]))) || !Array.isArray(rotation.failures) || !Array.isArray(rotation.pending) || !object(rotation.hold) || !count(rotation.hold.days) || !count(rotation.hold.maxBytes)) return bad()
    for (const v of rotation.failures as unknown[]) if (!object(v) || typeof v.username !== 'string' || typeof v.site !== 'string' || typeof v.reason !== 'string' || typeof v.at !== 'string') return bad()
    for (const v of rotation.pending as unknown[]) if (!object(v) || v.code !== 'archive_pending' || typeof v.username !== 'string' || !count(v.count) || !count(v.bytes) || typeof v.oldest !== 'string' || typeof v.reason !== 'string') return bad()
  } else if (rotation.state !== 'unavailable') return bad()
  for (const v of raw.accounts) if (!object(v) || typeof v.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(v.username) || typeof v.domain !== 'string' || !settings(v.settings) || !['account', 'server'].includes(String(v.source))) return bad()
  return raw as unknown as LogRetentionView
}
export interface DiskQuotaClientRow { accountId: string; username: string; domain: string; owner: string | null; usedMb: number | null; limitMb: number | 'unlimited' | null; source: 'package' | 'account'; planName: string | null }
export interface DiskQuotaClientPage { rows: DiskQuotaClientRow[]; total: number; page: number; pageSize: number; sort: string; dir: 'asc' | 'desc'; usage: { state: 'read' | 'unavailable'; observedAt: string | null; reason: string | null } }
/** GET /api/accounts/disk-quotas: one server-sorted, filtered page of the WHM Quota Modification table. */
export function readDiskQuotaPage(raw: unknown): DiskQuotaClientPage {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  const limit = (v: unknown): boolean => v === null || v === 'unlimited' || count(v)
  const bad = (): never => { throw new Error('invalid_disk_quotas') }
  if (!object(raw) || !Array.isArray(raw.rows) || raw.rows.length > 100 || !count(raw.total) || !count(raw.page) || raw.page < 1 || ![10, 25, 50, 100].includes(raw.pageSize as number) || !['username', 'domain', 'owner', 'used', 'limit'].includes(String(raw.sort)) || raw.dir !== 'asc' && raw.dir !== 'desc'
    || !object(raw.usage) || !['read', 'unavailable'].includes(String(raw.usage.state)) || raw.usage.reason !== null && typeof raw.usage.reason !== 'string') return bad()
  const rows = raw.rows.map(v => {
    if (!object(v) || typeof v.accountId !== 'string' || !/^[0-9a-f-]{36}$/.test(v.accountId) || typeof v.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(v.username) || typeof v.domain !== 'string' || v.domain.length > 253
      || v.owner !== null && typeof v.owner !== 'string' || v.usedMb !== null && !count(v.usedMb) || !limit(v.limitMb) || v.source !== 'package' && v.source !== 'account' || v.planName !== null && typeof v.planName !== 'string') return bad()
    return { accountId: v.accountId, username: v.username, domain: v.domain, owner: v.owner as string | null, usedMb: v.usedMb as number | null, limitMb: v.limitMb as DiskQuotaClientRow['limitMb'], source: v.source as DiskQuotaClientRow['source'], planName: v.planName as string | null }
  })
  return { rows, total: raw.total, page: raw.page, pageSize: raw.pageSize as number, sort: String(raw.sort), dir: raw.dir, usage: { state: raw.usage.state as 'read' | 'unavailable', observedAt: typeof raw.usage.observedAt === 'string' ? raw.usage.observedAt : null, reason: raw.usage.reason as string | null } }
}
export interface RawServerLogsClientView { server: 'nginx' | 'apache'; state: 'read' | 'unavailable'; files: { name: string; sizeBytes: number; mtime: string; downloadable: boolean }[]; maxBytes: number }
/** GET /api/server/logs/raw/<server>: the web server's own current and rotated logs. */
export function readRawServerLogs(raw: unknown, server: string): RawServerLogsClientView {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  if (!object(raw) || raw.server !== server || !['read', 'unavailable'].includes(String(raw.state)) || !Array.isArray(raw.files) || raw.files.length > 200 || !count(raw.maxBytes)) throw new Error('invalid_raw_server_logs')
  const files = raw.files.map(v => {
    if (!object(v) || typeof v.name !== 'string' || !/^(?:access|error)\.log(?:\.[1-9][0-9]?)?(?:\.gz)?$/.test(v.name) || !count(v.sizeBytes) || typeof v.mtime !== 'string' || typeof v.downloadable !== 'boolean') throw new Error('invalid_raw_server_log')
    return { name: v.name, sizeBytes: v.sizeBytes, mtime: v.mtime, downloadable: v.downloadable }
  })
  return { server: raw.server as 'nginx' | 'apache', state: raw.state as 'read' | 'unavailable', files, maxBytes: raw.maxBytes }
}
/** One account's limit override fields: an empty field returns to the package value, unlimited is its own choice. */
export function accountLimitsPatch(fields: { name: string; value: string; unlimited: boolean; group?: 'resources' | 'caps'; scale?: number }[]): { resources?: Record<string, number | 'unlimited' | null>; caps?: Record<string, number | 'unlimited' | null> } {
  const resources: Record<string, number | 'unlimited' | null> = {}, caps: Record<string, number | 'unlimited' | null> = {}
  for (const field of fields) {
    // A rendered package field names its group; only disk and bandwidth stand without one.
    if (!field.group && !['diskMb', 'bandwidthMbMonth'].includes(field.name)) throw new Error('invalid_limit_field')
    const target = field.group === 'caps' ? caps : resources, text = field.value.trim()
    if (field.unlimited) target[field.name] = 'unlimited'
    else if (!text) target[field.name] = null
    else if ((field.group === 'caps' ? /^(?:0|[1-9][0-9]{0,14})$/ : /^[1-9][0-9]{0,14}$/).test(text)) target[field.name] = Number(text) * (field.scale ?? 1)
    else throw new Error('invalid_limit_value')
  }
  return { ...(Object.keys(resources).length ? { resources } : {}), ...(Object.keys(caps).length ? { caps } : {}) }
}

function bindWhmMetering(askDialog?: (input: { title: string; body: string; confirm: string }) => Promise<unknown>): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const bytes = (value: number): string => { const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']; let size = value, index = 0; while (size >= 1024 && index < units.length - 1) { size /= 1024; index++ } return (index ? size.toFixed(1) : String(size)) + ' ' + units[index] }
  const fixed = (value: number): string => String(Math.round(value * 10) / 10)
  document.querySelectorAll<HTMLElement>('[data-whm-metering]').forEach(root => {
    if (root.dataset.meteringBound === 'true') return
    root.dataset.meteringBound = 'true'
    const kind = root.dataset.whmMetering
    const refresh = root.querySelector<HTMLButtonElement>('[data-whm-metering-refresh]'), status = root.querySelector<HTMLElement>('[data-whm-metering-status]')
    if (!refresh || !status) return
    if (!send || root.dataset.meteringCanRead !== 'true' || root.closest('[data-readonly="true"],[data-wiring="unavailable"],[data-capability-state="unavailable"],fieldset:disabled')) { refresh.disabled = true; return }
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const fact = (key: string, value: string): void => { const node = root.querySelector('[data-whm-metering-fact="' + key + '"]'); if (node) node.textContent = value }
    const fill = (table: string, values: { text: string; numeric?: boolean; level?: string }[][], empty: string): void => {
      const rows = root.querySelector<HTMLElement>('[data-whm-metering-rows="' + table + '"]')
      if (!rows) return
      rows.replaceChildren()
      const columns = rows.closest('table')?.querySelectorAll('thead th').length ?? 1
      if (!values.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns; td.textContent = empty; row.append(td); rows.append(row); return }
      for (const cells of values) {
        const row = document.createElement('tr')
        for (const value of cells) { const td = document.createElement('td'), bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value.text; if (value.numeric) td.dataset.numeric = ''; if (value.level) td.dataset.level = value.level; td.append(bdi); row.append(td) }
        rows.append(row)
      }
    }
    const unavailable = t('Unavailable')
    const meter = (used: number, cap: number | 'unlimited', unit: string, scale: number): { text: string; level?: string } => {
      if (cap === 'unlimited' || cap <= 0) return { text: fixed(used / scale) + ' ' + unit + '; ' + t('No limit') }
      const share = used / scale / cap * 100, level = share >= 95 ? 'critical' : share >= 80 ? 'warn' : 'ok'
      return { text: fixed(used / scale) + ' / ' + cap + ' ' + unit + ' (' + Math.round(share) + '%); ' + (level === 'ok' ? t('Within limit') : level === 'warn' ? t('Warning') : t('Critical')), level }
    }
    const loadIo = async (): Promise<void> => {
      const view = readWhmIoView(await send('GET', '/api/server/monitoring/io'))
      const sum = (key: 'readBytesPerSec' | 'writeBytesPerSec' | 'readIops' | 'writeIops'): number => view.accounts.reduce((total, row) => total + row[key], 0)
      const host = view.host, disk = view.disk
      fact('observed', view.observedAt ? formatDisplayDateTime(view.observedAt) : unavailable)
      // Totals over no measured account would read as a real zero while accounts are still unmeasured.
      const noTotals = view.state === 'unavailable' ? unavailable : !view.accounts.length && view.unmeasuredAccounts ? t('Not measured') : null
      fact('read', noTotals ?? bytes(sum('readBytesPerSec')) + '/s')
      fact('write', noTotals ?? bytes(sum('writeBytesPerSec')) + '/s')
      fact('iops', noTotals ?? fixed(sum('readIops') + sum('writeIops')) + ' IOPS')
      fact('latency', disk.state === 'read' && disk.awaitMs !== null ? fixed(disk.awaitMs) + ' ms (' + disk.intervalSeconds + ' s)' : disk.state === 'idle' ? t('No disk operations in the last interval') : unavailable)
      fact('pressure', host?.psiSomeAvg10 != null ? fixed(host.psiSomeAvg10) + '% (some, 10 s)' : unavailable)
      fact('host', host?.cpuPercent != null && host.memoryUsedBytes != null && host.memoryTotalBytes != null ? fixed(host.cpuPercent) + '% CPU; ' + bytes(host.memoryUsedBytes) + ' / ' + bytes(host.memoryTotalBytes) : unavailable)
      fill('devices', disk.devices.map(device => [{ text: device.name }, { text: device.readAwaitMs === null ? '-' : fixed(device.readAwaitMs) + ' ms', numeric: true }, { text: device.writeAwaitMs === null ? '-' : fixed(device.writeAwaitMs) + ' ms', numeric: true }, { text: fixed(device.utilPercent) + '%', numeric: true }]), t('Disk latency is unavailable.'))
      const count = root.querySelector('[data-whm-metering-count]')
      if (count) count.textContent = view.unmeasuredAccounts ? t('{shown, plural, one {# account measured} other {# accounts measured}}; {missing} not yet measured.', { shown: view.accounts.length, missing: view.unmeasuredAccounts }) : t('{shown, plural, one {# account measured.} other {# accounts measured.}}', { shown: view.accounts.length })
      fill('io', view.accounts.map(row => [
        { text: row.username + ' (UID ' + row.uid + ', xpanel-' + row.uid + '.slice)' },
        { text: 'R: ' + bytes(row.readBytesPerSec) + '/s / W: ' + bytes(row.writeBytesPerSec) + '/s', numeric: true },
        { text: 'R: ' + fixed(row.readIops) + ' / W: ' + fixed(row.writeIops), numeric: true },
        { ...meter(row.memoryCurrentBytes, row.memoryLimitMb, 'MiB', 1024 * 1024), numeric: true },
        { text: fixed(row.cpuPercent) + '%', numeric: true },
        { ...meter(row.pidsCurrent, row.pidsLimit, 'PIDs', 1), numeric: true },
      ]), view.state === 'unavailable' ? t('The account resource sample is unavailable.') : t('No account has a complete sample yet.'))
      note(view.state, view.state === 'unavailable' ? t('The account resource sample is unavailable. Nothing is shown as zero.') : view.state === 'partial' ? t('Partial sample. Unmeasured accounts and host fields are shown as unavailable, not zero.') : t('Resource usage read.'))
    }
    const loadBandwidth = async (): Promise<void> => {
      const view = readWhmBandwidthView(await send('GET', '/api/server/monitoring/bandwidth'))
      limited = view.accounts.filter(row => row.limited).map(row => row.username)
      if (relief) relief.disabled = !canRelieve || !limited.length
      const SOURCE_STATES: Record<string, string> = { read: t('Counted'), partial: t('Partly counted'), unavailable: t('Not counted') }
      fact('month', view.month)
      fact('since', view.since ? formatDisplayDateTime(view.since) : unavailable)
      fact('updated', view.updatedAt ? formatDisplayDateTime(view.updatedAt) : unavailable)
      fact('pending', view.state === 'unavailable' ? unavailable : bytes(view.pendingBytes))
      for (const source of ['web', 'mail', 'ftp'] as const) { const state = view.sources[source]; fact(source, SOURCE_STATES[state.state]! + (state.since ? ' · ' + formatDisplayDateTime(state.since) : '')) }
      const statuses: Record<string, string> = { active: t('Active'), suspended: t('Suspended'), terminating: t('Terminating') }
      const amount = (totals: { receivedBytes: number; sentBytes: number } | null): string => totals ? bytes(totals.receivedBytes + totals.sentBytes) : t('Not measured')
      const enforcement = (row: BandwidthReport['accounts'][number]): string => row.limited ? t('Limit page served') : row.enforced ? t('Enforced') : t('Not enforced')
      const marks = (row: BandwidthReport['accounts'][number]): string => (row.customLimit ? '; ' + t('Custom limit') : '') + (row.reliefThrough ? '; ' + t('Relieved through {day} (UTC)', { day: row.reliefThrough }) : '')
      const limitText = (row: BandwidthReport['accounts'][number]): { text: string; level?: string } => withMarks(row, row.limitBytes === null ? { text: t('Unlimited') + (row.limited ? '; ' + t('Limit page served') : '') }
        : row.usedPercent === null ? { text: bytes(row.limitBytes) + '; ' + t('Not measured') + '; ' + enforcement(row) }
        : { text: bytes(row.limitBytes) + ' (' + fixed(row.usedPercent) + '%); ' + (row.limitState === 'over' ? t('Over limit') : row.limitState === 'near' ? t('Near limit') : t('Within limit')) + '; ' + enforcement(row), ...(row.limitState === 'over' || row.limited ? { level: 'critical' } : row.limitState === 'near' ? { level: 'warn' } : {}) })
      const withMarks = (row: BandwidthReport['accounts'][number], cell: { text: string; level?: string }): { text: string; level?: string } => ({ ...cell, text: cell.text + marks(row) })
      fill('bandwidth', view.accounts.map(row => [{ text: row.username }, { text: row.domain }, { text: statuses[row.status] ?? row.status },
        { text: amount(row.month.web), numeric: true }, { text: amount(row.month.mail), numeric: true }, { text: amount(row.month.ftp), numeric: true },
        { text: row.totalBytes === null ? t('Not measured') : bytes(row.totalBytes), numeric: true }, { ...limitText(row), numeric: true }]), t('No accounts.'))
      note(view.state, view.state === 'unavailable' ? t('Bandwidth has not been counted yet. It is counted every 5 minutes from the saved logs and journals.') : view.state === 'partial' ? t('Partial count. A source is not counted or not fully counted yet, or counting began after the month started.') : t('Bandwidth read.'))
    }
    const canReset = kind === 'bandwidth' && root.dataset.bandwidthCanReset === 'true' && typeof askDialog === 'function'
    const canRelieve = kind === 'bandwidth' && root.dataset.bandwidthCanRelieve === 'true' && typeof askDialog === 'function'
    const relief = root.querySelector<HTMLButtonElement>('[data-whm-bandwidth-relief]'), reliefStatus = root.querySelector<HTMLElement>('[data-whm-bandwidth-relief-status]')
    const customRows = root.querySelector<HTMLElement>('[data-whm-metering-rows="custom"]'), customStatus = root.querySelector<HTMLElement>('[data-whm-bandwidth-custom-status]')
    let limited: string[] = []
    const say = (node: HTMLElement | null, state: string, message: string): void => { if (!node) return; node.hidden = false; node.dataset.state = state; node.textContent = message; node.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const refusal = (error: unknown): string => {
      const failure = error as { code?: string; details?: { reason?: string } }
      return failure?.details?.reason === 'bandwidth_limit_not_custom' ? t('That account no longer has a custom bandwidth limit. Nothing was changed.')
        : failure?.details?.reason === 'bandwidth_not_limited' ? t('An account is no longer limited. Nothing was changed; read bandwidth again.')
        : failure?.code === 'FORBIDDEN' ? t('Only root may change bandwidth limits.') : t('The change was not confirmed. Read bandwidth again before retrying.')
    }
    const loadCustom = async (): Promise<void> => {
      if (!canReset || !customRows) return
      const accounts = readCustomBandwidthView(await send('GET', '/api/accounts/bandwidth/custom'))
      customRows.replaceChildren()
      const columns = customRows.closest('table')?.querySelectorAll('thead th').length ?? 1
      const mb = (value: number | 'unlimited' | null): string => value === null ? t('Not read') : value === 'unlimited' ? t('Unlimited') : value + ' MB'
      if (!accounts.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns; td.textContent = t('No account has a custom bandwidth limit.'); row.append(td); customRows.append(row) }
      for (const account of accounts) {
        const row = document.createElement('tr')
        for (const value of [account.username, account.domain, account.planName ?? t('Not read'), mb(account.customLimitMb), mb(account.packageLimitMb)]) { const td = document.createElement('td'), bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; td.append(bdi); row.append(td) }
        const cell = document.createElement('td'), reset = document.createElement('button')
        reset.type = 'button'; reset.className = root.querySelector('[data-whm-metering-refresh]')?.className ?? ''; reset.textContent = t('Reset to package limit')
        reset.addEventListener('click', () => { void (async () => {
          const ok = await askDialog!({ title: t('Reset the bandwidth limit of {username}?', { username: account.username }), body: t('The account returns to its package limit ({limit}). Usage is compared with it on the next 5-minute count.', { limit: mb(account.packageLimitMb) }), confirm: t('Reset to package limit') })
          if (ok !== true) return
          reset.disabled = true
          try { await send('POST', '/api/accounts/bandwidth/reset', { accounts: [account.accountId] }); say(customStatus, 'read', t('{username} now uses its package bandwidth limit.', { username: account.username })); await loadCustom() }
          catch (error) { say(customStatus, 'failed', refusal(error)); reset.disabled = false }
        })() })
        cell.append(reset); row.append(cell); customRows.append(row)
      }
    }
    if (relief) {
      relief.disabled = true
      relief.addEventListener('click', () => { void (async () => {
        if (!canRelieve || !limited.length) return
        const ok = await askDialog!({ title: t('Lift the limit page of {n, plural, one {# account} other {# accounts}} until 00:00 UTC?', { n: limited.length }), body: limited.join(', ') + '\n' + t('Their websites are served again today. From 00:00 UTC they are evaluated again and limited if still over their limit.'), confirm: t('Unsuspend bandwidth exceeders') })
        if (ok !== true) return
        relief.disabled = true
        try {
          const listed = (await send('GET', '/api/accounts')) as { accounts?: { id?: unknown; username?: unknown }[] }
          const ids = limited.map(username => listed.accounts?.find(account => account.username === username)?.id).filter((id): id is string => typeof id === 'string')
          if (ids.length !== limited.length) throw new Error('accounts_changed')
          const result = (await send('POST', '/api/accounts/bandwidth/relief', { accounts: ids })) as { reliefThrough?: unknown }
          say(reliefStatus, 'read', t('Limit pages lifted through {day} (UTC). Hosting verification is still required.', { day: typeof result.reliefThrough === 'string' ? result.reliefThrough : '' }))
          await load()
        } catch (error) { say(reliefStatus, 'failed', refusal(error)) }
      })() })
    }
    const loadRetention = async (): Promise<void> => {
      const view = readLogRetentionView(await send('GET', '/api/server/logs/retention'))
      const policy = (value: LogRetentionView['serverDefaults']): string => (value.archive ? t('Archived in ~/logs') : t('Deleted after counting')) + '; ' + (value.retentionDays === null ? t('kept until removed') : t('{days, plural, one {kept # day} other {kept # days}}', { days: value.retentionDays })) + (value.removePreviousMonthArchive ? '; ' + t("previous month's archives removed") : '')
      fact('defaults', policy(view.serverDefaults))
      fact('panel', t('{days, plural, one {# day} other {# days}}', { days: view.panelRotateDays }))
      const run = view.rotation.state === 'read' ? view.rotation.lastRun : null
      fact('last-run', view.rotation.state === 'unavailable' ? unavailable : run ? formatDisplayDateTime(run.at) : t('Not run yet'))
      fact('last-result', run ? t('{rotated} rotated, {archived} archived, {deleted} deleted, {removed} old archives removed, {failures} failed', { rotated: run.rotated, archived: run.archived, deleted: run.deleted, removed: run.removedArchives, failures: run.failures }) : unavailable)
      fact('held', view.rotation.state === 'read' ? t('{held} waiting, {lost} lost in the last run; kept {days, plural, one {# day} other {# days}} and {size} at most', { held: run?.held ?? 0, lost: run?.lost ?? 0, days: view.rotation.hold.days, size: bytes(view.rotation.hold.maxBytes) }) : unavailable)
      fill('pending', view.rotation.state === 'read' ? view.rotation.pending.map(item => [{ text: item.username }, { text: String(item.count), numeric: true }, { text: bytes(item.bytes), numeric: true }, { text: formatDisplayDateTime(item.oldest) }, { text: item.code + ': ' + item.reason }]) : [], view.rotation.state === 'read' ? t('No archive waits to be copied.') : t('The rotation status is unavailable.'))
      fill('retention', view.accounts.map(row => [{ text: row.username }, { text: row.domain }, { text: policy(row.settings) }, { text: row.source === 'account' ? t('Account setting') : t('Server default') }]), t('No accounts.'))
      fill('rotation-failures', view.rotation.state === 'read' ? view.rotation.failures.map(failure => [{ text: formatDisplayDateTime(failure.at) }, { text: failure.username }, { text: failure.site || '-' }, { text: failure.reason }]) : [], view.rotation.state === 'read' ? t('No rotation failures.') : t('The rotation status is unavailable.'))
      note('read', view.rotation.state === 'read' ? t('Log retention read.') : t('Log retention read; the rotation status is unavailable on this host.'))
    }
    const load = async (): Promise<void> => {
      refresh.disabled = true; root.setAttribute('aria-busy', 'true'); note('reading', kind === 'io' ? t('Reading resource usage…') : kind === 'log-retention' ? t('Reading log retention…') : t('Reading bandwidth…'))
      try {
        if (kind === 'io') await loadIo()
        else if (kind === 'log-retention') await loadRetention()
        else { await loadBandwidth(); await loadCustom() }
      }
      catch { note('failed', t('This information could not be read. No empty result is assumed.')) }
      finally { refresh.disabled = false; root.removeAttribute('aria-busy') }
    }
    refresh.addEventListener('click', () => { void load() }); void load()
  })
  // WHM Raw NGINX / Raw Apache Log Download: the web server's own logs, listed and downloaded as stored.
  document.querySelectorAll<HTMLElement>('[data-whm-raw-logs]').forEach(root => {
    if (root.dataset.rawLogsBound === 'true') return
    root.dataset.rawLogsBound = 'true'
    const server = root.querySelector<HTMLSelectElement>('[data-raw-logs-server]'), refresh = root.querySelector<HTMLButtonElement>('[data-raw-logs-refresh]')
    const rows = root.querySelector<HTMLElement>('[data-raw-logs-rows]'), status = root.querySelector<HTMLElement>('[data-raw-logs-status]')
    const say = (state: string, message: string): void => { if (!status) return; status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    if (!send || root.dataset.rawLogsCanRead !== 'true' || !server || !refresh || !rows || root.closest('[data-readonly="true"],[data-capability-state="unavailable"],fieldset:disabled')) {
      if (server) server.disabled = true; if (refresh) refresh.disabled = true
      say('unavailable', t('Raw web server logs are unavailable here. Nothing was read.')); return
    }
    const load = async (): Promise<void> => {
      refresh.disabled = true; server.disabled = true; say('reading', t('Reading the log list…'))
      try {
        const view = readRawServerLogs(await send('GET', '/api/server/logs/raw/' + server.value), server.value)
        rows.replaceChildren()
        const columns = rows.closest('table')?.querySelectorAll('thead th').length ?? 1
        if (!view.files.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns; td.textContent = view.state === 'read' ? t('No logs in this directory.') : t('The log directory could not be read.'); row.append(td); rows.append(row) }
        for (const file of view.files) {
          const row = document.createElement('tr')
          for (const [value, numeric] of [[file.name, false], [bytes(file.sizeBytes), true], [formatDisplayDateTime(file.mtime), false]] as const) { const td = document.createElement('td'), bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; if (numeric) td.dataset.numeric = ''; td.append(bdi); row.append(td) }
          const cell = document.createElement('td')
          if (file.downloadable && file.sizeBytes > 0) { const link = document.createElement('a'); link.href = '/api/server/logs/raw/' + view.server + '/' + encodeURIComponent(file.name); link.setAttribute('download', view.server + '-' + file.name); link.className = refresh.className; link.textContent = t('Download'); cell.append(link) }
          else cell.textContent = file.sizeBytes > 0 ? t('Larger than {size}; read it on the host.', { size: bytes(view.maxBytes) }) : t('Empty')
          row.append(cell); rows.append(row)
        }
        say('read', view.state === 'read' ? t('Log list read.') : t('The log directory could not be read.'))
      } catch { say('failed', t('The log list could not be read. Nothing was changed.')) }
      finally { refresh.disabled = false; server.disabled = false }
    }
    refresh.addEventListener('click', () => { void load() })
    server.addEventListener('change', () => { void load() })
  })
  // WHM Quota Modification: every visible account's disk limit in force, sorted, filtered and paged by the server, with inline edit.
  document.querySelectorAll<HTMLElement>('[data-whm-quotas]').forEach(root => {
    if (root.dataset.quotasBound === 'true') return
    root.dataset.quotasBound = 'true'
    const rows = root.querySelector<HTMLElement>('[data-quotas-rows]'), status = root.querySelector<HTMLElement>('[data-quotas-status]'), usageNote = root.querySelector<HTMLElement>('[data-quotas-usage]')
    const search = root.querySelector<HTMLInputElement>('[data-quotas-search]'), owner = root.querySelector<HTMLSelectElement>('[data-quotas-owner]'), size = root.querySelector<HTMLSelectElement>('[data-quotas-page-size]')
    const previous = root.querySelector<HTMLButtonElement>('[data-quotas-previous]'), next = root.querySelector<HTMLButtonElement>('[data-quotas-next]'), pageLabel = root.querySelector<HTMLElement>('[data-quotas-page]'), refresh = root.querySelector<HTMLButtonElement>('[data-quotas-refresh]')
    const sorters = [...root.querySelectorAll<HTMLButtonElement>('button[data-quotas-sort]')]
    const controls = [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')]
    const say = (state: string, message: string): void => { if (!status) return; status.hidden = false; status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    if (!send || root.dataset.quotasCanRead !== 'true' || !rows || !search || !owner || !size || !previous || !next || !pageLabel || !refresh || root.closest('[data-readonly="true"],[data-capability-state="unavailable"],fieldset:disabled')) {
      for (const control of controls) control.disabled = true
      say('unavailable', t('Disk quotas are unavailable here. Nothing was read.')); return
    }
    const editable = root.dataset.quotasCanEdit === 'true'
    const query = { sort: 'username', dir: 'asc' as 'asc' | 'desc', page: 1 }
    let total = 0, timer: ReturnType<typeof setTimeout> | undefined, busy = false
    const mb = (value: number | 'unlimited' | null): string => value === null ? t('Not read') : value === 'unlimited' ? t('Unlimited') : value + ' MB'
    const cell = (row: HTMLElement, lines: (string | null)[], numeric = false): HTMLTableCellElement => {
      const td = document.createElement('td')
      if (numeric) td.dataset.numeric = ''
      lines.forEach((line, index) => { if (line === null) return; const part = document.createElement(index ? 'small' : 'span'), bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = line; part.append(bdi); td.append(part) })
      row.append(td); return td
    }
    const refusal = (error: unknown): string => {
      const failure = error as { code?: string; details?: { reason?: string } }, reason = failure?.details?.reason
      return reason === 'disk_below_mailbox_quota' ? t('Not saved: a mailbox quota is larger than this disk limit.') : reason === 'disk_below_path_quota' ? t('Not saved: a domain path quota is larger than this disk limit.')
        : failure?.code === 'OVERSELL_BLOCKED' ? t('Not saved: the reseller totals do not allow these limits.') : failure?.code === 'FORBIDDEN' ? t('Not saved: you do not have permission for these limits.') : t('The change was not confirmed. Reload the account before retrying.')
    }
    const save = async (row: DiskQuotaClientRow, value: string, unlimited: boolean): Promise<void> => {
      let patch: ReturnType<typeof accountLimitsPatch>
      try { patch = accountLimitsPatch([{ name: 'diskMb', value, unlimited }]) } catch { say('failed', t('Enter whole megabytes, choose unlimited, or leave a field empty for the package value.')); return }
      busy = true; lock(); say('reading', t('Saving limits…'))
      try { await send('PATCH', '/api/accounts/' + row.accountId + '/limits', patch); say('read', t('The disk limit of {username} is saved and applied. Hosting verification is still required.', { username: row.username })); busy = false; await load() }
      catch (error) { say('failed', refusal(error)) }
      finally { busy = false; lock() }
    }
    const paint = (view: DiskQuotaClientPage): void => {
      rows.replaceChildren()
      const columns = rows.closest('table')?.querySelectorAll('thead th').length ?? 1
      if (!view.rows.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns; td.textContent = view.total ? t('No accounts on this page.') : t('No accounts match these filters.'); row.append(td); rows.append(row) }
      for (const item of view.rows) {
        const row = document.createElement('tr')
        row.dataset.quotaAccount = item.username
        cell(row, [item.username, item.domain, item.owner ? t('Owner: {owner}', { owner: item.owner }) : null]).dataset.quotaCell = 'account'
        cell(row, [item.owner ?? t('Not read')]).dataset.quotaCell = 'owner'
        cell(row, [item.usedMb === null ? t('Not read') : item.usedMb + ' MB'], true).dataset.quotaCell = 'used'
        cell(row, [mb(item.limitMb), item.source === 'account' ? t('Account limit') : t('Package: {plan}', { plan: item.planName ?? t('Not read') })], true).dataset.quotaCell = 'limit'
        const change = document.createElement('td')
        change.dataset.quotaCell = 'change'
        if (editable) {
          const input = document.createElement('input'), label = document.createElement('label'), box = document.createElement('input'), text = document.createElement('span'), apply = document.createElement('button')
          input.type = 'text'; input.inputMode = 'numeric'; input.dir = 'ltr'; input.autocomplete = 'off'; input.value = typeof item.limitMb === 'number' && item.source === 'account' ? String(item.limitMb) : ''
          input.placeholder = t('Package value'); input.setAttribute('aria-label', t('Disk limit of {username} (MB)', { username: item.username }))
          box.type = 'checkbox'; box.checked = item.source === 'account' && item.limitMb === 'unlimited'; input.disabled = box.checked; text.textContent = t('Unlimited'); label.append(box, text)
          box.addEventListener('change', () => { input.disabled = box.checked })
          apply.type = 'button'; apply.className = refresh.className; apply.textContent = t('Save')
          apply.addEventListener('click', () => { void save(item, input.value, box.checked) })
          change.append(input, label, apply)
        } else change.textContent = '—'
        row.append(change); rows.append(row)
      }
      total = view.total; query.page = view.page
      const pages = Math.max(1, Math.ceil(view.total / view.pageSize))
      pageLabel.textContent = t('Page {page} of {pages} · {total, plural, one {# account} other {# accounts}}', { page: view.page, pages, total: view.total })
      for (const button of sorters) { const th = button.closest('th'); if (th) th.setAttribute('aria-sort', button.dataset.quotasSort === view.sort ? (view.dir === 'asc' ? 'ascending' : 'descending') : 'none') }
      if (usageNote) usageNote.textContent = view.usage.state === 'read' ? t('Disk used is read from the filesystem quota report at {time}.', { time: view.usage.observedAt ? formatDisplayDateTime(view.usage.observedAt) : '' })
        : view.usage.reason === 'usage_root_only' ? t('Disk used is read by root only; it is not shown here.') : t('Disk used could not be read from the quota report. Nothing is shown as zero.')
    }
    const lock = (): void => {
      for (const control of controls) control.disabled = busy
      previous.disabled = busy || query.page <= 1
      next.disabled = busy || query.page * Number(size.value) >= total
      root.setAttribute('aria-busy', String(busy))
    }
    async function load(): Promise<void> {
      busy = true; lock(); say('reading', t('Reading disk quotas…'))
      const params = new URLSearchParams({ sort: query.sort, dir: query.dir, page: String(query.page), pageSize: size!.value })
      if (search!.value.trim()) params.set('q', search!.value.trim().toLowerCase())
      if (owner!.value) params.set('owner', owner!.value)
      try { paint(readDiskQuotaPage(await send!('GET', '/api/accounts/disk-quotas?' + params.toString()))); say('read', t('Disk quotas read.')) }
      catch { say('failed', t('Disk quotas could not be read. Nothing is shown as zero.')) }
      finally { busy = false; lock() }
    }
    for (const button of sorters) button.addEventListener('click', () => { const key = button.dataset.quotasSort ?? 'username'; query.dir = query.sort === key && query.dir === 'asc' ? 'desc' : 'asc'; query.sort = key; query.page = 1; void load() })
    previous.addEventListener('click', () => { query.page = Math.max(1, query.page - 1); void load() })
    next.addEventListener('click', () => { query.page++; void load() })
    refresh.addEventListener('click', () => { void load() })
    for (const control of [owner, size]) control.addEventListener('change', () => { query.page = 1; void load() })
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { query.page = 1; void load() }, 300) })
    void load()
  })
  // WHM Modify Account / Quota Modification / Limit Bandwidth Usage: one account's disk and bandwidth overrides.
  document.querySelectorAll<HTMLFormElement>('form[data-account-limits-form]').forEach(form => {
    if (form.dataset.limitsBound === 'true') return
    form.dataset.limitsBound = 'true'
    const status = form.querySelector<HTMLElement>('[data-account-limits-status]'), accountId = form.dataset.accountId ?? ''
    const inputs = [...form.querySelectorAll<HTMLInputElement>('input[data-account-limit]')]
    if (!send || !/^[0-9a-f-]{36}$/.test(accountId) || form.closest('[data-readonly="true"],[data-capability-state="unavailable"],fieldset:disabled')) { for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) control.disabled = true; return }
    const say = (state: string, message: string): void => { if (!status) return; status.hidden = false; status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    // Each field's unlimited choice sits in the same field wrapper as its value input.
    const unlimitedOf = (input: HTMLInputElement): HTMLInputElement | null => input.parentElement?.querySelector<HTMLInputElement>('input[data-account-limit-unlimited]') ?? null
    for (const input of inputs) unlimitedOf(input)?.addEventListener('change', event => { input.disabled = (event.currentTarget as HTMLInputElement).checked })
    form.addEventListener('submit', event => {
      event.preventDefault()
      void (async () => {
        let patch: ReturnType<typeof accountLimitsPatch>
        try { patch = accountLimitsPatch(inputs.map(input => ({ name: input.dataset.accountLimit ?? '', value: input.value, unlimited: unlimitedOf(input)?.checked === true, ...(input.dataset.accountLimitGroup ? { group: input.dataset.accountLimitGroup as 'resources' | 'caps', scale: Number(input.dataset.accountLimitScale ?? '1') } : {}) }))) }
        catch { say('failed', t('Enter whole numbers, choose unlimited, or leave a field empty for the package value.')); return }
        const resolution = form.querySelector<HTMLSelectElement>('select[data-account-limit-resolution]')?.value ?? ''
        // A chosen resolution is the WHM package conflict answer; without one the values stay on this account.
        const packageBody = resolution ? Object.fromEntries(Object.entries({ ...patch.resources, ...patch.caps }).filter(([, value]) => value !== null)) : null
        if (packageBody && !Object.keys(packageBody).length) { say('failed', t('Enter the value to change first.')); return }
        const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')
        if (submit) submit.disabled = true
        say('reading', t('Saving limits…'))
        try {
          if (packageBody) { await send('PATCH', '/api/accounts/' + accountId, { ...packageBody, resolution }); say('read', t('Saved. Reload the account to read its package and limits.')) }
          else { await send('PATCH', '/api/accounts/' + accountId + '/limits', patch); say('read', t('Limits saved and applied. Hosting verification is still required.')) }
        }
        catch (error) {
          const failure = error as { code?: string; details?: { reason?: string } }, reason = failure?.details?.reason
          say('failed', reason === 'no_matching_package' ? t('Not saved: no package matches these values.') : failure?.code === 'VALIDATION' ? t('Not saved: a value is outside the allowed range.') : reason === 'disk_below_mailbox_quota' ? t('Not saved: a mailbox quota is larger than this disk limit.') : reason === 'disk_below_path_quota' ? t('Not saved: a domain path quota is larger than this disk limit.')
            : reason === 'limits_below_php_settings' ? t('Not saved: a domain PHP setting needs more than these limits allow.') : failure?.code === 'OVERSELL_BLOCKED' ? t('Not saved: the reseller totals do not allow these limits.')
            : failure?.code === 'FORBIDDEN' ? t('Not saved: you do not have permission for these limits.') : t('The change was not confirmed. Reload the account before retrying.'))
        } finally { if (submit) submit.disabled = false }
      })()
    })
  })
}
export const WHM_METERING_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readWhmIoView=${readWhmIoView.toString()};const readWhmBandwidthView=${readWhmBandwidthView.toString()};const readCustomBandwidthView=${readCustomBandwidthView.toString()};const readLogRetentionView=${readLogRetentionView.toString()};const accountLimitsPatch=${accountLimitsPatch.toString()};const readDiskQuotaPage=${readDiskQuotaPage.toString()};const readRawServerLogs=${readRawServerLogs.toString()};return ${bindWhmMetering.toString()};})()`
