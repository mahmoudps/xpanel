// xPanel-owned locations used by the edge. None of them is inside an account home,
// and none is distribution-specific: distro paths always come from the OsProfile.
import type { OsProfile } from '@xpanel/core'
import { derivePhpFpmBinary, fpmPaths } from '../system/units.ts'
import { assertDomainName, assertId, assertPhpVersion, assertSafeAbsPath, assertUsername } from './validate.ts'

export const XP_PATHS = {
  acmeDir: '/var/lib/xpanel/acme',
  nginxCacheDir: '/var/cache/xpanel/nginx',
  nginxLogDir: '/var/log/xpanel/nginx',
  apacheLogDir: '/var/log/xpanel/apache',
  fpmLogDir: '/var/log/xpanel/php-fpm',
  fpmRunDir: '/run/xpanel-fpm',
  fpmConfDir: '/etc/xpanel/php-fpm',
  sslDir: '/etc/xpanel/ssl',
  modsecDir: '/etc/xpanel/modsecurity',
  suspendedDir: '/usr/share/xpanel/suspended',
  defaultSiteDir: '/usr/share/xpanel/default',
} as const

/** Self-signed fallback the installer creates; served to TLS clients asking for an unbound name. */
export const DEFAULT_TLS = {
  cert: `${XP_PATHS.sslDir}/default/fullchain.pem`,
  key: `${XP_PATHS.sslDir}/default/privkey.pem`,
} as const

export const certPaths = (certId: string): { cert: string; key: string } => {
  const id = assertId(certId, 'certificate id')
  return { cert: `${XP_PATHS.sslDir}/${id}/fullchain.pem`, key: `${XP_PATHS.sslDir}/${id}/privkey.pem` }
}

export const nginxAccessLog = (domain: string): string => `${XP_PATHS.nginxLogDir}/${assertDomainName(domain)}.access.log`
export const nginxErrorLog = (domain: string): string => `${XP_PATHS.nginxLogDir}/${assertDomainName(domain)}.error.log`

/**
 * One FPM master per account and PHP version. The layout is the one the system module's unit
 * starts (fpmPaths): config under /etc/xpanel/php-fpm/<ver>/, socket and pid inside the unit's
 * RuntimeDirectory=xpanel-fpm/<user>-<ver> (owned by the account), so no shared writable
 * directory exists where one account could pre-create another account's socket.
 */
const fpm = (user: string, version: string) => fpmPaths(assertUsername(user), assertPhpVersion(version))

export const fpmRuntimeDir = (user: string, version: string): string => fpm(user, version).socketDir
export const fpmSocketPath = (user: string, version: string): string => fpm(user, version).socket
export const fpmPidPath = (user: string, version: string): string => `${fpm(user, version).socketDir}/php-fpm.pid`
export const fpmLogDir = (user: string, version: string): string => fpm(user, version).logDir
export const fpmErrorLog = (user: string, version: string): string => `${fpm(user, version).logDir}/${version}.error.log`
export const fpmMasterConfPath = (user: string, version: string): string => fpm(user, version).config
export const fpmPoolConfPath = (user: string, version: string): string => fpm(user, version).config.replace(/\.conf$/, '.pool.conf')
/** Shared per-version config directory; each file in it is readable by its own account only. */
export const fpmConfDir = (version: string): string => `${XP_PATHS.fpmConfDir}/${assertPhpVersion(version)}`

/** CGI wrappers must live under the suexec docroot, in a directory owned by the target user. */
export const cgiWrapperRoot = (os: OsProfile): string => `${assertSafeAbsPath(os.paths.suexecDocroot, 'suexec docroot')}/xpanel-cgi`
export const cgiWrapperDir = (user: string, os: OsProfile): string => `${cgiWrapperRoot(os)}/${assertUsername(user)}`
export const cgiWrapperName = (version: string, kind: 'cgi' | 'fcgi'): string =>
  `php${assertPhpVersion(version)}.${kind === 'fcgi' ? 'fcgi' : 'cgi'}`
export const cgiWrapperPath = (user: string, version: string, kind: 'cgi' | 'fcgi', os: OsProfile): string =>
  `${cgiWrapperDir(user, os)}/${cgiWrapperName(version, kind)}`

/** Optional members the os package's profile carries beyond the shared OsProfile contract. */
type ProfileExtras = OsProfile & {
  phpCgiBinary?: (version: string) => string
  phpFpmBinary?: (version: string) => string
  lsphpBinary?: (version: string) => string
  bin?: { nginx?: string }
}

const extrasOf = (os: OsProfile): ProfileExtras => os as ProfileExtras

/** php-cgi next to the CLI binary: /usr/bin/php8.3 -> /usr/bin/php-cgi8.3, .../bin/php -> .../bin/php-cgi. */
export const phpCgiBinary = (os: OsProfile, version: string): string => {
  const v = assertPhpVersion(version)
  const own = extrasOf(os).phpCgiBinary
  if (typeof own === 'function') return assertSafeAbsPath(own(v), 'php-cgi binary')
  const cli = assertSafeAbsPath(os.phpBinary(v), 'php binary')
  const i = cli.lastIndexOf('/')
  const base = cli.slice(i + 1)
  if (!base.startsWith('php')) return assertSafeAbsPath('', 'php-cgi binary')
  return assertSafeAbsPath(`${cli.slice(0, i)}/php-cgi${base.slice(3)}`, 'php-cgi binary')
}

/** php-fpm binary: the profile's own, else the system module's derivation from the CLI path. */
export const phpFpmBinary = (os: OsProfile, version: string): string => {
  const v = assertPhpVersion(version)
  const own = extrasOf(os).phpFpmBinary
  return assertSafeAbsPath(typeof own === 'function' ? own(v) : derivePhpFpmBinary(os, v), 'php-fpm binary')
}

/** LiteSpeed's lsphp builds live at <olsRoot>/lsphpXY/bin/lsphp on both families. */
export const lsphpBinary = (os: OsProfile, version: string): string => {
  const v = assertPhpVersion(version)
  const own = extrasOf(os).lsphpBinary
  if (typeof own === 'function') return assertSafeAbsPath(own(v), 'lsphp binary')
  return assertSafeAbsPath(`${os.paths.olsRoot}/lsphp${v.replace('.', '')}/bin/lsphp`, 'lsphp binary')
}

/** The profile's nginx binary when it names one, else `nginx` from the executor's PATH. */
export const nginxBinary = (os: OsProfile): string => {
  const own = extrasOf(os).bin?.nginx
  return own === undefined ? 'nginx' : assertSafeAbsPath(own, 'nginx binary')
}

/** Shared PHP library dir (PEAR) that open_basedir may include on request. */
export const systemPhpLibDir = (os: OsProfile): string => (os.family === 'rhel' ? '/usr/share/pear' : '/usr/share/php')

/** Dynamic module loaders of the distribution's nginx package. */
export const nginxModuleIncludes = (os: OsProfile): string[] =>
  os.family === 'rhel' ? ['/usr/share/nginx/modules/*.conf'] : [`${os.paths.nginxRoot}/modules-enabled/*.conf`]
