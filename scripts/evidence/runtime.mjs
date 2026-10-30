import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertCompleteEvidence, isHash, requireValue, receiptKey, safeEvidenceRelativePath, validateReceipt, validateRequirements, validateTarget, validateTargetDocument } from './contracts.mjs'
import { readBoundedFile } from './files.mjs'
import { sha256 } from './shared.mjs'
import { validateSemanticReport } from './reports.mjs'

const targetKey = target => JSON.stringify({ sourceFingerprint: target.sourceFingerprint, artifactSha256: target.artifactSha256, supportedProfiles: [...target.supportedProfiles].sort() })

/** Pure bundle validation. A caller must separately trust the bundle's digest and deployment target. */
export function verifyEvidenceBundle(bundle, { expectedTarget, expectedRequirements, evidenceRoot } = {}) {
  requireValue(bundle?.schemaVersion === 1 && bundle.kind === 'xpanel-capability-evidence', 'Unsupported detached evidence bundle')
  validateTargetDocument({ schemaVersion: 1, kind: 'xpanel-verification-target', target: bundle.target, source: bundle.source, provenance: bundle.provenance })
  validateRequirements(bundle.requirements)
  validateTarget(expectedTarget)
  requireValue(targetKey(bundle.target) === targetKey(expectedTarget), 'Evidence target does not match the deployed source/artifact/profiles')
  if (expectedRequirements !== undefined) requireValue(JSON.stringify(bundle.requirements) === JSON.stringify(validateRequirements(expectedRequirements)), 'Evidence requirements differ from the reviewed acceptance inventory')
  requireValue(Array.isArray(bundle.evidence) && Array.isArray(bundle.receipts) && bundle.receipts.length === bundle.evidence.length && bundle.receipts.length > 0, 'Incomplete receipt/evidence manifest')
  const receiptIds = new Set(), paths = new Set(), keys = new Set()
  for (const entry of bundle.receipts) {
    requireValue(safeEvidenceRelativePath(entry.path) && safeEvidenceRelativePath(entry.report?.path) && entry.path !== entry.report.path && !paths.has(entry.path) && !paths.has(entry.report.path) && isHash(entry.sha256) && isHash(entry.report.sha256) && Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && Number.isSafeInteger(entry.report.bytes) && entry.report.bytes > 0, 'Invalid or duplicate receipt/report file manifest')
    paths.add(entry.path); paths.add(entry.report.path)
    const requirement = validateReceipt(entry.receipt, { target: bundle.target, source: bundle.source }, bundle.requirements)
    const receipt = entry.receipt, key = receiptKey(receipt)
    requireValue(!receiptIds.has(receipt.receiptId) && !keys.has(key), 'Duplicate receipt identity or acceptance slot')
    receiptIds.add(receipt.receiptId); keys.add(key)
    requireValue(entry.report.path === receipt.report.path && entry.report.sha256 === receipt.report.sha256 && entry.report.kind === receipt.report.kind, 'Receipt/report binding mismatch')
    const counts = entry.report.counts, expected = requirement.checks[receipt.environment].length
    requireValue(counts?.total === expected && counts.passed === expected && counts.failed === 0 && counts.skipped === 0, 'Semantic acceptance counts are incomplete')
    const row = bundle.evidence.find(value => receiptKey(value) === key)
    const expectedRow = { toolId: receipt.toolId, stage: receipt.stage, acceptance: receipt.acceptance, result: receipt.result, sourceFingerprint: receipt.sourceFingerprint, artifactSha256: receipt.artifactSha256, environment: receipt.environment, profile: receipt.profile, executor: receipt.executor, runArtifact: entry.path, runArtifactSha256: entry.sha256, observedAt: receipt.finishedAt }
    requireValue(row !== undefined && Object.keys(expectedRow).every(field => row[field] === expectedRow[field]), 'Catalog evidence does not match its receipt')
    if (evidenceRoot !== undefined) {
      const receiptBytes = readBoundedFile(resolve(evidenceRoot, entry.path), { root: evidenceRoot })
      const reportBytes = readBoundedFile(resolve(evidenceRoot, entry.report.path), { root: evidenceRoot })
      requireValue(receiptBytes.length === entry.bytes && sha256(receiptBytes) === entry.sha256 && JSON.stringify(JSON.parse(receiptBytes.toString('utf8'))) === JSON.stringify(receipt), 'Raw acceptance receipt is missing or corrupted')
      requireValue(reportBytes.length === entry.report.bytes && sha256(reportBytes) === entry.report.sha256, 'Raw acceptance report is missing or corrupted')
      validateSemanticReport(JSON.parse(reportBytes.toString('utf8')), entry.report.kind, requirement.checks[receipt.environment])
    }
  }
  assertCompleteEvidence(bundle.evidence, bundle.target, bundle.requirements)
  return { target: bundle.target, evidence: bundle.evidence, source: bundle.source, requirements: bundle.requirements }
}

export function assertTrustedMetadata(entries) {
  requireValue(entries.length > 0 && entries.every(entry => entry.uid === 0 && Number.isSafeInteger(entry.mode) && (entry.mode & 0o022) === 0 && entry.symlink === false), 'Evidence bundle and its ancestors must be root-owned and not writable by group/other')
}

/** Production reader: the digest pin must come from separate trusted operator configuration. */
export function loadTrustedEvidenceBundle({ path, expectedSha256, expectedTarget, expectedRequirements }) {
  requireValue(process.platform === 'linux', 'Trusted capability bundles require a Linux ownership check')
  requireValue(isHash(expectedSha256), 'An external trusted SHA-256 pin is required')
  validateRequirements(expectedRequirements)
  const absolute = resolve(path), metadata = []
  let current = absolute
  while (true) {
    const info = lstatSync(current)
    metadata.push({ uid: info.uid, mode: info.mode, symlink: info.isSymbolicLink() })
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  assertTrustedMetadata(metadata)
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    requireValue(before.isFile() && before.size > 0 && before.size <= 8 * 1024 * 1024, 'Trusted evidence bundle size/type is invalid')
    assertTrustedMetadata([{ uid: before.uid, mode: before.mode, symlink: false }])
    const bytes = readFileSync(fd), after = fstatSync(fd)
    requireValue(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key]) && bytes.length === before.size && sha256(bytes) === expectedSha256, 'Trusted evidence bundle changed or its digest pin did not match')
    return verifyEvidenceBundle(JSON.parse(bytes.toString('utf8')), { expectedTarget, expectedRequirements })
  } finally { closeSync(fd) }
}
