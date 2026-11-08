import { runNativeLifecycleCommand } from '../apps/agent/src/lifecycle/native-runtime.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, readlink, realpath, rename, unlink, readdir } from 'node:fs/promises'
import { basename, dirname, join, posix } from 'node:path'
import { ReconcilerJournal } from '../apps/agent/src/reconciler-journal.ts'
import { withHostOperationGuard, assertHostOperationGuardHeld, assertHostOperationGuardActive, getStrictOperationDatabaseOrigin, createRootOperationAuditAuthority, withReadonlyOperationDatabase, withReadonlyLifecycleIntentObservation, assertOperationIntentReceipt, getPrincipal, getDurableJob, createJob, finishJob, finishUpgrade, currentSchemaVersion, latestUpgrade, reindexFromState, restoreOperationalDatabaseSnapshot } from '../packages/db/src/index.ts'
import { StateStore, generationSourceIsLinked } from '../packages/state/src/index.ts'
import { normalizeDependencyModes, offlineDependencyInstallArguments, withAuthenticatedReleaseArchive, stageAuthenticatedReleaseArchive, verifyAuthenticatedReleaseArchive } from './release-verifier.mjs'
import { readInstallationReceipt, parseInstallationReceipt, assertOwnedFile, withTrustedFile, withTrustedDirectory, requireLinuxRoot, OWNED_PANEL_UNITS } from './lifecycle-ownership.mjs'
import { observeOwnedControlPlaneUnits, assertOwnedControlPlaneQuiescent, awaitOwnedServiceChildren, projectOwnedControlPlaneObservation, stopAndDrainOwnedControlPlaneUnits } from './lifecycle-services.mjs'
import { assertPreparedReleaseCurrent, preparedReleaseInfo, withExistingPreparedRelease, withVisiblePreparedRelease, observeInstalledReleaseTree } from './prepared-release.mjs'
import { captureManagedFile, ensureManagedPrivateDirectory, managedPathAbsent, replaceManagedFile } from './lifecycle-managed-files.mjs'
import { withVerifiedCoordinatorOwnership, assertCoordinatorOwnershipCurrent, coordinatorOwnershipInfo } from './coordinator-ownership.mjs'
import { TERMINAL_RECORD_KEYS } from './install-transition-observation.mjs'
import { prepareInstallationTransition, selectInstallationTransition, publishInstallationTransition, readInstallationTransitionRecovery, reopenInstallationTransition } from './installation-transition.mjs'
import { createDb, getReadonlyOperationDatabaseOrigin, assertReadonlyOperationDatabaseCurrent, withReadonlyClosedOperationDatabase,
  withReadonlyLifecycleIntentFileObservation, assertReadonlyLifecycleIntentFileObservationCurrent,
  normalizeIssuedLifecycleAppendPlan, withReadonlyIssuedLifecycleAppendPrefixObservation, assertReadonlyIssuedLifecycleAppendPrefixCurrent,
  assertReadonlyIssuedLifecycleAppendRetainedIntent, withReadonlyIssuedLifecycleAppendDatabaseObservation } from '../packages/db/src/index.ts'
import { withClosedDatabasePins } from './lifecycle-database-fence.mjs'
import { writeIssuedLifecycleAuditJournal, writeIssuedLifecycleAuditCompletion, withSelectedIssuedLifecycleAuditJournal,
  assertIssuedLifecycleAuditJournalCurrent, issuedLifecycleAuditJournalInfo } from './lifecycle-issued-audit.mjs'

const ROOT = '/var/lib/xpanel-lifecycle'
const HEAD = ROOT + '/HEAD'
const TRUST = '/etc/xpanel/release-trust.json'
const EFFECTS = new Set(['service.stop', 'service.start', 'service.observe', 'barrier.retire', 'filesystem.write'])
const ACTIONS = new Set(['upgrade', 'rollback', 'recover', 'uninstall', 'adopt'])
const COORDINATORS = new Set(['xpanel-upgrade.service', 'xpanel-lifecycle.service'])
const SHA = /^[a-f0-9]{64}$/
const scopeStorage = new AsyncLocalStorage()
const capabilities = new WeakMap()
const retiredObservationScopes = new WeakSet()
const factories = new WeakMap()
const recoveryObservationScopes = new WeakMap()
const recoveryObservationStorage = new AsyncLocalStorage()
const bootstrapScopes = new WeakMap(), bootstrapStorage = new AsyncLocalStorage()
let visibleBootstrap = null
const closedRecoveryViews = new WeakMap()
const auditIssuances = new WeakMap(), auditIssuanceStorage = new AsyncLocalStorage()
const auditRepairs = new WeakMap(), auditRepairStorage = new AsyncLocalStorage()
const fail = (code, cause) => { throw Object.assign(new Error(code, cause ? { cause } : undefined), { code }) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

/** Actual pinned-runtime ABI probe; Argon2id is provided by Node, not an npm dependency. */
export const NATIVE_RUNTIME_ABI_PROBE = `
import { argon2 } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const tag = await new Promise((resolve, reject) => argon2('argon2id', {
  message: 'lifecycle-native-abi-probe', nonce: Buffer.alloc(16, 1),
  memory: 65536, passes: 3, parallelism: 4, tagLength: 32,
}, (error, value) => error ? reject(error) : resolve(value)));
if (!Buffer.isBuffer(tag) || tag.length !== 32) throw new Error('native Argon2id ABI failed');
const database = new DatabaseSync(':memory:');
try { if (database.prepare('SELECT 1 AS value').get().value !== 1) throw new Error('native SQLite ABI failed'); }
finally { database.close(); }
`

/** Parsing does not confer authority. Only the native factory below can mint a live scope. */
export function parseCoordinatorCgroup(text) {
  if (typeof text !== 'string' || text.length > 4096) fail('LIFECYCLE_COORDINATOR_INVALID')
  const rows = text.trim().split('\n')
  if (rows.length !== 1) fail('LIFECYCLE_COORDINATOR_INVALID')
  const match = /^0::\/system\.slice\/(xpanel-(?:upgrade|lifecycle)\.service)$/.exec(rows[0])
  if (!match || !COORDINATORS.has(match[1])) fail('LIFECYCLE_COORDINATOR_REQUIRED')
  return match[1]
}

export function parseLifecycleHead(value) {
  const keys = ['schemaVersion', 'issuerId', 'sequence', 'phase', 'operationId', 'reference', 'kind', 'requestFingerprint', 'updatedAt']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('LIFECYCLE_HEAD_INVALID')
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !['idle', 'pending', 'retirement_pending', 'retired'].includes(value.phase) || !ACTIONS.has(value.kind) || !SHA.test(value.requestFingerprint) || !/^[0-9a-f-]{36}$/.test(value.issuerId) || !/^[0-9a-f-]{36}$/.test(value.operationId) || !(value.reference === null || /^XP-JOB-(?:[0-9]{4}-)?[0-9]{6,16}$/.test(value.reference)) || !Number.isFinite(Date.parse(value.updatedAt))) fail('LIFECYCLE_HEAD_INVALID')
  return Object.freeze({ ...value })
}

async function processIdentity() {
  requireLinuxRoot()
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH || await readlink('/proc/self') !== String(process.pid)) fail('LIFECYCLE_RUNTIME_UNTRUSTED')
  const [status, stat, cgroup, executable] = await Promise.all([readFile(`/proc/${process.pid}/status`, 'utf8'), readFile(`/proc/${process.pid}/stat`, 'utf8'), readFile(`/proc/${process.pid}/cgroup`, 'utf8'), readlink(`/proc/${process.pid}/exe`)])
  if (!/^Uid:\s+0\s+0\s+0\s+0\s*$/m.test(status)) fail('LIFECYCLE_ACTUAL_UID_REQUIRED')
  const end = stat.lastIndexOf(')'), fields = stat.slice(end + 2).trim().split(/\s+/)
  if (end < 0 || !/^[0-9]+$/.test(fields[19] ?? '')) fail('LIFECYCLE_PROCESS_IDENTITY_INVALID')
  const actual = await realpath(process.execPath)
  if (actual !== executable) fail('LIFECYCLE_EXECUTABLE_CHANGED')
  return Object.freeze({ pid: process.pid, start: fields[19], executable, coordinatorUnit: parseCoordinatorCgroup(cgroup) })
}

async function nativeCommand(path, args, options = {}) {
  requireLinuxRoot()
  if (typeof path !== 'string' || !posix.isAbsolute(path) || !Array.isArray(args) || args.some(value => typeof value !== 'string' || /[\0\r\n]/.test(value))) fail('LIFECYCLE_COMMAND_INVALID')
  return withTrustedFile(path, { maxBytes: 256 * 1024 * 1024, ...(options.sha256 ? { sha256: options.sha256 } : {}) }, async pin => {
    if (!(Number(pin.info.mode) & 0o111)) fail('LIFECYCLE_EXECUTABLE_REQUIRED')
    return new Promise((resolve, reject) => {
      const child = spawn('/proc/self/fd/3', args, { cwd: options.cwd ?? '/', stdio: ['ignore', 'pipe', 'pipe', pin.fd], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' } })
      let output = '', bytes = 0, uncertain = false, spawnError
      let escalation
      const timer = setTimeout(() => { uncertain = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 5000) }, options.timeoutMs ?? 30_000)
      const collect = chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) uncertain = true; else output += chunk }
      child.stdout.on('data', collect); child.stderr.on('data', collect)
      child.once('error', error => { spawnError = error })
      // Keep the real descriptor and owning guard until actual close. A timeout is not quiescence.
      child.once('close', async (code, signal) => {
        clearTimeout(timer); clearTimeout(escalation)
        try { await pin.verify() } catch (error) { reject(error); return }
        if (uncertain || signal || code === null) { reject(Object.assign(new Error('LIFECYCLE_CHILD_UNCERTAIN'), { code: 'LIFECYCLE_CHILD_UNCERTAIN' })); return }
        if (spawnError) { reject(spawnError); return }
        resolve({ code, output })
      })
    })
  })
}

async function durableJson(path, value, replace = false, mode = 0o600) {
  const scope = scopeStorage.getStore()
  await assertScope(scope)
  const previous = replace ? (await captureManagedFile(path)).entry : null
  await replaceManagedFile(path, Buffer.from(JSON.stringify(value) + '\n'), mode, previous, () => assertScope(scope))
}

async function ensureTerminalDirectory(scope) {
  await ensureManagedPrivateDirectory(ROOT + '/terminal', () => assertScope(scope))
}

/** These 2 files are diagnostics inside the panel-owned DB directory, never writer authority. */
async function removePanelDiagnostic(scope, name) {
  if (!['maintenance.json', 'upgrade.lock'].includes(name)) fail('LIFECYCLE_DIAGNOSTIC_PATH_DENIED')
  await assertScope(scope); await assertProtectedDatabaseOrigin(scope.origin)
  return withTrustedDirectory('/var/lib', async ancestry => {
    const parent = await open('/var/lib/xpanel', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const [directory, database] = await Promise.all([parent.stat({ bigint: true }), lstat('/var/lib/xpanel/control.db', { bigint: true })])
      if (!directory.isDirectory() || directory.uid !== database.uid || directory.gid !== database.gid || ![0o2770n, 0o2750n].includes(directory.mode & 0o7777n)
        || String(database.dev) !== scope.origin.device || String(database.ino) !== scope.origin.inode) fail('LIFECYCLE_DIAGNOSTIC_PARENT_CHANGED')
      const path = `/proc/self/fd/${parent.fd}/${name}`
      let file
      try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) { if (error.code === 'ENOENT') return; throw error }
      try {
        const opened = await file.stat({ bigint: true })
        if (!opened.isFile() || opened.uid !== 0n || ![0n, directory.gid].includes(opened.gid) || opened.nlink !== 1n || (opened.mode & 0o022n) !== 0n || opened.size > 65536n) fail('LIFECYCLE_DIAGNOSTIC_FILE_CHANGED')
        const named = await lstat(path, { bigint: true }), parentNow = await lstat('/var/lib/xpanel', { bigint: true })
        if (named.dev !== opened.dev || named.ino !== opened.ino || parentNow.dev !== directory.dev || parentNow.ino !== directory.ino
          || parentNow.uid !== directory.uid || parentNow.gid !== directory.gid || parentNow.mode !== directory.mode) fail('LIFECYCLE_DIAGNOSTIC_FILE_CHANGED')
        await assertScope(scope); await ancestry.verify()
        await unlink(path); await parent.sync()
      } finally { await file.close() }
    } finally { await parent.close() }
  })
}

/**
 * Pure schema admission. Forward moves stay within the authenticated release. An older reader is admitted
 * only as a rollback through this upgrade's own snapshot: `planned` at precheck, then the verified snapshot.
 */
export function admitSchemaTransition(input, facts) {
  if (!input || !['forward', 'rollback'].includes(input.direction) || !Number.isSafeInteger(input.currentSchema) || !Number.isSafeInteger(input.targetSchema)) return false
  const manifest = facts.manifestSchema
  if (input.direction === 'rollback' && input.snapshot === 'planned') return Number.isSafeInteger(manifest) && input.targetSchema === facts.liveSchema && input.currentSchema === manifest && input.targetSchema <= manifest
  if (input.currentSchema !== facts.liveSchema) return false
  if (input.direction === 'rollback' && input.snapshot !== undefined) return facts.snapshotVerified === true && input.targetSchema <= facts.liveSchema
  return Number.isSafeInteger(manifest) && input.targetSchema >= facts.liveSchema && input.targetSchema <= manifest
}

/** The snapshot must be the one this scope wrote, or (recover) the one the in-flight upgrade's root-only receipt names. */
async function verifiedRewindSnapshot(scope, input) {
  const snapshot = input?.snapshot
  if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.recordId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(snapshot.recordId) || typeof snapshot.path !== 'string' || dirname(snapshot.path) !== ROOT + '/backups' || !/^[0-9]{8}T[0-9]{6}Z\.tar\.gz$/.test(basename(snapshot.path))) return false
  const copy = snapshot.path + '.control.db'
  const digest = await withTrustedFile(copy, { maxBytes: 256 * 1024 * 1024 }, async pin => pin.sha256)
  if (scope.backup) return scope.backup.path === copy && scope.backup.sha256 === digest && scope.backup.schema === input.targetSchema
  const last = await latestUpgrade(scope.db)
  if (!last || last.id !== snapshot.recordId || !['pending', 'running'].includes(last.status)) return false
  const receipt = await withTrustedFile(`${ROOT}/backups/upgrade-${snapshot.recordId}.receipt.json`, { exactMode: 0o600, maxBytes: 4 * 1024 * 1024 }, async pin => JSON.parse(pin.bytes.toString('utf8')))
  return receipt?.recordId === snapshot.recordId && receipt.snapshot?.path === snapshot.path && receipt.control?.path === copy && receipt.control?.sha256 === digest && receipt.fromSchema === input.targetSchema
}

async function readHead() {
  return withTrustedFile(HEAD, { exactMode: 0o600, maxBytes: 16384 }, async pin => ({ value: parseLifecycleHead(JSON.parse(pin.bytes.toString('utf8'))), hash: sha(pin.bytes), bytes: pin.bytes.toString('utf8') }))
}

async function trustConfiguration() {
  return withTrustedFile(TRUST, { exactMode: 0o600, maxBytes: 8192 }, async pin => {
    const config = JSON.parse(pin.bytes.toString('utf8'))
    if (!config || Object.keys(config).sort().join(',') !== 'keyId,packageManagerPath,packageManagerSha256,signingKeyPath' || typeof config.keyId !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(config.keyId) || !SHA.test(config.packageManagerSha256) || ![config.signingKeyPath, config.packageManagerPath].every(path => typeof path === 'string' && path.startsWith('/') && posix.normalize(path) === path && !path.startsWith('/home/'))) fail('LIFECYCLE_TRUST_CONFIGURATION_INVALID')
    const key = await withTrustedFile(config.signingKeyPath, { exactMode: 0o600, maxBytes: 4096 }, async held => Buffer.from(held.bytes))
    if (key.length < 32) fail('LIFECYCLE_TRUST_KEY_INVALID')
    return { ...config, signingKey: key }
  })
}

const bindingFor = origin => ({ databaseFile: origin.file, databaseDevice: origin.device, databaseInode: origin.inode, issuerId: origin.issuerId })
const archiveTrust = trust => ({ signingKey: trust.signingKey, keyId: trust.keyId })

async function assertProtectedDatabaseOrigin(origin) {
  // Finalization's durable root audit anchor outlives changes to HEAD/source receipts.
  await withTrustedFile('/var/lib/xpanel-agent/operation-audit/operation-audit-authority.json', { exactMode: 0o600, maxBytes: 16384 }, async pin => {
    const anchor = JSON.parse(pin.bytes)
    if (anchor.schemaVersion !== 1 || ['file', 'device', 'inode', 'issuerId'].some(key => anchor.origin?.[key] !== origin[key])) fail('LIFECYCLE_PROTECTED_DATABASE_ORIGIN_CHANGED')
  })
}

const DATABASE = '/var/lib/xpanel/control.db'
const originEqual = (a, b) => ['file', 'device', 'inode', 'issuerId'].every(key => a?.[key] === b?.[key])
async function withVisibleLifecycleBootstrap(callback) {
  const current = bootstrapStorage.getStore()
  const scope = current ?? visibleBootstrap
  if (typeof callback !== 'function' || !scope?.live || (visibleBootstrap && scope !== visibleBootstrap) || (current && current !== scope)) fail('LIFECYCLE_DATABASE_ADMISSION_REQUIRED')
  if (current === scope) return callback()
  return bootstrapStorage.run(scope, () => callback())
}
const bootstrap = capability => {
  const scope = capability && typeof capability === 'object' ? bootstrapScopes.get(capability) : undefined
  if (!scope?.live || bootstrapStorage.getStore() !== scope) fail('LIFECYCLE_BOOTSTRAP_SCOPE_REQUIRED')
  return scope
}

/** No SQLite calls: usable by the physical admission bridge and closed-reader rechecks. */
export async function assertLifecycleBootstrapHeld(capability) {
  const admitted = capability && typeof capability === 'object' ? bootstrapScopes.get(capability) : undefined
  if (admitted?.live && admitted === visibleBootstrap && bootstrapStorage.getStore() !== admitted) return bootstrapStorage.run(admitted, () => assertLifecycleBootstrapHeld(capability))
  const scope = bootstrap(capability)
  if (JSON.stringify(await processIdentity()) !== JSON.stringify(scope.processPin)) fail('LIFECYCLE_COORDINATOR_CHANGED')
  await assertCoordinatorOwnershipCurrent(scope.coordinator)
  await assertFixedCoordinatorMainProcess(scope.processPin, coordinatorOwnershipInfo(scope.coordinator))
  if (!['writable', 'promoted', 'repairing'].includes(scope.phase)) await scope.anchor.verify()
  await assertProtectedDatabaseOrigin(scope.origin)
  const named = await lstat(DATABASE, { bigint: true }), held = await scope.databasePin.stat({ bigint: true })
  if (!named.isFile() || !held.isFile() || named.nlink !== 1n || held.nlink !== 1n
    || String(named.dev) !== scope.origin.device || String(named.ino) !== scope.origin.inode
    || named.dev !== held.dev || named.ino !== held.ino) fail('LIFECYCLE_BOOTSTRAP_DATABASE_CHANGED')
  if (scope.phase !== 'promoted') {
    if ((await readHead()).hash !== scope.head.hash) fail('LIFECYCLE_BOOTSTRAP_HEAD_CHANGED')
    for (const entry of scope.images) await assertOwnedFile(entry)
    if (scope.recovery) {
      await withTrustedFile(ROOT + '/writer-barrier.json', { exactMode: 0o644, maxBytes: 16384, sha256: scope.recovery.barrier.hash }, async () => {})
      if (await accountLifetimeHash() !== scope.recovery.capture.intent.binding.accountLifetimeSha256) fail('LIFECYCLE_BOOTSTRAP_ACCOUNT_CHANGED')
    } else if (scope.issuedFence) await assertOwnedFile(scope.issuedFence.entry)
    else if (scope.fencePublication) {
      if (!await managedPathAbsent(ROOT + '/writer-barrier.json')) await withTrustedFile(ROOT + '/writer-barrier.json',
        { exactMode: 0o644, maxBytes: 16384, sha256: scope.fencePublication.sha256 }, async () => {})
    }
    else if (!await managedPathAbsent(ROOT + '/writer-barrier.json')) fail('LIFECYCLE_BOOTSTRAP_BARRIER_CHANGED')
  }
  if (scope.dispatch) {
    const transport = await import('../apps/agent/src/ops-upgrade-root-dispatch.ts')
    await transport.assertNativeRootOperatorDispatchHeld(scope.dispatch)
  }
  if (scope.fileProof && scope.phase !== 'promoted') await assertReadonlyLifecycleIntentFileObservationCurrent(scope.fileProof)
  if (scope.prefixProof) await assertReadonlyIssuedLifecycleAppendPrefixCurrent(scope.prefixProof)
  if (scope.issuedCapture) await assertIssuedLifecycleAuditJournalCurrent(scope.issuedCapture.capability)
  if (scope.stopJournal && scope.phase !== 'promoted') await assertOwnedFile(scope.stopJournal.entry)
}

async function readBootstrapDatabase(reader, scope) {
  await assertReadonlyOperationDatabaseCurrent(reader)
  const origin = getReadonlyOperationDatabaseOrigin(reader)
  if (!originEqual(origin, scope.origin)) fail('LIFECYCLE_BOOTSTRAP_DATABASE_CHANGED')
  const rows = await reader.query("SELECT id,username,kind,disabled,force_password_change FROM principals WHERE kind='root' AND disabled=0 ORDER BY created_at,id LIMIT 2")
  const principal = rows[0]
  if (rows.length !== 1 || principal.kind !== 'root' || principal.disabled !== 0 || principal.force_password_change !== 0
    || typeof principal.username !== 'string' || !/^[a-f0-9-]{36}$/.test(principal.id)) fail('LIFECYCLE_BOOTSTRAP_ROOT_REQUIRED')
  const proof = { origin: { ...origin }, principal: { id: principal.id, username: principal.username, kind: 'root' }, originalIntentReceipt: null, pendingIntentReceipt: null }
  if (!scope.recovery) {
    if (scope.head.value.phase !== 'retired' || !scope.head.value.reference) fail('LIFECYCLE_ACTIVE_FINALIZATION_REQUIRED')
    const completed = await getDurableJob(reader, scope.head.value.operationId), completedBinding = completed?.detail?.lifecycleIntent
    if (!completedBinding || completedBinding.jobId !== scope.head.value.operationId || completedBinding.requestFingerprint !== scope.head.value.requestFingerprint
      || completedBinding.principalId !== principal.id || completedBinding.action !== 'lifecycle.' + scope.head.value.kind
      || completed.referenceCode !== scope.head.value.reference) fail('LIFECYCLE_COMPLETED_HEAD_JOB_CHANGED')
    await withReadonlyLifecycleIntentObservation(reader, completedBinding, async observation => { await observation.assertCurrent() })
  }
  if (scope.recovery) {
    const recovery = scope.recovery, binding = recovery.capture.intent.binding.intentBinding
    if (principal.id !== binding.principalId) fail('LIFECYCLE_RECOVERY_PRINCIPAL_CHANGED')
    const original = await getDurableJob(reader, binding.jobId), pending = await getDurableJob(reader, recovery.pendingOperationId)
    if (!original || original.kind !== binding.action || original.referenceCode !== recovery.capture.intent.reference
      || JSON.stringify(original.detail?.lifecycleIntent) !== JSON.stringify(binding)) fail('LIFECYCLE_RECOVERY_JOB_CHANGED')
    const pendingBinding = pending?.detail?.lifecycleIntent
    if (!pendingBinding || pendingBinding.jobId !== recovery.pendingOperationId || pendingBinding.requestFingerprint !== recovery.pendingFingerprint
      || pendingBinding.principalId !== principal.id || pendingBinding.action !== 'lifecycle.' + recovery.barrier.value.kind) fail('LIFECYCLE_RECOVERY_HEAD_JOB_CHANGED')
    proof.originalIntentReceipt = await withReadonlyLifecycleIntentObservation(reader, binding, async observation => { await observation.assertCurrent(); return observation.receipt })
    proof.pendingIntentReceipt = await withReadonlyLifecycleIntentObservation(reader, pendingBinding, async observation => { await observation.assertCurrent(); return observation.receipt })
    proof.pendingBinding = pendingBinding
    if (scope.issuedCapture) {
      const issued = scope.issuedCapture.journal.intentBinding
      proof.issuedIntent = await withReadonlyLifecycleIntentObservation(reader, issued, async observation => {
        await observation.assertCurrent()
        return { binding: issued, receipt: observation.receipt, verified: observation.verified }
      })
    }
  }
  await assertReadonlyOperationDatabaseCurrent(reader)
  return proof
}

async function withBootstrapScope(operation, dispatch, callback) {
  if (!['upgrade', 'recover'].includes(operation) || bootstrapStorage.getStore()) fail('LIFECYCLE_BOOTSTRAP_SCOPE_CONFLICT')
  const processPin = await processIdentity()
  return withVerifiedCoordinatorOwnership(async coordinator => {
    const anchorPath = '/var/lib/xpanel-agent/operation-audit/operation-audit-authority.json'
    const anchor = await withTrustedFile(anchorPath, { exactMode: 0o600, maxBytes: 16384 }, async pin => ({ bytes: Buffer.from(pin.bytes), sha256: pin.sha256 }))
    anchor.verify = () => withTrustedFile(anchorPath, { exactMode: 0o600, maxBytes: 16384, sha256: anchor.sha256 }, async () => {})
    const origin = JSON.parse(anchor.bytes).origin
    if (origin?.file !== DATABASE || !/^[0-9]+$/.test(origin.device) || !/^[0-9]+$/.test(origin.inode) || !/^[a-f0-9-]{36}$/.test(origin.issuerId)) fail('LIFECYCLE_PROTECTED_DATABASE_ORIGIN_CHANGED')
    const recovery = operation === 'recover' ? await nativeRecoveryCapture() : null
    const installed = recovery ? null : await readInstallationReceipt()
    const head = recovery?.head ?? await readHead(), receipt = recovery?.capture.provisionalReceipt ?? installed.receipt
    if (receipt.status !== 'active' || head.value.issuerId !== origin.issuerId || !recovery && !['idle', 'retired'].includes(head.value.phase)) fail('LIFECYCLE_BOOTSTRAP_RETAINED_ATTENTION')
    const images = recovery ? [recovery.capture.journalEntry, ...recovery.capture.images]
      : await Promise.all([ROOT + '/installation.json', ROOT + '/bootstrap.json', ROOT + '/install-dependencies.json', '/opt/xpanel/current'].map(async path => (await captureManagedFile(path)).entry))
    if (!recovery) images.push(...receipt.files)
    return withSelectedIssuedLifecycleAuditJournal(head.hash, coordinatorOwnershipInfo(coordinator).helper.archiveSha256, async issuedCapability => {
    let issuedCapture = null
    if (issuedCapability) {
      const observed = issuedLifecycleAuditJournalInfo(issuedCapability), journal = observed.journal
      normalizeIssuedLifecycleAppendPlan(journal.plan)
      if (!recovery || !originEqual(journal.origin, origin) || journal.fence.sha256 !== recovery.barrier.hash
        || journal.coordinatorReceiptSha256 !== coordinatorOwnershipInfo(coordinator).receiptSha256
        || journal.baseline.sha256 !== recovery.capture.journalEntry.sha256 || journal.baseline.path !== recovery.capture.journalEntry.path
        || journal.accountLifetimeSha256 !== recovery.capture.intent.binding.accountLifetimeSha256) fail('LIFECYCLE_ISSUED_AUDIT_RETAINED_BINDING_CHANGED')
      for (const entry of journal.sourceImages) {
        await assertOwnedFile(entry)
        if (!images.some(existing => existing.path === entry.path)) images.push(entry)
      }
      issuedCapture = { ...observed, capability: issuedCapability }
      recovery.auditOnlyPreHead = journal.intentBinding.action === 'lifecycle.upgrade' && journal.parentBarrier === null
    }
    const databasePin = await open(DATABASE, constants.O_RDONLY | constants.O_NOFOLLOW)
    const capability = Object.freeze({}), scope = { live: true, phase: 'preflight', operation, dispatch, processPin, coordinator, anchor, origin, head, receipt, recovery,
      databasePin, capability, images, issuedCapture, prefixProof: null, pendingDbProof: null,
      fileProof: null, dbProof: null, dbHandle: null, stopCapture: null, closedPin: null, closed: false, controller: new AbortController() }
    bootstrapScopes.set(capability, scope)
    visibleBootstrap = scope
    try { return await bootstrapStorage.run(scope, async () => { await assertLifecycleBootstrapHeld(capability); return callback(scope) }) }
    finally { scope.live = false; if (visibleBootstrap === scope) visibleBootstrap = null; scope.controller.abort(); bootstrapScopes.delete(capability); await databasePin.close() }
    })
  })
}

async function withBootstrapWriter(scope, callback) {
  const admission = await import('./lifecycle-admission.mjs')
  await admission.assertLifecycleBootstrapExclusivePhysicalHeld(scope.capability)
  await assertLifecycleBootstrapHeld(scope.capability)
  if (!scope.dbProof || scope.phase !== 'admitted') fail('LIFECYCLE_DATABASE_ADMISSION_REQUIRED')
  if (scope.readerMode === 'closed') {
    const assertDrained = async () => {
      await assertBootstrapStopAuthority(scope)
      scope.stopCapture = await assertOwnedControlPlaneQuiescent(scope.receipt, scope.stopCapture, scope.capability)
    }
    // Recheck the observed main image and sidecar absence immediately before the first authorized RW open.
    await withClosedDatabasePins(scope.origin, assertDrained, async pins => {
      const current = await scope.databasePin.stat({ bigint: true })
      if (!same(current, scope.closedDatabaseStamp) || current.uid !== scope.closedDatabaseStamp.uid
        || current.gid !== scope.closedDatabaseStamp.gid || current.mode !== scope.closedDatabaseStamp.mode) fail('LIFECYCLE_CLOSED_DATABASE_IMAGE_CHANGED')
      await pins.assertCurrent()
    })
  }
  // All read-only SQLite/audit scopes have ended. EX and the native DB/source descriptors remain held.
  // This signed helper reads the host database before its own migrate phase applies this build's migrations.
  const handle = createDb(DATABASE, { durability: 'strict', migrations: 'pre-migration' })
  scope.dbHandle = handle; scope.phase = 'writable'
  try {
    const actual = await handle.db.transaction(tx => getStrictOperationDatabaseOrigin(tx))
    if (!originEqual(actual, scope.origin)) fail('LIFECYCLE_BOOTSTRAP_DATABASE_CHANGED')
    return await callback(Object.freeze({ db: handle.db, principal: scope.dbProof.principal }))
  } finally { try { await handle.close() } finally { scope.dbHandle = null } }
}

/** Normal coordinator admission: real readonly preflight, then EX, re-observation, then the first RW open. */
export async function withNativeLifecycleDatabaseAdmission(operation, callback, dispatch) {
  const existing = bootstrapStorage.getStore()
  if (existing) {
    if (!existing.live || !['writable', 'promoted'].includes(existing.phase) || existing.operation !== operation || !existing.dbHandle) fail('LIFECYCLE_BOOTSTRAP_SCOPE_CONFLICT')
    const admission = await import('./lifecycle-admission.mjs')
    await admission.assertLifecycleBootstrapExclusivePhysicalHeld(existing.capability)
    return callback(Object.freeze({ db: existing.dbHandle.db, principal: existing.dbProof.principal }))
  }
  if (operation !== 'upgrade') fail('LIFECYCLE_ROOT_RECOVERY_DISPATCH_REQUIRED')
  if (dispatch) {
    const transport = await import('../apps/agent/src/ops-upgrade-root-dispatch.ts')
    await transport.assertNativeRootOperatorDispatchHeld(dispatch)
    if (transport.getNativeRootOperatorDispatchInfo(dispatch).request.kind !== operation) fail('LIFECYCLE_ROOT_DISPATCH_OPERATION_CHANGED')
  }
  await assertNativeLifecyclePrerequisites()
  return withBootstrapScope(operation, dispatch ?? null, async scope => {
    const verifyInstalledSource = async () => {
      for (const entry of scope.images) await assertOwnedFile(entry)
      const source = scope.receipt.source
      const dependency = await withTrustedFile(ROOT + '/install-dependencies.json', { exactMode: 0o600, maxBytes: 16384, sha256: source.dependencyReceiptSha256 }, async file => JSON.parse(file.bytes))
      if (dependency.root !== '/opt/xpanel/releases/' + source.version || dependency.archiveSha256 !== source.archiveSha256
        || dependency.manifestSha256 !== source.manifestSha256 || (await observeInstalledReleaseTree(dependency.root)).treeSha256 !== dependency.tree?.treeSha256) fail('LIFECYCLE_BOOTSTRAP_SOURCE_CHANGED')
      await withTrustedFile(dependency.root + '/release-manifest.json', { maxBytes: 16 * 1024 * 1024, sha256: source.manifestSha256 }, async () => {})
    }
    await verifyInstalledSource()
    const preflight = await withReadonlyOperationDatabase(DATABASE, reader => readBootstrapDatabase(reader, scope), 'pre-migration')
    const admission = await import('./lifecycle-admission.mjs')
    return admission.withLifecycleBootstrapExclusiveAdmission(scope.capability, async () => {
      scope.phase = 'exclusive'
      await verifyInstalledSource()
      scope.dbProof = await withReadonlyOperationDatabase(DATABASE, reader => readBootstrapDatabase(reader, scope), 'pre-migration')
      if (JSON.stringify(preflight.principal) !== JSON.stringify(scope.dbProof.principal)) fail('LIFECYCLE_BOOTSTRAP_PRINCIPAL_CHANGED')
      scope.phase = 'admitted'
      return withBootstrapWriter(scope, callback)
    })
  })
}

export async function assertLifecycleBootstrapPromotion(initial, capability) {
  const admitted = initial && typeof initial === 'object' ? bootstrapScopes.get(initial) : undefined
  if (admitted?.live && admitted === visibleBootstrap && bootstrapStorage.getStore() !== admitted) return bootstrapStorage.run(admitted, () => assertLifecycleBootstrapPromotion(initial, capability))
  const scope = bootstrap(initial), operation = capabilities.get(capability)
  if (scope.phase !== 'writable' || !operation || operation.db !== scope.dbHandle?.db || operation.operation !== scope.operation
    || !originEqual(operation.origin, scope.origin)) fail('LIFECYCLE_BOOTSTRAP_PROMOTION_REFUSED')
  await assertLifecycleBootstrapHeld(initial)
  const admission = await import('./lifecycle-admission.mjs')
  await admission.assertLifecycleBootstrapExclusivePhysicalHeld(initial)
  scope.phase = 'promoted'
}

/** This capability admits observation only. The callback cannot mint a DB writer by copying it. */
export function getNativeClosedDatabaseObservationInfo(capability) {
  const scope = bootstrap(capability)
  if (!scope.closed || scope.phase !== 'observing' || !scope.closedPin) fail('LIFECYCLE_CLOSED_DATABASE_CAPABILITY_REQUIRED')
  return Object.freeze({ database: Object.freeze({ ...scope.origin }), operationId: scope.stopRequest.operationId,
    reference: scope.recovery.capture.intent.reference, purpose: 'closed-database-observation' })
}
export async function assertNativeClosedDatabaseObservationHeld(capability) {
  const scope = bootstrap(capability)
  getNativeClosedDatabaseObservationInfo(capability)
  await assertLifecycleBootstrapHeld(capability)
  await scope.closedPin.assertCurrent()
}

async function assertBootstrapStopAuthority(scope) {
  if (!scope.dispatch || scope.operation !== 'recover' || !(scope.fileProof || scope.prefixProof || scope.pendingDbProof || scope.dbProof) || !scope.stopJournal
    || !['exclusive', 'stopping', 'observing', 'admitted', 'repair-admitted', 'repairing'].includes(scope.phase)) fail('LIFECYCLE_STOP_ONLY_AUTHORITY_REQUIRED')
  await assertLifecycleBootstrapHeld(scope.capability)
  const admission = await import('./lifecycle-admission.mjs')
  await admission.assertLifecycleBootstrapExclusivePhysicalHeld(scope.capability)
}

async function recoveryReaderMode() {
  const present = []
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { await lstat(DATABASE + suffix); present.push(suffix) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (present.length === 0) return 'closed'
  if (present.join(',') === '-wal,-shm') return 'live'
  fail('LIFECYCLE_DATABASE_SIDECARS_AMBIGUOUS')
}

async function withRetainedRecoveryAudit(scope, work, issued = false) {
  if (issued) {
    return withReadonlyIssuedLifecycleAppendPrefixObservation(scope.issuedCapture.journal.plan, async proof => {
      scope.prefixProof = proof
      try {
        const journal = scope.issuedCapture.journal, head = scope.head.value
        // The actual retained HEAD must already exist in the complete PRIOR prefix.
        // The newly issued, possibly incomplete event never serves as this prior authority.
        assertReadonlyIssuedLifecycleAppendRetainedIntent(proof, { purpose: 'host.lifecycle.intent', jobId: head.operationId,
          requestFingerprint: head.requestFingerprint, action: 'lifecycle.' + head.kind, principalId: journal.intentBinding.principalId })
        const original = scope.recovery.capture.intent.binding.intentBinding
        if (JSON.stringify(original) !== JSON.stringify(journal.intentBinding)) assertReadonlyIssuedLifecycleAppendRetainedIntent(proof, original)
        await proof.assertCurrent()
        return await work()
      } finally { scope.prefixProof = null }
    })
  }
  return withReadonlyLifecycleIntentFileObservation(scope.recovery.capture.intent.binding.intentBinding, scope.origin, async proof => {
    scope.fileProof = proof
    try { return await work() } finally { scope.fileProof = null }
  })
}

async function readIssuedBootstrapDatabase(reader, scope) {
  return withReadonlyIssuedLifecycleAppendDatabaseObservation(reader, scope.prefixProof, async proof => {
    await proof.assertCurrent()
    const journal = scope.issuedCapture.journal
    if (!originEqual(getReadonlyOperationDatabaseOrigin(reader), scope.origin)) fail('LIFECYCLE_ISSUED_DATABASE_CHANGED')
    const rows = await reader.query("SELECT id,username,kind,disabled,force_password_change FROM principals WHERE kind='root' AND disabled=0 ORDER BY created_at,id LIMIT 2")
    const root = rows[0]
    if (rows.length !== 1 || root.id !== journal.intentBinding.principalId || root.username !== journal.plan.actor
      || root.force_password_change !== 0) fail('LIFECYCLE_ISSUED_ROOT_CHANGED')
    const original = scope.recovery.capture.intent.binding.intentBinding
    for (const binding of [original, journal.intentBinding]) {
      const job = await getDurableJob(reader, binding.jobId)
      if (!job || job.kind !== binding.action || job.actor !== root.username
        || JSON.stringify(job.detail?.lifecycleIntent) !== JSON.stringify(binding)) fail('LIFECYCLE_ISSUED_JOB_CHANGED')
    }
    await proof.assertCurrent()
    return Object.freeze({ origin: { ...scope.origin }, principal: { id: root.id, username: root.username, kind: 'root' }, journalSha256: scope.issuedCapture.sha256 })
  })
}

async function assertRecoveryDrained(scope) {
  await assertBootstrapStopAuthority(scope)
  scope.stopCapture = await assertOwnedControlPlaneQuiescent(scope.receipt, scope.stopCapture, scope.capability)
}

/** Reusable observation only; each invocation closes HTTP, SQLite, audit and worker pins before returning. */
async function observeClosedRecoveryDatabase(scope, dispatch, observeHosted, issued) {
  const admission = await import('./lifecycle-admission.mjs'), mode = await recoveryReaderMode()
  scope.readerMode = mode; scope.phase = 'observing'
  const observe = async () => {
    const readerStorage = new AsyncLocalStorage()
    const withReader = work => {
      const held = readerStorage.getStore()
      if (held) return work(held)
      const observeReader = reader => readerStorage.run(reader, () => work(reader))
      return mode === 'closed' ? withReadonlyClosedOperationDatabase(scope.capability, observeReader, 'pre-migration') : withReadonlyOperationDatabase(DATABASE, observeReader, 'pre-migration')
    }
    const assertCurrent = async () => {
      await assertRecoveryDrained(scope)
      if (mode !== await recoveryReaderMode()) fail('LIFECYCLE_DATABASE_READER_MODE_CHANGED')
      if (scope.closedPin) await scope.closedPin.assertCurrent()
    }
    const observed = async () => {
      await assertCurrent()
      const source = await observeRecoveryGenerationSource(scope, withReader)
      if (scope.generationProof && JSON.stringify(scope.generationProof) !== JSON.stringify(source.proof)) fail('LIFECYCLE_RECOVERY_GENERATION_SOURCE_CHANGED')
      scope.generationProof = source.proof
      await assertCurrent()
      return Object.freeze({ generation: source.generation, snapshot: structuredClone(source.source), sourceChecksum: source.source.checksum })
    }
    const view = Object.freeze({ assertCurrent, signal: scope.controller.signal,
      withReadonlyDatabase: async work => { await assertCurrent(); const result = await withReader(work); await assertCurrent(); return result }, activeGenerationSource: observed })
    closedRecoveryViews.set(view, { scope, assertCurrent })
    const hosted = await import('../apps/agent/src/ops-upgrade-hosted-qualification.ts')
    let qualification
    try {
      qualification = await observeHosted(view)
      await hosted.assertNativeHostedUidQualificationCurrent(qualification, dispatch)
      await assertCurrent(); await observed()
      if (issued) scope.pendingDbProof = await withReader(reader => readIssuedBootstrapDatabase(reader, scope))
      else scope.dbProof = await withReader(reader => readBootstrapDatabase(reader, scope))
      await assertCurrent()
      await hosted.consumeNativeHostedUidQualification(qualification, dispatch)
    } finally {
      closedRecoveryViews.delete(view)
      if (qualification) await hosted.retireNativeHostedUidQualification(qualification)
    }
  }
  if (mode === 'closed') {
    await withClosedDatabasePins(scope.origin, () => assertRecoveryDrained(scope), async pins => {
      scope.closedPin = pins; scope.closed = true
      scope.closedDatabaseStamp = await scope.databasePin.stat({ bigint: true })
      await admission.bindLifecycleClosedDatabaseObservation(scope.capability)
      try { await observe() }
      finally { await admission.retireLifecycleClosedDatabaseObservation(scope.capability); scope.closed = false; scope.closedPin = null }
    })
  } else await observe()
}

function issuedRepair(capability) {
  const repair = capability && typeof capability === 'object' ? auditRepairs.get(capability) : undefined
  if (!repair?.live || auditRepairStorage.getStore() !== repair || repair.scope.phase !== 'repairing') fail('LIFECYCLE_ISSUED_AUDIT_REPAIR_REQUIRED')
  return repair
}
export function getLifecycleIssuedAuditRepairInfo(capability) {
  const repair = issuedRepair(capability)
  return Object.freeze({ purpose: 'issued-lifecycle-audit-repair', plan: structuredClone(repair.scope.issuedCapture.journal.plan) })
}
/** No SQLite or prefix observer here: exact-prefix mutation is revalidated by the audit sink under its existing mutex. */
export async function assertLifecycleIssuedAuditRepairHeld(capability) {
  const repair = issuedRepair(capability), scope = repair.scope
  if (!scope.pendingDbProof || scope.pendingDbProof.journalSha256 !== scope.issuedCapture.sha256 || scope.prefixProof || scope.fileProof || scope.closedPin
    || !originEqual(scope.pendingDbProof.origin, scope.origin)) fail('LIFECYCLE_ISSUED_AUDIT_REPAIR_PROOF_REQUIRED')
  await assertRecoveryDrained(scope)
  await assertIssuedLifecycleAuditJournalCurrent(scope.issuedCapture.capability)
  for (const entry of scope.issuedCapture.journal.sourceImages) await assertOwnedFile(entry)
}

async function repairIssuedAudit(scope) {
  if (scope.phase !== 'repair-admitted' || !scope.pendingDbProof) fail('LIFECYCLE_ISSUED_AUDIT_REPAIR_PROOF_REQUIRED')
  await assertRecoveryDrained(scope)
  if (scope.readerMode === 'closed') await withClosedDatabasePins(scope.origin, () => assertRecoveryDrained(scope), async pins => {
    const current = await scope.databasePin.stat({ bigint: true })
    if (!same(current, scope.closedDatabaseStamp) || current.uid !== scope.closedDatabaseStamp.uid
      || current.gid !== scope.closedDatabaseStamp.gid || current.mode !== scope.closedDatabaseStamp.mode) fail('LIFECYCLE_CLOSED_DATABASE_IMAGE_CHANGED')
    await pins.assertCurrent()
  })
  const capability = Object.freeze({}), repair = { live: true, scope }
  auditRepairs.set(capability, repair); scope.phase = 'repairing'
  try { await auditRepairStorage.run(repair, async () => {
    // The full readonly prior-index/job/root proof, EX, native source and stop-only admission already hold.
    // This connection is confined to the issued audit repair; no general lifecycle writer is exposed.
    await assertLifecycleIssuedAuditRepairHeld(capability)
    const handle = createDb(DATABASE, { durability: 'strict', migrations: 'pre-migration' })
    try {
      const actual = await handle.db.transaction(tx => getStrictOperationDatabaseOrigin(tx))
      if (!originEqual(actual, scope.origin)) fail('LIFECYCLE_ISSUED_DATABASE_CHANGED')
      const authority = await createRootOperationAuditAuthority(handle.db)
      const verified = await authority.repairIssuedLifecycleIntent(capability)
      const record = scope.issuedCapture.journal.plan.record
      if (['eventUid', 'entryHash', 'seq'].some(key => verified[key] !== record[key])) fail('LIFECYCLE_ISSUED_REPAIR_RESULT_CHANGED')
      // Deliberately discard this plain result: the ordinary observer must issue the actual receipt later.
    } finally { await handle.close() }
  }) } finally { repair.live = false; auditRepairs.delete(capability) }
  const anchorPath = '/var/lib/xpanel-agent/operation-audit/operation-audit-authority.json'
  scope.anchor = await withTrustedFile(anchorPath, { exactMode: 0o600, maxBytes: 16384 }, async pin => ({ sha256: pin.sha256 }))
  scope.anchor.verify = () => withTrustedFile(anchorPath, { exactMode: 0o600, maxBytes: 16384, sha256: scope.anchor.sha256 }, async () => {})
  scope.phase = 'observing'
}

/** Explicit root operator recovery authorizes only journaled stop/drain before full DB admission. */
export async function withNativeClosedDatabaseRecoveryAdmission(dispatch, observeHosted, execute) {
  const transport = await import('../apps/agent/src/ops-upgrade-root-dispatch.ts')
  await transport.assertNativeRootOperatorDispatchHeld(dispatch)
  const dispatched = transport.getNativeRootOperatorDispatchInfo(dispatch), request = dispatched.request
  if (request.kind !== 'recover' || request.phase !== 'apply' || typeof observeHosted !== 'function' || typeof execute !== 'function') fail('LIFECYCLE_ROOT_RECOVERY_DISPATCH_REQUIRED')
  return withBootstrapScope('recover', dispatch, async scope => {
    const owned = coordinatorOwnershipInfo(scope.coordinator)
    if (request.expectedArchiveSha256 !== owned.helper.archiveSha256 || dispatched.coordinatorReceiptSha256 !== owned.receiptSha256) fail('LIFECYCLE_ROOT_RECOVERY_SOURCE_CHANGED')
    scope.stopRequest = request
    const binding = scope.recovery.capture.intent.binding.intentBinding
    if (!originEqual(scope.origin, scope.recovery.capture.intent.binding.origin)) fail('LIFECYCLE_RECOVERY_ORIGIN_CHANGED')
    const admission = await import('./lifecycle-admission.mjs')
    return admission.withLifecycleBootstrapExclusiveAdmission(scope.capability, async () => {
      scope.phase = 'exclusive'
      await withRetainedRecoveryAudit(scope, async () => {
        await assertLifecycleBootstrapHeld(scope.capability)
        const directory = ROOT + '/recovery-stops', path = directory + '/' + request.operationId + '.json'
        const claimAuthority = async () => { await assertLifecycleBootstrapHeld(scope.capability); await admission.assertLifecycleBootstrapExclusivePhysicalHeld(scope.capability) }
        await ensureManagedPrivateDirectory(directory, claimAuthority)
        scope.stopJournal = await replaceManagedFile(path, Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'xpanel-root-recovery-stop',
          operationId: request.operationId, purpose: 'xpanel-root-lifecycle-operator-v1', origin: scope.origin,
          requestFingerprint: sha(JSON.stringify(request)), coordinatorReceiptSha256: owned.receiptSha256, helper: owned.helper,
          headSha256: scope.head.hash, barrierSha256: scope.recovery.barrier.hash, transitionOperationId: scope.recovery.capture.operationId,
          transitionJournalSha256: scope.recovery.capture.journalEntry.sha256, intentBinding: binding,
          issuedAuditJournalSha256: scope.issuedCapture?.sha256 ?? null, phase: 'claimed', createdAt: new Date().toISOString() }) + '\n'), 0o600, null, claimAuthority)
        scope.phase = 'stopping'
        scope.stopCapture = await stopAndDrainOwnedControlPlaneUnits(scope.receipt, scope.capability)
        await assertRecoveryDrained(scope)
        const failedUnits = [...new Set(projectOwnedControlPlaneObservation(scope.stopCapture).observations.flatMap(item => item.units).filter(unit => unit.ActiveState === 'failed').map(unit => unit.Id))]
        // After the rename the journal has a new inode: bind the authority check to the read-back replacement.
        scope.stopJournal = await replaceManagedFile(path, Buffer.from(JSON.stringify({ ...JSON.parse(scope.stopJournal.bytes), phase: 'quiescent', failedUnits }) + '\n'),
          0o600, scope.stopJournal.entry, async replaced => { if (replaced) scope.stopJournal = replaced; await assertBootstrapStopAuthority(scope) })
        const initialFile = await captureManagedFile(`${ROOT}/admission-${scope.recovery.capture.operationId}.json`), initial = JSON.parse(initialFile.bytes)
        if (initialFile.entry.mode !== 0o600 || initial.operationId !== scope.recovery.capture.operationId || initial.kind !== 'xpanel-initial-upgrade-admission'
          || !SHA.test(initial.desiredState?.checksum) || initial.binding?.accountLifetimeSha256 !== scope.recovery.capture.intent.binding.accountLifetimeSha256
          || JSON.stringify(initial.binding?.intentBinding) !== JSON.stringify(binding)) fail('LIFECYCLE_RECOVERY_GENERATION_BASELINE_INVALID')
        scope.admission = { entry: initialFile.entry, value: initial }; scope.images.push(initialFile.entry)
        await observeClosedRecoveryDatabase(scope, dispatch, observeHosted, Boolean(scope.issuedCapture))
        scope.phase = scope.issuedCapture ? 'repair-admitted' : 'admitted'
      }, Boolean(scope.issuedCapture))
      // Prefix/file proofs and every readonly DB/HTTP/process observer have retired; the SAME physical EX remains held.
      if (scope.issuedCapture) {
        await repairIssuedAudit(scope)
        await withRetainedRecoveryAudit(scope, () => observeClosedRecoveryDatabase(scope, dispatch, observeHosted, false))
        const issued = scope.dbProof.issuedIntent
        scope.issuedCompletion = { jobId: issued.binding.jobId, journalSha256: scope.issuedCapture.sha256,
          binding: issued.binding, origin: scope.origin, verified: issued.verified }
        // The ordinary full observer has closed. Only its opaque receipt permits completion acknowledgement and fresh admission.
        await writeIssuedLifecycleAuditCompletion(scope.capability)
        scope.phase = 'admitted'
      }
      await assertRecoveryDrained(scope)
      await assertLifecycleBootstrapHeld(scope.capability)
      return withBootstrapWriter(scope, execute)
    })
  })
}

export async function assertNativeClosedDatabaseRecoveryScopeHeld(view) {
  const held = view && typeof view === 'object' ? closedRecoveryViews.get(view) : undefined
  if (!held || !held.scope.live || bootstrapStorage.getStore() !== held.scope || held.scope.phase !== 'observing') fail('LIFECYCLE_CLOSED_RECOVERY_VIEW_REQUIRED')
  await held.assertCurrent()
}

async function accountLifetimeHash() {
  return new StateStore('/var/lib/xpanel/state').withReadonlyObservation(async observation => {
    await observation.assertCurrent()
    const lifetimes = observation.snapshot.accounts.map(account => Object.fromEntries(['id', 'username', 'uid', 'gid', 'home', 'createdAt', 'primaryDomain', 'ownerId', 'planId'].map(key => [key, account[key]]))).sort((a, b) => a.id.localeCompare(b.id))
    const value = sha(JSON.stringify(lifetimes)); await observation.assertCurrent(); return value
  })
}
const lifetimeDigest = accounts => sha(JSON.stringify(accounts.map(account => Object.fromEntries(['id', 'username', 'uid', 'gid', 'home', 'createdAt', 'primaryDomain', 'ownerId', 'planId'].map(key => [key, account[key]]))).sort((a, b) => a.id.localeCompare(b.id))))

async function observeRecoveryGenerationSource(scope, withReader = work => withReadonlyOperationDatabase(DATABASE, work, 'pre-migration')) {
  return withReader(async reader => {
    const rows = await reader.query("SELECT id,status,checksum FROM config_generations WHERE status='active' ORDER BY id")
    const generation = rows[0]
    if (rows.length !== 1 || !Number.isSafeInteger(generation?.id) || generation.id < 1 || generation.status !== 'active' || !SHA.test(generation.checksum)) fail('LIFECYCLE_RECOVERY_ACTIVE_GENERATION_REQUIRED')
    const store = new StateStore('/var/lib/xpanel/state'), journal = new ReconcilerJournal('/var/lib/xpanel/state')
    const source = await store.readValidatedGenerationSnapshot(generation.id), manifest = await journal.readManifest(generation.id)
    if (!generationSourceIsLinked(generation, source, manifest) || source.checksum !== scope.admission.value.desiredState.checksum
      || lifetimeDigest(source.accounts) !== scope.recovery.capture.intent.binding.accountLifetimeSha256) fail('LIFECYCLE_RECOVERY_GENERATION_SOURCE_UNBOUND')
    const after = await reader.query("SELECT id,status,checksum FROM config_generations WHERE status='active' ORDER BY id")
    if (JSON.stringify(rows) !== JSON.stringify(after)) fail('LIFECYCLE_RECOVERY_ACTIVE_GENERATION_CHANGED')
    return { generation, source, proof: { generationId: generation.id, filesChecksum: generation.checksum, sourceChecksum: source.checksum,
      sourceDigest: sha(JSON.stringify(source)), manifestDigest: sha(JSON.stringify(manifest)) } }
  })
}

async function desiredStateIdentity() {
  return new StateStore('/var/lib/xpanel/state').withReadonlyObservation(async observation => {
    await observation.assertCurrent()
    const value = { revision: observation.snapshot.revision, checksum: observation.snapshot.checksum }
    await observation.assertCurrent(); return value
  })
}

async function initialInstallationValue(scope) {
  await withVisiblePreparedRelease(scope.options.preparedRelease, () => assertPreparedReleaseCurrent(scope.options.preparedRelease))
  const installed = await readInstallationReceipt(), entries = []
  for (const path of [ROOT + '/installation.json', ROOT + '/bootstrap.json', ROOT + '/install-dependencies.json', '/opt/xpanel/current']) entries.push((await captureManagedFile(path)).entry)
  for (const file of installed.receipt.files) { await assertOwnedFile(file); entries.push(file) }
  const capture = await observeOwnedControlPlaneUnits(installed.receipt, scope.capability)
  const restoreTimer = projectOwnedControlPlaneObservation(capture).observations.at(-1).units.some(unit => unit.Id === 'xpanel-management-tls.timer' && unit.ActiveState === 'active')
  const value = { schemaVersion: 1, kind: 'xpanel-initial-upgrade-admission', operationId: scope.job.id, reference: scope.job.referenceCode,
    parentHeadSha256: scope.previousHead.hash,
    parentHead: { value: scope.previousHead.value, sha256: scope.previousHead.hash, bytes: scope.previousHead.bytes },
    binding: { recordId: scope.job.id, origin: scope.origin, intentBinding: scope.intentBinding, backup: null, accountLifetimeSha256: await accountLifetimeHash() },
    receipt: installed.receipt, receiptSha256: installed.sha256, entries, target: structuredClone(preparedReleaseInfo(scope.options.preparedRelease)),
    desiredState: await desiredStateIdentity(), schema: await currentSchemaVersion(scope.db), restoreTimer, createdAt: new Date().toISOString() }
  return value
}

async function persistInitialInstallationBeforeAudit(initial, guard, job, intentBinding, options, head) {
  const assertIssuance = async () => {
    await assertLifecycleBootstrapHeld(initial.capability)
    const admission = await import('./lifecycle-admission.mjs')
    await admission.assertLifecycleBootstrapExclusivePhysicalHeld(initial.capability)
    await assertHostOperationGuardHeld(guard, bindingFor(initial.origin))
    const found = await getDurableJob(initial.dbHandle.db, job.id)
    if (initial.phase !== 'writable' || found?.kind !== intentBinding.action || found.actor !== initial.dbProof.principal.username
      || JSON.stringify(found.detail?.lifecycleIntent) !== JSON.stringify(intentBinding)) fail('LIFECYCLE_AUDIT_ISSUANCE_JOB_CHANGED')
  }
  await assertIssuance()
  initial.plannedJob = job
  const value = await initialInstallationValue({ capability: initial.capability, options, job, previousHead: head,
    origin: initial.origin, intentBinding, db: initial.dbHandle.db })
  initial.plannedInstallation = await replaceManagedFile(`${ROOT}/admission-${job.id}.json`, Buffer.from(JSON.stringify(value) + '\n'), 0o600, null, assertIssuance)
  // Denial only, compatible with the installed old admission parser. This is NOT an intent receipt or effect grant.
  // Publish before even acquiring the audit writer mutex: old writers remain fenced if this process dies later.
  const denial = { schemaVersion: 1, operationId: job.id, reference: job.referenceCode, kind: 'upgrade', phase: 'attention',
    requestFingerprint: intentBinding.requestFingerprint, sequence: head.value.sequence + 1, createdAt: new Date().toISOString() }
  const bytes = Buffer.from(JSON.stringify(denial) + '\n')
  initial.fencePublication = { sha256: sha(bytes) }
  try { initial.issuedFence = await replaceManagedFile(ROOT + '/writer-barrier.json', bytes, 0o644, null, assertIssuance) }
  finally { initial.fencePublication = null }
  await assertOwnedFile(initial.issuedFence.entry)
}

const auditIssuance = capability => {
  const scope = capability && typeof capability === 'object' ? auditIssuances.get(capability) : undefined
  if (!scope?.live || auditIssuanceStorage.getStore() !== scope || scope.phase !== 'issuing') fail('LIFECYCLE_AUDIT_ISSUANCE_REQUIRED')
  return scope
}
export async function assertLifecycleAuditIssuanceHeld(capability, plan) {
  const scope = auditIssuance(capability)
  if (scope.plan !== plan || !plan || JSON.stringify(plan.binding) !== JSON.stringify(scope.context.intentBinding)
    || !originEqual(plan.origin, scope.context.origin) || plan.actor !== scope.initial.dbProof.principal.username) fail('LIFECYCLE_AUDIT_PLAN_CHANGED')
  await assertLifecycleBootstrapHeld(scope.initial.capability)
  const admission = await import('./lifecycle-admission.mjs')
  await admission.assertLifecycleBootstrapExclusivePhysicalHeld(scope.initial.capability)
  await assertHostOperationGuardHeld(scope.guard, bindingFor(scope.context.origin))
  await withTrustedFile(ROOT + '/writer-barrier.json', { exactMode: 0o644, maxBytes: 16384, sha256: scope.context.fence.sha256 }, async () => {})
  for (const entry of scope.context.sourceImages) await assertOwnedFile(entry)
  if ((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() !== scope.context.issuer.bootId) fail('LIFECYCLE_AUDIT_ISSUER_CHANGED')
  const owner = JSON.parse(plan.writer.ownerRaw)
  if (owner.pid !== scope.context.issuer.pid || owner.protocol !== 'sqlite-v1' || owner.mutexIdentity !== plan.writer.mutexIdentity) fail('LIFECYCLE_AUDIT_GUARD_CHANGED')
  const job = await getDurableJob(scope.initial.dbHandle.db, scope.context.job.id)
  if (job?.kind !== scope.context.intentBinding.action || job.referenceCode !== scope.context.job.reference
    || job.actor !== scope.initial.dbProof.principal.username || JSON.stringify(job.detail?.lifecycleIntent) !== JSON.stringify(scope.context.intentBinding)) fail('LIFECYCLE_AUDIT_ISSUANCE_JOB_CHANGED')
}
export function getLifecycleAuditIssuanceInfo(capability) { return structuredClone(auditIssuance(capability).context) }

function auditCompletion(capability) {
  const issuance = capability && typeof capability === 'object' ? auditIssuances.get(capability) : undefined
  if (issuance?.live && auditIssuanceStorage.getStore() === issuance && issuance.completion) return { issuance, value: issuance.completion }
  const scope = bootstrap(capability)
  if (scope.phase !== 'observing' || !scope.issuedCompletion || !scope.dbProof?.issuedIntent) fail('LIFECYCLE_AUDIT_COMPLETION_AUTHORITY_REQUIRED')
  return { scope, value: scope.issuedCompletion }
}
export async function assertLifecycleIssuedAuditCompletionHeld(capability) {
  const completion = auditCompletion(capability)
  if (completion.issuance) await assertLifecycleAuditIssuanceHeld(capability, completion.issuance.plan)
  else { await assertBootstrapStopAuthority(completion.scope); await assertLifecycleBootstrapHeld(capability) }
}
export function getLifecycleIssuedAuditCompletionInfo(capability) { return structuredClone(auditCompletion(capability).value) }

async function appendIssuedNativeIntent(initial, guard, coordinator, job, intentBinding, authority, head) {
  const baseline = initial.operation === 'upgrade' ? initial.plannedInstallation.entry : initial.recovery.capture.journalEntry
  const parentBarrier = initial.recovery ? await withTrustedFile(ROOT + '/writer-barrier.json',
    { exactMode: 0o644, maxBytes: 16384, sha256: initial.recovery.barrier.hash }, async pin => ({ value: JSON.parse(pin.bytes), sha256: pin.sha256, bytes: pin.bytes.toString('utf8') })) : null
  const owner = coordinatorOwnershipInfo(coordinator)
  const context = { job: { id: job.id, reference: job.referenceCode }, origin: initial.origin, intentBinding,
    parentHead: { value: head.value, sha256: head.hash, bytes: head.bytes }, parentBarrier,
    fence: initial.issuedFence ? { value: JSON.parse(initial.issuedFence.bytes), bytes: initial.issuedFence.bytes.toString('utf8'), sha256: initial.issuedFence.entry.sha256 } : parentBarrier,
    baseline: { operationId: initial.operation === 'upgrade' ? job.id : initial.recovery.capture.operationId, path: baseline.path, sha256: baseline.sha256 },
    helper: owner.helper, coordinatorReceiptSha256: owner.receiptSha256,
    issuer: { ...initial.processPin, bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() },
    accountLifetimeSha256: await accountLifetimeHash(), sourceImages: [...new Map([...initial.images, baseline].map(entry => [entry.path, entry])).values()], issuedAt: new Date().toISOString() }
  const capability = Object.freeze({}), scope = { live: true, phase: 'issuing', initial, guard, context, plan: null }
  auditIssuances.set(capability, scope)
  try { return await auditIssuanceStorage.run(scope, async () => {
    const receipt = await authority.appendIssuedLifecycleIntent(intentBinding, async plan => {
      scope.plan = plan
      initial.issuedAudit = await writeIssuedLifecycleAuditJournal(capability, plan)
      await assertLifecycleAuditIssuanceHeld(capability, plan)
    })
    // The append's audit guard has closed. Its opaque receipt, not a JSON status, certifies this acknowledgement.
    const verified = await initial.dbHandle.db.transaction(tx => assertOperationIntentReceipt(receipt, intentBinding, tx))
    scope.completion = { jobId: job.id, journalSha256: initial.issuedAudit.sha256, binding: intentBinding, origin: initial.origin, verified }
    await writeIssuedLifecycleAuditCompletion(capability)
    return receipt
  }) } finally { scope.live = false; scope.phase = 'retired'; auditIssuances.delete(capability) }
}

async function captureInitialInstallation(scope) {
  await assertScope(scope)
  const baseline = await readInitialInstallation(scope.job.id)
  if (JSON.stringify(baseline.intent.binding.intentBinding) !== JSON.stringify(scope.intentBinding)
    || baseline.intent.parentHeadSha256 !== scope.previousHead.hash) fail('LIFECYCLE_INITIAL_ISSUANCE_CHANGED')
  scope.initialAdmission = baseline.intent
}

async function readInitialInstallation(operationId) {
  const path = `${ROOT}/admission-${operationId}.json`, journal = await captureManagedFile(path)
  const value = JSON.parse(journal.bytes)
  if (journal.entry.mode !== 0o600 || value.schemaVersion !== 1 || value.kind !== 'xpanel-initial-upgrade-admission' || value.operationId !== operationId
    || value.binding?.recordId !== operationId || value.binding?.intentBinding?.jobId !== operationId
    || value.binding?.intentBinding?.action !== 'lifecycle.upgrade' || !SHA.test(value.binding?.accountLifetimeSha256)) fail('LIFECYCLE_INITIAL_ADMISSION_INVALID')
  const receipt = parseInstallationReceipt(value.receipt)
  if (typeof value.parentHead?.bytes !== 'string' || Buffer.byteLength(value.parentHead.bytes) > 16384
    || sha(value.parentHead.bytes) !== value.parentHeadSha256 || value.parentHead.sha256 !== value.parentHeadSha256
    || JSON.stringify(parseLifecycleHead(JSON.parse(value.parentHead.bytes))) !== JSON.stringify(value.parentHead.value)) fail('LIFECYCLE_INITIAL_PARENT_HEAD_INVALID')
  if (sha(JSON.stringify(receipt) + '\n') !== value.receiptSha256 || receipt.status !== 'active' || value.schema !== receipt.source.controlDbSchemaVersion
    || value.target?.releaseRoot !== '/opt/xpanel/releases/' + value.target?.version || !SHA.test(value.target?.archiveSha256)) fail('LIFECYCLE_INITIAL_ADMISSION_INVALID')
  const expectedPaths = [ROOT + '/installation.json', ROOT + '/bootstrap.json', ROOT + '/install-dependencies.json', '/opt/xpanel/current', ...receipt.files.map(file => file.path)]
  if (!Array.isArray(value.entries) || value.entries.length !== expectedPaths.length || value.entries.some((file, index) => file.path !== expectedPaths[index])) fail('LIFECYCLE_INITIAL_ADMISSION_INVALID')
  for (const file of value.entries) await assertOwnedFile(file)
  if (value.entries[0].sha256 !== value.receiptSha256 || value.entries[2].sha256 !== receipt.source.dependencyReceiptSha256
    || value.entries[3].target !== '/opt/xpanel/releases/' + receipt.source.version
    || JSON.stringify(await desiredStateIdentity()) !== JSON.stringify(value.desiredState)
    || await accountLifetimeHash() !== value.binding.accountLifetimeSha256) fail('LIFECYCLE_INITIAL_STATE_CHANGED')
  const dependency = await withTrustedFile(ROOT + '/install-dependencies.json', { exactMode: 0o600, maxBytes: 16384, sha256: receipt.source.dependencyReceiptSha256 }, async pin => JSON.parse(pin.bytes))
  if (dependency.root !== value.entries[3].target || dependency.archiveSha256 !== receipt.source.archiveSha256 || dependency.manifestSha256 !== receipt.source.manifestSha256
    || (await observeInstalledReleaseTree(dependency.root)).treeSha256 !== dependency.tree?.treeSha256) fail('LIFECYCLE_INITIAL_SOURCE_CHANGED')
  await withTrustedFile(dependency.root + '/release-manifest.json', { maxBytes: 16 * 1024 * 1024, sha256: receipt.source.manifestSha256 }, async () => {})
  return { operationId, path, journalEntry: journal.entry, intent: { ...value, phase: 'admission', selected: 'previous' }, provisionalReceipt: receipt,
    images: value.entries, artifact: { artifactPath: value.target.artifactPath, expectedArchiveSha256: value.target.archiveSha256 }, recoveryMode: 'abort-before-transition' }
}

async function nativeRecoveryCapture() {
  const head = await readHead()
  const barrier = await withTrustedFile(ROOT + '/writer-barrier.json', { exactMode: 0o644, maxBytes: 16384 }, async pin => ({ value: JSON.parse(pin.bytes), hash: pin.sha256 }))
  if (!['upgrade', 'recover'].includes(barrier.value.kind) || typeof barrier.value.operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(barrier.value.operationId)
    || typeof barrier.value.requestFingerprint !== 'string' || !SHA.test(barrier.value.requestFingerprint)) fail('LIFECYCLE_RECOVERY_BARRIER_INVALID')
  const headMatches = barrier.value.operationId === head.value.operationId && barrier.value.requestFingerprint === head.value.requestFingerprint
  if (headMatches && (!['pending', 'retirement_pending', 'retired'].includes(head.value.phase) || head.value.kind !== barrier.value.kind)) fail('LIFECYCLE_NOTHING_RECOVERABLE')
  let transitionId = barrier.value.operationId
  if (barrier.value.kind === 'recover') {
    const prior = await withTrustedFile(`${ROOT}/recovery-${barrier.value.operationId}.json`, { exactMode: 0o600, maxBytes: 1024 * 1024 }, async pin => JSON.parse(pin.bytes))
    if (prior.kind !== 'xpanel-native-recovery-admission' || prior.operationId !== barrier.value.operationId || prior.requestFingerprint !== barrier.value.requestFingerprint
      || !headMatches && prior.parentHeadSha256 !== head.hash) fail('LIFECYCLE_RECOVERY_CHAIN_INVALID')
    transitionId = prior.transitionOperationId
  }
  let transitionExists = true
  try { await lstat(`${ROOT}/installation-transitions/${transitionId}.json`) }
  catch (error) { if (error.code !== 'ENOENT') throw error; transitionExists = false }
  const capture = transitionExists ? await readInstallationTransitionRecovery(transitionId) : await readInitialInstallation(transitionId)
  if (!headMatches && barrier.value.kind === 'upgrade' && (capture.recoveryMode !== 'abort-before-transition'
    || !['idle', 'retired'].includes(head.value.phase) || capture.intent.parentHeadSha256 !== head.hash
    || capture.intent.binding.intentBinding.requestFingerprint !== barrier.value.requestFingerprint)) fail('LIFECYCLE_RECOVERY_BARRIER_FOREIGN')
  if (headMatches && head.value.phase === 'retired') {
    const terminal = await withTrustedFile(`${ROOT}/terminal/${head.value.operationId}.json`, { exactMode: 0o600, maxBytes: 128 * 1024 }, async pin => JSON.parse(pin.bytes))
    if (terminal.operationId !== head.value.operationId || terminal.requestFingerprint !== head.value.requestFingerprint
      || terminal.installation?.operationId !== transitionId || (capture.intent.phase !== 'published'
        && !(capture.recoveryMode === 'abort-before-transition' && terminal.installation?.noSourceChange === true))) fail('LIFECYCLE_RECOVERY_TERMINAL_CHANGED')
  }
  return { head, capture, barrier, pendingOperationId: barrier.value.operationId, pendingFingerprint: barrier.value.requestFingerprint }
}

export async function assertNativeLifecycleRecoveryPrerequisites() {
  const processPin = await processIdentity()
  return withVerifiedCoordinatorOwnership(async capability => {
    const info = coordinatorOwnershipInfo(capability)
    if (processPin.coordinatorUnit !== info.unit || process.argv[1] !== info.sourcePath) fail('LIFECYCLE_COORDINATOR_SOURCE_REQUIRED')
    await assertFixedCoordinatorMainProcess(processPin, info)
    const recovered = await nativeRecoveryCapture()
    return withExistingPreparedRelease(recovered.capture.artifact, async prepared => {
      await assertPreparedReleaseCurrent(prepared)
      return Object.freeze({ transitionOperationId: recovered.capture.operationId, mode: recovered.capture.recoveryMode })
    })
  })
}

async function assertFixedCoordinatorMainProcess(processPin, info) {
  const shown = await nativeCommand('/usr/bin/systemctl', ['show', info.unit, '--property=MainPID,ControlPID,ControlGroup,FragmentPath,DropInPaths,User'])
  const values = Object.fromEntries(shown.output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
  if (shown.code !== 0 || values.MainPID !== String(process.pid) || values.ControlPID !== '0' || values.ControlGroup !== '/system.slice/' + info.unit
    || values.FragmentPath !== '/etc/systemd/system/' + info.unit || values.DropInPaths || !['', 'root', '0'].includes(values.User)
    || processPin.executable !== await realpath(info.nodePath) || JSON.stringify(process.argv) !== JSON.stringify([info.nodePath, info.sourcePath])
    || await realpath('/proc/self/cwd') !== info.helper.releaseRoot) fail('LIFECYCLE_OWNED_COORDINATOR_REQUIRED')
}

export async function withNativeRecoveryPreparation(callback) {
  await assertNativeLifecycleRecoveryPrerequisites()
  const recovery = await nativeRecoveryCapture()
  return withExistingPreparedRelease(recovery.capture.artifact, callback)
}

/** Read-only proof for a retained operation; never grants a writer or host-effect capability. */
export async function assertLifecycleRecoveryObservationHeld(capability) {
  const scope = capability && recoveryObservationScopes.get(capability)
  if (!scope || !scope.live || recoveryObservationStorage.getStore() !== scope) fail('LIFECYCLE_RECOVERY_OBSERVATION_REQUIRED')
  if (JSON.stringify(await processIdentity()) !== JSON.stringify(scope.processPin)) fail('LIFECYCLE_COORDINATOR_CHANGED')
  await assertCoordinatorOwnershipCurrent(scope.coordinator)
  await withVisiblePreparedRelease(scope.prepared, () => assertPreparedReleaseCurrent(scope.prepared))
  await assertFixedCoordinatorMainProcess(scope.processPin, coordinatorOwnershipInfo(scope.coordinator))
  if ((await readHead()).hash !== scope.recovery.head.hash) fail('LIFECYCLE_RECOVERY_HEAD_CHANGED')
  await withTrustedFile(ROOT + '/writer-barrier.json', { exactMode: 0o644, maxBytes: 16384, sha256: scope.recovery.barrier.hash }, async () => {})
  await assertOwnedFile(scope.recovery.capture.journalEntry)
  await assertOwnedFile(scope.admission.entry)
  for (const file of scope.recovery.capture.images) await assertOwnedFile(file)
  await assertProtectedDatabaseOrigin(scope.recovery.capture.intent.binding.origin)
  const database = await lstat('/var/lib/xpanel/control.db', { bigint: true })
  if (!database.isFile() || database.nlink !== 1n || String(database.dev) !== scope.recovery.capture.intent.binding.origin.device
    || String(database.ino) !== scope.recovery.capture.intent.binding.origin.inode
    || await accountLifetimeHash() !== scope.recovery.capture.intent.binding.accountLifetimeSha256) fail('LIFECYCLE_RECOVERY_IDENTITY_CHANGED')
  if (scope.generationProof && JSON.stringify((await observeRecoveryGenerationSource(scope)).proof) !== JSON.stringify(scope.generationProof)) fail('LIFECYCLE_RECOVERY_GENERATION_SOURCE_CHANGED')
}

export async function withNativeLifecycleRecoveryObservation(callback) {
  if (typeof callback !== 'function' || recoveryObservationStorage.getStore()) fail('LIFECYCLE_RECOVERY_OBSERVATION_CONFLICT')
  const processPin = await processIdentity()
  return withVerifiedCoordinatorOwnership(async coordinator => {
    const info = coordinatorOwnershipInfo(coordinator)
    if (processPin.coordinatorUnit !== info.unit || process.argv[1] !== info.sourcePath) fail('LIFECYCLE_COORDINATOR_SOURCE_REQUIRED')
    const recovery = await nativeRecoveryCapture()
    const baseline = await captureManagedFile(`${ROOT}/admission-${recovery.capture.operationId}.json`)
    const initial = JSON.parse(baseline.bytes)
    if (baseline.entry.mode !== 0o600 || initial.kind !== 'xpanel-initial-upgrade-admission' || initial.operationId !== recovery.capture.operationId
      || JSON.stringify(initial.binding?.intentBinding) !== JSON.stringify(recovery.capture.intent.binding.intentBinding)
      || !SHA.test(initial.desiredState?.checksum) || initial.binding?.accountLifetimeSha256 !== recovery.capture.intent.binding.accountLifetimeSha256) fail('LIFECYCLE_RECOVERY_GENERATION_BASELINE_INVALID')
    return withExistingPreparedRelease(recovery.capture.artifact, async prepared => {
      const capability = Object.freeze({}), controller = new AbortController()
      const scope = { live: true, processPin, coordinator, recovery, prepared, admission: { entry: baseline.entry, value: initial }, generationProof: null }
      recoveryObservationScopes.set(capability, scope)
      return recoveryObservationStorage.run(scope, async () => {
        const admission = await import('./lifecycle-admission.mjs')
        try {
          await assertLifecycleRecoveryObservationHeld(capability)
          return await admission.withLifecycleRecoveryObservationAdmission(capability, async () => callback(Object.freeze({
            operationId: recovery.pendingOperationId, kind: 'recover', readOnly: true, signal: controller.signal,
            assertCurrent: () => admission.assertLifecycleRecoveryObservationAdmissionHeld(capability),
            activeGenerationSource: async () => {
              await admission.assertLifecycleRecoveryObservationAdmissionHeld(capability)
              const observed = await observeRecoveryGenerationSource(scope)
              scope.generationProof = observed.proof
              await admission.assertLifecycleRecoveryObservationAdmissionHeld(capability)
              return Object.freeze({ generation: Object.freeze({ ...observed.generation }), snapshot: structuredClone(observed.source), sourceChecksum: observed.source.checksum })
            },
          })))
        } finally { scope.live = false; controller.abort() }
      })
    })
  })
}

async function assertScope(scope) {
  if (!scope || scopeStorage.getStore() !== scope || scope.phase !== 'held') fail('LIFECYCLE_NATIVE_SCOPE_REQUIRED')
  const current = await processIdentity()
  if (JSON.stringify(current) !== JSON.stringify(scope.process)) fail('LIFECYCLE_COORDINATOR_CHANGED')
  await assertHostOperationGuardHeld(scope.guard, bindingFor(scope.origin))
  for (const verify of scope.pins) await verify()
  await scope.db.transaction(async tx => { assertOperationIntentReceipt(scope.intentReceipt, scope.intentBinding, tx) })
}

export async function assertLifecycleRootSafetyHeld(capability, { effect } = {}) {
  if (!EFFECTS.has(effect)) fail('LIFECYCLE_EFFECT_INVALID')
  const initial = capability && typeof capability === 'object' ? bootstrapScopes.get(capability) : undefined
  if (initial) {
    if (effect === 'service.observe' && initial.phase === 'writable' && initial.plannedJob) {
      await assertLifecycleBootstrapHeld(capability)
      const admission = await import('./lifecycle-admission.mjs')
      return admission.assertLifecycleBootstrapExclusivePhysicalHeld(capability)
    }
    if (!['service.stop', 'service.observe'].includes(effect) || effect === 'service.stop' && initial.phase !== 'stopping') fail('LIFECYCLE_BOOTSTRAP_EFFECT_DENIED')
    return assertBootstrapStopAuthority(initial)
  }
  const scope = capability && typeof capability === 'object' ? capabilities.get(capability) : undefined
  await assertScope(scope)
}

export async function assertCurrentLifecycleEffect(effect) {
  const scope = scopeStorage.getStore()
  if (!scope || !EFFECTS.has(effect)) fail('LIFECYCLE_NATIVE_SCOPE_REQUIRED')
  await assertLifecycleRootSafetyHeld(scope.capability, { effect })
}

/** Read-only facade of THIS actual native scope. Data, a caller callback or a receipt cannot mint it. */
export async function captureCurrentLifecycleObservationScope() {
  const scope = scopeStorage.getStore()
  await assertLifecycleRootSafetyHeld(scope?.capability, { effect: 'service.observe' })
  if (!scope || scopeStorage.getStore() !== scope || scope.phase !== 'held' || retiredObservationScopes.has(scope)) fail('LIFECYCLE_NATIVE_SCOPE_REQUIRED')
  const controller = new AbortController()
  scope.observations.add(controller)
  let released = false
  const assertAuthority = async () => {
    if (released || controller.signal.aborted || scopeStorage.getStore() !== scope || scope.phase !== 'held' || retiredObservationScopes.has(scope)) fail('LIFECYCLE_OBSERVATION_SCOPE_EXPIRED')
    await assertLifecycleRootSafetyHeld(scope.capability, { effect: 'service.observe' })
    if (released || controller.signal.aborted || scopeStorage.getStore() !== scope || scope.phase !== 'held' || retiredObservationScopes.has(scope)) fail('LIFECYCLE_OBSERVATION_SCOPE_EXPIRED')
  }
  return Object.freeze({ operationId: scope.job.id, kind: scope.operation, readOnly: true, signal: controller.signal, assertAuthority,
    release() { if (!released) { released = true; scope.observations.delete(controller); controller.abort() } },
  })
}

export async function verifyCurrentLifecycleWriterReadiness() {
  const scope = scopeStorage.getStore()
  await assertScope(scope)
  const admission = await import('./lifecycle-admission.mjs')
  return admission.verifyNativeWriterGeneration(scope.capability, scope.job.id)
}

export async function readNativeReleaseTrust() {
  await processIdentity()
  const trust = await trustConfiguration()
  return Object.freeze(archiveTrust(trust))
}

/** Non-secret archive identity from the same fixed root trust used by native execution. */
export async function readNativeReleaseTrustIdentity() {
  await processIdentity()
  const trust = await trustConfiguration()
  return Object.freeze({ keyId: trust.keyId, signingKeyPath: trust.signingKeyPath })
}

export function getLifecycleRootSafetyInfo(capability) {
  const initial = capability && typeof capability === 'object' ? bootstrapScopes.get(capability) : undefined
  if (initial) {
    bootstrap(capability)
    if (initial.phase === 'writable' && initial.plannedJob) return Object.freeze({ operationId: initial.plannedJob.id, kind: initial.operation,
      reference: initial.plannedJob.referenceCode, coordinatorUnit: initial.processPin.coordinatorUnit, transitionBinding: null,
      recoveryOf: initial.recovery?.capture.operationId ?? null, recoveryJournalSha256: initial.recovery?.capture.journalEntry.sha256 ?? null })
    if (!initial.stopRequest || !initial.stopJournal || !['stopping', 'observing', 'admitted', 'repair-admitted', 'repairing'].includes(initial.phase)) fail('LIFECYCLE_STOP_ONLY_AUTHORITY_REQUIRED')
    return Object.freeze({ operationId: initial.stopRequest.operationId, kind: 'recover', reference: initial.recovery.capture.intent.reference,
      coordinatorUnit: initial.processPin.coordinatorUnit, transitionBinding: null, recoveryOf: initial.recovery.capture.operationId,
      recoveryJournalSha256: initial.recovery.capture.journalEntry.sha256 })
  }
  const scope = capability && typeof capability === 'object' ? capabilities.get(capability) : undefined
  if (!scope || scopeStorage.getStore() !== scope || scope.phase !== 'held') fail('LIFECYCLE_NATIVE_SCOPE_REQUIRED')
  return Object.freeze({ operationId: scope.job.id, kind: scope.operation, reference: scope.job.referenceCode, coordinatorUnit: scope.process.coordinatorUnit,
    transitionBinding: scope.transitionBinding ? structuredClone(scope.transitionBinding) : null,
    recoveryOf: scope.recovery?.capture.operationId ?? null, recoveryJournalSha256: scope.recovery?.capture.journalEntry.sha256 ?? null })
}

/** Actual kernel/service identity, independently observed before and after the private socket handshake. */
export async function observeLifecycleWriterService(capability, role, expected) {
  await assertLifecycleRootSafetyHeld(capability, { effect: 'service.observe' })
  if (!['api', 'agent'].includes(role)) fail('LIFECYCLE_WRITER_ROLE_INVALID')
  const scope = capabilities.get(capability), unit = `xpanel-${role}.service`
  const shown = await nativeCommand('/usr/bin/systemctl', ['show', unit, '--property=MainPID,ControlPID,ControlGroup,FragmentPath,DropInPaths,ActiveState,User'])
  const properties = Object.fromEntries(shown.output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
  if (shown.code !== 0 || !/^[1-9][0-9]*$/.test(properties.MainPID) || properties.ControlPID !== '0' || properties.ActiveState !== 'active' || properties.ControlGroup !== `/system.slice/${unit}` || properties.FragmentPath !== `/etc/systemd/system/${unit}` || properties.DropInPaths || (role === 'api' ? properties.User !== 'xpanel' : !['', 'root', '0'].includes(properties.User))) fail('LIFECYCLE_WRITER_SERVICE_UNOWNED')
  const pid = Number(properties.MainPID)
  const [status, stat, executable, cgroup, command] = await Promise.all([readFile(`/proc/${pid}/status`, 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8'), readlink(`/proc/${pid}/exe`), readFile(`/proc/${pid}/cgroup`, 'utf8'), readFile(`/proc/${pid}/cmdline`, 'utf8')])
  const uid = Number(/^Uid:\s+([0-9]+)\s+\1\s+\1\s+\1\s*$/m.exec(status)?.[1]), start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
  if (!Number.isSafeInteger(uid) || (role === 'api' ? uid <= 0 : uid !== 0) || !/^[0-9]+$/.test(start ?? '') || executable !== scope.process.executable || cgroup.trim() !== `0::/system.slice/${unit}`) fail('LIFECYCLE_WRITER_PROCESS_CHANGED')
  const source = await realpath('/opt/xpanel/current')
  const expectedEntry = join(source, `apps/${role}/src/main.ts`)
  const args = command.split('\0').filter(Boolean)
  if (JSON.stringify(args) !== JSON.stringify([scope.receipt.runtime.nodePath, role === 'agent' ? '--max-old-space-size=64' : '--max-old-space-size=96', expectedEntry])
    || await realpath(`/proc/${pid}/cwd`) !== source || source !== '/opt/xpanel/releases/' + scope.receipt.source.version) fail('LIFECYCLE_WRITER_SOURCE_MISMATCH')
  const actual = Object.freeze({ pid, uid, start, executable, source })
  if (expected && JSON.stringify(actual) !== JSON.stringify(expected)) fail('LIFECYCLE_WRITER_PROCESS_CHANGED')
  return actual
}

async function runtimeDependencies(scope, root, report) {
  await assertScope(scope)
  const manager = scope.trust.packageManagerPath
  const checked = await nativeCommand(manager, ['--version'], { sha256: scope.trust.packageManagerSha256 })
  if (checked.code !== 0 || checked.output.trim() !== report.manifest.runtime.packageManager.split('@').at(-1)) fail('LIFECYCLE_PACKAGE_MANAGER_MISMATCH')
  const installed = await nativeCommand(manager, offlineDependencyInstallArguments(report.manifest), { cwd: root, sha256: scope.trust.packageManagerSha256, timeoutMs: 120_000 })
  if (installed.code !== 0) fail('LIFECYCLE_DEPENDENCY_INSTALL_FAILED')
  await normalizeDependencyModes(root)
  const lock = await readFile(join(root, 'pnpm-lock.yaml'))
  if (sha(lock) !== report.manifest.lockfileSha256) fail('LIFECYCLE_LOCKFILE_CHANGED')
  const moduleRoot = join(root, 'node_modules'), actualRoot = await realpath(root)
  let seen = 0
  const walk = async directory => {
    if (++seen > 100_000) fail('LIFECYCLE_DEPENDENCY_LIMIT')
    for (const name of await readdir(directory)) {
      const path = join(directory, name), info = await lstat(path, { bigint: true })
      if (info.uid !== 0n || (info.mode & 0o022n) !== 0n) fail('LIFECYCLE_DEPENDENCY_OWNERSHIP')
      if (info.isSymbolicLink()) { const target = await realpath(path); if (target !== actualRoot && !target.startsWith(actualRoot + '/')) fail('LIFECYCLE_DEPENDENCY_ESCAPE') }
      else if (info.isDirectory()) await walk(path)
      else if (!info.isFile() || info.nlink < 1n) fail('LIFECYCLE_DEPENDENCY_KIND')
    }
  }
  await walk(moduleRoot)
  const native = await nativeCommand(scope.receipt.runtime.nodePath, ['--input-type=module', '-e', NATIVE_RUNTIME_ABI_PROBE], { cwd: root, sha256: scope.receipt.runtime.nodeSha256 })
  if (native.code !== 0) fail('LIFECYCLE_NATIVE_ABI_FAILED')
  scope.dependencies = { root, lockHash: sha(lock), verifiedAt: new Date().toISOString() }
}

/** Negative precheck before opening a writer connection; it does not mint an effect scope. */
export async function assertNativeLifecyclePrerequisites(ownership) {
  const processPin = await processIdentity()
  const { receipt } = await readInstallationReceipt()
  if (receipt.status !== 'active' || process.version !== `v${receipt.runtime.nodeVersion}` || processPin.executable !== await realpath(receipt.runtime.nodePath)) fail('LIFECYCLE_INSTALLATION_NOT_READY')
  const verifyCoordinator = async coordinator => {
    const verified = coordinatorOwnershipInfo(coordinator)
    if (processPin.coordinatorUnit !== verified.unit || process.argv[1] !== verified.sourcePath) fail('LIFECYCLE_COORDINATOR_SOURCE_REQUIRED')
    await assertCoordinatorOwnershipCurrent(coordinator)
  }
  if (ownership === undefined) await withVerifiedCoordinatorOwnership(verifyCoordinator)
  else await verifyCoordinator(ownership)
  await trustConfiguration()
  for (const file of receipt.files) await assertOwnedFile(file)
  await withTrustedFile(receipt.runtime.nodePath, { sha256: receipt.runtime.nodeSha256, maxBytes: 256 * 1024 * 1024 }, async () => {})
  await withTrustedFile('/usr/bin/systemctl', { maxBytes: 16 * 1024 * 1024 }, async () => {})
  const controller = await nativeCommand('/usr/bin/systemctl', ['show', processPin.coordinatorUnit, '--property=MainPID,ControlPID,ControlGroup,FragmentPath,DropInPaths,User'])
  const properties = Object.fromEntries(controller.output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
  if (controller.code !== 0 || properties.MainPID !== String(process.pid) || properties.ControlPID !== '0' || properties.ControlGroup !== `/system.slice/${processPin.coordinatorUnit}` || properties.FragmentPath !== `/etc/systemd/system/${processPin.coordinatorUnit}` || properties.DropInPaths || !['', 'root', '0'].includes(properties.User)) fail('LIFECYCLE_OWNED_COORDINATOR_REQUIRED')
  await withTrustedFile(properties.FragmentPath, { maxBytes: 65536 }, async () => {})
}

/** Only actual native observations create this implementation; no provider/stat/receipt override exists. */
export async function createNativeUpgradeSafety(options) {
  const processPin = await processIdentity()
  if (!options || typeof options !== 'object' || Object.keys(options).some(key => !['db', 'actorId', 'operation', 'release', 'layout', 'preparedRelease'].includes(key)) || !ACTIONS.has(options.operation) || typeof options.actorId !== 'string') fail('LIFECYCLE_NATIVE_OPTIONS_INVALID')
  const db = options.db, operation = options.operation
  const initial = await withVisibleLifecycleBootstrap(() => {
    const scope = bootstrapStorage.getStore()
    if (!scope?.live || scope.phase !== 'writable' || scope.operation !== operation || scope.dbHandle?.db !== db) fail('LIFECYCLE_DATABASE_ADMISSION_REQUIRED')
    return scope
  })
  const initialAdmission = await import('./lifecycle-admission.mjs')
  await initialAdmission.assertLifecycleBootstrapExclusivePhysicalHeld(initial.capability)
  if (operation === 'upgrade') await withVisiblePreparedRelease(options.preparedRelease, () => assertPreparedReleaseCurrent(options.preparedRelease))
  const origin = await db.transaction(async tx => getStrictOperationDatabaseOrigin(tx))
  await assertProtectedDatabaseOrigin(origin)
  const operatorBinding = await (await import('./root-operator.mjs')).currentRootOperatorBinding()
  if (operatorBinding && ['file', 'device', 'inode', 'issuerId'].some(key => operatorBinding.origin[key] !== origin[key])) fail('LIFECYCLE_OPERATOR_ORIGIN_CHANGED')
  const principal = await getPrincipal(db, options.actorId)
  if (!principal || principal.kind !== 'root' || principal.disabled || principal.forcePasswordChange
    || principal.id !== initial.dbProof.principal.id || principal.username !== initial.dbProof.principal.username) fail('LIFECYCLE_ROOT_PRINCIPAL_REQUIRED')
  const recovery = operation === 'recover' ? await nativeRecoveryCapture() : null
  if (recovery && initial.recovery?.auditOnlyPreHead) recovery.auditOnlyPreHead = true
  const actual = recovery ? null : await readInstallationReceipt(), receipt = recovery?.capture.provisionalReceipt ?? actual.receipt
  if (recovery) {
    await withVisiblePreparedRelease(options.preparedRelease, () => assertPreparedReleaseCurrent(options.preparedRelease))
    if (JSON.stringify(recovery.capture.intent.binding.origin) !== JSON.stringify(origin)
      || recovery.capture.intent.binding.accountLifetimeSha256 !== await accountLifetimeHash()) fail('LIFECYCLE_RECOVERY_IDENTITY_CHANGED')
    if (recovery.capture.recoveryMode === 'abort-before-transition' && await currentSchemaVersion(db) !== recovery.capture.intent.schema) fail('LIFECYCLE_INITIAL_SCHEMA_CHANGED')
  }
  if (receipt.status !== 'active' || process.version !== `v${receipt.runtime.nodeVersion}` || processPin.executable !== await realpath(receipt.runtime.nodePath)) fail('LIFECYCLE_INSTALLATION_NOT_READY')
  const trust = await trustConfiguration()
  for (const file of receipt.files) await assertOwnedFile(file)
  const controller = await nativeCommand('/usr/bin/systemctl', ['show', processPin.coordinatorUnit, '--property=MainPID,ControlPID,ControlGroup,FragmentPath,DropInPaths,User'])
  const properties = Object.fromEntries(controller.output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
  if (controller.code !== 0 || properties.MainPID !== String(process.pid) || properties.ControlPID !== '0' || properties.ControlGroup !== `/system.slice/${processPin.coordinatorUnit}` || properties.FragmentPath !== `/etc/systemd/system/${processPin.coordinatorUnit}` || properties.DropInPaths || !['', 'root', '0'].includes(properties.User)) fail('LIFECYCLE_OWNED_COORDINATOR_REQUIRED')
  await withTrustedFile(properties.FragmentPath, { maxBytes: 65536 }, async () => {})
  const factory = Object.freeze({})
  factories.set(factory, { db, origin, principal, process: processPin, receipt, trust, options, operation, recovery })
  let activeScope
  const current = async () => { await assertScope(activeScope); return activeScope }
  const safety = {
    async withExclusive(callback) {
      if (typeof callback !== 'function' || activeScope) fail('LIFECYCLE_SCOPE_CONFLICT')
      const configured = factories.get(factory)
      return withVerifiedCoordinatorOwnership(async coordinator => {
        const verified = coordinatorOwnershipInfo(coordinator)
        if (processPin.coordinatorUnit !== verified.unit || process.argv[1] !== verified.sourcePath) fail('LIFECYCLE_COORDINATOR_SOURCE_REQUIRED')
        return withHostOperationGuard(db, {}, async guard => withTrustedDirectory(ROOT, async parent => withTrustedFile('/usr/bin/systemctl', { maxBytes: 16 * 1024 * 1024 }, async tool => withTrustedFile(receipt.runtime.nodePath, { sha256: receipt.runtime.nodeSha256, maxBytes: 256 * 1024 * 1024 }, async node => {
        const head = await readHead()
        if (head.value.issuerId !== origin.issuerId || (recovery ? head.hash !== recovery.head.hash : !['idle', 'retired'].includes(head.value.phase))) fail('LIFECYCLE_RETAINED_ATTENTION')
        let originalIntentReceipt, originalJob
        if (recovery) {
          const binding = recovery.capture.intent.binding
          originalJob = await getDurableJob(db, binding.intentBinding.jobId)
          if (!originalJob || originalJob.kind !== binding.intentBinding.action || originalJob.referenceCode !== recovery.capture.intent.reference
            || JSON.stringify(originalJob.detail?.lifecycleIntent) !== JSON.stringify(binding.intentBinding)) fail('LIFECYCLE_RECOVERY_JOB_CHANGED')
          originalIntentReceipt = initial.dbProof.originalIntentReceipt
          await db.transaction(tx => { assertOperationIntentReceipt(originalIntentReceipt, binding.intentBinding, tx) })
          const pendingJob = await getDurableJob(db, recovery.pendingOperationId)
          const pendingBinding = pendingJob?.detail?.lifecycleIntent
          if (!pendingBinding || pendingBinding.jobId !== recovery.pendingOperationId || pendingBinding.requestFingerprint !== recovery.pendingFingerprint) fail('LIFECYCLE_RECOVERY_HEAD_JOB_CHANGED')
          if (JSON.stringify(pendingBinding) !== JSON.stringify(initial.dbProof.pendingBinding)) fail('LIFECYCLE_RECOVERY_HEAD_JOB_CHANGED')
          const pendingReceipt = initial.dbProof.pendingIntentReceipt
          await db.transaction(tx => { assertOperationIntentReceipt(pendingReceipt, pendingBinding, tx) })
          if (recovery.capture.recoveryMode !== 'abort-before-transition') {
            await withTrustedFile(`${ROOT}/backups/upgrade-${binding.recordId}.receipt.json`, { exactMode: 0o600, maxBytes: 4 * 1024 * 1024, sha256: binding.snapshotReceiptSha256 }, async () => {})
            await withTrustedFile(binding.backup.path, { maxBytes: 256 * 1024 * 1024, sha256: binding.backup.sha256 }, async () => {})
          }
        }
        const id = randomUUID(), fingerprint = sha(JSON.stringify({ operation, actorId: principal.id, release: options.release ?? null, parentHead: head.hash, operatorBinding,
          recovery: recovery ? { operationId: recovery.capture.operationId, journalSha256: recovery.capture.journalEntry.sha256, barrierSha256: recovery.barrier.hash } : null }))
        const intentBinding = { purpose: 'host.lifecycle.intent', jobId: id, requestFingerprint: fingerprint, action: `lifecycle.${operation}`, principalId: principal.id }
        const job = await createJob(db, { id, kind: intentBinding.action, actor: principal.username, detail: { lifecycleIntent: intentBinding, ...(operatorBinding ? { rootOperator: operatorBinding } : {}) } })
        if (operation === 'upgrade') await persistInitialInstallationBeforeAudit(initial, guard, job, intentBinding, options, head)
        const authority = await createRootOperationAuditAuthority(db)
        const intentReceipt = await appendIssuedNativeIntent(initial, guard, coordinator, job, intentBinding, authority, head)
        const scope = { ...configured, phase: 'held', guard, job, intentBinding, intentReceipt, pins: [parent.verify, tool.verify, node.verify, () => assertCoordinatorOwnershipCurrent(coordinator)], previousHead: head, capability: Object.freeze({}), observations: new Set(), capture: null, staged: null, dependencies: null, backup: null, installationTransition: null, restoreTimer: false }
        scope.originalJob = originalJob; scope.originalIntentReceipt = originalIntentReceipt
        scope.interruptedIssuedIntent = initial.dbProof.issuedIntent ?? null
        capabilities.set(scope.capability, scope); activeScope = scope
        return scopeStorage.run(scope, async () => {
          try {
            await assertScope(scope)
            const admission = await import('./lifecycle-admission.mjs')
            return await admission.withLifecyclePromotedExclusiveAdmission(initial.capability, scope.capability, async () => {
              const timestamp = new Date().toISOString(), sequence = head.value.sequence + 1
              if (initial.stopJournal) {
                const stopped = JSON.parse(initial.stopJournal.bytes)
                if (!operatorBinding || operatorBinding.operationId !== initial.stopRequest.operationId) fail('LIFECYCLE_RECOVERY_OPERATOR_BINDING_REQUIRED')
                initial.stopJournal = await replaceManagedFile(initial.stopJournal.entry.path,
                  Buffer.from(JSON.stringify({ ...stopped, phase: 'admitted', nativeOperationId: job.id, nativeReference: job.referenceCode,
                    nativeIntentBinding: intentBinding, operatorClaimSha256: operatorBinding.requestSha256, admittedAt: timestamp }) + '\n'),
                  0o600, initial.stopJournal.entry, () => assertScope(scope))
              }
              if (!recovery && operation === 'upgrade') await captureInitialInstallation(scope)
              if (recovery) {
                if ((await readHead()).hash !== recovery.head.hash || await accountLifetimeHash() !== recovery.capture.intent.binding.accountLifetimeSha256) fail('LIFECYCLE_RECOVERY_CAPTURE_CHANGED')
                await withTrustedFile(ROOT + '/writer-barrier.json', { exactMode: 0o644, maxBytes: 16384, sha256: recovery.barrier.hash }, async () => {})
                for (const file of recovery.capture.images) await assertOwnedFile(file)
                await durableJson(`${ROOT}/recovery-${job.id}.json`, { schemaVersion: 1, kind: 'xpanel-native-recovery-admission', operationId: job.id,
                  requestFingerprint: fingerprint, reference: job.referenceCode, parentHeadSha256: head.hash, previousBarrierSha256: recovery.barrier.hash,
                  transitionOperationId: recovery.capture.operationId, transitionJournalSha256: recovery.capture.journalEntry.sha256,
                  origin, priorOperationId: recovery.pendingOperationId, images: recovery.capture.images, createdAt: timestamp })
              }
              if (initial.issuedFence) await assertOwnedFile(initial.issuedFence.entry)
              await durableJson(ROOT + '/writer-barrier.json', { schemaVersion: 1, operationId: job.id, reference: job.referenceCode, kind: operation, phase: 'pending', requestFingerprint: fingerprint, sequence, createdAt: timestamp }, Boolean(recovery || initial.issuedFence), 0o644)
              await durableJson(HEAD, { ...head.value, sequence, phase: 'pending', operationId: job.id, reference: job.referenceCode, kind: operation, requestFingerprint: fingerprint, updatedAt: timestamp }, true)
              if (recovery) {
                if (recovery.capture.recoveryMode !== 'abort-before-transition') scope.installationTransition = await reopenInstallationTransition(scope.capability, options.preparedRelease, recovery.capture)
                scope.backup = recovery.capture.intent.binding.backup
                scope.dependencies = await withVisiblePreparedRelease(options.preparedRelease, () => preparedReleaseInfo(options.preparedRelease))
                scope.restoreTimer = recovery.capture.intent.restoreTimer ?? recovery.capture.intent.binding.restoreTimer ?? false
              }
              const result = await callback()
              return await settleNative(scope, result)
            })
          } finally {
            retiredObservationScopes.add(scope)
            for (const controller of scope.observations) controller.abort()
            scope.observations.clear()
            try { await awaitOwnedServiceChildren(scope.capability) } finally { scope.phase = 'closed'; activeScope = null }
          }
        })
      }))))
      })
    },
    async assertOwnedExecution(units) {
      const scope = await current()
      if (!Array.isArray(units) || units.some(unit => !['xpanel-api.service', 'xpanel-agent.service'].includes(unit))) fail('LIFECYCLE_UNOWNED_PANEL_UNIT')
      scope.capture ??= await observeOwnedControlPlaneUnits(scope.receipt, scope.capability)
      if (!scope.recovery) scope.restoreTimer = projectOwnedControlPlaneObservation(scope.capture).observations.at(-1).units.some(unit => unit.Id === 'xpanel-management-tls.timer' && unit.ActiveState === 'active')
    },
    async assertWritersQuiescent() { const scope = await current(); scope.capture = await assertOwnedControlPlaneQuiescent(scope.receipt, scope.capture, scope.capability) },
    async controlPlane(verb) {
      const scope = await current()
      if (!['stop', 'start', 'restart'].includes(verb)) fail('LIFECYCLE_SERVICE_VERB_INVALID')
      if (verb === 'stop') { scope.capture = await stopAndDrainOwnedControlPlaneUnits(scope.receipt, scope.capability); return }
      for (const file of scope.receipt.files) await assertOwnedFile(file)
      for (const unit of ['xpanel-agent.service', 'xpanel-api.service', ...(scope.restoreTimer ? ['xpanel-management-tls.timer'] : [])]) {
        await assertScope(scope)
        const result = await nativeCommand('/usr/bin/systemctl', [unit.endsWith('.timer') ? 'start' : verb, unit])
        if (result.code !== 0) fail('LIFECYCLE_SERVICE_START_FAILED')
      }
    },
    async acceptPreparedRelease(path) {
      const scope = await current()
      if (!scope.options.preparedRelease) return false
      await withVisiblePreparedRelease(scope.options.preparedRelease, () => assertPreparedReleaseCurrent(scope.options.preparedRelease))
      const info = await withVisiblePreparedRelease(scope.options.preparedRelease, () => preparedReleaseInfo(scope.options.preparedRelease))
      if (path !== info.releaseRoot || !scope.report || scope.report.archiveSha256 !== info.archiveSha256
        || scope.report.manifestSha256 !== info.manifestSha256 || info.version !== scope.options.release?.version) fail('LIFECYCLE_PREPARED_RELEASE_CHANGED')
      scope.dependencies = info
      return true
    },
    async prepareInstallationSource(recordId) {
      const scope = await current()
      if (scope.installationTransition) return
      if (!scope.backup || !scope.options.preparedRelease || recordId !== scope.job.id) fail('LIFECYCLE_INSTALLATION_PREPARATION_REQUIRED')
      const last = await latestUpgrade(scope.db)
      if (!last || last.id !== recordId || !['pending', 'running'].includes(last.status)) fail('LIFECYCLE_INSTALLATION_RECORD_CHANGED')
      const snapshot = await withTrustedFile(`${ROOT}/backups/upgrade-${recordId}.receipt.json`, { exactMode: 0o600, maxBytes: 4 * 1024 * 1024 }, async pin => ({ value: JSON.parse(pin.bytes), sha256: pin.sha256 }))
      if (snapshot.value.recordId !== recordId || snapshot.value.control?.path !== scope.backup.path || snapshot.value.control?.sha256 !== scope.backup.sha256) fail('LIFECYCLE_INSTALLATION_BACKUP_CHANGED')
      scope.transitionBinding = { recordId, origin: scope.origin, intentBinding: scope.intentBinding,
        backup: scope.backup, snapshotReceiptSha256: snapshot.sha256, accountLifetimeSha256: await accountLifetimeHash(), restoreTimer: scope.restoreTimer }
      scope.installationTransition = await prepareInstallationTransition(scope.capability, scope.options.preparedRelease)
    },
    async selectInstallationSource(input) {
      const scope = await current()
      if (!input || Object.keys(input).sort().join(',') !== 'direction,recordId,target'
        || !['forward', 'rollback'].includes(input.direction) || typeof input.recordId !== 'string') fail('LIFECYCLE_INSTALLATION_SELECTION_INVALID')
      if (input.direction === 'forward') {
        if (!scope.backup || !scope.options.preparedRelease) fail('LIFECYCLE_INSTALLATION_PREPARATION_REQUIRED')
        const preparedRoot = await withVisiblePreparedRelease(scope.options.preparedRelease, () => preparedReleaseInfo(scope.options.preparedRelease).releaseRoot)
        if (input.target !== preparedRoot) fail('LIFECYCLE_INSTALLATION_PREPARATION_REQUIRED')
        await safety.prepareInstallationSource(input.recordId)
      }
      if (scope.recovery && input.recordId !== scope.recovery.capture.intent.binding.recordId) fail('LIFECYCLE_RECOVERY_RECORD_CHANGED')
      if (!scope.installationTransition) fail('LIFECYCLE_INSTALLATION_RECOVERY_REQUIRED')
      const receipt = await selectInstallationTransition(scope.installationTransition, input.direction === 'forward' ? 'target' : 'previous')
      if (input.target !== '/opt/xpanel/releases/' + receipt.source.version) fail('LIFECYCLE_INSTALLATION_SELECTION_CHANGED')
      scope.receipt = receipt
      const reloaded = await nativeCommand('/usr/bin/systemctl', ['daemon-reload'])
      if (reloaded.code !== 0) fail('LIFECYCLE_SYSTEMD_RELOAD_FAILED')
      scope.capture = await observeOwnedControlPlaneUnits(scope.receipt, scope.capability)
    },
    async recoveryPlan() {
      const scope = await current()
      if (scope.operation !== 'recover' || !scope.recovery || scope.recovery.capture.recoveryMode !== 'abort-before-transition' && !scope.installationTransition) fail('LIFECYCLE_RECOVERY_ADMISSION_REQUIRED')
      let recordId = scope.recovery.capture.intent.binding.recordId
      if (scope.recovery.capture.recoveryMode === 'abort-before-transition') {
        const record = await latestUpgrade(scope.db)
        if (!record || record.id !== recordId) recordId = null
        else if (!['pending', 'running', 'rolled_back'].includes(record.status) || record.fromVersion !== scope.receipt.source.version || record.toVersion !== scope.recovery.capture.intent.target.version) fail('LIFECYCLE_INITIAL_RECORD_CHANGED')
      }
      return Object.freeze({ recordId, mode: scope.recovery.capture.recoveryMode,
        hostOutcome: scope.recovery.capture.intent.selected === 'target' ? 'succeeded' : 'rolled_back' })
    },
    async upgradeRecordId() { const scope = await current(); if (scope.operation !== 'upgrade' || !scope.initialAdmission) fail('LIFECYCLE_UPGRADE_RECORD_UNBOUND'); return scope.job.id },
    async assertWriteBarrier() {
      const scope = await current(), head = await readHead()
      if (head.value.operationId !== scope.job.id || !['pending', 'retirement_pending'].includes(head.value.phase)) fail('LIFECYCLE_WRITE_BARRIER_CHANGED')
      // Require the real native writer-lock capability as well as permanent pending evidence.
      const admission = await import('./lifecycle-admission.mjs')
      await admission.assertLifecycleExclusivePhysicalHeld(scope.capability)
    },
    async verifyRelease(release) {
      const scope = await current()
      if (!options.release || JSON.stringify(release) !== JSON.stringify(options.release)) fail('LIFECYCLE_RELEASE_BINDING_CHANGED')
      const report = await verifyAuthenticatedReleaseArchive(release.archivePath, { ...archiveTrust(trust), expectedArchiveSha256: release.sha256 })
      if (report.manifest.version !== release.version || report.manifest.controlDbSchemaVersion !== release.schemaVersion) fail('LIFECYCLE_RELEASE_MANIFEST_MISMATCH')
      scope.report = report
    },
    async unpackVerifiedRelease(path, release) {
      const scope = await current()
      await safety.verifyRelease(release)
      if (!path.startsWith('/opt/xpanel/staging/')) fail('LIFECYCLE_STAGE_PATH_INVALID')
      const held = await withAuthenticatedReleaseArchive(release.archivePath, { ...archiveTrust(trust), expectedArchiveSha256: release.sha256 }, async ({ report }) => stageAuthenticatedReleaseArchive(dirname(path), { ...archiveTrust(trust), authenticatedArchive: report }))
      // Descriptor close and ancestry revalidation completed before the staged directory is published.
      await scope.pins[0]()
      const existing = await readdir(path)
      if (existing.length) fail('LIFECYCLE_STAGE_NOT_EMPTY')
      const staged = held.value.stagedAt
      for (const name of await readdir(staged)) await rename(join(staged, name), join(path, name))
      scope.staged = path; scope.report = held.report
    },
    async verifyStagedRelease(path) { const scope = await current(); if (scope.staged !== path || !scope.report) fail('LIFECYCLE_STAGE_BINDING_REQUIRED'); await runtimeDependencies(scope, path, scope.report) },
    async assertCompatibility(input) {
      const scope = await current(), liveSchema = await currentSchemaVersion(db)
      const snapshotVerified = input?.direction === 'rollback' && input.snapshot !== undefined && input.snapshot !== 'planned' ? await verifiedRewindSnapshot(scope, input) : false
      if (!admitSchemaTransition(input, { liveSchema, manifestSchema: scope.report?.manifest.controlDbSchemaVersion ?? null, snapshotVerified })) fail('LIFECYCLE_READER_COMPATIBILITY_REQUIRED')
    },
    async snapshotControlPlane(snapshotPath) {
      const scope = await current(); await safety.assertWritersQuiescent()
      if (!snapshotPath.startsWith(ROOT + '/backups/')) fail('LIFECYCLE_BACKUP_PATH_INVALID')
      const databaseCopy = snapshotPath + '.control.db'
      await db.query('VACUUM INTO $1', [databaseCopy])
      const schema = await currentSchemaVersion(db)
      await withTrustedFile(databaseCopy, { maxBytes: 256 * 1024 * 1024 }, async backup => { await backup.verify(); scope.backup = { path: databaseCopy, sha256: backup.sha256, schema } })
      await safety.syncPath(databaseCopy); await safety.syncPath(dirname(databaseCopy))
    },
    // Rollback: the database returns to this upgrade's pre-migration copy, bound to the hash this scope
    // recorded, so the previous release reads its own reviewed migrations. Writers stayed fenced since the
    // snapshot; issued references, epochs, ids and audit history carry forward. Derived idx_* rows follow state.
    async restoreControlPlane(snapshotPath) {
      const scope = await current(); await safety.assertWritersQuiescent()
      if (!snapshotPath.startsWith(ROOT + '/backups/')) fail('LIFECYCLE_BACKUP_PATH_INVALID')
      if (scope.backup?.path !== snapshotPath + '.control.db' || !SHA.test(scope.backup?.sha256)) fail('LIFECYCLE_DATABASE_SNAPSHOT_UNBOUND')
      try { await restoreOperationalDatabaseSnapshot(db, { path: scope.backup.path, sha256: scope.backup.sha256 }) } catch (error) {
        const reason = error?.detail?.reason
        if (reason === 'database_snapshot_missing') fail('LIFECYCLE_DATABASE_SNAPSHOT_MISSING')
        if (reason === 'database_snapshot_changed') fail('LIFECYCLE_DATABASE_SNAPSHOT_CHANGED')
        throw error
      }
      await reindexFromState(db, await new StateStore('/var/lib/xpanel/state').readSnapshot())
      await current()
    },
    async syncPath(path) {
      await current()
      if (!['/opt/xpanel', ROOT, '/var/lib/xpanel'].some(root => path === root || path.startsWith(root + '/'))) fail('LIFECYCLE_SYNC_PATH_INVALID')
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { const info = await handle.stat(); if (!info.isFile() && !info.isDirectory()) fail('LIFECYCLE_SYNC_KIND_INVALID'); await handle.sync() } finally { await handle.close() }
    },
  }
  return Object.freeze(safety)
}

// A finished renewal run that failed holds no process and writes no panel state; its status file reports it.
const finishedRenewal = unit => unit.Id === 'xpanel-management-tls.service' && unit.ActiveState === 'failed' && unit.MainPID === '0' && unit.ControlPID === '0'

/** Syntax/state projection only; it cannot establish native capture, ownership or writer admission. */
export function isSettledControlPlaneProjection(value) {
  if (!value || !Array.isArray(value.observations) || value.observations.length === 0) return false
  const latest = value.observations.at(-1)
  if (!latest || !Array.isArray(latest.units) || latest.units.length !== OWNED_PANEL_UNITS.length) return false
  const seen = new Set()
  for (const unit of latest.units) {
    if (!unit || !OWNED_PANEL_UNITS.includes(unit.Id) || seen.has(unit.Id)
      || !(['active', 'inactive'].includes(unit.ActiveState) || finishedRenewal(unit))) return false
    if (['xpanel-api.service', 'xpanel-agent.service'].includes(unit.Id) && unit.ActiveState !== 'active') return false
    seen.add(unit.Id)
  }
  return OWNED_PANEL_UNITS.every(unit => seen.has(unit))
}

/** API and agent started behind the barrier stay quarantined until a process restart. Queued, so settlement never waits on daemon startup. */
export async function queueWriterRestart(run) {
  for (const unit of ['xpanel-agent.service', 'xpanel-api.service']) {
    let code = null
    try { code = (await run('/usr/bin/systemctl', ['restart', '--no-block', unit])).code } catch { code = null }
    if (code !== 0) process.stderr.write(`xpanel-lifecycle: restart of ${unit} refused after retirement code=LIFECYCLE_WRITER_RESTART_REFUSED\n`)
  }
}

async function settleNative(scope, result) {
  await assertScope(scope)
  if (!result || result.outcome !== 'retirement_pending') return result
  const head = await readHead()
  await durableJson(HEAD, { ...head.value, phase: 'retirement_pending', updatedAt: new Date().toISOString() }, true)
  const earlyAbort = scope.recovery?.capture.recoveryMode === 'abort-before-transition'
  if (!scope.dependencies || !scope.capture || !earlyAbort && (!scope.backup || !scope.installationTransition) || !['succeeded', 'rolled_back'].includes(result.hostOutcome)) return result
  const observation = projectOwnedControlPlaneObservation(await observeOwnedControlPlaneUnits(scope.receipt, scope.capability))
  if (!isSettledControlPlaneProjection(observation)) {
    const units = observation.observations.at(-1)?.units.map(unit => `${unit.Id}=${unit.ActiveState}`).join(' ')
    process.stderr.write(`xpanel-lifecycle: retirement withheld code=LIFECYCLE_CONTROL_PLANE_UNSETTLED ${units}\n`)
    return result
  }
  // Retirement also requires actual active writers holding the current shared admission generation.
  const admission = await import('./lifecycle-admission.mjs')
  if (!await admission.verifyNativeWriterGeneration(scope.capability, scope.job.id)) {
    process.stderr.write('xpanel-lifecycle: retirement withheld code=LIFECYCLE_WRITER_GENERATION_UNVERIFIED\n')
    return result
  }
  await assertScope(scope)
  let installation
  if (earlyAbort) {
    const baseline = await readInitialInstallation(scope.recovery.capture.operationId)
    if (result.hostOutcome !== 'rolled_back' || await currentSchemaVersion(scope.db) !== baseline.intent.schema) fail('LIFECYCLE_INITIAL_STATE_CHANGED')
    installation = { operationId: baseline.operationId, journalPath: baseline.path, journalSha256: baseline.journalEntry.sha256,
      installedReceiptSha256: baseline.intent.receiptSha256, source: baseline.provisionalReceipt.source, noSourceChange: true }
  } else installation = await publishInstallationTransition(scope.installationTransition, result.hostOutcome)
  const selected = await readInstallationReceipt()
  if (selected.sha256 !== installation.installedReceiptSha256) fail('LIFECYCLE_INSTALLATION_SETTLEMENT_CHANGED')
  scope.receipt = selected.receipt
  const terminal = { schemaVersion: 1, installation, operationId: scope.job.id, reference: scope.job.referenceCode, requestFingerprint: scope.intentBinding.requestFingerprint, hostOutcome: result.hostOutcome, sourceArchiveSha256: scope.receipt.source.archiveSha256, databaseBackupSha256: scope.backup?.sha256 ?? null,
    interruptedIssuance: scope.interruptedIssuedIntent ? { binding: scope.interruptedIssuedIntent.binding, verified: scope.interruptedIssuedIntent.verified,
      sourceWasNeverAdmitted: scope.recovery.auditOnlyPreHead === true, parentHeadSha256: scope.previousHead.hash } : null, completedAt: new Date().toISOString() }
  // The next release's acquisition reads this record with the same key list; a writer change must change both.
  if (JSON.stringify(Object.keys(terminal)) !== JSON.stringify(TERMINAL_RECORD_KEYS)) fail('LIFECYCLE_TERMINAL_RECORD_SHAPE')
  await ensureTerminalDirectory(scope)
  await durableJson(join(ROOT, 'terminal', scope.job.id + '.json'), terminal)
  let acknowledged = null
  if (scope.recovery && result.recordId) {
    const recorded = await latestUpgrade(scope.db)
    if (recorded?.id === result.recordId && !['pending', 'running'].includes(recorded.status)) {
      if (recorded.status !== result.hostOutcome) fail('LIFECYCLE_RECOVERY_ACKNOWLEDGEMENT_CHANGED')
      let operationId = scope.previousHead.value.operationId
      for (let depth = 0; depth < 32 && !acknowledged; depth++) {
        try {
          await withTrustedFile(`${ROOT}/terminal/${operationId}.json`, { exactMode: 0o600, maxBytes: 128 * 1024 }, async pin => {
            const old = JSON.parse(pin.bytes)
            if (pin.sha256 === recorded.healthReport?.terminalSha256 && old.reference === recorded.healthReport?.nativeLifecycleReference
              && old.hostOutcome === result.hostOutcome && old.installation?.operationId === scope.recovery.capture.operationId
              && old.installation?.installedReceiptSha256 === installation.installedReceiptSha256) acknowledged = { recordId: recorded.id, terminalSha256: pin.sha256 }
          })
        } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (acknowledged || operationId === scope.recovery.capture.operationId) break
        const prior = await withTrustedFile(`${ROOT}/recovery-${operationId}.json`, { exactMode: 0o600, maxBytes: 1024 * 1024 }, async pin => JSON.parse(pin.bytes))
        if (prior.operationId !== operationId || prior.transitionOperationId !== scope.recovery.capture.operationId || !/^[a-f0-9-]{36}$/.test(prior.priorOperationId)) fail('LIFECYCLE_RECOVERY_CHAIN_INVALID')
        operationId = prior.priorOperationId
      }
      if (!acknowledged) fail('LIFECYCLE_RECOVERY_ACKNOWLEDGEMENT_UNPROVEN')
    }
  }
  // Physical verification precedes the short canonical DB acknowledgement transaction.
  await assertHostOperationGuardHeld(scope.guard, bindingFor(scope.origin))
  await scope.db.transaction(async tx => {
    assertHostOperationGuardActive(scope.guard, bindingFor(scope.origin))
    assertOperationIntentReceipt(scope.intentReceipt, scope.intentBinding, tx)
    if (result.recordId && !acknowledged) await finishUpgrade(tx, result.recordId, { status: result.hostOutcome === 'succeeded' ? 'succeeded' : 'rolled_back', healthReport: { nativeLifecycleReference: scope.job.referenceCode, terminalSha256: sha(JSON.stringify(terminal) + '\n') }, error: result.hostOutcome === 'succeeded' ? null : 'State snapshot restored and verified after a failed upgrade', toSchemaVersion: await currentSchemaVersion(tx) })
    await finishJob(tx, scope.job.id, { status: 'succeeded', summary: 'Native lifecycle settlement completed' })
    if (scope.originalJob && scope.originalIntentReceipt) {
      assertOperationIntentReceipt(scope.originalIntentReceipt, scope.recovery.capture.intent.binding.intentBinding, tx)
      const original = await getDurableJob(tx, scope.originalJob.id)
      if (original?.status === 'succeeded') { if (!acknowledged) fail('LIFECYCLE_RECOVERY_JOB_ACKNOWLEDGEMENT_UNPROVEN') }
      else await finishJob(tx, scope.originalJob.id, scope.recovery.auditOnlyPreHead
        ? { status: 'failed', summary: 'Issued upgrade intent recovered; source activation never admitted' }
        : { status: 'succeeded', summary: 'Native lifecycle settlement completed by verified recovery' })
    }
    if (scope.interruptedIssuedIntent && scope.interruptedIssuedIntent.binding.jobId !== scope.originalJob?.id) {
      assertOperationIntentReceipt(scope.interruptedIssuedIntent.receipt, scope.interruptedIssuedIntent.binding, tx)
      const interrupted = await getDurableJob(tx, scope.interruptedIssuedIntent.binding.jobId)
      if (interrupted?.status === 'succeeded') fail('LIFECYCLE_INTERRUPTED_ISSUANCE_JOB_CHANGED')
      await finishJob(tx, scope.interruptedIssuedIntent.binding.jobId, { status: 'failed', summary: 'Issued recovery intent superseded by fresh verified recovery' })
    }
    assertHostOperationGuardActive(scope.guard, bindingFor(scope.origin))
    assertOperationIntentReceipt(scope.intentReceipt, scope.intentBinding, tx)
  })
  await durableJson(HEAD, { ...head.value, phase: 'retired', updatedAt: terminal.completedAt }, true)
  for (const path of ['/var/lib/xpanel/maintenance.json', '/var/lib/xpanel/upgrade.lock', ROOT + '/backups/retirement-attention.json', ROOT + '/writer-barrier.json']) {
    await assertScope(scope)
    if (path.startsWith('/var/lib/xpanel/')) { await removePanelDiagnostic(scope, basename(path)); continue }
    try { await withTrustedFile(path, { maxBytes: 1024 * 1024 }, async () => {}) }
    catch (error) { if (error.code === 'ENOENT' && path !== ROOT + '/writer-barrier.json') continue; throw error }
    await unlink(path); const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await directory.sync() } finally { await directory.close() }
  }
  await queueWriterRestart(nativeCommand)
  return Object.freeze({ ...result, outcome: result.hostOutcome,
    ...(Object.hasOwn(result, 'status') ? { status: 'recovered', closedRecordId: result.recordId, problems: [] } : {}), reason: null, code: null })
}

export async function executeNativeLifecycleCommand(request) { return runNativeLifecycleCommand(request) }
