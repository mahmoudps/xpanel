import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { handleNginxProxyRoute } from './nginx-proxy-workspace.ts'
import type { NginxProxyPorts } from './nginx-proxy-workspace.ts'
import { accountEdgeSiteOptions, edgeStatePath, parseAccountEdgeState, readAccountEdge } from '../../agent/src/account-edge.ts'
import { proxyRulesPath } from '../../agent/src/proxy-rules.ts'

const ALICE = { id: '22222222-2222-4222-8222-222222222222', username: 'alice', primaryDomain: 'alice.example', status: 'active', ipv4: '198.51.100.8', ipv6: '2001:db8::8' }
const BOB = { id: '44444444-4444-4444-8444-444444444444', username: 'bob', primaryDomain: 'bob.example', status: 'active' }
const ROOT = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 'one', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
const DOMAINS = [
  { id: 'd1', accountId: ALICE.id, name: 'alice.example', kind: 'primary', siteType: 'php', redirect: null },
  { id: 'd2', accountId: ALICE.id, name: 'parked.example', kind: 'alias', siteType: 'php', redirect: null },
  { id: 'd3', accountId: ALICE.id, name: 'moved.example', kind: 'addon', siteType: 'php', redirect: { to: 'https://elsewhere.example/', code: 301 } },
  { id: 'd4', accountId: BOB.id, name: 'bob.example', kind: 'primary', siteType: 'static', redirect: null },
]
const SETTINGS = { panelPort: 2083, backendPort: 8080, backendTlsPort: 8443, sshPort: 22 }
const NOW = new Date('2026-11-07T10:00:00.000Z')
const RULE = { path: '/app', target: 'https://203.0.113.7:9443', websocket: true, hostHeader: 'client' }
let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-nginx-proxy-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function harness(options: { assertRoot?: () => Promise<void>; resolve?: (name: string) => Promise<string[]> } = {}) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const ports = {
    requireCaller: vi.fn(async () => ROOT), assertRoot: vi.fn(options.assertRoot ?? (async () => undefined)), emitAudit: vi.fn(async () => undefined), triggerReconcile: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }), listAccounts: async () => [ALICE, BOB], listDomains: async () => DOMAINS, getAccount: async (id: string) => [ALICE, BOB].find(item => item.id === id) ?? null,
      getServerSettings: async () => SETTINGS, listServerIps: async () => [{ address: '198.51.100.4' }] },
    resolveHost: options.resolve ?? (async () => { throw new Error('no resolver') }), now: () => NOW,
  } as unknown as NginxProxyPorts
  const call = async (path: string, method = 'GET', body?: unknown) => handleNginxProxyRoute(new Request('http://api.test' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://api.test' + path), method, ports)
  const send = async (path: string, method = 'GET', body?: unknown): Promise<Record<string, any>> => (await call(path, method, body))!.json()
  return { ports, call, send }
}
const domainPath = '/api/server/nginx-proxy/domains/alice.example'

describe('NGINX Reverse Proxy Manager', () => {
  it('saves a rule for one domain, audits it and hands it to the renderer', async () => {
    const h = harness()
    const empty = await h.send(domainPath)
    expect(empty).toMatchObject({ domain: { name: 'alice.example', account: 'alice' }, state: 'default', rules: [] })
    const added = await h.send(domainPath, 'POST', { expectedRevision: empty.revision, add: RULE })
    expect(added).toMatchObject({ state: 'saved', reconcile: 'requested', rules: [{ ...RULE, refusal: null }] })
    expect(h.ports.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.nginx_proxy.rule_added', target: 'domain:alice.example', detail: { domain: 'alice.example', path: '/app', target: RULE.target } }))
    expect(h.ports.triggerReconcile).toHaveBeenCalledTimes(1)
    const edges = await readAccountEdge(root, [ALICE])
    expect(accountEdgeSiteOptions(edges, ALICE.id).proxyRules).toEqual({ 'alice.example': [{ path: '/app', target: RULE.target, options: { websocket: true, hostHeader: 'client', headers: [] } }] })
    const removed = await h.send(domainPath, 'POST', { expectedRevision: added.revision, remove: '/app' })
    expect(removed.rules).toEqual([])
    expect(h.ports.emitAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'server.nginx_proxy.rule_removed' }))
  })

  it.each([
    ['http://127.0.0.1:9000', 'loopback'], ['http://[::1]:9000', 'loopback'], ['http://169.254.169.254', 'forbidden_range'], ['http://203.0.113.7:2087', 'panel_port'], ['http://203.0.113.7:8080', 'panel_port'],
    ['http://198.51.100.4:9000', 'own_address'], ['http://198.51.100.8:9000', 'own_address'], ['http://[2001:db8:0:0::8]:9000', 'own_address'], ['http://203.0.113.7/base', 'invalid'], ['https://app.example.net', 'resolver_unavailable'],
  ])('refuses %s as %s before writing', async (target, code) => {
    const h = harness(), empty = await h.send(domainPath)
    await expect(h.send(domainPath, 'POST', { expectedRevision: empty.revision, add: { ...RULE, target } })).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false, fields: [{ field: 'target', code }] } })
    await expect(readFile(join(root, proxyRulesPath(ALICE.id)))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(h.ports.triggerReconcile).not.toHaveBeenCalled()
  })

  it('checks what a named target resolves to', async () => {
    const edge = { resolvers: ['192.0.2.53'] }
    const named = harness({ resolve: async name => name === 'app.example.net' ? ['203.0.113.9'] : name === 'self.example.net' ? ['198.51.100.4'] : name === 'back.example.net' ? ['127.0.0.1'] : [] })
    ;(named.ports.store as unknown as { getServerSettings: () => Promise<unknown> }).getServerSettings = async () => ({ ...SETTINGS, edge })
    const empty = await named.send(domainPath)
    for (const [host, code] of [['self.example.net', 'resolves_internal'], ['back.example.net', 'resolves_internal'], ['gone.example.net', 'unresolved']] as const)
      await expect(named.send(domainPath, 'POST', { expectedRevision: empty.revision, add: { ...RULE, target: 'https://' + host } })).rejects.toMatchObject({ detail: { fields: [{ field: 'target', code }] } })
    expect((await named.send(domainPath, 'POST', { expectedRevision: empty.revision, add: { ...RULE, target: 'https://app.example.net' } })).rules).toHaveLength(1)
  })

  it('refuses aliases, redirects, duplicates, bad paths and stale revisions', async () => {
    const h = harness(), empty = await h.send(domainPath)
    const body = { expectedRevision: empty.revision, add: RULE }
    await expect(h.send('/api/server/nginx-proxy/domains/parked.example', 'POST', body)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'domain_alias' } })
    await expect(h.send('/api/server/nginx-proxy/domains/moved.example', 'POST', body)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'domain_redirect' } })
    await expect(h.send('/api/server/nginx-proxy/domains/none.example')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    for (const path of ['app', '/App', '/app/', '/.well-known', '/a b', '/a;b']) await expect(h.send(domainPath, 'POST', { ...body, add: { ...RULE, path } })).rejects.toMatchObject({ detail: { fields: [{ field: 'path', code: 'invalid' }] } })
    const added = await h.send(domainPath, 'POST', body)
    await expect(h.send(domainPath, 'POST', body)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(h.send(domainPath, 'POST', { expectedRevision: added.revision, add: RULE })).rejects.toMatchObject({ detail: { fields: [{ field: 'path', code: 'duplicate' }] } })
    await expect(h.send(domainPath, 'POST', { expectedRevision: added.revision, remove: '/other' })).rejects.toMatchObject({ detail: { fields: [{ field: 'remove', code: 'not_found' }] } })
  })

  it('stops non-root callers before reading anything', async () => {
    const h = harness({ assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN' }) } })
    await expect(h.send('/api/server/nginx-proxy')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(h.send(domainPath, 'POST', {})).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await h.call('/api/server/other')).toBeNull()
    expect((await harness().call('/api/server/nginx-proxy', 'POST'))!.status).toBe(405)
  })

  it('switches and purges the cache per account and in bulk, leaving others alone', async () => {
    const h = harness(), first = await h.send('/api/server/nginx-proxy')
    expect(first.accounts.map((row: { username: string }) => row.username)).toEqual(['alice', 'bob'])
    expect(first.domains.map((row: { name: string }) => row.name)).toEqual(['alice.example', 'bob.example', 'moved.example'])
    const [alice, bob] = first.accounts as { username: string; cache: { revision: string; enabled: boolean } }[]
    expect(alice!.cache.enabled).toBe(true)
    const off = await h.send('/api/server/nginx-proxy/cache', 'POST', { op: 'disable', accounts: [{ username: 'alice', expectedRevision: alice!.cache.revision }] })
    expect(off).toMatchObject({ changed: 1, reconcile: 'requested' })
    expect(off.accounts[0].cache.enabled).toBe(false)
    expect(off.accounts[1].cache.enabled).toBe(true)
    expect(accountEdgeSiteOptions(await readAccountEdge(root, [ALICE, BOB]), ALICE.id)).toMatchObject({ cache: false })
    expect(accountEdgeSiteOptions(await readAccountEdge(root, [ALICE, BOB]), BOB.id)).toEqual({})
    expect(h.ports.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.nginx_proxy.cache_disabled', detail: { accounts: 1 } }))
    const stale = { op: 'purge', accounts: [{ username: 'alice', expectedRevision: alice!.cache.revision }] }
    await expect(h.send('/api/server/nginx-proxy/cache', 'POST', stale)).rejects.toMatchObject({ code: 'CONFLICT' })
    const purged = await h.send('/api/server/nginx-proxy/cache', 'POST', { op: 'purge', accounts: off.accounts.map((row: { username: string; cache: { revision: string } }) => ({ username: row.username, expectedRevision: row.cache.revision })) })
    expect(purged.changed).toBe(2)
    expect(JSON.parse(await readFile(join(root, edgeStatePath('cache', BOB.id)), 'utf8'))).toMatchObject({ enabled: true, purgedAt: NOW.toISOString() })
    const again = await h.send('/api/server/nginx-proxy/cache', 'POST', { op: 'disable', accounts: [{ username: 'alice', expectedRevision: purged.accounts[0].cache.revision }] })
    expect(again).toMatchObject({ changed: 0, reconcile: null })
    await expect(h.send('/api/server/nginx-proxy/cache', 'POST', { op: 'purge', accounts: [{ username: 'alice', expectedRevision: bob!.cache.revision }, { username: 'alice', expectedRevision: bob!.cache.revision }] })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('carries saved rules across a transfer and refuses anything else', () => {
    const proxyRules = { version: 1, rules: [{ domain: 'alice.example', path: '/app', target: RULE.target, options: { websocket: true, hostHeader: 'client', headers: [] } }], updatedAt: NOW.toISOString() }
    expect(parseAccountEdgeState({ proxyRules })).toEqual({ proxyRules })
    expect(parseAccountEdgeState({ proxyRules: { ...proxyRules, rules: [...proxyRules.rules, ...proxyRules.rules] } })).toBeNull()
    expect(parseAccountEdgeState({ proxyRules: { ...proxyRules, rules: [{ ...proxyRules.rules[0], target: 'http://x/ path' }] } })).toBeNull()
  })
})
