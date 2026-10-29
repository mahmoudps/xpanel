/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
export type BackupFilesAccountView = { username: string; primaryDomain: string }
export type BackupFilesArchiveView = { file: string; bytes: number; createdAt: string; integrity: 'unverified' | 'rejected'; reason: string | null }
export type BackupFilesListView = { archives: BackupFilesArchiveView[]; total: number; truncated: boolean }
export type BackupFilesBrowseView = { archive: { file: string; integrity: 'verified' | 'rejected'; reason: string | null; bytes: number | null; sha256: string | null }; folder: string; entries: { path: string; bytes: number }[] }
export type BackupFilesPreviewRow = { path: string; destination: string; bytes: number; action: 'restore' | 'refuse'; reason: string | null; exists: 'yes' | 'no' | 'unchecked' }
export type BackupFilesPreviewView = { rows: BackupFilesPreviewRow[]; counts: { restore: number; present: number; refused: number }; quota: { limitMb: number | 'unlimited'; plannedBytes: number; fits: boolean }; writer: 'available' | 'unavailable'; folder: string | null; revision: string }
export type BackupFilesResult = 'restored' | 'skipped-exists' | 'failed' | 'not-attempted'
export type BackupFilesResultRow = { path: string; destination: string; bytes: number; result: BackupFilesResult; reason: string | null; verificationRequired: boolean }
export type BackupFilesRestoreView = { results: BackupFilesResultRow[]; counts: Record<BackupFilesResult, number>; complete: boolean; verificationRequired: boolean }
export type BackupFilesExpected = { username?: string; file?: string; destination?: string; revision?: string }

/** Strict reply contract: every reply is bound to the requested account, archive, destination and revision. */
export function readBackupFilesReply(kind: 'accounts', value: unknown): BackupFilesAccountView[]
export function readBackupFilesReply(kind: 'archives', value: unknown, expected: BackupFilesExpected): BackupFilesListView
export function readBackupFilesReply(kind: 'browse', value: unknown, expected: BackupFilesExpected): BackupFilesBrowseView
export function readBackupFilesReply(kind: 'preview', value: unknown, expected: BackupFilesExpected): BackupFilesPreviewView
export function readBackupFilesReply(kind: 'restore', value: unknown, expected: BackupFilesExpected): BackupFilesRestoreView
export function readBackupFilesReply(kind: string, value: unknown, expected: BackupFilesExpected = {}): unknown {
  const bad = (): never => { throw new Error('invalid_backup_files_' + kind) }
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const count = (item: unknown): item is number => Number.isSafeInteger(item) && (item as number) >= 0
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length > 0 && item.length <= max && item.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/.test(item)
  const path = (item: unknown): item is string => text(item, 4096) && !item.startsWith('/') && !item.includes('\\') && item.split('/').every(part => part !== '' && part !== '.' && part !== '..')
  const target = (item: unknown): item is string => typeof item === 'string' && item.length <= 8192 && item.split('/').every(part => path(part))
  const digest = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)
  const user = /^[a-z][a-z0-9]{0,15}$/
  if (kind === 'accounts') {
    if (!object(value) || !Array.isArray(value.accounts) || value.accounts.length > 10000) return bad()
    return value.accounts.map(item => object(item) && typeof item.username === 'string' && user.test(item.username) && text(item.primaryDomain, 253) ? { username: item.username, primaryDomain: item.primaryDomain } : bad())
  }
  if (!user.test(expected.username ?? '') || !object(value) || !object(value.context) || value.context.username !== expected.username || typeof value.context.accountId !== 'string') return bad()
  const archiveName = new RegExp('^xpanel-backup-' + expected.username + '-[0-9]{8}T[0-9]{6}Z(?:-[a-f0-9]{12})?\\.tar\\.gz$')
  const created = (item: unknown): item is string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(item)
  const reasonCode = (item: unknown): item is string | null => item === null || typeof item === 'string' && /^[a-z][a-z-]{0,40}$/.test(item)
  if (kind === 'archives') {
    if (!Array.isArray(value.archives) || value.archives.length > 200 || !count(value.total) || value.total < value.archives.length || typeof value.truncated !== 'boolean') return bad()
    const archives = value.archives.map(item => object(item) && typeof item.file === 'string' && archiveName.test(item.file) && count(item.bytes) && created(item.createdAt) && (item.integrity === 'unverified' || item.integrity === 'rejected') && reasonCode(item.reason)
      ? { file: item.file, bytes: item.bytes, createdAt: item.createdAt, integrity: item.integrity, reason: item.reason } as BackupFilesArchiveView : bad())
    if (new Set(archives.map(item => item.file)).size !== archives.length) return bad()
    return { archives, total: value.total, truncated: value.truncated }
  }
  const archive = value.archive
  if (!object(archive) || archive.file !== expected.file) return bad()
  if (kind === 'browse') {
    const verified = archive.integrity === 'verified' && count(archive.bytes) && digest(archive.sha256)
    if (!verified && !(archive.integrity === 'rejected' && reasonCode(archive.reason)) || !text(value.folder, 64) || !/^restored-[0-9]{8}T[0-9]{6}Z(?:-[a-f0-9]{12})?$/.test(value.folder) || !Array.isArray(value.entries) || value.entries.length > 10000 || !verified && value.entries.length) return bad()
    const entries = value.entries.map(item => object(item) && path(item.path) && count(item.bytes) ? { path: item.path, bytes: item.bytes } : bad())
    return { archive: { file: archive.file, integrity: archive.integrity, reason: verified ? null : archive.reason, bytes: verified ? archive.bytes : null, sha256: verified ? archive.sha256 : null }, folder: value.folder, entries }
  }
  if (archive.integrity !== 'verified' || !digest(archive.sha256) || !object(value.destination) || value.destination.mode !== expected.destination || !digest(value.revision)) return bad()
  if (kind === 'preview') {
    const quota = value.quota, counts = value.counts
    if (!Array.isArray(value.rows) || value.rows.length > 500 || !object(quota) || !(quota.limitMb === 'unlimited' || count(quota.limitMb)) || !count(quota.plannedBytes) || typeof quota.fits !== 'boolean'
      || (value.writer !== 'available' && value.writer !== 'unavailable') || !object(counts)) return bad()
    const rows = value.rows.map(item => object(item) && path(item.path) && target(item.destination) && count(item.bytes) && (item.action === 'restore' && item.reason === null || item.action === 'refuse' && reasonCode(item.reason) && item.reason !== null)
      && (item.exists === 'yes' || item.exists === 'no' || item.exists === 'unchecked') ? { path: item.path, destination: item.destination, bytes: item.bytes, action: item.action, reason: item.reason, exists: item.exists } as BackupFilesPreviewRow : bad())
    const tally = { restore: rows.filter(row => row.action === 'restore' && row.exists !== 'yes').length, present: rows.filter(row => row.action === 'restore' && row.exists === 'yes').length, refused: rows.filter(row => row.action === 'refuse').length }
    if (counts.restore !== tally.restore || counts.present !== tally.present || counts.refused !== tally.refused) return bad()
    return { rows, counts: tally, quota: { limitMb: quota.limitMb, plannedBytes: quota.plannedBytes, fits: quota.fits }, writer: value.writer, folder: typeof value.destination.folder === 'string' ? value.destination.folder : null, revision: value.revision }
  }
  if (kind !== 'restore' || value.revision !== expected.revision || !Array.isArray(value.results) || value.results.length > 500 || !object(value.counts) || typeof value.complete !== 'boolean' || typeof value.verificationRequired !== 'boolean') return bad()
  const states: BackupFilesResult[] = ['restored', 'skipped-exists', 'failed', 'not-attempted']
  const results = value.results.map(item => object(item) && path(item.path) && target(item.destination) && count(item.bytes) && states.includes(item.result as BackupFilesResult) && reasonCode(item.reason) && typeof item.verificationRequired === 'boolean'
    ? { path: item.path, destination: item.destination, bytes: item.bytes, result: item.result, reason: item.reason, verificationRequired: item.verificationRequired } as BackupFilesResultRow : bad())
  const counts = Object.fromEntries(states.map(state => [state, results.filter(row => row.result === state).length])) as Record<BackupFilesResult, number>, reported = value.counts
  if (states.some(state => reported[state] !== counts[state]) || value.verificationRequired !== results.some(row => row.verificationRequired)) return bad()
  return { results, counts, complete: value.complete, verificationRequired: value.verificationRequired }
}

function bindWhmBackupFiles(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-backup-files-workspace]').forEach(root => {
    if (root.dataset.backupFilesBound === 'true') return
    root.dataset.backupFilesBound = 'true'
    const find = <T extends HTMLElement>(name: string): T | null => root.querySelector<T>('[data-backup-files-' + name + ']')
    const status = find('status'), account = find<HTMLSelectElement>('account'), archives = find('archives'), entries = find('entries'), pathView = find('path'), up = find<HTMLButtonElement>('up')
    const selectionNote = find('selection'), folderView = find('folder'), destination = find<HTMLFieldSetElement>('destination'), clear = find<HTMLButtonElement>('clear'), previewButton = find<HTMLButtonElement>('preview')
    const review = find('review'), ack = find<HTMLInputElement>('ack'), restoreButton = find<HTMLButtonElement>('restore'), results = find('results'), more = find<HTMLButtonElement>('continue'), steps = find('steps')
    if (!status || !account || !archives || !entries || !pathView || !up || !selectionNote || !folderView || !destination || !clear || !previewButton || !review || !ack || !restoreButton || !results || !more || !steps) return
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.backupFilesCanRead === 'true' && !root.closest(denied)
    if (!admitted()) return
    const canRestore = root.dataset.backupFilesCanRestore === 'true', MAX_SELECTION = 500, SHOWN = 1000
    const selected = new Set<string>()
    let busy = false, username = '', opened: BackupFilesBrowseView | null = null, directory = '', pending = 0
    let reviewed: (BackupFilesPreviewView & { paths: string[]; destination: string }) | null = null
    const REASONS: Record<string, string> = {
      format: msgid('not gzip-compressed tar data'), file: msgid('not a single regular file owned by the backup service'),
      size: msgid('larger than 2 GiB or too many entries'), unsafe: msgid('contains links, devices or unsafe paths'), changed: msgid('changed while it was inspected'),
      'too-large': msgid('larger than the 2 MiB confined write limit'), 'path-too-long': msgid('the destination path is too long'),
      'mail-preserved': msgid('mail data and settings are not restored in place'), reserved: msgid('the trash folder is managed by the file manager'),
      quota: msgid('the account disk quota refused the file'), 'parent-not-directory': msgid('a folder on the destination path is missing or is a file'),
      'refused-by-writer': msgid('the confined writer refused this path, for example a link'), busy: msgid('the destination folder was busy'),
      'write-unknown': msgid('the write outcome is unknown; inspect the file'), 'directory-unknown': msgid('the folder outcome is unknown; inspect it'),
      'readback-mismatch': msgid('the written file does not match the archive; inspect it'), 'readback-unavailable': msgid('the written file could not be read back; inspect it'),
      'archive-changed': msgid('the archive content changed after review'), 'archive-read': msgid('the archive could not be read further'),
      'authorization-changed': msgid('your authorization changed during the restore'), 'time-budget': msgid('not started within this request time limit; continue the restore'),
    }
    const reason = (code: string | null): string => code === null ? '' : REASONS[code] ? t(REASONS[code]!) : code
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const failure = (error: unknown): string => {
      const problem = (error ?? {}) as { code?: unknown; message?: unknown; details?: { verificationRequired?: unknown } }
      if (problem.details?.verificationRequired === true) return t('The restore outcome could not be verified. Inspect the account home before trying again.')
      if (typeof problem.message === 'string' && problem.message.startsWith('invalid_backup_files_')) return t('The server response could not be verified. Nothing is assumed.')
      const known: Record<string, string> = {
        FORBIDDEN: msgid('You are not authorized for this account or action.'), NOT_FOUND: msgid('The account or backup no longer exists.'),
        CONFLICT: msgid('The backup or selection changed. Review the restore again.'), LIMIT_EXCEEDED: msgid('The request exceeds a restore limit: files, size or disk quota.'),
        VALIDATION: msgid('The request was refused as invalid.'), PRECONDITION_FAILED: msgid('The server cannot do this now.'),
      }
      const copy = known[String(problem.code)], detail = typeof problem.message === 'string' ? ' ' + problem.message : ''
      return (copy ? t(copy) : t('The request failed.')) + detail
    }
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, value?: string): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; return node }
    const technical = (value: string): HTMLElement => { const node = element('bdi', value); node.dir = 'ltr'; return node }
    const size = (bytes: number): string => bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KiB' : bytes < 1073741824 ? (bytes / 1048576).toFixed(1) + ' MiB' : (bytes / 1073741824).toFixed(2) + ' GiB'
    const cell = (...nodes: (Node | string)[]): HTMLTableCellElement => { const td = element('td'); td.append(...nodes); return td }
    const fill = (body: HTMLElement, rows: HTMLTableRowElement[], empty: string, columns: number): void => {
      if (rows.length) { body.replaceChildren(...rows); return }
      const row = element('tr'), td = cell(empty); td.colSpan = columns; row.append(td); body.replaceChildren(row)
    }
    const fact = (name: string, value: Node | string): void => { find(name)?.replaceChildren(value) }
    const step = (name: string): void => steps.querySelectorAll<HTMLElement>('li').forEach(item => { if (item.dataset.step === name) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current') })
    const covered = (path: string): boolean => [...selected].some(item => path.startsWith(item + '/'))
    const base = (): string => '/api/backups/files/' + encodeURIComponent(username)
    const choice = (): string => destination.querySelector<HTMLInputElement>('input[type=radio]:checked')?.value === 'in-place' ? 'in-place' : 'new-folder'
    const sync = (): void => {
      const usable = !!opened && opened.archive.integrity === 'verified'
      account.disabled = busy || account.options.length < 2
      up.disabled = busy || !usable || !directory
      destination.disabled = busy || !usable
      destination.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.disabled = destination.disabled })
      clear.disabled = busy || !selected.size
      previewButton.disabled = busy || !usable || !selected.size
      const restorable = canRestore && !!reviewed && reviewed.counts.restore > 0 && reviewed.quota.fits && reviewed.writer === 'available'
      if (!restorable) ack.checked = false
      ack.disabled = busy || !restorable
      restoreButton.disabled = busy || !restorable || !ack.checked
      more.hidden = pending === 0; more.disabled = busy || !reviewed || !canRestore
      archives.querySelectorAll<HTMLButtonElement>('button[data-file]').forEach(button => { button.disabled = busy || button.dataset.rejected === 'true' })
      entries.querySelectorAll<HTMLButtonElement>('button[data-open]').forEach(button => { button.disabled = busy })
      entries.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(box => { const inherited = covered(box.value); box.checked = inherited || selected.has(box.value); box.disabled = busy || inherited })
      selectionNote.textContent = selected.size ? t('{count} of 500 files or folders selected. A selected folder includes everything inside it.', { count: selected.size }) : t('Nothing is selected. Up to 500 files or folders can be selected.')
    }
    const resetFacts = (names: readonly string[]): void => names.forEach(name => fact(name, t('Not read')))
    const invalidate = (): void => {
      reviewed = null; ack.checked = false
      fill(review, [], t('No restore has been reviewed.'), 4)
      resetFacts(['count-restore', 'count-present', 'count-refused', 'planned', 'quota', 'writer'])
    }
    const resetResults = (): void => { pending = 0; fill(results, [], t('No restore has run.'), 4); resetFacts(['count-restored', 'count-skipped', 'count-failed', 'count-pending']) }
    const run = async (loading: string, operation: () => Promise<void>): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; sync(); note('loading', loading)
      try { await operation() } catch (error) { note('failed', failure(error)); if ((error as { code?: unknown } | null)?.code === 'CONFLICT') invalidate() }
      finally { busy = false; sync() }
    }
    const renderArchives = (list: BackupFilesArchiveView[]): void => fill(archives, list.map(item => {
      const row = element('tr'), open = element('button', t(msgctxt('whm-backup-files-client', 'Open')))
      open.type = 'button'; open.className = 'xp-btn'; open.dataset.file = item.file; open.dataset.rejected = String(item.integrity === 'rejected')
      open.setAttribute('aria-label', t('Open backup {file}', { file: item.file }))
      row.append(cell(technical(displayDateTime(item.createdAt))), cell(technical(item.file)), cell(technical(size(item.bytes))),
        cell(item.integrity === 'rejected' ? t('Rejected: {reason}', { reason: reason(item.reason) }) : t('Not yet inspected; opening inspects every member')), cell(open))
      return row
    }), username ? t('This account has no backups in the server backup store.') : t('No account is selected.'), 5)
    const renderEntries = (): void => {
      pathView.textContent = '/' + directory
      if (!opened || opened.archive.integrity !== 'verified') { fill(entries, [], opened ? t('This archive failed inspection and cannot be browsed.') : t('No backup has been opened.'), 4); sync(); return }
      const prefix = directory ? directory + '/' : '', items = new Map<string, { name: string; path: string; folder: boolean; bytes: number; files: number }>()
      for (const entry of opened.entries) {
        if (!entry.path.startsWith(prefix)) continue
        const rest = entry.path.slice(prefix.length), cut = rest.indexOf('/'), name = cut < 0 ? rest : rest.slice(0, cut)
        const item = items.get(name) ?? { name, path: prefix + name, folder: cut >= 0, bytes: 0, files: 0 }
        item.bytes += entry.bytes; item.files++; items.set(name, item)
      }
      const sorted = [...items.values()].sort((a, b) => a.folder !== b.folder ? (a.folder ? -1 : 1) : a.name.localeCompare(b.name))
      const rows = sorted.slice(0, SHOWN).map(item => {
        const row = element('tr'), box = element('input')
        box.type = 'checkbox'; box.value = item.path; box.setAttribute('aria-label', t('Select {name}', { name: item.path }))
        let name: HTMLElement = technical(item.name)
        if (item.folder) { const open = element('button'); open.type = 'button'; open.className = 'xp-whm-backup-files__open'; open.dataset.open = item.path; open.append(technical(item.name + '/')); name = open }
        row.append(cell(box), cell(name), cell(item.folder ? t('Folder, {count} files', { count: item.files }) : t(msgctxt('whm-backup-files-client', 'File'))), cell(technical(size(item.bytes))))
        return row
      })
      if (sorted.length > SHOWN) { const row = element('tr'), td = cell(t('Only the first 1000 entries are shown. Select this folder from its parent to include all of them.')); td.colSpan = 4; row.append(td); rows.push(row) }
      fill(entries, rows, t('This folder is empty in the archive.'), 4)
      sync()
    }
    const renderReview = (view: BackupFilesPreviewView): void => {
      fill(review, view.rows.map(row => {
        const line = element('tr')
        const action = row.action === 'refuse' ? t('Not restored: {reason}', { reason: reason(row.reason) }) : row.exists === 'yes' ? t('Skip, already present') : row.exists === 'no' ? t('Restore') : t('Restore if still absent')
        line.append(cell(technical(row.path)), cell(technical(row.destination)), cell(technical(size(row.bytes))), cell(action))
        return line
      }), t('No file was selected.'), 4)
      fact('count-restore', String(view.counts.restore)); fact('count-present', String(view.counts.present)); fact('count-refused', String(view.counts.refused)); fact('planned', technical(size(view.quota.plannedBytes)))
      fact('quota', view.quota.limitMb === 'unlimited' ? t(msgctxt('whm-backup-files-client', 'Unlimited')) : (view.quota.fits ? t('Fits within {limit} MiB', { limit: view.quota.limitMb }) : t('Exceeds {limit} MiB', { limit: view.quota.limitMb })))
      fact('writer', view.writer === 'available' ? t('Available') : t('Not installed on this server'))
    }
    const renderResults = (view: BackupFilesRestoreView): void => {
      const label: Record<BackupFilesResult, string> = { restored: msgid('Restored and verified'), 'skipped-exists': msgctxt('whm-backup-files-client', 'Skipped, already present'), failed: msgid('Failed'), 'not-attempted': msgctxt('whm-backup-files-client', 'Not attempted yet') }
      fill(results, view.results.map(row => {
        const line = element('tr')
        line.dataset.result = row.result
        line.append(cell(technical(row.path)), cell(technical(row.destination)), cell(t(label[row.result])), cell(reason(row.reason) + (row.verificationRequired ? ' ' + t('Verification required.') : '')))
        return line
      }), t('No file was processed.'), 4)
      fact('count-restored', String(view.counts.restored)); fact('count-skipped', String(view.counts['skipped-exists'])); fact('count-failed', String(view.counts.failed)); fact('count-pending', String(view.counts['not-attempted']))
      pending = view.counts['not-attempted']
    }
    const restore = (): Promise<void> => run(t('Restoring files…'), async () => {
      const current = reviewed, file = opened?.archive.file
      if (!current || !file) return
      const view = readBackupFilesReply('restore', await transport!('POST', base() + '/restore', { file, paths: current.paths, destination: current.destination, expectedRevision: current.revision }), { username, file, destination: current.destination, revision: current.revision })
      renderResults(view); step('result')
      const summary = t('{restored} restored, {skipped} skipped, {failed} failed, {notAttempted} not attempted.', { restored: view.counts.restored, skipped: view.counts['skipped-exists'], failed: view.counts.failed, notAttempted: view.counts['not-attempted'] })
      note(view.counts.failed || view.verificationRequired ? 'failed' : 'read', summary + (view.verificationRequired ? ' ' + t('Some results require inspection of the account home.') : view.complete ? '' : ' ' + t('Continue the restore for the remaining files.')))
    })

    account.addEventListener('change', () => {
      if (busy) return
      username = account.value; opened = null; directory = ''; selected.clear(); invalidate(); resetResults(); renderArchives([]); renderEntries()
      resetFacts(['archive', 'integrity', 'sha256']); folderView.textContent = 'restored-…'
      if (!username) { step('account'); sync(); return }
      const chosen = username
      void run(t('Reading backups…'), async () => {
        const listing = readBackupFilesReply('archives', await transport!('GET', base()), { username: chosen })
        renderArchives(listing.archives); step('backup')
        note('read', !listing.archives.length ? t('This account has no backups in the server backup store.')
          : listing.truncated ? t('Showing the newest 200 of {total} backups. Open one to browse its files.', { total: listing.total }) : t('Open a backup to browse its files.'))
      })
    })
    archives.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button[data-file]')
      if (!button || button.disabled) return
      const file = button.dataset.file!
      void run(t('Inspecting every member of the archive…'), async () => {
        const view = readBackupFilesReply('browse', await transport!('POST', base() + '/browse', { file }), { username, file })
        opened = view; directory = ''; selected.clear(); invalidate(); resetResults()
        fact('archive', technical(file)); fact('sha256', view.archive.sha256 ? technical(view.archive.sha256) : t('Not available'))
        fact('integrity', view.archive.integrity === 'verified' ? t('Verified: every member is a regular file or folder') : t('Rejected: {reason}', { reason: reason(view.archive.reason) }))
        folderView.textContent = view.folder + '/'
        renderEntries()
        if (view.archive.integrity === 'verified') { step('files'); note('read', t('Select files or folders, then review the restore.')) }
        else note('failed', t('This archive failed integrity inspection. No file can be restored from it.'))
      })
    })
    entries.addEventListener('click', event => {
      const open = (event.target as Element).closest<HTMLButtonElement>('button[data-open]')
      if (!open || busy) return
      directory = open.dataset.open!; renderEntries()
    })
    up.addEventListener('click', () => { if (busy || !directory) return; directory = directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : ''; renderEntries() })
    entries.addEventListener('change', event => {
      const box = event.target as HTMLInputElement
      if (box.type !== 'checkbox') return
      if (busy) { sync(); return }
      if (box.checked) {
        if (selected.size >= MAX_SELECTION) { box.checked = false; note('failed', t('At most 500 files or folders can be selected.')); return }
        selected.add(box.value)
        // A selected folder already includes its descendants.
        for (const item of [...selected]) if (item.startsWith(box.value + '/')) selected.delete(item)
      } else selected.delete(box.value)
      invalidate(); sync()
    })
    destination.addEventListener('change', () => { invalidate(); sync() })
    clear.addEventListener('click', () => { selected.clear(); invalidate(); sync() })
    ack.addEventListener('change', () => sync())
    previewButton.addEventListener('click', () => {
      const file = opened?.archive.file, paths = [...selected].sort(), mode = choice()
      if (!file || !paths.length) return
      void run(t('Reviewing the restore…'), async () => {
        const view = readBackupFilesReply('preview', await transport!('POST', base() + '/preview', { file, paths, destination: mode }), { username, file, destination: mode })
        reviewed = { ...view, paths, destination: mode }; ack.checked = false; resetResults(); renderReview(view); step('review')
        note(view.quota.fits ? 'read' : 'failed', !view.quota.fits ? t('The selected files exceed the account plan disk quota.')
          : view.writer !== 'available' ? t('The confined account file writer is not installed on this server; files cannot be restored.')
          : !canRestore ? t('Restoring requires the edit-account privilege.')
          : view.counts.restore ? t('Review the list, confirm it, then restore.') : t('No selected file can be restored to this destination.'))
      })
    })
    restoreButton.addEventListener('click', () => { if (!restoreButton.disabled) void restore() })
    more.addEventListener('click', () => { if (!more.disabled) void restore() })

    void run(t('Reading accounts…'), async () => {
      const list = readBackupFilesReply('accounts', await transport!('GET', '/api/backups/files'))
      const placeholder = element('option', list.length ? t('Choose an account') : t('No active accounts are visible'))
      placeholder.value = ''
      account.replaceChildren(placeholder, ...list.map(item => { const option = element('option', item.username + ' · ' + item.primaryDomain); option.value = item.username; return option }))
      note('read', list.length ? t('Choose an account to list its backups.') : t('No active accounts are visible to you.'))
    })
  })
}

export const WHM_BACKUP_FILES_CLIENT_BINDING = `(()=>{const displayDateTime=${DISPLAY_DATETIME_BINDING};const readBackupFilesReply=${readBackupFilesReply.toString()};return ${bindWhmBackupFiles.toString()};})()`
