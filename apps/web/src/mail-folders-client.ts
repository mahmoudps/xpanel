/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatMailDateTime = formatDisplayDateTime

export type MailFolderRow = { folder: string; name: string; nameDecoded: boolean; leaf: string; parent: string | null; depth: number; delimiter: string | null; specialUse: string | null; system: boolean; selectable: boolean; subscribed: boolean | null; children: number; messages: number | null; unseen: number | null }
export type MailFolderList = { mailbox: string; observedAt: string; subscriptionsObserved: boolean; statusComplete: boolean; folders: MailFolderRow[] }
export type MailFolderChange = { operation: 'create' | 'rename' | 'delete' | 'subscribe' | 'unsubscribe'; folder: string; outcome: 'confirmed' | 'unknown'; view: MailFolderList }

/** Strict reader for GET /api/webmail/folders; the listing must belong to the sealed mailbox. */
export function readMailFolderList(value: unknown, mailbox: string): MailFolderList {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_mail_folders') }
  const text = (item: unknown, max: number): string => typeof item === 'string' && item.length > 0 && item.length <= max && !/[\u0000-\u001f\u007f]/.test(item) ? item : bad()
  const wire = (item: unknown): string => typeof item === 'string' && /^[\x20-\x7e]{1,1024}$/.test(item) ? item : bad()
  const count = (item: unknown, max: number): number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= max ? item : bad()
  const special = ['\\All', '\\Archive', '\\Drafts', '\\Flagged', '\\Junk', '\\Sent', '\\Trash']
  if (!object(value) || value.mailbox !== mailbox || typeof value.subscriptionsObserved !== 'boolean' || typeof value.statusComplete !== 'boolean'
    || typeof value.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAt) || !Array.isArray(value.folders) || value.folders.length > 2000) return bad()
  const folders = value.folders.map(raw => {
    if (!object(raw) || typeof raw.nameDecoded !== 'boolean' || typeof raw.system !== 'boolean' || typeof raw.selectable !== 'boolean'
      || (raw.subscribed !== null && typeof raw.subscribed !== 'boolean') || (raw.specialUse !== null && !special.includes(raw.specialUse as string))
      || (raw.delimiter !== null && (typeof raw.delimiter !== 'string' || !/^[\x21-\x7e]$/.test(raw.delimiter)))) return bad()
    return { folder: wire(raw.folder), name: text(raw.name, 4096), nameDecoded: raw.nameDecoded, leaf: text(raw.leaf, 1024), parent: raw.parent === null ? null : wire(raw.parent),
      depth: count(raw.depth, 64), delimiter: raw.delimiter as string | null, specialUse: raw.specialUse as string | null, system: raw.system, selectable: raw.selectable,
      subscribed: raw.subscribed as boolean | null, children: count(raw.children, 2000), messages: raw.messages === null ? null : count(raw.messages, Number.MAX_SAFE_INTEGER),
      unseen: raw.unseen === null ? null : count(raw.unseen, Number.MAX_SAFE_INTEGER) }
  })
  if (new Set(folders.map(item => item.folder)).size !== folders.length || (!value.subscriptionsObserved && folders.some(item => item.subscribed !== null))) return bad()
  return { mailbox, observedAt: value.observedAt, subscriptionsObserved: value.subscriptionsObserved, statusComplete: value.statusComplete, folders }
}

/** Strict reader for a folder mutation: confirmed or explicitly unknown, never an unflagged guess. */
export function readMailFolderChange(value: unknown, mailbox: string): MailFolderChange {
  const record = value as Record<string, unknown> | null
  if (!record || typeof record !== 'object' || !['create', 'rename', 'delete', 'subscribe', 'unsubscribe'].includes(record.operation as string)
    || !['confirmed', 'unknown'].includes(record.outcome as string) || record.stateChanged !== true || (record.outcome === 'unknown') !== (record.verificationRequired === true)
    || typeof record.folder !== 'string' || !/^[\x20-\x7e]{1,1024}$/.test(record.folder)) throw new Error('invalid_mail_folder_change')
  return { operation: record.operation as MailFolderChange['operation'], folder: record.folder, outcome: record.outcome as MailFolderChange['outcome'], view: readMailFolderList(record.view, mailbox) }
}

function bindMailFolders(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const special: Record<string, string> = { '\\All': t('All mail'), '\\Archive': t('Archive'), '\\Drafts': t('Drafts'), '\\Flagged': t('Flagged'), '\\Junk': t('Junk'), '\\Sent': t('Sent'), '\\Trash': t(msgctxt('mail-folders-client', 'Trash')) }
  const bdi = (value: string, dir = 'auto'): HTMLElement => { const item = document.createElement('bdi'); item.dir = dir; item.textContent = value; return item }
  const around = (text: string, node: Node): (string | Node)[] => { const [before = '', after = ''] = text.split('{folder}'); return [before, node, after] }
  document.querySelectorAll<HTMLElement>('[data-mail-folders]').forEach(root => {
    if (root.dataset.foldersBound === 'true') return
    root.dataset.foldersBound = 'true'
    const mailbox = root.dataset.foldersMailbox ?? ''
    const status = root.querySelector<HTMLElement>('[data-mail-folders-status]'), rows = root.querySelector<HTMLElement>('[data-mail-folders-rows]')
    const create = root.querySelector<HTMLFormElement>('[data-mail-folders-create]'), editor = root.querySelector<HTMLFormElement>('[data-mail-folders-editor]')
    const nameInput = create?.elements.namedItem('name') as HTMLInputElement | null, parentSelect = create?.elements.namedItem('parent') as HTMLSelectElement | null
    const renameInput = editor?.elements.namedItem('rename') as HTMLInputElement | null, confirmBox = editor?.elements.namedItem('confirm') as HTMLInputElement | null
    if (!status || !rows || !create || !editor || !nameInput || !parentSelect || !renameInput || !confirmBox) return
    const admitted = (): boolean => root.isConnected && root.dataset.foldersCanManage === 'true' && root.dataset.foldersMailbox === mailbox && !!mailbox && !root.closest(denied) && !!send
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const fact = (key: string, value: string): void => { const node = root.querySelector<HTMLElement>('[data-mail-folders-fact="' + key + '"]'); if (node) node.textContent = value }
    let busy = false, generation = 0, view: MailFolderList | null = null, editing: { mode: 'rename' | 'delete'; folder: MailFolderRow } | null = null
    const sync = (): void => {
      const blocked = !admitted() || busy
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = blocked || (control.matches('[data-mail-folders-subscribe]') && !view?.subscriptionsObserved) })
      root.setAttribute('aria-busy', String(busy))
    }
    const empty = (message: string): void => { rows.textContent = ''; const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = message; row.append(cell); rows.append(row) }
    const openEditor = (mode: 'rename' | 'delete', folder: MailFolderRow): void => {
      if (!admitted()) return
      editing = { mode, folder }
      const heading = editor.querySelector<HTMLElement>('[data-mail-folders-editor-heading]')!, text = editor.querySelector<HTMLElement>('[data-mail-folders-editor-text]')!
      const confirmText = editor.querySelector<HTMLElement>('[data-mail-folders-confirm-text]')!, submit = editor.querySelector<HTMLButtonElement>('[data-mail-folders-editor-submit]')!
      heading.textContent = mode === 'rename' ? t('Rename folder') : t('Delete folder')
      if (mode === 'rename') text.replaceChildren(...around(t('Messages and subfolders move with {folder}.'), bdi(folder.name)))
      else text.replaceChildren(folder.messages === null ? t('The message count could not be read. The server re-reads it before deleting.')
        : folder.messages ? t('This folder holds {messages} messages. They are deleted with the folder and cannot be recovered.', { messages: folder.messages })
        : t('This folder is empty.'))
      confirmText.replaceChildren(...around(folder.messages ? t('Delete {folder} and its {messages} messages permanently', { messages: folder.messages }) : t('Delete {folder}'), bdi(folder.name)))
      editor.querySelector<HTMLElement>('[data-mail-folders-rename-field]')!.hidden = mode !== 'rename'
      editor.querySelector<HTMLElement>('[data-mail-folders-confirm-field]')!.hidden = mode !== 'delete'
      renameInput.value = folder.leaf; confirmBox.checked = false
      submit.textContent = mode === 'rename' ? t('Save name') : t('Delete folder')
      editor.hidden = false; sync(); editor.focus()
    }
    const paint = (): void => {
      if (!view) return
      fact('observed', formatMailDateTime(view.observedAt)); fact('count', String(view.folders.length))
      const incomplete = root.querySelector<HTMLElement>('[data-mail-folders-incomplete]'); if (incomplete) incomplete.hidden = view.statusComplete
      const selected = parentSelect.value
      parentSelect.replaceChildren(new Option(t('Top level'), ''), ...view.folders.map(folder => new Option(folder.name, folder.folder)))
      parentSelect.value = view.folders.some(folder => folder.folder === selected) ? selected : ''
      rows.textContent = ''
      for (const folder of view.folders) {
        const row = document.createElement('tr'), cell = (): HTMLTableCellElement => { const td = document.createElement('td'); row.append(td); return td }
        const name = document.createElement('div'); name.className = 'xp-mail-folders__name'; name.style.paddingInlineStart = folder.depth * 16 + 'px'
        const label = document.createElement('strong'); label.append(bdi(folder.leaf)); name.append(label)
        if (folder.system) { const tag = document.createElement('span'); tag.className = 'xp-help'; tag.textContent = folder.specialUse ? special[folder.specialUse]! : t('System folder'); name.append(tag) }
        if (!folder.nameDecoded) { const raw = document.createElement('span'); raw.className = 'xp-help'; raw.textContent = t('Name shown as stored by the server'); name.append(raw) }
        cell().append(name)
        cell().append(bdi(folder.messages === null ? t('Not read') : String(folder.messages), 'ltr'))
        cell().append(bdi(folder.unseen === null ? t('Not read') : String(folder.unseen), 'ltr'))
        const shown = cell()
        if (folder.subscribed === null) shown.textContent = t('Unknown')
        else {
          const box = document.createElement('input'); box.type = 'checkbox'; box.checked = folder.subscribed; box.dataset.mailFoldersSubscribe = ''
          box.setAttribute('aria-label', t('Show {folder} in mail apps', { folder: folder.name }))
          box.addEventListener('change', () => { const subscribed = box.checked; box.checked = !subscribed; void mutate('/api/webmail/folders/subscription', { folder: folder.folder, subscribed }, subscribed ? t('The folder is shown in mail apps.') : t('The folder is hidden from mail apps.')) })
          shown.append(box)
        }
        const actions = cell()
        if (folder.system) actions.textContent = t('Protected')
        else {
          const wrap = document.createElement('div'); wrap.className = 'xp-mail-folders__row-actions'
          for (const [mode, text] of [['rename', t(msgctxt('mail-folders-client', 'Rename'))], ['delete', t('Delete')]] as const) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'xp-btn'; button.textContent = text
            button.setAttribute('aria-label', text + ' ' + folder.name); button.addEventListener('click', () => openEditor(mode, folder)); wrap.append(button)
          }
          actions.append(wrap)
        }
        rows.append(row)
      }
      if (!view.folders.length) empty(t('This mailbox has no folders.'))
      sync()
    }
    const failure = (error: unknown): string => {
      const problem = (error && typeof error === 'object' ? error : {}) as { status?: unknown; details?: Record<string, unknown> }, details = problem.details ?? {}
      if (problem.status === 403) return t('Folder management is not available for this mailbox. Nothing was changed.')
      if (details.unknownOutcome === true) return t('The outcome could not be verified. Read the folders again before retrying.')
      const messages: Record<string, string> = {
        folder_exists: t('A folder with that name already exists. Nothing was changed.'),
        protected_folder: t('System folders cannot be renamed or deleted, and their names are reserved. Nothing was changed.'),
        folder_not_empty: t('The folder still holds messages. Review the count and confirm again.'),
        folder_changed: t('The folder changed since it was read. Review the new count and confirm again.'),
        folder_has_children: t('Delete or move its subfolders first. Nothing was changed.'),
        mail_folder_name_invalid: t('Folder names use 1 to 64 characters without slashes, quotes, wildcards, the folder separator or a leading dot.'),
        mail_folder_refused: t('The mail server refused the change. Nothing was changed.'),
        mail_folder_missing: t('That folder no longer exists. Read the folders again.'),
      }
      return messages[details.reason as string] ?? (details.stateChanged === false ? t('The folder change was not made. Nothing was changed.') : t('The folder change could not be verified. Read the folders again before retrying.'))
    }
    const load = async (quiet = false): Promise<void> => {
      if (busy || !admitted() || !send) return
      const token = ++generation
      busy = true; sync(); if (!quiet) note('reading', t('Reading folders…'))
      try {
        const next = readMailFolderList(await send('GET', '/api/webmail/folders'), mailbox)
        if (token !== generation) return
        if (!admitted()) { view = null; empty(t('Nothing is shown.')); note('unavailable', t('Folder management is unavailable for this mailbox session. Nothing is shown.')); return }
        view = next; paint()
        if (!quiet) note('read', t('Folders read: {count}', { count: next.folders.length }))
      } catch (error) {
        if (token !== generation) return
        view = null; empty(t('Folders could not be read. Nothing is shown.'))
        note('failed', (error as { status?: unknown })?.status === 403 ? t('Folder management is not available for this mailbox. Nothing is shown.') : t('Folders could not be read or verified. Nothing is shown.'))
      } finally { if (token === generation) { busy = false; sync() } }
    }
    const mutate = async (path: string, body: Record<string, unknown>, done: string): Promise<void> => {
      if (busy || !admitted() || !send) return
      const token = ++generation
      let reread = false
      busy = true; sync(); note('saving', t('Saving the folder change…'))
      try {
        const change = readMailFolderChange(await send('POST', path, body), mailbox)
        if (token !== generation) return
        view = change.view; editing = null; editor.hidden = true; paint()
        note(change.outcome === 'confirmed' ? 'saved' : 'unknown', change.outcome === 'confirmed' ? done : t('The mail server accepted the change, but it could not be confirmed. Read the folders again before retrying.'))
        if (change.operation === 'create') nameInput.value = ''
      } catch (error) {
        if (token !== generation) return
        note('failed', failure(error))
        const details = (error as { details?: Record<string, unknown> })?.details ?? {}
        reread = details.unknownOutcome === true || ['folder_changed', 'folder_not_empty', 'mail_folder_missing'].includes(details.reason as string)
      } finally { if (token === generation) { busy = false; sync() } }
      if (reread && token === generation) { editing = null; editor.hidden = true; await load(true) }
    }
    if (!admitted()) { sync(); note('unavailable', t('Folder management is unavailable for this mailbox session. Nothing was read.')); return }
    create.addEventListener('submit', event => {
      event.preventDefault()
      const name = nameInput.value.trim()
      if (!name) { note('failed', t('Enter a folder name.')); nameInput.focus(); return }
      void mutate('/api/webmail/folders', { name, parent: parentSelect.value || null }, t('Folder created.'))
    })
    editor.addEventListener('submit', event => {
      event.preventDefault()
      const current = editing
      if (!current) return
      if (current.mode === 'rename') {
        const name = renameInput.value.trim()
        if (!name) { note('failed', t('Enter the new folder name.')); renameInput.focus(); return }
        void mutate('/api/webmail/folders/rename', { folder: current.folder.folder, name }, t('Folder renamed.'))
      } else {
        if (!confirmBox.checked) { note('failed', t('Confirm the deletion first.')); confirmBox.focus(); return }
        void mutate('/api/webmail/folders/delete', { folder: current.folder.folder, ...(current.folder.messages === null ? {} : { confirm: { folder: current.folder.folder, messages: current.folder.messages } }) }, t('Folder deleted.'))
      }
    })
    editor.querySelector<HTMLButtonElement>('[data-mail-folders-editor-cancel]')?.addEventListener('click', () => { editing = null; editor.hidden = true })
    root.querySelector<HTMLButtonElement>('[data-mail-folders-reload]')?.addEventListener('click', () => { void load() })
    sync(); void load()
  })
}

export const MAIL_FOLDERS_CLIENT_BINDING = `(()=>{const formatMailDateTime=${DISPLAY_DATETIME_BINDING};const readMailFolderList=${readMailFolderList.toString()};const readMailFolderChange=${readMailFolderChange.toString()};return ${bindMailFolders.toString()};})()`
