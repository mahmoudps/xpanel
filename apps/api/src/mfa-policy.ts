/**
 * Operator two-factor policy.
 *
 * Root and resellers must enroll before administration. Hosting-account users
 * (the demohost class) stay on password sign-in until they choose an authenticator.
 * `XPANEL_ALLOW_PASSWORD_ONLY_ROOT=1` is a development-only opt-out for root and
 * resellers. It is off by default and must be unset before production.
 */
export const PASSWORD_ONLY_ROOT_ENV = 'XPANEL_ALLOW_PASSWORD_ONLY_ROOT'

export const PASSWORD_ONLY_ROOT_WARNING =
  'XPANEL_ALLOW_PASSWORD_ONLY_ROOT is enabled. This development-only opt-out lets root and resellers administer without two-factor enrollment. Remove this flag before production.'

export const passwordOnlyOperatorsAllowed = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[PASSWORD_ONLY_ROOT_ENV] === '1'

export const operatorRequiresMfaEnrollment = (
  kind: string,
  totpEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  if (totpEnabled) return false
  if (kind !== 'root' && kind !== 'reseller') return false
  return !passwordOnlyOperatorsAllowed(env)
}

export const warnIfPasswordOnlyOperators = (
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = (line) => { process.stderr.write(line) },
): void => {
  if (!passwordOnlyOperatorsAllowed(env)) return
  write(`WARNING: ${PASSWORD_ONLY_ROOT_WARNING}\n`)
}
