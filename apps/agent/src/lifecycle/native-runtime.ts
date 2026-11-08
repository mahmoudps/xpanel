import { createHash } from 'node:crypto'
import { constants, readFileSync } from 'node:fs'
import { lstat, mkdir, open, readFile, readlink, readdir, rename, rm, statfs, symlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, posix } from 'node:path'
import { effectivePlan } from '@xpanel/core'
import type { HostAction, Principal } from '@xpanel/core'
import { createDb, getDurableJob, getGeneration, getPrincipal, getStrictOperationDatabaseOrigin, latestActive, loadMigrations } from '@xpanel/db'
import { limitRequirementMet, recoverUpgrade, runUpgrade } from '@xpanel/lifecycle'
import type { FsPort, HostPort, ReleaseInfo, UpgradePorts, UpgradeResult, UpgradeSafetyPort } from '@xpanel/lifecycle'
import { detectOs, parseOsRelease } from '@xpanel/os'
import { StateStore } from '@xpanel/state'
import { createProductionHostTargetMatcher, LinuxHostExecutor } from '../executor.ts'
import type { AgentExecutor } from '../executor.ts'
import { resolveHomeQuotaFilesystem } from '../services/quota.ts'
import { observeHostLimits } from '../limit-gaps.ts'
import { createNativeHostReconciler } from '../native-reconciler.ts'
import { loadNativePeerIdentityAddon } from '../peer-identity.ts'
import { createNativeLifecycleCanary } from './native-canary.ts'
import { createProvisioningDatabaseReaderPort } from '../account-provisioning-database-reader.ts'
import { createProductionUpgradePorts, verifySignedManifestForRelease } from './upgrade-runner.ts'
import type { ReleaseVerificationKey } from './upgrade-runner.ts'
import { signedReleaseManifestDigest } from './upgrade-runner.ts'
import { parseUpgradeProcessBinding, readUpgradeIntentJob } from '../upgrade-coordinator-contract.ts'
import type { UpgradeProcessBinding } from '../upgrade-coordinator-contract.ts'
import { assertUpgradeIntentCurrent } from '../upgrade-coordinator-validation.ts'
import { loadTrustedReleaseKeys, readReleaseManifestFor } from '../upgrade-observation.ts'
import { assertCurrentLifecycleEffect, assertNativeLifecyclePrerequisites, assertNativeLifecycleRecoveryPrerequisites, withNativeRecoveryPreparation, createNativeUpgradeSafety, readNativeReleaseTrust, verifyCurrentLifecycleWriterReadiness, withNativeLifecycleDatabaseAdmission } from '../../../../scripts/lifecycle-root-safety.mjs'
import { verifyAuthenticatedReleaseArchive } from '../../../../scripts/release-verifier.mjs'
import { withPreparedRelease, parsePreparedReleaseInput } from '../../../../scripts/prepared-release.mjs'
export { runNativeRootOperatorCommand } from '../../../../scripts/root-operator.mjs'

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
  if (Object.keys(artifact).sort().join(',') !== 'expectedArchiveSha256,keyId,path,signingKeyPath' || !canonical(artifact.path) || !canonical(artifact.signingKeyPath) || typeof artifact.keyId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(artifact.keyId) || typeof artifact.expectedArchiveSha256 !== 'string' || !SHA.test(artifact.expectedArchiveSha256)) return deny('LIFECYCLE_ARTIFACT_INVALID')
  parsePreparedReleaseInput({ artifactPath: artifact.path, expectedArchiveSha256: artifact.expectedArchiveSha256 })
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
/** Rewind scratch and set-aside trees beside the live state directory, keyed by upgrade record id. */
const REWIND_SCRATCH = /^\/var\/lib\/xpanel\/\.rewind-[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const REWIND_PATH = /^\/var\/lib\/xpanel\/(?:state(?:\/generations)?|\.pre-rewind-[A-Za-z0-9][A-Za-z0-9-]{0,63}|\.rewind-[A-Za-z0-9][A-Za-z0-9-]{0,63}\/state(?:\/generations)?)$/
/** Retention removes only sealed (root-owned) set-aside trees and empty scratch; the live state tree never. */
const REWIND_REMOVABLE = /^\/var\/lib\/xpanel\/\.(?:pre-rewind|rewind)-[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
/** Exact native engine paths only; policy matching is not an admission grant. */
export const nativeLifecyclePathAllowed = (path: string, operation: PathOperation): boolean => {
  if (!canonical(path)) return false
  if (operation === 'read') return nativeLifecyclePathAllowed(path, 'write') || nativeLifecyclePathAllowed(path, 'directory') || ['/opt/xpanel/releases/', '/opt/xpanel/staging/', '/opt/xpanel/downloads/', BACKUPS + '/'].some(root => path.startsWith(root))
  if (operation === 'directory') return path === BACKUPS || REWIND_SCRATCH.test(path) || /^\/opt\/xpanel\/staging\/[A-Za-z0-9._-]+$/.test(path)
  if (operation === 'link') return /^\/opt\/xpanel\/\.current-[A-Za-z0-9._-]+$/.test(path)
  if (operation === 'write') return path === '/opt/xpanel/current' || REWIND_PATH.test(path) || /^\/opt\/xpanel\/(?:\.current-[A-Za-z0-9._-]+|(?:staging|releases)\/[A-Za-z0-9._-]+)$/.test(path) || /^\/var\/lib\/xpanel\/(?:upgrade\.lock|maintenance\.json)(?:\.[A-Za-z0-9._-]+\.tmp)?$/.test(path) || path.startsWith(BACKUPS + '/')
  return /^\/opt\/xpanel\/(?:\.current-[A-Za-z0-9._-]+|(?:staging|releases)\/[A-Za-z0-9._-]+)$/.test(path) || /^\/var\/lib\/xpanel\/(?:upgrade\.lock|maintenance\.json)\.[A-Za-z0-9._-]+\.tmp$/.test(path)
    || REWIND_REMOVABLE.test(path) || /^\/var\/lib\/xpanel-lifecycle\/backups\/[A-Za-z0-9][A-Za-z0-9._-]*\.tmp$/.test(path)
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
type Owner = { uid: number; gid: number }
type AncestorPin = { path: string; uid: number; gid: number; mode: number }
const PANEL_STATE_PARENT = /^\/var\/lib\/xpanel\/(?:state|\.rewind-[A-Za-z0-9][A-Za-z0-9-]{0,63}\/state)$/
/**
 * Ancestors of a lifecycle path are root-owned and not group/world writable. The panel data root and the
 * desired-state trees inside it belong to the panel user with their installed modes; whoever can write the data
 * root can already replace those trees whole, so holding them as parents grants nothing more.
 */
export const lifecycleAncestorAccepted = (pin: AncestorPin, owner: Owner): boolean => {
  if (pin.uid === 0) return (pin.mode & 0o022) === 0
  if (pin.uid !== owner.uid || pin.gid !== owner.gid) return false
  if (pin.path === '/var/lib/xpanel') return [0o2770, 0o2750].includes(pin.mode)
  return PANEL_STATE_PARENT.test(pin.path) && pin.mode === 0o2750
}
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

const nativeFilesystem = (owner: Owner, boundArtifactPath: string | null): FsPort => {
  const withParent = async <T>(path: string, operation: PathOperation, callback: (heldPath: string, parent: FileHandle) => Promise<T>): Promise<T> => {
    if (!nativeLifecyclePathAllowed(path, operation) && !(operation === 'read' && path === boundArtifactPath && canonical(path))) return deny('LIFECYCLE_PATH_DENIED')
    await assertCurrentLifecycleEffect(operation === 'read' ? 'service.observe' : 'filesystem.write')
    const pins: { path: string; handle: FileHandle; dev: number; ino: number; uid: number; gid: number; mode: number }[] = []
    const verify = async (): Promise<void> => {
      for (const pin of pins) {
        const [opened, named] = await Promise.all([pin.handle.stat(), lstat(pin.path)])
        if (!opened.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || opened.dev !== pin.dev || opened.ino !== pin.ino || named.dev !== pin.dev || named.ino !== pin.ino
          || [opened, named].some(info => info.uid !== pin.uid || info.gid !== pin.gid || (info.mode & 0o7777) !== pin.mode)
          || !lifecycleAncestorAccepted(pin, owner)) return deny('LIFECYCLE_PATH_ANCESTRY_CHANGED')
      }
    }
    try {
      for (const segment of ['/', ...dirname(path).split('/').filter(Boolean)]) {
        const previous = pins.at(-1)
        const namedPath = previous ? posix.join(previous.path, segment) : '/'
        const fdPath = previous ? `/proc/self/fd/${previous.handle.fd}/${segment}` : '/'
        const handle = await open(fdPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        const info = await handle.stat()
        pins.push({ path: namedPath, handle, dev: info.dev, ino: info.ino, uid: info.uid, gid: info.gid, mode: info.mode & 0o7777 })
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

/**
 * A stop or disable of a unit systemd has no file for and does not run is already done; any other nonzero exit,
 * and an absent unit for start, restart, reload or enable, stays a failure.
 */
export const runLifecycleSystemdAction = async (run: (argv: string[]) => Promise<{ code: number | null; stdout: string }>, action: Extract<HostAction, { kind: 'systemd' }>): Promise<void> => {
  if ((await run(['/usr/bin/systemctl', action.verb, action.unit])).code === 0) return
  if (action.verb === 'stop' || action.verb === 'disable') {
    const shown = await run(['/usr/bin/systemctl', 'show', '-p', 'LoadState', '-p', 'ActiveState', '--value', '--', action.unit])
    if (shown.code === 0 && shown.stdout.trim().split('\n').join(' ') === 'not-found inactive') return
  }
  return deny('LIFECYCLE_SERVICE_COMMAND_FAILED')
}

/** The stable code first, then the unit and error the failed generation recorded, for the step log and attention record. */
const reconcileFailed = (result: { status: string; failedTest?: string; error?: string }): never => {
  throw Object.assign(new Error(result.status === 'failed' ? `LIFECYCLE_RECONCILE_FAILED ${result.failedTest}: ${result.error}`.slice(0, 600) : 'LIFECYCLE_RECONCILE_FAILED'), { code: 'LIFECYCLE_RECONCILE_FAILED' })
}

const guardedExecutor = (executor: LinuxHostExecutor): AgentExecutor => {
  const effect = async <T>(callback: () => Promise<T>, kind: 'filesystem.write' | 'service.observe' = 'filesystem.write'): Promise<T> => { await assertCurrentLifecycleEffect(kind); const value = await callback(); await assertCurrentLifecycleEffect(kind); return value }
  return { preflight: plan => effect(() => executor.preflight(plan), 'service.observe'), writeFile: file => effect(() => executor.writeFile(file)), readFile: path => effect(() => executor.readFile(path), 'service.observe'), removePath: path => effect(() => executor.removePath(path)), runTest: test => effect(() => executor.runTest(test)), runAction: action => effect(async () => { if (action.kind === 'systemd') return runLifecycleSystemdAction(argv => executor.runCommand(argv), action); await executor.runAction(action) }), runCommand: argv => effect(() => executor.runCommand(argv)), readSliceMetrics: uid => effect(() => executor.readSliceMetrics(uid), 'service.observe') }
}

const composition = async (db: ReturnType<typeof createDb>['db'], actor: Principal, owner: Owner, boundArtifactPath: string | null): Promise<{ ports: UpgradePorts; store: StateStore; os: Awaited<ReturnType<typeof detectOs>>; releaseKeys: readonly ReleaseVerificationKey[]; canaries: ReturnType<typeof createNativeLifecycleCanary> }> => {
  const os = detectOs(path => readFileSync(path, 'utf8'))
  const store = new StateStore(STATE)
  await store.getAuthorityMetadata()
  const native = new LinuxHostExecutor({ trustedHostTargetMatcher: createProductionHostTargetMatcher(), trustedHostTargets: [{ path: BACKUPS, operations: ['ensure-directory'] }] })
  const executor = guardedExecutor(native)
  const resolvedOs = await os
  // A read-only mount observation, outside lifecycle effects.
  const quotaFilesystem = await resolveHomeQuotaFilesystem(argv => native.runCommand(argv)).catch(() => '/home')
  const { reconciler } = await createNativeHostReconciler({ store, db, executor, os: resolvedOs, quotaFilesystem, healthProbe: async unit => { const result = await executor.runCommand(['/usr/bin/systemctl', 'is-active', '--quiet', unit]); return { ok: result.code === 0, ...(result.code !== 0 ? { error: 'Native service was not active' } : {}) } } }, native)
  const canaries = createNativeLifecycleCanary({ db, databaseReader: createProvisioningDatabaseReaderPort(DATABASE, 'pre-migration'), store, executor, reconciler, os: resolvedOs, addon: await loadNativePeerIdentityAddon() })
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
  // Root-held Ed25519 publisher keys only; missing, unsafe or HMAC trust yields an empty list that refuses upgrades.
  const releaseKeys = (await loadTrustedReleaseKeys()).keys
  const ports = createProductionUpgradePorts({ db, fs: nativeFilesystem(owner, boundArtifactPath), host, clock: { now: () => new Date(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) }, trustedReleaseKeys: releaseKeys,
    loadReleaseMigrations: root => loadMigrations(posix.join(root, 'packages/db/src/migrations')),
    probeFreeBytes: async path => { await assertCurrentLifecycleEffect('service.observe'); const value = await statfs(path, { bigint: true }); const bytes = value.bavail * value.bsize; if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER; return Number(bytes) },
    probeOsRelease: async () => parseOsRelease(await readFile('/etc/os-release', 'utf8')),
    probeActiveTransfers: async () => { await assertCurrentLifecycleEffect('service.observe'); if (!await verifyCurrentLifecycleWriterReadiness()) return deny('LIFECYCLE_WRITER_READINESS_UNAVAILABLE'); const rows = await db.query<{ count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','running') AND kind NOT LIKE 'lifecycle.%'"); const count = rows[0]?.count; if (!Number.isSafeInteger(count) || count! < 0) return deny('LIFECYCLE_TRANSFER_OBSERVATION_UNAVAILABLE'); return count! },
    // Private IPC proves the current fenced control-plane processes, not an MFA user login.
    probeQualifiedControlPlane: verifyCurrentLifecycleWriterReadiness,
    probeCanaryHttp: target => canaries.observe(target),
    reconciler: {
      currentGeneration: async () => { const active = await latestActive(db); if (!active) return deny('LIFECYCLE_ACTIVE_GENERATION_REQUIRED'); return active.id },
      reconcile: async () => { await assertCurrentLifecycleEffect('filesystem.write'); const result = await reconciler.reconcile({ force: true, actor: actor.username }); if (result.status === 'failed' || !result.generation) return reconcileFailed(result); return { generationId: result.generation.id, units: [] } },
      // Rewind only: the restored state files must be the exact source of that generation; this coordinator
      // (the pre-upgrade release) rebuilds and applies them. Any other historical replay stays denied.
      activate: async generationId => {
        await assertCurrentLifecycleEffect('filesystem.write')
        const [target, snapshot] = await Promise.all([getGeneration(db, generationId), store.readSnapshot()])
        const manifest = target ? await reconciler.journal.readManifest(generationId) : null
        if (!manifest || manifest.stateChecksum !== snapshot.checksum) return deny('LIFECYCLE_HISTORICAL_AUTHORITY_REPLAY_DENIED')
        const result = await reconciler.reconcileRewound(generationId, actor.username)
        if (result.status === 'failed' || !result.generation) return reconcileFailed(result)
        return { generationId: result.generation.id, units: [] }
      },
      status: async () => { const [drift, active, snapshot] = await Promise.all([reconciler.checkDrift(), latestActive(db), store.readSnapshot()]); const manifest = active ? await reconciler.journal.readManifest(active.id) : null; const problems = drift.items.map(item => item.path); if (!manifest || manifest.stateChecksum !== snapshot.checksum) problems.push('current desired state is not the active generation'); if (drift.manifestMissing) problems.push('active generation manifest is unavailable'); return { converged: !drift.hasDrift && problems.length === 0, drift: problems } },
      identities: async limits => { await assertCurrentLifecycleEffect('service.observe'); const snapshot = await store.readSnapshot(); const observed = await observeHostLimits(executor, snapshot.accounts, snapshot.plans, '/home'); if (snapshot.accounts.length && !limitRequirementMet(limits, observed)) return deny('LIFECYCLE_ASSIGNED_LIMITS_UNVERIFIED'); const identities = await Promise.all(snapshot.accounts.map(async account => { const [uid, gid] = await Promise.all([executor.runCommand(['/usr/bin/id', '-u', '--', account.username]), executor.runCommand(['/usr/bin/id', '-g', '--', account.username])]); if (!uid.ok || !gid.ok || uid.stdout.trim() !== String(account.uid) || gid.stdout.trim() !== String(account.gid)) return deny('LIFECYCLE_ACCOUNT_IDENTITY_CHANGED'); const plan = snapshot.plans.find(plan => plan.id === account.planId); if (!plan) return deny('LIFECYCLE_ASSIGNED_PLAN_UNAVAILABLE'); return { username: account.username, uid: account.uid, gid: account.gid, slice: `xpanel-${account.uid}.slice`, quotas: { ...effectivePlan(plan, account).resources } } })); return { accounts: await canaries.bindIdentities(identities), limits: observed } },
    },
  })
  return { ports, store, os: resolvedOs, releaseKeys, canaries }
}

/** Real composition only. No request, environment or callback supplies a principal or readiness. */
export const runNativeLifecycleCommand = async (input: unknown, processBinding?: UpgradeProcessBinding) => {
  const request = validateNativeLifecycleRequest(input)
  const binding = processBinding === undefined ? null : parseUpgradeProcessBinding(processBinding)
  if (binding && request.command !== 'upgrade') return deny('LIFECYCLE_HANDOFF_COMMAND_MISMATCH')
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) return deny('LIFECYCLE_ROOT_LINUX_REQUIRED')
  if (process.version !== 'v26.12.1' || process.env.NODE_OPTIONS || process.env.NODE_PATH) return deny('LIFECYCLE_PINNED_RUNTIME_REQUIRED')
  if (request.command === 'recover') await assertNativeLifecycleRecoveryPrerequisites()
  else await assertNativeLifecyclePrerequisites()
  return withNativeLifecycleDatabaseAdmission(request.command === 'recover' ? 'recover' : 'upgrade', async admitted => {
    const handle = { db: admitted.db }
    const origin = await handle.db.transaction(async tx => getStrictOperationDatabaseOrigin(tx))
    if (origin.file !== DATABASE) return deny('LIFECYCLE_DATABASE_CHANGED')
    const rows = await handle.db.query<{ id: string }>("SELECT id FROM principals WHERE kind='root' AND disabled=0 ORDER BY created_at,id LIMIT 2")
    if (rows.length !== 1) return deny('LIFECYCLE_ROOT_PRINCIPAL_AMBIGUOUS')
    const root = await getPrincipal(handle.db, rows[0]!.id)
    if (!root || root.kind !== 'root' || root.disabled || root.forcePasswordChange
      || root.id !== admitted.principal.id || root.username !== admitted.principal.username) return deny('LIFECYCLE_ROOT_PRINCIPAL_REQUIRED')
    const actor: Principal = { kind: 'root', id: root.id, username: root.username }
    const handoff = binding ? readUpgradeIntentJob(await getDurableJob(handle.db, binding.jobId), binding) : null
    if (handoff && (handoff.job.checkpointStep !== 'native-consumed' || handoff.intent.principalId !== actor.id || handoff.intent.actor !== actor.username)) return deny('LIFECYCLE_HANDOFF_ACTOR_MISMATCH')
    const { ports, os, releaseKeys, canaries } = await composition(handle.db, actor, await panelOwner(), request.artifact?.path ?? null)
    // A stored target is metadata until the actual native safety scope admits that exact account lifetime.
    const canary = await canaries.select()
    const withCanary = (safety: UpgradeSafetyPort): UpgradeSafetyPort => ({ ...safety,
      withExclusive: work => safety.withExclusive(async () => { await canaries.assertSelectionCurrent(canary); return work() }),
    })
    if (request.command === 'recover') {
      const result = await withNativeRecoveryPreparation(async preparedRelease => {
        const safety = await createNativeUpgradeSafety({ db: handle!.db, actorId: actor.id, operation: 'recover', preparedRelease })
        return recoverUpgrade({ ...ports, safety: withCanary(safety) }, { actor, os, note: 'Root operator requested recovery of the protected pending operation', canary: canary.username })
      })
      return { exitCode: result.outcome === 'retirement_pending' ? 6 : 0, code: result.outcome === 'retirement_pending' ? 'LIFECYCLE_RETIREMENT_PENDING' : 'LIFECYCLE_RECOVERED', outcome: result.outcome,
        details: { phase: result.outcome, recordId: result.recordId, qualified: result.outcome !== 'retirement_pending' } }
    }
    const artifact = request.artifact!
    const trust = await readNativeReleaseTrust()
    if (artifact.keyId !== trust.keyId) return deny('LIFECYCLE_ROOT_TRUST_MISMATCH')
    const report: unknown = await verifyAuthenticatedReleaseArchive(artifact.path, { ...trust, expectedArchiveSha256: artifact.expectedArchiveSha256 })
    const release = releaseInfoFromAuthenticatedReport(report, artifact)
    if (releaseKeys.length === 0) return deny('LIFECYCLE_NO_TRUSTED_RELEASE_KEYS')
    // The publisher-signed manifest beside the archive is independently re-verified here; agent observations are not authority.
    const signedManifest = await readReleaseManifestFor(artifact.path)
    try { verifySignedManifestForRelease(signedManifest, release, releaseKeys) } catch { return deny('LIFECYCLE_RELEASE_MANIFEST_UNVERIFIED') }
    if (handoff) {
      if (JSON.stringify(handoff.intent.release) !== JSON.stringify(release) || handoff.intent.manifestDigest !== signedReleaseManifestDigest(signedManifest)) return deny('LIFECYCLE_HANDOFF_RELEASE_MISMATCH')
      await assertUpgradeIntentCurrent(handle.db, handoff.intent)
      const current = readUpgradeIntentJob(await getDurableJob(handle.db, binding!.jobId), binding!)
      if (current.job.checkpointStep !== 'native-consumed' || current.intent.principalId !== actor.id || current.intent.actor !== actor.username) return deny('LIFECYCLE_HANDOFF_CHANGED')
    }
    const currentTarget = await readlink('/opt/xpanel/current')
    const currentVersion = basename(currentTarget)
    if (!VERSION.test(currentVersion) || dirname(currentTarget) !== '/opt/xpanel/releases') return deny('LIFECYCLE_CURRENT_RELEASE_INVALID')
    if (request.command === 'update' && currentVersion.split('.')[0] !== release.version.split('.')[0]) return deny('LIFECYCLE_MAJOR_UPGRADE_REQUIRED')
    const result = await withPreparedRelease({ artifactPath: artifact.path, expectedArchiveSha256: artifact.expectedArchiveSha256 }, async preparedRelease => {
      const safety = await createNativeUpgradeSafety({ db: handle!.db, actorId: actor.id, operation: 'upgrade', release, preparedRelease })
      return runUpgrade({ ...ports, safety: withCanary(safety) }, { actor, os, release, canary: canary.username })
    })
    return result.outcome === 'succeeded'
      ? { exitCode: 0, code: 'LIFECYCLE_NATIVE_COMMITTED', outcome: 'committed', details: { currentVersion: release.version, changed: true, upgradeId: result.recordId } }
      : result.outcome === 'rolled_back' ? { exitCode: 5, code: 'LIFECYCLE_NATIVE_ROLLED_BACK', outcome: 'rolled_back', details: { phase: 'rolled_back', qualified: true, upgradeId: result.recordId } }
      : { exitCode: result.outcome === 'refused' ? 3 : 6, code: result.outcome === 'refused' ? 'LIFECYCLE_UPGRADE_REFUSED' : result.outcome === 'rollback_failed' ? 'LIFECYCLE_ROLLBACK_FAILED' : 'LIFECYCLE_RETIREMENT_PENDING', outcome: result.outcome === 'refused' ? 'blocked' : 'attention', details: { phase: 'retirement_pending', qualified: false, ...upgradeAttentionStep(result) } }
  })
}

/** The step an operator starts from: a failed rewind step first, else the last failed upgrade step, with its reason. */
export const upgradeAttentionStep = (result: Pick<UpgradeResult, 'rewind' | 'steps'>): { step: string; reason: string } | Record<string, never> => {
  const rewound = /^(rewind:[a-z-]+): ([^]*)$/.exec(result.rewind?.problems[0] ?? '')
  if (rewound) return { step: rewound[1]!, reason: rewound[2]! }
  const failed = result.steps.findLast(step => !step.ok)
  return failed ? { step: failed.step, reason: failed.detail } : {}
}
