import { describe, expect, it, vi } from 'vitest'
import { DPKG_AUDIT_ARGV, RPMDB_VERIFY_ARGV } from '../../../packages/os/src/repair-command.ts'
import { classifyPackageDatabase, isPackageSafetyCommand, observePackageSafety, packageSafetyRefusal } from './ops-package-writers.ts'
import type { PackageSafetyPorts } from './ops-package-writers.ts'

const ports = (comms: Record<string, string>, audit = { ok: true, code: 0, stdout: '', stderr: '' }, overrides: Partial<PackageSafetyPorts> = {}): PackageSafetyPorts => ({
  listProcesses: async () => ['self', 'net', ...Object.keys(comms)],
  readComm: async pid => comms[pid] ?? null,
  run: vi.fn(async () => audit),
  selfPid: 1,
  ...overrides,
})

describe('package writer observation', () => {
  it('reports only package-manager processes outside the agent and runs the reviewed database check', async () => {
    const io = ports({ '1': 'apt-get\n', '30': 'unattended-upgr\n', '12': 'nginx\n', '9': 'dpkg\n', '44': 'packagekitd\n', '0123': 'apt\n' })
    const safety = await observePackageSafety('debian', io)
    expect(safety).toEqual({ state: 'read', writers: [{ pid: 9, command: 'dpkg' }, { pid: 30, command: 'unattended-upgr' }], database: 'clean' })
    expect(io.run).toHaveBeenCalledWith([...DPKG_AUDIT_ARGV])
    const rhel = ports({ '50': 'dnf\n', '51': 'yum\n', '52': 'apt\n' })
    expect(await observePackageSafety('rhel', rhel)).toMatchObject({ writers: [{ pid: 50 }, { pid: 51 }], database: 'clean' })
    expect(rhel.run).toHaveBeenCalledWith([...RPMDB_VERIFY_ARGV])
  })
  it('is unavailable when the process table is unreadable or unbounded and never treats an unreadable database as clean', async () => {
    expect(await observePackageSafety('debian', ports({}, undefined, { listProcesses: async () => null }))).toEqual({ state: 'unavailable', writers: [], database: 'not-read' })
    expect((await observePackageSafety('debian', ports({}, undefined, { listProcesses: async () => { throw new Error('EACCES') } }))).state).toBe('unavailable')
    expect((await observePackageSafety('debian', ports({}, undefined, { listProcesses: async () => Array.from({ length: 65_537 }, (_, i) => String(i + 1)) }))).state).toBe('unavailable')
    expect((await observePackageSafety('debian', ports({}, undefined, { run: async () => { throw new Error('gone') } }))).database).toBe('not-read')
    expect((await observePackageSafety('solaris' as never, ports({}))).state).toBe('unavailable')
  })
  it('classifies dpkg and rpm database outputs strictly', () => {
    const half = 'The following packages are only half configured, probably due to problems\nconfiguring them the first time.\n openssl  toolkit\n'
    expect(classifyPackageDatabase('debian', { ok: true, code: 0, stdout: '', stderr: '' })).toBe('clean')
    expect(classifyPackageDatabase('debian', { ok: true, code: 0, stdout: half, stderr: '' })).toBe('interrupted')
    expect(classifyPackageDatabase('debian', { ok: false, code: 2, stdout: '', stderr: 'dpkg: error' })).toBe('not-read')
    expect(classifyPackageDatabase('debian', { ok: true, code: 0, stdout: '', stderr: '', timedOut: true })).toBe('not-read')
    expect(classifyPackageDatabase('rhel', { ok: true, code: 0, stdout: '', stderr: '' })).toBe('clean')
    expect(classifyPackageDatabase('rhel', { ok: false, code: 1, stdout: '', stderr: 'error: rpmdb: database disk image is malformed' })).toBe('damaged')
    expect(classifyPackageDatabase('rhel', { ok: false, code: 1, stdout: '', stderr: 'permission denied' })).toBe('not-read')
    expect(classifyPackageDatabase('rhel', null)).toBe('not-read')
  })
  it('maps observations to refusals and admits only the two exact database checks', () => {
    expect(packageSafetyRefusal({ state: 'read', writers: [], database: 'clean' })).toBeNull()
    expect(packageSafetyRefusal({ state: 'unavailable', writers: [], database: 'clean' })).toBe('package-safety-unverified')
    expect(packageSafetyRefusal({ state: 'read', writers: [{ pid: 2, command: 'rpm' }], database: 'clean' })).toBe('competing-package-writer')
    expect(packageSafetyRefusal({ state: 'read', writers: [], database: 'not-read' })).toBe('package-database-not-clean')
    expect(isPackageSafetyCommand([...DPKG_AUDIT_ARGV])).toBe(true)
    expect(isPackageSafetyCommand([...RPMDB_VERIFY_ARGV])).toBe(true)
    expect(isPackageSafetyCommand(['/usr/bin/dpkg', '--audit', 'x'])).toBe(false)
    expect(isPackageSafetyCommand(['/usr/bin/rpmdb', '--rebuilddb'])).toBe(false)
  })
})
