import { fail } from './errors.ts'
import type { ServerSettings, ServerSshSettings, ShellJailPolicy, SshRootLogin } from './types.ts'

export const SSH_ROOT_LOGINS: readonly SshRootLogin[] = ['prohibit-password', 'no', 'yes', 'forced-commands-only']
const KEYS = ['passwordAuth', 'pubkeyAuth', 'rootLogin', 'loginAlarm', 'jail']
const JAIL_KEYS = ['privateTmp', 'hiddenHomes', 'systemView', 'exceptions']
const unchanged = { stateChanged: false }
export const SHELL_JAIL_MAX_EXCEPTIONS = 500

/** The policy the host has always rendered; an unset block means these values. */
export const DEFAULT_SERVER_SSH_SETTINGS: ServerSshSettings = Object.freeze({
  passwordAuth: false, pubkeyAuth: true, rootLogin: 'prohibit-password', loginAlarm: false,
  jail: Object.freeze({ privateTmp: false, hiddenHomes: false, systemView: false, exceptions: [] }),
})

const flag = (value: unknown, what: string): boolean => typeof value === 'boolean' ? value : fail('VALIDATION', `${what} must be a boolean`, unchanged)
const exact = (value: unknown, keys: readonly string[], what: string, optional: readonly string[] = []): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('VALIDATION', `${what} must be an object`, unchanged)
  const present = Object.keys(value)
  if (keys.some(key => !present.includes(key)) || present.some(key => !keys.includes(key) && !optional.includes(key))) return fail('VALIDATION', `${what} takes ${keys.join(', ')}`, unchanged)
  return value as Record<string, unknown>
}

export const validateShellJailPolicy = (value: unknown): ShellJailPolicy => {
  const o = exact(value, JAIL_KEYS, 'shell jail policy')
  if (!Array.isArray(o.exceptions) || o.exceptions.length > SHELL_JAIL_MAX_EXCEPTIONS) return fail('VALIDATION', `at most ${SHELL_JAIL_MAX_EXCEPTIONS} shell jail exceptions`, unchanged)
  const seen = new Set<string>()
  const exceptions = o.exceptions.map(raw => {
    const entry = exact(raw, ['username', 'reason'], 'shell jail exception')
    if (typeof entry.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(entry.username) || seen.has(entry.username)) return fail('VALIDATION', 'a shell jail exception needs one account username', unchanged)
    if (typeof entry.reason !== 'string' || !entry.reason.trim() || entry.reason.length > 200 || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(entry.reason)) return fail('VALIDATION', 'a shell jail exception needs a reason of up to 200 characters', unchanged)
    seen.add(entry.username)
    return { username: entry.username, reason: entry.reason.trim() }
  })
  return { privateTmp: flag(o.privateTmp, 'privateTmp'), hiddenHomes: flag(o.hiddenHomes, 'hiddenHomes'), systemView: flag(o.systemView, 'systemView'), exceptions }
}

export const validateServerSshSettings = (value: unknown): ServerSshSettings => {
  const o = exact(value, KEYS, 'SSH settings', ['previousPort'])
  const passwordAuth = flag(o.passwordAuth, 'passwordAuth'), pubkeyAuth = flag(o.pubkeyAuth, 'pubkeyAuth')
  if (!passwordAuth && !pubkeyAuth) return fail('NO_AUTH_METHOD', 'password and key sign-in cannot both be off', unchanged)
  if (!(SSH_ROOT_LOGINS as readonly unknown[]).includes(o.rootLogin)) return fail('VALIDATION', 'rootLogin is not a supported root sign-in policy', unchanged)
  if (o.previousPort !== undefined && !(typeof o.previousPort === 'number' && Number.isInteger(o.previousPort) && o.previousPort >= 1 && o.previousPort <= 65535)) return fail('VALIDATION', 'previousPort must be 1-65535', unchanged)
  return { passwordAuth, pubkeyAuth, rootLogin: o.rootLogin as SshRootLogin, loginAlarm: flag(o.loginAlarm, 'loginAlarm'), jail: validateShellJailPolicy(o.jail), ...(o.previousPort === undefined ? {} : { previousPort: o.previousPort as number }) }
}

export const effectiveServerSshSettings = (settings: Pick<ServerSettings, 'ssh'> | null | undefined): ServerSshSettings => settings?.ssh ?? DEFAULT_SERVER_SSH_SETTINGS

/** Ways back into the host. A null fact could not be read and never counts as a way in. */
export interface SshAccessFacts { rootKeys: number | null; rootPassword: boolean | null; otherAdministrators: number | null }
export type SshLockoutReason = 'root_has_no_key' | 'root_has_no_password' | 'no_other_administrator'

/** Why a policy would leave nobody able to sign in over SSH, or null when a way in stays open. */
export const sshLockoutReason = (policy: Pick<ServerSshSettings, 'passwordAuth' | 'pubkeyAuth' | 'rootLogin'>, facts: SshAccessFacts): SshLockoutReason | null => {
  const rootByKey = policy.pubkeyAuth && (policy.rootLogin === 'yes' || policy.rootLogin === 'prohibit-password')
  const rootByPassword = policy.passwordAuth && policy.rootLogin === 'yes'
  if (rootByKey && (facts.rootKeys ?? 0) > 0) return null
  if (rootByPassword && facts.rootPassword === true) return null
  if ((facts.otherAdministrators ?? 0) > 0) return null
  return rootByKey ? 'root_has_no_key' : rootByPassword ? 'root_has_no_password' : 'no_other_administrator'
}
