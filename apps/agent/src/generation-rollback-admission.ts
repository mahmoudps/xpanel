import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { latestActive, listGenerations } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { buildGenerationRollbackAdmission, generationSourceIsLinked, readGenerationReconciliationLeaseAvailable } from '@xpanel/state'
import type { GenerationRollbackAdmission, StateStore } from '@xpanel/state'
import { LinuxHostExecutor } from './executor.ts'
import type { AgentExecutor } from './executor.ts'
import type { ReconcilerJournal } from './reconciler-journal.ts'

/** Observation only. No mutex initialization, host command, schema or desired-state write. */
export async function readGenerationRollbackAdmission(input: {
  store: StateStore; db: Db; executor?: AgentExecutor; journal: ReconcilerJournal
}): Promise<GenerationRollbackAdmission> {
  const executor = input.executor instanceof LinuxHostExecutor ? 'linux' : input.executor ? 'fake' : 'unknown'
  const unavailable = () => buildGenerationRollbackAdmission({ executor, supportedProfile: false, mutexAvailable: false, sourceAvailable: false, activeGeneration: null, sourceRevision: null, eligibleTargets: [] })
  if (executor !== 'linux' || !input.executor) return unavailable()
  try {
    const release = await input.executor.readFile('/etc/os-release')
    if (!release) return unavailable()
    profileFor(release)
    if (!await readGenerationReconciliationLeaseAvailable(input.store.rootDir)) return unavailable()
    const authorityFile = await lstat(join(input.store.rootDir, 'authority.json'))
    if (!authorityFile.isFile() || authorityFile.isSymbolicLink() || await input.journal.readActiveJournal()) return unavailable()
    const [authority, active, generations] = await Promise.all([input.store.getAuthorityMetadata(), latestActive(input.db), listGenerations(input.db)])
    if (!active) return unavailable()
    const [activeSource, activeManifest] = await Promise.all([input.store.readValidatedGenerationSnapshot(active.id), input.journal.readManifest(active.id)])
    if (!generationSourceIsLinked(active, activeSource, activeManifest)) return unavailable()
    const eligibleTargets: { generationId: number; checksum: string }[] = []
    for (const target of generations.filter(item => item.status === 'superseded' && item.id !== active.id)) {
      try {
        const [source, manifest] = await Promise.all([input.store.readValidatedGenerationSnapshot(target.id), input.journal.readManifest(target.id)])
        if (generationSourceIsLinked(target, source, manifest)) eligibleTargets.push({ generationId: target.id, checksum: target.checksum })
      } catch { /* A malformed historical target remains readable but cannot be restored. */ }
    }
    const [confirmed, revision] = await Promise.all([latestActive(input.db), input.store.getRevision()])
    return buildGenerationRollbackAdmission({ executor, supportedProfile: true, mutexAvailable: true,
      sourceAvailable: confirmed?.id === active.id && confirmed.checksum === active.checksum && revision === authority.revision,
      activeGeneration: { id: active.id, checksum: active.checksum }, sourceRevision: authority.revision, eligibleTargets })
  } catch { return unavailable() }
}
