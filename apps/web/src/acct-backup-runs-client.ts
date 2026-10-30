/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
const formatDisplayDateTime = sharedFormatDisplayDateTime

export interface WhmBackupRunEntry { username: string; destinationId: string; file: string | null; bytes: number | null; sha256: string | null; outcome: 'verified' | 'failed' | 'unknown'; reason: string | null }
/** The local archive of one account (or the `_control` snapshot) in a run: verified only after a complete integrity read on the server. */
export interface WhmBackupRunArchive { username: string; file: string | null; bytes: number | null; sha256: string | null; databases: string[]; zones: string[]; integrity: 'verified' | 'failed'; reason: string | null; detail: string | null }
export interface WhmBackupRun {
  id: string; trigger: 'schedule' | 'manual' | 'account'; startedAt: string; finishedAt: string | null; state: 'running' | 'succeeded' | 'failed' | 'unknown'; accounts: number; destinationIds: string[]
  mailIncluded: boolean; databasesIncluded: boolean; dnsIncluded: boolean; archives: WhmBackupRunArchive[]; control: WhmBackupRunArchive | null; entries: WhmBackupRunEntry[]
  retention: { destinationId: string; deleted: number; outcome: string }[]; localDeleted: number | null
}
export interface WhmBackupPartRestore { id: string; username: string; file: string; startedAt: string; finishedAt: string | null; state: 'running' | 'finished' | 'unknown'; items: { part: 'database' | 'dns'; name: string; result: 'restored' | 'failed' | 'not-attempted'; reason: string | null }[] }
export interface WhmBackupRecovery { id: string; destinationId: string; username: string; file: string; startedAt: string; state: 'running' | 'recovered' | 'failed' | 'unknown'; reason: string | null }
export interface WhmBackupRunsView {
  available: boolean; reason: string | null; revision: string; schedule: { enabled: boolean; cron: string; nextRunAt: string | null; lastScheduledAt: string | null } | null
  storage: { freeBytes: number; totalBytes: number } | null
  activeId: string | null; runs: WhmBackupRun[]; recoveries: WhmBackupRecovery[]; restores: WhmBackupPartRestore[]
}
export interface WhmBackupRetentionPlan { destinationId: string; planDigest: string; rows: { name: string; username: string; createdAt: string; bytes: number; action: 'keep' | 'delete'; reason: string }[] }

/** Strict reader for GET /api/backups/workspace/runs (apps/agent/src/acct-backup-plan.ts readBackupRunsView). */
export function readWhmBackupRunsView(raw: unknown): WhmBackupRunsView {
  const bad = (): never => { throw new Error('invalid_backup_runs') }
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const uuid = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : bad()
  const stamp = (value: unknown, nullable = false): string | null => nullable && value === null ? null : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ? value : bad()
  const archive = (username: unknown, file: unknown): boolean => typeof username === 'string' && typeof file === 'string' && (username === '_control'
    ? /^xpanel-control-[0-9]{8}T[0-9]{6}Z(?:-[a-f0-9]{12})?\.tar\.gz$/.test(file)
    : /^[a-z][a-z0-9]{0,15}$/.test(username) && file.startsWith('xpanel-backup-' + username + '-') && /^xpanel-backup-[a-z][a-z0-9]{0,15}-[0-9]{8}T[0-9]{6}Z(?:-[a-f0-9]{12})?\.tar\.gz$/.test(file))
  const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : bad()
  const database = (username: string, value: unknown): string => typeof value === 'string' && /^[a-z][a-z0-9]{0,15}_[a-z0-9_]{1,47}$/.test(value) && value.startsWith(username + '_') ? value : bad()
  const zone = (value: unknown): string => typeof value === 'string' && value.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(value) ? value : bad()
  if (!object(raw) || typeof raw.available !== 'boolean' || raw.nativeQualified !== false || typeof raw.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.revision) || !Array.isArray(raw.runs) || raw.runs.length > 30 || !Array.isArray(raw.recoveries) || raw.recoveries.length > 30 || !Array.isArray(raw.restores) || raw.restores.length > 30
    || !(raw.reason === null || ['no_executor', 'no_provider', 'no_schedule', 'no_destination', 'invalid_configuration', 'invalid_ledger'].includes(raw.reason as string)) || raw.available !== (raw.reason === null)) return bad()
  let schedule: WhmBackupRunsView['schedule'] = null
  if (raw.schedule !== null) {
    if (!object(raw.schedule) || typeof raw.schedule.enabled !== 'boolean' || typeof raw.schedule.cron !== 'string' || !/^[0-9*,/ -]{1,100}$/.test(raw.schedule.cron)) return bad()
    schedule = { enabled: raw.schedule.enabled, cron: raw.schedule.cron, nextRunAt: stamp(raw.schedule.nextRunAt, true), lastScheduledAt: stamp(raw.schedule.lastScheduledAt, true) }
  }
  const storage = raw.storage === null ? null : object(raw.storage) && count(raw.storage.freeBytes) <= count(raw.storage.totalBytes) ? { freeBytes: raw.storage.freeBytes as number, totalBytes: raw.storage.totalBytes as number } : bad()
  const archiveOf = (entry: unknown): WhmBackupRunArchive => {
    if (!object(entry) || typeof entry.username !== 'string' || !(entry.file === null || archive(entry.username, entry.file)) || !['verified', 'failed'].includes(entry.integrity as string) || !Array.isArray(entry.databases) || entry.databases.length > 1000 || !Array.isArray(entry.zones) || entry.zones.length > 1000
      || !(entry.sha256 === null || typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256)) || !(entry.bytes === null || count(entry.bytes) >= 0) || (entry.integrity === 'verified') !== (entry.reason === null) || !(entry.reason === null || ['backup_failed', 'integrity_failed'].includes(entry.reason as string))
      || !(entry.detail === null || typeof entry.detail === 'string' && entry.detail.length <= 500 && entry.integrity === 'failed')) return bad()
    return { username: entry.username, file: entry.file as string | null, bytes: entry.bytes as number | null, sha256: entry.sha256 as string | null, databases: entry.databases.map(name => database(entry.username as string, name)), zones: entry.zones.map(zone),
      integrity: entry.integrity as WhmBackupRunArchive['integrity'], reason: entry.reason as string | null, detail: entry.detail as string | null }
  }
  const runs = raw.runs.map((item): WhmBackupRun => {
    if (!object(item) || !['schedule', 'manual', 'account'].includes(item.trigger as string) || !['running', 'succeeded', 'failed', 'unknown'].includes(item.state as string) || typeof item.mailIncluded !== 'boolean' || typeof item.databasesIncluded !== 'boolean' || typeof item.dnsIncluded !== 'boolean'
      || !Array.isArray(item.destinationIds) || item.destinationIds.length > 50 || !Array.isArray(item.archives) || item.archives.length > 2000 || !(item.localDeleted === null || count(item.localDeleted) >= 0) || !Array.isArray(item.entries) || item.entries.length > 2000 || !Array.isArray(item.retention)) return bad()
    const entries = item.entries.map((entry): WhmBackupRunEntry => {
      if (!object(entry) || !['verified', 'failed', 'unknown'].includes(entry.outcome as string) || !(entry.file === null || archive(entry.username, entry.file)) || typeof entry.username !== 'string' || !(entry.reason === null || typeof entry.reason === 'string' && /^[a-z_]{1,40}$/.test(entry.reason))
        || !(entry.sha256 === null || typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256)) || !(entry.bytes === null || count(entry.bytes) >= 0) || entry.outcome === 'verified' && (!entry.file || !entry.sha256 || !entry.bytes || entry.reason !== null)) return bad()
      return { username: entry.username as string, destinationId: uuid(entry.destinationId), file: entry.file as string | null, bytes: entry.bytes as number | null, sha256: entry.sha256 as string | null, outcome: entry.outcome as WhmBackupRunEntry['outcome'], reason: entry.reason as string | null }
    })
    const archives = item.archives.map(archiveOf), control = item.control === null ? null : archiveOf(item.control)
    if (archives.some(entry => entry.username === '_control') || control && control.username !== '_control') return bad()
    const state = item.state as WhmBackupRun['state']
    if (state === 'succeeded' && (!archives.length || [...archives, ...control ? [control] : []].some(entry => entry.integrity !== 'verified') || entries.some(entry => entry.outcome !== 'verified'))) return bad()
    return { id: uuid(item.id), trigger: item.trigger as WhmBackupRun['trigger'], startedAt: stamp(item.startedAt)!, finishedAt: stamp(item.finishedAt, true), state, accounts: count(item.accounts), destinationIds: item.destinationIds.map(uuid), mailIncluded: item.mailIncluded, databasesIncluded: item.databasesIncluded, dnsIncluded: item.dnsIncluded,
      archives, control, entries, localDeleted: item.localDeleted as number | null,
      retention: item.retention.map(row => object(row) && ['verified', 'failed', 'unknown'].includes(row.outcome as string) ? { destinationId: uuid(row.destinationId), deleted: count(row.deleted), outcome: row.outcome as string } : bad()) }
  })
  const recoveries = raw.recoveries.map((item): WhmBackupRecovery => {
    if (!object(item) || item.username === '_control' || !archive(item.username, item.file) || !['running', 'recovered', 'failed', 'unknown'].includes(item.state as string) || !(item.reason === null || ['exists', 'missing', 'mismatch', 'transport', 'interrupted'].includes(item.reason as string))) return bad()
    return { id: uuid(item.id), destinationId: uuid(item.destinationId), username: item.username as string, file: item.file as string, startedAt: stamp(item.startedAt)!, state: item.state as WhmBackupRecovery['state'], reason: item.reason as string | null }
  })
  const restores = raw.restores.map((item): WhmBackupPartRestore => {
    if (!object(item) || item.username === '_control' || !archive(item.username, item.file) || !['running', 'finished', 'unknown'].includes(item.state as string) || !Array.isArray(item.items) || !item.items.length || item.items.length > 20) return bad()
    const items = item.items.map(row => object(row) && ['database', 'dns'].includes(row.part as string) && ['restored', 'failed', 'not-attempted'].includes(row.result as string) && (row.result === 'restored') === (row.reason === null) && (row.reason === null || typeof row.reason === 'string' && /^[a-z-]{1,40}$/.test(row.reason))
      ? { part: row.part as 'database' | 'dns', name: row.part === 'database' ? database(item.username as string, row.name) : zone(row.name), result: row.result as WhmBackupPartRestore['items'][number]['result'], reason: row.reason as string | null } : bad())
    return { id: uuid(item.id), username: item.username as string, file: item.file as string, startedAt: stamp(item.startedAt)!, finishedAt: stamp(item.finishedAt, true), state: item.state as WhmBackupPartRestore['state'], items }
  })
  const running = [...runs, ...recoveries, ...restores].filter(item => item.state === 'running')
  const activeId = raw.activeId === null ? null : uuid(raw.activeId)
  if (running.length > 1 || (running[0]?.id ?? null) !== activeId) return bad()
  return { available: raw.available, reason: raw.reason as string | null, revision: raw.revision, schedule, storage, activeId, runs, recoveries, restores }
}
/** Strict reader for GET /api/backups/workspace/destinations/<id>/retention. */
export function readWhmBackupRetentionPlan(raw: unknown, destinationId: string): WhmBackupRetentionPlan {
  const bad = (): never => { throw new Error('invalid_backup_retention') }
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  if (!object(raw) || raw.destinationId !== destinationId || typeof raw.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(raw.planDigest) || !Array.isArray(raw.rows) || raw.rows.length > 10000) return bad()
  const rows = raw.rows.map(row => {
    if (!object(row) || typeof row.name !== 'string' || typeof row.username !== 'string'
      || !(row.username === '_control' ? row.name.startsWith('_control/xpanel-control-') : row.name.startsWith(row.username + '/xpanel-backup-' + row.username + '-')) || typeof row.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.createdAt)
      || typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !['newest', 'protected', 'within_count', 'weekly', 'monthly', 'within_days', 'expired'].includes(row.reason as string) || row.action !== (row.reason === 'expired' ? 'delete' : 'keep')) return bad()
    return { name: row.name, username: row.username, createdAt: row.createdAt, bytes: row.bytes, action: row.action as 'keep' | 'delete', reason: row.reason as string }
  })
  return { destinationId, planDigest: raw.planDigest, rows }
}

function bindWhmBackupRuns(ask: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-backup-runs]').forEach(root => {
    if (root.dataset.bound === 'true') return
    root.dataset.bound = 'true'
    const q = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const status = q<HTMLElement>('[data-backup-runs-status]'), loading = q<HTMLElement>('[data-backup-runs-loading]'), read = q<HTMLButtonElement>('[data-backup-runs-read]'), start = q<HTMLButtonElement>('[data-backup-runs-start]')
    const select = q<HTMLSelectElement>('[data-backup-retention-destination]'), preview = q<HTMLButtonElement>('[data-backup-retention-preview]'), apply = q<HTMLButtonElement>('[data-backup-retention-apply]'), retentionStatus = q<HTMLElement>('[data-backup-retention-status]')
    if (!status || !loading || !read || !start || !select || !preview || !apply || !retentionStatus) return
    const templates = new Map<string, HTMLTemplateElement>()
    const rowSlots = { runs: ['started', 'trigger', 'state', 'copies', 'mail', 'retention'], copies: ['account', 'destination', 'archive', 'size', 'started', 'action'], recoveries: ['started', 'account', 'archive', 'state'], retention: ['archive', 'account', 'created', 'size', 'plan'] } as const
    try {
      for (const [kind, slots] of Object.entries(rowSlots)) {
        const template = clientTemplate(root, 'whm-backup-' + kind + '-row')
        const clone = cloneClientTemplate(template, 'tr', slots)
        if (kind === 'copies') clientTemplateSlot(clone, 'action', 'button')
        templates.set(kind, template)
      }
    } catch {
      root.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select').forEach(control => { control.disabled = true })
      status.dataset.state = 'failed'; status.textContent = t('Backup runs could not be read. No changes were made.'); return
    }
    const rows = (id: string): HTMLElement => q<HTMLElement>(`[data-backup-runs-rows="${id}"]`)!, empty = (id: string): HTMLElement => q<HTMLElement>(`[data-backup-runs-empty="${id}"]`)!
    let view: WhmBackupRunsView | null = null, configRevision = '', names = new Map<string, string>(), plan: WhmBackupRetentionPlan | null = null, busy = false, review = false
    const eligible = (): boolean => root.isConnected && root.dataset.canManage === 'true' && !!send && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const note = (node: HTMLElement, state: string, message: string): void => { node.hidden = false; node.dataset.state = state; node.textContent = message; node.setAttribute('role', ['failed', 'review'].includes(state) ? 'alert' : 'status') }
    const lock = (): void => {
      const ready = eligible() && !busy && !review && !!view
      read.disabled = !eligible() || busy
      start.disabled = !ready || !view!.available || view!.activeId !== null
      select.disabled = !ready || !select.options.length || select.options[0]!.value === ''
      preview.disabled = select.disabled
      apply.disabled = !ready || !plan || plan.destinationId !== select.value || !plan.rows.some(row => row.action === 'delete')
      root.querySelectorAll<HTMLButtonElement>('[data-backup-recover]').forEach(button => { button.disabled = !ready || view!.activeId !== null })
      root.setAttribute('aria-busy', String(busy)); loading.hidden = !busy
    }
    const technical = (value: string): HTMLElement => { const node = document.createElement('bdi'); node.dir = 'ltr'; node.textContent = value; return node }
    const size = (bytes: number | null): string => bytes === null ? '' : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KiB' : bytes < 1024 ** 3 ? (bytes / 1024 / 1024).toFixed(1) + ' MiB' : (bytes / 1024 ** 3).toFixed(2) + ' GiB'
    const row = (target: HTMLElement, kind: keyof typeof rowSlots, values: Record<string, string | Node>): HTMLTableRowElement => {
      const tr = cloneClientTemplate(templates.get(kind)!, 'tr', rowSlots[kind]) as HTMLTableRowElement
      for (const [name, value] of Object.entries(values)) clientTemplateSlot(tr, name).replaceChildren(value)
      target.append(tr); return tr
    }
    const fill = (id: string, count: number): HTMLElement => { const target = rows(id); target.replaceChildren(); empty(id).hidden = count > 0; return target }
    const stateLabel = (state: string): string => ({ running: t('Running'), succeeded: t('Succeeded'), failed: t('Failed'), unknown: t('Outcome unknown; review required'), recovered: t('Recovered'), verified: t('Verified') } as Record<string, string>)[state] ?? state
    const reasonText = (reason: string | null): string => ({
      no_executor: t('Scheduled backups cannot run here: this server has no Linux host executor for account archives.'),
      no_provider: t('No trusted remote transport is configured. Add an S3-compatible or SFTP credential profile on the server, then test and activate a destination.'),
      no_schedule: t('No backup schedule is saved. Save a schedule; without destinations it keeps verified copies on this server only.'),
      no_destination: t('No selected destination is enabled with a current verification. Test and activate a destination first.'),
      invalid_configuration: t('The saved backup configuration could not be read. Review the schedule and destinations.'),
      invalid_ledger: t('The run history file {path} is in an older or unreadable format. Move it aside (for example to {path}.old) to start a new history; nothing runs until then.', { path: '/var/lib/xpanel/backup-runs.json' }),
    } as Record<string, string>)[reason ?? ''] ?? t('Backup runs were read.')
    const paint = (next: WhmBackupRunsView): void => {
      view = next
      const facts = (key: string, value: string | Node): void => { q<HTMLElement>(`[data-backup-runs-fact="${key}"]`)!.replaceChildren(value) }
      facts('schedule', next.schedule ? next.schedule.enabled ? technical(next.schedule.cron) : t('Saved, disabled') : t('No schedule saved'))
      facts('next', next.schedule?.nextRunAt ? formatDisplayDateTime(next.schedule.nextRunAt) : t('None'))
      facts('last', next.schedule?.lastScheduledAt ? formatDisplayDateTime(next.schedule.lastScheduledAt) : t('None'))
      const runs = fill('runs', next.runs.length)
      for (const run of next.runs) {
        // A copy counts once its local archive passed the integrity read and every remote copy was re-read.
        const verified = run.archives.filter(item => item.integrity === 'verified' && run.entries.every(entry => entry.username !== item.username || entry.outcome === 'verified')).length
        row(runs, 'runs', { started: formatDisplayDateTime(run.startedAt), trigger: run.trigger === 'schedule' ? t('Scheduled') : run.trigger === 'account' ? t('Selected accounts') : t('Run now'), state: stateLabel(run.state), copies: t('{verified} of {total}', { verified, total: run.archives.length }), mail: run.mailIncluded ? t(msgctxt('acct-backup-runs-client', 'Included')) : t('Not included'),
          retention: run.retention.length ? run.retention.map(item => t('{deleted, plural, one {# archive deleted} other {# archives deleted}} ({state})', { deleted: item.deleted, state: stateLabel(item.outcome) })).join(', ') : t('Not applied') })
      }
      const copies = next.runs.flatMap(run => run.entries.filter(entry => entry.outcome === 'verified' && entry.username !== '_control').map(entry => ({ run, entry })))
      const copyRows = fill('copies', copies.length)
      for (const { run, entry } of copies) {
        const copyRow = row(copyRows, 'copies', { account: technical(entry.username), destination: names.get(entry.destinationId) ?? t('Not read'), archive: technical(entry.file!), size: size(entry.bytes), started: formatDisplayDateTime(run.startedAt) })
        const button = clientTemplateSlot(copyRow, 'action', 'button') as HTMLButtonElement
        button.textContent = t('Recover to this server')
        Object.assign(button.dataset, { backupRecover: run.id, username: entry.username, file: entry.file!, destination: entry.destinationId })
      }
      const recoveries = fill('recoveries', next.recoveries.length)
      for (const item of next.recoveries) row(recoveries, 'recoveries', { started: formatDisplayDateTime(item.startedAt), account: technical(item.username), archive: technical(item.file), state: stateLabel(item.state) + (item.reason === 'exists' ? ' - ' + t('A local archive with this name already exists.') : item.reason === 'mismatch' ? ' - ' + t('The downloaded copy did not match the recorded SHA-256.') : item.reason === 'missing' ? ' - ' + t('The remote copy no longer exists.') : '') })
      note(status, next.available ? 'read' : 'unavailable', next.activeId ? t('A backup operation is running. Read again to follow it.') : reasonText(next.reason))
      lock()
    }
    const load = async (): Promise<void> => {
      if (!eligible() || busy) return
      busy = true; lock()
      try {
        const lifecycle = await send!('GET', '/api/backups/workspace/destination-lifecycle') as { revision?: unknown; destinations?: unknown }
        if (!lifecycle || typeof lifecycle.revision !== 'string' || !/^[0-9a-f]{64}$/.test(lifecycle.revision) || !Array.isArray(lifecycle.destinations)) throw new Error('invalid_lifecycle')
        configRevision = lifecycle.revision
        const active = (lifecycle.destinations as { id?: unknown; name?: unknown; effectiveActive?: unknown }[]).filter(item => typeof item.id === 'string' && typeof item.name === 'string')
        names = new Map(active.map(item => [item.id as string, item.name as string]))
        const prior = select.value
        select.replaceChildren(...active.filter(item => item.effectiveActive === true).map(item => { const option = document.createElement('option'); option.value = item.id as string; option.textContent = item.name as string; return option }))
        if (!select.options.length) { const option = document.createElement('option'); option.value = ''; option.textContent = t('No active destination'); select.append(option) }
        if ([...select.options].some(option => option.value === prior)) select.value = prior
        let next: WhmBackupRunsView
        try { next = readWhmBackupRunsView(await send!('GET', '/api/backups/workspace/runs')) }
        catch (error) { if ((error as { status?: number }).status === 412) { view = null; note(status, 'unavailable', t('Scheduled backup execution is unavailable on this server.')); return } throw error }
        if (!eligible()) return
        review = false; paint(next)
      } catch { view = null; note(status, 'failed', t('Backup runs could not be read. No changes were made.')) }
      finally { busy = false; lock() }
    }
    const confirm = async (title: string, body: string, danger = false): Promise<boolean> => !!ask && await ask({ title, body, danger, confirm: t('Confirm') }) === true
    const mutate = async (path: string, body: Record<string, unknown>, done: string, node: HTMLElement): Promise<boolean> => {
      busy = true; lock()
      try { await send!('POST', path, { expectedRevision: configRevision, ...body }); note(node, 'saved', done); return true }
      catch (error) {
        const code = (error as { status?: number }).status
        if (code === 409 || code === 412 || code === 404 || code === 422) note(node, 'failed', t('The server refused the request because the saved state changed or is not ready. Nothing was changed. Read again.'))
        else { review = true; note(node, 'review', t('The outcome requires review. Read again before another change.')) }
        return false
      } finally { busy = false; lock() }
    }
    read.addEventListener('click', () => { void load() })
    start.addEventListener('click', async () => {
      if (start.disabled || !view) return
      if (!await confirm(t('Run backup now'), t('Archive the scheduled accounts now and upload them to every selected destination. Each copy is read back before it counts.'))) return
      if (await mutate('/api/backups/workspace/runs', { expectedRunsRevision: view.revision }, t('The backup run started. Read again to follow its progress.'), status)) await load()
    })
    select.addEventListener('change', () => { plan = null; fill('retention', 0); empty('retention').hidden = true; lock() })
    preview.addEventListener('click', async () => {
      if (preview.disabled) return
      const destinationId = select.value
      busy = true; lock()
      try {
        plan = readWhmBackupRetentionPlan(await send!('GET', '/api/backups/workspace/destinations/' + destinationId + '/retention'), destinationId)
        const target = fill('retention', plan.rows.length), reasons: Record<string, string> = { newest: t('Keep: newest archive'), protected: t('Keep: newest verified copy'), within_count: t('Keep: within retention count'), within_days: t('Keep: within retention days'), expired: t('Delete: expired') }
        for (const item of plan.rows) row(target, 'retention', { archive: technical(item.name), account: technical(item.username), created: formatDisplayDateTime(item.createdAt), size: size(item.bytes), plan: reasons[item.reason]! })
        const deletions = plan.rows.filter(item => item.action === 'delete').length
        note(retentionStatus, 'read', t('{count, plural, =0 {Nothing is due for deletion.} one {# archive is due for deletion.} other {# archives are due for deletion.}}', { count: deletions }))
      } catch { plan = null; note(retentionStatus, 'failed', t('The retention plan could not be read. Nothing was deleted.')) }
      finally { busy = false; lock() }
    })
    apply.addEventListener('click', async () => {
      if (apply.disabled || !plan) return
      const reviewed = plan, count = reviewed.rows.filter(item => item.action === 'delete').length
      if (!await confirm(t('Delete expired archives'), t('{count, plural, one {Delete # expired archive from this destination? It cannot be recovered afterwards.} other {Delete # expired archives from this destination? They cannot be recovered afterwards.}}', { count }), true)) return
      busy = true; lock()
      try {
        const result = await send!('POST', '/api/backups/workspace/destinations/' + reviewed.destinationId + '/retention', { expectedRevision: configRevision, expectedPlanDigest: reviewed.planDigest }) as { outcome?: unknown; deleted?: unknown }
        if (result?.outcome === 'verified' && Array.isArray(result.deleted)) note(retentionStatus, 'saved', t('{count, plural, one {# archive was deleted and the listing no longer shows it.} other {# archives were deleted and the listing no longer shows them.}}', { count: result.deleted.length }))
        else { review = true; note(retentionStatus, 'review', t('Some deletions could not be confirmed by listing the destination again. Review before retrying.')) }
        plan = null
      } catch (error) {
        const code = (error as { status?: number }).status
        if (code === 409) note(retentionStatus, 'failed', t('The remote archives changed. Review the plan again; nothing was deleted.'))
        else { review = true; note(retentionStatus, 'review', t('The outcome requires review. Read again before another change.')) }
      } finally { busy = false; lock() }
    })
    root.addEventListener('click', async event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-backup-recover]')
      if (!button || button.disabled || !view) return
      const { backupRecover: runId, username, file, destination } = button.dataset
      if (!await confirm(t('Recover to this server'), t('Download {file} into the local archives of {username}? The copy is checked against its recorded SHA-256 and never replaces an existing archive.', { file: file!, username: username! }))) return
      if (await mutate('/api/backups/workspace/destinations/' + destination + '/recover', { expectedRunsRevision: view.revision, runId, username, file }, t('The recovery started. Read again to follow it.'), status)) await load()
    })
    lock()
    if (eligible()) void load()
    else note(status, 'unavailable', t('Backup run management is unavailable here.'))
  })
}
export { bindWhmBackupRuns }
export const WHM_BACKUP_RUNS_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const readWhmBackupRunsView=${readWhmBackupRunsView.toString()};const readWhmBackupRetentionPlan=${readWhmBackupRetentionPlan.toString()};return ${bindWhmBackupRuns.toString()};})()`
