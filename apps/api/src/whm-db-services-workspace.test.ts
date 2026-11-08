import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateStore } from '@xpanel/state'
import { handleWhmDbServicesRoute } from './whm-db-services-workspace.ts'
import type { WhmDbServicesHelpers } from './whm-db-services-workspace.ts'

let rootDir = ''
beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'xp-dbs-')) })
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }) })
const caller = { principal: { id: 'p1', username: 'root' } }
const helpers = (extra: Partial<WhmDbServicesHelpers> = {}) => {
  const audit = vi.fn(async () => undefined), callHost = vi.fn(async () => ({ ok: true })), readHost = vi.fn(async (_c: unknown, path: string) => path.endsWith('phpmyadmin-access') ? { installed: true, phpVersions: ['8.3'], allowedPorts: null } : { engine: 'redis', rows: [] })
  const store = { rootDir, getWriterLock: () => ({ acquire: async () => ({ assertFencingToken: async () => undefined, release: async () => undefined }) }), readSnapshot: async () => ({ databases: [{ name: 'alice_shop', engine: 'mariadb', trashedAt: null }], server: { settings: { panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 } } }) } as unknown as StateStore
  const value: WhmDbServicesHelpers = { store, requireCaller: (async () => caller) as never, assertRoot: (async () => undefined) as never, emitAudit: audit as never, callHost, readHost, triggerReconcile: async () => ({ ok: true, status: 200, body: {} }), ...extra }
  return { value, audit, callHost, readHost }
}
const send = (path: string, method: string, body: unknown | undefined, value: WhmDbServicesHelpers) => handleWhmDbServicesRoute(new Request('http://api' + path, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), new URL('http://api' + path), method, value)

describe('database service routes', () => {
  it('leaves other paths alone', async () => {
    expect(await send('/api/server/databases/settings', 'GET', undefined, helpers().value)).toBeNull()
  })
  it('passes a read to the agent and refuses selectors', async () => {
    const { value, readHost } = helpers()
    expect(await (await send('/api/server/databases/services/redis', 'GET', undefined, value))!.json()).toMatchObject({ engine: 'redis' })
    expect(readHost).toHaveBeenCalledWith(caller, '/host/databases/services/redis')
    await expect(send('/api/server/databases/services/redis?db=1', 'GET', undefined, value)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('refuses a route of another engine', async () => {
    const { value, callHost } = helpers()
    expect((await send('/api/server/databases/services/postgresql/keys', 'POST', {}, value))!.status).toBe(404)
    expect((await send('/api/server/databases/services/redis/config', 'DELETE', undefined, value))!.status).toBe(405)
    expect(callHost).not.toHaveBeenCalled()
  })
  it('audits a change without its password or value', async () => {
    const { value, audit, callHost } = helpers()
    await send('/api/server/databases/services/redis/password', 'POST', { password: 'Correct-Horse-9-x' }, value)
    await send('/api/server/databases/services/redis/key', 'POST', { db: 1, key: 'k', value: 'private', ttlSeconds: null }, value)
    expect(callHost).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/Correct-Horse|private/)
    expect((audit.mock.calls as unknown as [{ action: string; outcome: string }][]).map(([entry]) => entry.action)).toEqual(['server.databases.service_password', 'server.databases.redis_key_saved'])
  })
  it('does not audit reading a key page', async () => {
    const { value, audit } = helpers()
    await send('/api/server/databases/services/redis/keys', 'POST', { db: 0, cursor: '0', match: '' }, value)
    expect(audit).not.toHaveBeenCalled()
  })
  it('records a refused host effect as failed and passes the refusal on', async () => {
    const { value, audit } = helpers({ callHost: vi.fn(async () => { throw Object.assign(new Error('no'), { code: 'PRECONDITION_FAILED' }) }) })
    await expect(send('/api/server/databases/services/mongodb/auth', 'POST', { enabled: true }, value)).rejects.toThrow('no')
    expect((audit.mock.calls[0] as unknown as [{ outcome: string }])[0].outcome).toBe('failed')
  })
})

describe('MongoDB archive upload', () => {
  const start = (value: WhmDbServicesHelpers, body: unknown = { filename: 'shop.archive.gz', bytes: 5 }) => send('/api/server/databases/services/mongodb/import', 'POST', body, value)
  const chunk = (value: WhmDbServicesHelpers, id: string, offset: number, data: string) => send(`/api/server/databases/services/mongodb/import/${id}`, 'PUT', { offset, data }, value)
  it('stores chunks in order, then hands the finished file to the agent once', async () => {
    const { value, callHost, audit } = helpers()
    const { id, chunkBytes } = await (await start(value))!.json() as { id: string; chunkBytes: number }
    expect(chunkBytes).toBe(4 * 1024 * 1024)
    expect(await (await chunk(value, id, 0, Buffer.from('ab').toString('base64')))!.json()).toEqual({ received: 2, complete: false })
    await expect(chunk(value, id, 0, Buffer.from('ab').toString('base64'))).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(callHost).not.toHaveBeenCalled()
    expect(await (await chunk(value, id, 2, Buffer.from('cde').toString('base64')))!.json()).toMatchObject({ received: 5, complete: true })
    expect(callHost).toHaveBeenCalledWith(caller, '/host/databases/services/mongodb/import', { id, filename: 'shop.archive.gz' })
    expect(await readFile(join(rootDir, 'extended/transfers/mongodb', `${id}.archive.gz`), 'utf8')).toBe('abcde')
    expect((audit.mock.calls[0] as unknown as [{ action: string }])[0].action).toBe('server.databases.mongodb_imported')
    await expect(chunk(value, id, 5, 'YQ==')).rejects.toMatchObject({ detail: { reason: 'mongodb_import_expired' } })
  })
  it('refuses another file type, an oversized chunk and a bad method', async () => {
    const { value } = helpers()
    await expect(start(value, { filename: 'shop.zip', bytes: 5 })).rejects.toMatchObject({ detail: { reason: 'mongodb_archive_rejected' } })
    await expect(start(value, { filename: 'shop.gz', bytes: 0 })).rejects.toMatchObject({ detail: { reason: 'mongodb_import_too_large' } })
    const { id } = await (await start(value))!.json() as { id: string }
    await expect(chunk(value, id, 0, Buffer.from('abcdefgh').toString('base64'))).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await send('/api/server/databases/services/mongodb/import', 'GET', undefined, value))!.status).toBe(405)
  })
})

describe('database size limit route', () => {
  it('saves a limit with its revision and enforces at once', async () => {
    const { value, callHost } = helpers()
    const first = await (await send('/api/server/databases/quota', 'GET', undefined, value))!.json() as { revision: string }
    const saved = await (await send('/api/server/databases/quota', 'PUT', { database: 'alice_shop', limitMb: 100, expectedRevision: first.revision }, value))!.json() as { revision: string }
    expect(saved.revision).not.toBe(first.revision)
    expect(callHost).toHaveBeenCalledWith(caller, '/host/databases/quota/enforce', {})
    await expect(send('/api/server/databases/quota', 'PUT', { database: 'alice_shop', limitMb: 200, expectedRevision: first.revision }, value)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('refuses a database no account owns and a bad limit', async () => {
    const { value } = helpers()
    await expect(send('/api/server/databases/quota', 'PUT', { database: 'bob_x', limitMb: 1, expectedRevision: 'x' }, value)).rejects.toMatchObject({ detail: { reason: 'database_not_saved' } })
    await expect(send('/api/server/databases/quota', 'PUT', { database: 'alice_shop', limitMb: 0, expectedRevision: 'x' }, value)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('phpMyAdmin access route', () => {
  const body = { publicAccess: true, httpPort: 8008, httpsPort: 8009, phpVersion: '8.3', basicAuthUser: null, basicAuthPassword: null }
  const read = async (value: WhmDbServicesHelpers) => await (await send('/api/server/databases/phpmyadmin-access', 'GET', undefined, value))!.json() as { revision: string; publicAccess: boolean; basicAuthUser: string | null }
  it('starts private, applies a change and never returns the hash', async () => {
    const { value, audit } = helpers()
    const first = await read(value)
    expect(first.publicAccess).toBe(false)
    const reply = await send('/api/server/databases/phpmyadmin-access', 'PUT', { ...body, basicAuthUser: 'guard', basicAuthPassword: 'Correct-Horse-9-x', expectedRevision: first.revision }, value)
    const text = await reply!.text()
    expect(JSON.parse(text)).toMatchObject({ publicAccess: true, basicAuthUser: 'guard', application: { status: 'applied' } })
    expect(text).not.toMatch(/\$6\$|Correct-Horse/)
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/\$6\$|Correct-Horse/)
  })
  it('keeps the saved password when its field stays empty', async () => {
    const { value } = helpers(), first = await read(value)
    await send('/api/server/databases/phpmyadmin-access', 'PUT', { ...body, basicAuthUser: 'guard', basicAuthPassword: 'Correct-Horse-9-x', expectedRevision: first.revision }, value)
    const next = await read(value)
    expect((await (await send('/api/server/databases/phpmyadmin-access', 'PUT', { ...body, basicAuthUser: 'keeper', expectedRevision: next.revision, basicAuthPassword: null }, value))!.json() as { basicAuthUser: string }).basicAuthUser).toBe('keeper')
  })
  it('refuses reserved ports, missing PHP, a missing password and an absent package', async () => {
    const { value } = helpers(), first = await read(value)
    const put = (change: Record<string, unknown>, target = value) => send('/api/server/databases/phpmyadmin-access', 'PUT', { ...body, ...change, expectedRevision: first.revision }, target)
    await expect(put({ httpsPort: 2087 })).rejects.toMatchObject({ detail: { reason: 'phpmyadmin_port_reserved' } })
    await expect(put({ httpPort: 8080 })).rejects.toMatchObject({ detail: { reason: 'phpmyadmin_port_reserved' } })
    await expect(put({ phpVersion: '7.4' })).rejects.toMatchObject({ detail: { reason: 'phpmyadmin_php_missing' } })
    await expect(put({ basicAuthUser: 'guard' })).rejects.toMatchObject({ detail: { reason: 'phpmyadmin_password_required' } })
    await expect(put({}, helpers({ readHost: async () => ({ installed: false }) }).value)).rejects.toMatchObject({ detail: { reason: 'phpmyadmin_not_installed' } })
    await expect(put({ httpsPort: 7000 }, helpers({ readHost: async () => ({ installed: true, phpVersions: ['8.3'], allowedPorts: [8008, 8009] }) }).value)).rejects.toMatchObject({ detail: { reason: 'phpmyadmin_port_selinux' } })
  })
})
