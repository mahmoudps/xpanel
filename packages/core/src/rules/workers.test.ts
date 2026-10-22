import { describe, expect, it } from 'vitest'
import { XpanelError } from '../errors.ts'
import { apacheWorkerErrors, nginxWorkerErrors, suggestServerSettings, validateApacheWorkers, validateNginxWorkers } from './workers.ts'
import type { ApacheWorkers, NginxWorkers } from './workers.ts'
import { fitFpmToCap, fpmErrors, validateFpm } from './php.ts'
import { defaultPlan } from './plans.ts'

const code = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof XpanelError) return e.code
    throw e
  }
}

describe('suggestServerSettings', () => {
  const profiles = [
    { cores: 1, memoryMb: 256 },
    { cores: 1, memoryMb: 512 },
    { cores: 2, memoryMb: 2048 },
    { cores: 4, memoryMb: 8192 },
    { cores: 16, memoryMb: 65536 },
    { cores: 128, memoryMb: 1_048_576 },
  ]

  it.each(profiles)('produces values that pass its own validators (%o)', (hw) => {
    const s = suggestServerSettings(hw)
    expect(apacheWorkerErrors(s.apache)).toEqual([])
    expect(nginxWorkerErrors(s.nginx)).toEqual([])
    expect(fpmErrors(s.fpm)).toEqual([])
    expect(fpmErrors({ ...s.fpm, mode: 'dynamic' })).toEqual([])
    expect(s.nginx.workerProcesses).toBe(hw.cores)
    expect(s.nginx.workerRlimitNofile).toBeGreaterThanOrEqual(s.nginx.workerConnections * 2)
    expect(s.apache.serverLimit).toBeGreaterThanOrEqual(s.apache.maxRequestWorkers)
    expect(s.fpm.maxChildren).toBeGreaterThanOrEqual(2)
    expect(s.fpm.maxChildren).toBeLessThanOrEqual(10)
  })

  it('the suggested pool can exceed a plan cap and must be fitted to it', () => {
    const big = suggestServerSettings({ cores: 8, memoryMb: 16384 })
    const cap = defaultPlan().caps.phpWorkers as number
    expect(big.fpm.maxChildren).toBeGreaterThan(cap)
    expect(code(() => validateFpm(big.fpm, cap))).toBe('LIMIT_EXCEEDED')
    for (const hw of profiles) {
      const fpm = suggestServerSettings(hw).fpm
      for (const c of [1, 2, cap, 'unlimited' as const]) {
        const fitted = fitFpmToCap(fpm, c)
        expect(c === 'unlimited' || fitted.maxChildren <= c).toBe(true)
        expect(fpmErrors({ ...fitted, mode: 'dynamic' })).toEqual([])
      }
    }
  })

  it('scales Apache workers with memory and never below the floor', () => {
    const small = suggestServerSettings({ cores: 1, memoryMb: 512 })
    const mid = suggestServerSettings({ cores: 4, memoryMb: 8192 })
    const big = suggestServerSettings({ cores: 16, memoryMb: 65536 })
    expect(small.apache.maxRequestWorkers).toBe(16)
    expect(small.notes.length).toBeGreaterThan(0)
    expect(mid.apache.maxRequestWorkers).toBeGreaterThan(small.apache.maxRequestWorkers)
    expect(big.apache.maxRequestWorkers).toBeGreaterThan(mid.apache.maxRequestWorkers)
    expect(suggestServerSettings({ cores: 128, memoryMb: 16 * 1024 * 1024 }).apache.maxRequestWorkers).toBe(2000)
  })

  it('reserves memory for the OS and MariaDB before Apache', () => {
    const s = suggestServerSettings({ cores: 4, memoryMb: 8192 })
    const { osReserve, dbReserve, apache, php } = s.budgetMb
    expect(osReserve + dbReserve + apache + php).toBe(8192)
    expect(s.apache.maxRequestWorkers * 24).toBeLessThanOrEqual(apache)
  })

  it('takes per-child estimates into account', () => {
    const light = suggestServerSettings({ cores: 4, memoryMb: 16384 }, { apacheChildMb: 12 })
    const heavy = suggestServerSettings({ cores: 4, memoryMb: 16384 }, { apacheChildMb: 48 })
    expect(light.apache.maxRequestWorkers).toBeGreaterThan(heavy.apache.maxRequestWorkers)
  })

  it.each([
    { cores: 0, memoryMb: 1024 },
    { cores: 1.5, memoryMb: 1024 },
    { cores: -2, memoryMb: 1024 },
    { cores: 2, memoryMb: 128 },
    { cores: 2, memoryMb: Number.NaN },
    { cores: '4' as unknown as number, memoryMb: 1024 },
  ])('rejects bad hardware %o', (hw) => {
    expect(code(() => suggestServerSettings(hw))).toBe('VALIDATION')
  })

  it('rejects bad options and non-objects', () => {
    expect(code(() => suggestServerSettings({ cores: 2, memoryMb: 2048 }, { apacheChildMb: 0 }))).toBe('VALIDATION')
    expect(code(() => suggestServerSettings(null as unknown as { cores: number; memoryMb: number }))).toBe('VALIDATION')
    expect(code(() => suggestServerSettings({ cores: 2, memoryMb: 2048 }, null as unknown as object))).toBe('VALIDATION')
  })
})

const apache = (over: Partial<ApacheWorkers> = {}): ApacheWorkers => ({
  startServers: 5,
  minSpareServers: 5,
  maxSpareServers: 10,
  maxRequestWorkers: 150,
  maxConnectionsPerChild: 0,
  serverLimit: 150,
  ...over,
})

describe('validateApacheWorkers', () => {
  it('accepts upstream defaults and returns a copy', () => {
    const a = apache()
    const out = validateApacheWorkers(a)
    expect(out).toEqual(a)
    expect(out).not.toBe(a)
  })

  it.each<[string, Partial<ApacheWorkers>]>([
    ['minSpare > maxSpare', { minSpareServers: 11 }],
    ['minSpare equal to maxSpare (Apache would silently raise maxSpare)', { minSpareServers: 10, startServers: 10 }],
    ['startServers below minSpare', { startServers: 4 }],
    ['startServers above maxSpare', { startServers: 11 }],
    ['maxSpare above maxRequestWorkers', { maxSpareServers: 200, startServers: 5, maxRequestWorkers: 150 }],
    ['serverLimit below maxRequestWorkers', { serverLimit: 149 }],
    ['zero startServers', { startServers: 0 }],
    ['zero maxRequestWorkers', { maxRequestWorkers: 0 }],
    ['negative', { minSpareServers: -1 }],
    ['fraction', { maxRequestWorkers: 150.5 }],
    ['above hard limit', { serverLimit: 20001, maxRequestWorkers: 20001 }],
    ['negative maxConnectionsPerChild', { maxConnectionsPerChild: -1 }],
  ])('rejects %s', (_, over) => {
    expect(code(() => validateApacheWorkers(apache(over)))).toBe('VALIDATION')
  })

  it('allows the boundaries', () => {
    expect(() => validateApacheWorkers(apache({ startServers: 10 }))).not.toThrow()
    expect(() => validateApacheWorkers(apache({ minSpareServers: 9, startServers: 9 }))).not.toThrow()
    expect(() => validateApacheWorkers(apache({ serverLimit: 20000 }))).not.toThrow()
  })

  it('rejects unknown keys, missing keys and non-objects', () => {
    expect(code(() => validateApacheWorkers({ ...apache(), threadsPerChild: 25 }))).toBe('VALIDATION')
    const { serverLimit: _, ...missing } = apache()
    expect(code(() => validateApacheWorkers(missing))).toBe('VALIDATION')
    expect(code(() => validateApacheWorkers('MaxRequestWorkers 150'))).toBe('VALIDATION')
  })
})

const nginx = (over: Partial<NginxWorkers> = {}): NginxWorkers => ({
  workerProcesses: 'auto',
  workerConnections: 1024,
  workerRlimitNofile: 2048,
  multiAccept: true,
  keepaliveTimeoutSec: 0,
  ...over,
})

describe('validateNginxWorkers', () => {
  it('accepts auto, numbers and the 2x rlimit boundary', () => {
    expect(validateNginxWorkers(nginx())).toEqual(nginx())
    expect(() => validateNginxWorkers(nginx({ workerProcesses: 8 }))).not.toThrow()
  })

  it.each<[string, Partial<NginxWorkers>]>([
    ['rlimit below 2x connections', { workerRlimitNofile: 2047 }],
    ['zero processes', { workerProcesses: 0 }],
    ['too many processes', { workerProcesses: 5000 }],
    ['string processes', { workerProcesses: '4' as unknown as number }],
    ['tiny connections', { workerConnections: 10, workerRlimitNofile: 20 }],
    ['rlimit above nr_open', { workerConnections: 600_000, workerRlimitNofile: 1_200_000 }],
    ['non-bool multiAccept', { multiAccept: 'on' as unknown as boolean }],
    ['negative keepalive', { keepaliveTimeoutSec: -1 }],
    ['huge keepalive', { keepaliveTimeoutSec: 3601 }],
  ])('rejects %s', (_, over) => {
    expect(code(() => validateNginxWorkers(nginx(over)))).toBe('VALIDATION')
  })

  it('rejects injection through unknown keys', () => {
    expect(code(() => validateNginxWorkers({ ...nginx(), 'worker_processes 1; include /etc/shadow': 1 }))).toBe('VALIDATION')
  })
})
