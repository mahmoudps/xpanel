import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_QUOTA_STATE, createDbQuotaEnforcer, dbQuotaPrivileges, parseDbQuotas, readDbQuotaLocks } from './db-quota.ts'
import type { DbQuotaDeps } from './db-quota.ts'

const account = { id: 'a1', username: 'alice', status: 'active', databaseRemoteAccess: [] }
const snapshot = { accounts: [account], databases: [{ id: 'd1', accountId: 'a1', engine: 'mariadb', name: 'alice_shop', trashedAt: null }], databaseUsers: [{ id: 'u1', accountId: 'a1', name: 'alice_app', grants: [{ databaseId: 'd1', privileges: ['ALL'] }] }] }
let rootDir = ''
beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'xp-quota-')); await mkdir(join(rootDir, 'extended/panel'), { recursive: true }) })
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }) })
const setup = (size: () => number) => {
  const statements: string[] = [], audit = vi.fn(async () => undefined)
  const sql = { query: vi.fn(async (list: readonly string[]) => { statements.push(...list); return list[0]!.startsWith('SELECT') ? `alice_shop\t${size()}\n` : '' }) }
  const enforcer = createDbQuotaEnforcer({ store: { rootDir, readSnapshot: async () => snapshot as never }, sql, audit } as DbQuotaDeps)
  return { statements, audit, sql, enforcer }
}
const limit = (limits: Record<string, number>) => writeFile(join(rootDir, DB_QUOTA_STATE), JSON.stringify({ limits }))

describe('database size limits', () => {
  it('does nothing while no limit is saved', async () => {
    const { enforcer, statements, audit } = setup(() => 5 * 1024 * 1024)
    const report = await enforcer.enforce('root')
    expect(report.rows[0]).toMatchObject({ database: 'alice_shop', account: 'alice', limitMb: null, locked: false, sizeBytes: 5242880 })
    expect(statements.filter(row => !row.startsWith('SELECT'))).toEqual([])
    expect(audit).not.toHaveBeenCalled()
  })
  it('takes write privileges over the limit and gives them back under it', async () => {
    let bytes = 2 * 1024 * 1024
    const { enforcer, statements, audit } = setup(() => bytes)
    await limit({ alice_shop: 1 })
    expect((await enforcer.enforce('root')).rows[0]).toMatchObject({ locked: true, limitMb: 1 })
    expect(statements.some(row => row.startsWith('REVOKE ALL PRIVILEGES ON `alice\\_shop`.*'))).toBe(true)
    const grant = statements.find(row => row.startsWith('GRANT'))!
    expect(grant).toMatch(/^GRANT SELECT, DELETE, DROP/)
    expect(grant).not.toMatch(/INSERT|UPDATE|CREATE/)
    expect(await readDbQuotaLocks(rootDir)).toEqual(new Set(['alice_shop']))
    statements.length = 0
    expect((await enforcer.enforce('root')).rows[0]!.locked).toBe(true)
    expect(statements.filter(row => !row.startsWith('SELECT'))).toEqual([])
    bytes = 1024
    expect((await enforcer.enforce('root')).rows[0]!.locked).toBe(false)
    expect(statements.some(row => /^GRANT .*INSERT/.test(row))).toBe(true)
    expect(audit.mock.calls.map(call => (call as unknown as [{ action: string }])[0].action)).toEqual(['database.quota.locked', 'database.quota.unlocked'])
  })
  it('releases a locked database when its limit is removed', async () => {
    const { enforcer } = setup(() => 2 * 1024 * 1024)
    await limit({ alice_shop: 1 }); await enforcer.enforce('root')
    await limit({})
    expect((await enforcer.enforce('root')).rows[0]!.locked).toBe(false)
  })
  it('measures on a five minute gate and survives a failed read', async () => {
    const { enforcer, sql } = setup(() => 1)
    await limit({ alice_shop: 1 })
    await enforcer.tick(); await enforcer.tick()
    expect(sql.query).toHaveBeenCalledTimes(1)
    sql.query.mockRejectedValueOnce(new Error('down'))
    expect((await enforcer.enforce('root')).state).toBe('unavailable')
  })
  it('keeps only non-writing privileges for a reconcile while locked', () => {
    expect(dbQuotaPrivileges(['ALL'], true)).toEqual(expect.arrayContaining(['SELECT', 'DELETE', 'DROP']))
    expect(dbQuotaPrivileges(['ALL'], true)).not.toContain('INSERT')
    expect(dbQuotaPrivileges(['INSERT'], true)).toEqual([])
    expect(dbQuotaPrivileges(['INSERT'], false)).toEqual(['INSERT'])
  })
  it('validates the saved file', () => {
    expect(parseDbQuotas({ limits: { a: 1 } })).toEqual({ a: 1 })
    expect(parseDbQuotas({ limits: { a: 0 } })).toBeNull()
    expect(parseDbQuotas({ limits: [] })).toBeNull()
    expect(parseDbQuotas(null)).toBeNull()
  })
})
