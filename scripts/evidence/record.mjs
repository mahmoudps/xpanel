import { relative, resolve, sep } from 'node:path'
import { assertSameSource, hashArtifact, identifySource, readBoundedFile, sha256 } from './identity.mjs'
import { assertCompleteEvidence, requireValue, receiptKey, safeEvidenceRelativePath, validateReceipt, validateRequirements, validateTargetDocument } from './contracts.mjs'
import { validateSemanticReport } from './reports.mjs'
import { isMain, parseArguments, readJson, runCli, writeDetachedJson } from './cli.mjs'

function relativeEvidencePath(base, path) {
  const value = relative(resolve(base), resolve(path)).split(sep).join('/')
  requireValue(value !== '' && !value.startsWith('../') && value !== '..' && !value.startsWith('/'), 'Receipt/report must stay inside the evidence directory')
  return value
}

/** Only explicit complete-capability envelopes are promoted; primitive reports are not envelopes. */
export function recordEvidenceBundle({ targetDocument, requirements, receiptPaths, evidenceRoot, root, artifact }) {
  validateTargetDocument(targetDocument)
  validateRequirements(requirements)
  requireValue(Array.isArray(receiptPaths) && receiptPaths.length > 0, 'Acceptance receipts are required')
  const before = identifySource(root)
  requireValue(before.sourceFingerprint === targetDocument.target.sourceFingerprint && before.commit === targetDocument.source.commit, 'Current source does not match the immutable target')
  const artifactBefore = hashArtifact(artifact)
  requireValue(artifactBefore.sha256 === targetDocument.target.artifactSha256 && artifactBefore.bytes === targetDocument.artifact.bytes, 'Release artifact does not match the immutable target')
  const receipts = [], evidence = [], ids = new Set(), keys = new Set(), filePaths = new Set()
  for (const suppliedPath of receiptPaths) {
    const path = resolve(evidenceRoot, suppliedPath)
    const receiptPath = relativeEvidencePath(evidenceRoot, path)
    const raw = readBoundedFile(path, { root: evidenceRoot })
    const receipt = JSON.parse(raw.toString('utf8'))
    const requirement = validateReceipt(receipt, targetDocument, requirements)
    const key = receiptKey(receipt)
    requireValue(!ids.has(receipt.receiptId) && !keys.has(key) && !filePaths.has(receiptPath), 'Duplicate receipt or capability evidence')
    ids.add(receipt.receiptId); keys.add(key); filePaths.add(receiptPath)
    requireValue(safeEvidenceRelativePath(receiptPath) && safeEvidenceRelativePath(receipt.report.path), 'Report path must be a safe relative evidence path')
    const reportPath = resolve(evidenceRoot, receipt.report.path)
    const reportRelative = relativeEvidencePath(evidenceRoot, reportPath)
    requireValue(!filePaths.has(reportRelative), 'Each receipt must bind its own report')
    filePaths.add(reportRelative)
    const reportBytes = readBoundedFile(reportPath, { root: evidenceRoot })
    requireValue(sha256(reportBytes) === receipt.report.sha256, 'Acceptance report hash mismatch')
    const counts = validateSemanticReport(JSON.parse(reportBytes.toString('utf8')), receipt.report.kind, requirement.checks[receipt.environment])
    receipts.push({ path: receiptPath, sha256: sha256(raw), bytes: raw.length, receipt, report: { path: reportRelative, sha256: receipt.report.sha256, bytes: reportBytes.length, kind: receipt.report.kind, counts } })
    evidence.push({ toolId: receipt.toolId, stage: receipt.stage, acceptance: receipt.acceptance, result: receipt.result, sourceFingerprint: receipt.sourceFingerprint, artifactSha256: receipt.artifactSha256, environment: receipt.environment, profile: receipt.profile, executor: receipt.executor, runArtifact: receiptPath, runArtifactSha256: sha256(raw), observedAt: receipt.finishedAt })
  }
  assertCompleteEvidence(evidence, targetDocument.target, requirements)
  assertSameSource(before, identifySource(root))
  requireValue(hashArtifact(artifact).sha256 === artifactBefore.sha256, 'Release artifact changed during evidence recording')
  return { schemaVersion: 1, kind: 'xpanel-capability-evidence', createdAt: new Date().toISOString(), target: targetDocument.target, source: targetDocument.source, provenance: targetDocument.provenance, requirements, evidence, receipts }
}

if (isMain(import.meta.url)) await runCli(() => {
  const args = parseArguments(process.argv.slice(2), ['root', 'artifact', 'target', 'requirements', 'receipt-list', 'evidence-root', 'output'], ['root', 'artifact', 'target', 'requirements', 'receipt-list', 'evidence-root', 'output'])
  const bundle = recordEvidenceBundle({ root: args.root, artifact: args.artifact, targetDocument: readJson(args.target), requirements: readJson(args.requirements), receiptPaths: readJson(args['receipt-list']), evidenceRoot: args['evidence-root'] })
  const output = writeDetachedJson(args.root, args.output, bundle, args.artifact)
  process.stdout.write(JSON.stringify({ status: 'recorded', output, evidence: bundle.evidence.length }) + '\n')
})
