import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import {
  assertSequence,
  checksumOf,
  currentSchemaVersion,
  latestSchemaVersion,
  loadMigrations,
  migrate,
  migrationViolations,
  parseMigration,
  type Migration,
} from './migrate.ts'
import { ALL_STRICT_TABLES } from './schema.ts'
import { sqliteRunner, type SqlRunner } from './sql-runner.ts'

const open: DatabaseSync[] = []

const fresh = (): SqlRunner => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  open.push(db)
  return sqliteRunner(db)
}

afterEach(() => {
  for (const db of open.splice(0)) db.close()
})

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (e) {
    return isXpanelError(e) ? e.code : `raw:${(e as Error).message}`
  }
  return 'no error'
}

const tables = async (r: SqlRunner): Promise<string[]> =>
  (
    await r.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_fts%' ORDER BY name`,
    )
  ).map((x) => x.name)

const columns = async (r: SqlRunner, table: string): Promise<string[]> =>
  (await r.query<{ name: string }>(`SELECT name FROM pragma_table_info($1) ORDER BY cid`, [table])).map((x) => x.name)

const m = (name: string, sql: string): Migration => parseMigration(name, sql)

describe('migration files', () => {
  it('loads the shipped migrations in order with stable checksums', async () => {
    const ms = await loadMigrations()
    expect(ms[0]?.name).toBe('0001_init.sql')
    expect(ms.map((x) => x.version)).toEqual(ms.map((_, i) => i + 1))
    for (const x of ms) {
      expect(x.checksum).toMatch(/^[0-9a-f]{64}$/)
      expect(migrationViolations(x)).toEqual([])
    }
    expect(latestSchemaVersion(ms)).toBe(ms.length)
  })

  it('normalises CRLF and BOM before hashing', () => {
    expect(checksumOf('a;\r\nb;\r\n')).toBe(checksumOf('a;\nb;\n'))
    expect(checksumOf('\uFEFFa;')).toBe(checksumOf('a;'))
    expect(checksumOf('a;')).not.toBe(checksumOf('a; '))
  })

  it.each(['1_init.sql', '0001-init.sql', '0001_Init.sql', '0001_.sql', '0001_init.SQL', '../0001_x.sql', '0000_zero.sql'])(
    'rejects file name %s',
    (name) => {
      expect(() => parseMigration(name, 'SELECT 1;')).toThrow()
    },
  )

  it('detects *_contract.sql', () => {
    expect(m('0002_drop_old_contract.sql', '').contract).toBe(true)
    expect(m('0002_contractor.sql', '').contract).toBe(false)
  })

  it('requires 1..n without gaps or duplicates', () => {
    expect(() => assertSequence([m('0001_a.sql', ''), m('0003_c.sql', '')])).toThrow(/expected 0002/)
    expect(() => assertSequence([m('0001_a.sql', ''), m('0001_b.sql', '')])).toThrow()
    expect(() => assertSequence([m('0002_b.sql', '')])).toThrow()
    expect(() => assertSequence([m('0002_b.sql', ''), m('0001_a.sql', '')])).not.toThrow()
  })

  it('refuses a directory containing a badly named .sql file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xpanel-mig-'))
    try {
      await writeFile(join(dir, '0001_ok.sql'), 'SELECT 1;')
      await writeFile(join(dir, 'oops.sql'), 'SELECT 1;')
      await writeFile(join(dir, 'README.md'), 'ignored')
      await expect(loadMigrations(dir)).rejects.toThrow(/0001_name\.sql/)
      await rm(join(dir, 'oops.sql'))
      expect((await loadMigrations(dir)).map((x) => x.name)).toEqual(['0001_ok.sql'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('expand-only guard', () => {
  const v = (sql: string, name = '0002_x.sql') => migrationViolations(m(name, sql))

  it.each([
    ['DROP TABLE accounts;', 'DROP TABLE'],
    ['drop   table if exists x;', 'DROP TABLE'],
    ['ALTER TABLE accounts DROP COLUMN shell;', 'DROP COLUMN'],
    ['ALTER TABLE accounts\n  drop\n  column shell;', 'DROP COLUMN'],
    ['ALTER TABLE accounts DROP shell;', 'ALTER TABLE ... DROP <column>'],
    ['ALTER TABLE accounts RENAME TO users;', 'RENAME'],
    ['ALTER TABLE accounts RENAME COLUMN shell TO login_shell;', 'RENAME'],
    ['DROP VIEW v;', 'DROP <view|sequence|type|domain|extension|database|owned>'],
    ['ALTER TABLE accounts ALTER COLUMN note SET NOT NULL;', 'SET NOT NULL'],
    ['TRUNCATE audit_log;', 'TRUNCATE'],
    ['DROP SCHEMA public CASCADE;', 'DROP SCHEMA'],
  ])('rejects %s', (sql, rule) => {
    expect(v(sql)).toContain(rule)
  })

  it.each([
    'ALTER TABLE principals ADD COLUMN note TEXT NULL;',
    'DROP INDEX IF EXISTS principals_note_idx;',
    'DROP TRIGGER IF EXISTS t_touch;',
    'CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT; CREATE INDEX t_idx ON t (id);',
    '-- DROP TABLE principals; would be bad\nSELECT 1;',
    '/* ALTER TABLE a RENAME TO b; /* nested */ still comment */ SELECT 1;',
  ])('allows %s', (sql) => {
    expect(v(sql)).toEqual([])
  })

  it('lets *_contract.sql drop, retype and rename', () => {
    expect(v('ALTER TABLE a DROP COLUMN b; ALTER TABLE a RENAME TO c; DROP TABLE d;', '0003_cleanup_contract.sql')).toEqual([])
  })

  it('rejects transaction control and CONCURRENTLY everywhere, contract or not', () => {
    for (const name of ['0002_x.sql', '0002_x_contract.sql']) {
      expect(v('BEGIN; SELECT 1; COMMIT;', name)).toContain('transaction control (the runner wraps each migration in a transaction)')
      expect(v('CREATE INDEX CONCURRENTLY i ON t (x);', name)).toContain('CONCURRENTLY (cannot run inside a transaction)')
    }
    expect(v("CREATE TRIGGER t_g BEFORE DELETE ON t BEGIN SELECT RAISE(ABORT, 'FORBIDDEN'); END;")).toEqual([])
  })

  it('reports unparseable SQL instead of guessing', () => {
    expect(v("SELECT 'unterminated;")[0]).toMatch(/unparseable/)
  })
})

describe('migrate()', () => {
  it('applies on an empty database and records name + checksum', async () => {
    const r = fresh()
    expect(await currentSchemaVersion(r)).toBe(0)
    const res = await migrate(r)
    expect(res.applied).toEqual(['0001_init.sql'])
    expect(res.version).toBe(1)
    expect(await currentSchemaVersion(r)).toBe(1)
    const rows = await r.query<{ name: string; checksum: string }>('SELECT name, checksum FROM xpanel_schema_migrations')
    const shipped = await loadMigrations()
    expect(rows).toEqual([{ name: '0001_init.sql', checksum: shipped[0]?.checksum }])
    expect(await tables(r)).toEqual([...ALL_STRICT_TABLES].sort())
  })

  it('is a no-op the second time', async () => {
    const r = fresh()
    await migrate(r)
    const before = await r.query('SELECT version, applied_at FROM xpanel_schema_migrations')
    const again = await migrate(r)
    expect(again.applied).toEqual([])
    expect(again.alreadyApplied).toEqual(['0001_init.sql'])
    expect(again.version).toBe(1)
    expect(await r.query('SELECT version, applied_at FROM xpanel_schema_migrations')).toEqual(before)
  })

  it('refuses when an applied migration changed, before touching anything', async () => {
    const r = fresh()
    const shipped = await loadMigrations()
    await migrate(r)
    const tampered = shipped.map((x) => (x.version === 1 ? m(x.name, `${x.sql}\n-- edited\n`) : x))
    const added = m('0002_more.sql', 'CREATE TABLE should_not_exist (id INTEGER) STRICT;')
    const err = await migrate(r, { migrations: [...tampered, added] }).catch((e: unknown) => e)
    expect(isXpanelError(err) && err.code).toBe('PRECONDITION_FAILED')
    expect((err as Error).message).toMatch(/checksum mismatch/)
    expect(await tables(r)).not.toContain('should_not_exist')
    expect(await currentSchemaVersion(r)).toBe(1)
  })

  it('refuses when an applied version now has another file name', async () => {
    const r = fresh()
    const one = m('0001_first.sql', 'CREATE TABLE a (id INTEGER) STRICT;')
    await migrate(r, { migrations: [one] })
    const renamed = m('0001_renamed.sql', 'CREATE TABLE a (id INTEGER) STRICT;')
    expect(await codeOf(migrate(r, { migrations: [renamed] }))).toBe('PRECONDITION_FAILED')
  })

  it('expand-only guard blocks DROP COLUMN in a non-contract migration and applies nothing', async () => {
    const r = fresh()
    const one = m('0001_base.sql', 'CREATE TABLE a (id INTEGER, old TEXT) STRICT;')
    await migrate(r, { migrations: [one] })
    const good = m('0002_add.sql', 'ALTER TABLE a ADD COLUMN note TEXT;')
    const bad = m('0003_drop.sql', 'ALTER TABLE a DROP COLUMN old;')
    const err = await migrate(r, { migrations: [one, good, bad] }).catch((e: unknown) => e)
    expect(isXpanelError(err) && err.code).toBe('VALIDATION')
    expect((err as Error).message).toMatch(/expand-only.*DROP COLUMN/)
    expect(await columns(r, 'a')).toEqual(['id', 'old'])
    expect(await currentSchemaVersion(r)).toBe(1)

    const contract = m('0003_drop_old_contract.sql', 'ALTER TABLE a DROP COLUMN old;')
    const res = await migrate(r, { migrations: [one, good, contract] })
    expect(res.applied).toEqual(['0002_add.sql', '0003_drop_old_contract.sql'])
    expect(await columns(r, 'a')).toEqual(['id', 'note'])
  })

  it('runs each migration in a transaction: a failing one leaves no trace', async () => {
    const r = fresh()
    const one = m('0001_base.sql', 'CREATE TABLE a (id INTEGER) STRICT;')
    const broken = m('0002_broken.sql', 'CREATE TABLE half (id INTEGER) STRICT;\nINSERT INTO missing_table VALUES (1);')
    await expect(migrate(r, { migrations: [one, broken] })).rejects.toThrow()
    expect(await tables(r)).toEqual(['a', 'xpanel_schema_migrations'])
    expect(await currentSchemaVersion(r)).toBe(1)
    const fixed = m('0002_broken.sql', 'CREATE TABLE half (id INTEGER) STRICT;')
    expect((await migrate(r, { migrations: [one, fixed] })).applied).toEqual(['0002_broken.sql'])
  })

  it('tolerates migrations from a newer build (expand-only makes old code safe)', async () => {
    const r = fresh()
    const one = m('0001_base.sql', 'CREATE TABLE a (id INTEGER) STRICT;')
    const two = m('0002_newer.sql', 'ALTER TABLE a ADD COLUMN b INTEGER;')
    await migrate(r, { migrations: [one, two] })
    const res = await migrate(r, { migrations: [one] })
    expect(res.applied).toEqual([])
    expect(res.unknownApplied).toEqual(['0002_newer.sql'])
    expect(res.version).toBe(2)
  })

  it('concurrent runners apply each migration exactly once', async () => {
    const r = fresh()
    const results = await Promise.all([migrate(r), migrate(r), migrate(r)])
    expect(results.flatMap((x) => x.applied)).toEqual(['0001_init.sql'])
    const [row] = await r.query<{ n: number }>('SELECT count(*) AS n FROM xpanel_schema_migrations')
    expect(row?.n).toBe(1)
  })
})
