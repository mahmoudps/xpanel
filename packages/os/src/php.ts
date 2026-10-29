import { fail } from '@xpanel/core'
import { preview } from './validate.ts'

/** Runtime root of xPanel's own per-account FPM masters (<dir>/<user>-<version>/php-fpm.sock), not a distro master's. */
export const XPANEL_FPM_SOCKET_DIR = '/run/xpanel-fpm'

export const SUPPORTED_PHP_VERSIONS = ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4'] as const

export type PhpVersion = (typeof SUPPORTED_PHP_VERSIONS)[number]

const SUPPORTED: ReadonlySet<string> = new Set(SUPPORTED_PHP_VERSIONS)

export const isPhpVersion = (v: unknown): v is PhpVersion => typeof v === 'string' && SUPPORTED.has(v)

export const assertPhpVersion = (v: unknown): PhpVersion =>
  isPhpVersion(v)
    ? v
    : fail('VALIDATION', 'unsupported PHP version', { version: preview(v), supported: [...SUPPORTED_PHP_VERSIONS] })

/** '8.3' -> '83', as used by Remi SCL and lsphp package names. */
export const phpCompact = (v: unknown): string => assertPhpVersion(v).replace('.', '')

/** Strict list: an array of supported versions, no duplicates, no holes. */
export const assertPhpVersionList = (list: unknown): PhpVersion[] => {
  if (!Array.isArray(list)) return fail('VALIDATION', 'phpVersions must be an array')
  if (list.length > SUPPORTED_PHP_VERSIONS.length) return fail('VALIDATION', 'too many PHP versions', { count: list.length })
  const out = Array.from(list, assertPhpVersion)
  return new Set(out).size === out.length ? out : fail('VALIDATION', 'duplicate PHP version', { versions: out })
}
