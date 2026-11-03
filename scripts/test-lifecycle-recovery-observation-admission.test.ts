import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
const seams = vi.hoisted(() => ({ capability: {}, spawns: [] as string[][] }))
vi.mock('node:child_process', () => ({ spawn: (_path: string, args: string[]) => {
  seams.spawns.push(args); const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 0, null)); return child
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
