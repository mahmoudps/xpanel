/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
export type DnsToolsZoneItem = { zone: string; revision: string; records: number; minTtl: number | null; maxTtl: number | null }
export type DnsCheckJobItem = { id: string; status: string; summary: string; zones: number; createdAt: string; startedAt: string | null; finishedAt: string | null; error: string | null }
export type DnsCheckResultItem = { zone: string | null; state: string; records: number | null; errors: number | null; warnings: number | null; messages: string[] }
export type DnsCompareItem = { zone: string; saved: { stateSerial: number | null; file: string; fileSerial: number | null; ns: string[] }; live: { state: string; serial: number | null; nsState: string; ns: string[] }; drift: string[] }
export type DnsNameserverItem = { zone: string; soa: string; truncated: boolean; nameservers: { host: string; state: string; addresses: { address: string; thisServer: boolean }[]; result: string }[] }
export type DnsTtlPreviewItem = { zone: string; state: string; revision: string | null; records: number; changes: number; minTtl: number | null; maxTtl: number | null }
export type DnsToolsViews = {
  overview: { observedAt: string; zones: DnsToolsZoneItem[] }
  jobs: { jobs: DnsCheckJobItem[] }
  job: { job: DnsCheckJobItem; logAvailable: boolean; logTruncated: boolean; results: DnsCheckResultItem[] }
  compare: { observedAt: string; control: string; page: number; pages: number; total: number; zones: DnsCompareItem[] }
  nameservers: { observedAt: string; page: number; pages: number; total: number; zones: DnsNameserverItem[] }
  submit: { jobs: { id: string; status: string; zones: number }[]; zones: number; notQueued: number; incomplete: boolean }
  preview: { ttl: number; zones: DnsTtlPreviewItem[] }
  apply: { ttl: number; reconcile: string; auditIncomplete: boolean; results: { zone: string; state: string; revision: string | null; changes: number }[] }
}
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
type Ask = (options: Record<string, unknown>) => Promise<unknown>

/** Strict reader for /api/server/dns-tools responses; `expected` is the requested job id, page, or TTL change. Unknown fields are dropped. */
export function readDnsToolsView<K extends keyof DnsToolsViews>(kind: K, value: unknown, expected?: unknown): DnsToolsViews[K] {
  const bad = (): never => { throw new Error('invalid_dns_tools_' + kind) }
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const int = (item: unknown, max = Number.MAX_SAFE_INTEGER): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= max
  const nint = (item: unknown, max?: number): item is number | null => item === null || int(item, max)
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length >= 1 && item.length <= max
  const time = (item: unknown): item is string => typeof item === 'string' && item.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(item) && Number.isFinite(Date.parse(item))
  const oneOf = (item: unknown, allowed: string[]): item is string => typeof item === 'string' && allowed.includes(item)
  const zone = (item: unknown): item is string => typeof item === 'string' && item.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(item)
  const host = (item: unknown): item is string => typeof item === 'string' && item.length <= 253 && /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)*$/.test(item)
  const hosts = (item: unknown): item is string[] => Array.isArray(item) && item.length <= 64 && item.every(host)
  const uuid = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)
  const revision = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)
  const list = (item: unknown, max: number): unknown[] => Array.isArray(item) && item.length <= max ? item : bad()
  const answers = ['answered', 'nxdomain', 'no-data', 'refused', 'servfail', 'no-response', 'unavailable'], statuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled']
  const job = (item: unknown): DnsCheckJobItem => object(item) && uuid(item.id) && oneOf(item.status, statuses) && text(item.summary, 512) && int(item.zones, 32) && item.zones >= 1 && time(item.createdAt)
    && (item.startedAt === null || time(item.startedAt)) && (item.finishedAt === null || time(item.finishedAt)) && (item.error === null || text(item.error, 1024))
    ? { id: item.id, status: item.status, summary: item.summary, zones: item.zones, createdAt: item.createdAt, startedAt: item.startedAt as string | null, finishedAt: item.finishedAt as string | null, error: item.error as string | null } : bad()
  const paged = (item: Record<string, unknown>): { observedAt: string; page: number; pages: number; total: number } =>
    time(item.observedAt) && item.server === '127.0.0.1' && item.page === expected && int(item.pages, 9999) && int(item.page) && item.pages >= item.page && int(item.total) ? { observedAt: item.observedAt, page: item.page, pages: item.pages, total: item.total } : bad()
  if (!object(value)) return bad()
  if (kind === 'overview') {
    if (!time(value.observedAt)) return bad()
    return { observedAt: value.observedAt, zones: list(value.zones, 5000).map(item => object(item) && zone(item.zone) && revision(item.revision) && int(item.records) && nint(item.minTtl) && nint(item.maxTtl) && (item.minTtl === null) === (item.records === 0) && (item.maxTtl === null) === (item.records === 0)
      ? { zone: item.zone, revision: item.revision, records: item.records, minTtl: item.minTtl, maxTtl: item.maxTtl } : bad()) } as DnsToolsViews[K]
  }
  if (kind === 'jobs') return { jobs: list(value.jobs, 64).map(job) } as DnsToolsViews[K]
  if (kind === 'job') {
    const read = job(value.job)
    if (read.id !== expected || typeof value.logAvailable !== 'boolean' || typeof value.logTruncated !== 'boolean') return bad()
    const results = list(value.results, 32).map(item => {
      if (!object(item) || item.zone !== null && !zone(item.zone) || !oneOf(item.state, ['passed', 'failed', 'unavailable', 'pending', 'not-run']) || !Array.isArray(item.messages) || item.messages.length > 20 || !item.messages.every(message => text(message, 300))) return bad()
      const counted = item.state === 'passed' || item.state === 'failed'
      if (counted ? !int(item.records) || !int(item.errors) || !int(item.warnings) || (item.state === 'passed') !== (item.errors === 0) : item.records !== null || item.errors !== null || item.warnings !== null) return bad()
      return { zone: item.zone as string | null, state: item.state, records: item.records as number | null, errors: item.errors as number | null, warnings: item.warnings as number | null, messages: item.messages as string[] }
    })
    return results.length === read.zones ? { job: read, logAvailable: value.logAvailable, logTruncated: value.logTruncated, results } as DnsToolsViews[K] : bad()
  }
  if (kind === 'compare') {
    const base = paged(value)
    if (!oneOf(value.control, ['reachable', 'unreachable', 'unavailable'])) return bad()
    const flags = ['not-answered', 'file-not-parsed', 'serial-differs-from-file', 'serial-behind-saved', 'ns-not-answered', 'ns-differs']
    const zones = list(value.zones, 25).map(item => {
      if (!object(item) || !zone(item.zone) || !object(item.saved) || !object(item.live) || !Array.isArray(item.drift) || !item.drift.every(flag => oneOf(flag, flags))) return bad()
      const s = item.saved, l = item.live
      if (!nint(s.stateSerial, 4294967295) || !oneOf(s.file, ['parsed', 'missing', 'malformed', 'too-large', 'not-regular', 'unreadable', 'not-read']) || !nint(s.fileSerial, 4294967295) || (s.fileSerial === null) === (s.file === 'parsed') || !hosts(s.ns)
        || !oneOf(l.state, answers) || !nint(l.serial, 4294967295) || (l.serial === null) === (l.state === 'answered') || !oneOf(l.nsState, answers) || !hosts(l.ns)) return bad()
      return { zone: item.zone, saved: { stateSerial: s.stateSerial, file: s.file, fileSerial: s.fileSerial, ns: s.ns }, live: { state: l.state, serial: l.serial, nsState: l.nsState, ns: l.ns }, drift: item.drift as string[] }
    })
    return { ...base, control: value.control, zones } as DnsToolsViews[K]
  }
  if (kind === 'nameservers') {
    const base = paged(value)
    const results = ['answers', 'no-answer', 'other-server', 'not-resolved', 'not-local', 'unavailable', 'not-checked']
    const zones = list(value.zones, 25).map(item => object(item) && zone(item.zone) && oneOf(item.soa, answers) && typeof item.truncated === 'boolean' ? { zone: item.zone, soa: item.soa, truncated: item.truncated,
      nameservers: list(item.nameservers, 16).map(entry => object(entry) && host(entry.host) && oneOf(entry.state, answers) && oneOf(entry.result, results) ? { host: entry.host, state: entry.state, result: entry.result,
        addresses: list(entry.addresses, 32).map(address => object(address) && typeof address.address === 'string' && /^[0-9a-f.:]{2,45}$/.test(address.address) && typeof address.thisServer === 'boolean' ? { address: address.address, thisServer: address.thisServer } : bad()) } : bad()) } : bad())
    return { ...base, zones } as DnsToolsViews[K]
  }
  if (kind === 'submit') {
    if (!int(value.zones) || !int(value.notQueued) || typeof value.incomplete !== 'boolean') return bad()
    const jobs = list(value.jobs, 64).map(item => object(item) && uuid(item.id) && item.kind === 'dns.tools.check-zones' && oneOf(item.status, statuses) && int(item.zones, 32) && item.zones >= 1 ? { id: item.id, status: item.status, zones: item.zones } : bad())
    return jobs.length ? { jobs, zones: value.zones, notQueued: value.notQueued, incomplete: value.incomplete } as DnsToolsViews[K] : bad()
  }
  const change = object(expected) ? expected : {}, names = Array.isArray(change.zones) ? change.zones : []
  if (value.ttl !== change.ttl) return bad()
  if (kind === 'preview') {
    const zones = list(value.zones, 32).map((item, index) => object(item) && item.zone === names[index] && oneOf(item.state, ['ready', 'unchanged', 'not-found']) && (item.revision === null ? item.state === 'not-found' : revision(item.revision) && item.state !== 'not-found')
      && int(item.records) && int(item.changes) && item.changes <= item.records && (item.changes > 0) === (item.state === 'ready') && nint(item.minTtl) && nint(item.maxTtl)
      ? { zone: item.zone as string, state: item.state, revision: item.revision as string | null, records: item.records, changes: item.changes, minTtl: item.minTtl, maxTtl: item.maxTtl } : bad())
    return zones.length === names.length ? { ttl: value.ttl as number, zones } as DnsToolsViews[K] : bad()
  }
  if (!oneOf(value.reconcile, ['not-needed', 'requested', 'failed', 'not-connected', 'unknown']) || typeof value.auditIncomplete !== 'boolean') return bad()
  const results = list(value.results, 32).map((item, index) => {
    if (!object(item) || item.zone !== names[index] || !oneOf(item.state, ['applied', 'unchanged', 'conflict', 'not-found', 'refused', 'unknown', 'not-attempted']) || !int(item.changes)) return bad()
    // Only an applied or unchanged zone carries its saved revision.
    if (item.state === 'applied' || item.state === 'unchanged' ? !revision(item.revision) : item.revision !== null) return bad()
    return { zone: item.zone as string, state: item.state, revision: item.revision as string | null, changes: item.changes }
  })
  return results.length === names.length && (value.reconcile === 'not-needed') === !results.some(item => item.state === 'applied') ? { ttl: value.ttl as number, reconcile: value.reconcile, auditIncomplete: value.auditIncomplete, results } as DnsToolsViews[K] : bad()
}

function bindWhmDnsTools(askDialog: Ask | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-dns-tools-workspace]').forEach(root => {
    if (root.dataset.dnsToolsBound === 'true') return
    root.dataset.dnsToolsBound = 'true'
    const q = <T extends Element = HTMLElement>(selector: string): T | null => root.querySelector<T>(selector)
    const refresh = q<HTMLButtonElement>('[data-whm-dns-tools-refresh]'), ttlInput = q<HTMLInputElement>('[data-whm-dns-tools-ttl]'), search = q<HTMLInputElement>('[data-whm-dns-tools-search]')
    const link = q<HTMLAnchorElement>('[data-whm-dns-tools-job-link]'), selectedNote = q('[data-whm-dns-tools-selected]')
    const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    if (!refresh) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.dnsToolsCanRead === 'true' && !root.closest(denied) && !!request
    const manageable = (): boolean => admitted() && root.dataset.dnsToolsCanManage === 'true'
    const MAX = 32, SHOWN_MAX = 200, TTL_MAX = 2147483647
    let busy = false, overview: DnsToolsViews['overview'] | null = null, preview: DnsToolsViews['preview'] | null = null
    const pages: Record<string, { page: number; pages: number } | null> = { compare: null, nameservers: null }
    const selected = new Set<string>()
    const note = (key: string, state: string, message: string): void => { const node = q('[data-whm-dns-tools-status="' + key + '"]'); if (!node) return; node.dataset.state = state; node.textContent = message; node.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const show = (key: string, kind: string, message: string): void => { const node = q('[data-whm-dns-tools-result="' + key + '"]'); if (!node) return; node.hidden = false; node.dataset.outcome = kind; node.textContent = message; node.setAttribute('role', ['unknown', 'denied'].includes(kind) ? 'alert' : 'status') }
    const technical = (value: string): HTMLElement => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; return bdi }
    const lines = (values: string[]): HTMLElement => { const box = document.createElement('div'); for (const value of values) { const line = document.createElement('div'); line.append(technical(value)); box.append(line) } return box }
    const fact = (key: string, value: string | null): void => { const cell = q('[data-whm-dns-tools-fact="' + key + '"]'); if (cell) cell.textContent = value ?? t('Not read') }
    const utc = (value: string | null): string => value === null ? t('Not yet') : displayDateTime(value)
    const fill = (key: string, rows: (string | Node)[][], empty: string, columns: number): void => {
      const body = q('[data-whm-dns-tools-rows="' + key + '"]')
      if (!body) return
      body.textContent = ''
      for (const cells of rows) { const row = document.createElement('tr'); for (const content of cells) { const td = document.createElement('td'); td.append(content); row.append(td) } body.append(row) }
      if (!rows.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns; td.textContent = empty; row.append(td); body.append(row) }
    }
    const outcome = (error: unknown): string => {
      if (error instanceof Error && error.message.startsWith('invalid_dns_tools_')) return 'unverified'
      const problem = error && typeof error === 'object' ? error as { status?: number; code?: string; details?: Record<string, unknown> } : {}, details = problem.details && typeof problem.details === 'object' ? problem.details : {}
      if (details.unknownOutcome === true || details.verificationRequired === true && details.stateChanged !== false) return 'unknown'
      if (problem.status === 401 || problem.status === 403) return 'denied'
      if (problem.status === 412 || problem.status === 503 || problem.code === 'PRECONDITION_FAILED') return 'unavailable'
      return details.stateChanged === false ? 'refused' : 'unknown'
    }
    const failure = (kind: string, write: boolean): string => kind === 'denied' ? t('Authorization is no longer valid. Nothing was changed.')
      : kind === 'unavailable' ? t('This tool is unavailable on this server right now. Nothing was changed.')
      : kind === 'refused' ? t('The request was refused. Nothing was changed.')
      : kind === 'unverified' && !write ? t('The server returned a result that could not be verified. Nothing is shown from it.')
      : write ? t('The outcome is unknown. Review host jobs and the DNS zones before trying again.') : t('The read did not complete. Values shown are from the last successful read.')
    const confirm = async (key: string, options: Record<string, unknown>): Promise<boolean> => {
      if (!askDialog) { show(key, 'refused', t('Confirmation is unavailable; nothing was changed.')); return false }
      try { return await askDialog(options) === true } catch { return false }
    }
    const ttlValue = (): number | null => { const raw = (ttlInput?.value ?? '').trim(); return /^(?:0|[1-9][0-9]{0,9})$/.test(raw) && Number(raw) <= TTL_MAX ? Number(raw) : null }
    const previewCurrent = (): boolean => !!preview && preview.ttl === ttlValue() && preview.zones.length === selected.size && preview.zones.every(item => selected.has(item.zone))
    const controls = (): void => {
      refresh.disabled = busy || !admitted()
      for (const input of [ttlInput, search]) if (input) input.disabled = !admitted() || !manageable() && input === ttlInput
      const set = (selector: string, enabled: boolean): void => root.querySelectorAll<HTMLButtonElement>(selector).forEach(button => { button.disabled = busy || !enabled })
      set('[data-whm-dns-tools-run="check"]', manageable() && !!overview?.zones.length)
      set('[data-whm-dns-tools-load]', admitted())
      set('[data-whm-dns-tools-job]', admitted())
      for (const key of ['compare', 'nameservers']) {
        const at = pages[key]
        root.querySelectorAll<HTMLButtonElement>('[data-whm-dns-tools-page="' + key + '"]').forEach(button => { button.disabled = busy || !admitted() || !at || (button.dataset.direction === 'next' ? at.page >= at.pages : at.page <= 1) })
      }
      root.querySelectorAll<HTMLInputElement>('[data-whm-dns-tools-pick]').forEach(box => { box.disabled = busy || !manageable() || !box.checked && selected.size >= MAX })
      set('[data-whm-dns-tools-run="preview"]', manageable() && selected.size >= 1 && selected.size <= MAX && ttlValue() !== null)
      set('[data-whm-dns-tools-run="apply"]', manageable() && previewCurrent() && preview!.zones.some(item => item.state === 'ready'))
      if (selectedNote) selectedNote.textContent = t('Selected zones: {count} / {max}', { count: selected.size, max: MAX })
      root.setAttribute('aria-busy', String(busy))
    }
    const range = (min: number | null, max: number | null): string | Node => min === null || max === null ? t('No records') : technical(min === max ? String(min) : min + ' - ' + max)
    const paintZones = (): void => {
      for (const zone of [...selected]) if (!overview?.zones.some(item => item.zone === zone)) selected.delete(zone)
      const needle = (search?.value ?? '').trim().toLowerCase(), matches = (overview?.zones ?? []).filter(item => !needle || item.zone.includes(needle))
      const limited = q('[data-whm-dns-tools-limited]'); if (limited) limited.hidden = matches.length <= SHOWN_MAX
      fill('zones', matches.slice(0, SHOWN_MAX).map(item => {
        const box = document.createElement('input'); box.type = 'checkbox'; box.checked = selected.has(item.zone); box.dataset.whmDnsToolsPick = item.zone; box.setAttribute('aria-label', t('Select {name}', { name: item.zone }))
        return [box, technical(item.zone), technical(String(item.records)), range(item.minTtl, item.maxTtl)]
      }), !overview ? t('No zones have been read.') : overview.zones.length ? t('No zones match.') : t('No saved DNS zones exist.'), 4)
      controls()
    }
    const guarded = async (work: () => Promise<void>): Promise<void> => { if (busy || !admitted()) return; busy = true; controls(); try { await work() } finally { busy = false; controls() } }
    const loadOverview = (): Promise<void> => guarded(async () => {
      note('summary', 'reading', t('Reading saved zones…'))
      try {
        const next = readDnsToolsView('overview', await request!('GET', '/api/server/dns-tools'))
        if (!admitted()) return
        overview = next; fact('zones', String(next.zones.length)); fact('observed-at', utc(next.observedAt))
        note('summary', 'read', next.zones.length ? t('Saved zones read.') : t('No saved DNS zones exist, so there is nothing to check.'))
      } catch (error) { if (admitted()) note('summary', 'failed', failure(outcome(error), false)) }
      finally { paintZones() }
    })
    const statusText: Record<string, string> = { queued: t(msgctxt('whm-dns-tools-client', 'Queued')), running: t('Running'), succeeded: t('Every zone ran'), failed: t('Stopped early'), cancelled: t(msgctxt('whm-dns-tools-client', 'Cancelled')) }
    const paintJobs = (jobs: DnsCheckJobItem[]): void => fill('jobs', jobs.map(job => {
      const open = document.createElement('button'); open.type = 'button'; open.className = 'xp-btn'; open.textContent = t('Show results'); open.dataset.whmDnsToolsJob = job.id; open.setAttribute('aria-label', t('Show results of {summary}', { summary: job.summary }))
      return [technical(job.summary), technical(String(job.zones)), statusText[job.status] ?? job.status, technical(utc(job.createdAt)), technical(utc(job.finishedAt)), open]
    }), t('No DNS check jobs exist yet.'), 6)
    const loadJobs = (): Promise<void> => guarded(async () => {
      note('check', 'reading', t('Reading check jobs…'))
      try { const next = readDnsToolsView('jobs', await request!('GET', '/api/server/dns-tools/check-jobs')); if (!admitted()) return; paintJobs(next.jobs); note('check', 'read', t('Check jobs read from the host.')) }
      catch (error) { if (admitted()) note('check', 'failed', failure(outcome(error), false)) }
    })
    const checkText: Record<string, string> = { passed: t(msgctxt('whm-dns-tools-client', 'Passed')), failed: t('Errors found'), unavailable: t('Could not be verified'), pending: t('Waiting to run'), 'not-run': t(msgctxt('whm-dns-tools-client', 'Not run')) }
    const loadJob = (id: string): Promise<void> => guarded(async () => {
      note('results', 'reading', t('Reading zone results…'))
      try {
        const next = readDnsToolsView('job', await request!('GET', '/api/server/dns-tools/check-jobs/' + encodeURIComponent(id)), id)
        if (!admitted()) return
        fill('results', next.results.map((item, index) => [technical(item.zone ?? t('Zone {number}', { number: index + 1 })), checkText[item.state] ?? item.state,
          item.records === null ? '-' : technical(String(item.records)), item.errors === null ? '-' : technical(String(item.errors)), item.warnings === null ? '-' : technical(String(item.warnings)), lines(item.messages)]), t('This job checks no zones.'), 6)
        if (link) { link.href = '/whm/jobs?job=' + encodeURIComponent(id) + (document.documentElement.lang && document.documentElement.lang !== 'en' ? '&lang=' + encodeURIComponent(document.documentElement.lang) : ''); link.hidden = false }
        note('results', 'read', !next.logAvailable ? t('The job log could not be read, so zone results cannot be verified.')
          : next.logTruncated ? t('The job log reached its size limit; later zones cannot be verified.') : t('Results of {summary}', { summary: next.job.summary }))
      } catch (error) { if (admitted()) note('results', 'failed', failure(outcome(error), false)) }
    })
    const runCheck = async (): Promise<void> => {
      if (busy || !manageable() || !overview?.zones.length) return
      if (!await confirm('check', { title: t('Check all zones?'), body: t('pdnsutil check-zone runs for {count} saved zones as read-only host jobs of up to 32 zones. Nothing is changed.', { count: overview.zones.length }), confirm: t('Check all zones') }) || !manageable()) return
      await guarded(async () => {
        try {
          const ack = readDnsToolsView('submit', await request!('POST', '/api/server/dns-tools/check-jobs', {}))
          const counts = { jobs: ack.jobs.length, queued: ack.jobs.reduce((sum, job) => sum + job.zones, 0), zones: ack.zones, notQueued: ack.notQueued }
          show('check', ack.incomplete || ack.notQueued ? 'unknown' : 'submitted', ack.incomplete && ack.notQueued ? t('Check jobs queued: {jobs}, for zones: {queued} / {zones}. Some jobs may not have been queued; review host jobs.. Zones beyond the limit were not queued: {notQueued}', counts)
            : ack.incomplete ? t('Check jobs queued: {jobs}, for zones: {queued} / {zones}. Some jobs may not have been queued; review host jobs.', counts)
            : ack.notQueued ? t('Check jobs queued: {jobs}, for zones: {queued} / {zones}. Zones beyond the limit were not queued: {notQueued}', counts)
            : t('Check jobs queued: {jobs}, for zones: {queued} / {zones}', counts))
        } catch (error) { const kind = outcome(error); show('check', kind === 'unverified' ? 'unknown' : kind, failure(kind === 'unverified' ? 'unknown' : kind, true)) }
      })
      await loadJobs()
    }
    const answerText: Record<string, string> = { answered: t('Answered'), nxdomain: t('Name does not exist'), 'no-data': t('No such record'), refused: t('Refused: not served here'),
      servfail: t('Server failure'), 'no-response': t('No response'), unavailable: t('Could not be verified') }
    const fileText: Record<string, string> = { missing: t('File missing'), malformed: t('No valid SOA'), 'too-large': t('File too large'), 'not-regular': t('Not a regular file'), unreadable: t(msgctxt('whm-dns-tools-client', 'Unreadable')), 'not-read': t('Not read') }
    const driftText: Record<string, string> = { 'not-answered': t('Not answered by this server'), 'file-not-parsed': t('Zone file not usable'), 'serial-differs-from-file': t('Published serial differs from the zone file'),
      'serial-behind-saved': t('Published serial is behind the saved serial'), 'ns-not-answered': t('NS not answered'), 'ns-differs': t('Published NS differ from saved NS') }
    const pageLabel = (key: string): void => { const at = pages[key], node = q('[data-whm-dns-tools-page-label="' + key + '"]'); if (node) node.textContent = at ? t('Page {page} / {pages}', { page: at.page, pages: at.pages }) : t('Page: not read') }
    const loadCompare = (page: number): Promise<void> => guarded(async () => {
      note('compare', 'reading', t('Comparing published and saved zones…'))
      try {
        const next = readDnsToolsView('compare', await request!('GET', '/api/server/dns-tools/compare?page=' + page), page)
        if (!admitted()) return
        pages.compare = { page: next.page, pages: next.pages }; pageLabel('compare')
        fill('compare', next.zones.map(item => [technical(item.zone), item.saved.stateSerial === null ? '-' : technical(String(item.saved.stateSerial)), item.saved.fileSerial === null ? fileText[item.saved.file] ?? item.saved.file : technical(String(item.saved.fileSerial)),
          item.live.serial === null ? answerText[item.live.state] ?? item.live.state : technical(String(item.live.serial)), lines(item.saved.ns), item.live.nsState === 'answered' ? lines(item.live.ns) : answerText[item.live.nsState] ?? item.live.nsState,
          item.drift.length ? item.drift.map(flag => driftText[flag] ?? flag).join('; ') : t(msgctxt('whm-dns-tools-client', 'In sync'))]), t('No saved DNS zones exist.'), 7)
        const drifting = next.zones.filter(item => item.drift.length).length
        note('compare', 'read', (next.control === 'reachable' ? '' : t('The PowerDNS control socket did not answer.') + ' ') + t('Zones with drift on this page: {drifting} / {shown}. Saved zones: {total}', { drifting, shown: next.zones.length, total: next.total }))
      } catch (error) { if (admitted()) note('compare', 'failed', failure(outcome(error), false)) }
    })
    const nsText: Record<string, string> = { answers: t('Answers from this server'), 'no-answer': t('On this server, but the zone SOA was not answered'), 'other-server': t('Another server; not queried'),
      'not-resolved': t('Does not resolve'), 'not-local': t('Outside zones served here; not checked'), unavailable: t('Could not be verified'), 'not-checked': t('Not checked: page limit reached') }
    const loadNameservers = (page: number): Promise<void> => guarded(async () => {
      note('nameservers', 'reading', t('Checking saved nameservers…'))
      try {
        const next = readDnsToolsView('nameservers', await request!('GET', '/api/server/dns-tools/nameservers?page=' + page), page)
        if (!admitted()) return
        pages.nameservers = { page: next.page, pages: next.pages }; pageLabel('nameservers')
        fill('nameservers', next.zones.flatMap(item => item.nameservers.length ? item.nameservers.map(entry => [technical(item.zone), answerText[item.soa] ?? item.soa, technical(entry.host),
          entry.addresses.length ? lines(entry.addresses.map(address => address.thisServer ? t('{address} (this server)', { address: address.address }) : address.address)) : answerText[entry.state] ?? entry.state, nsText[entry.result] ?? entry.result])
          : [[technical(item.zone), answerText[item.soa] ?? item.soa, t('No saved apex NS records'), '-', t('Not checked')]]), t('No saved DNS zones exist.'), 5)
        const attention = next.zones.filter(item => item.nameservers.some(entry => entry.result !== 'answers') || !item.nameservers.length).length
        const counts = { attention, shown: next.zones.length }
        note('nameservers', 'read', next.zones.some(item => item.truncated) ? t('Zones with a nameserver not confirmed on this server: {attention} / {shown}. Only the first 16 nameservers of a zone are checked.', counts)
          : t('Zones with a nameserver not confirmed on this server: {attention} / {shown}', counts))
      } catch (error) { if (admitted()) note('nameservers', 'failed', failure(outcome(error), false)) }
    })
    const previewText: Record<string, string> = { ready: t('Will change'), unchanged: t('Already at this TTL'), 'not-found': t('Zone no longer saved') }
    const runPreview = (): Promise<void> => guarded(async () => {
      const ttl = ttlValue(), zones = [...selected].sort()
      if (ttl === null || !zones.length || zones.length > MAX || !manageable()) return
      preview = null
      note('ttl', 'reading', t('Previewing the TTL change…'))
      try {
        const next = readDnsToolsView('preview', await request!('POST', '/api/server/dns-tools/ttl/preview', { ttl, zones }), { ttl, zones })
        if (!admitted()) return
        preview = next
        fill('preview', next.zones.map(item => [technical(item.zone), technical(String(item.records)), technical(String(item.changes)), range(item.minTtl, item.maxTtl), previewText[item.state] ?? item.state]), t('No preview has been made.'), 5)
        const ready = next.zones.filter(item => item.state === 'ready').length
        note('ttl', 'read', ready ? t('Zones that will change: {ready}. Nothing has been written yet.', { ready }) : t('No selected zone needs a change.'))
      } catch (error) { if (admitted()) note('ttl', 'failed', failure(outcome(error), false)) }
    })
    const applyText: Record<string, string> = { applied: t('Applied and read back'), unchanged: t('Already at this TTL'), conflict: t('Changed since the preview; not written'), 'not-found': t('Zone no longer saved'),
      refused: t('Refused; not written'), unknown: t('Outcome unknown; review this zone'), 'not-attempted': t('Not attempted') }
    const reconcileText: Record<string, string> = { requested: t('Publishing to PowerDNS was requested. Use Compare to confirm the published serials.'),
      failed: t('The zones were saved, but publishing to PowerDNS failed. Review the DNS server.'), 'not-connected': t('The zones were saved, but no host agent is connected, so nothing was published.'),
      unknown: t('The zones were saved; the publishing outcome is unknown.'), 'not-needed': t('Nothing was written.') }
    const runApply = async (): Promise<void> => {
      if (busy || !manageable() || !previewCurrent()) return
      const current = preview!, zones = current.zones.filter(item => item.state === 'ready' && item.revision)
      if (!zones.length) return
      if (!await confirm('ttl', { title: t('Apply the TTL change?'), body: zones.map(item => item.zone).join('\n') + '\n' + t('TTL for every record: {ttl} seconds. Each zone is written only if unchanged since the preview.', { ttl: current.ttl }), confirm: t(msgctxt('whm-dns-tools-client', 'Apply')) }) || !manageable() || preview !== current) return
      await guarded(async () => {
        const body = { ttl: current.ttl, zones: zones.map(item => ({ zone: item.zone, expectedZoneRevision: item.revision })) }
        try {
          const result = readDnsToolsView('apply', await request!('POST', '/api/server/dns-tools/ttl/apply', body), { ttl: current.ttl, zones: zones.map(item => item.zone) })
          fill('applied', result.results.map(item => [technical(item.zone), technical(String(item.changes)), applyText[item.state] ?? item.state]), t('No change has been applied.'), 3)
          const doubtful = result.results.some(item => item.state === 'unknown') || result.reconcile === 'unknown' || result.auditIncomplete
          show('ttl', doubtful ? 'unknown' : result.results.every(item => item.state === 'applied' || item.state === 'unchanged') ? 'applied' : 'partial', t('Zones applied: {applied} / {total}.', { applied: result.results.filter(item => item.state === 'applied').length, total: result.results.length }) + ' ' + (reconcileText[result.reconcile] ?? '')
            + (result.auditIncomplete ? ' ' + t('The audit log could not record every change.') : ''))
        } catch (error) { const kind = outcome(error); show('ttl', kind === 'unverified' ? 'unknown' : kind, failure(kind === 'unverified' ? 'unknown' : kind, true)) }
        preview = null
        fill('preview', [], t('No preview has been made.'), 5)
      })
      await loadOverview()
    }
    root.addEventListener('click', event => {
      const target = (event.target as Element | null)?.closest<HTMLButtonElement>('button')
      if (!target || target.disabled || !root.contains(target)) return
      if (target.dataset.whmDnsToolsRun === 'check') void runCheck()
      else if (target.dataset.whmDnsToolsRun === 'preview') void runPreview()
      else if (target.dataset.whmDnsToolsRun === 'apply') void runApply()
      else if (target.dataset.whmDnsToolsLoad === 'jobs') void loadJobs()
      else if (target.dataset.whmDnsToolsLoad === 'compare') void loadCompare(1)
      else if (target.dataset.whmDnsToolsLoad === 'nameservers') void loadNameservers(1)
      else if (target.dataset.whmDnsToolsJob) void loadJob(target.dataset.whmDnsToolsJob)
      else if (target.dataset.whmDnsToolsPage) {
        const key = target.dataset.whmDnsToolsPage, at = pages[key]
        if (at) void (key === 'compare' ? loadCompare : loadNameservers)(at.page + (target.dataset.direction === 'next' ? 1 : -1))
      }
    })
    q('[data-whm-dns-tools-rows="zones"]')?.addEventListener('change', event => {
      const box = (event.target as Element | null)?.closest<HTMLInputElement>('[data-whm-dns-tools-pick]')
      if (!box) return
      const zone = box.dataset.whmDnsToolsPick ?? ''
      if (box.checked && selected.size < MAX) selected.add(zone); else { box.checked = false; selected.delete(zone) }
      controls()
    })
    search?.addEventListener('input', () => { if (overview) paintZones() })
    ttlInput?.addEventListener('input', controls)
    refresh.addEventListener('click', () => { void loadOverview() })
    if (!admitted()) { controls(); note('summary', 'unavailable', t('DNS tools are unavailable here. Nothing was read or changed.')); return }
    void loadOverview()
  })
}

export const WHM_DNS_TOOLS_CLIENT_BINDING = `(()=>{const displayDateTime=${DISPLAY_DATETIME_BINDING};const readDnsToolsView=${readDnsToolsView.toString()};return ${bindWhmDnsTools.toString()};})()`
