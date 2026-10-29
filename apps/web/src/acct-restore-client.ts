/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import { readBackupFilesReply } from './whm-backup-files-client.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
// Module-local alias: the binding source refers to it by this name, defined again in ACCT_RESTORE_CLIENT_BINDING.
const readFilesReply = readBackupFilesReply
export type RestoreMoreMailbox = { address: string; messages: number; bytes: number; current: 'exists' | 'missing' }
export type RestoreMoreDatabase = { name: string; bytes: number; current: 'exists' | 'missing' }
export type RestoreMorePartState = 'available' | 'unavailable' | 'not-in-archive'
export type RestoreMoreInventory = { sha256: string; files: { files: number; bytes: number }; mail: { state: 'available' | 'unavailable'; mailboxes: RestoreMoreMailbox[]; truncated: boolean }; mailSettingsFiles: number
  databases: { state: RestoreMorePartState; databases: RestoreMoreDatabase[] }; dns: { state: RestoreMorePartState; zones: RestoreMoreDatabase[] } }
/** Accepted database restore: it runs on the server in the background and its per-database results are recorded and audited. */
export type RestoreMorePartsStarted = { restoreId: string; databases: string[]; zones: string[] }
export type RestoreMorePreview = { rows: { path: string; bytes: number }[]; counts: { messages: number; present: number; batch: number; remaining: number; refused: number }; quota: { limitMb: number | 'unlimited'; plannedBytes: number; fits: boolean }; writer: 'available' | 'unavailable'; revision: string }
export type RestoreMoreResult = 'restored' | 'skipped-exists' | 'failed' | 'not-attempted'
export type RestoreMoreRestore = { results: { path: string; result: RestoreMoreResult; reason: string | null; verificationRequired: boolean }[]; counts: Record<RestoreMoreResult, number>; complete: boolean; remaining: number; verificationRequired: boolean }
export type RestoreMoreExpected = { username: string; file: string; mailboxes?: string[]; revision?: string; databases?: string[]; zones?: string[]; sha256?: string }

/** Strict reply contract for /api/backups/components (apps/api/src/acct-restore-workspace.ts): bound to account, archive, mailboxes and revision. */
export function readRestoreMoreReply(kind: 'inventory', value: unknown, expected: RestoreMoreExpected): RestoreMoreInventory
export function readRestoreMoreReply(kind: 'preview', value: unknown, expected: RestoreMoreExpected): RestoreMorePreview
export function readRestoreMoreReply(kind: 'restore', value: unknown, expected: RestoreMoreExpected): RestoreMoreRestore
export function readRestoreMoreReply(kind: 'parts', value: unknown, expected: RestoreMoreExpected): RestoreMorePartsStarted
export function readRestoreMoreReply(kind: string, value: unknown, expected: RestoreMoreExpected): unknown {
  const bad = (): never => { throw new Error('invalid_restore_more_' + kind) }
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const count = (item: unknown): item is number => Number.isSafeInteger(item) && (item as number) >= 0
  const digest = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)
  const address = (item: unknown): item is string => typeof item === 'string' && /^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9.-]{1,253}$/.test(item)
  const selected = new Set(expected.mailboxes ?? [])
  const message = (item: unknown): item is string => {
    const match = typeof item === 'string' && item.length <= 4096 && !/[\u0000-\u001f\u007f\\]/.test(item) ? /^mail\/([^/]+)\/([^/]+)\/(?:\.[^/]+\/)?(?:cur|new)\/[^/]+$/.exec(item) : null
    return !!match && selected.has(match[2] + '@' + match[1])
  }
  const owned = (item: unknown): item is string => typeof item === 'string' && /^[a-z][a-z0-9]{0,15}_[a-z0-9_]{1,47}$/.test(item) && item.startsWith(expected.username + '_')
  const zone = (item: unknown): item is string => typeof item === 'string' && item.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(item)
  if (kind === 'parts') {
    if (!object(value) || !object(value.context) || value.context.username !== expected.username || !object(value.archive) || value.archive.file !== expected.file || value.archive.sha256 !== expected.sha256 || value.state !== 'running'
      || typeof value.restoreId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.restoreId) || !Array.isArray(value.databases) || value.databases.join('\n') !== (expected.databases ?? []).join('\n') || !value.databases.every(owned)
      || !Array.isArray(value.zones) || value.zones.join('\n') !== (expected.zones ?? []).join('\n') || !value.zones.every(zone)) return bad()
    return { restoreId: value.restoreId, databases: [...value.databases as string[]], zones: [...value.zones as string[]] }
  }
  if (!object(value) || !object(value.context) || value.context.username !== expected.username || !object(value.archive) || value.archive.file !== expected.file || value.archive.integrity !== 'verified' || !digest(value.archive.sha256)) return bad()
  if (kind === 'inventory') {
    const c = value.components
    if (!object(c) || !object(c.files) || !count(c.files.files) || !count(c.files.bytes) || !object(c.mail) || !['available', 'unavailable'].includes(c.mail.state as string) || !Array.isArray(c.mail.mailboxes) || c.mail.mailboxes.length > 1000 || typeof c.mail.truncated !== 'boolean'
      || !object(c.mailSettings) || c.mailSettings.state !== 'not-restorable' || !count(c.mailSettings.files) || !object(c.databases) || !['available', 'unavailable', 'not-in-archive'].includes(c.databases.state as string) || !Array.isArray(c.databases.databases) || c.databases.databases.length > 1000
      || (c.databases.state === 'not-in-archive') !== (c.databases.databases.length === 0) || !object(c.dns) || !['available', 'unavailable', 'not-in-archive'].includes(c.dns.state as string) || !Array.isArray(c.dns.zones) || c.dns.zones.length > 1000
      || (c.dns.state === 'not-in-archive') !== (c.dns.zones.length === 0)) return bad()
    const zones = c.dns.zones.map(row => object(row) && zone(row.name) && count(row.bytes) && (row.current === 'exists' || row.current === 'missing') ? { name: row.name, bytes: row.bytes, current: row.current } as RestoreMoreDatabase : bad())
    const databases = c.databases.databases.map(row => object(row) && owned(row.name) && count(row.bytes) && (row.current === 'exists' || row.current === 'missing') ? { name: row.name, bytes: row.bytes, current: row.current } as RestoreMoreDatabase : bad())
    const mailboxes = c.mail.mailboxes.map(box => object(box) && address(box.address) && count(box.messages) && count(box.bytes) && (box.current === 'exists' || box.current === 'missing') ? { address: box.address, messages: box.messages, bytes: box.bytes, current: box.current } as RestoreMoreMailbox : bad())
    if (new Set(mailboxes.map(box => box.address)).size !== mailboxes.length) return bad()
    return { sha256: value.archive.sha256, files: { files: c.files.files, bytes: c.files.bytes }, mail: { state: c.mail.state, mailboxes, truncated: c.mail.truncated }, mailSettingsFiles: c.mailSettings.files,
      databases: { state: c.databases.state as RestoreMorePartState, databases }, dns: { state: c.dns.state as RestoreMorePartState, zones } }
  }
  if (!Array.isArray(value.mailboxes) || value.mailboxes.join('\n') !== (expected.mailboxes ?? []).join('\n') || !digest(value.revision)) return bad()
  if (kind === 'preview') {
    const counts = value.counts, quota = value.quota
    if (!Array.isArray(value.rows) || value.rows.length > 500 || !object(counts) || ![counts.messages, counts.present, counts.batch, counts.remaining, counts.refused].every(count) || counts.batch !== value.rows.length
      || !object(quota) || typeof quota.fits !== 'boolean' || !count(quota.plannedBytes) || !(quota.limitMb === 'unlimited' || count(quota.limitMb)) || (value.writer !== 'available' && value.writer !== 'unavailable')) return bad()
    return { rows: value.rows.map(row => object(row) && message(row.path) && count(row.bytes) ? { path: row.path, bytes: row.bytes } : bad()), counts: { messages: counts.messages, present: counts.present, batch: counts.batch, remaining: counts.remaining, refused: counts.refused },
      quota: { limitMb: quota.limitMb, plannedBytes: quota.plannedBytes, fits: quota.fits }, writer: value.writer, revision: value.revision }
  }
  const states = ['restored', 'skipped-exists', 'failed', 'not-attempted'] as const, counts = value.counts
  if (value.revision !== expected.revision || !Array.isArray(value.results) || value.results.length > 500 || !object(counts) || typeof value.complete !== 'boolean' || typeof value.verificationRequired !== 'boolean' || !count(value.remaining)) return bad()
  const results = value.results.map(row => object(row) && message(row.path) && states.includes(row.result as RestoreMoreResult) && (row.reason === null || typeof row.reason === 'string' && /^[a-z-]{1,40}$/.test(row.reason)) && typeof row.verificationRequired === 'boolean'
    ? { path: row.path, result: row.result as RestoreMoreResult, reason: row.reason as string | null, verificationRequired: row.verificationRequired } : bad())
  if (states.some(state => counts[state] !== results.filter(row => row.result === state).length) || value.verificationRequired !== results.some(row => row.verificationRequired)) return bad()
  return { results, counts: { restored: counts.restored, 'skipped-exists': counts['skipped-exists'], failed: counts.failed, 'not-attempted': counts['not-attempted'] }, complete: value.complete, remaining: value.remaining, verificationRequired: value.verificationRequired }
}

function bindRestoreMore(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-restore-more-workspace]').forEach(root => {
    if (root.dataset.restoreMoreBound === 'true') return
    root.dataset.restoreMoreBound = 'true'
    const find = <T extends HTMLElement>(name: string): T | null => root.querySelector<T>('[data-restore-more-' + name + ']')
    const status = find('status'), account = find<HTMLSelectElement>('account'), archives = find('archives'), components = find('components'), mailboxes = find('mailboxes'), selectionNote = find('selection')
    const previewButton = find<HTMLButtonElement>('preview'), review = find('review'), ack = find<HTMLInputElement>('ack'), restoreButton = find<HTMLButtonElement>('restore'), results = find('results'), more = find<HTMLButtonElement>('continue'), steps = find('steps')
    if (!status || !account || !archives || !components || !mailboxes || !selectionNote || !previewButton || !review || !ack || !restoreButton || !results || !more || !steps) return
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.restoreMoreCanRead === 'true' && !root.closest(denied)
    if (!admitted()) return
    const canRestore = root.dataset.restoreMoreCanRestore === 'true', MAX_SELECTION = 50
    const selected = new Set<string>()
    let busy = false, username = '', file = '', inventory: RestoreMoreInventory | null = null, reviewed: (RestoreMorePreview & { mailboxes: string[] }) | null = null, again = false
    const REASONS: Record<string, string> = {
      format: msgid('not gzip-compressed tar data'), file: msgid('not a single regular file owned by the backup service'), size: msgid('larger than 2 GiB or too many entries'), unsafe: msgid('contains links, devices or unsafe paths'), changed: msgid('changed while it was inspected'),
      quota: msgid('the account disk quota refused the file'), 'parent-not-directory': msgid('a folder on the destination path is missing or is a file'), 'refused-by-writer': msgid('the confined writer refused this path, for example a link'), busy: msgid('the destination folder was busy'),
      'write-unknown': msgid('the write outcome is unknown; inspect the file'), 'directory-unknown': msgid('the folder outcome is unknown; inspect it'), 'readback-mismatch': msgid('the written file does not match the archive; inspect it'),
      'readback-unavailable': msgid('the written file could not be read back; inspect it'), 'archive-changed': msgid('the archive content changed after review'), 'archive-read': msgid('the archive could not be read further'),
      'authorization-changed': msgid('your authorization changed during the restore'), 'time-budget': msgid('not started within this request time limit; continue the restore'),
    }
    const reason = (code: string | null): string => code === null ? '' : REASONS[code] ? t(REASONS[code]!) : code
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const failure = (error: unknown): string => {
      const problem = (error ?? {}) as { code?: unknown; message?: unknown; details?: { verificationRequired?: unknown } }
      if (problem.details?.verificationRequired === true) return t('The mail restore outcome could not be verified. Inspect the mailboxes before trying again.')
      if (typeof problem.message === 'string' && /^invalid_(?:restore_more|backup_files)_/.test(problem.message)) return t('The server response could not be verified. Nothing is assumed.')
      const known: Record<string, string> = {
        FORBIDDEN: msgid('You are not authorized for this account or action.'), NOT_FOUND: msgid('The account or backup no longer exists.'), CONFLICT: msgid('The backup or selection changed. Review the restore again.'),
        LIMIT_EXCEEDED: msgid('The request exceeds a restore limit: files, size or disk quota.'), VALIDATION: msgid('The request was refused as invalid.'), PRECONDITION_FAILED: msgid('The server cannot do this now.'),
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
    const base = (): string => '/api/backups/components/' + encodeURIComponent(username)
    const sync = (): void => {
      account.disabled = busy || account.options.length < 2
      const writable = inventory?.mail.state === 'available'
      mailboxes.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(box => { box.checked = selected.has(box.value); box.disabled = busy || !writable || box.dataset.current !== 'exists' })
      previewButton.disabled = busy || !writable || !selected.size
      const restorable = canRestore && !!reviewed && reviewed.counts.batch > 0 && reviewed.quota.fits && reviewed.writer === 'available'
      if (!restorable) ack.checked = false
      ack.disabled = busy || !restorable
      restoreButton.disabled = busy || !restorable || !ack.checked
      more.hidden = !again; more.disabled = busy
      archives.querySelectorAll<HTMLButtonElement>('button[data-file]').forEach(button => { button.disabled = busy || button.dataset.rejected === 'true' })
      selectionNote.textContent = selected.size ? t('Mailboxes selected: {count} of 50.', { count: selected.size }) : t('No mailbox is selected. Up to 50 mailboxes can be selected.')
    }
    const resetFacts = (names: readonly string[]): void => names.forEach(name => fact(name, t('Not read')))
    const invalidate = (): void => { reviewed = null; ack.checked = false; fill(review, [], t('No restore has been reviewed.'), 2); resetFacts(['count-messages', 'count-present', 'count-batch', 'count-remaining', 'count-refused', 'planned', 'quota', 'writer']) }
    const resetResults = (): void => { again = false; fill(results, [], t('No restore has run.'), 3); resetFacts(['count-restored', 'count-skipped', 'count-failed', 'count-pending']) }
    const run = async (loading: string, operation: () => Promise<void>): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; sync(); note('loading', loading)
      try { await operation() } catch (error) { note('failed', failure(error)); if ((error as { code?: unknown } | null)?.code === 'CONFLICT') invalidate() }
      finally { busy = false; sync() }
    }
    const renderComponents = (view: RestoreMoreInventory | null): void => {
      const row = (name: string, contents: string, action: Node | string): HTMLTableRowElement => { const line = element('tr'); line.append(cell(name), cell(contents), cell(action)); return line }
      const link = element('a', t('Restore files')); link.href = '/whm/backups/files'; link.className = 'xp-btn'
      fill(components, view ? [
        row(t('Home files'), t('{count, plural, one {# file} other {# files}}, {size}', { count: view.files.files, size: size(view.files.bytes) }), view.files.files ? link : t('Nothing to restore')),
        row(t('Mail'), t('{count, plural, one {# mailbox} other {# mailboxes}}', { count: view.mail.mailboxes.length }), view.mail.state === 'available' ? t('Select mailboxes below') : t('Unavailable: the confined account file writer is not installed on this server')),
        row(t('Mail settings'), t('{count, plural, one {# file} other {# files}}', { count: view.mailSettingsFiles }), t('Not restored: account mail settings are rendered from saved configuration')),
        row(t('Databases'), t('Not in this backup'), t('Unavailable: server account backups contain no database dumps. Restore a database from its own export in Databases.')),
        row('DNS', t('Not in this backup'), t('Unavailable: DNS zones are rendered from saved configuration. Review the zone in DNS zones.')),
      ] : [], t('No backup has been opened.'), 3)
      fill(mailboxes, (view?.mail.mailboxes ?? []).map(box => {
        const line = element('tr'), check = element('input')
        check.type = 'checkbox'; check.value = box.address; check.dataset.current = box.current; check.setAttribute('aria-label', t('Select {name}', { name: box.address }))
        line.append(cell(check), cell(technical(box.address)), cell(technical(String(box.messages))), cell(technical(size(box.bytes))), cell(box.current === 'exists' ? t('Exists') : t('Missing: create the mailbox again before restoring its mail')))
        return line
      }), view ? t('This backup contains no mailbox messages.') : t('No backup has been opened.'), 5)
    }
    const renderArchives = (list: { file: string; bytes: number; createdAt: string; integrity: string; reason: string | null }[]): void => fill(archives, list.map(item => {
      const row = element('tr'), open = element('button', t(msgctxt('acct-restore-client', 'Open')))
      open.type = 'button'; open.className = 'xp-btn'; open.dataset.file = item.file; open.dataset.rejected = String(item.integrity === 'rejected')
      open.setAttribute('aria-label', t('Open backup {file}', { file: item.file }))
      row.append(cell(technical(displayDateTime(item.createdAt))), cell(technical(item.file)), cell(technical(size(item.bytes))), cell(item.integrity === 'rejected' ? t('Rejected: {reason}', { reason: reason(item.reason) }) : t('Not yet inspected; opening inspects every member')), cell(open))
      return row
    }), username ? t('This account has no backups in the server backup store.') : t('No account is selected.'), 5)
    const preview = (): Promise<void> => run(t('Reviewing the restore…'), async () => {
      const chosen = [...selected].sort()
      const view = readRestoreMoreReply('preview', await transport!('POST', base() + '/preview', { file, mailboxes: chosen }), { username, file, mailboxes: chosen })
      reviewed = { ...view, mailboxes: chosen }; ack.checked = false; resetResults(); step('review')
      fill(review, view.rows.map(item => { const line = element('tr'); line.append(cell(technical(item.path)), cell(technical(size(item.bytes)))); return line }), t('Every selected message is already present.'), 2)
      fact('count-messages', String(view.counts.messages)); fact('count-present', String(view.counts.present)); fact('count-batch', String(view.counts.batch)); fact('count-remaining', String(view.counts.remaining)); fact('count-refused', String(view.counts.refused))
      fact('planned', technical(size(view.quota.plannedBytes))); fact('quota', view.quota.limitMb === 'unlimited' ? t(msgctxt('acct-restore-client', 'Unlimited')) : (view.quota.fits ? t('Fits within {limit} MiB', { limit: view.quota.limitMb }) : t('Exceeds {limit} MiB', { limit: view.quota.limitMb })))
      fact('writer', view.writer === 'available' ? t('Available') : t('Not installed on this server'))
      note(view.quota.fits ? 'read' : 'failed', !view.quota.fits ? t('The selected messages exceed the account plan disk quota.') : view.writer !== 'available' ? t('The confined account file writer is not installed on this server; mail cannot be restored.')
        : !canRestore ? t('Restoring requires the edit-account privilege.') : view.counts.batch ? t('Review the list, confirm it, then restore.') : t('Every selected message is already present.'))
    })
    account.addEventListener('change', () => {
      if (busy) return
      username = account.value; file = ''; inventory = null; selected.clear(); invalidate(); resetResults(); renderArchives([]); renderComponents(null); resetFacts(['archive', 'sha256'])
      if (!username) { step('account'); sync(); return }
      const chosen = username
      void run(t('Reading backups…'), async () => {
        const listing = readFilesReply('archives', await transport!('GET', '/api/backups/files/' + encodeURIComponent(chosen)), { username: chosen })
        renderArchives(listing.archives); step('backup')
        note('read', listing.archives.length ? t('Open a backup to list its components.') : t('This account has no backups in the server backup store.'))
      })
    })
    archives.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button[data-file]')
      if (!button || button.disabled) return
      const chosen = button.dataset.file!
      void run(t('Inspecting every member of the archive…'), async () => {
        const view = readRestoreMoreReply('inventory', await transport!('POST', base() + '/inventory', { file: chosen }), { username, file: chosen })
        file = chosen; inventory = view; selected.clear(); invalidate(); resetResults()
        fact('archive', technical(chosen)); fact('sha256', technical(view.sha256)); renderComponents(view); step('components')
        note('read', view.mail.state === 'available' ? t('Select mailboxes that exist now, then review the mail restore.') : t('The confined account file writer is not installed on this server; mail cannot be restored.'))
      })
    })
    mailboxes.addEventListener('change', event => {
      const box = event.target as HTMLInputElement
      if (box.type !== 'checkbox') return
      if (busy) { sync(); return }
      if (box.checked && selected.size >= MAX_SELECTION) { box.checked = false; note('failed', t('At most 50 mailboxes can be selected.')); return }
      if (box.checked) selected.add(box.value); else selected.delete(box.value)
      invalidate(); sync()
    })
    previewButton.addEventListener('click', () => { if (!previewButton.disabled) void preview() })
    ack.addEventListener('change', () => sync())
    more.addEventListener('click', () => { if (!more.disabled) void preview() })
    restoreButton.addEventListener('click', () => {
      if (restoreButton.disabled) return
      void run(t('Restoring mail…'), async () => {
        const current = reviewed
        if (!current) return
        const view = readRestoreMoreReply('restore', await transport!('POST', base() + '/restore', { file, mailboxes: current.mailboxes, expectedRevision: current.revision }), { username, file, mailboxes: current.mailboxes, revision: current.revision })
        const label: Record<RestoreMoreResult, string> = { restored: msgid('Restored and verified'), 'skipped-exists': msgctxt('acct-restore-client', 'Skipped, already present'), failed: msgid('Failed'), 'not-attempted': msgctxt('acct-restore-client', 'Not attempted yet') }
        fill(results, view.results.map(row => { const line = element('tr'); line.dataset.result = row.result; line.append(cell(technical(row.path)), cell(t(label[row.result])), cell(reason(row.reason) + (row.verificationRequired ? ' ' + t('Verification required.') : ''))); return line }), t('No message was processed.'), 3)
        fact('count-restored', String(view.counts.restored)); fact('count-skipped', String(view.counts['skipped-exists'])); fact('count-failed', String(view.counts.failed)); fact('count-pending', String(view.counts['not-attempted']))
        reviewed = null; ack.checked = false; again = !view.complete || view.remaining > 0 || view.counts['not-attempted'] > 0; step('result')
        const summary = t('{restored} restored, {skipped} skipped, {failed} failed, {notAttempted} not attempted.', { restored: view.counts.restored, skipped: view.counts['skipped-exists'], failed: view.counts.failed, notAttempted: view.counts['not-attempted'] })
        note(view.counts.failed || view.verificationRequired ? 'failed' : 'read', summary + (view.verificationRequired ? ' ' + t('Some results require inspection of the mailboxes.') : again ? ' ' + t('Review again to restore the next messages.') : ''))
      })
    })
    void run(t('Reading accounts…'), async () => {
      const list = readFilesReply('accounts', await transport!('GET', '/api/backups/files'))
      const placeholder = element('option', list.length ? t('Choose an account') : t('No active accounts are visible'))
      placeholder.value = ''
      account.replaceChildren(placeholder, ...list.map(item => { const option = element('option', item.username + ' · ' + item.primaryDomain); option.value = item.username; return option }))
      note('read', list.length ? t('Choose an account to list its backups.') : t('No active accounts are visible to you.'))
    })
  })
}

export const ACCT_RESTORE_CLIENT_BINDING = `(()=>{const displayDateTime=${DISPLAY_DATETIME_BINDING};const readFilesReply=${readBackupFilesReply.toString()};const readRestoreMoreReply=${readRestoreMoreReply.toString()};return ${bindRestoreMore.toString()};})()`
