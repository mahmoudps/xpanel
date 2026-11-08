import type {
  CapabilityDelivery, CapabilityEvidence, DeliveryStage, EvidenceEnvironment,
  ProfileExclusion, ToolDefinition, ToolSpec, VerificationTarget,
} from './types.ts'

const sha256 = /^[a-f0-9]{64}$/
const stages: readonly DeliveryStage[] = ['implemented', 'integrated', 'verified']
const requiredEnvironments: Record<DeliveryStage, readonly EvidenceEnvironment[]> = {
  implemented: ['unit'],
  integrated: ['http', 'browser'],
  verified: ['linux', 'browser', 'external'],
}

const validTarget = (target: VerificationTarget): boolean => {
  if (typeof target !== 'object' || target === null || !sha256.test(target.sourceFingerprint)) return false
  if (target.artifactSha256 !== null && !sha256.test(target.artifactSha256)) return false
  return Array.isArray(target.supportedProfiles) && target.supportedProfiles.length > 0
    && target.supportedProfiles.every(profile => typeof profile === 'string' && profile.trim() === profile && profile.length > 0)
    && new Set(target.supportedProfiles).size === target.supportedProfiles.length
}

/** Owner decision 9: every tool needs all target profiles unless a reviewed entry here proves it cannot exist on one. */
export const PROFILE_EXCLUSIONS: Readonly<Record<string, ProfileExclusion>> = {
  'wheel-group-users': { profiles: ['ubuntu-22.04', 'ubuntu-24.04'], reason: 'Ubuntu grants administrator rights through the sudo group; there is no wheel group to manage.' },
  'sudo-group-users': { profiles: ['almalinux-9', 'rocky-9', 'centos-stream-9'], reason: 'Enterprise Linux grants administrator rights through the wheel group; there is no sudo group to manage.' },
}

/** Profiles a tool must be proven on; empty (never verified) when its exclusion is malformed or leaves nothing. */
export const requiredProfiles = (
  toolId: string, target: VerificationTarget, exclusions: Readonly<Record<string, ProfileExclusion>> = PROFILE_EXCLUSIONS,
): readonly string[] => {
  const exclusion = Object.hasOwn(exclusions, toolId) ? exclusions[toolId] : undefined
  if (exclusion === undefined) return target.supportedProfiles
  const valid = typeof exclusion.reason === 'string' && exclusion.reason.trim().length > 0 && Array.isArray(exclusion.profiles)
    && exclusion.profiles.length > 0 && new Set(exclusion.profiles).size === exclusion.profiles.length
    && exclusion.profiles.every(profile => target.supportedProfiles.includes(profile))
  return valid ? target.supportedProfiles.filter(profile => !exclusion.profiles.includes(profile)) : []
}

const matchesTarget = (proof: CapabilityEvidence, spec: ToolSpec, target: VerificationTarget): boolean => {
  if (typeof proof !== 'object' || proof === null) return false
  if (proof.toolId !== spec.id || proof.acceptance !== spec.acceptance || !stages.includes(proof.stage)) return false
  if (!sha256.test(target.sourceFingerprint) || proof.sourceFingerprint !== target.sourceFingerprint) return false
  if (!target.supportedProfiles.includes(proof.profile)) return false
  if (typeof proof.runArtifact !== 'string' || !proof.runArtifact.trim() || !sha256.test(proof.runArtifactSha256)) return false
  if (!Number.isFinite(Date.parse(proof.observedAt))) return false
  if (proof.environment !== 'unit' && proof.executor !== 'real') return false
  if (proof.stage === 'implemented') return true
  return target.artifactSha256 !== null && sha256.test(target.artifactSha256)
    && proof.artifactSha256 === target.artifactSha256
}

/** Each tier requires its own results. HTTP with a fake executor cannot prove a live service. */
export const assessDelivery = (
  tool: ToolDefinition, spec: ToolSpec, observations: readonly CapabilityEvidence[],
  target: VerificationTarget | null, exclusions: Readonly<Record<string, ProfileExclusion>> = PROFILE_EXCLUSIONS,
): CapabilityDelivery => {
  if (tool.status === 'out-of-scope') {
    return { status: 'out-of-scope', reason: tool.outOfScopeReason ?? 'Outside the product scope.', evidence: [] }
  }
  if (target === null || !validTarget(target) || tool.id !== spec.id || !spec.acceptance.trim()) {
    return { status: 'researched', reason: 'No source and release target with supported acceptance evidence.', evidence: [] }
  }
  const profiles = requiredProfiles(tool.id, target, exclusions)
  if (profiles.length === 0) {
    return { status: 'researched', reason: 'The reviewed profile exclusion for this capability is invalid.', evidence: [] }
  }
  const latest = new Map<string, CapabilityEvidence>()
  for (const proof of observations.filter(proof => matchesTarget(proof, spec, target) && profiles.includes(proof.profile))) {
    const key = `${proof.stage}:${proof.environment}:${proof.profile}`
    const previous = latest.get(key)
    if (previous === undefined || Date.parse(proof.observedAt) > Date.parse(previous.observedAt)
      || (Date.parse(proof.observedAt) === Date.parse(previous.observedAt) && proof.result !== 'passed')) latest.set(key, proof)
  }
  const evidence = [...latest.values()]
  let status: CapabilityDelivery['status'] = 'researched'
  for (const stage of stages) {
    const results = evidence.filter(proof => proof.stage === stage)
    if (results.some(proof => proof.result !== 'passed')) break
    // Every declared profile must supply its own complete tier. Evidence from
    // different distributions cannot fill each other's missing observations.
    if (!profiles.every(profile => {
      const environments = new Set(results.filter(proof => proof.profile === profile).map(proof => proof.environment))
      return requiredEnvironments[stage].every(environment => environments.has(environment))
    })) break
    status = stage
  }
  return {
    status,
    reason: status === 'verified'
      ? 'Acceptance observed on the target artifact in supported browser, Linux and external environments.'
      : `Acceptance evidence is incomplete for the tier after ${status}.`,
    evidence,
  }
}
