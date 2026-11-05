import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import nodeTest from 'node:test'
import { assessDelivery } from '../../packages/catalog/src/delivery.ts'
import { deliveryEvidence, deliveryTarget } from '../../packages/catalog/src/data/delivery.ts'
import { isMain } from './cli.mjs'
import { STAGE_ENVIRONMENTS } from './contracts.mjs'
import { REQUIRED_PROFILES, SOURCE_ALGORITHM, computeSourceDigest, sha256 } from './shared.mjs'
import { SLOT_ORDER, TIER_ORDER, buildEvidenceStatus, checkEvidenceStatus, formatStatusMarkdown, resolveReviewedRequirements } from './status.mjs'

const ACCEPTANCE = 'The observed capability matches the reviewed acceptance criterion.'
const requirements = ['alpha', 'beta'].map(toolId => ({
  toolId,
  acceptance: toolId === 'alpha' ? ACCEPTANCE : 'A different reviewed acceptance criterion.',
  checks: Object.fromEntries(['unit', 'http', 'browser', 'linux', 'external'].map(environment => [environment, [`${toolId}-${environment}-check`]])),
}))

const osByProfile = {
  'ubuntu-22.04': { id: 'ubuntu', versionId: '22.04', name: 'Ubuntu' },
  'ubuntu-24.04': { id: 'ubuntu', versionId: '24.04', name: 'Ubuntu' },
  'almalinux-9': { id: 'almalinux', versionId: '9.6', name: 'AlmaLinux' },
  'rocky-9': { id: 'rocky', versionId: '9.6', name: 'Rocky Linux' },
  'centos-stream-9': { id: 'centos', versionId: '9', name: 'CentOS Stream' },
}

function fixture({ profiles = [...REQUIRED_PROFILES], artifactSha256 = sha256('artifact'), toolIds = ['alpha'] } = {}) {
  const sourceFiles = [{ path: 'pnpm-lock.yaml', bytes: 4, sha256: sha256('lock') }]
  const source = { algorithm: SOURCE_ALGORITHM, commit: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false, node: '26.12.1', files: sourceFiles, sourceFingerprint: computeSourceDigest(sourceFiles), lockfileSha256: sourceFiles[0].sha256 }
  const target = { sourceFingerprint: source.sourceFingerprint, artifactSha256, supportedProfiles: [...profiles] }
  const provenanceDocument = { schemaVersion: 1, kind: 'xpanel-artifact-provenance', source: { algorithm: source.algorithm, commit: source.commit, sourceFingerprint: source.sourceFingerprint }, artifact: { sha256: target.artifactSha256, bytes: 8 } }
  const provenance = { sha256: sha256(JSON.stringify(provenanceDocument)), document: provenanceDocument }
  const document = { schemaVersion: 1, kind: 'xpanel-verification-target', target, source, provenance }
  const bundle = { schemaVersion: 1, kind: 'xpanel-capability-evidence', target, source, provenance, requirements: structuredClone(requirements), evidence: [], receipts: [] }
  const raw = new Map()
  for (const toolId of toolIds) for (const profile of profiles) for (const slot of SLOT_ORDER) {
    const [stage, environment] = slot.split(':')
    const requirement = requirements.find(item => item.toolId === toolId)
    const id = `${toolId}-${profile.replaceAll('.', '_')}-${stage}-${environment}`
    const report = { schemaVersion: 1, status: 'passed', proofExecuted: true, checks: [{ id: requirement.checks[environment][0], status: 'passed', observed: { withinTolerance: true } }] }
    const reportPath = `${id}.report.json`, reportBytes = Buffer.from(JSON.stringify(report) + '\n')
    const receipt = {
      schemaVersion: 1, kind: 'xpanel-capability-acceptance', runId: 'qualification-batch', receiptId: id,
      toolId, acceptance: requirement.acceptance, coverage: 'full-acceptance',
      stage, environment, profile, sourceAlgorithm: SOURCE_ALGORITHM, sourceFingerprint: source.sourceFingerprint,
      artifactSha256: target.artifactSha256, sourceBefore: source.sourceFingerprint, sourceAfter: source.sourceFingerprint, commit: source.commit,
      result: 'passed', executor: 'real', startedAt: '2026-10-29T00:00:00Z', finishedAt: '2026-10-29T00:00:01Z',
      runtime: { node: 'v26.12.1', platform: 'linux', profile }, host: { osRelease: osByProfile[profile] }, cleanup: { ok: true, errors: [] },
      observer: { independent: true, identity: 'separate-OS-observer' },
      report: { kind: 'checks-v1', path: reportPath, sha256: sha256(reportBytes) },
    }
    const path = `${id}.receipt.json`, receiptBytes = Buffer.from(JSON.stringify(receipt) + '\n')
    bundle.receipts.push({ path, sha256: sha256(receiptBytes), bytes: receiptBytes.length, receipt, report: { path: reportPath, sha256: sha256(reportBytes), bytes: reportBytes.length, kind: 'checks-v1', counts: { total: 1, passed: 1, failed: 0, skipped: 0 } } })
    bundle.evidence.push({ toolId, stage, acceptance: requirement.acceptance, result: 'passed', sourceFingerprint: source.sourceFingerprint, artifactSha256: target.artifactSha256, environment, profile, executor: 'real', runArtifact: path, runArtifactSha256: sha256(receiptBytes), observedAt: receipt.finishedAt })
    raw.set(path, receiptBytes); raw.set(reportPath, reportBytes)
  }
  return { document, bundle, raw }
}

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'xpanel-status-test-'))
  return { directory, dispose: () => { if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected temporary directory'); rmSync(directory, { recursive: true, force: true }) } }
}

function writeBundle(directory, bundle, raw = new Map()) {
  const path = join(directory, 'bundle.json')
  writeFileSync(path, JSON.stringify(bundle))
  for (const [relative, bytes] of raw) writeFileSync(join(directory, relative), bytes)
  return path
}

const tool = { id: 'alpha', surface: 'xpanel', groupId: 'files', name: 'Alpha', summary: '', featureKey: 'alpha', resellerAcl: null, rootOnly: false, entity: 'file', status: 'researched' }
const spec = { id: 'alpha', behaviors: ['Observe the operation.'], acceptance: ACCEPTANCE, source: 'xpanel:native', upstreamFeatureKey: '', upstreamAcl: '', upstreamApi: '', absorbed: [] }

async function statusOf(options) {
  return buildEvidenceStatus({ requirements, ...options })
}

export function registerStatusTests(test) {

test('the shipped catalog delivery data stays empty and unbound', () => {
  assert.deepEqual(deliveryEvidence, [])
  assert.equal(deliveryTarget, null)
})

test('a complete detached bundle produces one verified tool row for every profile', async () => {
  const { directory, dispose } = workspace()
  try {
    const { document, bundle, raw } = fixture()
    const bundlePath = writeBundle(directory, bundle, raw)
    const status = await statusOf({ targetDocument: document, bundlePaths: [bundlePath], evidenceRoot: directory })
    assert.equal(status.requirements.length, 2)
    const alpha = status.requirements[0]
    assert.equal(alpha.status, 'verified', 'a complete, passed, exact-target bundle is verified')
    assert.equal(alpha.evidenceRows, 30)
    for (const profile of alpha.profiles) {
      assert.equal(profile.status, 'verified')
      for (const tier of TIER_ORDER) assert.equal(profile.tiers[tier], 'complete')
      for (const slot of SLOT_ORDER) assert.equal(profile.slots[slot], 'passed')
    }
    assert.equal(status.requirements[1].status, 'researched', 'a reviewed tool with no evidence stays researched')
    assert.deepEqual(status.summary, { requirements: 2, bundles: 1, verified: 1, blocked: 0, researched: 1 })
    assert.deepEqual(checkEvidenceStatus(status), { status: 'not-verified', verified: 1, notVerified: ['beta'], bundles: 1 })
    const markdown = formatStatusMarkdown(status)
    assert.match(markdown, /\| alpha \| verified \| 5\/5 \| 30 \|/)
    assert.match(markdown, /\| beta \| researched \| 0\/5 \| 0 \|/)
    assert.equal(assessDelivery(tool, spec, bundle.evidence, document.target).status, 'verified')
  } finally { dispose() }
})

test('missing profile evidence is reported blocked instead of being shared across profiles', async () => {
  const { directory, dispose } = workspace()
  try {
    const deployed = fixture()
    const { bundle } = fixture({ profiles: ['ubuntu-24.04'] })
    const bundlePath = writeBundle(directory, bundle)
    const status = await statusOf({ targetDocument: deployed.document, bundlePaths: [bundlePath] })
    const alpha = status.requirements[0]
    assert.equal(alpha.status, 'blocked')
    assert.deepEqual(alpha.profiles.map(profile => [profile.profile, profile.status]), [
      ['ubuntu-22.04', 'researched'], ['ubuntu-24.04', 'verified'], ['almalinux-9', 'researched'], ['rocky-9', 'researched'], ['centos-stream-9', 'researched'],
    ])
    assert.match(formatStatusMarkdown(status), /\| alpha \| blocked \| 1\/5 \| 6 \|/)
  } finally { dispose() }
})

test('a missing environment is a partial tier and cannot be verified', async () => {
  const { directory, dispose } = workspace()
  try {
    const { document, bundle, raw } = fixture()
    const receipt = bundle.receipts.find(entry => entry.receipt.toolId === 'alpha' && entry.receipt.stage === 'verified'
      && entry.receipt.environment === 'linux' && entry.receipt.profile === 'rocky-9')
    assert.ok(receipt !== undefined)
    bundle.receipts.splice(bundle.receipts.indexOf(receipt), 1)
    const row = bundle.evidence.find(entry => entry.runArtifact === receipt.path)
    bundle.evidence.splice(bundle.evidence.indexOf(row), 1)
    raw.delete(receipt.path); raw.delete(receipt.report.path)
    const status = await statusOf({ targetDocument: document, bundlePaths: [writeBundle(directory, bundle, raw)], evidenceRoot: directory })
    const alpha = status.requirements[0]
    assert.equal(alpha.status, 'blocked')
    const rocky = alpha.profiles.find(profile => profile.profile === 'rocky-9')
    assert.equal(rocky.status, 'integrated')
    assert.equal(rocky.tiers.verified, 'partial 2/3')
    assert.equal(rocky.slots['verified:linux'], 'missing')
    assert.equal(rocky.slots['verified:browser'], 'passed')
  } finally { dispose() }
})

test('forged receipt, report and evidence hashes are rejected before a report is produced', async () => {
  const { directory, dispose } = workspace()
  try {
    const mutations = [
      bundle => { bundle.receipts[0].report.sha256 = sha256('forged-report') },
      bundle => { bundle.evidence[0].runArtifactSha256 = sha256('forged-receipt') },
      bundle => { bundle.receipts[0].receipt.report.sha256 = sha256('forged-binding') },
    ]
    for (const mutate of mutations) {
      const { document, bundle, raw } = fixture()
      mutate(bundle)
      const path = join(directory, 'forged.json')
      writeFileSync(path, JSON.stringify(bundle))
      for (const [relative, bytes] of raw) writeFileSync(join(directory, relative), bytes)
      await assert.rejects(() => statusOf({ targetDocument: document, bundlePaths: [path], evidenceRoot: directory }))
    }
  } finally { dispose() }
})

test('a stale bundle for a different artifact is rejected, never reported as researched', async () => {
  const { directory, dispose } = workspace()
  try {
    const current = fixture()
    const stale = fixture({ artifactSha256: sha256('another-artifact') })
    const path = writeBundle(directory, stale.bundle)
    await assert.rejects(() => statusOf({ targetDocument: current.document, bundlePaths: [path] }), /stale/)
  } finally { dispose() }
})

test('mixed bundles for different sources or artifacts cannot be combined', async () => {
  const { directory, dispose } = workspace()
  try {
    const first = fixture()
    const second = fixture({ artifactSha256: sha256('another-artifact') })
    const firstPath = join(directory, 'first.json'), secondPath = join(directory, 'second.json')
    writeFileSync(firstPath, JSON.stringify(first.bundle)); writeFileSync(secondPath, JSON.stringify(second.bundle))
    await assert.rejects(() => statusOf({ targetDocument: first.document, bundlePaths: [firstPath, secondPath] }), /mixed/)
  } finally { dispose() }
})

test('duplicate acceptance evidence across bundles is rejected', async () => {
  const { directory, dispose } = workspace()
  try {
    const { document, bundle } = fixture()
    const firstPath = join(directory, 'first.json'), secondPath = join(directory, 'second.json')
    writeFileSync(firstPath, JSON.stringify(bundle)); writeFileSync(secondPath, JSON.stringify(bundle))
    await assert.rejects(() => statusOf({ targetDocument: document, bundlePaths: [firstPath, secondPath] }), /Duplicate/)
  } finally { dispose() }
})

test('reviewed requirement inventory names are explicit and unknown names fail closed', async () => {
  const inventory = await resolveReviewedRequirements('server-information')
  assert.equal(inventory.length, 1)
  assert.equal(inventory[0].toolId, 'server-information')
  assert.deepEqual(Object.keys(inventory[0].checks).sort(), ['browser', 'external', 'http', 'linux', 'unit'])
  await assert.rejects(() => resolveReviewedRequirements('unreviewed-inventory'), /Unknown reviewed requirement inventory/)
})

test('targetless status reports researched and the CI gate never passes without a target', async () => {
  const status = await statusOf()
  assert.equal(status.target, null)
  assert.deepEqual(status.summary, { requirements: 2, bundles: 0, verified: 0, blocked: 0, researched: 2 })
  assert.equal(status.requirements[0].profiles.length, REQUIRED_PROFILES.length)
  assert.deepEqual(checkEvidenceStatus(status), { status: 'not-verified', verified: 0, notVerified: ['alpha', 'beta'], bundles: 0 })
})

test('a targetless run cannot smuggle in a bundle without a deployment target', async () => {
  const { directory, dispose } = workspace()
  try {
    const { bundle } = fixture()
    const path = writeBundle(directory, bundle)
    await assert.rejects(() => statusOf({ bundlePaths: [path] }), /deployed verification target/)
  } finally { dispose() }
})
}

if (isMain(import.meta.url)) registerStatusTests(nodeTest)
