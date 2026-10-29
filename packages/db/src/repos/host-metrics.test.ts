import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb, type TestDbHandle } from '../client.ts'
import { listMetricsHistory, pruneMetricsHistory, recordHostMetricsSample, recordMetricsSample, type HostMetricsObservation } from './metrics.ts'
import { downsampleHostMetrics } from '../../../../apps/api/src/monitoring-workspace.ts'
const at = '2026-10-27T10:00:00.000Z'
const observation = (values: Partial<HostMetricsObservation> = {}): HostMetricsObservation => ({ load1: 0, load5: null, load15: null, memoryTotalBytes: 8388608, memoryAvailableBytes: 2097152, swapTotalBytes: 0, swapFreeBytes: 0, diskTotalBytes: null, diskUsedBytes: null, diskAvailableBytes: null, cpuPercent: null, processes: null, ...values })
let handle: TestDbHandle | undefined
afterEach(async () => { await handle?.close(); handle = undefined })
describe('host observation persistence and performance projection', () => {
  it('preserves account samples, true zero values and partial availability through SQLite', async () => {
    handle = await createTestDb()
    const account = await recordMetricsSample(handle.db, { scope: 'account', accountId: randomUUID(), at, cpuPercent: 45, memoryMb: 8 })
    const host = await recordHostMetricsSample(handle.db, { at, observation: observation() })
    expect(host?.hostObservation).toEqual(observation()); expect(account.hostObservation).toBeUndefined()
    const history = await listMetricsHistory(handle.db, { scope: 'host' })
    expect(history).toHaveLength(1)
    const chart = downsampleHostMetrics(history, '1h', Date.parse(at), false).points.at(-1)!
    expect(chart.values).toEqual({ cpuPercent: null, memoryMb: { avg: 6, max: 6 }, load1: { avg: 0, max: 0 }, processes: null, diskMb: null })
    expect(await listMetricsHistory(handle.db, { scope: 'account', accountId: account.accountId! })).toEqual([account])
  })
  it('keeps per-metric denominators and empty intervals as gaps', async () => {
    handle = await createTestDb()
    await recordHostMetricsSample(handle.db, { at, observation: observation({ load1: 8 }) })
    await recordHostMetricsSample(handle.db, { at, observation: observation({ load1: null }) })
    const result = downsampleHostMetrics(await listMetricsHistory(handle.db, { scope: 'host' }), '1h', Date.parse(at), false)
    expect(result.points.at(-1)?.values.load1).toEqual({ avg: 8, max: 8 }); expect(result.points[0]?.values.load1).toBeNull()
  })
  it('skips completely unavailable samples and rejects invalid partial measurements', async () => {
    handle = await createTestDb()
    const none = Object.fromEntries(Object.keys(observation()).map(key => [key, null])) as unknown as HostMetricsObservation
    expect(await recordHostMetricsSample(handle.db, { at, observation: none })).toBeNull()
    await expect(recordHostMetricsSample(handle.db, { at, observation: observation({ memoryAvailableBytes: 999999999 }) })).rejects.toThrow()
    expect(await listMetricsHistory(handle.db, { scope: 'host' })).toHaveLength(0)
  })
  it('records host CPU % and process count, and reads rows recorded before those fields as unavailable', async () => {
    handle = await createTestDb()
    await recordHostMetricsSample(handle.db, { at, observation: observation({ cpuPercent: 37.5, processes: 212 }) })
    const legacy = { ...observation() } as Partial<HostMetricsObservation>
    delete legacy.cpuPercent; delete legacy.processes
    await handle.db.query(`INSERT INTO metrics_history (at, scope, host_observation_json) VALUES ($1, 'host', $2)`, [at, JSON.stringify(legacy)])
    const history = await listMetricsHistory(handle.db, { scope: 'host' })
    const pairs = history.map(row => [row.hostObservation?.cpuPercent, row.hostObservation?.processes])
    expect(pairs).toHaveLength(2); expect(pairs).toContainEqual([37.5, 212]); expect(pairs).toContainEqual([null, null])
    const values = downsampleHostMetrics(history, '1h', Date.parse(at), false).points.at(-1)!.values
    expect(values.cpuPercent).toEqual({ avg: 37.5, max: 37.5 }); expect(values.processes).toEqual({ avg: 212, max: 212 })
    await expect(recordHostMetricsSample(handle.db, { at, observation: observation({ cpuPercent: 100.5 }) })).rejects.toThrow()
    await expect(recordHostMetricsSample(handle.db, { at, observation: observation({ processes: 1.5 }) })).rejects.toThrow()
  })
  it('prunes only host samples when scoped', async () => {
    handle = await createTestDb()
    await recordHostMetricsSample(handle.db, { at, observation: observation() })
    await recordMetricsSample(handle.db, { scope: 'account', accountId: randomUUID(), at })
    expect(await pruneMetricsHistory(handle.db, '2026-10-27T10:00:01.000Z', 'host')).toBe(1)
    expect(await listMetricsHistory(handle.db, { scope: 'host' })).toHaveLength(0)
  })
  it('retains historical numeric samples and deletes new observations with the existing retention path', async () => {
    handle = await createTestDb()
    const legacy = await recordMetricsSample(handle.db, { scope: 'host', at, cpuPercent: 7 })
    expect(legacy.hostObservation).toBeUndefined()
    expect(downsampleHostMetrics([legacy], '1h', Date.parse(at), false).points.at(-1)?.values.cpuPercent?.avg).toBe(7)
    await recordHostMetricsSample(handle.db, { at, observation: observation() })
    expect(await pruneMetricsHistory(handle.db, '2026-10-27T10:00:01.000Z')).toBe(2)
  })
})
import { createHash } from 'node:crypto'
import { createDb } from '../client.ts'
import { loadMigrations, migrate } from '../migrate.ts'
import { initializeOperationalMetadata, requireOperationalIdentity } from './official-references.ts'

describe('additive host migration preserves immutable operational identity', () => {
  it('upgrades an existing schema3 database without changing issuer, issued references or counters', async () => {
    const db = createDb(':memory:')
    try {
      const migrations = await loadMigrations(), oldMigrations = migrations.slice(0, 3)
      await migrate(db.runner, { migrations: oldMigrations })
      const issuer = randomUUID(), job = randomUUID(), reference = 'XP-JOB-2026-000009'
      const receipt = JSON.stringify(oldMigrations.map(({ version, name, checksum }) => ({ version, name, checksum })))
      await db.db.query('INSERT INTO operational_identity(singleton,issuer_id,initialized_at,schema_version,migration_checksums_json,legacy_import_count,legacy_import_sha256) VALUES(1,$1,$2,3,$3,0,$4)', [issuer, at, receipt, createHash('sha256').update('[]').digest('hex')])
      await db.db.query("INSERT INTO jobs(id,kind,actor) VALUES($1,'backup.create','root')", [job])
      await db.db.query("INSERT INTO official_reference_counters(issuer_id,kind,issued_year,last_sequence) VALUES($1,'job',2026,9)", [issuer])
      await db.db.query("INSERT INTO official_reference_ledger(issuer_id,kind,entity_id,reference_code,issued_year,sequence,origin,publication_state,created_at,issued_at) VALUES($1,'job',$2,$3,2026,9,'legacy','issued',$4,$4)", [issuer, job, reference, at])
      const tables = ['operational_identity', 'official_reference_counters', 'official_reference_ledger', 'jobs']
      const before = await Promise.all(tables.map(table => db.db.query(`SELECT * FROM ${table}`)))
      await migrate(db.runner)
      expect(await initializeOperationalMetadata(db.db)).toEqual({ issuerId: issuer, imported: 0 })
      expect(await requireOperationalIdentity(db.db)).toBe(issuer)
      expect(await Promise.all(tables.map(table => db.db.query(`SELECT * FROM ${table}`)))).toEqual(before)
      await expect(db.db.query('UPDATE operational_identity SET migration_checksums_json=$1 WHERE singleton=1', ['[]'])).rejects.toThrow(/immutable/)
      await expect(db.db.query('DELETE FROM operational_identity')).rejects.toThrow(/permanent/)
      await initializeOperationalMetadata(db.db)
      expect(await Promise.all(tables.map(table => db.db.query(`SELECT * FROM ${table}`)))).toEqual(before)
    } finally { await db.close() }
  })
  it('refuses unknown and tampered additive migration evidence with the unchanged schema3 receipt', async () => {
    handle = await createTestDb()
    const before = await handle.db.query('SELECT * FROM operational_identity')
    await handle.db.query("INSERT INTO xpanel_schema_migrations(version,name,checksum) VALUES(7,'0007_unknown.sql',$1)", ['a'.repeat(64)])
    await expect(requireOperationalIdentity(handle.db)).rejects.toThrow(/differs/)
    await expect(initializeOperationalMetadata(handle.db)).rejects.toThrow(/require review/)
    await handle.db.query('DELETE FROM xpanel_schema_migrations WHERE version=5')
    await handle.db.query('UPDATE xpanel_schema_migrations SET checksum=$1 WHERE version=4', ['b'.repeat(64)])
    await expect(requireOperationalIdentity(handle.db)).rejects.toThrow(/differs/)
    await expect(initializeOperationalMetadata(handle.db)).rejects.toThrow(/require review/)
    expect(await handle.db.query('SELECT * FROM operational_identity')).toEqual(before)
  })
})
