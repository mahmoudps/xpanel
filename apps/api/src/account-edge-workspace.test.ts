import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { handleAccountEdgeRoute } from './account-edge-workspace.ts'
import type { AccountEdgePorts } from './account-edge-workspace.ts'
import { edgeStatePath, readAccountEdge } from '../../agent/src/account-edge.ts'

const ACCOUNT = { id: '22222222-2222-4222-8222-222222222222', username: 'alice', status: 'active', planId: 'p' }
const OWNER = { principal: { kind: 'user', id: '33333333-3333-4333-8333-333333333333', username: 'alice', accountId: ACCOUNT.id }, sessionId: 'two', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
const ROOT = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 'one', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
const NOW = new Date('2026-11-07T10:00:00.000Z')
let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-edge-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function harness(options: { caller?: AuthenticatedCaller; disabled?: string[]; resolve?: (name: string) => Promise<string[]> } = {}) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const ports = {
    requireCaller: vi.fn(async () => options.caller ?? OWNER), emitAudit: vi.fn(async () => undefined), triggerReconcile: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }), getAccount: async () => ACCOUNT, getPlan: async () => ({ featureListId: 'f' }), getFeatureList: async () => ({ disabled: options.disabled ?? [] }) },
    resolveHost: options.resolve ?? (async () => { throw new Error('no resolver') }), now: () => NOW,
  } as unknown as AccountEdgePorts
  const send = async (path: string, method = 'GET', body?: unknown): Promise<Record<string, any>> => {
    const response = await handleAccountEdgeRoute(new Request('http://api.test' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://api.test' + path), method, ports)
    return response!.json()
  }
  return { ports, send }
}

describe('account IP Blocker and cache control', () => {
  it('adds a cPanel range as exact CIDR blocks, removes one, audits and asks for a reconcile', async () => {
    const h = harness()
    const empty = await h.send('/api/account/ip-blocker')
    expect(empty).toMatchObject({ context: { accountId: ACCOUNT.id, username: 'alice' }, state: 'default', entries: [], limit: 1000 })
    const added = await h.send('/api/account/ip-blocker', 'POST', { expectedRevision: empty.revision, add: '10.5.3.3-40' })
    expect(added.entries.map((item: { entry: string }) => item.entry)).toEqual(['10.5.3.3', '10.5.3.4/30', '10.5.3.8/29', '10.5.3.16/28', '10.5.3.32/29', '10.5.3.40'])
    expect(added.entries[1]).toEqual({ entry: '10.5.3.4/30', first: '10.5.3.4', last: '10.5.3.7' })
    expect(added).toMatchObject({ state: 'saved', reconcile: 'requested' })
    expect(h.ports.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'account.ip_blocker.added', target: 'account:alice', detail: { entries: 6 } }))
    const removed = await h.send('/api/account/ip-blocker', 'POST', { expectedRevision: added.revision, remove: '10.5.3.40' })
    expect(removed.entries).toHaveLength(5)
    // The reconciler reads exactly what the API saved.
    expect((await readAccountEdge(root, [ACCOUNT])).get(ACCOUNT.id)).toEqual({ policy: { deny: ['10.5.3.3', '10.5.3.4/30', '10.5.3.8/29', '10.5.3.16/28', '10.5.3.32/29'], cacheEpoch: null }, cache: true })
  })
  it('resolves host names to addresses and refuses invalid, protected, duplicate and stale changes before writing', async () => {
    const h = harness({ resolve: async name => name === 'bad.example.test' ? ['192.0.2.9', '192.0.2.9', '2001:db8::9'] : name === 'local.example.test' ? ['127.0.0.1'] : [] })
    const empty = await h.send('/api/account/ip-blocker')
    const resolved = await h.send('/api/account/ip-blocker', 'POST', { expectedRevision: empty.revision, add: 'Bad.Example.Test' })
    expect(resolved.entries.map((item: { entry: string }) => item.entry)).toEqual(['192.0.2.9', '2001:db8::9'])
    const cases: [Record<string, unknown>, string, string][] = [
      [{ add: 'abc' }, 'add', 'address'], [{ add: '127.0.0.1' }, 'add', 'protected_address'], [{ add: 'local.example.test' }, 'add', 'protected_address'],
      [{ add: 'nothing.example.test' }, 'add', 'unresolved'], [{ add: '192.0.2.9' }, 'add', 'duplicate'], [{ add: '10.5.3.40-3' }, 'add', 'range'], [{ remove: '198.51.100.0/24' }, 'remove', 'not_found'],
    ]
    for (const [change, name, code] of cases) await expect(h.send('/api/account/ip-blocker', 'POST', { expectedRevision: resolved.revision, ...change }), code).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false, fields: [{ field: name, code }] } })
    await expect(h.send('/api/account/ip-blocker', 'POST', { expectedRevision: empty.revision, add: '198.51.100.7' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(h.send('/api/account/ip-blocker', 'POST', { expectedRevision: resolved.revision, add: '198.51.100.7', remove: '192.0.2.9' })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(JSON.parse(await readFile(join(root, edgeStatePath('ip-blocker', ACCOUNT.id)), 'utf8')).entries).toEqual(['192.0.2.9', '2001:db8::9'])
    expect(h.ports.emitAudit).toHaveBeenCalledTimes(1)
  })
  it('purges by a new cache key epoch and switches the account cache off and on', async () => {
    const h = harness()
    const initial = await h.send('/api/account/edge-cache')
    expect(initial).toMatchObject({ state: 'default', enabled: true, purgedAt: null })
    const purged = await h.send('/api/account/edge-cache', 'POST', { expectedRevision: initial.revision, op: 'purge' })
    expect(purged).toMatchObject({ enabled: true, purgedAt: NOW.toISOString(), reconcile: 'requested' })
    const off = await h.send('/api/account/edge-cache', 'POST', { expectedRevision: purged.revision, op: 'disable' })
    expect(off).toMatchObject({ enabled: false, purgedAt: NOW.toISOString() })
    await expect(h.send('/api/account/edge-cache', 'POST', { expectedRevision: off.revision, op: 'disable' })).rejects.toMatchObject({ code: 'VALIDATION', detail: { fields: [{ field: 'op', code: 'unchanged' }] } })
    expect((await readAccountEdge(root, [ACCOUNT])).get(ACCOUNT.id)).toEqual({ policy: { deny: [], cacheEpoch: NOW.getTime().toString(36) }, cache: false })
    expect(h.ports.emitAudit).toHaveBeenNthCalledWith(1, expect.objectContaining({ action: 'account.edge_cache.purged' }))
    expect(h.ports.emitAudit).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: 'account.edge_cache.disabled' }))
  })
  it('admits only the signed-in owner with the plan feature', async () => {
    await expect(harness({ caller: ROOT }).send('/api/account/ip-blocker')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(harness({ disabled: ['ip-blocker'] }).send('/api/account/ip-blocker')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(harness({ disabled: ['nginx-cache-control'] }).send('/api/account/edge-cache')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(harness().send('/api/account/ip-blocker?account=bob')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
