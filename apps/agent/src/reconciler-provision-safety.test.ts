import { describe, expect, it, vi } from 'vitest'
import type { HostAction } from '@xpanel/core'
import { hasUnverifiedPreActions, runJournaledPreActions, sha256Text, type ReconcileJournalRecord } from './reconciler-journal.ts'

const record = (): ReconcileJournalRecord => ({
  schemaVersion: 1, journalId: 'test-journal', generationId: 1, previousActiveGenerationId: null,
  actor: 'root', stateChecksum: 'state', filesChecksum: 'files', phase: 'test',
  startedAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z',
  candidateManifest: { schemaVersion: 1, generationId: 1, stateChecksum: 'state', filesChecksum: 'files', createdAt: '2026-10-29T00:00:00Z', actor: 'root', files: [], managedUnits: [], testResults: [] },
  previousManifest: null, diff: { added: [], updated: [], unchanged: [], removed: [], removedUnits: [], affectedServices: [] },
  previousFilesBackup: [], completedPreActions: 0, switchedFilePaths: [], removedFilePaths: [],
  stoppedObsoleteUnits: [], completedPostActions: 0, reloadedUnits: [], verifiedUnits: [], error: null,
})
const actions: HostAction[] = [{ kind: 'ensure-dir', path: '/home/tenant', mode: 0o750, owner: 'tenant', group: 'tenant' }]

describe('durable reconciliation prerequisite effects', () => {
  it('persists an action identity before invoking it and preserves the verification requirement after completion', async () => {
    const journal = record()
    const durable: ReconcileJournalRecord[] = []
    const save = async (entry: ReconcileJournalRecord) => { durable.push(structuredClone(entry)) }
    const executor = { runAction: vi.fn(async () => {
      expect(durable.at(-1)?.pendingPreAction).toEqual({ index: 0, kind: 'ensure-dir', sha256: sha256Text(JSON.stringify(actions[0])) })
      expect(durable.at(-1)?.completedPreActions).toBe(0)
    }) }
    await runJournaledPreActions(journal, actions, executor, save, true)
    expect(executor.runAction).toHaveBeenCalledTimes(1)
    expect(durable.at(-1)?.completedPreActions).toBe(1)
    expect(durable.at(-1)?.pendingPreAction).toBeUndefined()
    expect(durable.at(-1)?.preActionPlanSha256).toBe(sha256Text(JSON.stringify(actions)))
    expect(hasUnverifiedPreActions(journal)).toBe(true)
  })

  it('does not invoke the host when the pre-action intent cannot be acknowledged', async () => {
    const executor = { runAction: vi.fn(async () => undefined) }
    await expect(runJournaledPreActions(record(), actions, executor, async () => { throw new Error('intent fsync failed') }, true)).rejects.toThrow('intent fsync failed')
    expect(executor.runAction).not.toHaveBeenCalled()
  })

  it('retains in-flight identity when an action fails after an uncertain host effect', async () => {
    const journal = record()
    const durable: ReconcileJournalRecord[] = []
    await expect(runJournaledPreActions(journal, actions, { runAction: async () => { throw new Error('connection lost after host mutation') } },
      async entry => { durable.push(structuredClone(entry)) }, true)).rejects.toThrow('connection lost')
    expect(durable).toHaveLength(1)
    expect(durable[0]?.pendingPreAction?.index).toBe(0)
    expect(durable[0]?.completedPreActions).toBe(0)
    expect(hasUnverifiedPreActions(durable[0]!)).toBe(true)
  })

  it('leaves a durable in-flight action if the completion acknowledgement fails', async () => {
    const journal = record()
    let durable: ReconcileJournalRecord | undefined
    let writes = 0
    await expect(runJournaledPreActions(journal, actions, { runAction: async () => undefined }, async entry => {
      if (++writes === 2) throw new Error('completion fsync failed')
      durable = structuredClone(entry)
    }, true)).rejects.toThrow('completion fsync failed')
    expect(durable?.pendingPreAction?.index).toBe(0)
    expect(hasUnverifiedPreActions(durable!)).toBe(true)
    expect(hasUnverifiedPreActions(journal)).toBe(true)
  })

  it('distinguishes completed prerequisites from the next uncertain action', async () => {
    const journal = record()
    const pair: HostAction[] = [...actions, { kind: 'systemd-daemon-reload' }]
    const durable: ReconcileJournalRecord[] = []
    await expect(runJournaledPreActions(journal, pair, { runAction: async action => {
      if (action.kind === 'systemd-daemon-reload') throw new Error('interrupted')
    } }, async entry => { durable.push(structuredClone(entry)) }, true)).rejects.toThrow('interrupted')
    expect(durable.at(-1)?.completedPreActions).toBe(1)
    expect(durable.at(-1)?.pendingPreAction).toMatchObject({ index: 1, kind: 'systemd-daemon-reload' })
  })

  it.each(['test', 'activate', 'reload', 'verify', 'needs_attention'] as const)('treats legacy %s journals with completed prerequisites as unverified', phase => {
    const journal = record()
    journal.phase = phase
    expect(hasUnverifiedPreActions(journal)).toBe(false)
    journal.completedPreActions = 1
    expect(hasUnverifiedPreActions(journal)).toBe(true)
  })

  it('does not create native proof or recovery intent for the explicitly modeled executor', async () => {
    const journal = record()
    journal.phase = 'activate'
    const save = vi.fn(async () => undefined)
    await runJournaledPreActions(journal, actions, { runAction: async () => undefined }, save, false)
    expect(journal.completedPreActions).toBe(1)
    expect(save).not.toHaveBeenCalled()
    expect(hasUnverifiedPreActions(journal)).toBe(false)
  })
})
