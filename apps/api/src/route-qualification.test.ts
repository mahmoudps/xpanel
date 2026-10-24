import { writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { navigation } from '@xpanel/catalog'
import { createResellerPrincipal, createRootPrincipal, createSession, createTestDb, createUserPrincipal } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { SESSION_COOKIE_NAME, sha256Hex } from './auth.ts'
import { resetQualifiedCatalogCache } from './host-catalog.ts'
import { createDefaultWebRenderer } from './main.ts'

const PUBLIC_VECTOR = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SERVER_SECRET = 'route-qualification-fixture-secret-for-tests'
const PROBES = ['linux-account', 'apache', 'mariadb', 'mail', 'files', 'acme', 'pdns', 'backups', 'systemd', 'host-info', 'audit_log']
const SIDEBAR = [
  '/home', '/resources', '/files/manager', '/files/backup', '/files/directory-privacy',
  '/domains', '/domains/site-settings', '/domains/zone-editor', '/databases/mariadb',
  '/email/accounts', '/software/php', '/software/htaccess', '/advanced/cron',
  '/metrics/traffic', '/security/ssl', '/security/account',
]
const ROOT_LINKS = ['/whm/resellers', '/whm/security/firewall', '/whm/server/upgrade', '/whm/server/setup', '/whm/audit']
const future = () => new Date(Date.now() + 60_000).toISOString()

const navRoutes = navigation.flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))

describe('built navigation routes render', () => {
  let db: TestDbHandle
  let state: TestStateStoreHandle

  beforeEach(async () => {
    resetQualifiedCatalogCache()
    db = await createTestDb()
    state = await createTestStateStore()
  })

  afterEach(async () => {
    resetQualifiedCatalogCache()
    await state.close()
    await db.close()
  })

  const session = async (principalId: string, token: string) => {
    await createSession(db.db, { principalId, tokenHash: sha256Hex(token), expiresAt: future(), mfaVerified: true })
    return `${SESSION_COOKIE_NAME}=${token}`
  }

  const probed = () => createDefaultWebRenderer({
    store: state.store,
    db: db.db,
    serverSecret: SERVER_SECRET,
    agent: {
      token: 'e'.repeat(64),
      fetch: async (request) => {
        if (new URL(request.url).pathname !== '/health') return new Response('missing', { status: 404 })
        return Response.json({ executor: 'linux', probes: Object.fromEntries(PROBES.map(probe => [probe, 'passed'])) })
      },
    },
  })

  const ask = async (render: Awaited<ReturnType<typeof probed>>, path: string, cookie: string) => {
    const response = await render(new Request(`http://localhost${path}`, { headers: { cookie } }))
    const html = await response.text()
    return { status: response.status, html, renders: response.status === 200 && !html.includes('data-status-page="404"') }
  }

  it('resolves every navigation link for root and keeps an unknown path at 404', async () => {
    const principal = await createRootPrincipal(db.db, { username: 'root', passwordHash: PUBLIC_VECTOR, forcePasswordChange: false })
    const cookie = await session(principal.id, 'route-qualification-root')
    const render = await probed()
    const rows = []
    for (const route of navRoutes) {
      const row = await ask(render, route, cookie)
      rows.push({ route, ...row })
      expect(row.status, route).not.toBe(404)
      expect(row.renders, route).toBe(true)
    }
    const unknown = await ask(render, '/not-a-real-page', cookie)
    expect(unknown.status).toBe(404)
    expect(unknown.html).toContain('data-status-page="404"')
    for (const route of ['/resources', '/advanced/terminal', '/whm/security/firewall']) {
      const row = rows.find(item => item.route === route)
      expect(row?.renders, route).toBe(true)
      expect(row?.html, route).toMatch(/Coming soon|data-wiring="soon"|data-tool-availability="unverified"/)
      expect(row?.html, route).not.toMatch(/alice-shop\.com|omar-clinic\.net|srv1\.xpanel\.test/)
    }
    const home = rows.find(item => item.route === '/whm')
    expect(home?.html).toContain('href="/whm/server/upgrade')
    expect(home?.html).not.toContain('/whm/upgrade')
    writeFileSync('/tmp/route-counts-after.json', `${JSON.stringify({
      navRoutes: navRoutes.length,
      rootRendering: rows.filter(row => row.renders).length,
      root404: rows.filter(row => row.status === 404).length,
    })}\n`)
  })

  it('resolves every xPanel sidebar link for the account owner', async () => {
    const featureList = await state.store.createFeatureList({ name: 'Route features', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({
      name: 'Route plan', ownerId: null, featureListId: featureList.id,
      resources: { diskMb: 1000, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
      caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 },
      dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
    })
    await state.store.saveServerIp({ address: '192.0.2.210', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const account = await state.store.createAccount({
      passwordHash: PUBLIC_VECTOR, planId: plan.id, ownerId: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.210', shell: 'none',
      php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
      username: 'owner7', primaryDomain: 'owner7.example.test',
    })
    const principal = await createUserPrincipal(db.db, { username: account.username, accountId: account.id, passwordHash: PUBLIC_VECTOR })
    const cookie = await session(principal.id, 'route-qualification-owner')
    const render = await probed()
    const missing = []
    for (const route of SIDEBAR) {
      const row = await ask(render, route, cookie)
      expect(row.status, route).not.toBe(404)
      expect(row.renders, route).toBe(true)
      if (!row.renders) missing.push(route)
    }
    expect(missing).toEqual([])
    expect(SIDEBAR).toHaveLength(16)
  })

  it('omits root links from the reseller sidebar', async () => {
    const reseller = await state.store.createReseller({
      username: 'reseller7', passwordHash: PUBLIC_VECTOR, acl: ['list-accounts'], maxAccounts: 10,
      totalDiskMb: 10000, totalBandwidthMb: 'unlimited', oversell: false, nameservers: [], delegatedIps: [],
    })
    const principal = await createResellerPrincipal(db.db, { id: reseller.id, username: reseller.username, passwordHash: PUBLIC_VECTOR })
    const cookie = await session(principal.id, 'route-qualification-reseller')
    const render = await probed()
    const home = await ask(render, '/whm', cookie)
    const accounts = await ask(render, '/whm/accounts', cookie)
    expect(home.renders).toBe(true)
    expect(accounts.renders).toBe(true)
    expect(accounts.html).toContain('data-nav-route="/whm/accounts"')
    for (const html of [home.html, accounts.html]) {
      for (const route of ROOT_LINKS) expect(html, route).not.toContain(route)
      expect(html).not.toContain('/whm/upgrade')
    }
  })
})
