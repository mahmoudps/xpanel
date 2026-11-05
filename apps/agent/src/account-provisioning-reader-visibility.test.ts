import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('canary source reader visibility', () => {
  it('reads the active generation inside the same live read-only reader', () => {
    const source = readFileSync(new URL('./account-provisioning-http-source.ts', import.meta.url), 'utf8')
    const uses = source.match(/withVisibleReadonlyOperationDatabase\(reader, \(\) => latestActive\(reader\)\)/g)
    expect(uses).toHaveLength(2)
    expect(source).not.toMatch(/(?<!withVisibleReadonlyOperationDatabase\(reader, \(\) => )latestActive\(reader\)/)
    // No observation may fall back to the constructor handle when the live reader port is present.
    expect(source).toContain('options.databaseReader?.database() ?? options.db')
  })

  it('composes the pinned read-only reader for the live daemon and every held-request callback', () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
    expect(main).toContain('databaseReader: createProvisioningDatabaseReaderPort(dbPath)')
    const http = readFileSync(new URL('./account-provisioning-http.ts', import.meta.url), 'utf8')
    expect(http).toContain("reader.withReadonlyDatabase(async () => work())")
    expect(http).toContain('heldObservationInReaderScope(reader, held)')
    // The pinned reader is reobserved on WAL collisions; a single attempt refused during live writes.
    const readerPort = readFileSync(new URL('./account-provisioning-database-reader.ts', import.meta.url), 'utf8')
    expect(readerPort).toContain('withReobservedReadonlyOperationDatabase')
  })
})
