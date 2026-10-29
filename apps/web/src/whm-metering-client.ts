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
    if (!object(v) || typeof v.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(v.username) || typeof v.domain !== 'string' || typeof v.status !== 'string' || !object(v.month) || !['within', 'near', 'over', 'unlimited', 'unmeasured'].includes(String(v.limitState)) || typeof v.enforced !== 'boolean' || typeof v.limited !== 'boolean') return bad()
    const month = v.month
    for (const source of sources) { const totals = month[source]; if (totals !== null && (!object(totals) || !count(totals.count) || !count(totals.receivedBytes) || !count(totals.sentBytes))) return bad() }
    if (v.totalBytes !== null && !count(v.totalBytes) || v.limitBytes !== null && !count(v.limitBytes) || v.usedPercent !== null && !(typeof v.usedPercent === 'number' && v.usedPercent >= 0)) return bad()
    if ((v.totalBytes === null) !== sources.every(source => month[source] === null)) return bad()
  }
  return raw as unknown as BandwidthReport
}

function bindWhmMetering(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
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
      const SOURCE_STATES: Record<string, string> = { read: t('Counted'), partial: t('Partly counted'), unavailable: t('Not counted') }
      fact('month', view.month)
      fact('since', view.since ? formatDisplayDateTime(view.since) : unavailable)
      fact('updated', view.updatedAt ? formatDisplayDateTime(view.updatedAt) : unavailable)
      fact('pending', view.state === 'unavailable' ? unavailable : bytes(view.pendingBytes))
      for (const source of ['web', 'mail', 'ftp'] as const) { const state = view.sources[source]; fact(source, SOURCE_STATES[state.state]! + (state.since ? ' · ' + formatDisplayDateTime(state.since) : '')) }
      const statuses: Record<string, string> = { active: t('Active'), suspended: t('Suspended'), terminating: t('Terminating') }
      const amount = (totals: { receivedBytes: number; sentBytes: number } | null): string => totals ? bytes(totals.receivedBytes + totals.sentBytes) : t('Not measured')
      const enforcement = (row: BandwidthReport['accounts'][number]): string => row.limited ? t('Limit page served') : row.enforced ? t('Enforced') : t('Not enforced')
      const limitText = (row: BandwidthReport['accounts'][number]): { text: string; level?: string } => row.limitBytes === null ? { text: t('Unlimited') + (row.limited ? '; ' + t('Limit page served') : '') }
        : row.usedPercent === null ? { text: bytes(row.limitBytes) + '; ' + t('Not measured') + '; ' + enforcement(row) }
        : { text: bytes(row.limitBytes) + ' (' + fixed(row.usedPercent) + '%); ' + (row.limitState === 'over' ? t('Over limit') : row.limitState === 'near' ? t('Near limit') : t('Within limit')) + '; ' + enforcement(row), ...(row.limitState === 'over' || row.limited ? { level: 'critical' } : row.limitState === 'near' ? { level: 'warn' } : {}) }
      fill('bandwidth', view.accounts.map(row => [{ text: row.username }, { text: row.domain }, { text: statuses[row.status] ?? row.status },
        { text: amount(row.month.web), numeric: true }, { text: amount(row.month.mail), numeric: true }, { text: amount(row.month.ftp), numeric: true },
        { text: row.totalBytes === null ? t('Not measured') : bytes(row.totalBytes), numeric: true }, { ...limitText(row), numeric: true }]), t('No accounts.'))
      note(view.state, view.state === 'unavailable' ? t('Bandwidth has not been counted yet. It is counted every 5 minutes from the saved logs and journals.') : view.state === 'partial' ? t('Partial count. A source is not counted or not fully counted yet, or counting began after the month started.') : t('Bandwidth read.'))
    }
    const load = async (): Promise<void> => {
      refresh.disabled = true; root.setAttribute('aria-busy', 'true'); note('reading', kind === 'io' ? t('Reading resource usage…') : t('Reading bandwidth…'))
      try { await (kind === 'io' ? loadIo() : loadBandwidth()) }
      catch { note('failed', t('This information could not be read. No empty result is assumed.')) }
      finally { refresh.disabled = false; root.removeAttribute('aria-busy') }
    }
    refresh.addEventListener('click', () => { void load() }); void load()
  })
}
export const WHM_METERING_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readWhmIoView=${readWhmIoView.toString()};const readWhmBandwidthView=${readWhmBandwidthView.toString()};return ${bindWhmMetering.toString()};})()`
