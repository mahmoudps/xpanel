import { afterEach, describe, expect, it } from 'vitest'
import { createTestStateStore } from './store.ts'
import type { TestStateStoreHandle } from './store.ts'
import { assertGenerationRollbackPreconditions, buildGenerationRollbackAdmission, generationDesiredState, generationSourceIsLinked, parseGenerationRollbackAdmission, parseGenerationRollbackRequest } from './generation-rollback.ts'

const handles: TestStateStoreHandle[] = []
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close() })
const request = { expectedCurrentGenerationId: 9, expectedCurrentStateRevision: 0, expectedTargetChecksum: '7'.repeat(64), confirmation: '7' }
async function fixture() { const handle = await createTestStateStore(); handles.push(handle); return { ...handle, source: await handle.store.readSnapshot() } }
describe('guarded generation source and transport contract', () => {
  it.each([{ ...request, bypass: true }, { ...request, expectedCurrentStateRevision: -1 }, { ...request, expectedCurrentStateRevision: '0' }, { ...request, confirmation: '07' }, { ...request, confirmation: true }, { ...request, expectedTargetChecksum: 'invalid' }, {}])('refuses missing or injected rollback authority %#', body => {
    expect(() => parseGenerationRollbackRequest(7, body)).toThrow()
  })
  it('uses exact desired-source checksums and persisted revisions rather than rendered hashes', async () => {
    const f = await fixture()
    expect(parseGenerationRollbackRequest(7, request)).toEqual(request)
    expect(generationDesiredState(f.source, f.source)).toEqual({ revision: f.source.revision, checksum: f.source.checksum, pending: false })
    const generation = { id: 9, status: 'active', checksum: '9'.repeat(64) }
    expect(generationSourceIsLinked(generation, f.source, { generationId: 9, stateChecksum: f.source.checksum, filesChecksum: generation.checksum })).toBe(true)
    expect(generationSourceIsLinked(generation, f.source, { generationId: 9, stateChecksum: generation.checksum, filesChecksum: generation.checksum })).toBe(false)
    const active = generation, target = { id: 7, status: 'superseded', checksum: request.expectedTargetChecksum }
    assertGenerationRollbackPreconditions(7, { ...request, expectedCurrentStateRevision: f.source.revision! }, { current: f.source, active, target, appliedSource: f.source })
    await f.store.createFeatureList({ name: 'Saved change', ownerId: null, disabled: [] })
    const changed = await f.store.readSnapshot()
    expect(generationDesiredState(changed, f.source)?.pending).toBe(true)
    expect(() => assertGenerationRollbackPreconditions(7, { ...request, expectedCurrentStateRevision: changed.revision! }, { current: changed, active, target, appliedSource: f.source })).toThrow()
  })
  it('fails closed on missing native observations and treats modeled readiness as admission only', () => {
    const observations = { supportedProfile: true, mutexAvailable: true, sourceAvailable: true, activeGeneration: { id: 9, checksum: '9'.repeat(64) }, sourceRevision: 20, eligibleTargets: [{ generationId: 7, checksum: '7'.repeat(64) }] }
    expect(buildGenerationRollbackAdmission({ ...observations, executor: 'fake' }).canRollback).toBe(false)
    expect(buildGenerationRollbackAdmission({ ...observations, executor: 'linux', mutexAvailable: false }).canRollback).toBe(false)
    // Declared source DTO fake; no native host or Linux readiness is established by this test.
    const admitted = buildGenerationRollbackAdmission({ ...observations, executor: 'linux' })
    expect(parseGenerationRollbackAdmission(admitted)).toEqual(admitted)
    expect(parseGenerationRollbackAdmission({ ...admitted, executor: 'fake' })).toBeNull()
    expect(parseGenerationRollbackAdmission({ ...admitted, eligibleTargets: [admitted.eligibleTargets[0], admitted.eligibleTargets[0]] })).toBeNull()
    expect(parseGenerationRollbackAdmission({ ...admitted, sourceRevision: undefined })).toBeNull()
  })
})
