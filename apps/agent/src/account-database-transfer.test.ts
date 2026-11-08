import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dumpReadArgv, handleDatabaseTransferRoute } from './account-database-transfer.ts'

const account = { id: 'a1', username: 'alice', home: '/home/alice' }
describe('database transfer route', () => {
  let root: string
  const engine = () => ({
    dump: vi.fn(async (_a: unknown, _d: string, path: string) => { await writeFile(path, 'CREATE TABLE t(a int);'); return { bytes: 21, sha256: 'b'.repeat(64) } }),
    restore: vi.fn(async () => undefined), importUntrusted: vi.fn(async () => undefined), drop: vi.fn(async () => undefined),
  })
  const call = (action: string, method: string, body: unknown, overrides: Record<string, unknown> = {}) => {
    const url = `http://agent/accounts/alice/databases/alice_shop/${action}`
    return handleDatabaseTransferRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(url), method,
      { caller: { role: 'user', accountId: 'a1' }, store: { getAccountByUsername: async () => account as never }, engine: engine(), root, run: vi.fn(async (command: { stdoutPath: string }) => { await writeFile(command.stdoutPath, 'INSERT'); return { ok: true, killed: false } }) as never, ...overrides } as never)
  }
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dbt-')) })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('refuses another owner, a missing engine and an unknown path', async () => {
    await expect(call('import', 'POST', { path: 'a.sql' }, { caller: { role: 'user', accountId: 'other' } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call('import', 'POST', { path: 'a.sql' }, { engine: null })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await handleDatabaseTransferRoute(new Request('http://agent/x'), new URL('http://agent/x'), 'GET', {} as never)).toBeNull()
    expect((await call('dump', 'POST', undefined))!.status).toBe(405)
  })

  it('reads a dump only as the account, inside the home, and imports it as untrusted', async () => {
    for (const bad of ['/etc/passwd.sql', '../x.sql', 'a/../b.sql', 'notes.txt', 'a//b.sql']) expect(() => dumpReadArgv('/home/alice', bad)).toThrow()
    expect(dumpReadArgv('/home/alice', 'db/x.sql.gz')).toEqual(['/usr/bin/gzip', '-dc', '--', '/home/alice/db/x.sql.gz'])
    const used = engine(), run = vi.fn(async (command: { stdoutPath: string }) => { await writeFile(command.stdoutPath, 'INSERT'); return { ok: true, killed: false } })
    await call('import', 'POST', { path: 'x.sql' }, { engine: used, run })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ runAsUser: 'alice', argv: ['/usr/bin/cat', '--', '/home/alice/x.sql'] }))
    expect(used.importUntrusted).toHaveBeenCalledTimes(1)
    expect(used.restore).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })

  it('stops an unreadable dump before the database is touched', async () => {
    const used = engine()
    await expect(call('import', 'POST', { path: 'x.sql' }, { engine: used, run: vi.fn(async (command: { stdoutPath: string }) => { await writeFile(command.stdoutPath, ''); return { ok: false, killed: false } }) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(used.importUntrusted).not.toHaveBeenCalled()
  })

  it('copies through our own dump and verifies its digest', async () => {
    const used = engine()
    expect(await (await call('copy', 'POST', { to: 'alice_new' }, { engine: used }))!.json()).toMatchObject({ copied: 'alice_new' })
    expect(used.restore).toHaveBeenCalledWith(account, 'alice_new', expect.any(String), 'b'.repeat(64))
    await expect(call('copy', 'POST', { to: 'alice_shop' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('streams a compressed dump and removes the staged file', async () => {
    const response = (await call('dump', 'GET', undefined))!
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="alice_shop.sql.gz"')
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe('CREATE TABLE t(a int);')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await readdir(root)).toEqual([])
  })

  it('drops only when the name is repeated', async () => {
    const used = engine()
    await expect(call('drop', 'POST', { name: 'other' }, { engine: used })).rejects.toMatchObject({ code: 'VALIDATION' })
    await call('drop', 'POST', { name: 'alice_shop' }, { engine: used })
    expect(used.drop).toHaveBeenCalledWith(account, 'alice_shop')
  })
})
