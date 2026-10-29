import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime

export interface WhmBackupDestination {
  id: string; name: string; kind: 'local' | 'sftp' | 's3' | 'backblaze' | 'rsync' | 'ftp'; endpoint: string
  bucket: string | null; region: string | null; pathPrefix: string; username: string | null
  retentionDays: number; enabled: boolean; createdAt: string
}
export interface WhmBackupSchedule {
  enabled: boolean; frequency: 'daily' | 'weekly' | 'monthly'; cron: string; retentionCount: number
  compress: 'zstd' | 'gzip'; includeDatabases: boolean; includeMail: boolean
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
  return { enabled: backupBoolean(value.enabled), frequency: value.frequency as WhmBackupSchedule['frequency'], cron: backupText(value.cron, 100), retentionCount: backupInteger(value.retentionCount, 1, 3650), compress: value.compress as WhmBackupSchedule['compress'], includeDatabases: backupBoolean(value.includeDatabases), includeMail: backupBoolean(value.includeMail), selectedAccounts: value.selectedAccounts === 'all' ? 'all' : backupArray(value.selectedAccounts, 10000, item => backupText(item, 64)), destinationIds: backupArray(value.destinationIds, 50, backupIdentity), updatedAt: backupText(value.updatedAt, 64) }
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
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const input = (key: string): HTMLInputElement => root.querySelector<HTMLInputElement>('#backup-layout-' + key)!
    const select = (key: string): HTMLSelectElement => root.querySelector<HTMLSelectElement>('#backup-layout-' + key)!
    const action = (key: string): HTMLButtonElement => root.querySelector<HTMLButtonElement>('[data-backup-action="' + key + '"]')!
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.backupManage === 'true' && !root.closest(denied)
    const scheduleInputs = ['policy-enabled', 'policy-cron', 'daily-copies', 'include-databases', 'include-mail', 'start-time']
    const destinationInputs = ['destination-name', 'destination-endpoint', 'destination-prefix', 'destination-bucket', 'destination-region', 'destination-user', 'destination-retention']
    const activationHelp = document.createElement('span'), activationLink = document.createElement('a')
    activationHelp.className = 'xp-help'; activationHelp.id = 'backup-destination-activation-help'
    const [activationBefore, activationAfter] = t('Saved flag only. Changes save this destination inactive. Verify and activate in {link}').split('{link}'), pageLang = document.documentElement.lang
    activationLink.href = '/whm/backups/destinations' + (pageLang && pageLang !== 'en' ? '?lang=' + encodeURIComponent(pageLang) : ''); activationLink.textContent = t('Backup destinations'); activationHelp.append(activationBefore ?? '', activationLink, activationAfter ?? '')
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
          const notice = document.createElement('p'), clear = document.createElement('button')
          notice.textContent = t('Unavailable account selections: {count}', { count: missing.length })
          clear.type = 'button'; clear.className = 'xp-btn'; clear.textContent = t('Remove unavailable selections from this draft')
          clear.addEventListener('click', () => { if (busy || review || confirming) return; for (const selector of missing) selectedAccounts.delete(selector); scheduleDirty = true; renderChoices(); lock() })
          accounts.append(notice, clear)
        }
        for (const account of current?.accounts ?? []) {
          const label = document.createElement('label'), checkbox = document.createElement('input'), text = document.createElement('bdi')
          label.className = 'xp-whm-backup-choice'; checkbox.type = 'checkbox'; checkbox.dataset.backupSelectedAccount = ''; checkbox.checked = allAccounts || selectedAccounts.has(account.id); text.dir = 'ltr'; text.textContent = account.username + ' · ' + account.primaryDomain
          checkbox.addEventListener('change', () => { checkbox.checked ? selectedAccounts.add(account.id) : selectedAccounts.delete(account.id); scheduleDirty = true; lock() })
          label.append(checkbox, text); accounts.append(label)
        }
      }
      if (destinations) {
        destinations.textContent = ''
        const heading = document.createElement('strong'); heading.textContent = t('Destinations selected by this policy'); destinations.append(heading)
        for (const destination of current?.destinations ?? []) {
          const label = document.createElement('label'), checkbox = document.createElement('input'), text = document.createElement('span')
          label.className = 'xp-whm-backup-choice'; checkbox.type = 'checkbox'; checkbox.dataset.backupSelectedDestination = ''; checkbox.checked = selectedDestinations.has(destination.id); text.textContent = destination.name + ' · ' + (destination.enabled ? t('Enabled configuration') : t('Disabled configuration'))
          checkbox.addEventListener('change', () => { checkbox.checked ? selectedDestinations.add(destination.id) : selectedDestinations.delete(destination.id); scheduleDirty = true; lock() })
          label.append(checkbox, text); destinations.append(label)
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
        const row = document.createElement('tr')
        for (const value of [destination.name, destination.kind, destination.endpoint, destination.enabled ? t('Enabled configuration; connection unverified') : t('Disabled configuration')]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell) }
        const cell = document.createElement('td'), edit = document.createElement('button'), remove = document.createElement('button')
        edit.type = remove.type = 'button'; edit.className = remove.className = 'xp-btn'; edit.textContent = t('Edit configuration'); remove.textContent = t('Remove destination'); edit.dataset.backupEditDestination = ''; remove.dataset.backupDeleteDestination = ''
        const inUse = current?.schedule?.destinationIds.includes(destination.id) === true
        remove.dataset.backupInUse = String(inUse); if (inUse) remove.title = t('Remove this destination from the saved schedule first.')
        edit.addEventListener('click', () => { if (edit.disabled) return; void (async () => { if (destinationDirty && !await confirm(t('Discard destination edits?'), t('Read this saved destination instead of the unsaved draft.'), true)) return; fillDestination(destination); lock() })() })
        remove.addEventListener('click', () => { if (!remove.disabled) void mutate('delete-destination', destination) })
        cell.append(edit, remove); row.append(cell); body.append(row)
      }
      if (!current?.destinations.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = t('No saved destinations.'); row.append(cell); body.append(row) }
    }
    const renderSnapshots = (): void => {
      const body = root.querySelector<HTMLElement>('[data-backup-snapshot-rows]')
      if (!body) return
      body.textContent = ''
      const snapshots = current?.snapshots ?? [], visible = snapshots.slice(snapshotPage * 25, (snapshotPage + 1) * 25)
      for (const snapshot of visible) {
        const row = document.createElement('tr')
        for (const value of [formatDisplayDateTime(snapshot.createdAt), t('Recorded metadata'), snapshot.username, String(snapshot.sizeBytes) + ' B', t('Not read'), t('Unverified'), t('Not a verified archive')]) { const cell = document.createElement('td'), text = document.createElement('bdi'); text.dir = 'ltr'; text.textContent = value; cell.append(text); row.append(cell) }
        const cell = document.createElement('td'), details = document.createElement('details'), summary = document.createElement('summary'), list = document.createElement('ul')
        summary.textContent = t('Recorded paths')
        for (const file of snapshot.files) { const item = document.createElement('li'), text = document.createElement('bdi'); text.dir = 'ltr'; text.textContent = file.path + ' · ' + String(file.sizeBytes) + ' B'; item.append(text); list.append(item) }
        details.append(summary, list); cell.append(details); row.append(cell); body.append(row)
      }
      if (!visible.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 8; cell.textContent = t('No snapshot metadata was returned. Account archives remain separate.'); row.append(cell); body.append(row) }
      const pager = root.querySelector<HTMLElement>('[data-backup-snapshot-pager]')
      if (pager) { pager.textContent = ''; const previous = document.createElement('button'), next = document.createElement('button'), label = document.createElement('span'); previous.type = next.type = 'button'; previous.className = next.className = 'xp-btn'; previous.textContent = t('Previous metadata'); next.textContent = t('Next metadata'); previous.disabled = snapshotPage === 0; next.disabled = (snapshotPage + 1) * 25 >= snapshots.length; label.textContent = String(visible.length ? snapshotPage * 25 + 1 : 0) + '-' + String(snapshotPage * 25 + visible.length) + ' / ' + String(snapshots.length); previous.addEventListener('click', () => { if (snapshotPage > 0) { snapshotPage--; renderSnapshots() } }); next.addEventListener('click', () => { if ((snapshotPage + 1) * 25 < snapshots.length) { snapshotPage++; renderSnapshots() } }); pager.append(previous, label, next) }
    }
    const install = (view: WhmBackupWorkspaceView): void => {
      current = view; review = false; scheduleDirty = false; snapshotPage = 0
      const schedule = view.schedule
      input('policy-enabled').checked = schedule?.enabled ?? false; input('policy-cron').value = schedule?.cron ?? '0 2 * * *'; input('daily-copies').value = String(schedule?.retentionCount ?? 7)
      input('include-databases').checked = schedule?.includeDatabases ?? true; input('include-mail').checked = schedule?.includeMail ?? true
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
    const scheduleDraft = (): Omit<WhmBackupSchedule, 'updatedAt'> => ({ enabled: input('policy-enabled').checked, frequency: select('frequency').value === '3' ? 'weekly' : select('frequency').value === '4' ? 'monthly' : 'daily', cron: input('policy-cron').value.trim().replace(/\s+/g, ' '), retentionCount: number(input('daily-copies').value), compress: select('policy-compress').value === '2' ? 'gzip' : 'zstd', includeDatabases: input('include-databases').checked, includeMail: input('include-mail').checked, selectedAccounts: allAccounts ? 'all' : [...selectedAccounts], destinationIds: [...selectedDestinations] })
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
      else if ([...scheduleInputs.map(key => 'backup-layout-' + key)].includes(control.id)) scheduleDirty = true
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

export const WHM_BACKUPS_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const backupKinds=${JSON.stringify(backupKinds)};const backupObject=${backupObject.toString()};const backupText=${backupText.toString()};const backupIdentity=${backupIdentity.toString()};const backupInteger=${backupInteger.toString()};const backupBoolean=${backupBoolean.toString()};const backupArray=${backupArray.toString()};const backupRevision=${backupRevision.toString()};const backupApplication=${backupApplication.toString()};const readWhmBackupDestination=${readWhmBackupDestination.toString()};const readWhmBackupSchedule=${readWhmBackupSchedule.toString()};const readWhmBackupWorkspace=${readWhmBackupWorkspace.toString()};const backupStable=${backupStable.toString()};const backupUnknown=${backupUnknown.toString()};return ${bindWhmBackups.toString()};})()`
