import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { createTestDb, searchIndex, type DbHandle } from '@xpanel/db'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import {
  handleWhmSearchIndexReindexRoute,
  type WhmSearchIndexReindexHelpers,
} from './whm-panel-reindex-routes.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const root = {
  principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' },
  sessionId: 'sess-root-1',
} as unknown as AuthenticatedCaller
const reseller = {
  principal: { kind: 'reseller', id: '22222222-2222-4222-8222-222222222222', username: 'reseller1' },
  sessionId: 'sess-reseller-1',
} as unknown as AuthenticatedCaller

const dbHandles: DbHandle[] = []
const storeHandles: TestStateStoreHandle[] = []
afterEach(async () => {
  for (const h of dbHandles.splice(0)) await h.close()
  for (const h of storeHandles.splice(0)) await h.close()
})

const setup = async (caller: AuthenticatedCaller = root) => {
  const dbHandle = await createTestDb()
  dbHandles.push(dbHandle)
  const storeHandle = await createTestStateStore()
  storeHandles.push(storeHandle)

  const feature = await storeHandle.store.createFeatureList({ name: 'Default', ownerId: null, disabled: [] })
  const plan = await storeHandle.store.createPlan({
    name: 'Starter',
    ownerId: null,
    featureListId: feature.id,
    resources: {
      diskMb: 1000,
      bandwidthMbMonth: 10000,
      ioReadBps: 1048576,
      ioWriteBps: 1048576,
      ioReadIops: 100,
      ioWriteIops: 100,
      memoryMb: 128,
      maxProcesses: 16,
      cpuPercent: 100,
    },
    caps: {
      addonDomains: 2,
      aliasDomains: 2,
      subdomains: 2,
      mailboxes: 4,
      forwarders: 4,
      mailingLists: 2,
      ftpAccounts: 2,
      databases: 2,
      phpWorkers: 2,
    },
    dedicatedIp: false,
    shell: 'none',
    defaultMailboxQuotaMb: 100,
  })
  await storeHandle.store.saveServerIp({
    address: '192.0.2.10',
    version: 4,
    prefixLength: 24,
    interfaceName: 'eth0',
    role: 'shared',
    ownerKind: 'root',
    ownerId: null,
    ptrHostname: null,
    isPrimary: true,
    notes: '',
  })
  await storeHandle.store.createAccount({
    username: 'alice',
    ownerId: null,
    passwordHash: HASH,
    primaryDomain: 'alice.example.test',
    planId: plan.id,
    contactEmail: 'alice@example.test',
    ipv4: '192.0.2.10',
    shell: 'none',
    php: {
      version: '8.3',
      handler: 'fpm',
      fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 },
      ini: {},
    },
  })

  const audits: Record<string, unknown>[] = []
  const assertRoot = vi.fn(async (c: AuthenticatedCaller, action: string) => {
    if (c.principal.kind !== 'root') fail('FORBIDDEN', `root required for ${action}`, { stateChanged: false })
  })
  const helpers: WhmSearchIndexReindexHelpers = {
    db: dbHandle.db,
    store: storeHandle.store,
    requireCaller: vi.fn(async () => caller),
    assertRoot,
    emitAudit: vi.fn(async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>)
    }),
  }
  const send = (method: string, path = '/api/server/search-index/rebuild', body?: string) => {
    const url = new URL('http://localhost' + path)
    return handleWhmSearchIndexReindexRoute(
      new Request(url, {
        method,
        ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
      }),
      url,
      method,
      helpers,
    )
  }
  return { dbHandle, storeHandle, audits, assertRoot, helpers, send }
}

describe('WHM search index rebuild route', { tags: ['feature'] }, () => {
  it('returns null for unrelated paths and 405 for non-POST methods', async () => {
    const f = await setup()
    expect(await f.send('POST', '/api/server/other')).toBeNull()
    const getRes = await f.send('GET')
    expect(getRes?.status).toBe(405)
    expect(getRes?.headers.get('allow')).toBe('POST')
  })

  it('requires root server.search_index.rebuild privilege', async () => {
    const f = await setup(reseller)
    await expect(f.send('POST', '/api/server/search-index/rebuild', JSON.stringify({ confirm: true }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(f.assertRoot).toHaveBeenCalledWith(reseller, 'server.search_index.rebuild')
    expect(f.audits).toHaveLength(0)
  })

  it('rebuilds the derived FTS/SQLite index for { confirm: true } and empty JSON object, emitting audit', async () => {
    const f = await setup()
    expect(await searchIndex(f.dbHandle.db, 'alice')).toEqual([])

    const res = await f.send('POST', '/api/server/search-index/rebuild', JSON.stringify({ confirm: true }))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; rebuilt: boolean; counts: Record<string, number> }
    expect(body).toMatchObject({
      ok: true,
      rebuilt: true,
      counts: { resellers: 0, plans: 1, accounts: 1, domains: 1, serviceUsers: 0, databases: 0, ftsEntries: 3 },
    })
    expect(await searchIndex(f.dbHandle.db, 'alice')).toHaveLength(2)
    expect(f.audits).toHaveLength(1)
    expect(f.audits[0]).toMatchObject({
      actor: 'root',
      action: 'server.search_index.rebuilt',
      target: 'server:search-index',
      outcome: 'ok',
    })

    const emptyRes = await f.send('POST', '/api/server/search-index/rebuild', '{}')
    expect(emptyRes?.status).toBe(200)
    expect(await emptyRes!.json()).toMatchObject({ ok: true, rebuilt: true })
    expect(f.audits).toHaveLength(2)
  })

  it('rejects invalid confirmation payloads and query parameters without rebuilding', async () => {
    const f = await setup()
    for (const bad of ['{"confirm":false}', '{"extra":1}', '[]', 'not-json']) {
      await expect(f.send('POST', '/api/server/search-index/rebuild', bad)).rejects.toMatchObject({
        code: 'VALIDATION',
      })
    }
    await expect(f.send('POST', '/api/server/search-index/rebuild?force=1', '{}')).rejects.toMatchObject({
      code: 'VALIDATION',
    })
    expect(f.audits).toHaveLength(0)
  })
})
