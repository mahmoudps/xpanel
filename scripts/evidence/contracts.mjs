import { computeSourceDigest, REQUIRED_PROFILES, SOURCE_ALGORITHM } from './shared.mjs'

const HASH = /^[a-f0-9]{64}$/
const ENVIRONMENTS = ['unit', 'http', 'browser', 'linux', 'external']
export const STAGE_ENVIRONMENTS = Object.freeze({ implemented: ['unit'], integrated: ['http', 'browser'], verified: ['linux', 'browser', 'external'] })
export const requireValue = (condition, message) => { if (!condition) throw new Error(message) }
export const isHash = value => typeof value === 'string' && HASH.test(value)
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
export const safeEvidenceRelativePath = path => typeof path === 'string' && path.length > 0 && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..') && !/[\\:\x00-\x1f]/.test(path) && !path.startsWith('/')
export function validateArtifactProvenance(provenance, source, artifactSha256, artifactBytes) {
  requireValue(provenance?.schemaVersion === 1 && provenance.kind === 'xpanel-artifact-provenance', 'A reviewed packaging provenance receipt is required')
  requireValue(provenance.source?.algorithm === source.algorithm && provenance.source?.sourceFingerprint === source.sourceFingerprint && provenance.source?.commit === source.commit, 'Artifact provenance belongs to a different source')
  requireValue(provenance.artifact?.sha256 === artifactSha256 && Number.isSafeInteger(provenance.artifact?.bytes) && provenance.artifact.bytes > 0 && (artifactBytes === undefined || provenance.artifact.bytes === artifactBytes), 'Artifact provenance does not match the release archive')
}
export function profileFromOsRelease(os) {
  requireValue(isRecord(os) && typeof os.id === 'string' && typeof os.versionId === 'string', 'Observed host OS identity is required')
  if (os.id === 'ubuntu' && ['22.04', '24.04'].includes(os.versionId)) return `ubuntu-${os.versionId}`
  if (['almalinux', 'rocky'].includes(os.id) && /^9(?:\.|$)/.test(os.versionId)) return `${os.id}-9`
  if (os.id === 'centos' && /^9(?:\.|$)/.test(os.versionId) && os.name === 'CentOS Stream') return 'centos-stream-9'
  throw new Error('Host OS does not match a declared qualification profile')
}
export function stringList(value, message) {
  requireValue(Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.trim() === item && item.length > 0) && new Set(value).size === value.length, message)
  return value
}

export function validateTarget(target) {
  requireValue(isRecord(target) && isHash(target.sourceFingerprint) && isHash(target.artifactSha256), 'A complete source/artifact verification target is required')
  stringList(target.supportedProfiles, 'Target profiles must be nonempty and unique')
  requireValue(target.supportedProfiles.every(profile => REQUIRED_PROFILES.includes(profile)), 'Unknown qualification profile')
  return target
}

export function validateTargetDocument(document, { requireAllProfiles = true } = {}) {
  requireValue(document?.schemaVersion === 1 && document.kind === 'xpanel-verification-target', 'Unsupported verification target document')
  validateTarget(document.target)
  const source = document.source
  requireValue(isRecord(source) && source.algorithm === SOURCE_ALGORITHM && /^[a-f0-9]{40,64}$/.test(source.commit) && /^[a-f0-9]{40,64}$/.test(source.tree) && source.dirty === false && source.sourceFingerprint === document.target.sourceFingerprint && isHash(source.lockfileSha256), 'Unbound or dirty source identity')
  requireValue(typeof source.node === 'string' && /^26\.12\.1$/.test(source.node), 'Qualification requires the pinned Node runtime')
  // Manifest paths are metadata, never runtime read instructions; source construction enforces its allowlist.
  requireValue(Array.isArray(source.files) && source.files.length > 0 && new Set(source.files.map(file => file.path)).size === source.files.length && source.files.every(file => safeEvidenceRelativePath(file.path) && isHash(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0) && computeSourceDigest(source.files) === source.sourceFingerprint, 'Invalid source input manifest')
  requireValue(source.files.find(file => file.path === 'pnpm-lock.yaml')?.sha256 === source.lockfileSha256, 'Dependency lock identity is missing from the source manifest')
  requireValue(isHash(document.provenance?.sha256), 'Packaging provenance digest is required')
  validateArtifactProvenance(document.provenance.document, source, document.target.artifactSha256, document.artifact?.bytes)
  if (requireAllProfiles) requireValue(REQUIRED_PROFILES.every(profile => document.target.supportedProfiles.includes(profile)) && document.target.supportedProfiles.length === REQUIRED_PROFILES.length, 'All five qualification profiles are required')
  return document
}

export function validateRequirements(requirements) {
  requireValue(Array.isArray(requirements) && requirements.length > 0, 'At least one reviewed capability requirement is required')
  const ids = new Set()
  for (const item of requirements) {
    requireValue(isRecord(item) && typeof item.toolId === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(item.toolId) && !ids.has(item.toolId), 'Invalid or duplicate capability requirement')
    ids.add(item.toolId)
    requireValue(typeof item.acceptance === 'string' && item.acceptance.trim().length > 0 && isRecord(item.checks), 'An exact acceptance criterion and reviewed check inventory are required')
    requireValue(Object.keys(item.checks).length === ENVIRONMENTS.length && ENVIRONMENTS.every(environment => Object.hasOwn(item.checks, environment)), 'Every acceptance environment needs an explicit check inventory')
    for (const environment of ENVIRONMENTS) stringList(item.checks[environment], 'Expected acceptance checks must be nonempty and unique')
  }
  return requirements
}

export function receiptKey(receipt) {
  return [receipt.toolId, receipt.stage, receipt.environment, receipt.profile].join(':')
}

export function validateReceipt(receipt, document, requirements) {
  requireValue(receipt?.schemaVersion === 1 && receipt.kind === 'xpanel-capability-acceptance' && typeof receipt.runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(receipt.runId) && typeof receipt.receiptId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,150}$/.test(receipt.receiptId), 'Unknown or incomplete capability acceptance receipt')
  const requirement = requirements.find(item => item.toolId === receipt.toolId)
  requireValue(requirement !== undefined && receipt.acceptance === requirement.acceptance && receipt.coverage === 'full-acceptance', 'Receipt does not cover the exact capability acceptance criterion')
  requireValue(STAGE_ENVIRONMENTS[receipt.stage]?.includes(receipt.environment), 'Invalid stage/environment pairing')
  requireValue(document.target.supportedProfiles.includes(receipt.profile), 'Receipt profile is outside the target')
  requireValue(receipt.sourceAlgorithm === document.source.algorithm && receipt.sourceFingerprint === document.target.sourceFingerprint && receipt.artifactSha256 === document.target.artifactSha256 && receipt.sourceBefore === receipt.sourceFingerprint && receipt.sourceAfter === receipt.sourceFingerprint && receipt.commit === document.source.commit, 'Mixed or changed source/artifact identity')
  requireValue(receipt.result === 'passed' && (receipt.executor === 'real' || (receipt.environment === 'unit' && receipt.executor === 'fake')), 'Required acceptance must pass on a real executor')
  requireValue(validTime(receipt.startedAt) && validTime(receipt.finishedAt) && Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt), 'Invalid receipt execution times')
  requireValue(receipt.runtime?.node === `v${document.source.node}` && receipt.runtime?.profile === receipt.profile, 'Receipt runtime/profile does not match the target')
  requireValue(profileFromOsRelease(receipt.host?.osRelease) === receipt.profile, 'Observed host OS is not the claimed qualification profile')
  requireValue(isRecord(receipt.cleanup) && receipt.cleanup.ok === true && Array.isArray(receipt.cleanup.errors) && receipt.cleanup.errors.length === 0, 'Cleanup must be confirmed before recording acceptance')
  requireValue(receipt.cleanup.leftovers === undefined || (isRecord(receipt.cleanup.leftovers) && Object.values(receipt.cleanup.leftovers).every(value => Array.isArray(value) && value.length === 0)), 'Cleanup contains remaining or unconfirmed fixture effects')
  if (receipt.environment === 'linux') requireValue(receipt.runtime.platform === 'linux', 'Linux acceptance needs a real Linux runtime')
  if (receipt.environment === 'external') requireValue(receipt.observer?.independent === true && typeof receipt.observer.identity === 'string' && receipt.observer.identity.trim().length > 0, 'External acceptance requires an identified independent observer')
  requireValue(isRecord(receipt.report) && ['checks-v1', 'vitest-v1'].includes(receipt.report.kind) && safeEvidenceRelativePath(receipt.report.path) && isHash(receipt.report.sha256), 'Receipt needs a supported hash-bound semantic report')
  return requirement
}

export function assertCompleteEvidence(evidence, target, requirements) {
  const keys = new Set()
  for (const row of evidence) {
    const key = receiptKey(row)
    requireValue(!keys.has(key), 'Duplicate capability stage/environment/profile evidence')
    keys.add(key)
  }
  for (const item of requirements) for (const profile of target.supportedProfiles) for (const [stage, environments] of Object.entries(STAGE_ENVIRONMENTS)) for (const environment of environments) {
    requireValue(keys.has(`${item.toolId}:${stage}:${environment}:${profile}`), `Missing acceptance evidence: ${item.toolId}/${profile}/${stage}/${environment}`)
  }
}
