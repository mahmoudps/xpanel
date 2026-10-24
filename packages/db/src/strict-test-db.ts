import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, type TestDbHandle } from './client.ts'
import { migrate } from './migrate.ts'
import { initializeOperationalMetadata } from './repos/official-references.ts'

/** Real file-backed policy for privileged-operation diagnostics; never a root authority fixture. */
export const createStrictTestDb = async (opts: { migrate?: boolean } = {}): Promise<TestDbHandle> => {
  const directory = await mkdtemp(join(tmpdir(), 'xpanel-strict-db-'))
  const handle = createDb(join(directory, 'db.sqlite'), { durability: 'strict' })
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => closePromise ??= (async () => {
    await handle.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })()
  try {
    const migration = opts.migrate === false
      ? { applied: [], alreadyApplied: [], unknownApplied: [], version: 0 }
      : await migrate(handle.db)
    if (opts.migrate !== false) await initializeOperationalMetadata(handle.db)
    return { ...handle, migration, close }
  } catch (error) {
    await close()
    throw error
  }
}
