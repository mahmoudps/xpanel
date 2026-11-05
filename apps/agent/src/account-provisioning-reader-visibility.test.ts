import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('canary source reader visibility', () => {
  it('reads each active generation inside its own short pinned read-only reader', () => {
    const source = readFileSync(new URL('./account-provisioning-http-source.ts', import.meta.url), 'utf8')
    expect(source.match(/await readActiveGeneration\(options\)/g)).toHaveLength(2)
    expect(source).toContain('options.databaseReader.withReadonlyDatabase(reader => withVisibleReadonlyOperationDatabase(reader, () => latestActive(reader as unknown as Db)))')
    // No observation may fall back to the constructor handle or reuse a reader held across the exchange.
    expect(source).not.toContain('.database()')
    expect(source.match(/latestActive\(/g)).toHaveLength(2)
  })

  it('composes the pinned reader for the live daemon without holding it across the native exchange', () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
    expect(main).toContain('databaseReader: createProvisioningDatabaseReaderPort(dbPath)')
    const http = readFileSync(new URL('./account-provisioning-http.ts', import.meta.url), 'utf8')
    // A reader held while the control API writes job progress is refused (database_wal_generation_changed).
    expect(http).not.toContain('withReadonlyDatabase(')
    expect(http).not.toContain('heldObservationInReaderScope')
    const readerPort = readFileSync(new URL('./account-provisioning-database-reader.ts', import.meta.url), 'utf8')
    expect(readerPort).toContain('withReobservedReadonlyOperationDatabase(databasePath, work)')
  })
})
