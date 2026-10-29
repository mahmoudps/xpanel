import { fail } from '@xpanel/core'
import type { StateSnapshot } from './types.ts'
import { checksumStateTree } from './validate-state.ts'

export const GENERATION_ROLLBACK_GUARD_VERSION = 1
export interface GenerationRollbackRequest {
  expectedCurrentGenerationId: number
  expectedCurrentStateRevision: number
  expectedTargetChecksum: string
  confirmation: string
}
export interface GenerationDesiredState { revision: number; checksum: string; pending: boolean }
export interface GenerationIdentity { id: number; status: string; checksum: string }
export interface GenerationRollbackAdmission {
  guardVersion: 1
  source: 'agent'
  executor: 'linux' | 'fake' | 'unknown'
  canRollback: boolean
  activeGeneration: { id: number; checksum: string } | null
  sourceRevision: number | null
  eligibleTargets: { generationId: number; checksum: string }[]
}
const SHA256 = /^[0-9a-f]{64}$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Sealed transport grammar. Authorization is a separate trusted callback. */
export function parseGenerationRollbackRequest(generationId: number, value: unknown): GenerationRollbackRequest {
  const keys = ['expectedCurrentGenerationId', 'expectedCurrentStateRevision', 'expectedTargetChecksum', 'confirmation']
  if (!Number.isSafeInteger(generationId) || generationId < 1 || !object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || typeof value.expectedCurrentGenerationId !== 'number' || !Number.isSafeInteger(value.expectedCurrentGenerationId) || value.expectedCurrentGenerationId < 1
    || typeof value.expectedCurrentStateRevision !== 'number' || !Number.isSafeInteger(value.expectedCurrentStateRevision) || value.expectedCurrentStateRevision < 0
    || typeof value.expectedTargetChecksum !== 'string' || !SHA256.test(value.expectedTargetChecksum) || value.confirmation !== String(generationId)) {
    return fail('VALIDATION', 'generation restore requires the exact reviewed current generation, desired revision, target checksum and target-number confirmation', { stateChanged: false })
  }
  return Object.freeze({ expectedCurrentGenerationId: value.expectedCurrentGenerationId, expectedCurrentStateRevision: value.expectedCurrentStateRevision, expectedTargetChecksum: value.expectedTargetChecksum, confirmation: value.confirmation })
}

/** Source checksum only; the rendered-files checksum in the generation row is different. */
export function generationSourceChecksum(value: unknown): string | null {
  if (!object(value) || typeof value.checksum !== 'string' || !SHA256.test(value.checksum)
    || !['featureLists', 'plans', 'resellers', 'accounts', 'domains', 'serviceUsers', 'databases', 'databaseUsers', 'certificates', 'zones', 'cronJobs'].every(key => Array.isArray(value[key]))
    || value.server !== null && !object(value.server) || !object(value.firewall) || !object(value.uidAllocator)) return null
  try { return checksumStateTree(value as unknown as StateSnapshot) === value.checksum ? value.checksum : null }
  catch { return null }
}

export function generationDesiredState(current: StateSnapshot, appliedSource: StateSnapshot | null): GenerationDesiredState | null {
  const checksum = generationSourceChecksum(current), appliedChecksum = generationSourceChecksum(appliedSource)
  if (!checksum || !appliedChecksum || typeof current.revision !== 'number' || !Number.isSafeInteger(current.revision) || current.revision < 0) return null
  return { revision: current.revision, checksum, pending: checksum !== appliedChecksum }
}

/** Bind the persisted desired source to the generation's actual rendered manifest. */
export function generationSourceIsLinked(generation: GenerationIdentity, source: StateSnapshot | null, manifest: unknown): boolean {
  const checksum = generationSourceChecksum(source)
  return !!checksum && object(manifest) && manifest.generationId === generation.id && manifest.stateChecksum === checksum && manifest.filesChecksum === generation.checksum
}

/** Must execute inside the restore writer lease with fresh DB generation observations. */
export function assertGenerationRollbackPreconditions(generationId: number, request: GenerationRollbackRequest, input: {
  current: StateSnapshot; active: GenerationIdentity | null; target: GenerationIdentity | null; appliedSource: StateSnapshot | null
}): void {
  const checked = parseGenerationRollbackRequest(generationId, request)
  if (!input.active || input.active.status !== 'active' || input.active.id !== checked.expectedCurrentGenerationId
    || !input.target || input.target.id !== generationId || input.target.status !== 'superseded' || input.target.id === input.active.id
    || input.target.checksum !== checked.expectedTargetChecksum) return fail('CONFLICT', 'the current or reviewed target generation changed', { stateChanged: false })
  const desired = generationDesiredState(input.current, input.appliedSource)
  if (!desired || desired.revision !== checked.expectedCurrentStateRevision || desired.pending) return fail('CONFLICT', 'saved desired changes must be preserved; read and review the current state before restoring', { stateChanged: false })
}

/** Only server-produced observations may populate this admission. It is not native qualification. */
export function buildGenerationRollbackAdmission(input: {
  executor: 'linux' | 'fake' | 'unknown'; supportedProfile: boolean; mutexAvailable: boolean; sourceAvailable: boolean
  activeGeneration: { id: number; checksum: string } | null; sourceRevision: number | null
  eligibleTargets: readonly { generationId: number; checksum: string }[]
}): GenerationRollbackAdmission {
  const seen = new Set<number>()
  const targets = input.eligibleTargets.filter(item => Number.isSafeInteger(item.generationId) && item.generationId > 0 && SHA256.test(item.checksum) && !seen.has(item.generationId) && !!seen.add(item.generationId)).map(item => ({ ...item })).sort((a, b) => b.generationId - a.generationId)
  const active = input.activeGeneration && Number.isSafeInteger(input.activeGeneration.id) && input.activeGeneration.id > 0 && SHA256.test(input.activeGeneration.checksum) ? { ...input.activeGeneration } : null
  const revision = typeof input.sourceRevision === 'number' && Number.isSafeInteger(input.sourceRevision) && input.sourceRevision >= 0 ? input.sourceRevision : null
  const canRollback = input.executor === 'linux' && input.supportedProfile && input.mutexAvailable && input.sourceAvailable && !!active && revision !== null && targets.length > 0
  return { guardVersion: GENERATION_ROLLBACK_GUARD_VERSION, source: 'agent', executor: input.executor, canRollback, activeGeneration: active, sourceRevision: revision, eligibleTargets: canRollback ? targets : [] }
}

export function parseGenerationRollbackAdmission(value: unknown): GenerationRollbackAdmission | null {
  if (!object(value) || value.guardVersion !== GENERATION_ROLLBACK_GUARD_VERSION || value.source !== 'agent' || typeof value.executor !== 'string' || !['linux', 'fake', 'unknown'].includes(value.executor) || typeof value.canRollback !== 'boolean'
    || !Array.isArray(value.eligibleTargets) || value.eligibleTargets.length > 10000 || value.activeGeneration !== null && !object(value.activeGeneration)
    || value.sourceRevision !== null && (typeof value.sourceRevision !== 'number' || !Number.isSafeInteger(value.sourceRevision) || value.sourceRevision < 0)) return null
  const active = value.activeGeneration
  if (active !== null && (!object(active) || typeof active.id !== 'number' || !Number.isSafeInteger(active.id) || active.id < 1 || typeof active.checksum !== 'string' || !SHA256.test(active.checksum))) return null
  const seen = new Set<number>()
  for (const target of value.eligibleTargets) {
    if (!object(target) || typeof target.generationId !== 'number' || !Number.isSafeInteger(target.generationId) || target.generationId < 1 || seen.has(target.generationId) || typeof target.checksum !== 'string' || !SHA256.test(target.checksum)) return null
    seen.add(target.generationId)
  }
  if (value.canRollback && (value.executor !== 'linux' || active === null || value.sourceRevision === null || value.eligibleTargets.length === 0)) return null
  return value as unknown as GenerationRollbackAdmission
}
