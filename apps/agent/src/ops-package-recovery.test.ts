import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RPM_INSTALLED_IDENTITY_ARGV, RPMDB_REBUILD_ARGV, isOpsPackageRecoveryCommand } from '../../../packages/os/src/ops-package-recovery-command.ts'
import { beginPackageSnapshot, createRhelCacheRecovery, readInstalledIdentity, readRetainedPackageSnapshot } from './ops-package-recovery.ts'
import type { PackageRecoveryPorts } from './ops-package-recovery.ts'

let base = ''
const revision = 'a'.repeat(64)
let packages = 'bash-5.1.8-9.el9.x86_64\nnginx-1:1.20.1-16.el9.x86_64\n'
const ports = (overrides: Partial<PackageRecoveryPorts> = {}): PackageRecoveryPorts => ({
  recoveryDir: join(base, 'recovery'), sourceDir: join(base, 'cache'), configFiles: async () => [join(base, 'dnf.conf')],
  run: vi.fn(async (argv: string[]) => argv.join(' ') === RPM_INSTALLED_IDENTITY_ARGV.join(' ') ? { ok: true, code: 0, stdout: packages, stderr: '' } : { ok: false, code: 1, stdout: '', stderr: 'unexpected' }),
  safety: async () => ({ state: 'read', writers: [], database: 'clean' }),
  isProcessAlive: () => false,
  ...overrides,
})
const input = { expectedRevision: revision, currentRevision: async () => revision }
const tree = async (dir: string, prefix = ''): Promise<string[]> => (await Promise.all((await readdir(join(dir, prefix), { withFileTypes: true })).map(async entry => entry.isDirectory() ? tree(dir, prefix + entry.name + '/') : [prefix + entry.name]))).flat().sort()

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'xpanel-ops-recovery-'))
  packages = 'bash-5.1.8-9.el9.x86_64\nnginx-1:1.20.1-16.el9.x86_64\n'
  await mkdir(join(base, 'cache', 'baseos-1a2b', 'repodata'), { recursive: true })
  await mkdir(join(base, 'cache', 'baseos-1a2b', 'packages'), { recursive: true })
  await writeFile(join(base, 'cache', 'baseos-1a2b', 'repodata', 'repomd.xml'), '<repomd/>')
  await writeFile(join(base, 'cache', 'baseos.solv'), 'solv-v1')
  await writeFile(join(base, 'cache', 'baseos-1a2b', 'packages', 'nginx.rpm'), 'rpm-bytes')
  await writeFile(join(base, 'dnf.conf'), '[main]\n')
})
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

describe('package recovery grammar', () => {
  it('admits only the exact identity read and database rebuild', () => {
    expect(isOpsPackageRecoveryCommand([...RPM_INSTALLED_IDENTITY_ARGV])).toBe(true)
    expect(isOpsPackageRecoveryCommand([...RPMDB_REBUILD_ARGV])).toBe(true)
    for (const argv of [['/usr/bin/rpm', '-qa'], ['/usr/bin/rpmdb', '--rebuilddb', '--root=/x'], ['/usr/bin/rpm', '-qa', '--qf', '%{NAME}\n'], 'rpm -qa' as unknown as string[]]) expect(isOpsPackageRecoveryCommand(argv)).toBe(false)
  })
  it('hashes a sorted readable NEVRA list and refuses unreadable identities', async () => {
    const run = async () => ({ ok: true, code: 0, stdout: 'b-1-1.x86_64\na-1-1.noarch\n', stderr: '' })
    expect(await readInstalledIdentity(run)).toBe(await readInstalledIdentity(async () => ({ ok: true, code: 0, stdout: 'a-1-1.noarch\nb-1-1.x86_64\n', stderr: '' })))
    for (const result of [{ ok: false, code: 1, stdout: '', stderr: 'error' }, { ok: true, code: 0, stdout: '', stderr: '' }, { ok: true, code: 0, stdout: 'a b\n', stderr: '' }, { ok: true, code: 0, stdout: 'a-1\na-1\n', stderr: '' }])
      await expect(readInstalledIdentity(async () => result)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})

describe('DNF metadata snapshot recovery', () => {
  it('snapshots metadata only, restores the exact preimage after a refresh and releases everything', async () => {
    const io = ports(), snapshot = await createRhelCacheRecovery(io).begin(input)
    expect(snapshot.observedRevision).toBe(revision)
    expect(snapshot.snapshotRevision).toMatch(/^[a-f0-9]{64}$/)
    const record = await readRetainedPackageSnapshot(io, 'dnf-cache')
    expect(record!.files.map(file => file.path)).toEqual(['baseos-1a2b/repodata/repomd.xml', 'baseos.solv'])
    await snapshot.assertLeaseAndPackagesUnchanged()
    // dnf clean metadata + makecache: old metadata removed, new metadata written, downloaded packages untouched.
    await rm(join(base, 'cache', 'baseos.solv'))
    await writeFile(join(base, 'cache', 'baseos-1a2b', 'repodata', 'repomd.xml'), '<repomd new/>')
    await writeFile(join(base, 'cache', 'baseos-1a2b', 'repodata', 'new-primary.xml.gz'), 'gz')
    expect(await snapshot.restoreAndVerify()).toBe(true)
    expect(await tree(join(base, 'cache'))).toEqual(['baseos-1a2b/packages/nginx.rpm', 'baseos-1a2b/repodata/repomd.xml', 'baseos.solv'])
    expect(await readFile(join(base, 'cache', 'baseos-1a2b', 'repodata', 'repomd.xml'), 'utf8')).toBe('<repomd/>')
    await snapshot.release()
    expect(await readRetainedPackageSnapshot(io, 'dnf-cache')).toBeNull()
    expect(await readdir(join(base, 'recovery'))).toEqual([])
  })
  it('refuses a second snapshot while one is retained and keeps a crashed record for review', async () => {
    const io = ports()
    await beginPackageSnapshot(io, 'dnf-cache', input)
    await expect(beginPackageSnapshot(io, 'dnf-cache', input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    // A dead lease holder with a retained record is never broken automatically.
    await expect(beginPackageSnapshot(ports({ isProcessAlive: () => false }), 'dnf-cache', input)).rejects.toMatchObject({ detail: { stateChanged: false } })
    expect(await readRetainedPackageSnapshot(io, 'dnf-cache')).not.toBeNull()
  })
  it('breaks only a stale lease that never committed a record, and honours a live holder', async () => {
    await mkdir(join(base, 'recovery'), { recursive: true })
    await writeFile(join(base, 'recovery', 'dnf-cache.lease'), JSON.stringify({ pid: 999999, token: 'old' }))
    await expect(beginPackageSnapshot(ports({ isProcessAlive: () => true }), 'dnf-cache', input)).rejects.toMatchObject({ code: 'CONFLICT' })
    const snapshot = await beginPackageSnapshot(ports(), 'dnf-cache', input)
    await snapshot.release()
  })
  it('rolls back a partial snapshot on revision drift, competing writers or unsupported entries', async () => {
    await expect(beginPackageSnapshot(ports(), 'dnf-cache', { expectedRevision: revision, currentRevision: async () => 'b'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(beginPackageSnapshot(ports({ safety: async () => ({ state: 'read', writers: [{ pid: 4, command: 'dnf' }], database: 'clean' }) }), 'dnf-cache', input)).rejects.toMatchObject({ detail: { reason: 'competing-package-writer' } })
    await expect(beginPackageSnapshot(ports({ sourceDir: join(base, 'missing') }), 'dnf-cache', input)).rejects.toThrow()
    expect(await readRetainedPackageSnapshot(ports(), 'dnf-cache')).toBeNull()
    expect(await readdir(join(base, 'recovery'))).toEqual([])
  })
  it('detects installed package or configuration changes and reports restore failure without throwing', async () => {
    const io = ports(), snapshot = await createRhelCacheRecovery(io).begin(input)
    packages += 'kernel-5.14.0-1.el9.x86_64\n'
    await expect(snapshot.assertLeaseAndPackagesUnchanged()).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: true, verificationRequired: true } })
    expect(await snapshot.restoreAndVerify()).toBe(false)
    packages = 'bash-5.1.8-9.el9.x86_64\nnginx-1:1.20.1-16.el9.x86_64\n'
    await writeFile(join(base, 'dnf.conf'), '[main]\ngpgcheck=0\n')
    await expect(snapshot.assertLeaseAndPackagesUnchanged()).rejects.toMatchObject({ code: 'CONFLICT' })
    await rm(join(base, 'recovery', 'dnf-cache.lease'))
    await expect(snapshot.assertLeaseAndPackagesUnchanged()).rejects.toMatchObject({ detail: { verificationRequired: true } })
    expect(await snapshot.restoreAndVerify()).toBe(false)
  })
  it('snapshots every database file for the RPM rebuild', async () => {
    await mkdir(join(base, 'rpm'))
    await writeFile(join(base, 'rpm', 'rpmdb.sqlite'), 'db-v1'); await writeFile(join(base, 'rpm', 'Packages.rpm'), 'kept')
    const io = ports({ sourceDir: join(base, 'rpm') }), snapshot = await beginPackageSnapshot(io, 'rpm-database', input)
    expect(snapshot.record.files.map(file => file.path)).toEqual(['Packages.rpm', 'rpmdb.sqlite'])
    await writeFile(join(base, 'rpm', 'rpmdb.sqlite'), 'db-rebuilt')
    expect(await snapshot.restoreAndVerify()).toBe(true)
    expect(await readFile(join(base, 'rpm', 'rpmdb.sqlite'), 'utf8')).toBe('db-v1')
    await snapshot.release()
  })
})

describe('executor admission for package recovery', () => {
  it('admits only the read-only identity query for direct runs', async () => {
    const { isRpmInstalledIdentityCommand } = await import('../../../packages/os/src/ops-package-recovery-command.ts')
    expect(isRpmInstalledIdentityCommand([...RPM_INSTALLED_IDENTITY_ARGV])).toBe(true)
    expect(isRpmInstalledIdentityCommand([...RPMDB_REBUILD_ARGV])).toBe(false)
  })
})
