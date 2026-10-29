import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fail } from '@xpanel/core'
import { RPM_INSTALLED_IDENTITY_ARGV } from '../../../packages/os/src/ops-package-recovery-command.ts'
import type { PackageSafety } from './ops-package-writers.ts'
import { packageSafetyRefusal } from './ops-package-writers.ts'
import type { RepairCommandResult, RhelCacheRecovery, RhelCacheSnapshot } from './repair-center.ts'

export type PackageSnapshotKind = 'dnf-cache' | 'rpm-database'
export interface PackageRecoveryPorts {
  /** Root-only directory (0700) that retains snapshots and records until explicit release. */
  recoveryDir: string
  /** /var/cache/dnf for the metadata cache, /var/lib/rpm for the database. */
  sourceDir: string
  /** DNF configuration whose bytes must not change: /etc/dnf/dnf.conf and /etc/yum.repos.d/*.repo. */
  configFiles: () => Promise<string[]>
  run: (argv: string[]) => Promise<RepairCommandResult>
  /** Competing package writers (ops-package-writers); a running writer refuses every snapshot step. */
  safety: () => Promise<PackageSafety>
  isProcessAlive: (pid: number) => boolean
  now?: () => Date
}
export interface PackageSnapshotEntry { path: string; sha256: string; size: number; mode: number }
export interface PackageSnapshotRecord {
  schemaVersion: 1; id: string; kind: PackageSnapshotKind; createdAt: string; sourceDir: string; observedRevision: string
  identitySha256: string; configSha256: string; files: PackageSnapshotEntry[]; directories: string[]
}
export interface PackageSnapshot extends RhelCacheSnapshot { record: PackageSnapshotRecord }

const MAX_FILES = 50_000, MAX_BYTES = 4 * 1024 ** 3, MAX_DEPTH = 16
const NEVRA = /^[A-Za-z0-9_.+^~:-]{1,512}$/
const unchanged = { stateChanged: false }
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const hashFile = (path: string): Promise<string> => new Promise((resolve, reject) => {
  const hash = createHash('sha256')
  createReadStream(path).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')))
})
/** The DNF metadata cache excludes downloaded packages: clean metadata never removes them, so they are not snapshotted or restored. */
const included = (kind: PackageSnapshotKind, rel: string): boolean => kind === 'rpm-database' || !/\.(?:rpm|drpm)$/.test(rel)
const recordPath = (ports: PackageRecoveryPorts, kind: PackageSnapshotKind): string => join(ports.recoveryDir, kind, 'record.json')
const filesDir = (ports: PackageRecoveryPorts, kind: PackageSnapshotKind): string => join(ports.recoveryDir, kind, 'files')
const leasePath = (ports: PackageRecoveryPorts, kind: PackageSnapshotKind): string => join(ports.recoveryDir, kind + '.lease')

async function fsyncPath(path: string, flags = 'r'): Promise<void> {
  const handle = await open(path, flags)
  try { await handle.sync() } finally { await handle.close() }
}
async function writeDurable(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + randomUUID() + '.tmp', handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(data, 'utf8'); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
  try { await fsyncPath(dirname(path)) } catch { /* Directory fsync is unsupported on some platforms; the rename is still atomic. */ }
}

/** Regular files and directories only; a symlink, device or socket makes the tree unsupported rather than silently skipped. */
async function walk(root: string, kind: PackageSnapshotKind): Promise<{ files: { path: string; size: number; mode: number }[]; directories: string[] }> {
  const files: { path: string; size: number; mode: number }[] = [], directories: string[] = []
  let bytes = 0
  const stack: [string, number][] = [['', 0]]
  const top = await lstat(root)
  if (!top.isDirectory() || top.isSymbolicLink()) return fail('PRECONDITION_FAILED', 'the package recovery source is not a real directory', unchanged)
  while (stack.length) {
    const [rel, depth] = stack.pop()!
    if (depth > MAX_DEPTH) return fail('PRECONDITION_FAILED', 'the package recovery source is too deep', unchanged)
    for (const name of (await readdir(join(root, rel))).sort()) {
      const child = rel ? rel + '/' + name : name, info = await lstat(join(root, child))
      if (info.isDirectory()) { directories.push(child); stack.push([child, depth + 1]); continue }
      if (!info.isFile()) return fail('PRECONDITION_FAILED', 'the package recovery source contains an unsupported entry', unchanged)
      if (!included(kind, child)) continue
      bytes += info.size
      if (files.length >= MAX_FILES || bytes > MAX_BYTES) return fail('LIMIT_EXCEEDED', 'the package recovery source exceeds its snapshot bounds', unchanged)
      files.push({ path: child, size: info.size, mode: info.mode & 0o7777 })
    }
  }
  return { files: files.sort((a, b) => a.path < b.path ? -1 : 1), directories: directories.sort() }
}

/** sha256 of the sorted installed NEVRA list; an unreadable or empty list is never an identity. */
export async function readInstalledIdentity(run: PackageRecoveryPorts['run']): Promise<string> {
  let result: RepairCommandResult | null = null
  try { result = await run([...RPM_INSTALLED_IDENTITY_ARGV]) } catch { result = null }
  const rows = result && result.ok && result.code === 0 && !result.timedOut && typeof result.stdout === 'string' && !result.stderr?.trim() ? result.stdout.split('\n').filter(Boolean) : []
  if (!rows.length || rows.length > 100_000 || rows.some(row => !NEVRA.test(row)) || new Set(rows).size !== rows.length) return fail('PRECONDITION_FAILED', 'the installed package identity could not be read', unchanged)
  return sha(rows.sort().join('\n'))
}
async function configIdentity(ports: PackageRecoveryPorts): Promise<string> {
  const paths = [...new Set(await ports.configFiles())].sort()
  if (paths.length > 512) return fail('LIMIT_EXCEEDED', 'too many DNF configuration files', unchanged)
  const parts: string[] = []
  for (const path of paths) { try { parts.push(path + '\0' + sha(await readFile(path))) } catch { parts.push(path + '\0missing') } }
  return sha(parts.join('\n'))
}

export async function readRetainedPackageSnapshot(ports: Pick<PackageRecoveryPorts, 'recoveryDir'>, kind: PackageSnapshotKind): Promise<PackageSnapshotRecord | null> {
  try { return JSON.parse(await readFile(recordPath(ports as PackageRecoveryPorts, kind), 'utf8')) as PackageSnapshotRecord }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; return fail('PRECONDITION_FAILED', 'a retained package recovery record is unreadable and requires review', unchanged) }
}

async function acquireLease(ports: PackageRecoveryPorts, kind: PackageSnapshotKind): Promise<{ assertHeld(): Promise<void>; release(): Promise<void> }> {
  const path = leasePath(ports, kind), token = randomUUID()
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token }), 'utf8'); await handle.sync() } finally { await handle.close() }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) return fail('CONFLICT', 'another package recovery holds the lease', unchanged)
      let holder: { pid?: unknown } = {}
      try { holder = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown } } catch { return fail('PRECONDITION_FAILED', 'the package recovery lease is unreadable and requires review', unchanged) }
      // A dead holder without a retained record never changed anything; its lease can be broken once.
      if (!Number.isSafeInteger(holder.pid) || ports.isProcessAlive(holder.pid as number) || await readRetainedPackageSnapshot(ports, kind)) return fail('CONFLICT', 'another package recovery holds the lease', unchanged)
      await unlink(path)
    }
  }
  const assertHeld = async (): Promise<void> => {
    let current: { token?: unknown } = {}
    try { current = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown } } catch { /* reported below */ }
    if (current.token !== token) return fail('CONFLICT', 'the package recovery lease was lost', { stateChanged: true, verificationRequired: true })
  }
  return { assertHeld, release: async () => { await assertHeld(); await unlink(path) } }
}

async function assertIdle(ports: PackageRecoveryPorts): Promise<void> {
  let reason: string | null
  try { reason = packageSafetyRefusal(await ports.safety()) } catch { reason = 'package-safety-unverified' }
  // The database check is the repair target for rpm-database snapshots, so only writers and visibility fence here.
  if (reason === 'package-safety-unverified' || reason === 'competing-package-writer') return fail('PRECONDITION_FAILED', 'another package manager is running or could not be checked', { ...unchanged, reason })
}

/** Snapshot under an exclusive lease; the preimage is re-hashed before the record that makes it restorable is written. */
export async function beginPackageSnapshot(ports: PackageRecoveryPorts, kind: PackageSnapshotKind, input: { expectedRevision: string; currentRevision(): Promise<string> }): Promise<PackageSnapshot> {
  if (!/^[a-f0-9]{64}$/.test(input.expectedRevision)) return fail('VALIDATION', 'an observed revision is required', unchanged)
  await mkdir(ports.recoveryDir, { recursive: true, mode: 0o700 })
  if (await readRetainedPackageSnapshot(ports, kind)) return fail('PRECONDITION_FAILED', 'a retained package snapshot from an earlier repair requires review', unchanged)
  const lease = await acquireLease(ports, kind)
  let committed = false
  try {
    await assertIdle(ports)
    const observedRevision = await input.currentRevision()
    if (observedRevision !== input.expectedRevision) return fail('CONFLICT', 'diagnostics changed before the recovery snapshot', unchanged)
    const identitySha256 = await readInstalledIdentity(ports.run), configSha256 = await configIdentity(ports)
    const tree = await walk(ports.sourceDir, kind), target = filesDir(ports, kind), files: PackageSnapshotEntry[] = []
    await rm(join(ports.recoveryDir, kind), { recursive: true, force: true })
    for (const directory of ['', ...tree.directories]) await mkdir(join(target, directory), { recursive: true, mode: 0o700 })
    for (const file of tree.files) {
      const from = join(ports.sourceDir, file.path), to = join(target, file.path)
      await copyFile(from, to)
      await fsyncPath(to, 'r+')
      const [source, copy] = [await hashFile(from), await hashFile(to)]
      if (source !== copy) return fail('PRECONDITION_FAILED', 'a package snapshot copy could not be verified', unchanged)
      files.push({ path: file.path, sha256: copy, size: file.size, mode: file.mode })
    }
    await lease.assertHeld()
    const record: PackageSnapshotRecord = { schemaVersion: 1, id: randomUUID(), kind, createdAt: (ports.now?.() ?? new Date()).toISOString(), sourceDir: ports.sourceDir, observedRevision, identitySha256, configSha256, files, directories: tree.directories }
    await writeDurable(recordPath(ports, kind), JSON.stringify(record))
    committed = true
    return snapshotHandle(ports, record, lease)
  } finally {
    if (!committed) {
      await rm(join(ports.recoveryDir, kind), { recursive: true, force: true }).catch(() => undefined)
      await lease.release().catch(() => undefined)
    }
  }
}

function snapshotHandle(ports: PackageRecoveryPorts, record: PackageSnapshotRecord, lease: { assertHeld(): Promise<void>; release(): Promise<void> }): PackageSnapshot {
  const unchangedPackages = async (): Promise<void> => {
    await lease.assertHeld(); await assertIdle(ports)
    if (await readInstalledIdentity(ports.run) !== record.identitySha256) return fail('CONFLICT', 'installed packages changed during the repair', { stateChanged: true, verificationRequired: true })
    if (await configIdentity(ports) !== record.configSha256) return fail('CONFLICT', 'DNF configuration changed during the repair', { stateChanged: true, verificationRequired: true })
  }
  const matches = async (): Promise<boolean> => {
    const tree = await walk(ports.sourceDir, record.kind)
    if (tree.files.length !== record.files.length) return false
    for (const [index, file] of tree.files.entries()) {
      const saved = record.files[index]!
      if (file.path !== saved.path || file.size !== saved.size || await hashFile(join(ports.sourceDir, file.path)) !== saved.sha256) return false
    }
    return true
  }
  return {
    record,
    observedRevision: record.observedRevision,
    snapshotRevision: sha(JSON.stringify(record)),
    assertLeaseAndPackagesUnchanged: unchangedPackages,
    /** Replaces the included files with the retained preimage, then proves bytes and installed identity. */
    restoreAndVerify: async () => {
      try {
        await lease.assertHeld(); await assertIdle(ports)
        const saved = new Set(record.files.map(file => file.path))
        for (const file of (await walk(ports.sourceDir, record.kind)).files) if (!saved.has(file.path)) await unlink(join(ports.sourceDir, file.path))
        for (const directory of record.directories) await mkdir(join(ports.sourceDir, directory), { recursive: true, mode: 0o755 })
        for (const file of record.files) {
          const to = join(ports.sourceDir, file.path), temporary = to + '.xpanel-restore'
          await copyFile(join(filesDir(ports, record.kind), file.path), temporary)
          const handle = await open(temporary, 'r+')
          try { await handle.chmod(file.mode); await handle.sync() } finally { await handle.close() }
          await rename(temporary, to)
        }
        if (!await matches()) return false
        await unchangedPackages()
        return true
      } catch { return false }
    },
    release: async () => {
      await lease.assertHeld()
      await rm(join(ports.recoveryDir, record.kind), { recursive: true, force: true })
      await lease.release()
    },
  }
}

/** Qualified RhelCacheRecovery for the reviewed metadata-only repair (repair-center.ts buildRhelCacheJobPlan). */
export const createRhelCacheRecovery = (ports: PackageRecoveryPorts): RhelCacheRecovery => ({
  begin: input => beginPackageSnapshot(ports, 'dnf-cache', input),
})

/** /var/lib/rpm snapshot for the reviewed rebuild (repair-center.ts buildRpmRebuildJobPlan). */
export const createRpmDatabaseRecovery = (ports: PackageRecoveryPorts): RhelCacheRecovery => ({
  begin: input => beginPackageSnapshot(ports, 'rpm-database', input),
})

export const nativeDnfConfigFiles = async (): Promise<string[]> => {
  let repos: string[] = []
  try { repos = (await readdir('/etc/yum.repos.d')).filter(name => /^[A-Za-z0-9._-]{1,128}\.repo$/.test(name)).map(name => '/etc/yum.repos.d/' + name) } catch { repos = [] }
  return ['/etc/dnf/dnf.conf', ...repos]
}
export const isProcessAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
