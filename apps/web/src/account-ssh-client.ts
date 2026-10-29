import type { MessageValues } from './i18n.ts'
import './i18n.ts'
/// <reference lib="dom" />
const SSH_ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/
const SSH_KEY_TYPES = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa', 'ssh-dss', 'sk-ecdsa-sha2-nistp256@openssh.com', 'sk-ssh-ed25519@openssh.com']
export interface AccountSshKey { line: number; type: string; fingerprint: string; comment: string; bits: number | null; hasOptions: boolean; allowed: boolean }
export interface AccountSshClientView {
  revision: string; exists: boolean; sizeBytes: number; directory: { exists: boolean; kind: string | null; mode: number | null }
  keys: AccountSshKey[]; unrecognizedLines: number[]; capacity: { maxKeys: number; used: number }
  login: { enabled: boolean; accountShell: string; planShell: string; port: number | null }
  capabilities: { canAdd: boolean; canRemove: boolean; reason: string | null }; status: string; removedLines: number | null
}
export function sshObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
const sshInt = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
export function readAccountSshView(value: unknown, accountId: string): AccountSshClientView {
  if (!SSH_ACCOUNT_ID.test(accountId) || !sshObject(value) || !sshObject(value.context) || value.context.accountId !== accountId || !sshObject(value.file) || !sshObject(value.file.directory) || !sshObject(value.login) || !sshObject(value.capabilities) || !sshObject(value.capacity) || !sshObject(value.application)) throw new Error('invalid_ssh_scope')
  const file = value.file, directory = value.file.directory as Record<string, unknown>, login = value.login, capabilities = value.capabilities, application = value.application
  if ([value, sshObject(value.details) ? value.details : {}].some(part => part.unknownOutcome === true || part.verificationRequired === true)) throw new Error('uncertain_ssh_reply')
  if (file.path !== '.ssh/authorized_keys' || typeof file.revision !== 'string' || !/^[0-9a-f]{64}$/.test(file.revision) || typeof file.exists !== 'boolean' || !sshInt(file.sizeBytes, 0, 1048576) || typeof directory.exists !== 'boolean' || ![null, 'directory', 'file', 'symlink'].includes(directory.kind as string | null) || !(directory.mode === null || sshInt(directory.mode, 0, 4095))) throw new Error('invalid_ssh_file')
  if (!Array.isArray(value.keys) || value.keys.length > 10000 || !Array.isArray(value.unrecognizedLines) || value.unrecognizedLines.length > 100000 || value.unrecognizedLines.some(line => !sshInt(line, 1))) throw new Error('invalid_ssh_keys')
  const seen = new Set<number>()
  const keys = value.keys.map(raw => {
    if (!sshObject(raw) || !sshInt(raw.line, 1) || seen.has(raw.line) || !SSH_KEY_TYPES.includes(raw.type as string) || typeof raw.fingerprint !== 'string' || !SSH_FINGERPRINT.test(raw.fingerprint) || typeof raw.comment !== 'string' || raw.comment.length > 1025 || !(raw.bits === null || sshInt(raw.bits, 1, 65536)) || typeof raw.hasOptions !== 'boolean' || typeof raw.allowed !== 'boolean') throw new Error('invalid_ssh_key')
    seen.add(raw.line)
    return { line: raw.line, type: raw.type as string, fingerprint: raw.fingerprint, comment: raw.comment, bits: raw.bits as number | null, hasOptions: raw.hasOptions, allowed: raw.allowed }
  })
  if (!sshInt(value.capacity.maxKeys, 1) || value.capacity.used !== keys.length || typeof login.enabled !== 'boolean' || !['none', 'jailed'].includes(login.accountShell as string) || !['none', 'jailed'].includes(login.planShell as string) || !(login.port === null || sshInt(login.port, 1, 65535)) || login.source !== 'saved-configuration'
    || typeof capabilities.canAdd !== 'boolean' || typeof capabilities.canRemove !== 'boolean' || ![null, 'directory_unmanageable', 'capacity'].includes(capabilities.reason as string | null) || !['read', 'added', 'removed'].includes(application.status as string) || application.nativeQualified !== false || !(application.removedLines === undefined || sshInt(application.removedLines, 1))) throw new Error('invalid_ssh_state')
  return { revision: file.revision, exists: file.exists, sizeBytes: file.sizeBytes as number, directory: { exists: directory.exists, kind: directory.kind as string | null, mode: directory.mode as number | null }, keys, unrecognizedLines: value.unrecognizedLines as number[],
    capacity: { maxKeys: value.capacity.maxKeys as number, used: keys.length }, login: { enabled: login.enabled, accountShell: login.accountShell as string, planShell: login.planShell as string, port: login.port as number | null },
    capabilities: { canAdd: capabilities.canAdd, canRemove: capabilities.canRemove, reason: capabilities.reason as string | null }, status: application.status as string, removedLines: (application.removedLines as number | undefined) ?? null }
}
export function accountSshUncertain(error: unknown): boolean {
  const value = sshObject(error) ? error : {}, details = sshObject(value.details) ? value.details : {}
  if ([value, details].some(part => part.stateChanged === true || part.unknownOutcome === true || part.verificationRequired === true)) return true
  if ([value, details].some(part => part.stateChanged === false)) return false
  return typeof value.status !== 'number' || value.status >= 500
}
export function accountSshFieldCode(error: unknown): string | null {
  const details = sshObject(error) && sshObject(error.details) ? error.details : null, first = details && Array.isArray(details.fields) ? details.fields[0] : null
  return sshObject(first) && typeof first.code === 'string' && /^[a-z_]{1,32}$/.test(first.code) ? first.code : null
}

function bindAccountSsh(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const PATH = '/api/account/ssh/keys'
  document.querySelectorAll<HTMLElement>('[data-account-ssh]').forEach(root => {
    if (root.dataset.sshBound === 'true') return
    root.dataset.sshBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const accountId = root.dataset.account ?? ''
    const eligible = (): boolean => root.isConnected && root.dataset.sshManage === 'true' && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const find = <T extends HTMLElement>(key: string): T => root.querySelector<T>('[data-ssh-' + key + ']')!
    const status = find('status'), rows = find('rows'), keyInput = find<HTMLTextAreaElement>('key'), add = find<HTMLButtonElement>('add'), refreshButton = find<HTMLButtonElement>('refresh')
    if (!status || !rows || !keyInput || !add || !refreshButton || !find('login') || !find('port') || !find('shell') || !find('file')) return
    let view: AccountSshClientView | null = null, busy = false, confirming = false, review = false
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'stale', 'uncertain', 'fields'].includes(state) ? 'alert' : 'status') }
    const lock = (): void => {
      const blocked = !eligible() || !view || busy || confirming || review
      keyInput.disabled = blocked || !view!.capabilities.canAdd
      add.disabled = keyInput.disabled || !keyInput.value.trim()
      refreshButton.disabled = !eligible() || busy || confirming
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = blocked || !view!.capabilities.canRemove })
      root.setAttribute('aria-busy', String(busy || confirming))
    }
    const request = (method: string, body?: unknown): Promise<unknown> => !send || !eligible() ? Promise.reject({ stateChanged: false }) : body === undefined ? send(method, PATH) : send(method, PATH, body)
    const ask = async (title: string, body: string, danger: boolean): Promise<boolean> => {
      if (!askDialog || confirming) { note('failed', t('Confirmation is unavailable. Nothing was sent.')); return false }
      confirming = true; lock()
      try { return await askDialog({ title, body, danger, confirm: t('Confirm') }) === true } catch { return false } finally { confirming = false; lock() }
    }
    const fieldMessage = (code: string): string => ({
      options_refused: t('Option prefixes such as command= or from= are not accepted. Paste the key line without them.'),
      rsa_too_short: t('RSA keys must be at least 3072 bits. Generate an Ed25519 key or a longer RSA key.'),
      unsupported_type: t('This key type is not accepted. Use Ed25519, ECDSA or RSA of at least 3072 bits.'),
      invalid_key: t('The key data is not a valid public key of the stated type.'),
      multiple_lines: t('Add one key at a time, on a single line.'),
      invalid_characters: t('The key line contains control characters.'),
      comment_too_long: t('The key comment is longer than 255 characters.'),
      too_long: t('The key line is longer than 8 KiB.'),
      duplicate: t('This key is already authorized.'),
      required: t('Paste a public key first.'),
    } as Record<string, string>)[code] ?? t('The key was refused. Nothing was changed.')
    const cell = (row: HTMLTableRowElement, text: string, technical: boolean): void => { const td = document.createElement('td'), content = document.createElement(technical ? 'bdi' : 'span'); content.dir = technical ? 'ltr' : 'auto'; content.textContent = text; td.append(content); row.append(td) }
    const paint = (next: AccountSshClientView): void => {
      view = next; review = false; rows.textContent = ''
      find('login').textContent = next.login.enabled ? t('Enabled for this account') : t('Disabled: the account or its plan does not allow shell access')
      find('port').textContent = next.login.port === null ? t('Not configured') : String(next.login.port)
      find('shell').textContent = next.login.accountShell + ' / ' + next.login.planShell
      const notes = [next.directory.exists && next.directory.kind !== 'directory' ? t('~/.ssh is not a regular directory, so keys cannot be managed here.') : next.exists ? t('The key file exists ({size} bytes).', { size: next.sizeBytes }) : t('The key file does not exist yet; adding a key creates it with mode 0600 in ~/.ssh (0700).'),
        next.unrecognizedLines.length ? t('{count} lines are not keys this page can read; they are kept unchanged.', { count: next.unrecognizedLines.length }) : '',
        next.capabilities.reason === 'capacity' ? t('The key limit has been reached.') : '']
      find('file').textContent = notes.filter(Boolean).join(' ')
      for (const key of next.keys) {
        const row = document.createElement('tr')
        cell(row, key.type + (key.bits === null ? '' : ' · ' + String(key.bits)), true); cell(row, key.fingerprint, true); cell(row, key.comment || t('No comment'), false)
        cell(row, [key.hasOptions ? t('Has options') : '', key.allowed ? '' : t('Below the current key policy')].filter(Boolean).join(' · ') || '-', false)
        const td = document.createElement('td'), button = document.createElement('button')
        button.type = 'button'; button.className = 'xp-btn'; button.textContent = t('Remove'); button.setAttribute('aria-label', t('Remove: {fingerprint}', { fingerprint: key.fingerprint }))
        button.addEventListener('click', () => { if (!button.disabled) void remove(key) }); td.append(button); row.append(td); rows.append(row)
      }
      if (!next.keys.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 5; td.textContent = t('No keys are authorized.'); row.append(td); rows.append(row) }
    }
    const failed = (error: unknown): void => {
      const code = accountSshFieldCode(error)
      if (code) { note('fields', fieldMessage(code)); return }
      const stale = sshObject(error) && error.status === 409
      review = stale || accountSshUncertain(error)
      note(review ? stale ? 'stale' : 'uncertain' : 'failed', review ? t('The key file outcome requires review. No retry was sent. Read keys before continuing.') : t(msgctxt('account-ssh-client', 'The request was refused. Nothing was changed.')))
    }
    async function refresh(): Promise<void> {
      if (!eligible() || busy || confirming) return
      busy = true; lock(); note('reading', t('Reading authorized keys…'))
      try { paint(readAccountSshView(await request('GET'), accountId)); note('read', t('Authorized keys read from the account file.')) }
      catch { note('failed', t('Authorized keys could not be read. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    async function mutate(method: 'POST' | 'DELETE', body: Record<string, unknown>, target: string, title: string, message: string): Promise<void> {
      const before = view
      if (!before || !eligible() || busy || confirming || review || !await ask(title, message, method === 'DELETE') || view !== before || !eligible()) return
      busy = true; lock(); note('saving', t('Saving and reading the key file back…'))
      try {
        const ack = readAccountSshView(await request(method, { expectedRevision: before.revision, ...body }), accountId), present = ack.keys.some(key => key.fingerprint === target)
        const kept = before.keys.filter(key => key.fingerprint !== target).every(key => ack.keys.some(item => item.fingerprint === key.fingerprint))
        if (ack.status !== (method === 'POST' ? 'added' : 'removed') || !kept || (method === 'POST' ? ack.keys.length !== before.keys.length + 1 : present)) throw new Error('wrong_ssh_ack')
        const observed = readAccountSshView(await request('GET'), accountId)
        if (observed.revision !== ack.revision) throw new Error('ssh_readback_mismatch')
        paint(observed); if (method === 'POST') keyInput.value = ''
        note('saved', method === 'POST' ? t('Key added and read back from the account file.') : t('Key removed and read back from the account file.'))
      } catch (error) { failed(error) }
      finally { busy = false; lock() }
    }
    function remove(key: AccountSshKey): Promise<void> {
      return mutate('DELETE', { fingerprint: key.fingerprint }, key.fingerprint, t('Remove this key?'), key.fingerprint + '\n' + (key.comment || '') + '\n' + t('Sessions using this key can no longer sign in.'))
    }
    if (!send || !eligible() || !SSH_ACCOUNT_ID.test(accountId)) {
      for (const control of root.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button,textarea')) control.disabled = true
      note('unavailable', t('SSH key management is unavailable here. Nothing was read or changed.')); return
    }
    keyInput.addEventListener('input', () => { if (!busy) lock() })
    refreshButton.addEventListener('click', () => { void refresh() })
    add.addEventListener('click', () => {
      const line = keyInput.value.trim()
      if (!line || add.disabled) return
      if (/[\r\n]/.test(line)) { note('fields', fieldMessage('multiple_lines')); return }
      // The server computes the authoritative fingerprint; the acknowledgement must add exactly one new key.
      void mutate('POST', { key: line }, '', t('Add this public key?'), line.slice(0, 160) + (line.length > 160 ? '…' : ''))
    })
    lock(); void refresh()
  })
}

export const ACCOUNT_SSH_CLIENT_BINDING = `(()=>{const SSH_ACCOUNT_ID=${SSH_ACCOUNT_ID.toString()};const SSH_FINGERPRINT=${SSH_FINGERPRINT.toString()};const SSH_KEY_TYPES=${JSON.stringify(SSH_KEY_TYPES)};const sshObject=${sshObject.toString()};const sshInt=${sshInt.toString()};const readAccountSshView=${readAccountSshView.toString()};const accountSshUncertain=${accountSshUncertain.toString()};const accountSshFieldCode=${accountSshFieldCode.toString()};return ${bindAccountSsh.toString()};})()`
