import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canOpenRegisteredRoute, registeredDocumentAliases, tools } from '@xpanel/catalog'
import {
  createApiToken, createResellerPrincipal, createRootPrincipal, createSession, createTestDb, createUserPrincipal, setTotpSecret,
} from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { SESSION_COOKIE_NAME, sha256Hex } from './auth.ts'
import { createDefaultWebRenderer } from './main.ts'
import { createApiApp, listenApiServer } from './server.ts'

const hydration = vi.hoisted(() => [] as Record<string, unknown>[])
vi.mock('../../web/src/index.ts', async (importOriginal) => {
  const web = await importOriginal<typeof import('../../web/src/index.ts')>()
  return {
    ...web,
    serveWebUi: async (req: Request, provider?: () => Promise<Record<string, unknown>>) => {
      if (!provider) return web.serveWebUi(req)
      const state = await provider()
      hydration.push(state)
      return web.serveWebUi(req, () => state as unknown as import('../../web/src/app.ts').WebAppRenderState)
    },
  }
})

const PUBLIC_VECTOR = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SERVER_SECRET = 'web-boundary-fixture-secret-for-tests-only'
const PUBLIC_DB_AUTH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'
const observations: Record<string, unknown>[] = []
const future = () => new Date(Date.now() + 60_000).toISOString()
const protectedPaths = ['/', '/whm', '/panel', '/mail', '/home', '/resources', '/files/manager', '/panel/files/manager', '/whm/accounts', '/whm/security/sign-in', '/mail/inbox']

const expectReadOnlyUnqualifiedWorkspace = (html: string): void => {
  const document = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  const start = document.search(/<section\b[^>]*\bdata-tool-availability="unverified"[^>]*>/i)
  expect(start).toBeGreaterThanOrEqual(0)
  const workspace = document.slice(start)
  const controls = [...workspace.matchAll(/<(?:button|input|select|textarea)\b[^>]*>/gi)].map(match => match[0])
  expect(controls.length).toBeGreaterThan(0)
  // Enforce the native interaction boundary, regardless of marker names or attribute order.
  for (const control of controls) expect(control).toMatch(/\sdisabled(?:\s|=|\/?>)/i)
  expect(workspace).not.toMatch(/<form\b/i)
  expect(workspace).not.toMatch(/<a\b[^>]*\s(?:data-action|onclick|onsubmit)\s*=/i)
}

afterAll(async () => {
  const path = process.env.XPANEL_WEB_BOUNDARY_EVIDENCE
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  const source = await readFile(new URL('./main.ts', import.meta.url))
  await writeFile(path, `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    proof: 'In-process production HTML renderer with real SQLite session authentication and an isolated state store; no host services or browser execution.',
    nodeVersion: process.version,
    mainSha256: createHash('sha256').update(source).digest('hex'),
    verifiedCatalogTools: tools.filter(tool => tool.status === 'verified' && tool.delivery.status === 'verified').length,
    observations,
  }, null, 2)}\n`)
})

describe('production web renderer boundary regressions', () => {
  let db: TestDbHandle
  let state: TestStateStoreHandle
  let snapshotReads: number

  beforeEach(async () => {
    db = await createTestDb()
    state = await createTestStateStore()
    snapshotReads = 0
    hydration.length = 0
    const readSnapshot = state.store.readSnapshot.bind(state.store)
    state.store.readSnapshot = async () => { snapshotReads++; return readSnapshot() }
  })

  afterEach(async () => { await state.close(); await db.close() })

  const renderer = () => createDefaultWebRenderer({ store: state.store, db: db.db, serverSecret: SERVER_SECRET })
  const request = (path: string, cookie?: string, authorization?: string) => new Request(`http://localhost${path}`, {
    headers: { ...(cookie ? { cookie } : {}), ...(authorization ? { authorization } : {}) },
  })
  const session = async (principalId: string, mfaVerified = true) => {
    const token = 'web-boundary-session-fixture'
    await createSession(db.db, { principalId, tokenHash: sha256Hex(token), expiresAt: future(), mfaVerified })
    return `${SESSION_COOKIE_NAME}=${token}`
  }
  const root = async (opts: { enrolled?: boolean; forcePasswordChange?: boolean } = {}) => {
    const principal = await createRootPrincipal(db.db, { username: 'root', passwordHash: PUBLIC_VECTOR, forcePasswordChange: opts.forcePasswordChange ?? false })
    if (opts.enrolled !== false) await setTotpSecret(db.db, principal.id, new Uint8Array(32))
    return principal
  }
  const observe = async (id: string, response: Response, expectedStatus: number, expectedLocation?: string) => {
    const html = await response.text()
    const observation = {
      id,
      status: response.status,
      location: response.headers.get('location'),
      expectedStatus,
      ...(expectedLocation ? { expectedLocation } : {}),
      statusPassed: response.status === expectedStatus,
      ...(expectedLocation ? { locationPassed: response.headers.get('location') === expectedLocation } : {}),
      snapshotReads,
      unavailableWorkspace: html.includes('data-tool-availability="unverified"'),
      sampleDataPresent: /alice-shop\.com|srv1\.xpanel\.test/.test(html),
    }
    observations.push(observation)
    expect.soft(response.status, id).toBe(expectedStatus)
    if (expectedLocation) expect.soft(response.headers.get('location'), id).toBe(expectedLocation)
    return html
  }

  it('redirects anonymous surface requests without reading hosting state', async () => {
    const render = await renderer()
    for (const path of protectedPaths) {
      await observe(`anonymous:${path}`, await render(request(path)), 303, '/login')
    }
    expect(snapshotReads).toBe(0)
  })

  it('rejects forged UI cookies, including substring matches', async () => {
    const render = await renderer()
    for (const cookie of ['xpanel_ui_session=1', 'unrelated=xpanel_ui_session=1']) {
      for (const path of protectedPaths) {
        await observe(`forged-ui-cookie:${cookie.startsWith('unrelated') ? 'substring' : 'exact'}:${path}`, await render(request(path, cookie)), 303, '/login')
      }
    }
    expect(snapshotReads).toBe(0)
  })

  it('does not publish prototype boards or their runtime from the production renderer', async () => {
    const render = await renderer()
    for (const path of ['/reference-a.dc.html', '/reference-b.dc.html', '/reference-c.dc.html', '/reference-d.dc.html', '/support.js', '/assets/support.js']) {
      await observe(`prototype:${path}`, await render(request(path)), 404)
    }
    expect(snapshotReads).toBe(0)
  })

  it('refuses an account owner on the administrative surface before reading state', async () => {
    const principal = await createUserPrincipal(db.db, { username: 'owner', passwordHash: PUBLIC_VECTOR, accountId: '10000000-0000-4000-8000-000000000001' })
    const render = await renderer()
    const cookie = await session(principal.id)
    for (const path of ['/whm', '/whm/accounts', '/whm/security/sign-in']) {
      await observe(`owner-crosses-whm:${path}`, await render(request(path, cookie)), 403)
    }
    expect(snapshotReads).toBe(0)
  })

  it.each(['no-acl', 'root-only', 'route-acl'] as const)('denies reseller document admission before a hosting snapshot: %s', async condition => {
    const reseller = await state.store.createReseller({ username: 'boundaryreseller', passwordHash: PUBLIC_VECTOR,
      acl: condition === 'no-acl' ? [] : ['list-accounts'], maxAccounts: 2, totalDiskMb: 1024,
      totalBandwidthMb: 2048, oversell: false, nameservers: [], delegatedIps: [],
    })
    const principal = await createResellerPrincipal(db.db, { id: reseller.id, username: reseller.username, passwordHash: PUBLIC_VECTOR })
    const cookie = await session(principal.id)
    const render = await renderer()
    const path = condition === 'no-acl' ? '/whm/accounts' : condition === 'root-only' ? '/whm/accounts/health' : '/whm/accounts/new'
    snapshotReads = 0
    const html = await observe(`reseller-admission:${condition}:${path}`, await render(request(path, cookie)), 403)
    expect(html).toContain('data-status-page="403"')
    expect(html).not.toContain('data-tool-availability="unverified"')
    const supplied = hydration.at(-1)
    expect(supplied?.error).toMatchObject({ status: 403 })
    for (const key of ['whm', 'panel', 'mail', 'generationId', 'workspaceSummary']) expect(supplied).not.toHaveProperty(key)
    expect(snapshotReads).toBe(0)
  })

  it.each([false, true])('hydrates only the authenticated reseller security model with list-accounts=%s', async listAccounts => {
    const reseller = await state.store.createReseller({ username: 'selfreseller', passwordHash: PUBLIC_VECTOR,
      acl: listAccounts ? ['list-accounts'] : [], maxAccounts: 2, totalDiskMb: 1024,
      totalBandwidthMb: 2048, oversell: false, nameservers: [], delegatedIps: [],
    })
    const principal = await createResellerPrincipal(db.db, { id: reseller.id, username: reseller.username, passwordHash: PUBLIC_VECTOR })
    if (listAccounts) await setTotpSecret(db.db, principal.id, new Uint8Array(32))
    const other = await root({ enrolled: !listAccounts })
    const getSettings = vi.spyOn(state.store, 'getServerSettings')
    const readWorkspace = vi.spyOn(state.store, 'readAccountWorkspace')
    const hostFetch = vi.fn(async () => new Response(null, { status: 503 }))
    const render = await createDefaultWebRenderer({ store: state.store, db: db.db, serverSecret: SERVER_SECRET, agent: { fetch: hostFetch, token: 'synthetic-agent-token' } })
    const cookie = await session(principal.id)
    const html = await observe(`reseller-self-security:${listAccounts}`, await render(request(`/whm/security/sign-in?principalId=${other.id}&accountId=foreign-account-marker&surface=xpanel`, cookie)), 200)
    expect(hydration.at(-1)).toEqual({
      surface: 'xwhm', mfaRuntimeMode: 'optional', activeRoute: '/whm/security/sign-in',
      security: { totpEnabled: listAccounts },
      visibility: { principal: { kind: 'reseller', id: principal.id, username: principal.username } },
    })
    expect(html).toContain('data-account-security="two-factor"')
    expect(html).toContain(listAccounts ? 'data-mfa-enabled="true"' : 'data-auth-state="optional"')
    expect(html).not.toMatch(/data-mfa-recommendation|data-realtime-enabled="true"|data-workspace-account-overview=|data-account-row=|data-service-row=|data-cmdk-item=/)
    for (const marker of [other.id, 'Multi-factor enrollment is required']) expect(html).not.toContain(marker)
    // Account URL context may persist in links; it never selects a self-service actor or read model.
    expect(html).toContain('accountId=foreign-account-marker')
    expect(html.replace(/href="[^"]*"/g, '')).not.toContain('foreign-account-marker')
    expect(getSettings).not.toHaveBeenCalled()
    expect(readWorkspace).not.toHaveBeenCalled()
    expect(hostFetch).not.toHaveBeenCalled()
    expect(snapshotReads).toBe(0)
    // This self-service exception does not grant the global operator document role.
    expect(canOpenRegisteredRoute('/whm/security/sign-in', { principal: { kind: 'reseller', id: principal.id, username: principal.username }, reseller })).toBe(false)
    for (const path of ['/whm/security/firewall', '/whm/server/setup', '/whm/accounts/health']) {
      expect((await render(request(path, cookie))).status).toBe(403)
    }
    expect(snapshotReads).toBe(0)
  })

  it.each(['missing', 'mismatched', 'disabled', 'password-change', 'revoked', 'expired', 'mfa-pending', 'api-token'] as const)('does not open reseller self security for a %s actor or session', async condition => {
    const reseller = condition === 'missing' ? undefined : await state.store.createReseller({ username: 'guardreseller', passwordHash: PUBLIC_VECTOR,
      acl: [], maxAccounts: 2, totalDiskMb: 1024, totalBandwidthMb: 2048, oversell: false, nameservers: [], delegatedIps: [],
    })
    const principal = await createResellerPrincipal(db.db, {
      ...(reseller ? { id: reseller.id } : {}), username: condition === 'mismatched' ? 'differentactor' : 'guardreseller', passwordHash: PUBLIC_VECTOR,
      disabled: condition === 'disabled', forcePasswordChange: condition === 'password-change',
    })
    if (condition === 'mfa-pending') await setTotpSecret(db.db, principal.id, new Uint8Array(32))
    const cookie = await session(principal.id, condition !== 'mfa-pending')
    let authorization: string | undefined
    if (condition === 'api-token') {
      const token = 'reseller-self-security-api-token-fixture'
      await createApiToken(db.db, { principalId: principal.id, name: 'Self security fixture', tokenHash: sha256Hex(token), scopes: ['*'], expiresAt: future() })
      authorization = `Bearer ${token}`
    }
    if (condition === 'revoked') await db.db.query('UPDATE sessions SET revoked_at = $1 WHERE principal_id = $2', [new Date().toISOString(), principal.id])
    if (condition === 'expired') await db.db.query('UPDATE sessions SET last_seen_at = $1 WHERE principal_id = $2', [new Date(Date.now() - 2 * 3600_000).toISOString(), principal.id])
    const getSettings = vi.spyOn(state.store, 'getServerSettings')
    const readWorkspace = vi.spyOn(state.store, 'readAccountWorkspace')
    const render = await renderer()
    const expectedStatus = condition === 'missing' || condition === 'mismatched' ? 403 : 303
    const html = await observe(`reseller-self-security-rejected:${condition}`, await render(request('/whm/security/sign-in', condition === 'api-token' ? undefined : cookie, authorization)), expectedStatus, expectedStatus === 303 ? '/login' : undefined)
    expect(html).not.toContain('data-account-security="two-factor"')
    if (expectedStatus === 303) expect(hydration).toEqual([])
    else expect(hydration.at(-1)).not.toHaveProperty('security')
    expect(getSettings).not.toHaveBeenCalled()
    expect(readWorkspace).not.toHaveBeenCalled()
    expect(snapshotReads).toBe(0)
  })

  it('requires a real active account for account owners', async () => {
    const principal = await createUserPrincipal(db.db, { username: 'owner', passwordHash: PUBLIC_VECTOR, accountId: '10000000-0000-4000-8000-000000000001' })
    const cookie = await session(principal.id)
    const render = await renderer()
    for (const path of ['/panel', '/mail']) await observe(`missing-owner-account:${path}`, await render(request(path, cookie)), 403)
  })

  it.each(['mfa-pending', 'password-change', 'revoked', 'api-token'] as const)('requires a completed interactive session: %s', async (condition) => {
    const principal = await root({ forcePasswordChange: condition === 'password-change' })
    let cookie = 'xpanel_ui_session=1'
    let authorization: string | undefined
    if (condition === 'api-token') {
      const token = 'web-boundary-api-token-fixture'
      await createApiToken(db.db, { principalId: principal.id, name: 'Web boundary fixture', tokenHash: sha256Hex(token), scopes: ['*'], expiresAt: future() })
      authorization = `Bearer ${token}`
    } else {
      cookie = `${await session(principal.id, condition !== 'mfa-pending')}; ${cookie}`
      if (condition === 'revoked') await db.db.query('UPDATE sessions SET revoked_at = $1 WHERE principal_id = $2', [new Date().toISOString(), principal.id])
    }
    const render = await renderer()
    await observe(`interactive-session:${condition}`, await render(request('/whm', cookie, authorization)), 303, '/login')
    expect(snapshotReads).toBe(0)
  })

  it('opens administrative HTML for root when two-factor authentication is not enrolled', async () => {
    const principal = await root({ enrolled: false })
    const render = await renderer()
    const cookie = await session(principal.id)
    const home = await observe('root-mfa-unenrolled:/whm', await render(request('/whm', cookie)), 200)
    expect(home).toContain('data-mfa-optional-link')
    expect(home).not.toMatch(/Multi-factor enrollment is required|must complete enrollment/)
    const accounts = await observe('root-mfa-unenrolled:/whm/accounts', await render(request('/whm/accounts', cookie)), 200)
    expect(accounts).toContain('data-tool-availability="unverified"')
    expectReadOnlyUnqualifiedWorkspace(accounts)
    expect(accounts).not.toContain('data-status-page="404"')
    expect(accounts).not.toMatch(/Multi-factor enrollment is required|must complete enrollment/)
    const security = await observe('root-mfa-unenrolled:security', await render(request('/whm/security/sign-in', cookie)), 200)
    expect(security).toContain('data-mfa-recommendation')
    expect(security).toContain('data-auth-setup-form')
    expect(security).not.toContain('data-mfa-optional-link')
    expect(snapshotReads).toBe(0)
  })

  it('preserves the real catalog qualification state', async () => {
    const principal = await root()
    const cookie = await session(principal.id)
    const render = await renderer()
    expect(tools.some(tool => tool.status === 'verified' && tool.delivery.status === 'verified')).toBe(false)
    const home = await observe('unverified-catalog:/whm', await render(request('/whm', cookie)), 200)
    expect.soft(home.includes('data-tool-availability="unverified"')).toBe(true)
    expect.soft(/alice-shop\.com|srv1\.xpanel\.test/.test(home)).toBe(false)
    const accounts = await observe('unverified-catalog:/whm/accounts', await render(request('/whm/accounts', cookie)), 200)
    expect.soft(accounts.includes('data-status-page="404"')).toBe(false)
    expect.soft(accounts.includes('data-tool-availability="unverified"')).toBe(true)
    expectReadOnlyUnqualifiedWorkspace(accounts)
    expect(hydration.at(-1)?.workspaceSummary).toEqual({})
    for (const key of ['whm', 'panel', 'mail', 'generationId']) expect(hydration.at(-1)).not.toHaveProperty(key)
    expect.soft(/alice-shop\.com|srv1\.xpanel\.test/.test(accounts)).toBe(false)
    expect(snapshotReads).toBe(0)
  })

  it('hydrates only a bounded identity summary while tools remain unqualified', async () => {
    const principal = await root()
    const cookie = await session(principal.id)
    const render = await renderer()
    await observe('empty-state:/whm', await render(request('/whm', cookie)), 200)
    const workspace = hydration.at(-1)
    expect(workspace).toBeDefined()
    expect((workspace!.visibility as { principal: { kind: string } }).principal.kind).toBe('root')
    expect(workspace!.catalog).toBeUndefined()
    expect(workspace!.workspaceSummary).toEqual({})
    for (const key of ['whm', 'panel', 'mail', 'generationId']) expect(workspace).not.toHaveProperty(key)
    for (const path of ['/whm/accounts', '/whm/accounts/health', ...registeredDocumentAliases.filter(row => row.parentRoute === '/whm/software/site-software').map(row => row.route)]) {
      const html = await observe(`empty-state:${path}`, await render(request(path, cookie)), 200)
      expect(html).toContain('data-tool-availability="unverified"')
      expectReadOnlyUnqualifiedWorkspace(html)
      const supplied = hydration.at(-1)
      expect(supplied).toBeDefined()
      const visibility = supplied!.visibility as { principal: { kind: string } }
      observations.push({ id: `hydration:${path}`, visibilityPrincipalKind: visibility.principal.kind,
        catalogOverridden: supplied!.catalog !== undefined,
        fullStateSupplied: ['whm', 'panel', 'mail', 'generationId'].some(key => key in supplied!),
        workspaceSummaryKeys: Object.keys(supplied!.workspaceSummary as Record<string, unknown>),
      })
      expect(visibility.principal.kind).toBe('root')
      expect(supplied!.catalog).toBeUndefined()
      expect(supplied!.activeRoute).toBe(path)
      expect(supplied!.workspaceSummary).toEqual({})
      expect(supplied).not.toHaveProperty('error')
      for (const key of ['whm', 'panel', 'mail', 'generationId']) expect(supplied).not.toHaveProperty(key)
    }
    expect(snapshotReads).toBe(0)
  })

  it('distinguishes unknown documents from role-denied pages and unqualified registered workspaces', async () => {
    const principal = await root()
    const cookie = await session(principal.id)
    const render = await renderer()
    const unknown = await observe('route-404:anonymous-email', await render(request('/panel/email')), 404)
    expect(unknown).toContain('data-status-page="404"')
    expect(unknown).not.toContain('data-tool-availability="unverified"')
    expect(unknown).toContain('Sign in')
    const signedUnknown = await observe('route-404:signed-in-unknown', await render(request('/not-a-real-page', cookie)), 404)
    expect(signedUnknown).toContain('data-status-page="404"')
    expect(signedUnknown).toContain('data-user-menu')
    expect(signedUnknown).toContain('data-action="logout"')
    expect(signedUnknown).not.toContain('>Sign in<')
    for (const path of ['/panel', '/panel/domains', '/panel/files/manager', '/mail', '/mail/inbox']) {
      const denied = await observe(`root-owner-only:${path}`, await render(request(path, cookie)), 403)
      expect(denied).toContain('data-status-page="403"')
      expect(denied).not.toContain('data-tool-availability="unverified"')
      expect(hydration.at(-1)).not.toHaveProperty('workspaceSummary')
    }
    const home = await observe('route-home:/whm', await render(request('/whm', cookie)), 200)
    expect(home).toContain('data-tool-availability="unverified"')
    expect(home).toContain('Coming soon')
    const crossedRender = await createDefaultWebRenderer({
      store: state.store, db: db.db, serverSecret: SERVER_SECRET, entryPoint: 'xpanel', publicOrigin: 'https://panel.example.test:2083',
    })
    // A listener renders no other panel: the 404 names neither another origin nor a switch to it.
    const crossed = await observe('route-404:cross-whm', await crossedRender(request('/whm')), 404)
    expect(crossed).not.toMatch(/whm\.example\.test|mail\.example\.test|data-panel-link|data-panel-switch/)
    expect(crossed).not.toContain('href="/whm')
    expect(snapshotReads).toBe(0)
  })

  it.each([false, true])('serves a scoped account overview over HTTP with populated owner database state: %s', async (populated) => {
    const featureList = await state.store.createFeatureList({ name: 'Summary fixture features', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({
      name: 'Summary plan7', ownerId: null, featureListId: featureList.id,
      resources: { diskMb: 1000, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
      caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 },
      dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
    })
    const accountInput = { passwordHash: PUBLIC_VECTOR, planId: plan.id, ownerId: null, contactEmail: 'private-summary-contact@example.test', ipv4: '192.0.2.199', shell: 'none' as const,
      php: { version: '8.3', handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
    }
    await state.store.saveServerIp({ address: '192.0.2.199', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const owner = await state.store.createAccount({ ...accountInput, username: 'owner7', primaryDomain: 'owner7.example.test' })
    const other = await state.store.createAccount({ ...accountInput, username: 'other7', primaryDomain: 'private-other-account.example.test' })
    const trashedDatabase = await state.store.createDatabase({ accountId: owner.id, name: 'owner7_trashed' })
    await state.store.trashDatabase(trashedDatabase.id)
    const databases = populated ? [await state.store.createDatabase({ accountId: owner.id, name: 'owner7_live' })] : []
    const databaseUsers = populated ? await Promise.all(['app', 'reader'].map(name => state.store.createDatabaseUser({
      accountId: owner.id, name: `owner7_${name}`, authPlugin: 'ed25519', authString: PUBLIC_DB_AUTH,
    }))) : []
    const otherDatabase = await state.store.createDatabase({ accountId: other.id, name: 'other7_private' })
    const otherDatabaseUser = await state.store.createDatabaseUser({
      accountId: other.id, name: 'other7_private', authPlugin: 'ed25519', authString: PUBLIC_DB_AUTH,
    })
    const principal = await createUserPrincipal(db.db, { username: owner.username, accountId: owner.id, passwordHash: PUBLIC_VECTOR })
    const cookie = await session(principal.id)
    const app = createApiApp({ store: state.store, db: db.db, serverSecret: SERVER_SECRET, webRenderer: await renderer() })
    const server = await listenApiServer(app, { host: '127.0.0.1', port: 0 })
    snapshotReads = 0
    try {
      const origin = `http://127.0.0.1:${server.port}`
      for (const locale of ['en', 'ar']) {
        const response = await fetch(`${origin}/panel?lang=${locale}`, { headers: { cookie }, redirect: 'manual' })
        const html = await observe(`scoped-summary-http:${populated ? 'database-populated' : 'database-empty'}:${locale}`, response, 200)
        for (const value of [owner.username, owner.primaryDomain, plan.name, owner.home, owner.ipv4]) expect(html).toContain(value)
        expect(html).toContain('data-board-port="xpanel-home"')
        expect(html).toContain(locale === 'ar' ? 'الرئيسية' : 'Home')
        expect(html).toContain('data-action="logout"')
        expect(html).not.toContain('data-tool-availability="unverified"')
        expect(html).not.toMatch(/<form\b|[\u0660-\u0669\u06f0-\u06f9]/)
        const panel = hydration.at(-1)?.panel as { databases: Array<{ id: string; name: string }>; databaseUsers: Array<{ id: string; name: string; grants: unknown[] }> }
        expect(panel.databases.map(database => database.name)).toEqual(databases.map(database => database.name))
        expect(panel.databaseUsers).toEqual(databaseUsers.map(user => ({ id: user.id, name: user.name, grants: user.grants })))
        const databaseLabel = locale === 'ar' ? 'قواعد البيانات' : 'Databases'
        const databaseMeter = new RegExp(`#475467[^"]*">${databaseLabel}</span>([\\s\\S]*?)</div>`).exec(html)?.[1]
        expect(databaseMeter?.replace(/<[^>]*>/g, '').trim()).toBe(`${databases.length} / 1`)
        for (const value of [otherDatabase.id, otherDatabase.name, otherDatabaseUser.id, otherDatabaseUser.name, trashedDatabase.id, trashedDatabase.name, PUBLIC_DB_AUTH]) {
          expect(JSON.stringify(panel)).not.toContain(value)
          expect(html).not.toContain(value)
        }
        for (const value of [owner.id, other.id, principal.id, plan.id, featureList.id, owner.contactEmail, other.primaryDomain, PUBLIC_VECTOR]) expect(html).not.toContain(value)
      }
      for (const [path, canonicalRoute] of [
        ['/domains', '/domains'], ['/panel/domains', '/domains'],
        ['/files/manager', '/files/manager'], ['/panel/files/manager', '/files/manager'],
        ...registeredDocumentAliases.filter(row => row.parentRoute === '/software/installer').map(row => [row.route, row.route] as const),
      ] as const) {
        const html = await observe(`registered-unqualified-owner:${path}`, await fetch(`${origin}${path}`, { headers: { cookie }, redirect: 'manual' }), 200)
        expect(html).toContain('data-tool-availability="unverified"')
        expectReadOnlyUnqualifiedWorkspace(html)
        expect(html).not.toContain('data-status-page="404"')
        const supplied = hydration.at(-1)
        expect(supplied).toMatchObject({ surface: 'xpanel', activeRoute: canonicalRoute })
        expect(supplied?.workspaceSummary).toEqual({
          account: { id: owner.id, ownerId: owner.ownerId, username: owner.username, primaryDomain: owner.primaryDomain, status: owner.status, planId: owner.planId },
          plan: { id: plan.id, name: plan.name },
        })
        expect(supplied?.catalog).toBeUndefined()
        expect(supplied).not.toHaveProperty('error')
        for (const key of ['whm', 'panel', 'mail', 'generationId']) expect(supplied).not.toHaveProperty(key)
        for (const value of [owner.home, owner.ipv4, owner.contactEmail, other.primaryDomain, PUBLIC_VECTOR, PUBLIC_DB_AUTH,
          otherDatabase.id, otherDatabase.name, otherDatabaseUser.id, otherDatabaseUser.name,
          ...databases.map(database => database.name), ...databaseUsers.map(user => user.name),
        ]) {
          expect(JSON.stringify(supplied?.workspaceSummary)).not.toContain(value)
          expect(html).not.toContain(value)
        }
        for (const value of [owner.username, owner.primaryDomain, plan.name]) expect(html).toContain(value)
        for (const value of [owner.id, other.id, principal.id, plan.id, featureList.id]) expect(html).not.toContain(value)
      }
      await observe('scoped-summary-http:other-account', await fetch(`${origin}/panel?accountId=${other.id}`, { headers: { cookie }, redirect: 'manual' }), 404)
      await observe('scoped-summary-http:anonymous', await fetch(`${origin}/panel`, { redirect: 'manual' }), 303, '/login')
      expect(snapshotReads).toBe(0)
    } finally { await server.close() }
  })
})
