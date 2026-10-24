import { readLifecyclePublicStatus, readLifecycleBarrier } from './lifecycle-admission.mjs'
import { readInstallationReceipt, readTrustedFile, requireLinuxRoot } from './lifecycle-ownership.mjs'
import { verifyAuthenticatedReleaseArchive, verifyAuthenticatedReleaseTree } from './release-verifier.mjs'
import { observeOwnedControlPlaneUnits } from './lifecycle-services.mjs'

const COMMANDS = Object.freeze({ status: ['read'], doctor: ['read'], install: ['plan', 'apply'], adopt: ['plan', 'apply'], update: ['check', 'plan', 'apply'], upgrade: ['plan', 'apply'], 'rollback-release': ['plan', 'apply'], recover: ['plan', 'apply'], uninstall: ['plan', 'apply'], 'verify-install-source': ['read'], 'verify-install-ready': ['read'] })
const fail = code => { throw Object.assign(new Error(code), { code }) }
const result = (exitCode, code, outcome, details = {}) => Object.freeze({ exitCode, code, outcome, details: Object.freeze(details) })
const SHA = /^[a-f0-9]{64}$/

export function validateLifecycleRuntimeRequest(request) {
  const fields = ['schemaVersion', 'command', 'mode', 'json', 'assumeYes', 'artifact', 'artifactDir', 'dependencyReceipt', 'targetRelease']
  if (!request || typeof request !== 'object' || Array.isArray(request) || Reflect.ownKeys(request).some(key => !fields.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(request, key) ?? {}, 'value')) || request.schemaVersion !== 1 || !Object.hasOwn(COMMANDS, request.command) || !COMMANDS[request.command].includes(request.mode) || typeof request.json !== 'boolean' || typeof request.assumeYes !== 'boolean') fail('LIFECYCLE_REQUEST_INVALID')
  if (request.mode === 'apply' && !request.assumeYes) fail('LIFECYCLE_CONFIRMATION_REQUIRED')
  if (request.artifact) {
    const artifact = request.artifact
    if (Object.keys(artifact).sort().join(',') !== 'expectedArchiveSha256,keyId,path,signingKeyPath' || !SHA.test(artifact.expectedArchiveSha256) || !['path', 'signingKeyPath'].every(key => typeof artifact[key] === 'string' && artifact[key].startsWith('/') && !/[\0\r\n]/.test(artifact[key])) || typeof artifact.keyId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(artifact.keyId)) fail('LIFECYCLE_ARTIFACT_INVALID')
  }
  return Object.freeze({ ...request })
}

export function lifecycleCompatibilitySummary(installed, target) {
  const from = /^(\d+)\.(\d+)\.(\d+)$/.exec(installed?.source?.version ?? ''), to = /^(\d+)\.(\d+)\.(\d+)$/.exec(target?.version ?? '')
  if (!from || !to) fail('LIFECYCLE_VERSION_INVALID')
  return Object.freeze({ sameMajor: from[1] === to[1], newer: Number(to[1]) > Number(from[1]) || to[1] === from[1] && (Number(to[2]) > Number(from[2]) || to[2] === from[2] && Number(to[3]) > Number(from[3])), sameSchema: installed.source.controlDbSchemaVersion === target.controlDbSchemaVersion })
}

async function sourceDiagnostic(request) {
  if (!request.artifact) fail('AUTHENTICATED_ARTIFACT_REQUIRED')
  requireLinuxRoot()
  const key = await readTrustedFile(request.artifact.signingKeyPath, { exactMode: 0o600, maxBytes: 4096 })
  if (key.bytes.length < 32) fail('LIFECYCLE_TRUST_KEY_INVALID')
  const trust = { signingKey: key.bytes, keyId: request.artifact.keyId, expectedArchiveSha256: request.artifact.expectedArchiveSha256 }
  const report = await verifyAuthenticatedReleaseArchive(request.artifact.path, trust)
  if (request.artifactDir) await verifyAuthenticatedReleaseTree(request.artifactDir, { signingKey: key.bytes, keyId: trust.keyId, authenticatedArchive: report })
  return report
}

/** Fixed runtime dispatch. Diagnostic source receipts never authorize application effects. */
export async function runLifecycleRuntime(input) {
  try {
    const request = validateLifecycleRuntimeRequest(input)
    if (request.command === 'status') {
      const status = await readLifecyclePublicStatus()
      return result(0, status.active ? 'LIFECYCLE_ATTENTION_RETAINED' : 'LIFECYCLE_NORMAL_OPERATION', 'read', { active: status.active, reference: status.reference, phase: status.phase, ready: false })
    }
    if (request.command === 'doctor') {
      const actual = await readInstallationReceipt()
      await observeOwnedControlPlaneUnits(actual.receipt)
      return result(0, 'LIFECYCLE_NATIVE_PREREQUISITES_OBSERVED', 'read', { version: actual.receipt.source.version, ready: false, nativeQualified: false })
    }
    if (request.mode === 'plan') return result(0, 'LIFECYCLE_PLAN_ONLY', 'planned', { command: request.command, ready: false, reason: 'Actual native admission and runtime verification are required before effects.' })
    if (request.command === 'verify-install-source' || request.command === 'verify-install-ready' || request.command === 'update' && request.mode === 'check') {
      const source = await sourceDiagnostic(request)
      if (request.command === 'verify-install-ready') return result(3, 'SOURCE_PROOF_IS_NOT_RUNTIME_READINESS', 'blocked', { version: source.manifest.version, sourceVerified: true, runtimeDependenciesVerified: false, installReady: false })
      return result(0, 'SOURCE_AUTHENTICATED_NOT_INSTALL_READY', 'read', { version: source.manifest.version, sourceVerified: true, runtimeDependenciesVerified: false, installReady: false })
    }
    requireLinuxRoot()
    if (process.version !== 'v26.12.1' || process.env.NODE_OPTIONS || process.env.NODE_PATH) fail('LIFECYCLE_PINNED_RUNTIME_REQUIRED')
    // A real pending barrier must be recovered, never bypassed by a new apply request.
    if (await readLifecycleBarrier() && request.command !== 'recover') fail('LIFECYCLE_RETAINED_ATTENTION')
    const native = await import('./lifecycle-root-safety.mjs')
    return await native.executeNativeLifecycleCommand(request)
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'LIFECYCLE_PREREQUISITES_UNAVAILABLE'
    return result(code.includes('ATTENTION') || code.includes('UNCERTAIN') ? 6 : 3, code, code.includes('ATTENTION') || code.includes('UNCERTAIN') ? 'attention' : 'blocked')
  }
}
