/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
const formatDisplayDateTime = canonicalFormatDisplayDateTime

const ACCOUNT_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024
const ACCOUNT_ARCHIVE_STATES = ['add', 'replace', 'unchanged', 'keep', 'preserve-mail'] as const
type ArchiveState = typeof ACCOUNT_ARCHIVE_STATES[number]
interface AccountArchive { file: string; bytes: number }
interface RestoreDifference { path: string; state: ArchiveState; archiveBytes: number | null; currentBytes: number | null }
interface RestorePreview { file: string; bytes: number; revision: string; archiveSha256: string; rows: RestoreDifference[]; counts: Record<ArchiveState, number> }
const backupObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const backupFile = (username: string, value: unknown): string => {
  if (!/^[a-z][a-z0-9]{0,15}$/.test(username) || typeof value !== 'string' || !new RegExp('^xpanel-backup-' + username + '-[0-9]{8}T[0-9]{6}Z(?:-[a-f0-9]{12})?\\.tar\\.gz$').test(value)) throw new Error('invalid_account_archive')
  return value
}
const backupContext = (value: unknown, accountId: string, username: string): Record<string, unknown> => {
  if (!backupObject(value) || !backupObject(value.context) || value.context.accountId !== accountId || value.context.username !== username || value.context.scope !== 'home' || value.context.mailPreserved !== true || value.context.maxBytes !== ACCOUNT_ARCHIVE_MAX_BYTES) throw new Error('invalid_backup_context')
  return value
}
const backupArchive = (value: unknown, username: string): AccountArchive => {
  if (!backupObject(value) || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0) throw new Error('invalid_archive_size')
  return { file: backupFile(username, value.file), bytes: Number(value.bytes) }
}
export function readAccountBackups(value: unknown, accountId: string, username: string): AccountArchive[] {
  const reply = backupContext(value, accountId, username)
  if (!Array.isArray(reply.backups) || reply.backups.length > 10000) throw new Error('invalid_account_archives')
  const archives = reply.backups.map(raw => backupArchive(raw, username))
  if (new Set(archives.map(item => item.file)).size !== archives.length) throw new Error('duplicate_account_archives')
  return archives.sort((a, b) => b.file.localeCompare(a.file))
}
export function readAccountBackupPreview(value: unknown, accountId: string, username: string, file: string): RestorePreview {
  const reply = backupContext(value, accountId, username), preview = reply.preview
  if (!backupObject(preview) || preview.file !== file || preview.scope !== 'home' || preview.mailPreserved !== true || typeof preview.revision !== 'string' || !/^[a-f0-9]{64}$/.test(preview.revision)
    || typeof preview.archiveSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(preview.archiveSha256) || !Number.isSafeInteger(preview.bytes) || Number(preview.bytes) <= 0 || Number(preview.bytes) > ACCOUNT_ARCHIVE_MAX_BYTES
    || !Array.isArray(preview.rows) || preview.rows.length > 20000 || !backupObject(preview.counts)) throw new Error('invalid_backup_preview')
  const counts = { add: 0, replace: 0, unchanged: 0, keep: 0, 'preserve-mail': 0 }, seen = new Set<string>()
  const rows: RestoreDifference[] = preview.rows.map(raw => {
    if (!backupObject(raw) || typeof raw.path !== 'string' || !raw.path || raw.path.length > 4096 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(raw.path) || seen.has(raw.path) || !ACCOUNT_ARCHIVE_STATES.includes(raw.state as ArchiveState)) throw new Error('invalid_backup_difference')
    for (const field of ['archiveBytes', 'currentBytes']) if (raw[field] !== null && (!Number.isSafeInteger(raw[field]) || Number(raw[field]) < 0)) throw new Error('invalid_difference_size')
    seen.add(raw.path); const state = raw.state as ArchiveState; counts[state]++
    return { path: raw.path, state, archiveBytes: raw.archiveBytes as number | null, currentBytes: raw.currentBytes as number | null }
  })
  for (const state of ACCOUNT_ARCHIVE_STATES) if (preview.counts[state] !== counts[state]) throw new Error('invalid_backup_difference_count')
  return { file, bytes: Number(preview.bytes), revision: preview.revision, archiveSha256: preview.archiveSha256, rows, counts }
}
function bindAccountBackup(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-account-backup]').forEach(root => {
    if (root.dataset.accountBackupBound === 'true') return
    root.dataset.accountBackupBound = 'true'
    const accountId = root.dataset.accountBackupAccount ?? '', username = root.dataset.accountBackupUsername ?? ''
    const status = root.querySelector<HTMLElement>('[data-account-backup-status]')!
    const select = root.querySelector<HTMLSelectElement>('[data-account-backup-select]')!
    const table = root.querySelector<HTMLElement>('[data-account-backup-archives]')!
    const differences = root.querySelector<HTMLElement>('[data-account-backup-differences]')!
    const confirmation = root.querySelector<HTMLInputElement>('[data-account-backup-confirmation]')!
    const acknowledgement = root.querySelector<HTMLInputElement>('[data-account-backup-ack]')!
    const download = root.querySelector<HTMLAnchorElement>('[data-account-backup-download]')!
    const csv = root.querySelector<HTMLAnchorElement>('[data-account-backup-csv]')!
    const limit = root.querySelector<HTMLElement>('[data-account-backup-diff-limit]')!
    const button = (key: string): HTMLButtonElement => root.querySelector<HTMLButtonElement>('[data-account-backup-' + key + ']')!
    if (!accountId || !username || !status || !select || !table || !differences || !confirmation || !acknowledgement || !download || !csv || !limit || ['refresh', 'create', 'preview', 'restore'].some(key => !button(key))) return
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const blocked = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.accountBackupManage === 'true' && !root.closest(blocked)
    let archiveTemplate: HTMLTemplateElement, differenceTemplate: HTMLTemplateElement, emptyTemplate: HTMLTemplateElement
    const columns = (target: HTMLElement): number => {
      const value = Number(target.dataset.xpColumns)
      if (!Number.isSafeInteger(value) || value < 1 || value > 32) throw new Error('invalid_backup_table_columns')
      return value
    }
    try {
      archiveTemplate = clientTemplate(root, 'account-backup-archive-row')
      differenceTemplate = clientTemplate(root, 'account-backup-difference-row')
      emptyTemplate = clientTemplate(root, 'account-backup-empty-row')
      const archiveRow = cloneClientTemplate(archiveTemplate, 'tr', ['file', 'created', 'bytes', 'integrity']) as HTMLTableRowElement
      const differenceRow = cloneClientTemplate(differenceTemplate, 'tr', ['path', 'result', 'archive-bytes', 'current-bytes']) as HTMLTableRowElement
      if (archiveRow.cells.length !== columns(table) || differenceRow.cells.length !== columns(differences)) throw new Error('invalid_backup_table_shape')
      cloneClientTemplate(emptyTemplate, 'tr', ['message'])
      clientTemplateSlot(archiveRow, 'created', 'time')
    } catch {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true })
      status.dataset.state = 'unavailable'; status.textContent = t('Account backup service is unavailable here. No archive was read or changed.'); return
    }
    let archives: AccountArchive[] = [], selected = '', preview: RestorePreview | null = null
    let loaded = false, busy = false, uncertain = false, confirming = false
    const announce = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const selectedArchive = (): AccountArchive | null => archives.find(item => item.file === selected) ?? null
    const available = (): boolean => { const current = selectedArchive(); return !!current && current.bytes > 0 && current.bytes <= ACCOUNT_ARCHIVE_MAX_BYTES }
    const controls = (): void => {
      const locked = !admitted() || !loaded || busy || confirming || uncertain
      button('refresh').disabled = !admitted() || busy || confirming
      button('create').disabled = locked
      button('preview').disabled = locked || !available()
      select.disabled = locked || archives.length === 0
      confirmation.disabled = locked || !preview
      acknowledgement.disabled = locked || !preview
      button('restore').disabled = locked || !preview || preview.counts.add + preview.counts.replace === 0 || !acknowledgement.checked || confirmation.value !== username
      table.querySelectorAll<HTMLButtonElement>('[data-xp-action="review"]').forEach(action => {
        const archive = archives.find(item => item.file === action.dataset.accountBackupReview)
        action.disabled = locked || !archive || archive.bytes <= 0 || archive.bytes > ACCOUNT_ARCHIVE_MAX_BYTES
      })
      for (const link of [download, csv]) { link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true') }
      if (!locked && available()) { download.href = '/api/account/backups/' + encodeURIComponent(selected) + '/download'; download.setAttribute('download', selected); download.setAttribute('aria-disabled', 'false') }
      if (!locked && preview) { csv.href = '/api/account/backups/' + encodeURIComponent(selected) + '/preview.csv?revision=' + preview.revision; csv.setAttribute('aria-disabled', 'false') }
      root.setAttribute('aria-busy', String(busy || confirming))
    }
    const emptyRow = (target: HTMLElement, text: string): void => { const row = cloneClientTemplate(emptyTemplate, 'tr', ['message']); const td = clientTemplateSlot(row, 'message', 'td') as HTMLTableCellElement; td.colSpan = columns(target); td.textContent = text; target.append(row) }
    const clearPreview = (): void => {
      preview = null; confirmation.value = ''; acknowledgement.checked = false
      differences.textContent = ''; emptyRow(differences, t('No archive has been compared.'))
      root.querySelectorAll<HTMLElement>('[data-account-backup-count]').forEach(count => { count.textContent = t(msgctxt('account-backup-client', 'Not read')) })
      limit.hidden = true
    }
    const paintArchives = (wanted = selected): void => {
      selected = archives.some(item => item.file === wanted) ? wanted : archives[0]?.file ?? ''
      select.textContent = ''; table.textContent = ''
      for (const archive of archives) {
        const option = document.createElement('option'); option.value = archive.file; option.textContent = archive.file; select.append(option)
        const stamp = /-([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z/.exec(archive.file)
        const date = stamp ? stamp[1] + '-' + stamp[2] + '-' + stamp[3] + 'T' + stamp[4] + ':' + stamp[5] + ':' + stamp[6] + 'Z' : ''
        const createdAt = date && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 19) === date.slice(0, 19) ? date : null
        const created = createdAt ? formatDisplayDateTime(createdAt) : t(msgctxt('account-backup-client', 'Not read'))
        const row = cloneClientTemplate(archiveTemplate, 'tr', ['file', 'created', 'bytes', 'integrity'])
        clientTemplateSlot(row, 'file').textContent = archive.file
        clientTemplateSlot(row, 'bytes').textContent = String(archive.bytes)
        const time = clientTemplateSlot(row, 'created', 'time') as HTMLTimeElement; time.textContent = created
        if (createdAt) time.dateTime = createdAt; else time.removeAttribute('datetime')
        clientTemplateSlot(row, 'integrity').textContent = archive.bytes <= 0 || archive.bytes > ACCOUNT_ARCHIVE_MAX_BYTES ? t('Empty or over the 2 GiB limit') : t('Stored; not yet inspected')
        row.querySelectorAll<HTMLButtonElement>('[data-xp-action="review"]').forEach(action => {
          action.dataset.accountBackupReview = archive.file
          action.disabled = !admitted() || archive.bytes <= 0 || archive.bytes > ACCOUNT_ARCHIVE_MAX_BYTES
          action.addEventListener('click', () => {
            if (!admitted() || busy || confirming || uncertain || action.disabled) return
            selected = archive.file; select.value = selected; clearPreview(); controls(); void review()
          })
        })
        table.append(row)
      }
      if (!archives.length) emptyRow(table, t('The host returned no account archives.'))
      select.value = selected; clearPreview()
    }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => {
      if (!transport || !admitted()) return Promise.reject({ details: { stateChanged: false } })
      return body === undefined ? transport(method, path) : transport(method, path, body)
    }
    const read = async (): Promise<AccountArchive[]> => readAccountBackups(await request('GET', '/api/account/backups'), accountId, username)
    const confirm = async (title: string, message: string, danger = false): Promise<boolean> => {
      if (!askDialog) { announce('failed', t('Confirmation is unavailable. Nothing was sent.')); return false }
      confirming = true; controls()
      try { return await askDialog({ title, body: message, danger, confirm: t('Confirm') }) === true }
      catch { return false }
      finally { confirming = false; controls() }
    }
    const reload = async (): Promise<void> => {
      if (!admitted() || busy || confirming) return
      if (uncertain && !await confirm(t('Read the current archive state?'), t('No request is retried. Inspect archives and review restore differences again before continuing.'), true)) return
      if (!admitted() || busy || confirming) return
      busy = true; controls(); announce('reading', t('Reading actual account archives…'))
      try { archives = await read(); loaded = true; uncertain = false; paintArchives(); announce('read', t('Host archive listing read. Select an archive to inspect its restore differences.')) }
      catch { announce('failed', t('Account archives could not be read. Nothing was changed.')) }
      finally { busy = false; controls() }
    }
    const review = async (): Promise<void> => {
      if (!admitted() || busy || confirming || uncertain || !available()) return
      const file = selected; busy = true; controls(); announce('reading', t('Inspecting archive bytes and current home files…'))
      try {
        preview = readAccountBackupPreview(await request('POST', '/api/account/backups/' + encodeURIComponent(file) + '/preview', {}), accountId, username, file)
        differences.textContent = ''
        const label = (state: ArchiveState) => state === 'add' ? t('Add') : state === 'replace' ? t('Replace (recovery archive first)') : state === 'unchanged' ? t('Unchanged') : state === 'preserve-mail' ? t('Preserve mailbox/settings') : t('Keep current file')
        for (const entry of preview.rows.slice(0, 1000)) {
          const row = cloneClientTemplate(differenceTemplate, 'tr', ['path', 'result', 'archive-bytes', 'current-bytes'])
          for (const [slot, text] of [['path', entry.path], ['result', label(entry.state)], ['archive-bytes', entry.archiveBytes === null ? '—' : String(entry.archiveBytes)], ['current-bytes', entry.currentBytes === null ? '—' : String(entry.currentBytes)]]) clientTemplateSlot(row, slot!).textContent = text!
          differences.append(row)
        }
        if (!preview.rows.length) emptyRow(differences, t('No file differences were returned.'))
        root.querySelectorAll<HTMLElement>('[data-account-backup-count]').forEach(count => { const key = count.dataset.accountBackupCount as ArchiveState; count.textContent = String(preview!.counts[key]) })
        limit.hidden = preview.rows.length <= 1000
        limit.textContent = t('Showing the first 1000 rows. Download the full CSV for every reviewed difference.')
        confirmation.value = ''; acknowledgement.checked = false
        announce('reviewed', t('The archive and current home files were compared. Missing files and mailbox data/settings are kept.'))
      } catch { clearPreview(); announce('failed', t('The archive could not be safely compared. Restore stays unavailable and no files were changed.')) }
      finally { busy = false; controls() }
    }
    const mutate = async (kind: 'create' | 'restore'): Promise<void> => {
      if (!admitted() || busy || confirming || uncertain || !loaded || kind === 'restore' && button('restore').disabled) return
      const file = selected, reviewed = preview
      const message = kind === 'create' ? t('Create a home-file archive for {username}? Mail data and mail settings are separate.', { username }) : file + '\n' + t('Reviewed files will be replaced only after a recovery archive is created. Missing files and mailbox data/settings are kept.')
      if (!await confirm(kind === 'create' ? t('Create account archive') : t('Restore reviewed home files'), message, kind === 'restore') || !admitted()) return
      busy = true; controls()
      try {
        const path = kind === 'create' ? '/api/account/backups' : '/api/account/backups/' + encodeURIComponent(file) + '/restore'
        const raw = backupContext(await request('POST', path, kind === 'create' ? {} : { expectedRevision: reviewed!.revision, confirmation: username }), accountId, username)
        let saved: AccountArchive, recovery: AccountArchive | null = null
        if (kind === 'create') saved = backupArchive(raw.backup, username)
        else {
          if (!backupObject(raw.backup) || raw.backup.file !== file || raw.backup.scope !== 'home' || raw.backup.mailPreserved !== true || raw.backup.contentReadback !== 'matched') throw new Error('invalid_restore_ack')
          recovery = backupArchive(raw.backup.recovery, username)
          if (recovery.file === file) throw new Error('recovery_archive_must_be_separate')
          saved = recovery
        }
        if (saved.bytes <= 0 || saved.bytes > ACCOUNT_ARCHIVE_MAX_BYTES) throw new Error('invalid_archive_ack_size')
        const observed = await read()
        if (!observed.some(item => item.file === saved.file && item.bytes === saved.bytes)) throw new Error('archive_readback_mismatch')
        archives = observed; paintArchives(kind === 'create' ? saved.file : file)
        announce(kind === 'create' ? 'created' : 'restored', kind === 'create' ? t('Archive created and read back. It is available to download.') : t('Home-file content was restored and read back. Recovery archive retained: {file}', { file: recovery!.file }))
      } catch (error) {
        const details = backupObject(error) && backupObject(error.details) ? error.details : {}
        const refused = details.stateChanged === false && details.verificationRequired !== true && details.unknownOutcome !== true
        uncertain = !refused || backupObject(error) && error.status === 409
        announce(uncertain ? 'uncertain' : 'failed', uncertain ? t('The outcome requires review. Nothing was retried. Read archives and review the actual home-file differences before another action.') : t('The request was refused without changing files. The selected archive and review are kept.'))
      } finally { busy = false; controls() }
    }
    if (!transport || !admitted()) { root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true }); announce('unavailable', t('Account backup service is unavailable here. No archive was read or changed.')); return }
    select.addEventListener('change', () => { if (!select.disabled && admitted()) { selected = select.value; clearPreview(); controls() } })
    confirmation.addEventListener('input', controls); acknowledgement.addEventListener('change', controls)
    button('refresh').addEventListener('click', () => { void reload() })
    button('preview').addEventListener('click', () => { void review() })
    button('create').addEventListener('click', () => { void mutate('create') })
    button('restore').addEventListener('click', () => { void mutate('restore') })
    controls(); void reload()
  })
}
export const ACCOUNT_BACKUP_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const ACCOUNT_ARCHIVE_MAX_BYTES=${ACCOUNT_ARCHIVE_MAX_BYTES};const ACCOUNT_ARCHIVE_STATES=${JSON.stringify(ACCOUNT_ARCHIVE_STATES)};const backupObject=${backupObject.toString()};const backupFile=${backupFile.toString()};const backupContext=${backupContext.toString()};const backupArchive=${backupArchive.toString()};const readAccountBackups=${readAccountBackups.toString()};const readAccountBackupPreview=${readAccountBackupPreview.toString()};return ${bindAccountBackup.toString()};})()`
