import { afterEach, describe, expect, it } from 'vitest'
import type { AuditEntry } from '@xpanel/core'
import { createTestDb, type TestDbHandle } from '../client.ts'
import { listAudit, normalizeAuditFilters, type AuditQuery } from './audit.ts'

const handles: TestDbHandle[] = []
afterEach(async () => { for (const h of handles.splice(0)) await h.close() })

// Isolated read-query fixtures; these rows make no durable-chain or audit-write claim.
const fixture = async () => {
  const h = await createTestDb(); handles.push(h)
  const add = async (at: string, outcome: AuditEntry['outcome'] = 'ok', actor = 'root', target = 'account:owner', action = 'account.test') => {
    const [row] = await h.db.query<{ id: number }>(
      'INSERT INTO audit_log (at,actor,principal_id,ip,action,target,detail,outcome) VALUES ($1,$2,NULL,NULL,$3,$4,$5,$6) RETURNING id',
      [at, actor, action, target, '{}', outcome],
    )
    return String(row!.id)
  }
  const ids = await Promise.all([
    add('2026-10-24T23:59:59.999Z'),
    add('2026-10-25T00:00:00.000Z'),
    add('2026-10-25T00:30:00.000Z'),
    add('2026-10-25T01:00:00Z'),
    add('2026-10-25T01:00:00.001Z'),
  ])
  return { h, add, ids }
}

const range = { from: '2026-10-25T00:00', to: '2026-10-25T01:00' }

describe('audit read query filters', () => {
  it('includes both UTC boundaries, excludes the adjacent milliseconds, and reads legacy ISO instants', async () => {
    const { h, ids } = await fixture()
    expect((await listAudit(h.db, range)).map(e => e.id)).toEqual([ids[3], ids[2], ids[1]])
    expect((await listAudit(h.db, { ...range, from: '2026-10-25T03:00+03:00' })).map(e => e.id)).toEqual([ids[3], ids[2], ids[1]])
    expect((await listAudit(h.db, { from: '2026-10-25T01:00:00.001Z' })).map(e => e.id)).toEqual([ids[4]])
    expect((await listAudit(h.db, { to: '2026-10-24T23:59:59.999Z' })).map(e => e.id)).toEqual([ids[0]])
  })

  it('includes offset-stored historical timestamps at the same from/to instant', async () => {
    const { h, add } = await fixture()
    const expected = await add('2026-10-25T03:30:00+03:00', 'failed')
    expect((await listAudit(h.db, { from: '2026-10-25T00:30', to: '2026-10-25T00:30:00.000Z', outcome: 'failed' })).map(e => e.id)).toEqual([expected])
  })

  it('combines exact filters, inclusive dates, exclusive keyset cursor and limit', async () => {
    const { h, ids, add } = await fixture()
    await add('2026-10-25T00:30:00.000Z', 'failed')
    await add('2026-10-25T00:30:00.000Z', 'ok', 'other')
    expect((await listAudit(h.db, { ...range, beforeId: ids[3], actor: 'root', target: 'account:owner', action: 'account.test', outcome: 'ok', limit: 1 })).map(e => e.id)).toEqual([ids[2]])
  })

  it.each(['ok', 'denied', 'failed'] as const)('filters outcome %s in SQL before the page limit', async outcome => {
    const { h, add } = await fixture()
    const expected = await add('2026-10-25T00:30:00.000Z', outcome)
    for (let i = 0; i < 55; i++) await add('2026-10-25T02:00:00.000Z', outcome === 'ok' ? 'failed' : 'ok')
    expect((await listAudit(h.db, { ...range, outcome, limit: 1 })).map(e => e.id)).toEqual([expected])
  })

  it('binds hostile SQL strings as exact values and preserves literal wildcard characters', async () => {
    const { h, add } = await fixture()
    const literal = "x' OR 1=1 --_%"
    const expected = await add('2026-10-25T00:30:00Z', 'denied', literal, literal)
    expect((await listAudit(h.db, { actor: literal, target: literal, outcome: 'denied' })).map(e => e.id)).toEqual([expected])
    expect(await listAudit(h.db, { action: literal })).toEqual([])
    expect(await listAudit(h.db, { target: '%' })).toEqual([])
    expect((await listAudit(h.db)).length).toBe(6)
  })

  it.each([
    { outcome: 'unknown' },
    { from: '2026-02-30T00:00' },
    { from: '2026-10-25T24:00' },
    { to: '2026-10-25' },
    { to: '2026-10-25T00:00:00+24:00' },
    { from: '2026-10-26T00:00', to: '2026-10-25T00:00' },
    { from: "2026-10-25T00:00Z' OR 1=1 --" },
  ])('rejects invalid repository filter %j', async query => {
    const { h } = await fixture()
    await expect(listAudit(h.db, query as AuditQuery)).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('normalizes UTC regardless of local timezone and supports equal instants with different offsets', () => {
    expect(normalizeAuditFilters({ from: '2024-02-29T05:06:07.8', to: '2024-02-29T07:06:07.800+02:00' })).toEqual({
      from: '2024-02-29T05:06:07.800Z', to: '2024-02-29T05:06:07.800Z',
    })
  })

  it.each(['owner7', 'child7'])('mentions %s uses full actor and canonical account target boundaries', async username => {
    const { h, add } = await fixture()
    const allowed: string[] = []
    allowed.push(await add('2026-10-25T00:30:00Z', 'ok', username, 'server:actor-only-marker'))
    allowed.push(await add('2026-10-25T00:30:00Z', 'ok', 'root', `account:${username}`))
    allowed.push(await add('2026-10-25T00:30:00Z', 'ok', 'root', `account:${username}:git:example`))
    allowed.push(await add('2026-10-25T00:30:00Z', 'ok', 'root', `account:${username}:/public_html/index.php`))
    for (const target of [`account:${username}0`, `account:${username}0:cache`, `prefix:account:${username}`, `notaccount:${username}:app:node`, `server:${username}`]) {
      await add('2026-10-25T00:30:00Z', 'ok', 'root', target)
    }
    await add('2026-10-25T00:30:00Z', 'ok', `${username}0`, 'server:other-actor')
    expect((await listAudit(h.db, { ...range, mentions: username, outcome: 'ok', limit: 50 })).map(entry => entry.id)).toEqual(allowed.reverse())
  })

  it('binds mentions with SQL and wildcard characters literally', async () => {
    const { h, add } = await fixture()
    const username = "u'_%"
    const expected = await add('2026-10-25T00:30:00Z', 'ok', 'root', `account:${username}:cache`)
    await add('2026-10-25T00:30:00Z', 'ok', 'root', 'account:uABC:cache')
    expect((await listAudit(h.db, { mentions: username })).map(entry => entry.id)).toEqual([expected])
  })

})
