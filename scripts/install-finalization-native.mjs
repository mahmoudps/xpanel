import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile, readlink, realpath, lstat, rename } from 'node:fs/promises'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireLinuxRoot, withTrustedDirectory, withTrustedFile, readTrustedFile, readInstallationReceipt, assertOwnedFile } from './lifecycle-ownership.mjs'
import { withLifecycleWriterAdmission, assertLifecycleWriterAdmissionHeld, withInstallFinalizationExclusiveAdmission, assertInstallFinalizationExclusivePhysicalHeld, assertInstallFinalizationExclusiveHeld, verifyInstallFinalizationParticipants } from './lifecycle-admission.mjs'
import { runPreparedInstallFinalization, runPreparedInstallAdoption, installAdoptionAccountLifetimeDigest, assertInstallAdoptionState, installAdoptionSubjectDigest, inspectInstallFinalizationRecovery, installFinalizationSubjectDigest, INSTALL_FINALIZATION_PATHS as PATHS } from './install-finalization.mjs'

import { ensurePreparedInstallParticipants, settlePreparedInstallReadiness, verifyPreparedInstallStartupSources } from './install-startup.mjs'

const ROOT = '/var/lib/xpanel-lifecycle', DATABASE = '/var/lib/xpanel/control.db', STATE = '/var/lib/xpanel/state'
const SHA = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const scopes = new WeakMap(), active = new AsyncLocalStorage()
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (condition, code) => { if (!condition) fail(code) }
const record = (value, keys) => check(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value')), 'INSTALL_FINALIZATION_REQUEST_INVALID')
const canonicalPath = path => typeof path === 'string' && path.length <= 4096 && posix.isAbsolute(path) && posix.normalize(path) === path && !/[\\\x00-\x20\x7f]/.test(path)

export function parseNativeInstallFinalizationRequest(value) { return parseFinalizationRequest(value, 'install') }
export function parseNativePreparedAdoptionRequest(value) { return parseFinalizationRequest(value, 'adopt') }
function parseFinalizationRequest(value, command) {
  record(value, ['schemaVersion', 'command', 'mode', 'json', 'assumeYes', 'artifact'])
  check(value.schemaVersion === 1 && value.command === command && value.mode === 'apply' && value.assumeYes === true && typeof value.json === 'boolean', 'INSTALL_FINALIZATION_REQUEST_INVALID')
  record(value.artifact, ['path', 'expectedArchiveSha256', 'keyId', 'signingKeyPath'])
  check(canonicalPath(value.artifact.path) && value.artifact.path.endsWith('.tar.gz') && !/^\/(?:home(?:[0-9]+)?|tmp|var\/tmp)(?:\/|$)/.test(value.artifact.path)
    && SHA.test(value.artifact.expectedArchiveSha256) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.artifact.keyId)
    && canonicalPath(value.artifact.signingKeyPath), 'INSTALL_FINALIZATION_ARTIFACT_INVALID')
  // Common CLI grammar only: this path is never read as authority. Installed trust is fixed below.
  return Object.freeze({ ...value, artifact: Object.freeze({ ...value.artifact }) })
}

export function installOwnershipCompletionSummary(kind) {
  check(kind === 'install' || kind === 'adopt', 'INSTALL_FINALIZATION_KIND_INVALID')
  return kind === 'adopt' ? 'Observed populated-installation adoption finalized' : 'Observed fresh-install ownership finalized'
}

export function installFinalizationMetadataTarget(path, jobId) {
  if (Object.values(PATHS).includes(path)) return Object.freeze({ path, temporary: false, sha256: null })
  if (!UUID.test(jobId ?? '')) return null
  for (const target of Object.values(PATHS)) {
    const prefix = target + '.install-' + jobId + '-'
    if (typeof path === 'string' && path.startsWith(prefix) && path.endsWith('.tmp')) {
      const hash = path.slice(prefix.length, -4)
      if (SHA.test(hash)) return Object.freeze({ path: target, temporary: true, sha256: hash })
    }
  }
  return null
}


/** Fixed, read-only source pins. This helper does not mint native authority. */
export async function withInstallFinalizationStateDirectories(uid, gid, run) {
  check(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0 && typeof run === 'function', 'INSTALL_STATE_IDENTITY_INVALID')
  return withTrustedDirectory('/var/lib', async ancestor => {
    const pins = []
    const safe = (value, mode) => value.isDirectory() && !value.isSymbolicLink()
      && value.uid === BigInt(uid) && value.gid === BigInt(gid) && Number(value.mode & 0o7777n) === mode
    const verify = async () => {
      await ancestor.verify()
      for (const pin of pins) {
        const [opened, named, actual] = await Promise.all([pin.handle.stat({ bigint: true }), lstat(pin.path, { bigint: true }), realpath(pin.path)])
        check(safe(opened, pin.mode) && safe(named, pin.mode) && actual === pin.path
          && opened.dev === pin.device && opened.ino === pin.inode
          && named.dev === pin.device && named.ino === pin.inode, 'INSTALL_STATE_DIRECTORY_CHANGED')
      }
      await ancestor.verify()
    }
    try {
      await ancestor.verify()
      for (const [path, modes] of [['/var/lib/xpanel', [0o2770, 0o2750]], [STATE, [0o2750]]]) {
        const named = await lstat(path, { bigint: true })
        // Startup narrows the legacy parent to 02750. Accept either exact installed
        // image initially; pin the observed mode, so even that narrowing is drift here.
        const mode = Number(named.mode & 0o7777n)
        check(modes.includes(mode) && safe(named, mode) && await realpath(path) === path, 'INSTALL_STATE_DIRECTORY_UNSAFE')
        const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        const pin = { path, mode, handle, device: named.dev, inode: named.ino }
        pins.push(pin)
        await verify()
      }
      const result = await run(Object.freeze({ verify }))
      await verify()
      return result
    } finally {
      const closed = await Promise.allSettled([...pins].reverse().map(pin => pin.handle.close()))
      const failures = closed.filter(item => item.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(item => item.reason), 'install state directory handles did not retire')
    }
  })
}

async function processIdentity() {
  requireLinuxRoot()
  check(process.version === 'v26.12.1' && !process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'INSTALL_PINNED_RUNTIME_REQUIRED')
  check(await readlink('/proc/self') === String(process.pid), 'INSTALL_PROC_IDENTITY_INVALID')
  const [status, stat, executable] = await Promise.all([readFile('/proc/self/status', 'utf8'), readFile('/proc/self/stat', 'utf8'), readlink('/proc/self/exe')])
  const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
  check(/^Uid:\s+0\s+0\s+0\s+0\s*$/m.test(status) && /^[0-9]+$/.test(start ?? '') && executable === await realpath(process.execPath), 'INSTALL_PROC_IDENTITY_INVALID')
  return { pid: process.pid, start, executable }
}

async function assertBase(scope) {
  check(scope.live && active.getStore() === scope, 'INSTALL_FINALIZATION_NATIVE_SCOPE_REQUIRED')
  check(canonical(await processIdentity()) === canonical(scope.identity), 'INSTALL_FINALIZATION_PROCESS_CHANGED')
  for (const verify of scope.pins) await verify()
  if (scope.helperCapability) await scope.bootstrapApi.assertPreparedReleaseCurrent(scope.helperCapability)
  if (scope.databasePin) {
    const [opened, named] = await Promise.all([scope.databasePin.stat({ bigint: true }), lstat(DATABASE, { bigint: true })])
    const expected = scope.databaseInfo
    check(opened.dev === expected.dev && opened.ino === expected.ino && named.dev === expected.dev && named.ino === expected.ino
      && !named.isSymbolicLink() && named.uid === expected.uid && named.gid === expected.gid && named.mode === expected.mode && named.nlink === 1n, 'INSTALL_DATABASE_CHANGED')
  }
  if (scope.context) check(await readlink('/opt/xpanel/current') === '/opt/xpanel/releases/' + scope.context.source.version
    && await realpath('/opt/xpanel/current') === '/opt/xpanel/releases/' + scope.context.source.version, 'INSTALL_CURRENT_CHANGED')
}

export async function assertInstallFinalizationNativeScope(capability, phase) {
  const scope = capability && typeof capability === 'object' ? scopes.get(capability) : undefined
  check(scope && active.getStore() === scope && scope.live, 'INSTALL_FINALIZATION_NATIVE_SCOPE_REQUIRED')
  check(phase === 'admission' && scope.phase === 'admitting' && !scope.db && !scope.databaseAccess || phase === 'held' && scope.phase === 'held' && scope.guard, 'INSTALL_FINALIZATION_NATIVE_PHASE_INVALID')
  await assertBase(scope)
  if (phase === 'held') await scope.dbApi.assertHostOperationGuardHeld(scope.guard, scope.originBinding)
}

/** Only the fixed adoption factory can bind a populated readiness observation to this live scope. */
export async function assertInstallAdoptionReadinessScope(capability, context, phase) {
  const scope = capability && typeof capability === 'object' ? scopes.get(capability) : undefined
  check(scope && scope.kind === 'adopt' && scope.helperCapability && scope.live && active.getStore() === scope
    && scope.phase === phase && ['capturing', 'held'].includes(phase)
    && canonical(context) === canonical(scope.context), 'INSTALL_ADOPTION_NATIVE_SCOPE_REQUIRED')
  await assertBase(scope)
  await assertCapturedInstallSource(scope)
  if (phase === 'held') await assertInstallFinalizationExclusiveHeld(capability)
}

export function installFinalizationNativeInfo(capability) {
  const scope = capability && typeof capability === 'object' ? scopes.get(capability) : undefined
  check(scope && scope.live && active.getStore() === scope && scope.phase === 'held' && scope.observation, 'INSTALL_FINALIZATION_NATIVE_SCOPE_REQUIRED')
  return Object.freeze({ probeId: scope.probeId, processes: Object.freeze(scope.observation.processes.map(process => Object.freeze({ ...process }))) })
}

const metadataLimit = path => path === PATHS.bootstrap ? 16 * 1024 : 64 * 1024
async function metadata(path) { return readTrustedFile(path, { exactMode: 0o600, maxBytes: metadataLimit(path) }) }
const bindingFor = origin => ({ databaseFile: origin.file, databaseDevice: origin.device, databaseInode: origin.inode, issuerId: origin.issuerId })
function assertTime(scope) { check(scope.observation && Date.now() < Date.parse(scope.observation.expiresAt), 'INSTALL_FINALIZATION_OBSERVATION_EXPIRED') }
function lifecycleBinding(scope, job) { return { purpose: 'host.lifecycle.intent', jobId: job.id, requestFingerprint: scope.subject, action: 'lifecycle.adopt', principalId: scope.context.rootPrincipalId } }

// Connections are local to one actual admission phase. No SQL handle crosses SH -> EX.
async function assertDatabasePhase(scope) {
  await assertBase(scope)
  if (scope.phase === 'capturing') await assertLifecycleWriterAdmissionHeld()
  else {
    check(['admitting', 'held', 'retiring'].includes(scope.phase), 'INSTALL_FINALIZATION_DATABASE_PHASE_INVALID')
    await assertInstallFinalizationExclusivePhysicalHeld(scope.capability)
  }
}
async function bindDatabase(scope, db, access) {
  check(!scope.db && !scope.databaseAccess, 'INSTALL_FINALIZATION_DATABASE_SCOPE_CONFLICT')
  scope.db = db; scope.databaseAccess = access
  const origin = access === 'readonly' ? scope.dbApi.getReadonlyOperationDatabaseOrigin(db)
    : await db.transaction(tx => scope.dbApi.getStrictOperationDatabaseOrigin(tx))
  check(origin.file === DATABASE && origin.device === String(scope.databaseInfo.dev)
    && origin.inode === String(scope.databaseInfo.ino), 'INSTALL_DATABASE_CHANGED')
  if (scope.originBinding) check(canonical(bindingFor(origin)) === canonical(scope.originBinding), 'INSTALL_FINALIZATION_DATABASE_CHANGED')
  const principal = await db.transaction(async tx => {
    const roots = await tx.query("SELECT id FROM principals WHERE kind='root' AND disabled=0 ORDER BY created_at,id LIMIT 2")
    check(roots.length === 1, 'INSTALL_FINALIZATION_ROOT_REQUIRED')
    const root = await scope.dbApi.getPrincipal(tx, roots[0].id)
    check(root?.kind === 'root' && root.disabled === false && root.forcePasswordChange === false, 'INSTALL_FINALIZATION_ROOT_REQUIRED')
    return root
  })
  if (scope.root) check(principal.id === scope.root.id && principal.username === scope.root.username, 'INSTALL_FINALIZATION_ROOT_CHANGED')
  scope.origin = origin; scope.originBinding = bindingFor(origin); scope.root = principal
}
function unbindDatabase(scope) { scope.db = null; scope.databaseAccess = null; scope.audit = null }
async function withFinalizationReadonlyDatabase(scope, run) {
  await assertDatabasePhase(scope)
  check(scope.phase === 'capturing' && !scope.db, 'INSTALL_FINALIZATION_DATABASE_SCOPE_CONFLICT')
  return scope.dbApi.withReadonlyOperationDatabase(DATABASE, async db => {
    try {
      await bindDatabase(scope, db, 'readonly')
      await assertDatabasePhase(scope)
      const result = await run()
      await scope.dbApi.assertReadonlyOperationDatabaseCurrent(db)
      await assertDatabasePhase(scope)
      return result
    } finally { unbindDatabase(scope) }
  })
}
async function withFinalizationWriterDatabase(scope, run) {
  await assertDatabasePhase(scope)
  check(!scope.db && !scope.databaseAccess, 'INSTALL_FINALIZATION_DATABASE_SCOPE_CONFLICT')
  if (scope.phase === 'capturing') {
    // Existing fresh-startup SH is the sole write exception before readiness.
    // The readonly state gate precedes even SQLite connection initialization.
    check(scope.kind === 'install' && scope.startupDeadline && Date.now() < scope.startupDeadline, 'INSTALL_STARTUP_SCOPE_REQUIRED')
    check((await readScopeSnapshot(scope)).accounts.length === 0, 'INSTALL_FINALIZATION_STATE_CHANGED')
  } else check(scope.phase === 'admitting', 'INSTALL_FINALIZATION_DATABASE_PHASE_INVALID')
  await assertDatabasePhase(scope)
  scope.changed = true // SQLite setup may persist WAL state even if a later check fails.
  const handle = scope.dbApi.createDb(DATABASE, { durability: 'strict' })
  try {
    await bindDatabase(scope, handle.db, 'writer')
    await assertDatabasePhase(scope)
    return await run()
  } finally {
    // Retire audit objects tied to this runner together with the connection.
    // Receipts remain bound to the same persistent origin and are rechecked in EX.
    try { await handle.close() } finally { unbindDatabase(scope) }
  }
}

async function rootInTransaction(scope, tx) {
  if (scope.guard) scope.dbApi.assertHostOperationGuardActive(scope.guard, scope.originBinding)
  const origin = scope.databaseAccess === 'readonly' ? scope.dbApi.getReadonlyOperationDatabaseOrigin(tx) : await scope.dbApi.getStrictOperationDatabaseOrigin(tx)
  check(canonical(bindingFor(origin)) === canonical(scope.originBinding), 'INSTALL_FINALIZATION_DATABASE_CHANGED')
  const rows = await tx.query("SELECT id FROM principals WHERE kind='root' AND disabled=0 ORDER BY created_at,id LIMIT 2")
  check(rows.length === 1 && rows[0].id === scope.root.id, 'INSTALL_FINALIZATION_ROOT_CHANGED')
  const principal = await scope.dbApi.getPrincipal(tx, scope.root.id)
  check(principal?.kind === 'root' && principal.disabled === false && principal.forcePasswordChange === false && principal.username === scope.root.username, 'INSTALL_FINALIZATION_ROOT_CHANGED')
  if (scope.guard) scope.dbApi.assertHostOperationGuardActive(scope.guard, scope.originBinding)
  return principal
}

function assertCompletionScope(scope) {
  check(scope.live && active.getStore() === scope && scope.phase === 'held' && scope.guard
    && process.platform === 'linux' && process.getuid() === 0 && process.geteuid() === 0, 'INSTALL_FINALIZATION_NATIVE_SCOPE_REQUIRED')
  scope.dbApi.assertHostOperationGuardActive(scope.guard, scope.originBinding)
  assertTime(scope)
}

/** Pure persisted-proof check; does not grant authority or establish native readiness. */
export function assertInstallOwnershipCompletionProof(kind, subject, intent, job) {
  check(kind === 'install' || kind === 'adopt', 'INSTALL_FINALIZATION_KIND_INVALID')
  const subjectDigest = kind === 'adopt' ? installAdoptionSubjectDigest : installFinalizationSubjectDigest
  const proof = job.detail?.installFinalization, recorded = job.checkpointData?.installFinalization
  const evidence = job.checkpointData?.installFinalizationEvidence
  check(intent && proof && recorded && evidence && SHA.test(proof.observationDigest ?? '')
    && proof.receiptSha256 === intent.expectedActiveSha256
    && recorded.subjectDigest === subject && recorded.receiptSha256 === proof.receiptSha256
    && recorded.observationDigest === proof.observationDigest
    && evidence.observation?.subjectDigest === subject
    && subjectDigest(evidence.context, intent.previousReceiptSha256) === subject
    && digest(canonical(evidence.observation)) === proof.observationDigest, 'INSTALL_FINALIZATION_JOB_PROOF_CHANGED')
}

function checkCompletionProof(scope, job) {
  assertInstallOwnershipCompletionProof(scope.kind, scope.subject, scope.intent, job)
}

function checkJob(scope, job) {
  check(job && job.kind === 'lifecycle.adopt' && job.actor === scope.root.username && job.accountId === null && job.requestFingerprint === scope.subject
    && job.referenceCode && canonical(job.detail?.lifecycleIntent) === canonical(lifecycleBinding(scope, job))
    && job.detail?.installFinalization?.subjectDigest === scope.subject && job.detail.installFinalization.rootPrincipalId === scope.root.id, 'INSTALL_FINALIZATION_JOB_CHANGED')
  if (scope.intent) check(job.id === scope.intent.jobId && job.referenceCode === scope.intent.reference && job.createdAt === scope.intent.createdAt, 'INSTALL_FINALIZATION_JOB_CHANGED')
  check(!job.cancelRequested && !job.needsAttention && !['failed', 'cancelled'].includes(job.status), 'INSTALL_FINALIZATION_JOB_REQUIRES_REVIEW')
  if (job.status === 'succeeded') {
    checkCompletionProof(scope, job)
  } else {
    check(job.status === 'running' && job.leaseOwner === scope.workerId && job.fencingToken === scope.leaseFence
      && Number.isFinite(Date.parse(job.leaseExpiresAt)) && Date.parse(job.leaseExpiresAt) > Date.now(), 'INSTALL_FINALIZATION_LEASE_CHANGED')
  }
}

async function claim(scope, row) {
  check(row && row.requestFingerprint === scope.subject, 'INSTALL_FINALIZATION_JOB_CHANGED')
  if (row.status === 'succeeded') { scope.job = row; checkJob(scope, row) }
  else {
    scope.changed = true
    scope.job = await scope.dbApi.acquireJobLease(scope.db, { jobId: row.id, workerId: scope.workerId, leaseDurationMs: scope.startupActive ? 120_000 : 30_000 })
    check(scope.job, 'INSTALL_FINALIZATION_LEASE_UNAVAILABLE')
    scope.leaseFence = scope.job.fencingToken; checkJob(scope, scope.job)
  }
  scope.operationBinding = lifecycleBinding(scope, scope.job)
  scope.audit ??= await scope.dbApi.createRootOperationAuditAuthority(scope.db)
  scope.intentReceipt = scope.job.status === 'succeeded'
    ? await scope.audit.recoverLifecycleIntent(scope.operationBinding)
    : await scope.audit.appendLifecycleIntent(scope.operationBinding)
  await scope.db.transaction(async tx => { await rootInTransaction(scope, tx); scope.dbApi.assertOperationIntentReceipt(scope.intentReceipt, scope.operationBinding, tx); assertInstallOperationWindow(scope) })
  return scope.job
}


function assertInstallOperationWindow(scope) {
  if (scope.observation) return assertTime(scope)
  check(scope.startupActive && scope.guard && Date.now() < scope.startupDeadline, 'INSTALL_STARTUP_AUTHORITY_EXPIRED')
}
const lifetimeOf = account => Object.fromEntries(['id', 'username', 'uid', 'gid', 'home', 'createdAt', 'primaryDomain', 'ownerId', 'planId'].map(key => [key, account[key]]))
const adoptionState = snapshot => ({ revision: snapshot.revision, checksum: snapshot.checksum, accounts: snapshot.accounts.map(lifetimeOf) })
async function readScopeSnapshot(scope) {
  await assertDatabasePhase(scope)
  return scope.store.withReadonlyObservation(async observation => {
    await observation.assertCurrent()
    const snapshot = structuredClone(observation.snapshot)
    await observation.assertCurrent()
    return snapshot
  })
}

async function assertCapturedInstallSource(scope) {
  for (const [path, expected] of scope.expected) check((await metadata(path)).sha256 === expected, 'INSTALL_FINALIZATION_METADATA_CHANGED')
  for (const owned of scope.receipt.files) await assertOwnedFile(owned)
  await scope.stateDirectories.verify()
  const snapshot = await readScopeSnapshot(scope)
  await scope.stateDirectories.verify()
  if (scope.kind === 'adopt') assertInstallAdoptionState(scope.context, adoptionState(snapshot))
  else check(snapshot.revision === scope.context.state.revision && snapshot.checksum === scope.context.state.checksum && snapshot.accounts.length === 0, 'INSTALL_FINALIZATION_STATE_CHANGED')
}
async function assertInstallCaptureCurrent(scope, requireStartupGuard = false) {
  check(scope.phase === 'capturing' && scope.context && scope.live, 'INSTALL_STARTUP_SCOPE_REQUIRED')
  if (requireStartupGuard) check(scope.startupActive && scope.guard, 'INSTALL_STARTUP_SCOPE_REQUIRED')
  await assertBase(scope)
  if (scope.guard) await scope.dbApi.assertHostOperationGuardHeld(scope.guard, scope.originBinding)
  await assertCapturedInstallSource(scope)
  await scope.db.transaction(async tx => {
    await rootInTransaction(scope, tx)
    if (scope.job) checkJob(scope, await scope.dbApi.getDurableJob(tx, scope.job.id))
    if (scope.intentReceipt && scope.databaseAccess === 'writer') scope.dbApi.assertOperationIntentReceipt(scope.intentReceipt, scope.operationBinding, tx)
    if (scope.startupActive) assertInstallOperationWindow(scope)
  })
  if (scope.intentReceipt && scope.databaseAccess === 'readonly') {
    // Readonly evidence cannot be checked by a strict-write transaction assertion.
    // The native observer rejects pending root-audit repair instead of performing it.
    await scope.dbApi.withReadonlyLifecycleIntentObservation(scope.db, scope.operationBinding, async observation => {
      await observation.assertCurrent()
    })
  }
}
export async function assertInstallFinalizationStartupScope(capability, unit) {
  const scope = capability && typeof capability === 'object' ? scopes.get(capability) : undefined
  check(scope && active.getStore() === scope && scope.live && scope.phase === 'capturing'
    && scope.startupActive && scope.guard && scope.job && ['xpanel-api.service','xpanel-agent.service'].includes(unit), 'INSTALL_STARTUP_SCOPE_REQUIRED')
  await assertInstallCaptureCurrent(scope, true)
  return Object.freeze({ receipt: structuredClone(scope.receipt), operationId: scope.job.id, serviceGid: Number(scope.databaseInfo.gid) })
}
export function assertInstallFinalizationStartupRetirement(capability) {
  const scope = capability && typeof capability === 'object' ? scopes.get(capability) : undefined
  check(scope && active.getStore() === scope && scope.live && scope.phase === 'capturing' && scope.startupActive && scope.guard, 'INSTALL_STARTUP_SCOPE_REQUIRED')
}
async function recordInstallStartup(scope, unit, phase, observation) {
  await assertInstallCaptureCurrent(scope, true)
  scope.startupStates ??= {}
  scope.startupStates[unit] = { phase, ...(observation ? { observation } : {}) }
  await scope.dbApi.saveJobCheckpoint(scope.db, {
    jobId: scope.job.id, workerId: scope.workerId, fencingToken: scope.leaseFence,
    step: 'install-start-' + (phase === 'dispatch-intent' ? 'intent-' : 'observed-') + (unit === 'xpanel-api.service' ? 'api' : 'agent'),
    data: { installStartup: { sourceSha256: scope.context.source.archiveSha256, units: scope.startupStates } },
  })
  await assertInstallCaptureCurrent(scope, true)
}
async function startPreparedInstallScope(scope) {
  const services = await import('./lifecycle-services.mjs')
  return active.run(scope, async () => {
    check(scope.phase === 'new', 'INSTALL_STARTUP_SCOPE_REQUIRED')
    scope.phase = 'capturing'; scope.startupDeadline = Date.now() + 90_000
    try {
      // This SH scope contains service effects and unit-state observation only, never health.
      await withLifecycleWriterAdmission(() => withFinalizationWriterDatabase(scope, async () => {
        await ports(scope).capturePrepared()
        if (scope.receipt.status !== 'bootstrap_pending' || scope.preparedBootstrap.status !== 'bootstrap_pending') return
        const result = await ensurePreparedInstallParticipants({
          observe: async () => {
            await assertInstallCaptureCurrent(scope)
            const capture = await services.observeOwnedControlPlaneUnits(scope.receipt)
            return services.projectOwnedControlPlaneObservation(capture).observations.at(-1).units.filter(unit => ['xpanel-api.service','xpanel-agent.service'].includes(unit.Id))
          },
          withStartAuthority: async run => scope.dbApi.withHostOperationGuard(scope.db, { acquireTimeoutMs: 1, retryIntervalMs: 1 }, async guard => {
            scope.guard = guard; scope.startupActive = true
            try {
              await assertInstallCaptureCurrent(scope, true)
              if (!scope.job) {
                if (scope.seedIntent) {
                  scope.intent = scope.seedIntent
                  const row = await scope.dbApi.getDurableJob(scope.db, scope.seedIntent.jobId)
                  check(row?.status !== 'succeeded', 'INSTALL_STARTUP_JOB_REQUIRES_REVIEW')
                  await claim(scope, row)
                } else await allocateInstallJob(scope)
              }
              await run()
            } finally {
              try { await services.awaitPreparedInstallServiceChildren(scope.capability) }
              finally { scope.startupActive = false; scope.guard = null }
            }
          }),
          current: () => assertInstallCaptureCurrent(scope, scope.startupActive === true),
          recordIntent: unit => recordInstallStartup(scope, unit, 'dispatch-intent'),
          start: unit => { scope.changed = true; scope.startupDispatched = true; return services.startPreparedInstallParticipant(scope.capability, unit) },
          recordObserved: (unit, observation) => recordInstallStartup(scope, unit, 'observed-running', observation),
        })
        scope.startupRequested = result.requiresSettling
      }))
    } finally {
      // The startup SH, physical guard and every service child are retired before normal
      // runPreparedInstallFinalization is allowed to obtain its own fresh readiness SH.
      scope.phase = 'new'; scope.startupActive = false; scope.guard = null; scope.startupDeadline = null
    }
  })
}

async function allocateInstallJob(scope) {
  const id = randomUUID(), binding = lifecycleBinding(scope, { id })
  scope.changed = true
  const job = await scope.dbApi.enqueueDurableJob(scope.db, { id, kind: 'lifecycle.adopt', actor: scope.root.username,
    idempotencyKey: 'install-finalization:' + scope.subject, requestFingerprint: scope.subject, targetRevision: scope.context.state.revision,
    summary: scope.kind === 'adopt' ? 'Finalize observed populated-installation adoption' : 'Finalize observed fresh-install ownership', detail: { lifecycleIntent: binding, installFinalization: { subjectDigest: scope.subject, rootPrincipalId: scope.root.id } } },
    async (tx, row) => { await rootInTransaction(scope, tx); check(row.requestFingerprint === scope.subject && canonical(row.detail.lifecycleIntent) === canonical(lifecycleBinding(scope, row)), 'INSTALL_FINALIZATION_JOB_CHANGED'); assertInstallOperationWindow(scope) })
  check(job.status !== 'succeeded', 'INSTALL_FINALIZATION_JOB_REQUIRES_REVIEW')
  await claim(scope, job)
}

async function assertCurrent(scope, context, observation, intent) {
  check(scope.phase === 'held' && canonical(context) === canonical(scope.context) && canonical(observation) === canonical(scope.observation), 'INSTALL_FINALIZATION_CAPTURE_CHANGED')
  if (intent) { check(intent.subjectDigest === scope.subject, 'INSTALL_FINALIZATION_INTENT_CHANGED'); scope.intent = intent }
  await assertInstallFinalizationExclusiveHeld(scope.capability)
  if (!scope.preparedInExclusive) {
    const verified = await scope.bootstrapApi.observePreparedInstallFinalization()
    check(verified.runtime.nodePath === scope.context.runtime.nodePath && verified.runtime.nodeSha256 === scope.context.runtime.nodeSha256, 'INSTALL_FINALIZATION_SOURCE_CHANGED')
    scope.preparedInExclusive = true
  }
  await assertCapturedInstallSource(scope)
  await scope.readiness.assertInstallFinalizationReadinessCurrent(context, observation)
  if (!scope.participantsVerified) { await verifyInstallFinalizationParticipants(scope.capability); scope.participantsVerified = true }
  await scope.readiness.assertInstallFinalizationReadinessCurrent(context, observation)
  await scope.db.transaction(async tx => {
    await rootInTransaction(scope, tx)
    if (scope.job) { const row = await scope.dbApi.getDurableJob(tx, scope.job.id); checkJob(scope, row); scope.job = row }
    if (scope.intentReceipt) scope.dbApi.assertOperationIntentReceipt(scope.intentReceipt, scope.operationBinding, tx)
    scope.dbApi.assertHostOperationGuardActive(scope.guard, scope.originBinding); assertTime(scope)
  })
  assertTime(scope)
}

async function tracked(scope, operation) {
  check(scope.phase === 'held', 'INSTALL_FINALIZATION_NATIVE_PHASE_INVALID')
  const flight = operation(); scope.flights.add(flight)
  try { return await flight } finally { scope.flights.delete(flight) }
}

function nativeFilesystem(scope) {
  const target = path => {
    const selected = installFinalizationMetadataTarget(path, scope.job?.id)
    check(selected, 'INSTALL_FINALIZATION_WRITE_DENIED'); return selected
  }
  const guard = () => assertCurrent(scope, scope.context, scope.observation, scope.intent)
  return {
    async readFile(path) {
      const selected = target(path)
      check(scope.phase === 'capturing' || scope.phase === 'held', 'INSTALL_FINALIZATION_NATIVE_PHASE_INVALID')
      await assertBase(scope)
      try { return (await metadata(selected.temporary ? path : selected.path)).bytes.toString('utf8') }
      catch (error) { if (error.code === 'ENOENT' && selected.temporary) return null; throw error }
    },
    writeFileExclusive(path, content, mode) { return tracked(scope, async () => {
      const selected = target(path)
      check(selected.temporary && mode === 0o600 && typeof content === 'string' && Buffer.byteLength(content) <= metadataLimit(selected.path) && digest(content) === selected.sha256, 'INSTALL_FINALIZATION_WRITE_DENIED')
      await guard()
      await withTrustedDirectory(ROOT, async parent => {
        await guard(); scope.changed = true
        const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { await handle.chown(0, 0); await handle.chmod(0o600); await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
        await parent.verify(); await guard()
      })
    }) },
    rename(from, to) { return tracked(scope, async () => {
      const source = target(from), destination = target(to)
      check(source.temporary && !destination.temporary && source.path === to, 'INSTALL_FINALIZATION_WRITE_DENIED')
      await guard()
      await withTrustedDirectory(ROOT, async parent => {
        const handle = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const before = await handle.stat({ bigint: true }), bytes = await handle.readFile()
          check(before.isFile() && before.uid === 0n && before.gid === 0n && before.nlink === 1n && Number(before.mode & 0o7777n) === 0o600
            && bytes.length <= metadataLimit(to) && digest(bytes) === source.sha256, 'INSTALL_FINALIZATION_TEMPORARY_CHANGED')
          await guard(); scope.changed = true
          await rename(from, to); scope.expected.set(to, source.sha256)
          const after = await lstat(to, { bigint: true })
          check(after.dev === before.dev && after.ino === before.ino && !after.isSymbolicLink(), 'INSTALL_FINALIZATION_READBACK_FAILED')
          await parent.verify(); await guard()
        } finally { await handle.close() }
      })
    }) },
  }
}

function ports(scope) {
  const fs = nativeFilesystem(scope)
  return {
    fs, clock: { now: () => new Date() },
    async withSharedAdmission(callback) {
      check(scope.phase === 'new', 'INSTALL_FINALIZATION_NATIVE_PHASE_INVALID')
      return active.run(scope, async () => {
        scope.phase = 'capturing'
        try { return await withLifecycleWriterAdmission(() => withFinalizationReadonlyDatabase(scope, callback)) } finally { scope.phase = 'prepared' }
      })
    },
    async withExclusiveAdmission(callback) {
      check(scope.phase === 'prepared' && scope.context && scope.observation && !scope.db && !scope.databaseAccess, 'INSTALL_FINALIZATION_NATIVE_PHASE_INVALID')
      return active.run(scope, async () => {
        scope.phase = 'admitting'
        try {
          return await withInstallFinalizationExclusiveAdmission(scope.capability, () => withFinalizationWriterDatabase(scope, () => scope.dbApi.withHostOperationGuard(scope.db,
            { acquireTimeoutMs: 1, retryIntervalMs: 1 }, async guard => {
              scope.guard = guard; scope.phase = 'held'
              try {
                if (scope.seedIntent && !scope.job) {
                  scope.intent = scope.seedIntent
                  await assertCurrent(scope, scope.context, scope.observation, scope.seedIntent)
                  await claim(scope, await scope.dbApi.getDurableJob(scope.db, scope.seedIntent.jobId))
                }
                return await callback()
              } finally {
                scope.phase = 'retiring'
                const pending = await Promise.allSettled([...scope.flights]); const failed = pending.filter(item => item.status === 'rejected')
                if (failed.length) throw new AggregateError(failed.map(item => item.reason), 'install finalization primitive retirement requires inspection')
              }
            })))
        } finally { scope.phase = 'retired'; scope.guard = null }
      })
    },
    async readAdoptionState() {
      check(scope.kind === 'adopt', 'INSTALL_ADOPTION_NATIVE_SCOPE_REQUIRED')
      await assertBase(scope); await scope.stateDirectories.verify()
      const snapshot = await readScopeSnapshot(scope)
      await scope.stateDirectories.verify(); await assertBase(scope)
      return adoptionState(snapshot)
    },
    async capturePrepared() {
      await assertBase(scope)
      const prepared = await scope.bootstrapApi.observePreparedInstallFinalization(), installation = await readInstallationReceipt()
      scope.receipt = installation.receipt
      const values = await Promise.all(Object.values(PATHS).map(metadata))
      for (let index = 0; index < values.length; index++) scope.expected.set(Object.values(PATHS)[index], values[index].sha256)
      const raw = { bootstrapBytes: values[0].bytes.toString('utf8'), receiptBytes: values[1].bytes.toString('utf8'), headBytes: values[2].bytes.toString('utf8') }
      const bootstrap = JSON.parse(raw.bootstrapBytes)
      scope.preparedBootstrap = bootstrap
      const previousSubject = scope.subject
      scope.seedIntent = bootstrap.finalization ? inspectInstallFinalizationRecovery(raw).intent : null
      await scope.stateDirectories.verify()
      const snapshot = await readScopeSnapshot(scope)
      await scope.stateDirectories.verify()
      const helper = scope.kind === 'adopt' ? scope.bootstrapApi.preparedReleaseInfo(scope.helperCapability) : null
      const context = { source: installation.receipt.source, runtime: installation.receipt.runtime,
        ...(helper ? { helperIdentity: Object.fromEntries(['version', 'archiveSha256', 'manifestSha256', 'dependencyReceiptSha256', 'sourceFilesDigest'].map(key => [key, helper[key]])) } : {}), database: {
        file: scope.origin.file, device: scope.origin.device, inode: scope.origin.inode, issuerId: scope.origin.issuerId }, rootPrincipalId: scope.root.id,
        state: { revision: snapshot.revision, checksum: snapshot.checksum, accountCount: snapshot.accounts.length,
          ...(scope.kind === 'adopt' ? { accountLifetimeDigest: installAdoptionAccountLifetimeDigest(snapshot.accounts.map(lifetimeOf)) } : {}) },
        admissionFingerprint: digest(JSON.stringify({ source: prepared.bootstrap.archiveSha256, manifest: prepared.bootstrap.manifestSha256, origin: scope.origin })) }
      check((scope.kind === 'adopt' ? prepared.helper.archiveSha256 : prepared.bootstrap.archiveSha256) === scope.request.artifact.expectedArchiveSha256 && prepared.runtime.nodeSha256 === context.runtime.nodeSha256, 'INSTALL_FINALIZATION_SOURCE_CHANGED')
      scope.context = context
      scope.subject = (scope.kind === 'adopt' ? installAdoptionSubjectDigest : installFinalizationSubjectDigest)(context, scope.seedIntent?.previousReceiptSha256 ?? values[1].sha256)
      if (scope.job) check(previousSubject === scope.subject, 'INSTALL_STARTUP_SOURCE_CHANGED')
      if (scope.seedIntent) check(scope.seedIntent.subjectDigest === scope.subject, 'INSTALL_FINALIZATION_INTENT_CHANGED')
      await scope.db.transaction(tx => rootInTransaction(scope, tx))
      return structuredClone(context)
    },
    async observeReady(context, subject) {
      check(scope.phase === 'capturing' && subject === scope.subject, 'INSTALL_FINALIZATION_CAPTURE_CHANGED')
      scope.observation = scope.startupRequested ? await settlePreparedInstallReadiness({
        clock: { now: () => new Date() }, current: () => assertInstallCaptureCurrent(scope),
        ready: async () => { const observation = await scope.readiness.captureInstallFinalizationReadiness(context, subject); scope.pendingStartupObservation = observation; return observation },
        delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
      }) : await scope.readiness.captureInstallFinalizationReadiness(context, subject)
      scope.pendingStartupObservation = null
      check(scope.observation.processes.find(process => process.role === 'api')?.uid === Number(scope.databaseInfo.uid), 'INSTALL_FINALIZATION_SERVICE_IDENTITY_CHANGED')
      return structuredClone(scope.observation)
    },
    assertCurrent: (context, observation, intent) => assertCurrent(scope, context, observation, intent),
    syncPath(path) { return tracked(scope, async () => {
      check(path === ROOT || installFinalizationMetadataTarget(path, scope.job?.id), 'INSTALL_FINALIZATION_WRITE_DENIED')
      await assertCurrent(scope, scope.context, scope.observation, scope.intent)
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (path === ROOT ? constants.O_DIRECTORY : 0))
      try {
        const info = await handle.stat({ bigint: true })
        check(path === ROOT ? info.isDirectory() && info.uid === 0n && (info.mode & 0o022n) === 0n
          : info.isFile() && info.uid === 0n && info.gid === 0n && info.nlink === 1n && Number(info.mode & 0o7777n) === 0o600, 'INSTALL_FINALIZATION_SYNC_TARGET_CHANGED')
        await handle.sync()
      } finally { await handle.close() }
      await assertCurrent(scope, scope.context, scope.observation, scope.intent)
    }) },
    jobs: {
      async begin(input) {
        check(input.requestFingerprint === scope.subject && input.rootPrincipalId === scope.root.id && input.kind === 'lifecycle.adopt', 'INSTALL_FINALIZATION_JOB_CHANGED')
        await assertCurrent(scope, scope.context, scope.observation, scope.intent)
        if (!scope.job) await allocateInstallJob(scope)
        await assertCurrent(scope, scope.context, scope.observation, scope.intent)
        return { id: scope.job.id, referenceCode: scope.job.referenceCode, createdAt: scope.job.createdAt }
      },
      async complete(intent, proof) {
        scope.intent = intent; await assertCurrent(scope, scope.context, scope.observation, intent)
        if (scope.job.status === 'succeeded') return
        check((await metadata(PATHS.receipt)).sha256 === proof.receiptSha256 && proof.receiptSha256 === intent.expectedActiveSha256, 'INSTALL_FINALIZATION_READBACK_FAILED')
        await scope.dbApi.saveJobCheckpoint(scope.db, { jobId: scope.job.id, workerId: scope.workerId, fencingToken: scope.leaseFence,
          step: 'install-ownership-observed', data: { installFinalization: { subjectDigest: scope.subject, ...proof },
            installFinalizationEvidence: { context: scope.context, observation: scope.observation } } })
        await assertCurrent(scope, scope.context, scope.observation, intent)
        scope.job = await scope.dbApi.completeJobWithLease(scope.db, { jobId: scope.job.id, workerId: scope.workerId, fencingToken: scope.leaseFence, status: 'succeeded',
          summary: installOwnershipCompletionSummary(scope.kind), detail: { ...scope.job.detail, installFinalization: { subjectDigest: scope.subject, rootPrincipalId: scope.root.id, ...proof } } },
          async (tx, current, phase) => {
            assertCompletionScope(scope)
            await rootInTransaction(scope, tx)
            checkJob(scope, current)
            if (phase === 'after') checkJob(scope, await scope.dbApi.getDurableJob(tx, current.id))
            assertCompletionScope(scope)
          })
        checkJob(scope, scope.job)
        await assertCurrent(scope, scope.context, scope.observation, intent)
      },
      async assertComplete(intent, subject) {
        check(subject === scope.subject, 'INSTALL_FINALIZATION_INTENT_CHANGED'); scope.intent = intent
        await assertCurrent(scope, scope.context, scope.observation, intent)
        check(scope.job?.status === 'succeeded', 'INSTALL_FINALIZATION_JOB_PROOF_CHANGED')
      },
    },
  }
}

export async function runNativeInstallFinalization(input) { return runNativeFinalization(input, null) }

/** Opens an authenticated new helper while finalizing the separately observed old installation. */
export async function runNativePreparedAdoption(input) {
  try {
    const request = parseNativePreparedAdoptionRequest(input), bootstrap = await import('./install-bootstrap.mjs')
    return await bootstrap.withExistingPreparedRelease({ artifactPath: request.artifact.path, expectedArchiveSha256: request.artifact.expectedArchiveSha256 },
      capability => runNativeFinalization(request, capability))
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'INSTALL_ADOPTION_NATIVE_UNVERIFIED'
    return { exitCode: 6, code, outcome: 'attention', details: { status: 'attention', qualified: false, nativeQualified: false, installReady: false, reason: code } }
  }
}

async function runNativeFinalization(input, helperCapability) {
  let scope, databasePin, output
  try {
    const request = (helperCapability ? parseNativePreparedAdoptionRequest : parseNativeInstallFinalizationRequest)(input), identity = await processIdentity()
    const bootstrapModule = await import('./install-bootstrap.mjs')
    const bootstrapApi = helperCapability ? { ...bootstrapModule, observePreparedInstallFinalization: () => bootstrapModule.observePreparedAdoptionSource(helperCapability) } : bootstrapModule
    const prepared = await withLifecycleWriterAdmission(async () => {
      await assertLifecycleWriterAdmissionHeld()
      return bootstrapApi.observePreparedInstallFinalization()
    }), helperRoot = helperCapability ? prepared.helper.releaseRoot : prepared.bootstrap.releaseRoot
    check(identity.executable === prepared.runtime.nodePath && await realpath(fileURLToPath(import.meta.url)) === helperRoot + '/scripts/install-finalization-native.mjs', 'INSTALL_HELPER_SOURCE_MISMATCH')
    output = await withTrustedDirectory(ROOT, async rootPin => withTrustedFile(identity.executable, { sha256: prepared.runtime.nodeSha256, maxBytes: 256 * 1024 * 1024 }, async nodePin =>
      withTrustedFile('/etc/xpanel/release-trust.json', { exactMode: 0o600, maxBytes: 8192 }, async trustPin => {
        const trust = bootstrapApi.parseBootstrapTrust(JSON.parse(trustPin.bytes.toString('utf8')))
        check(trust.signingKeyPath === '/etc/xpanel/release-hmac.key' && trust.keyId === request.artifact.keyId, 'INSTALL_FINALIZATION_TRUST_CHANGED')
        return withTrustedFile(trust.signingKeyPath, { exactMode: 0o600, maxBytes: 4096 }, async keyPin => withTrustedFile('/etc/xpanel/release-keys.json', { maxBytes: 16 * 1024 }, async keysPin => {
          check(keyPin.bytes.length >= 32, 'INSTALL_HMAC_KEY_INVALID')
          const release = await import('./release-verifier.mjs')
          return release.withAuthenticatedReleaseArchive(request.artifact.path, { signingKey: keyPin.bytes, keyId: trust.keyId, expectedArchiveSha256: request.artifact.expectedArchiveSha256 }, async ({ report }) => {
            const sidecar = request.artifact.path.slice(0, -'.tar.gz'.length) + '.manifest.json'
            return withTrustedFile(sidecar, { maxBytes: 4096 }, async publisher => {
              bootstrapApi.verifyBootstrapPublisher(JSON.parse(publisher.bytes.toString('utf8')), report, bootstrapApi.parseBootstrapKeys(JSON.parse(keysPin.bytes.toString('utf8'))))
              check(report.archiveSha256 === (helperCapability ? prepared.helper.archiveSha256 : prepared.bootstrap.archiveSha256) && report.manifestSha256 === (helperCapability ? prepared.helper.manifestSha256 : prepared.bootstrap.manifestSha256), 'INSTALL_FINALIZATION_SOURCE_CHANGED')
              await verifyPreparedInstallStartupSources(report, async (required, sha256) => {
                await readTrustedFile(helperRoot + '/' + required, { sha256, maxBytes: 256 * 1024 })
              })
              const dbApi = await import('../packages/db/src/index.ts'), stateApi = await import('../packages/state/src/index.ts'), readiness = await import('./install-finalization-readiness.mjs')
              const passwd = (await readTrustedFile('/etc/passwd', { maxBytes: 1024 * 1024 })).bytes.toString('utf8').split('\n').map(line => line.split(':')).filter(fields => fields[0] === 'xpanel')
              check(passwd.length === 1 && /^[1-9][0-9]*$/.test(passwd[0][2]) && /^[1-9][0-9]*$/.test(passwd[0][3]), 'INSTALL_PANEL_IDENTITY_INVALID')
              return withInstallFinalizationStateDirectories(Number(passwd[0][2]), Number(passwd[0][3]), async stateDirectories => {
              databasePin = await open(DATABASE, constants.O_RDONLY | constants.O_NOFOLLOW)
              const before = await databasePin.stat({ bigint: true })
              check(before.isFile() && before.nlink === 1n && before.uid === BigInt(passwd[0][2]) && before.gid === BigInt(passwd[0][3])
                && Number(before.mode & 0o7777n) === 0o660, 'INSTALL_DATABASE_UNSAFE')
              const capability = Object.freeze(Object.create(null))
              scope = { capability, kind: helperCapability ? 'adopt' : 'install', helperCapability, request, identity, bootstrapApi, readiness: helperCapability ? {
                captureInstallFinalizationReadiness: (context, subject) => readiness.captureInstallAdoptionReadiness(capability, context, subject),
                assertInstallFinalizationReadinessCurrent: (context, observation) => readiness.assertInstallAdoptionReadinessCurrent(capability, context, observation),
                releaseInstallFinalizationReadiness: observation => readiness.releaseInstallAdoptionReadiness(observation),
              } : readiness, dbApi, db: null, databaseAccess: null, origin: null, originBinding: null, root: null,
                store: new stateApi.StateStore(STATE), stateDirectories, databasePin, databaseInfo: before, pins: [stateDirectories.verify, rootPin.verify, nodePin.verify, trustPin.verify, keyPin.verify, keysPin.verify, publisher.verify],
                live: true, phase: 'new', expected: new Map(), flights: new Set(), workerId: 'install-finalize:' + randomUUID(), probeId: randomUUID(), changed: false }
              scopes.set(capability, scope)
              if (!helperCapability && prepared.bootstrap.status === 'bootstrap_pending') await startPreparedInstallScope(scope)
              return (helperCapability ? runPreparedInstallAdoption : runPreparedInstallFinalization)(ports(scope))
              })
            })
          })
        }))
      })))
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'INSTALL_FINALIZATION_NATIVE_UNVERIFIED'
    const attention = scope?.changed === true
    output = { exitCode: attention ? 6 : 3, code, outcome: attention ? 'attention' : 'blocked', details: { status: attention ? 'attention' : 'blocked', changed: attention, qualified: false, nativeQualified: false, installReady: false, reason: code } }
  } finally {
    const errors = []
    if (scope) {
      scope.live = false; scope.phase = 'closed'; scopes.delete(scope.capability)
      if (scope.pendingStartupObservation) try { await scope.readiness.releaseInstallFinalizationReadiness?.(scope.pendingStartupObservation) } catch (error) { errors.push(error) }
      if (scope.observation) try { await scope.readiness.releaseInstallFinalizationReadiness?.(scope.observation) } catch (error) { errors.push(error) }
    }
    try { if (databasePin) await databasePin.close() } catch (error) { errors.push(error) }
    if (errors.length) output = { exitCode: 6, code: 'INSTALL_FINALIZATION_RETIREMENT_ATTENTION', outcome: 'attention', details: { status: 'attention', changed: scope?.changed === true, qualified: false, nativeQualified: false, installReady: false } }
  }
  if (output?.exitCode !== 0 && scope?.changed && output.details?.changed !== true) {
    output = { ...output, exitCode: 6, outcome: 'attention', details: { ...output.details, status: 'attention', changed: true, ...(scope.job?.referenceCode ? { officialReference: scope.job.referenceCode } : {}) } }
  }
  if (output?.exitCode !== 0 && scope?.job?.referenceCode) output = { ...output, details: { ...output.details, officialReference: scope.job.referenceCode } }
  return output
}
