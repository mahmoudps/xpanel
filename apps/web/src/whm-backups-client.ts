import { clientTemplate as canonicalBackupTemplate, cloneClientTemplate as canonicalBackupClone, clientTemplateSlot as canonicalBackupSlot } from './client-templates.ts'
const clientTemplate = canonicalBackupTemplate
const cloneClientTemplate = canonicalBackupClone
const clientTemplateSlot = canonicalBackupSlot
function backupNode(root: HTMLElement, name: string, tag: string, values: Readonly<Record<string, string>> = {}): HTMLElement {
  const node = cloneClientTemplate(clientTemplate(root, 'whm-backup-' + name), tag, Object.keys(values))
  for (const [key, value] of Object.entries(values)) clientTemplateSlot(node, key).textContent = value
  return node
}
function requireBackupTemplates(root: HTMLElement): void {
  const specs: readonly [string, string, readonly string[]][] = [
    ['activation','span',['before','link','after']],['missing','div',['notice','clear']],['account-choice','label',['control','text']],['destination-heading','strong',['text']],['destination-choice','label',['control','text']],
    ['destination-row','tr',['name','kind','endpoint','state','edit','remove']],['destination-empty','tr',['message']],['snapshot-row','tr',['created','kind','username','bytes','contents','integrity','state','summary','paths']],['path','li',['text']],['snapshot-empty','tr',['message']],['pager','div',['previous','label','next']],
    ['run-row','tr',['created','trigger','accounts','bytes','duration','copies','state','restore','log']],['run-empty','tr',['message']],['log','li',[]],['technical','bdi',['text']],['name','bdi',['text']],['radio','button',['title','note']],['choices-empty','p',['message']],['difference','tr',['part','name','current','backup','action']],
  ]
  for (const [name,tag,slots] of specs) cloneClientTemplate(clientTemplate(root, 'whm-backup-' + name), tag, slots)
}
import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
import { readWhmBackupRunsView } from './acct-backup-runs-client.ts'
import type { WhmBackupRun, WhmBackupRunArchive, WhmBackupRunsView } from './acct-backup-runs-client.ts'
import { readRestoreMoreReply } from './acct-restore-client.ts'
import type { RestoreMoreInventory } from './acct-restore-client.ts'
// Module-local aliases: the binding source refers to them by these names, defined again in WHM_BACKUPS_CLIENT_BINDING.
const backupRunsView = readWhmBackupRunsView
const backupRestoreReply = readRestoreMoreReply

export interface WhmBackupDestination {
  id: string; name: string; kind: 'local' | 'sftp' | 's3' | 'backblaze' | 'rsync' | 'ftp'; endpoint: string
  bucket: string | null; region: string | null; pathPrefix: string; username: string | null
  retentionDays: number; enabled: boolean; createdAt: string
}
export interface WhmBackupSchedule {
  enabled: boolean; frequency: 'daily' | 'weekly' | 'monthly'; cron: string; retentionCount: number
  retentionWeekly: number; retentionMonthly: number
  compress: 'zstd' | 'gzip'; includeDatabases: boolean; includeMail: boolean; includeDns: boolean; includeControl: boolean
  selectedAccounts: string[] | 'all'; destinationIds: string[]; updatedAt: string
}
export interface WhmBackupSnapshot {
  id: string; accountId: string; username: string; createdAt: string; sizeBytes: number
  files: { path: string; sizeBytes: number; mode: number }[]; databases: string[]
  application: { status: 'recorded_metadata'; archiveVerified: false; restoreAvailable: false }
}
export interface WhmBackupWorkspaceView {
  revision: string; destinations: WhmBackupDestination[]; schedule: WhmBackupSchedule | null
  accounts: { id: string; username: string; primaryDomain: string; status: string }[]; snapshots: WhmBackupSnapshot[]
}
const backupKinds = ['local', 'sftp', 's3', 'backblaze', 'rsync', 'ftp'] as const
const backupObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const backupText = (value: unknown, max = 4096): string => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(value)) throw new Error('invalid_backup_text')
  return value
}
const backupIdentity = (value: unknown): string => {
  const result = backupText(value, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) throw new Error('invalid_backup_identity')
  return result
}
const backupInteger = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('invalid_backup_number')
  return value
}
const backupBoolean = (value: unknown): boolean => { if (typeof value !== 'boolean') throw new Error('invalid_backup_boolean'); return value }
const backupArray = <T>(value: unknown, max: number, parse: (item: unknown) => T): T[] => {
  if (!Array.isArray(value) || value.length > max) throw new Error('invalid_backup_collection')
  return value.map(parse)
}
const backupRevision = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('invalid_backup_revision')
  return value
}
const backupApplication = (value: unknown): void => {
  if (!backupObject(value) || value.status !== 'configuration_only' || value.nativeApplied !== false) throw new Error('invalid_backup_application')
}
export function readWhmBackupDestination(value: unknown): WhmBackupDestination {
  if (!backupObject(value) || !backupKinds.includes(value.kind as WhmBackupDestination['kind'])) throw new Error('invalid_backup_destination')
  const nullable = (raw: unknown): string | null => raw === null ? null : backupText(raw, 1024)
  return { id: backupIdentity(value.id), name: backupText(value.name, 120), kind: value.kind as WhmBackupDestination['kind'], endpoint: backupText(value.endpoint, 1024), bucket: nullable(value.bucket), region: nullable(value.region), pathPrefix: backupText(value.pathPrefix, 1024), username: nullable(value.username), retentionDays: backupInteger(value.retentionDays, 1, 3650), enabled: backupBoolean(value.enabled), createdAt: backupText(value.createdAt, 64) }
}
export function readWhmBackupSchedule(value: unknown): WhmBackupSchedule {
  if (!backupObject(value) || !['daily', 'weekly', 'monthly'].includes(String(value.frequency)) || !['zstd', 'gzip'].includes(String(value.compress))) throw new Error('invalid_backup_schedule')
  return { enabled: backupBoolean(value.enabled), frequency: value.frequency as WhmBackupSchedule['frequency'], cron: backupText(value.cron, 100), retentionCount: backupInteger(value.retentionCount, 1, 3650), retentionWeekly: backupInteger(value.retentionWeekly, 0, 520), retentionMonthly: backupInteger(value.retentionMonthly, 0, 240), compress: value.compress as WhmBackupSchedule['compress'], includeDatabases: backupBoolean(value.includeDatabases), includeMail: backupBoolean(value.includeMail), includeDns: backupBoolean(value.includeDns), includeControl: backupBoolean(value.includeControl), selectedAccounts: value.selectedAccounts === 'all' ? 'all' : backupArray(value.selectedAccounts, 10000, item => backupText(item, 64)), destinationIds: backupArray(value.destinationIds, 50, backupIdentity), updatedAt: backupText(value.updatedAt, 64) }
}
export function readWhmBackupWorkspace(value: unknown): WhmBackupWorkspaceView {
  if (!backupObject(value)) throw new Error('invalid_backup_workspace')
  backupApplication(value.application)
  const accounts = backupArray(value.accounts, 10000, raw => {
    if (!backupObject(raw)) throw new Error('invalid_backup_account')
    return { id: backupIdentity(raw.id), username: backupText(raw.username, 32), primaryDomain: backupText(raw.primaryDomain, 253), status: backupText(raw.status, 32) }
  })
  const destinations = backupArray(value.destinations, 50, readWhmBackupDestination)
  if (new Set(accounts.map(account => account.id)).size !== accounts.length || new Set(destinations.map(destination => destination.id)).size !== destinations.length) throw new Error('ambiguous_backup_context')
  const snapshots = backupArray(value.snapshots, 10000, raw => {
    if (!backupObject(raw) || !backupObject(raw.application) || raw.application.status !== 'recorded_metadata' || raw.application.archiveVerified !== false || raw.application.restoreAvailable !== false) throw new Error('invalid_backup_snapshot')
    return { id: backupIdentity(raw.id), accountId: backupIdentity(raw.accountId), username: backupText(raw.username, 32), createdAt: backupText(raw.createdAt, 64), sizeBytes: backupInteger(raw.sizeBytes), files: backupArray(raw.files, 10000, file => {
      if (!backupObject(file)) throw new Error('invalid_backup_file')
      return { path: backupText(file.path), sizeBytes: backupInteger(file.sizeBytes), mode: backupInteger(file.mode, 0, 0o7777) }
    }), databases: backupArray(raw.databases, 10000, item => backupText(item, 128)), application: { status: 'recorded_metadata' as const, archiveVerified: false as const, restoreAvailable: false as const } }
  })
  return { revision: backupRevision(value.revision), accounts, destinations, schedule: value.schedule === null ? null : readWhmBackupSchedule(value.schedule), snapshots }
}
const backupStable = (value: unknown): string => Array.isArray(value) ? '[' + value.map(backupStable).join(',') + ']' : backupObject(value) ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + backupStable(value[key])).join(',') + '}' : JSON.stringify(value) ?? 'null'
const backupUnknown = (error: unknown): boolean => {
  if (!backupObject(error)) return true
  const details = backupObject(error.details) ? error.details : {}
  if ([error, details].some(part => part.unknownOutcome === true || part.verificationRequired === true || part.stateChanged === true)) return true
  if (error.stateChanged === false || details.stateChanged === false) return false
  return typeof error.status !== 'number' || error.status >= 500
}

function bindWhmBackups(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-approved-whm-backups]').forEach(root => {
    if (root.dataset.backupBound === 'true') return
    root.dataset.backupBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-backup-workspace-status]')
    if (!status) return
    try { requireBackupTemplates(root) } catch { root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true }); status.dataset.state = 'unavailable'; status.textContent = t('Unavailable'); return }
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const input = (key: string): HTMLInputElement => root.querySelector<HTMLInputElement>('#backup-layout-' + key)!
    const select = (key: string): HTMLSelectElement => root.querySelector<HTMLSelectElement>('#backup-layout-' + key)!
    const action = (key: string): HTMLButtonElement => root.querySelector<HTMLButtonElement>('[data-backup-action="' + key + '"]')!
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.backupManage === 'true' && !root.closest(denied)
    const scheduleInputs = ['policy-enabled', 'policy-cron', 'daily-copies', 'weekly-copies', 'include-databases', 'include-mail', 'include-dns', 'include-control', 'start-time']
    const destinationInputs = ['destination-name', 'destination-endpoint', 'destination-prefix', 'destination-bucket', 'destination-region', 'destination-user', 'destination-retention']
    const activationHelp = backupNode(root, 'activation', 'span'), activationLink = clientTemplateSlot(activationHelp, 'link', 'a') as HTMLAnchorElement
    const [activationBefore, activationAfter] = t('Saved flag only. Changes save this destination inactive. Verify and activate in {link}').split('{link}'), pageLang = document.documentElement.lang
    activationLink.href = '/whm/backups/destinations' + (pageLang && pageLang !== 'en' ? '?lang=' + encodeURIComponent(pageLang) : ''); activationLink.textContent = t('Backup destinations'); clientTemplateSlot(activationHelp, 'before').textContent = activationBefore ?? ''; clientTemplateSlot(activationHelp, 'after').textContent = activationAfter ?? ''
    input('destination-enabled').setAttribute('aria-describedby', activationHelp.id)
    input('destination-enabled').closest('label')?.querySelector('span')?.append(activationHelp)
    let current: WhmBackupWorkspaceView | null = null, destinationId: string | null = null
    let busy = false, review = false, scheduleDirty = false, destinationDirty = false, allAccounts = true, confirming = false, snapshotPage = 0
    const selectedAccounts = new Set<string>(), selectedDestinations = new Set<string>()
    const announce = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'uncertain', 'stale'].includes(state) ? 'alert' : 'status'); root.dataset.backupReadState = state }
    const setEnabled = (control: HTMLInputElement | HTMLSelectElement | HTMLButtonElement, enabled: boolean): void => {
      if (!control) return
      const fieldset = control.closest<HTMLFieldSetElement>('fieldset')
      if (enabled && fieldset) fieldset.disabled = false
      control.disabled = !enabled
    }
    const lock = (): void => {
      const ready = !!current && admitted() && !busy && !review && !confirming
      for (const key of [...scheduleInputs, ...destinationInputs]) setEnabled(input(key), ready)
      const monthly = root.querySelector<HTMLInputElement>('#backup-layout-monthly-copies'); if (monthly) setEnabled(monthly, ready)
      input('destination-enabled').disabled = true
      for (const key of ['frequency', 'policy-compress', 'destination-kind']) setEnabled(select(key), ready)
      for (const key of ['all-accounts', 'selected-accounts', 'new-destination']) setEnabled(action(key), ready)
      setEnabled(action('save-schedule'), ready && scheduleDirty)
      setEnabled(action('discard-schedule'), ready && scheduleDirty)
      setEnabled(action('save-destination'), ready && destinationDirty)
      setEnabled(action('refresh'), admitted() && !busy && !confirming)
      root.querySelectorAll<HTMLInputElement>('[data-backup-selected-account]').forEach(control => { control.disabled = !ready || allAccounts })
      root.querySelectorAll<HTMLInputElement>('[data-backup-selected-destination]').forEach(control => { control.disabled = !ready })
      root.querySelectorAll<HTMLButtonElement>('[data-backup-edit-destination],[data-backup-delete-destination]').forEach(control => { control.disabled = !ready || control.dataset.backupInUse === 'true' && control.hasAttribute('data-backup-delete-destination') })
      root.setAttribute('aria-busy', String(busy || confirming))
    }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => !send || !admitted() ? Promise.reject({ stateChanged: false }) : body === undefined ? send(method, path) : send(method, path, body)
    const confirm = async (title: string, body: string, danger = false): Promise<boolean> => {
      if (!askDialog || confirming) { announce('failed', t('Confirmation is unavailable; nothing was sent.')); return false }
      confirming = true; lock()
      try { return await askDialog({ title, body, danger, confirm: t('Confirm') }) === true } catch { return false } finally { confirming = false; lock() }
    }
    const renderChoices = (): void => {
      const accounts = root.querySelector<HTMLElement>('[data-backup-account-choices]'), destinations = root.querySelector<HTMLElement>('[data-backup-destination-choices]')
      if (accounts) {
        accounts.textContent = ''
        const known = new Set((current?.accounts ?? []).map(account => account.id))
        const missing = [...selectedAccounts].filter(selector => !known.has(selector))
        if (missing.length) {
          const notice = backupNode(root, 'missing', 'div', { notice: t('Unavailable account selections: {count}', { count: missing.length }), clear: t('Remove unavailable selections from this draft') }), clear = clientTemplateSlot(notice, 'clear', 'button') as HTMLButtonElement
          clear.disabled = busy || review || confirming
          clear.addEventListener('click', () => { if (busy || review || confirming) return; for (const selector of missing) selectedAccounts.delete(selector); scheduleDirty = true; renderChoices(); lock() })
          accounts.append(notice)
        }
        for (const account of current?.accounts ?? []) {
          const label = backupNode(root, 'account-choice', 'label', { text: account.username + ' · ' + account.primaryDomain }), checkbox = clientTemplateSlot(label, 'control', 'input') as HTMLInputElement
          checkbox.checked = allAccounts || selectedAccounts.has(account.id)
          checkbox.addEventListener('change', () => { checkbox.checked ? selectedAccounts.add(account.id) : selectedAccounts.delete(account.id); scheduleDirty = true; lock() })
          accounts.append(label)
        }
      }
      if (destinations) {
        destinations.textContent = ''
        destinations.append(backupNode(root, 'destination-heading', 'strong', { text: t('Destinations selected by this policy') }))
        for (const destination of current?.destinations ?? []) {
          const label = backupNode(root, 'destination-choice', 'label', { text: destination.name + ' · ' + (destination.enabled ? t('Enabled configuration') : t('Disabled configuration')) }), checkbox = clientTemplateSlot(label, 'control', 'input') as HTMLInputElement
          checkbox.checked = selectedDestinations.has(destination.id)
          checkbox.addEventListener('change', () => { checkbox.checked ? selectedDestinations.add(destination.id) : selectedDestinations.delete(destination.id); scheduleDirty = true; lock() })
          destinations.append(label)
        }
      }
    }
    const fillDestination = (destination: WhmBackupDestination | null): void => {
      destinationId = destination?.id ?? null
      input('destination-name').value = destination?.name ?? ''
      select('destination-kind').value = String(backupKinds.indexOf(destination?.kind ?? 'local') + 1)
      for (const [key, value] of [['endpoint', destination?.endpoint], ['prefix', destination?.pathPrefix], ['bucket', destination?.bucket], ['region', destination?.region], ['user', destination?.username]] as const) input('destination-' + key).value = value ?? ''
      input('destination-retention').value = destination ? String(destination.retentionDays) : '30'
      input('destination-enabled').checked = destination?.enabled ?? false
      destinationDirty = false
    }
    const renderDestinations = (): void => {
      const body = root.querySelector<HTMLElement>('[data-backup-destination-rows]')
      if (!body) return
      body.textContent = ''
      for (const destination of current?.destinations ?? []) {
        const row = backupNode(root, 'destination-row', 'tr', { name: destination.name, kind: destination.kind, endpoint: destination.endpoint, state: destination.enabled ? t('Enabled configuration; connection unverified') : t('Disabled configuration'), edit: t('Edit configuration'), remove: t('Remove destination') })
        const edit = clientTemplateSlot(row, 'edit', 'button') as HTMLButtonElement, remove = clientTemplateSlot(row, 'remove', 'button') as HTMLButtonElement
        const inUse = current?.schedule?.destinationIds.includes(destination.id) === true
        remove.dataset.backupInUse = String(inUse); if (inUse) remove.title = t('Remove this destination from the saved schedule first.')
        edit.addEventListener('click', () => { if (edit.disabled) return; void (async () => { if (destinationDirty && !await confirm(t('Discard destination edits?'), t('Read this saved destination instead of the unsaved draft.'), true)) return; fillDestination(destination); lock() })() })
        remove.addEventListener('click', () => { if (!remove.disabled) void mutate('delete-destination', destination) })
        body.append(row)
      }
      if (!current?.destinations.length) body.append(backupNode(root, 'destination-empty', 'tr', { message: t('No saved destinations.') }))
    }
    const renderSnapshots = (): void => {
      const body = root.querySelector<HTMLElement>('[data-backup-snapshot-rows]')
      if (!body) return
      body.textContent = ''
      const snapshots = current?.snapshots ?? [], visible = snapshots.slice(snapshotPage * 25, (snapshotPage + 1) * 25)
      for (const snapshot of visible) {
        const row = backupNode(root, 'snapshot-row', 'tr', { created: formatDisplayDateTime(snapshot.createdAt), kind: t('Recorded metadata'), username: snapshot.username, bytes: String(snapshot.sizeBytes) + ' B', contents: t('Not read'), integrity: t('Unverified'), state: t('Not a verified archive'), summary: t('Recorded paths') })
        const list = clientTemplateSlot(row, 'paths', 'ul')
        for (const file of snapshot.files) list.append(backupNode(root, 'path', 'li', { text: file.path + ' · ' + String(file.sizeBytes) + ' B' }))
        body.append(row)
      }
      if (!visible.length) body.append(backupNode(root, 'snapshot-empty', 'tr', { message: t('No snapshot metadata was returned. Account archives remain separate.') }))
      const pager = root.querySelector<HTMLElement>('[data-backup-snapshot-pager]')
      if (pager) { const page = backupNode(root, 'pager', 'div', { previous: t('Previous metadata'), next: t('Next metadata'), label: String(visible.length ? snapshotPage * 25 + 1 : 0) + '-' + String(snapshotPage * 25 + visible.length) + ' / ' + String(snapshots.length) }), previous = clientTemplateSlot(page, 'previous', 'button') as HTMLButtonElement, next = clientTemplateSlot(page, 'next', 'button') as HTMLButtonElement; previous.disabled = snapshotPage === 0; next.disabled = (snapshotPage + 1) * 25 >= snapshots.length; previous.addEventListener('click', () => { if (snapshotPage > 0) { snapshotPage--; renderSnapshots() } }); next.addEventListener('click', () => { if ((snapshotPage + 1) * 25 < snapshots.length) { snapshotPage++; renderSnapshots() } }); pager.replaceChildren(page) }
    }
    const install = (view: WhmBackupWorkspaceView): void => {
      current = view; review = false; scheduleDirty = false; snapshotPage = 0
      const schedule = view.schedule
      input('policy-enabled').checked = schedule?.enabled ?? false; input('policy-cron').value = schedule?.cron ?? '0 2 * * *'; input('daily-copies').value = String(schedule?.retentionCount ?? 7)
      input('include-databases').checked = schedule?.includeDatabases ?? true; input('include-mail').checked = schedule?.includeMail ?? true
      input('weekly-copies').value = String(schedule?.retentionWeekly ?? 4); input('include-dns').checked = schedule?.includeDns ?? true; input('include-control').checked = schedule?.includeControl ?? true
      const monthly = root.querySelector<HTMLInputElement>('#backup-layout-monthly-copies'); if (monthly) monthly.value = String(schedule?.retentionMonthly ?? 0)
      select('frequency').value = schedule?.frequency === 'weekly' ? '3' : schedule?.frequency === 'monthly' ? '4' : '1'; select('policy-compress').value = schedule?.compress === 'gzip' ? '2' : '1'
      const cron = input('policy-cron').value.split(/\s+/)
      const pairedHours = (cron[1] ?? '').split(',').map(Number)
      if (schedule?.frequency === 'daily' && (cron[1] === '*/12' || pairedHours.length === 2 && pairedHours.every(Number.isInteger) && Math.abs(pairedHours[1]! - pairedHours[0]!) === 12)) select('frequency').value = '2'
      const hour = select('frequency').value === '2' ? cron[1] === '*/12' ? '0' : (cron[1] ?? '').split(',')[0]! : cron[1] ?? ''
      input('start-time').value = /^\d+$/.test(cron[0] ?? '') && /^\d+$/.test(hour) ? hour.padStart(2, '0') + ':' + cron[0]!.padStart(2, '0') : ''
      allAccounts = !schedule || schedule.selectedAccounts === 'all'; selectedAccounts.clear(); selectedDestinations.clear()
      if (schedule && schedule.selectedAccounts !== 'all') {
        for (const selector of schedule.selectedAccounts) selectedAccounts.add(selector)
        for (const account of view.accounts) if (selectedAccounts.has(account.username)) { selectedAccounts.delete(account.username); selectedAccounts.add(account.id) }
      }
      for (const identity of schedule?.destinationIds ?? []) selectedDestinations.add(identity)
      renderChoices(); renderDestinations(); renderSnapshots(); fillDestination(view.destinations.find(destination => destination.id === destinationId) ?? null)
      const limit = root.querySelector<HTMLElement>('#whm-backup-layout-unavailable')
      if (limit) limit.textContent = t('Saved configuration and recorded snapshot metadata were read. Server-wide jobs, restore differences, remote connection checks and native archive verification remain unavailable.')
      const runs = root.querySelector<HTMLElement>('[data-backup-section="runs"]>p')
      if (runs) runs.textContent = t('Recorded snapshot metadata is shown below. It is not server-wide run history or proof of a completed archive.')
      const configuration = root.querySelector<HTMLElement>('[data-backup-section="configuration"]>p')
      if (configuration) configuration.textContent = t('Saved schedule and destination metadata were read. The requested policy does not prove scheduler installation, transport trust or low-priority CPU/IO enforcement (weight 10).')
      root.querySelectorAll<HTMLElement>('[data-backup-account-choices]').forEach(choices => { const previous = choices.previousElementSibling; if (previous?.tagName === 'P' && previous.getAttribute('role') === 'status') previous.textContent = t('Authorized current accounts read: {count}', { count: view.accounts.length }) })
      const saved = root.querySelector<HTMLElement>('[data-backup-configuration-status]')
      if (saved) saved.textContent = schedule ? t('Saved configuration read; scheduling and remote transport remain unverified.') : t('No schedule is stored. The controls contain an unsaved draft.')
    }
    const refresh = async (): Promise<void> => {
      if (busy || confirming || !admitted()) return
      if ((scheduleDirty || destinationDirty || review) && !await confirm(t('Discard drafts and read saved configuration?'), t('Unsaved edits will be discarded. No previous write is retried.'), true)) return
      if (busy || confirming || !admitted()) return
      busy = true; lock()
      try { install(readWhmBackupWorkspace(await request('GET', '/api/backups/workspace'))); announce('read', t('Saved backup configuration read. Execution and archive verification remain unavailable.')) }
      catch { announce('failed', t('Backup configuration could not be read. No changes were sent.')) }
      finally { busy = false; lock() }
    }
    const number = (value: string): number => { if (!/^\d+$/.test(value)) throw new Error('invalid_integer'); return backupInteger(Number(value), 1, 3650) }
    const copies = (value: string, max: number): number => { if (!/^\d+$/.test(value)) throw new Error('invalid_integer'); return backupInteger(Number(value), 0, max) }
    const scheduleDraft = (): Omit<WhmBackupSchedule, 'updatedAt'> => ({ enabled: input('policy-enabled').checked, frequency: select('frequency').value === '3' ? 'weekly' : select('frequency').value === '4' ? 'monthly' : 'daily', cron: input('policy-cron').value.trim().replace(/\s+/g, ' '), retentionCount: number(input('daily-copies').value), retentionWeekly: copies(input('weekly-copies').value, 520), retentionMonthly: root.querySelector<HTMLInputElement>('#backup-layout-monthly-copies') ? copies(root.querySelector<HTMLInputElement>('#backup-layout-monthly-copies')!.value, 240) : current?.schedule?.retentionMonthly ?? 0, compress: select('policy-compress').value === '2' ? 'gzip' : 'zstd', includeDatabases: input('include-databases').checked, includeMail: input('include-mail').checked, includeDns: input('include-dns').checked, includeControl: input('include-control').checked, selectedAccounts: allAccounts ? 'all' : [...selectedAccounts], destinationIds: [...selectedDestinations] })
    const destinationDraft = (): Omit<WhmBackupDestination, 'id' | 'createdAt'> => {
      const kind = backupKinds[Number(select('destination-kind').value) - 1]
      if (!kind) throw new Error('invalid_kind')
      const nullable = (key: string): string | null => input('destination-' + key).value.trim() || null
      const raw = input('destination-endpoint').value.trim()
      if (kind !== 'local') new URL(raw)
      const endpoint = raw
      return { name: input('destination-name').value.trim(), kind, endpoint, bucket: nullable('bucket'), region: nullable('region'), pathPrefix: input('destination-prefix').value.trim(), username: nullable('user'), retentionDays: number(input('destination-retention').value), enabled: false }
    }
    async function mutate(kind: 'schedule' | 'destination' | 'delete-destination', target?: WhmBackupDestination): Promise<void> {
      if (!current || busy || confirming || review || !admitted()) return
      let draft: Record<string, unknown>
      try { draft = kind === 'schedule' ? scheduleDraft() : kind === 'destination' ? destinationDraft() : {} }
      catch { announce('failed', t('Check the schedule, retention, destination URL and required fields. Nothing was sent.')); return }
      const expectedRevision = current.revision, selectedId = kind === 'delete-destination' ? target?.id : destinationId
      const keepSchedule = kind !== 'schedule' && scheduleDirty
      const keepDestination = kind !== 'destination' && destinationDirty
      const remembered = new Map<string, { value: string; checked: boolean }>()
      if (keepSchedule) for (const key of [...scheduleInputs, 'frequency', 'policy-compress']) { const control = key === 'frequency' || key === 'policy-compress' ? select(key) : input(key); remembered.set(key, { value: control.value, checked: control instanceof HTMLInputElement && control.checked }) }
      if (keepDestination) for (const key of [...destinationInputs, 'destination-kind']) { const control = key === 'destination-kind' ? select(key) : input(key); remembered.set(key, { value: control.value, checked: control instanceof HTMLInputElement && control.checked }) }
      const rememberedAccounts = [...selectedAccounts], rememberedDestinations = [...selectedDestinations], rememberedAll = allAccounts, rememberedDestinationId = destinationId
      if (kind === 'delete-destination' && !selectedId) return
      const name = target?.name ?? (kind === 'destination' ? String(draft.name) : t('Saved backup policy'))
      if (!await confirm(kind === 'delete-destination' ? t('Remove backup destination?') : t('Save backup configuration?'), name + '\n' + t('This changes saved configuration only; no backup or remote connection is started.') + (kind === 'schedule' && allAccounts ? '\n' + t('All accounts includes accounts created later.') : ''), kind === 'delete-destination')) return
      if (!admitted()) return
      busy = true; lock(); let submitted = false
      try {
        const path = kind === 'schedule' ? '/api/backups/workspace/schedule' : '/api/backups/workspace/destinations' + (selectedId ? '/' + encodeURIComponent(selectedId) : '')
        submitted = true
        const reply = await request(kind === 'delete-destination' ? 'DELETE' : kind === 'destination' && selectedId ? 'PATCH' : kind === 'destination' ? 'POST' : 'PUT', path, { ...draft, expectedRevision })
        if (!backupObject(reply)) throw new Error('invalid_backup_ack')
        backupApplication(reply.application); const acknowledgedRevision = backupRevision(reply.revision)
        if (kind === 'delete-destination' && reply.ok !== true) throw new Error('invalid_backup_delete_ack')
        const observed = readWhmBackupWorkspace(await request('GET', '/api/backups/workspace'))
        if (observed.revision !== acknowledgedRevision) throw new Error('backup_readback_changed')
        if (kind === 'schedule') {
          const saved = readWhmBackupSchedule(reply.schedule), { updatedAt: _at, ...fields } = saved
          if (backupStable(fields) !== backupStable(draft) || backupStable(observed.schedule) !== backupStable(saved)) throw new Error('backup_schedule_readback_mismatch')
        } else if (kind === 'destination') {
          const saved = readWhmBackupDestination(reply.destination), { id: _id, createdAt: _createdAt, ...fields } = saved
          if (selectedId && saved.id !== selectedId || backupStable(fields) !== backupStable(draft) || backupStable(observed.destinations.find(destination => destination.id === saved.id)) !== backupStable(saved)) throw new Error('backup_destination_readback_mismatch')
          destinationId = saved.id
        } else if (observed.destinations.some(destination => destination.id === selectedId)) throw new Error('backup_deleted_destination_still_present')
        install(observed)
        for (const [key, value] of remembered) { const control = ['frequency', 'policy-compress', 'destination-kind'].includes(key) ? select(key) : input(key); control.value = value.value; if (control instanceof HTMLInputElement) control.checked = value.checked }
        if (keepSchedule) { selectedAccounts.clear(); for (const selector of rememberedAccounts) selectedAccounts.add(selector); selectedDestinations.clear(); for (const identity of rememberedDestinations) if (kind !== 'delete-destination' || identity !== selectedId) selectedDestinations.add(identity); allAccounts = rememberedAll; scheduleDirty = true; renderChoices() }
        if (keepDestination) { destinationId = kind === 'delete-destination' && rememberedDestinationId === selectedId ? null : rememberedDestinationId; destinationDirty = true }
        announce('saved', t('Configuration stored and read back. Backup execution, remote connection and native archive verification remain unverified.'))
      } catch (error) {
        const conflict = backupObject(error) && error.status === 409
        review = submitted && (conflict || backupUnknown(error))
        announce(review ? conflict ? 'stale' : 'uncertain' : 'failed', review ? t('The outcome requires review. Drafts are kept; no retry was sent. Read saved configuration before continuing.') : t('The request was refused. Drafts are kept and no retry was sent.'))
      } finally { busy = false; lock() }
    }
    if (!send || !admitted()) { announce('unavailable', t('Backup configuration is unavailable here. Nothing was read or changed.')); return }
    root.addEventListener('input', event => {
      const control = event.target
      if (!(control instanceof HTMLInputElement) || control.disabled) return
      if (control.id.startsWith('backup-layout-destination-')) destinationDirty = true
      else if ([...scheduleInputs.map(key => 'backup-layout-' + key), 'backup-layout-monthly-copies'].includes(control.id)) scheduleDirty = true
      lock()
    })
    root.addEventListener('change', event => {
      const control = event.target
      if (!(control instanceof HTMLSelectElement) || control.disabled) return
      if (control.id === 'backup-layout-destination-kind') destinationDirty = true
      else if (control.id === 'backup-layout-frequency' || control.id === 'backup-layout-policy-compress') scheduleDirty = true
      if (control.id === 'backup-layout-frequency') {
        const [hour = '02', minute = '00'] = (input('start-time').value || '02:00').split(':')
        const time = String(Number(minute)) + ' ' + String(Number(hour))
        input('policy-cron').value = control.value === '2' ? String(Number(minute)) + ' ' + String(Number(hour) % 12) + ',' + String(Number(hour) % 12 + 12) + ' * * *' : time + (control.value === '3' ? ' * * 0' : control.value === '4' ? ' 1 * *' : ' * * *')
      }
      lock()
    })
    input('start-time').addEventListener('change', () => {
      if (input('start-time').disabled || !/^\d\d:\d\d$/.test(input('start-time').value)) return
      const [hour, minute] = input('start-time').value.split(':'), fields = input('policy-cron').value.trim().split(/\s+/)
      if (fields.length === 5) { fields[0] = String(Number(minute)); fields[1] = select('frequency').value === '2' ? String(Number(hour) % 12) + ',' + String(Number(hour) % 12 + 12) : String(Number(hour)); input('policy-cron').value = fields.join(' '); scheduleDirty = true; lock() }
    })
    action('all-accounts').addEventListener('click', () => { if (!action('all-accounts').disabled) { allAccounts = true; scheduleDirty = true; renderChoices(); lock() } })
    action('selected-accounts').addEventListener('click', () => { if (!action('selected-accounts').disabled) { if (allAccounts) { selectedAccounts.clear(); for (const account of current?.accounts ?? []) selectedAccounts.add(account.id) } allAccounts = false; scheduleDirty = true; renderChoices(); lock() } })
    action('refresh').addEventListener('click', () => { void refresh() })
    action('save-schedule').addEventListener('click', () => { if (!action('save-schedule').disabled) void mutate('schedule') })
    action('save-destination').addEventListener('click', () => { if (!action('save-destination').disabled) void mutate('destination') })
    action('new-destination').addEventListener('click', () => { if (action('new-destination').disabled) return; void (async () => { if (destinationDirty && !await confirm(t('Discard destination draft?'), t('Start a new destination draft without saving this one.'), true)) return; fillDestination(null); lock() })() })
    action('discard-schedule').addEventListener('click', () => { void refresh() })
    window.addEventListener('beforeunload', event => { if (scheduleDirty || destinationDirty || review) { event.preventDefault(); event.returnValue = '' } })
    lock(); void refresh()
  })
}

/**
 * Server backups page operations from authorized reads: summary, run history and log, run now and "back up again",
 * the run → account → parts → difference → restore wizard, and the SFTP connection check. Hooks are the
 * `data-backup-*` attributes of the approved page; a missing hook leaves that part as rendered.
 */
function bindWhmBackupOperations(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-approved-whm-backups]').forEach(root => {
    if (root.dataset.backupOperationsBound === 'true') return
    root.dataset.backupOperationsBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"]'
    const admitted = (): boolean => root.isConnected && root.dataset.backupManage === 'true' && !root.closest(denied)
    if (!send || !admitted()) return
    try { requireBackupTemplates(root) } catch { root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true }); const status = root.querySelector<HTMLElement>('[data-backup-workspace-status]'); if (status) { status.dataset.state = 'unavailable'; status.textContent = t('Unavailable') }; return }
    const one = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const buttons = (key: string): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>('[data-backup-action="' + key + '"]')]
    const field = (key: string): HTMLInputElement | null => one<HTMLInputElement>('#backup-layout-' + key)
    const size = (bytes: number | null): string => { if (bytes === null) return '-'; const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let value = bytes, unit = 0; while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ } return (unit ? value.toFixed(1) : String(value)) + ' ' + units[unit] }
    const technical = (value: string): HTMLElement => backupNode(root, 'technical', 'bdi', { text: value })
    const stateLabel = (state: string): string => ({ running: t('Running'), succeeded: t('Succeeded'), failed: t('Failed'), unknown: t('Outcome unknown; review required'), finished: t('Finished'), verified: t('Verified') } as Record<string, string>)[state] ?? state
    let view: WhmBackupRunsView | null = null, configRevision = '', destinations: { id: string; name: string; kind: string; endpoint: string; username: string | null; pathPrefix: string; state: string; credentialRef: string | null }[] = []
    let busy = false, logRun: string | null = null, runId: string | null = null, account: string | null = null, inventory: RestoreMoreInventory | null = null, step = 1
    let mailReview: { revision: string; mailboxes: string[] } | null = null, reviewed = false
    const confirm = async (title: string, body: string, danger = false): Promise<boolean> => { if (!askDialog) return false; try { return await askDialog({ title, body, danger, confirm: t('Confirm') }) === true } catch { return false } }
    const say = (node: HTMLElement | null, message: string, state = 'read'): void => { if (!node) return; node.textContent = message; node.dataset.state = state; node.setAttribute('role', state === 'failed' || state === 'review' ? 'alert' : 'status') }
    const restoreStatus = one<HTMLElement>('[data-backup-restore-status]'), sftpStatus = one<HTMLElement>('[data-backup-sftp-status]')
    const run = (): WhmBackupRun | null => view?.runs.find(item => item.id === runId) ?? null
    const archive = (): WhmBackupRunArchive | null => run()?.archives.find(item => item.username === account && item.integrity === 'verified') ?? null
    const parts = (): { databases: string[]; zones: string[]; mail: boolean } => ({
      databases: field('restore-databases')?.checked ? (inventory?.databases.databases ?? []).filter(item => item.current === 'exists').map(item => item.name) : [],
      zones: field('restore-dns')?.checked ? (inventory?.dns.zones ?? []).filter(item => item.current === 'exists').map(item => item.name) : [],
      mail: field('restore-mail')?.checked === true,
    })
    const lock = (): void => {
      const idle = !busy && !!view && !view.activeId
      for (const button of buttons('run-now')) button.disabled = !idle || !view!.available
      for (const button of buttons('rerun-account')) button.disabled = !idle || !failedAccounts().length
      for (const button of buttons('run-log')) button.disabled = !view?.runs.length
      for (const button of buttons('restore-run')) button.disabled = !runId
      for (const button of buttons('restore-back')) button.disabled = busy || step === 1
      for (const button of buttons('restore-continue')) button.disabled = busy || step === 1 && !runId || step === 2 && !inventory || step === 3
      const chosen = parts()
      for (const button of buttons('restore-review')) button.disabled = busy || step !== 3 || !chosen.databases.length && !chosen.zones.length && !chosen.mail
      for (const button of buttons('restore-apply')) button.disabled = busy || !reviewed || field('restore-acknowledge')?.checked !== true
      for (const button of buttons('test-sftp')) { button.disabled = busy || !destinations.some(item => item.kind === 'sftp' && ['verified', 'active', 'unverified'].includes(item.state)); if (!button.disabled) button.closest('fieldset')?.removeAttribute('disabled') }
      const acknowledge = field('restore-acknowledge'); if (acknowledge) acknowledge.disabled = busy || !reviewed
      for (const key of ['restore-databases', 'restore-dns', 'restore-mail']) { const input = field(key); if (input) { const state = key === 'restore-databases' ? inventory?.databases.state : key === 'restore-dns' ? inventory?.dns.state : inventory?.mail.state; const usable = step === 3 && state === 'available'; input.disabled = busy || !usable; if (!usable) input.checked = false; input.closest('fieldset')?.removeAttribute('disabled') } }
      const home = field('restore-home'); if (home) { home.disabled = true; home.checked = false }
      root.querySelectorAll<HTMLElement>('[data-backup-restore-step]').forEach(item => { if (Number(item.dataset.backupRestoreStep) === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current') })
      root.setAttribute('aria-busy', String(busy))
    }
    function failedAccounts(): string[] { const latest = view?.runs[0]; return latest ? latest.archives.filter(item => item.integrity === 'failed').map(item => item.username) : [] }

    const paintSummary = (): void => {
      const put = (key: string, text: string): void => { const node = one<HTMLElement>('[data-backup-summary="' + key + '"]'); if (node) node.textContent = text }
      const done = view?.runs.find(item => item.state !== 'running')
      put('last', done ? formatDisplayDateTime(done.finishedAt ?? done.startedAt) + ' · ' + stateLabel(done.state) : t('None'))
      put('next', view?.schedule?.nextRunAt ? formatDisplayDateTime(view.schedule.nextRunAt) : t('None'))
      put('local', view?.storage ? t('{used} used · {free} free', { used: size(view.storage.totalBytes - view.storage.freeBytes), free: size(view.storage.freeBytes) }) : t('Not read'))
      const remote = destinations.find(item => item.kind === 'sftp' && item.state === 'active') ?? destinations.find(item => item.state === 'active')
      const uploaded = remote ? view?.runs.flatMap(item => item.entries.filter(entry => entry.destinationId === remote.id && entry.outcome === 'verified').map(() => item.finishedAt ?? item.startedAt))[0] : undefined
      put('remote', remote ? remote.name + (uploaded ? ' · ' + t('Uploaded {at}', { at: formatDisplayDateTime(uploaded) }) : '') : t('No active remote destination'))
    }
    const paintRuns = (): void => {
      const body = one<HTMLElement>('[data-backup-snapshot-rows]')
      if (!body || !view) return
      body.replaceChildren()
      for (const item of view.runs) {
        const bytes = item.archives.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0), seconds = item.finishedAt ? Math.round((Date.parse(item.finishedAt) - Date.parse(item.startedAt)) / 1000) : null
        const copies = item.destinationIds.length ? t('{verified} of {total}', { verified: item.entries.filter(entry => entry.outcome === 'verified').length, total: item.entries.length }) : t('This server only')
        const row = backupNode(root, 'run-row', 'tr', { created: formatDisplayDateTime(item.startedAt), trigger: item.trigger === 'schedule' ? t('Scheduled') : item.trigger === 'account' ? t('Selected accounts') : t('Run now'), accounts: t('{verified} of {total}', { verified: item.archives.filter(entry => entry.integrity === 'verified').length, total: item.archives.length }), bytes: size(bytes), duration: seconds === null ? '-' : seconds >= 60 ? Math.floor(seconds / 60) + ' min ' + (seconds % 60) + ' s' : seconds + ' s', copies, state: stateLabel(item.state), restore: t('Restore'), log: t('Log') })
        const restore = clientTemplateSlot(row, 'restore', 'button') as HTMLButtonElement, log = clientTemplateSlot(row, 'log', 'button') as HTMLButtonElement
        log.disabled = false
        restore.disabled = !item.archives.some(entry => entry.integrity === 'verified')
        restore.addEventListener('click', () => { if (!restore.disabled && !busy) { selectRun(item.id); one<HTMLElement>('[data-backup-section="restore"]')?.scrollIntoView?.({ block: 'start' }) } })
        log.addEventListener('click', () => { logRun = item.id; paintLog() })
        body.append(row)
      }
      if (!view.runs.length) body.append(backupNode(root, 'run-empty', 'tr', { message: t('No backup run has been recorded yet.') }))
    }
    const paintFailure = (): void => {
      const notice = one<HTMLElement>('[data-backup-run-failure]'), text = notice?.querySelector<HTMLElement>('p')
      const latest = view?.runs[0], failed = latest?.archives.filter(item => item.integrity === 'failed') ?? []
      if (!notice || !text) return
      if (!latest || !failed.length && !(latest.control?.integrity === 'failed')) { text.textContent = t('The latest run has no failed parts.'); return }
      const verified = latest.archives.filter(item => item.integrity === 'verified').length
      text.textContent = t('{failed, plural, one {# account failed} other {# accounts failed}}: {names}. {verified, plural, one {# account is complete} other {# accounts are complete}}.', { failed: failed.length, names: failed.map(item => item.username).join(', '), verified })
        + (latest.control?.integrity === 'failed' ? ' ' + t('The control snapshot failed.') : '')
    }
    const paintLog = (): void => {
      const log = one<HTMLElement>('[data-backup-run-log]'), item = view?.runs.find(entry => entry.id === logRun) ?? view?.runs[0]
      if (!log || !item) return
      // Localized prose follows the page direction and font; only names, sizes, dates and diagnostics are isolated LTR values.
      const named = (value: string): HTMLElement => backupNode(root, 'name', 'bdi', { text: value })
      const line = (entry: WhmBackupRunArchive): (string | Node)[] => [technical(entry.username), ': ', ...entry.integrity === 'verified'
        ? [t('verified') + ' ', technical(size(entry.bytes)), ...entry.databases.length ? [' · ' + t('{count, plural, one {# database} other {# databases}}', { count: entry.databases.length })] : [], ...entry.zones.length ? [' · ' + t('{count, plural, one {# DNS zone} other {# DNS zones}}', { count: entry.zones.length })] : []]
        : [entry.reason === 'integrity_failed' ? t('failed its integrity read') : t('was not built'), ...entry.detail ? [' - ', technical(entry.detail)] : []]]
      const uploads = item.entries.filter(entry => entry.outcome !== 'verified').map(entry => [technical(entry.username), ' · ', named(destinations.find(target => target.id === entry.destinationId)?.name ?? t('Not read')), ': ' + stateLabel(entry.outcome), ...entry.reason ? [' (', technical(entry.reason), ')'] : []])
      const lines: (string | Node)[][] = [[technical(formatDisplayDateTime(item.startedAt)), ' · ' + stateLabel(item.state)], ...item.control ? [line(item.control)] : [], ...item.archives.map(line), ...uploads,
        ...item.localDeleted !== null ? [[t('{count, plural, one {# older local copy removed} other {# older local copies removed}}', { count: item.localDeleted })]] : []]
      log.replaceChildren(...lines.map(parts => { const row = backupNode(root, 'log', 'li'); row.append(...parts); return row }))
      log.hidden = false
    }
    const radio = (container: HTMLElement | null, items: { key: string; title: string; note: string; checked: boolean }[], pick: (key: string) => void): void => {
      if (!container) return
      container.replaceChildren()
      for (const item of items) {
        const button = backupNode(root, 'radio', 'button', { title: item.title, note: item.note }) as HTMLButtonElement
        button.setAttribute('aria-checked', String(item.checked)); button.dataset.backupChoice = item.key; button.disabled = busy
        button.addEventListener('click', () => { if (!busy) pick(item.key) }); container.append(button)
      }
      if (!items.length) container.append(backupNode(root, 'choices-empty', 'p', { message: t('Nothing to choose yet.') }))
    }
    const paintWizard = (): void => {
      const usable = view?.runs.filter(item => item.archives.some(entry => entry.integrity === 'verified')) ?? []
      radio(one('[data-backup-restore-runs]'), usable.map(item => ({ key: item.id, title: formatDisplayDateTime(item.startedAt), note: stateLabel(item.state) + ' · ' + size(item.archives.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)), checked: item.id === runId })), selectRun)
      const search = (field('restore-search')?.value ?? '').trim().toLowerCase()
      radio(one('[data-backup-restore-accounts]'), (run()?.archives ?? []).filter(item => item.integrity === 'verified' && item.username.includes(search)).map(item => ({ key: item.username, title: item.username, note: size(item.bytes), checked: item.username === account })), pick => { void selectAccount(pick) })
      const availability = one<HTMLElement>('[data-backup-part-availability]')
      if (availability) availability.textContent = !inventory ? t('Pick a run and an account to read which parts its backup holds.')
        : t('This backup holds {databases, plural, =0 {no databases} one {# database} other {# databases}}, {zones, plural, =0 {no DNS zones} one {# DNS zone} other {# DNS zones}} and {mailboxes, plural, =0 {no mailboxes} one {# mailbox} other {# mailboxes}}. Home files are restored file by file on the Restore files page.', { databases: inventory.databases.databases.length, zones: inventory.dns.zones.length, mailboxes: inventory.mail.mailboxes.length })
      lock()
    }
    function selectRun(id: string): void { runId = id; account = null; inventory = null; reviewed = false; mailReview = null; step = 2; paintWizard() }
    async function selectAccount(username: string): Promise<void> {
      const chosen = run()?.archives.find(item => item.username === username && item.integrity === 'verified')
      if (!chosen?.file || busy) return
      account = username; inventory = null; reviewed = false; busy = true; paintWizard()
      try { inventory = backupRestoreReply('inventory', await send!('POST', '/api/backups/components/' + username + '/inventory', { file: chosen.file }), { username, file: chosen.file }); step = 3; say(restoreStatus, t('The backup of {account} was read and checked.', { account: username })) }
      catch { say(restoreStatus, t('The backup of {account} could not be read. Nothing was changed.', { account: username }), 'failed') }
      finally { busy = false; paintWizard() }
    }
    const review = async (): Promise<void> => {
      const chosen = archive(), selected = parts()
      if (!chosen?.file || !inventory || busy) return
      busy = true; reviewed = false; lock()
      const rows = one<HTMLElement>('[data-backup-difference-rows]'), facts = (key: string, text: string): void => { const node = one<HTMLElement>('[data-backup-difference="' + key + '"]'); if (node) node.textContent = text }
      try {
        let add = 0, keep = 0
        mailReview = null
        if (selected.mail) {
          const mailboxes = inventory.mail.mailboxes.filter(item => item.current === 'exists').map(item => item.address)
          if (mailboxes.length) {
            const preview = backupRestoreReply('preview', await send!('POST', '/api/backups/components/' + account + '/preview', { file: chosen.file, mailboxes }), { username: account!, file: chosen.file, mailboxes })
            add = preview.counts.batch; keep = preview.counts.present; mailReview = { revision: preview.revision, mailboxes }
          }
        }
        if (rows) {
          rows.replaceChildren()
          const row = (part: string, name: string, current: string, backup: string, action: string): void => { rows.append(backupNode(root, 'difference', 'tr', { part, name, current, backup, action })) }
          for (const item of inventory.databases.databases.filter(entry => selected.databases.includes(entry.name))) row(t('Databases'), item.name, t('Exists'), size(item.bytes), t('Replace with the backup copy'))
          for (const item of inventory.dns.zones.filter(entry => selected.zones.includes(entry.name))) row(t('DNS zone'), item.name, t('Exists'), size(item.bytes), t('Replace records with the backup copy'))
          if (mailReview) row(t('Mail'), mailReview.mailboxes.join(', '), t('{count, plural, one {# message present} other {# messages present}}', { count: keep }), t('{count, plural, one {# message} other {# messages}}', { count: add + keep }), t('{count, plural, one {Add # missing message} other {Add # missing messages}}', { count: add }))
        }
        facts('differ', t('{count, plural, one {# part replaced} other {# parts replaced}}', { count: selected.databases.length + selected.zones.length }))
        facts('add', t('{count, plural, one {# message added} other {# messages added}}', { count: add }))
        facts('keep', t('{count, plural, one {# message kept, never deleted} other {# messages kept, never deleted}}', { count: keep }))
        facts('databases', selected.databases.length ? selected.databases.join(', ') : t('None selected'))
        reviewed = true
        say(restoreStatus, t('Review the difference, confirm it, then restore.'))
      } catch { say(restoreStatus, t('The difference could not be read. Nothing was changed.'), 'failed') }
      finally { busy = false; lock() }
    }
    const apply = async (): Promise<void> => {
      const chosen = archive(), selected = parts(), current = run()
      if (!chosen?.file || !chosen.sha256 || !current || !reviewed || busy) return
      if (!await confirm(t('Restore {account}', { account: account! }), t('Restore the selected parts of {account} from the run of {run}? Databases and zones are replaced with their backup copies; files missing from the backup are never deleted.', { account: account!, run: formatDisplayDateTime(current.startedAt) }), true)) return
      busy = true; lock()
      const messages: string[] = []
      try {
        if (selected.databases.length || selected.zones.length) {
          backupRestoreReply('parts', await send!('POST', '/api/backups/components/' + account + '/parts', { file: chosen.file, databases: selected.databases, zones: selected.zones, expectedArchiveSha256: chosen.sha256 }), { username: account!, file: chosen.file, sha256: chosen.sha256, databases: selected.databases, zones: selected.zones })
          messages.push(t('Reconciling: restoring {account} from {run}. The account stays online; you can follow it in the audit log.', { account: account!, run: formatDisplayDateTime(current.startedAt) }))
        }
        if (mailReview) {
          const result = backupRestoreReply('restore', await send!('POST', '/api/backups/components/' + account + '/restore', { file: chosen.file, mailboxes: mailReview.mailboxes, expectedRevision: mailReview.revision }), { username: account!, file: chosen.file, mailboxes: mailReview.mailboxes, revision: mailReview.revision })
          messages.push(t('{count, plural, one {# message restored} other {# messages restored}}.', { count: result.counts.restored }))
        }
        reviewed = false
        say(restoreStatus, messages.join(' '), 'saved')
      } catch { say(restoreStatus, t('The restore outcome requires review. Read the backups again before retrying.'), 'review') }
      finally { busy = false; lock(); void load() }
    }
    const startRun = async (accounts?: string[]): Promise<void> => {
      if (!view || busy || !configRevision) return
      if (!await confirm(accounts ? t('Back up again') : t('Run backup now'), accounts ? t('Back up {names} again now, at low priority?', { names: accounts.join(', ') }) : t('Start a backup of every selected account now, at low priority?'))) return
      busy = true; lock()
      try { await send!('POST', '/api/backups/workspace/runs', { expectedRevision: configRevision, expectedRunsRevision: view.revision, ...accounts ? { accounts } : {} }); say(restoreStatus, t('The backup started. Read again to follow it.'), 'saved') }
      catch (error) { say(restoreStatus, (error as { status?: unknown })?.status === 409 ? t('Backups changed meanwhile. Read again before starting.') : t('The backup could not be started.'), 'failed') }
      finally { busy = false; await load() }
    }
    const testSftp = async (): Promise<void> => {
      const target = destinations.find(item => item.kind === 'sftp')
      if (!target || busy) return
      if (!await confirm(t('Test connection'), t('Write, read and delete one small test file on {host}?', { host: target.endpoint }))) return
      busy = true; lock()
      try {
        await send!('POST', '/api/backups/workspace/destinations/' + target.id + '/test', { expectedRevision: configRevision })
        const reply = await send!('GET', '/api/backups/workspace/destinations/' + target.id + '/space') as { space?: { freeBytes?: unknown } | null }
        const free = reply?.space?.freeBytes
        say(sftpStatus, typeof free === 'number' ? t('Connected. {free} free on the remote path.', { free: size(free) }) : t('Connected. The remote server does not report free space.'), 'saved')
      } catch { say(sftpStatus, t('The connection test failed or requires review. The destination stays inactive.'), 'failed') }
      finally { busy = false; await load() }
    }
    async function load(): Promise<void> {
      if (!admitted()) return
      try {
        const lifecycle = await send!('GET', '/api/backups/workspace/destination-lifecycle') as { revision?: unknown; destinations?: unknown }
        if (!lifecycle || typeof lifecycle.revision !== 'string' || !/^[0-9a-f]{64}$/.test(lifecycle.revision) || !Array.isArray(lifecycle.destinations)) throw new Error('invalid_lifecycle')
        configRevision = lifecycle.revision
        destinations = lifecycle.destinations.flatMap(item => { const row = item as Record<string, unknown>; return typeof row.id === 'string' && typeof row.name === 'string' && typeof row.kind === 'string' && typeof row.endpoint === 'string' && typeof row.state === 'string' && typeof row.pathPrefix === 'string'
          ? [{ id: row.id, name: row.name, kind: row.kind, endpoint: row.endpoint, username: typeof row.username === 'string' ? row.username : null, pathPrefix: row.pathPrefix, state: row.state, credentialRef: typeof row.credentialRef === 'string' ? row.credentialRef : null }] : [] })
        view = backupRunsView(await send!('GET', '/api/backups/workspace/runs'))
      } catch { view = null; lock(); return }
      const sftp = destinations.find(item => item.kind === 'sftp')
      if (sftp) {
        try { const url = new URL(sftp.endpoint); for (const [key, value] of [['sftp-host', url.hostname], ['sftp-port', url.port || '22'], ['sftp-user', sftp.username ?? ''], ['sftp-path', sftp.pathPrefix], ['sftp-key', sftp.credentialRef ? '/etc/xpanel/backup-keys/' + sftp.credentialRef : '']] as const) { const input = field(key); if (input) input.value = value } } catch { /* endpoint shown as saved */ }
        if (!sftpStatus?.dataset.state || sftpStatus.dataset.state === 'read') say(sftpStatus, sftp.state === 'active' ? t('Verified and active.') : sftp.state === 'verified' ? t('Verified, not yet active.') : t('Not verified yet. Test the connection.'))
      }
      if (view.reason === 'invalid_ledger') say(restoreStatus, t('The run history file {path} is in an older or unreadable format. Move it aside (for example to {path}.old) to start a new history; nothing runs until then.', { path: '/var/lib/xpanel/backup-runs.json' }), 'failed')
      paintSummary(); paintRuns(); paintFailure(); paintLog(); paintWizard()
    }
    for (const button of buttons('run-now')) button.addEventListener('click', () => { if (!button.disabled) void startRun() })
    for (const button of buttons('rerun-account')) button.addEventListener('click', () => { if (!button.disabled) void startRun(failedAccounts()) })
    for (const button of buttons('run-log')) button.addEventListener('click', () => { if (!button.disabled) paintLog() })
    for (const button of buttons('restore-run')) button.addEventListener('click', () => { if (!button.disabled) one<HTMLElement>('[data-backup-section="restore"]')?.scrollIntoView?.({ block: 'start' }) })
    for (const button of buttons('restore-back')) button.addEventListener('click', () => { if (button.disabled) return; step = Math.max(1, step - 1); if (step < 3) { reviewed = false } if (step === 1) { account = null; inventory = null } paintWizard() })
    for (const button of buttons('restore-continue')) button.addEventListener('click', () => { if (!button.disabled) { step = Math.min(3, step + 1); paintWizard() } })
    for (const button of buttons('restore-review')) button.addEventListener('click', () => { if (!button.disabled) void review() })
    for (const button of buttons('restore-apply')) button.addEventListener('click', () => { if (!button.disabled) void apply() })
    for (const button of buttons('test-sftp')) button.addEventListener('click', () => { if (!button.disabled) void testSftp() })
    field('restore-search')?.addEventListener('input', () => paintWizard())
    root.addEventListener('change', event => { const target = event.target as HTMLElement; if (target.id?.startsWith('backup-layout-restore-')) { if (target.id !== 'backup-layout-restore-acknowledge') reviewed = false; lock() } })
    lock(); void load()
  })
}

export const WHM_BACKUPS_CLIENT_BINDING = `(()=>{const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const backupNode=${backupNode.toString()};const requireBackupTemplates=${requireBackupTemplates.toString()};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const backupKinds=${JSON.stringify(backupKinds)};const backupObject=${backupObject.toString()};const backupText=${backupText.toString()};const backupIdentity=${backupIdentity.toString()};const backupInteger=${backupInteger.toString()};const backupBoolean=${backupBoolean.toString()};const backupArray=${backupArray.toString()};const backupRevision=${backupRevision.toString()};const backupApplication=${backupApplication.toString()};const readWhmBackupDestination=${readWhmBackupDestination.toString()};const readWhmBackupSchedule=${readWhmBackupSchedule.toString()};const readWhmBackupWorkspace=${readWhmBackupWorkspace.toString()};const backupStable=${backupStable.toString()};const backupUnknown=${backupUnknown.toString()};const backupRunsView=${readWhmBackupRunsView.toString()};const backupRestoreReply=${readRestoreMoreReply.toString()};const bindWhmBackups=${bindWhmBackups.toString()};const bindWhmBackupOperations=${bindWhmBackupOperations.toString()};return ask=>{bindWhmBackups(ask);bindWhmBackupOperations(ask)};})()`
