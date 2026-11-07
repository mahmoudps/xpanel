import { VIEW_RECORD_HELPERS, cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction } from './workspace-view-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction
/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

export interface LeechClientFolder {
  path: string; maxLogins: number; redirectUrl: string; alertEmail: string | null; disableUsers: boolean
  state: 'applied' | 'not_protected' | 'conflict' | 'outside_document_root' | 'pending'; flagged: string[]; disabled: string[]
}
export interface LeechClientView {
  context: { accountId: string; username: string }; state: 'default' | 'saved' | 'invalid'; revision: string; limit: number; updatedAt: string | null
  capabilities: { canSave: boolean; reason: 'engine' | 'monitor' | null }; folders: LeechClientFolder[]
}

/** Shape checks of the leech protection reply; the API owns the grammar and pins the agent status. */
export function readLeechView(value: unknown, username: string): LeechClientView {
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const names = (item: unknown): boolean => Array.isArray(item) && item.length <= 1000 && item.every(name => typeof name === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(name))
  const bad = (): never => { throw new Error('invalid_leech_view') }
  if (!object(value) || !object(value.context) || value.context.username !== username || !['default', 'saved', 'invalid'].includes(value.state) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)
    || !Number.isSafeInteger(value.limit) || value.limit < 1 || !object(value.capabilities) || typeof value.capabilities.canSave !== 'boolean' || ![null, 'engine', 'monitor'].includes(value.capabilities.reason)
    || !Array.isArray(value.folders) || value.folders.length > value.limit) return bad()
  for (const item of value.folders) {
    if (!object(item) || typeof item.path !== 'string' || item.path.length > 512 || !Number.isSafeInteger(item.maxLogins) || typeof item.redirectUrl !== 'string' || item.redirectUrl.length > 2048
      || !(item.alertEmail === null || typeof item.alertEmail === 'string') || typeof item.disableUsers !== 'boolean' || !['applied', 'not_protected', 'conflict', 'outside_document_root', 'pending'].includes(item.state)
      || !names(item.flagged) || !names(item.disabled)) return bad()
  }
  return value as LeechClientView
}

/** Folders that Directory Privacy protects now; only these can take a limit. */
export function protectedLeechFolders(value: unknown): string[] {
  const directories = value && typeof value === 'object' ? (value as Record<string, unknown>).directories : null
  if (!Array.isArray(directories)) throw new Error('invalid_directory_privacy')
  return directories.flatMap((item: { enabled?: unknown; path?: unknown } | null) => item?.enabled === true && typeof item.path === 'string' ? [item.path] : []).sort()
}

function bindLeechProtection(askDialog: unknown, parse: typeof readLeechView, folders: typeof protectedLeechFolders): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const confirm = typeof askDialog === 'function' ? askDialog as (options: Record<string, unknown>) => Promise<unknown> : null
  const blocked = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const FIELD: Record<string, string> = {
    path: msgid('Choose a folder that Directory privacy protects.'), range: msgid('Enter a whole number from 1 to 1000.'), url: msgid('Enter a full http or https address without a percent sign.'),
    email: msgid('Enter one email address or leave the field empty.'), too_many: msgid('There are too many folders with a limit. Remove one first.'), not_found: msgid('This folder has no saved limit any more. Read the list again.'),
  }
  const STATE: Record<LeechClientFolder['state'], string> = {
    applied: msgid('Active'), pending: msgid('Waiting for the server'), not_protected: msgid('The folder is not password protected'),
    conflict: msgid('Needs review in .htaccess'), outside_document_root: msgid('The folder is outside every site'),
  }
  document.querySelectorAll<HTMLElement>('[data-leech-protection]').forEach(root => {
    if (root.dataset.lpBound === 'true') return
    root.dataset.lpBound = 'true'
    const folder = root.querySelector<HTMLSelectElement>('[data-lp-folder]'), max = root.querySelector<HTMLInputElement>('[data-lp-max]'), url = root.querySelector<HTMLInputElement>('[data-lp-url]'), email = root.querySelector<HTMLInputElement>('[data-lp-email]')
    const disable = root.querySelector<HTMLInputElement>('[data-lp-disable]'), save = root.querySelector<HTMLButtonElement>('[data-lp-save]'), refresh = root.querySelector<HTMLButtonElement>('[data-lp-refresh]')
    const status = root.querySelector<HTMLElement>('[data-lp-status]'), error = root.querySelector<HTMLElement>('[data-lp-error]'), rows = root.querySelector<HTMLElement>('[data-lp-rows]')
    if (!folder || !max || !url || !email || !disable || !save || !refresh || !status || !error || !rows) return
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status') }
    const row = (item: LeechClientFolder): HTMLElement => cloneViewRecord(root, 'leech-row', 'tr', { path: item.path, limit: t('Logins per user: {count}', { count: item.maxLogins }), redirect: item.redirectUrl, state: t(STATE[item.state]), flagged: t('Users over the limit: {users}', { users: item.flagged.join(', ') || t('None') }), disabled: t('Disabled users: {users}', { users: item.disabled.join(', ') || t('None') }), 'edit-label': t('Edit'), 'remove-label': t('Remove') })
    try { viewAction(row({ path: '', maxLogins: 1, redirectUrl: '', alertEmail: null, disableUsers: false, state: 'pending', flagged: [], disabled: [] }), 'edit'); cloneViewRecord(root, 'leech-empty', 'tr', { message: '' }) }
    catch { root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select').forEach(control => { control.disabled = true }); note('unavailable', t('Leech protection is unavailable here. Nothing was read or changed.')); return }
    const username = root.dataset.lpUsername ?? ''
    const admitted = (): boolean => root.isConnected && root.dataset.lpManage === 'true' && !root.closest(blocked) && /^[a-z][a-z0-9]{0,15}$/.test(username) && typeof transport === 'function'
    let view: LeechClientView | null = null, protectedPaths: string[] = [], busy = false, review = false
    const ready = (): boolean => !busy && !review && admitted() && view !== null && view.state !== 'invalid' && view.capabilities.canSave
    const paint = (): void => {
      for (const control of [folder, max, url, email, disable, save]) control.disabled = !ready() || !protectedPaths.length
      refresh.disabled = busy || !admitted()
      const selected = folder.value
      folder.replaceChildren(...protectedPaths.map(path => { const option = document.createElement('option'); option.value = path; option.textContent = path; return option }))
      if (protectedPaths.includes(selected)) folder.value = selected
      rows.textContent = ''
      for (const item of view?.folders ?? []) {
        const line = row(item), edit = viewAction(line, 'edit'), remove = viewAction(line, 'remove')
        edit.disabled = !ready() || !protectedPaths.includes(item.path); remove.disabled = !ready()
        edit.addEventListener('click', () => { folder.value = item.path; max.value = String(item.maxLogins); url.value = item.redirectUrl; email.value = item.alertEmail ?? ''; disable.checked = item.disableUsers; max.focus() })
        remove.addEventListener('click', () => { void change({ remove: item.path }) })
        rows.append(line)
      }
      if (!rows.childElementCount) rows.append(cloneViewRecord(root, 'leech-empty', 'tr', { message: view ? t('No folder has a login limit.') : t('Not read.') }))
    }
    const readMessage = (current: LeechClientView): string => current.state === 'invalid' ? t('The saved settings need review by the server administrator. Nothing can be changed here.')
      : current.capabilities.reason === 'engine' ? t('Leech protection needs the Apache web server. Nothing can be changed now.')
        : current.capabilities.reason === 'monitor' ? t('This host does not observe sign-ins. Nothing can be changed now.')
          : !protectedPaths.length ? t('No folder is password protected yet. Protect a folder above first.') : t('Login limits were read from the saved settings.')
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; paint(); note('reading', t('Reading login limits…'))
      try {
        const current = parse(await transport!('GET', '/api/account/leech-protection'), username)
        protectedPaths = folders(await transport!('GET', '/api/web-features/' + encodeURIComponent(username) + '/directory-privacy'))
        view = current; review = false
        note(current.state === 'invalid' || !current.capabilities.canSave ? 'failed' : 'read', readMessage(current))
      } catch { view = null; note('failed', t('The login limits could not be read. Nothing was changed.')) }
      finally { busy = false; paint() }
    }
    const change = async (body: { folder: Record<string, unknown> } | { remove: string }): Promise<void> => {
      if (!ready() || !view) return
      if ('remove' in body && confirm && await confirm({ title: t('Remove this login limit?'), body: body.remove + '\n' + t('Users of this folder are no longer redirected. Users who were already disabled stay disabled until they get a new password.'), confirm: t('Remove'), danger: true }) !== true) return
      busy = true; error.hidden = true; paint(); note('saving', t('Saving…'))
      try {
        view = parse(await transport!('POST', '/api/account/leech-protection', { expectedRevision: view.revision, ...body }), username)
        const target = 'folder' in body ? view.folders.find(item => item.path === body.folder.path) : null
        note(target && target.state !== 'applied' ? 'warning' : 'saved', target && target.state !== 'applied' ? t('Saved, but the limit is not active: {state}.', { state: t(STATE[target.state]) }) : t('Saved and applied to the folder.'))
      } catch (reason) {
        const details = reason && typeof reason === 'object' ? (reason as Record<string, any>).details : null, code = Array.isArray(details?.fields) && typeof details.fields[0]?.code === 'string' ? details.fields[0].code : null
        if (code) { error.textContent = t(FIELD[code] ?? FIELD.path!); error.hidden = false; note('fields', t('The change was refused. Nothing was saved.')) }
        else if ((reason as Record<string, any>)?.status === 409 || details?.stateChanged !== false) { review = true; note('uncertain', t('The outcome needs review. No retry was sent. Read the list again before continuing.')) }
        else note('failed', t('The change was refused. Nothing was saved.'))
      } finally { busy = false; paint() }
    }
    paint()
    if (!admitted()) { refresh.disabled = true; note('unavailable', t('Leech protection is unavailable here. Nothing was read or changed.')); return }
    save.addEventListener('click', () => { void change({ folder: { path: folder.value, maxLogins: Number(max.value), redirectUrl: url.value.trim(), alertEmail: email.value.trim() || null, disableUsers: disable.checked } }) })
    refresh.addEventListener('click', () => { review = false; void load() })
    void load()
  })
}
export const ACCOUNT_LEECH_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const parse=${readLeechView.toString()};const folders=${protectedLeechFolders.toString()};const bind=${bindLeechProtection.toString()};return (askDialog)=>bind(askDialog,parse,folders);})()`
