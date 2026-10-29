import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />

/**
 * Directory privacy browser controller.
 *
 * Reads and writes the account's protected-directory rules through the real
 * `/api/web-features/:username/directory-privacy` route. Password hashes are never
 * returned by the server, so every saved user requires a freshly entered password;
 * the UI states that limitation explicitly instead of silently dropping users.
 * Everything here is saved configuration only: no web-server protection is claimed.
 */

export interface DirectoryPrivacyUser { username: string; password: string; existing: boolean }
export interface DirectoryPrivacyRuleDraft { path: string; authName: string; enabled: boolean; users: DirectoryPrivacyUser[] }
export interface DirectoryPrivacySnapshot {
  rules: { path: string; authName: string; enabled: boolean; users: string[] }[]
  compiledNginx: string
  compiledApache: string
  updatedAt: string
}
export type DirectoryPrivacyStatus = 'unavailable' | 'reading' | 'read' | 'saving' | 'saved' | 'stale' | 'failed' | 'uncertain'

const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const USERNAME = /^[A-Za-z0-9._-]{1,64}$/

export function directoryPrivacyObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function directoryPrivacyPath(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || unsafe.test(value)) throw new Error('invalid_directory_path')
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 512) throw new Error('invalid_directory_path')
  const segments = trimmed.replace(/^\/+/, '').replace(/\/+$/, '').split('/')
  if (!segments.length || segments.some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) throw new Error('invalid_directory_path')
  return '/' + segments.join('/')
}
export function directoryPrivacyPrompt(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || unsafe.test(value)) throw new Error('invalid_directory_prompt')
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

/** Validates the public GET reply and refuses foreign-account or malformed payloads. */
export function directoryPrivacyConfig(value: unknown, username: string): DirectoryPrivacySnapshot {
  if (!directoryPrivacyObject(value) || !directoryPrivacyObject(value.config)) throw new Error('invalid_directory_privacy')
  const config = value.config
  if (config.accountId !== undefined && typeof config.accountId !== 'string') throw new Error('invalid_directory_privacy')
  if (!Array.isArray(config.rules) || config.rules.length > 1000) throw new Error('invalid_directory_privacy')
  const rules = config.rules.map(raw => {
    if (!directoryPrivacyObject(raw)) throw new Error('invalid_directory_privacy')
    const path = typeof raw.path === 'string' ? directoryPrivacyPath(raw.path) : (() => { throw new Error('invalid_directory_privacy') })()
    if (typeof raw.authName !== 'string' || !raw.authName.isWellFormed() || unsafe.test(raw.authName)) throw new Error('invalid_directory_privacy')
    const authName = raw.authName.trim() || 'Protected Area'
    if (raw.authName.length > 128) throw new Error('invalid_directory_privacy')
    if (typeof raw.enabled !== 'boolean') throw new Error('invalid_directory_privacy')
    if (!Array.isArray(raw.users) || raw.users.length > 100) throw new Error('invalid_directory_privacy')
    const users = raw.users.map(user => {
      if (!directoryPrivacyObject(user) || typeof user.username !== 'string' || !USERNAME.test(user.username) || Object.keys(user).some(key => key !== 'username')) throw new Error('invalid_directory_privacy')
      return user.username
    })
    if (new Set(users).size !== users.length) throw new Error('invalid_directory_privacy')
    return { path, authName, enabled: raw.enabled, users }
  })
  const compiledNginx = typeof config.compiledNginx === 'string' ? config.compiledNginx : ''
  const compiledApache = typeof config.compiledApache === 'string' ? config.compiledApache : ''
  const updatedAt = typeof config.updatedAt === 'string' && Number.isFinite(Date.parse(config.updatedAt)) ? config.updatedAt : ''
  void username
  return { rules, compiledNginx, compiledApache, updatedAt }
}

/** Current-value signature used to refuse silently overwriting another writer's change. */
export function directoryPrivacySignature(snapshot: DirectoryPrivacySnapshot): string {
  return JSON.stringify({ rules: snapshot.rules.map(rule => ({ path: rule.path, authName: rule.authName, enabled: rule.enabled, users: [...rule.users].sort() })), updatedAt: snapshot.updatedAt })
}

export function directoryPrivacyDraft(snapshot: DirectoryPrivacySnapshot): DirectoryPrivacyRuleDraft[] {
  return snapshot.rules.map(rule => ({ path: rule.path, authName: rule.authName, enabled: rule.enabled, users: rule.users.map(username => ({ username, password: '', existing: true })) }))
}
export function directoryPrivacyDraftKey(rule: DirectoryPrivacyRuleDraft): string {
  const users = rule.users.map(user => user.username).sort().join(',')
  return JSON.stringify([rule.path, rule.authName, rule.enabled, users])
}
export function directoryPrivacyDraftMatchesSnapshot(draft: readonly DirectoryPrivacyRuleDraft[], snapshot: DirectoryPrivacySnapshot): boolean {
  if (draft.length !== snapshot.rules.length) return false
  return draft.every((rule, index) => directoryPrivacyDraftKey(rule) === directoryPrivacyDraftKey({ path: snapshot.rules[index]!.path, authName: snapshot.rules[index]!.authName, enabled: snapshot.rules[index]!.enabled, users: snapshot.rules[index]!.users.map(username => ({ username, password: '', existing: true })) }))
}

/** Exact server PUT body. Every kept user needs a freshly entered password. */
export function directoryPrivacyPayload(draft: readonly DirectoryPrivacyRuleDraft[]): { rules: { path: string; authName: string; enabled: boolean; users: { username: string; password: string }[] }[] } {
  if (!draft.length) return { rules: [] }
  if (draft.length > 1000) throw new Error('too_many_directory_rules')
  const seen = new Set<string>()
  const rules = draft.map(rule => {
    const path = directoryPrivacyPath(rule.path)
    if (seen.has(path)) throw new Error('duplicate_directory_path')
    seen.add(path)
    const authName = directoryPrivacyPrompt(rule.authName)
    if (typeof rule.enabled !== 'boolean') throw new Error('invalid_directory_rule')
    if (rule.users.length > 100) throw new Error('too_many_directory_users')
    const usernames = new Set<string>()
    const users = rule.users.map(user => {
      const username = directoryPrivacyUsername(user.username)
      if (usernames.has(username)) throw new Error('duplicate_directory_user')
      usernames.add(username)
      if (!user.password) throw new Error('password_required_for_existing_users')
      return { username, password: directoryPrivacyPassword(user.password) }
    })
    return { path, authName, enabled: rule.enabled, users }
  })
  return { rules }
}

function bindDirectoryPrivacy(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const copy = (message: string, values?: MessageValues): string => xpT(message, values)
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
    const controls = (): (HTMLButtonElement | HTMLInputElement)[] => [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')]
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const eligible = (): boolean => root.isConnected && !root.closest(denied) && /^[a-z][a-z0-9]{0,15}$/.test(username)
    let draft: DirectoryPrivacyRuleDraft[] = []
    let baseline: DirectoryPrivacySnapshot | null = null
    let busy = false, uncertain = false
    const setStatus = (message: string, kind: DirectoryPrivacyStatus): void => {
      status.hidden = !message
      status.dataset.state = kind
      status.setAttribute('role', kind === 'failed' || kind === 'uncertain' ? 'alert' : 'status')
      status.textContent = message
    }
    const lock = (): void => { const blocked = busy || uncertain || !eligible(); controls().forEach(control => { control.disabled = blocked }) }
    const cell = (parent: HTMLElement, content: string, technical = false): HTMLElement => {
      const node = document.createElement('td')
      if (technical) { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.className = 'xp-mono'; bdi.textContent = content; node.replaceChildren(bdi) } else node.textContent = content
      parent.appendChild(node)
      return node
    }
    const smallButton = (parent: HTMLElement, label: string, kind: string, onClick: () => void): HTMLButtonElement => {
      const button = document.createElement('button')
      button.type = 'button'; button.className = 'xp-btn'; button.dataset.directoryPrivacyAction = kind; button.textContent = label
      button.addEventListener('click', event => { event.stopPropagation(); if (!button.disabled && eligible()) onClick() })
      parent.appendChild(button)
      return button
    }
    const paint = (): void => {
      rows.textContent = ''
      draft.forEach((rule, index) => {
        const row = document.createElement('tr'); row.dataset.directoryPrivacyRule = rule.path
        cell(row, rule.path, true); cell(row, rule.authName)
        const usersCell = document.createElement('td')
        const list = document.createElement('div'); list.className = 'xp-directory-privacy-users'; list.style.display = 'flex'; list.style.flexDirection = 'column'; list.style.gap = 'var(--xp-space-field)'
        rule.users.forEach((user, userIndex) => {
          const line = document.createElement('div'); line.className = 'xp-directory-privacy-user'; line.style.display = 'flex'; line.style.alignItems = 'end'; line.style.gap = 'var(--xp-space-field)'; line.style.flexWrap = 'wrap'
          const name = document.createElement('bdi'); name.dir = 'ltr'; name.className = 'xp-mono'; name.textContent = user.username
          const nameField = document.createElement('div'); nameField.className = 'xp-field'; nameField.style.flex = '1 1 8rem'
          const nameLabel = document.createElement('span'); nameLabel.className = 'xp-label'; nameLabel.textContent = copy('Username'); nameField.append(nameLabel, name)
          const password = document.createElement('input'); password.type = 'password'; password.className = 'xp-input'; password.dir = 'ltr'; password.autocomplete = 'new-password'
          password.id = 'directory-privacy-user-password-' + index + '-' + userIndex
          const passwordField = document.createElement('div'); passwordField.className = 'xp-field'; passwordField.style.flex = '1 1 12rem'
          const passwordLabel = document.createElement('label'); passwordLabel.className = 'xp-label'; passwordLabel.htmlFor = password.id; passwordLabel.style.paddingInline = 'var(--xp-control-content-inset)'; passwordLabel.textContent = copy('Password'); passwordField.append(passwordLabel, password)
          password.placeholder = copy('Password (required on save)')
          password.dataset.directoryPrivacyUserPassword = user.username
          password.addEventListener('input', event => { user.password = (event.target as HTMLInputElement).value })
          const removeUser = document.createElement('button'); removeUser.type = 'button'; removeUser.className = 'xp-btn'; removeUser.textContent = copy('Remove user')
          removeUser.addEventListener('click', event => { event.stopPropagation(); if (busy || uncertain || !eligible()) return; rule.users.splice(userIndex, 1); paint(); lock() })
          line.append(nameField, passwordField, removeUser); list.appendChild(line)
        })
        usersCell.appendChild(list); row.appendChild(usersCell)
        const enabledCell = document.createElement('td')
        const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = rule.enabled; enabled.dataset.directoryPrivacyEnabled = rule.path
        enabled.addEventListener('change', event => { rule.enabled = (event.target as HTMLInputElement).checked })
        enabledCell.appendChild(enabled); row.appendChild(enabledCell)
        const actionCell = document.createElement('td')
        smallButton(actionCell, copy('Remove folder'), 'remove-rule', () => { if (busy || uncertain) return; draft.splice(index, 1); paint(); lock() })
        row.appendChild(actionCell); rows.appendChild(row)
      })
      if (!draft.length) {
        const row = document.createElement('tr'), empty = document.createElement('td')
        empty.colSpan = 5
        empty.textContent = baseline ? copy('No protected folders are saved.') : copy('Protected folders have not been read.')
        row.appendChild(empty); rows.appendChild(row)
      }
      if (previewWrap) previewWrap.hidden = draft.length === 0
      lock()
    }
    const read = async (): Promise<void> => {
      if (busy) return
      busy = true; lock(); setStatus(copy('Reading saved protected folders…'), 'reading')
      try {
        const snapshot = directoryPrivacyConfig(await transport!('GET', '/api/web-features/' + encodeURIComponent(username) + '/directory-privacy'), username)
        baseline = snapshot; draft = directoryPrivacyDraft(snapshot)
        if (preview) preview.textContent = [snapshot.compiledNginx, snapshot.compiledApache].filter(Boolean).join('\n\n')
        paint()
        setStatus(copy('Saved rules read. They are configuration only; web-server protection is not verified here.'), 'read')
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
        if (draft.some(rule => rule.users.some(existing => existing.username === user.username))) throw new Error('duplicate_directory_user')
        draft = [...draft, { path, authName, enabled: true, users: [user] }]
        if (addPath) addPath.value = ''
        if (addPrompt) addPrompt.value = ''
        if (addUsername) addUsername.value = ''
        if (addPassword) addPassword.value = ''
        paint()
        setStatus(copy('Folder added to the draft. Save to store it; nothing has been written yet.'), 'read')
      } catch (error) {
        const message = error instanceof Error && error.message === 'duplicate_directory_path' ? copy('That folder is already listed once.')
          : error instanceof Error && error.message === 'duplicate_directory_user' ? copy('That username is already listed on another folder.')
            : copy('Folder, prompt, username and a password of at least 8 characters are required.')
        setStatus(message, 'failed')
      }
    }
    const save = async (): Promise<void> => {
      if (busy || uncertain || !baseline || !eligible()) return
      let body: ReturnType<typeof directoryPrivacyPayload>
      try { body = directoryPrivacyPayload(draft) } catch (error) {
        setStatus(error instanceof Error && error.message === 'password_required_for_existing_users'
          ? copy('Enter a password for every kept user. Saved password hashes are never returned, so each save re-proves the credentials.')
          : copy('Fix the protected-folder fields before saving. Nothing was sent.'), 'failed')
        return
      }
      busy = true; lock(); setStatus(copy('Verifying the saved rules before writing…'), 'saving')
      let dispatched = false
      try {
        const current = directoryPrivacyConfig(await transport!('GET', '/api/web-features/' + encodeURIComponent(username) + '/directory-privacy'), username)
        if (directoryPrivacySignature(current) !== directoryPrivacySignature(baseline)) {
          setStatus(copy('The saved rules changed elsewhere. Your draft is kept; refresh before saving again.'), 'stale')
          return
        }
        dispatched = true
        const saved = directoryPrivacyConfig(await transport!('PUT', '/api/web-features/' + encodeURIComponent(username) + '/directory-privacy', body), username)
        const expectedPaths = body.rules.map(rule => rule.path)
        const observedPaths = saved.rules.map(rule => rule.path)
        const matches = expectedPaths.length === observedPaths.length && expectedPaths.every((path, index) => path === observedPaths[index] && body.rules[index]!.authName === saved.rules[index]!.authName && body.rules[index]!.enabled === saved.rules[index]!.enabled && body.rules[index]!.users.map(user => user.username).join(',') === saved.rules[index]!.users.join(','))
        if (!matches) throw new Error('readback_mismatch')
        baseline = saved; draft = directoryPrivacyDraft(saved)
        if (preview) preview.textContent = [saved.compiledNginx, saved.compiledApache].filter(Boolean).join('\n\n')
        paint()
        setStatus(copy('Saved rules were stored and read back. Web-server application remains unverified on the host.'), 'saved')
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

export const DIRECTORY_PRIVACY_CLIENT_BINDING = `(function(askDialog){const USERNAME=${USERNAME.toString()};const unsafe=${unsafe.toString()};const directoryPrivacyObject=${directoryPrivacyObject.toString()};const directoryPrivacyPath=${directoryPrivacyPath.toString()};const directoryPrivacyPrompt=${directoryPrivacyPrompt.toString()};const directoryPrivacyUsername=${directoryPrivacyUsername.toString()};const directoryPrivacyPassword=${directoryPrivacyPassword.toString()};const directoryPrivacyConfig=${directoryPrivacyConfig.toString()};const directoryPrivacySignature=${directoryPrivacySignature.toString()};const directoryPrivacyDraft=${directoryPrivacyDraft.toString()};const directoryPrivacyDraftKey=${directoryPrivacyDraftKey.toString()};const directoryPrivacyDraftMatchesSnapshot=${directoryPrivacyDraftMatchesSnapshot.toString()};const directoryPrivacyPayload=${directoryPrivacyPayload.toString()};(${bindDirectoryPrivacy.toString()})(askDialog);})`
