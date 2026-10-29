import { describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import { buildTransferSourceInventory, handleTransferSourceBackupRoute, handleTransferSourceInventoryRoute, signTransferManifest, verifyTransferManifest } from './acct-transfer-source.ts'
import type { TransferSourceSnapshot } from './acct-transfer-source.ts'
import { parseTransferSourceInventory } from './acct-transfer-discovery.ts'
import type { AuthenticatedCaller } from './auth.ts'

const php = (version: string) => ({ version }) as never
const snapshot = (): TransferSourceSnapshot => ({
  server: { settings: { hostname: 'source.example.test' }, setupCompletedAt: null, updatedAt: '2026-10-28T00:00:00.000Z' } as never,
  plans: [{ id: 'p1', name: 'gold' }, { id: 'p2', name: 'silver' }] as never,
  accounts: [
    { id: 'a1', username: 'bob', uid: 20002, primaryDomain: 'bob.example.test', planId: 'p1', status: 'suspended' },
    { id: 'a2', username: 'alice', uid: 20001, primaryDomain: 'alice.example.test', planId: 'p2', status: 'active' },
    { id: 'a3', username: 'gone', uid: 20003, primaryDomain: 'gone.example.test', planId: 'p2', status: 'terminating' },
  ] as never,
  domains: [
    { id: 'd1', accountId: 'a2', name: 'alice.example.test', php: php('8.3') }, { id: 'd2', accountId: 'a2', name: 'shop.example.test', php: php('8.2') },
    { id: 'd3', accountId: 'a1', name: 'bob.example.test', php: php('8.3') },
  ] as never,
  databases: [{ accountId: 'a2', name: 'alice_wp', trashedAt: null }, { accountId: 'a2', name: 'alice_old', trashedAt: '2026-10-01T00:00:00.000Z' }] as never,
  serviceUsers: [{ accountId: 'a2', services: { email: true } }, { accountId: 'a2', services: { email: false } }] as never,
})
const disk = (items = [{ username: 'alice', usedBytes: 1024, limitBytes: null }, { username: 'bob', usedBytes: 2048, limitBytes: null }], state: 'read' | 'unavailable' = 'read') => ({
  observedAt: '2026-10-28T00:00:00.000Z', filesystems: { state: 'unavailable' as const, items: [], inodes: 'unavailable' as const, reason: 'filesystems-unavailable' as const },
  accounts: state === 'read' ? { state, source: 'repquota' as const, mount: '/home', items } : { state, source: 'repquota' as const, mount: null, items: [], reason: 'quota-mount-unavailable' as const },
})

describe('transfer source inventory', () => {
  it('reports observed accounts, domains, live databases, mailboxes and PHP versions', () => {
    const inventory = buildTransferSourceInventory(snapshot(), disk() as never, '0.1.0')
    expect(inventory.source).toEqual({ hostname: 'source.example.test', version: '0.1.0' })
    expect(inventory.accounts.map(account => account.username)).toEqual(['alice', 'bob'])
    expect(inventory.accounts[0]).toEqual({ username: 'alice', uid: 20001, primaryDomain: 'alice.example.test', domains: ['alice.example.test', 'shop.example.test'], plan: 'silver', diskBytes: 1024, databases: ['alice_wp'], mailboxes: 1, phpVersions: ['8.2', '8.3'] })
    expect(inventory.plans).toEqual([{ name: 'gold' }, { name: 'silver' }])
    expect(parseTransferSourceInventory(JSON.parse(JSON.stringify(inventory)))).toEqual(inventory)
  })
  it('refuses rather than reporting zero when disk usage or hostname is not observed', () => {
    expect(() => buildTransferSourceInventory(snapshot(), disk(undefined, 'unavailable') as never, '0.1.0')).toThrow(/disk usage could not be observed/)
    expect(() => buildTransferSourceInventory(snapshot(), disk([{ username: 'alice', usedBytes: null as never, limitBytes: null }]) as never, '0.1.0')).toThrow(/disk usage could not be observed/)
    expect(() => buildTransferSourceInventory({ ...snapshot(), server: null }, disk() as never, '0.1.0')).toThrow(/no saved hostname/)
  })
  it('serves the route to root only, without selectors, after re-checking authority', async () => {
    let kind = 'root', calls = 0
    const ports = {
      requireCaller: async () => { calls++; return { principal: { kind, id: 'p' }, sessionId: null, apiTokenId: 't' } as unknown as AuthenticatedCaller },
      assertRoot: async (caller: AuthenticatedCaller) => { if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root required') },
      readSnapshot: async () => snapshot(), readDisk: async () => disk(), version: async () => '0.1.0',
    }
    const call = (path: string, method = 'GET') => { const url = new URL('http://x' + path); return handleTransferSourceInventoryRoute(new Request(url, { method }), url, method, ports) }
    expect(await call('/api/transfers/sessions')).toBeNull()
    const response = (await call('/api/transfers/source/inventory'))!
    expect(response.status).toBe(200)
    expect((await response.json()).accounts).toHaveLength(2)
    expect(calls).toBe(2)
    await expect(call('/api/transfers/source/inventory?all=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call('/api/transfers/source/inventory', 'POST'))!.status).toBe(405)
    kind = 'user'
    await expect(call('/api/transfers/source/inventory')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('signed transfer archive source', () => {
  const TOKEN = 'xp_' + 'a'.repeat(43)
  const ports = (overrides: Record<string, unknown> = {}) => ({
    requireCaller: async () => ({ principal: { kind: 'root', id: 'p' }, sessionId: null, apiTokenId: 't' }) as unknown as AuthenticatedCaller,
    assertRoot: async (caller: AuthenticatedCaller) => { if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root required') },
    readSnapshot: async () => snapshot(), now: () => new Date('2026-10-28T12:00:00.000Z'),
    createArchive: async () => new Response(JSON.stringify({ file: 'xpanel-backup-alice-20261028T120000Z-abcdefabcdef.tar.gz', bytes: 7, sha256: 'c'.repeat(64) }), { status: 201 }),
    openArchive: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '3' } }),
    ...overrides,
  })
  const call = (path: string, method: string, p = ports(), body?: string, token = TOKEN) => { const url = new URL('http://x' + path); return handleTransferSourceBackupRoute(new Request(url, { method, headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body }) }), url, method, p) }
  it('returns a manifest signed with the presented token that the destination verifies', async () => {
    const response = (await call('/api/transfers/source/accounts/alice/backup', 'POST', ports(), '{}'))!
    expect(response.status).toBe(201)
    const value = await response.json()
    expect(value.manifest).toEqual({ source: 'source.example.test', username: 'alice', file: 'xpanel-backup-alice-20261028T120000Z-abcdefabcdef.tar.gz', bytes: 7, sha256: 'c'.repeat(64), createdAt: '2026-10-28T12:00:00.000Z' })
    expect(value.signature).toBe(signTransferManifest(TOKEN, value.manifest))
    expect(verifyTransferManifest(value, TOKEN, { source: 'source.example.test', username: 'alice' })).toEqual(value.manifest)
    for (const [raw, token, expected] of [[{ ...value, signature: '0'.repeat(64) }, TOKEN, 'alice'], [value, 'xp_' + 'b'.repeat(43), 'alice'], [value, TOKEN, 'bob'], [{ ...value, manifest: { ...value.manifest, bytes: 8 } }, TOKEN, 'alice'], [{ ...value, extra: 1 }, TOKEN, 'alice']] as const)
      expect(() => verifyTransferManifest(raw, token, { source: 'source.example.test', username: expected })).toThrow(/invalid or unsigned archive manifest/)
  })
  it('streams the named archive and refuses sessions, other names, bodies and unverified agent replies', async () => {
    const stream = (await call('/api/transfers/source/accounts/alice/backup/xpanel-backup-alice-20261028T120000Z.tar.gz', 'GET'))!
    expect(stream.headers.get('content-type')).toBe('application/gzip'); expect(new Uint8Array(await stream.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    await expect(call('/api/transfers/source/accounts/alice/backup/xpanel-backup-bob-20261028T120000Z.tar.gz', 'GET')).rejects.toMatchObject({ code: 'VALIDATION' })
    const session = ports({ requireCaller: async () => ({ principal: { kind: 'root', id: 'p' }, sessionId: 's', apiTokenId: null }) as unknown as AuthenticatedCaller })
    await expect(call('/api/transfers/source/accounts/alice/backup', 'POST', session, '{}')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call('/api/transfers/source/accounts/alice/backup', 'POST', ports(), '{"all":true}')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/api/transfers/source/accounts/gone/backup', 'POST', ports(), '{}')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call('/api/transfers/source/accounts/alice/backup', 'POST', ports({ createArchive: async () => new Response(JSON.stringify({ file: '../x', bytes: 1, sha256: 'c'.repeat(64) }), { status: 201 }) }), '{}')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await call('/api/transfers/source/accounts/alice/backup', 'GET'))!.status).toBe(405)
  })
})
