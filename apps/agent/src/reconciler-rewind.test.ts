import { randomUUID } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { suggestServerSettings } from '@xpanel/core'
import { createGeneration, createTestDb, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import { HostReconciler } from './reconciler.ts'
import type { GenerationManifest } from './reconciler-journal.ts'

const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
let state: TestStateStoreHandle
let db: TestDbHandle
// Device flushes, not these contracts, set the wall time; flush durability is proven by packages/state atomic-durability tests.
let restoreFileSync = (): void => {}
beforeAll(async () => {
  const probe = await open(fileURLToPath(import.meta.url), 'r')
  try {
    const sync = vi.spyOn(Object.getPrototypeOf(probe) as FileHandle, 'sync').mockResolvedValue(undefined)
    restoreFileSync = () => sync.mockRestore()
  } finally { await probe.close() }
})
afterAll(() => restoreFileSync())
beforeEach(async () => {
  state = await createTestStateStore()
  db = await createTestDb()
  const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
  await state.store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
})
afterEach(async () => { await state.close(); await db.close() })

const attention = (generationId: number, previous: number, manifest: GenerationManifest) => {
  const at = new Date().toISOString()
  return { schemaVersion: 1 as const, journalId: randomUUID(), generationId, previousActiveGenerationId: previous, actor: 'root', stateChecksum: manifest.stateChecksum,
    filesChecksum: manifest.filesChecksum, phase: 'needs_attention' as const, startedAt: at, updatedAt: at, candidateManifest: { ...manifest, generationId }, previousManifest: manifest,
    diff: { added: [], updated: [], unchanged: manifest.files, removed: [], removedUnits: [], affectedServices: [] }, previousFilesBackup: [], completedPreActions: 2,
    preActionsNeedVerification: true, switchedFilePaths: [], removedFilePaths: [], stoppedObsoleteUnits: [], completedPostActions: 0, reloadedUnits: [], verifiedUnits: [], error: 'post-action failed' }
}

describe('upgrade rewind reconciliation', { tags: ['feature'] }, () => {
  it('keeps an attention the rewound upgrade did not create, and names its generation in every refusal', async () => {
    const reconciler = new HostReconciler({ store: state.store, db: db.db, executor: new FakeHostExecutor(), os })
    const applied = await reconciler.reconcile({ actor: 'root' })
    if (applied.status !== 'applied') throw new Error('generation did not apply')
    const manifest = (await reconciler.journal.readManifest(applied.generation.id))!
    // Built on another generation than the one being restored.
    await reconciler.journal.saveJournal(attention(applied.generation.id + 1, applied.generation.id + 7, manifest))
    await expect(reconciler.reconcileRewound(applied.generation.id, 'root')).rejects.toThrow(`generation ${applied.generation.id + 1} requires operator attention, and the rewound upgrade did not create it: post-action failed`)
    await expect(reconciler.reconcile({ actor: 'root' })).rejects.toThrow(`previous reconciliation of generation ${applied.generation.id + 1} requires operator attention`)
    // Recorded in the restored index, so it is older than the upgrade snapshot.
    const older = await createGeneration(db.db, { checksum: manifest.filesChecksum, actor: 'root' })
    await reconciler.journal.saveJournal(attention(older.id, applied.generation.id, manifest))
    await expect(reconciler.reconcileRewound(applied.generation.id, 'root')).rejects.toThrow(`generation ${older.id} requires operator attention, and the rewound upgrade did not create it`)
    expect((await reconciler.journal.readActiveJournal())?.phase).toBe('needs_attention')
    expect(await db.db.query("SELECT id FROM audit_log WHERE action = 'reconcile.attention_resolved'")).toEqual([])
  })
})
