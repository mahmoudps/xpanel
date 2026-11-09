import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('canary source reader visibility', () => {
  it('reads each active generation inside its own short pinned read-only reader', () => {
    const source = readFileSync(new URL('./account-provisioning-http-source.ts', import.meta.url), 'utf8')
    expect(source.match(/await readActiveGeneration\(options\)/g)).toHaveLength(2)
    expect(source).toContain('options.databaseReader.withReadonlyDatabase(reader => withVisibleReadonlyOperationDatabase(reader, () => latestActive(reader)))')
    // No observation may fall back to the constructor handle or reuse a reader held across the exchange.
    expect(source).not.toContain('.database()')
    expect(source.match(/latestActive\(/g)).toHaveLength(2)
  })

  it('reads the live upgrade observation through fresh readers of one pinned origin', () => {
    const hosted = readFileSync(new URL('./ops-upgrade-hosted-qualification.ts', import.meta.url), 'utf8')
    // Only the closed recovery scope may hold one reader for the whole observation; the live path must not.
    expect(hosted).not.toMatch(/withReadonlyOperationDatabase\(DATABASE, db => collectHostedObservation/)
    // The coordinator of the target release observes before its upgrade migrates the database.
    expect(hosted).toContain("withReobservedReadonlyOperationDatabase(DATABASE, async db => getReadonlyOperationDatabaseOrigin(db), 'pre-migration')")
    expect(hosted).toContain("collectHostedObservation(ownership, request, authority, { origin, fresh: read => withReobservedReadonlyOperationDatabase(DATABASE, read, 'pre-migration') }, false)")
    expect(hosted).toContain("collectHostedObservation(ownership, request, scope, { held: db }, true)")
    expect(hosted).toContain("if (JSON.stringify(getReadonlyOperationDatabaseOrigin(db)) !== JSON.stringify(origin)) return refuse('database_origin_changed')")
    expect(hosted.match(/await read\(db => latestActive\(db\)\)/g)).toHaveLength(2)
    expect(hosted).not.toMatch(/latestActive\(db\)(?!\))/)
  })

  it('composes the pinned reader for the live daemon without holding it across the native exchange', () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
    expect(main).toContain('databaseReader: createProvisioningDatabaseReaderPort(dbPath)')
    // The running agent keeps the complete reviewed set; only the lifecycle canary names the pre-migration mode.
    expect(main).not.toContain("'pre-migration'")
    expect(readFileSync(new URL('./lifecycle/native-runtime.ts', import.meta.url), 'utf8')).toContain("createProvisioningDatabaseReaderPort(DATABASE, 'pre-migration')")
    const http = readFileSync(new URL('./account-provisioning-http.ts', import.meta.url), 'utf8')
    // A reader held while the control API writes job progress is refused (database_wal_generation_changed).
    expect(http).not.toContain('withReadonlyDatabase(')
    expect(http).not.toContain('heldObservationInReaderScope')
    const readerPort = readFileSync(new URL('./account-provisioning-database-reader.ts', import.meta.url), 'utf8')
    expect(readerPort).toContain("(databasePath: string, migrations: OperationalMigrationMode = 'complete')")
    expect(readerPort).toContain('withReobservedReadonlyOperationDatabase(databasePath, work, migrations)')
  })
})
