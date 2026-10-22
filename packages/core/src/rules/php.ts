// PHP handler availability per engine/MPM, PHP-FPM pool validation and per-site php.ini
// allowlisting. Handler rules follow the PLAN: itk never silently falls back to a shared
// web-server user, suPHP only exists with itk off, lsphp only with OpenLiteSpeed.
import type { ApacheMpm, Engine, Limit, PhpHandler } from '../types.ts'
import { fail } from '../errors.ts'
import { isUnlimited } from '../limits.ts'
import { hasControlChars, invalid, isInt, isLimit, isRecord, throwIfErrors } from './check.ts'
import type { FpmSettings } from './workers.ts'

export interface HandlerContext {
  engine: Engine
  /** ignored when the engine is OpenLiteSpeed */
  mpm: ApacheMpm
  /** whether the distribution ships an mpm_itk package for this host */
  itkAvailable: boolean
}

export interface HandlerOption {
  handler: PhpHandler
  available: boolean
  default: boolean
  /** a process in the request path (the web server child) does not run as the account UID */
  sharedIdentity: boolean
  /** why the handler is unavailable */
  reason: string | null
}

export interface HandlerMatrix {
  engine: Engine
  mpm: ApacheMpm | null
  sharedIdentity: boolean
  defaultHandler: PhpHandler
  handlers: HandlerOption[]
  warnings: string[]
}

export const PHP_HANDLERS: readonly PhpHandler[] = ['fpm', 'cgi', 'suphp', 'lsphp']

const option = (handler: PhpHandler, available: boolean, isDefault: boolean, sharedIdentity: boolean, reason: string | null): HandlerOption => ({
  handler,
  available,
  default: isDefault,
  sharedIdentity: available && sharedIdentity,
  reason: available ? null : reason,
})

/**
 * Throws ENGINE_UNAVAILABLE when itk is requested on a host without the itk package:
 * running every site as the shared web-server user instead is never an acceptable fallback.
 */
export const availableHandlers = (ctx: HandlerContext): HandlerMatrix => {
  if (!isRecord(ctx)) return invalid('handler context must be an object')
  if (ctx.engine === 'openlitespeed') {
    const apacheOnly = 'Apache handlers are unavailable while OpenLiteSpeed is the engine'
    return {
      engine: 'openlitespeed',
      mpm: null,
      sharedIdentity: true,
      defaultHandler: 'lsphp',
      handlers: [
        option('fpm', false, false, true, apacheOnly),
        option('cgi', false, false, true, apacheOnly),
        option('suphp', false, false, true, apacheOnly),
        option('lsphp', true, true, true, null),
      ],
      warnings: ['OpenLiteSpeed serves static files as its own user; PHP runs as the account through lsphp'],
    }
  }
  if (ctx.engine !== 'apache') return invalid('unknown engine', { engine: ctx.engine })
  if (ctx.mpm !== 'itk' && ctx.mpm !== 'prefork') return invalid('unknown Apache MPM', { mpm: ctx.mpm })
  const olsOnly = 'lsphp requires the OpenLiteSpeed engine'
  if (ctx.mpm === 'itk') {
    if (ctx.itkAvailable !== true) {
      return fail('ENGINE_UNAVAILABLE', 'mpm_itk is not available on this host; refusing to serve accounts as the shared web server user', {
        engine: 'apache',
        mpm: 'itk',
      })
    }
    return {
      engine: 'apache',
      mpm: 'itk',
      sharedIdentity: false,
      defaultHandler: 'fpm',
      handlers: [
        option('fpm', true, true, false, null),
        option('cgi', true, false, false, null),
        option('suphp', false, false, false, 'suPHP cannot run alongside mpm_itk; switch Apache to prefork to use it'),
        option('lsphp', false, false, false, olsOnly),
      ],
      warnings: [],
    }
  }
  return {
    engine: 'apache',
    mpm: 'prefork',
    sharedIdentity: true,
    defaultHandler: 'fpm',
    handlers: [
      option('fpm', true, true, true, null),
      option('cgi', true, false, true, null),
      option('suphp', true, false, true, null),
      option('lsphp', false, false, true, olsOnly),
    ],
    warnings: ['prefork: Apache children are shared and do not run as the account; only PHP runs under the account UID'],
  }
}

/** ENGINE_UNAVAILABLE unless the handler can run under the current engine/MPM. */
export const assertHandlerAvailable = (handler: PhpHandler, ctx: HandlerContext): HandlerOption => {
  const found = availableHandlers(ctx).handlers.find((h) => h.handler === handler)
  if (!found) return invalid('unknown PHP handler', { handler })
  if (!found.available) return fail('ENGINE_UNAVAILABLE', found.reason ?? `${handler} is unavailable`, { handler })
  return found
}

const FPM_MODES = ['ondemand', 'dynamic', 'static'] as const
const FPM_KEYS = ['mode', 'maxChildren', 'startServers', 'minSpareServers', 'maxSpareServers', 'maxRequests', 'processIdleTimeoutSec'] as const
export const FPM_MAX_CHILDREN = 1024

/** Structural pool errors, matching the checks php-fpm itself runs at startup. */
export const fpmErrors = (fpm: unknown): string[] => {
  if (!isRecord(fpm)) return ['fpm settings must be an object']
  const errors = Object.keys(fpm).filter((k) => !(FPM_KEYS as readonly string[]).includes(k)).map((k) => `${k} is not a known field`)
  if (!(FPM_MODES as readonly unknown[]).includes(fpm.mode)) errors.push('mode must be ondemand, dynamic or static')
  if (!isInt(fpm.maxChildren, 1, FPM_MAX_CHILDREN)) errors.push(`maxChildren must be an integer between 1 and ${FPM_MAX_CHILDREN}`)
  for (const k of ['startServers', 'minSpareServers', 'maxSpareServers'] as const) {
    if (!isInt(fpm[k], 0, FPM_MAX_CHILDREN)) errors.push(`${k} must be an integer between 0 and ${FPM_MAX_CHILDREN}`)
  }
  // 0 = never recycle, as php-fpm documents for pm.max_requests
  if (!isInt(fpm.maxRequests, 0, 10_000_000)) errors.push('maxRequests must be an integer between 0 and 10000000')
  if (!isInt(fpm.processIdleTimeoutSec, 0, 86400)) errors.push('processIdleTimeoutSec must be an integer between 0 and 86400')
  if (errors.length > 0) return errors
  const f = fpm as unknown as FpmSettings
  if (f.mode === 'dynamic') {
    if (f.minSpareServers < 1) errors.push('dynamic: minSpareServers must be at least 1')
    if (f.minSpareServers > f.startServers) errors.push('dynamic: minSpareServers must not exceed startServers')
    if (f.startServers > f.maxSpareServers) errors.push('dynamic: startServers must not exceed maxSpareServers')
    if (f.maxSpareServers > f.maxChildren) errors.push('dynamic: maxSpareServers must not exceed maxChildren')
  }
  if (f.mode === 'ondemand' && f.processIdleTimeoutSec <= 0) errors.push('ondemand: processIdleTimeoutSec must be greater than 0')
  return errors
}

/** VALIDATION for a malformed pool, LIMIT_EXCEEDED when maxChildren breaks the plan's cap. */
export const validateFpm = (fpm: unknown, phpWorkersCap: Limit): FpmSettings => {
  if (!isLimit(phpWorkersCap, 1)) return invalid('plan phpWorkers cap is invalid', { phpWorkersCap })
  throwIfErrors('PHP-FPM pool', fpmErrors(fpm))
  const f = fpm as FpmSettings
  if (!isUnlimited(phpWorkersCap) && f.maxChildren > phpWorkersCap) {
    return fail('LIMIT_EXCEEDED', `maxChildren ${f.maxChildren} exceeds the plan's PHP worker cap of ${phpWorkersCap}`, {
      what: 'PHP workers per domain',
      limit: phpWorkersCap,
      requested: f.maxChildren,
    })
  }
  return {
    mode: f.mode,
    maxChildren: f.maxChildren,
    startServers: f.startServers,
    minSpareServers: f.minSpareServers,
    maxSpareServers: f.maxSpareServers,
    maxRequests: f.maxRequests,
    processIdleTimeoutSec: f.processIdleTimeoutSec,
  }
}

/**
 * A default pool (e.g. suggestServerSettings().fpm) shrunk to the plan's PHP worker cap, with
 * the spare counts following so the dynamic-mode ordering still holds. For deriving a new
 * domain's pool only; user-submitted pools go through validateFpm and are refused, not shrunk.
 */
export const fitFpmToCap = (fpm: FpmSettings, phpWorkersCap: Limit): FpmSettings => {
  if (!isLimit(phpWorkersCap, 1)) return invalid('plan phpWorkers cap is invalid', { phpWorkersCap })
  throwIfErrors('PHP-FPM pool', fpmErrors(fpm))
  if (isUnlimited(phpWorkersCap) || fpm.maxChildren <= phpWorkersCap) return validateFpm(fpm, phpWorkersCap)
  const maxChildren = phpWorkersCap
  const maxSpareServers = Math.min(fpm.maxSpareServers, maxChildren)
  const startServers = Math.min(fpm.startServers, maxSpareServers)
  const minSpareServers = Math.min(fpm.minSpareServers, startServers)
  return validateFpm({ ...fpm, maxChildren, maxSpareServers, startServers, minSpareServers }, phpWorkersCap)
}

/**
 * Disabled in every pool unless root grants an exception. Covers process execution and
 * control, new namespaces (pcntl_unshare), environment tampering (LD_PRELOAD via putenv),
 * known command-injection vectors (imap_open), and syslog writes: with openlog() a site could
 * forge sshd failure lines under any ident and get the SSH failure ban to block an address.
 */
export const DANGEROUS_FUNCTIONS: readonly string[] = [
  'exec', 'passthru', 'shell_exec', 'system', 'proc_open', 'popen', 'proc_close', 'proc_get_status',
  'proc_nice', 'proc_terminate', 'pcntl_exec', 'pcntl_fork', 'pcntl_rfork', 'pcntl_forkx', 'pcntl_unshare',
  'pcntl_signal', 'pcntl_alarm', 'pcntl_waitpid', 'pcntl_wait', 'pcntl_setpriority', 'posix_kill',
  'posix_mkfifo', 'posix_setpgid', 'posix_setsid', 'posix_setuid', 'posix_setgid', 'posix_seteuid',
  'posix_setegid', 'putenv', 'dl', 'imap_open', 'expect_popen', 'link', 'symlink', 'openlog', 'syslog',
  'apache_setenv',
]

const FUNCTION_RE = /^[a-z_][a-z0-9_]{0,63}$/

/** The pool's disable_functions list minus root-granted exceptions (which must be on the list). */
export const disabledFunctions = (exceptions: readonly unknown[] = []): string[] => {
  if (!Array.isArray(exceptions)) return invalid('function exceptions must be an array of names')
  for (const fn of exceptions) {
    if (typeof fn !== 'string' || !FUNCTION_RE.test(fn)) invalid('invalid function name', { fn })
    if (!DANGEROUS_FUNCTIONS.includes(fn as string)) invalid(`"${fn as string}" is not a disabled function`, { fn })
  }
  return DANGEROUS_FUNCTIONS.filter((fn) => !exceptions.includes(fn))
}

// ---- php.ini allowlist ---------------------------------------------------------------

/** `user`: settable in .user.ini (PHP_INI_PERDIR/ALL). `pool`: PHP_INI_SYSTEM, php_admin_value only. */
export type PhpIniScope = 'user' | 'pool'

interface IniDirective {
  scope: PhpIniScope
  hint: string
  normalize: (v: string, opts: PhpIniOptions) => string | null
}

export interface PhpIniOptions {
  /** the plan's memory cap; memory_limit may not exceed it */
  maxMemoryMb?: Limit
}

const UNITS: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }

const SIZE_RE = /^(\d{1,12})([KMG]?)$/i

/** php.ini shorthand size (`64M`, `1G`, `512K`, bytes) to bytes; null when malformed. */
export const parseIniSize = (v: string): number | null => {
  const m = SIZE_RE.exec(v)
  if (!m) return null
  return Number(m[1]) * (UNITS[(m[2] ?? '').toUpperCase()] ?? 1)
}

const canonicalSize = (v: string): string => {
  const m = SIZE_RE.exec(v)
  return m ? `${Number(m[1])}${(m[2] ?? '').toUpperCase()}` : v
}

const size = (min: number, max: number) => (v: string): string | null => {
  const bytes = parseIniSize(v)
  return bytes !== null && bytes >= min && bytes <= max ? canonicalSize(v) : null
}

const int = (min: number, max: number) => (v: string): string | null =>
  /^-?\d{1,10}$/.test(v) && Number(v) >= min && Number(v) <= max ? String(Number(v)) : null

const bool = (v: string): string | null => {
  const s = v.toLowerCase()
  if (['1', 'on', 'true', 'yes'].includes(s)) return 'On'
  if (['0', 'off', 'false', 'no'].includes(s)) return 'Off'
  return null
}

const oneOf = (values: readonly string[]) => (v: string): string | null => values.find((x) => x.toLowerCase() === v.toLowerCase()) ?? null

const E_CONSTANTS = new Set([
  'E_ERROR', 'E_WARNING', 'E_PARSE', 'E_NOTICE', 'E_CORE_ERROR', 'E_CORE_WARNING', 'E_COMPILE_ERROR',
  'E_COMPILE_WARNING', 'E_USER_ERROR', 'E_USER_WARNING', 'E_USER_NOTICE', 'E_STRICT',
  'E_RECOVERABLE_ERROR', 'E_DEPRECATED', 'E_USER_DEPRECATED', 'E_ALL',
])

const errorLevel = (v: string): string | null => {
  const s = v.trim()
  if (/^-?\d{1,6}$/.test(s)) return String(Number(s))
  const term = String.raw`~?\s*(?:E_[A-Z_]+|\d{1,6})`
  if (!new RegExp(String.raw`^${term}(?:\s*[&|^]\s*${term})*$`).test(s)) return null
  const constants = s.match(/E_[A-Z_]+/g) ?? []
  if (!constants.every((c) => E_CONSTANTS.has(c))) return null
  return s.replace(/\s*([&|^])\s*/g, ' $1 ').replace(/~\s+/g, '~')
}

const timezone = (v: string): string | null => {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(v)) return null
  try {
    new Intl.DateTimeFormat('en', { timeZone: v })
    return v
  } catch {
    return null
  }
}

const memoryLimit = (v: string, opts: PhpIniOptions): string | null => {
  const bytes = parseIniSize(v)
  if (bytes === null || bytes < 16 * 1024 ** 2 || bytes > 64 * 1024 ** 3) return null
  const cap = opts.maxMemoryMb
  if (cap !== undefined && !isUnlimited(cap) && bytes > cap * 1024 ** 2) return null
  return canonicalSize(v)
}

const outputBuffering = (v: string): string | null => bool(v) ?? int(0, 16 * 1024 * 1024)(v)

const GiB = 1024 ** 3

export const PHP_INI_DIRECTIVES: Readonly<Record<string, IniDirective>> = {
  memory_limit: { scope: 'user', hint: 'size from 16M up to the plan memory, e.g. 256M', normalize: memoryLimit },
  upload_max_filesize: { scope: 'user', hint: 'size from 1K to 64G, e.g. 64M', normalize: size(1024, 64 * GiB) },
  post_max_size: { scope: 'user', hint: 'size from 1K to 64G, e.g. 64M', normalize: size(1024, 64 * GiB) },
  max_execution_time: { scope: 'user', hint: 'seconds, 1-86400', normalize: int(1, 86400) },
  max_input_time: { scope: 'user', hint: 'seconds, -1-86400', normalize: int(-1, 86400) },
  max_input_vars: { scope: 'user', hint: 'integer, 1-100000', normalize: int(1, 100000) },
  max_input_nesting_level: { scope: 'user', hint: 'integer, 1-1024', normalize: int(1, 1024) },
  max_file_uploads: { scope: 'user', hint: 'integer, 1-1000', normalize: int(1, 1000) },
  default_socket_timeout: { scope: 'user', hint: 'seconds, 1-3600', normalize: int(1, 3600) },
  display_errors: { scope: 'user', hint: 'On or Off', normalize: bool },
  display_startup_errors: { scope: 'user', hint: 'On or Off', normalize: bool },
  log_errors: { scope: 'user', hint: 'On or Off', normalize: bool },
  html_errors: { scope: 'user', hint: 'On or Off', normalize: bool },
  error_reporting: { scope: 'user', hint: 'E_* constants with & | ^ ~, or an integer', normalize: errorLevel },
  'date.timezone': { scope: 'user', hint: 'IANA zone such as Asia/Gaza or UTC', normalize: timezone },
  short_open_tag: { scope: 'user', hint: 'On or Off', normalize: bool },
  output_buffering: { scope: 'user', hint: 'On, Off or a buffer size in bytes', normalize: outputBuffering },
  'zlib.output_compression': { scope: 'user', hint: 'On or Off', normalize: bool },
  default_charset: { scope: 'user', hint: 'charset name such as UTF-8', normalize: (v) => (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,31}$/.test(v) ? v : null) },
  'session.gc_maxlifetime': { scope: 'user', hint: 'seconds, 1-2592000', normalize: int(1, 2_592_000) },
  'session.cookie_lifetime': { scope: 'user', hint: 'seconds, 0-31536000', normalize: int(0, 31_536_000) },
  'session.cookie_secure': { scope: 'user', hint: 'On or Off', normalize: bool },
  'session.cookie_httponly': { scope: 'user', hint: 'On or Off', normalize: bool },
  'session.use_strict_mode': { scope: 'user', hint: 'On or Off', normalize: bool },
  'session.use_only_cookies': { scope: 'user', hint: 'On or Off', normalize: bool },
  'session.cookie_samesite': { scope: 'user', hint: 'Strict, Lax or None', normalize: oneOf(['Strict', 'Lax', 'None']) },
  allow_url_fopen: { scope: 'pool', hint: 'On or Off', normalize: bool },
  file_uploads: { scope: 'pool', hint: 'On or Off', normalize: bool },
}

/** Directives the server owns. Named explicitly so the error says why, not just "unknown". */
export const FORBIDDEN_PHP_DIRECTIVES: ReadonlySet<string> = new Set([
  'disable_functions', 'disable_classes', 'open_basedir', 'allow_url_include', 'auto_prepend_file',
  'auto_append_file', 'include_path', 'extension', 'zend_extension', 'extension_dir', 'enable_dl',
  'sendmail_path', 'sendmail_from', 'mail.log', 'mail.add_x_header', 'error_log', 'session.save_path',
  'session.save_handler', 'upload_tmp_dir', 'sys_temp_dir', 'user_ini.filename', 'user_ini.cache_ttl',
  'doc_root', 'user_dir', 'expose_php', 'opcache.restrict_api', 'opcache.file_cache',
])

export const MAX_INI_ENTRIES = 64

export const phpIniScope = (name: string): PhpIniScope | null => PHP_INI_DIRECTIVES[name]?.scope ?? null

/**
 * Validates per-site php.ini values against the allowlist and returns canonical values.
 * Rejects (never drops) unknown or server-owned directives and malformed values, so what
 * the user saved is exactly what gets written.
 */
export const sanitizePhpIni = (ini: unknown, opts: PhpIniOptions = {}): Record<string, string> => {
  if (!isRecord(ini)) return invalid('php.ini settings must be an object')
  // a malformed cap would compare as NaN and silently lift the memory limit
  if (!isRecord(opts) || (opts.maxMemoryMb !== undefined && !isLimit(opts.maxMemoryMb, 1))) return invalid('maxMemoryMb must be a positive integer or "unlimited"')
  const names = Object.keys(ini)
  if (names.length > MAX_INI_ENTRIES) return invalid(`at most ${MAX_INI_ENTRIES} php.ini directives may be set`)
  const errors: string[] = []
  const out: Record<string, string> = {}
  for (const name of names) {
    const raw = ini[name]
    const shown = name.slice(0, 64)
    if (FORBIDDEN_PHP_DIRECTIVES.has(name) || name.startsWith('cgi.') || name.startsWith('fastcgi.')) {
      errors.push(`${shown} is managed by the server and cannot be set per site`)
      continue
    }
    const directive = Object.hasOwn(PHP_INI_DIRECTIVES, name) ? PHP_INI_DIRECTIVES[name] : undefined
    if (!directive) {
      errors.push(`${shown} is not an allowed directive`)
      continue
    }
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256 || hasControlChars(raw)) {
      errors.push(`${name} needs a value: ${directive.hint}`)
      continue
    }
    const value = directive.normalize(raw.trim(), opts)
    if (value === null) errors.push(`${name}: invalid value (${directive.hint})`)
    else out[name] = value
  }
  const upload = out.upload_max_filesize === undefined ? null : parseIniSize(out.upload_max_filesize)
  const post = out.post_max_size === undefined ? null : parseIniSize(out.post_max_size)
  if (upload !== null && post !== null && upload > post) errors.push('upload_max_filesize must not exceed post_max_size')
  throwIfErrors('php.ini settings', errors)
  return out
}

