import { runNativeLifecycleCommand } from '../apps/agent/src/lifecycle/native-runtime.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, readlink, realpath, rename, unlink, readdir } from 'node:fs/promises'
import { basename, dirname, join, posix } from 'node:path'
import { withHostOperationGuard, assertHostOperationGuardHeld, assertHostOperationGuardActive, getStrictOperationDatabaseOrigin, createRootOperationAuditAuthority, assertOperationIntentReceipt, getPrincipal, createJob, finishJob, finishUpgrade, currentSchemaVersion, latestUpgrade, reindexFromState } from '../packages/db/src/index.ts'
import { StateStore } from '../packages/state/src/index.ts'
import { withAuthenticatedReleaseArchive, stageAuthenticatedReleaseArchive, verifyAuthenticatedReleaseArchive } from './release-verifier.mjs'
import { readInstallationReceipt, assertOwnedFile, withTrustedFile, withTrustedDirectory, requireLinuxRoot } from './lifecycle-ownership.mjs'
import { observeOwnedControlPlaneUnits, assertOwnedControlPlaneQuiescent, awaitOwnedServiceChildren, projectOwnedControlPlaneObservation } from './lifecycle-services.mjs'

const ROOT = '/var/lib/xpanel-lifecycle'
const HEAD = ROOT + '/HEAD'
const TRUST = '/etc/xpanel/release-trust.json'
const EFFECTS = new Set(['service.stop', 'service.start', 'service.observe', 'barrier.retire', 'filesystem.write'])
const ACTIONS = new Set(['upgrade', 'rollback', 'recover', 'uninstall', 'adopt'])
const COORDINATORS = new Set(['xpanel-upgrade.service', 'xpanel-lifecycle.service'])
const SHA = /^[a-f0-9]{64}$/
const scopeStorage = new AsyncLocalStorage()
const capabilities = new WeakMap()
const factories = new WeakMap()
const fail = (code, cause) => { throw Object.assign(new Error(code, cause ? { cause } : undefined), { code }) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

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
      const timer = setTimeout(() => { uncertain = true }, options.timeoutMs ?? 30_000)
      const collect = chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) uncertain = true; else output += chunk }
      child.stdout.on('data', collect); child.stderr.on('data', collect)
      child.once('error', error => { spawnError = error })
      // Keep the real descriptor and owning guard until actual close. A timeout is not quiescence.
      child.once('close', async (code, signal) => {
        clearTimeout(timer)
        try { await pin.verify() } catch (error) { reject(error); return }
        if (uncertain || signal || code === null) { reject(Object.assign(new Error('LIFECYCLE_CHILD_UNCERTAIN'), { code: 'LIFECYCLE_CHILD_UNCERTAIN' })); return }
        if (spawnError) { reject(spawnError); return }
        resolve({ code, output })
      })
    })
  })
}

async function durableJson(path, value, replace = false, mode = 0o600) {
  await withTrustedDirectory(dirname(path), async parent => {
    const temporary = `${path}.${randomUUID()}.tmp`
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync() } finally { await handle.close() }
    if (!replace) { try { await lstat(path); fail('LIFECYCLE_PATH_EXISTS') } catch (error) { if (error.code !== 'ENOENT') throw error } }
    await rename(temporary, path)
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await directory.close() }
    await parent.verify()
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
  return withTrustedFile(HEAD, { exactMode: 0o600, maxBytes: 16384 }, async pin => ({ value: parseLifecycleHead(JSON.parse(pin.bytes.toString('utf8'))), hash: sha(pin.bytes) }))
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
  const scope = capability && typeof capability === 'object' ? capabilities.get(capability) : undefined
  await assertScope(scope)
}

export async function assertCurrentLifecycleEffect(effect) {
  const scope = scopeStorage.getStore()
  if (!scope || !EFFECTS.has(effect)) fail('LIFECYCLE_NATIVE_SCOPE_REQUIRED')
  await assertLifecycleRootSafetyHeld(scope.capability, { effect })
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

export function getLifecycleRootSafetyInfo(capability) {
  const scope = capability && typeof capability === 'object' ? capabilities.get(capability) : undefined
  if (!scope || scopeStorage.getStore() !== scope || scope.phase !== 'held') fail('LIFECYCLE_NATIVE_SCOPE_REQUIRED')
  return Object.freeze({ operationId: scope.job.id, kind: scope.operation, coordinatorUnit: scope.process.coordinatorUnit })
}

/** Actual kernel/service identity, independently observed before and after the private socket handshake. */
export async function observeLifecycleWriterService(capability, role, expected) {
  await assertLifecycleRootSafetyHeld(capability, { effect: 'service.observe' })
  if (!['api', 'agent'].includes(role)) fail('LIFECYCLE_WRITER_ROLE_INVALID')
  const scope = capabilities.get(capability), unit = `xpanel-${role}.service`
  const shown = await nativeCommand('/usr/bin/systemctl', ['show', unit, '--property=MainPID,ControlPID,ControlGroup,FragmentPath,DropInPaths,ActiveState,User'], { sha256: scope.receipt.runtime.systemctlSha256 })
  const properties = Object.fromEntries(shown.output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
  if (shown.code !== 0 || !/^[1-9][0-9]*$/.test(properties.MainPID) || properties.ControlPID !== '0' || properties.ActiveState !== 'active' || properties.ControlGroup !== `/system.slice/${unit}` || properties.FragmentPath !== `/etc/systemd/system/${unit}` || properties.DropInPaths || (role === 'api' ? properties.User !== 'xpanel' : !['', 'root', '0'].includes(properties.User))) fail('LIFECYCLE_WRITER_SERVICE_UNOWNED')
  const pid = Number(properties.MainPID)
  const [status, stat, executable, cgroup, command] = await Promise.all([readFile(`/proc/${pid}/status`, 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8'), readlink(`/proc/${pid}/exe`), readFile(`/proc/${pid}/cgroup`, 'utf8'), readFile(`/proc/${pid}/cmdline`, 'utf8')])
  const uid = Number(/^Uid:\s+([0-9]+)\s+\1\s+\1\s+\1\s*$/m.exec(status)?.[1]), start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
  if (!Number.isSafeInteger(uid) || (role === 'api' ? uid <= 0 : uid !== 0) || !/^[0-9]+$/.test(start ?? '') || executable !== scope.process.executable || cgroup.trim() !== `0::/system.slice/${unit}`) fail('LIFECYCLE_WRITER_PROCESS_CHANGED')
  const source = await realpath('/opt/xpanel/current')
  const expectedEntry = join(source, `apps/${role}/src/main.ts`)
  let entryMatches = false
  for (const argument of command.split('\0')) {
    if (argument === expectedEntry || argument === `/opt/xpanel/current/apps/${role}/src/main.ts`) {
      if (await realpath(argument) === expectedEntry) entryMatches = true
    }
  }
  if (!entryMatches) fail('LIFECYCLE_WRITER_SOURCE_MISMATCH')
  const actual = Object.freeze({ pid, uid, start, executable, source })
  if (expected && JSON.stringify(actual) !== JSON.stringify(expected)) fail('LIFECYCLE_WRITER_PROCESS_CHANGED')
  return actual
}

async function runtimeDependencies(scope, root, report) {
  await assertScope(scope)
  const manager = scope.trust.packageManagerPath
  const checked = await nativeCommand(manager, ['--version'], { sha256: scope.trust.packageManagerSha256 })
  if (checked.code !== 0 || checked.output.trim() !== report.manifest.runtime.packageManager.split('@').at(-1)) fail('LIFECYCLE_PACKAGE_MANAGER_MISMATCH')
  const installed = await nativeCommand(manager, ['install', '--offline', '--frozen-lockfile', '--prod', '--ignore-scripts', '--verify-store-integrity'], { cwd: root, sha256: scope.trust.packageManagerSha256, timeoutMs: 120_000 })
  if (installed.code !== 0) fail('LIFECYCLE_DEPENDENCY_INSTALL_FAILED')
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
  const probe = "import {createRequire} from 'node:module';import{DatabaseSync}from'node:sqlite';const require=createRequire(process.cwd()+'/package.json');const a=require('argon2');const h=await a.hash('lifecycle-native-abi-probe');if(!await a.verify(h,'lifecycle-native-abi-probe'))process.exit(1);const d=new DatabaseSync(':memory:');if(d.prepare('select 1 as v').get().v!==1)process.exit(1);d.close();"
  const native = await nativeCommand(scope.receipt.runtime.nodePath, ['--input-type=module', '-e', probe], { cwd: root, sha256: scope.receipt.runtime.nodeSha256 })
  if (native.code !== 0) fail('LIFECYCLE_NATIVE_ABI_FAILED')
  scope.dependencies = { root, lockHash: sha(lock), verifiedAt: new Date().toISOString() }
}

/** Negative precheck before opening a writer connection; it does not mint an effect scope. */
export async function assertNativeLifecyclePrerequisites() {
  const processPin = await processIdentity()
  const { receipt } = await readInstallationReceipt()
  if (receipt.status !== 'active' || process.version !== `v${receipt.runtime.nodeVersion}` || processPin.executable !== await realpath(receipt.runtime.nodePath)) fail('LIFECYCLE_INSTALLATION_NOT_READY')
  await trustConfiguration()
  for (const file of receipt.files) await assertOwnedFile(file)
  await withTrustedFile(receipt.runtime.nodePath, { sha256: receipt.runtime.nodeSha256, maxBytes: 256 * 1024 * 1024 }, async () => {})
  await withTrustedFile('/usr/bin/systemctl', { sha256: receipt.runtime.systemctlSha256, maxBytes: 16 * 1024 * 1024 }, async () => {})
  const controller = await nativeCommand('/usr/bin/systemctl', ['show', processPin.coordinatorUnit, '--property=MainPID,ControlPID,ControlGroup,FragmentPath,DropInPaths,User'], { sha256: receipt.runtime.systemctlSha256 })
  const properties = Object.fromEntries(controller.output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
  if (controller.code !== 0 || properties.MainPID !== String(process.pid) || properties.ControlPID !== '0' || properties.ControlGroup !== `/system.slice/${processPin.coordinatorUnit}` || properties.FragmentPath !== `/etc/systemd/system/${processPin.coordinatorUnit}` || properties.DropInPaths || !['', 'root', '0'].includes(properties.User)) fail('LIFECYCLE_OWNED_COORDINATOR_REQUIRED')
  await withTrustedFile(properties.FragmentPath, { maxBytes: 65536 }, async () => {})
}

/** Only actual native observations create this implementation; no provider/stat/receipt override exists. */
export async function createNativeUpgradeSafety(options) {
  const processPin = await processIdentity()
  if (!options || typeof options !== 'object' || Object.keys(options).some(key => !['db', 'actorId', 'operation', 'release', 'layout'].includes(key)) || !ACTIONS.has(options.operation) || typeof options.actorId !== 'string') fail('LIFECYCLE_NATIVE_OPTIONS_INVALID')
  const db = options.db
  const origin = await db.transaction(async tx => getStrictOperationDatabaseOrigin(tx))
  const principal = await getPrincipal(db, options.actorId)
  if (!principal || principal.kind !== 'root' || principal.disabled) fail('LIFECYCLE_ROOT_PRINCIPAL_REQUIRED')
  const actual = await readInstallationReceipt(), receipt = actual.receipt
  if (receipt.status !== 'active' || process.version !== `v${receipt.runtime.nodeVersion}` || processPin.executable !== await realpath(receipt.runtime.nodePath)) fail('LIFECYCLE_INSTALLATION_NOT_READY')
  const trust = await trustConfiguration()
  for (const file of receipt.files) await assertOwnedFile(file)
  const controller = await nativeCommand('/usr/bin/systemctl', ['show', processPin.coordinatorUnit, '--property=MainPID,ControlPID,ControlGroup,FragmentPath,DropInPaths,User'], { sha256: receipt.runtime.systemctlSha256 })
  const properties = Object.fromEntries(controller.output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
  if (controller.code !== 0 || properties.MainPID !== String(process.pid) || properties.ControlPID !== '0' || properties.ControlGroup !== `/system.slice/${processPin.coordinatorUnit}` || properties.FragmentPath !== `/etc/systemd/system/${processPin.coordinatorUnit}` || properties.DropInPaths || !['', 'root', '0'].includes(properties.User)) fail('LIFECYCLE_OWNED_COORDINATOR_REQUIRED')
  await withTrustedFile(properties.FragmentPath, { maxBytes: 65536 }, async () => {})
  const factory = Object.freeze({})
  factories.set(factory, { db, origin, principal, process: processPin, receipt, trust, options })
  let activeScope
  const current = async () => { await assertScope(activeScope); return activeScope }
  const safety = {
    async withExclusive(callback) {
      if (typeof callback !== 'function' || activeScope) fail('LIFECYCLE_SCOPE_CONFLICT')
      const configured = factories.get(factory)
      return withHostOperationGuard(db, {}, async guard => withTrustedDirectory(ROOT, async parent => withTrustedFile('/usr/bin/systemctl', { sha256: receipt.runtime.systemctlSha256, maxBytes: 16 * 1024 * 1024 }, async tool => withTrustedFile(receipt.runtime.nodePath, { sha256: receipt.runtime.nodeSha256, maxBytes: 256 * 1024 * 1024 }, async node => {
        const head = await readHead()
        if (head.value.issuerId !== origin.issuerId || !['idle', 'retired'].includes(head.value.phase)) fail('LIFECYCLE_RETAINED_ATTENTION')
        const id = randomUUID(), fingerprint = sha(JSON.stringify({ operation: options.operation, actorId: principal.id, release: options.release ?? null, parentHead: head.hash }))
        const intentBinding = { purpose: 'host.lifecycle.intent', jobId: id, requestFingerprint: fingerprint, action: `lifecycle.${options.operation}`, principalId: principal.id }
        const job = await createJob(db, { id, kind: intentBinding.action, actor: principal.username, detail: { lifecycleIntent: intentBinding } })
        const authority = await createRootOperationAuditAuthority(db)
        const intentReceipt = await authority.appendLifecycleIntent(intentBinding)
        const scope = { ...configured, phase: 'held', guard, job, intentBinding, intentReceipt, pins: [parent.verify, tool.verify, node.verify], previousHead: head, capability: Object.freeze({}), capture: null, staged: null, dependencies: null, backup: null }
        capabilities.set(scope.capability, scope); activeScope = scope
        return scopeStorage.run(scope, async () => {
          try {
            await assertScope(scope)
            const admission = await import('./lifecycle-admission.mjs')
            return await admission.withLifecycleExclusiveAdmission(scope.capability, async () => {
              const timestamp = new Date().toISOString(), sequence = head.value.sequence + 1
              await durableJson(ROOT + '/writer-barrier.json', { schemaVersion: 1, operationId: job.id, reference: job.referenceCode, kind: options.operation, phase: 'pending', requestFingerprint: fingerprint, sequence, createdAt: timestamp }, false, 0o644)
              await durableJson(HEAD, { ...head.value, sequence, phase: 'pending', operationId: job.id, reference: job.referenceCode, kind: options.operation, requestFingerprint: fingerprint, updatedAt: timestamp }, true)
              const result = await callback()
              return await settleNative(scope, result)
            })
          } finally {
            try { await awaitOwnedServiceChildren(scope.capability) } finally { scope.phase = 'closed'; activeScope = null }
          }
        })
      }))))
    },
    async assertOwnedExecution(units) {
      const scope = await current()
      if (!Array.isArray(units) || units.some(unit => !['xpanel-api.service', 'xpanel-agent.service'].includes(unit))) fail('LIFECYCLE_UNOWNED_PANEL_UNIT')
      scope.capture ??= await observeOwnedControlPlaneUnits(receipt, scope.capability)
    },
    async assertWritersQuiescent() { const scope = await current(); scope.capture = await assertOwnedControlPlaneQuiescent(receipt, scope.capture, scope.capability) },
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
    // Rewind: the engine matched this copy to the snapshot receipt. Derived idx_* rows are rebuilt from
    // the restored state files; identity, session, job and audit authority never rewinds (A25).
    async restoreControlPlane(snapshotPath) {
      await current(); await safety.assertWritersQuiescent()
      if (!snapshotPath.startsWith(ROOT + '/backups/')) fail('LIFECYCLE_BACKUP_PATH_INVALID')
      await withTrustedFile(snapshotPath + '.control.db', { maxBytes: 256 * 1024 * 1024 }, async copy => { await copy.verify() })
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

async function settleNative(scope, result) {
  await assertScope(scope)
  if (!result || result.outcome !== 'retirement_pending') return result
  const head = await readHead()
  await durableJson(HEAD, { ...head.value, phase: 'retirement_pending', updatedAt: new Date().toISOString() }, true)
  if (!scope.dependencies || !scope.backup || !scope.capture || !['succeeded', 'rolled_back'].includes(result.hostOutcome)) return result
  const observation = projectOwnedControlPlaneObservation(await observeOwnedControlPlaneUnits(scope.receipt, scope.capability))
  if (!observation || !Array.isArray(observation.units) || observation.units.some(unit => !['active', 'inactive'].includes(unit.ActiveState))) return result
  // Retirement also requires actual active writers holding the current shared admission generation.
  const admission = await import('./lifecycle-admission.mjs')
  if (!await admission.verifyNativeWriterGeneration(scope.capability, scope.job.id)) return result
  await assertScope(scope)
  const terminal = { schemaVersion: 1, operationId: scope.job.id, reference: scope.job.referenceCode, requestFingerprint: scope.intentBinding.requestFingerprint, hostOutcome: result.hostOutcome, sourceArchiveSha256: scope.report.archiveSha256, databaseBackupSha256: scope.backup.sha256, completedAt: new Date().toISOString() }
  await durableJson(join(ROOT, 'terminal', scope.job.id + '.json'), terminal)
  // Physical verification precedes the short canonical DB acknowledgement transaction.
  await assertHostOperationGuardHeld(scope.guard, bindingFor(scope.origin))
  await scope.db.transaction(async tx => {
    assertHostOperationGuardActive(scope.guard, bindingFor(scope.origin))
    assertOperationIntentReceipt(scope.intentReceipt, scope.intentBinding, tx)
    if (result.recordId) await finishUpgrade(tx, result.recordId, { status: result.hostOutcome === 'succeeded' ? 'succeeded' : 'rolled_back', healthReport: { nativeLifecycleReference: scope.job.referenceCode, terminalSha256: sha(JSON.stringify(terminal) + '\n') }, error: result.hostOutcome === 'succeeded' ? null : 'State snapshot restored and verified after a failed upgrade', toSchemaVersion: await currentSchemaVersion(tx) })
    await finishJob(tx, scope.job.id, { status: 'succeeded', summary: 'Native lifecycle settlement completed' })
    assertHostOperationGuardActive(scope.guard, bindingFor(scope.origin))
    assertOperationIntentReceipt(scope.intentReceipt, scope.intentBinding, tx)
  })
  await durableJson(HEAD, { ...head.value, phase: 'retired', updatedAt: terminal.completedAt }, true)
  for (const path of ['/var/lib/xpanel/maintenance.json', '/var/lib/xpanel/upgrade.lock', ROOT + '/backups/retirement-attention.json', ROOT + '/writer-barrier.json']) {
    await assertScope(scope)
    await withTrustedFile(path, { maxBytes: 1024 * 1024 }, async () => {})
    await unlink(path); const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await directory.sync() } finally { await directory.close() }
  }
  return Object.freeze({ ...result, outcome: result.hostOutcome, reason: null, code: null })
}

export async function executeNativeLifecycleCommand(request) { return runNativeLifecycleCommand(request) }
