import { describe, expect, it } from 'vitest'
import { XpanelError } from '../errors.ts'
import type { FpmSettings } from './workers.ts'
import {
  DANGEROUS_FUNCTIONS,
  assertHandlerAvailable,
  availableHandlers,
  disabledFunctions,
  fitFpmToCap,
  parseIniSize,
  phpIniScope,
  sanitizePhpIni,
  validateFpm,
} from './php.ts'

const code = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof XpanelError) return e.code
    throw e
  }
}

const avail = (m: ReturnType<typeof availableHandlers>) => m.handlers.filter((h) => h.available).map((h) => h.handler)

describe('availableHandlers', () => {
  it('Apache + itk: fpm (default) and cgi, never suphp or lsphp', () => {
    const m = availableHandlers({ engine: 'apache', mpm: 'itk', itkAvailable: true })
    expect(avail(m)).toEqual(['fpm', 'cgi'])
    expect(m.defaultHandler).toBe('fpm')
    expect(m.handlers.find((h) => h.default)?.handler).toBe('fpm')
    expect(m.sharedIdentity).toBe(false)
    expect(m.handlers.every((h) => !h.sharedIdentity)).toBe(true)
    expect(m.handlers.find((h) => h.handler === 'suphp')?.reason).toMatch(/itk/)
  })

  it('itk requested without the package is ENGINE_UNAVAILABLE, never a silent fallback', () => {
    expect(code(() => availableHandlers({ engine: 'apache', mpm: 'itk', itkAvailable: false }))).toBe('ENGINE_UNAVAILABLE')
    expect(code(() => availableHandlers({ engine: 'apache', mpm: 'itk', itkAvailable: 'yes' as unknown as boolean }))).toBe('ENGINE_UNAVAILABLE')
  })

  it('Apache + prefork: suphp appears, flagged as shared identity', () => {
    const m = availableHandlers({ engine: 'apache', mpm: 'prefork', itkAvailable: false })
    expect(avail(m)).toEqual(['fpm', 'cgi', 'suphp'])
    expect(m.defaultHandler).toBe('fpm')
    expect(m.sharedIdentity).toBe(true)
    expect(m.handlers.find((h) => h.handler === 'suphp')).toMatchObject({ available: true, sharedIdentity: true })
    expect(m.warnings.length).toBeGreaterThan(0)
  })

  it('OpenLiteSpeed: lsphp only, Apache handlers unavailable', () => {
    const m = availableHandlers({ engine: 'openlitespeed', mpm: 'itk', itkAvailable: false })
    expect(avail(m)).toEqual(['lsphp'])
    expect(m.defaultHandler).toBe('lsphp')
    expect(m.mpm).toBeNull()
    for (const h of m.handlers.filter((x) => x.handler !== 'lsphp')) expect(h.reason).toMatch(/OpenLiteSpeed/)
  })

  it('rejects unknown engines and MPMs', () => {
    expect(code(() => availableHandlers({ engine: 'nginx' as 'apache', mpm: 'itk', itkAvailable: true }))).toBe('VALIDATION')
    expect(code(() => availableHandlers({ engine: 'apache', mpm: 'event' as 'itk', itkAvailable: true }))).toBe('VALIDATION')
    expect(code(() => availableHandlers(null as unknown as Parameters<typeof availableHandlers>[0]))).toBe('VALIDATION')
  })

  it('assertHandlerAvailable gates handler switches', () => {
    const itk = { engine: 'apache' as const, mpm: 'itk' as const, itkAvailable: true }
    expect(assertHandlerAvailable('fpm', itk).handler).toBe('fpm')
    expect(code(() => assertHandlerAvailable('suphp', itk))).toBe('ENGINE_UNAVAILABLE')
    expect(code(() => assertHandlerAvailable('lsphp', itk))).toBe('ENGINE_UNAVAILABLE')
    expect(code(() => assertHandlerAvailable('fpm', { engine: 'openlitespeed', mpm: 'itk', itkAvailable: false }))).toBe('ENGINE_UNAVAILABLE')
    expect(code(() => assertHandlerAvailable('mod_php' as 'fpm', itk))).toBe('VALIDATION')
  })
})

const fpm = (over: Partial<FpmSettings> = {}): FpmSettings => ({
  mode: 'dynamic',
  maxChildren: 8,
  startServers: 2,
  minSpareServers: 1,
  maxSpareServers: 3,
  maxRequests: 500,
  processIdleTimeoutSec: 10,
  ...over,
})

describe('validateFpm', () => {
  it('accepts a dynamic pool inside the cap and at the cap', () => {
    expect(validateFpm(fpm(), 8)).toEqual(fpm())
    expect(validateFpm(fpm({ maxChildren: 500 }), 'unlimited').maxChildren).toBe(500)
  })

  it('LIMIT_EXCEEDED above the plan cap', () => {
    expect(code(() => validateFpm(fpm({ maxChildren: 9 }), 8))).toBe('LIMIT_EXCEEDED')
  })

  it.each<[string, Partial<FpmSettings>]>([
    ['minSpare > start', { minSpareServers: 3, startServers: 2 }],
    ['start > maxSpare', { startServers: 4 }],
    ['maxSpare > maxChildren', { maxSpareServers: 9, maxChildren: 8 }],
    ['minSpare 0', { minSpareServers: 0, startServers: 0 }],
    ['maxChildren 0', { maxChildren: 0 }],
    ['negative', { maxRequests: -1 }],
    ['fraction', { maxChildren: 2.5 }],
    ['huge', { maxChildren: 5000 }],
    ['bad mode', { mode: 'adaptive' as 'static' }],
  ])('rejects %s', (_, over) => {
    expect(code(() => validateFpm(fpm(over), 'unlimited'))).toBe('VALIDATION')
  })

  it('ondemand needs an idle timeout; spare counts are not checked', () => {
    expect(code(() => validateFpm(fpm({ mode: 'ondemand', processIdleTimeoutSec: 0 }), 8))).toBe('VALIDATION')
    expect(() => validateFpm(fpm({ mode: 'ondemand', startServers: 9, minSpareServers: 0 }), 8)).not.toThrow()
  })

  it('static only needs maxChildren', () => {
    expect(() => validateFpm(fpm({ mode: 'static', minSpareServers: 0, startServers: 0, maxSpareServers: 0, processIdleTimeoutSec: 0 }), 8)).not.toThrow()
  })

  it('rejects a malformed cap and unknown keys', () => {
    expect(code(() => validateFpm(fpm(), 0))).toBe('VALIDATION')
    expect(code(() => validateFpm(fpm(), -1))).toBe('VALIDATION')
    expect(code(() => validateFpm({ ...fpm(), 'pm.status_path': '/status' }, 8))).toBe('VALIDATION')
    expect(code(() => validateFpm(null, 8))).toBe('VALIDATION')
  })
})

describe('fitFpmToCap', () => {
  const pool = fpm({ maxChildren: 10, startServers: 4, minSpareServers: 2, maxSpareServers: 6 })

  it('shrinks maxChildren and keeps min <= start <= maxSpare <= max', () => {
    expect(fitFpmToCap(pool, 3)).toEqual({ ...pool, maxChildren: 3, maxSpareServers: 3, startServers: 3, minSpareServers: 2 })
    expect(fitFpmToCap(pool, 1)).toEqual({ ...pool, maxChildren: 1, maxSpareServers: 1, startServers: 1, minSpareServers: 1 })
  })

  it('leaves a pool already inside the cap alone and returns a copy', () => {
    expect(fitFpmToCap(pool, 10)).toEqual(pool)
    expect(fitFpmToCap(pool, 'unlimited')).not.toBe(pool)
  })

  it('still refuses malformed pools and caps', () => {
    expect(code(() => fitFpmToCap(fpm({ minSpareServers: 0, startServers: 0 }), 4))).toBe('VALIDATION')
    expect(code(() => fitFpmToCap(pool, 0))).toBe('VALIDATION')
    expect(code(() => fitFpmToCap(pool, '4' as unknown as number))).toBe('VALIDATION')
  })
})

describe('sanitizePhpIni', () => {
  it('canonicalizes allowed values', () => {
    expect(
      sanitizePhpIni({
        memory_limit: '256m',
        upload_max_filesize: '064M',
        post_max_size: '128M',
        max_execution_time: '60',
        max_input_vars: '5000',
        display_errors: 'off',
        log_errors: '1',
        'date.timezone': 'Asia/Gaza',
        error_reporting: 'E_ALL&~E_DEPRECATED & ~E_STRICT',
        output_buffering: '4096',
        'session.cookie_samesite': 'lax',
      }),
    ).toEqual({
      memory_limit: '256M',
      upload_max_filesize: '64M',
      post_max_size: '128M',
      max_execution_time: '60',
      max_input_vars: '5000',
      display_errors: 'Off',
      log_errors: 'On',
      'date.timezone': 'Asia/Gaza',
      error_reporting: 'E_ALL & ~E_DEPRECATED & ~E_STRICT',
      output_buffering: '4096',
      'session.cookie_samesite': 'Lax',
    })
  })

  it('accepts UTC and integer error levels', () => {
    expect(sanitizePhpIni({ 'date.timezone': 'UTC', error_reporting: '-1' })).toEqual({ 'date.timezone': 'UTC', error_reporting: '-1' })
    expect(sanitizePhpIni({})).toEqual({})
  })

  it.each([
    ['disable_functions', ''],
    ['open_basedir', '/'],
    ['auto_prepend_file', '/tmp/x.php'],
    ['allow_url_include', 'On'],
    ['extension', 'evil.so'],
    ['sendmail_path', '/bin/sh -c id'],
    ['session.save_path', '/home/alice/tmp'],
    ['cgi.fix_pathinfo', '1'],
    ['error_log', '/etc/passwd'],
  ])('refuses server-owned directive %s', (name, value) => {
    try {
      sanitizePhpIni({ [name]: value })
      expect.unreachable()
    } catch (e) {
      expect((e as XpanelError).code).toBe('VALIDATION')
      expect((e as XpanelError).message).toMatch(/managed by the server/)
    }
  })

  it.each([
    ['memory_limit', '-1'],
    ['memory_limit', '8M'],
    ['memory_limit', '1T'],
    ['memory_limit', '256 M'],
    ['memory_limit', '256M\nauto_prepend_file=/tmp/x'],
    ['upload_max_filesize', '0'],
    ['max_execution_time', '0'],
    ['max_execution_time', '1e3'],
    ['max_input_vars', '1000000'],
    ['display_errors', 'maybe'],
    ['display_errors', ''],
    ['date.timezone', 'Mars/Olympus'],
    ['date.timezone', '../../etc/localtime'],
    ['date.timezone', 'UTC"; system("id'],
    ['error_reporting', 'E_ALL & ~E_EVIL'],
    ['error_reporting', 'E_ALL; extension=x'],
    ['error_reporting', 'E_ALL && E_NOTICE'],
    ['session.cookie_samesite', 'Sometimes'],
    ['default_charset', 'utf-8"'],
  ])('rejects %s=%j', (name, value) => {
    expect(code(() => sanitizePhpIni({ [name]: value }))).toBe('VALIDATION')
  })

  it('rejects unknown directives, non-string values and prototype keys', () => {
    expect(code(() => sanitizePhpIni({ 'Memory_Limit': '128M' }))).toBe('VALIDATION')
    expect(code(() => sanitizePhpIni({ memory_limit: 128 as unknown as string }))).toBe('VALIDATION')
    expect(code(() => sanitizePhpIni(JSON.parse('{"__proto__": {"polluted": "1"}}')))).toBe('VALIDATION')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(code(() => sanitizePhpIni(['memory_limit=1G']))).toBe('VALIDATION')
    expect(code(() => sanitizePhpIni(null))).toBe('VALIDATION')
  })

  it('checks upload size against post size', () => {
    expect(code(() => sanitizePhpIni({ upload_max_filesize: '256M', post_max_size: '128M' }))).toBe('VALIDATION')
    expect(() => sanitizePhpIni({ upload_max_filesize: '128M', post_max_size: '128M' })).not.toThrow()
  })

  it('caps memory_limit at the plan memory', () => {
    expect(sanitizePhpIni({ memory_limit: '1G' }, { maxMemoryMb: 1024 })).toEqual({ memory_limit: '1G' })
    expect(code(() => sanitizePhpIni({ memory_limit: '1025M' }, { maxMemoryMb: 1024 }))).toBe('VALIDATION')
    expect(() => sanitizePhpIni({ memory_limit: '4G' }, { maxMemoryMb: 'unlimited' })).not.toThrow()
  })

  it('fails closed on a malformed memory cap instead of ignoring it', () => {
    for (const cap of ['1024', -1, 0, Number.NaN, 1.5]) {
      expect(code(() => sanitizePhpIni({ memory_limit: '64G' }, { maxMemoryMb: cap as number }))).toBe('VALIDATION')
    }
  })

  it('limits the number of entries and collects all errors', () => {
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`x${i}`, '1']))
    expect(code(() => sanitizePhpIni(many))).toBe('VALIDATION')
    try {
      sanitizePhpIni({ memory_limit: 'x', display_errors: 'y' })
    } catch (e) {
      expect(((e as XpanelError).detail.errors as string[]).length).toBe(2)
    }
  })

  it('exposes where each directive may be written', () => {
    expect(phpIniScope('memory_limit')).toBe('user')
    expect(phpIniScope('allow_url_fopen')).toBe('pool')
    expect(phpIniScope('open_basedir')).toBeNull()
    expect(parseIniSize('2G')).toBe(2 * 1024 ** 3)
    expect(parseIniSize('2X')).toBeNull()
  })
})

describe('dangerous functions', () => {
  it('covers process execution by default', () => {
    for (const fn of ['exec', 'passthru', 'shell_exec', 'system', 'proc_open', 'popen', 'pcntl_exec', 'putenv']) {
      expect(DANGEROUS_FUNCTIONS).toContain(fn)
    }
    expect(disabledFunctions()).toEqual([...DANGEROUS_FUNCTIONS])
  })

  it('also covers namespace creation and syslog forgery', () => {
    for (const fn of ['pcntl_unshare', 'pcntl_rfork', 'openlog', 'syslog']) expect(DANGEROUS_FUNCTIONS).toContain(fn)
  })

  it('every entry is a valid, unique PHP function name', () => {
    expect(new Set(DANGEROUS_FUNCTIONS).size).toBe(DANGEROUS_FUNCTIONS.length)
    for (const fn of DANGEROUS_FUNCTIONS) expect(fn).toMatch(/^[a-z_][a-z0-9_]*$/)
  })

  it('root exceptions remove only listed functions', () => {
    const list = disabledFunctions(['exec', 'proc_open'])
    expect(list).not.toContain('exec')
    expect(list).not.toContain('proc_open')
    expect(list).toContain('system')
    expect(code(() => disabledFunctions(['strlen']))).toBe('VALIDATION')
    expect(code(() => disabledFunctions(['exec,system']))).toBe('VALIDATION')
    expect(code(() => disabledFunctions([42]))).toBe('VALIDATION')
    expect(code(() => disabledFunctions(null as unknown as string[]))).toBe('VALIDATION')
    expect(code(() => disabledFunctions('exec' as unknown as string[]))).toBe('VALIDATION')
  })
})
