import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type DbHandle } from './client.ts'
import { loadMigrations, migrate, MIGRATIONS_DIR } from './migrate.ts'
import { isReviewedOperationalMigrationSet, matchesReviewedOperationalMigrations, OPERATIONAL_IDENTITY_MIGRATIONS_JSON, OPERATIONAL_MIGRATION_NAMES, OPERATIONAL_SCHEMA_VERSION } from './schema.ts'
import { getStrictOperationDatabaseOrigin } from './sql-runner.ts'
import { createJob, getDurableJob } from './repos/jobs.ts'
import { completeOperationalMigrations, requireOperationalIdentity } from './repos/official-references.ts'

type Row = { version: number; name: string; checksum: string }
let reviewed: Row[] = []
beforeAll(async () => { reviewed = (await loadMigrations()).map(({ version, name, checksum }) => ({ version, name, checksum })) })

describe('reviewed migration modes', { tags: ['unit'] }, () => {
  it('lists every shipped migration file in OPERATIONAL_MIGRATION_NAMES, in order', async () => {
    expect((await readdir(MIGRATIONS_DIR)).filter(file => file.endsWith('.sql')).sort()).toEqual([...OPERATIONAL_MIGRATION_NAMES])
  })

  it('accepts an exact reviewed prefix only before migration, and the complete set in both modes', () => {
    expect(reviewed.length).toBe(OPERATIONAL_MIGRATION_NAMES.length)
    for (let length = OPERATIONAL_SCHEMA_VERSION; length <= reviewed.length; length++) {
      const applied = reviewed.slice(0, length)
      expect(isReviewedOperationalMigrationSet(applied, 'pre-migration')).toBe(true)
      expect(isReviewedOperationalMigrationSet(applied, 'complete')).toBe(length === reviewed.length)
      expect(matchesReviewedOperationalMigrations(OPERATIONAL_IDENTITY_MIGRATIONS_JSON, applied, 'pre-migration')).toBe(true)
    }
  })

  it('refuses a short, gapped, extra, altered, reordered or widened set in both modes', () => {
    const six = reviewed.slice(0, 6)
    const invalid = [
      reviewed.slice(0, OPERATIONAL_SCHEMA_VERSION - 1),
      six.filter(row => row.version !== 4),
      [...six, { version: 9, name: '0009_unknown.sql', checksum: 'c'.repeat(64) }],
      [...reviewed, { version: reviewed.length + 1, name: 'future.sql', checksum: 'c'.repeat(64) }],
      six.map(row => row.version === 5 ? { ...row, checksum: 'b'.repeat(64) } : row),
      six.map(row => row.version === 6 ? { ...row, name: '0006_renamed.sql' } : row),
      [six[1], six[0], ...six.slice(2)],
      six.map(row => ({ ...row, applied_at: '2026-01-01T00:00:00.000Z' })),
      null, {},
    ]
    for (const applied of invalid) {
      for (const mode of ['pre-migration', 'complete'] as const) {
        expect(isReviewedOperationalMigrationSet(applied, mode)).toBe(false)
        expect(matchesReviewedOperationalMigrations(OPERATIONAL_IDENTITY_MIGRATIONS_JSON, applied, mode)).toBe(false)
      }
    }
    for (const mode of ['prefix', undefined, 'COMPLETE']) expect(isReviewedOperationalMigrationSet(six, mode as never)).toBe(false)
  })

  it('binds an exact applied receipt to the very prefix it was issued for', () => {
    const six = reviewed.slice(0, 6), receipt = JSON.stringify(six)
    expect(matchesReviewedOperationalMigrations(receipt, six, 'pre-migration')).toBe(true)
    expect(matchesReviewedOperationalMigrations(receipt, reviewed.slice(0, 5), 'pre-migration')).toBe(false)
    expect(matchesReviewedOperationalMigrations(receipt, reviewed.slice(0, 7), 'pre-migration')).toBe(false)
    expect(matchesReviewedOperationalMigrations(receipt, reviewed, 'complete')).toBe(false)
    expect(matchesReviewedOperationalMigrations(JSON.stringify(reviewed), reviewed, 'complete')).toBe(true)
    expect(matchesReviewedOperationalMigrations(JSON.stringify(reviewed), six, 'pre-migration')).toBe(false)
    expect(matchesReviewedOperationalMigrations(receipt + ' ', six, 'pre-migration')).toBe(false)
  })
})

// A host on the previous release: 0001-0006 applied from the real files, initialized by that release.
let directory = '', template = '', issuer = ''
const handles: DbHandle[] = []
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xpanel-pre-migration-'))
  template = join(directory, 'host.sqlite'); issuer = randomUUID()
  const host = createDb(template, { durability: 'strict' })
  try {
    await migrate(host.db, { migrations: (await loadMigrations()).slice(0, 6) })
    await host.db.query('INSERT INTO operational_identity(singleton,issuer_id,initialized_at,schema_version,migration_checksums_json,legacy_import_count,legacy_import_sha256) VALUES(1,$1,$2,$3,$4,0,$5)',
      [issuer, new Date().toISOString(), OPERATIONAL_SCHEMA_VERSION, OPERATIONAL_IDENTITY_MIGRATIONS_JSON, createHash('sha256').update('[]').digest('hex')])
    await host.db.query('INSERT INTO reconcile_host_epochs(issuer_id,last_epoch) VALUES($1,0)', [issuer])
  } finally { await host.close() }
})
afterEach(async () => { await Promise.all(handles.splice(0).reverse().map(handle => handle.close())) })
afterAll(async () => { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })
const hostCopy = async (): Promise<string> => { const file = join(directory, randomUUID() + '.sqlite'); await copyFile(template, file); return file }
const open = (file: string, migrations?: 'pre-migration'): DbHandle => {
  const handle = createDb(file, { durability: 'strict', ...(migrations ? { migrations } : {}) }); handles.push(handle); return handle
}
const strictOrigin = (handle: DbHandle) => handle.db.transaction(async tx => getStrictOperationDatabaseOrigin(tx))

describe('previous-release host database before this build migrates it', { tags: ['feature'] }, () => {
  it('passes the pre-migration reads and refuses the complete ones', async () => {
    const file = await hostCopy(), before = open(file, 'pre-migration')
    expect(await strictOrigin(before)).toMatchObject({ issuerId: issuer })
    expect(await requireOperationalIdentity(before.db)).toBe(issuer)
    const job = await createJob(before.db, { kind: 'backup.create', actor: 'root' })
    expect(await getDurableJob(before.db, job.id)).toMatchObject({ id: job.id, referenceCode: job.referenceCode })
    const running = open(file)
    await expect(strictOrigin(running)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(requireOperationalIdentity(running.db)).rejects.toThrow(/differs/)
  })

  it.each([
    ['a wrong checksum', 'UPDATE xpanel_schema_migrations SET checksum=$1 WHERE version=5', ['b'.repeat(64)]],
    ['a gap', 'DELETE FROM xpanel_schema_migrations WHERE version=4', []],
    ['an extra migration', "INSERT INTO xpanel_schema_migrations(version,name,checksum) VALUES(9,'0009_unknown.sql',$1)", ['c'.repeat(64)]],
  ])('refuses a host with %s', async (_label, sql, params) => {
    const file = await hostCopy()
    await open(file).db.query(sql, params)
    const before = open(file, 'pre-migration')
    await expect(strictOrigin(before)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(requireOperationalIdentity(before.db)).rejects.toThrow(/differs/)
  })

  it('refuses an unknown mode before opening the file', () => {
    expect(() => createDb(join(directory, 'never.sqlite'), { durability: 'strict', migrations: 'prefix' as never })).toThrow(/complete or pre-migration/)
  })

  it('does not end the migrate phase while migrations are still pending', async () => {
    const before = open(await hostCopy(), 'pre-migration')
    await expect(completeOperationalMigrations(before.db)).rejects.toThrow(/differs/)
    expect(await requireOperationalIdentity(before.db)).toBe(issuer)
  })
})

// Keep last: completing the migrate phase switches this whole process to the complete set.
describe('after the migrate phase', { tags: ['feature'] }, () => {
  it('applies the pending migrations, then every read requires the complete set', async () => {
    const file = await hostCopy(), upgrade = open(file, 'pre-migration')
    expect((await migrate(upgrade.db)).applied).toEqual(['0007_reseller_oversell.sql', '0008_identity_factors.sql'])
    await completeOperationalMigrations(upgrade.db)
    expect(await strictOrigin(upgrade)).toMatchObject({ issuerId: issuer })
    const running = open(file)
    expect(await strictOrigin(running)).toMatchObject({ issuerId: issuer })
    expect(await requireOperationalIdentity(running.db)).toBe(issuer)
    const stale = open(await hostCopy(), 'pre-migration')
    await expect(strictOrigin(stale)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(requireOperationalIdentity(stale.db)).rejects.toThrow(/differs/)
  })
})
