import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { DrizzleQueryError } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { XpanelError, isXpanelError } from '@xpanel/core'
import { createDb, type DbHandle } from './client.ts'
import { currentSchemaVersion, migrate } from './migrate.ts'
import { toXpanelError, withPgErrors } from './pg-errors.ts'
import { createAccount, getAccount } from './repos/accounts.ts'
import { findPrincipalByUsername, getPrincipal, setTotpSecret } from './repos/principals.ts'
import { createReseller } from './repos/resellers.ts'
import { pgRunner } from './sql-runner.ts'
import { ARGON2, accountInput, seedPlan } from './testing.ts'

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'ok'
  } catch (e) {
    return isXpanelError(e) ? e.code : `raw:${(e as Error).message}`
  }
}

describe('createDb', () => {
  it('validates the url and options without echoing the url, and connects lazily', async () => {
    for (const bad of ['mysql://u:secret@h/db', 'postgres://u:secret@h/db name', '', 42 as never]) {
      try {
        createDb(bad)
        expect.unreachable()
      } catch (e) {
        expect(isXpanelError(e) && e.code).toBe('VALIDATION')
        expect(JSON.stringify(e) + (e as Error).message).not.toContain('secret')
      }
    }
    for (const opts of [{ max: 0 }, { max: 21 }, { max: 1.5 }, { applicationName: 'x y' }, { statementTimeoutMs: -1 }, { connectionTimeoutMs: 0 }]) {
      expect(await codeOf(Promise.resolve().then(() => createDb('postgres://xpanel:secret@127.0.0.1:1/xpanel', opts))), JSON.stringify(opts)).toBe('VALIDATION')
    }
    const h = createDb('postgres://xpanel:secret@127.0.0.1:1/xpanel', { max: 1 })
    expect(typeof h.db.select).toBe('function')
    await h.close()
  })

  it('reports an unreachable server without the query parameters', async () => {
    const h = createDb('postgres://xpanel:secret@127.0.0.1:1/xpanel', { max: 1, connectionTimeoutMs: 2000 })
    try {
      const err = await withPgErrors(() => h.db.execute(`SELECT 'p4ssw0rd-param'`)).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect(`${(err as Error).message} ${JSON.stringify(err)}`).not.toMatch(/p4ssw0rd|secret/)
    } finally {
      await h.close()
    }
  })
})

interface Call {
  on: 'pool' | 'client'
  text: string
}

const fakePool = (opts: { failOn?: string } = {}) => {
  const calls: Call[] = []
  const released: unknown[] = []
  const answer = (on: Call['on']) => async (text: string) => {
    calls.push({ on, text })
    if (opts.failOn !== undefined && text === opts.failOn) throw new Error(`fail at ${text}`)
    return { rows: [{ ok: 1 }] }
  }
  const pool = {
    query: answer('pool'),
    connect: async () => ({ query: answer('client'), release: (e?: unknown) => released.push(e) }),
  }
  return { pool: pool as never, calls, released }
}

describe('pgRunner', () => {
  it('runs queries on the pool and a transaction on one client', async () => {
    const { pool, calls, released } = fakePool()
    const r = pgRunner(pool)
    expect(await r.query('SELECT $1', [1])).toEqual([{ ok: 1 }])
    await r.exec('SELECT 1; SELECT 2')
    expect(await r.transaction(async (tx) => (await tx.query('SELECT 3')).length)).toBe(1)
    expect(calls).toEqual([
      { on: 'pool', text: 'SELECT $1' },
      { on: 'pool', text: 'SELECT 1; SELECT 2' },
      { on: 'client', text: 'BEGIN' },
      { on: 'client', text: 'SELECT 3' },
      { on: 'client', text: 'COMMIT' },
    ])
    expect(released).toEqual([undefined])
  })

  it('rolls back when the body throws and refuses nested transactions', async () => {
    const { pool, calls, released } = fakePool()
    const r = pgRunner(pool)
    await expect(r.transaction(async (tx) => tx.transaction(async () => 1))).rejects.toThrow(/nested/)
    expect(calls.map((c) => c.text)).toEqual(['BEGIN', 'ROLLBACK'])
    expect(released).toEqual([undefined])
  })

  it('destroys the client when even ROLLBACK fails', async () => {
    const { pool, released } = fakePool({ failOn: 'ROLLBACK' })
    const r = pgRunner(pool)
    await expect(
      r.transaction(async () => {
        throw new Error('body failed')
      }),
    ).rejects.toThrow('body failed')
    expect(released).toHaveLength(1)
    expect(released[0]).toBeInstanceOf(Error)
  })
})

describe('node-postgres against a real server protocol (PGlite over a socket)', () => {
  let pglite: PGlite
  let server: PGLiteSocketServer
  let h: DbHandle

  beforeAll(async () => {
    pglite = new PGlite()
    server = new PGLiteSocketServer({ db: pglite, port: 0, maxConnections: 2 })
    await server.start()
    const port = server.getServerConn().split(':')[1]
    // one pooled connection: PGlite is a single backend, so concurrent sessions would share a transaction
    h = createDb(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1, applicationName: 'xpanel-test' })
  }, 120_000)

  afterAll(async () => {
    await h?.close()
    await server?.stop()
    await pglite?.close()
  })

  it('migrates through pgRunner, idempotently', async () => {
    const first = await migrate(h.runner)
    expect(first.applied).toEqual(['0001_init.sql'])
    expect((await migrate(h.runner)).applied).toEqual([])
    expect(await currentSchemaVersion(h.runner)).toBe(1)
  }, 120_000)

  it('maps int8, inet, inet[], bytea and timestamptz through the driver', async () => {
    const plan = await seedPlan(h.db)
    expect(plan.resources.diskMb).toBe(10_240)
    expect(plan.resources.bandwidthMbMonth).toBe('unlimited')
    const reseller = await createReseller(h.db, {
      username: 'netres',
      passwordHash: ARGON2,
      acl: ['create-account'],
      maxAccounts: 5,
      totalDiskMb: 'unlimited',
      totalBandwidthMb: 9_007_199_254_740_991,
      oversell: false,
      nameservers: ['ns1.netres.example'],
      delegatedIps: ['203.0.113.4', '2001:DB8::4'],
    })
    expect(reseller.totalBandwidthMb).toBe(Number.MAX_SAFE_INTEGER)
    expect(reseller.delegatedIps).toEqual(['203.0.113.4', '2001:db8::4'])
    const acc = await createAccount(h.db, accountInput(plan.id, { username: 'wireuser', primaryDomain: 'wire.example.net' }))
    expect(acc).toMatchObject({ uid: expect.any(Number), ipv4: '192.0.2.10', home: '/home/wireuser' })
    expect(Number.isNaN(Date.parse(acc.createdAt))).toBe(false)
    expect(await getAccount(h.db, acc.id)).toEqual(acc)
    const login = await findPrincipalByUsername(h.db, 'wireuser')
    const sealed = Uint8Array.from({ length: 40 }, (_, i) => 255 - i)
    await setTotpSecret(h.db, login?.id as string, sealed)
    expect([...((await getPrincipal(h.db, login?.id as string))?.totpSecretEnc ?? [])]).toEqual([...sealed])
    const [raw] = await h.query<{ n: string }>('SELECT count(*) AS n FROM accounts')
    expect(raw?.n).toBe('1') // raw rows stay driver-native
  })

  it('turns driver errors into XpanelErrors and rolls the transaction back', async () => {
    const plan = await seedPlan(h.db)
    expect(await codeOf(createAccount(h.db, accountInput(plan.id, { username: 'wireuser' })))).toBe('CONFLICT')
    expect(await codeOf(createAccount(h.db, accountInput(plan.id, { primaryDomain: 'wire.example.net' })))).toBe('CONFLICT')
    // the pool's single connection is usable again
    expect((await h.query<{ one: number }>('SELECT 1 AS one'))[0]?.one).toBe(1)
  })
})

describe('database error mapping', () => {
  const pgErr = (code: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error((extra.message as string) ?? 'boom'), { code, ...extra })

  it('unwraps DrizzleQueryError and never leaks query parameters', () => {
    const secret = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$c2VjcmV0'
    const wrapped = new DrizzleQueryError('insert into principals ...', [secret], pgErr('23505', {
      constraint: 'principals_username_key',
      table: 'principals',
      detail: `Key (password_hash)=(${secret}) already exists.`,
    }))
    const x = toXpanelError(wrapped)
    expect(isXpanelError(x) && x.code).toBe('CONFLICT')
    expect(`${(x as Error).message} ${JSON.stringify(x)} ${JSON.stringify((x as XpanelError).detail)}`).not.toContain('c2VjcmV0')
    expect((x as XpanelError).detail).toMatchObject({ constraint: 'principals_username_key', pgCode: '23505' })
  })

  it('strips the query and parameters when the cause is not a Postgres error', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })
    const x = toXpanelError(new DrizzleQueryError('update principals set password_hash = $1', ['$argon2id$secret'], cause)) as Error & { code?: string }
    expect(x.message).toBe('database query failed: connect ECONNREFUSED 127.0.0.1:5432')
    expect(x.code).toBe('ECONNREFUSED')
    expect(`${x.message} ${JSON.stringify(x)} ${String(x.stack)}`).not.toMatch(/argon2id|password_hash/)
    const bare = toXpanelError(new DrizzleQueryError('select $1', ['s3cret'], undefined as never)) as Error
    expect(bare.message).toBe('database query failed: no cause reported')
  })

  it.each([
    ['23514', 'VALIDATION'],
    ['23502', 'VALIDATION'],
    ['22P02', 'VALIDATION'],
    ['42501', 'FORBIDDEN'],
    ['40001', 'CONFLICT'],
    ['40P01', 'CONFLICT'],
    ['2200H', 'LIMIT_EXCEEDED'],
  ])('maps SQLSTATE %s to %s', (sqlstate, expected) => {
    const x = toXpanelError(pgErr(sqlstate))
    expect(isXpanelError(x) && x.code).toBe(expected)
  })

  it('tells a missing reference from a row still in use', () => {
    const insert = toXpanelError(pgErr('23503', { message: 'insert or update on table "accounts" violates foreign key constraint "accounts_plan_id_fkey"' }))
    const del = toXpanelError(pgErr('23503', { message: 'update or delete on table "plans" violates foreign key constraint "accounts_plan_id_fkey" on table "accounts"' }))
    expect([(insert as XpanelError).code, (del as XpanelError).code]).toEqual(['NOT_FOUND', 'CONFLICT'])
  })

  it('keeps unexpected SQLSTATEs as plain 500-style errors and passes others through', async () => {
    const x = toXpanelError(new DrizzleQueryError('select', ['p4ss'], pgErr('42601', { message: 'syntax error at or near "x"' })))
    expect(isXpanelError(x)).toBe(false)
    expect((x as Error).message).toBe('database error 42601: syntax error at or near "x"')
    const plain = new Error('network down')
    expect(toXpanelError(plain)).toBe(plain)
    const own = new XpanelError('NOT_FOUND', 'x')
    expect(toXpanelError(own)).toBe(own)
    await expect(withPgErrors(async () => Promise.reject(pgErr('23505')))).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await withPgErrors(async () => 7)).toBe(7)
  })
})
