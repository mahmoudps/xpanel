/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
export type ServerHealthStateView = 'ok' | 'warning' | 'problem' | 'unavailable'
export type ServerHealthItemView = { name: string; state: ServerHealthStateView; reason: string; evidence: string }
export type ServerHealthCheckView = { id: string; state: ServerHealthStateView; reason: string; evidence: string; items: ServerHealthItemView[]; omitted: number }
type Pair = { warning: number; problem: number }
export type ServerHealthReportView = {
  observedAt: string; host: 'read' | 'unavailable'; counts: Record<ServerHealthStateView, number>; checks: ServerHealthCheckView[]
  thresholds: { loadPerCore: Pair; memoryAvailablePercent: Pair; swapUsedPercent: Pair; diskUsedPercent: Pair; inodeUsedPercent: Pair; certificateExpiryDays: number }
}
export type LimitRowView = { id: string; limit: number | 'unlimited' | null; enforced: string | null; enforcement: 'match' | 'drift' | 'unavailable'; usage: number | null; percent: number | null; usageState: 'ok' | 'high' | 'unlimited' | 'unavailable' }
export type AccountLimitsView = { username: string; status: 'active' | 'suspended' | 'terminating'; plan: string | null; slice: 'read' | 'not-active' | 'unavailable'; quota: 'read' | 'unavailable'; high: number; drift: number; unavailable: number; rows: LimitRowView[] }
export type ServerLimitsReportView = { observedAt: string; host: 'read' | 'unavailable'; highPercent: number; sample: { state: 'read' | 'unavailable'; observedAt: string | null; reason: string | null }; accounts: AccountLimitsView[]; pending: string[]; truncated: boolean }

// Serialized into the page binding by name; keep them free of outer references.
function shObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function shFail(): never { throw new Error('invalid_server_health') }
function shText(value: unknown, max: number, lines = false): string { return typeof value === 'string' && value.length <= max && value.isWellFormed() && !(lines ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/ : /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/).test(value) ? value : shFail() }
function shIso(value: unknown): string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : shFail() }
function shCount(value: unknown, max: number): number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max ? value as number : shFail() }
function shAmount(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : shFail() }
function shOneOf<T extends string>(value: unknown, allowed: readonly T[]): T { return allowed.includes(value as T) ? value as T : shFail() }

/** Strict reader for GET /api/server/server-health: fixed check order, every reason implies its state, a check with items is its worst item. */
export function readServerHealthReport(value: unknown): ServerHealthReportView {
  const CHECKS: Record<string, Record<string, ServerHealthStateView>> = {
    load: { load_ok: 'ok', load_high: 'warning', load_overloaded: 'problem', load_unread: 'unavailable', host_unavailable: 'unavailable' },
    memory: { memory_ok: 'ok', memory_low: 'warning', memory_exhausted: 'problem', memory_unread: 'unavailable', host_unavailable: 'unavailable' },
    swap: { swap_ok: 'ok', swap_none: 'ok', swap_high: 'warning', swap_exhausted: 'problem', swap_unread: 'unavailable', host_unavailable: 'unavailable' },
    'disk-space': { filesystems_ok: 'ok', filesystems_warning: 'warning', filesystems_problem: 'problem', filesystems_unread: 'unavailable', host_unavailable: 'unavailable' },
    'disk-inodes': { filesystems_ok: 'ok', no_inode_tables: 'ok', filesystems_warning: 'warning', filesystems_problem: 'problem', filesystems_unread: 'unavailable', host_unavailable: 'unavailable' },
    services: { services_ok: 'ok', services_failed: 'problem', services_partial: 'unavailable', services_unread: 'unavailable', host_unavailable: 'unavailable' },
    drift: { drift_none: 'ok', drift_found: 'problem', manifest_missing: 'problem', no_generation: 'unavailable', drift_unread: 'unavailable', host_unavailable: 'unavailable' },
    certificates: { certificates_ok: 'ok', certificates_none: 'ok', certificates_warning: 'warning', certificates_problem: 'problem', certificates_unread: 'unavailable' },
    reboot: { reboot_not_required: 'ok', reboot_required: 'warning', reboot_unread: 'unavailable', reboot_unsupported: 'unavailable', host_unavailable: 'unavailable' },
  }
  const ITEMS: Record<string, Record<string, ServerHealthStateView>> = {
    'disk-space': { space_ok: 'ok', space_high: 'warning', space_full: 'problem' }, 'disk-inodes': { inodes_ok: 'ok', inodes_high: 'warning', inodes_full: 'problem' },
    services: { service_failed: 'problem', service_unchecked: 'unavailable' }, drift: { file_missing: 'problem', file_changed: 'problem', file_metadata: 'problem' },
    certificates: { cert_expired: 'problem', cert_expiring: 'warning', cert_unread: 'unavailable' },
  }
  const rank: Record<string, number> = { problem: 0, warning: 1, unavailable: 2, ok: 3 }
  const ids = Object.keys(CHECKS)
  if (!shObject(value) || !shObject(value.thresholds) || !shObject(value.counts) || !Array.isArray(value.checks) || value.checks.length !== ids.length) return shFail()
  const pair = (raw: unknown): Pair => shObject(raw) ? { warning: shAmount(raw.warning), problem: shAmount(raw.problem) } : shFail()
  const limits = value.thresholds, counted = value.counts
  const checks = value.checks.map((raw, index): ServerHealthCheckView => {
    const id = ids[index]!
    if (!shObject(raw) || raw.id !== id || typeof raw.reason !== 'string' || !Object.hasOwn(CHECKS[id]!, raw.reason) || CHECKS[id]![raw.reason] !== raw.state) return shFail()
    const reasons = ITEMS[id]
    if ((raw.items !== undefined || raw.omitted !== undefined) && (!reasons || !Array.isArray(raw.items) || raw.items.length > 25)) return shFail()
    const items = ((raw.items as unknown[] | undefined) ?? []).map(entry => shObject(entry) && typeof entry.reason === 'string' && Object.hasOwn(reasons!, entry.reason) && reasons![entry.reason] === entry.state
      ? { name: shText(entry.name, 512), state: entry.state as ServerHealthStateView, reason: entry.reason, evidence: shText(entry.evidence, 256) } : shFail())
    const omitted = raw.omitted === undefined ? 0 : shCount(raw.omitted, 100000)
    const worst = items.reduce<string | null>((current, entry) => current === null || rank[entry.state]! < rank[current]! ? entry.state : current, null)
    if (omitted && items.length !== 25 || worst !== null && worst !== raw.state) return shFail()
    return { id, state: raw.state as ServerHealthStateView, reason: raw.reason, evidence: shText(raw.evidence, 1024), items, omitted }
  })
  const counts = { ok: 0, warning: 0, problem: 0, unavailable: 0 }
  for (const entry of checks) counts[entry.state]++
  if ((['ok', 'warning', 'problem', 'unavailable'] as const).some(state => counted[state] !== counts[state])) return shFail()
  return { observedAt: shIso(value.observedAt), host: shOneOf(value.host, ['read', 'unavailable'] as const), counts, checks,
    thresholds: { loadPerCore: pair(limits.loadPerCore), memoryAvailablePercent: pair(limits.memoryAvailablePercent), swapUsedPercent: pair(limits.swapUsedPercent), diskUsedPercent: pair(limits.diskUsedPercent), inodeUsedPercent: pair(limits.inodeUsedPercent), certificateExpiryDays: shCount(limits.certificateExpiryDays, 3650) } }
}

/** Strict reader for GET /api/server/server-limits: every resource row once, usage states implied by usage, limit and percent. */
export function readServerLimitsReport(value: unknown, requested?: readonly string[]): ServerLimitsReportView {
  const RESOURCES = ['cpu', 'memory', 'processes', 'io-read-bps', 'io-write-bps', 'io-read-iops', 'io-write-iops', 'disk']
  const username = /^[a-z][a-z0-9]{0,15}$/
  if (!shObject(value) || !shObject(value.sample) || !Array.isArray(value.accounts) || value.accounts.length > 50 || typeof value.truncated !== 'boolean'
    || !Array.isArray(value.pending) || value.pending.length > 5000 || new Set(value.pending).size !== value.pending.length || !value.pending.every(name => typeof name === 'string' && username.test(name))) return shFail()
  const highPercent = shCount(value.highPercent, 100), seen = new Set<string>()
  const accounts = value.accounts.map((raw): AccountLimitsView => {
    if (!shObject(raw) || typeof raw.username !== 'string' || !username.test(raw.username) || seen.has(raw.username) || requested && !requested.includes(raw.username) || !Array.isArray(raw.rows) || raw.rows.length !== RESOURCES.length) return shFail()
    seen.add(raw.username)
    const rows = raw.rows.map((row, index): LimitRowView => {
      if (!shObject(row) || row.id !== RESOURCES[index]) return shFail()
      const limit = row.limit === null || row.limit === 'unlimited' ? row.limit : shAmount(row.limit)
      const usage = row.usage === null ? null : shAmount(row.usage), percent = row.percent === null ? null : shAmount(row.percent)
      const usageState = shOneOf(row.usageState, ['ok', 'high', 'unlimited', 'unavailable'] as const), enforcement = shOneOf(row.enforcement, ['match', 'drift', 'unavailable'] as const)
      const expected = usage === null || limit === null ? 'unavailable' : limit === 'unlimited' ? 'unlimited' : percent === null ? null : percent >= highPercent ? 'high' : 'ok'
      if (expected !== usageState || (usageState === 'ok' || usageState === 'high') !== (percent !== null) || limit === null && enforcement !== 'unavailable') return shFail()
      return { id: RESOURCES[index]!, limit, enforced: row.enforced === null ? null : shText(row.enforced, 4096, true), enforcement, usage, percent, usageState }
    })
    const high = rows.filter(row => row.usageState === 'high').length, drift = rows.filter(row => row.enforcement === 'drift').length
    const unavailable = rows.filter(row => row.enforcement === 'unavailable' || row.usageState === 'unavailable').length
    if (raw.high !== high || raw.drift !== drift || raw.unavailable !== unavailable) return shFail()
    return { username: raw.username, status: shOneOf(raw.status, ['active', 'suspended', 'terminating'] as const), plan: raw.plan === null ? null : shText(raw.plan, 128),
      slice: shOneOf(raw.slice, ['read', 'not-active', 'unavailable'] as const), quota: shOneOf(raw.quota, ['read', 'unavailable'] as const), high, drift, unavailable, rows }
  })
  const sample = value.sample, state = shOneOf(sample.state, ['read', 'unavailable'] as const)
  if (state === 'read' ? sample.reason !== null || sample.observedAt === null : typeof sample.reason !== 'string') return shFail()
  return { observedAt: shIso(value.observedAt), host: shOneOf(value.host, ['read', 'unavailable'] as const), highPercent, accounts, pending: value.pending as string[], truncated: value.truncated,
    sample: { state, observedAt: sample.observedAt === null ? null : shIso(sample.observedAt), reason: sample.reason === null ? null : shText(sample.reason, 40) } }
}

function bindWhmServerHealth(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
  const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, value?: string, className?: string): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node }
  const technical = (value: string): HTMLElement => { const node = element('bdi', value); node.dir = 'ltr'; return node }
  const utc = (value: string | null): string => value ? formatDisplayDateTime(value) : t('Not read')
  const fixed = (value: number): string => String(Math.round(value * 10) / 10)
  const bytes = (value: number): string => value >= 1048576 ? fixed(value / 1048576) + ' MiB' : value >= 1024 ? fixed(value / 1024) + ' KiB' : String(value) + ' B'
  const evidence = (value: string): HTMLElement => { const details = element('details'), pre = element('pre', value, 'xp-whm-server-health__evidence'); pre.dir = 'ltr'; pre.tabIndex = 0; details.append(element('summary', t('Evidence')), pre); return details }
  document.querySelectorAll<HTMLElement>('[data-whm-server-health]').forEach(root => {
    if (root.dataset.serverHealthBound === 'true') return
    root.dataset.serverHealthBound = 'true'
    const kind = root.dataset.whmServerHealth
    const find = <T extends HTMLElement>(name: string): T | null => root.querySelector<T>('[data-whm-server-health-' + name + ']')
    const status = find('status'), refresh = find<HTMLButtonElement>('refresh')
    if (!status || !refresh || kind !== 'health' && kind !== 'limits') return
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.serverHealthCanRead === 'true' && !root.closest(denied)
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const fact = (name: string, value: string): void => { const node = find(name); if (node) node.textContent = value }
    if (!admitted()) {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button').forEach(control => { control.disabled = true })
      note('unavailable', kind === 'health' ? t('Server health is unavailable here. Nothing was read or changed.') : t('Resource limits are unavailable here. Nothing was read or changed.'))
      return
    }
    let busy = false
    const lockStart = (message: string): void => { busy = true; refresh.disabled = true; root.setAttribute('aria-busy', 'true'); note('reading', message) }
    const lockEnd = (): void => { busy = false; refresh.disabled = !admitted(); root.setAttribute('aria-busy', 'false') }
    const failed = (): void => note('failed', t('The read could not be completed. Any values shown are from the last successful read. Nothing was changed.'))

    if (kind === 'health') {
      const list = find('checks'), thresholds = find('thresholds')
      if (!list || !thresholds) return
      const TITLES: Record<string, string> = {
        load: msgid('Load versus processors'), memory: msgid('Available memory'), swap: msgid('Swap use'),
        'disk-space': msgid('Disk space per filesystem'), 'disk-inodes': msgid('Inodes per filesystem'), services: msgid('Failed services'),
        drift: msgid('Configuration drift'), certificates: msgid('Certificates expiring soon'), reboot: msgid('Reboot required'),
      }
      const CAUSES: Record<string, string> = {
        host_unavailable: msgid('This server could not be observed, so this check was not run.'),
        load_ok: msgid('The 5-minute load is below the warning level for the number of processors.'),
        load_high: msgid('The 5-minute load is at or above one task per processor, so processes wait for CPU time.'),
        load_overloaded: msgid('The 5-minute load is at or above twice the processors, so sites respond slowly.'),
        load_unread: msgid('The load average or processor count could not be read.'),
        memory_ok: msgid('Enough memory is available.'), memory_low: msgid('Available memory is low.'),
        memory_exhausted: msgid('Memory is nearly exhausted, so the kernel can stop processes.'), memory_unread: msgid('Memory figures could not be read.'),
        swap_ok: msgid('Swap use is below the warning level.'), swap_none: msgid('No swap is configured.'),
        swap_high: msgid('Swap use is high, which slows the server.'), swap_exhausted: msgid('Swap is nearly full.'), swap_unread: msgid('Swap figures could not be read.'),
        filesystems_ok: msgid('Every graded filesystem is below the warning level.'), filesystems_warning: msgid('At least one filesystem is above the warning level.'),
        filesystems_problem: msgid('At least one filesystem is nearly full, so writes can fail.'), filesystems_unread: msgid('Filesystem figures could not be read.'),
        no_inode_tables: msgid('No graded filesystem has a fixed inode table.'),
        space_ok: msgid('Below the warning level.'), space_high: msgid('Above the warning level.'), space_full: msgid('Nearly full.'),
        inodes_ok: msgid('Below the warning level.'), inodes_high: msgid('Above the warning level.'), inodes_full: msgid('Nearly out of inodes, so new files can fail.'),
        services_ok: msgid('No reviewed service is in the failed state.'), services_failed: msgid('At least one service has failed.'),
        services_partial: msgid('No failed service was found, but some services could not be checked.'), services_unread: msgid('Service states could not be read.'),
        service_failed: msgid('The service is in the failed state.'), service_unchecked: msgid('The service state could not be read.'),
        drift_none: msgid('Managed configuration files match the active generation.'), drift_found: msgid('Managed configuration files differ from the active generation.'),
        manifest_missing: msgid('The active generation file manifest is missing, so files cannot be compared.'), no_generation: msgid('No configuration generation is active, so there is nothing to compare.'),
        drift_unread: msgid('Configuration drift could not be read.'),
        file_missing: msgid('The file is missing.'), file_changed: msgid('The file content changed.'), file_metadata: msgid('The file owner or mode changed.'),
        certificates_ok: msgid('No saved certificate expires soon.'), certificates_none: msgid('No certificates are saved.'),
        certificates_warning: msgid('At least one saved certificate expires soon.'), certificates_problem: msgid('At least one saved certificate has expired.'),
        certificates_unread: msgid('At least one saved certificate has an unreadable expiry date.'),
        cert_expired: msgid('Expired. Visitors get a security warning.'), cert_expiring: msgid('Expires soon.'), cert_unread: msgid('The expiry date could not be read.'),
        reboot_not_required: msgid('No installed update is waiting for a reboot.'), reboot_required: msgid('An installed update takes effect only after a reboot.'),
        reboot_unread: msgid('The reboot flag could not be read.'), reboot_unsupported: msgid('This host family does not record a reboot flag. Review it on the System updates page.'),
      }
      const FIXES: Record<string, [string, string]> = {
        load: ['/whm/monitoring/processes', msgid('Review running processes')], memory: ['/whm/monitoring/processes', msgid('Review running processes')],
        swap: ['/whm/monitoring/processes', msgid('Review running processes')], 'disk-space': ['/whm/monitoring/disk', msgid('Review disk usage')],
        'disk-inodes': ['/whm/monitoring/disk', msgid('Review disk usage')], services: ['/whm/services', msgid('Open services')],
        drift: ['/whm/monitoring/repair', msgid('Review drift in the repair center')], certificates: ['/whm/ssl', msgid('Manage certificates')],
        reboot: ['/whm/software/updates', msgid('Open system updates')],
      }
      const LABELS: Record<string, string> = { ok: msgid('No problem found'), warning: msgid('Warning'), problem: msgid('Problem found'), unavailable: msgid('Not verified') }
      const badge = (state: string): HTMLElement => element('span', t(LABELS[state]!), 'xp-badge' + (state === 'ok' ? ' xp-badge--ok' : state === 'problem' ? ' xp-badge--critical' : state === 'warning' ? ' xp-badge--warn' : ''))
      const cause = (reason: string): string => { const known = CAUSES[reason]; return known ? t(known) : reason }
      const paint = (report: ServerHealthReportView): void => {
        fact('observed-at', utc(report.observedAt))
        for (const state of ['ok', 'warning', 'problem', 'unavailable'] as const) fact('count-' + state, String(report.counts[state]))
        list.replaceChildren()
        for (const check of report.checks) {
          const card = element('li', undefined, 'xp-whm-server-health__item'), head = element('div', undefined, 'xp-whm-server-health__head'), title = TITLES[check.id]!
          card.dataset.whmServerHealthCheck = check.id; card.dataset.state = check.state
          head.append(element('h3', t(title)), badge(check.state)); card.append(head, element('p', cause(check.reason)))
          const fix = FIXES[check.id]
          if (fix && check.state !== 'ok') { const link = element('a', t(fix[1]), 'xp-btn'); link.href = fix[0]; link.dataset.whmServerHealthFix = check.id; const actions = element('div', undefined, 'xp-whm-detail-actions'); actions.append(link); card.append(actions) }
          if (check.evidence) card.append(evidence(check.evidence))
          if (check.items.length) {
            const items = element('ul', undefined, 'xp-whm-server-health__items')
            for (const entry of check.items) {
              const line = element('li'), label = element('div', undefined, 'xp-whm-server-health__head')
              line.dataset.state = entry.state; label.append(technical(entry.name), badge(entry.state)); line.append(label, element('p', cause(entry.reason)))
              if (entry.evidence) line.append(evidence(entry.evidence))
              items.append(line)
            }
            card.append(items)
            if (check.omitted) card.append(element('p', t('{count} more entries are not listed. The worst results are shown first.', { count: check.omitted }), 'xp-help'))
          }
          list.append(card)
        }
        const limits = report.thresholds, rows: [string, string, string][] = [
          [t('Load per processor, 5 minutes'), '>= ' + String(limits.loadPerCore.warning), '>= ' + String(limits.loadPerCore.problem)],
          [t('Available memory'), '< ' + String(limits.memoryAvailablePercent.warning) + '%', '< ' + String(limits.memoryAvailablePercent.problem) + '%'],
          [t('Swap used'), '>= ' + String(limits.swapUsedPercent.warning) + '%', '>= ' + String(limits.swapUsedPercent.problem) + '%'],
          [t('Disk space used'), '>= ' + String(limits.diskUsedPercent.warning) + '%', '>= ' + String(limits.diskUsedPercent.problem) + '%'],
          [t('Inodes used'), '>= ' + String(limits.inodeUsedPercent.warning) + '%', '>= ' + String(limits.inodeUsedPercent.problem) + '%'],
          [t('Certificate validity left'), t('< {count} days', { count: limits.certificateExpiryDays }), t(msgctxt('whm-server-health-client', 'Expired'))],
        ]
        thresholds.replaceChildren(...rows.map(([label, warning, problem]) => { const tr = element('tr'), first = element('td', label); const second = element('td'), third = element('td'); second.dataset.numeric = ''; third.dataset.numeric = ''; second.append(technical(warning)); third.append(technical(problem)); tr.append(first, second, third); return tr }))
        const host = report.host === 'unavailable' ? ' ' + t('This server could not be observed natively, so host checks were not run.') : ''
        note(report.counts.problem ? 'problem' : report.counts.warning ? 'warning' : report.counts.unavailable ? 'partial' : 'read',
          (report.counts.problem ? t('Checks found problems. Each one links to the page that fixes it.') : report.counts.warning ? t('Checks found warnings.')
            : report.counts.unavailable ? t('No problem was found, but some checks could not be verified.') : t('No problems were found.')) + host)
      }
      const load = async (): Promise<void> => {
        if (busy || !admitted()) return
        lockStart(t('Reading server health…'))
        try { const report = readServerHealthReport(await transport!('GET', '/api/server/server-health')); if (admitted()) paint(report) } catch { if (admitted()) failed() }
        finally { lockEnd() }
      }
      refresh.addEventListener('click', () => { void load() })
      void load()
      return
    }

    const list = find('accounts'), filter = find<HTMLSelectElement>('filter'), search = find<HTMLInputElement>('search')
    if (!list || !filter || !search) return
    const NAMES: Record<string, string> = {
      cpu: msgid('CPU'), memory: msgid('Memory'), processes: msgid('Processes'), 'io-read-bps': msgctxt('whm-server-health-client', 'Disk read rate'), 'io-write-bps': msgctxt('whm-server-health-client', 'Disk write rate'),
      'io-read-iops': msgid('Disk read operations'), 'io-write-iops': msgid('Disk write operations'), disk: msgid('Disk space'),
    }
    const SAMPLE: Record<string, string> = {
      'not-sampled': msgid('The resource sampler has no sample yet.'), paused: msgid('The resource sampler is paused during a panel lifecycle operation.'),
      stale: msgid('The last resource sample is too old.'), 'configuration-changed': msgid('Accounts changed since the last resource sample.'),
      invalid: msgid('The resource sample could not be verified.'), incomplete: msgid('The resource sample is incomplete.'), 'no-accounts': msgid('There are no accounts.'),
    }
    const amount = (id: string, value: number): string => id === 'cpu' ? fixed(value) + '%' : id === 'memory' || id === 'disk' ? bytes(value) : id.endsWith('-bps') ? bytes(value) + '/s' : id.endsWith('-iops') ? fixed(value) + ' IOPS' : fixed(value)
    const rows = new Map<string, AccountLimitsView>()
    let observedAt = '', sampleAt: string | null = null, sampleReason: string | null = null, hostUnread = false, truncated = false
    const stateOf = (account: AccountLimitsView): string => account.drift ? 'drift' : account.high ? 'high' : account.unavailable ? 'unavailable' : 'ok'
    const applyFilter = (): void => {
      const wanted = filter.value, needle = search.value.trim().toLowerCase()
      let shown = 0
      list.querySelectorAll<HTMLElement>('[data-whm-server-health-account]').forEach(row => {
        const account = rows.get(row.dataset.whmServerHealthAccount ?? '')
        const match = !!account && (wanted === 'all' || wanted === 'high' && account.high > 0 || wanted === 'drift' && account.drift > 0 || wanted === 'unavailable' && account.unavailable > 0 || wanted === 'ok' && stateOf(account) === 'ok') && (!needle || account.username.includes(needle))
        row.hidden = !match; if (match) shown++
      })
      const empty = find('empty')
      if (empty) { empty.hidden = rows.size > 0 && shown > 0; empty.textContent = rows.size ? t('No account matches this filter.') : t('No accounts have been read.') }
    }
    const badge = (label: string, tone: string): HTMLElement => element('span', label, 'xp-badge' + (tone ? ' xp-badge--' + tone : ''))
    const renderAccount = (account: AccountLimitsView): HTMLElement => {
      const item = element('li', undefined, 'xp-whm-server-health__item')
      item.dataset.whmServerHealthAccount = account.username; item.dataset.state = account.drift ? 'problem' : account.high ? 'warning' : account.unavailable ? 'unavailable' : 'ok'
      const details = element('details'), summary = element('summary'), headline = element('span', undefined, 'xp-whm-server-health__head')
      const status = account.status === 'active' ? t('Active') : account.status === 'suspended' ? t(msgctxt('whm-server-health-client', 'Suspended')) : t('Being removed')
      headline.append(technical(account.username), element('span', account.plan ?? t('Plan missing')), element('span', status))
      if (account.drift) headline.append(badge(t('{count} differ from plan', { count: account.drift }), 'critical'))
      if (account.high) headline.append(badge(t('{count} at or above 90%', { count: account.high }), 'warn'))
      if (account.unavailable) headline.append(badge(t('{count} not verified', { count: account.unavailable }), ''))
      if (!account.drift && !account.high && !account.unavailable) headline.append(badge(t('Within limits'), 'ok'))
      summary.append(headline); details.append(summary)
      const notes: string[] = []
      if (account.slice === 'not-active') notes.push(t('The account has no running cgroup, so memory, processes and CPU caps were not read.'))
      if (account.slice === 'unavailable') notes.push(t('The account cgroup could not be read.'))
      if (account.quota === 'unavailable') notes.push(t('The disk quota report has no row for this account.'))
      for (const text of notes) details.append(element('p', text, 'xp-help'))
      const scroll = element('div', undefined, 'xp-whm-detail-scroll'), table = element('table', undefined, 'xp-whm-detail-table xp-table'), head = element('tr'), body = element('tbody')
      scroll.setAttribute('role', 'region'); scroll.tabIndex = 0; scroll.setAttribute('aria-label', t('Limits for {username}', { username: account.username }))
      for (const [label, numeric] of [[t('Resource'), false], [t('Plan limit'), true], [t('Enforced on the server'), false], [t('Compared with plan'), false], [t('Usage'), true], [t(msgctxt('whm-server-health-client', 'Use')), true]] as const) {
        const th = element('th', label); th.scope = 'col'; if (numeric) th.dataset.numeric = ''; head.append(th)
      }
      const ENFORCEMENT: Record<string, [string, string]> = { match: [msgid('Matches plan'), 'ok'], drift: [msgid('Differs from plan'), 'critical'], unavailable: [msgid('Not verified'), ''] }
      for (const row of account.rows) {
        const tr = element('tr'), name = NAMES[row.id]!, enforcement = ENFORCEMENT[row.enforcement]!
        tr.dataset.whmServerHealthResource = row.id; tr.dataset.usageState = row.usageState; tr.dataset.enforcement = row.enforcement
        const cells: (string | Node)[] = [t(name), row.limit === null ? t('Plan missing') : row.limit === 'unlimited' ? t('Unlimited') : technical(amount(row.id, row.limit)),
          row.enforced === null ? t('Not read') : row.enforced === '' || row.enforced === 'max' ? t('No cap') : technical(row.enforced), badge(t(enforcement[0]), enforcement[1]),
          row.usage === null ? t('Not measured') : technical(amount(row.id, row.usage)),
          row.usageState === 'high' ? badge(fixed(row.percent!) + '%', 'warn') : row.percent !== null ? technical(fixed(row.percent) + '%') : row.usageState === 'unlimited' ? t('No limit') : '-']
        cells.forEach((content, index) => { const td = element('td'); if (index === 1 || index >= 4) td.dataset.numeric = ''; td.append(content); tr.append(td) })
        body.append(tr)
      }
      const thead = element('thead'); thead.append(head); table.append(thead, body); scroll.append(table); details.append(scroll)
      if (account.drift || account.high) { const actions = element('div', undefined, 'xp-whm-detail-actions'), link = element('a', t('Review the plan limits'), 'xp-btn'); link.href = '/whm/plans'; link.dataset.whmServerHealthFix = account.username; actions.append(link); details.append(actions) }
      item.append(details)
      return item
    }
    const paint = (accounts: readonly AccountLimitsView[]): void => {
      for (const account of accounts) {
        rows.set(account.username, account)
        const next = renderAccount(account), current = list.querySelector<HTMLElement>('[data-whm-server-health-account="' + account.username + '"]')
        if (current) current.replaceWith(next); else list.append(next)
      }
      const all = [...rows.values()]
      fact('observed-at', utc(observedAt || null)); fact('sample-at', utc(sampleAt)); fact('count-accounts', String(all.length))
      fact('count-high', String(all.filter(entry => entry.high > 0).length)); fact('count-drift', String(all.filter(entry => entry.drift > 0).length))
      applyFilter()
    }
    const read = async (names?: readonly string[]): Promise<ServerLimitsReportView> => {
      const value = readServerLimitsReport(await transport!('GET', '/api/server/server-limits' + (names ? '?' + names.map(name => 'username=' + encodeURIComponent(name)).join('&') : '')), names)
      observedAt = value.observedAt; sampleAt = value.sample.observedAt; sampleReason = value.sample.state === 'read' ? null : value.sample.reason
      if (value.host === 'unavailable' && value.accounts.length) hostUnread = true
      return value
    }
    const outcome = (): void => {
      const all = [...rows.values()]
      const extra = (sampleReason ? ' ' + t('CPU and IO usage is not measured: {reason}', { reason: SAMPLE[sampleReason] ? t(SAMPLE[sampleReason]!) : sampleReason }) : '')
        + (hostUnread ? ' ' + t('This server could not be observed natively, so enforced caps were not read.') : '')
        + (truncated ? ' ' + t('Only the first 5050 accounts were read.') : '')
      if (!all.length) note('read', t('There are no accounts to read.'))
      else note(all.some(entry => entry.drift) ? 'problem' : all.some(entry => entry.high) ? 'warning' : all.some(entry => entry.unavailable) ? 'partial' : 'read',
        (all.some(entry => entry.drift) ? t('Some enforced limits differ from their plans.') : all.some(entry => entry.high) ? t('Some accounts use 90 percent or more of a limit.')
          : all.some(entry => entry.unavailable) ? t('No finding, but some values could not be verified.') : t('Every account is within its plan limits.')) + extra)
    }
    const runAll = async (): Promise<void> => {
      if (busy || !admitted()) return
      lockStart(t('Reading resource limits…')); hostUnread = false
      try {
        const first = await read()
        if (!admitted()) throw new Error('not_admitted')
        rows.clear(); list.querySelectorAll('[data-whm-server-health-account]').forEach(row => row.remove()); truncated = first.truncated
        paint(first.accounts)
        for (let index = 0; index < first.pending.length && admitted(); index += 50) {
          note('reading', t('Read {done} of {total} accounts…', { done: rows.size, total: first.accounts.length + first.pending.length }))
          paint((await read(first.pending.slice(index, index + 50))).accounts)
        }
        outcome()
      } catch { failed() }
      finally { lockEnd() }
    }
    refresh.addEventListener('click', () => { void runAll() })
    filter.addEventListener('change', applyFilter); search.addEventListener('input', applyFilter)
  })
}

export const WHM_SERVER_HEALTH_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};${[shObject, shFail, shText, shIso, shCount, shAmount, shOneOf].map(helper => helper.toString()).join(';')};const readServerHealthReport=${readServerHealthReport.toString()};const readServerLimitsReport=${readServerLimitsReport.toString()};return ${bindWhmServerHealth.toString()};})()`
