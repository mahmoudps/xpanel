import { describe, expect, it, vi } from 'vitest'
import { handleDatabaseTransferRoute } from './database-transfer-workspace.ts'

const ID = '11111111-1111-4111-8111-111111111111', USER = '22222222-2222-4222-8222-222222222222'
const account = { id: 'a1', username: 'alice', ownerId: null }
const ok = (body: unknown = {}) => new Response(JSON.stringify(body))
const ports = (agent = vi.fn(async () => ok()), database: object = { id: ID, accountId: 'a1', engine: 'mariadb', name: 'alice_old', trashedAt: null }) => ({
  store: { getDatabase: vi.fn(async () => database), getDatabaseUser: vi.fn(async () => ({ id: USER, accountId: 'a1', name: 'alice_u' })), getAccount: vi.fn(async () => account), renameDatabase: vi.fn(async () => ({ name: 'alice_new' })), setDatabaseUserAuth: vi.fn(async () => undefined) },
  requireCaller: vi.fn(async () => ({ principal: { id: 'p', username: 'alice' } })), assertCanAccessAccount: vi.fn(async () => undefined), callAgent: agent,
  mutateDatabase: vi.fn(async (_r: unknown, _c: unknown, _a: unknown, _action: unknown, _kind: unknown, operation: (options: object) => Promise<unknown>) => ({ value: await operation({}), application: { status: 'not_requested', targetVerified: false } })),
  emitAudit: vi.fn(async () => undefined), reconcile: vi.fn(async () => null), ownedName: (user: string, name: unknown) => `${user}_${String(name)}`, reindex: vi.fn(async () => undefined), passwordHash: () => '*HASH',
  assertPassword: (value: unknown) => { if (typeof value !== 'string' || value.length < 8) throw new Error('weak') },
})
const call = (path: string, method: string, port: unknown, body?: unknown) => { const url = `http://x${path}`; return handleDatabaseTransferRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(url), method, port as never) }

describe('database transfer workspace', () => {
  it('leaves other paths alone and refuses a trashed or PostgreSQL database', async () => {
    expect(await call('/api/databases', 'GET', ports())).toBeNull()
    await expect(call(`/api/databases/${ID}/rename`, 'POST', ports(undefined, { id: ID, accountId: 'a1', engine: 'postgresql', name: 'alice_old', trashedAt: null }), { name: 'x' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('renames by copy, then the record, then drops the old copy', async () => {
    const steps: string[] = [], agent = vi.fn(async (path: string) => { steps.push(path); return ok() }), port = ports(agent as never)
    await call(`/api/databases/${ID}/rename`, 'POST', port, { name: 'new' })
    expect(steps).toEqual(['/accounts/alice/databases/alice_old/copy', '/accounts/alice/databases/alice_old/drop'])
    expect(port.store.renameDatabase).toHaveBeenCalledWith(ID, 'alice_new', {})
    expect(port.reindex).toHaveBeenCalled()
  })
  it('keeps the old database when the copy fails, and removes the copy when the record fails', async () => {
    const failed = ports(vi.fn(async () => new Response('{}', { status: 503 })) as never)
    expect((await call(`/api/databases/${ID}/rename`, 'POST', failed, { name: 'new' }))!.status).toBe(503)
    expect(failed.store.renameDatabase).not.toHaveBeenCalled()
    const steps: string[] = [], port = ports(vi.fn(async (path: string) => { steps.push(path); return ok() }) as never)
    port.store.renameDatabase = vi.fn(async () => { throw new Error('conflict') })
    await expect(call(`/api/databases/${ID}/rename`, 'POST', port, { name: 'new' })).rejects.toThrow('conflict')
    expect(steps.at(-1)).toBe('/accounts/alice/databases/alice_new/drop')
  })
  it('reports a rename whose old copy could not be removed', async () => {
    const port = ports(vi.fn(async (path: string) => path.endsWith('/drop') ? new Response('{}', { status: 500 }) : ok()) as never)
    await expect(call(`/api/databases/${ID}/rename`, 'POST', port, { name: 'new' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
  it('imports a home path and sets a password as a stored hash', async () => {
    const agent = vi.fn(async () => ok()), port = ports(agent as never)
    await call(`/api/databases/${ID}/import`, 'POST', port, { path: 'x.sql' })
    expect(agent).toHaveBeenCalledWith('/accounts/alice/databases/alice_old/import', expect.objectContaining({ method: 'POST', body: { path: 'x.sql' } }))
    await call(`/api/databases/users/${USER}/password`, 'POST', port, { password: 'long-enough' })
    expect(port.store.setDatabaseUserAuth).toHaveBeenCalledWith(USER, '*HASH', 'mysql_native_password')
    await expect(call(`/api/databases/users/${USER}/password`, 'POST', port, { password: 'x' })).rejects.toThrow('weak')
  })
})
