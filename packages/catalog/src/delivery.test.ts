import { describe, expect, it } from 'vitest'
import { assessDelivery } from './delivery.ts'
import type { CapabilityEvidence, ToolDefinition, ToolSpec, VerificationTarget } from './types.ts'

const tool: ToolDefinition = {
  id: 'example', surface: 'xpanel', groupId: 'files', name: 'Example', summary: '',
  featureKey: 'example', resellerAcl: null, rootOnly: false, entity: 'file', status: 'researched',
}
const spec: ToolSpec = {
  id: tool.id, behaviors: ['Observe the operation.'], acceptance: 'The real operation succeeds and denied access has no side effect.',
  source: 'xpanel:native', upstreamFeatureKey: '', upstreamAcl: '', upstreamApi: '', absorbed: [],
}
const target: VerificationTarget = {
  sourceFingerprint: 'a'.repeat(64), artifactSha256: 'b'.repeat(64), supportedProfiles: ['fixture-profile'],
}
const proof = (over: Partial<CapabilityEvidence> = {}): CapabilityEvidence => ({
  toolId: tool.id, stage: 'implemented', acceptance: spec.acceptance, result: 'passed',
  sourceFingerprint: target.sourceFingerprint, artifactSha256: target.artifactSha256,
  environment: 'unit', profile: 'fixture-profile', executor: 'real',
  runArtifact: 'fixture-results/acceptance.json', runArtifactSha256: 'c'.repeat(64),
  observedAt: '2026-10-22T08:00:00.000Z', ...over,
})
const completeEvidence = (): CapabilityEvidence[] => [
  proof(),
  proof({ stage: 'integrated', environment: 'http' }),
  proof({ stage: 'integrated', environment: 'browser' }),
  proof({ stage: 'verified', environment: 'browser' }),
  proof({ stage: 'verified', environment: 'linux' }),
  proof({ stage: 'verified', environment: 'external' }),
]
const assess = (evidence: readonly CapabilityEvidence[], verificationTarget: VerificationTarget | null = target) =>
  assessDelivery(tool, spec, evidence, verificationTarget)

describe('capability delivery evidence', () => {
  it('leaves declarations unverified when there is no release target or result', () => {
    expect(assess([], null).status).toBe('researched')
    expect(assess([]).status).toBe('researched')
    const declaration = 'apps/api/src/api.test.ts :: a matching test name'
    expect(assess([declaration as unknown as CapabilityEvidence]).status).toBe('researched')
  })

  it('records domain implementation separately from browser and service acceptance', () => {
    expect(assess([proof()]).status).toBe('implemented')
    expect(assess(completeEvidence().filter(item => item.stage !== 'verified')).status).toBe('integrated')
    expect(assess(completeEvidence()).status).toBe('verified')
    expect(assess(completeEvidence()).evidence).toHaveLength(6)
  })

  it('does not promote from a filename, a generic criterion or another tool result', () => {
    expect(assess([proof({ acceptance: 'auth, tokens and CSRF' })]).status).toBe('researched')
    expect(assess([proof({ toolId: 'another-tool' })]).status).toBe('researched')
    expect(assessDelivery({ ...tool, id: 'other' }, spec, completeEvidence(), target).status).toBe('researched')
  })

  it('invalidates results from another source tree or release artifact', () => {
    expect(assess(completeEvidence().map(item => ({ ...item, sourceFingerprint: 'd'.repeat(64) }))).status).toBe('researched')
    expect(assess(completeEvidence().map(item => ({ ...item, artifactSha256: 'd'.repeat(64) }))).status).toBe('implemented')
    expect(assess(completeEvidence(), { ...target, sourceFingerprint: '' }).status).toBe('researched')
    expect(assess(completeEvidence(), { ...target, artifactSha256: null }).status).toBe('implemented')
  })

  it('requires supported environments, hashed run artifacts and observation times', () => {
    for (const invalid of [
      proof({ profile: 'unsupported-profile' }),
      proof({ runArtifact: '' }),
      proof({ runArtifactSha256: '' }),
      proof({ observedAt: 'not-a-date' }),
    ]) expect(assess([invalid]).status).toBe('researched')
  })

  it('never treats a fake HTTP or Linux executor as acceptance of a real service', () => {
    const simulated = completeEvidence().map(item => ({ ...item, executor: 'fake' as const }))
    expect(assess(simulated).status).toBe('implemented')
    expect(assess(completeEvidence().map(item => item.environment === 'linux' ? { ...item, executor: 'fake' as const } : item)).status).toBe('integrated')
  })

  it('requires every preceding tier and the external observation', () => {
    expect(assess(completeEvidence().filter(item => item.stage !== 'implemented')).status).toBe('researched')
    expect(assess(completeEvidence().filter(item => item.environment !== 'external')).status).toBe('integrated')
    expect(assess([proof(), proof({ stage: 'verified', environment: 'linux' })]).status).toBe('implemented')
  })

  it.each(['failed', 'blocked', 'not_run'] as const)('replaces an older pass with a later %s observation', result => {
    const later = proof({ stage: 'verified', environment: 'linux', result, observedAt: '2026-10-22T08:05:00.000Z' })
    expect(assess([...completeEvidence(), later]).status).toBe('integrated')
    expect(assess([later, ...completeEvidence()]).status).toBe('integrated')
    expect(assess([...completeEvidence(), later, { ...later, result: 'passed', observedAt: '2026-10-22T08:06:00.000Z' }]).status).toBe('verified')
  })

  it('keeps exclusions outside the delivery tiers even if proof is supplied', () => {
    const excluded: ToolDefinition = { ...tool, status: 'out-of-scope', outOfScopeReason: 'Proprietary product excluded.' }
    const assessment = assessDelivery(excluded, spec, completeEvidence(), target)
    expect(assessment.status).toBe('out-of-scope')
    expect(assessment.reason).toBe(excluded.outOfScopeReason)
    expect(assessment.evidence).toEqual([])
  })
})
