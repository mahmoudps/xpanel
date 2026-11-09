import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { requireLinuxRoot, withTrustedDirectory, readTrustedFile, readInstallationReceipt, assertOwnedFile } from './lifecycle-ownership.mjs'
import { assertPreparedReleaseCurrent, preparedReleaseInfo, parsePreparedReleaseInput } from './prepared-release.mjs'
import { observePreparedAdoptionSource } from './install-bootstrap.mjs'
import { withLifecycleWriterAdmission, assertLifecycleWriterAdmissionHeld, withAgentPrivateStateMigrationExclusiveAdmission,
  assertAgentPrivateStateMigrationExclusivePhysicalHeld, observeNormalLifecycleParticipants } from './lifecycle-admission.mjs'
import { observeOwnedControlPlaneUnits, projectOwnedControlPlaneObservation } from './lifecycle-services.mjs'

const TARGET = '/var/lib/xpanel-agent', LIFE = '/var/lib/xpanel-lifecycle', DATABASE = '/var/lib/xpanel/control.db'
const INTENT = LIFE + '/agent-private-state-v1.intent.json', COMPLETE = LIFE + '/agent-private-state-v1.complete.json'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const scopes = new WeakMap(), current = new AsyncLocalStorage()
const sha = raw => createHash('sha256').update(raw).digest('hex')
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const same = (left, right) => canonical(left) === canonical(right)
const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (value, code = 'AGENT_PRIVATE_STATE_UNCONFIRMED') => { if (!value) fail(code) }
const json = value => Buffer.from(JSON.stringify(value) + '\n')
const parse = raw => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
const metadata = value => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(value[key])]))
const directoryIdentity = value => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'nlink', 'size', 'mtimeNs'].map(key => [key, String(value[key])]))
const lifetime = account => Object.fromEntries(['id', 'username', 'uid', 'gid', 'home', 'createdAt', 'primaryDomain', 'ownerId', 'planId'].map(key => [key, account[key]]))

export function parseAgentPrivateStateMigrationArgs(argv) {
  check(Array.isArray(argv) && argv.length === 3 && /^--mode=(?:apply|observe|recover)$/.test(argv[0])
    && typeof argv[1] === 'string' && argv[1].startsWith('--artifact=')
    && typeof argv[2] === 'string' && /^--archive-sha256=[a-f0-9]{64}$/.test(argv[2]), 'AGENT_PRIVATE_STATE_ARGUMENTS_INVALID')
  return Object.freeze({ mode: argv[0].slice(7), artifact: parsePreparedReleaseInput({ artifactPath: argv[1].slice(11), expectedArchiveSha256: argv[2].slice(17) }) })
}

async function processIdentity() {
  requireLinuxRoot()
  check(process.version === 'v26.12.1'
    && !process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'AGENT_PRIVATE_STATE_RUNTIME_REQUIRED')
  const raw = await readFile('/proc/self/stat', 'utf8'), start = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
  const status = await readFile('/proc/self/status', 'utf8')
  check(/^Uid:\s+0\s+0\s+0\s+0\s*$/m.test(status) && /^[1-9][0-9]*$/.test(start ?? ''), 'AGENT_PRIVATE_STATE_PROCESS_UNVERIFIED')
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  check(UUID.test(bootId), 'AGENT_PRIVATE_STATE_PROCESS_UNVERIFIED')
  return { pid: process.pid, start, executable: await readlink('/proc/self/exe'), bootId,
    gid: process.getgid?.(), effectiveGid: process.getegid?.() }
}

async function assertScope(scope) {
  check(scope?.live && current.getStore() === scope, 'AGENT_PRIVATE_STATE_NATIVE_SCOPE_REQUIRED')
  check(same(await processIdentity(), scope.identity), 'AGENT_PRIVATE_STATE_PROCESS_CHANGED')
  await assertPreparedReleaseCurrent(scope.prepared)
  for (const verify of scope.pins) await verify()
}

export async function assertAgentPrivateStateMigrationScope(capability, phase) {
  const scope = capability && typeof capability === 'object' ? scopes.get(capability) : undefined
  check(scope && scope.phase === phase && ['admitting', 'held'].includes(phase), 'AGENT_PRIVATE_STATE_NATIVE_SCOPE_REQUIRED')
  await assertScope(scope)
}

async function absent(path) {
  try { await lstat(path); fail('AGENT_PRIVATE_STATE_RETAINED_ATTENTION') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
async function optional(path) {
  try {
    const value = await readTrustedFile(path, { exactMode: 0o600, maxBytes: 65536 }), parsed = parse(value.bytes)
    check(value.bytes.equals(json(parsed)), 'AGENT_PRIVATE_STATE_RECORD_NONCANONICAL')
    return { value: parsed, sha256: value.sha256 }
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function writeNew(path, value, scope) {
  await assertScope(scope); await assertAgentPrivateStateMigrationExclusivePhysicalHeld(scope.capability)
  const raw = json(value); check(raw.length <= 65536)
  // A lost/partial record is attention, never authority for another effect.
  scope.recordAttempted = true
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.chown(0, 0); await handle.chmod(0o600); await handle.writeFile(raw); await handle.sync() }
  finally { await handle.close() }
  const parent = await open(LIFE, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await parent.sync() } finally { await parent.close() }
  check((await readTrustedFile(path, { exactMode: 0o600, maxBytes: 65536 })).sha256 === sha(raw), 'AGENT_PRIVATE_STATE_RECORD_CHANGED')
  return sha(raw)
}

async function normalParticipants(receipt, apiUid, nodeInfo) {
  const captured = projectOwnedControlPlaneObservation(await observeOwnedControlPlaneUnits(receipt))
  const units = captured.observations.at(-1).units, processes = []
  const release = '/opt/xpanel/releases/' + receipt.source.version
  for (const role of ['api', 'agent']) {
    const unit = units.find(value => value.Id === 'xpanel-' + role + '.service')
    check(unit && unit.ActiveState === 'active' && unit.SubState === 'running' && unit.ControlPID === '0'
      && /^[1-9][0-9]*$/.test(unit.MainPID) && /^[a-f0-9]{32}$/.test(unit.InvocationID)
      && unit.ControlGroup === '/system.slice/xpanel-' + role + '.service', 'AGENT_PRIVATE_STATE_PARTICIPANT_REQUIRED')
    const pid = Number(unit.MainPID), base = '/proc/' + pid, uid = role === 'api' ? apiUid : 0
    const raw = await readFile(base + '/stat', 'utf8'), start = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
    const status = await readFile(base + '/status', 'utf8'), ids = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/m.exec(status)
    const args = (await readFile(base + '/cmdline', 'utf8')).split('\0').filter(Boolean)
    const executable = await stat(base + '/exe', { bigint: true })
    // Inspect only; environment values may contain credentials and are never retained.
    const environmentRaw = await readFile(base + '/environ', 'utf8'), environment = new Map()
    check(Buffer.byteLength(environmentRaw) <= 65536, 'AGENT_PRIVATE_STATE_PARTICIPANT_CHANGED')
    for (const entry of environmentRaw.split('\0').filter(Boolean)) {
      const separator = entry.indexOf('='), name = entry.slice(0, separator)
      check(separator > 0 && !environment.has(name), 'AGENT_PRIVATE_STATE_PARTICIPANT_CHANGED')
      environment.set(name, entry.slice(separator + 1))
    }
    check(environment.get('INVOCATION_ID') === unit.InvocationID && environment.get('NODE_ENV') === 'production'
      && !environment.get('NODE_OPTIONS') && !environment.get('NODE_PATH')
      && (!environment.has('XPANEL_AGENT_SOCKET') || environment.get('XPANEL_AGENT_SOCKET') === '/run/xpanel/agent.sock'), 'AGENT_PRIVATE_STATE_PARTICIPANT_CHANGED')
    check(ids && ids.slice(1).every(value => Number(value) === uid) && /^[1-9][0-9]*$/.test(start ?? '')
      && executable.dev === nodeInfo.dev && executable.ino === nodeInfo.ino
      && await readlink(base + '/exe') === receipt.runtime.nodePath && await readlink(base + '/cwd') === release
      && await readFile(base + '/cgroup', 'utf8') === '0::' + unit.ControlGroup + '\n'
      && args.length >= 2 && args.length <= 4 && await realpath(args[0]) === receipt.runtime.nodePath
      && args.slice(1, -1).every(value => /^--max-(?:old|semi)-space-size=[1-9][0-9]{0,5}$/.test(value))
      && await realpath(args.at(-1)) === release + '/apps/' + role + '/src/main.ts', 'AGENT_PRIVATE_STATE_PARTICIPANT_CHANGED')
    processes.push({ role, pid, start, uid, invocationId: unit.InvocationID, cgroup: unit.ControlGroup })
  }
  await observeNormalLifecycleParticipants(processes, randomUUID())
  for (const value of processes) {
    const raw = await readFile('/proc/' + value.pid + '/stat', 'utf8')
    check(raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19] === value.start, 'AGENT_PRIVATE_STATE_PARTICIPANT_CHANGED')
  }
  return processes
}

async function capture(scope) {
  await assertScope(scope)
  if (scope.phase === 'capturing') await assertLifecycleWriterAdmissionHeld()
  else { check(scope.phase === 'held'); await assertAgentPrivateStateMigrationExclusivePhysicalHeld(scope.capability) }
  const prepared = await observePreparedAdoptionSource(scope.prepared), installed = await readInstallationReceipt()
  const metadataPins = {}
  for (const [name, limit] of [['bootstrap.json', 16384], ['installation.json', 65536], ['HEAD', 16384]])
    metadataPins[name] = await readTrustedFile(LIFE + '/' + name, { exactMode: 0o600, maxBytes: limit })
  const bootstrap = parse(metadataPins['bootstrap.json'].bytes), head = parse(metadataPins.HEAD.bytes), receipt = installed.receipt
  check(same(Object.keys(bootstrap).sort(), ['schemaVersion', 'status', 'createdAt', 'version', 'releaseRoot', 'archiveSha256', 'manifestSha256', 'controlDbSchemaVersion', 'dependencyReceiptSha256', 'runtime'].sort())
    && same(Object.keys(head).sort(), ['schemaVersion', 'issuerId', 'sequence', 'phase', 'operationId', 'reference', 'kind', 'requestFingerprint', 'updatedAt'].sort())
    && typeof head.updatedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(head.updatedAt)
    && Number.isFinite(Date.parse(head.updatedAt)), 'AGENT_PRIVATE_STATE_PENDING_INSTALLATION_REQUIRED')
  check(receipt.status === 'bootstrap_pending' && bootstrap.status === 'bootstrap_pending'
    && !Object.hasOwn(bootstrap, 'finalization') && !Object.hasOwn(bootstrap, 'installationTransition')
    && receipt.lastLifecycleReference === null && installed.sha256 === metadataPins['installation.json'].sha256
    && same(bootstrap, prepared.bootstrap) && bootstrap.version === receipt.source.version
    && bootstrap.archiveSha256 === receipt.source.archiveSha256 && bootstrap.manifestSha256 === receipt.source.manifestSha256
    && bootstrap.dependencyReceiptSha256 === receipt.source.dependencyReceiptSha256
    && bootstrap.controlDbSchemaVersion === receipt.source.controlDbSchemaVersion
    && same(bootstrap.runtime, { nodePath: receipt.runtime.nodePath, nodeSha256: receipt.runtime.nodeSha256 }), 'AGENT_PRIVATE_STATE_PENDING_INSTALLATION_REQUIRED')
  const acquisition = parse((await readTrustedFile(LIFE + '/prepared/' + scope.helper.archiveSha256 + '/intent.json', { exactMode: 0o600, maxBytes: 16384 })).bytes)
  check(acquisition.schemaVersion === 1 && acquisition.kind === 'xpanel-prepared-release-intent'
    && acquisition.installedArchiveSha256 === receipt.source.archiveSha256 && acquisition.archiveSha256 === scope.helper.archiveSha256
    && acquisition.manifestSha256 === scope.helper.manifestSha256 && acquisition.releaseRoot === scope.helper.releaseRoot, 'AGENT_PRIVATE_STATE_ACQUISITION_CHANGED')
  for (const path of [LIFE + '/writer-barrier.json', LIFE + '/backups/retirement-attention.json', '/var/lib/xpanel/upgrade.lock', '/var/lib/xpanel/maintenance.json']) await absent(path)
  for (const file of receipt.files) await assertOwnedFile(file)
  const node = await readTrustedFile(receipt.runtime.nodePath, { maxBytes: 256 * 1024 * 1024, sha256: receipt.runtime.nodeSha256 })
  const dbApi = await import('../packages/db/src/index.ts'), stateApi = await import('../packages/state/src/index.ts')
  const database = await lstat(DATABASE, { bigint: true })
  check(database.isFile() && !database.isSymbolicLink() && database.nlink === 1n && database.uid > 0n && database.gid > 0n
    && (database.mode & 0o7777n) === 0o660n, 'AGENT_PRIVATE_STATE_DATABASE_CHANGED')
  let databaseState
  await dbApi.withReadonlyOperationDatabase(DATABASE, async db => {
    const origin = dbApi.getReadonlyOperationDatabaseOrigin(db)
    check(origin.device === String(database.dev) && origin.inode === String(database.ino)
      && head.schemaVersion === 1 && head.issuerId === origin.issuerId && UUID.test(head.operationId)
      && head.sequence === 0 && head.phase === 'idle' && head.kind === 'adopt' && head.reference === null
      && head.requestFingerprint === sha(JSON.stringify({ source: bootstrap.archiveSha256, manifest: bootstrap.manifestSha256, origin })), 'AGENT_PRIVATE_STATE_HEAD_CHANGED')
    const roots = await db.query("SELECT id FROM principals WHERE kind='root' AND disabled=0 ORDER BY created_at,id LIMIT 2")
    check(roots.length === 1, 'AGENT_PRIVATE_STATE_ROOT_REQUIRED')
    const root = await dbApi.getPrincipal(db, roots[0].id)
    check(root?.kind === 'root' && root.username === 'root' && root.disabled === false && root.forcePasswordChange === false, 'AGENT_PRIVATE_STATE_ROOT_REQUIRED')
    const store = new stateApi.StateStore('/var/lib/xpanel/state')
    await store.withReadonlyObservation(async observation => {
      await observation.assertCurrent()
      const value = observation.snapshot
      databaseState = { origin, rootPrincipalId: root.id, state: { revision: value.revision, checksum: value.checksum,
        accountCount: value.accounts.length, accountLifetimeDigest: sha(canonical(value.accounts.map(lifetime))) } }
      await observation.assertCurrent()
    })
    await dbApi.assertReadonlyOperationDatabaseCurrent(db)
  })
  const processes = await normalParticipants(receipt, Number(database.uid), node.info)
  for (const [name, pin] of Object.entries(metadataPins))
    await readTrustedFile(LIFE + '/' + name, { exactMode: 0o600, maxBytes: 65536, sha256: pin.sha256 })
  await assertScope(scope)
  return { source: receipt.source, runtime: receipt.runtime, helper: scope.helperIdentity, databaseState, processes,
    metadataSha256: Object.fromEntries(Object.entries(metadataPins).map(([name, pin]) => [name, pin.sha256])),
    machineIdSha256: (await readTrustedFile('/etc/machine-id', { maxBytes: 128 })).sha256, bootId: scope.identity.bootId }
}

async function pinTarget() {
  const handle = await open(TARGET, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const verify = async () => {
    const opened = await handle.stat({ bigint: true }), named = await lstat(TARGET, { bigint: true })
    check(opened.isDirectory() && named.isDirectory() && !named.isSymbolicLink() && opened.uid === 0n && opened.gid === 0n
      && [0o755n, 0o700n].includes(opened.mode & 0o7777n) && same(metadata(opened), metadata(named)), 'AGENT_PRIVATE_STATE_DIRECTORY_UNSAFE')
    return opened
  }
  try {
    const original = await verify()
    return { handle, original, verify, async unchanged(mode) {
      const value = await verify()
      check(same(directoryIdentity(value), directoryIdentity(original)) && (value.mode & 0o7777n) === BigInt(mode), 'AGENT_PRIVATE_STATE_DIRECTORY_CHANGED')
      return value
    } }
  } catch (error) { await handle.close(); throw error }
}

function validateIntent(value, binding, target) {
  check(value && value.schemaVersion === 1 && value.kind === 'xpanel-agent-private-state-intent'
    && same(Object.keys(value).sort(), ['schemaVersion', 'kind', 'action', 'operationId', 'binding', 'target', 'fromMode', 'toMode', 'preimage', 'execution', 'createdAt'].sort())
    && value.action === 'root-owned-agent-parent-0755-to-0700' && UUID.test(value.operationId)
    && same(value.binding, binding) && value.target === TARGET && value.fromMode === 0o755 && value.toMode === 0o700
    && same(value.preimage.identity, directoryIdentity(target)) && value.preimage.mode === 0o755
    && same(directoryIdentity(value.preimage.metadata), value.preimage.identity)
    && (BigInt(value.preimage.metadata.mode) & 0o7777n) === 0o755n
    && Number.isSafeInteger(value.execution.pid) && value.execution.pid > 1 && /^[1-9][0-9]*$/.test(value.execution.start)
    && value.execution.bootId === binding.bootId && value.execution.executable === binding.runtime.nodePath
    && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)),
  'AGENT_PRIVATE_STATE_INTENT_CHANGED')
}

async function migrate(scope, target) {
  const binding = await capture(scope)
  check(same(binding, scope.binding), 'AGENT_PRIVATE_STATE_CAPTURE_CHANGED')
  const before = await target.verify(), mode = Number(before.mode & 0o7777n)
  const retained = await optional(INTENT), completed = await optional(COMPLETE)
  if (retained) scope.retainedIntent = true
  check(!completed || retained, 'AGENT_PRIVATE_STATE_COMPLETION_WITHOUT_INTENT')
  if (retained) validateIntent(retained.value, binding, before)
  const result = (status, changed, intentSha256 = null, completionSha256 = null) => ({ schemaVersion: 1,
    kind: 'xpanel-agent-private-state-result', status, changed: changed || scope.recordAttempted,
    targetChanged: changed, journalWritten: scope.recordAttempted, bindingSha256: sha(canonical(binding)),
    archiveScopeRetired: false, terminalVerified: false,
    targetMetadataSha256: sha(canonical(metadata(before))), intentSha256, completionSha256,
    sqliteSidecarWritesExcluded: false, sqlAuditVerified: false, durableJobCreated: false, installationFinalized: false, releaseUpgraded: false, nativeCapabilityAcceptance: false })
  const currentResult = async (...args) => {
    await target.unchanged(mode)
    check(same(await capture(scope), binding), 'AGENT_PRIVATE_STATE_CAPTURE_CHANGED')
    return result(...args)
  }
  const claimRecovery = async value => {
    const entries = await readdir(LIFE)
    check(entries.length <= 4096, 'AGENT_PRIVATE_STATE_RECOVERY_CAPACITY')
    const claims = entries.filter(name => /^agent-private-state-v1\.recovery-[a-f0-9-]+\.json$/.test(name))
    check(claims.length < 16, 'AGENT_PRIVATE_STATE_RECOVERY_CAPACITY')
    return writeNew(LIFE + '/agent-private-state-v1.recovery-' + randomUUID() + '.json', value, scope)
  }
  if (completed) {
    check(scope.mode !== 'apply', 'AGENT_PRIVATE_STATE_EXISTING_EXECUTION_REQUIRES_OBSERVATION')
    check(mode === 0o700 && completed.value.schemaVersion === 1 && completed.value.kind === 'xpanel-agent-private-state-completion'
      && completed.value.intentSha256 === retained.sha256 && completed.value.operationId === retained.value.operationId
      && completed.value.bindingSha256 === sha(canonical(binding)) && same(completed.value.directoryIdentity, directoryIdentity(before))
      && completed.value.targetMetadataSha256 === sha(canonical(metadata(before)))
      && completed.value.effectVerified === true && completed.value.archiveScopeRetired === false
      && ['sqlAuditVerified', 'durableJobCreated', 'installationFinalized', 'releaseUpgraded', 'nativeCapabilityAcceptance'].every(key => completed.value[key] === false),
    'AGENT_PRIVATE_STATE_COMPLETION_CHANGED')
    if (scope.mode === 'observe') return currentResult('effect_observed_retirement_unconfirmed', false, retained.sha256, completed.sha256)
    // Explicit recovery produces a new execution. An old effect checkpoint
    // never proves that the first invocation retired its archive or exited.
    await claimRecovery({ schemaVersion: 1,
      kind: 'xpanel-agent-private-state-recovery', intentSha256: retained.sha256, priorEffectCheckpointSha256: completed.sha256,
      operationId: retained.value.operationId, execution: scope.identity, observedMode: mode, bindingSha256: sha(canonical(binding)),
      effectVerified: true, archiveScopeRetired: false, createdAt: new Date().toISOString() })
    return currentResult('effect_verified', false, retained.sha256, completed.sha256)
  }
  if (scope.mode === 'observe') return currentResult(retained ? 'attention_incomplete' : mode === 0o700 ? 'already_private' : 'legacy_pending', false, retained?.sha256 ?? null)
  if (!retained && mode === 0o700) { check(scope.mode === 'apply', 'AGENT_PRIVATE_STATE_RECOVERY_INTENT_REQUIRED'); return currentResult('already_private', false) }
  check(scope.mode === 'recover' ? retained !== null : retained === null, 'AGENT_PRIVATE_STATE_EXPLICIT_RECOVERY_REQUIRED')
  let intent = retained?.value, intentSha256 = retained?.sha256
  if (!intent) {
    check(mode === 0o755, 'AGENT_PRIVATE_STATE_LEGACY_MODE_REQUIRED')
    intent = { schemaVersion: 1, kind: 'xpanel-agent-private-state-intent', action: 'root-owned-agent-parent-0755-to-0700',
      operationId: randomUUID(), binding, target: TARGET, fromMode: 0o755, toMode: 0o700,
      preimage: { identity: directoryIdentity(before), metadata: metadata(before), mode: 0o755 }, execution: scope.identity, createdAt: new Date().toISOString() }
    intentSha256 = await writeNew(INTENT, intent, scope)
  } else {
    await claimRecovery({ schemaVersion: 1,
      kind: 'xpanel-agent-private-state-recovery', intentSha256, operationId: intent.operationId, execution: scope.identity,
      observedMode: mode, createdAt: new Date().toISOString() })
  }
  check(same(await capture(scope), binding), 'AGENT_PRIVATE_STATE_CAPTURE_CHANGED')
  await target.unchanged(mode)
  if (mode === 0o755) {
    scope.effectAttempted = true
    await target.handle.chmod(0o700)
    await target.handle.sync()
  }
  const after = await target.unchanged(0o700)
  check(same(await capture(scope), binding), 'AGENT_PRIVATE_STATE_CAPTURE_CHANGED')
  const completionSha256 = await writeNew(COMPLETE, { schemaVersion: 1, kind: 'xpanel-agent-private-state-completion',
    operationId: intent.operationId, intentSha256, bindingSha256: sha(canonical(binding)), directoryIdentity: directoryIdentity(after),
    targetMetadataSha256: sha(canonical(metadata(after))), execution: scope.identity, completedAt: new Date().toISOString(),
    effectVerified: true, archiveScopeRetired: false,
    sqlAuditVerified: false, durableJobCreated: false, installationFinalized: false, releaseUpgraded: false, nativeCapabilityAcceptance: false }, scope)
  await target.unchanged(0o700)
  check(same(await capture(scope), binding), 'AGENT_PRIVATE_STATE_CAPTURE_CHANGED')
  return { ...result('effect_verified', scope.effectAttempted, intentSha256, completionSha256), targetMetadataSha256: sha(canonical(metadata(after))) }
}

export async function runAgentPrivateStateMigration(prepared, request) {
  let scope, target, trustedIngress = false
  try {
    const identity = await processIdentity()
    await assertPreparedReleaseCurrent(prepared)
    trustedIngress = true
    const helper = preparedReleaseInfo(prepared)
    const parsed = parseAgentPrivateStateMigrationArgs(process.argv.slice(2))
    check(same(parsed, request) && helper.artifactPath === request.artifact.artifactPath && helper.archiveSha256 === request.artifact.expectedArchiveSha256
      && identity.executable === helper.runtime.nodePath && await realpath(process.execPath) === helper.runtime.nodePath
      && await realpath(fileURLToPath(import.meta.url)) === helper.releaseRoot + '/scripts/agent-private-state-migration.mjs'
      && process.argv[1] === helper.releaseRoot + '/scripts/agent-private-state-migration-entry.mjs', 'AGENT_PRIVATE_STATE_HELPER_REQUIRED')
    const capability = Object.freeze(Object.create(null))
    scope = { prepared, helper, helperIdentity: Object.fromEntries(['version', 'archiveSha256', 'manifestSha256', 'dependencyReceiptSha256', 'sourceFilesDigest'].map(key => [key, helper[key]])),
      capability, identity, mode: request.mode, live: true, phase: 'capturing', pins: [], recordAttempted: false, effectAttempted: false }
    scopes.set(capability, scope)
    return await current.run(scope, () => withTrustedDirectory('/var/lib', async parent => withTrustedDirectory(LIFE, async life => {
      scope.pins = [parent.verify, life.verify]
      scope.binding = await withLifecycleWriterAdmission(() => capture(scope))
      scope.phase = 'admitting'
      return withAgentPrivateStateMigrationExclusiveAdmission(capability, async () => {
        scope.phase = 'held'
        await assertAgentPrivateStateMigrationExclusivePhysicalHeld(capability)
        target = await pinTarget()
        try { return await migrate(scope, target) } finally { await target.handle.close(); target = null }
      })
    })))
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'AGENT_PRIVATE_STATE_UNVERIFIED'
    return { schemaVersion: 1, kind: 'xpanel-agent-private-state-result', status: trustedIngress ? 'attention' : 'blocked',
      code, changed: trustedIngress ? null : false, previousEffectsUnknown: true,
      targetChanged: trustedIngress ? null : false, journalWritten: trustedIngress ? null : false,
      sqliteSidecarWritesExcluded: false, sqlAuditVerified: false, durableJobCreated: false,
      installationFinalized: false, releaseUpgraded: false, nativeCapabilityAcceptance: false }
  } finally {
    if (scope) { scope.live = false; scope.phase = 'closed'; scopes.delete(scope.capability) }
    if (target) await target.handle.close()
  }
}
