/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { generateMailboxPassword } from './password-generate-client.ts'

export type WhmDbRootPasswordState = { clientFile: 'absent' | 'managed' | 'unmanaged' | 'unreadable'; mariadb: 'connected' | 'unavailable' }
export type WhmDbRootPasswordOutcome = { clientFile: 'written' | 'failed'; socketAccess: 'verified' | 'unverified'; verificationRequired: boolean }

/** The same printable-ASCII rule the agent applies; length and character classes only estimate strength. */
export function rootPasswordStrength(password: string): 'invalid' | 'weak' | 'fair' | 'strong' {
  if (!/^[\x21-\x7e]{8,128}$/.test(password)) return 'invalid'
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(password)).length
  return password.length >= 16 && classes >= 3 ? 'strong' : password.length >= 12 && classes >= 2 ? 'fair' : 'weak'
}
export function readWhmDbRootPasswordState(value: unknown): WhmDbRootPasswordState {
  const item = !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null, file = item && item.clientFile && typeof item.clientFile === 'object' ? item.clientFile as Record<string, unknown> : null
  if (!item || !file || file.path !== '/root/.my.cnf' || !['absent', 'managed', 'unmanaged', 'unreadable'].includes(String(file.state)) || !['connected', 'unavailable'].includes(String(item.mariadb))) throw new Error('invalid_root_password_state')
  return { clientFile: file.state as WhmDbRootPasswordState['clientFile'], mariadb: item.mariadb as WhmDbRootPasswordState['mariadb'] }
}
export function readWhmDbRootPasswordOutcome(value: unknown): WhmDbRootPasswordOutcome {
  const item = !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null, file = item && item.clientFile && typeof item.clientFile === 'object' ? item.clientFile as Record<string, unknown> : null
  if (!item || item.serverPassword !== 'verified' || !file || file.path !== '/root/.my.cnf' || !['written', 'failed'].includes(String(file.state)) || !['verified', 'unverified'].includes(String(item.socketAccess))
    || item.verificationRequired !== (file.state !== 'written' || item.socketAccess !== 'verified')) throw new Error('invalid_root_password_outcome')
  return { clientFile: file.state as WhmDbRootPasswordOutcome['clientFile'], socketAccess: item.socketAccess as WhmDbRootPasswordOutcome['socketAccess'], verificationRequired: item.verificationRequired as boolean }
}

function bindWhmDbRootPassword(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-db-root-password]').forEach(root => {
    if (root.dataset.dbRootBound === 'true') return
    root.dataset.dbRootBound = 'true'
    const password = root.querySelector<HTMLInputElement>('[data-db-root-new]'), confirmation = root.querySelector<HTMLInputElement>('[data-db-root-confirm]')
    const generate = root.querySelector<HTMLButtonElement>('[data-db-root-generate]'), submit = root.querySelector<HTMLButtonElement>('[data-db-root-submit]')
    const strength = root.querySelector<HTMLElement>('[data-db-root-strength]'), status = root.querySelector<HTMLElement>('[data-db-root-status]'), fileFact = root.querySelector<HTMLElement>('[data-db-root-fact="clientFile"]')
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!password || !confirmation || !generate || !submit || !strength || !status || !fileFact) return
    let busy = false, state: WhmDbRootPasswordState | null = null
    const admitted = (): boolean => root.isConnected && root.dataset.canManage === 'true' && typeof askDialog === 'function' && !!transport && !root.closest('[data-wiring="unavailable"],[data-readonly="true"],[data-capability-state="unavailable"],fieldset:disabled')
    const writable = (): boolean => admitted() && !!state && state.mariadb === 'connected' && (state.clientFile === 'absent' || state.clientFile === 'managed')
    const note = (kind: string, message: string): void => { status.dataset.state = kind; status.textContent = message; status.setAttribute('role', ['failed', 'uncertain'].includes(kind) ? 'alert' : 'status') }
    const strengthLabels = { invalid: t('Use 8 to 128 printable characters without spaces.'), weak: t('Weak'), fair: t('Fair'), strong: t('Strong') }
    const lock = (): void => {
      const ready = writable() && !busy
      password.disabled = confirmation.disabled = generate.disabled = !ready
      const level = rootPasswordStrength(password.value)
      strength.dataset.strength = password.value ? level : 'empty'; strength.textContent = password.value ? strengthLabels[level] : ''
      submit.disabled = !ready || level === 'invalid' || password.value !== confirmation.value
      root.setAttribute('aria-busy', String(busy))
    }
    const fileLabels = { absent: t('Not present; it will be created with mode 0600'), managed: t('Written by xPanel'), unmanaged: t('Edited outside xPanel; the password cannot be changed here'), unreadable: t('Not read') }
    const load = async (): Promise<void> => {
      if (!transport) return
      busy = true; lock()
      try { state = readWhmDbRootPasswordState(await transport('GET', '/api/server/databases/root-password')); fileFact.textContent = fileLabels[state.clientFile] }
      catch { state = null; fileFact.textContent = fileLabels.unreadable }
      finally { busy = false; lock() }
      if (!state || state.mariadb !== 'connected') note('unavailable', t('MariaDB administration is not connected on this server. Nothing can be changed.'))
      else if (state.clientFile === 'unmanaged' || state.clientFile === 'unreadable') note('unavailable', t('The root client file /root/.my.cnf must be absent or written by xPanel before the password can change.'))
    }
    password.addEventListener('input', lock); confirmation.addEventListener('input', lock)
    generate.addEventListener('click', () => {
      if (generate.disabled) return
      try { const value = generateMailboxPassword(); password.value = value; confirmation.value = value; password.type = 'text'; note('idle', t('Password generated locally. Copy it before you save; it is not shown again.')) }
      catch { note('failed', t('Secure generation is unavailable. Enter a password yourself.')) }
      lock()
    })
    submit.addEventListener('click', () => { void (async () => {
      if (busy || submit.disabled || !writable()) return
      let confirmed = false
      try { confirmed = await askDialog!({ title: t('Change the MariaDB root password?'), body: t('Clients that sign in as root with the old password stop working. The server root account keeps signing in through the local socket.'), danger: true, confirm: t('Change password') }) === true }
      catch { confirmed = false }
      if (!confirmed || busy || !writable()) return
      const body = { password: password.value }
      busy = true; lock(); note('reading', t('Changing the password and verifying it on the server…'))
      try {
        const outcome = readWhmDbRootPasswordOutcome(await transport!('POST', '/api/server/databases/root-password', body))
        password.value = confirmation.value = ''; password.type = 'password'
        note(outcome.verificationRequired ? 'uncertain' : 'read', !outcome.verificationRequired ? t('The new password is verified on the server and saved in /root/.my.cnf.')
          : outcome.clientFile === 'failed' ? t('The server uses the new password, but /root/.my.cnf could not be written. Update it before using the root client.')
            : t('The server uses the new password, but local socket access could not be confirmed. Check the database service.'))
      } catch (error) {
        const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}, details = value.details && typeof value.details === 'object' ? value.details as Record<string, unknown> : {}
        note(details.stateChanged === false ? 'failed' : 'uncertain', details.stateChanged === false ? t('The password was not changed.') : t('The outcome is unknown. Sign in with the new password to check before you retry.'))
      } finally { busy = false; lock() }
    })() })
    lock()
    if (!admitted()) { note('unavailable', t('Changing the root password is unavailable here. Nothing was read or changed.')); return }
    void load()
  })
}

export const WHM_DB_ROOT_PASSWORD_CLIENT_BINDING = `(()=>{const generateMailboxPassword=${generateMailboxPassword.toString()};const rootPasswordStrength=${rootPasswordStrength.toString()};const readWhmDbRootPasswordState=${readWhmDbRootPasswordState.toString()};const readWhmDbRootPasswordOutcome=${readWhmDbRootPasswordOutcome.toString()};return ${bindWhmDbRootPassword.toString()};})()`
