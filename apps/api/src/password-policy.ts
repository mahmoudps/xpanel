import { fail, passwordStrength } from '@xpanel/core'

export { passwordStrength }

/** What a password signs in to; each service may carry its own strength rule. */
export type PasswordService = 'panel' | 'mail' | 'ftp' | 'database' | 'webdisk' | 'directory'
export const PASSWORD_SERVICES: readonly PasswordService[] = ['panel', 'mail', 'ftp', 'database', 'webdisk', 'directory']

/** Minimum strength (0-100) of a new password per service; null uses the default (cPanel Password Strength Configuration). */
export interface PasswordStrengthPolicy {
  default: number
  perService: Record<PasswordService, number | null>
}

export const defaultPasswordStrength = (): PasswordStrengthPolicy =>
  ({ default: 0, perService: { panel: null, mail: null, ftp: null, database: null, webdisk: null, directory: null } })

// One API process serves one state root; it installs the saved sign-in policy before each authenticated request.
let active = defaultPasswordStrength()
export const usePasswordStrengthPolicy = (policy: PasswordStrengthPolicy): void => { active = policy }

export const requiredPasswordStrength = (service: PasswordService, policy: PasswordStrengthPolicy = active): number =>
  policy.perService[service] ?? policy.default

/** Whether its service allows a new password. Format bounds (one line, byte limits) stay with each caller. */
export const passwordAllowed = (password: string, service: PasswordService): boolean =>
  password.length >= 8 && passwordStrength(password) >= requiredPasswordStrength(service)

export const assertPasswordAllowed = (password: string, service: PasswordService): string => {
  if (password.length < 8) return fail('VALIDATION', 'password must contain at least 8 characters')
  const strength = passwordStrength(password), required = requiredPasswordStrength(service)
  return strength >= required ? password
    : fail('VALIDATION', `password strength ${strength} is below the required ${required}`, { reason: 'weak_password', service, strength, required, stateChanged: false })
}

/** The services a mail, FTP or Web Disk user signs in to with one password. */
export const servicePasswordKinds = (services: unknown): PasswordService[] => {
  const s = typeof services === 'object' && services !== null ? services as Record<string, unknown> : {}
  return [...(s.email === true ? ['mail' as const] : []), ...(s.ftp === true ? ['ftp' as const] : []), ...(s.webdisk === true ? ['webdisk' as const] : [])]
}
