import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultPlan, type Account, type PhpSettings } from '@xpanel/core'
import {
  createApiToken, createResellerPrincipal, createRootPrincipal, createSession,
  createTestDb, createUserPrincipal, listAudit, type TestDbHandle,
} from '@xpanel/db'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { deriveCsrfToken, hashPasswordArgon2id, sha256Hex } from './auth.ts'
import { sessionCookieName, sessionTokenHash } from './entry-points.ts'
import { createApiApp, type ApiApp } from './server.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'
import type { InstalledAppRecord } from './extended-routes.ts'

const php: PhpSettings = {
  version: '8.3', handler: 'fpm',
  fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 },
  ini: {},
}
let passwordHash: string
beforeAll(async () => { passwordHash = await hashPasswordArgon2id('ApplicationFixturePassword!2026') })

describe('application lifecycle requires a qualified native provider', () => {
  let db: TestDbHandle
  let state: TestStateStoreHandle
  let app: ApiApp
  let account: Account
  let neighbor: Account
  let records: InstalledAppRecord[]
  let metadataPath: string
  let metadataBytes: Buffer
  let featureListId: string
  let rootId: string
  let ownerId: string
  let resellerId: string
  let restrictedResellerId: string
  let tokens: { root: string; owner: string; reseller: string; restricted: string }
  let agentFetch: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>>

  const tokenFor = async (principalId: string) => {
    const raw = `xp_${randomUUID()}`
    await createApiToken(db.db, { principalId, name: 'Application guard fixture', tokenHash: sha256Hex(raw), scopes: ['*'], expiresAt: new Date(Date.now() + 60_000).toISOString() })
    return raw
  }
  const request = (token: string | null, path: string, method = 'GET', body?: unknown) => app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const installBody = () => ({ appType: 'wordpress', domain: account.primaryDomain, title: 'Requested application', version: '999.0.0', providerAvailable: true, nativeVerified: true })
  const operations = () => [
    { label: 'installation', path: `/api/apps/${account.id}`, method: 'POST', body: installBody() },
    { label: 'staging clone', path: `/api/apps/${account.id}/${records[0]!.id}/staging-clone`, method: 'POST', body: { stagingDomain: `staging.${account.primaryDomain}`, providerAvailable: true } },
    { label: 'staging push', path: `/api/apps/${account.id}/${records[1]!.id}/staging-push`, method: 'POST', body: { nativeVerified: true } },
    { label: 'item removal', path: `/api/apps/${account.id}/${records[0]!.id}`, method: 'DELETE', body: {} },
  ]
  const assertUnchanged = async (snapshot: Awaited<ReturnType<TestStateStoreHandle['store']['readSnapshot']>>, auditIds: string[]) => {
    expect(await readFile(metadataPath)).toEqual(metadataBytes)
    expect(await state.store.readSnapshot()).toEqual(snapshot)
    const successfulAppAudits = (await listAudit(db.db)).filter(row => row.action.startsWith('app.') && row.outcome === 'ok').map(row => row.id)
    expect(successfulAppAudits).toEqual(auditIds)
    expect(agentFetch).not.toHaveBeenCalled()
  }
  const assertUnavailable = async (response: Response) => {
    expect(response.status).toBe(412)
    expect(await response.json()).toMatchObject({ code: 'PRECONDITION_FAILED', details: { reason: 'application_provider_unavailable', stateChanged: false, nativeApplied: false } })
  }

  beforeEach(async () => {
    db = await createTestDb()
    state = await createTestStateStore()
    rootId = (await createRootPrincipal(db.db, { username: 'root', passwordHash, forcePasswordChange: false })).id
    const resellerInput = { passwordHash, maxAccounts: 10, totalDiskMb: 50_000, totalBandwidthMb: 500_000, oversell: false, nameservers: [], delegatedIps: [] }
    const reseller = await state.store.createReseller({ ...resellerInput, username: 'appreseller', acl: ['list-accounts', 'edit-account'] })
    resellerId = reseller.id
    await createResellerPrincipal(db.db, { id: reseller.id, username: reseller.username, passwordHash })
    const restricted = await state.store.createReseller({ ...resellerInput, username: 'apprestricted', acl: [] })
    restrictedResellerId = restricted.id
    await createResellerPrincipal(db.db, { id: restricted.id, username: restricted.username, passwordHash })
    featureListId = (await state.store.createFeatureList({ name: 'Application guard features', ownerId: null, disabled: [] })).id
    const { id: _id, ...planInput } = defaultPlan({ name: 'Application guard plan', featureListId })
    const plan = await state.store.createPlan(planInput)
    await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    account = await state.store.createAccount({ username: 'appowner', passwordHash, primaryDomain: 'owned.example.test', planId: plan.id, ownerId: resellerId, contactEmail: 'owner@owned.example.test', ipv4: '192.0.2.10', shell: 'none', php })
    neighbor = await state.store.createAccount({ username: 'appneighbor', passwordHash, primaryDomain: 'neighbor.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@neighbor.example.test', ipv4: '192.0.2.10', shell: 'none', php })
    ownerId = (await createUserPrincipal(db.db, { username: account.username, accountId: account.id, passwordHash })).id
    tokens = { root: await tokenFor(rootId), owner: await tokenFor(ownerId), reseller: await tokenFor(resellerId), restricted: await tokenFor(restrictedResellerId) }
    const observedAt = '2026-01-02T03:04:05.678Z'
    const production: InstalledAppRecord = { id: randomUUID(), accountId: account.id, appType: 'wordpress', domain: account.primaryDomain, path: '/', docRoot: `${account.home}/domains/${account.primaryDomain}/public_html`, title: 'Stored application metadata', adminUser: 'storedadmin', adminEmail: account.contactEmail, version: '6.0.0-stored', databaseName: 'appowner_stored', environment: 'production', parentAppId: null, createdAt: observedAt, updatedAt: observedAt }
    records = [production, { ...production, id: randomUUID(), domain: `staging.${account.primaryDomain}`, path: '/staging', docRoot: `${account.home}/domains/staging.${account.primaryDomain}/public_html`, version: '6.1.0-stored', databaseName: 'appowner_stored_stg', environment: 'staging', parentAppId: production.id }]
    metadataPath = join(state.rootDir, 'extended', 'apps', `${account.id}.json`)
    metadataBytes = Buffer.from(JSON.stringify(records, null, 2) + '\n')
    await mkdir(join(state.rootDir, 'extended', 'apps'), { recursive: true })
    await writeFile(metadataPath, metadataBytes)
    agentFetch = vi.fn(async (_request: Request) => new Response('{}', { status: 503 }))
    app = createApiApp({ db: db.db, store: state.store, serverSecret: TEST_SERVER_SECRET, agentToken: TEST_AGENT_TOKEN, agentApp: { fetch: agentFetch, subscribe: () => () => undefined } })
  })
  afterEach(async () => { await state?.close(); await db?.close() })

  for (const actor of ['root', 'owner'] as const) {
    for (const [operationIndex, operationName] of ['installation', 'staging clone', 'staging push', 'item removal'].entries()) {
      it(`${actor} refuses unavailable application ${operationName} without state or success effects`, async () => {
        const operation = operations()[operationIndex]!
        const snapshot = await state.store.readSnapshot()
        const auditIds = (await listAudit(db.db)).filter(row => row.action.startsWith('app.') && row.outcome === 'ok').map(row => row.id)
        await assertUnavailable(await request(tokens[actor], operation.path, operation.method, operation.body))
        await assertUnchanged(snapshot, auditIds)
      })
    }
  }

  it('keeps the exact stored-record read envelope without claiming native verification', async () => {
    const snapshot = await state.store.readSnapshot()
    for (const token of [tokens.root, tokens.owner, tokens.reseller]) {
      const response = await request(token, `/api/apps/${account.id}`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ apps: records })
    }
    await assertUnchanged(snapshot, [])
  })

  it.each(['query', 'body'] as const)('refuses collection removal selected by %s without rewriting stored bytes', async selector => {
    const snapshot = await state.store.readSnapshot()
    const path = `/api/apps/${account.id}${selector === 'query' ? `?id=${records[0]!.id}` : ''}`
    await assertUnavailable(await request(tokens.owner, path, 'DELETE', selector === 'body' ? { id: records[0]!.id } : {}))
    await assertUnchanged(snapshot, [])
  })

  it('refuses concurrent lifecycle requests without metadata races or success audits', async () => {
    const snapshot = await state.store.readSnapshot()
    const probes = [...operations(), ...operations()]
    const responses = await Promise.all(probes.map(operation => request(tokens.owner, operation.path, operation.method, operation.body)))
    for (const response of responses) await assertUnavailable(response)
    await assertUnchanged(snapshot, [])
  })

  it.each(['root', 'owner'] as const)('keeps foreign-domain installation and cloning hidden from %s', async actor => {
    const snapshot = await state.store.readSnapshot()
    const expectedStatus = actor === 'root' ? 403 : 404
    expect((await request(tokens[actor], `/api/apps/${account.id}`, 'POST', { ...installBody(), domain: neighbor.primaryDomain })).status).toBe(expectedStatus)
    expect((await request(tokens[actor], `/api/apps/${account.id}/${records[0]!.id}/staging-clone`, 'POST', { stagingDomain: neighbor.primaryDomain })).status).toBe(expectedStatus)
    await assertUnchanged(snapshot, [])
  })

  it('keeps foreign accounts and unknown application targets hidden', async () => {
    const snapshot = await state.store.readSnapshot()
    expect((await request(tokens.owner, `/api/apps/${neighbor.id}`)).status).toBe(404)
    expect((await request(tokens.owner, `/api/apps/${neighbor.id}`, 'POST', installBody())).status).toBe(404)
    for (const suffix of ['/staging-clone', '/staging-push', '']) {
      expect((await request(tokens.owner, `/api/apps/${account.id}/${randomUUID()}${suffix}`, suffix ? 'POST' : 'DELETE', {})).status).toBe(404)
    }
    await assertUnchanged(snapshot, [])
  })

  it('preserves feature denial before the unavailable provider response', async () => {
    await state.store.updateFeatureList(featureListId, { disabled: ['web-apps'] })
    const snapshot = await state.store.readSnapshot()
    for (const operation of operations()) expect((await request(tokens.owner, operation.path, operation.method, operation.body)).status).toBe(403)
    expect((await request(tokens.owner, `/api/apps/${account.id}`)).status).toBe(403)
    await assertUnchanged(snapshot, [])
  })

  it('preserves reseller ownership and ACL before lifecycle availability', async () => {
    const snapshot = await state.store.readSnapshot()
    await assertUnavailable(await request(tokens.reseller, `/api/apps/${account.id}`, 'POST', installBody()))
    expect((await request(tokens.reseller, `/api/apps/${neighbor.id}`)).status).toBe(404)
    await assertUnchanged(snapshot, [])
    await state.store.changeOwner(neighbor.id, restrictedResellerId)
    const restrictedSnapshot = await state.store.readSnapshot()
    expect((await request(tokens.restricted, `/api/apps/${neighbor.id}`)).status).toBe(403)
    expect((await request(tokens.restricted, `/api/apps/${neighbor.id}`, 'POST', { domain: neighbor.primaryDomain })).status).toBe(403)
    await assertUnchanged(restrictedSnapshot, [])
  })

  it('preserves anonymous and session CSRF rejection without application effects', async () => {
    const snapshot = await state.store.readSnapshot()
    expect((await request(null, `/api/apps/${account.id}`, 'POST', installBody())).status).toBe(401)
    const origin = 'https://panel.example.test:2083'
    const raw = randomUUID()
    await createSession(db.db, { principalId: ownerId, tokenHash: sessionTokenHash(raw, 'xpanel'), expiresAt: new Date(Date.now() + 60_000).toISOString(), mfaVerified: true })
    const sessionApp = createApiApp({ db: db.db, store: state.store, serverSecret: TEST_SERVER_SECRET, entryPoint: 'xpanel', publicOrigin: origin, allowedOrigins: [origin], secureCookies: true })
    const headers = { cookie: `${sessionCookieName('xpanel', true)}=${raw}`, origin, 'content-type': 'application/json' }
    const rejected = await sessionApp.fetch(new Request(`${origin}/api/apps/${account.id}`, { method: 'POST', headers, body: JSON.stringify(installBody()) }))
    expect(rejected.status).toBe(403)
    const admitted = await sessionApp.fetch(new Request(`${origin}/api/apps/${account.id}`, { method: 'POST', headers: { ...headers, 'x-csrf-token': deriveCsrfToken(raw, TEST_SERVER_SECRET, 'xpanel') }, body: JSON.stringify(installBody()) }))
    await assertUnavailable(admitted)
    await assertUnchanged(snapshot, [])
  })
})
