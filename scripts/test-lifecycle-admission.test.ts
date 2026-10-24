import { describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ namespace: true, bytes: null as Buffer | null, failure: null as Error | null, reads: 0 }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    if (args[0] === '/var/lib/xpanel-lifecycle') return {} as Awaited<ReturnType<typeof actual.lstat>>
    return actual.lstat(...args)
  } }
})
vi.mock('./lifecycle-ownership.mjs', () => ({ withTrustedDirectory: async (_path: string, callback: () => unknown) => { if (state.failure) throw state.failure; return callback() }, withTrustedFile: async (path: string, options: { exactMode: number }, callback: (pin: {bytes:Buffer}) => unknown) => {
  state.reads++
  if (path !== '/var/lib/xpanel-lifecycle/writer-barrier.json' || options.exactMode !== 0o644) throw new Error('unexpected path')
  if (state.failure) throw state.failure
  if (!state.bytes) throw Object.assign(new Error('absent'), { code: 'ENOENT' })
  return callback({ bytes: state.bytes })
} }))
import { assertLifecycleWritesAllowed, lifecycleAdmissionResponse, readLifecyclePublicStatus } from './lifecycle-admission.mjs'

const barrier = { schemaVersion: 1, operationId: '12345678-1234-4234-8234-123456789abc', reference: 'XP-JOB-2026-000001', kind: 'upgrade', phase: 'pending', requestFingerprint: 'a'.repeat(64), sequence: 1, createdAt: '2026-10-24T12:00:00.000Z' }
describe('read-only lifecycle negative admission (synthetic trusted-reader seam)', () => {
  it('keeps ordinary operation when no barrier exists without claiming native readiness', async () => {
    state.failure = null; state.bytes = null
    await expect(assertLifecycleWritesAllowed()).resolves.toBeUndefined()
    expect(await readLifecyclePublicStatus()).toEqual({ active: false, reference: null, phase: 'normal' })
    expect(await lifecycleAdmissionResponse(new Request('http://localhost/api/accounts'))).toBeNull()
  })
  it('blocks before auth/session work across active, malformed, unread and wrong-owner barriers', async () => {
    for (const fixture of [JSON.stringify(barrier), JSON.stringify({ ...barrier, phase: 'retirement_pending' }), '{bad', JSON.stringify({ ...barrier, phase: 'idle' })]) {
      state.failure = null; state.bytes = Buffer.from(fixture)
      await expect(assertLifecycleWritesAllowed()).rejects.toThrow()
      const denied = await lifecycleAdmissionResponse(new Request('http://localhost/api/auth/login', { method: 'POST' }))
      expect(denied?.status).toBe(503); expect(denied?.headers.get('set-cookie')).toBeNull()
    }
    for (const code of ['EACCES', 'TRUSTED_FILE_REQUIRED', 'TRUSTED_PARENT_DRIFT']) {
      state.failure = Object.assign(new Error(code), { code })
      expect((await lifecycleAdmissionResponse(new Request('http://localhost/login')))?.status).toBe(503)
    }
    state.failure = null
  })
  it('allows only exact process health and never a method, query or trailing-slash lookalike', async () => {
    state.bytes = Buffer.from(JSON.stringify(barrier)); state.failure = null
    expect(await lifecycleAdmissionResponse(new Request('http://localhost/api/health'))).toBeNull()
    for (const [path, method] of [['/api/health/', 'GET'], ['/api/health?apply=1', 'GET'], ['/api/health', 'POST'], ['/api/health', 'HEAD']]) expect((await lifecycleAdmissionResponse(new Request('http://localhost' + path, { method })))?.status).toBe(503)
  })
})
