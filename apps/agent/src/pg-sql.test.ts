import { describe, expect, it } from 'vitest'
import type { Database } from '@xpanel/core'
import { postgresqlScramVerifier } from '../../../packages/state/src/pg-state.ts'
import type { StoredPostgresqlUser } from '../../../packages/state/src/pg-state.ts'
import { PSQL_SCRIPT_ARGV } from '../../../packages/os/src/db-engines-command.ts'
import { createPostgresqlSqlRunner, pgDropDatabaseStatements, pgDropRoleStatements, postgresqlAccountStatements, postgresqlScript, postgresqlSqlAction, withPostgresqlSqlRunner } from './pg-sql.ts'

const accountId = '11111111-1111-4111-8111-111111111111'
const verifier = postgresqlScramVerifier('correct horse battery', Buffer.alloc(16, 1))
const user: StoredPostgresqlUser = { id: '22222222-2222-4222-8222-222222222222', accountId, name: 'alice_app', authPlugin: 'scram-sha-256', authString: verifier }
const db = (over: Partial<Database> = {}): Database => ({ id: '33333333-3333-4333-8333-333333333333', accountId, engine: 'postgresql', name: 'alice_shop', owner: 'alice_app', trashedAt: null, ...over })

describe('PostgreSQL account statements', () => {
  it('creates roles before their databases, revokes PUBLIC access and keeps the password out of the text', () => {
    const statements = postgresqlAccountStatements({ username: 'alice', status: 'active' }, [db()], [user])
    expect(statements).toEqual([
      `SELECT 'CREATE ROLE "alice_app"' WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'alice_app')\\gexec`,
      `ALTER ROLE "alice_app" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${verifier}';`,
      `SELECT 'CREATE DATABASE "alice_shop" OWNER "alice_app"' WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = 'alice_shop')\\gexec`,
      'ALTER DATABASE "alice_shop" OWNER TO "alice_app";', 'REVOKE ALL ON DATABASE "alice_shop" FROM PUBLIC;',
      'ALTER DATABASE "alice_shop" WITH ALLOW_CONNECTIONS true;', 'COMMENT ON DATABASE "alice_shop" IS NULL;',
    ])
    expect(statements.join('\n')).not.toContain('correct horse')
    expect(postgresqlScript(statements).split('\n')).toHaveLength(statements.length + 1)
  })
  it('closes trashed databases and suspended roles, and drops saved objects only on termination', () => {
    const trashed = postgresqlAccountStatements({ username: 'alice', status: 'suspended' }, [db({ trashedAt: '2026-10-28T10:00:00.000Z' })], [user])
    expect(trashed).toContain(`ALTER ROLE "alice_app" WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${verifier}';`)
    expect(trashed).toContain(`SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE usename = 'alice_app' AND pid <> pg_catalog.pg_backend_pid();`)
    expect(trashed).toContain('ALTER DATABASE "alice_shop" WITH ALLOW_CONNECTIONS false;')
    expect(trashed).toContain(`COMMENT ON DATABASE "alice_shop" IS 'xpanel-trash:2026-10-28T10:00:00.000Z';`)
    expect(trashed.some(statement => statement.startsWith('DROP'))).toBe(false)
    expect(postgresqlAccountStatements({ username: 'alice', status: 'terminating' }, [db()], [user])).toEqual([
      'DROP DATABASE IF EXISTS "alice_shop" WITH (FORCE);',
      `SELECT 'DROP OWNED BY "alice_app"' FROM pg_catalog.pg_roles WHERE rolname = 'alice_app'\\gexec`, 'DROP ROLE IF EXISTS "alice_app";',
    ])
    expect(pgDropDatabaseStatements('alice', 'alice_shop')).toEqual(['DROP DATABASE IF EXISTS "alice_shop" WITH (FORCE);'])
    expect(pgDropRoleStatements('alice', 'alice_app')).toHaveLength(2)
  })
  it('refuses names outside the account, unknown owners and non-verifier credentials', () => {
    expect(() => postgresqlAccountStatements({ username: 'alice', status: 'active' }, [db({ name: 'bob_shop' })], [user])).toThrow()
    expect(() => postgresqlAccountStatements({ username: 'alice', status: 'active' }, [db({ owner: 'alice_other' })], [user])).toThrow('owner')
    expect(() => postgresqlAccountStatements({ username: 'alice', status: 'active' }, [], [{ ...user, authString: "x'; DROP ROLE postgres; --" }])).toThrow()
    expect(() => pgDropDatabaseStatements('alice', 'alice_x"; DROP DATABASE postgres; --')).toThrow()
    expect(() => postgresqlSqlAction([])).toThrow()
    expect(postgresqlSqlAction(['SELECT 1;'])).toEqual({ kind: 'sql', engine: 'postgresql', statements: ['SELECT 1;'] })
  })
})

describe('PostgreSQL script runner', () => {
  it('refuses meta-commands, multi-line statements and unterminated literals', () => {
    for (const statements of [[], ['SELECT 1'], ['\\! id;'], ['SELECT 1; \\o /tmp/x;'], ['SELECT 1;\nDROP DATABASE x;'], ["SELECT 'open;"], ['SELECT é;']]) expect(() => postgresqlScript(statements)).toThrow()
    expect(postgresqlScript(["SELECT 'a\\b';", "SELECT 'x' WHERE true\\gexec"])).toBe("SELECT 'a\\b';\nSELECT 'x' WHERE true\\gexec\n")
  })
  it('feeds the script on stdin to the reviewed psql argv and reports exit status without secrets', async () => {
    const calls: { argv: readonly string[]; stdin: string }[] = []
    const ok = createPostgresqlSqlRunner(async (argv, stdin) => { calls.push({ argv, stdin }); return { code: 0, stderr: '' } })
    await ok(['SELECT 1;'])
    expect(calls).toEqual([{ argv: PSQL_SCRIPT_ARGV, stdin: 'SELECT 1;\n' }])
    const failing = (code: number | null) => createPostgresqlSqlRunner(async () => ({ code, stderr: `psql:<stdin>:2: ERROR: near PASSWORD '${verifier}'` }))
    await expect(failing(2)(['SELECT 1;'])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(failing(3)(['SELECT 1;'])).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
    await expect(failing(null)(['SELECT 1;'])).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    await failing(3)(['SELECT 1;']).catch((error: Error) => { expect(error.message).not.toContain('SCRAM'); expect(error.message).toContain('[REDACTED]') })
    await expect(createPostgresqlSqlRunner(async () => { throw new Error('ENOENT') })(['SELECT 1;'])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('routes only the postgresql engine to the PostgreSQL runner', async () => {
    const seen: string[] = []
    const runner = withPostgresqlSqlRunner(async engine => { seen.push(engine) }, async statements => { seen.push('pg:' + statements.length) })
    await runner('mariadb', ['SELECT 1']); await runner('postgresql', ['SELECT 1;', 'SELECT 2;'])
    expect(seen).toEqual(['mariadb', 'pg:2'])
  })
})
