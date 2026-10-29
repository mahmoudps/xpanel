import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { suggestServerSettings, XpanelError } from '@xpanel/core'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { createTestStateStore } from '@xpanel/state'
import { atomicWriteJson } from '@xpanel/state'
import { readAccountRuntimeView } from '../../../packages/os/src/account-runtime-command.ts'
import {
  applyRuntimeOp, buildDepsCommand, cacheCapMb, compileAccountRuntime, EMPTY_RUNTIME, handleAccountRuntimeRoute, isAccountRuntimeCommand, parseRuntimeRegistry,
  readRuntimeHostFacts, readRuntimeRegistry, readUnitStates, runtimeRegistryPath, runtimeRevision, type RuntimeHost, type RuntimeRegistry,
  buildPodmanCleanupCommand, preflightApp, readRuntimeGeneration, removeRuntimeRegistry, restoreRuntimeRegistries, saveRuntimeGeneration, type RuntimeFiles,
} from './account-runtime.ts'
import { compileDesiredGeneration, HostReconciler } from './reconciler.ts'
import { FakeHostExecutor } from './executor.ts'
import { createTestDb } from '@xpanel/db'

const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111', DOMAIN_ID = '22222222-2222-4222-8222-222222222222', PRINCIPAL = '33333333-3333-4333-8333-333333333333'
const account: Account = { id: ACCOUNT_ID, username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice-shop.com', planId: 'plan', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'a@example.com', ipv4: '192.0.2.1', shell: 'none', createdAt: '2026-10-29T00:00:00Z' } as Account
const plan = { id: 'plan', name: 'Business', ownerId: null, featureListId: 'fl', resources: { diskMb: 10240, bandwidthMbMonth: 'unlimited', ioReadBps: 'unlimited', ioWriteBps: 'unlimited', ioReadIops: 'unlimited', ioWriteIops: 'unlimited', memoryMb: 1024, maxProcesses: 128, cpuPercent: 100 } } as unknown as Plan
const domain = { id: DOMAIN_ID, accountId: ACCOUNT_ID, name: 'alice-shop.com', kind: 'primary', suspended: false } as Domain
const app = { name: 'shop', runtime: 'node' as const, root: 'apps/shop', startup: 'server.js', domainId: DOMAIN_ID, path: '/api', env: { TOKEN: 's3cret' }, enabled: true, updatedAt: '2026-10-29T00:00:00.000Z' }
const registry: RuntimeRegistry = { apps: [app], cache: { redis: { enabled: true, memoryMb: 64, binary: '/usr/bin/redis-server', updatedAt: app.updatedAt }, memcached: null }, containers: [{ name: 'kuma', image: 'docker.io/louislam/uptime-kuma:1', env: {}, enabled: true, updatedAt: app.updatedAt }] }

const fakeHost = (over: Partial<RuntimeHost> & { files?: string[]; text?: Record<string, string> } = {}): RuntimeHost & { calls: string[][] } => {
  const files = new Set(over.files ?? ['/usr/bin/node', '/usr/bin/python3', '/usr/lib/systemd/systemd-socket-proxyd', '/usr/bin/redis-server', '/usr/bin/memcached', '/usr/bin/podman', '/usr/bin/newuidmap'])
  const calls: string[][] = []
  const versions: Record<string, string> = { '/usr/bin/node': 'v18.19.1', '/usr/bin/python3': 'Python 3.12.3', '/usr/bin/redis-server': 'Redis server v=7.0.15 sha=0', '/usr/bin/memcached': 'memcached 1.6.24', '/usr/bin/podman': 'podman version 4.9.3' }
  return {
    calls,
    exists: async path => files.has(path),
    run: async argv => { calls.push(argv); return argv[0] === '/usr/bin/systemctl' ? { ok: true, code: 0, stdout: '', stderr: '' } : { ok: true, code: 0, stdout: versions[argv[0]!] ?? '', stderr: '' } },
    systemd: async (verb, unit) => { calls.push(['systemctl', verb, unit]) },
    probe: async () => 200,
    readText: async path => over.text?.[path] ?? 'alice:100000:65536\n',
    ...over,
  }
}
const facts = () => readRuntimeHostFacts(fakeHost(), account)

describe('runtime registry', () => {
  it('reads strictly and refuses traversal, reserved env, duplicate paths and foreign registries', () => {
    expect(parseRuntimeRegistry(registry)).toEqual(registry)
    for (const bad of [
      { ...registry, apps: [{ ...app, root: '../bob' }] },
      { ...registry, apps: [{ ...app, env: { PORT: '1' } }] },
      { ...registry, apps: [app, { ...app, name: 'other' }] },
      { ...registry, cache: { redis: { ...registry.cache.redis, binary: '/tmp/redis' }, memcached: null } },
      { ...registry, containers: [{ ...registry.containers[0], image: 'evil.example/x:1' }] },
      { ...registry, extra: true },
    ]) expect(() => parseRuntimeRegistry(bad)).toThrowError(XpanelError)
  })
})

describe('compileAccountRuntime', () => {
  it('renders units in the slice and routes the app path of an owned site to its front socket', () => {
    const r = compileAccountRuntime(account, plan, [domain], registry, os)
    expect(r.units).toEqual(['xpanel-app-alice-shop.service', 'xpanel-appproxy-alice-shop.socket', 'xpanel-appproxy-alice-shop.service', 'xpanel-redis-alice.service', 'xpanel-ctr-alice-kuma.service'])
    expect(r.routes).toEqual({ 'alice-shop.com': [{ path: '/api', socket: '/run/xpanel-app-proxy/alice-shop.sock' }] })
    expect(r.files.map(f => f.path)).toContain('/etc/xpanel/runtime/alice/shop.env')
    expect(r.postActions).toContainEqual({ kind: 'systemd', verb: 'start', unit: 'xpanel-appproxy-alice-shop.socket' })
    expect(r.files.find(f => f.path.endsWith('xpanel-redis-alice.service'))!.content).toContain('--maxmemory 64mb')
    expect(r.files.find(f => f.path.endsWith('xpanel-ctr-alice-kuma.service'))!.content).toContain('--memory=1024m --cpus=1.00 --pids-limit=128')
  })

  it('renders nothing for a suspended account, a disabled entry or a plan without the feature', () => {
    expect(compileAccountRuntime({ ...account, status: 'suspended' }, plan, [domain], registry, os).files).toEqual([])
    expect(compileAccountRuntime(account, plan, [domain], { ...registry, apps: [{ ...app, enabled: false }], cache: { redis: null, memcached: null }, containers: [] }, os).files).toEqual([])
    expect(compileAccountRuntime(account, plan, [domain], registry, os, ['application-manager', 'account-cache-services', 'account-containers']).units).toEqual([])
  })

  it('never routes another account’s domain or an alias', () => {
    expect(compileAccountRuntime(account, plan, [{ ...domain, accountId: 'other' }], registry, os).routes).toEqual({})
    expect(compileAccountRuntime(account, plan, [{ ...domain, kind: 'alias' }], registry, os).routes).toEqual({})
  })

  it('caps cache memory by the plan', () => {
    expect(cacheCapMb(1024)).toBe(256)
    expect(cacheCapMb('unlimited')).toBe(256)
    expect(cacheCapMb(8192)).toBe(1024)
    const r = compileAccountRuntime(account, { ...plan, resources: { ...plan.resources, memoryMb: 128 } }, [domain], registry, os)
    expect(r.files.find(f => f.path.endsWith('xpanel-redis-alice.service'))!.content).toContain('--maxmemory 32mb')
  })
})

describe('applyRuntimeOp', () => {
  const input = async () => ({ account, plan, disabled: [] as string[], facts: await facts(), domains: [domain], now: '2026-10-29T01:00:00.000Z' })
  const r = runtimeRevision(EMPTY_RUNTIME)

  it('saves a new app stopped and keeps paths unique per domain', async () => {
    const i = await input()
    const next = applyRuntimeOp({ op: 'app.save', expectedRevision: r, app: { name: 'web', runtime: 'node', root: 'web', startup: 'index.js', domainId: DOMAIN_ID, path: '/', env: {} } }, EMPTY_RUNTIME, i)
    expect(next.apps).toEqual([{ name: 'web', runtime: 'node', root: 'web', startup: 'index.js', domainId: DOMAIN_ID, path: '/', env: {}, enabled: false, updatedAt: '2026-10-29T01:00:00.000Z' }])
    expect(() => applyRuntimeOp({ op: 'app.save', expectedRevision: r, app: { name: 'web2', runtime: 'node', root: 'web2', startup: 'index.js', domainId: DOMAIN_ID, path: '/', env: {} } }, next, i)).toThrowError(expect.objectContaining({ code: 'CONFLICT' }))
  })

  it('refuses a runtime the host lacks, a foreign domain, cache above the plan and containers without the engine', async () => {
    const i = await input()
    const save = (over: object) => applyRuntimeOp({ op: 'app.save', expectedRevision: r, app: { name: 'web', runtime: 'node', root: 'web', startup: 'index.js', domainId: DOMAIN_ID, path: '/', env: {}, ...over } as never }, EMPTY_RUNTIME, i)
    expect(() => save({ runtime: 'ruby' })).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
    expect(() => applyRuntimeOp({ op: 'app.save', expectedRevision: r, app: { name: 'web', runtime: 'node', root: 'web', startup: 'index.js', domainId: DOMAIN_ID, path: '/', env: {} } }, EMPTY_RUNTIME, { ...i, domains: [{ ...domain, accountId: 'bob' }] })).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => applyRuntimeOp({ op: 'cache.save', expectedRevision: r, service: 'redis', enabled: true, memoryMb: 512 }, EMPTY_RUNTIME, i)).toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }))
    const noEngine = { ...i, facts: { ...i.facts, containers: { available: false, version: null, reason: 'no-subordinate-ids' as const } } }
    expect(() => applyRuntimeOp({ op: 'container.run', expectedRevision: r, container: { name: 'kuma', image: 'docker.io/louislam/uptime-kuma:1', env: {} } }, EMPTY_RUNTIME, noEngine)).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
    expect(() => applyRuntimeOp({ op: 'cache.save', expectedRevision: r, service: 'redis', enabled: true, memoryMb: 64 }, EMPTY_RUNTIME, { ...i, disabled: ['account-cache-services'] })).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
  })

  it('returns the same registry when nothing is saved', async () => {
    const i = await input()
    expect(applyRuntimeOp({ op: 'app.restart', expectedRevision: r, name: 'shop' }, registry, i)).toBe(registry)
    expect(applyRuntimeOp({ op: 'app.start', expectedRevision: r, name: 'shop' }, registry, i)).toBe(registry)
    expect(applyRuntimeOp({ op: 'app.stop', expectedRevision: r, name: 'shop' }, registry, i).apps[0]!.enabled).toBe(false)
  })
})

describe('host facts', () => {
  it('reads installed versions and reports what is missing truthfully', async () => {
    const f = await facts()
    expect(f.runtimes).toEqual([
      { kind: 'node', available: true, version: '18.19.1', reason: null },
      { kind: 'python', available: true, version: '3.12.3', reason: null },
      { kind: 'ruby', available: false, version: null, reason: 'not-installed' },
    ])
    expect(f.cache[0]).toEqual({ service: 'redis', available: true, version: '7.0.15', binary: '/usr/bin/redis-server', reason: null })
    expect(f.containers).toEqual({ available: true, version: '4.9.3', reason: null })
    const noIds = await readRuntimeHostFacts(fakeHost({ text: { '/etc/subuid': 'bob:100000:65536\n', '/etc/subgid': 'bob:100000:65536\n' } }), account)
    expect(noIds.containers.reason).toBe('no-subordinate-ids')
    const noProxy = await readRuntimeHostFacts(fakeHost({ files: ['/usr/bin/node'] }), account)
    expect(noProxy.runtimes[0]).toEqual({ kind: 'node', available: false, version: '18.19.1', reason: 'proxy-unavailable' })
    expect((await readRuntimeHostFacts(null, account)).runtimes.every(r => !r.available)).toBe(true)
  })

  it('parses systemctl show blocks per unit', async () => {
    const host = fakeHost({ run: async () => ({ ok: true, code: 0, stderr: '', stdout: 'Id=a.service\nLoadState=loaded\nActiveState=active\nSubState=running\nActiveEnterTimestamp=@1761696000\nMemoryCurrent=1048576\nCPUUsageNSec=5\nNRestarts=0\n\nId=b.service\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nActiveEnterTimestamp=\nMemoryCurrent=[not set]\nCPUUsageNSec=[not set]\nNRestarts=0\n' }) })
    const states = await readUnitStates(host, ['a.service', 'b.service'])
    expect(states.get('a.service')).toEqual({ load: 'loaded', active: 'active', sub: 'running', since: '2025-10-29T00:00:00.000Z', memoryBytes: 1048576, cpuNs: 5, restarts: 0 })
    expect(states.get('b.service')?.memoryBytes).toBeNull()
  })
})

describe('dependency installs', () => {
  it('run as the account in its slice and are admitted only in their exact shape', () => {
    const argv = buildDepsCommand(account, app)
    expect(argv.slice(0, 4)).toEqual(['/usr/bin/systemd-run', '--unit=xpanel-deps-alice-shop.service', '--no-block', '--quiet'])
    expect(argv).toContain('User=20014')
    expect(argv).toContain('Slice=xpanel-20014.slice')
    expect(argv).toContain('--working-directory=/home/alice/apps/shop')
    // RuntimeMaxSec= does not apply to Type=oneshot; the start timeout bounds the whole install.
    expect(argv).toEqual(expect.arrayContaining(['Type=oneshot', 'TimeoutStartSec=900s']))
    expect(argv.slice(argv.lastIndexOf('--') + 1)).toEqual(['/usr/bin/npm', 'install', '--omit=dev', '--no-audit', '--no-fund'])
    expect(isAccountRuntimeCommand(argv)).toBe(true)
    expect(isAccountRuntimeCommand(argv.map(v => v === 'User=20014' ? 'User=0' : v))).toBe(false)
    expect(isAccountRuntimeCommand([...argv.slice(0, -1), '--global'])).toBe(false)
    expect(isAccountRuntimeCommand(argv.map(v => v.startsWith('--working-directory=') ? '--working-directory=/home/bob/x' : v))).toBe(false)
    expect(isAccountRuntimeCommand(buildDepsCommand(account, { ...app, runtime: 'python' }))).toBe(true)
  })
})

describe('account runtime route', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xpanel-runtime-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  const context = (over: { host?: RuntimeHost | null; reconcile?: () => Promise<{ status: 'noop' | 'applied' | 'failed' }>; files?: RuntimeFiles } = {}) => {
    const reconciles: number[] = []
    return {
      reconciles,
      ctx: {
        caller: { principalId: PRINCIPAL, actor: 'alice', role: 'user' as const, accountId: ACCOUNT_ID, resellerId: null },
        store: { rootDir: root, getAccountByUsername: async (u: string) => u === account.username ? account : u === 'bob' ? { ...account, id: '44444444-4444-4444-8444-444444444444', username: 'bob' } : null,
          listDomains: async () => [domain], getPlan: async () => plan, getFeatureList: async () => ({ id: 'fl', name: 'f', ownerId: null, disabled: [] }) as FeatureList, withAccountLifecycleLease: async <T>(_id: string, op: (a: Account) => Promise<T>) => op(account) },
        currentPrincipal: async () => ({ kind: 'user', id: PRINCIPAL, username: 'alice', accountId: ACCOUNT_ID, disabled: false }),
        os, host: over.host === undefined ? fakeHost() : over.host, files: over.files ? () => over.files! : null,
        reconcile: async () => { reconciles.push(1); return over.reconcile ? over.reconcile() : { status: 'applied' as const } },
        audit: async () => undefined,
      },
    }
  }
  const call = (ctx: Parameters<typeof handleAccountRuntimeRoute>[3], method: string, path: string, body?: unknown) =>
    handleAccountRuntimeRoute(new Request('http://agent' + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), new URL('http://agent' + path), method, ctx)

  it('reads a view the shared grammar accepts, without secrets of other accounts', async () => {
    await atomicWriteJson(runtimeRegistryPath(root, ACCOUNT_ID), registry, 0o600)
    const res = await call(context().ctx, 'GET', '/accounts/alice/runtime')
    const view = readAccountRuntimeView(await res!.json())
    expect(view.revision).toBe(runtimeRevision(registry))
    expect(view.apps[0]).toMatchObject({ name: 'shop', state: 'stopped', env: [{ name: 'TOKEN', value: 's3cret' }] })
    expect(view.cache[0]).toMatchObject({ service: 'redis', enabled: true, socket: '/home/alice/.xpanel-cache/redis.sock' })
    expect(view.plan).toMatchObject({ cacheMaxMb: 256, memoryMb: 1024 })
  })

  it('refuses another account, stale revisions and hosts without the reconciler', async () => {
    const { ctx } = context()
    await expect(call(ctx, 'GET', '/accounts/bob/runtime')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(ctx, 'POST', '/accounts/alice/runtime', { op: 'cache.save', expectedRevision: 'f'.repeat(64), service: 'redis', enabled: true, memoryMb: 64 })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call(context({ host: null }).ctx, 'POST', '/accounts/alice/runtime', { op: 'cache.save', expectedRevision: runtimeRevision(EMPTY_RUNTIME), service: 'redis', enabled: true, memoryMb: 64 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('saves, reconciles and restarts; a failed reconcile restores the saved state', async () => {
    const ok = context()
    const res = await call(ok.ctx, 'POST', '/accounts/alice/runtime', { op: 'cache.save', expectedRevision: runtimeRevision(EMPTY_RUNTIME), service: 'redis', enabled: true, memoryMb: 64 })
    expect(res!.status).toBe(200)
    expect(ok.reconciles).toHaveLength(1)
    expect((await readRuntimeRegistry(root, ACCOUNT_ID)).cache.redis).toMatchObject({ enabled: true, memoryMb: 64, binary: '/usr/bin/redis-server' })
    const host = (ok.ctx.host as ReturnType<typeof fakeHost>)
    expect(host.calls).toContainEqual(['systemctl', 'restart', 'xpanel-redis-alice.service'])

    const saved = await readFile(runtimeRegistryPath(root, ACCOUNT_ID), 'utf8')
    const bad = context({ reconcile: async () => ({ status: 'failed' }) })
    await expect(call(bad.ctx, 'POST', '/accounts/alice/runtime', { op: 'cache.save', expectedRevision: runtimeRevision(JSON.parse(saved)), service: 'memcached', enabled: true, memoryMb: 32 })).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
    expect(await readFile(runtimeRegistryPath(root, ACCOUNT_ID), 'utf8')).toBe(saved)
    expect(bad.reconciles).toHaveLength(2)
  })

  it('refuses to start an app the preflight finds unready and cleans the image of a removed container', async () => {
    await atomicWriteJson(runtimeRegistryPath(root, ACCOUNT_ID), { ...registry, apps: [{ ...app, enabled: false }] }, 0o600)
    const { ctx } = context({ files: fakeFiles({ 'apps/shop': null, 'apps/shop/package.json': '{}' }) })
    const reg = await readRuntimeRegistry(root, ACCOUNT_ID)
    await expect(call(ctx, 'POST', '/accounts/alice/runtime', { op: 'app.start', expectedRevision: runtimeRevision(reg), name: 'shop' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: expect.objectContaining({ problems: ['startup-missing', 'node-modules-missing'] }) })
    const view = readAccountRuntimeView(await (await call(ctx, 'GET', '/accounts/alice/runtime'))!.json())
    expect(view.apps[0]!.preflight).toEqual(['startup-missing', 'node-modules-missing'])
    const removed = await call(ctx, 'POST', '/accounts/alice/runtime', { op: 'container.remove', expectedRevision: runtimeRevision(reg), name: 'kuma' })
    expect(removed!.status).toBe(200)
    const host = ctx.host as ReturnType<typeof fakeHost>
    expect(host.calls.some(argv => argv[1] === '--unit=xpanel-podclean-alice.service' && argv.at(-1) === 'docker.io/louislam/uptime-kuma:1' && isAccountRuntimeCommand(argv))).toBe(true)
    const pruned = await call(ctx, 'POST', '/accounts/alice/runtime', { op: 'container.prune', expectedRevision: runtimeRevision(await readRuntimeRegistry(root, ACCOUNT_ID)) })
    expect(pruned!.status).toBe(202)
    expect(host.calls.some(argv => argv.at(-1) === '--force' && isAccountRuntimeCommand(argv))).toBe(true)
  })

  it('starts a dependency install through the admitted command and reads logs of saved entries only', async () => {
    await atomicWriteJson(runtimeRegistryPath(root, ACCOUNT_ID), registry, 0o600)
    const { ctx } = context()
    const res = await call(ctx, 'POST', '/accounts/alice/runtime', { op: 'app.deps', expectedRevision: runtimeRevision(registry), name: 'shop' })
    expect(res!.status).toBe(202)
    const host = ctx.host as ReturnType<typeof fakeHost>
    expect(host.calls.some(argv => argv[1] === '--unit=xpanel-deps-alice-shop.service' && isAccountRuntimeCommand(argv))).toBe(true)
    const log = await call(ctx, 'GET', '/accounts/alice/runtime/log?target=app:shop')
    expect(await log!.json()).toMatchObject({ unit: 'xpanel-app-alice-shop.service' })
    await expect(call(ctx, 'GET', '/accounts/alice/runtime/log?target=app:other')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call(ctx, 'GET', '/accounts/alice/runtime/log?target=../x')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('reconciler integration', () => {
  it('renders runtime units and the app route into the account generation', async () => {
    const state = await createTestStateStore()
    const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
    await state.store.saveServerSettings({ hostname: 'fixture.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com',
      engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
    const features = await state.store.createFeatureList({ name: 'Fixture', ownerId: null, disabled: [] })
    const p = await state.store.createPlan({ name: 'Fixture', ownerId: null, featureListId: features.id, resources: plan.resources,
      caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 2 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 1024 })
    await state.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    // Shape-only state fixture; never authenticated.
    const a = await state.store.createAccount({ username: 'alice', passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo', primaryDomain: 'alice-shop.com', planId: p.id,
      ownerId: null, contactEmail: 'alice@example.com', ipv4: '203.0.113.10', shell: 'none',
      php: { version: '8.3', handler: 'fpm', ini: {}, fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 } } })
    const d = (await state.store.listDomains({ accountId: a.id }))[0]!
    const runtime = new Map([[a.id, { ...registry, apps: [{ ...app, domainId: d.id, runtime: 'python' as const, startup: 'passenger_wsgi.py' }] }]])
    const compiled = compileDesiredGeneration(await state.store.readSnapshot(), { os, quotaFilesystem: '/home', runtime })
    const site = compiled.files.find(f => f.path.endsWith('/xpanel-alice.conf') && f.content.includes('server_name'))!
    expect(site.content).toContain('proxy_pass http://unix:/run/xpanel-app-proxy/alice-shop.sock:;')
    expect(compiled.files.map(f => f.path)).toEqual(expect.arrayContaining(['/etc/systemd/system/xpanel-app-alice-shop.service', '/etc/xpanel/runtime/wsgi-unix.py', '/etc/systemd/system/xpanel-ctr-alice-kuma.service']))
    expect(compiled.postActions).toContainEqual({ kind: 'systemd', verb: 'start', unit: 'xpanel-redis-alice.service' })
  })
})

const fakeFiles = (tree: Record<string, string | null>): RuntimeFiles => ({
  // tree: relative path -> file content, or null for a directory
  list: async dir => {
    if (tree[dir] !== null) throw new XpanelError('NOT_FOUND', 'missing')
    return Object.keys(tree).filter(path => path.startsWith(dir + '/') && !path.slice(dir.length + 1).includes('/')).map(path => ({ name: path.slice(dir.length + 1), kind: tree[path] === null ? 'directory' : 'file' }))
  },
  readText: async path => typeof tree[path] === 'string' ? { content: tree[path]! } : Promise.reject(new XpanelError('NOT_FOUND', 'missing')),
})

describe('dependency preflight', () => {
  it('names what each runtime still needs', async () => {
    expect(await preflightApp(fakeFiles({}), app)).toEqual(['root-missing'])
    expect(await preflightApp(fakeFiles({ 'apps/shop': null, 'apps/shop/package.json': '{}' }), app)).toEqual(['startup-missing', 'node-modules-missing'])
    expect(await preflightApp(fakeFiles({ 'apps/shop': null, 'apps/shop/server.js': '', 'apps/shop/package.json': '{}', 'apps/shop/node_modules': null }), app)).toEqual([])
    expect(await preflightApp(fakeFiles({ 'apps/py': null, 'apps/py/passenger_wsgi.py': '' }), { runtime: 'python', root: 'apps/py', startup: 'passenger_wsgi.py' })).toEqual(['venv-missing'])
    const ruby = { runtime: 'ruby' as const, root: 'apps/rb', startup: 'config.ru' }
    expect(await preflightApp(fakeFiles({ 'apps/rb': null, 'apps/rb/config.ru': '' }), ruby)).toEqual(['gemfile-missing'])
    expect(await preflightApp(fakeFiles({ 'apps/rb': null, 'apps/rb/config.ru': '', 'apps/rb/Gemfile': 'gem "rack"\n' }), ruby)).toEqual(['puma-missing', 'bundle-missing'])
    expect(await preflightApp(fakeFiles({ 'apps/rb': null, 'apps/rb/config.ru': '', 'apps/rb/Gemfile': 'gem "rack"\n', 'apps/rb/Gemfile.lock': 'GEM\n  specs:\n    puma (6.4.2)\n', 'apps/rb/vendor': null, 'apps/rb/vendor/bundle': null }), ruby)).toEqual([])
  })

  it('reports python without venv support on the host as unavailable', async () => {
    const host = fakeHost({ run: async argv => ({ ok: argv[1] !== '-m', code: 0, stderr: '', stdout: argv[0] === '/usr/bin/python3' ? 'Python 3.12.3' : 'v18.19.1' }) })
    expect((await readRuntimeHostFacts(host, account)).runtimes[1]).toEqual({ kind: 'python', available: false, version: '3.12.3', reason: 'venv-missing' })
  })
})

describe('container image cleanup', () => {
  it('runs as the account on its own storage and is admitted only in its exact shape', () => {
    const rm = buildPodmanCleanupCommand(account, { image: 'docker.io/louislam/uptime-kuma:1' }), prune = buildPodmanCleanupCommand(account, 'prune')
    expect(rm.slice(-5)).toEqual(['--cgroup-manager=cgroupfs', 'image', 'rm', '--ignore', 'docker.io/louislam/uptime-kuma:1'])
    expect(prune.slice(-4)).toEqual(['image', 'prune', '--all', '--force'])
    expect(prune).toEqual(expect.arrayContaining(['User=20014', 'Slice=xpanel-20014.slice', 'BindPaths=/home/alice', '--setenv=XDG_RUNTIME_DIR=/run/xpanel-ctr/alice', 'TimeoutStartSec=600s']))
    expect(isAccountRuntimeCommand(rm) && isAccountRuntimeCommand(prune)).toBe(true)
    expect(isAccountRuntimeCommand(prune.map(v => v === 'BindPaths=/home/alice' ? 'BindPaths=/home/bob' : v))).toBe(false)
    expect(isAccountRuntimeCommand([...rm.slice(0, -1), 'evil.example/x:1'])).toBe(false)
    expect(isAccountRuntimeCommand([...prune.slice(0, -1), '--filter'])).toBe(false)
  })
})

describe('runtime registries across generations and purge', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xpanel-runtime-gen-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  it('saves the compiled set per generation and restores exactly it', async () => {
    const other = '44444444-4444-4444-8444-444444444444'
    await saveRuntimeGeneration(root, 7, new Map([[ACCOUNT_ID, registry], [other, EMPTY_RUNTIME]]))
    expect(await readRuntimeGeneration(root, 8)).toBeNull()
    const saved = (await readRuntimeGeneration(root, 7))!
    expect([...saved.keys()]).toEqual([ACCOUNT_ID])
    await atomicWriteJson(runtimeRegistryPath(root, other), { ...EMPTY_RUNTIME, containers: registry.containers }, 0o600)
    await atomicWriteJson(runtimeRegistryPath(root, ACCOUNT_ID), EMPTY_RUNTIME, 0o600)
    await restoreRuntimeRegistries(root, saved)
    expect(await readRuntimeRegistry(root, ACCOUNT_ID)).toEqual(registry)
    expect(await readRuntimeRegistry(root, other)).toEqual(EMPTY_RUNTIME)
    await removeRuntimeRegistry(root, ACCOUNT_ID)
    expect(await readRuntimeRegistry(root, ACCOUNT_ID)).toEqual(EMPTY_RUNTIME)
  })
})

describe('runtime registries through the real reconciler', () => {
  const handles: { close(): Promise<void> }[] = []
  afterEach(async () => { for (const handle of handles.splice(0)) await handle.close() })
  const setup = async () => {
    const state = await createTestStateStore(), db = await createTestDb(); handles.push(state, db)
    const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
    await state.store.saveServerSettings({ hostname: 'srv1.example.test', nameservers: ['ns1.example.test', 'ns2.example.test'], adminEmail: 'ops@example.test',
      engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
    const features = await state.store.createFeatureList({ name: 'Fixture', ownerId: null, disabled: [] })
    const p = await state.store.createPlan({ name: 'Fixture', ownerId: null, featureListId: features.id, resources: plan.resources,
      caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 2 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 1024 })
    await state.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    // Shape-only state fixture; never authenticated.
    const a = await state.store.createAccount({ username: 'alice', passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo', primaryDomain: 'alice-shop.com', planId: p.id,
      ownerId: null, contactEmail: 'alice@example.com', ipv4: '203.0.113.10', shell: 'none',
      php: { version: '8.3', handler: 'fpm', ini: {}, fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 } } })
    // Memory-only host model: proves the saved-state sequencing, not native capability.
    const executor = new FakeHostExecutor()
    const reconciler = new HostReconciler({ store: state.store, db: db.db, executor, os })
    const save = (r: RuntimeRegistry) => atomicWriteJson(runtimeRegistryPath(state.store.rootDir, a.id), r, 0o600)
    const units = (gen: number) => executor.files.has('/etc/systemd/system/xpanel-redis-alice.service') ? `redis@${gen}` : executor.files.has('/etc/systemd/system/xpanel-memcached-alice.service') ? `memcached@${gen}` : `none@${gen}`
    return { state, db, a, executor, reconciler, save, units }
  }
  const redis = { ...EMPTY_RUNTIME, cache: { redis: { enabled: true, memoryMb: 32, binary: '/usr/bin/redis-server', updatedAt: app.updatedAt }, memcached: null } }
  const memcached = { ...EMPTY_RUNTIME, cache: { redis: null, memcached: { enabled: true, memoryMb: 16, binary: '/usr/bin/memcached', updatedAt: app.updatedAt } } }

  it('restores the registries of the target generation on rollback', async () => {
    const f = await setup()
    await f.save(redis)
    const target = await f.reconciler.reconcile({ force: true, actor: 'root', mailAuth: null })
    if (target.status !== 'applied') throw new Error('target not applied')
    expect(f.units(1)).toBe('redis@1')
    await f.save(memcached)
    const current = await f.reconciler.reconcile({ force: true, actor: 'root', mailAuth: null })
    if (current.status !== 'applied') throw new Error('current not applied')
    expect(f.units(2)).toBe('memcached@2')
    const snapshot = await f.state.store.readSnapshot()
    const result = await f.reconciler.rollbackToGeneration(target.generation.id, 'root', { authorize: async () => undefined,
      request: { expectedCurrentGenerationId: current.generation.id, expectedCurrentStateRevision: snapshot.revision!, expectedTargetChecksum: target.generation.checksum, confirmation: String(target.generation.id) } })
    expect(result.status).toBe('applied')
    expect(await readRuntimeRegistry(f.state.store.rootDir, f.a.id)).toEqual(redis)
    expect(f.units(3)).toBe('redis@3')
  })

  it('purges the registry and the Podman runtime directory with the account', async () => {
    const f = await setup()
    await f.save({ ...redis, containers: registry.containers })
    expect((await f.reconciler.reconcile({ force: true, actor: 'root', mailAuth: null })).status).toBe('applied')
    await f.state.store.markTerminating(f.a.id)
    expect((await f.reconciler.reconcile({ force: true, actor: 'root', mailAuth: null })).status).toBe('applied')
    expect(f.executor.executedActions).toContainEqual({ kind: 'systemd', verb: 'stop', unit: 'xpanel-ctr-alice-kuma.service' })
    expect(f.executor.executedActions).toContainEqual({ kind: 'remove-path', path: '/run/xpanel-ctr/alice' })
    expect(f.units(4)).toBe('none@4')
    await expect(readFile(runtimeRegistryPath(f.state.store.rootDir, f.a.id), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
