import { EventEmitter } from 'node:events'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { afterEach, describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import type { Db } from './client.ts'
import { backoffDelay, DESIRED_STATE_CHANNEL, listenDesiredState, type ListenerClient, type ReconcileReason } from './listen.ts'
import { loadMigrations, migrate } from './migrate.ts'
import { createAccount } from './repos/accounts.ts'
import { schema } from './schema.ts'
import { pgliteRunner } from './sql-runner.ts'
import { accountInput, seedPlan } from './testing.ts'

const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not reached in time')
    await new Promise((r) => setTimeout(r, 5))
  }
}

class FakeClient extends EventEmitter implements ListenerClient {
  queries: string[] = []
  ended = false
  readonly failConnect: boolean
  constructor(failConnect: boolean) {
    super()
    this.failConnect = failConnect
  }
  async connect(): Promise<void> {
    if (this.failConnect) throw new Error('ECONNREFUSED')
  }
  async query(text: string): Promise<void> {
    this.queries.push(text)
  }
  async end(): Promise<void> {
    this.ended = true
  }
}

describe('backoffDelay', () => {
  it('doubles up to the cap with equal jitter, never collapsing to zero', () => {
    expect([0, 1, 2, 3, 10].map((a) => backoffDelay(a, 100, 1000, () => 0))).toEqual([50, 100, 200, 400, 500])
    expect([0, 1, 2, 3, 10].map((a) => backoffDelay(a, 100, 1000, () => 0.999999))).toEqual([0, 1, 2, 3, 10].map((a) => Math.min(1000, 100 * 2 ** a) * 0.9999995))
    expect(backoffDelay(10_000, 100, 1000, () => 2)).toBe(1000)
    expect(backoffDelay(0, 100, 1000, () => -1)).toBe(50)
  })
})

describe('listenDesiredState with an injected client', () => {
  const opened: { close(): Promise<void> }[] = []
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((l) => l.close()))
  })

  it('LISTENs, reconciles fully, forwards valid hints and reconnects after a failure', async () => {
    const clients: FakeClient[] = []
    const failFirst = [false, true, true, false]
    const reasons: ReconcileReason[] = []
    const hints: string[] = []
    const errors: unknown[] = []
    const l = listenDesiredState({
      client: () => {
        const c = new FakeClient(failFirst[clients.length] ?? false)
        clients.push(c)
        return c
      },
      onReconcile: (r) => {
        reasons.push(r)
      },
      onHint: (t) => hints.push(t),
      onError: (e) => errors.push(e),
      initialDelayMs: 1,
      maxDelayMs: 4,
      random: () => 0,
    })
    opened.push(l)
    await until(() => reasons.length === 1)
    expect(reasons).toEqual(['connected'])
    expect(clients[0]?.queries).toEqual([`LISTEN ${DESIRED_STATE_CHANNEL}`])

    const c0 = clients[0] as FakeClient
    c0.emit('notification', { channel: DESIRED_STATE_CHANNEL, payload: 'domains' })
    c0.emit('notification', { channel: 'other', payload: 'accounts' })
    c0.emit('notification', { channel: DESIRED_STATE_CHANNEL, payload: 'x; DROP TABLE y' })
    c0.emit('notification', { channel: DESIRED_STATE_CHANNEL })
    expect(hints).toEqual(['domains'])

    c0.emit('error', new Error('terminating connection due to administrator command'))
    await until(() => reasons.length === 2)
    expect(reasons).toEqual(['connected', 'reconnected'])
    expect(c0.ended).toBe(true)
    // two refused connects in between, each reported, then a fresh LISTEN
    expect(clients).toHaveLength(4)
    expect(errors.map((e) => (e as Error).message)).toEqual(['terminating connection due to administrator command', 'ECONNREFUSED', 'ECONNREFUSED'])
    expect(clients[3]?.queries).toEqual([`LISTEN ${DESIRED_STATE_CHANNEL}`])
    // a late event from the discarded client changes nothing
    c0.emit('notification', { channel: DESIRED_STATE_CHANNEL, payload: 'plans' })
    expect(hints).toEqual(['domains'])
  })

  it('treats a clean end like a failure, reports reconcile errors and stops on close', async () => {
    const clients: FakeClient[] = []
    const errors: string[] = []
    let reconciles = 0
    const l = listenDesiredState({
      client: () => {
        const c = new FakeClient(false)
        clients.push(c)
        return c
      },
      onReconcile: () => {
        reconciles++
        throw new Error('reconcile failed')
      },
      onError: (e) => errors.push((e as Error).message),
      initialDelayMs: 1,
      maxDelayMs: 2,
      random: () => 0,
    })
    await until(() => reconciles === 1)
    ;(clients[0] as FakeClient).emit('end')
    await until(() => reconciles === 2)
    expect(errors).toEqual(['reconcile failed', 'reconcile failed'])
    await l.close()
    expect(clients[1]?.ended).toBe(true)
    ;(clients[1] as FakeClient).emit('error', new Error('after close'))
    await new Promise((r) => setTimeout(r, 20))
    expect(clients).toHaveLength(2)
    expect(errors).toHaveLength(2)
  })

  it('validates its options', () => {
    const bad = [
      { onReconcile: () => {} },
      { url: 'mysql://x', onReconcile: () => {} },
      { url: 'postgres://u@h/db', onReconcile: () => {}, initialDelayMs: 0 },
      { url: 'postgres://u@h/db', onReconcile: undefined as never },
    ]
    for (const opts of bad) {
      try {
        listenDesiredState(opts)
        expect.unreachable()
      } catch (e) {
        expect(isXpanelError(e) && e.code).toBe('VALIDATION')
      }
    }
  })
})

describe('listenDesiredState over a real pg.Client (PGlite socket)', () => {
  it('connects, reconciles, and reconnects with a full reconcile after the server restarts', async () => {
    const db = new PGlite()
    let server = new PGLiteSocketServer({ db, port: 0, maxConnections: 2 })
    await server.start()
    const port = Number(server.getServerConn().split(':')[1])
    const reasons: ReconcileReason[] = []
    const l = listenDesiredState({
      url: `postgres://postgres@127.0.0.1:${port}/postgres`,
      onReconcile: (r) => {
        reasons.push(r)
      },
      initialDelayMs: 20,
      maxDelayMs: 100,
    })
    try {
      await until(() => reasons.length === 1)
      await server.stop()
      server = new PGLiteSocketServer({ db, port, maxConnections: 2 })
      await server.start()
      await until(() => reasons.length === 2, 10_000)
      expect(reasons).toEqual(['connected', 'reconnected'])
    } finally {
      await l.close()
      await server.stop()
      await db.close()
    }
  }, 30_000)
})

describe('NOTIFY triggers', () => {
  it('fire inside the writing transaction: on commit, once per table, never on rollback', async () => {
    const pg = new PGlite()
    try {
      await migrate(pgliteRunner(pg))
      const db = drizzlePglite({ client: pg, schema }) as unknown as Db
      const got: string[] = []
      const unlisten = await pg.listen(DESIRED_STATE_CHANNEL, (payload) => {
        got.push(payload)
      })
      const plan = await seedPlan(db)
      await until(() => got.length === 1)
      expect(got).toEqual(['plans']) // feature lists are panel-only

      got.length = 0
      await createAccount(db, accountInput(plan.id))
      await until(() => got.length === 3)
      expect([...got].sort()).toEqual(['accounts', 'domains', 'principals'])

      got.length = 0
      await pg.transaction(async (tx) => {
        await tx.query(`INSERT INTO firewall_rules (kind, action, protocol, port, sort_order) VALUES ('port', 'accept', 'tcp', '22', 0)`)
        await tx.query(`INSERT INTO firewall_rules (kind, action, protocol, port, sort_order) VALUES ('port', 'accept', 'tcp', '80', 1), ('port', 'accept', 'tcp', '443', 2)`)
        expect(got).toEqual([]) // nothing before commit
      })
      await until(() => got.length === 1)
      expect(got).toEqual(['firewall_rules']) // identical notifications of one transaction fold into one

      got.length = 0
      await pg.transaction(async (tx) => {
        await tx.query(`UPDATE plans SET dedicated_ip = true`)
        await tx.rollback()
      })
      await pg.query(`INSERT INTO audit_log (actor, action, target, outcome) VALUES ('root', 'x.y', 't', 'ok')`)
      await pg.query(`INSERT INTO login_attempts (username, ip, success) VALUES ('a', '192.0.2.1', false)`)
      await pg.query(`UPDATE plans SET dedicated_ip = false`)
      await until(() => got.length === 1)
      expect(got).toEqual(['plans'])
      await unlisten()
    } finally {
      await pg.close()
    }
  }, 120_000)

  it('cover every desired-state table and no panel-only one', async () => {
    const [init] = await loadMigrations()
    const sql = init?.sql ?? ''
    const notified = [...sql.matchAll(/CREATE TRIGGER \w+_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON (\w+) FOR EACH STATEMENT/g)].map((m) => m[1])
    expect(notified).toEqual(
      expect.arrayContaining(['accounts', 'domains', 'plans', 'firewall_rules', 'firewall_prefix_lists', 'server_settings', 'service_users', 'databases', 'database_grants', 'dns_records', 'cron_jobs', 'certificates']),
    )
    for (const quiet of ['sessions', 'api_tokens', 'login_attempts', 'lockouts', 'audit_log', 'config_generations', 'uid_allocator', 'feature_lists']) {
      expect(notified).not.toContain(quiet)
    }
    expect(sql).toContain(`pg_notify('${DESIRED_STATE_CHANNEL}', TG_TABLE_NAME)`)
  })
})
