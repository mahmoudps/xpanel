import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OsProfile } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AgentExecutor } from './executor.ts'
import { secIngressProviderFor } from './sec-ingress-provider.ts'
import { handleSecRoute } from './sec-routes.ts'
import type { SecRouteContext } from './sec-routes.ts'
import { SEC_DNS_CLUSTER_STATE, secRevision } from './sec-policy.ts'

let dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))); dirs = [] })
const saved = { version: 1, policy: { peers: [{ name: 'ns2.example.net', address: '198.51.100.53' }] }, updatedAt: '2026-10-28T10:00:00.000Z' }
async function context(overrides: Partial<SecRouteContext> = {}): Promise<SecRouteContext & { calls: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'sec-routes-')); dirs.push(root)
  await mkdir(join(root, 'extended', 'dns'), { recursive: true })
  await writeFile(join(root, SEC_DNS_CLUSTER_STATE), JSON.stringify(saved))
  const calls: string[] = []
  const executor = { readFile: async () => null, runCommand: async () => ({ ok: true, code: 0, stdout: '{"nftables":[]}', stderr: '' }), writeFile: vi.fn(), removePath: vi.fn(), runAction: vi.fn() } as unknown as AgentExecutor
  return { calls, assertRoot: async action => { calls.push(action); return { actor: 'root' } }, executor, os: { family: 'debian', nginxConf: '/etc/nginx/nginx.conf', powerdnsUnit: 'pdns' }, rootDir: root,
    zones: async () => ['example.com'], present: async path => path === '/usr/sbin/nft', readText: async () => null, query: async () => ({ serial: 7 }), now: () => new Date('2026-10-28T12:00:00.000Z'), ...overrides }
}
const call = (ctx: SecRouteContext, path: string, method = 'GET', body?: unknown) => handleSecRoute(new Request('http://agent.local' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://agent.local' + path), method, ctx)

describe('sec agent routes', () => {
  it('requires root before anything, then refuses wrong methods, selectors and a missing host executor', async () => {
    const ctx = await context()
    expect(await call(ctx, '/host/other')).toBeNull()
    await expect(call({ ...ctx, assertRoot: async () => { throw Object.assign(new Error('no'), { code: 'FORBIDDEN' }) } }, '/host/sec/waf')).rejects.toThrow('no')
    expect((await call(ctx, '/host/sec/waf', 'POST'))!.status).toBe(405)
    await expect(call(ctx, '/host/sec/flood?x=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(ctx, '/host/sec/dns-cluster/verify?peer=a&peer=b')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call({ ...ctx, executor: null }, '/host/sec/waf')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('serves the owner WAF summary to any authenticated caller without root', async () => {
    const ctx = await context({ assertRoot: async () => { throw new Error('root required') }, assertCaller: async () => {} })
    expect(await (await call(ctx, '/host/sec/waf/summary'))!.json()).toMatchObject({ connector: { nginx: false }, active: { lists: null } })
    await expect(call(ctx, '/host/sec/waf')).rejects.toThrow('root required')
  })
  it('observes from saved peers only and verifies a named saved peer', async () => {
    const ctx = await context()
    expect(await (await call(ctx, '/host/sec/flood'))!.json()).toMatchObject({ state: 'read', rules: { connections: 0 } })
    expect(await (await call(ctx, '/host/sec/dns-cluster'))!.json()).toMatchObject({ state: 'not_installed', peers: [{ name: 'ns2.example.net', transferAllowed: null }] })
    expect(await (await call(ctx, '/host/sec/dns-cluster/verify?peer=ns2.example.net'))!.json()).toMatchObject({ counts: { in_sync: 1 }, zones: [{ zone: 'example.com', state: 'in_sync' }] })
    await expect(call(ctx, '/host/sec/dns-cluster/verify?peer=ns9.example.net')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('applies only the exact saved revision and re-checks root before writing', async () => {
    const ctx = await context()
    await expect(call(ctx, '/host/sec/dns-cluster/apply', 'POST', { expectedRevision: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call(ctx, '/host/sec/dns-cluster/apply', 'POST', { expectedRevision: secRevision('dns-cluster', saved), peers: [] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(ctx, '/host/sec/dns-cluster/apply', 'POST', { expectedRevision: secRevision('dns-cluster', saved) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'powerdns_unreadable' } })
    expect((ctx.executor as unknown as { writeFile: ReturnType<typeof vi.fn> }).writeFile).not.toHaveBeenCalled()
  })
})

describe('sec agent server wiring', () => {
  // Compile-time proof that the integration hunk type-checks against the real agent server dependencies.
  const wire = (executor: AgentExecutor, store: StateStore, os: OsProfile, req: Request) => secIngressProviderFor({ executor, os, store, managementClient: req.headers.get('x-xpanel-management-client') })
  it('builds a provider that refuses to observe without the live nginx.conf', async () => {
    const os = { family: 'debian', paths: { nginxRoot: '/etc/nginx' }, services: { nginx: 'nginx' } } as unknown as OsProfile
    const executor = { readFile: async () => null } as unknown as AgentExecutor
    const store = { rootDir: '/nonexistent', readSnapshot: async () => ({ server: null, domains: [] }) } as unknown as StateStore
    await expect(wire(executor, store, os, new Request('http://agent.local/host/trusted-proxies', { headers: { 'x-xpanel-management-client': '198.51.100.7' } })).observe()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
