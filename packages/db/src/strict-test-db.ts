import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, getTestDbTemplate, type TestDbHandle } from './client.ts'
import { initializeOperationalMetadata } from './repos/official-references.ts'

/** Real file-backed policy for privileged-operation diagnostics; never a root authority fixture. */
export const createStrictTestDb = async (opts: { migrate?: boolean } = {}): Promise<TestDbHandle> => {
  const directory = await mkdtemp(join(tmpdir(), 'xpanel-strict-db-'))
  const dbPath = join(directory, 'db.sqlite')
  let template: Awaited<ReturnType<typeof getTestDbTemplate>> | undefined
  if (opts.migrate !== false) {
    template = await getTestDbTemplate()
    await writeFile(dbPath, template.bytes)
  }
  const handle = createDb(dbPath, { durability: 'strict' })
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => closePromise ??= (async () => {
    await handle.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })()
  try {
    const migration = template
      ? { applied: [...template.applied], alreadyApplied: [], unknownApplied: [], version: template.version }
      : { applied: [], alreadyApplied: [], unknownApplied: [], version: 0 }
    if (template) await initializeOperationalMetadata(handle.db)
    return { ...handle, migration, close }
  } catch (error) {
    await close()
    throw error
  }
}
