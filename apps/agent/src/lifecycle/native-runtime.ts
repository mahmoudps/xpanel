import { createHash } from 'node:crypto'
import { constants, readFileSync } from 'node:fs'
import { lstat, mkdir, open, readFile, readlink, readdir, rename, rm, statfs, symlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, posix } from 'node:path'
import type { HostAction, Principal } from '@xpanel/core'
import { createDb, getPrincipal, getStrictOperationDatabaseOrigin, latestActive, loadMigrations } from '@xpanel/db'
import { recoverUpgrade, runUpgrade } from '@xpanel/lifecycle'
import type { FsPort, HostPort, ReleaseInfo, UpgradePorts } from '@xpanel/lifecycle'
import { detectOs, parseOsRelease } from '@xpanel/os'
import { StateStore } from '@xpanel/state'
import { createProductionHostTargetMatcher, LinuxHostExecutor } from '../executor.ts'
import type { AgentExecutor } from '../executor.ts'
import { observeHostLimits } from '../limit-gaps.ts'
import { HostReconciler } from '../reconciler.ts'
import { createProductionUpgradePorts } from './upgrade-runner.ts'
import { assertCurrentLifecycleEffect, assertNativeLifecyclePrerequisites, createNativeUpgradeSafety, readNativeReleaseTrust, verifyCurrentLifecycleWriterReadiness } from '../../../../scripts/lifecycle-root-safety.mjs'
import { verifyAuthenticatedReleaseArchive } from '../../../../scripts/release-verifier.mjs'

const DATABASE = '/var/lib/xpanel/control.db'
const STATE = '/var/lib/xpanel/state'
const BACKUPS = '/var/lib/xpanel-lifecycle/backups'
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const SHA = /^[0-9a-f]{64}$/
const deny = (code: string): never => { throw Object.assign(new Error(code), { code }) }
const record = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return deny('LIFECYCLE_REQUEST_INVALID')
  for (const key of Reflect.ownKeys(input)) if (typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value')) return deny('LIFECYCLE_REQUEST_INVALID')
  return input as Record<string, unknown>
}
const canonical = (path: unknown): path is string => typeof path === 'string' && path.length < 4096 && posix.isAbsolute(path) && posix.normalize(path) === path && !/[\u0000-\u001f\u007f\\]/.test(path)

export interface NativeLifecycleRequest {
  readonly command: 'update' | 'upgrade' | 'recover'
  readonly artifact?: { readonly path: string; readonly expectedArchiveSha256: string; readonly keyId: string }
}

/** Pure syntax. Caller keys, actors, paths, receipts and callbacks never become authority. */
export const validateNativeLifecycleRequest = (input: unknown): NativeLifecycleRequest => {
  const value = record(input)
  const allowed = new Set(['schemaVersion', 'command', 'mode', 'json', 'assumeYes', 'artifact', 'dependencyReceipt'])
  if (Object.keys(value).some(key => !allowed.has(key)) || value.schemaVersion !== 1 || value.mode !== 'apply' || value.assumeYes !== true || typeof value.json !== 'boolean') return deny('LIFECYCLE_REQUEST_INVALID')
  if (value.command !== 'update' && value.command !== 'upgrade' && value.command !== 'recover') return deny('LIFECYCLE_NATIVE_COMMAND_UNSUPPORTED')
  if (value.dependencyReceipt !== undefined) return deny('LIFECYCLE_RECEIPT_NOT_AUTHORITY')
  if (value.command === 'recover') {
    if (value.artifact !== undefined) return deny('LIFECYCLE_REQUEST_INVALID')
    return Object.freeze({ command: value.command })
  }
  const artifact = record(value.artifact)
  if (Object.keys(artifact).sort().join(',') !== 'expectedArchiveSha256,keyId,path,signingKeyPath' || !canonical(artifact.path) || dirname(artifact.path) !== '/opt/xpanel/downloads' || !canonical(artifact.signingKeyPath) || typeof artifact.keyId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(artifact.keyId) || typeof artifact.expectedArchiveSha256 !== 'string' || !SHA.test(artifact.expectedArchiveSha256)) return deny('LIFECYCLE_ARTIFACT_INVALID')
  // signingKeyPath is accepted only for the common CLI grammar. It is never read here.
  return Object.freeze({ command: value.command, artifact: Object.freeze({ path: artifact.path, expectedArchiveSha256: artifact.expectedArchiveSha256, keyId: artifact.keyId }) })
}

/** Metadata projection only. The native safety module independently authenticates retained bytes. */
export const releaseInfoFromAuthenticatedReport = (input: unknown, artifact: NonNullable<NativeLifecycleRequest['artifact']>): ReleaseInfo => {
  const report = record(input), manifest = record(report.manifest)
  if (report.ok !== true || report.scope !== 'source-artifact' || report.archiveSha256 !== artifact.expectedArchiveSha256 || typeof manifest.version !== 'string' || !VERSION.test(manifest.version) || !manifest.version.split('.').every(part => Number.isSafeInteger(Number(part))) || typeof manifest.controlDbSchemaVersion !== 'number' || !Number.isSafeInteger(manifest.controlDbSchemaVersion) || manifest.controlDbSchemaVersion < 0 || typeof report.totalUnpackedBytes !== 'number' || !Number.isSafeInteger(report.totalUnpackedBytes) || report.totalUnpackedBytes < 1) return deny('LIFECYCLE_ARTIFACT_REPORT_INVALID')
  return { version: manifest.version, schemaVersion: manifest.controlDbSchemaVersion, archivePath: artifact.path, sha256: artifact.expectedArchiveSha256, bytes: report.totalUnpackedBytes }
}

type PathOperation = 'read' | 'write' | 'remove' | 'directory' | 'link'
/** Exact native engine paths only; policy matching is not an admission grant. */
export const nativeLifecyclePathAllowed = (path: string, operation: PathOperation): boolean => {
  if (!canonical(path)) return false
  if (operation === 'read') return nativeLifecyclePathAllowed(path, 'write') || nativeLifecyclePathAllowed(path, 'directory') || ['/opt/xpanel/releases/', '/opt/xpanel/staging/', '/opt/xpanel/downloads/', BACKUPS + '/'].some(root => path.startsWith(root))
  if (operation === 'directory') return path === BACKUPS || /^\/opt\/xpanel\/staging\/[A-Za-z0-9._-]+$/.test(path)
  if (operation === 'link') return /^\/opt\/xpanel\/\.current-[A-Za-z0-9._-]+$/.test(path)
  if (operation === 'write') return path === '/opt/xpanel/current' || /^\/opt\/xpanel\/(?:\.current-[A-Za-z0-9._-]+|(?:staging|releases)\/[A-Za-z0-9._-]+)$/.test(path) || /^\/var\/lib\/xpanel\/(?:upgrade\.lock|maintenance\.json)(?:\.[A-Za-z0-9._-]+\.tmp)?$/.test(path) || path.startsWith(BACKUPS + '/')
  return /^\/opt\/xpanel\/(?:\.current-[A-Za-z0-9._-]+|(?:staging|releases)\/[A-Za-z0-9._-]+)$/.test(path) || /^\/var\/lib\/xpanel\/(?:upgrade\.lock|maintenance\.json)\.[A-Za-z0-9._-]+\.tmp$/.test(path)
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
type Owner = { uid: number; gid: number }
const panelOwner = async (): Promise<Owner> => {
  const handle = await open('/etc/passwd', constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) || info.size > 1024 * 1024) return deny('LIFECYCLE_ACCOUNT_OWNER_UNKNOWN')
    const lines = (await handle.readFile('utf8')).split('\n').filter(line => line.startsWith('xpanel:'))
    const parts = lines[0]?.split(':')
    if (lines.length !== 1 || !parts || !/^[1-9][0-9]*$/.test(parts[2] ?? '') || !/^[1-9][0-9]*$/.test(parts[3] ?? '')) return deny('LIFECYCLE_ACCOUNT_OWNER_UNKNOWN')
    return { uid: Number(parts[2]), gid: Number(parts[3]) }
  } finally { await handle.close() }
}

const nativeFilesystem = (owner: Owner): FsPort => {
  const withParent = async <T>(path: string, operation: PathOperation, callback: (heldPath: string, parent: FileHandle) => Promise<T>): Promise<T> => {
    if (!nativeLifecyclePathAllowed(path, operation)) return deny('LIFECYCLE_PATH_DENIED')
    await assertCurrentLifecycleEffect(operation === 'read' ? 'service.observe' : 'filesystem.write')
    const pins: { path: string; handle: FileHandle; dev: number; ino: number }[] = []
    const verify = async (): Promise<void> => {
      for (const pin of pins) {
        const [opened, named] = await Promise.all([pin.handle.stat(), lstat(pin.path)])
        const diagnosticParent = pin.path === '/var/lib/xpanel' && named.uid === owner.uid && named.gid === owner.gid && (named.mode & 0o7777) === 0o2770
        if (!opened.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || opened.dev !== pin.dev || opened.ino !== pin.ino || named.dev !== pin.dev || named.ino !== pin.ino || !diagnosticParent && (named.uid !== 0 || (named.mode & 0o022) !== 0)) return deny('LIFECYCLE_PATH_ANCESTRY_CHANGED')
      }
    }
    try {
      for (const segment of ['/', ...dirname(path).split('/').filter(Boolean)]) {
        const previous = pins.at(-1)
        const namedPath = previous ? posix.join(previous.path, segment) : '/'
        const fdPath = previous ? `/proc/self/fd/${previous.handle.fd}/${segment}` : '/'
        const handle = await open(fdPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        const info = await handle.stat()
        pins.push({ path: namedPath, handle, dev: info.dev, ino: info.ino })
        await verify()
      }
      const parent = pins.at(-1)!.handle
      const value = await callback(`/proc/self/fd/${parent.fd}/${basename(path)}`, parent)
      await verify()
      await assertCurrentLifecycleEffect(operation === 'read' ? 'service.observe' : 'filesystem.write')
      return value
    } finally { for (const pin of pins.reverse()) await pin.handle.close() }
  }
  return {
    async exists(path) { try { return await withParent(path, 'read', async held => { try { await lstat(held); return true } catch (error) { if (missing(error)) return false; throw error } }) } catch (error) { if (missing(error)) return false; throw error } },
    async readlink(path) { return withParent(path, 'read', async held => { try { const info = await lstat(held); return info.isSymbolicLink() ? readlink(held) : null } catch (error) { if (missing(error)) return null; throw error } }) },
    async readFile(path) { return withParent(path, 'read', async held => { let handle: FileHandle; try { handle = await open(held, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) { if (missing(error)) return null; throw error } try { const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024) return deny('LIFECYCLE_FILE_UNSAFE'); return await handle.readFile('utf8') } finally { await handle.close() } }) },
    async sha256(path) { return withParent(path, 'read', async held => { const handle = await open(held, constants.O_RDONLY | constants.O_NOFOLLOW); try { const before = await handle.stat(); if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022)) return deny('LIFECYCLE_FILE_UNSAFE'); const hash = createHash('sha256'); for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk); const after = await handle.stat(); if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return deny('LIFECYCLE_FILE_CHANGED'); return hash.digest('hex') } finally { await handle.close() } }) },
    async writeFileExclusive(path, content, mode) { await withParent(path, 'write', async (held, parent) => { const handle = await open(held, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, mode); try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() } await parent.sync() }) },
    async mkdirp(path, mode) { await withParent(path, 'directory', async (held, parent) => { try { await mkdir(held, { mode }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error } const handle = await open(held, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { const info = await handle.stat(); if (info.uid !== 0 || (info.mode & 0o022)) return deny('LIFECYCLE_DIRECTORY_UNSAFE'); await handle.sync() } finally { await handle.close() } await parent.sync() }) },
    async symlink(target, path) { if (!/^\/opt\/xpanel\/releases\/[0-9]+\.[0-9]+\.[0-9]+$/.test(target)) return deny('LIFECYCLE_LINK_TARGET_INVALID'); await withParent(path, 'link', async (held, parent) => { await symlink(target, held); await parent.sync() }) },
    async rename(from, to) { await withParent(from, 'write', async (source, sourceParent) => withParent(to, 'write', async (target, targetParent) => { await rename(source, target); await sourceParent.sync(); await targetParent.sync() })) },
    async remove(path) { await withParent(path, 'remove', async (held, parent) => { const info = await lstat(held); const base = await parent.stat(); if (info.dev !== base.dev) return deny('LIFECYCLE_MOUNT_REMOVAL_DENIED'); let members = 0; const inspect = async (target: string): Promise<void> => { if (++members > 100_000) return deny('LIFECYCLE_REMOVAL_BUDGET'); const entry = await lstat(target); if (entry.dev !== base.dev || entry.uid !== 0 || !entry.isSymbolicLink() && (entry.mode & 0o022)) return deny('LIFECYCLE_REMOVAL_TREE_UNSAFE'); if (entry.isDirectory()) { const directory = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { for (const child of await readdir(`/proc/self/fd/${directory.fd}`)) await inspect(`/proc/self/fd/${directory.fd}/${child}`) } finally { await directory.close() } } else if (!entry.isFile() && !entry.isSymbolicLink()) return deny('LIFECYCLE_REMOVAL_TREE_UNSAFE') }; await inspect(held); await assertCurrentLifecycleEffect('filesystem.write'); await rm(held, { recursive: true, force: false }); await parent.sync() }) },
  }
}

const guardedExecutor = (executor: LinuxHostExecutor): AgentExecutor => {
  const effect = async <T>(callback: () => Promise<T>, kind: 'filesystem.write' | 'service.observe' = 'filesystem.write'): Promise<T> => { await assertCurrentLifecycleEffect(kind); const value = await callback(); await assertCurrentLifecycleEffect(kind); return value }
  return { preflight: plan => effect(() => executor.preflight(plan), 'service.observe'), writeFile: file => effect(() => executor.writeFile(file)), readFile: path => effect(() => executor.readFile(path), 'service.observe'), removePath: path => effect(() => executor.removePath(path)), runTest: test => effect(() => executor.runTest(test)), runAction: action => effect(async () => { if (action.kind === 'systemd') { const result = await executor.runCommand(['/usr/bin/systemctl', action.verb, action.unit]); if (result.code !== 0) return deny('LIFECYCLE_SERVICE_COMMAND_FAILED'); return } await executor.runAction(action) }), runCommand: argv => effect(() => executor.runCommand(argv)), readSliceMetrics: uid => effect(() => executor.readSliceMetrics(uid), 'service.observe') }
}

const composition = async (db: ReturnType<typeof createDb>['db'], actor: Principal, owner: Owner): Promise<{ ports: UpgradePorts; store: StateStore; os: Awaited<ReturnType<typeof detectOs>> }> => {
  const os = detectOs(path => readFileSync(path, 'utf8'))
  const store = new StateStore(STATE)
  await store.getAuthorityMetadata()
  const executor = guardedExecutor(new LinuxHostExecutor({ trustedHostTargetMatcher: createProductionHostTargetMatcher(), trustedHostTargets: [{ path: BACKUPS, operations: ['ensure-directory'] }] }))
  const resolvedOs = await os
  const reconciler = new HostReconciler({ store, db, executor, os: resolvedOs, quotaFilesystem: '/home', healthProbe: async unit => { const result = await executor.runCommand(['/usr/bin/systemctl', 'is-active', '--quiet', unit]); return { ok: result.code === 0, ...(result.code !== 0 ? { error: 'Native service was not active' } : {}) } } })
  const host: HostPort = { async apply(action: HostAction) {
    const kind = action.kind === 'systemd' && action.verb === 'stop' ? 'service.stop' : action.kind === 'systemd' ? 'service.start' : 'filesystem.write'
    await assertCurrentLifecycleEffect(kind)
    await executor.preflight({ files: [], preActions: [action], postActions: [] })
    if (action.kind === 'exec' || action.kind === 'systemd') {
      if (action.kind === 'exec' && action.runAsUser && action.runAsUser !== 'root') return deny('LIFECYCLE_UNOWNED_COMMAND_USER')
      const argv = action.kind === 'exec' ? action.argv : ['/usr/bin/systemctl', action.verb, action.unit]
      const output = await executor.runCommand(argv)
      await assertCurrentLifecycleEffect(kind)
      return { code: output.code, stdout: output.stdout, stderr: output.stderr }
    }
    await executor.runAction(action)
    await assertCurrentLifecycleEffect(kind)
    return { code: 0, stdout: '', stderr: '' }
  } }
  const ports = createProductionUpgradePorts({ db, fs: nativeFilesystem(owner), host, clock: { now: () => new Date(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) }, trustedReleaseKeys: [],
    loadReleaseMigrations: root => loadMigrations(posix.join(root, 'packages/db/src/migrations')),
    probeFreeBytes: async path => { await assertCurrentLifecycleEffect('service.observe'); const value = await statfs(path, { bigint: true }); const bytes = value.bavail * value.bsize; if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER; return Number(bytes) },
    probeOsRelease: async () => parseOsRelease(await readFile('/etc/os-release', 'utf8')),
    probeActiveTransfers: async () => { await assertCurrentLifecycleEffect('service.observe'); if (!await verifyCurrentLifecycleWriterReadiness()) return deny('LIFECYCLE_WRITER_READINESS_UNAVAILABLE'); const rows = await db.query<{ count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','running') AND kind NOT LIKE 'lifecycle.%'"); const count = rows[0]?.count; if (!Number.isSafeInteger(count) || count! < 0) return deny('LIFECYCLE_TRANSFER_OBSERVATION_UNAVAILABLE'); return count! },
    // Private IPC proves the current fenced control-plane processes, not an MFA user login.
    probeQualifiedControlPlane: verifyCurrentLifecycleWriterReadiness,
    probeCanaryHttp: async () => deny('LIFECYCLE_HOSTED_UID_PROBE_UNAVAILABLE'),
    reconciler: {
      currentGeneration: async () => { const active = await latestActive(db); if (!active) return deny('LIFECYCLE_ACTIVE_GENERATION_REQUIRED'); return active.id },
      reconcile: async () => { await assertCurrentLifecycleEffect('filesystem.write'); const result = await reconciler.reconcile({ force: true, actor: actor.username }); if (result.status === 'failed' || !result.generation) return deny('LIFECYCLE_RECONCILE_FAILED'); return { generationId: result.generation.id, units: [] } },
      activate: async () => deny('LIFECYCLE_HISTORICAL_AUTHORITY_REPLAY_DENIED'),
      status: async () => { const [drift, active, snapshot] = await Promise.all([reconciler.checkDrift(), latestActive(db), store.readSnapshot()]); const manifest = active ? await reconciler.journal.readManifest(active.id) : null; const problems = drift.items.map(item => item.path); if (!manifest || manifest.stateChecksum !== snapshot.checksum) problems.push('current desired state is not the active generation'); if (drift.manifestMissing) problems.push('active generation manifest is unavailable'); return { converged: !drift.hasDrift && problems.length === 0, drift: problems } },
      identities: async () => { const snapshot = await store.readSnapshot(); if (snapshot.accounts.length && (await observeHostLimits(executor, snapshot.accounts, snapshot.plans, '/home')).status !== 'verified') return deny('LIFECYCLE_ASSIGNED_LIMITS_UNVERIFIED'); return Promise.all(snapshot.accounts.map(async account => { const [uid, gid] = await Promise.all([executor.runCommand(['/usr/bin/id', '-u', '--', account.username]), executor.runCommand(['/usr/bin/id', '-g', '--', account.username])]); if (!uid.ok || !gid.ok || uid.stdout.trim() !== String(account.uid) || gid.stdout.trim() !== String(account.gid)) return deny('LIFECYCLE_ACCOUNT_IDENTITY_CHANGED'); const plan = snapshot.plans.find(plan => plan.id === account.planId); if (!plan) return deny('LIFECYCLE_ASSIGNED_PLAN_UNAVAILABLE'); return { username: account.username, uid: account.uid, gid: account.gid, slice: `xpanel-${account.uid}.slice`, quotas: { ...plan.resources } } })) },
    },
  })
  return { ports, store, os: resolvedOs }
}

/** Real composition only. No request, environment or callback supplies a principal or readiness. */
export const runNativeLifecycleCommand = async (input: unknown) => {
  const request = validateNativeLifecycleRequest(input)
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) return deny('LIFECYCLE_ROOT_LINUX_REQUIRED')
  if (process.version !== 'v26.12.1' || process.env.NODE_OPTIONS || process.env.NODE_PATH) return deny('LIFECYCLE_PINNED_RUNTIME_REQUIRED')
  await assertNativeLifecyclePrerequisites()
  const databasePin = await open(DATABASE, constants.O_RDONLY | constants.O_NOFOLLOW)
  let handle: ReturnType<typeof createDb> | undefined
  try {
    const before = await databasePin.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n) return deny('LIFECYCLE_DATABASE_UNSAFE')
    handle = createDb(DATABASE, { durability: 'strict' })
    const origin = await handle.db.transaction(async tx => getStrictOperationDatabaseOrigin(tx))
    if (origin.file !== DATABASE || origin.device !== String(before.dev) || origin.inode !== String(before.ino)) return deny('LIFECYCLE_DATABASE_CHANGED')
    const rows = await handle.db.query<{ id: string }>("SELECT id FROM principals WHERE kind='root' AND disabled=0 ORDER BY created_at,id LIMIT 2")
    if (rows.length !== 1) return deny('LIFECYCLE_ROOT_PRINCIPAL_AMBIGUOUS')
    const root = await getPrincipal(handle.db, rows[0]!.id)
    if (!root || root.kind !== 'root' || root.disabled) return deny('LIFECYCLE_ROOT_PRINCIPAL_REQUIRED')
    const actor: Principal = { kind: 'root', id: root.id, username: root.username }
    const { ports, store, os } = await composition(handle.db, actor, await panelOwner())
    // No real hosted-request UID producer exists yet. Refuse before any service/FS effects.
    if ((await store.readSnapshot()).accounts.length !== 0) return deny('LIFECYCLE_HOSTED_UID_PROBE_UNAVAILABLE')
    if (request.command === 'recover') {
      const safety = await createNativeUpgradeSafety({ db: handle.db, actorId: actor.id, operation: 'recover' })
      await recoverUpgrade({ ...ports, safety }, { actor, os, note: 'Native command observed current authority; physical retirement remains separately verified', canary: null })
      return { exitCode: 6, code: 'LIFECYCLE_RETIREMENT_PENDING', outcome: 'attention', details: { phase: 'retirement_pending', qualified: false } }
    }
    const artifact = request.artifact!
    const trust = await readNativeReleaseTrust()
    if (artifact.keyId !== trust.keyId) return deny('LIFECYCLE_ROOT_TRUST_MISMATCH')
    const report: unknown = await verifyAuthenticatedReleaseArchive(artifact.path, { ...trust, expectedArchiveSha256: artifact.expectedArchiveSha256 })
    const release = releaseInfoFromAuthenticatedReport(report, artifact)
    const currentTarget = await readlink('/opt/xpanel/current')
    const currentVersion = basename(currentTarget)
    if (!VERSION.test(currentVersion) || dirname(currentTarget) !== '/opt/xpanel/releases') return deny('LIFECYCLE_CURRENT_RELEASE_INVALID')
    if (request.command === 'update' && currentVersion.split('.')[0] !== release.version.split('.')[0]) return deny('LIFECYCLE_MAJOR_UPGRADE_REQUIRED')
    const safety = await createNativeUpgradeSafety({ db: handle.db, actorId: actor.id, operation: 'upgrade', release })
    const result = await runUpgrade({ ...ports, safety }, { actor, os, release, canary: null })
    return result.outcome === 'succeeded'
      ? { exitCode: 0, code: 'LIFECYCLE_NATIVE_COMMITTED', outcome: 'committed', details: { currentVersion: release.version, changed: true } }
      : { exitCode: result.outcome === 'refused' ? 3 : 6, code: result.outcome === 'refused' ? 'LIFECYCLE_UPGRADE_REFUSED' : 'LIFECYCLE_RETIREMENT_PENDING', outcome: result.outcome === 'refused' ? 'blocked' : 'attention', details: { phase: 'retirement_pending', qualified: false } }
  } finally { try { if (handle) await handle.close() } finally { await databasePin.close() } }
}
