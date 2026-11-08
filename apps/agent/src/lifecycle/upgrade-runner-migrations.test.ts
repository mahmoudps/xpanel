import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, getStrictOperationDatabaseOrigin, loadMigrations, migrate, OPERATIONAL_IDENTITY_MIGRATIONS_JSON, OPERATIONAL_SCHEMA_VERSION, requireOperationalIdentity, type DbHandle } from '@xpanel/db'
import { createProductionUpgradePorts, type ProductionUpgradeDependencies } from './upgrade-runner.ts'

let directory = '', template = ''
const issuer = randomUUID(), handles: DbHandle[] = []
beforeAll(async () => {
  // A host on the previous release: 0001-0006 applied from the real files and initialized by that release.
  directory = await mkdtemp(join(tmpdir(), 'xpanel-upgrade-migrator-'))
  template = join(directory, 'host.sqlite')
  const host = createDb(template, { durability: 'strict' })
  try {
    await migrate(host.db, { migrations: (await loadMigrations()).slice(0, 6) })
    await host.db.query('INSERT INTO operational_identity(singleton,issuer_id,initialized_at,schema_version,migration_checksums_json,legacy_import_count,legacy_import_sha256) VALUES(1,$1,$2,$3,$4,0,$5)',
      [issuer, new Date().toISOString(), OPERATIONAL_SCHEMA_VERSION, OPERATIONAL_IDENTITY_MIGRATIONS_JSON, createHash('sha256').update('[]').digest('hex')])
  } finally { await host.close() }
})
afterAll(async () => {
  await Promise.all(handles.map(handle => handle.close()))
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
const preMigration = async (): Promise<DbHandle> => {
  const file = join(directory, randomUUID() + '.sqlite')
  await copyFile(template, file)
  const handle = createDb(file, { durability: 'strict', migrations: 'pre-migration' }); handles.push(handle); return handle
}
const origin = (handle: DbHandle) => handle.db.transaction(async tx => getStrictOperationDatabaseOrigin(tx))

describe('production upgrade migrator', { tags: ['feature'] }, () => {
  it('applies the pending reviewed migrations, then every read of the process requires the complete set', async () => {
    const upgrade = await preMigration()
    const { migrator } = createProductionUpgradePorts({ db: upgrade.db, fs: {}, host: {}, clock: {}, reconciler: {},
      loadReleaseMigrations: () => loadMigrations() } as unknown as ProductionUpgradeDependencies)
    expect((await migrator.pending('/opt/xpanel/releases/next')).map(row => row.name)).toEqual(['0007_reseller_oversell.sql', '0008_identity_factors.sql'])
    expect(await origin(upgrade)).toMatchObject({ issuerId: issuer })
    expect(await migrator.apply('/opt/xpanel/releases/next')).toEqual({ applied: ['0007_reseller_oversell.sql', '0008_identity_factors.sql'], version: 8 })
    expect(await migrator.pending('/opt/xpanel/releases/next')).toEqual([])
    expect(await origin(upgrade)).toMatchObject({ issuerId: issuer })
    expect(await requireOperationalIdentity(upgrade.db)).toBe(issuer)
    const stale = await preMigration()
    await expect(origin(stale)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
