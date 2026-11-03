import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { assertOwnedFile, parseInstallationReceipt, requireLinuxRoot, withTrustedFile } from './lifecycle-ownership.mjs'
import { parseInstallationTransitionJournal } from './installation-transition.mjs'

const ROOT = '/var/lib/xpanel-lifecycle'
const SHA = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const REF = /^XP-JOB-(?:[0-9]{4}-)?[0-9]{6,16}$/
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }) }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const json = text => { check(typeof text === 'string' && Buffer.byteLength(text) <= 1024 * 1024, 'INSTALL_TRANSITION_IMAGE_INVALID'); return JSON.parse(text) }
const plain = (value, keys) => check(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value')), 'INSTALL_TRANSITION_IMAGE_INVALID')

/** Pure image binding only. Native root pins, source closure and DB/root-audit proof remain mandatory. */
export function inspectCompletedInstallationTransition(input) {
  plain(input, ['bootstrapBytes', 'receiptBytes', 'dependencyBytes', 'headBytes', 'journalBytes', 'terminalBytes'])
  const bootstrap = json(input.bootstrapBytes), receipt = parseInstallationReceipt(json(input.receiptBytes)), head = json(input.headBytes)
  const pointer = bootstrap.installationTransition
  plain(pointer, ['operationId', 'reference', 'previousBootstrapSha256'])
  check(UUID.test(pointer.operationId) && REF.test(pointer.reference) && SHA.test(pointer.previousBootstrapSha256), 'INSTALL_TRANSITION_POINTER_INVALID')
  const journal = parseInstallationTransitionJournal(json(input.journalBytes), pointer.operationId)
  plain(head, ['schemaVersion', 'issuerId', 'sequence', 'phase', 'operationId', 'reference', 'kind', 'requestFingerprint', 'updatedAt'])
  check(head.schemaVersion === 1 && head.phase === 'retired' && ['upgrade', 'recover'].includes(head.kind)
    && UUID.test(head.issuerId) && UUID.test(head.operationId) && REF.test(head.reference) && SHA.test(head.requestFingerprint)
    && Number.isSafeInteger(head.sequence) && head.sequence > 0 && Number.isFinite(Date.parse(head.updatedAt)), 'INSTALL_TRANSITION_NOT_RETIRED')
  check(bootstrap.status === 'active' && receipt.status === 'active' && journal.phase === 'published'
    && journal.reference === pointer.reference && journal.previous.bootstrap.entry.sha256 === pointer.previousBootstrapSha256
    && journal.binding.origin.issuerId === head.issuerId, 'INSTALL_TRANSITION_NOT_PUBLISHED')
  for (const [key, bytes] of [['bootstrap', input.bootstrapBytes], ['receipt', input.receiptBytes], ['dependencies', input.dependencyBytes]]) {
    const image = journal.publication.find(item => item.key === key)
    check(image?.sha256 === hash(bytes) && Buffer.from(image.bytes, 'base64').equals(Buffer.from(bytes)), 'INSTALL_TRANSITION_PUBLICATION_CHANGED')
  }
  const source = receipt.source
  check(bootstrap.schemaVersion === 1 && bootstrap.version === source.version && bootstrap.releaseRoot === '/opt/xpanel/releases/' + source.version
    && bootstrap.archiveSha256 === source.archiveSha256 && bootstrap.manifestSha256 === source.manifestSha256
    && bootstrap.dependencyReceiptSha256 === source.dependencyReceiptSha256 && hash(input.dependencyBytes) === source.dependencyReceiptSha256
    && bootstrap.controlDbSchemaVersion === source.controlDbSchemaVersion
    && bootstrap.runtime?.nodePath === receipt.runtime.nodePath && bootstrap.runtime?.nodeSha256 === receipt.runtime.nodeSha256,
  'INSTALL_TRANSITION_SOURCE_CHANGED')
  const published = journal.published, terminal = json(input.terminalBytes)
  plain(published, ['receiptSha256', 'source', 'hostOutcome'])
  plain(terminal, ['schemaVersion', 'installation', 'operationId', 'reference', 'requestFingerprint', 'hostOutcome', 'sourceArchiveSha256', 'databaseBackupSha256', 'completedAt'])
  const installed = terminal.installation
  plain(installed, ['operationId', 'journalPath', 'journalSha256', 'previousReceiptSha256', 'installedReceiptSha256', 'source'])
  check(['succeeded', 'rolled_back'].includes(published.hostOutcome) && published.hostOutcome === (journal.selected === 'target' ? 'succeeded' : 'rolled_back')
    && published.receiptSha256 === hash(input.receiptBytes) && same(published.source, source), 'INSTALL_TRANSITION_PUBLICATION_CHANGED')
  check(terminal.schemaVersion === 1 && terminal.operationId === head.operationId && terminal.reference === head.reference
    && terminal.requestFingerprint === head.requestFingerprint && terminal.hostOutcome === published.hostOutcome
    && terminal.sourceArchiveSha256 === source.archiveSha256 && terminal.databaseBackupSha256 === journal.binding.backup.sha256
    && terminal.completedAt === head.updatedAt && Number.isFinite(Date.parse(terminal.completedAt))
    && installed.operationId === journal.operationId && installed.journalPath === ROOT + '/installation-transitions/' + journal.operationId + '.json'
    && installed.journalSha256 === hash(input.journalBytes) && installed.previousReceiptSha256 === journal.previous.receipt.entry.sha256
    && installed.installedReceiptSha256 === hash(input.receiptBytes) && same(installed.source, source), 'INSTALL_TRANSITION_TERMINAL_CHANGED')
  if (head.kind === 'upgrade') check(head.operationId === journal.operationId && head.reference === journal.reference
    && head.requestFingerprint === journal.binding.intentBinding.requestFingerprint, 'INSTALL_TRANSITION_HEAD_CHANGED')
  return freeze({ bootstrap, receipt, head, journal, terminal, terminalSha256: hash(input.terminalBytes) })
}

async function absent(path) {
  try { await lstat(path); check(false, 'INSTALL_TRANSITION_RETIREMENT_INCOMPLETE') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

/** Read-only completed publication proof. Never repairs audit history, opens a writer or grants admission. */
async function withCompletedInstallationObservation(bootstrapBytes, callback, historicalHeadBytes) {
  requireLinuxRoot(); check(typeof callback === 'function', 'INSTALL_TRANSITION_CALLBACK_REQUIRED')
  const bootstrap = json(bootstrapBytes), operationId = bootstrap.installationTransition?.operationId
  check(UUID.test(operationId), 'INSTALL_TRANSITION_POINTER_INVALID')
  const pins = [], paths = [
    [ROOT + '/bootstrap.json', 16 * 1024, hash(bootstrapBytes)], [ROOT + '/installation.json', 64 * 1024],
    [ROOT + '/install-dependencies.json', 16 * 1024], [ROOT + '/HEAD', 16 * 1024],
    [ROOT + '/installation-transitions/' + operationId + '.json', 1024 * 1024],
  ]
  const hold = async (index, body) => {
    if (index === paths.length) return body()
    const [path, maxBytes, sha256] = paths[index]
    return withTrustedFile(path, { exactMode: 0o600, maxBytes, ...(sha256 ? { sha256 } : {}) }, async pin => {
      pins.push(pin); try { return await hold(index + 1, body) } finally { pins.pop() }
    })
  }
  return hold(0, async () => {
    const headBytes = historicalHeadBytes ?? pins[3].bytes.toString('utf8'), head = json(headBytes)
    check(UUID.test(head.operationId), 'INSTALL_TRANSITION_HEAD_CHANGED')
    return withTrustedFile(ROOT + '/terminal/' + head.operationId + '.json', { exactMode: 0o600, maxBytes: 128 * 1024 }, async terminalPin => {
      const projection = inspectCompletedInstallationTransition({ bootstrapBytes, receiptBytes: pins[1].bytes.toString('utf8'),
        dependencyBytes: pins[2].bytes.toString('utf8'), headBytes, journalBytes: pins[4].bytes.toString('utf8'), terminalBytes: terminalPin.bytes.toString('utf8') })
      const dbApi = await import('../packages/db/src/index.ts')
      return dbApi.withReadonlyOperationDatabase('/var/lib/xpanel/control.db', async db => {
        const origin = dbApi.getReadonlyOperationDatabaseOrigin(db), expectedOrigin = projection.journal.binding.origin
        check(['file', 'device', 'inode', 'issuerId'].every(key => origin[key] === expectedOrigin[key]), 'INSTALL_TRANSITION_DATABASE_CHANGED')
        const job = await dbApi.getDurableJob(db, head.operationId)
        check(job && job.kind === 'lifecycle.' + head.kind && job.status === 'succeeded' && job.referenceCode === head.reference,
          'INSTALL_TRANSITION_JOB_INCOMPLETE')
        const binding = job.detail?.lifecycleIntent
        check(binding?.purpose === 'host.lifecycle.intent' && binding.jobId === head.operationId && binding.action === job.kind
          && binding.requestFingerprint === head.requestFingerprint, 'INSTALL_TRANSITION_JOB_CHANGED')
        const original = await dbApi.getDurableJob(db, operationId)
        check(original?.status === 'succeeded' && original.kind === 'lifecycle.upgrade' && original.referenceCode === projection.journal.reference
          && same(original.detail?.lifecycleIntent, projection.journal.binding.intentBinding), 'INSTALL_TRANSITION_ORIGINAL_JOB_CHANGED')
        const record = await dbApi.getUpgrade(db, projection.journal.binding.recordId)
        check(record?.status === projection.terminal.hostOutcome && record.fromVersion === JSON.parse(Buffer.from(projection.journal.previous.receipt.bytes, 'base64')).source.version
          && record.toVersion === projection.journal.target.version && record.healthReport
          && SHA.test(record.healthReport.terminalSha256) && REF.test(record.healthReport.nativeLifecycleReference), 'INSTALL_TRANSITION_UPGRADE_UNACKNOWLEDGED')
        // Recovery may acknowledge an already committed prior terminal. Locate it only through the protected recovery chain.
        const proveAcknowledgement = () => proveTerminalAcknowledgement(record, head, operationId, projection.receipt, projection.terminal)

        return dbApi.withReadonlyLifecycleIntentObservation(db, binding, async currentAudit => {
            let live = true
            const assertCurrent = async () => {
              check(live, 'INSTALL_TRANSITION_OBSERVATION_EXPIRED')
              await dbApi.assertReadonlyOperationDatabaseCurrent(db); await currentAudit.assertCurrent()
              await dbApi.withReadonlyLifecycleIntentObservation(db, projection.journal.binding.intentBinding, originalAudit => originalAudit.assertCurrent())
              await currentAudit.assertCurrent()
              await absent(ROOT + '/writer-barrier.json'); await absent(ROOT + '/backups/retirement-attention.json')
              for (const pin of [...pins, terminalPin]) await pin.verify()
              for (const file of projection.receipt.files) await assertOwnedFile(file)
              await proveAcknowledgement()
              const currentJob = await dbApi.getDurableJob(db, head.operationId), currentOriginal = await dbApi.getDurableJob(db, operationId), currentRecord = await dbApi.getUpgrade(db, projection.journal.binding.recordId)
              check(same(currentJob, job) && same(currentOriginal, original) && same(currentRecord, record), 'INSTALL_TRANSITION_DATABASE_CHANGED')
            }
            try { await assertCurrent(); const value = await callback(Object.freeze({ bootstrap: projection.bootstrap, assertCurrent })); await assertCurrent(); return value }
            finally { live = false }
          })
      })
    })
  })
}


async function proveTerminalAcknowledgement(record, head, operationId, receipt, terminal) {
  let currentId = head.operationId
  for (let depth = 0; depth < 32; depth++) {
    let matched = false
    try {
      await withTrustedFile(ROOT + '/terminal/' + currentId + '.json', { exactMode: 0o600, maxBytes: 128 * 1024 }, async pin => {
        const prior = json(pin.bytes.toString('utf8'))
        matched = pin.sha256 === record.healthReport.terminalSha256 && prior.operationId === currentId
          && prior.reference === record.healthReport.nativeLifecycleReference && prior.installation?.operationId === operationId
          && prior.installation?.installedReceiptSha256 === terminal.installation.installedReceiptSha256
          && same(prior.installation?.source, receipt.source) && prior.hostOutcome === terminal.hostOutcome
        await pin.verify()
      })
    } catch (error) { if (error.code !== 'ENOENT' || currentId === head.operationId) throw error }
    if (matched) return
    check(currentId !== operationId, 'INSTALL_TRANSITION_ACKNOWLEDGEMENT_CHANGED')
    currentId = await withTrustedFile(ROOT + '/recovery-' + currentId + '.json', { exactMode: 0o600, maxBytes: 1024 * 1024 }, async pin => {
      const link = json(pin.bytes.toString('utf8'))
      check(link.operationId === currentId && link.transitionOperationId === operationId && UUID.test(link.priorOperationId), 'INSTALL_TRANSITION_RECOVERY_CHAIN_INVALID')
      await pin.verify(); return link.priorOperationId
    })
  }
  check(false, 'INSTALL_TRANSITION_RECOVERY_CHAIN_INVALID')
}

/** A rejected upgrade may retire without changing source. Its exact baseline preserves the prior HEAD bytes. */
export function inspectNoSourceChangeInstallation(input) {
  plain(input, ['bootstrapBytes', 'receiptBytes', 'dependencyBytes', 'headBytes', 'admissionBytes', 'terminalBytes'])
  const bootstrap = json(input.bootstrapBytes), receipt = parseInstallationReceipt(json(input.receiptBytes)), head = json(input.headBytes)
  const admission = json(input.admissionBytes), terminal = json(input.terminalBytes), installed = terminal.installation
  plain(head, ['schemaVersion', 'issuerId', 'sequence', 'phase', 'operationId', 'reference', 'kind', 'requestFingerprint', 'updatedAt'])
  plain(terminal, ['schemaVersion', 'installation', 'operationId', 'reference', 'requestFingerprint', 'hostOutcome', 'sourceArchiveSha256', 'databaseBackupSha256', 'completedAt'])
  plain(installed, ['operationId', 'journalPath', 'journalSha256', 'installedReceiptSha256', 'source', 'noSourceChange'])
  check(head.schemaVersion === 1 && head.phase === 'retired' && head.kind === 'recover' && UUID.test(head.operationId)
    && UUID.test(head.issuerId) && REF.test(head.reference) && SHA.test(head.requestFingerprint) && Number.isSafeInteger(head.sequence) && head.sequence > 0,
  'INSTALL_TRANSITION_NOT_RETIRED')
  check(admission.schemaVersion === 1 && admission.kind === 'xpanel-initial-upgrade-admission' && UUID.test(admission.operationId)
    && REF.test(admission.reference) && admission.binding?.recordId === admission.operationId && admission.binding?.intentBinding?.jobId === admission.operationId
    && admission.binding?.intentBinding?.action === 'lifecycle.upgrade' && admission.binding?.origin?.issuerId === head.issuerId
    && admission.binding.backup === null && SHA.test(admission.binding.accountLifetimeSha256), 'INSTALL_TRANSITION_BASELINE_INVALID')
  const expectedPaths = [ROOT + '/installation.json', ROOT + '/bootstrap.json', ROOT + '/install-dependencies.json', '/opt/xpanel/current', ...receipt.files.map(file => file.path)]
  check(bootstrap.status === 'active' && receipt.status === 'active' && same(admission.receipt, receipt)
    && admission.receiptSha256 === hash(input.receiptBytes) && admission.schema === receipt.source.controlDbSchemaVersion
    && Array.isArray(admission.entries) && admission.entries.length === expectedPaths.length && admission.entries.every((entry, i) => entry.path === expectedPaths[i])
    && admission.entries[0].sha256 === hash(input.receiptBytes) && admission.entries[1].sha256 === hash(input.bootstrapBytes)
    && admission.entries[2].sha256 === hash(input.dependencyBytes) && hash(input.dependencyBytes) === receipt.source.dependencyReceiptSha256
    && admission.entries[3].target === '/opt/xpanel/releases/' + receipt.source.version, 'INSTALL_TRANSITION_BASELINE_CHANGED')
  plain(admission.parentHead, ['value', 'sha256', 'bytes'])
  check(typeof admission.parentHead.bytes === 'string' && Buffer.byteLength(admission.parentHead.bytes) <= 16384
    && hash(admission.parentHead.bytes) === admission.parentHead.sha256 && admission.parentHead.sha256 === admission.parentHeadSha256
    && same(json(admission.parentHead.bytes), admission.parentHead.value) && admission.parentHead.value.sequence < head.sequence,
  'INSTALL_TRANSITION_PARENT_HEAD_CHANGED')
  check(terminal.schemaVersion === 1 && terminal.operationId === head.operationId && terminal.reference === head.reference
    && terminal.requestFingerprint === head.requestFingerprint && terminal.hostOutcome === 'rolled_back' && terminal.databaseBackupSha256 === null
    && terminal.sourceArchiveSha256 === receipt.source.archiveSha256 && terminal.completedAt === head.updatedAt && Number.isFinite(Date.parse(terminal.completedAt))
    && installed.noSourceChange === true && installed.operationId === admission.operationId && installed.journalPath === ROOT + '/admission-' + admission.operationId + '.json'
    && installed.journalSha256 === hash(input.admissionBytes) && installed.installedReceiptSha256 === hash(input.receiptBytes)
    && same(installed.source, receipt.source), 'INSTALL_TRANSITION_TERMINAL_CHANGED')
  return freeze({ bootstrap, receipt, head, admission, terminal })
}

/** Native proof follows only protected no-change baselines; historical HEAD is never written back. */
export async function withActiveInstallationObservation(bootstrapBytes, callback) {
  requireLinuxRoot(); check(typeof callback === 'function', 'INSTALL_TRANSITION_CALLBACK_REQUIRED')
  return withTrustedFile(ROOT + '/bootstrap.json', { exactMode: 0o600, maxBytes: 16 * 1024, sha256: hash(bootstrapBytes) }, bootstrapPin =>
    withTrustedFile(ROOT + '/installation.json', { exactMode: 0o600, maxBytes: 64 * 1024 }, receiptPin =>
      withTrustedFile(ROOT + '/install-dependencies.json', { exactMode: 0o600, maxBytes: 16 * 1024 }, dependencyPin =>
        withTrustedFile(ROOT + '/HEAD', { exactMode: 0o600, maxBytes: 16 * 1024 }, async headPin => {
          const verify = async () => { for (const pin of [bootstrapPin, receiptPin, dependencyPin, headPin]) await pin.verify(); await absent(ROOT + '/writer-barrier.json'); await absent(ROOT + '/backups/retirement-attention.json') }
          const prove = async (headBytes, depth) => {
            check(depth < 32, 'INSTALL_TRANSITION_HISTORY_LIMIT')
            const head = json(headBytes)
            if (head.kind === 'adopt') {
              check(!Object.hasOwn(json(bootstrapBytes), 'installationTransition'), 'INSTALL_TRANSITION_HISTORY_AMBIGUOUS')
              const { inspectInstallFinalizationRecovery } = await import('./install-finalization.mjs')
              const inspected = inspectInstallFinalizationRecovery({ bootstrapBytes, receiptBytes: receiptPin.bytes.toString('utf8'), headBytes })
              check(inspected.bootstrap.status === 'active' && head.phase === 'retired', 'INSTALL_TRANSITION_FINALIZATION_INCOMPLETE')
              await verify(); const value = await callback(Object.freeze({ bootstrap: inspected.bootstrap, assertCurrent: verify })); await verify(); return value
            }
            check(UUID.test(head.operationId) && head.phase === 'retired' && ['upgrade', 'recover'].includes(head.kind), 'INSTALL_TRANSITION_NOT_RETIRED')
            return withTrustedFile(ROOT + '/terminal/' + head.operationId + '.json', { exactMode: 0o600, maxBytes: 128 * 1024 }, async terminalPin => {
              const terminal = json(terminalPin.bytes.toString('utf8'))
              if (terminal.installation?.noSourceChange !== true) return withCompletedInstallationObservation(bootstrapBytes, callback, headBytes)
              const operationId = terminal.installation?.operationId
              check(UUID.test(operationId), 'INSTALL_TRANSITION_BASELINE_INVALID')
              return withTrustedFile(ROOT + '/admission-' + operationId + '.json', { exactMode: 0o600, maxBytes: 1024 * 1024 }, async admissionPin => {
                const projection = inspectNoSourceChangeInstallation({ bootstrapBytes, receiptBytes: receiptPin.bytes.toString('utf8'), dependencyBytes: dependencyPin.bytes.toString('utf8'),
                  headBytes, admissionBytes: admissionPin.bytes.toString('utf8'), terminalBytes: terminalPin.bytes.toString('utf8') })
                const dbApi = await import('../packages/db/src/index.ts')
                const verifyAuthority = () => dbApi.withReadonlyOperationDatabase('/var/lib/xpanel/control.db', async db => {
                  const origin = dbApi.getReadonlyOperationDatabaseOrigin(db)
                  check(['file', 'device', 'inode', 'issuerId'].every(key => origin[key] === projection.admission.binding.origin[key]), 'INSTALL_TRANSITION_DATABASE_CHANGED')
                  const job = await dbApi.getDurableJob(db, head.operationId), original = await dbApi.getDurableJob(db, operationId)
                  check(job?.status === 'succeeded' && job.kind === 'lifecycle.recover' && job.referenceCode === head.reference
                    && job.detail?.lifecycleIntent?.purpose === 'host.lifecycle.intent' && job.detail.lifecycleIntent.jobId === head.operationId
                    && job.detail.lifecycleIntent.action === job.kind && job.detail.lifecycleIntent.requestFingerprint === head.requestFingerprint && original?.status === 'succeeded'
                    && original.kind === 'lifecycle.upgrade' && original.referenceCode === projection.admission.reference
                    && same(original.detail?.lifecycleIntent, projection.admission.binding.intentBinding), 'INSTALL_TRANSITION_JOB_INCOMPLETE')
                  const binding = job.detail.lifecycleIntent, record = await dbApi.getUpgrade(db, operationId)
                  if (record) check(record.status === 'rolled_back' && record.fromVersion === projection.receipt.source.version
                    && record.toVersion === projection.admission.target.version && SHA.test(record.healthReport?.terminalSha256)
                    && REF.test(record.healthReport?.nativeLifecycleReference), 'INSTALL_TRANSITION_UPGRADE_UNACKNOWLEDGED')
                  return dbApi.withReadonlyLifecycleIntentObservation(db, binding, async currentAudit => {
                      const current = async () => {
                        await verify(); await terminalPin.verify(); await admissionPin.verify()
                        await dbApi.assertReadonlyOperationDatabaseCurrent(db); await currentAudit.assertCurrent()
                        await dbApi.withReadonlyLifecycleIntentObservation(db, projection.admission.binding.intentBinding, originalAudit => originalAudit.assertCurrent())
                        await currentAudit.assertCurrent()
                        for (const entry of projection.admission.entries) await assertOwnedFile(entry)
                        if (record) await proveTerminalAcknowledgement(record, head, operationId, projection.receipt, projection.terminal)
                        check(same(await dbApi.getDurableJob(db, head.operationId), job) && same(await dbApi.getDurableJob(db, operationId), original)
                          && same(await dbApi.getUpgrade(db, operationId), record), 'INSTALL_TRANSITION_DATABASE_CHANGED')
                      }
                      await current()
                    })
                })
                // Keep metadata FDs pinned, but retire DB/audit scopes before following historical authority.
                // Reopen and revalidate this immutable completed operation after the parent proof returns.
                await verifyAuthority()
                const value = await prove(projection.admission.parentHead.bytes, depth + 1)
                await verifyAuthority()
                return value
              })
            })
          }
          await verify(); const value = await prove(headPin.bytes.toString('utf8'), 0); await verify(); return value
        }))))
}
