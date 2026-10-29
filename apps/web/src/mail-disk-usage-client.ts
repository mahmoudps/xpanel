import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'

const formatMailDateTime = formatDisplayDateTime

type FolderSize = { state: 'measured'; bytes: number; method: 'status-size' | 'message-sizes' } | { state: 'not-measured'; reason: 'too-many-messages' | 'changed' | 'unavailable' }
export type MailboxUsageFolder = { folder: string; name: string; specialUse: string | null; messages: number | null; unseen: number | null; size: FolderSize }
export type MailboxUsage = {
  mailbox: string; observedAt: string; capabilities: { statusSize: boolean; quota: boolean; move: boolean; uidPlus: boolean }
  quota: { state: 'read'; root: string; usedBytes: number; limitBytes: number | null } | { state: 'no-storage-limit' | 'not-advertised' | 'unavailable' }
  folders: MailboxUsageFolder[]; omittedFolders: number; trash: string | null
}
export type CleanupCriteria = { olderThanDays?: number; largerThanMb?: number; seen?: true }
export type CleanupPreview = { folder: string; name: string; uidValidity: number; criteria: CleanupCriteria; matched: number; matchedBytes: number; batch: { uids: number[]; count: number; bytes: number }; trash: string | null; isTrash: boolean; capabilities: { move: boolean; uidPlus: boolean } }
export type CleanupResult = { operation: 'move-to-trash' | 'delete-permanently'; folder: string; requested: number; completed: number; outcome: 'confirmed' | 'partial' | 'unknown' }

const usageCount = (item: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0 || item > max) throw new Error('invalid_mail_usage')
  return item
}
const usageWire = (item: unknown): string => {
  if (typeof item !== 'string' || !/^[\x20-\x7e]{1,1024}$/.test(item)) throw new Error('invalid_mail_usage')
  return item
}

/** Strict reader for GET /api/webmail/disk-usage; sizes are either measured with a method or explicitly not measured. */
export function readMailboxUsage(value: unknown, mailbox: string): MailboxUsage {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_mail_usage') }
  const flags = (item: unknown, keys: string[]): Record<string, boolean> => object(item) && keys.every(key => typeof item[key] === 'boolean') ? item as Record<string, boolean> : bad()
  if (!object(value) || value.mailbox !== mailbox || typeof value.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAt)
    || !Array.isArray(value.folders) || value.folders.length > 500 || !object(value.quota) || (value.trash !== null && typeof value.trash !== 'string')) return bad()
  const capabilities = flags(value.capabilities, ['statusSize', 'quota', 'move', 'uidPlus'])
  const quota = value.quota
  const quotaView = quota.state === 'read'
    ? { state: 'read' as const, root: typeof quota.root === 'string' && quota.root.length <= 256 ? quota.root : bad(), usedBytes: usageCount(quota.usedBytes), limitBytes: quota.limitBytes === null ? null : usageCount(quota.limitBytes) }
    : ['no-storage-limit', 'not-advertised', 'unavailable'].includes(quota.state as string) ? { state: quota.state as 'no-storage-limit' } : bad()
  const folders = value.folders.map(raw => {
    if (!object(raw) || typeof raw.name !== 'string' || raw.name.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw.name) || !object(raw.size) || (raw.specialUse !== null && typeof raw.specialUse !== 'string')) return bad()
    const size = raw.size
    const sized: FolderSize = size.state === 'measured' && ['status-size', 'message-sizes'].includes(size.method as string) ? { state: 'measured', bytes: usageCount(size.bytes), method: size.method as 'status-size' }
      : size.state === 'not-measured' && ['too-many-messages', 'changed', 'unavailable'].includes(size.reason as string) ? { state: 'not-measured', reason: size.reason as 'changed' } : bad()
    return { folder: usageWire(raw.folder), name: raw.name, specialUse: raw.specialUse as string | null, messages: raw.messages === null ? null : usageCount(raw.messages), unseen: raw.unseen === null ? null : usageCount(raw.unseen), size: sized }
  })
  if (new Set(folders.map(item => item.folder)).size !== folders.length || (value.trash !== null && !folders.some(item => item.folder === value.trash))) return bad()
  return { mailbox, observedAt: value.observedAt, capabilities: capabilities as MailboxUsage['capabilities'], quota: quotaView, folders, omittedFolders: usageCount(value.omittedFolders, 100000), trash: value.trash as string | null }
}

/** Strict reader for a cleanup preview: the batch is a bounded subset of what matched, in one observed generation. */
export function readCleanupPreview(value: unknown, mailbox: string, folder: string): CleanupPreview {
  const record = value as Record<string, any> | null
  if (!record || typeof record !== 'object' || record.mailbox !== mailbox || record.folder !== folder || typeof record.name !== 'string' || typeof record.isTrash !== 'boolean'
    || !record.batch || !Array.isArray(record.batch.uids) || record.batch.uids.length > 5000 || !record.criteria || typeof record.criteria !== 'object' || !record.capabilities) throw new Error('invalid_cleanup_preview')
  const uids = record.batch.uids.map((uid: unknown) => usageCount(uid, 0xffffffff))
  const criteria: CleanupCriteria = {}
  for (const [key, item] of Object.entries(record.criteria)) {
    if (key === 'seen' && item === true) criteria.seen = true
    else if ((key === 'olderThanDays' || key === 'largerThanMb') && typeof item === 'number' && Number.isSafeInteger(item) && item > 0) criteria[key] = item
    else throw new Error('invalid_cleanup_preview')
  }
  const matched = usageCount(record.matched, 50000), uidValidity = usageCount(record.uidValidity, 0xffffffff)
  if (!uidValidity || !Object.keys(criteria).length || uids.includes(0) || new Set(uids).size !== uids.length || uids.length !== Math.min(matched, 5000) || usageCount(record.batch.count) !== uids.length
    || typeof record.capabilities.move !== 'boolean' || typeof record.capabilities.uidPlus !== 'boolean' || (record.trash !== null && typeof record.trash !== 'string')) throw new Error('invalid_cleanup_preview')
  return { folder, name: record.name, uidValidity, criteria, matched, matchedBytes: usageCount(record.matchedBytes), batch: { uids, count: uids.length, bytes: usageCount(record.batch.bytes) },
    trash: record.trash, isTrash: record.isTrash, capabilities: { move: record.capabilities.move, uidPlus: record.capabilities.uidPlus } }
}

export function readCleanupResult(value: unknown, folder: string, requested: number): CleanupResult {
  const record = value as Record<string, any> | null
  if (!record || typeof record !== 'object' || record.folder !== folder || !['move-to-trash', 'delete-permanently'].includes(record.operation) || !['confirmed', 'partial', 'unknown'].includes(record.outcome)
    || record.requested !== requested || (record.outcome === 'confirmed') === (record.verificationRequired === true)) throw new Error('invalid_cleanup_result')
  const completed = usageCount(record.completed, requested)
  if (record.outcome === 'confirmed' && completed !== requested) throw new Error('invalid_cleanup_result')
  return { operation: record.operation, folder, requested, completed, outcome: record.outcome }
}

function bindMailDiskUsage(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const bytes = (value: number): string => value < 1024 ? value + ' B' : value < 1048576 ? (value / 1024).toFixed(1) + ' KiB' : value < 1073741824 ? (value / 1048576).toFixed(1) + ' MiB' : (value / 1073741824).toFixed(2) + ' GiB'
  const bdi = (value: string, dir = 'ltr'): HTMLElement => { const item = document.createElement('bdi'); item.dir = dir; item.textContent = value; return item }
  const notMeasured: Record<string, string> = { 'too-many-messages': t('Not measured: more than 50000 messages'), changed: t('Not measured: the folder changed while it was read'), unavailable: t('Not measured: the server did not answer') }
  document.querySelectorAll<HTMLElement>('[data-mail-disk-usage]').forEach(root => {
    if (root.dataset.usageBound === 'true') return
    root.dataset.usageBound = 'true'
    const mailbox = root.dataset.usageMailbox ?? ''
    const status = root.querySelector<HTMLElement>('[data-mail-usage-status]'), rows = root.querySelector<HTMLElement>('[data-mail-usage-rows]'), form = root.querySelector<HTMLFormElement>('[data-mail-usage-cleanup]')
    const panel = root.querySelector<HTMLElement>('[data-mail-usage-preview]'), apply = root.querySelector<HTMLButtonElement>('[data-mail-usage-apply]')
    const folderSelect = form?.elements.namedItem('folder') as HTMLSelectElement | null, age = form?.elements.namedItem('olderThanDays') as HTMLInputElement | null
    const size = form?.elements.namedItem('largerThanMb') as HTMLInputElement | null, seen = form?.elements.namedItem('seen') as HTMLInputElement | null
    const purgeConfirm = panel?.querySelector<HTMLInputElement>('[name="purgeConfirm"]')
    if (!status || !rows || !form || !panel || !apply || !folderSelect || !age || !size || !seen || !purgeConfirm) return
    const admitted = (): boolean => root.isConnected && root.dataset.usageCanManage === 'true' && root.dataset.usageMailbox === mailbox && !!mailbox && !root.closest(denied) && !!send
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const fact = (key: string, value: string): void => { const node = root.querySelector<HTMLElement>('[data-mail-usage-fact="' + key + '"]'); if (node) node.textContent = value }
    let busy = false, generation = 0, usage: MailboxUsage | null = null, preview: CleanupPreview | null = null
    const sync = (): void => {
      const blocked = !admitted() || busy
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = blocked })
      if (!blocked && preview) apply.disabled = !preview.batch.count || (preview.isTrash ? !preview.capabilities.uidPlus || !purgeConfirm.checked : !preview.capabilities.move || !preview.trash)
      root.setAttribute('aria-busy', String(busy))
    }
    const empty = (message: string): void => { rows.textContent = ''; const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = message; row.append(cell); rows.append(row) }
    const paint = (): void => {
      if (!usage) return
      fact('observed', formatMailDateTime(usage.observedAt))
      const meter = root.querySelector<HTMLMeterElement>('[data-mail-usage-meter]'), quotaNote = root.querySelector<HTMLElement>('[data-mail-usage-quota-note]')
      const quota = usage.quota
      fact('quota-used', quota.state === 'read' ? bytes(quota.usedBytes) : t('Not reported'))
      fact('quota-limit', quota.state === 'read' ? (quota.limitBytes === null ? t('No limit reported') : bytes(quota.limitBytes)) : t('Not reported'))
      if (meter) { meter.hidden = !(quota.state === 'read' && quota.limitBytes); if (quota.state === 'read' && quota.limitBytes) meter.value = Math.min(1, quota.usedBytes / quota.limitBytes) }
      if (quotaNote) {
        const message = quota.state === 'not-advertised' ? t('The mail server does not report quotas (RFC 9208), so no quota is shown.')
          : quota.state === 'unavailable' ? t('The mail server did not answer the quota request. No quota is shown.')
          : quota.state === 'no-storage-limit' ? t('The mail server reports no storage limit for this mailbox.') : ''
        quotaNote.hidden = !message; quotaNote.textContent = message
      }
      const measured = usage.folders.filter(item => item.size.state === 'measured')
      fact('total', measured.length === usage.folders.length && !usage.omittedFolders ? bytes(measured.reduce((sum, item) => sum + (item.size as { bytes: number }).bytes, 0)) : t('Not every folder was measured'))
      rows.textContent = ''
      const sorted = [...usage.folders].sort((left, right) => (right.size.state === 'measured' ? right.size.bytes : -1) - (left.size.state === 'measured' ? left.size.bytes : -1))
      for (const folder of sorted) {
        const row = document.createElement('tr'), cell = (value: string | Node): void => { const td = document.createElement('td'); td.append(value); row.append(td) }
        cell(bdi(folder.name, 'auto')); cell(bdi(folder.messages === null ? t('Not read') : String(folder.messages))); cell(bdi(folder.unseen === null ? t('Not read') : String(folder.unseen)))
        cell(folder.size.state === 'measured' ? bdi(bytes(folder.size.bytes)) : notMeasured[folder.size.reason]!)
        cell(folder.size.state === 'measured' ? (folder.size.method === 'status-size' ? t('Server folder size (RFC 8438)') : t('Sum of message sizes')) : '-')
        rows.append(row)
      }
      if (!usage.folders.length) empty(t('This mailbox has no readable folders.'))
      const selected = folderSelect.value
      folderSelect.replaceChildren(...usage.folders.map(item => new Option(item.name, item.folder)))
      if (usage.folders.some(item => item.folder === selected)) folderSelect.value = selected
      sync()
    }
    const load = async (quiet = false): Promise<void> => {
      if (busy || !admitted() || !send) return
      const token = ++generation
      busy = true; sync(); if (!quiet) note('reading', t('Reading disk usage…'))
      try {
        const next = readMailboxUsage(await send('GET', '/api/webmail/disk-usage'), mailbox)
        if (token !== generation) return
        usage = next; paint()
        if (!quiet) note('read', t('Disk usage read for folders: {count}', { count: next.folders.length }))
      } catch (error) {
        if (token !== generation) return
        usage = null; empty(t('Disk usage could not be read. Nothing is shown.'))
        note('failed', (error as { status?: unknown })?.status === 403 ? t('Disk usage is not available for this mailbox. Nothing is shown.') : t('Disk usage could not be read or verified. Nothing is shown.'))
      } finally { if (token === generation) { busy = false; sync() } }
    }
    const showPreview = (value: CleanupPreview): void => {
      preview = value
      const facts = panel.querySelector<HTMLElement>('[data-mail-usage-preview-facts]')!, info = panel.querySelector<HTMLElement>('[data-mail-usage-preview-note]')!
      facts.textContent = ''
      for (const [label, item] of [[t('Folder'), bdi(value.name, 'auto')], [t('Matching messages'), bdi(String(value.matched))], [t('Matching size'), bdi(bytes(value.matchedBytes))], [t('In this action'), bdi(value.batch.count + ' / ' + bytes(value.batch.bytes))]] as const) {
        const box = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.append(item); box.append(dt, dd); facts.append(box)
      }
      info.textContent = !value.matched ? t('No messages match these criteria. Nothing would change.')
        : value.isTrash ? (value.capabilities.uidPlus ? t('These messages are already in Trash. Deleting them is permanent and cannot be undone.') : t('This mail server cannot delete an exact set of messages safely, so permanent deletion is unavailable.'))
        : !value.trash ? t('This mailbox has no Trash folder, so messages cannot be moved.')
        : !value.capabilities.move ? t('This mail server cannot move messages (RFC 6851), so cleanup is unavailable.')
        : t('These messages move to Trash. You can restore them from Trash.')
      if (value.matched > value.batch.count) info.textContent += ' ' + t('One action includes at most 5000 messages. Preview again afterwards for the rest.')
      const purgeField = panel.querySelector<HTMLElement>('[data-mail-usage-purge-field]')!
      purgeField.hidden = !value.isTrash || !value.batch.count; purgeConfirm.checked = false
      panel.querySelector<HTMLElement>('[data-mail-usage-purge-text]')!.textContent = t('Delete these {count} messages permanently', { count: value.batch.count })
      apply.textContent = value.isTrash ? t('Delete permanently') : t('Move to Trash')
      panel.hidden = false; sync(); panel.focus()
    }
    const failure = (error: unknown, fallback: string): string => {
      const problem = (error && typeof error === 'object' ? error : {}) as { status?: unknown; details?: Record<string, unknown> }, details = problem.details ?? {}
      if (problem.status === 403) return t('Cleanup is not available for this mailbox. Nothing was changed.')
      if (details.unknownOutcome === true) return t('The cleanup outcome could not be verified. Read usage again before retrying.')
      const messages: Record<string, string> = {
        cleanup_set_changed: t('The previewed messages changed. Preview again. Nothing was changed.'),
        imap_folder_changed: t('The folder changed while it was read. Preview again. Nothing was changed.'),
        imap_message_set_changed: t('The previewed messages changed. Preview again. Nothing was changed.'),
        folder_too_large: t('This folder holds more than 50000 messages, so its cleanup cannot be measured here.'),
        cleanup_criteria_required: t('Choose at least one cleanup criterion.'),
        cleanup_refused: t('The mail server refused the cleanup. Nothing was changed.'),
        trash_missing: t('This mailbox has no Trash folder. Nothing was changed.'),
      }
      return messages[details.reason as string] ?? (problem.status === 409 ? messages.imap_folder_changed! : fallback)
    }
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (busy || !admitted() || !send || !usage) return
      const params = new URLSearchParams({ folder: folderSelect.value })
      if (age.value) params.set('olderThanDays', age.value)
      if (size.value) params.set('largerThanMb', size.value)
      if (seen.checked) params.set('seen', 'true')
      if ([...params.keys()].length < 2) { note('failed', t('Choose at least one cleanup criterion.')); return }
      const folder = folderSelect.value, token = ++generation
      preview = null; panel.hidden = true; busy = true; sync(); note('reading', t('Previewing cleanup…'))
      void (async () => {
        try {
          const value = readCleanupPreview(await send('GET', '/api/webmail/disk-usage/preview?' + params), mailbox, folder)
          if (token !== generation) return
          busy = false; showPreview(value); note('read', t('Matching messages: {count}', { count: value.matched }))
        } catch (error) {
          if (token !== generation) return
          note('failed', failure(error, t('The cleanup preview could not be read. Nothing was changed.')))
        } finally { if (token === generation) { busy = false; sync() } }
      })()
    })
    purgeConfirm.addEventListener('change', sync)
    root.querySelector<HTMLButtonElement>('[data-mail-usage-discard]')?.addEventListener('click', () => { preview = null; panel.hidden = true; sync() })
    root.querySelector<HTMLButtonElement>('[data-mail-usage-reload]')?.addEventListener('click', () => { void load() })
    apply.addEventListener('click', () => {
      const current = preview
      if (busy || !admitted() || !send || !current || !current.batch.count || (current.isTrash && !purgeConfirm.checked)) return
      const token = ++generation, purge = current.isTrash
      busy = true; sync(); note('saving', purge ? t('Deleting messages permanently…') : t('Moving messages to Trash…'))
      void (async () => {
        let reread = false
        try {
          const body = { folder: current.folder, uidValidity: current.uidValidity, criteria: current.criteria, uids: current.batch.uids, ...(purge ? { confirm: { folder: current.folder, count: current.batch.count } } : {}) }
          const result = readCleanupResult(await send('POST', purge ? '/api/webmail/disk-usage/purge' : '/api/webmail/disk-usage/cleanup', body), current.folder, current.batch.count)
          if (token !== generation) return
          preview = null; panel.hidden = true; reread = true
          note(result.outcome === 'confirmed' ? 'saved' : 'unknown', result.outcome === 'confirmed'
            ? (purge ? t('Messages deleted permanently: {count}', { count: result.completed }) : t('Messages moved to Trash: {count}', { count: result.completed }))
            : t('Only {completed} of {requested} messages were confirmed. Read usage again before retrying.', { completed: result.completed, requested: result.requested }))
        } catch (error) {
          if (token !== generation) return
          note('failed', failure(error, t('The cleanup could not be verified. Read usage again before retrying.')))
          preview = null; panel.hidden = true; reread = true
        } finally { if (token === generation) { busy = false; sync() } }
        if (reread && token === generation) await load(true)
      })()
    })
    if (!admitted()) { sync(); note('unavailable', t('Disk usage is unavailable for this mailbox session. Nothing was read.')); return }
    sync(); void load()
  })
}

export const MAIL_DISK_USAGE_CLIENT_BINDING = `(()=>{const formatMailDateTime=${DISPLAY_DATETIME_BINDING};const usageCount=${usageCount.toString()};const usageWire=${usageWire.toString()};const readMailboxUsage=${readMailboxUsage.toString()};const readCleanupPreview=${readCleanupPreview.toString()};const readCleanupResult=${readCleanupResult.toString()};return ${bindMailDiskUsage.toString()};})()`
