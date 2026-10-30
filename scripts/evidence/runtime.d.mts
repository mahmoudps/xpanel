import type { CapabilityEvidence, VerificationTarget } from '@xpanel/catalog'

export interface CapabilityRequirement {
  toolId: string
  acceptance: string
  checks: Record<'unit' | 'http' | 'browser' | 'linux' | 'external', readonly string[]>
}

export interface VerifiedEvidenceBundle {
  target: VerificationTarget
  evidence: readonly CapabilityEvidence[]
  source: {
    algorithm: 'xpanel-executable-inputs-v1'
    commit: string
    tree: string
    dirty: false
    sourceFingerprint: string
    node: string
    lockfileSha256: string
    files: readonly { path: string; bytes: number; sha256: string }[]
  }
  requirements: readonly CapabilityRequirement[]
}

export function verifyEvidenceBundle(bundle: unknown, options: {
  expectedTarget: VerificationTarget
  expectedRequirements?: readonly CapabilityRequirement[]
  evidenceRoot?: string
}): VerifiedEvidenceBundle

export function loadTrustedEvidenceBundle(options: {
  path: string
  expectedSha256: string
  expectedTarget: VerificationTarget
  expectedRequirements: readonly CapabilityRequirement[]
}): VerifiedEvidenceBundle

export function assertTrustedMetadata(entries: readonly {
  uid: number
  mode: number
  symlink: boolean
}[]): void
