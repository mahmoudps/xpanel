import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
const seams = vi.hoisted(() => ({ capability: {}, spawns: [] as string[][], busy: 0 }))
vi.mock('node:child_process', () => ({ spawn: (_path: string, args: string[]) => {
  seams.spawns.push(args); const child = new EventEmitter(); const code = seams.busy > 0 ? (seams.busy--, 1) : 0; queueMicrotask(() => child.emit('close', code, null)); return child
} }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), lstat: async () => ({ dev: 1n, ino: 2n }) }))
vi.mock('./lifecycle-ownership.mjs', () => ({ withTrustedFile: async (_path: string, _options: unknown, callback: (pin: unknown) => unknown) => callback({ fd: 42, verify: vi.fn() }), withTrustedDirectory: vi.fn() }))
vi.mock('./lifecycle-root-safety.mjs', () => ({ assertLifecycleRecoveryObservationHeld: async (cap: unknown) => { if (cap !== seams.capability) throw new Error('unissued native observation') } }))
import { assertLifecycleRecoveryObservationAdmissionHeld, assertLifecycleWriterAdmissionHeld, withLifecycleRecoveryObservationAdmission, withLifecycleWriterAdmission } from './lifecycle-admission.mjs'

// Synthetic protocol seam: this does not certify physical flock or native retained-journal ownership.
describe('recovery observation cannot become writer authority', () => {
  it('rejects copied or absent capability before kernel admission', async () => {
    const before = seams.spawns.length
    await expect(withLifecycleRecoveryObservationAdmission({}, async () => undefined)).rejects.toThrow('unissued')
    expect(seams.spawns.length).toBe(before)
  })
  it.skipIf(process.platform !== 'linux')('holds SH only, forbids nested writes and retires the assertion', async () => {
    await withLifecycleRecoveryObservationAdmission(seams.capability, async () => {
      await assertLifecycleRecoveryObservationAdmissionHeld(seams.capability)
      await expect(assertLifecycleWriterAdmissionHeld()).rejects.toThrow('LIFECYCLE_SHARED_ADMISSION_REQUIRED')
      await expect(withLifecycleWriterAdmission(async () => undefined)).rejects.toThrow('LIFECYCLE_RECOVERY_OBSERVATION_READONLY')
    })
    expect(seams.spawns.every(args => args[0] === '--shared')).toBe(true)
    await expect(assertLifecycleRecoveryObservationAdmissionHeld(seams.capability)).rejects.toThrow('LIFECYCLE_RECOVERY_OBSERVATION_REQUIRED')
  })
})

// flock exits 1 when its wait ends with EX still held elsewhere (an upgrade finishing, release retention).
describe.runIf(process.platform === 'linux')('daemon startup admission while another process holds EX', () => {
  it('asks again after LIFECYCLE_BUSY and runs the startup callback once', async () => {
    seams.busy = 2
    const before = seams.spawns.length, callback = vi.fn(async () => 'ready')
    await expect(withLifecycleWriterAdmission(callback, { busyRetryMs: 1 })).resolves.toBe('ready')
    expect(callback).toHaveBeenCalledTimes(1)
    expect(seams.spawns.length - before).toBe(3)
  })
  it('fails as before without busyRetryMs and never repeats a callback that already ran', async () => {
    seams.busy = 1
    await expect(withLifecycleWriterAdmission(async () => undefined)).rejects.toMatchObject({ code: 'LIFECYCLE_BUSY' })
    const inner = vi.fn(async () => { throw Object.assign(new Error('LIFECYCLE_BUSY'), { code: 'LIFECYCLE_BUSY' }) })
    await expect(withLifecycleWriterAdmission(inner, { busyRetryMs: 1 })).rejects.toMatchObject({ code: 'LIFECYCLE_BUSY' })
    expect(inner).toHaveBeenCalledTimes(1)
  })
})
