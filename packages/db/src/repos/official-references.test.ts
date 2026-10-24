import { createStrictTestDb } from '../strict-test-db.ts'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { createDb, type Db, type DbHandle } from '../client.ts'
import { loadMigrations, migrate } from '../migrate.ts'
import { getStrictOperationDatabaseOrigin } from '../sql-runner.ts'
import { createJob, enqueueDurableJob, getDurableJob, getJob, listJobs, acquireJobLease } from './jobs.ts'
import { confirmLegacyJobReferenceRepair, initializeOperationalMetadata, reserveLegacyJobReferenceRepair, reserveOfficialJobReferenceTx } from './official-references.ts'

const handles: DbHandle[] = []
afterEach(async () => { await Promise.all(handles.splice(0).reverse().map(h => h.close())) })
const fresh = async () => { const h = await createStrictTestDb(); handles.push(h); return h }
const addLegacy = async (h: DbHandle, id = randomUUID()) => {
  await h.db.query("INSERT INTO jobs(id,kind,actor,created_at,updated_at) VALUES($1,'backup.create','root','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')", [id])
  return id
}
const issuedAt = async (h: DbHandle, date: string) => h.db.transaction(async tx => {
  const id = randomUUID()
  const reference = await reserveOfficialJobReferenceTx(tx, { jobId: id, at: new Date(date) })
  await tx.query("INSERT INTO jobs(id,kind,actor) VALUES($1,'backup.create','root')", [id])
  return { id, reference }
})

describe('permanent official reference ledger and explicit operational initialization', () => {
  it('rejects a structural acknowledgement provider before invoking its transaction accessor', async () => {
    let invoked = 0
    const fake = Object.defineProperty({}, 'transaction', { get() { invoked++; return () => Promise.resolve({ referenceCode: 'XP-JOB-2026-000001' }) } }) as Db
    const id = randomUUID()
    const calls = [
      () => initializeOperationalMetadata(fake),
      () => enqueueDurableJob(fake, { kind: 'backup.create', actor: 'root' }),
      () => reserveLegacyJobReferenceRepair(fake, { jobId: id, requestKey: 'fake-provider', principalId: randomUUID(), reason: 'Reviewed metadata' }),
      () => confirmLegacyJobReferenceRepair(fake, id, {}),
    ]
    for (const call of calls) await expect(call()).rejects.toThrow('a registered public database runner is required')
    expect(invoked).toBe(0)
  })

  it('requires explicit initialization and never writes initialization on a read', async () => {
    const h = await createStrictTestDb({ migrate: false }); handles.push(h)
    await migrate(h.db)
    await expect(getJob(h.db, randomUUID())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await h.db.query('SELECT * FROM operational_identity')).toEqual([])
    await initializeOperationalMetadata(h.db)
    expect(await getJob(h.db, randomUUID())).toBeNull()
    expect(await initializeOperationalMetadata(h.db)).toMatchObject({ imported: 0 })
  })

  it('adds mailbox and operational migrations to an applied-0001 schema lacking the former lazy table without rewriting its checksum', async () => {
    const h = await createStrictTestDb({ migrate: false }); handles.push(h)
    const migrations = await loadMigrations()
    await migrate(h.db, { migrations: [migrations[0]!] })
    const old = await h.db.query('SELECT * FROM xpanel_schema_migrations')
    const id = await addLegacy(h)
    await migrate(h.db)
    await initializeOperationalMetadata(h.db)
    expect((await h.db.query('SELECT * FROM xpanel_schema_migrations WHERE version=1'))[0]).toEqual(old[0])
    expect((await getDurableJob(h.db, id))?.referenceCode).toBeNull()
    expect(await h.db.query('SELECT * FROM official_reference_counters')).toEqual([])
  })

  it('imports persisted historical official strings byte-for-byte and seeds canonical year high-water', async () => {
    const h = await createStrictTestDb({ migrate: false }); handles.push(h)
    const migrations = await loadMigrations()
    await migrate(h.db, { migrations: [migrations[0]!] })
    const ddl = migrations[2]!.sql.match(/CREATE TABLE IF NOT EXISTS job_runtime_leases\s*\([\s\S]*?\) STRICT;/)![0]
    await h.db.exec(ddl)
    const refs = ['XP-JOB-000007', 'ARCHIVE/2021-009', 'XP-JOB-2026-000042', 'XP-JOB-000000']
    const ids: string[] = []
    for (const reference of refs) {
      const id = await addLegacy(h); ids.push(id)
      await h.db.query('INSERT INTO job_runtime_leases(job_id,reference_code,updated_at) VALUES($1,$2,$3)', [id, reference, '2020-01-01T00:00:00.000Z'])
    }
    await migrate(h.db)
    expect((await initializeOperationalMetadata(h.db)).imported).toBe(3)
    for (let i = 0; i < 3; i++) expect((await getJob(h.db, ids[i]!))?.referenceCode).toBe(refs[i])
    expect((await getJob(h.db, ids[3]!))?.referenceCode).toBeNull()
    expect((await issuedAt(h, '2026-10-23T00:00:00.000Z')).reference).toBe('XP-JOB-2026-000043')
    expect((await h.db.query<{ reference_code: string }>('SELECT reference_code FROM job_runtime_leases WHERE job_id=$1', [ids[3]]))[0]?.reference_code).toBe('XP-JOB-000000')
    expect(await initializeOperationalMetadata(h.db)).toMatchObject({ imported: 0 })
  })

  it('refuses a changed pre-existing lazy schema rather than treating IF NOT EXISTS as compatibility proof', async () => {
    const h = await createStrictTestDb({ migrate: false }); handles.push(h)
    const migrations = await loadMigrations()
    await migrate(h.db, { migrations: [migrations[0]!] })
    const ddl = migrations[2]!.sql.match(/CREATE TABLE IF NOT EXISTS job_runtime_leases\s*\([\s\S]*?\) STRICT;/)![0]
    await h.db.exec(ddl.replace('max_attempts >= 1', 'max_attempts >= 0'))
    await migrate(h.db)
    await expect(initializeOperationalMetadata(h.db)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await h.db.query('SELECT * FROM operational_identity')).toEqual([])
  })

  it.each([['literal case', "'retryable'", "'Retryable'"], ['literal whitespace', "'unknown_outcome'", "'unknown_ outcome'"]])('refuses %s drift without normalizing string contents', async (_name, oldLiteral, changedLiteral) => {
    const h = await createStrictTestDb({ migrate: false }); handles.push(h)
    const migrations = await loadMigrations()
    await migrate(h.db, { migrations: [migrations[0]!] })
    const ddl = migrations[2]!.sql.match(/CREATE TABLE IF NOT EXISTS job_runtime_leases\s*\([\s\S]*?\) STRICT;/)![0]
    await h.db.exec(ddl.replace(oldLiteral!, changedLiteral!))
    await migrate(h.db)
    await expect(initializeOperationalMetadata(h.db)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await h.db.query('SELECT * FROM operational_identity')).toEqual([])
  })

  it('refuses an unknown future migration in startup, reads and genuine operation origin admission', async () => {
    const h = await fresh()
    await h.db.query('INSERT INTO xpanel_schema_migrations(version,name,checksum,applied_at) VALUES(4,$1,$2,$3)', ['0004_future.sql', 'f'.repeat(64), new Date().toISOString()])
    await expect(initializeOperationalMetadata(h.db)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(getJob(h.db, randomUUID())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(h.db.transaction(async tx => getStrictOperationDatabaseOrigin(tx))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('keeps reads and rejected legacy claims free of numbering and schema writes', async () => {
    const h = await fresh(); const id = await addLegacy(h)
    const before = await h.db.query('SELECT name,sql FROM sqlite_master ORDER BY name')
    for (let i = 0; i < 25; i++) {
      expect((await getJob(h.db, id))?.referenceCode).toBeNull()
      expect((await getDurableJob(h.db, id))?.referenceCode).toBeNull()
      expect((await listJobs(h.db))[0]?.referenceCode).toBeNull()
    }
    await expect(acquireJobLease(h.db, { jobId: id, workerId: 'worker' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await acquireJobLease(h.db, { workerId: 'worker' })).toBeNull()
    expect(await h.db.query('SELECT * FROM official_reference_ledger')).toEqual([])
    expect(await h.db.query('SELECT * FROM official_reference_counters')).toEqual([])
    expect(await h.db.query('SELECT name,sql FROM sqlite_master ORDER BY name')).toEqual(before)
  })

  it('rolls back uncommitted allocations and retains issued tombstones against deletion and ID reuse', async () => {
    const h = await fresh()
    await expect(h.db.transaction(async tx => { await reserveOfficialJobReferenceTx(tx, { jobId: randomUUID(), at: new Date() }); throw new Error('abort') })).rejects.toThrow('abort')
    expect(await h.db.query('SELECT * FROM official_reference_ledger')).toHaveLength(0)
    expect(await h.db.query('SELECT * FROM official_reference_counters')).toHaveLength(0)
    const first = await createJob(h.db, { kind: 'backup.create', actor: 'root' })
    await h.db.query('DELETE FROM jobs WHERE id=$1', [first.id])
    await expect(createJob(h.db, { id: first.id, kind: 'backup.create', actor: 'root' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await createJob(h.db, { kind: 'backup.create', actor: 'root' })).referenceCode).not.toBe(first.referenceCode)
    await expect(h.db.query('DELETE FROM official_reference_ledger')).rejects.toThrow(/permanent/)
    await expect(h.db.query('DELETE FROM official_reference_counters')).rejects.toThrow(/permanent/)
    await expect(h.db.query('UPDATE official_reference_counters SET last_sequence=0')).rejects.toThrow(/rewind/)
    await expect(h.db.query("UPDATE official_reference_ledger SET reference_code='different'")).rejects.toThrow(/immutable/)
    await expect(h.db.query("INSERT OR REPLACE INTO official_reference_counters SELECT * FROM official_reference_counters")).rejects.toThrow(/already exists/)
    await expect(h.db.query('DELETE FROM operational_identity')).rejects.toThrow(/permanent/)
    await expect(h.db.query('INSERT OR REPLACE INTO operational_identity SELECT * FROM operational_identity')).rejects.toThrow(/already exists/)
  })

  it('handles UTC year rollover, clock rollback and exhaustion without wrapping', async () => {
    const h = await fresh()
    expect((await issuedAt(h, '2026-12-31T23:59:59.999Z')).reference).toBe('XP-JOB-2026-000001')
    expect((await issuedAt(h, '2027-01-01T00:00:00.000Z')).reference).toBe('XP-JOB-2027-000001')
    expect((await issuedAt(h, '2026-12-31T23:59:58.000Z')).reference).toBe('XP-JOB-2026-000002')
    await h.db.query('UPDATE official_reference_counters SET last_sequence=9007199254740990 WHERE issued_year=2026')
    expect((await issuedAt(h, '2026-10-01T00:00:00.000Z')).reference).toBe('XP-JOB-2026-9007199254740991')
    const before = await h.db.query('SELECT * FROM official_reference_ledger')
    await expect(issuedAt(h, '2026-10-01T00:00:00.000Z')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(await h.db.query('SELECT * FROM official_reference_ledger')).toEqual(before)
  })

  it('keeps normal generic issuance available while privileged acknowledgements require an actual strict connection', async () => {
    const h = await fresh()
    const file = (await h.db.query<{ file: string; name: string }>('PRAGMA database_list')).find(row => row.name === 'main')!.file
    const normal = createDb(file); handles.push(normal)
    expect(await getJob(normal.db, randomUUID())).toBeNull()
    const normalJob = await createJob(normal.db, { kind: 'backup.create', actor: 'root' })
    expect(normalJob.referenceCode).toMatch(/^XP-JOB-[0-9]{4}-[0-9]{6,16}$/)
    await expect(reserveLegacyJobReferenceRepair(normal.db, { jobId: randomUUID(), requestKey: 'normal-repair', principalId: randomUUID(), reason: 'Reviewed repair' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(reserveOfficialJobReferenceTx(h.db, { jobId: randomUUID(), at: new Date() })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const memory = createDb(':memory:'); handles.push(memory)
    await migrate(memory.db)
    await initializeOperationalMetadata(memory.db)
    expect((await createJob(memory.db, { kind: 'backup.create', actor: 'root' })).referenceCode).toMatch(/^XP-JOB-/)
    await expect(memory.db.transaction(async tx => getStrictOperationDatabaseOrigin(tx))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    h.sqlite.exec('PRAGMA synchronous=NORMAL')
    await expect(createJob(h.db, { kind: 'backup.create', actor: 'root' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('serializes allocator writes across independently opened connections and preserves retry identity', async () => {
    const h = await fresh()
    const file = (await h.db.query<{ file: string; name: string }>('PRAGMA database_list')).find(row => row.name === 'main')!.file
    const second = createDb(file, { durability: 'strict' }); handles.push(second)
    const jobs = await Promise.all(Array.from({ length: 20 }, (_, i) => createJob(i % 2 ? h.db : second.db, { kind: 'backup.create', actor: 'root' })))
    expect(new Set(jobs.map(j => j.referenceCode)).size).toBe(20)
    const first = await enqueueDurableJob(h.db, { kind: 'backup.create', actor: 'root', idempotencyKey: 'ack-unknown' })
    const replay = await enqueueDurableJob(second.db, { kind: 'backup.create', actor: 'root', idempotencyKey: 'ack-unknown' })
    expect(replay.id).toBe(first.id)
    expect(replay.referenceCode).toBe(first.referenceCode)
  })

  it('serializes permanent issuance across independent Node processes', async () => {
    const h = await fresh()
    const file = (await h.db.query<{ file: string; name: string }>('PRAGMA database_list')).find(row => row.name === 'main')!.file
    const source = `import {createDb} from ${JSON.stringify(new URL('../client.ts', import.meta.url).href)};import {createJob} from ${JSON.stringify(new URL('./jobs.ts', import.meta.url).href)};const h=createDb(process.argv[1],{durability:'strict'});const refs=[];for(let i=0;i<12;i++)refs.push((await createJob(h.db,{kind:'backup.create',actor:'root'})).referenceCode);await h.close();console.log(JSON.stringify(refs));`
    const run = () => new Promise<string[]>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, file], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } })
      let out = ''; let err = ''
      child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { err += chunk })
      child.once('error', reject); child.once('close', code => code === 0 ? resolve(JSON.parse(out.trim()) as string[]) : reject(new Error(`child failed: ${code}: ${err}`)))
    })
    const refs = (await Promise.all([run(), run()])).flat()
    expect(refs).toHaveLength(24)
    expect(new Set(refs).size).toBe(24)
  })

  it('reserves repair metadata idempotently without issuing or executing it, and rejects forged confirmation', async () => {
    const h = await fresh(); const id = await addLegacy(h); const principal = randomUUID()
    const input = { jobId: id, requestKey: 'legacy-repair-1', principalId: principal, reason: 'Reviewed unissued legacy job' }
    const first = await reserveLegacyJobReferenceRepair(h.db, input)
    expect(first.state).toBe('awaiting_intent'); expect(first.reference).toBeNull()
    expect(await reserveLegacyJobReferenceRepair(h.db, input)).toEqual(first)
    expect((await getJob(h.db, id))?.referenceCode).toBeNull()
    expect(await h.db.query('SELECT * FROM job_runtime_leases WHERE job_id=$1', [id])).toHaveLength(0)
    await expect(confirmLegacyJobReferenceRepair(h.db, first.repairId!, { durable: true, eventUid: randomUUID(), entryHash: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(reserveLegacyJobReferenceRepair(h.db, { ...input, reason: 'Different reviewed request' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await h.db.query('SELECT * FROM official_reference_ledger')).toHaveLength(1)
  })

  it('never rewrites an already issued official number through repair', async () => {
    const h = await fresh(); const job = await createJob(h.db, { kind: 'backup.create', actor: 'root' })
    const result = await reserveLegacyJobReferenceRepair(h.db, { jobId: job.id, requestKey: 'already-official', principalId: randomUUID(), reason: 'Check numbering' })
    expect(result).toMatchObject({ state: 'already_issued', reference: job.referenceCode, repairId: null, intentBinding: null })
    expect(await h.db.query('SELECT * FROM legacy_reference_repairs')).toHaveLength(0)
  })
})
