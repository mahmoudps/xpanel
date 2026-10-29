import { describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import { buildTransferSourceInventory, handleTransferSourceInventoryRoute, handleTransferSourcePackageRoute, signTransferManifest, verifyTransferManifest } from './acct-transfer-source.ts'
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

describe('signed transfer package source', () => {
  const TOKEN = 'xp_' + 'a'.repeat(43), ID = '0f0f0f0f-0000-4000-8000-000000000001'
  const full = () => {
    const base = snapshot()
    return { ...base,
      plans: [{ id: 'p2', name: 'silver', ownerId: null, featureListId: 'f1', resources: { diskMb: 1024 }, caps: {}, dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 1024 }] as never,
      accounts: (base.accounts as unknown as Record<string, unknown>[]).map(a => ({ ...a, home: '/home/' + String(a.username), contactEmail: 'owner@example.test', shell: 'jailed', ipv4: '192.0.2.5' })) as never,
      domains: [{ id: 'd1', accountId: 'a2', name: 'alice.example.test', kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null, php: php('8.3'), wildcard: false }] as never,
      databases: [{ id: 'db1', accountId: 'a2', name: 'alice_wp', trashedAt: null }] as never,
      databaseUsers: [{ accountId: 'a2', name: 'alice_wpuser', authPlugin: 'mysql_native_password', authString: '*HASH', grants: [{ databaseId: 'db1', privileges: ['ALL'] }] }] as never,
      serviceUsers: [{ accountId: 'a2', login: 'info@alice.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 512, ftpDir: '', passwordHash: '{ARGON2ID}$x' }] as never,
      zones: [{ accountId: 'a2', name: 'alice.example.test', records: [{ id: 'r', zone: 'alice.example.test', name: '@', type: 'A', ttl: 300, content: '192.0.2.5', priority: null }] }] as never,
      cronJobs: [{ accountId: 'a2', schedule: '@daily', command: '/home/alice/run.sh', comment: '', enabled: true }] as never,
    }
  }
  const task = (state: string) => ({ task: { id: ID, kind: 'package', username: 'alice', state, updatedAt: '2026-10-29T01:00:00.000Z', error: state === 'failed' ? 'dump failed' : null,
    result: { artifacts: [{ name: 'home.tar.gz', bytes: 7, sha256: 'c'.repeat(64) }, { name: 'db-alice_wp.sql', bytes: 3, sha256: 'd'.repeat(64) }], databases: [{ name: 'alice_wp', artifact: 'db-alice_wp.sql' }], certificates: [] } } })
  const ports = (overrides: Record<string, unknown> = {}, state = 'succeeded') => {
    const calls: string[] = []
    return { calls, ports: {
      requireCaller: async () => ({ principal: { kind: 'root', id: 'p' }, sessionId: null, apiTokenId: 't' }) as unknown as AuthenticatedCaller,
      assertRoot: async (caller: AuthenticatedCaller) => { if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root required') },
      readSnapshot: async () => full(),
      agent: async (_caller: AuthenticatedCaller, path: string, init: { method?: string; body?: unknown } = {}) => {
        calls.push((init.method ?? 'GET') + ' ' + path + (init.body ? ' ' + JSON.stringify(init.body) : ''))
        if (path === '/transfers/tasks') return Response.json({ task: { id: ID } }, { status: 202 })
        if (path.startsWith('/transfers/packages/')) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '3' } })
        return init.method === 'DELETE' ? Response.json({ discarded: true }) : Response.json(task(state))
      },
      ...overrides,
    } }
  }
  const call = (path: string, method: string, p = ports().ports, body?: string, token = TOKEN) => { const url = new URL('http://x' + path); return handleTransferSourcePackageRoute(new Request(url, { method, headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body }) }), url, method, p) }
  it('starts packaging on the agent and, once ready, signs the manifest with the account state', async () => {
    const p = ports()
    const started = (await call('/api/transfers/source/accounts/alice/package', 'POST', p.ports, '{}'))!
    expect(started.status).toBe(202); expect(await started.json()).toEqual({ package: ID })
    expect(p.calls[0]).toBe('POST /transfers/tasks {"kind":"package","username":"alice"}')
    const value = await (await call('/api/transfers/source/accounts/alice/package/' + ID, 'GET', p.ports))!.json()
    expect(value.manifest).toMatchObject({ source: 'source.example.test', username: 'alice', package: ID, artifacts: [{ name: 'home.tar.gz' }, { name: 'db-alice_wp.sql' }] })
    expect(value.manifest.bundle).toMatchObject({ account: { username: 'alice', home: '/home/alice', ipv4: '192.0.2.5' }, plan: { name: 'silver' }, databaseUsers: [{ name: 'alice_wpuser', authString: '*HASH', grants: [{ database: 'alice_wp', privileges: ['ALL'] }] }],
      mailboxes: [{ login: 'info@alice.example.test', passwordHash: '{ARGON2ID}$x' }], zones: [{ name: 'alice.example.test' }], cron: [{ schedule: '@daily' }], databases: [{ name: 'alice_wp', artifact: 'db-alice_wp.sql' }] })
    expect(value.manifest.bundle.plan).not.toHaveProperty('id')
    expect(value.signature).toBe(signTransferManifest(TOKEN, value.manifest))
    expect(verifyTransferManifest(value, TOKEN, { source: 'source.example.test', username: 'alice', package: ID })).toMatchObject({ package: ID })
    for (const [raw, token, user] of [[{ ...value, signature: '0'.repeat(64) }, TOKEN, 'alice'], [value, 'xp_' + 'b'.repeat(43), 'alice'], [value, TOKEN, 'bob'], [{ ...value, manifest: { ...value.manifest, artifacts: [] } }, TOKEN, 'alice'], [{ ...value, extra: 1 }, TOKEN, 'alice']] as const)
      expect(() => verifyTransferManifest(raw, token, { source: 'source.example.test', username: user, package: ID })).toThrow(/invalid or unsigned package manifest/)
  })
  it('reports running and failed packaging without a manifest', async () => {
    expect(await (await call('/api/transfers/source/accounts/alice/package/' + ID, 'GET', ports({}, 'running').ports))!.json()).toEqual({ state: 'running' })
    expect(await (await call('/api/transfers/source/accounts/alice/package/' + ID, 'GET', ports({}, 'failed').ports))!.json()).toEqual({ state: 'failed', error: 'dump failed' })
  })
  it('streams named artifacts only, for API tokens only, and refuses bodies and selectors', async () => {
    const stream = (await call('/api/transfers/source/accounts/alice/package/' + ID + '/home.tar.gz', 'GET'))!
    expect(stream.headers.get('content-type')).toBe('application/octet-stream'); expect(new Uint8Array(await stream.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    await expect(call('/api/transfers/source/accounts/alice/package/' + ID + '/..%2Ftasks.json', 'GET')).rejects.toMatchObject({ code: 'VALIDATION' })
    const session = ports({ requireCaller: async () => ({ principal: { kind: 'root', id: 'p' }, sessionId: 's', apiTokenId: null }) as unknown as AuthenticatedCaller }).ports
    await expect(call('/api/transfers/source/accounts/alice/package', 'POST', session, '{}')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call('/api/transfers/source/accounts/alice/package', 'POST', ports().ports, '{"all":true}')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/api/transfers/source/accounts/gone/package', 'POST', ports().ports, '{}')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await call('/api/transfers/source/accounts/alice/package', 'GET'))!.status).toBe(405)
    expect(await (await call('/api/transfers/source/accounts/alice/package/' + ID, 'DELETE'))!.json()).toEqual({ discarded: true })
  })
})
