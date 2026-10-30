import { describe, expect, it } from 'vitest'
import { buildDeliveryCatalog, specs, tools } from './data/index.ts'
import type { CapabilityEvidence, VerificationTarget } from './types.ts'

const target: VerificationTarget = {
  sourceFingerprint: 'a'.repeat(64), artifactSha256: 'b'.repeat(64), supportedProfiles: ['test-linux'],
}

describe('detached delivery catalog', () => {
  it('accepts only the capability with complete matching evidence without mutating the default catalog', () => {
    const spec = specs.find(item => item.id === 'server-information')!
    const evidence: CapabilityEvidence[] = [
      ['implemented', 'unit'], ['integrated', 'http'], ['integrated', 'browser'],
      ['verified', 'linux'], ['verified', 'browser'], ['verified', 'external'],
    ].map(([stage, environment]) => ({
      toolId: spec.id, acceptance: spec.acceptance,
      stage: stage as CapabilityEvidence['stage'], environment: environment as CapabilityEvidence['environment'],
      executor: 'real', result: 'passed', sourceFingerprint: target.sourceFingerprint,
      artifactSha256: target.artifactSha256, profile: 'test-linux', observedAt: '2026-10-29T12:00:00Z',
      runArtifact: 'synthetic-catalog-guard.json', runArtifactSha256: 'c'.repeat(64),
    }))
    const accepted = buildDeliveryCatalog(evidence, target)
    expect(accepted.filter(tool => tool.status === 'verified').map(tool => tool.id)).toEqual([spec.id])
    expect(tools.some(tool => tool.status === 'verified')).toBe(false)
    expect(accepted.find(tool => tool.id === spec.id)).not.toBe(tools.find(tool => tool.id === spec.id))
    expect(buildDeliveryCatalog(evidence, { ...target, artifactSha256: 'd'.repeat(64) }).some(tool => tool.status === 'verified')).toBe(false)
    expect(buildDeliveryCatalog(evidence, null).some(tool => tool.status === 'verified')).toBe(false)
  })
})
