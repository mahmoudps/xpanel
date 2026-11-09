import { createHash } from 'node:crypto'
import { mkdir, readlink, realpath } from 'node:fs/promises'
import { assertOwnedFile, parseInstallationReceipt, readInstallationReceipt, readTrustedFile, requireLinuxRoot, withTrustedDirectory } from './lifecycle-ownership.mjs'
import { assertPreparedReleaseCurrent, preparedReleaseInfo, observeInstalledReleaseTree, parsePreparedReleaseInput, withVisiblePreparedRelease } from './prepared-release.mjs'
import { renderManagedUnits, renderInstalledManagedUnitImages } from './managed-units.mjs'
import { captureManagedFile, managedPathAbsent, replaceManagedFile, replaceManagedLink, syncManagedDirectory } from './lifecycle-managed-files.mjs'

const ROOT = '/var/lib/xpanel-lifecycle', JOURNALS = ROOT + '/installation-transitions'
const PATHS = Object.freeze({ receipt: ROOT + '/installation.json', bootstrap: ROOT + '/bootstrap.json', dependencies: ROOT + '/install-dependencies.json', current: '/opt/xpanel/current' })
const UNITS = Object.freeze(['xpanel-api.service', 'xpanel-agent.service', 'xpanel-management-tls.service', 'xpanel-management-tls.timer'])
const SHA = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const transitions = new WeakMap()
const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (value, code) => { if (!value) fail(code) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => Buffer.from(JSON.stringify(value) + '\n')
const encoded = bytes => bytes.toString('base64')
const decoded = value => Buffer.from(value, 'base64')
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value) } return value }

/** Pure transition diagnostics. Exact byte images only; unknown state never authorizes overwrite. */
export function classifyInstallationImage(actual, previous, selected) {
  if (![actual, previous, selected].every(value => typeof value === 'string' && SHA.test(value))) return 'foreign'
  if (actual === selected) return 'selected'
  return actual === previous ? 'previous' : 'foreign'
}

/** Source projection only; native code captures actual new inode metadata before calling this. */
export function projectSelectedInstallationReceipt(prior, selected, files, reference) {
  const old = parseInstallationReceipt(prior)
  check(old.status === 'active' && typeof reference === 'string' && /^XP-JOB-[0-9]{4}-[0-9]{6,16}$/.test(reference), 'INSTALLATION_TRANSITION_REFERENCE_INVALID')
  check(selected && selected.releaseRoot === '/opt/xpanel/releases/' + selected.version
    && ['archiveSha256', 'manifestSha256', 'dependencyReceiptSha256'].every(key => SHA.test(selected[key])), 'INSTALLATION_TRANSITION_SOURCE_INVALID')
  return parseInstallationReceipt({ ...old, lastLifecycleReference: reference,
    source: { root: '/opt/xpanel', version: selected.version, archiveSha256: selected.archiveSha256,
      manifestSha256: selected.manifestSha256, dependencyReceiptSha256: selected.dependencyReceiptSha256, controlDbSchemaVersion: selected.controlDbSchemaVersion }, files })
}

async function authority(capability) {
  requireLinuxRoot()
  const safety = await import('./lifecycle-root-safety.mjs'), admission = await import('./lifecycle-admission.mjs')
  await safety.assertLifecycleRootSafetyHeld(capability, { effect: 'filesystem.write' })
  await admission.assertLifecycleExclusivePhysicalHeld(capability)
  const info = safety.getLifecycleRootSafetyInfo(capability)
  check(['upgrade', 'recover', 'rollback'].includes(info.kind) && UUID.test(info.operationId), 'INSTALLATION_TRANSITION_AUTHORITY_REQUIRED')
  return info
}
async function current(token) {
  const state = token && transitions.get(token)
  check(state, 'INSTALLATION_TRANSITION_CAPABILITY_REQUIRED')
  const info = await authority(state.capability)
  check(info.operationId === state.activeOperationId && info.reference === state.activeReference, 'INSTALLATION_TRANSITION_SCOPE_CHANGED')
  await withVisiblePreparedRelease(state.prepared, () => assertPreparedReleaseCurrent(state.prepared))
  return state
}
async function writeJournal(state, patch) {
  const value = { ...state.intent, ...patch }
  const written = await replaceManagedFile(state.path, json(value), 0o600, state.journal?.entry ?? null, () => authority(state.capability))
  state.intent = value; state.journal = written
}

async function verifyPreviousSource(state) {
  const old = state.original, dependency = JSON.parse(decoded(state.intent.previous.dependencies.bytes).toString('utf8'))
  check(dependency.kind === 'xpanel-installed-dependencies' && dependency.root === state.intent.previousTarget
    && dependency.archiveSha256 === old.source.archiveSha256 && dependency.manifestSha256 === old.source.manifestSha256
    && dependency.nodePath === old.runtime.nodePath && dependency.nodeSha256 === old.runtime.nodeSha256
    && dependency.nodeVersion === old.runtime.nodeVersion && SHA.test(dependency.tree?.treeSha256), 'INSTALLATION_TRANSITION_PREVIOUS_SOURCE_INVALID')
  await readTrustedFile(dependency.root + '/release-manifest.json', { maxBytes: 16 * 1024 * 1024, sha256: old.source.manifestSha256 })
  await readTrustedFile(dependency.root + '/pnpm-lock.yaml', { maxBytes: 4 * 1024 * 1024, sha256: dependency.lockfileSha256 })
  const tree = await observeInstalledReleaseTree(dependency.root)
  check(tree.treeSha256 === dependency.tree.treeSha256, 'INSTALLATION_TRANSITION_PREVIOUS_TREE_CHANGED')
}

/** Actual preimages, same-scope quiescence and prepared target pins are required before first write. */
export async function prepareInstallationTransition(capability, prepared) {
  const info = await authority(capability)
  check(typeof info.reference === 'string', 'INSTALLATION_TRANSITION_REFERENCE_REQUIRED')
  await withVisiblePreparedRelease(prepared, () => assertPreparedReleaseCurrent(prepared))
  const target = await withVisiblePreparedRelease(prepared, () => preparedReleaseInfo(prepared)), installed = await readInstallationReceipt()
  const original = installed.receipt
  check(original.status === 'active' && target.version !== original.source.version
    && target.runtime.nodePath === original.runtime.nodePath && target.runtime.nodeSha256 === original.runtime.nodeSha256, 'INSTALLATION_TRANSITION_SOURCE_INVALID')
  const previousTarget = '/opt/xpanel/releases/' + original.source.version
  check(await readlink(PATHS.current) === previousTarget && await realpath(PATHS.current) === previousTarget, 'INSTALLATION_TRANSITION_CURRENT_CHANGED')
  for (const file of original.files) await assertOwnedFile(file)
  const service = await import('./lifecycle-services.mjs')
  const before = await service.observeOwnedControlPlaneUnits(original, capability)
  await service.assertOwnedControlPlaneQuiescent(original, before, capability)
  const oldReceipt = await captureManagedFile(PATHS.receipt), oldBootstrap = await captureManagedFile(PATHS.bootstrap), oldDependencies = await captureManagedFile(PATHS.dependencies), oldCurrent = await captureManagedFile(PATHS.current)
  check(oldReceipt.entry.sha256 === installed.sha256 && oldDependencies.entry.sha256 === original.source.dependencyReceiptSha256, 'INSTALLATION_TRANSITION_METADATA_CHANGED')
  const bootstrap = JSON.parse(oldBootstrap.bytes.toString('utf8'))
  check(bootstrap.status === 'active' && bootstrap.version === original.source.version && bootstrap.archiveSha256 === original.source.archiveSha256
    && bootstrap.manifestSha256 === original.source.manifestSha256 && bootstrap.dependencyReceiptSha256 === original.source.dependencyReceiptSha256, 'INSTALLATION_TRANSITION_BOOTSTRAP_CHANGED')
  const dependency = await readTrustedFile(target.dependencyReceiptPath, { exactMode: 0o600, maxBytes: 16 * 1024, sha256: target.dependencyReceiptSha256 })
  const targetDependency = JSON.parse(dependency.bytes.toString('utf8'))
  check(targetDependency.kind === 'xpanel-installed-dependencies' && targetDependency.root === target.releaseRoot
    && targetDependency.archiveSha256 === target.archiveSha256 && targetDependency.manifestSha256 === target.manifestSha256
    && targetDependency.tree?.treeSha256 === target.treeSha256, 'INSTALLATION_TRANSITION_TARGET_DEPENDENCY_INVALID')
  const rendered = renderManagedUnits({ nodePath: original.runtime.nodePath, programRoot: target.releaseRoot, lifecycleParticipants: true })
  const units = []
  for (const name of UNITS) {
    const path = '/etc/systemd/system/' + name, old = await captureManagedFile(path), next = Buffer.from(rendered[name])
    const prior = original.files.find(file => file.path === path)
    check(prior && JSON.stringify(old.entry) === JSON.stringify(prior), 'INSTALLATION_TRANSITION_UNIT_CHANGED')
    units.push({ path, previous: { entry: old.entry, bytes: encoded(old.bytes) }, selected: { sha256: hash(next), mode: 0o644, bytes: encoded(next) } })
  }
  await withTrustedDirectory(ROOT, async parent => {
    if (await managedPathAbsent(JOURNALS)) { await mkdir(JOURNALS, { mode: 0o700 }); await syncManagedDirectory(ROOT) }
    await withTrustedDirectory(JOURNALS, async directory => { await directory.verify() }); await parent.verify()
  })
  const path = JOURNALS + '/' + info.operationId + '.json'
  check(await managedPathAbsent(path), 'INSTALLATION_TRANSITION_RECOVERY_REQUIRED')
  const remember = captured => ({ entry: captured.entry, bytes: encoded(captured.bytes) })
  const intent = { schemaVersion: 1, kind: 'xpanel-installation-transition', operationId: info.operationId, reference: info.reference,
    phase: 'prepared', selected: null, previousTarget, target: structuredClone(target), createdAt: new Date().toISOString(),
    binding: structuredClone(info.transitionBinding),
    previous: { receipt: remember(oldReceipt), bootstrap: remember(oldBootstrap), dependencies: remember(oldDependencies), current: oldCurrent.entry },
    targetDependencies: { sha256: dependency.sha256, bytes: encoded(dependency.bytes) }, units, checkpoints: [], published: null }
  check(intent.binding?.recordId && intent.binding?.origin && intent.binding?.intentBinding && SHA.test(intent.binding?.accountLifetimeSha256), 'INSTALLATION_TRANSITION_BINDING_REQUIRED')
  const state = { capability, prepared, original, intent, path, journal: null, selectedReceipt: original, activeOperationId: info.operationId, activeReference: info.reference }
  await verifyPreviousSource(state)
  await authority(capability); await withVisiblePreparedRelease(prepared, () => assertPreparedReleaseCurrent(prepared))
  await writeJournal(state, {})
  const token = Object.freeze({}); transitions.set(token, state)
  return token
}

async function observedOwnedReceipt(state) {
  const files = []
  for (const prior of state.original.files) {
    const unit = state.intent.units.find(item => item.path === prior.path)
    if (!unit) { await assertOwnedFile(prior); files.push(prior); continue }
    const actual = await captureManagedFile(prior.path)
    check(actual.entry.kind === 'file' && actual.entry.mode === 0o644
      && classifyInstallationImage(actual.entry.sha256, unit.previous.entry.sha256, unit.selected.sha256) !== 'foreign', 'INSTALLATION_TRANSITION_FOREIGN_UNIT')
    files.push(actual.entry)
  }
  return parseInstallationReceipt({ ...state.original, files })
}

/** Changes only 4 fixed unit files and current, with each completed image journaled and read back. */
export async function selectInstallationTransition(token, selection) {
  const state = await current(token)
  check(['target', 'previous'].includes(selection), 'INSTALLATION_TRANSITION_SELECTION_INVALID')
  check(state.intent.phase !== 'published', 'INSTALLATION_TRANSITION_ALREADY_PUBLISHED')
  if (selection === 'previous') await verifyPreviousSource(state)
  const service = await import('./lifecycle-services.mjs'), observed = await observedOwnedReceipt(state)
  const before = await service.observeOwnedControlPlaneUnits(observed, state.capability)
  await service.assertOwnedControlPlaneQuiescent(observed, before, state.capability)
  await writeJournal(state, { phase: 'selecting', selected: selection })
  for (const unit of state.intent.units) {
    const bytes = decoded(selection === 'target' ? unit.selected.bytes : unit.previous.bytes)
    const actual = await captureManagedFile(unit.path)
    check(classifyInstallationImage(actual.entry.sha256, unit.previous.entry.sha256, unit.selected.sha256) !== 'foreign', 'INSTALLATION_TRANSITION_FOREIGN_UNIT')
    const written = actual.entry.sha256 === hash(bytes) ? actual : await replaceManagedFile(unit.path, bytes, 0o644, actual.entry, () => current(token))
    await writeJournal(state, { checkpoints: [...state.intent.checkpoints, { path: unit.path, selection, entry: written.entry }] })
  }
  const target = selection === 'target' ? state.intent.target.releaseRoot : state.intent.previousTarget
  const link = await captureManagedFile(PATHS.current)
  check(link.entry.kind === 'symlink' && [state.intent.previousTarget, state.intent.target.releaseRoot].includes(link.entry.target), 'INSTALLATION_TRANSITION_FOREIGN_CURRENT')
  if (link.entry.target !== target) await replaceManagedLink(PATHS.current, target, link.entry, () => current(token))
  check(await realpath(PATHS.current) === target, 'INSTALLATION_TRANSITION_CURRENT_READBACK_FAILED')
  const files = (await observedOwnedReceipt(state)).files
  const selected = selection === 'target' ? state.intent.target : { ...state.original.source, releaseRoot: state.intent.previousTarget }
  state.selectedReceipt = projectSelectedInstallationReceipt(state.original, selected, files, state.activeReference)
  await writeJournal(state, { phase: 'selected', selectedReceipt: state.selectedReceipt })
  // Caller must perform pinned daemon-reload, then actual process/writer/health checks.
  return state.selectedReceipt
}

/** Publish only after root-safety's real current writer checks, never from a supplied observation. */
export async function publishInstallationTransition(token, hostOutcome) {
  const state = await current(token)
  const selection = hostOutcome === 'succeeded' ? 'target' : hostOutcome === 'rolled_back' ? 'previous' : null
  check(selection && state.intent.selected === selection && ['selected', 'publishing', 'published'].includes(state.intent.phase), 'INSTALLATION_TRANSITION_NOT_SELECTED')
  const safety = await import('./lifecycle-root-safety.mjs')
  const expectedRoot = selection === 'target' ? state.intent.target.releaseRoot : state.intent.previousTarget
  for (const role of ['agent', 'api']) {
    const observed = await safety.observeLifecycleWriterService(state.capability, role)
    check(observed.source === expectedRoot, 'INSTALLATION_TRANSITION_OLD_PROCESS_RUNNING')
  }
  check(await safety.verifyCurrentLifecycleWriterReadiness(), 'INSTALLATION_TRANSITION_WRITERS_UNVERIFIED')
  if (selection === 'previous') await verifyPreviousSource(state)
  for (const file of state.selectedReceipt.files) await assertOwnedFile(file)
  const previousBootstrap = JSON.parse(decoded(state.intent.previous.bootstrap.bytes).toString('utf8'))
  const selectedSource = state.selectedReceipt.source
  const dependencies = decoded(selection === 'target' ? state.intent.targetDependencies.bytes : state.intent.previous.dependencies.bytes)
  const bootstrap = { ...previousBootstrap, status: 'active', version: selectedSource.version, releaseRoot: expectedRoot,
    archiveSha256: selectedSource.archiveSha256, manifestSha256: selectedSource.manifestSha256,
    dependencyReceiptSha256: selectedSource.dependencyReceiptSha256, controlDbSchemaVersion: selectedSource.controlDbSchemaVersion,
    installationTransition: { operationId: state.intent.operationId, reference: state.intent.reference, previousBootstrapSha256: state.intent.previous.bootstrap.entry.sha256 } }
  let images = [
    { key: 'dependencies', bytes: dependencies }, { key: 'bootstrap', bytes: json(bootstrap) }, { key: 'receipt', bytes: json(state.selectedReceipt) },
  ]
  // Record all postimages before the first metadata rename; readback can identify a lost reply.
  if (state.intent.publication) images = state.intent.publication.map(image => ({ key: image.key, bytes: decoded(image.bytes) }))
  else await writeJournal(state, { phase: 'publishing', publication: images.map(image => ({ key: image.key, sha256: hash(image.bytes), bytes: encoded(image.bytes) })) })
  for (const image of images) {
    const path = PATHS[image.key], actual = await captureManagedFile(path), prior = state.intent.previous[image.key]
    check(classifyInstallationImage(actual.entry.sha256, prior.entry.sha256, hash(image.bytes)) !== 'foreign', 'INSTALLATION_TRANSITION_FOREIGN_METADATA')
    if (actual.entry.sha256 !== hash(image.bytes)) await replaceManagedFile(path, image.bytes, 0o600, actual.entry, () => current(token))
    await readTrustedFile(path, { maxBytes: 128 * 1024, exactMode: 0o600, sha256: hash(image.bytes) })
  }
  const installed = await readInstallationReceipt()
  check(installed.sha256 === hash(json(state.selectedReceipt)), 'INSTALLATION_TRANSITION_RECEIPT_READBACK_FAILED')
  await writeJournal(state, { phase: 'published', published: { receiptSha256: installed.sha256, source: installed.receipt.source, hostOutcome } })
  return frozen({ operationId: state.intent.operationId, journalPath: state.path, journalSha256: state.journal.entry.sha256,
    previousReceiptSha256: state.intent.previous.receipt.entry.sha256, installedReceiptSha256: installed.sha256, source: installed.receipt.source })
}

/** A crash inspector is read-only. It cannot mint the original host/admission authority or retry effects. */
export async function inspectInstallationTransition(operationId) {
  requireLinuxRoot(); check(UUID.test(operationId), 'INSTALLATION_TRANSITION_ID_INVALID')
  const file = await readTrustedFile(JOURNALS + '/' + operationId + '.json', { maxBytes: 1024 * 1024, exactMode: 0o600 })
  const intent = JSON.parse(file.bytes.toString('utf8'))
  check(intent.schemaVersion === 1 && intent.kind === 'xpanel-installation-transition' && intent.operationId === operationId
    && Array.isArray(intent.units) && intent.units.length === UNITS.length
    && intent.units.every((unit, index) => unit.path === '/etc/systemd/system/' + UNITS[index]), 'INSTALLATION_TRANSITION_JOURNAL_INVALID')
  const images = []
  for (const unit of intent.units) {
    const actual = await captureManagedFile(unit.path)
    images.push({ path: unit.path, state: classifyInstallationImage(actual.entry.sha256, unit.previous.entry.sha256, unit.selected.sha256) })
  }
  return frozen({ operationId, phase: intent.phase, selected: intent.selected, images, journalSha256: file.sha256,
    recoveryAuthority: 'required', ready: false })
}

/** Strict durable image parser. This is data validation, never an admission capability. */
export function parseInstallationTransitionJournal(input, operationId) {
  const keys = ['schemaVersion', 'kind', 'operationId', 'reference', 'phase', 'selected', 'previousTarget', 'target', 'createdAt', 'binding', 'previous', 'targetDependencies', 'units', 'checkpoints', 'published', 'selectedReceipt', 'publication']
  check(input && typeof input === 'object' && !Array.isArray(input) && [Object.prototype, null].includes(Object.getPrototypeOf(input))
    && Reflect.ownKeys(input).every(key => typeof key === 'string' && keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value')), 'INSTALLATION_TRANSITION_JOURNAL_INVALID')
  const value = structuredClone(input)
  check(value && value.schemaVersion === 1 && value.kind === 'xpanel-installation-transition'
    && typeof operationId === 'string' && UUID.test(operationId) && value.operationId === operationId
    && ['prepared', 'selecting', 'selected', 'publishing', 'published'].includes(value.phase)
    && [null, 'target', 'previous'].includes(value.selected), 'INSTALLATION_TRANSITION_JOURNAL_INVALID')
  const image = (item, path) => {
    check(item && item.entry?.path === path && item.entry.kind === 'file' && item.entry.mode === 0o600
      && typeof item.bytes === 'string' && item.bytes.length < 512 * 1024 && encoded(decoded(item.bytes)) === item.bytes
      && hash(decoded(item.bytes)) === item.entry.sha256, 'INSTALLATION_TRANSITION_PREIMAGE_INVALID')
  }
  for (const key of ['receipt', 'bootstrap', 'dependencies']) image(value.previous?.[key], PATHS[key])
  const original = parseInstallationReceipt(JSON.parse(decoded(value.previous.receipt.bytes)))
  check(original.status === 'active' && value.previousTarget === '/opt/xpanel/releases/' + original.source.version
    && value.previous.current?.path === PATHS.current && value.previous.current.kind === 'symlink'
    && value.previous.current.target === value.previousTarget, 'INSTALLATION_TRANSITION_PREVIOUS_INVALID')
  check(value.target && value.target.releaseRoot === '/opt/xpanel/releases/' + value.target.version
    && value.target.version !== original.source.version && SHA.test(value.target.archiveSha256)
    && SHA.test(value.target.manifestSha256) && SHA.test(value.target.dependencyReceiptSha256)
    && hash(decoded(value.targetDependencies.bytes)) === value.target.dependencyReceiptSha256,
  'INSTALLATION_TRANSITION_TARGET_INVALID')
  parsePreparedReleaseInput({ artifactPath: value.target.artifactPath, expectedArchiveSha256: value.target.archiveSha256 })
  // The release that wrote the journal rendered its selected units; an installed release's journal keeps its own images.
  const renders = renderInstalledManagedUnitImages({ nodePath: original.runtime.nodePath, programRoot: value.target.releaseRoot, lifecycleParticipants: true })
  check(Array.isArray(value.units) && value.units.length === UNITS.length && Array.isArray(value.checkpoints), 'INSTALLATION_TRANSITION_UNITS_INVALID')
  value.units.forEach((unit, index) => {
    const path = '/etc/systemd/system/' + UNITS[index], expected = original.files.find(file => file.path === path)
    check(unit?.path === path && JSON.stringify(unit.previous?.entry) === JSON.stringify(expected)
      && hash(decoded(unit.previous.bytes)) === expected?.sha256
      && renders.some(rendered => decoded(unit.selected?.bytes).equals(Buffer.from(rendered[UNITS[index]]))
        && unit.selected.sha256 === hash(Buffer.from(rendered[UNITS[index]]))), 'INSTALLATION_TRANSITION_UNIT_IMAGE_INVALID')
  })
  if (['selected', 'publishing', 'published'].includes(value.phase)) {
    const selected = parseInstallationReceipt(value.selectedReceipt)
    check(value.selected && selected.source.version === (value.selected === 'target' ? value.target.version : original.source.version), 'INSTALLATION_TRANSITION_SELECTION_INVALID')
  }
  if (['publishing', 'published'].includes(value.phase)) check(value.publication !== undefined, 'INSTALLATION_TRANSITION_PUBLICATION_INVALID')
  if (value.publication !== undefined) {
    check(Array.isArray(value.publication) && value.publication.length === 3, 'INSTALLATION_TRANSITION_PUBLICATION_INVALID')
    for (const [index, key] of ['dependencies', 'bootstrap', 'receipt'].entries()) {
      const item = value.publication[index]
      check(item?.key === key && typeof item.bytes === 'string' && item.sha256 === hash(decoded(item.bytes)), 'INSTALLATION_TRANSITION_PUBLICATION_INVALID')
    }
    check(value.publication[2].sha256 === hash(json(value.selectedReceipt)), 'INSTALLATION_TRANSITION_PUBLICATION_INVALID')
  }
  const binding = value.binding
  check(binding && typeof binding.recordId === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(binding.recordId)
    && binding.origin?.file === '/var/lib/xpanel/control.db' && UUID.test(binding.origin?.issuerId)
    && binding.intentBinding?.jobId === value.operationId && binding.intentBinding?.purpose === 'host.lifecycle.intent'
    && binding.intentBinding?.action === 'lifecycle.upgrade' && SHA.test(binding.intentBinding?.requestFingerprint)
    && SHA.test(binding.accountLifetimeSha256) && SHA.test(binding.snapshotReceiptSha256)
    && binding.backup?.path?.startsWith(ROOT + '/backups/') && SHA.test(binding.backup?.sha256), 'INSTALLATION_TRANSITION_BINDING_INVALID')
  return frozen(value)
}

/** Read actual root-protected images; only exact old/new images are recoverable. No effects. */
export async function readInstallationTransitionRecovery(operationId) {
  requireLinuxRoot(); check(typeof operationId === 'string' && UUID.test(operationId), 'INSTALLATION_TRANSITION_ID_INVALID')
  const path = JOURNALS + '/' + operationId + '.json', journal = await captureManagedFile(path)
  check(journal.entry.mode === 0o600 && journal.bytes.length <= 1024 * 1024, 'INSTALLATION_TRANSITION_JOURNAL_INVALID')
  const intent = parseInstallationTransitionJournal(JSON.parse(journal.bytes), operationId)
  const original = parseInstallationReceipt(JSON.parse(decoded(intent.previous.receipt.bytes)))
  const state = { original, intent }
  await verifyPreviousSource(state)
  const observed = await observedOwnedReceipt(state), images = []
  for (const key of ['receipt', 'bootstrap', 'dependencies']) {
    const actual = await captureManagedFile(PATHS[key]), selected = intent.publication?.find(item => item.key === key)
    check(actual.entry.mode === 0o600 && classifyInstallationImage(actual.entry.sha256, intent.previous[key].entry.sha256,
      selected?.sha256 ?? intent.previous[key].entry.sha256) !== 'foreign', 'INSTALLATION_TRANSITION_FOREIGN_METADATA')
    images.push(actual.entry)
  }
  const link = await captureManagedFile(PATHS.current)
  check(link.entry.kind === 'symlink' && [intent.previousTarget, intent.target.releaseRoot].includes(link.entry.target), 'INSTALLATION_TRANSITION_FOREIGN_CURRENT')
  for (const unit of intent.units) {
    const actual = observed.files.find(file => file.path === unit.path)
    const checkpoint = [...intent.checkpoints].reverse().find(point => point.path === unit.path && point.entry.sha256 === actual.sha256)
    // A recorded inode must remain exact. A lost rename reply is admitted only for the declared selecting phase.
    const known = checkpoint?.entry ?? (actual.sha256 === unit.previous.entry.sha256 ? unit.previous.entry : null)
    if (known) check(JSON.stringify(known) === JSON.stringify(actual), 'INSTALLATION_TRANSITION_UNIT_INODE_CHANGED')
    else check(intent.phase === 'selecting', 'INSTALLATION_TRANSITION_UNRECORDED_UNIT')
  }
  const currentVersion = link.entry.target === intent.previousTarget ? original.source.version : intent.target.version
  const selectedSource = currentVersion === original.source.version ? { ...original.source, releaseRoot: intent.previousTarget } : intent.target
  const provisionalReceipt = projectSelectedInstallationReceipt(original, selectedSource, observed.files, intent.reference)
  return frozen({ operationId, path, journalEntry: journal.entry, intent, provisionalReceipt, images: [...images, link.entry, ...observed.files],
    artifact: { artifactPath: intent.target.artifactPath, expectedArchiveSha256: intent.target.archiveSha256 },
    recoveryMode: ['publishing', 'published'].includes(intent.phase) ? 'finish-publication' : 'rollback' })
}

/** Reopen only under a fresh native recovery admission bound to this protected journal. */
export async function reopenInstallationTransition(capability, prepared, capture) {
  const info = await authority(capability)
  check(info.kind === 'recover' && info.recoveryOf === capture.operationId && info.recoveryJournalSha256 === capture.journalEntry.sha256,
    'INSTALLATION_TRANSITION_RECOVERY_AUTHORITY_REQUIRED')
  await withVisiblePreparedRelease(prepared, () => assertPreparedReleaseCurrent(prepared))
  const target = await withVisiblePreparedRelease(prepared, () => preparedReleaseInfo(prepared))
  check(target.archiveSha256 === capture.intent.target.archiveSha256 && target.releaseRoot === capture.intent.target.releaseRoot
    && target.treeSha256 === capture.intent.target.treeSha256, 'INSTALLATION_TRANSITION_TARGET_CHANGED')
  await assertOwnedFile(capture.journalEntry)
  for (const file of capture.images) await assertOwnedFile(file)
  const journal = await captureManagedFile(capture.path)
  const intent = structuredClone(capture.intent), original = parseInstallationReceipt(JSON.parse(decoded(intent.previous.receipt.bytes)))
  const token = Object.freeze({})
  transitions.set(token, { capability, prepared, original, intent, path: capture.path, journal,
    selectedReceipt: intent.selectedReceipt ? parseInstallationReceipt(intent.selectedReceipt) : capture.provisionalReceipt,
    activeOperationId: info.operationId, activeReference: info.reference })
  return token
}
