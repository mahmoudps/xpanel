import { latestActive, listGenerations } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { generationDesiredState, parseGenerationRollbackAdmission } from '@xpanel/state'
import type { GenerationDesiredState, GenerationRollbackAdmission, StateSnapshot, StateStore } from '@xpanel/state'

/** Read-only generation history with source-bound admission from the authenticated agent. */
export async function readGenerationWorkspace(input: {
  store: StateStore
  db: Db
  readAdmission: () => Promise<unknown>
}): Promise<{
  generations: Awaited<ReturnType<typeof listGenerations>>
  currentGeneration: Awaited<ReturnType<typeof latestActive>>
  desiredState: GenerationDesiredState | null
  canRollback: boolean
  rollbackEligibleGenerationIds: number[]
}> {
  const [generations, currentGeneration, snapshot] = await Promise.all([
    listGenerations(input.db), latestActive(input.db), input.store.readSnapshot().catch(() => null),
  ])
  let appliedSource: StateSnapshot | null = null
  try { if (currentGeneration) appliedSource = await input.store.readValidatedGenerationSnapshot(currentGeneration.id) }
  catch { /* History is readable when a legacy or invalid source cannot qualify recovery. */ }
  const desiredState = snapshot ? generationDesiredState(snapshot, appliedSource) : null
  let admission: GenerationRollbackAdmission | null = null
  try { admission = parseGenerationRollbackAdmission(await input.readAdmission()) } catch { /* Source absence fails closed. */ }
  const [confirmed, revision] = await Promise.all([latestActive(input.db), input.store.getRevision()])
  const coherent = !!currentGeneration && currentGeneration.status === 'active' && confirmed?.id === currentGeneration.id
    && confirmed.checksum === currentGeneration.checksum && !!snapshot && revision === snapshot.revision
  const eligible = admission?.canRollback ? generations.filter(item => item.status === 'superseded'
    && admission.eligibleTargets.some(target => target.generationId === item.id && target.checksum === item.checksum)).map(item => item.id) : []
  const canRollback = coherent && !!desiredState && !desiredState.pending && admission?.canRollback === true
    && admission.activeGeneration?.id === currentGeneration!.id && admission.activeGeneration.checksum === currentGeneration!.checksum
    && admission.sourceRevision === desiredState.revision && eligible.length > 0
  return { generations, currentGeneration, desiredState, canRollback, rollbackEligibleGenerationIds: canRollback ? eligible : [] }
}
