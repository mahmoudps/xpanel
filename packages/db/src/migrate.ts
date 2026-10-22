import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fail } from '@xpanel/core'
import { LOCKS } from './locks.ts'
import { splitStatements, stripComments } from './sql-lexer.ts'
import type { SqlRunner } from './sql-runner.ts'

export const MIGRATIONS_DIR = join(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), 'migrations')

export const MIGRATIONS_TABLE = 'xpanel_schema_migrations'


const FILE_NAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/

export interface Migration {
  version: number
  /** file name, e.g. 0001_init.sql */
  name: string
  sql: string
  checksum: string
  /** *_contract.sql: allowed to drop, retype and rename (cold path only) */
  contract: boolean
}

export interface MigrateResult {
  applied: string[]
  alreadyApplied: string[]
  /** recorded in the database but absent from this build (newer schema; tolerated because migrations are expand-only) */
  unknownApplied: string[]
  version: number
}

export interface MigrateOptions {
  /** defaults to the files in MIGRATIONS_DIR */
  migrations?: Migration[]
  dir?: string
}

/** Line endings and a BOM are normalised so a checkout on Windows hashes the same as on Linux. */
const normalise = (sql: string): string => sql.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')

export const checksumOf = (sql: string): string => createHash('sha256').update(normalise(sql), 'utf8').digest('hex')

export const parseMigration = (name: string, sql: string): Migration => {
  const m = FILE_NAME.exec(name)
  if (!m) return fail('VALIDATION', `migration file name must look like 0001_name.sql: ${name}`)
  const version = Number(m[1])
  if (version < 1) return fail('VALIDATION', `migration numbers start at 0001: ${name}`)
  return { version, name, sql: normalise(sql), checksum: checksumOf(sql), contract: (m[2] as string).endsWith('_contract') || m[2] === 'contract' }
}

/** Versions must be 1..n without gaps or duplicates. */
export const assertSequence = (migrations: readonly Migration[]): void => {
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  sorted.forEach((m, i) => {
    if (m.version !== i + 1) {
      fail('VALIDATION', `migration sequence broken at ${m.name}: expected ${String(i + 1).padStart(4, '0')}`, {
        name: m.name,
      })
    }
  })
}

export const loadMigrations = async (dir: string = MIGRATIONS_DIR): Promise<Migration[]> => {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const migrations = await Promise.all(files.map(async (f) => parseMigration(f, await readFile(join(dir, f), 'utf8'))))
  assertSequence(migrations)
  return migrations.sort((a, b) => a.version - b.version)
}

const EXPAND_ONLY_RULES: { what: string; re: RegExp }[] = [
  { what: 'DROP TABLE', re: /\bDROP\s+TABLE\b/i },
  { what: 'DROP SCHEMA', re: /\bDROP\s+SCHEMA\b/i },
  { what: 'DROP COLUMN', re: /\bDROP\s+COLUMN\b/i },
  {
    what: 'ALTER COLUMN ... TYPE',
    re: /\bALTER\s+(?:COLUMN\s+)?(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)\s+(?:SET\s+DATA\s+)?TYPE\b/i,
  },
  { what: 'RENAME', re: /\bRENAME\b/i },
  // data and objects the running (older) version may still read
  { what: 'DROP <view|sequence|type|domain|extension|database|owned>', re: /\bDROP\s+(?:MATERIALIZED\s+VIEW|VIEW|SEQUENCE|TYPE|DOMAIN|EXTENSION|DATABASE|OWNED)\b/i },
  // the running version may still insert rows without the column
  { what: 'SET NOT NULL', re: /\bSET\s+NOT\s+NULL\b/i },
]

const ALTER_TABLE = /^ALTER\s+TABLE\b/i
// ALTER TABLE t DROP c (COLUMN is optional in the grammar)
const IMPLICIT_DROP_COLUMN = /\bDROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\b|IDENTITY\b|EXPRESSION\b|COLUMN\b)\S/i
const TRANSACTION_CONTROL = /^(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|SAVEPOINT|RELEASE|END|ABORT)\b/i

/**
 * Lists why a migration may not run. Comments are ignored; string literals and
 * function bodies are scanned, so EXECUTE 'DROP TABLE ...' is caught too.
 */
export const migrationViolations = (m: Pick<Migration, 'name' | 'sql' | 'contract'>): string[] => {
  let code: string
  let statements: string[]
  try {
    code = stripComments(m.sql)
    statements = splitStatements(m.sql)
  } catch (e) {
    return [`unparseable SQL (${(e as Error).message})`]
  }
  const found: string[] = []
  for (const st of statements) {
    if (TRANSACTION_CONTROL.test(st)) found.push('transaction control (the runner wraps each migration in a transaction)')
    if (/\bCONCURRENTLY\b/i.test(st)) found.push('CONCURRENTLY (cannot run inside a transaction)')
  }
  if (!m.contract) {
    for (const rule of EXPAND_ONLY_RULES) if (rule.re.test(code)) found.push(rule.what)
    for (const st of statements) {
      if (/^TRUNCATE\b/i.test(st)) found.push('TRUNCATE')
      if (ALTER_TABLE.test(st) && IMPLICIT_DROP_COLUMN.test(st)) found.push('ALTER TABLE ... DROP <column>')
    }
  }
  return [...new Set(found)]
}

export const assertMigrationAllowed = (m: Migration): void => {
  const v = migrationViolations(m)
  if (v.length > 0) {
    fail(
      'VALIDATION',
      m.contract
        ? `migration ${m.name} is not runnable: ${v.join(', ')}`
        : `migration ${m.name} is expand-only but contains: ${v.join(', ')}; move it to a *_contract.sql migration`,
      { name: m.name, violations: v },
    )
  }
}

const BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  version integer PRIMARY KEY CHECK (version > 0),
  name text NOT NULL UNIQUE,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  execution_ms integer NOT NULL DEFAULT 0 CHECK (execution_ms >= 0)
)`

interface AppliedRow {
  version: number
  name: string
  checksum: string
  [k: string]: unknown
}

/** Serialises concurrent runners (API and agent starting together). */
const lock = (tx: SqlRunner) => tx.query(`SELECT pg_advisory_xact_lock(${LOCKS.migrations}::bigint)`)

const readApplied = (tx: SqlRunner): Promise<AppliedRow[]> =>
  tx.query<AppliedRow>(`SELECT version, name, checksum FROM ${MIGRATIONS_TABLE} ORDER BY version`)

const assertUnchanged = (row: AppliedRow, m: Migration | undefined): void => {
  if (!m) return
  if (row.name !== m.name) {
    fail('PRECONDITION_FAILED', `migration ${String(row.version).padStart(4, '0')} was applied as ${row.name} but this build has ${m.name}`, {
      version: row.version,
    })
  }
  if (row.checksum !== m.checksum) {
    fail('PRECONDITION_FAILED', `applied migration ${m.name} was modified after it ran (checksum mismatch); add a new migration instead`, {
      name: m.name,
      expected: row.checksum,
      actual: m.checksum,
    })
  }
}

/**
 * Applies pending migrations in order, each in its own transaction, and records
 * name + sha256. A second run is a no-op. Refuses to start when an applied file
 * changed or a pending one breaks the expand-only rule.
 */
export const migrate = async (runner: SqlRunner, opts: MigrateOptions = {}): Promise<MigrateResult> => {
  const migrations = [...(opts.migrations ?? (await loadMigrations(opts.dir)))].sort((a, b) => a.version - b.version)
  assertSequence(migrations)

  await runner.transaction(async (tx) => {
    await lock(tx)
    await tx.exec(BOOTSTRAP)
  })

  const byVersion = new Map(migrations.map((m) => [m.version, m]))
  const appliedRows = await readApplied(runner)
  for (const row of appliedRows) assertUnchanged(row, byVersion.get(row.version))

  const appliedVersions = new Set(appliedRows.map((r) => r.version))
  const pending = migrations.filter((m) => !appliedVersions.has(m.version))
  for (const m of pending) assertMigrationAllowed(m)

  const applied: string[] = []
  for (const m of pending) {
    const ran = await runner.transaction(async (tx) => {
      await lock(tx)
      const [existing] = await tx.query<AppliedRow>(`SELECT version, name, checksum FROM ${MIGRATIONS_TABLE} WHERE version = $1`, [m.version])
      if (existing) {
        assertUnchanged(existing, m)
        return false
      }
      const started = performance.now()
      await tx.exec(m.sql)
      await tx.query(`INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)`, [
        m.version,
        m.name,
        m.checksum,
        Math.round(performance.now() - started),
      ])
      return true
    })
    if (ran) applied.push(m.name)
  }

  const known = new Set(migrations.map((m) => m.version))
  return {
    applied,
    alreadyApplied: appliedRows.filter((r) => known.has(r.version)).map((r) => r.name),
    unknownApplied: appliedRows.filter((r) => !known.has(r.version)).map((r) => r.name),
    version: await currentSchemaVersion(runner),
  }
}

/** Highest applied migration number; 0 for an empty database. */
export const currentSchemaVersion = async (runner: SqlRunner): Promise<number> => {
  const [reg] = await runner.query<{ t: string | null }>(`SELECT to_regclass('${MIGRATIONS_TABLE}')::text AS t`)
  if (!reg?.t) return 0
  const [row] = await runner.query<{ v: number | string }>(`SELECT coalesce(max(version), 0) AS v FROM ${MIGRATIONS_TABLE}`)
  return Number(row?.v ?? 0)
}

/** Highest migration number shipped with this build. */
export const latestSchemaVersion = (migrations: readonly Migration[]): number =>
  migrations.reduce((max, m) => Math.max(max, m.version), 0)
