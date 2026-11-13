import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { access, copyFile, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from 'vitest'
import { createAgentApp, FakeHostExecutor, HostReconciler } from '@xpanel/agent'
import { createDb, createRootPrincipal, createUserPrincipal, initializeOperationalMetadata, listAudit, migrate } from '@xpanel/db'
import { defaultPlan } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { atomicWriteJson, StateStore } from '@xpanel/state'
import { runtimeRegistryPath } from '../../agent/src/account-runtime.ts'
import { CSRF_HEADER_NAME, hashPasswordArgon2id, parseCookies, SESSION_COOKIE_NAME } from './auth.ts'
import { createMemoryDav } from './mail/dav-testkit.ts'
import { startPanelServer } from './test-panel-server.ts'
import { ExtendedFeaturesStore, type InstalledAppRecord } from './extended-routes.ts'
import * as mailDocuments from './mail/document.ts'
import { parseMarkup } from '../../web/src/html.ts'
import { renderWebApp } from '../../web/src/app.ts'
import { translator } from '../../web/src/i18n.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

// Fixture hashes use the cheapest accepted cost (as team-test-fixture.ts); route-created hashes keep production cost.
const FIXTURE_HASH_COST = { timeCost: 1, parallelism: 1 }
const FAST_TMP = existsSync('/dev/shm') ? '/dev/shm' : tmpdir()
const TEST_OS = profileFor('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble')

interface HttpSessionClient {
  baseUrl: string
  cookie: string
  csrfToken: string
  request(
    path: string,
    opts?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<Response>
}

const createHttpClient = (baseUrl: string, setCookieHeader: string | null, csrfToken: string): HttpSessionClient => {
  const cookies = parseCookies(
    setCookieHeader
      ? setCookieHeader
          .split(',')
          .map((part) => part.split(';')[0]?.trim())
          .filter(Boolean)
          .join('; ')
      : null,
  )
  const token = cookies[SESSION_COOKIE_NAME] ?? ''
  const cookieHeader = `${SESSION_COOKIE_NAME}=${token}`

  return {
    baseUrl,
    cookie: cookieHeader,
    csrfToken,
    request: async (path, opts = {}) => {
      const method = (opts.method ?? 'GET').toUpperCase()
      const headers: Record<string, string> = {
        cookie: cookieHeader,
        ...(opts.headers ?? {}),
      }
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        headers[CSRF_HEADER_NAME] = csrfToken
      }
      if (opts.body !== undefined) {
        headers['content-type'] = 'application/json'
      }
      return fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      })
    },
  }
}

// Inspect actual unqualified status-body elements. Bootstrap strings and inert
// row templates do not grant authority; hidden/disabled live forms still count.
const assertUnqualifiedWorkspaceHasNoLiveActions = (html: string): ReturnType<typeof parseMarkup> => {
  const nodes = parseMarkup(html)
  const liveWorkspace: ReturnType<typeof parseMarkup> = []
  const bodies = new Set(nodes.flatMap((node, index) => node.namespace === 'html' && node.template === -1
    && node.tag === 'section' && node.attrs.get('data-tool-availability') === 'unverified' ? [index] : []))
  assert.ok(bodies.size > 0, 'the actual unqualified workspace status body must exist')
  const inside = (index: number): boolean => {
    for (let current = index; current >= 0; current = nodes[current]?.parent ?? -1) if (bodies.has(current)) return true
    return false
  }
  for (const [index, node] of nodes.entries()) {
    // Forbidden enrollment cards remain forbidden even when hidden or templated.
    assert.notEqual(node.attrs.get('data-account-security'), 'two-factor')
    if (node.namespace !== 'html' || node.template !== -1 || !inside(index)) continue
    assert.notEqual(node.tag, 'form', 'an unqualified workspace must not contain a live operation form')
    assert.equal(node.attrs.has('data-cmdk-item'), false, 'an unqualified status body must not expose executable command items')
    liveWorkspace.push(node)
  }
  return liveWorkspace
}

describe('@xpanel/api extended HTTP contracts with explicit fake host execution', () => {
  let tmpDir: string
  let templateDir: string
  let templateDbPath: string
  let docOwnerPasswordHash: string
  let serverHandle: Extract<Awaited<ReturnType<typeof startPanelServer>>, { quarantined: false }>
  let baseUrl: string
  let agentDb: ReturnType<typeof createDb>
  // Every state write, writer lease and staged generation file calls FileHandle#sync, so device flush
  // latency, not this file's contracts, set its wall time (2.5 s idle, over 30 s under a parallel lane).
  // Flush durability is proven by packages/state atomic-durability tests; writes, renames and read-back stay real.
  let restoreFileSync = (): void => {}
  beforeAll(async () => {
    const probe = await open(fileURLToPath(import.meta.url), 'r')
    try {
      const sync = vi.spyOn(Object.getPrototypeOf(probe) as FileHandle, 'sync').mockResolvedValue(undefined)
      restoreFileSync = () => sync.mockRestore()
    } finally { await probe.close() }
    translator('en'); translator('ar')
    parseMarkup(renderWebApp({ surface: 'login', activeRoute: '/login', locale: 'en', uiTheme: 'v2' }))
    parseMarkup(renderWebApp({ surface: 'xwhm', activeRoute: '/whm', locale: 'en', uiTheme: 'v2' }))
    parseMarkup(renderWebApp({ surface: 'xwhm', activeRoute: '/whm/security/sign-in', locale: 'en', uiTheme: 'v2' }))
    parseMarkup(renderWebApp({ surface: 'xpanel', activeRoute: '/home', locale: 'ar', uiTheme: 'v2' }))
    parseMarkup(renderWebApp({ surface: 'xpanel', activeRoute: '/domains', locale: 'ar', uiTheme: 'v2' }))
    templateDir = await mkdtemp(join(FAST_TMP, 'xpanel-ext-tpl-'))
    templateDbPath = join(templateDir, 'control.db')
    const [rootPasswordHash, ownerHash] = await Promise.all([
      hashPasswordArgon2id('RootPassword!2026', FIXTURE_HASH_COST),
      hashPasswordArgon2id('DocumentOwnerPassword!2026', FIXTURE_HASH_COST),
    ])
    docOwnerPasswordHash = ownerHash
    const tpl = createDb(templateDbPath)
    try {
      await migrate(tpl.runner)
      await initializeOperationalMetadata(tpl.db)
      await createRootPrincipal(tpl.db, { username: 'root', passwordHash: rootPasswordHash, forcePasswordChange: false })
    } finally { await tpl.close() }
  })
  afterAll(async () => {
    restoreFileSync()
    if (templateDir) await rm(templateDir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(FAST_TMP, 'xpanel-ext-e2e-'))
    const dbPath = join(tmpDir, 'control.db')
    const stateDir = join(tmpDir, 'state')
    const os = TEST_OS
    await copyFile(templateDbPath, dbPath)
    agentDb = createDb(dbPath)
    const store = new StateStore(stateDir)
    const executor = new FakeHostExecutor()
    const reconciler = new HostReconciler({ db: agentDb.db, store, executor, os })
    const agentApp = createAgentApp({
      db: agentDb.db, store, executor, reconciler, agentToken: TEST_AGENT_TOKEN,
      os: { id: os.id, versionId: os.versionId, family: os.family },
      homeBaseDir: join(tmpDir, 'host'),
    })
    const started = await startPanelServer({
      davExchange: createMemoryDav({ defaults: true }).exchange,
      port: 0,
      host: '127.0.0.1',
      dbPath,
      stateDir,
      homeBaseDir: join(tmpDir, 'host'),
      agentApp,
      os,
      agentToken: TEST_AGENT_TOKEN,
      serverSecret: TEST_SERVER_SECRET,
    })
    if (started.quarantined) {
      await started.close()
      throw new Error('The ordinary HTTP fixture unexpectedly entered lifecycle quarantine')
    }
    serverHandle = started
    baseUrl = `http://127.0.0.1:${serverHandle.port}`
  })

  afterEach(async () => {
    await serverHandle?.close()
    await agentDb?.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  const loginOverHttp = async (username: string, password: string): Promise<HttpSessionClient> => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { csrfToken: string; mfaEnrollmentRequired?: boolean }
    assert.equal(body.mfaEnrollmentRequired, false)
    return createHttpClient(baseUrl, res.headers.get('set-cookie'), body.csrfToken)
  }

  it('1. HTTP documents protect anonymous routes and render authenticated English and Arabic surfaces', async () => {
    const loginPage = await fetch(`${baseUrl}/login`)
    assert.equal(loginPage.status, 200)
    assert.match(loginPage.headers.get('content-type') ?? '', /text\/html/)
    const loginHtml = await loginPage.text()
    assert.match(loginHtml, /data-surface="login"/)
    assert.match(loginHtml, /data-ui-theme="v2"/)
    assert.match(loginHtml, /href="\/assets\/themes\/v2\/styles\.css\?v=/)
    assert.doesNotMatch(loginHtml, /must complete enrollment/)
    assert.doesNotMatch(loginHtml, /<form[^>]*data-auth-setup-form/)

    for (const path of ['/whm', '/panel', '/mail']) {
      const anonymous = await fetch(`${baseUrl}${path}`, { redirect: 'manual' })
      assert.equal(anonymous.status, 303)
      assert.equal(anonymous.headers.get('location'), '/login')
    }

    const root = await loginOverHttp('root', 'RootPassword!2026')
    const whmPage = await root.request('/whm')
    assert.equal(whmPage.status, 200)
    const whmHtml = await whmPage.text()
    assert.match(whmHtml, /data-surface="xwhm"/)
    assert.match(whmHtml, /id="xpanel-login-client"/)
    assert.match(whmHtml, /id="xpanel-realtime-client"/)
    assert.match(whmHtml, /<html\b[^>]*data-realtime-enabled="false"/)
    assert.match(whmHtml, /data-tool-availability="unverified"/)
    assert.match(whmHtml, /data-mfa-optional-link/)
    assert.match(whmHtml, /data-nav-route=/)
    assertUnqualifiedWorkspaceHasNoLiveActions(whmHtml)
    const securityPage = await root.request('/whm/security/sign-in')
    assert.equal(securityPage.status, 200)
    const securityHtml = await securityPage.text()
    assert.match(securityHtml, /data-mfa-recommendation/)
    assert.match(securityHtml, /data-auth-setup-form/)
    assert.doesNotMatch(securityHtml, /must complete enrollment|data-mfa-optional-link/)

    for (const path of ['/panel', '/mail?lang=ar&theme=light']) {
      const denied = await root.request(path)
      assert.equal(denied.status, 403)
      const html = await denied.text()
      assert.match(html, /data-status-page="403"/)
      assert.doesNotMatch(html, /data-tool-availability="unverified"|data-board-port="xpanel-home"|data-panel-home\b/)
      assert.doesNotMatch(html, /<(?:div|section|main)\b[^>]*data-mail-layout=/)
    }

    const featureList = await serverHandle.store.createFeatureList({ name: 'Document features', ownerId: null, disabled: [] })
    const { id: _seedId, ...planInput } = defaultPlan({ name: 'Document plan', featureListId: featureList.id })
    const plan = await serverHandle.store.createPlan(planInput)
    const password = 'DocumentOwnerPassword!2026'
    const passwordHash = docOwnerPasswordHash
    await serverHandle.store.saveServerIp({ address: '192.0.2.31', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const account = await serverHandle.store.createAccount({ username: 'docowner', passwordHash, primaryDomain: 'docowner.example.test', planId: plan.id, ownerId: null,
      contactEmail: 'private-document-contact@example.test', ipv4: '192.0.2.31', shell: 'none',
      php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
    })
    assert.equal(account.status, 'active')
    const user = await createUserPrincipal(serverHandle.db, { username: account.username, accountId: account.id, passwordHash })
    const owner = await loginOverHttp(account.username, password)
    let snapshotReads = 0
    const mailRead = vi.spyOn(mailDocuments, 'loadMailDocument')
    const readSnapshot = serverHandle.store.readSnapshot.bind(serverHandle.store)
    serverHandle.store.readSnapshot = async () => { snapshotReads++; return readSnapshot() }
    try {
      for (const path of ['/panel', '/mail']) {
        const denied = await root.request(path)
        assert.equal(denied.status, 403)
        const html = await denied.text()
        assert.match(html, /data-status-page="403"/)
        for (const value of [account.id, account.primaryDomain, account.home, account.ipv4, account.contactEmail, plan.name, passwordHash]) assert.ok(!html.includes(value), 'The root role does not expose owner data on owner-only documents')
        assert.equal(snapshotReads, 0)
        assert.equal(mailRead.mock.calls.length, 0)
      }
      for (const locale of ['en', 'ar']) {
        const home = await owner.request(`/panel?lang=${locale}&theme=light`)
        assert.equal(home.status, 200)
        const homeHtml = await home.text()
        assert.match(homeHtml, /data-surface="xpanel"/)
        assert.match(homeHtml, /data-panel-home\b/)
        assert.ok(homeHtml.includes(account.primaryDomain))
        assert.ok(homeHtml.includes(plan.name))
        // xMail opens only for a mailbox identity; the hosting owner gets its denial without account data.
        const mail = await owner.request(`/mail?lang=${locale}&theme=light`)
        assert.equal(mail.status, 403)
        const mailHtml = await mail.text()
        assert.match(mailHtml, /data-status-page="403"/)
        for (const value of [account.id, account.primaryDomain, account.home, account.ipv4, account.contactEmail, plan.name, passwordHash]) assert.ok(!mailHtml.includes(value))
        for (const path of ['/panel/domains']) {
          const document = await owner.request(`${path}?lang=${locale}&theme=light`)
          assert.equal(document.status, 200)
          assert.match(document.headers.get('content-type') ?? '', /text\/html/)
          const html = await document.text()
          assert.ok(html.includes(`lang="${locale}"`))
          assert.ok(html.includes(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`))
          assert.match(html, /data-theme="light"/)
          assert.ok(html.includes('data-surface="xpanel"'))
          assert.match(html, /data-tool-availability="unverified"/)
          const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
          const workspace = assertUnqualifiedWorkspaceHasNoLiveActions(html)
          const controls = workspace.filter(node => ['button', 'input', 'select', 'textarea'].includes(node.tag))
          assert.ok(controls.length > 0, 'The read-only document retains its actual live controls')
          // Inspect every live control, including hidden/disabled elements. Inert
          // finite row/prompt templates and controls outside the body are separate.
          for (const control of controls) assert.equal(control.attrs.has('disabled'), true)
          for (const node of workspace.filter(value => value.tag === 'a')) {
            assert.equal(['data-action', 'onclick', 'onsubmit'].some(attribute => node.attrs.has(attribute)), false)
          }
          assert.match(html, /<html\b[^>]*data-realtime-enabled="false"/)
          assert.doesNotMatch(html, /data-status-page="404"|data-board-port="xpanel-home"|data-panel-home\b/)
          assert.doesNotMatch(markup, /<(?:div|section|main)\b[^>]*data-mail-layout=/)
          // The saved document root and IPv4 binding of the owner's own domain may show in closed fields.
          for (const value of [account.id, plan.id, featureList.id, user.id, account.contactEmail, password, passwordHash]) assert.ok(!html.includes(value), 'Unqualified documents must not expose full account or authentication data')
          assert.ok(html.includes(account.primaryDomain))
          assert.ok(html.includes(plan.name))
          assert.equal(snapshotReads, 0, 'Unqualified documents do not hydrate a full hosting snapshot')
          assert.equal(mailRead.mock.calls.length, 0, 'Unqualified mail documents do not enter the provider-backed mail loader')
        }
      }
    } finally { serverHandle.store.readSnapshot = readSnapshot; mailRead.mockRestore() }
  })

  it('2. Stored extended feature HTTP contracts and generated configuration with fake host execution', { tags: ['slow'] }, async () => {
    const root = await loginOverHttp('root', 'RootPassword!2026')

    // ---- Step A: First-Run Setup Wizard, Hostname Change & Disk Quota Init ----
    const wizGet = await root.request('/api/setup/wizard')
    assert.equal(wizGet.status, 200)
    const wizInitData = (await wizGet.json()) as { setupComplete: boolean }
    assert.equal(wizInitData.setupComplete, false)

    const wizard = { hostname: 'whm.xpanel.test', nameservers: ['ns1.xpanel.test', 'ns2.xpanel.test'], contactEmail: 'noc@xpanel.test', engine: 'apache', apacheMpm: 'itk',
      primaryIpv4: '203.0.113.10', primaryIpv6: '2001:db8::10', quotaFilesystem: '/home', initQuotas: true }
    // Prefork is refused as the installer refuses it, before any setup write.
    const preforkPost = await root.request('/api/setup/wizard', { method: 'POST', body: { ...wizard, apacheMpm: 'prefork' } })
    assert.equal(preforkPost.status, 422)
    assert.equal(((await preforkPost.json()) as { code: string }).code, 'ENGINE_UNAVAILABLE')
    assert.equal(((await (await root.request('/api/setup/wizard')).json()) as { setupComplete: boolean }).setupComplete, false)
    const wizPost = await root.request('/api/setup/wizard', { method: 'POST', body: wizard })
    assert.equal(wizPost.status, 200)
    const wizPostBody = (await wizPost.json()) as {
      ok: boolean
      setupComplete: boolean
      quotaInitialized: boolean
      settings: { hostname: string }
    }
    assert.equal(wizPostBody.ok, true)
    assert.equal(wizPostBody.setupComplete, true)
    assert.equal(wizPostBody.quotaInitialized, false)
    assert.equal(wizPostBody.settings.hostname, 'whm.xpanel.test')

    // Change hostname
    const hostRes = await root.request('/api/server/hostname', {
      method: 'POST',
      body: { hostname: 'edge01.xpanel.test' },
    })
    assert.equal(hostRes.status, 200)
    const hostBody = (await hostRes.json()) as {
      hostname: string
      previousHostname: string
      settings: { hostname: string }
      application: { nativeApplied: boolean; kernelHostname: string | null }
      reconcile: { status: string } | null
    }
    assert.equal(hostBody.hostname, 'edge01.xpanel.test')
    assert.equal(hostBody.previousHostname, 'whm.xpanel.test')
    assert.equal(hostBody.settings.hostname, 'edge01.xpanel.test')
    assert.ok(hostBody.reconcile)
    // The memory-only executor has no kernel host name, so the saved name is not reported as applied.
    assert.deepEqual(hostBody.application, { nativeApplied: false, kernelHostname: null })
    assert.equal('files' in hostBody, false)

    // Initialize filesystem quotas
    const quotaRes = await root.request('/api/server/quotas/init', {
      method: 'POST',
      body: { filesystem: '/home' },
    })
    // The route reaches the agent now; this fixture's memory-only executor refuses, and that refusal is reported.
    assert.equal(quotaRes.status, 412)
    const quotaBody = (await quotaRes.json()) as { detail: string; details: { stateChanged: boolean } }
    assert.equal(quotaBody.details.stateChanged, false)
    assert.equal(quotaBody.detail, 'quota setup requires the native Linux host executor')

    // Create a plan and hosting account for tenant-scoped features
    const planRes = await root.request('/api/plans', {
      method: 'POST',
      body: { name: 'Enterprise NVMe' },
    })
    assert.equal(planRes.status, 201)
    const planId = ((await planRes.json()) as { plan: { id: string } }).plan.id

    // Arrange isolated desired-state data for the extended-contract fixture.
    // This fake host has no private/native prepared-provisioning proof. Account
    // provisioning HTTP/WHMCS admission is tested by its dedicated strict suites;
    // this setup must not pretend a native account-create acknowledgement.
    const accountPasswordHash = await hashPasswordArgon2id('NebulaPassword!2026', FIXTURE_HASH_COST)
    const account = await serverHandle.store.createAccount({ username: 'nebula', primaryDomain: 'nebula.test', planId,
      ownerId: null, contactEmail: 'nebula@nebula.test', passwordHash: accountPasswordHash, shell: 'none',
      php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} },
    })
    await createUserPrincipal(serverHandle.db, { username: account.username, accountId: account.id, passwordHash: accountPasswordHash, forcePasswordChange: false })

    // Register the source domain and mailbox through authorized provisioning contracts.
    const oldDomain = await root.request('/api/domains', {
      method: 'POST', body: { accountId: account.id, name: 'nebula-old.test', kind: 'addon' },
    })
    assert.equal(oldDomain.status, 201)
    const founderMailbox = await root.request('/api/service-users', {
      method: 'POST', body: {
        accountId: account.id, login: 'founder@nebula.test', password: 'FounderPassword!2026',
        services: { email: true, ftp: false, webdisk: false },
      },
    })
    assert.equal(founderMailbox.status, 201)
    const provisionedMailbox = await founderMailbox.json() as { serviceUser: Record<string, unknown> }
    assert.ok(!('passwordHash' in provisionedMailbox.serviceUser))

    // ---- Step B: Deep Mail (/api/mail/*) ----
    const domFwdRes = await root.request('/api/mail/domain-forwarders', {
      method: 'POST',
      body: {
        accountId: account.id,
        sourceDomain: 'nebula-old.test',
        targetDomain: 'nebula.test',
      },
    })
    assert.equal(domFwdRes.status, 201)
    const domFwdBody = (await domFwdRes.json()) as { domainForwarder: { sourceDomain: string; targetDomain: string }; revision: number }
    assert.equal(domFwdBody.domainForwarder.sourceDomain, 'nebula-old.test')
    assert.equal(domFwdBody.domainForwarder.targetDomain, 'nebula.test')
    assert.ok(Number.isSafeInteger(domFwdBody.revision))

    const fwdRes = await root.request('/api/mail/forwarders', {
      method: 'POST',
      body: {
        accountId: account.id,
        sourceAddress: 'sales@nebula.test',
        destinations: ['founder@nebula.test', 'crm@nebula.test'],
      },
    })
    assert.equal(fwdRes.status, 201)

    const mlRes = await root.request('/api/mail/mailing-lists', {
      method: 'POST',
      body: {
        accountId: account.id,
        name: 'engineering',
        domain: 'nebula.test',
        members: ['dev1@nebula.test', 'dev2@nebula.test'],
      },
    })
    assert.equal(mlRes.status, 201)

    const filterRes = await root.request('/api/mail/filters', {
      method: 'POST',
      body: {
        accountId: account.id,
        scope: 'mailbox',
        mailbox: 'founder@nebula.test',
        name: 'Route Invoices',
        conditions: [{ field: 'subject', comparator: 'contains', value: 'Invoice' }],
        actions: [{ type: 'fileinto', target: 'Billing' }],
      },
    })
    assert.equal(filterRes.status, 201)
    const filterBody = (await filterRes.json()) as { compiledSieve: string }
    assert.match(filterBody.compiledSieve, /fileinto :create "Billing"/)

    const spamRes = await root.request('/api/mail/spam-settings', {
      method: 'PUT',
      body: {
        rejectScore: 12.5,
        spamBoxEnabled: true,
        allowlist: ['partner@trusted.test'],
      },
    })
    assert.equal(spamRes.status, 200)

    const csvRes = await root.request('/api/mail/import-csv', {
      method: 'POST',
      body: {
        accountId: account.id,
        csv: [
          'email,password_or_target,quota_mb',
          'support@nebula.test,SupportPass!2026,2048',
          'billing@nebula.test,BillingPass!2026,1024',
          'info@nebula.test,support@nebula.test',
        ].join('\n'),
      },
    })
    assert.equal(csvRes.status, 200)
    const csvBody = (await csvRes.json()) as {
      summary: { mailboxesImported: number; forwardersImported: number; errorCount: number }
    }
    assert.equal(csvBody.summary.mailboxesImported, 2)
    assert.equal(csvBody.summary.forwardersImported, 1)
    assert.equal(csvBody.summary.errorCount, 0)

    // Calendars and contacts connect through the per-account Radicale behind the edge; the saved URL record is gone.
    assert.equal((await root.request('/api/mail/caldav-carddav', { method: 'PUT', body: { enabled: true } })).status, 404)

    // ---- Step C: xMail Webmail Deep Endpoints (/api/webmail/*) ----
    const idRes = await root.request('/api/webmail/identities', {
      method: 'POST',
      body: {
        mailbox: 'support@nebula.test',
        email: 'support@nebula.test',
        displayName: 'Nebula Support Desk',
        htmlSignature: '<p><strong>Nebula Support</strong> — 24/7 SLA</p>',
        textSignature: 'Nebula Support - 24/7 SLA',
      },
    })
    assert.equal(idRes.status, 201)
    const identityId = ((await idRes.json()) as { identity: { id: string } }).identity.id

    const msgRes = await root.request('/api/webmail/messages', {
      method: 'POST',
      body: {
        from: 'support@nebula.test',
        to: ['billing@nebula.test'],
        subject: 'Q4 Infrastructure Renewal Proposal',
        textBody: 'Attached is the Q4 NVMe cluster renewal quote.',
        attachments: [{ filename: 'q4-quote.pdf', contentType: 'application/pdf', sizeBytes: 48120 }],
        identityId,
      },
    })
    // No SMTP or IMAP stands behind the JSON store, so it refuses instead of copying the message into recipients' INBOX.
    assert.equal(msgRes.status, 412)
    const msgRefusal = (await msgRes.json()) as { code: string; details: unknown }
    assert.equal(msgRefusal.code, 'PRECONDITION_FAILED')
    assert.deepEqual(msgRefusal.details, { reason: 'mailbox_submission_required', stateChanged: false })
    assert.deepEqual(await new ExtendedFeaturesStore(serverHandle.store.rootDir).readOrDefault('webmail/messages.json', []), [])
    await new ExtendedFeaturesStore(serverHandle.store.rootDir).write('webmail/messages.json', [{
      id: '33333333-3333-4333-8333-333333333333', mailbox: 'support@nebula.test', folder: 'Sent', from: 'support@nebula.test', to: ['billing@nebula.test'], cc: [], bcc: [],
      subject: 'Q4 Infrastructure Renewal Proposal', textBody: 'Attached is the Q4 NVMe cluster renewal quote.', htmlBody: '',
      attachments: [{ filename: 'q4-quote.pdf', contentType: 'application/pdf', sizeBytes: 48120 }], identityId, read: true, starred: false, sentAt: '2026-10-01T09:10:11.123Z',
    }])

    const searchRes = await root.request('/api/webmail/search?q=q4-quote.pdf&mailbox=support%40nebula.test')
    assert.equal(searchRes.status, 200)
    const searchBody = (await searchRes.json()) as { total: number; hits: { subject: string }[] }
    assert.ok(searchBody.total >= 1)
    assert.equal(searchBody.hits[0]?.subject, 'Q4 Infrastructure Renewal Proposal')

    // Delivery evidence comes only from the parsed Postfix journal (/api/server/mail-log/delivery); no invented report route remains.
    assert.equal((await root.request('/api/mail/delivery-reports?status=delivered')).status, 404)

    const vacRes = await root.request('/api/webmail/vacation', {
      method: 'PUT',
      body: {
        mailbox: 'support@nebula.test',
        enabled: true,
        subject: 'Away at CloudConf',
        body: 'Our team will reply within 4 hours.',
        replyIntervalHours: 48,
      },
    })
    assert.equal(vacRes.status, 200)
    const vacBody = (await vacRes.json()) as { vacation: { compiledSieve: string } }
    assert.match(vacBody.vacation.compiledSieve, /vacation :days 2/)

    const calRes = await root.request('/api/webmail/calendars', {
      method: 'POST',
      body: { owner: 'support@nebula.test', name: 'On-Call Rotation', timezone: 'UTC' },
    })
    assert.equal(calRes.status, 201)
    const calId = ((await calRes.json()) as { calendar: { id: string } }).calendar.id

    const shareRes = await root.request(`/api/webmail/calendars/${calId}/share?mailbox=support%40nebula.test`, {
      method: 'POST',
      body: { principal: 'billing@nebula.test', permission: 'read-write' },
    })
    assert.equal(shareRes.status, 200)
    const shareBody = (await shareRes.json()) as {
      calendar: { shares: { principal: string; permission: string }[] }
    }
    assert.equal(shareBody.calendar.shares[0]?.permission, 'read-write')

    const contactRes = await root.request('/api/webmail/contacts', {
      method: 'POST',
      body: {
        owner: 'support@nebula.test',
        fullName: 'Layla Hassan',
        email: 'layla@nebula.test',
        phone: '+971500000000',
        organization: 'Nebula Corp',
      },
    })
    assert.equal(contactRes.status, 201)
    const contactBody = (await contactRes.json()) as { contact: { vcard: string } }
    assert.match(contactBody.contact.vcard, /BEGIN:VCARD/)

    // ---- Step D: Operational DNS (/api/dns/*) ----
    const tplApplyRes = await root.request('/api/dns/templates/apply', {
      method: 'POST',
      body: {
        template: 'standard',
        domain: 'nebula.test',
        ipv4: '203.0.113.10',
        accountId: account.id,
      },
    })
    assert.equal(tplApplyRes.status, 200)

    const batchAuthRes = await root.request('/api/dns/email-auth/batch', {
      method: 'POST',
      body: { ipv4: '203.0.113.10' },
    })
    assert.equal(batchAuthRes.status, 200)
    const batchAuthBody = (await batchAuthRes.json()) as {
      count: number
      provisioned: { domain: string; spf: string; dkim: string; dmarc: string }[]
    }
    assert.ok(batchAuthBody.count >= 1)
    assert.match(batchAuthBody.provisioned[0]!.dkim, /^v=DKIM1;/)
    assert.match(batchAuthBody.provisioned[0]!.dmarc, /^v=DMARC1;/)

    // Root can create a standalone zone; cleanup then removes the unregistered legacy zone.
    const orphanZone = await root.request('/api/dns/zones/orphan-legacy.test', {
      method: 'PUT', body: { records: [] },
    })
    assert.equal(orphanZone.status, 200, await orphanZone.clone().text())
    const cleanupRes = await root.request('/api/dns/cleanup', {
      method: 'POST',
      body: { dryRun: false },
    })
    assert.equal(cleanupRes.status, 200)
    const cleanupBody = (await cleanupRes.json()) as { removedZones: string[]; keptZones: string[] }
    assert.ok(cleanupBody.removedZones.includes('orphan-legacy.test'))
    assert.ok(cleanupBody.keptZones.includes('nebula.test'))

    // ---- Step E: Backups, Single-File Granular Restore, Transfers & cPanel Import ----
    const destRes = await root.request('/api/backups/destinations', {
      method: 'POST',
      body: {
        name: 'Primary AWS S3 Vault',
        kind: 's3',
        endpoint: 'https://s3.eu-central-1.amazonaws.com',
        bucket: 'xpanel-vault-prod',
        region: 'eu-central-1',
      },
    })
    assert.equal(destRes.status, 201)
    const destId = ((await destRes.json()) as { destination: { id: string } }).destination.id

    const scheduleBeforeRes = await root.request('/api/backups/schedule')
    assert.equal(scheduleBeforeRes.status, 200)
    const scheduleBefore = await scheduleBeforeRes.json()
    const requestedSchedule = {
      enabled: true,
      frequency: 'daily',
      retentionCount: 14,
      destinationIds: [destId],
    }
    const enabledScheduleRes = await root.request('/api/backups/schedule', {
      method: 'PUT', body: requestedSchedule,
    })
    assert.equal(enabledScheduleRes.status, 422)
    const scheduleAfterRefusalRes = await root.request('/api/backups/schedule')
    assert.equal(scheduleAfterRefusalRes.status, 200)
    assert.deepEqual(await scheduleAfterRefusalRes.json(), scheduleBefore)
    const schedRes = await root.request('/api/backups/schedule', {
      method: 'PUT', body: { ...requestedSchedule, enabled: false },
    })
    assert.equal(schedRes.status, 200)
    const savedSchedule = await schedRes.json() as { schedule: typeof requestedSchedule }
    assert.deepEqual(savedSchedule.schedule.destinationIds, requestedSchedule.destinationIds)
    assert.equal(savedSchedule.schedule.enabled, false)
    assert.equal(savedSchedule.schedule.frequency, requestedSchedule.frequency)
    assert.equal(savedSchedule.schedule.retentionCount, requestedSchedule.retentionCount)

    // This fixture has no confined file runner; snapshot metadata is not a filesystem backup proof.
    const writeOrig = await root.request('/api/accounts/nebula/files', {
      method: 'POST',
      body: {
        op: 'write',
        path: 'domains/nebula.test/public_html/config.php',
        content: '<?php return ["env" => "production", "version" => "1.0.0"];\n',
      },
    })
    assert.equal(writeOrig.status, 412)

    const snapRes = await root.request('/api/backups/snapshots', {
      method: 'POST',
      body: {
        accountId: account.id,
        destinationId: destId,
        files: [
          {
            path: 'domains/nebula.test/public_html/config.php',
            content: '<?php return ["env" => "production", "version" => "1.0.0"];\n',
          },
        ],
      },
    })
    assert.equal(snapRes.status, 201)
    const snapshotId = ((await snapRes.json()) as { snapshot: { id: string } }).snapshot.id

    // A second write is also refused without a confined runner.
    const overwrite = await root.request('/api/accounts/nebula/files', {
      method: 'POST',
      body: {
        op: 'write',
        path: 'domains/nebula.test/public_html/config.php',
        content: 'CORRUPTED_FILE',
      },
    })

    assert.equal(overwrite.status, 412)

    // Restore cannot write through the API process when its confined port is unavailable.
    const restoreRes = await root.request(`/api/backups/snapshots/${snapshotId}/restore-file`, {
      method: 'POST',
      body: { path: 'domains/nebula.test/public_html/config.php' },
    })
    assert.equal(restoreRes.status, 412)
    assert.equal((await restoreRes.json() as { code: string }).code, 'PRECONDITION_FAILED')

    // No physical file was created or restored, and reads still require the confined port.
    const readRestored = await root.request('/api/accounts/nebula/files', {
      method: 'POST',
      body: { op: 'read', path: 'domains/nebula.test/public_html/config.php' },
    })
    assert.equal(readRestored.status, 412)
    await assert.rejects(access(join(tmpDir, 'host', 'nebula', 'domains', 'nebula.test', 'public_html', 'config.php')), { code: 'ENOENT' })

    // cPanel archive import
    const cpImportRes = await root.request('/api/lifecycle/cpanel-import', {
      method: 'POST',
      body: {
        archiveName: 'cpmove-legacyshop.tar.gz',
        username: 'legacyshop',
        password: 'LegacyShopPassword!2026',
        primaryDomain: 'legacyshop.test',
        planId,
      },
    })
    // Import is refused until archive custody and a qualified adapter exist; it never synthesizes an account.
    assert.equal(cpImportRes.status, 412)
    const cpImport = (await cpImportRes.json()) as { code: string; details: unknown }
    assert.equal(cpImport.code, 'PRECONDITION_FAILED')
    assert.deepEqual(cpImport.details, { stateChanged: false, nativeApplied: false })
    assert.equal(await serverHandle.store.getAccountByUsername('legacyshop'), null)

    // ---- Step F: Extended File Isolation & Web Extras ----
    // Directory privacy lives in the account files; without the confined account file runner nothing is read or claimed.
    const dirPrivRes = await root.request(`/api/web-features/${account.id}/directory-privacy`)
    assert.equal(dirPrivRes.status, 412)
    assert.equal(((await dirPrivRes.json()) as { code: string }).code, 'PRECONDITION_FAILED')

    // Hotlink Protection is the domain .htaccess block of /api/domains/:id/web-directives/hotlink; the record-only route is gone.
    assert.equal((await root.request(`/api/web-features/${account.id}/hotlink-protection`, { method: 'PUT', body: { enabled: true } })).status, 404)

    // Web Disk logins are User Manager users served by lighttpd as the account; the compiled nginx alias record is gone.
    assert.equal((await root.request(`/api/web-features/${account.id}/web-disk`, { method: 'PUT', body: { enabled: true } })).status, 404)

    const extrasRes = await root.request(`/api/web-features/${account.id}/extras`, {
      method: 'PUT',
      body: {
        errorPages: { '404': '/errors/404.html', '500': '/errors/500.html' },
        deniedCidrs: ['198.51.100.0/24'],
        directoryIndexMode: 'disabled',
      },
    })
    assert.equal(extrasRes.status, 200)

    // Git runs only through the agent-backed /api/account/git and /api/server/software/deployments; the record-only registry is gone.
    assert.equal((await root.request(`/api/git/${account.id}/repos`, { method: 'POST', body: { name: 'storefront' } })).status, 404)
    assert.equal((await root.request(`/api/git/${account.id}/repos/storefront/deploy`, { method: 'POST', body: { commitSha: 'a1b2c3d4e5f6' } })).status, 404)

    // ---- Step G: Database remote hosts, maintenance & private per-account cache ----
    // The metadata-only PostgreSQL and MongoDB routes are gone; PostgreSQL lives under /api/account/database-engines/postgresql.
    for (const path of ['/api/databases/postgres', '/api/databases/postgres/users', '/api/databases/mongo']) {
      assert.equal((await root.request(path, { method: 'POST', body: { accountId: account.id, name: 'analytics' } })).status, 404)
    }

    const remoteHostRes = await root.request(`/api/databases/${account.id}/remote-hosts`, {
      method: 'PUT',
      body: {
        hosts: [{ address: '198.51.100.25', engine: 'both', comment: 'BI Worker Node' }],
      },
    })
    assert.equal(remoteHostRes.status, 200)
    const remoteHostBody = (await remoteHostRes.json()) as {
      config: { compiledPgHba: string; compiledMariaDbGrants: string }
    }
    assert.match(remoteHostBody.config.compiledPgHba, /198\.51\.100\.25\/32 scram-sha-256/)
    assert.match(remoteHostBody.config.compiledMariaDbGrants, /'nebula'@'198\.51\.100\.25'/)

    const maintRes = await root.request(`/api/databases/${account.id}/maintenance`, {
      method: 'POST',
      body: { engine: 'postgresql', database: 'nebula_analytics', operation: 'optimize' },
    })
    // Nothing runs the maintenance statements yet, so the route refuses instead of reporting processed tables.
    assert.equal(maintRes.status, 412)
    const maintBody = (await maintRes.json()) as { code: string; details: unknown }
    assert.equal(maintBody.code, 'PRECONDITION_FAILED')
    assert.deepEqual(maintBody.details, { reason: 'database_maintenance_unavailable', stateChanged: false, nativeApplied: false })

    // Cache and container views project the saved runtime registry; only the owner's runtime route changes it.
    await atomicWriteJson(runtimeRegistryPath(serverHandle.store.rootDir, account.id), { apps: [], cache: { redis: { enabled: true, memoryMb: 64, binary: '/usr/bin/redis-server', updatedAt: '2026-10-29T00:00:00.000Z' }, memcached: null },
      containers: [{ name: 'search', image: 'docker.io/getmeili/meilisearch:v1.11', env: { MEILI_ENV: 'production' }, enabled: true, updatedAt: '2026-10-29T00:00:00.000Z' }] }, 0o600)
    const cacheRes = await root.request(`/api/cache/${account.id}`)
    assert.equal(cacheRes.status, 200)
    const cacheBody = (await cacheRes.json()) as { cache: { slice: string; redis: { socketPath: string; enabled: boolean; maxMemoryMb: number }; memcached: { socketPath: string; enabled: boolean } } }
    assert.equal(cacheBody.cache.slice, `xpanel-${account.uid}.slice`)
    assert.deepEqual([cacheBody.cache.redis.enabled, cacheBody.cache.redis.maxMemoryMb, cacheBody.cache.memcached.enabled], [true, 64, false])
    assert.equal(cacheBody.cache.redis.socketPath, `/home/${account.username}/.xpanel-cache/redis.sock`)
    assert.equal(cacheBody.cache.memcached.socketPath, `/home/${account.username}/.xpanel-cache/memcached.sock`)
    assert.equal((await root.request(`/api/cache/${account.id}`, { method: 'PUT', body: { redis: { enabled: false } } })).status, 405)

    // ---- Step H: Containers, 1-Click Apps + Staging, Cluster, Branding, Languages, WHMCS ----
    // The invented fine-settings store is gone: nothing answers there.
    assert.equal((await root.request('/api/server/fine-settings')).status, 404)

    const containerRes = await root.request(`/api/containers/${account.id}`)
    assert.equal(containerRes.status, 200)
    const containerBody = (await containerRes.json()) as { containers: { name: string; slice: string; systemdUnit: string; publishedPorts: unknown[]; envKeys: string[] }[] }
    assert.deepEqual(containerBody.containers.map(c => [c.name, c.slice, c.systemdUnit, c.publishedPorts, c.envKeys]), [['search', `xpanel-${account.uid}.slice`, `xpanel-ctr-${account.username}-search.service`, [], ['MEILI_ENV']]])
    assert.equal((await root.request(`/api/containers/${account.id}`, { method: 'POST', body: { name: 'x', image: 'docker.io/library/redis:7' } })).status, 405)

    const storedAccount = await serverHandle.store.getAccount(account.id)
    assert.ok(storedAccount)
    const appMetadata = new ExtendedFeaturesStore(serverHandle.store.rootDir)
    const savedAt = '2026-10-01T09:10:11.123Z'
    const storedProduction: InstalledAppRecord = {
      id: '11111111-1111-4111-8111-111111111111', accountId: account.id,
      appType: 'wordpress', domain: 'nebula.test', path: '/',
      docRoot: `${storedAccount.home}/domains/nebula.test/public_html`,
      title: 'Stored application metadata', adminUser: 'storedadmin', adminEmail: 'owner@nebula.test',
      version: '6.7.2-stored', databaseName: 'nebula_stored', environment: 'production', parentAppId: null,
      createdAt: savedAt, updatedAt: savedAt,
    }
    const storedStaging: InstalledAppRecord = {
      ...storedProduction, id: '22222222-2222-4222-8222-222222222222',
      domain: 'staging.nebula.test', path: '/staging', docRoot: `${storedAccount.home}/domains/staging.nebula.test/public_html`,
      version: '6.8.0-stored', databaseName: 'nebula_stored_stg', environment: 'staging', parentAppId: storedProduction.id,
    }
    const storedApps = [storedProduction, storedStaging]
    await appMetadata.write(`apps/${account.id}.json`, storedApps)
    const appListBefore = await root.request(`/api/apps/${account.id}`)
    assert.equal(appListBefore.status, 200)
    assert.deepEqual(await appListBefore.json(), { apps: storedApps })
    const appMutations = [
      { path: `/api/apps/${account.id}`, method: 'POST', body: { appType: 'wordpress', domain: 'nebula.test', title: 'Requested application' } },
      { path: `/api/apps/${account.id}/${storedProduction.id}/staging-clone`, method: 'POST', body: { stagingDomain: 'staging.nebula.test' } },
      { path: `/api/apps/${account.id}/${storedStaging.id}/staging-push`, method: 'POST', body: {} },
      { path: `/api/apps/${account.id}/${storedProduction.id}`, method: 'DELETE', body: {} },
    ]
    for (const mutation of appMutations) {
      const response = await root.request(mutation.path, { method: mutation.method, body: mutation.body })
      assert.equal(response.status, 412)
      const refusal = await response.json() as { code: string; details: { reason: string; stateChanged: boolean; nativeApplied: boolean } }
      assert.equal(refusal.code, 'PRECONDITION_FAILED')
      assert.deepEqual(refusal.details, { reason: 'application_route_replaced', stateChanged: false, nativeApplied: false })
    }
    const appListAfter = await root.request(`/api/apps/${account.id}`)
    assert.equal(appListAfter.status, 200)
    assert.deepEqual(await appListAfter.json(), { apps: storedApps })

    // No cluster membership or log-built statistics exist behind these paths, so they are not served at all.
    assert.equal((await root.request('/api/cluster/nodes', { method: 'POST', body: { name: 'eu-dns-01', hostname: 'ns2.xpanel.test', ipv4: '203.0.113.55', role: 'dns' } })).status, 404)
    assert.equal((await root.request('/api/analytics/legacy/nebula.test')).status, 404)

    // Verify audit log captured all major extended operations
    const audits = await listAudit(serverHandle.db, { limit: 200 })
    const actions = new Set(audits.map((a) => a.action))
    assert.ok(actions.has('setup.wizard.completed'))
    assert.ok(actions.has('server.hostname_change'))
    assert.equal(audits.some(entry => entry.action === 'server.quota_init' && entry.outcome === 'ok'), false, 'Unavailable quota initialization must not produce a success audit')
    assert.ok(actions.has('mail.domain_forwarder.created'))
    assert.ok(actions.has('mail.filter.created'))
    assert.ok(actions.has('mail.import_csv'))
    assert.ok(!actions.has('webmail.message.sent'))
    assert.ok(actions.has('dns.email_auth.batch_provisioned'))
    assert.ok(!audits.some(a => a.action === 'backup.snapshot.restore_file' && a.outcome === 'ok'))
    assert.ok(!actions.has('git.repo.deployed') && !actions.has('database.maintenance.optimize') && !actions.has('cluster.node.added'))
    assert.ok(!actions.has('cache.updated') && !actions.has('container.created'))
    assert.ok(!actions.has('app.installed'))
    assert.ok(!actions.has('app.staging.cloned'))
    assert.ok(!actions.has('app.staging.pushed'))
  })
})
