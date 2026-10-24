import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReconcilerJournal, type GenerationManifest, type ReconcileJournalRecord } from './reconciler-journal.ts'

const boundary = vi.hoisted(() => ({ directories: [] as string[], events: [] as string[], renames: 0, failAtRename: 0, failAfterRemoval: false, removed: false }))
// File writes, file fsync, rename and removal use actual temporary files. Only
// directory descriptors are modeled; this is not power-loss qualification.
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const normalize = (path: unknown) => String(path).replace(/\\/g, '/')
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (args[1] === 'r' && boundary.directories.includes(normalize(args[0]))) {
        return {
          sync: async () => {
            boundary.events.push('directory-sync')
            if ((boundary.failAtRename > 0 && boundary.renames >= boundary.failAtRename) || (boundary.failAfterRemoval && boundary.removed)) {
              throw Object.assign(new Error('injected journal directory I/O failure'), { code: 'EIO' })
            }
          },
          close: async () => { boundary.events.push('directory-close') },
        }
      }
      return fs.open(...args)
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args)
      boundary.renames++
      boundary.events.push(`rename:${normalize(args[1]).split('/').at(-1)}`)
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      await fs.rm(...args)
      if (normalize(args[0]).endsWith('/active-journal.json')) {
        boundary.removed = true
        boundary.events.push('remove-active')
      }
    },
  }
})

let root: string
let journal: ReconcilerJournal
const manifest = (): GenerationManifest => ({ schemaVersion: 1, generationId: 1, stateChecksum: 'state', filesChecksum: 'files', createdAt: new Date().toISOString(), actor: 'root', files: [], managedUnits: [], testResults: [] })
const record = (phase: ReconcileJournalRecord['phase']): ReconcileJournalRecord => ({
  schemaVersion: 1, journalId: 'journal', generationId: 1, previousActiveGenerationId: null,
  actor: 'root', stateChecksum: 'state', filesChecksum: 'files', phase,
  startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  candidateManifest: manifest(), previousManifest: null,
  diff: { added: [], updated: [], unchanged: [], removed: [], removedUnits: [], affectedServices: [] },
  previousFilesBackup: [], completedPreActions: 0, switchedFilePaths: [], removedFilePaths: [],
  stoppedObsoleteUnits: [], completedPostActions: 0, reloadedUnits: [], verifiedUnits: [], error: null,
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'xpanel-journal-durability-'))
  journal = new ReconcilerJournal(root)
  boundary.directories = [join(root, 'generations', 'journal'), join(root, 'generations', 'manifests')].map(path => path.replace(/\\/g, '/'))
  boundary.events = []; boundary.renames = 0; boundary.failAtRename = 0; boundary.failAfterRemoval = false; boundary.removed = false
})
afterEach(async () => {
  boundary.directories = []; boundary.failAtRename = 0; boundary.failAfterRemoval = false
  await rm(root, { recursive: true, force: true })
})

describe('reconciler journal directory durability acknowledgement', () => {
  it('rejects an uncertain manifest publication even though renamed bytes are readable', async () => {
    boundary.failAtRename = 1
    await expect(journal.writeManifest(manifest())).rejects.toMatchObject({ code: 'STATE_DIRECTORY_DURABILITY', phase: 'sync', cause: { code: 'EIO' } })
    expect(boundary.renames).toBe(1)
    expect((await journal.readManifest(1))?.filesChecksum).toBe('files')
    expect(boundary.events.at(-1)).toBe('directory-close')
  })

  it('rejects an uncertain active journal publication after the history entry was synced', async () => {
    boundary.failAtRename = 2
    await expect(journal.saveJournal(record('stage'))).rejects.toMatchObject({ code: 'STATE_DIRECTORY_DURABILITY', cause: { code: 'EIO' } })
    expect((await journal.readActiveJournal())?.phase).toBe('stage')
    expect(boundary.events.filter(event => event === 'directory-sync')).toHaveLength(2)
  })

  it('does not report terminal success when removal of the active entry cannot be synced', async () => {
    await journal.saveJournal(record('stage'))
    boundary.failAfterRemoval = true
    await expect(journal.saveJournal(record('committed'))).rejects.toMatchObject({ code: 'STATE_DIRECTORY_DURABILITY', cause: { code: 'EIO' } })
    expect(boundary.removed).toBe(true)
    expect(await journal.readActiveJournal()).toBeNull()
    expect((await journal.readGenerationJournal(1))?.phase).toBe('committed')
  })

  it('syncs each published entry and terminal removal before resolving', async () => {
    await journal.saveJournal(record('stage'))
    await journal.saveJournal(record('committed'))
    expect(boundary.events).toEqual([
      'rename:gen-1.json', 'directory-sync', 'directory-close',
      'rename:active-journal.json', 'directory-sync', 'directory-close',
      'rename:gen-1.json', 'directory-sync', 'directory-close',
      'remove-active', 'directory-sync', 'directory-close',
    ])
    await expect(readFile(join(root, 'generations', 'journal', 'active-journal.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
