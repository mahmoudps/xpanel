import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { requireLinuxRoot, withTrustedFile, withTrustedDirectory } from './lifecycle-ownership.mjs'
import { captureManagedFile, ensureManagedPrivateDirectory, managedPathAbsent, replaceManagedFile } from './lifecycle-managed-files.mjs'

const ROOT = '/var/lib/xpanel-lifecycle/issued-audit'
const SHA = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const scopes = new WeakMap(), active = new AsyncLocalStorage()
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }

async function selectorAbsent() {
  return withTrustedDirectory('/var/lib', async ancestor => {
    try { await lstat('/var/lib/xpanel-lifecycle') } catch (error) { if (error.code !== 'ENOENT') throw error; await ancestor.verify(); return true }
    return withTrustedDirectory('/var/lib/xpanel-lifecycle', async parent => {
      let directory
      try { directory = await lstat(ROOT) } catch (error) { if (error.code !== 'ENOENT') throw error }
      await parent.verify(); await ancestor.verify()
      if (!directory) return true
      return withTrustedDirectory(ROOT, async held => { const absent = await managedPathAbsent(ROOT + '/LATEST'); await held.verify(); return absent })
    })
  })
}

/** Root journal syntax only. Its plan is validated independently by the existing audit parser/observer. */
export function parseIssuedLifecycleAuditJournal(value, expectedJobId) {
  const fields = ['schemaVersion', 'kind', 'job', 'origin', 'intentBinding', 'plan', 'parentHead', 'parentBarrier', 'fence', 'baseline',
    'helper', 'coordinatorReceiptSha256', 'issuer', 'accountLifetimeSha256', 'sourceImages', 'issuedAt']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
    || fields.some(key => !Object.hasOwn(value, key)) || value.schemaVersion !== 1 || value.kind !== 'xpanel-issued-lifecycle-audit'
    || !UUID.test(expectedJobId) || value.job?.id !== expectedJobId || !/^XP-JOB-(?:[0-9]{4}-)?[0-9]{6,16}$/.test(value.job?.reference)
    || !['lifecycle.upgrade', 'lifecycle.recover'].includes(value.intentBinding?.action) || value.intentBinding?.purpose !== 'host.lifecycle.intent'
    || value.intentBinding?.jobId !== expectedJobId || !UUID.test(value.intentBinding?.principalId) || !SHA.test(value.intentBinding?.requestFingerprint)
    || value.origin?.file !== '/var/lib/xpanel/control.db' || !UUID.test(value.origin?.issuerId)
    || !['device', 'inode'].every(key => /^[0-9]+$/.test(value.origin?.[key]))
    || JSON.stringify(value.plan?.binding) !== JSON.stringify(value.intentBinding) || JSON.stringify(value.plan?.origin) !== JSON.stringify(value.origin)
    || value.plan?.schemaVersion !== 1 || value.plan?.purpose !== 'issued-lifecycle-append') fail('LIFECYCLE_ISSUED_AUDIT_JOURNAL_INVALID')
  const head = value.parentHead
  if (typeof head?.bytes !== 'string' || Buffer.byteLength(head.bytes) > 16384 || !SHA.test(head.sha256) || hash(head.bytes) !== head.sha256
    || JSON.stringify(JSON.parse(head.bytes)) !== JSON.stringify(head.value)) fail('LIFECYCLE_ISSUED_AUDIT_HEAD_INVALID')
  const barrier = value.parentBarrier
  if (barrier !== null && (typeof barrier?.bytes !== 'string' || Buffer.byteLength(barrier.bytes) > 16384 || !SHA.test(barrier.sha256)
    || hash(barrier.bytes) !== barrier.sha256 || JSON.stringify(JSON.parse(barrier.bytes)) !== JSON.stringify(barrier.value))) fail('LIFECYCLE_ISSUED_AUDIT_BARRIER_INVALID')
  const fence = value.fence
  if (typeof fence?.bytes !== 'string' || Buffer.byteLength(fence.bytes) > 16384 || !SHA.test(fence.sha256) || hash(fence.bytes) !== fence.sha256
    || JSON.stringify(JSON.parse(fence.bytes)) !== JSON.stringify(fence.value)) fail('LIFECYCLE_ISSUED_AUDIT_FENCE_INVALID')
  if (barrier === null && (fence.value.phase !== 'attention' || fence.value.kind !== 'upgrade' || fence.value.operationId !== expectedJobId
    || fence.value.requestFingerprint !== value.intentBinding.requestFingerprint || fence.value.sequence !== head.value.sequence + 1)
    || barrier !== null && fence.sha256 !== barrier.sha256) fail('LIFECYCLE_ISSUED_AUDIT_FENCE_BINDING_INVALID')
  if (!UUID.test(value.baseline?.operationId) || !SHA.test(value.baseline?.sha256)
    || ![`/var/lib/xpanel-lifecycle/admission-${value.baseline.operationId}.json`, `/var/lib/xpanel-lifecycle/installation-transitions/${value.baseline.operationId}.json`].includes(value.baseline.path)
    || value.intentBinding.action === 'lifecycle.upgrade' && value.baseline.operationId !== expectedJobId
    || !SHA.test(value.helper?.archiveSha256) || !/^\/opt\/xpanel\/releases\/[0-9]+\.[0-9]+\.[0-9]+$/.test(value.helper?.releaseRoot)
    || !SHA.test(value.coordinatorReceiptSha256) || !SHA.test(value.accountLifetimeSha256)
    || !Number.isSafeInteger(value.issuer?.pid) || value.issuer.pid < 1 || !/^[0-9]+$/.test(value.issuer?.start)
    || !UUID.test(value.issuer?.bootId) || value.issuer?.coordinatorUnit !== 'xpanel-lifecycle.service'
    || !Array.isArray(value.sourceImages) || value.sourceImages.length < 1 || value.sourceImages.length > 256
    || !Number.isFinite(Date.parse(value.issuedAt))) fail('LIFECYCLE_ISSUED_AUDIT_BINDING_INVALID')
  return value
}

/** Called only inside the actual audit planner callback and native bootstrap admission. */
export async function writeIssuedLifecycleAuditJournal(capability, plan) {
  requireLinuxRoot()
  const native = await import('./lifecycle-root-safety.mjs')
  const assertAuthority = () => native.assertLifecycleAuditIssuanceHeld(capability, plan)
  await assertAuthority()
  const context = native.getLifecycleAuditIssuanceInfo(capability)
  const value = parseIssuedLifecycleAuditJournal({ schemaVersion: 1, kind: 'xpanel-issued-lifecycle-audit', ...context, plan }, context.job.id)
  await ensureManagedPrivateDirectory(ROOT, assertAuthority)
  const file = await replaceManagedFile(ROOT + '/' + context.job.id + '.json', Buffer.from(JSON.stringify(value) + '\n'), 0o600, null, assertAuthority)
  const latest = ROOT + '/LATEST', previous = await managedPathAbsent(latest) ? null : await captureManagedFile(latest)
  if (previous) parseSelector(JSON.parse(previous.bytes))
  await replaceManagedFile(latest, Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'xpanel-issued-audit-selector', jobId: context.job.id,
    journalSha256: file.entry.sha256, parentHeadSha256: context.parentHead.sha256, helperArchiveSha256: context.helper.archiveSha256 }) + '\n'),
    0o600, previous?.entry ?? null, assertAuthority)
  await assertAuthority()
  return Object.freeze({ path: file.entry.path, sha256: file.entry.sha256 })
}

function parseSelector(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'helperArchiveSha256,jobId,journalSha256,kind,parentHeadSha256,schemaVersion'
    || value.schemaVersion !== 1 || value.kind !== 'xpanel-issued-audit-selector' || !UUID.test(value.jobId)
    || !['journalSha256', 'parentHeadSha256', 'helperArchiveSha256'].every(key => SHA.test(value[key]))) fail('LIFECYCLE_ISSUED_AUDIT_SELECTOR_INVALID')
  return value
}

/** Fixed root selector, bound again to the actual retained HEAD/helper by the native producer. */
export async function withSelectedIssuedLifecycleAuditJournal(headSha256, helperArchiveSha256, callback) {
  requireLinuxRoot()
  if (!SHA.test(headSha256) || !SHA.test(helperArchiveSha256) || typeof callback !== 'function') fail('LIFECYCLE_ISSUED_AUDIT_SELECTOR_INVALID')
  if (await selectorAbsent()) return callback(null)
  const selected = await withTrustedFile(ROOT + '/LATEST', { exactMode: 0o600, maxBytes: 4096 }, async pin => parseSelector(JSON.parse(pin.bytes)))
  if (selected.parentHeadSha256 !== headSha256 || selected.helperArchiveSha256 !== helperArchiveSha256) return callback(null)
  return withIssuedLifecycleAuditJournal(selected.jobId, async capability => {
    const actual = issuedLifecycleAuditJournalInfo(capability)
    if (actual.sha256 !== selected.journalSha256 || actual.journal.parentHead.sha256 !== headSha256
      || actual.journal.helper.archiveSha256 !== helperArchiveSha256) fail('LIFECYCLE_ISSUED_AUDIT_SELECTOR_CHANGED')
    return callback(capability)
  })
}

const registered = capability => {
  const scope = capability && typeof capability === 'object' ? scopes.get(capability) : undefined
  if (!scope?.live || active.getStore() !== scope) fail('LIFECYCLE_ISSUED_AUDIT_SCOPE_REQUIRED')
  return scope
}
export async function assertIssuedLifecycleAuditJournalCurrent(capability) { const scope = registered(capability); await scope.pin.verify() }
export function issuedLifecycleAuditJournalInfo(capability) {
  const scope = registered(capability)
  return Object.freeze({ path: scope.path, sha256: scope.pin.sha256, journal: structuredClone(scope.value) })
}
export async function withIssuedLifecycleAuditJournal(jobId, callback) {
  requireLinuxRoot()
  if (typeof jobId !== 'string' || !UUID.test(jobId) || typeof callback !== 'function' || active.getStore()) fail('LIFECYCLE_ISSUED_AUDIT_SELECTOR_INVALID')
  const path = ROOT + '/' + jobId + '.json'
  return withTrustedFile(path, { exactMode: 0o600, maxBytes: 2 * 1024 * 1024 }, async pin => {
    const value = parseIssuedLifecycleAuditJournal(JSON.parse(pin.bytes), jobId), capability = Object.freeze({})
    const scope = { live: true, value, path, pin }; scopes.set(capability, scope)
    try { return await active.run(scope, async () => { await pin.verify(); const result = await callback(capability); await pin.verify(); return result }) }
    finally { scope.live = false; scopes.delete(capability) }
  })
}

function completedAppend(value, journal, journalSha256) {
  const verified = journal.plan.record
  if (!value || Object.keys(value).sort().join(',') !== 'binding,jobId,journalSha256,kind,origin,schemaVersion,verified'
    || value.schemaVersion !== 1 || value.kind !== 'xpanel-issued-audit-completed-append'
    || value.jobId !== journal.job.id || value.journalSha256 !== journalSha256
    || JSON.stringify(value.binding) !== JSON.stringify(journal.intentBinding) || JSON.stringify(value.origin) !== JSON.stringify(journal.origin)
    || Object.keys(value.verified ?? {}).sort().join(',') !== 'entryHash,eventUid,seq'
    || ['eventUid', 'entryHash', 'seq'].some(key => value.verified[key] !== verified[key])) fail('LIFECYCLE_ISSUED_AUDIT_COMPLETION_INVALID')
  return value
}

/** Durable acknowledgement of the completed append only; it does not retire the lifecycle barrier. */
export async function writeIssuedLifecycleAuditCompletion(capability) {
  requireLinuxRoot()
  const native = await import('./lifecycle-root-safety.mjs')
  const assertAuthority = () => native.assertLifecycleIssuedAuditCompletionHeld(capability)
  await assertAuthority()
  const info = native.getLifecycleIssuedAuditCompletionInfo(capability)
  return withTrustedFile(ROOT + '/' + info.jobId + '.json', { exactMode: 0o600, maxBytes: 2 * 1024 * 1024, sha256: info.journalSha256 }, async pin => {
    const journal = parseIssuedLifecycleAuditJournal(JSON.parse(pin.bytes), info.jobId)
    const value = completedAppend({ schemaVersion: 1, kind: 'xpanel-issued-audit-completed-append', ...info }, journal, pin.sha256)
    const path = ROOT + '/' + info.jobId + '.complete.json', bytes = Buffer.from(JSON.stringify(value) + '\n')
    if (await managedPathAbsent(path)) await replaceManagedFile(path, bytes, 0o600, null, assertAuthority)
    await withTrustedFile(path, { exactMode: 0o600, maxBytes: 16384, sha256: hash(bytes) }, async () => {})
    await pin.verify(); await assertAuthority()
  })
}

/** SQL-free fixed gate, callable by ordinary finalization/reconcile without a coordinator scope.
 * A completion is written only from an opaque full intent receipt, never from repair's plain result.
 * It permits subsequent audit writes; HEAD, source and the old-compatible barrier remain independent gates. */
export async function assertNoUnretiredIssuedLifecycleAudit() {
  requireLinuxRoot()
  if (await selectorAbsent()) return
  await withTrustedFile(ROOT + '/LATEST', { exactMode: 0o600, maxBytes: 4096 }, async selected => {
    const selector = parseSelector(JSON.parse(selected.bytes))
    await withTrustedFile(ROOT + '/' + selector.jobId + '.json', { exactMode: 0o600, maxBytes: 2 * 1024 * 1024, sha256: selector.journalSha256 }, async pin => {
      const journal = parseIssuedLifecycleAuditJournal(JSON.parse(pin.bytes), selector.jobId)
      if (journal.parentHead.sha256 !== selector.parentHeadSha256 || journal.helper.archiveSha256 !== selector.helperArchiveSha256) fail('LIFECYCLE_ISSUED_AUDIT_SELECTOR_CHANGED')
      await withTrustedFile(ROOT + '/' + selector.jobId + '.complete.json', { exactMode: 0o600, maxBytes: 16384 }, async complete => {
        completedAppend(JSON.parse(complete.bytes), journal, pin.sha256)
        await complete.verify(); await pin.verify(); await selected.verify()
      })
    })
  })
}
