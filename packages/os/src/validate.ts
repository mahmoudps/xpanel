import { fail } from '@xpanel/core'
import type { OsFamily } from '@xpanel/core'

/** Characters allowed in any argv element we emit. No whitespace, quotes, globs or shell operators. */
export const SAFE_ARG = /^[A-Za-z0-9@+=:./_-]+$/
const MAX_ARG = 1024
const DEB_PACKAGE = /^[a-z0-9][a-z0-9+.-]{1,127}$/
const RPM_PACKAGE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/
const UNIT = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,254}$/
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/
const URL_PATH = /^\/[A-Za-z0-9._/-]+\.rpm$/
const TRUSTED_PACKAGE_HOSTS = new Set(['dl.fedoraproject.org', 'rpms.remirepo.net'])

export const preview = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 64) : typeof v)

export const isSafeArg = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_ARG && SAFE_ARG.test(v)

export const assertAbsolutePath = (v: unknown): string => {
  if (typeof v !== 'string' || v.length > 4096 || !v.startsWith('/')) {
    return fail('VALIDATION', 'expected an absolute path', { path: preview(v) })
  }
  const segments = v.slice(1).split('/')
  const ok = segments.every((s, i) => (s === '' ? i === segments.length - 1 && v !== '/' : PATH_SEGMENT.test(s) && s !== '.' && s !== '..'))
  return ok ? v : fail('VALIDATION', 'unsafe absolute path', { path: preview(v) })
}

/** argv[0] must be an absolute binary path; every element must match SAFE_ARG. */
export const assertSafeArgv = (argv: readonly unknown[]): string[] => {
  if (!Array.isArray(argv) || argv.length === 0) return fail('VALIDATION', 'argv must be a non-empty array')
  const out = Array.from(argv, (a, i) => (isSafeArg(a) ? a : fail('VALIDATION', 'unsafe argv element', { index: i, value: preview(a) })))
  assertAbsolutePath(out[0])
  return out
}

/** Package names never start with '-', so they cannot be read as package-manager options. */
export const assertPackageName = (family: OsFamily, name: unknown): string => {
  const re = family === 'debian' ? DEB_PACKAGE : RPM_PACKAGE
  return typeof name === 'string' && re.test(name) ? name : fail('VALIDATION', 'invalid package name', { family, name: preview(name) })
}

export const assertUnitName = (name: unknown): string =>
  typeof name === 'string' && UNIT.test(name) && !name.includes('..')
    ? name
    : fail('VALIDATION', 'invalid systemd unit name', { unit: preview(name) })

/** Repository bootstrap RPMs may only come over https from the EPEL and Remi mirrors. */
export const assertTrustedPackageUrl = (v: unknown): string => {
  if (typeof v !== 'string' || !isSafeArg(v)) return fail('VALIDATION', 'invalid package URL', { url: preview(v) })
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return fail('VALIDATION', 'invalid package URL', { url: preview(v) })
  }
  const ok = u.protocol === 'https:' && TRUSTED_PACKAGE_HOSTS.has(u.hostname) && u.port === '' &&
    u.username === '' && u.password === '' && u.search === '' && u.hash === '' &&
    URL_PATH.test(u.pathname) && !u.pathname.includes('..') && u.href === v
  return ok ? v : fail('VALIDATION', 'untrusted package URL', { url: preview(v) })
}
