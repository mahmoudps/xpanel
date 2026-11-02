// Protocol only. Production must call this through a fixed native bootstrap factory.
// A supplied port object, parsed receipt or passing unit test grants no native authority.
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { parseInstallationReceipt } from './lifecycle-ownership.mjs'

export const INSTALL_FINALIZATION_PATHS = Object.freeze({
  bootstrap: '/var/lib/xpanel-lifecycle/bootstrap.json',
  receipt: '/var/lib/xpanel-lifecycle/installation.json',
  head: '/var/lib/xpanel-lifecycle/HEAD',
})
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const SHA = /^[a-f0-9]{64}$/
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/
const REFERENCE = /^XP-JOB-(?:[0-9]{4}-)?[0-9]{6,16}$/
const PHASES = new Set(['intent', 'verified', 'receipt_published', 'complete'])
const WINDOW_MS = 30_000
const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (condition, code) => { if (!condition) fail(code) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => JSON.stringify(value) + '\n'
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const same = (left, right) => canonical(left) === canonical(right)
const record = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const exact = (value, keys, code) => check(record(value) && Reflect.ownKeys(value).length === keys.length
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value')), code)
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
const parse = (bytes, maximum) => {
  check(typeof bytes === 'string' && Buffer.byteLength(bytes) <= maximum, 'INSTALL_FINALIZATION_RECORD_UNAVAILABLE')
  try { const value = JSON.parse(bytes); check(record(value), 'INSTALL_FINALIZATION_RECORD_INVALID'); return value }
  catch (error) { if (error?.code) throw error; fail('INSTALL_FINALIZATION_RECORD_INVALID') }
}

function contextOf(value) {
  exact(value, ['source', 'runtime', 'database', 'rootPrincipalId', 'state', 'admissionFingerprint'], 'INSTALL_FINALIZATION_CONTEXT_INVALID')
  exact(value.database, ['file', 'device', 'inode', 'issuerId'], 'INSTALL_FINALIZATION_DATABASE_INVALID')
  exact(value.state, ['revision', 'checksum', 'accountCount'], 'INSTALL_FINALIZATION_STATE_INVALID')
  check(value.database.file === '/var/lib/xpanel/control.db' && DECIMAL.test(value.database.device) && DECIMAL.test(value.database.inode)
    && UUID.test(value.database.issuerId) && UUID.test(value.rootPrincipalId) && SHA.test(value.admissionFingerprint), 'INSTALL_FINALIZATION_DATABASE_INVALID')
  check(Number.isSafeInteger(value.state.revision) && value.state.revision >= 0 && SHA.test(value.state.checksum)
    && value.state.accountCount === 0, 'INSTALL_FINALIZATION_FRESH_INSTALL_REQUIRED')
  return structuredClone(value)
}

function intentOf(value) {
  exact(value, ['schemaVersion', 'jobId', 'reference', 'subjectDigest', 'previousReceiptSha256', 'expectedActiveSha256', 'phase', 'observationDigest', 'createdAt'], 'INSTALL_FINALIZATION_INTENT_INVALID')
  check(value.schemaVersion === 1 && UUID.test(value.jobId) && REFERENCE.test(value.reference)
    && [value.subjectDigest, value.previousReceiptSha256, value.expectedActiveSha256].every(hash => typeof hash === 'string' && SHA.test(hash))
    && PHASES.has(value.phase) && (value.observationDigest === null || typeof value.observationDigest === 'string' && SHA.test(value.observationDigest))
    && iso(value.createdAt), 'INSTALL_FINALIZATION_INTENT_INVALID')
  return structuredClone(value)
}

function observationOf(value, subject, context, now) {
  exact(value, ['subjectDigest', 'observedAt', 'expiresAt', 'mode', 'processes', 'ingress'], 'INSTALL_FINALIZATION_OBSERVATION_INVALID')
  check(value.subjectDigest === subject && iso(value.observedAt) && iso(value.expiresAt) && value.mode === 'normal', 'INSTALL_FINALIZATION_OBSERVATION_INVALID')
  const observed = Date.parse(value.observedAt), expires = Date.parse(value.expiresAt)
  check(observed <= now && now < expires && expires > observed && expires - observed <= WINDOW_MS, 'INSTALL_FINALIZATION_OBSERVATION_EXPIRED')
  check(Array.isArray(value.processes) && value.processes.length === 2, 'INSTALL_FINALIZATION_PROCESS_INVALID')
  for (const role of ['api', 'agent']) {
    const entries = value.processes.filter(item => item?.role === role)
    check(entries.length === 1, 'INSTALL_FINALIZATION_PROCESS_INVALID')
    const item = entries[0]
    exact(item, ['role', 'pid', 'start', 'uid', 'executable', 'cwd', 'cgroup', 'invocationId', 'socketDevice', 'socketInode'], 'INSTALL_FINALIZATION_PROCESS_INVALID')
    check(Number.isSafeInteger(item.pid) && item.pid > 0 && item.pid <= 2147483647 && DECIMAL.test(item.start)
      && Number.isSafeInteger(item.uid) && (role === 'agent' ? item.uid === 0 : item.uid > 0)
      && item.executable === context.runtime.nodePath && item.cwd === '/opt/xpanel/releases/' + context.source.version
      && item.cgroup === '/system.slice/xpanel-' + role + '.service' && /^[a-f0-9]{32}$/.test(item.invocationId)
      && DECIMAL.test(item.socketDevice) && DECIMAL.test(item.socketInode), 'INSTALL_FINALIZATION_PROCESS_INVALID')
  }
  exact(value.ingress, ['configSha256', 'certificateSha256', 'audiences'], 'INSTALL_FINALIZATION_INGRESS_INVALID')
  check(SHA.test(value.ingress.configSha256) && SHA.test(value.ingress.certificateSha256)
    && Array.isArray(value.ingress.audiences) && same([...value.ingress.audiences].sort(), ['xmail', 'xpanel', 'xwhm']), 'INSTALL_FINALIZATION_INGRESS_INVALID')
  return structuredClone(value)
}

function validateState(state, context) {
  const bootstrap = parse(state.bootstrapBytes, 16 * 1024), receipt = parseInstallationReceipt(parse(state.receiptBytes, 64 * 1024)), head = parse(state.headBytes, 16 * 1024)
  check(same(receipt.source, context.source) && same(receipt.runtime, context.runtime), 'INSTALL_FINALIZATION_SOURCE_CHANGED')
  check(bootstrap.schemaVersion === 1 && ['bootstrap_pending', 'active'].includes(bootstrap.status)
    && bootstrap.version === context.source.version && bootstrap.releaseRoot === '/opt/xpanel/releases/' + context.source.version
    && bootstrap.archiveSha256 === context.source.archiveSha256 && bootstrap.manifestSha256 === context.source.manifestSha256
    && bootstrap.dependencyReceiptSha256 === context.source.dependencyReceiptSha256 && bootstrap.controlDbSchemaVersion === context.source.controlDbSchemaVersion
    && same(bootstrap.runtime, { nodePath: context.runtime.nodePath, nodeSha256: context.runtime.nodeSha256 }), 'INSTALL_FINALIZATION_BOOTSTRAP_CHANGED')
  check(head.schemaVersion === 1 && head.issuerId === context.database.issuerId && head.kind === 'adopt'
    && Number.isSafeInteger(head.sequence) && UUID.test(head.operationId) && iso(head.updatedAt), 'INSTALL_FINALIZATION_HEAD_CHANGED')
  const intent = bootstrap.finalization === undefined ? null : intentOf(bootstrap.finalization)
  const previousReceiptSha256 = intent?.previousReceiptSha256 ?? digest(state.receiptBytes)
  const subjectDigest = digest(canonical({ context, previousReceiptSha256 }))
  if (intent) {
    check(intent.subjectDigest === subjectDigest, 'INSTALL_FINALIZATION_INTENT_CHANGED')
    const current = digest(state.receiptBytes)
    check(current === intent.previousReceiptSha256 && receipt.status === 'bootstrap_pending' && receipt.lastLifecycleReference === null
      || current === intent.expectedActiveSha256 && receipt.status === 'active' && receipt.lastLifecycleReference === intent.reference, 'INSTALL_FINALIZATION_RECEIPT_CHANGED')
    check(head.sequence === 0 && head.phase === 'idle' && head.reference === null && head.requestFingerprint === context.admissionFingerprint
      || head.sequence === 1 && ['pending', 'retired'].includes(head.phase) && head.operationId === intent.jobId
        && head.reference === intent.reference && head.requestFingerprint === subjectDigest, 'INSTALL_FINALIZATION_HEAD_CHANGED')
    check(head.phase !== 'retired' || receipt.status === 'active', 'INSTALL_FINALIZATION_HEAD_CHANGED')
    check(bootstrap.status !== 'active' || intent.phase === 'complete' && receipt.status === 'active' && head.phase === 'retired', 'INSTALL_FINALIZATION_BOOTSTRAP_CHANGED')
  } else {
    check(bootstrap.status === 'bootstrap_pending' && receipt.status === 'bootstrap_pending' && receipt.lastLifecycleReference === null
      && head.sequence === 0 && head.phase === 'idle' && head.reference === null && head.requestFingerprint === context.admissionFingerprint, 'INSTALL_FINALIZATION_PENDING_REQUIRED')
  }
  return { bootstrap, receipt, head, intent, subjectDigest, previousReceiptSha256 }
}

const result = (exitCode, code, outcome, details) => Object.freeze({ exitCode, code, outcome, details: Object.freeze(details) })

/** Pure recovery-record inspection only; native source/DB/process authority remains separate. */
export function inspectInstallFinalizationRecovery(value) {
  exact(value, ['bootstrapBytes', 'receiptBytes', 'headBytes'], 'INSTALL_FINALIZATION_RECORD_INVALID')
  const bootstrap = parse(value.bootstrapBytes, 16 * 1024), receipt = parseInstallationReceipt(parse(value.receiptBytes, 64 * 1024)), head = parse(value.headBytes, 16 * 1024)
  const intent = intentOf(bootstrap.finalization)
  check(bootstrap.schemaVersion === 1 && ['bootstrap_pending', 'active'].includes(bootstrap.status)
    && bootstrap.releaseRoot === '/opt/xpanel/releases/' + receipt.source.version && bootstrap.version === receipt.source.version
    && bootstrap.archiveSha256 === receipt.source.archiveSha256 && bootstrap.manifestSha256 === receipt.source.manifestSha256
    && bootstrap.dependencyReceiptSha256 === receipt.source.dependencyReceiptSha256 && bootstrap.controlDbSchemaVersion === receipt.source.controlDbSchemaVersion
    && same(bootstrap.runtime, { nodePath: receipt.runtime.nodePath, nodeSha256: receipt.runtime.nodeSha256 }), 'INSTALL_FINALIZATION_BOOTSTRAP_CHANGED')
  const current = digest(value.receiptBytes), pending = current === intent.previousReceiptSha256 && receipt.status === 'bootstrap_pending' && receipt.lastLifecycleReference === null
  const active = current === intent.expectedActiveSha256 && receipt.status === 'active' && receipt.lastLifecycleReference === intent.reference
  check(pending || active, 'INSTALL_FINALIZATION_RECEIPT_CHANGED')
  check(head.schemaVersion === 1 && UUID.test(head.issuerId) && UUID.test(head.operationId) && head.kind === 'adopt' && iso(head.updatedAt), 'INSTALL_FINALIZATION_HEAD_CHANGED')
  const initial = head.sequence === 0 && head.phase === 'idle' && head.reference === null && SHA.test(head.requestFingerprint) && pending && intent.phase === 'intent'
  const owned = head.sequence === 1 && ['pending', 'retired'].includes(head.phase) && head.operationId === intent.jobId && head.reference === intent.reference && head.requestFingerprint === intent.subjectDigest
  check(initial || owned, 'INSTALL_FINALIZATION_HEAD_CHANGED')
  check(head.phase !== 'retired' || active, 'INSTALL_FINALIZATION_HEAD_CHANGED')
  check(!active || intent.phase !== 'intent', 'INSTALL_FINALIZATION_INTENT_CHANGED')
  check(intent.phase !== 'receipt_published' || active, 'INSTALL_FINALIZATION_INTENT_CHANGED')
  check(intent.phase !== 'complete' || active && head.phase === 'retired' && bootstrap.status === 'active', 'INSTALL_FINALIZATION_INTENT_CHANGED')
  check(bootstrap.status !== 'active' || intent.phase === 'complete' && active && head.phase === 'retired', 'INSTALL_FINALIZATION_BOOTSTRAP_CHANGED')
  return Object.freeze({ bootstrap: Object.freeze(bootstrap), receipt, head: Object.freeze(head), intent: Object.freeze(intent) })
}

export function installFinalizationSubjectDigest(context, previousReceiptSha256) {
  check(typeof previousReceiptSha256 === 'string' && SHA.test(previousReceiptSha256), 'INSTALL_FINALIZATION_RECEIPT_CHANGED')
  return digest(canonical({ context: contextOf(context), previousReceiptSha256 }))
}

/**
 * Isolated protocol using the existing lifecycle FsPort/ClockPort shapes. A fixed native
 * install-bootstrap factory must own every port and enforce actual effect admission.
 * The fixed native bootstrap factory owns the real SH/EX/process/receipt authority;
 * isolated port fixtures do not establish that native installation evidence.
 */
export async function runPreparedInstallFinalization(ports) {
  let attemptedEffects = false, intentSeen = false
  try {
    let captured
    await ports.withSharedAdmission(async () => {
      const context = contextOf(await ports.capturePrepared())
      const state = await readState(ports.fs)
      // Preserve the known recovery boundary even when later receipt validation fails.
      intentSeen ||= Object.hasOwn(parse(state.bootstrapBytes, 16 * 1024), 'finalization')
      const parsed = validateState(state, context)
      intentSeen = parsed.intent !== null
      const observation = observationOf(await ports.observeReady(context, parsed.subjectDigest), parsed.subjectDigest, context, ports.clock.now().getTime())
      captured = { context, observation, subjectDigest: parsed.subjectDigest }
    })
    check(captured, 'INSTALL_FINALIZATION_CAPTURE_UNAVAILABLE')
    // The shared wrapper has fully retired before any exclusive acquisition is requested.
    return await ports.withExclusiveAdmission(async () => {
      const { context, observation, subjectDigest } = captured
      let intent = null
      const fresh = async () => {
        await ports.assertCurrent(context, observation, intent)
        observationOf(observation, subjectDigest, context, ports.clock.now().getTime())
      }
      await fresh()
      const current = await readState(ports.fs)
      intentSeen ||= Object.hasOwn(parse(current.bootstrapBytes, 16 * 1024), 'finalization')
      const parsed = validateState(current, context)
      check(parsed.subjectDigest === subjectDigest, 'INSTALL_FINALIZATION_INTENT_CHANGED')
      intent = parsed.intent; intentSeen ||= intent !== null
      await fresh()
      let { bootstrap, receipt, head } = parsed
      if (intent?.phase === 'complete' && bootstrap.status === 'active' && head.phase === 'retired') {
        await ports.jobs.assertComplete(intent, subjectDigest)
        await fresh()
        return result(0, 'INSTALL_OWNERSHIP_ACTIVE', 'committed', { status: 'installed', version: context.source.version, officialReference: intent.reference, installationActive: true, installReady: false, nativeQualified: false, qualified: false, bootstrapPending: false, changed: false })
      }
      if (!intent) {
        attemptedEffects = true // A lost database reply is an unknown effect, never an unchanged claim.
        const job = await ports.jobs.begin({ kind: 'lifecycle.adopt', requestFingerprint: subjectDigest, rootPrincipalId: context.rootPrincipalId })
        exact(job, ['id', 'referenceCode', 'createdAt'], 'INSTALL_FINALIZATION_JOB_INVALID')
        check(UUID.test(job.id) && REFERENCE.test(job.referenceCode) && iso(job.createdAt), 'INSTALL_FINALIZATION_JOB_INVALID')
        const active = { ...receipt, status: 'active', lastLifecycleReference: job.referenceCode }
        intent = intentOf({ schemaVersion: 1, jobId: job.id, reference: job.referenceCode, subjectDigest,
          previousReceiptSha256: parsed.previousReceiptSha256, expectedActiveSha256: digest(json(active)), phase: 'intent', observationDigest: null, createdAt: job.createdAt })
        intentSeen = true
        await fresh()
        bootstrap = { ...bootstrap, finalization: intent }
        await replace(INSTALL_FINALIZATION_PATHS.bootstrap, json(bootstrap), intent, fresh)
      }
      if (head.phase === 'idle') {
        head = { ...head, sequence: 1, phase: 'pending', operationId: intent.jobId, reference: intent.reference, requestFingerprint: subjectDigest, updatedAt: intent.createdAt }
        await replace(INSTALL_FINALIZATION_PATHS.head, json(head), intent, fresh)
      }
      await fresh()
      intent = { ...intent, phase: 'verified', observationDigest: digest(canonical(observation)) }
      bootstrap = { ...bootstrap, finalization: intent }
      await replace(INSTALL_FINALIZATION_PATHS.bootstrap, json(bootstrap), intent, fresh)
      const activeBytes = json({ ...receipt, status: 'active', lastLifecycleReference: intent.reference })
      check(digest(activeBytes) === intent.expectedActiveSha256, 'INSTALL_FINALIZATION_ACTIVE_BINDING_CHANGED')
      const actualReceipt = await ports.fs.readFile(INSTALL_FINALIZATION_PATHS.receipt)
      await fresh()
      if (digest(actualReceipt ?? '') === intent.previousReceiptSha256) await replace(INSTALL_FINALIZATION_PATHS.receipt, activeBytes, intent, fresh)
      else check(actualReceipt === activeBytes, 'INSTALL_FINALIZATION_RECEIPT_CHANGED')
      check(await ports.fs.readFile(INSTALL_FINALIZATION_PATHS.receipt) === activeBytes, 'INSTALL_FINALIZATION_READBACK_FAILED')
      await fresh()
      intent = { ...intent, phase: 'receipt_published' }
      bootstrap = { ...bootstrap, finalization: intent }
      await replace(INSTALL_FINALIZATION_PATHS.bootstrap, json(bootstrap), intent, fresh)
      attemptedEffects = true
      await ports.jobs.complete(intent, { receiptSha256: intent.expectedActiveSha256, observationDigest: intent.observationDigest })
      await fresh()
      head = { ...head, phase: 'retired', updatedAt: intent.createdAt }
      await replace(INSTALL_FINALIZATION_PATHS.head, json(head), intent, fresh)
      intent = { ...intent, phase: 'complete' }
      bootstrap = { ...bootstrap, status: 'active', finalization: intent }
      await replace(INSTALL_FINALIZATION_PATHS.bootstrap, json(bootstrap), intent, fresh)
      await fresh()
      return result(0, 'INSTALL_OWNERSHIP_ACTIVE', 'committed', { status: 'installed', version: context.source.version, officialReference: intent.reference, installationActive: true, installReady: false, nativeQualified: false, qualified: false, bootstrapPending: false, changed: true })

      async function replace(path, bytes, operation, guard) {
        check(Object.values(INSTALL_FINALIZATION_PATHS).includes(path), 'INSTALL_FINALIZATION_WRITE_DENIED')
        await guard()
        const temporary = path + '.install-' + operation.jobId + '-' + digest(bytes) + '.tmp'
        attemptedEffects = true
        try { await ports.fs.writeFileExclusive(temporary, bytes, 0o600) }
        catch (error) {
          if (error?.code !== 'EEXIST') throw error
          check(await ports.fs.readFile(temporary) === bytes, 'INSTALL_FINALIZATION_TEMPORARY_CHANGED')
        }
        await ports.syncPath(temporary)
        await guard()
        await ports.fs.rename(temporary, path)
        await ports.syncPath(posix.dirname(path))
        await guard()
        check(await ports.fs.readFile(path) === bytes, 'INSTALL_FINALIZATION_READBACK_FAILED')
        await guard()
      }
    })
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'INSTALL_FINALIZATION_UNVERIFIED'
    const attention = attemptedEffects || intentSeen
    return result(attention ? 6 : 3, code, attention ? 'attention' : 'blocked', { status: attention ? 'attention' : 'blocked', qualified: false, changed: attemptedEffects, bootstrapPending: true, reason: code })
  }
}

async function readState(fs) {
  const [bootstrapBytes, receiptBytes, headBytes] = await Promise.all(Object.values(INSTALL_FINALIZATION_PATHS).map(path => fs.readFile(path)))
  return { bootstrapBytes, receiptBytes, headBytes }
}
