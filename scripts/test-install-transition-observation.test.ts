import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { pathToFileURL } from 'node:url'
import { isBuiltin } from 'node:module'
import { describe, it } from 'vitest'
import { renderInstalledManagedUnitImages, renderManagedUnits } from './managed-units.mjs'
import { parseInstallationTransitionJournal } from './installation-transition.mjs'
import { inspectCompletedInstallationTransition, inspectNoSourceChangeInstallation } from './install-transition-observation.mjs'

// Pure durable-image contracts only. Fixtures are never accepted as native ownership/readiness capabilities.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const text = (value: unknown) => JSON.stringify(value) + '\n'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const encoded = (value: string) => Buffer.from(value).toString('base64')
const root = '/var/lib/xpanel-lifecycle', time = '2026-11-03T00:00:00.000Z'
const ref = (n: number) => 'XP-JOB-2026-' + String(n).padStart(6, '0')
type ImageSet = { bootstrapBytes: string; receiptBytes: string; dependencyBytes: string; headBytes: string; journalBytes: string; terminalBytes: string }
function fixture(outcome: 'succeeded' | 'rolled_back' = 'succeeded', previous?: ImageSet): ImageSet {
  const operationId = previous ? id(20) : id(10), reference = previous ? ref(20) : ref(10)
  const oldVersion = previous ? '0.1.1' : '0.1.0', version = previous ? '0.1.2' : '0.1.1'
  const runtime = { nodePath: '/usr/bin/node', nodeVersion: '26.12.1', nodeSha256: '1'.repeat(64), systemctlSha256: '2'.repeat(64), nginxSha256: '3'.repeat(64) }
  const source = { root: '/opt/xpanel', version: oldVersion, archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), dependencyReceiptSha256: hash('{}\n'), controlDbSchemaVersion: 6 }
  const units = ['xpanel-api.service', 'xpanel-agent.service', 'xpanel-management-tls.service', 'xpanel-management-tls.timer'] as const
  const links = ['/usr/local/bin/xpanel-ctl', '/etc/systemd/system/multi-user.target.wants/xpanel-api.service', '/etc/systemd/system/multi-user.target.wants/xpanel-agent.service', '/etc/systemd/system/timers.target.wants/xpanel-management-tls.timer']
  const paths = ['/usr/local/bin/xpanel-ctl', '/opt/xpanel/bin/xpanel-ctl', ...units.map(unit => '/etc/systemd/system/' + unit), ...links.slice(1), '/etc/nginx/conf.d/xpanel-management.conf', '/etc/nginx/conf.d/xpanel-management-challenge.conf', '/etc/nginx/xpanel-management/ingress-secret.conf']
  const files = paths.map((path, index) => ({ path, kind: links.includes(path) ? 'symlink' : 'file', device: '1', inode: String(index + 10), size: 1,
    mode: links.includes(path) ? 0o777 : path === '/opt/xpanel/bin/xpanel-ctl' ? 0o755 : path.endsWith('secret.conf') ? 0o600 : 0o644,
    sha256: links.includes(path) ? null : hash(path), target: links.includes(path) ? path === links[0] ? '/opt/xpanel/bin/xpanel-ctl' : '/etc/systemd/system/' + path.split('/').at(-1) : null }))
  const oldReceipt = previous ? JSON.parse(previous.receiptBytes) : { schemaVersion: 1, product: 'xpanel', status: 'active', officialReference: null, lastLifecycleReference: ref(1), createdAt: time, source, runtime, writerProtocol: 'lifecycle-admission-v1', units, files }
  const oldBootstrap = previous ? JSON.parse(previous.bootstrapBytes) : { schemaVersion: 1, status: 'active', createdAt: time, version: oldVersion, releaseRoot: '/opt/xpanel/releases/' + oldVersion, ...Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'root')), runtime: { nodePath: runtime.nodePath, nodeSha256: runtime.nodeSha256 }, finalization: { historicalOnly: true, archiveSha256: source.archiveSha256 } }
  const oldDeps = previous ? previous.dependencyBytes : '{}\n', newDeps = text({ kind: 'xpanel-installed-dependencies', version })
  const target = { artifactPath: '/root/releases/xpanel-' + version + '.tar.gz', releaseRoot: '/opt/xpanel/releases/' + version, version, archiveSha256: (previous ? 'e' : 'c').repeat(64), manifestSha256: 'd'.repeat(64), dependencyReceiptSha256: hash(newDeps), controlDbSchemaVersion: 6 }
  const rendered = renderManagedUnits({ nodePath: runtime.nodePath, programRoot: target.releaseRoot, lifecycleParticipants: true })
  const unitImages = units.map(unit => {
    const path = '/etc/systemd/system/' + unit, prior = oldReceipt.files.find((file: { path: string }) => file.path === path)
    // Match exact preceding unit bytes for a chained release, preserving previous-image integrity.
    const priorText = previous ? renderManagedUnits({ nodePath: runtime.nodePath, programRoot: '/opt/xpanel/releases/' + oldVersion, lifecycleParticipants: true })[unit] : path
    return { path, previous: { entry: prior, bytes: encoded(priorText) }, selected: { bytes: encoded(rendered[unit]), sha256: hash(rendered[unit]), mode: 0o644 } }
  })
  const receipt = { ...oldReceipt, lastLifecycleReference: reference, source: outcome === 'succeeded' ? { root: '/opt/xpanel', ...Object.fromEntries(['version', 'archiveSha256', 'manifestSha256', 'dependencyReceiptSha256', 'controlDbSchemaVersion'].map(key => [key, target[key as keyof typeof target]])) } : oldReceipt.source,
    files: oldReceipt.files.map((file: { path: string }) => { const unit = unitImages.find(value => value.path === file.path); return outcome === 'succeeded' && unit ? { ...file, sha256: unit.selected.sha256, size: Buffer.byteLength(Buffer.from(unit.selected.bytes, 'base64')) } : file }) }
  const metadata = (key: string, bytes: string) => ({ entry: { path: root + '/' + ({ receipt: 'installation.json', bootstrap: 'bootstrap.json', dependencies: 'install-dependencies.json' })[key as 'receipt'], kind: 'file', mode: 0o600, sha256: hash(bytes) }, bytes: encoded(bytes) })
  const oldBootstrapBytes = text(oldBootstrap)
  const bootstrap = { ...oldBootstrap, version: receipt.source.version, releaseRoot: '/opt/xpanel/releases/' + receipt.source.version, archiveSha256: receipt.source.archiveSha256, manifestSha256: receipt.source.manifestSha256, dependencyReceiptSha256: receipt.source.dependencyReceiptSha256,
    installationTransition: { operationId, reference, previousBootstrapSha256: hash(oldBootstrapBytes) } }
  const bootstrapBytes = text(bootstrap), receiptBytes = text(receipt), dependencyBytes = outcome === 'succeeded' ? newDeps : oldDeps
  const journal = { schemaVersion: 1, kind: 'xpanel-installation-transition', operationId, reference, phase: 'published', selected: outcome === 'succeeded' ? 'target' : 'previous', previousTarget: '/opt/xpanel/releases/' + oldVersion, target, createdAt: time,
    binding: { recordId: operationId, origin: { file: '/var/lib/xpanel/control.db', device: '1', inode: '2', issuerId: id(1) }, intentBinding: { purpose: 'host.lifecycle.intent', jobId: operationId, action: 'lifecycle.upgrade', requestFingerprint: 'f'.repeat(64), principalId: id(2) }, accountLifetimeSha256: '4'.repeat(64), snapshotReceiptSha256: '5'.repeat(64), backup: { path: root + '/backups/copy.db', sha256: '6'.repeat(64) } },
    previous: { receipt: metadata('receipt', text(oldReceipt)), bootstrap: metadata('bootstrap', oldBootstrapBytes), dependencies: metadata('dependencies', oldDeps), current: { path: '/opt/xpanel/current', kind: 'symlink', target: '/opt/xpanel/releases/' + oldVersion } },
    targetDependencies: { bytes: encoded(newDeps) }, units: unitImages, checkpoints: [], selectedReceipt: receipt,
    publication: [['dependencies', dependencyBytes], ['bootstrap', bootstrapBytes], ['receipt', receiptBytes]].map(([key, bytes]) => ({ key, bytes: encoded(bytes!), sha256: hash(bytes!) })),
    published: { receiptSha256: hash(receiptBytes), source: receipt.source, hostOutcome: outcome } }
  const journalBytes = text(journal)
  const head = { schemaVersion: 1, issuerId: id(1), sequence: previous ? 3 : 2, phase: 'retired', operationId: outcome === 'rolled_back' ? id(11) : operationId, reference: outcome === 'rolled_back' ? ref(11) : reference, kind: outcome === 'rolled_back' ? 'recover' : 'upgrade', requestFingerprint: 'f'.repeat(64), updatedAt: time }
  const terminal = { schemaVersion: 1, installation: { operationId, journalPath: root + '/installation-transitions/' + operationId + '.json', journalSha256: hash(journalBytes), previousReceiptSha256: hash(text(oldReceipt)), installedReceiptSha256: hash(receiptBytes), source: receipt.source }, operationId: head.operationId, reference: head.reference, requestFingerprint: head.requestFingerprint, hostOutcome: outcome, sourceArchiveSha256: receipt.source.archiveSha256, databaseBackupSha256: '6'.repeat(64), interruptedIssuance: null, completedAt: time }
  return { bootstrapBytes, receiptBytes, dependencyBytes, headBytes: text(head), journalBytes, terminalBytes: text(terminal) }
}

describe('completed source observations are distinct from historical finalization', () => {
  it('accepts upgrade -> observe/acquire source projection -> next upgrade without discarding finalization history', () => {
    const first = fixture(), observed = inspectCompletedInstallationTransition(first)
    assert.equal(observed.bootstrap.version, '0.1.1')
    assert.equal((observed.bootstrap.finalization as unknown as { archiveSha256: string }).archiveSha256, 'a'.repeat(64))
    const second = fixture('succeeded', first)
    assert.equal(inspectCompletedInstallationTransition(second).bootstrap.version, '0.1.2')
    assert.equal(JSON.parse(second.journalBytes).previous.bootstrap.entry.sha256, hash(first.bootstrapBytes))
  })
  it('accepts a completed rollback source projection under fresh recovery HEAD, without treating the old finalization as new source proof', () => {
    const observed = inspectCompletedInstallationTransition(fixture('rolled_back'))
    assert.equal(observed.bootstrap.version, '0.1.0'); assert.equal(observed.head.kind, 'recover')
    assert.notEqual(observed.head.reference, observed.receipt.lastLifecycleReference)
  })
  it('reads the interrupted issuance the upgrade writer records, and refuses a terminal without it or with a foreign shape', () => {
    const base = fixture(), terminal = JSON.parse(base.terminalBytes) as Record<string, unknown>
    const issued = { ...terminal, interruptedIssuance: { binding: { recordId: 'r' }, verified: { audit: true }, sourceWasNeverAdmitted: false, parentHeadSha256: 'c'.repeat(64) } }
    assert.equal(inspectCompletedInstallationTransition({ ...base, terminalBytes: JSON.stringify(issued) }).terminal.interruptedIssuance !== null, true)
    const { interruptedIssuance: _dropped, ...older } = terminal
    assert.throws(() => inspectCompletedInstallationTransition({ ...base, terminalBytes: JSON.stringify(older) }), /INSTALL_TRANSITION_IMAGE_INVALID/)
    for (const bad of [{ binding: {}, verified: {}, sourceWasNeverAdmitted: 'no', parentHeadSha256: 'c'.repeat(64) }, { binding: {}, verified: {}, sourceWasNeverAdmitted: true, parentHeadSha256: 'c'.repeat(64), extra: 1 }, 'x'])
      assert.throws(() => inspectCompletedInstallationTransition({ ...base, terminalBytes: JSON.stringify({ ...terminal, interruptedIssuance: bad }) }), /INSTALL_TRANSITION_IMAGE_INVALID/)
  })

  it('parses a journal an installed release wrote with its own unit images, and refuses a foreign one', () => {
    const journal = JSON.parse(fixture().journalBytes)
    const [, installed] = renderInstalledManagedUnitImages({ nodePath: '/usr/bin/node', programRoot: journal.target.releaseRoot, lifecycleParticipants: true })
    const withApi = (bytes: string) => ({ ...journal, units: [{ ...journal.units[0], selected: { ...journal.units[0].selected, bytes: encoded(bytes), sha256: hash(bytes) } }, ...journal.units.slice(1)] })
    assert.equal(parseInstallationTransitionJournal(withApi(installed['xpanel-api.service']), id(10)).phase, 'published')
    assert.throws(() => parseInstallationTransitionJournal(withApi(installed['xpanel-api.service'].replace('=96', '=512')), id(10)), /INSTALLATION_TRANSITION_UNIT_IMAGE_INVALID/)
  })

  it('refuses incomplete publication, unsettled HEAD, terminal drift and an old receipt substitution', () => {
    const good = fixture()
    const mutate = (key: keyof typeof good, update: (value: any) => void) => { const copy = { ...good }, value = JSON.parse(copy[key]); update(value); copy[key] = text(value); return copy }
    for (const value of [mutate('journalBytes', v => { v.phase = 'publishing' }), mutate('headBytes', v => { v.phase = 'retirement_pending' }), mutate('terminalBytes', v => { v.installation.journalSha256 = '0'.repeat(64) }), mutate('receiptBytes', v => { v.source.version = '0.1.0' })]) assert.throws(() => inspectCompletedInstallationTransition(value))
  })
  it('requires exact retained parent HEAD and unchanged metadata for a no-source-change retirement', () => {
    const previous = fixture(), head = { ...JSON.parse(previous.headBytes), operationId: id(31), reference: ref(31), kind: 'recover', sequence: 5 }
    const receipt = JSON.parse(previous.receiptBytes), source = receipt.source, admissionId = id(30)
    const admission = { schemaVersion: 1, kind: 'xpanel-initial-upgrade-admission', operationId: admissionId, reference: ref(30), parentHeadSha256: hash(previous.headBytes), parentHead: { value: JSON.parse(previous.headBytes), sha256: hash(previous.headBytes), bytes: previous.headBytes },
      binding: { recordId: admissionId, origin: { issuerId: id(1) }, intentBinding: { jobId: admissionId, action: 'lifecycle.upgrade' }, backup: null, accountLifetimeSha256: '4'.repeat(64) }, receipt, receiptSha256: hash(previous.receiptBytes), schema: 6,
      entries: [{ path: root + '/installation.json', sha256: hash(previous.receiptBytes) }, { path: root + '/bootstrap.json', sha256: hash(previous.bootstrapBytes) }, { path: root + '/install-dependencies.json', sha256: hash(previous.dependencyBytes) }, { path: '/opt/xpanel/current', target: '/opt/xpanel/releases/' + source.version }, ...receipt.files] }
    const admissionBytes = text(admission), terminal = { schemaVersion: 1, installation: { operationId: admissionId, journalPath: root + '/admission-' + admissionId + '.json', journalSha256: hash(admissionBytes), installedReceiptSha256: hash(previous.receiptBytes), source, noSourceChange: true }, operationId: head.operationId, reference: head.reference, requestFingerprint: head.requestFingerprint, hostOutcome: 'rolled_back', sourceArchiveSha256: source.archiveSha256, databaseBackupSha256: null, interruptedIssuance: null, completedAt: time }
    const input = { bootstrapBytes: previous.bootstrapBytes, receiptBytes: previous.receiptBytes, dependencyBytes: previous.dependencyBytes, headBytes: text(head), admissionBytes, terminalBytes: text(terminal) }
    assert.equal(inspectNoSourceChangeInstallation(input).admission.parentHead.bytes, previous.headBytes)
    assert.equal(inspectCompletedInstallationTransition(previous).bootstrap.version, source.version)
    admission.parentHead.bytes = text({ ...admission.parentHead.value, kind: 'adopt' })
    assert.throws(() => inspectNoSourceChangeInstallation({ ...input, admissionBytes: text(admission) }))
  })
})

// Runs the actual hook function with an isolated registration recorder. No installed path or authority.
describe('authenticated acquisition module resolution closure', () => {
  const source = readFileSync(new URL('./acquire-lifecycle-release.mjs', import.meta.url), 'utf8')
  const begin = source.indexOf('async function withAuthenticatedWorkspaceResolution('), end = source.indexOf('\nexport async function acquireLifecycleRelease', begin)
  const body = source.slice(begin, end)
  function harness() {
    let registered: any, deregistered = 0
    const scope = new AsyncLocalStorage(), check = (ok: unknown, code: string) => { if (!ok) throw new Error(code) }
    const run = new Function('check', 'resolutionScope', 'pathToFileURL', 'isBuiltin', 'registerHooks', body + '\nreturn withAuthenticatedWorkspaceResolution')(
      check, scope, pathToFileURL, isBuiltin, (hooks: unknown) => { registered = hooks; return { deregister() { deregistered++ } } },
    )
    const root = '/authenticated/source', prefix = pathToFileURL(root + '/').href
    const manifest = { files: ['scripts/install-bootstrap.mjs', 'scripts/prepared-release.mjs', 'packages/core/src/index.ts', 'packages/state/src/index.ts', 'packages/db/src/index.ts'].map(path => ({ path })) }
    const resolve = (specifier: string, parent = prefix + 'packages/db/src/index.ts', result?: string) => registered.resolve(specifier, { parentURL: parent }, (s: string, context: { parentURL: string }) => ({ url: result ?? (s.startsWith('node:') ? s : new URL(s, context.parentURL).href) }))
    return { run, root, prefix, manifest, resolve, deregistered: () => deregistered, outside: (fn: () => unknown) => scope.run(undefined, fn) }
  }
  it('binds only literal aliases and rejects escapes, transitive outside source and non-inventory parents', async () => {
    const f = harness()
    await f.run(f.root, f.manifest, async () => {
      assert.equal(f.resolve('@xpanel/core').url, f.prefix + 'packages/core/src/index.ts')
      assert.equal(f.resolve('node:crypto').url, 'node:crypto')
      for (const specifier of ['@xpanel/core/override', 'fs', 'evil', '../../../outside.ts', 'file:///tmp/other.ts']) assert.throws(() => f.resolve(specifier), /IMPORT_OUTSIDE_SOURCE/)
      assert.throws(() => f.resolve('../core/src/index.ts', f.prefix + 'not-in-inventory.ts'), /SCOPE_REQUIRED/)
      assert.throws(() => f.resolve('../core/src/index.ts', undefined, 'file:///tmp/escape.ts'), /IMPORT_OUTSIDE_SOURCE/)
      assert.throws(() => f.outside(() => f.resolve('@xpanel/state')), /SCOPE_REQUIRED/)
    })
    assert.equal(f.deregistered(), 1)
  })
  it('retires hooks after success or throw and rejects retained/sibling scope use', async () => {
    const f = harness()
    await assert.rejects(f.run(f.root, f.manifest, async () => { throw new Error('abort') }), /abort/)
    assert.equal(f.deregistered(), 1)
    assert.throws(() => f.resolve('@xpanel/core'), /SCOPE_REQUIRED/)
  })
})


// Execute the actual recursion control flow with strict isolated DB/audit scope models.
// These models deliberately provide no native ownership or readiness capability.
describe('no-source-change history retires each DB/audit scope before descending', () => {
  const source = readFileSync(new URL('./install-transition-observation.mjs', import.meta.url), 'utf8')
  const begin = source.indexOf('export async function withActiveInstallationObservation(')
  const body = source.slice(begin).replace('export async function', 'async function')
    .replaceAll("await import('../packages/db/src/index.ts')", 'await dbModule()')
    .replaceAll("await import('./install-finalization.mjs')", 'await finalizationModule()')
  it.each(['transition', 'finalization'] as const)('observes 2 completed aborts above %s without nested DB scopes', async kind => {
    const leaf = fixture(), bootstrap = JSON.parse(leaf.bootstrapBytes)
    if (kind === 'finalization') delete bootstrap.installationTransition
    const bootstrapBytes = text(bootstrap), receipt = JSON.parse(leaf.receiptBytes)
    const leafHead = kind === 'transition' ? JSON.parse(leaf.headBytes) : { ...JSON.parse(leaf.headBytes), kind: 'adopt', sequence: 1 }
    const files = new Map<string, string>([[root + '/bootstrap.json', bootstrapBytes], [root + '/installation.json', leaf.receiptBytes], [root + '/install-dependencies.json', leaf.dependencyBytes]])
    const jobs = new Map<string, any>(), origin = { file: '/var/lib/xpanel/control.db', device: '1', inode: '2', issuerId: id(1) }
    if (kind === 'transition') files.set(root + '/terminal/' + leafHead.operationId + '.json', leaf.terminalBytes)
    let priorHeadBytes = text(leafHead)
    for (const sequence of [4, 6]) {
      const operationId = id(sequence + 30), recoveryId = id(sequence + 31)
      const head = { ...leafHead, operationId: recoveryId, reference: ref(sequence + 31), kind: 'recover', sequence }
      const binding = { purpose: 'host.lifecycle.intent', jobId: operationId, action: 'lifecycle.upgrade', principalId: id(2), requestFingerprint: 'f'.repeat(64) }
      const admission = { schemaVersion: 1, kind: 'xpanel-initial-upgrade-admission', operationId, reference: ref(sequence + 30), parentHeadSha256: hash(priorHeadBytes), parentHead: { value: JSON.parse(priorHeadBytes), sha256: hash(priorHeadBytes), bytes: priorHeadBytes },
        binding: { recordId: operationId, origin, intentBinding: binding, backup: null, accountLifetimeSha256: '4'.repeat(64) }, receipt, receiptSha256: hash(leaf.receiptBytes), schema: 6, target: { version: '0.2.0' },
        entries: [{ path: root + '/installation.json', sha256: hash(leaf.receiptBytes) }, { path: root + '/bootstrap.json', sha256: hash(bootstrapBytes) }, { path: root + '/install-dependencies.json', sha256: hash(leaf.dependencyBytes) }, { path: '/opt/xpanel/current', target: '/opt/xpanel/releases/' + receipt.source.version }, ...receipt.files] }
      const admissionBytes = text(admission)
      const terminal = { schemaVersion: 1, installation: { operationId, journalPath: root + '/admission-' + operationId + '.json', journalSha256: hash(admissionBytes), installedReceiptSha256: hash(leaf.receiptBytes), source: receipt.source, noSourceChange: true },
        operationId: recoveryId, reference: head.reference, requestFingerprint: head.requestFingerprint, hostOutcome: 'rolled_back', sourceArchiveSha256: receipt.source.archiveSha256, databaseBackupSha256: null, interruptedIssuance: null, completedAt: time }
      files.set(root + '/admission-' + operationId + '.json', admissionBytes); files.set(root + '/terminal/' + recoveryId + '.json', text(terminal))
      jobs.set(operationId, { status: 'succeeded', kind: 'lifecycle.upgrade', referenceCode: admission.reference, detail: { lifecycleIntent: binding } })
      jobs.set(recoveryId, { status: 'succeeded', kind: 'lifecycle.recover', referenceCode: head.reference, detail: { lifecycleIntent: { ...binding, action: 'lifecycle.recover', jobId: recoveryId } } })
      priorHeadBytes = text(head)
    }
    files.set(root + '/HEAD', priorHeadBytes)
    let databases = 0, maximum = 0, proofs = 0, leafCalls = 0, mutations = 0
    const auditScopes = new AsyncLocalStorage<object>()
    const db = { exec() { mutations++; throw new Error('write forbidden') } }
    const dbApi = {
      async withReadonlyOperationDatabase(_path: string, callback: (db: unknown) => Promise<unknown>) {
        assert.equal(databases, 0, 'historical proof attempted a nested DB scope'); databases++; maximum = Math.max(maximum, databases)
        try { return await callback(db) } finally { databases-- }
      },
      getReadonlyOperationDatabaseOrigin: () => origin,
      assertReadonlyOperationDatabaseCurrent: async () => { assert.equal(databases, 1) },
      getDurableJob: async (_db: unknown, jobId: string) => jobs.get(jobId), getUpgrade: async () => null,
      async withReadonlyLifecycleIntentObservation(_db: unknown, _binding: unknown, callback: (value: { assertCurrent(): Promise<void> }) => Promise<unknown>) {
        assert.equal(databases, 1); const scope = {}, observation = { async assertCurrent() { assert.equal(auditScopes.getStore(), scope); assert.equal(databases, 1) } }
        return auditScopes.run(scope, () => callback(observation))
      },
    }
    const check = (ok: unknown, code: string) => { if (!ok) throw new Error(code) }
    const withTrustedFile = async (path: string, options: { sha256?: string }, callback: (pin: unknown) => Promise<unknown>) => {
      const bytes = files.get(path); assert.notEqual(bytes, undefined, path)
      if (options.sha256) assert.equal(hash(bytes!), options.sha256)
      let live = true
      try { return await callback({ bytes: Buffer.from(bytes!), sha256: hash(bytes!), async verify() { assert(live); assert.equal(files.get(path), bytes) } }) }
      finally { live = false }
    }
    const leafProof = async (_bootstrap: string, callback: (value: unknown) => Promise<unknown>, headBytes: string) => {
      assert.equal(databases, 0); assert.equal(auditScopes.getStore(), undefined); assert.equal(headBytes, text(leafHead)); leafCalls++
      return callback({ bootstrap, async assertCurrent() { assert.equal(databases, 0) } })
    }
    const run = new Function('requireLinuxRoot', 'check', 'ROOT', 'hash', 'withTrustedFile', 'absent', 'json', 'UUID', 'SHA', 'REF', 'same',
      'inspectNoSourceChangeInstallation', 'assertOwnedFile', 'proveTerminalAcknowledgement', 'withCompletedInstallationObservation', 'dbModule', 'finalizationModule', body + '\nreturn withActiveInstallationObservation')(
      () => {}, check, root, hash, withTrustedFile, async () => {}, JSON.parse, /^[a-f0-9-]{36}$/, /^[a-f0-9]{64}$/, /^XP-JOB-2026-[0-9]{6}$/, (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
      inspectNoSourceChangeInstallation, async () => {}, async () => { throw new Error('unexpected upgrade record') }, leafProof, async () => dbApi,
      async () => ({ inspectInstallFinalizationRecovery(input: { headBytes: string }) { assert.equal(input.headBytes, text(leafHead)); assert.equal(databases, 0); leafCalls++; return { bootstrap } } }),
    )
    await run(bootstrapBytes, async (observation: { assertCurrent(): Promise<void> }) => { assert.equal(databases, 0); await observation.assertCurrent(); proofs++ })
    assert.equal(leafCalls, 1); assert.equal(proofs, 1); assert.equal(maximum, 1); assert.equal(databases, 0); assert.equal(mutations, 0)
    const latest = jobs.get(JSON.parse(priorHeadBytes).operationId), originalBinding = { ...latest.detail.lifecycleIntent }
    for (const [key, value] of [['jobId', id(999)], ['action', 'lifecycle.upgrade'], ['purpose', 'reference.repair.intent']]) {
      latest.detail.lifecycleIntent = { ...originalBinding, [key!]: value }
      await assert.rejects(run(bootstrapBytes, async () => { throw new Error('foreign binding reached source proof') }), /INSTALL_TRANSITION_JOB_INCOMPLETE/)
      assert.equal(databases, 0)
    }
    latest.detail.lifecycleIntent = originalBinding
    assert.equal(leafCalls, 1); assert.equal(mutations, 0)
  })
})
