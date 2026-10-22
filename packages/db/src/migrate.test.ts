import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
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
import { pgliteRunner, type SqlRunner } from './sql-runner.ts'

const T = 120_000
const open: PGlite[] = []

const fresh = async (): Promise<SqlRunner> => {
  const pg = new PGlite()
  await pg.waitReady
  open.push(pg)
  return pgliteRunner(pg)
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((pg) => pg.close()))
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
  (await r.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((x) => x.t)

const columns = async (r: SqlRunner, table: string): Promise<string[]> =>
  (
    await r.query<{ c: string }>(
      `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY 1`,
      [table],
    )
  ).map((x) => x.c)

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
    ['ALTER TABLE accounts DROP IF EXISTS shell;', 'ALTER TABLE ... DROP <column>'],
    ['ALTER TABLE ONLY accounts DROP CONSTRAINT c, DROP shell;', 'ALTER TABLE ... DROP <column>'],
    ['ALTER TABLE accounts ALTER COLUMN uid TYPE bigint;', 'ALTER COLUMN ... TYPE'],
    ['ALTER TABLE accounts ALTER uid TYPE bigint;', 'ALTER COLUMN ... TYPE'],
    ['ALTER TABLE accounts ALTER COLUMN "uid" SET DATA TYPE bigint;', 'ALTER COLUMN ... TYPE'],
    ['ALTER TABLE accounts RENAME TO users;', 'RENAME'],
    ['ALTER TABLE accounts RENAME COLUMN shell TO login_shell;', 'RENAME'],
    ['ALTER INDEX a RENAME TO b;', 'RENAME'],
    ['DROP VIEW v;', 'DROP <view|sequence|type|domain|extension|database|owned>'],
    ['DROP MATERIALIZED VIEW IF EXISTS mv;', 'DROP <view|sequence|type|domain|extension|database|owned>'],
    ['DROP SEQUENCE xpanel_uid_seq;', 'DROP <view|sequence|type|domain|extension|database|owned>'],
    ['DROP TYPE status_t;', 'DROP <view|sequence|type|domain|extension|database|owned>'],
    ['ALTER TABLE accounts ALTER COLUMN note SET NOT NULL;', 'SET NOT NULL'],
    ['TRUNCATE audit_log;', 'TRUNCATE'],
    ['DROP SCHEMA public CASCADE;', 'DROP SCHEMA'],
    ["DO $$ BEGIN EXECUTE 'DROP TABLE accounts'; END $$;", 'DROP TABLE'],
    ['DO $body$ BEGIN ALTER TABLE accounts DROP COLUMN shell; END $body$;', 'DROP COLUMN'],
  ])('rejects %s', (sql, rule) => {
    expect(v(sql)).toContain(rule)
  })

  it.each([
    'ALTER TABLE accounts ADD COLUMN note text NULL;',
    'ALTER TABLE accounts DROP CONSTRAINT accounts_x_check;',
    'ALTER TABLE accounts ALTER COLUMN note DROP NOT NULL;',
    'ALTER TABLE accounts ALTER COLUMN note DROP DEFAULT;',
    'ALTER TABLE accounts ALTER COLUMN note SET DEFAULT 1;',
    'DROP INDEX IF EXISTS accounts_note_idx;',
    'DROP TRIGGER IF EXISTS t_touch ON t;',
    'CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
    'CREATE TABLE t (id int); CREATE INDEX t_idx ON t (id);',
    '-- DROP TABLE accounts; would be bad\nSELECT 1;',
    '/* ALTER TABLE a RENAME TO b; /* nested */ still comment */ SELECT 1;',
    "CREATE TABLE g (p text[] CHECK (p <@ ARRAY['DROP','ALTER','CREATE']::text[]));",
    'CREATE TABLE typed (type text);',
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
    // a plpgsql BEGIN inside a dollar-quoted body is not transaction control
    expect(v('CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;')).toEqual([])
  })

  it('reports unparseable SQL instead of guessing', () => {
    expect(v("SELECT 'unterminated;")[0]).toMatch(/unparseable/)
    expect(v('SELECT $$ open;')[0]).toMatch(/unparseable/)
  })
})

describe('migrate()', () => {
  it(
    'applies on an empty database and records name + checksum',
    async () => {
      const r = await fresh()
      expect(await currentSchemaVersion(r)).toBe(0)
      const res = await migrate(r)
      expect(res.applied).toEqual(['0001_init.sql'])
      expect(res.version).toBe(1)
      expect(await currentSchemaVersion(r)).toBe(1)
      const rows = await r.query<{ name: string; checksum: string }>('SELECT name, checksum FROM xpanel_schema_migrations')
      const shipped = await loadMigrations()
      expect(rows).toEqual([{ name: '0001_init.sql', checksum: shipped[0]?.checksum }])
      expect(await tables(r)).toEqual(
        [
          'accounts', 'api_tokens', 'audit_log', 'backup_jobs', 'backups', 'certificates', 'config_generations', 'cron_jobs',
          'database_grants', 'database_users', 'databases', 'dns_records', 'dns_zones', 'domains', 'feature_lists', 'firewall_prefix_lists',
          'firewall_rules', 'lockouts', 'login_attempts', 'plans', 'principals', 'resellers', 'server_settings',
          'service_catalog', 'service_users', 'sessions', 'transfer_items', 'transfers', 'trash_items', 'uid_allocator',
          'upgrades', 'xpanel_schema_migrations',
        ].sort(),
      )
    },
    T,
  )

  it(
    'is a no-op the second time',
    async () => {
      const r = await fresh()
      await migrate(r)
      const before = await r.query('SELECT version, applied_at FROM xpanel_schema_migrations')
      const again = await migrate(r)
      expect(again.applied).toEqual([])
      expect(again.alreadyApplied).toEqual(['0001_init.sql'])
      expect(again.version).toBe(1)
      expect(await r.query('SELECT version, applied_at FROM xpanel_schema_migrations')).toEqual(before)
    },
    T,
  )

  it(
    'refuses when an applied migration changed, before touching anything',
    async () => {
      const r = await fresh()
      const shipped = await loadMigrations()
      await migrate(r)
      const tampered = shipped.map((x) => (x.version === 1 ? m(x.name, `${x.sql}\n-- edited\n`) : x))
      const added = m('0002_more.sql', 'CREATE TABLE should_not_exist (id int);')
      const err = await migrate(r, { migrations: [...tampered, added] }).catch((e: unknown) => e)
      expect(isXpanelError(err) && err.code).toBe('PRECONDITION_FAILED')
      expect((err as Error).message).toMatch(/checksum mismatch/)
      expect(await tables(r)).not.toContain('should_not_exist')
      expect(await currentSchemaVersion(r)).toBe(1)
    },
    T,
  )

  it(
    'refuses when an applied version now has another file name',
    async () => {
      const r = await fresh()
      const one = m('0001_first.sql', 'CREATE TABLE a (id int);')
      await migrate(r, { migrations: [one] })
      const renamed = m('0001_renamed.sql', 'CREATE TABLE a (id int);')
      expect(await codeOf(migrate(r, { migrations: [renamed] }))).toBe('PRECONDITION_FAILED')
    },
    T,
  )

  it(
    'expand-only guard blocks DROP COLUMN in a non-contract migration and applies nothing',
    async () => {
      const r = await fresh()
      const one = m('0001_base.sql', 'CREATE TABLE a (id int, old text);')
      await migrate(r, { migrations: [one] })
      const good = m('0002_add.sql', 'ALTER TABLE a ADD COLUMN note text;')
      const bad = m('0003_drop.sql', 'ALTER TABLE a DROP COLUMN old;')
      const err = await migrate(r, { migrations: [one, good, bad] }).catch((e: unknown) => e)
      expect(isXpanelError(err) && err.code).toBe('VALIDATION')
      expect((err as Error).message).toMatch(/expand-only.*DROP COLUMN/)
      // validated up front: not even the harmless 0002 ran
      expect(await columns(r, 'a')).toEqual(['id', 'old'])
      expect(await currentSchemaVersion(r)).toBe(1)

      const contract = m('0003_drop_old_contract.sql', 'ALTER TABLE a DROP COLUMN old;')
      const res = await migrate(r, { migrations: [one, good, contract] })
      expect(res.applied).toEqual(['0002_add.sql', '0003_drop_old_contract.sql'])
      expect(await columns(r, 'a')).toEqual(['id', 'note'])
    },
    T,
  )

  it(
    'runs each migration in a transaction: a failing one leaves no trace',
    async () => {
      const r = await fresh()
      const one = m('0001_base.sql', 'CREATE TABLE a (id int);')
      const broken = m('0002_broken.sql', 'CREATE TABLE half (id int);\nINSERT INTO missing_table VALUES (1);')
      await expect(migrate(r, { migrations: [one, broken] })).rejects.toThrow()
      expect(await tables(r)).toEqual(['a', 'xpanel_schema_migrations'])
      expect(await currentSchemaVersion(r)).toBe(1)
      const fixed = m('0002_broken.sql', 'CREATE TABLE half (id int);')
      expect((await migrate(r, { migrations: [one, fixed] })).applied).toEqual(['0002_broken.sql'])
    },
    T,
  )

  it(
    'tolerates migrations from a newer build (expand-only makes old code safe)',
    async () => {
      const r = await fresh()
      const one = m('0001_base.sql', 'CREATE TABLE a (id int);')
      const two = m('0002_newer.sql', 'ALTER TABLE a ADD COLUMN b int;')
      await migrate(r, { migrations: [one, two] })
      const res = await migrate(r, { migrations: [one] })
      expect(res.applied).toEqual([])
      expect(res.unknownApplied).toEqual(['0002_newer.sql'])
      expect(res.version).toBe(2)
    },
    T,
  )

  it(
    'concurrent runners apply each migration exactly once',
    async () => {
      const r = await fresh()
      const results = await Promise.all([migrate(r), migrate(r), migrate(r)])
      expect(results.flatMap((x) => x.applied)).toEqual(['0001_init.sql'])
      const [row] = await r.query<{ n: number }>('SELECT count(*)::int AS n FROM xpanel_schema_migrations')
      expect(row?.n).toBe(1)
    },
    T,
  )
})
