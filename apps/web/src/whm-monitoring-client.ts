import { WHM_CLIENT_TEMPLATE_BINDING, whmClientNode as canonicalWhmClientNode } from './whm-client-templates.ts'
const whmClientNode = canonicalWhmClientNode
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
type MonitoringAsk = ((options: Record<string, unknown>) => Promise<unknown>) | undefined
export type MonitoringProcess = { pid: number; ppid: number; uid: number; user: string; cpuPercent: number; memoryPercent: number; rssBytes: number; elapsedSeconds: number; startedAt: string; stat: string; comm: string; account: string | null; protection: string | null }
export type MonitoringProcessesView = { state: 'read' | 'unavailable'; observedAt: string; total: number; truncated: boolean; items: MonitoringProcess[]; accounts: { username: string; processes: number; cpuPercent: number; rssBytes: number }[] }
export type MonitoringSignalBody = { pid: number; uid: number; comm: string; startedAt: string; signal: 'TERM' | 'KILL'; killConfirmed?: true }
export type MonitoringSignalView = { state: 'confirmed' | 'attempted' | 'unknown'; commandOk: boolean; observedAt: string }
export type MonitoringDiskView = {
  observedAt: string
  filesystems: { state: 'read' | 'unavailable'; inodes: 'read' | 'unavailable'; items: { filesystem: string; type: string; mount: string; totalBytes: number; usedBytes: number; availableBytes: number; inodes: { total: number; used: number; free: number } | null }[] }
  accounts: { state: 'read' | 'unavailable'; mount: string | null; reason: string | null; items: { username: string; usedBytes: number | null; limitBytes: number | null }[] }
}
export type MonitoringLogsQuery = { unit: string; lines: number; since: string | null; priority: number | null }
export type MonitoringLogsView = { state: 'read' | 'unavailable'; observedAt: string; truncated: boolean; items: { at: string; priority: number | null; unit: string | null; pid: number | null; message: string | null; messageTruncated: boolean }[] }
type MonitoringMetric = { avg: number; max: number } | null
export type MonitoringPerformanceView = { state: 'read' | 'unavailable'; from: string; to: string; bucketSeconds: number; samples: number; truncated: boolean; points: { at: string; samples: number; values: Record<string, MonitoringMetric> }[] }

// Serialized into the page binding by name; keep them free of outer references.
function monitoringObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function monitoringText(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value) }
function monitoringIso(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) }
function monitoringCount(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max }
function monitoringNumber(value: unknown, max: number): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max }
function monitoringAccount(value: unknown): value is string { return typeof value === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(value) }

export function readProcessesView(value: unknown): MonitoringProcessesView {
  if (!monitoringObject(value) || !['read', 'unavailable'].includes(String(value.state)) || !monitoringIso(value.observedAt) || !monitoringCount(value.total, 65_536) || typeof value.truncated !== 'boolean' || !Array.isArray(value.items) || value.items.length > 4000
    || value.items.length > value.total || value.truncated !== value.total > value.items.length || !Array.isArray(value.accounts) || value.accounts.length > 10_000 || value.state === 'unavailable' && (value.items.length || value.accounts.length)) throw new Error('invalid_processes')
  const seen = new Set<number>()
  const items = value.items.map((raw): MonitoringProcess => {
    if (!monitoringObject(raw) || !monitoringCount(raw.pid, 4_194_304) || raw.pid < 1 || seen.has(raw.pid) || !monitoringCount(raw.ppid, 4_194_304) || !monitoringCount(raw.uid, 4_294_967_295) || !monitoringText(raw.user, 64) || /\s/.test(raw.user)
      || !monitoringNumber(raw.cpuPercent, 1_000_000) || !monitoringNumber(raw.memoryPercent, 100) || !monitoringCount(raw.rssBytes) || !monitoringCount(raw.elapsedSeconds) || !monitoringIso(raw.startedAt) || typeof raw.stat !== 'string' || !/^[DIRSTtWXZ<NLsl+]{1,8}$/.test(raw.stat)
      || !monitoringText(raw.comm, 64) || raw.account !== null && !monitoringAccount(raw.account) || raw.protection !== null && !['init', 'kernel', 'agent', 'root', 'panel', 'protected-command'].includes(String(raw.protection))) throw new Error('invalid_process')
    seen.add(raw.pid)
    return { pid: raw.pid, ppid: raw.ppid, uid: raw.uid, user: raw.user, cpuPercent: raw.cpuPercent, memoryPercent: raw.memoryPercent, rssBytes: raw.rssBytes, elapsedSeconds: raw.elapsedSeconds, startedAt: raw.startedAt, stat: raw.stat, comm: raw.comm, account: raw.account as string | null, protection: raw.protection as string | null }
  })
  const accounts = value.accounts.map(raw => {
    if (!monitoringObject(raw) || !monitoringAccount(raw.username) || !monitoringCount(raw.processes, 65_536) || !monitoringNumber(raw.cpuPercent, 1_000_000_000) || !monitoringCount(raw.rssBytes)) throw new Error('invalid_process_account')
    return { username: raw.username, processes: raw.processes, cpuPercent: raw.cpuPercent, rssBytes: raw.rssBytes }
  })
  return { state: value.state as 'read' | 'unavailable', observedAt: value.observedAt, total: value.total, truncated: value.truncated, items, accounts }
}

export function readSignalOutcome(value: unknown, body: MonitoringSignalBody): MonitoringSignalView {
  if (!monitoringObject(value) || !['confirmed', 'attempted', 'unknown'].includes(String(value.state)) || value.pid !== body.pid || value.signal !== body.signal || typeof value.commandOk !== 'boolean' || !monitoringIso(value.observedAt) || value.verificationRequired !== (value.state !== 'confirmed')) throw new Error('invalid_signal_outcome')
  return { state: value.state as MonitoringSignalView['state'], commandOk: value.commandOk, observedAt: value.observedAt }
}

export function readDiskView(value: unknown): MonitoringDiskView {
  if (!monitoringObject(value) || !monitoringIso(value.observedAt) || !monitoringObject(value.filesystems) || !monitoringObject(value.accounts)) throw new Error('invalid_disk')
  const fs = value.filesystems, quota = value.accounts
  if (!['read', 'unavailable'].includes(String(fs.state)) || !['read', 'unavailable'].includes(String(fs.inodes)) || !Array.isArray(fs.items) || fs.items.length > 4096 || fs.state === 'unavailable' && fs.items.length) throw new Error('invalid_filesystems')
  const items = fs.items.map(raw => {
    if (!monitoringObject(raw) || !monitoringText(raw.filesystem, 1024) || !monitoringText(raw.type, 64) || !monitoringText(raw.mount, 4096) || !raw.mount.startsWith('/') || !monitoringCount(raw.totalBytes) || !monitoringCount(raw.usedBytes) || !monitoringCount(raw.availableBytes)) throw new Error('invalid_filesystem')
    const inodes = raw.inodes
    if (inodes !== null && (!monitoringObject(inodes) || !monitoringCount(inodes.total) || !monitoringCount(inodes.used, Number(inodes.total)) || !monitoringCount(inodes.free))) throw new Error('invalid_filesystem')
    return { filesystem: raw.filesystem, type: raw.type, mount: raw.mount, totalBytes: raw.totalBytes, usedBytes: raw.usedBytes, availableBytes: raw.availableBytes, inodes: inodes === null ? null : { total: Number(inodes.total), used: Number(inodes.used), free: Number(inodes.free) } }
  })
  if (!['read', 'unavailable'].includes(String(quota.state)) || quota.source !== 'repquota' || quota.mount !== null && (!monitoringText(quota.mount, 4096) || !quota.mount.startsWith('/')) || !Array.isArray(quota.items) || quota.items.length > 10_000 || quota.state === 'unavailable' && quota.items.length
    || quota.reason !== undefined && !['quota-mount-unavailable', 'quota-report-unavailable', 'invalid-quota-report'].includes(String(quota.reason))) throw new Error('invalid_quota')
  const usage = quota.items.map(raw => {
    if (!monitoringObject(raw) || !monitoringAccount(raw.username) || raw.usedBytes !== null && !monitoringCount(raw.usedBytes) || raw.limitBytes !== null && !monitoringCount(raw.limitBytes)) throw new Error('invalid_quota_row')
    return { username: raw.username, usedBytes: raw.usedBytes as number | null, limitBytes: raw.limitBytes as number | null }
  })
  return { observedAt: value.observedAt, filesystems: { state: fs.state as 'read' | 'unavailable', inodes: fs.inodes as 'read' | 'unavailable', items }, accounts: { state: quota.state as 'read' | 'unavailable', mount: quota.mount as string | null, reason: (quota.reason as string | undefined) ?? null, items: usage } }
}

export function readLogsView(value: unknown, query: MonitoringLogsQuery): MonitoringLogsView {
  if (!monitoringObject(value) || !['read', 'unavailable'].includes(String(value.state)) || value.unit !== query.unit || value.lines !== query.lines || value.since !== query.since || value.priority !== query.priority || !monitoringIso(value.observedAt)
    || value.order !== 'newest-first' || typeof value.truncated !== 'boolean' || !Array.isArray(value.items) || value.items.length > query.lines || value.state === 'unavailable' && value.items.length) throw new Error('invalid_logs')
  const items = value.items.map(raw => {
    if (!monitoringObject(raw) || !monitoringIso(raw.at) || raw.priority !== null && !monitoringCount(raw.priority, 7) || raw.unit !== null && !monitoringText(raw.unit, 256) || raw.pid !== null && !monitoringCount(raw.pid, 4_294_967_295)
      || raw.message !== null && (typeof raw.message !== 'string' || raw.message.length > 4096 || !raw.message.isWellFormed()) || typeof raw.messageTruncated !== 'boolean') throw new Error('invalid_log_entry')
    return { at: raw.at, priority: raw.priority as number | null, unit: raw.unit as string | null, pid: raw.pid as number | null, message: raw.message as string | null, messageTruncated: raw.messageTruncated }
  })
  return { state: value.state as 'read' | 'unavailable', observedAt: value.observedAt, truncated: value.truncated, items }
}

export function readPerformanceView(value: unknown, window: '1h' | '24h' | '7d'): MonitoringPerformanceView {
  const buckets = window === '1h' ? 60 : window === '24h' ? 96 : 168, seconds = window === '1h' ? 60 : window === '24h' ? 900 : 3600
  if (!monitoringObject(value) || !['read', 'unavailable'].includes(String(value.state)) || value.scope !== 'host' || value.source !== 'metrics-history' || value.window !== window || !monitoringIso(value.from) || !monitoringIso(value.to) || value.bucketSeconds !== seconds
    || !monitoringCount(value.samples) || typeof value.truncated !== 'boolean' || !Array.isArray(value.points) || value.points.length !== (value.state === 'read' ? buckets : 0)) throw new Error('invalid_performance')
  let total = 0
  const points = value.points.map(raw => {
    if (!monitoringObject(raw) || !monitoringIso(raw.at) || !monitoringCount(raw.samples) || !monitoringObject(raw.values)) throw new Error('invalid_performance_point')
    const values: Record<string, MonitoringMetric> = {}
    for (const metric of ['cpuPercent', 'memoryMb', 'load1', 'processes', 'diskMb']) {
      const item = raw.values[metric]
      if (raw.samples === 0 ? item !== null : !monitoringObject(item) || !monitoringNumber(item.avg, Number.MAX_SAFE_INTEGER) || !monitoringNumber(item.max, Number.MAX_SAFE_INTEGER) || item.avg > item.max) throw new Error('invalid_performance_point')
      values[metric] = item === null ? null : { avg: Number((item as Record<string, unknown>).avg), max: Number((item as Record<string, unknown>).max) }
    }
    total += raw.samples
    return { at: raw.at, samples: raw.samples, values }
  })
  if (value.state === 'read' && total !== value.samples) throw new Error('invalid_performance')
  return { state: value.state as 'read' | 'unavailable', from: value.from, to: value.to, bucketSeconds: seconds, samples: value.samples, truncated: value.truncated, points }
}

function bindWhmMonitoring(askDialog: MonitoringAsk): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const bytes = (value: number): string => { const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']; let size = value, index = 0; while (size >= 1024 && index < units.length - 1) { size /= 1024; index++ } return (index ? size.toFixed(1) : String(size)) + ' ' + units[index] }
  const duration = (seconds: number): string => { const days = Math.floor(seconds / 86400), rest = seconds % 86400, pad = (part: number): string => String(part).padStart(2, '0'); return (days ? String(days) + 'd ' : '') + pad(Math.floor(rest / 3600)) + ':' + pad(Math.floor(rest % 3600 / 60)) + ':' + pad(rest % 60) }
  const percent = (part: number, whole: number): string => whole > 0 ? String(Math.ceil(part * 100 / whole)) + '%' : '-'
  const fixed = (value: number): string => String(Math.round(value * 100) / 100)
  document.querySelectorAll<HTMLElement>('[data-whm-monitoring]').forEach(root => {
    if (root.dataset.monitoringBound === 'true') return
    root.dataset.monitoringBound = 'true'
    const kind = root.dataset.whmMonitoring
    const status = root.querySelector<HTMLElement>('[data-whm-monitoring-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-whm-monitoring-refresh]')
    if (!status || !refresh) return
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.monitoringCanRead === 'true' && !root.closest(denied)
    const note = (state: string, message: string, target: HTMLElement = status): void => { target.dataset.state = state; target.textContent = message; target.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const fact = (name: string, value: string): void => { const node = root.querySelector('[data-whm-monitoring-' + name + ']'); if (node) node.textContent = value }
    const cell = (row: HTMLTableRowElement, value: string, options: { technical?: boolean; numeric?: boolean; message?: boolean } = {}): void => {
      const td = document.createElement('td'), content = document.createElement(options.technical ? 'bdi' : 'span')
      if (options.technical) content.dir = 'ltr'
      if (options.numeric) td.dataset.numeric = ''
      if (options.message) content.dataset.whmMonitoringMessage = ''
      content.textContent = value; td.append(content); row.append(td)
    }
    const placeholder = (body: HTMLElement | null, message: string): void => {
      if (!body) return
      const row = document.createElement('tr'), td = document.createElement('td')
      td.colSpan = body.closest('table')?.querySelectorAll('thead th').length ?? 1; td.textContent = message; row.append(td); body.replaceChildren(row)
    }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => !transport || !admitted() ? Promise.reject({ details: { stateChanged: false } }) : body === undefined ? transport(method, path) : transport(method, path, body)
    let busy = false
    const lock = (on: boolean): void => { busy = on; root.setAttribute('aria-busy', String(on)); refresh.disabled = on || !admitted() }
    if (!admitted()) {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true })
      note('unavailable', t('Host monitoring is unavailable here. Nothing was read or changed.'))
      return
    }

    if (kind === 'processes') {
      const rows = root.querySelector<HTMLElement>('[data-whm-monitoring-rows]'), accountRows = root.querySelector<HTMLElement>('[data-whm-monitoring-account-rows]')
      const search = root.querySelector<HTMLInputElement>('[data-whm-monitoring-search]'), account = root.querySelector<HTMLSelectElement>('[data-whm-monitoring-account]'), sort = root.querySelector<HTMLSelectElement>('[data-whm-monitoring-sort]')
      const canSignal = root.dataset.monitoringCanSignal === 'true' && typeof askDialog === 'function'
      const termAttempted = new Set<string>()
      let view: MonitoringProcessesView | null = null
      const identity = (item: MonitoringProcess): string => String(item.pid) + '@' + item.startedAt
      const protections: Record<string, string> = { init: t('Protected: init'), kernel: t('Protected: kernel thread'), agent: t('Protected: panel agent'), root: t('Protected: root process'), panel: t('Protected: panel service'), 'protected-command': t('Protected: core service') }
      const paint = (): void => {
        if (!rows || !view) return
        const query = (search?.value ?? '').trim().toLowerCase(), owner = account?.value ?? '', order = sort?.value ?? 'cpu'
        const matching = view.items.filter(item => (!query || [String(item.pid), item.user, item.comm, item.account ?? ''].some(value => value.toLowerCase().includes(query))) && (owner === '' || (owner === '-' ? item.account === null : item.account === owner)))
          .sort((left, right) => (order === 'memory' ? right.rssBytes - left.rssBytes : order === 'elapsed' ? right.elapsedSeconds - left.elapsedSeconds : order === 'pid' ? 0 : right.cpuPercent - left.cpuPercent) || left.pid - right.pid)
        const shown = matching.slice(0, 500)
        rows.replaceChildren()
        for (const item of shown) {
          const row = document.createElement('tr')
          cell(row, String(item.pid), { technical: true, numeric: true }); cell(row, item.user, { technical: true }); cell(row, item.account ?? t('Not an account'), { technical: item.account !== null })
          cell(row, fixed(item.cpuPercent), { technical: true, numeric: true }); cell(row, fixed(item.memoryPercent), { technical: true, numeric: true }); cell(row, bytes(item.rssBytes), { technical: true, numeric: true })
          cell(row, duration(item.elapsedSeconds), { technical: true, numeric: true }); cell(row, item.stat, { technical: true }); cell(row, item.comm, { technical: true })
          const action = document.createElement('td')
          if (item.protection) action.textContent = protections[item.protection] ?? t(msgctxt('whm-monitoring-client', 'Protected'))
          else if (!canSignal) action.textContent = t('Signals unavailable')
          else {
            const group = whmClientNode(root, 'whm-process-actions', 'div')
            for (const signal of termAttempted.has(identity(item)) ? ['TERM', 'KILL'] as const : ['TERM'] as const) {
              const button = whmClientNode(root, signal === 'KILL' ? 'whm-process-kill' : 'whm-process-term', 'button'); button.dataset.whmMonitoringSignal = signal; button.disabled = busy
              button.textContent = signal === 'KILL' ? t('Force stop (KILL)') : t('Stop (TERM)')
              button.addEventListener('click', () => { if (!button.disabled) void send(item, signal) }); group.append(button)
            }
            action.append(group)
          }
          row.append(action); rows.append(row)
        }
        if (!shown.length) placeholder(rows, view.state === 'read' ? t('No processes match the current filter.') : t('The host process list is unavailable.'))
        fact('shown', String(shown.length) + (matching.length > shown.length ? ' / ' + String(matching.length) : ''))
      }
      const load = async (keepNote = false): Promise<void> => {
        if (busy || !admitted()) return
        lock(true); if (!keepNote) note('reading', t('Reading the process list…'))
        try {
          const next = readProcessesView(await request('GET', '/api/server/monitoring/processes'))
          view = next; fact('observed-at', formatDisplayDateTime(next.observedAt)); fact('total', String(next.total))
          if (account) {
            const previous = account.value
            for (const option of [...account.options]) if (option.value !== '' && option.value !== '-') option.remove()
            for (const summary of next.accounts) { const option = document.createElement('option'); option.value = summary.username; option.textContent = summary.username; account.append(option) }
            account.value = [...account.options].some(option => option.value === previous) ? previous : ''
          }
          for (const control of [search, account, sort]) if (control) control.disabled = next.state !== 'read'
          if (accountRows) {
            accountRows.replaceChildren()
            for (const summary of next.accounts) { const row = document.createElement('tr'); cell(row, summary.username, { technical: true }); cell(row, String(summary.processes), { technical: true, numeric: true }); cell(row, fixed(summary.cpuPercent), { technical: true, numeric: true }); cell(row, bytes(summary.rssBytes), { technical: true, numeric: true }); accountRows.append(row) }
            if (!next.accounts.length) placeholder(accountRows, next.state === 'read' ? t('No running process belongs to a saved account.') : t('Account grouping is unavailable.'))
          }
          if (!keepNote) note(next.state === 'read' ? 'read' : 'unavailable', next.state !== 'read' ? t('The host process list is unavailable. Nothing was signalled.') : next.truncated ? t('Only the first 4000 processes were returned; more exist on the host.') : t('Process list read. Command arguments are not shown.'))
        } catch { if (!keepNote) note('failed', t('The process list could not be read. Any values shown are from the last successful read.')) }
        finally { lock(false); paint() }
      }
      const send = async (item: MonitoringProcess, signal: 'TERM' | 'KILL'): Promise<void> => {
        if (busy || !canSignal || !admitted() || !askDialog) return
        const label = item.comm + ' · PID ' + String(item.pid) + ' · ' + item.user
        let confirmed = false
        try {
          confirmed = await askDialog(signal === 'TERM'
            ? { title: t('Stop this process?'), body: label + '\n' + t('TERM asks the process to exit. The host re-reads it first and refuses if its PID, user, command or start time changed.'), confirm: t('Send TERM'), danger: true }
            : { title: t('Force stop with KILL?'), body: label + '\n' + t('TERM did not end this process. KILL cannot be caught or delayed, and unsaved work in the process is lost.'), confirm: t('Send KILL'), danger: true }) === true
        } catch { confirmed = false }
        if (!confirmed || busy || !admitted()) return
        lock(true); paint()
        const body: MonitoringSignalBody = { pid: item.pid, uid: item.uid, comm: item.comm, startedAt: item.startedAt, signal, ...(signal === 'KILL' ? { killConfirmed: true as const } : {}) }
        try {
          const outcome = readSignalOutcome(await request('POST', '/api/server/monitoring/processes/signal', body), body)
          if (outcome.state === 'confirmed') { termAttempted.delete(identity(item)); note('saved', t('PID {pid} is no longer present after {signal}.', { pid: String(item.pid), signal })) }
          else if (outcome.state === 'attempted') {
            if (signal === 'TERM') termAttempted.add(identity(item))
            note('uncertain', signal === 'TERM' ? t('TERM was sent, but the process is still present. Read again, or force stop with KILL after a separate confirmation.') : t('KILL was sent, but the process is still present. It may be waiting on the kernel; read again later.'))
          } else note('uncertain', t('The signal outcome could not be verified. No retry was sent; read the process list before acting again.'))
        } catch (error) {
          const problem = monitoringObject(error) ? error : {}, details = monitoringObject(problem.details) ? problem.details : {}
          const refused = details.stateChanged === false && details.unknownOutcome !== true && details.verificationRequired !== true
          note(refused && problem.status === 409 ? 'stale' : refused ? 'failed' : 'uncertain', refused && problem.status === 409 ? t('The process changed or exited before the signal. Nothing was sent; read the list again.') : refused ? t('The signal was refused. Nothing was sent.') : t('The signal outcome requires review. No retry was sent; read the process list before acting again.'))
        } finally { lock(false) }
        await load(true)
      }
      search?.addEventListener('input', paint); account?.addEventListener('change', paint); sort?.addEventListener('change', paint)
      refresh.addEventListener('click', () => { void load() })
      void load()
    } else if (kind === 'disk') {
      const rows = root.querySelector<HTMLElement>('[data-whm-monitoring-rows]'), quotaRows = root.querySelector<HTMLElement>('[data-whm-monitoring-quota-rows]'), quotaStatus = root.querySelector<HTMLElement>('[data-whm-monitoring-quota-status]')
      const load = async (): Promise<void> => {
        if (busy || !admitted()) return
        lock(true); note('reading', t('Reading filesystems and quota usage…'))
        try {
          const disk = readDiskView(await request('GET', '/api/server/monitoring/disk'))
          fact('observed-at', formatDisplayDateTime(disk.observedAt)); fact('inodes', disk.filesystems.inodes === 'read' ? t(msgctxt('whm-monitoring-client', 'Read')) : t(msgctxt('whm-monitoring-client', 'Unavailable')))
          if (rows) {
            rows.replaceChildren()
            for (const item of disk.filesystems.items) {
              const row = document.createElement('tr')
              cell(row, item.mount, { technical: true }); cell(row, item.filesystem, { technical: true }); cell(row, item.type, { technical: true })
              for (const size of [item.totalBytes, item.usedBytes, item.availableBytes]) cell(row, bytes(size), { technical: true, numeric: true })
              cell(row, percent(item.usedBytes, item.usedBytes + item.availableBytes), { technical: true, numeric: true })
              cell(row, item.inodes ? String(item.inodes.used) + ' / ' + String(item.inodes.total) : t(msgctxt('whm-monitoring-client', 'Not reported')), { technical: !!item.inodes, numeric: true })
              cell(row, item.inodes ? percent(item.inodes.used, item.inodes.total) : '-', { technical: true, numeric: true })
              rows.append(row)
            }
            if (!disk.filesystems.items.length) placeholder(rows, t('Filesystem usage is unavailable.'))
          }
          fact('quota-mount', disk.accounts.mount ?? t('Unavailable'))
          if (quotaRows) {
            quotaRows.replaceChildren()
            for (const item of disk.accounts.items) {
              const row = document.createElement('tr')
              cell(row, item.username, { technical: true })
              cell(row, item.usedBytes === null ? t(msgctxt('whm-monitoring-client', 'Not reported')) : bytes(item.usedBytes), { technical: item.usedBytes !== null, numeric: true })
              cell(row, item.usedBytes === null ? t(msgctxt('whm-monitoring-client', 'Not reported')) : item.limitBytes === null ? t('No limit') : bytes(item.limitBytes), { technical: item.limitBytes !== null, numeric: true })
              cell(row, item.usedBytes !== null && item.limitBytes !== null ? percent(item.usedBytes, item.limitBytes) : '-', { technical: true, numeric: true })
              quotaRows.append(row)
            }
            if (!disk.accounts.items.length) placeholder(quotaRows, disk.accounts.state === 'read' ? t('No saved accounts were found.') : t('Per-account usage is unavailable.'))
          }
          if (quotaStatus) note(disk.accounts.state === 'read' ? 'read' : 'unavailable', disk.accounts.state === 'read' ? t('Usage read from the user quota report.') : disk.accounts.reason === 'quota-mount-unavailable' ? t('The filesystem that holds /home could not be identified.') : disk.accounts.reason === 'invalid-quota-report' ? t('The quota report could not be verified.') : t('The user quota report is unavailable; quotas may not be enabled.'), quotaStatus)
          note(disk.filesystems.state === 'read' ? 'read' : 'unavailable', disk.filesystems.state === 'read' ? t('Filesystems read.') : t('Filesystem usage is unavailable on this host.'))
        } catch { note('failed', t('Disk usage could not be read. Any values shown are from the last successful read.')) }
        finally { lock(false) }
      }
      refresh.addEventListener('click', () => { void load() })
      void load()
    } else if (kind === 'logs') {
      const rows = root.querySelector<HTMLElement>('[data-whm-monitoring-rows]'), unit = root.querySelector<HTMLSelectElement>('[data-whm-monitoring-unit]'), lines = root.querySelector<HTMLInputElement>('[data-whm-monitoring-lines]')
      const since = root.querySelector<HTMLInputElement>('[data-whm-monitoring-since]'), priority = root.querySelector<HTMLSelectElement>('[data-whm-monitoring-priority]')
      const load = async (): Promise<void> => {
        if (busy || !admitted() || !unit || !lines || !since || !priority) return
        const count = lines.value.trim()
        if (!/^[1-9][0-9]{0,2}$/.test(count) || Number(count) > 500) { note('failed', t('Enter 1 to 500 entries. Nothing was read.')); return }
        let sinceIso: string | null = null
        if (since.value) {
          const ms = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(since.value) ? Date.parse(since.value + 'Z') : Number.NaN
          if (!Number.isFinite(ms)) { note('failed', t('Enter a valid UTC start time. Nothing was read.')); return }
          sinceIso = new Date(Math.floor(ms / 1000) * 1000).toISOString()
        }
        const query: MonitoringLogsQuery = { unit: unit.value, lines: Number(count), since: sinceIso, priority: priority.value === '' ? null : Number(priority.value) }
        const params = new URLSearchParams({ unit: query.unit, lines: String(query.lines) })
        if (query.since !== null) params.set('since', query.since)
        if (query.priority !== null) params.set('priority', String(query.priority))
        lock(true); note('reading', t('Reading journal entries…'))
        try {
          const logs = readLogsView(await request('GET', '/api/server/monitoring/logs?' + params.toString()), query)
          fact('observed-at', formatDisplayDateTime(logs.observedAt)); fact('shown', String(logs.items.length))
          if (rows) {
            rows.replaceChildren()
            for (const item of logs.items) {
              const row = document.createElement('tr')
              cell(row, formatDisplayDateTime(item.at), { technical: true }); cell(row, item.priority === null ? '-' : String(item.priority), { technical: true, numeric: true }); cell(row, item.unit ?? '-', { technical: true }); cell(row, item.pid === null ? '-' : String(item.pid), { technical: true, numeric: true })
              cell(row, item.message === null ? t('No message was recorded, or it exceeds 4096 bytes.') : item.messageTruncated ? t('{message} [truncated at 4 KiB]', { message: item.message }) : item.message, { technical: item.message !== null, message: true })
              rows.append(row)
            }
            if (!logs.items.length) placeholder(rows, logs.state === 'read' ? t('No journal entries matched this read.') : t('The journal is unavailable for this read.'))
          }
          note(logs.state === 'read' ? 'read' : 'unavailable', logs.state !== 'read' ? t('The journal could not be read on this host.') : logs.truncated ? t('Entries read, newest first. The 1 MiB response limit was reached; older entries are not shown.') : t('Entries read, newest first.'))
        } catch { note('failed', t('The journal could not be read. Any values shown are from the last successful read.')) }
        finally { lock(false) }
      }
      refresh.addEventListener('click', () => { void load() })
    } else if (kind === 'performance') {
      const select = root.querySelector<HTMLSelectElement>('[data-whm-monitoring-window]'), summary = root.querySelector<HTMLElement>('[data-whm-monitoring-summary-rows]')
      const metrics = ['cpuPercent', 'memoryMb', 'load1', 'processes', 'diskMb']
      const draw = (figure: HTMLElement, history: MonitoringPerformanceView, metric: string): void => {
        figure.querySelector('svg')?.remove()
        const state = figure.querySelector<HTMLElement>('[data-whm-monitoring-chart-state]'), values = history.points.map(point => point.values[metric] ?? null)
        const top = Math.max(0, ...values.map(value => value ? value.avg : 0)), peak = Math.max(0, ...values.map(value => value ? value.max : 0))
        if (!values.some(Boolean)) { if (state) state.textContent = t('No recorded samples in this window.'); return }
        const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), title = document.createElementNS(ns, 'title')
        svg.setAttribute('viewBox', '0 0 600 120'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('role', 'img'); svg.setAttribute('direction', 'ltr')
        title.textContent = t('{chart}: peak {peak}', { chart: figure.querySelector('figcaption')?.textContent ?? metric, peak: fixed(peak) }); svg.append(title)
        const step = 600 / Math.max(1, values.length - 1), scale = top > 0 ? top : 1
        let segment: string[] = []
        const flush = (): void => {
          if (segment.length === 1) { const [x, y] = segment[0]!.split(','), dot = document.createElementNS(ns, 'circle'); dot.setAttribute('cx', x!); dot.setAttribute('cy', y!); dot.setAttribute('r', '3'); dot.setAttribute('fill', 'currentColor'); svg.append(dot) }
          else if (segment.length) { const line = document.createElementNS(ns, 'polyline'); line.setAttribute('points', segment.join(' ')); line.setAttribute('fill', 'none'); line.setAttribute('stroke', 'currentColor'); line.setAttribute('stroke-width', '2'); line.setAttribute('vector-effect', 'non-scaling-stroke'); svg.append(line) }
          segment = []
        }
        values.forEach((value, index) => { if (!value) flush(); else segment.push((index * step).toFixed(1) + ',' + (116 - value.avg / scale * 112).toFixed(1)) })
        flush(); figure.append(svg)
        if (state) state.textContent = t('Average per interval. Peak sample: {peak}', { peak: fixed(peak) })
      }
      const load = async (): Promise<void> => {
        const range = select?.value
        if (busy || !admitted() || (range !== '1h' && range !== '24h' && range !== '7d')) return
        lock(true); if (select) select.disabled = true; note('reading', t('Reading recorded host samples…'))
        try {
          const history = readPerformanceView(await request('GET', '/api/server/monitoring/performance?window=' + range), range)
          fact('observed-range', formatDisplayDateTime(history.from) + ' / ' + formatDisplayDateTime(history.to)); fact('samples', String(history.samples)); fact('bucket', String(history.bucketSeconds))
          root.querySelectorAll<HTMLElement>('[data-whm-monitoring-chart]').forEach(figure => draw(figure, history, figure.dataset.whmMonitoringChart ?? ''))
          if (summary) {
            summary.replaceChildren()
            for (const metric of metrics) {
              const row = document.createElement('tr'), filled = history.points.filter(point => point.values[metric])
              const latest = filled.at(-1)?.values[metric], weight = filled.reduce((sum, point) => sum + point.samples, 0)
              cell(row, root.querySelector('[data-whm-monitoring-chart="' + metric + '"] figcaption')?.textContent ?? metric)
              if (!latest || !weight) { cell(row, t('No samples')); cell(row, '-', { technical: true, numeric: true }); cell(row, '-', { technical: true, numeric: true }) }
              else {
                cell(row, fixed(latest.avg), { technical: true, numeric: true })
                cell(row, fixed(filled.reduce((sum, point) => sum + point.values[metric]!.avg * point.samples, 0) / weight), { technical: true, numeric: true })
                cell(row, fixed(Math.max(...filled.map(point => point.values[metric]!.max))), { technical: true, numeric: true })
              }
              summary.append(row)
            }
          }
          note(history.state !== 'read' ? 'unavailable' : history.samples ? 'read' : 'empty', history.state !== 'read' ? t('Recorded performance history is unavailable.') : !history.samples ? t('No host samples were recorded in this window. Nothing is shown as zero.') : history.truncated ? t('Only the newest 20160 samples were read; older intervals may be missing.') : t('History read. Values are recorded host samples averaged per interval.'))
        } catch { note('failed', t('Performance history could not be read. Any values shown are from the last successful read.')) }
        finally { lock(false); if (select) select.disabled = !admitted() }
      }
      select?.addEventListener('change', () => { void load() })
      refresh.addEventListener('click', () => { void load() })
      void load()
    }
  })
}

export const WHM_MONITORING_CLIENT_BINDING = `(()=>{${WHM_CLIENT_TEMPLATE_BINDING}const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};${[monitoringObject, monitoringText, monitoringIso, monitoringCount, monitoringNumber, monitoringAccount].map(helper => helper.toString()).join(';')};const readProcessesView=${readProcessesView.toString()};const readSignalOutcome=${readSignalOutcome.toString()};const readDiskView=${readDiskView.toString()};const readLogsView=${readLogsView.toString()};const readPerformanceView=${readPerformanceView.toString()};return ${bindWhmMonitoring.toString()};})()`
