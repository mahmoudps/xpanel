import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { assertCompleteEvidence, isHash, requireValue, receiptKey, safeEvidenceRelativePath, validateReceipt, validateRequirements, validateTarget, validateTargetDocument } from './contracts.mjs'
import { readBoundedFile } from './files.mjs'
import { sha256 } from './shared.mjs'
import { validateSemanticReport } from './reports.mjs'

const targetKey = target => JSON.stringify({ sourceFingerprint: target.sourceFingerprint, artifactSha256: target.artifactSha256, supportedProfiles: [...target.supportedProfiles].sort() })

/**
 * Pure bundle validation for one EvidenceBundle v1 document.
 *
 * `requireComplete` exists only for reporting consumers (for example the
 * generated status surface): every supplied receipt and evidence row is still
 * validated in full, but a report may describe a bundle that has not yet
 * reached complete acceptance. The admission path (`verifyEvidenceBundle`, the
 * trusted Linux loader and the API acceptance configuration) always requires
 * complete evidence.
 */
export function validateEvidenceBundle(bundle, { expectedTarget, expectedRequirements, evidenceRoot, requireComplete = true, requireAllProfiles = requireComplete } = {}) {
  requireValue(bundle?.schemaVersion === 1 && bundle.kind === 'xpanel-capability-evidence', 'Unsupported detached evidence bundle')
  validateTargetDocument({ schemaVersion: 1, kind: 'xpanel-verification-target', target: bundle.target, source: bundle.source, provenance: bundle.provenance }, { requireAllProfiles })
  validateRequirements(bundle.requirements)
  if (expectedTarget !== undefined) {
    validateTarget(expectedTarget)
    requireValue(targetKey(bundle.target) === targetKey(expectedTarget), 'Evidence target does not match the deployed source/artifact/profiles')
  }
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
  if (requireComplete) assertCompleteEvidence(bundle.evidence, bundle.target, bundle.requirements)
  return { target: bundle.target, evidence: bundle.evidence, source: bundle.source, requirements: bundle.requirements, receipts: bundle.receipts }
}

/** Admission validation: complete acceptance evidence only. */
export function verifyEvidenceBundle(bundle, options = {}) {
  requireValue(options.expectedTarget !== undefined, 'A deployed verification target is required')
  return validateEvidenceBundle(bundle, { ...options, requireComplete: true, requireAllProfiles: true })
}

export function assertTrustedMetadata(entries) {
  requireValue(entries.length > 0 && entries.every(entry => entry.uid === 0 && Number.isSafeInteger(entry.mode) && (entry.mode & 0o022) === 0 && entry.symlink === false), 'Evidence bundle and its ancestors must be root-owned and not writable by group/other')
}

/** Root-owned and not group/other-writable from the file up to /, no symbolic link, bounded, unchanged while read. */
function readTrustedFile(path, label, maxBytes) {
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
    requireValue(before.isFile() && before.size > 0 && before.size <= maxBytes, `${label} size/type is invalid`)
    assertTrustedMetadata([{ uid: before.uid, mode: before.mode, symlink: false }])
    const bytes = readFileSync(fd), after = fstatSync(fd)
    requireValue(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key]) && bytes.length === before.size, `${label} changed while it was read`)
    return bytes
  } finally { closeSync(fd) }
}

/** Production reader: the digest pin must come from separate trusted operator configuration. */
export function loadTrustedEvidenceBundle({ path, expectedSha256, expectedTarget, expectedRequirements }) {
  requireValue(process.platform === 'linux', 'Trusted capability bundles require a Linux ownership check')
  requireValue(isHash(expectedSha256), 'An external trusted SHA-256 pin is required')
  validateRequirements(expectedRequirements)
  const bytes = readTrustedFile(path, 'Trusted evidence bundle', 8 * 1024 * 1024)
  requireValue(sha256(bytes) === expectedSha256, 'Trusted evidence bundle changed or its digest pin did not match')
  return verifyEvidenceBundle(JSON.parse(bytes.toString('utf8')), { expectedTarget, expectedRequirements })
}

/** Operator acceptance configuration, a protected startup file like runtime.env. */
export const CAPABILITY_ACCEPTANCE_CONFIG = '/etc/xpanel/capability-acceptance.json'

/** Exact shape of the acceptance configuration: the bundle location, its reviewed pin, the deployed target and the reviewed requirements. */
export function parseAcceptanceConfig(value) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value) && value.schemaVersion === 1
    && Object.keys(value).sort().join(',') === 'bundlePath,bundleSha256,requirements,schemaVersion,target', 'Unsupported capability acceptance configuration')
  requireValue(typeof value.bundlePath === 'string' && value.bundlePath.startsWith('/') && posix.normalize(value.bundlePath) === value.bundlePath, 'The capability bundle path must be absolute and canonical')
  requireValue(isHash(value.bundleSha256), 'The capability bundle needs a reviewed SHA-256 pin')
  validateTarget(value.target)
  validateRequirements(value.requirements)
  return { path: value.bundlePath, expectedSha256: value.bundleSha256, expectedTarget: value.target, expectedRequirements: value.requirements }
}

/** Startup reader. An absent file means no tool is accepted; a present file must be trusted and valid, or startup fails. */
export function loadTrustedAcceptanceConfig(path = CAPABILITY_ACCEPTANCE_CONFIG) {
  try { lstatSync(path) } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error }
  requireValue(process.platform === 'linux', 'Capability acceptance configuration requires a Linux ownership check')
  return parseAcceptanceConfig(JSON.parse(readTrustedFile(path, 'Capability acceptance configuration', 1024 * 1024).toString('utf8')))
}
