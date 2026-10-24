import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { XpanelError, isXpanelError } from '@xpanel/core'
import { createDb, createTestDb } from './client.ts'
import { currentSchemaVersion, migrate } from './migrate.ts'
import { createRootPrincipal, findPrincipalByUsername, getPrincipal, setTotpSecret } from './repos/principals.ts'
import { toXpanelError, withSqliteErrors } from './sqlite-errors.ts'
import { ARGON2 } from './testing.ts'

describe('createDb', () => {
  it('validates the path and options', async () => {
    for (const bad of ['postgres://u:secret@h/db', 'mysql://u:secret@h/db', '', '   ', 'sqlite://', 'a\0b']) {
      expect(() => createDb(bad)).toThrow()
    }
    for (const opts of [{ busyTimeoutMs: -1 }, { busyTimeoutMs: 700_000 }, { busyTimeoutMs: 1.5 }]) {
      expect(() => createDb(':memory:', opts)).toThrow()
    }
    const h = createDb(':memory:')
    await h.close()
  })

  it('enables WAL mode and foreign_keys on a file-backed SQLite database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xpanel-sqlite-'))
    const dbPath = join(dir, 'index.sqlite')
    const h = createDb(dbPath)
    try {
      const [fk] = await h.query<{ foreign_keys: number }>('PRAGMA foreign_keys')
      const [jm] = await h.query<{ journal_mode: string }>('PRAGMA journal_mode')
      expect(fk?.foreign_keys).toBe(1)
      expect(jm?.journal_mode.toLowerCase()).toBe('wal')

      const first = await migrate(h.runner)
      expect(first.applied).toEqual(['0001_init.sql', '0002_mailbox_sessions.sql', '0003_job_references_reconcile.sql'])
      expect(await currentSchemaVersion(h.runner)).toBe(3)

      const root = await createRootPrincipal(h.db, { username: 'root', passwordHash: ARGON2 })
      const sealed = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)
      await setTotpSecret(h.db, root.id, sealed)
      const loaded = await getPrincipal(h.db, root.id)
      expect([...(loaded?.totpSecretEnc ?? [])]).toEqual([...sealed])
      expect((await findPrincipalByUsername(h.db, 'ROOT'))?.id).toBe(root.id)
    } finally {
      await h.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rolls back when a transaction throws and refuses nested transactions', async () => {
    const h = await createTestDb()
    try {
      await expect(
        h.runner.transaction(async (tx) => {
          await createRootPrincipal(tx, { username: 'rollbackuser', passwordHash: ARGON2 })
          throw new Error('abort tx')
        }),
      ).rejects.toThrow('abort tx')
      expect(await findPrincipalByUsername(h.db, 'rollbackuser')).toBeNull()

      await expect(h.runner.transaction(async (tx) => tx.transaction(async () => 1))).rejects.toThrow(/nested/)
    } finally {
      await h.close()
    }
  })
})

describe('sqlite error mapping', () => {
  const sqErr = (message: string, errcode = 19) =>
    Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode })

  it('maps UNIQUE, FOREIGN KEY, CHECK, NOT NULL, BUSY, and trigger prefixes to XpanelError', async () => {
    expect(toXpanelError(sqErr('UNIQUE constraint failed: principals.username'))).toMatchObject({
      code: 'CONFLICT',
    })
    expect(toXpanelError(sqErr('FOREIGN KEY constraint failed'))).toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(toXpanelError(sqErr('CHECK constraint failed: kind IN (...)'))).toMatchObject({
      code: 'VALIDATION',
    })
    expect(toXpanelError(sqErr('NOT NULL constraint failed: principals.username'))).toMatchObject({
      code: 'VALIDATION',
    })
    expect(toXpanelError(sqErr('FORBIDDEN: audit_log is append-only'))).toMatchObject({
      code: 'FORBIDDEN',
      message: 'audit_log is append-only',
    })
    expect(toXpanelError(sqErr('VALIDATION: illegal config_generations status transition'))).toMatchObject({
      code: 'VALIDATION',
    })
    expect(toXpanelError(sqErr('database is locked', 5))).toMatchObject({
      code: 'CONFLICT',
    })

    const own = new XpanelError('NOT_FOUND', 'x')
    expect(toXpanelError(own)).toBe(own)
    await expect(withSqliteErrors(() => Promise.reject(sqErr('UNIQUE constraint failed: x')))).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(await withSqliteErrors(() => 42)).toBe(42)
    expect(isXpanelError(toXpanelError(sqErr('syntax error', 1)))).toBe(false)
  })
})
