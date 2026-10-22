import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { createTestDb, type TestDbHandle } from './client.ts'
import { ALL_STRICT_TABLES } from './schema.ts'
import { toXpanelError } from './sqlite-errors.ts'
import { ARGON2, sha } from './testing.ts'

let h: TestDbHandle

beforeAll(async () => {
  h = await createTestDb()
})

afterAll(async () => {
  await h?.close()
})

const sqlCode = async (text: string, params: unknown[] = [], on: TestDbHandle = h): Promise<string> => {
  try {
    await on.query(text, params)
    return 'ok'
  } catch (e) {
    const x = toXpanelError(e)
    return isXpanelError(x) ? x.code : `raw:${(e as Error).message}`
  }
}

describe('SQLite schema parity & STRICT tables', () => {
  it('defines all operational and derived-index tables as STRICT plus search_fts', async () => {
    const rows = await h.query<{ name: string; strict: number }>(
      `SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_fts%' ORDER BY name`,
    )
    expect(rows.map((r) => r.name)).toEqual([...ALL_STRICT_TABLES].sort())
    for (const r of rows) {
      expect(r.strict, `${r.name} must be STRICT`).toBe(1)
    }
    const fts = await h.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'search_fts'`,
    )
    expect(fts).toHaveLength(1)
  })
})

describe('append-only audit_log', () => {
  it('rejects UPDATE and DELETE via trigger', async () => {
    await h.query(
      `INSERT INTO audit_log (actor, action, target, outcome) VALUES ('root', 'account.create', 'alice', 'ok')`,
    )
    expect(await sqlCode(`UPDATE audit_log SET outcome = 'failed'`)).toBe('FORBIDDEN')
    expect(await sqlCode(`DELETE FROM audit_log`)).toBe('FORBIDDEN')
    const [row] = await h.query<{ n: number }>(`SELECT count(*) AS n FROM audit_log WHERE outcome = 'ok'`)
    expect(row?.n).toBeGreaterThanOrEqual(1)
  })

  it('validates action, outcome and detail shape', async () => {
    expect(await sqlCode(`INSERT INTO audit_log (actor, action, target, outcome) VALUES ('root', 'x', 't', 'maybe')`)).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO audit_log (actor, action, target, outcome) VALUES ('root', 'bad action', 't', 'ok')`)).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO audit_log (actor, action, target, outcome) VALUES ('root', 'Account.Create', 't', 'ok')`)).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO audit_log (actor, action, target, outcome, detail) VALUES ('root', 'a', 't', 'ok', '[]')`)).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO audit_log (actor, action, target, outcome) VALUES ($1, 'a', 't', 'ok')`, ['root\n'])).toBe('VALIDATION')
  })
})

describe('principals, sessions, api_tokens, lockouts constraints', () => {
  it('refuses non-argon2id password hashes, bad tokens, and invalid lockout targets', async () => {
    const id1 = randomUUID()
    expect(await sqlCode(`INSERT INTO principals (id, kind, username, password_hash) VALUES ($1, 'root', 'r1', 'plaintext')`, [id1])).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO principals (id, kind, username, password_hash) VALUES ($1, 'root', 'r1', $2)`, [id1, ARGON2.replace('argon2id', 'argon2i')])).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO principals (id, kind, username, password_hash) VALUES ($1, 'root', 'r1', $2)`, [id1, ARGON2])).toBe('ok')
    expect(await sqlCode(`INSERT INTO principals (id, kind, username, password_hash) VALUES ($1, 'root', 'r1', $2)`, [randomUUID(), ARGON2])).toBe('CONFLICT')
    expect(await sqlCode(`INSERT INTO principals (id, kind, username, password_hash) VALUES ($1, 'user', 'u9', $2)`, [randomUUID(), ARGON2])).toBe('VALIDATION')

    expect(
      await sqlCode(
        `INSERT INTO api_tokens (id, principal_id, name, token_hash, expires_at) VALUES ($1, $2, 'ci', 'nothex', '2099-01-01T00:00:00.000Z')`,
        [randomUUID(), id1],
      ),
    ).toBe('VALIDATION')
    expect(
      await sqlCode(
        `INSERT INTO api_tokens (id, principal_id, name, token_hash, expires_at) VALUES ($1, $2, 'ci', $3, '2099-01-01T00:00:00.000Z')`,
        [randomUUID(), id1, sha('a')],
      ),
    ).toBe('ok')

    expect(await sqlCode(`INSERT INTO lockouts (id, locked_until) VALUES ($1, '2099-01-01T00:00:00.000Z')`, [randomUUID()])).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO lockouts (id, username, ip, locked_until) VALUES ($1, 'a', '1.2.3.4', '2099-01-01T00:00:00.000Z')`, [randomUUID()])).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO lockouts (id, ip, locked_until) VALUES ($1, '1.2.3.4', '2099-01-01T00:00:00.000Z')`, [randomUUID()])).toBe('ok')
    expect(await sqlCode(`INSERT INTO lockouts (id, ip, locked_until) VALUES ($1, '1.2.3.4', '2099-01-01T00:00:00.000Z')`, [randomUUID()])).toBe('CONFLICT')
  })
})

describe('config_generations', () => {
  it('allows at most one active row and only legal transitions', async () => {
    const [g1] = await h.query<{ id: number }>(`INSERT INTO config_generations (checksum) VALUES ($1) RETURNING id`, [sha('1')])
    const [g2] = await h.query<{ id: number }>(`INSERT INTO config_generations (checksum) VALUES ($1) RETURNING id`, [sha('2')])
    const now = new Date().toISOString()
    expect(
      await sqlCode(
        `UPDATE config_generations SET status = 'active', tested_at = $1, activated_at = $1 WHERE id = $2`,
        [now, g1?.id],
      ),
    ).toBe('VALIDATION')

    await h.query(`UPDATE config_generations SET status = 'tested', tested_at = $1 WHERE id IN ($2, $3)`, [now, g1?.id, g2?.id])
    expect(await sqlCode(`UPDATE config_generations SET status = 'active', activated_at = $1 WHERE id = $2`, [now, g1?.id])).toBe('ok')
    expect(await sqlCode(`UPDATE config_generations SET status = 'active', activated_at = $1 WHERE id = $2`, [now, g2?.id])).toBe('CONFLICT')
    expect(await sqlCode(`UPDATE config_generations SET checksum = $1 WHERE id = $2`, [sha('3'), g1?.id])).toBe('VALIDATION')
    expect(await sqlCode(`UPDATE config_generations SET status = 'failed' WHERE id = $1`, [g2?.id])).toBe('VALIDATION')
    expect(await sqlCode(`UPDATE config_generations SET status = 'pending' WHERE id = $1`, [g1?.id])).toBe('VALIDATION')
    await h.query(`UPDATE config_generations SET status = 'superseded' WHERE id = $1`, [g1?.id])
  })
})

describe('upgrades', () => {
  it('allows a single upgrade in flight', async () => {
    const ins = () =>
      sqlCode(`INSERT INTO upgrades (id, from_version, to_version, actor) VALUES ($1, '1.0.0', '1.1.0', 'root')`, [
        randomUUID(),
      ])
    expect(await ins()).toBe('ok')
    expect(await ins()).toBe('CONFLICT')
    expect(
      await sqlCode(
        `INSERT INTO upgrades (id, from_version, to_version, actor, status, finished_at) VALUES ($1, '1.0', '1.1.0', 'root', 'succeeded', '2026-01-01T00:00:00.000Z')`,
        [randomUUID()],
      ),
    ).toBe('VALIDATION')
    expect(await sqlCode(`UPDATE upgrades SET status = 'failed', finished_at = '2026-01-01T00:00:00.000Z' WHERE status = 'pending'`)).toBe('VALIDATION')
    expect(
      await sqlCode(
        `UPDATE upgrades SET status = 'failed', error = 'health check', finished_at = '2026-01-01T00:00:00.000Z' WHERE status = 'pending'`,
      ),
    ).toBe('ok')
    expect(await ins()).toBe('ok')
  })
})
