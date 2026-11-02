import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import nodeTest from 'node:test'
import { computeSourceDigest } from '../vm/source-snapshot.mjs'
import { assertDetachedOutput, assertSameSource, REQUIRED_PROFILES, sha256, SOURCE_ALGORITHM } from './identity.mjs'
import { assertCompleteEvidence, profileFromOsRelease, STAGE_ENVIRONMENTS, validateArtifactProvenance, validateReceipt, validateTargetDocument } from './contracts.mjs'
import { validateSemanticReport } from './reports.mjs'
import { assertTrustedMetadata, loadTrustedEvidenceBundle, verifyEvidenceBundle } from './verify.mjs'
import { isMain, parseArguments, writeDetachedJson } from './cli.mjs'

const requirements = [{ toolId: 'server-information', acceptance: 'Observed server metrics match independent operating system observations.', checks: Object.fromEntries(['unit', 'http', 'browser', 'linux', 'external'].map(environment => [environment, [`${environment}:metrics`]])) }]
const osByProfile = {
  'ubuntu-22.04': { id: 'ubuntu', versionId: '22.04', name: 'Ubuntu' },
  'ubuntu-24.04': { id: 'ubuntu', versionId: '24.04', name: 'Ubuntu' },
  'almalinux-9': { id: 'almalinux', versionId: '9.6', name: 'AlmaLinux' },
  'rocky-9': { id: 'rocky', versionId: '9.6', name: 'Rocky Linux' },
  'centos-stream-9': { id: 'centos', versionId: '9', name: 'CentOS Stream' },
}

function fixture() {
  const sourceFiles = [{ path: 'pnpm-lock.yaml', bytes: 4, sha256: sha256('lock') }]
  const source = { algorithm: SOURCE_ALGORITHM, commit: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false, node: '26.12.1', files: sourceFiles, sourceFingerprint: computeSourceDigest(sourceFiles), lockfileSha256: sourceFiles[0].sha256 }
  const target = { sourceFingerprint: source.sourceFingerprint, artifactSha256: sha256('artifact'), supportedProfiles: [...REQUIRED_PROFILES] }
  const provenanceDocument = { schemaVersion: 1, kind: 'xpanel-artifact-provenance', source: { algorithm: source.algorithm, commit: source.commit, sourceFingerprint: source.sourceFingerprint }, artifact: { sha256: target.artifactSha256, bytes: 8 } }
  const provenance = { sha256: sha256(JSON.stringify(provenanceDocument)), document: provenanceDocument }
  const document = { schemaVersion: 1, kind: 'xpanel-verification-target', target, source, provenance }
  const bundle = { schemaVersion: 1, kind: 'xpanel-capability-evidence', target, source, provenance, requirements: structuredClone(requirements), evidence: [], receipts: [] }
  const raw = new Map()
  for (const profile of target.supportedProfiles) for (const [stage, environments] of Object.entries(STAGE_ENVIRONMENTS)) for (const environment of environments) {
    const id = `${profile.replaceAll('.', '_')}-${stage}-${environment}`
    const report = { schemaVersion: 1, status: 'passed', proofExecuted: true, checks: [{ id: `${environment}:metrics`, status: 'passed', observed: { withinTolerance: true } }] }
    const reportPath = `${id}.report.json`, reportBytes = Buffer.from(JSON.stringify(report) + '\n')
    const receipt = {
      schemaVersion: 1, kind: 'xpanel-capability-acceptance', runId: 'qualification-batch', receiptId: id,
      toolId: requirements[0].toolId, acceptance: requirements[0].acceptance, coverage: 'full-acceptance',
      stage, environment, profile, sourceAlgorithm: SOURCE_ALGORITHM, sourceFingerprint: source.sourceFingerprint,
      artifactSha256: target.artifactSha256, sourceBefore: source.sourceFingerprint, sourceAfter: source.sourceFingerprint, commit: source.commit,
      result: 'passed', executor: 'real', startedAt: '2026-10-29T00:00:00Z', finishedAt: '2026-10-29T00:00:01Z',
      runtime: { node: 'v26.12.1', platform: 'linux', profile }, host: { osRelease: osByProfile[profile] }, cleanup: { ok: true, errors: [] },
      observer: { independent: true, identity: 'separate-OS-observer' },
      report: { kind: 'checks-v1', path: reportPath, sha256: sha256(reportBytes) },
    }
    const path = `${id}.receipt.json`, receiptBytes = Buffer.from(JSON.stringify(receipt) + '\n')
    bundle.receipts.push({ path, sha256: sha256(receiptBytes), bytes: receiptBytes.length, receipt, report: { path: reportPath, sha256: sha256(reportBytes), bytes: reportBytes.length, kind: 'checks-v1', counts: { total: 1, passed: 1, failed: 0, skipped: 0 } } })
    bundle.evidence.push({ toolId: receipt.toolId, stage, acceptance: receipt.acceptance, result: receipt.result, sourceFingerprint: source.sourceFingerprint, artifactSha256: target.artifactSha256, environment, profile, executor: receipt.executor, runArtifact: path, runArtifactSha256: sha256(receiptBytes), observedAt: receipt.finishedAt })
    raw.set(path, receiptBytes); raw.set(reportPath, reportBytes)
  }
  return { document, bundle, raw }
}
const verify = bundle => verifyEvidenceBundle(bundle, { expectedTarget: fixture().document.target, expectedRequirements: requirements })

export function registerEvidenceTests(test) {

test('complete detached bundle covers all environments independently for all five profiles', () => {
  const { bundle, document } = fixture()
  validateTargetDocument(document)
  assert.equal(verify(bundle).evidence.length, 30)
  assert.equal(bundle.receipts[0].receipt.runId, bundle.receipts[1].receipt.runId, 'one batch may produce many unique receipts')
})

test('missing profile evidence cannot be filled by a different profile', () => {
  const { bundle } = fixture()
  bundle.evidence.pop(); bundle.receipts.pop()
  assert.throws(() => verify(bundle), /Missing acceptance evidence/)
  assert.throws(() => assertCompleteEvidence(bundle.evidence, bundle.target, requirements), /Missing acceptance evidence/)
})

test('target requires all five declared profiles', () => {
  const { document } = fixture()
  document.target.supportedProfiles.pop()
  assert.throws(() => validateTargetDocument(document), /All five/)
})

test('source and artifact identity, clean status and manifest are mandatory', () => {
  for (const mutate of [
    value => { value.source.algorithm = 'browser-git-tree' },
    value => { value.source.dirty = true },
    value => { value.source.files[0].sha256 = sha256('changed') },
    value => { value.target.artifactSha256 = null },
  ]) {
    const { document } = fixture(); mutate(document)
    assert.throws(() => validateTargetDocument(document))
  }
})

test('mixed source, artifact, host profile, fake native executor and failed cleanup are rejected', () => {
  for (const mutate of [
    value => { value.sourceAlgorithm = 'snapshot-archive' },
    value => { value.sourceAfter = sha256('changed') },
    value => { value.artifactSha256 = sha256('different-artifact') },
    value => { value.host.osRelease = osByProfile['rocky-9'] },
    value => { value.executor = 'fake' },
    value => { value.cleanup.ok = false },
    value => { value.cleanup.errors.push('leftover') },
    value => { value.cleanup.leftovers = { units: ['remaining.service'] } },
    value => { value.runtime.platform = 'win32' },
    value => { value.coverage = 'primitives-only' },
  ]) {
    const { bundle, document } = fixture()
    const receipt = bundle.receipts.find(entry => entry.receipt.environment === 'linux').receipt
    mutate(receipt)
    assert.throws(() => validateReceipt(receipt, document, requirements))
  }
})

test('independent observer and exact acceptance criterion cannot be omitted', () => {
  const { bundle, document } = fixture()
  const receipt = bundle.receipts.find(entry => entry.receipt.environment === 'external').receipt
  receipt.observer.independent = false
  assert.throws(() => validateReceipt(receipt, document, requirements), /independent observer/)
  receipt.observer.independent = true; receipt.acceptance = 'Some checks passed'
  assert.throws(() => validateReceipt(receipt, document, requirements), /exact capability/)
})

test('duplicate receipt IDs, slots, paths and substituted catalog rows fail validation', () => {
  for (const mutate of [
    value => { value.receipts[1].receipt.receiptId = value.receipts[0].receipt.receiptId },
    value => { value.receipts[1].path = value.receipts[0].path },
    value => { value.receipts[0].report.path = '../outside.json' },
    value => { value.evidence[0].runArtifactSha256 = sha256('forged') },
    value => { value.receipts[0].report.counts.skipped = 1 },
  ]) {
    const { bundle } = fixture(); mutate(bundle)
    assert.throws(() => verify(bundle))
  }
})

test('unknown, skipped, unobserved, incomplete and exit-only reports cannot pass', () => {
  const report = { schemaVersion: 1, status: 'passed', proofExecuted: true, checks: [{ id: 'expected', status: 'passed', observed: 0 }] }
  assert.equal(validateSemanticReport(report, 'checks-v1', ['expected']).passed, 1)
  for (const mutate of [
    value => { value.proofExecuted = false },
    value => { value.checks[0].status = 'skipped' },
    value => { delete value.checks[0].observed },
    value => { value.checks.push(structuredClone(value.checks[0])) },
    value => { value.checks[0].id = 'unreviewed' },
  ]) {
    const changed = structuredClone(report); mutate(changed)
    assert.throws(() => validateSemanticReport(changed, 'checks-v1', ['expected']))
  }
  assert.throws(() => validateSemanticReport({ exit_code: 0 }, 'checks-v1', ['expected']))
  assert.throws(() => validateSemanticReport(report, 'unreviewed-adapter', ['expected']))
})

test('Vitest adapter checks assertion identities and hidden pending/collection failures', () => {
  const report = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, testResults: [{ status: 'passed', message: '', assertionResults: [{ fullName: 'expected', status: 'passed', failureMessages: [] }] }] }
  assert.equal(validateSemanticReport(report, 'vitest-v1', ['expected']).total, 1)
  for (const mutate of [
    value => { value.numPendingTests = 1 },
    value => { value.testResults[0].status = 'failed' },
    value => { value.testResults[0].assertionResults[0].status = 'pending' },
    value => { value.testResults[0].assertionResults[0].failureMessages.push('failed') },
    value => { value.testResults[0].assertionResults[0].fullName = 'unexpected' },
  ]) {
    const changed = structuredClone(report); mutate(changed)
    assert.throws(() => validateSemanticReport(changed, 'vitest-v1', ['expected']))
  }
})

test('raw receipt and output hashes are verified before accepting a bundle', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xpanel-evidence-test-'))
  const { bundle, raw } = fixture()
  try {
    for (const [path, bytes] of raw) writeFileSync(join(directory, path), bytes)
    assert.equal(verifyEvidenceBundle(bundle, { expectedTarget: bundle.target, expectedRequirements: requirements, evidenceRoot: directory }).evidence.length, 30)
    writeFileSync(join(directory, bundle.receipts[0].report.path), '{"status":"passed"}')
    assert.throws(() => verifyEvidenceBundle(bundle, { expectedTarget: bundle.target, evidenceRoot: directory }), /corrupted/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && directory.split(sep).at(-1).startsWith('xpanel-evidence-test-'))
    rmSync(directory, { recursive: true })
  }
})

test('root ownership policy rejects service-owned, writable or symbolic-link inputs', () => {
  assertTrustedMetadata([{ uid: 0, mode: 0o100644, symlink: false }, { uid: 0, mode: 0o40755, symlink: false }])
  for (const value of [{ uid: 999, mode: 0o100644, symlink: false }, { uid: 0, mode: 0o100664, symlink: false }, { uid: 0, mode: 0o40777, symlink: false }, { uid: 0, mode: 0o100644, symlink: true }]) assert.throws(() => assertTrustedMetadata([value]), /root-owned/)
  assert.throws(() => assertTrustedMetadata([]))
  if (process.platform !== 'linux') assert.throws(() => loadTrustedEvidenceBundle({ path: 'unused' }), /Linux ownership/)
})

test('detached output excludes source inputs, and command writes cannot overwrite evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'xpanel-evidence-test-'))
  try {
    assert.throws(() => assertDetachedOutput(root, join(root, 'scripts', 'evidence', 'output.json')), /detached/)
    assert.throws(() => assertDetachedOutput(root, join(root, 'docs', 'planning', 'acceptance-scenario-mapping.json')), /detached/)
    const output = join(root, '.tools', 'evidence', 'bundle.json')
    writeDetachedJson(root, output, { value: 1 })
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).value, 1)
    assert.throws(() => writeDetachedJson(root, output, { value: 2 }))
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.split(sep).at(-1).startsWith('xpanel-evidence-test-'))
    rmSync(root, { recursive: true })
  }
})

test('OS profile mapping distinguishes CentOS Stream and does not relabel distributions', () => {
  for (const [profile, os] of Object.entries(osByProfile)) assert.equal(profileFromOsRelease(os), profile)
  assert.throws(() => profileFromOsRelease({ id: 'centos', versionId: '9', name: 'CentOS Linux' }))
  assert.throws(() => profileFromOsRelease({ id: 'ubuntu', versionId: '20.04' }))
})

test('source stability and strict CLI arguments reject changed or ambiguous inputs', () => {
  const { document } = fixture()
  assertSameSource(document.source, structuredClone(document.source))
  assert.throws(() => assertSameSource(document.source, { ...document.source, sourceFingerprint: sha256('changed') }))
  assert.deepEqual(parseArguments(['--root=path'], ['root'], ['root']), { root: 'path' })
  assert.throws(() => parseArguments(['--root=one', '--root=two'], ['root'], ['root']))
  assert.throws(() => parseArguments(['--unknown=value'], ['root'], []))
  const digest = 'a'.repeat(64)
  assert.deepEqual(parseArguments(
    [`--target-sha256=${digest}`, `--binding-sha256=${digest}`],
    ['target-sha256', 'binding-sha256'],
    ['target-sha256', 'binding-sha256'],
  ), { 'target-sha256': digest, 'binding-sha256': digest })
  assert.throws(() => parseArguments([`--binding-sha256=${digest}`], ['target-sha256'], []))
  assert.throws(() => parseArguments(['--256=abc'], ['256'], []))
})

test('packaging provenance must bind this source and this archive independently', () => {
  const { document } = fixture()
  validateArtifactProvenance(document.provenance.document, document.source, document.target.artifactSha256, 8)
  assert.throws(() => validateArtifactProvenance(document.provenance.document, { ...document.source, sourceFingerprint: sha256('different-source') }, document.target.artifactSha256, 8), /different source/)
  assert.throws(() => validateArtifactProvenance(document.provenance.document, document.source, sha256('different-artifact'), 8), /release archive/)
  assert.throws(() => validateArtifactProvenance(document.provenance.document, document.source, document.target.artifactSha256, 9), /release archive/)
})

test('historical snapshot digest keeps its sorted path-NUL-hash-newline byte protocol', () => {
  assert.equal(computeSourceDigest([]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  const entries = [{ path: 'packages/z.ts', sha256: 'b'.repeat(64) }, { path: 'apps/a.ts', sha256: 'a'.repeat(64) }]
  assert.equal(computeSourceDigest(entries), '39f75e3afd53a862c1166f47cf688ed1f58dc7b3f77c063c2c471235bead873c')
})
}

if (isMain(import.meta.url)) registerEvidenceTests(nodeTest)
