import { createHash, randomUUID } from 'node:crypto'
import { appendFile, copyFile, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type DbHandle } from './client.ts'
import { loadMigrations, migrate } from './migrate.ts'
import { OPERATIONAL_IDENTITY_MIGRATIONS_JSON, OPERATIONAL_SCHEMA_VERSION } from './schema.ts'
import { getStrictOperationDatabaseOrigin } from './sql-runner.ts'
import { restoreOperationalDatabaseSnapshot } from './snapshot-restore.ts'
import { appendAudit } from './repos/audit.ts'
import { createGeneration } from './repos/generations.ts'
import { createJob, getDurableJob } from './repos/jobs.ts'
import { completeOperationalMigrations } from './repos/official-references.ts'

let directory = '', template = ''
const issuer = randomUUID(), handles: DbHandle[] = []
const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
const applied = (handle: DbHandle) => handle.db.query<{ name: string }>('SELECT name FROM xpanel_schema_migrations ORDER BY version').then(rows => rows.map(row => row.name))
const origin = (handle: DbHandle) => handle.db.transaction(async tx => getStrictOperationDatabaseOrigin(tx))
beforeAll(async () => {
  // A host on the previous release: 0001-0006 applied from the real files and initialized by that release.
  directory = await mkdtemp(join(tmpdir(), 'xpanel-snapshot-restore-'))
  template = join(directory, 'host.sqlite')
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

/** The upgrade connection: snapshot taken the way the native safety takes it, then this build's migrations applied. */
const migratedHost = async (complete = true) => {
  const file = join(directory, randomUUID() + '.sqlite'), snapshot = file + '.control.db'
  await copyFile(template, file)
  const upgrade = createDb(file, { durability: 'strict', migrations: 'pre-migration' }); handles.push(upgrade)
  const before = await createJob(upgrade.db, { kind: 'backup.create', actor: 'root' })
  await upgrade.db.query('VACUUM INTO $1', [snapshot])
  const snapshotSha256 = await sha(snapshot)
  await migrate(upgrade.db)
  if (complete) await completeOperationalMigrations(upgrade.db)
  return { file, snapshot, snapshotSha256, upgrade, before }
}

describe('rollback restores the pre-migration database snapshot', { tags: ['feature'] }, () => {
  it('returns the same file to the snapshot, carries never-rewind values forward and re-admits pre-migration reads', async () => {
    const host = await migratedHost(), inode = (await stat(host.file)).ino
    // Lifecycle writes after the snapshot: an issued reference, an audit event, an epoch and a generation id.
    const after = await createJob(host.upgrade.db, { kind: 'backup.create', actor: 'root' })
    await appendAudit(host.upgrade.db, { actor: 'root', action: 'upgrade.migrated', target: 'xpanel', outcome: 'ok' })
    await host.upgrade.db.query('UPDATE reconcile_host_epochs SET last_epoch=7 WHERE issuer_id=$1', [issuer])
    const generation = await createGeneration(host.upgrade.db, { checksum: 'a'.repeat(64) })

    await restoreOperationalDatabaseSnapshot(host.upgrade.db, { path: host.snapshot, sha256: host.snapshotSha256 })
    expect((await stat(host.file)).ino).toBe(inode)
    expect(await applied(host.upgrade)).toEqual((await loadMigrations()).slice(0, 6).map(row => row.name))
    expect(await origin(host.upgrade)).toMatchObject({ issuerId: issuer })
    const running = createDb(host.file, { durability: 'strict' }); handles.push(running)
    await expect(origin(running)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })

    expect(await getDurableJob(host.upgrade.db, host.before.id)).toMatchObject({ referenceCode: host.before.referenceCode })
    expect(await getDurableJob(host.upgrade.db, after.id)).toBeNull()
    expect(await host.upgrade.db.query('SELECT tombstoned_at FROM official_reference_ledger WHERE entity_id=$1', [after.id])).toEqual([{ tombstoned_at: expect.any(String) }])
    const next = await createJob(host.upgrade.db, { kind: 'backup.create', actor: 'root' })
    expect(next.referenceCode).not.toBe(after.referenceCode)
    expect(next.referenceCode! > after.referenceCode!).toBe(true)
    expect(await host.upgrade.db.query("SELECT action FROM audit_log WHERE action='upgrade.migrated'")).toHaveLength(1)
    expect(await host.upgrade.db.query('SELECT last_epoch FROM reconcile_host_epochs')).toEqual([{ last_epoch: 7 }])
    expect((await createGeneration(host.upgrade.db, { checksum: 'b'.repeat(64) })).id).toBeGreaterThan(generation.id)
    expect((await readdir(directory)).filter(name => name.includes('.restore'))).toEqual([])

    // A repeated restore converges on the same database.
    const repeated = await host.upgrade.db.query('SELECT entity_id,reference_code FROM official_reference_ledger ORDER BY reference_code')
    await restoreOperationalDatabaseSnapshot(host.upgrade.db, { path: host.snapshot, sha256: host.snapshotSha256 })
    expect(await host.upgrade.db.query('SELECT entity_id,reference_code FROM official_reference_ledger ORDER BY reference_code')).toEqual(repeated)
  })

  it.each([
    ['missing', async (host: Awaited<ReturnType<typeof migratedHost>>) => { await rm(host.snapshot) }, 'database_snapshot_missing'],
    ['changed', async (host: Awaited<ReturnType<typeof migratedHost>>) => { await appendFile(host.snapshot, Buffer.from([0])) }, 'database_snapshot_changed'],
  ])('refuses a %s snapshot and leaves the migrated database untouched', async (_what, corrupt, reason) => {
    const host = await migratedHost(false), migrated = await applied(host.upgrade)
    await corrupt(host)
    await expect(restoreOperationalDatabaseSnapshot(host.upgrade.db, { path: host.snapshot, sha256: host.snapshotSha256 }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason, stateChanged: false } })
    expect(await applied(host.upgrade)).toEqual(migrated)
    expect(await origin(host.upgrade)).toMatchObject({ issuerId: issuer })
  })
})
