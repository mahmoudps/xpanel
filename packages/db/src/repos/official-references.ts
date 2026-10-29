import { createHash, randomUUID } from 'node:crypto'
import { assertId, assertLine, fail } from '@xpanel/core'
import type { Db } from '../client.ts'
import { loadMigrations } from '../migrate.ts'
import { assertDatabaseTransaction, assertNoActiveDatabaseTransaction, assertRegisteredDatabaseRunner, assertStrictDurableTransaction } from '../sql-runner.ts'
import { lexSql } from '../sql-lexer.ts'
import { isReviewedOperationalMigrationSet, matchesReviewedOperationalMigrations, OPERATIONAL_IDENTITY_MIGRATIONS_JSON, OPERATIONAL_SCHEMA_VERSION } from '../schema.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'
import { assertOperationIntentReceipt } from './operation-audit-authority.ts'

interface IdentityRow extends Record<string, unknown> { issuer_id: string; schema_version: number; migration_checksums_json: string }
interface ReferenceRow extends Record<string, unknown> {
  reference_code: string
  publication_state: 'reserved' | 'issued' | 'abandoned'
  tombstoned_at: string | null
}

const normalizedSql = (sql: string): string => lexSql(sql).filter(segment => segment.kind !== 'comment').map(segment => segment.kind === 'code'
  ? segment.text.replace(/\bIF\s+NOT\s+EXISTS\b/gi, '').replace(/\s+/g, '').toLowerCase() : segment.text).join('').replace(/;$/, '')
const appliedMigrations = (db: Db) => db.query<{ version: number; name: string; checksum: string }>('SELECT version,name,checksum FROM xpanel_schema_migrations ORDER BY version')
const canonicalReference = /^XP-JOB-([0-9]{4})-([0-9]{6,16})$/

const parsedSequence = (reference: string): { year: number; sequence: number } | null => {
  const match = canonicalReference.exec(reference)
  if (!match) return null
  const year = Number(match[1])
  const sequence = Number(match[2])
  if (year < 1 || !Number.isSafeInteger(sequence) || sequence < 1 || String(sequence).padStart(6, '0') !== match[2]) return null
  return { year, sequence }
}

const legacyReviewReason = (reference: string): 'unissued_sentinel' | 'internal_id' | 'unsafe_reference' | null => {
  if (reference === 'XP-JOB-000000') return 'unissued_sentinel'
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference)) return 'internal_id'
  if (reference.length < 1 || reference.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/.test(reference)) return 'unsafe_reference'
  return null
}

/** An explicit post-migration, pre-listener write. Never call this from a request/read. */
export const initializeOperationalMetadata = (db: Db): Promise<{ issuerId: string; imported: number }> =>
  withSqliteErrors(async () => {
    assertRegisteredDatabaseRunner(db)
    assertNoActiveDatabaseTransaction()
    const migrations = await loadMigrations()
    const expected = migrations.map(({ version, name, checksum }) => ({ version, name, checksum }))
    if (!isReviewedOperationalMigrationSet(expected)) return fail('PRECONDITION_FAILED', 'this operational implementation supports only the reviewed migration set')
    const expectedJson = JSON.stringify(expected)
    const sql = migrations.find(m => m.version === OPERATIONAL_SCHEMA_VERSION)?.sql
    const expectedRuntime = sql?.match(/CREATE TABLE IF NOT EXISTS job_runtime_leases\s*\([\s\S]*?\) STRICT;/)?.[0]
    if (!expectedRuntime) return fail('PRECONDITION_FAILED', 'the operational migration is unavailable')
    return db.transaction(async tx => {
      assertDatabaseTransaction(tx)
      if (JSON.stringify(await appliedMigrations(tx)) !== expectedJson) return fail('PRECONDITION_FAILED', 'applied operational migration names, versions or checksums require review')
      const [runtime] = await tx.query<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='job_runtime_leases'")
      if (!runtime || normalizedSql(runtime.sql) !== normalizedSql(expectedRuntime)) fail('PRECONDITION_FAILED', 'existing job runtime schema requires explicit compatibility review')
      const existing = await tx.query<IdentityRow>('SELECT issuer_id,schema_version,migration_checksums_json FROM operational_identity WHERE singleton=1')
      if (existing[0]) {
        if (existing[0].schema_version !== OPERATIONAL_SCHEMA_VERSION || !matchesReviewedOperationalMigrations(existing[0].migration_checksums_json, expected)) fail('PRECONDITION_FAILED', 'unsupported operational metadata version or migration receipt')
        return { issuerId: assertId(existing[0].issuer_id), imported: 0 }
      }
      const rows = await tx.query<{ job_id: string; reference_code: string; updated_at: string }>('SELECT job_id,reference_code,updated_at FROM job_runtime_leases ORDER BY job_id')
      const issuerId = randomUUID()
      const now = new Date().toISOString()
      const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex')
      await tx.query('INSERT INTO operational_identity(singleton,issuer_id,initialized_at,schema_version,migration_checksums_json,legacy_import_count,legacy_import_sha256) VALUES(1,$1,$2,$3,$4,$5,$6)', [issuerId, now, OPERATIONAL_SCHEMA_VERSION, OPERATIONAL_IDENTITY_MIGRATIONS_JSON, rows.length, digest])
      let imported = 0
      for (const row of rows) {
        const reason = legacyReviewReason(row.reference_code)
        if (reason) {
          await tx.query('INSERT INTO legacy_reference_reviews(job_id,raw_reference,reason,recorded_at) VALUES($1,$2,$3,$4)', [row.job_id, row.reference_code, reason, now])
          continue
        }
        const parsed = parsedSequence(row.reference_code)
        await tx.query(`INSERT INTO official_reference_ledger(issuer_id,kind,entity_id,reference_code,issued_year,sequence,origin,publication_state,created_at,issued_at)
          VALUES($1,'job',$2,$3,$4,$5,'legacy','issued',$6,$6)`, [issuerId, row.job_id, row.reference_code, parsed?.year ?? null, parsed?.sequence ?? null, row.updated_at])
        if (parsed) {
          const [counter] = await tx.query<{ last_sequence: number }>("SELECT last_sequence FROM official_reference_counters WHERE issuer_id=$1 AND kind='job' AND issued_year=$2", [issuerId, parsed.year])
          if (!counter) await tx.query("INSERT INTO official_reference_counters(issuer_id,kind,issued_year,last_sequence) VALUES($1,'job',$2,$3)", [issuerId, parsed.year, parsed.sequence])
          else if (parsed.sequence > counter.last_sequence) await tx.query("UPDATE official_reference_counters SET last_sequence=$1 WHERE issuer_id=$2 AND kind='job' AND issued_year=$3", [parsed.sequence, issuerId, parsed.year])
        }
        imported++
      }
      await tx.query('INSERT INTO reconcile_host_epochs(issuer_id,last_epoch) VALUES($1,0)', [issuerId])
      return { issuerId, imported }
    })
  })

/** Read-only readiness assertion. Missing initialization never triggers repair or DDL. */
export const requireOperationalIdentity = async (db: Db): Promise<string> => {
  const table = await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='operational_identity'")
  if (table.length !== 1) fail('PRECONDITION_FAILED', 'operational database migration and explicit startup initialization are required')
  const [identity] = await db.query<IdentityRow>('SELECT issuer_id,schema_version,migration_checksums_json FROM operational_identity WHERE singleton=1')
  if (!identity || identity.schema_version !== OPERATIONAL_SCHEMA_VERSION) return fail('PRECONDITION_FAILED', 'explicit operational database startup initialization is required')
  if (!matchesReviewedOperationalMigrations(identity.migration_checksums_json, await appliedMigrations(db))) return fail('PRECONDITION_FAILED', 'operational schema differs from the reviewed initialized migration set')
  return assertId(identity.issuer_id, 'issuerId')
}

/** Internal transaction-only allocator. It never derives numbers from internal IDs or rowids. */
export const reserveOfficialJobReferenceTx = async (
  tx: Db,
  input: { jobId: string; at: Date; origin?: 'new' | 'repair'; repairId?: string; issued?: boolean },
): Promise<string> => {
  assertDatabaseTransaction(tx)
  if (input.origin === 'repair' || input.issued === false) assertStrictDurableTransaction(tx)
  const issuer = await requireOperationalIdentity(tx)
  const jobId = assertId(input.jobId, 'jobId')
  const year = input.at.getUTCFullYear()
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isFinite(input.at.getTime())) fail('VALIDATION', 'reference issue time is invalid')
  const existing = await tx.query<ReferenceRow>("SELECT reference_code,publication_state,tombstoned_at FROM official_reference_ledger WHERE issuer_id=$1 AND kind='job' AND entity_id=$2", [issuer, jobId])
  if (existing.length > 0) fail('CONFLICT', 'job identity already has permanent reference history')
  await tx.query("INSERT INTO official_reference_counters(issuer_id,kind,issued_year,last_sequence) SELECT $1,'job',$2,0 WHERE NOT EXISTS(SELECT 1 FROM official_reference_counters WHERE issuer_id=$1 AND kind='job' AND issued_year=$2)", [issuer, year])
  const [allocated] = await tx.query<{ last_sequence: number }>("UPDATE official_reference_counters SET last_sequence=last_sequence+1 WHERE issuer_id=$1 AND kind='job' AND issued_year=$2 AND last_sequence<9007199254740991 RETURNING last_sequence", [issuer, year])
  if (!allocated) return fail('LIMIT_EXCEEDED', 'official reference sequence is exhausted')
  const reference = `XP-JOB-${String(year).padStart(4, '0')}-${String(allocated.last_sequence).padStart(6, '0')}`
  const at = input.at.toISOString()
  await tx.query(`INSERT INTO official_reference_ledger(issuer_id,kind,entity_id,reference_code,issued_year,sequence,origin,publication_state,created_at,issued_at,repair_id)
    VALUES($1,'job',$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [issuer, jobId, reference, year, allocated.last_sequence, input.origin ?? 'new', input.issued === false ? 'reserved' : 'issued', at, input.issued === false ? null : at, input.repairId ?? null])
  return reference
}

export const issueReservedJobReferenceTx = async (tx: Db, jobId: string, at: string): Promise<string> => {
  assertDatabaseTransaction(tx)
  assertStrictDurableTransaction(tx)
  const issuer = await requireOperationalIdentity(tx)
  const [row] = await tx.query<{ reference_code: string }>(`UPDATE official_reference_ledger SET publication_state='issued',issued_at=$1
    WHERE issuer_id=$2 AND kind='job' AND entity_id=$3 AND publication_state='reserved' AND tombstoned_at IS NULL RETURNING reference_code`, [at, issuer, assertId(jobId)])
  if (!row) return fail('PRECONDITION_FAILED', 'a live reserved official reference is required')
  return row.reference_code
}

interface RepairRow extends Record<string, unknown> {
  id: string; job_id: string; request_key: string; principal_id: string; reason: string
  original_reference: string | null; request_fingerprint: string; state: 'awaiting_intent' | 'confirmed'
  intent_event_uid: string | null; intent_entry_hash: string | null
}

export interface LegacyReferenceRepair {
  readonly repairId: string | null
  readonly jobId: string
  readonly state: 'already_issued' | 'awaiting_intent' | 'confirmed'
  readonly reference: string | null
  readonly intentBinding: Readonly<{ purpose: 'reference.repair.intent'; jobId: string; requestFingerprint: string; action: 'job.reference.repair'; principalId: string }> | null
}

const repairSubject = async (tx: Db, jobId: string): Promise<Record<string, unknown>> => {
  const [job] = await tx.query<{ id: string; kind: string; account_id: string | null; actor: string; created_at: string; raw_reference: string | null }>(`SELECT j.id,j.kind,j.account_id,j.actor,j.created_at,l.reference_code AS raw_reference FROM jobs j LEFT JOIN job_runtime_leases l ON l.job_id=j.id WHERE j.id=$1`, [jobId])
  if (!job) return fail('NOT_FOUND', 'legacy job does not exist')
  if (job.kind === 'host.reconcile') return fail('PRECONDITION_FAILED', 'reconcile references must be confirmed by their own intent')
  return job
}
const repairFingerprint = (subject: Record<string, unknown>, requestKey: string, principalId: string, reason: string): string =>
  createHash('sha256').update(JSON.stringify({ purpose: 'reference.repair.intent', subject, requestKey, principalId, reason })).digest('hex')

const projectRepair = async (tx: Db, row: RepairRow): Promise<LegacyReferenceRepair> => {
  const [reference] = await tx.query<{ reference_code: string }>("SELECT reference_code FROM official_reference_ledger WHERE kind='job' AND entity_id=$1 AND publication_state='issued' AND tombstoned_at IS NULL", [row.job_id])
  return Object.freeze({ repairId: row.id, jobId: row.job_id, state: row.state, reference: reference?.reference_code ?? null,
    intentBinding: Object.freeze({ purpose: 'reference.repair.intent', jobId: row.job_id, requestFingerprint: row.request_fingerprint, action: 'job.reference.repair', principalId: row.principal_id }) })
}

/** Explicit metadata-only repair reservation; no business action is executed or reissued. */
export const reserveLegacyJobReferenceRepair = (db: Db, input: { jobId: string; requestKey: string; principalId: string; reason: string }): Promise<LegacyReferenceRepair> => withSqliteErrors(async () => {
  assertRegisteredDatabaseRunner(db)
  assertNoActiveDatabaseTransaction()
  const id = assertId(input.jobId, 'jobId')
  const principal = assertId(input.principalId, 'principalId')
  const key = assertLine(input.requestKey, 128, 'requestKey', { allowEmpty: false })
  const reason = assertLine(input.reason, 512, 'reason', { allowEmpty: false })
  return db.transaction(async tx => {
    assertStrictDurableTransaction(tx)
    await requireOperationalIdentity(tx)
    const [existing] = await tx.query<RepairRow>('SELECT * FROM legacy_reference_repairs WHERE request_key=$1 OR job_id=$2', [key, id])
    if (existing) {
      if (existing.job_id !== id || existing.request_key !== key || existing.principal_id !== principal || existing.reason !== reason) return fail('CONFLICT', 'reference repair key or target already binds a different request')
      return projectRepair(tx, existing)
    }
    const [issued] = await tx.query<{ reference_code: string }>("SELECT reference_code FROM official_reference_ledger WHERE kind='job' AND entity_id=$1 AND publication_state='issued' AND tombstoned_at IS NULL", [id])
    if (issued) return Object.freeze({ repairId: null, jobId: id, state: 'already_issued', reference: issued.reference_code, intentBinding: null })
    const subject = await repairSubject(tx, id)
    const raw = subject.raw_reference as string | null
    if (raw !== null && legacyReviewReason(raw) === null) return fail('PRECONDITION_FAILED', 'an existing possible official reference requires explicit import review, never renumbering')
    const repairId = randomUUID()
    const now = new Date().toISOString()
    const fingerprint = repairFingerprint(subject, key, principal, reason)
    await reserveOfficialJobReferenceTx(tx, { jobId: id, at: new Date(now), origin: 'repair', repairId, issued: false })
    await tx.query(`INSERT INTO legacy_reference_repairs(id,request_key,job_id,principal_id,reason,original_reference,request_fingerprint,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'awaiting_intent',$8)`, [repairId, key, id, principal, reason, raw, fingerprint, now])
    return projectRepair(tx, (await tx.query<RepairRow>('SELECT * FROM legacy_reference_repairs WHERE id=$1', [repairId]))[0]!)
  })
})

export const confirmLegacyJobReferenceRepair = (db: Db, repairId: string, receipt: unknown): Promise<LegacyReferenceRepair> => withSqliteErrors(async () => {
  assertRegisteredDatabaseRunner(db)
  assertNoActiveDatabaseTransaction()
  return db.transaction(async tx => {
  assertStrictDurableTransaction(tx)
  await requireOperationalIdentity(tx)
  const [row] = await tx.query<RepairRow>('SELECT * FROM legacy_reference_repairs WHERE id=$1', [assertId(repairId, 'repairId')])
  if (!row) return fail('NOT_FOUND', 'reference repair does not exist')
  const verified = assertOperationIntentReceipt(receipt, { purpose: 'reference.repair.intent', jobId: row.job_id, requestFingerprint: row.request_fingerprint, action: 'job.reference.repair', principalId: row.principal_id }, tx)
  if (row.state === 'confirmed') {
    if (verified.eventUid !== row.intent_event_uid || verified.entryHash !== row.intent_entry_hash) return fail('CONFLICT', 'repair audit intent differs from confirmed record')
    return projectRepair(tx, row)
  }
  const subject = await repairSubject(tx, row.job_id)
  if (repairFingerprint(subject, row.request_key, row.principal_id, row.reason) !== row.request_fingerprint) return fail('CONFLICT', 'legacy reference or job identity changed during repair')
  const now = new Date().toISOString()
  const reference = await issueReservedJobReferenceTx(tx, row.job_id, now)
  if (row.original_reference === null) await tx.query("INSERT INTO job_runtime_leases(job_id,reference_code,updated_at) VALUES($1,$2,$3)", [row.job_id, reference, now])
  else await tx.query('UPDATE job_runtime_leases SET reference_code=$1,updated_at=$2 WHERE job_id=$3 AND reference_code=$4', [reference, now, row.job_id, row.original_reference])
  await tx.query("UPDATE legacy_reference_repairs SET state='confirmed',intent_event_uid=$1,intent_entry_hash=$2,confirmed_at=$3 WHERE id=$4 AND state='awaiting_intent'", [verified.eventUid, verified.entryHash, now, row.id])
  return projectRepair(tx, (await tx.query<RepairRow>('SELECT * FROM legacy_reference_repairs WHERE id=$1', [row.id]))[0]!)
})})
