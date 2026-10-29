import { spawn } from 'node:child_process'
import { assertDbNameOwned, fail } from '@xpanel/core'
import type { Account, Database, HostAction } from '@xpanel/core'
import { assertPostgresqlRoleName, assertPostgresqlVerifier } from '../../../packages/state/src/pg-state.ts'
import type { StoredPostgresqlUser } from '../../../packages/state/src/pg-state.ts'
import { PSQL_SCRIPT_ARGV } from '../../../packages/os/src/db-engines-command.ts'

/**
 * Reviewed PostgreSQL statements for account databases and login roles. Names are validated `<username>_<suffix>`
 * identifiers (a-z, 0-9, _) and are still double-quoted; literals are single-quoted with quotes doubled. A role's
 * password reaches the server only as its SCRAM-SHA-256 verifier. CREATE DATABASE cannot run in a transaction or a
 * function, so idempotent creation uses psql(1) \gexec; DROP DATABASE ... WITH (FORCE) needs PostgreSQL 13 or later.
 */
export const PG_TRASH_COMMENT_PREFIX = 'xpanel-trash:'
const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`
const database = (username: string, name: unknown): string => assertDbNameOwned(username, name)
const role = (username: string, name: unknown): string => assertPostgresqlRoleName(username, name)
const ifMissing = (create: string, catalog: 'pg_roles' | 'pg_database', column: 'rolname' | 'datname', name: string): string =>
  `SELECT ${literal(create)} WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.${catalog} WHERE ${column} = ${literal(name)})\\gexec`
const terminate = (column: 'usename' | 'datname', name: string): string =>
  `SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE ${column} = ${literal(name)} AND pid <> pg_catalog.pg_backend_pid();`

export const pgDropDatabaseStatements = (username: string, name: string): string[] => [`DROP DATABASE IF EXISTS ${ident(database(username, name))} WITH (FORCE);`]
/** DROP OWNED (run in the postgres database) clears the role's objects there and its privileges on shared objects first. */
export const pgDropRoleStatements = (username: string, name: string): string[] => {
  const r = role(username, name)
  return [`SELECT ${literal('DROP OWNED BY ' + ident(r))} FROM pg_catalog.pg_roles WHERE rolname = ${literal(r)}\\gexec`, `DROP ROLE IF EXISTS ${ident(r)};`]
}

/**
 * Converges one account: roles first (LOGIN only while the account is active), then databases owned by their saved role
 * with CONNECT and TEMPORARY revoked from PUBLIC. A trashed database refuses connections and carries a dated comment;
 * restore reopens it. Termination drops the saved databases, then the roles. Objects xPanel does not save are untouched.
 */
export function postgresqlAccountStatements(account: Pick<Account, 'username' | 'status'>, databases: readonly Database[], users: readonly StoredPostgresqlUser[]): string[] {
  const username = account.username
  if (account.status === 'terminating') return [...databases.flatMap(db => pgDropDatabaseStatements(username, db.name)), ...users.flatMap(user => pgDropRoleStatements(username, user.name))]
  const login = account.status === 'active', out: string[] = []
  for (const user of users) {
    const r = role(username, user.name)
    out.push(ifMissing(`CREATE ROLE ${ident(r)}`, 'pg_roles', 'rolname', r),
      `ALTER ROLE ${ident(r)} WITH ${login ? 'LOGIN' : 'NOLOGIN'} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(assertPostgresqlVerifier(user.authString))};`)
    if (!login) out.push(terminate('usename', r))
  }
  for (const db of databases) {
    const name = database(username, db.name), owner = role(username, db.owner)
    if (!users.some(user => user.name === owner)) return fail('VALIDATION', 'PostgreSQL database owner is not a saved PostgreSQL user', { database: name })
    out.push(ifMissing(`CREATE DATABASE ${ident(name)} OWNER ${ident(owner)}`, 'pg_database', 'datname', name),
      `ALTER DATABASE ${ident(name)} OWNER TO ${ident(owner)};`, `REVOKE ALL ON DATABASE ${ident(name)} FROM PUBLIC;`)
    if (db.trashedAt === null) out.push(`ALTER DATABASE ${ident(name)} WITH ALLOW_CONNECTIONS true;`, `COMMENT ON DATABASE ${ident(name)} IS NULL;`)
    else out.push(`ALTER DATABASE ${ident(name)} WITH ALLOW_CONNECTIONS false;`, `COMMENT ON DATABASE ${ident(name)} IS ${literal(PG_TRASH_COMMENT_PREFIX + new Date(db.trashedAt).toISOString())};`, terminate('datname', name))
  }
  return out
}

export const postgresqlSqlAction = (statements: string[]): HostAction => statements.length ? { kind: 'sql', engine: 'postgresql', statements } : fail('VALIDATION', 'PostgreSQL SQL action has no statements')

/**
 * The script psql reads: one statement per line, printable ASCII, ending in `;` or `\gexec`. A backslash anywhere else
 * would start a psql meta-command (for example `\!`), so it is refused outside quoted literals.
 */
export function postgresqlScript(statements: readonly string[]): string {
  if (!Array.isArray(statements) || statements.length === 0 || statements.length > 100_000) return fail('VALIDATION', 'PostgreSQL statements are required')
  for (const statement of statements) {
    if (typeof statement !== 'string' || statement.length > 4096 || !/^[\x20-\x7e]+$/.test(statement)) return fail('VALIDATION', 'PostgreSQL statements must be single printable lines')
    const body = statement.endsWith('\\gexec') ? statement.slice(0, -6) : statement.endsWith(';') ? statement : fail('VALIDATION', 'PostgreSQL statements must end with ; or \\gexec')
    let quoted = false
    for (const char of body) { if (char === "'") quoted = !quoted; else if (char === '\\' && !quoted) return fail('VALIDATION', 'PostgreSQL statements must not contain psql meta-commands') }
    if (quoted) return fail('VALIDATION', 'PostgreSQL statement has an unterminated literal')
  }
  return statements.join('\n') + '\n'
}

export type PgScriptRun = (argv: readonly string[], stdin: string) => Promise<{ code: number | null; stderr: string }>
const redact = (text: string): string => text.replace(/SCRAM-SHA-256\$[^\s']*/g, '[REDACTED]').replace(/PASSWORD\s+'[^']*'/gi, "PASSWORD '[REDACTED]'").slice(0, 2000).trim()
const spawnScript: PgScriptRun = (argv, stdin) => new Promise((resolve, reject) => {
  const child = spawn(argv[0]!, argv.slice(1), { cwd: '/', stdio: ['pipe', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' }, windowsHide: true })
  let stderr = ''
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { if (stderr.length < 65_536) stderr += chunk })
  child.on('error', error => { clearTimeout(timer); reject(error) })
  child.on('close', code => { clearTimeout(timer); resolve({ code, stderr }) })
  child.stdin.on('error', () => undefined)
  child.stdin.end(stdin, 'utf8')
})

/** SQL runner for the 'postgresql' engine; statement text and verifiers never reach argv or error messages. */
export function createPostgresqlSqlRunner(run: PgScriptRun = spawnScript): (statements: string[]) => Promise<void> {
  return async statements => {
    const script = postgresqlScript(statements)
    let result: Awaited<ReturnType<PgScriptRun>>
    try { result = await run(PSQL_SCRIPT_ARGV, script) } catch { return fail('PRECONDITION_FAILED', 'the PostgreSQL client could not be started') }
    if (result.code === 0) return
    const detail = redact(result.stderr)
    // psql(1) EXIT STATUS: 1 is a fatal client error (runuser exits 1 when the postgres user is missing), 2 a failed
    // server connection, 3 a failed script statement under ON_ERROR_STOP. A killed run has no code and an unknown effect.
    if (result.code === 1 || result.code === 2) return fail('PRECONDITION_FAILED', 'PostgreSQL is not available' + (detail ? ': ' + detail : ''))
    if (result.code === null) return fail('SERVICE_UNAVAILABLE', 'PostgreSQL statements timed out', { unknownOutcome: true, verificationRequired: true })
    return fail('CONFIG_TEST_FAILED', 'PostgreSQL statements failed' + (detail ? ': ' + detail : ''), { exitCode: result.code })
  }
}

type EngineRunner = (engine: 'mariadb' | 'postgresql', statements: string[]) => Promise<void>
/** Sends 'postgresql' actions to the PostgreSQL runner and every other engine to the existing runner. */
export const withPostgresqlSqlRunner = (other: EngineRunner, postgresql: (statements: string[]) => Promise<void> = createPostgresqlSqlRunner()): EngineRunner =>
  (engine, statements) => engine === 'postgresql' ? postgresql(statements) : other(engine, statements)
