import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Domain, Plan } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { handleAccountRuntimeWorkspaceRoute } from './account-runtime-workspace.ts'
import type { ReadAgent } from './account-ssh-workspace.ts'
import { EMPTY_RUNTIME, handleAccountRuntimeRoute, readRuntimeRegistry, runtimeRevision } from '../../agent/src/account-runtime.ts'
import type { RuntimeHost } from '../../agent/src/account-runtime.ts'

// The agent side is the actual handleAccountRuntimeRoute; only the host, the store and the transport are test doubles.
const ACCOUNT = '11111111-1111-4111-8111-111111111111', DOMAIN = '22222222-2222-4222-8222-222222222222', PRINCIPAL = '33333333-3333-4333-8333-333333333333'
const account = { id: ACCOUNT, username: 'alice', status: 'active', planId: 'plan', uid: 20014, gid: 20014, home: '/home/alice' } as Account
const plan = { id: 'plan', featureListId: 'list', resources: { memoryMb: 1024, cpuPercent: 100, maxProcesses: 128 } } as unknown as Plan
const domain = { id: DOMAIN, accountId: ACCOUNT, name: 'alice-shop.com', kind: 'primary', suspended: false } as Domain
const caller = (kind: 'user' | 'root', extra: Record<string, unknown> = {}) => ({ principal: { kind, id: kind === 'user' ? PRINCIPAL : 'p-root', username: kind === 'user' ? 'alice' : 'root', ...(kind === 'user' ? { accountId: ACCOUNT } : {}) }, apiTokenId: null, scopes: [], principalRecord: { forcePasswordChange: false }, ...extra }) as unknown as AuthenticatedCaller
const host: RuntimeHost = {
  exists: async path => ['/usr/bin/node', '/usr/lib/systemd/systemd-socket-proxyd', '/usr/bin/memcached'].includes(path),
  run: async argv => ({ ok: true, code: 0, stderr: '', stdout: argv[0] === '/usr/bin/node' ? 'v18.19.1' : argv[0] === '/usr/bin/memcached' ? 'memcached 1.6.24' : argv[0] === '/usr/bin/journalctl' ? '2026-10-29T01:00:00+00:00 host node[1]: listening\n' : '' }),
  systemd: async () => undefined, probe: async () => 200, readText: async () => null,
}

describe('account runtime workspace', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xpanel-runtime-api-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  const setup = (options: { callers?: AuthenticatedCaller[]; reply?: (value: any) => unknown } = {}) => {
    const readAgent = vi.fn(async (_caller: AuthenticatedCaller, path: string, input?: unknown, _mutation?: boolean, method = 'GET') => {
      const url = new URL('http://agent' + path)
      const res = await handleAccountRuntimeRoute(new Request(url, { method, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }), url, method, {
        caller: { principalId: PRINCIPAL, actor: 'alice', role: 'user', accountId: ACCOUNT, resellerId: null },
        store: { rootDir: root, getAccountByUsername: async u => u === 'alice' ? account : null, listDomains: async () => [domain], getPlan: async () => plan,
          getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: [] }), withAccountLifecycleLease: async (_id, op) => op(account) },
        currentPrincipal: async () => ({ kind: 'user', id: PRINCIPAL, username: 'alice', accountId: ACCOUNT, disabled: false }),
        os: profileFor('ID=ubuntu\nVERSION_ID="24.04"\n'), host, files: null, reconcile: async () => ({ status: 'applied' }), audit: async () => undefined,
      })
      const body = await res!.json()
      return options.reply ? options.reply(body) : body
    })
    const store = { getAccount: async (id: string) => id === ACCOUNT ? account : null, getPlan: async () => plan, getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: [] }) } as unknown as StateStore
    const callers = [...(options.callers ?? [])]
    const ports = { store, requireCaller: async () => callers.length ? callers.shift()! : caller('user'), readAgent: readAgent as unknown as ReadAgent }
    const route = (method: string, path: string, body?: unknown) => { const url = new URL('http://panel.test' + path); return handleAccountRuntimeWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, method, ports) }
    return { route, readAgent }
  }

  it('reads the verified view and saves a memcached instance through the agent', async () => {
    const t = setup()
    const view = await (await t.route('GET', '/api/account/runtime'))!.json()
    expect(view.host.runtimes[0]).toEqual({ kind: 'node', available: true, version: '18.19.1', reason: null })
    expect(view.host.cache).toEqual([{ service: 'redis', available: false, version: null, binary: null, reason: 'not-installed' }, { service: 'memcached', available: true, version: '1.6.24', binary: '/usr/bin/memcached', reason: null }])
    const saved = await t.route('POST', '/api/account/runtime', { op: 'cache.save', expectedRevision: view.revision, service: 'memcached', enabled: true, memoryMb: 32 })
    expect(await saved!.json()).toMatchObject({ op: 'cache.save', changed: true })
    expect((await readRuntimeRegistry(root, ACCOUNT)).cache.memcached).toMatchObject({ enabled: true, memoryMb: 32 })
    await expect(t.route('POST', '/api/account/runtime', { op: 'cache.save', expectedRevision: runtimeRevision(EMPTY_RUNTIME), service: 'redis', enabled: true, memoryMb: 32 })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('reads logs only for a valid target and refuses non-owners before the agent', async () => {
    const t = setup()
    await expect(t.route('GET', '/api/account/runtime/log?target=cache:redis').then(r => r!.json())).resolves.toMatchObject({ unit: 'xpanel-redis-alice.service', lines: ['2026-10-29T01:00:00+00:00 host node[1]: listening'] })
    await expect(t.route('GET', '/api/account/runtime/log?target=cache:../x')).rejects.toMatchObject({ code: 'VALIDATION' })
    const root = setup({ callers: [caller('root')] })
    await expect(root.route('GET', '/api/account/runtime')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(root.readAgent).not.toHaveBeenCalled()
    await expect(t.route('POST', '/api/account/runtime', { op: 'app.save', expectedRevision: 'a'.repeat(64), app: { name: 'x', runtime: 'node', root: '../bob', startup: 's.js', domainId: DOMAIN, path: '/', env: {} } })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('refuses an agent reply for another account or an unverifiable change', async () => {
    const wrong = setup({ reply: body => body.context ? { ...body, context: { ...body.context, accountId: '44444444-4444-4444-8444-444444444444' } } : body })
    await expect(wrong.route('GET', '/api/account/runtime')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const lost = setup({ reply: body => body.context ? body : { ok: true } })
    const view = await (await lost.route('GET', '/api/account/runtime'))!.json()
    await expect(lost.route('POST', '/api/account/runtime', { op: 'cache.save', expectedRevision: view.revision, service: 'memcached', enabled: true, memoryMb: 16 })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: expect.objectContaining({ unknownOutcome: true }) })
  })
})
