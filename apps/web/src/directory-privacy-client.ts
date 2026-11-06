import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />

/**
 * Directory privacy browser controller.
 *
 * Reads the account's protected folders through `/api/web-features/:username/directory-privacy` and saves
 * each changed folder with its own revision. The agent writes the folder's `.htaccess` block and
 * `~/.htpasswds/<folder>/passwd`; a folder is reported as protected by the web server only when Apache
 * answered 401 without credentials. Password hashes never reach the browser; an empty password keeps a user's.
 */

export interface DirectoryPrivacyUser { username: string; password: string; existing: boolean }
export interface DirectoryPrivacyRuleDraft { path: string; authName: string; enabled: boolean; users: DirectoryPrivacyUser[] }
export interface DirectoryPrivacyFolder { path: string; authName: string; enabled: boolean; users: string[]; revision: string; conflict: string | null; url: { domain: string; path: string } | null; directives: string[] }
export interface DirectoryPrivacySnapshot {
  canSave: boolean
  folders: DirectoryPrivacyFolder[]
  application: { status: 'read' | 'saved'; httpStatus: number | null; protectionVerified: boolean | null }
}
export interface DirectoryPrivacyChange { path: string; revision: string | null; body: { path: string; enabled: boolean; authName: string; users: ({ username: string } | { username: string; password: string })[] } }
export type DirectoryPrivacyStatus = 'unavailable' | 'reading' | 'read' | 'saving' | 'saved' | 'stale' | 'failed' | 'uncertain'

const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const USERNAME = /^[A-Za-z0-9._-]{1,64}$/
const REVISION = /^[0-9a-f]{64}$/

export function directoryPrivacyObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
/** Account-relative folder such as public_html/private; surrounding slashes typed by a person are dropped. */
export function directoryPrivacyPath(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || unsafe.test(value)) throw new Error('invalid_directory_path')
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 512) throw new Error('invalid_directory_path')
  const segments = trimmed.replace(/^\/+/, '').replace(/\/+$/, '').split('/')
  if (!segments.length || segments[0]!.startsWith('.') || segments.some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) throw new Error('invalid_directory_path')
  return segments.join('/')
}
export function directoryPrivacyPrompt(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || unsafe.test(value) || /["\\]/.test(value)) throw new Error('invalid_directory_prompt')
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 128) throw new Error('invalid_directory_prompt')
  return trimmed
}
export function directoryPrivacyUsername(value: unknown): string {
  if (typeof value !== 'string' || !USERNAME.test(value.trim())) throw new Error('invalid_directory_username')
  return value.trim()
}
export function directoryPrivacyPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 1024 || unsafe.test(value)) throw new Error('invalid_directory_password')
  return value
}

/** Validates the agent-backed reply and refuses foreign-account or malformed payloads. */
export function directoryPrivacyConfig(value: unknown, username: string): DirectoryPrivacySnapshot {
  if (!directoryPrivacyObject(value) || !directoryPrivacyObject(value.context) || value.context.username !== username || !directoryPrivacyObject(value.capabilities) || typeof value.capabilities.canSave !== 'boolean'
    || !directoryPrivacyObject(value.application) || !['read', 'saved'].includes(value.application.status as string) || !Array.isArray(value.directories) || value.directories.length > 100) throw new Error('invalid_directory_privacy')
  const application = value.application
  const httpStatus = application.httpStatus === null || Number.isSafeInteger(application.httpStatus) ? application.httpStatus as number | null : (() => { throw new Error('invalid_directory_privacy') })()
  const protectionVerified = application.protectionVerified === null || typeof application.protectionVerified === 'boolean' ? application.protectionVerified as boolean | null : (() => { throw new Error('invalid_directory_privacy') })()
  const folders = value.directories.map(raw => {
    if (!directoryPrivacyObject(raw) || typeof raw.path !== 'string' || directoryPrivacyPath(raw.path) !== raw.path || typeof raw.enabled !== 'boolean' || typeof raw.authName !== 'string' || raw.authName.length > 128 || unsafe.test(raw.authName)
      || typeof raw.revision !== 'string' || !REVISION.test(raw.revision) || !Array.isArray(raw.users) || raw.users.length > 100 || raw.users.some(user => typeof user !== 'string' || !USERNAME.test(user)) || new Set(raw.users).size !== raw.users.length
      || !Array.isArray(raw.directives) || raw.directives.length > 8 || raw.directives.some(line => typeof line !== 'string' || line.length > 1024 || unsafe.test(line))) throw new Error('invalid_directory_privacy')
    const conflict = raw.conflict === null ? null : directoryPrivacyObject(raw.conflict) && typeof raw.conflict.code === 'string' && /^[a-z_]{1,40}$/.test(raw.conflict.code) ? raw.conflict.code : (() => { throw new Error('invalid_directory_privacy') })()
    const url = raw.url === null ? null : directoryPrivacyObject(raw.url) && typeof raw.url.domain === 'string' && typeof raw.url.path === 'string' && !unsafe.test(raw.url.domain + raw.url.path) ? { domain: raw.url.domain, path: raw.url.path } : (() => { throw new Error('invalid_directory_privacy') })()
    return { path: raw.path, authName: raw.authName, enabled: raw.enabled, users: [...raw.users as string[]], revision: raw.revision, conflict, url, directives: [...raw.directives as string[]] }
  })
  return { canSave: value.capabilities.canSave, folders, application: { status: application.status as 'read' | 'saved', httpStatus, protectionVerified } }
}

/** Current-value signature used to refuse silently overwriting another writer's change. */
export function directoryPrivacySignature(snapshot: DirectoryPrivacySnapshot): string {
  return JSON.stringify(snapshot.folders.map(folder => [folder.path, folder.revision]))
}

export function directoryPrivacyDraft(snapshot: DirectoryPrivacySnapshot): DirectoryPrivacyRuleDraft[] {
  return snapshot.folders.map(folder => ({ path: folder.path, authName: folder.authName, enabled: folder.enabled, users: folder.users.map(username => ({ username, password: '', existing: true })) }))
}

/** The saved `.htaccess` directives of every protected folder, exactly as the agent read them back. */
export function directoryPrivacyPreview(snapshot: DirectoryPrivacySnapshot): string {
  return snapshot.folders.filter(folder => folder.directives.length).map(folder => '# ' + folder.path + '/.htaccess\n' + folder.directives.join('\n')).join('\n\n')
}

/** One PUT per changed folder; a removed folder is saved unprotected with no users. Existing users without a new password keep theirs. */
export function directoryPrivacyChanges(draft: readonly DirectoryPrivacyRuleDraft[], snapshot: DirectoryPrivacySnapshot): DirectoryPrivacyChange[] {
  if (draft.length > 100) throw new Error('too_many_directory_rules')
  const seen = new Set<string>(), changes: DirectoryPrivacyChange[] = []
  for (const rule of draft) {
    const path = directoryPrivacyPath(rule.path)
    if (seen.has(path)) throw new Error('duplicate_directory_path')
    seen.add(path)
    if (typeof rule.enabled !== 'boolean' || rule.users.length > 100) throw new Error('invalid_directory_rule')
    const authName = rule.enabled || rule.authName.trim() ? directoryPrivacyPrompt(rule.authName) : ''
    const usernames = new Set<string>()
    const users = rule.users.map(user => {
      const username = directoryPrivacyUsername(user.username)
      if (usernames.has(username)) throw new Error('duplicate_directory_user')
      usernames.add(username)
      if (!user.password && !user.existing) throw new Error('password_required_for_new_users')
      return user.password ? { username, password: directoryPrivacyPassword(user.password) } : { username }
    })
    const saved = snapshot.folders.find(folder => folder.path === path)
    const same = saved && saved.enabled === rule.enabled && saved.authName === authName && saved.users.join(',') === users.map(user => user.username).join(',') && users.every(user => !('password' in user))
    if (!same) changes.push({ path, revision: saved?.revision ?? null, body: { path, enabled: rule.enabled, authName, users } })
  }
  for (const folder of snapshot.folders) if (!seen.has(folder.path)) changes.push({ path: folder.path, revision: folder.revision, body: { path: folder.path, enabled: false, authName: '', users: [] } })
  return changes
}

function bindDirectoryPrivacy(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const copy = (message: string, values?: MessageValues): string => xpT(message, values)
  void askDialog
  document.querySelectorAll<HTMLElement>('[data-directory-privacy]').forEach(root => {
    if (root.dataset.directoryPrivacyBound === 'true') return
    root.dataset.directoryPrivacyBound = 'true'
    const username = root.dataset.accountUsername ?? ''
    const rows = root.querySelector<HTMLTableSectionElement>('[data-directory-privacy-rows]')
    const status = root.querySelector<HTMLElement>('[data-directory-privacy-status]')
    const preview = root.querySelector<HTMLElement>('[data-directory-privacy-preview]')
    const previewWrap = root.querySelector<HTMLElement>('[data-directory-privacy-preview-wrap]')
    const addPath = root.querySelector<HTMLInputElement>('[data-directory-privacy-path]')
    const addPrompt = root.querySelector<HTMLInputElement>('[data-directory-privacy-prompt]')
    const addUsername = root.querySelector<HTMLInputElement>('[data-directory-privacy-username]')
    const addPassword = root.querySelector<HTMLInputElement>('[data-directory-privacy-password]')
    const addButton = root.querySelector<HTMLButtonElement>('[data-directory-privacy-add]')
    const saveButton = root.querySelector<HTMLButtonElement>('[data-directory-privacy-save]')
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!rows || !status) return
    const route = '/api/web-features/' + encodeURIComponent(username) + '/directory-privacy'
    const controls = (): (HTMLButtonElement | HTMLInputElement)[] => [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')]
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const eligible = (): boolean => root.isConnected && !root.closest(denied) && /^[a-z][a-z0-9]{0,15}$/.test(username)
    let draft: DirectoryPrivacyRuleDraft[] = []
    let baseline: DirectoryPrivacySnapshot | null = null
    let busy = false, uncertain = false
    // controls of folders whose files need review; rebuilt on every paint
    let conflicted = new Set<HTMLElement>()
    const setStatus = (message: string, kind: DirectoryPrivacyStatus): void => {
      status.hidden = !message
      status.dataset.state = kind
      status.setAttribute('role', kind === 'failed' || kind === 'uncertain' ? 'alert' : 'status')
      status.textContent = message
    }
    const lock = (): void => {
      const blocked = busy || uncertain || !eligible() || baseline?.canSave === false
      controls().forEach(control => { control.disabled = blocked || conflicted.has(control) })
    }
    const ruleSlots = ['path', 'prompt', 'users', 'enabled', 'remove']
    const userSlots = ['name-label', 'username', 'password-label', 'password', 'remove']
    const clone = (name: string, tag: string, slots: readonly string[]): HTMLElement => cloneClientTemplate(clientTemplate(root, name), tag, slots)
    try {
      const rule = clone('directory-privacy-rule', 'tr', ruleSlots)
      clientTemplateSlot(rule, 'path', 'bdi'); clientTemplateSlot(rule, 'users', 'div')
      if ((clientTemplateSlot(rule, 'enabled', 'input') as HTMLInputElement).type !== 'checkbox') throw new Error('invalid_directory_template')
      clientTemplateSlot(rule, 'remove', 'button')
      const user = clone('directory-privacy-user', 'div', userSlots)
      clientTemplateSlot(user, 'username', 'bdi'); clientTemplateSlot(user, 'password-label', 'label')
      if ((clientTemplateSlot(user, 'password', 'input') as HTMLInputElement).type !== 'password') throw new Error('invalid_directory_template')
      clientTemplateSlot(user, 'remove', 'button')
      clone('directory-privacy-empty', 'tr', ['message'])
    } catch {
      controls().forEach(control => { control.disabled = true })
      setStatus(copy('Directory privacy editing is unavailable here. No rules were read or changed.'), 'unavailable')
      return
    }
    const paint = (): void => {
      rows.textContent = ''
      conflicted = new Set()
      draft.forEach((rule, index) => {
        const row = clone('directory-privacy-rule', 'tr', ruleSlots); row.dataset.directoryPrivacyRule = rule.path
        clientTemplateSlot(row, 'path', 'bdi').textContent = rule.path
        clientTemplateSlot(row, 'prompt').textContent = rule.authName
        const list = clientTemplateSlot(row, 'users', 'div')
        const removeRule = clientTemplateSlot(row, 'remove', 'button') as HTMLButtonElement
        rule.users.forEach((user, userIndex) => {
          const line = clone('directory-privacy-user', 'div', userSlots)
          clientTemplateSlot(line, 'username', 'bdi').textContent = user.username
          clientTemplateSlot(line, 'name-label').textContent = copy('Username')
          const password = clientTemplateSlot(line, 'password', 'input') as HTMLInputElement
          password.id = 'directory-privacy-user-password-' + index + '-' + userIndex
          const passwordLabel = clientTemplateSlot(line, 'password-label', 'label') as HTMLLabelElement
          passwordLabel.htmlFor = password.id; passwordLabel.textContent = copy('Password')
          password.placeholder = user.existing ? copy('Leave empty to keep the current password') : copy('Password (required on save)')
          password.value = user.password
          password.dataset.directoryPrivacyUserPassword = user.username
          password.addEventListener('input', event => { user.password = (event.target as HTMLInputElement).value })
          const removeUser = clientTemplateSlot(line, 'remove', 'button') as HTMLButtonElement
          removeUser.textContent = copy('Remove user')
          removeUser.addEventListener('click', event => { event.stopPropagation(); if (busy || uncertain || !eligible()) return; rule.users.splice(userIndex, 1); paint(); lock() })
          list.appendChild(line)
        })
        const enabled = clientTemplateSlot(row, 'enabled', 'input') as HTMLInputElement
        enabled.checked = rule.enabled; enabled.dataset.directoryPrivacyEnabled = rule.path
        enabled.setAttribute('aria-label', copy('Enabled') + ': ' + rule.path)
        enabled.addEventListener('change', event => { rule.enabled = (event.target as HTMLInputElement).checked })
        removeRule.textContent = copy('Remove folder')
        removeRule.addEventListener('click', event => { event.stopPropagation(); if (removeRule.disabled || busy || uncertain || !eligible()) return; draft.splice(index, 1); paint(); lock() })
        if (baseline?.folders.some(folder => folder.path === rule.path && folder.conflict)) row.querySelectorAll<HTMLElement>('button,input').forEach(control => conflicted.add(control))
        rows.appendChild(row)
      })
      if (!draft.length) {
        const row = clone('directory-privacy-empty', 'tr', ['message'])
        clientTemplateSlot(row, 'message').textContent = baseline ? copy('No protected folders are saved.') : copy('Protected folders have not been read.')
        rows.appendChild(row)
      }
      const text = baseline ? directoryPrivacyPreview(baseline) : ''
      if (preview) preview.textContent = text
      if (previewWrap) previewWrap.hidden = !text
      lock()
    }
    const readMessage = (snapshot: DirectoryPrivacySnapshot): string => !snapshot.canSave ? copy('Directory privacy needs the Apache web server and an active account. Nothing can be changed now.')
      : snapshot.folders.some(folder => folder.conflict) ? copy('Some folders have access rules or edits this page does not manage. Review their .htaccess before changing them here.')
        : copy('Protected folders read from the account files.')
    const read = async (): Promise<void> => {
      if (busy) return
      busy = true; lock(); setStatus(copy('Reading saved protected folders…'), 'reading')
      try {
        const snapshot = directoryPrivacyConfig(await transport!('GET', route), username)
        baseline = snapshot; draft = directoryPrivacyDraft(snapshot)
        paint()
        setStatus(readMessage(snapshot), 'read')
      } catch {
        setStatus(copy('Saved protected folders could not be read. Nothing was changed.'), 'failed')
      } finally { busy = false; lock() }
    }
    const addRule = (): void => {
      if (busy || uncertain || !eligible()) return
      try {
        const path = directoryPrivacyPath(addPath?.value ?? '')
        if (draft.some(rule => rule.path === path)) throw new Error('duplicate_directory_path')
        const authName = directoryPrivacyPrompt(addPrompt?.value ?? '')
        const user = { username: directoryPrivacyUsername(addUsername?.value ?? ''), password: directoryPrivacyPassword(addPassword?.value ?? ''), existing: false }
        draft = [...draft, { path, authName, enabled: true, users: [user] }]
        if (addPath) addPath.value = ''
        if (addPrompt) addPrompt.value = ''
        if (addUsername) addUsername.value = ''
        if (addPassword) addPassword.value = ''
        paint()
        setStatus(copy('Folder added to the draft. Save to store it; nothing has been written yet.'), 'read')
      } catch (error) {
        const message = error instanceof Error && error.message === 'duplicate_directory_path' ? copy('That folder is already listed once.')
          : copy('Folder, prompt, username and a password of at least 8 characters are required.')
        setStatus(message, 'failed')
      }
    }
    const save = async (): Promise<void> => {
      if (busy || uncertain || !baseline || !eligible()) return
      let changes: DirectoryPrivacyChange[]
      try { changes = directoryPrivacyChanges(draft, baseline) } catch (error) {
        setStatus(error instanceof Error && error.message === 'password_required_for_new_users'
          ? copy('Enter a password for every new user.')
          : copy('Fix the protected-folder fields before saving. Nothing was sent.'), 'failed')
        return
      }
      if (!changes.length) { setStatus(copy('There are no changes to save.'), 'read'); return }
      busy = true; lock(); setStatus(copy('Verifying the saved rules before writing…'), 'saving')
      let dispatched = false
      const results: DirectoryPrivacySnapshot['application'][] = []
      try {
        const current = directoryPrivacyConfig(await transport!('GET', route), username)
        if (directoryPrivacySignature(current) !== directoryPrivacySignature(baseline)) {
          setStatus(copy('The saved rules changed elsewhere. Your draft is kept; refresh before saving again.'), 'stale')
          return
        }
        for (const change of changes) {
          let revision = change.revision
          if (revision === null) {
            const folder = directoryPrivacyConfig(await transport!('GET', route + '?path=' + encodeURIComponent(change.path)), username).folders[0]
            if (!folder || folder.path !== change.path || folder.conflict) { setStatus(copy('The folder {path} cannot be protected here. Check that it exists inside a site and has no other access rules.', { path: change.path }), 'failed'); return }
            revision = folder.revision
          }
          dispatched = true
          const saved = directoryPrivacyConfig(await transport!('PUT', route, { ...change.body, expectedRevision: revision }), username)
          const folder = saved.folders[0]
          if (saved.application.status !== 'saved' || saved.folders.length !== 1 || folder!.path !== change.path || folder!.enabled !== change.body.enabled || folder!.users.join(',') !== change.body.users.map(user => user.username).join(',')) throw new Error('readback_mismatch')
          results.push(saved.application)
        }
        baseline = directoryPrivacyConfig(await transport!('GET', route), username); draft = directoryPrivacyDraft(baseline)
        paint()
        const protectedResults = results.filter((_result, index) => changes[index]!.body.enabled)
        setStatus(protectedResults.some(result => result.protectionVerified === false) ? copy('Saved, but the web server did not ask for a password on a protected folder. Review it before relying on the protection.')
          : !protectedResults.length ? copy('Saved and read back.')
            : protectedResults.every(result => result.protectionVerified === true) ? copy('Saved. The web server now asks for a password on every protected folder that changed.')
              : copy('Saved and read back. The web server answer could not be checked for every folder.'), 'saved')
      } catch (error) {
        const detail = directoryPrivacyObject(error) && directoryPrivacyObject(error.details) ? error.details : {}
        const certain = directoryPrivacyObject(error) && (error.stateChanged === false || detail.stateChanged === false) && detail.unknownOutcome !== true && detail.verificationRequired !== true
        if (dispatched && !certain) {
          uncertain = true
          setStatus(copy('The save outcome is uncertain. Inspect the saved rules before retrying; no automatic retry was sent.'), 'uncertain')
        } else {
          setStatus(copy('The save was refused or its readback did not match. Your draft is kept and nothing was retried.'), 'failed')
        }
      } finally { busy = false; lock() }
    }
    if (!eligible() || typeof transport !== 'function') {
      controls().forEach(control => { control.disabled = true })
      setStatus(copy('Directory privacy editing is unavailable here. No rules were read or changed.'), 'unavailable')
      return
    }
    addButton?.addEventListener('click', event => { event.preventDefault(); addRule() })
    saveButton?.addEventListener('click', event => { event.preventDefault(); void save() })
    paint()
    void read()
  })
}

export const DIRECTORY_PRIVACY_CLIENT_BINDING = `(function(askDialog){const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const USERNAME=${USERNAME.toString()};const REVISION=${REVISION.toString()};const unsafe=${unsafe.toString()};const directoryPrivacyObject=${directoryPrivacyObject.toString()};const directoryPrivacyPath=${directoryPrivacyPath.toString()};const directoryPrivacyPrompt=${directoryPrivacyPrompt.toString()};const directoryPrivacyUsername=${directoryPrivacyUsername.toString()};const directoryPrivacyPassword=${directoryPrivacyPassword.toString()};const directoryPrivacyConfig=${directoryPrivacyConfig.toString()};const directoryPrivacySignature=${directoryPrivacySignature.toString()};const directoryPrivacyDraft=${directoryPrivacyDraft.toString()};const directoryPrivacyPreview=${directoryPrivacyPreview.toString()};const directoryPrivacyChanges=${directoryPrivacyChanges.toString()};(${bindDirectoryPrivacy.toString()})(askDialog);})`
