import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createDb, createTestDb } from './client.ts'
import { loadMigrations, migrate } from './migrate.ts'
import { isReviewedOperationalMigrationSet, matchesReviewedOperationalMigrations } from './schema.ts'
import { enqueueDurableJob, getDurableJob } from './repos/jobs.ts'
import { initializeOperationalMetadata } from './repos/official-references.ts'
import { createRootPrincipal } from './repos/principals.ts'
import { findActiveSessionByTokenHash } from './repos/sessions.ts'
import { getMailboxSession, saveMailboxSession } from './repos/mailbox-sessions.ts'
import { ARGON2 } from './testing.ts'

describe('permanent job reference consolidation', () => {
  it('allows generic issuance on an independent normal database inside another connection transaction', async () => {
    const first = await createTestDb()
    const second = await createTestDb()
    try {
      await first.db.transaction(async tx => {
        expect(await tx.query('SELECT 1 AS value')).toEqual([{ value: 1 }])
        const job = await enqueueDurableJob(second.db, { kind: 'backup.create', actor: 'root' })
        expect(job.referenceCode).toMatch(/^XP-JOB-[0-9]{4}-[0-9]{6,16}$/)
        expect(await tx.query('SELECT 2 AS value')).toEqual([{ value: 2 }])
      })
    } finally { await second.close(); await first.close() }
  })

  it('never reuses an issued reference after every job and lease has been removed', async () => {
    const handle = await createTestDb()
    try {
      const first = await enqueueDurableJob(handle.db, { kind: 'backup.create', actor: 'root' })
      await handle.db.query('DELETE FROM jobs WHERE id=$1', [first.id])
      const next = await enqueueDurableJob(handle.db, { kind: 'backup.create', actor: 'root' })
      expect(next.referenceCode).not.toBe(first.referenceCode)
    } finally { await handle.close() }
  })

  it('keeps an uninitialized job read free of schema writes', async () => {
    const handle = createDb(':memory:')
    try {
      await migrate(handle.db)
      const before = await handle.db.query('SELECT name,sql FROM sqlite_master ORDER BY name')
      await expect(getDurableJob(handle.db, randomUUID())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      expect(await handle.db.query('SELECT name,sql FROM sqlite_master ORDER BY name')).toEqual(before)
    } finally { await handle.close() }
  })

  it('preserves mailbox authentication and exact applied migration receipts through additive initialization', async () => {
    const handle = createDb(':memory:')
    try {
      const migrations = await loadMigrations()
      await migrate(handle.db, { migrations: migrations.slice(0, 2) })
      const beforeMigrations = await handle.db.query('SELECT * FROM xpanel_schema_migrations ORDER BY version')
      const principal = await createRootPrincipal(handle.db, { username: 'root', passwordHash: ARGON2 })
      const tokenHash = 'a'.repeat(64)
      // Schema 2 has no impersonation columns, so the legacy session row uses that schema's own column set.
      const [legacy] = await handle.db.query<{ id: string }>(`INSERT INTO sessions (id, principal_id, token_hash, expires_at) VALUES ($1, $2, $3, $4) RETURNING id`,
        [randomUUID(), principal.id, tokenHash, new Date(Date.now() + 60_000).toISOString()])
      const session = { id: legacy!.id }
      const mailbox = await saveMailboxSession(handle.db, { sessionId: session.id, mailbox: 'owner@example.test', serviceUserId: randomUUID(), accountId: randomUUID(), sealedPassword: new Uint8Array(32).fill(7) })
      const result = await migrate(handle.db)
      expect(result.applied).toEqual(['0003_job_references_reconcile.sql', '0004_host_metrics_observations.sql', '0005_team_sign_in.sql', '0006_panel_handoffs.sql'])
      const first = await initializeOperationalMetadata(handle.db)
      expect(await initializeOperationalMetadata(handle.db)).toEqual({ issuerId: first.issuerId, imported: 0 })
      expect(await handle.db.query('SELECT * FROM xpanel_schema_migrations WHERE version<=2 ORDER BY version')).toEqual(beforeMigrations)
      expect(await getMailboxSession(handle.db, session.id)).toEqual(mailbox)
      expect(await findActiveSessionByTokenHash(handle.db, tokenHash)).toMatchObject({ id: session.id, principalId: principal.id, impersonatorPrincipalId: null, impersonatorLogin: null })
      const [identity] = await handle.db.query<{ schema_version: number; migration_checksums_json: string }>('SELECT schema_version,migration_checksums_json FROM operational_identity')
      expect(identity?.schema_version).toBe(3)
      const applied = await handle.db.query('SELECT version,name,checksum FROM xpanel_schema_migrations ORDER BY version')
      expect(matchesReviewedOperationalMigrations(identity?.migration_checksums_json, applied)).toBe(true)
      expect(await handle.db.query('SELECT * FROM official_reference_counters')).toEqual([])
    } finally { await handle.close() }
  })

  it('rejects malformed, old, future and fabricated checksum receipts against the actual reviewed source', async () => {
    const migrations = (await loadMigrations()).map(({ version, name, checksum }) => ({ version, name, checksum }))
    expect(isReviewedOperationalMigrationSet(migrations)).toBe(true)
    for (const invalid of [null, [], migrations.slice(0, 2), [...migrations, { version: 5, name: '0005_future.sql', checksum: 'f'.repeat(64) }], migrations.map(row => ({ ...row, checksum: 'f'.repeat(64) }))]) {
      expect(isReviewedOperationalMigrationSet(invalid)).toBe(false)
      expect(matchesReviewedOperationalMigrations(JSON.stringify(invalid), invalid)).toBe(false)
    }
    for (const malformed of ['{', JSON.stringify(migrations) + ' ', JSON.stringify(migrations).replace('"version":1', '"version":0,"version":1')]) {
      expect(matchesReviewedOperationalMigrations(malformed, migrations)).toBe(false)
    }
  })
})
