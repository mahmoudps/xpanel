// PHP policy shared by FPM pools, CGI wrappers, lsphp and .user.ini. The rules themselves
// (dangerous functions, php.ini allowlist, pool sanity, plan cap) live in @xpanel/core; this
// module turns their output into isolation values and INI-safe text.
import { disabledFunctions, phpIniScope, sanitizePhpIni, validateFpm } from '@xpanel/core'
import type { Account, Limit, OsProfile, PhpIniOptions, PhpSettings } from '@xpanel/core'
import { systemPhpLibDir } from './paths.ts'
import { iniValue } from './quote.ts'

export interface PhpIniEntries {
  /** PHP_INI_PERDIR/ALL keys: php_value in a pool, .user.ini lines */
  user: [string, string][]
  /** PHP_INI_SYSTEM keys: php_admin_value in a pool, never .user.ini */
  pool: [string, string][]
}

/**
 * Panel php.ini settings through the core allowlist (unknown and server-owned keys are refused,
 * values canonical), split by where PHP honours them, values rendered INI-safe.
 */
export const iniEntries = (ini: Record<string, string> | null | undefined, opts: PhpIniOptions = {}): PhpIniEntries => {
  const out: PhpIniEntries = { user: [], pool: [] }
  if (ini === null || ini === undefined) return out
  for (const [key, value] of Object.entries(sanitizePhpIni(ini, opts))) {
    out[phpIniScope(key) === 'pool' ? 'pool' : 'user'].push([key, iniValue(value, `PHP setting ${key}`)])
  }
  return out
}

export interface PhpIsolationOptions {
  /** root-granted exceptions; each must be on core's DANGEROUS_FUNCTIONS list */
  allowedFunctions?: readonly string[]
  /** add the distribution's shared PEAR/PHP library dir to open_basedir */
  includeSystemPhpLib?: boolean
}

export interface PhpIsolation {
  tmpDir: string
  openBasedir: string
  disableFunctions: string
  /** admin values every handler must enforce, raw (unquoted) */
  admin: [string, string][]
}

/** open_basedir on the home and its tmp only; temp, upload and session files stay in ~/tmp. */
export const phpIsolation = (account: Account, os: OsProfile, opts: PhpIsolationOptions = {}): PhpIsolation => {
  const tmpDir = `${account.home}/tmp`
  const dirs = [account.home, tmpDir]
  if (opts.includeSystemPhpLib) dirs.push(systemPhpLibDir(os))
  const openBasedir = dirs.join(':')
  const disableFunctions = disabledFunctions(opts.allowedFunctions ?? []).join(',')
  return {
    tmpDir,
    openBasedir,
    disableFunctions,
    admin: [
      ['open_basedir', openBasedir],
      ['disable_functions', disableFunctions],
      ['upload_tmp_dir', tmpDir],
      ['session.save_path', tmpDir],
      ['sys_temp_dir', tmpDir],
      ['allow_url_include', 'Off'],
      ['expose_php', 'Off'],
    ],
  }
}

export type FpmWorkers = PhpSettings['fpm']

/** Worker numbers as php-fpm itself checks them, within the plan's per-domain cap (PlanCaps.phpWorkers). */
export const assertWorkers = (fpm: FpmWorkers, cap: Limit = 'unlimited'): FpmWorkers => validateFpm(fpm, cap)
