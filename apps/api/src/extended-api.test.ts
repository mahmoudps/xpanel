import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { createAgentApp, FakeHostExecutor, HostReconciler } from '@xpanel/agent'
import { createDb, createRootPrincipal, createUserPrincipal, listAudit, migrate } from '@xpanel/db'
import { defaultPlan } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { StateStore } from '@xpanel/state'
import { CSRF_HEADER_NAME, hashPasswordArgon2id, parseCookies, SESSION_COOKIE_NAME } from './auth.ts'
import { startPanelServer } from './main.ts'
import * as mailDocuments from './mail/document.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

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

describe('@xpanel/api extended HTTP contracts with explicit fake host execution', () => {
  let tmpDir: string
  let serverHandle: Extract<Awaited<ReturnType<typeof startPanelServer>>, { quarantined: false }>
  let baseUrl: string
  let agentDb: ReturnType<typeof createDb>
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xpanel-ext-e2e-'))
    const dbPath = join(tmpDir, 'control.db')
    const stateDir = join(tmpDir, 'state')
    const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble')
    agentDb = createDb(dbPath)
    await migrate(agentDb.runner)
    await createRootPrincipal(agentDb.db, { username: 'root', passwordHash: await hashPasswordArgon2id('RootPassword!2026'), forcePasswordChange: false })
    const store = new StateStore(stateDir)
    const executor = new FakeHostExecutor()
    const reconciler = new HostReconciler({ db: agentDb.db, store, executor, os })
    const agentApp = createAgentApp({
      db: agentDb.db, store, executor, reconciler, agentToken: TEST_AGENT_TOKEN,
      os: { id: os.id, versionId: os.versionId, family: os.family },
      homeBaseDir: join(tmpDir, 'host'),
    })
    const started = await startPanelServer({
      port: 0,
      host: '127.0.0.1',
      dbPath,
      stateDir,
      homeBaseDir: join(tmpDir, 'host'),
      rootPassword: 'RootPassword!2026',
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
    assert.match(loginHtml, /id="xpanel-design-tokens"/)
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
    assert.doesNotMatch(whmHtml, /<form\b|data-cmdk-item="/)
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
      assert.doesNotMatch(html, /data-tool-availability="unverified"|data-board-port="xpanel-home"/)
      assert.doesNotMatch(html, /<(?:div|section|main)\b[^>]*data-mail-layout=/)
    }

    const featureList = await serverHandle.store.createFeatureList({ name: 'Document features', ownerId: null, disabled: [] })
    const { id: _seedId, ...planInput } = defaultPlan({ name: 'Document plan', featureListId: featureList.id })
    const plan = await serverHandle.store.createPlan(planInput)
    const password = 'DocumentOwnerPassword!2026'
    const passwordHash = await hashPasswordArgon2id(password)
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
        assert.match(homeHtml, /data-board-port="xpanel-home"/)
        assert.ok(homeHtml.includes(account.primaryDomain))
        assert.ok(homeHtml.includes(plan.name))
        for (const path of ['/panel/domains', '/mail']) {
          const document = await owner.request(`${path}?lang=${locale}&theme=light`)
          assert.equal(document.status, 200)
          assert.match(document.headers.get('content-type') ?? '', /text\/html/)
          const html = await document.text()
          assert.ok(html.includes(`lang="${locale}"`))
          assert.ok(html.includes(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`))
          assert.match(html, /data-theme="light"/)
          assert.ok(html.includes(`data-surface="${path === '/mail' ? 'xmail' : 'xpanel'}"`))
          assert.match(html, /data-tool-availability="unverified"/)
          assert.match(html, /disabled data-wiring="soon"/)
          assert.match(html, /<html\b[^>]*data-realtime-enabled="false"/)
          assert.doesNotMatch(html, /data-status-page="404"|data-board-port="xpanel-home"/)
          assert.doesNotMatch(html, /<(?:div|section|main)\b[^>]*data-mail-layout=/)
          for (const value of [account.id, plan.id, featureList.id, user.id, account.home, account.ipv4, account.contactEmail, password, passwordHash]) assert.ok(!html.includes(value), 'Unqualified documents must not expose full account or authentication data')
          if (path === '/panel/domains') {
            assert.ok(html.includes(account.primaryDomain))
            assert.ok(html.includes(plan.name))
          }
          assert.equal(snapshotReads, 0, 'Unqualified documents do not hydrate a full hosting snapshot')
          assert.equal(mailRead.mock.calls.length, 0, 'Unqualified mail documents do not enter the provider-backed mail loader')
        }
      }
    } finally { serverHandle.store.readSnapshot = readSnapshot; mailRead.mockRestore() }
  })

  it('2. Stored extended feature HTTP contracts and generated configuration with fake host execution', async () => {
    const root = await loginOverHttp('root', 'RootPassword!2026')

    // ---- Step A: First-Run Setup Wizard, Hostname Change & Disk Quota Init ----
    const wizGet = await root.request('/api/setup/wizard')
    assert.equal(wizGet.status, 200)
    const wizInitData = (await wizGet.json()) as { setupComplete: boolean }
    assert.equal(wizInitData.setupComplete, false)

    const wizPost = await root.request('/api/setup/wizard', {
      method: 'POST',
      body: {
        hostname: 'whm.xpanel.test',
        nameservers: ['ns1.xpanel.test', 'ns2.xpanel.test'],
        contactEmail: 'noc@xpanel.test',
        engine: 'apache',
        apacheMpm: 'itk',
        primaryIpv4: '203.0.113.10',
        primaryIpv6: '2001:db8::10',
        quotaFilesystem: '/home',
        initQuotas: true,
      },
    })
    assert.equal(wizPost.status, 200)
    const wizPostBody = (await wizPost.json()) as {
      ok: boolean
      setupComplete: boolean
      quotaInitialized: boolean
      settings: { hostname: string }
    }
    assert.equal(wizPostBody.ok, true)
    assert.equal(wizPostBody.setupComplete, true)
    assert.equal(wizPostBody.quotaInitialized, true)
    assert.equal(wizPostBody.settings.hostname, 'whm.xpanel.test')

    // Change hostname
    const hostRes = await root.request('/api/server/hostname', {
      method: 'POST',
      body: { hostname: 'edge01.xpanel.test' },
    })
    assert.equal(hostRes.status, 200)
    const hostBody = (await hostRes.json()) as {
      ok: boolean
      hostname: string
      previousHostname: string
      files: { path: string; content: string }[]
    }
    assert.equal(hostBody.hostname, 'edge01.xpanel.test')
    assert.equal(hostBody.previousHostname, 'whm.xpanel.test')
    assert.ok(hostBody.files.some((f) => f.path === '/etc/hostname' && f.content.includes('edge01.xpanel.test')))

    // Initialize filesystem quotas
    const quotaRes = await root.request('/api/server/quotas/init', {
      method: 'POST',
      body: { filesystem: '/home' },
    })
    assert.equal(quotaRes.status, 200)
    const quotaBody = (await quotaRes.json()) as { ok: boolean; status: string; commands: string[][] }
    assert.equal(quotaBody.ok, true)
    assert.equal(quotaBody.status, 'enabled')
    assert.equal(quotaBody.commands.length, 2)

    // Create a plan and hosting account for tenant-scoped features
    const planRes = await root.request('/api/plans', {
      method: 'POST',
      body: { name: 'Enterprise NVMe' },
    })
    assert.equal(planRes.status, 201)
    const planId = ((await planRes.json()) as { plan: { id: string } }).plan.id

    const accRes = await root.request('/api/accounts', {
      method: 'POST',
      body: {
        username: 'nebula',
        primaryDomain: 'nebula.test',
        planId,
        password: 'NebulaPassword!2026',
      },
    })
    assert.equal(accRes.status, 201)
    const account = ((await accRes.json()) as { account: { id: string; username: string; uid: number } }).account

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
    const domFwdBody = (await domFwdRes.json()) as { compiledVirtualMap: string }
    assert.match(domFwdBody.compiledVirtualMap, /@nebula-old\.test @nebula\.test/)

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
        action: { type: 'fileinto', target: 'Billing' },
      },
    })
    assert.equal(filterRes.status, 201)
    const filterBody = (await filterRes.json()) as { compiledSieve: string }
    assert.match(filterBody.compiledSieve, /fileinto "Billing"/)

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

    const davRes = await root.request('/api/mail/caldav-carddav', {
      method: 'PUT',
      body: { enabled: true, autodiscoverSrv: true },
    })
    assert.equal(davRes.status, 200)

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
    assert.equal(msgRes.status, 201)

    const searchRes = await root.request('/api/webmail/search?q=q4-quote.pdf&mailbox=support%40nebula.test')
    assert.equal(searchRes.status, 200)
    const searchBody = (await searchRes.json()) as { total: number; hits: { subject: string }[] }
    assert.ok(searchBody.total >= 1)
    assert.equal(searchBody.hits[0]?.subject, 'Q4 Infrastructure Renewal Proposal')

    // Delivery report was automatically recorded for the sent webmail message
    const delivRes = await root.request('/api/mail/delivery-reports?status=delivered')
    assert.equal(delivRes.status, 200)
    const delivBody = (await delivRes.json()) as { total: number }
    assert.ok(delivBody.total >= 1)

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

    const shareRes = await root.request(`/api/webmail/calendars/${calId}/share`, {
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

    const dnsClusterRes = await root.request('/api/dns/cluster', {
      method: 'PUT',
      body: {
        enabled: true,
        provider: 'cloudflare',
        cloudflareZoneMap: { 'nebula.test': 'cf-zone-998877' },
      },
    })
    assert.equal(dnsClusterRes.status, 200)

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

    const schedRes = await root.request('/api/backups/schedule', {
      method: 'PUT',
      body: {
        enabled: true,
        frequency: 'daily',
        retentionCount: 14,
        destinationIds: [destId],
      },
    })
    assert.equal(schedRes.status, 200)

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
    assert.equal(cpImportRes.status, 201)

    // ---- Step F: Extended File Isolation & Web Extras + Git Push-to-Deploy ----
    const dirPrivRes = await root.request(`/api/web-features/${account.id}/directory-privacy`, {
      method: 'PUT',
      body: {
        rules: [
          {
            path: '/admin',
            authName: 'Nebula Admin Area',
            users: [{ username: 'ops', password: 'OpsSecret!2026' }],
          },
        ],
      },
    })
    assert.equal(dirPrivRes.status, 200)
    const dirPrivBody = (await dirPrivRes.json()) as {
      config: { compiledNginx: string; rules: { users: Record<string, unknown>[] }[] }
    }
    assert.match(dirPrivBody.config.compiledNginx, /auth_basic "Nebula Admin Area"/)
    assert.ok(!('compiledHtpasswd' in dirPrivBody.config))
    assert.ok(dirPrivBody.config.rules.every(rule => rule.users.every(user => !('passwordHash' in user))))

    const hotlinkRes = await root.request(`/api/web-features/${account.id}/hotlink-protection`, {
      method: 'PUT',
      body: {
        enabled: true,
        allowedUrls: ['nebula.test', 'cdn.nebula.test'],
        protectedExtensions: ['jpg', 'png', 'webp'],
      },
    })
    assert.equal(hotlinkRes.status, 200)
    const hotlinkBody = (await hotlinkRes.json()) as { config: { compiledNginx: string } }
    assert.match(hotlinkBody.config.compiledNginx, /valid_referers/)

    const webDiskRes = await root.request(`/api/web-features/${account.id}/web-disk`, {
      method: 'PUT',
      body: { enabled: true, rootPath: 'public_html', readOnly: false },
    })
    assert.equal(webDiskRes.status, 200)
    const webDiskBody = (await webDiskRes.json()) as { config: { compiledConfig: string } }
    assert.match(webDiskBody.config.compiledConfig, /dav_ext_methods PROPFIND OPTIONS/)

    const extrasRes = await root.request(`/api/web-features/${account.id}/extras`, {
      method: 'PUT',
      body: {
        errorPages: { '404': '/errors/404.html', '500': '/errors/500.html' },
        deniedCidrs: ['198.51.100.0/24'],
        directoryIndexMode: 'disabled',
      },
    })
    assert.equal(extrasRes.status, 200)

    const gitCreateRes = await root.request(`/api/git/${account.id}/repos`, {
      method: 'POST',
      body: {
        name: 'storefront',
        branch: 'main',
        remoteUrl: 'https://github.com/nebula/storefront.git',
      },
    })
    assert.equal(gitCreateRes.status, 201)
    const repoId = ((await gitCreateRes.json()) as { repo: { id: string } }).repo.id

    const gitDeployRes = await root.request(`/api/git/${account.id}/repos/${repoId}/deploy`, {
      method: 'POST',
      body: { commitSha: 'a1b2c3d4e5f6' },
    })
    assert.equal(gitDeployRes.status, 200)
    const gitDeployBody = (await gitDeployRes.json()) as {
      deployment: { commitSha: string; releaseDir: string; status: string }
    }
    assert.equal(gitDeployBody.deployment.commitSha, 'a1b2c3d4e5f6')
    assert.equal(gitDeployBody.deployment.status, 'deployed')

    // ---- Step G: Databases Beyond MariaDB & Private Per-Account Cache ----
    const pgDbRes = await root.request('/api/databases/postgres', {
      method: 'POST',
      body: { accountId: account.id, name: 'analytics', extensions: ['pg_stat_statements'] },
    })
    assert.equal(pgDbRes.status, 201)
    const pgDbBody = (await pgDbRes.json()) as { database: { id: string; name: string; compiledSql: string } }
    assert.equal(pgDbBody.database.name, 'nebula_analytics')
    assert.match(pgDbBody.database.compiledSql, /CREATE DATABASE "nebula_analytics"/)

    const pgUserRes = await root.request('/api/databases/postgres/users', {
      method: 'POST',
      body: { accountId: account.id, username: 'reporter', password: 'ReporterPassword!2026', databaseIds: [pgDbBody.database.id] },
    })
    assert.equal(pgUserRes.status, 201)
    const pgUserBody = (await pgUserRes.json()) as { user: { username: string } }
    assert.equal(pgUserBody.user.username, 'nebula_reporter')
    assert.ok(!('scramHash' in pgUserBody.user))
    assert.ok(!('compiledSql' in pgUserBody.user))

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
    assert.equal(maintRes.status, 200)
    const maintBody = (await maintRes.json()) as { status: string }
    assert.equal(maintBody.status, 'healthy')

    const mongoRes = await root.request('/api/databases/mongo', {
      method: 'POST',
      body: { accountId: account.id, name: 'events' },
    })
    assert.equal(mongoRes.status, 201)

    const cacheRes = await root.request(`/api/cache/${account.id}`, {
      method: 'PUT',
      body: {
        redis: { enabled: true, maxMemoryMb: 256 },
        memcached: { enabled: true, maxMemoryMb: 128 },
      },
    })
    assert.equal(cacheRes.status, 200)
    const cacheBody = (await cacheRes.json()) as {
      cache: { slice: string; redis: { socketPath: string; enabled: boolean } }
    }
    assert.equal(cacheBody.cache.slice, `xpanel-${account.uid}.slice`)
    assert.equal(cacheBody.cache.redis.enabled, true)
    assert.equal(cacheBody.cache.redis.socketPath, '/run/xpanel/cache/nebula/redis.sock')

    // ---- Step H: Server Fine Settings, Containers, 1-Click Apps + Staging, Cluster, Branding, Languages, WHMCS ----
    const fineRes = await root.request('/api/server/fine-settings', {
      method: 'PUT',
      body: {
        limits: { maxMemoryPerProcessMb: 2048, maxProcessesPerAccount: 128, oomScoreAdj: 150 },
        logRotation: { frequency: 'daily', retainDays: 30, compress: true, maxSizeMb: 200 },
        mta: {
          maxQueueLifetimeHours: 48,
          maxMessageSizeMb: 75,
          smarthost: { enabled: true, host: 'relay.mailchannels.net', port: 587, username: 'xpanel' },
          rbls: ['zen.spamhaus.org'],
        },
      },
    })
    assert.equal(fineRes.status, 200)
    const fineBody = (await fineRes.json()) as {
      settings: { mta: { compiledPostfixMainCf: string }; logRotation: { compiledLogrotateConf: string } }
    }
    assert.match(fineBody.settings.mta.compiledPostfixMainCf, /relay\.mailchannels\.net/)
    assert.match(fineBody.settings.logRotation.compiledLogrotateConf, /rotate 30/)

    const containerRes = await root.request(`/api/containers/${account.id}`, {
      method: 'POST',
      body: {
        name: 'meilisearch',
        image: 'getmeili/meilisearch:v1.11',
        runtime: 'podman',
        internalPort: 7700,
      },
    })
    assert.equal(containerRes.status, 201)
    const containerBody = (await containerRes.json()) as {
      container: { slice: string; systemdUnit: string }
    }
    assert.equal(containerBody.container.slice, `xpanel-${account.uid}.slice`)
    assert.match(containerBody.container.systemdUnit, /Slice=xpanel-/)

    const wpRes = await root.request(`/api/apps/${account.id}`, {
      method: 'POST',
      body: {
        appType: 'wordpress',
        domain: 'nebula.test',
        title: 'Nebula Commerce',
      },
    })
    assert.equal(wpRes.status, 201)
    const wpAppId = ((await wpRes.json()) as { app: { id: string } }).app.id

    const cloneRes = await root.request(`/api/apps/${account.id}/${wpAppId}/staging-clone`, {
      method: 'POST',
      body: { stagingDomain: 'staging.nebula.test' },
    })
    assert.equal(cloneRes.status, 201)
    const stagingAppId = ((await cloneRes.json()) as { stagingApp: { id: string } }).stagingApp.id

    const pushRes = await root.request(`/api/apps/${account.id}/${stagingAppId}/staging-push`, {
      method: 'POST',
      body: {},
    })
    assert.equal(pushRes.status, 200)
    const pushBody = (await pushRes.json()) as { ok: boolean; productionApp: { id: string } }
    assert.equal(pushBody.ok, true)
    assert.equal(pushBody.productionApp.id, wpAppId)

    const nodeRes = await root.request('/api/cluster/nodes', {
      method: 'POST',
      body: {
        name: 'eu-dns-01',
        hostname: 'ns2.xpanel.test',
        ipv4: '203.0.113.55',
        role: 'dns',
      },
    })
    assert.equal(nodeRes.status, 201)

    const legacyStatsRes = await root.request('/api/analytics/legacy/nebula.test')
    assert.equal(legacyStatsRes.status, 200)
    const legacyStatsBody = (await legacyStatsRes.json()) as {
      awstats: { uniqueVisitors: number }
      webalizer: { dailyAvgHits: number }
    }
    assert.ok(legacyStatsBody.awstats.uniqueVisitors > 0)
    assert.ok(legacyStatsBody.webalizer.dailyAvgHits > 0)

    const brandRes = await root.request('/api/branding', {
      method: 'PUT',
      body: {
        companyName: 'Nebula Cloud Hosting',
        productName: 'NebulaPanel',
        hidePoweredBy: true,
      },
    })
    assert.equal(brandRes.status, 200)

    const langRes = await root.request('/api/languages/ar', {
      method: 'PUT',
      body: {
        direction: 'rtl',
        overrides: { 'app.title': 'لوحة استضافة نيبولا' },
      },
    })
    assert.equal(langRes.status, 200)

    const whmcsRes = await root.request('/api/whmcs', {
      method: 'PUT',
      body: {
        enabled: true,
        whmcsUrl: 'https://billing.nebulacloud.test',
        webhookSecret: 'whmcs-hmac-secret-2026',
      },
    })
    assert.equal(whmcsRes.status, 200)
    const whmcsBody = (await whmcsRes.json()) as { whmcs: { webhookSecretConfigured: boolean } }
    assert.equal(whmcsBody.whmcs.webhookSecretConfigured, true)

    // Verify audit log captured all major extended operations
    const audits = await listAudit(serverHandle.db, { limit: 200 })
    const actions = new Set(audits.map((a) => a.action))
    assert.ok(actions.has('setup.wizard.completed'))
    assert.ok(actions.has('server.hostname_change'))
    assert.ok(actions.has('server.quota_init'))
    assert.ok(actions.has('mail.domain_forwarder.created'))
    assert.ok(actions.has('mail.filter.created'))
    assert.ok(actions.has('mail.import_csv'))
    assert.ok(actions.has('webmail.message.sent'))
    assert.ok(actions.has('dns.email_auth.batch_provisioned'))
    assert.ok(!audits.some(a => a.action === 'backup.snapshot.restore_file' && a.outcome === 'ok'))
    assert.ok(actions.has('git.repo.deployed'))
    assert.ok(actions.has('database.postgres.created'))
    assert.ok(actions.has('cache.updated'))
    assert.ok(actions.has('app.staging.cloned'))
    assert.ok(actions.has('app.staging.pushed'))
  })
})
