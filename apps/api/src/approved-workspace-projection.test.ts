import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResellerAcl, ServerSettings } from '@xpanel/core'
import {
  appendAudit, createResellerPrincipal, createRootPrincipal, createSession, createTestDb, createUserPrincipal,
} from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { SESSION_COOKIE_NAME, sha256Hex } from './auth.ts'
import { createDefaultWebRenderer } from './main.ts'

const hydration = vi.hoisted(() => [] as Record<string, unknown>[])
vi.mock('../../web/src/index.ts', async importOriginal => {
  const web = await importOriginal<typeof import('../../web/src/index.ts')>()
  return {
    ...web,
    serveWebUi: async (request: Request, provider?: () => Promise<Record<string, unknown>>) => {
      if (!provider) return web.serveWebUi(request)
      const data = await provider()
      hydration.push(data)
      return web.serveWebUi(request, () => data as unknown as import('../../web/src/app.ts').WebAppRenderState)
    },
  }
})
// Qualification is supplied only to reach the production hydration boundary. No host executor is created.
vi.mock('./host-catalog.ts', async () => {
  const { tools } = await import('@xpanel/catalog')
  return {
    loadQualifiedCatalog: async () => tools.map(tool => ({
      ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const },
    })),
  }
})

const PUBLIC_VECTOR = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SERVER_SECRET = 'approved-projection-fixture-secret-only'
const settings: ServerSettings = {
  hostname: 'private-projection.example.test', nameservers: ['ns1.example.test'], adminEmail: 'private-ops@example.test',
  engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443,
  nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 65535, multiAccept: false, keepaliveTimeoutSec: 65 },
  apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 6, maxRequestWorkers: 100, maxConnectionsPerChild: 1000, serverLimit: 100 },
}

describe('approved workspace hydration projection', () => {
  let db: TestDbHandle
  let state: TestStateStoreHandle

  beforeEach(async () => {
    db = await createTestDb()
    state = await createTestStateStore()
    hydration.length = 0
  })
  afterEach(async () => { await state.close(); await db.close(); vi.restoreAllMocks() })

  const cookie = async (principalId: string) => {
    const token = `projection-session-${principalId}`
    await createSession(db.db, { principalId, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 60_000).toISOString(), mfaVerified: true })
    return `${SESSION_COOKIE_NAME}=${token}`
  }
  const renderer = () => createDefaultWebRenderer({ store: state.store, db: db.db, serverSecret: SERVER_SECRET })
  const request = (path: string, session: string) => new Request(`http://localhost${path}`, { headers: { cookie: session } })
  const rootSession = async () => {
    const principal = await createRootPrincipal(db.db, { username: 'root', passwordHash: PUBLIC_VECTOR, forcePasswordChange: false })
    return cookie(principal.id)
  }
  const seedWorkspace = async (acl: ResellerAcl[] = ['list-accounts', 'manage-feature-lists']) => {
    await state.store.saveServerSettings(settings)
    const resellerInput = { passwordHash: PUBLIC_VECTOR, maxAccounts: 10, totalDiskMb: 100000, totalBandwidthMb: 100000, oversell: false, nameservers: [], delegatedIps: [] }
    const owner = await state.store.createReseller({ ...resellerInput, username: 'projectionowner', acl })
    const foreign = await state.store.createReseller({ ...resellerInput, username: 'projectionother', acl: ['list-accounts'] })
    const defaultFeatures = await state.store.createFeatureList({ name: 'Default projection features', ownerId: null, disabled: ['terminal'] })
    const ownedFeatures = await state.store.createFeatureList({ name: 'Owned projection features', ownerId: owner.id, disabled: ['ssh-access'] })
    const foreignFeatures = await state.store.createFeatureList({ name: 'Foreign projection features', ownerId: foreign.id, disabled: [] })
    const planInput = {
      resources: { diskMb: 1000, bandwidthMbMonth: 1000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
      caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 },
      dedicatedIp: false, shell: 'none' as const, defaultMailboxQuotaMb: 100,
    }
    const globalPlan = await state.store.createPlan({ ...planInput, name: 'Global projection plan', ownerId: null, featureListId: defaultFeatures.id })
    const ownPlan = await state.store.createPlan({ ...planInput, name: 'Own projection plan', ownerId: owner.id, featureListId: ownedFeatures.id })
    const foreignPlan = await state.store.createPlan({ ...planInput, name: 'Foreign projection plan', ownerId: foreign.id, featureListId: foreignFeatures.id })
    await state.store.saveServerIp({ address: '192.0.2.198', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const accountInput = {
      passwordHash: PUBLIC_VECTOR, contactEmail: 'projection@example.test', ipv4: '192.0.2.198', shell: 'none' as const,
      php: { version: '8.3', handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
    }
    const ownAccount = await state.store.createAccount({ ...accountInput, username: 'projectown', primaryDomain: 'own-projection.example.test', ownerId: owner.id, planId: ownPlan.id })
    const otherAccount = await state.store.createAccount({ ...accountInput, username: 'projectother', primaryDomain: 'foreign-projection.example.test', ownerId: foreign.id, planId: foreignPlan.id })
    const rootAccount = await state.store.createAccount({ ...accountInput, username: 'projectroot', primaryDomain: 'root-projection.example.test', ownerId: null, planId: globalPlan.id })
    const principal = await createResellerPrincipal(db.db, { id: owner.id, username: owner.username, passwordHash: PUBLIC_VECTOR })
    return { owner, principal, ownAccount, otherAccount, rootAccount, defaultFeatures, ownedFeatures, foreignFeatures }
  }
  const lastWhm = () => hydration.at(-1)?.whm as {
    accounts: Array<{ id: string }>; domains: Array<{ accountId: string; name: string }>
    featureLists: Array<{ id: string; name: string; disabled: string[]; ownerId: string | null }>
    serverSettings?: ServerSettings
  }

  it('gives an authorized root the actual server settings and all account domains', async () => {
    const fixture = await seedWorkspace()
    const render = await renderer()
    const response = await render(request('/whm/accounts', await rootSession()))
    expect(response.status).toBe(200)
    const projected = lastWhm()
    expect(projected.serverSettings).toEqual(settings)
    expect(new Set(projected.accounts.map(account => account.id))).toEqual(new Set([fixture.ownAccount.id, fixture.otherAccount.id, fixture.rootAccount.id]))
    expect(new Set(projected.domains.map(domain => domain.accountId))).toEqual(new Set(projected.accounts.map(account => account.id)))
    expect(projected.domains.map(domain => domain.name).sort()).toEqual(['foreign-projection.example.test', 'own-projection.example.test', 'root-projection.example.test'])
    expect(new Set(projected.featureLists.map(list => list.id))).toEqual(new Set([fixture.defaultFeatures.id, fixture.ownedFeatures.id, fixture.foreignFeatures.id]))
  })

  it('limits reseller domains to listed accounts and exposes complete default/owned feature-list records', async () => {
    const fixture = await seedWorkspace()
    const render = await renderer()
    // This implemented workspace is independently admitted by feature-list-crud;
    // unrelated account-page capabilities need not be qualified for this projection test.
    expect((await render(request('/whm/plans/features', await cookie(fixture.principal.id)))).status).toBe(200)
    const projected = lastWhm()
    expect(projected.accounts.map(account => account.id)).toEqual([fixture.ownAccount.id])
    expect(projected.domains).toHaveLength(1)
    expect(projected.domains[0]).toMatchObject({ accountId: fixture.ownAccount.id, name: fixture.ownAccount.primaryDomain })
    expect(projected.featureLists).toHaveLength(2)
    expect(projected.featureLists).toEqual(expect.arrayContaining([fixture.defaultFeatures, fixture.ownedFeatures]))
    expect(projected).not.toHaveProperty('serverSettings')
    expect(JSON.stringify(projected)).not.toContain(fixture.foreignFeatures.id)
    expect(JSON.stringify(projected)).not.toContain(fixture.otherAccount.primaryDomain)
    expect(JSON.stringify(projected)).not.toContain(settings.adminEmail)
  })

  it('allows feature-list management without list-accounts while withholding domains and server settings', async () => {
    const fixture = await seedWorkspace(['manage-feature-lists'])
    const render = await renderer()
    const session = await cookie(fixture.principal.id)
    expect((await render(request('/whm/plans/features', session))).status).toBe(200)
    const projected = lastWhm()
    expect(projected.accounts).toEqual([])
    expect(projected.domains).toEqual([])
    expect(projected.featureLists).toEqual(expect.arrayContaining([fixture.defaultFeatures, fixture.ownedFeatures]))
    expect(projected.featureLists).toHaveLength(2)
    expect(projected).not.toHaveProperty('serverSettings')
    hydration.length = 0
    const readSnapshot = vi.spyOn(state.store, 'readSnapshot')
    expect((await render(request('/whm/accounts', session))).status).toBe(403)
    expect((await render(request('/whm', session))).status).toBe(403)
    expect(readSnapshot).not.toHaveBeenCalled()
    expect(hydration.every(row => !Object.hasOwn(row, 'whm'))).toBe(true)
  })

  it('denies a user on WHM before reading a snapshot or projecting server data', async () => {
    await state.store.saveServerSettings(settings)
    const principal = await createUserPrincipal(db.db, { username: 'projectuser', passwordHash: PUBLIC_VECTOR, accountId: '10000000-0000-4000-8000-000000000001' })
    const render = await renderer()
    const readSnapshot = vi.spyOn(state.store, 'readSnapshot')
    expect((await render(request('/whm/server/setup', await cookie(principal.id)))).status).toBe(403)
    expect(readSnapshot).not.toHaveBeenCalled()
    expect(hydration.at(-1)).not.toHaveProperty('whm')
    expect(hydration.at(-1)).not.toHaveProperty('panel')
  })

  it('rejects an invalid audit instant before reading the hosting snapshot', async () => {
    await state.store.saveServerSettings(settings)
    const render = await renderer()
    const readSnapshot = vi.spyOn(state.store, 'readSnapshot')
    const response = await render(request('/whm/audit?from=invalid', await rootSession()))
    expect(response.status).toBe(400)
    expect(readSnapshot).not.toHaveBeenCalled()
    expect(hydration.at(-1)).not.toHaveProperty('whm')
    expect(hydration.at(-1)).not.toHaveProperty('panel')
  })

  it('applies valid outcome and UTC instant bounds to the hydrated audit records', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-25T10:00:00.000Z'))
      await appendAudit(db.db, { actor: 'root', action: 'projection.match', target: 'matched', outcome: 'ok' })
      await appendAudit(db.db, { actor: 'root', action: 'projection.denied', target: 'excluded-outcome', outcome: 'denied' })
      vi.setSystemTime(new Date('2026-10-25T08:00:00.000Z'))
      await appendAudit(db.db, { actor: 'root', action: 'projection.early', target: 'excluded-time', outcome: 'ok' })
    } finally { vi.useRealTimers() }
    const render = await renderer()
    const response = await render(request('/whm/audit?outcome=ok&from=2026-10-25T09:00&to=2026-10-25T11:00', await rootSession()))
    expect(response.status).toBe(200)
    const projected = hydration.at(-1)?.whm as { auditEntries: Array<{ action: string; outcome: string }> }
    expect(projected.auditEntries.map(row => row.action)).toEqual(['projection.match'])
    expect(projected.auditEntries[0]?.outcome).toBe('ok')
  })
})
