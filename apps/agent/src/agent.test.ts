import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { defaultFirewallRules, isXpanelError, suggestServerSettings } from '@xpanel/core'
import type { LiveEvent } from '@xpanel/core'
import { createRootPrincipal, createTestDb, createUserPrincipal, latestActive, listAudit, listMetricsHistory, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { IoAnalyticsEngine, WebsiteAnalyticsEngine } from './analytics.ts'
import { FakeHostExecutor } from './executor.ts'
import { JailedFileManager } from './file-manager.ts'
import { HostReconciler } from './reconciler.ts'
import { agentCallerHeaders, createAgentApp } from './server.ts'

const AGENT_TOKEN = 'a'.repeat(64)

const ARGON2 =
  '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'

describe('@xpanel/agent — HostReconciler, JailedFileManager, IO/Website Analytics, Jailed Shell & Agent Security', () => {
  let stateHandle: TestStateStoreHandle
  let dbHandle: TestDbHandle
  let executor: FakeHostExecutor
  let homeDir: string
  let rootPrincipalId: string
  let alicePrincipalId: string
  const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')

  beforeEach(async () => {
    stateHandle = await createTestStateStore()
    dbHandle = await createTestDb()
    rootPrincipalId = (await createRootPrincipal(dbHandle.db, { username: 'root', passwordHash: ARGON2 })).id
    executor = new FakeHostExecutor()
    homeDir = await mkdtemp(join(tmpdir(), 'xpanel-agent-home-'))
  })

  afterEach(async () => {
    await stateHandle.close()
    await dbHandle.close()
    await rm(homeDir, { recursive: true, force: true })
  })

  const seedServerAndAccount = async (shell: 'none' | 'jailed' = 'jailed') => {
    const suggested = suggestServerSettings({ cores: 4, memoryMb: 8192 })
    await stateHandle.store.saveServerSettings({
      hostname: 'srv1.example.com',
      nameservers: ['ns1.example.com', 'ns2.example.com'],
      adminEmail: 'ops@example.com',
      engine: 'apache',
      apacheMpm: 'itk',
      panelPort: 2087,
      sshPort: 22,
      nginx: suggested.nginx,
      apache: suggested.apache,
      backendPort: 8080,
      backendTlsPort: 8443,
    })
    for (const rule of defaultFirewallRules({
      panelPort: 2087,
      sshPort: 22,
      backendPort: 8080,
      backendTlsPort: 8443,
    })) {
      await stateHandle.store.createFirewallRule(rule, { lockout: null })
    }
    const fl = await stateHandle.store.createFeatureList({
      name: 'Standard',
      ownerId: null,
      disabled: [],
    })
    const plan = await stateHandle.store.createPlan({
      name: 'Pro',
      ownerId: null,
      featureListId: fl.id,
      resources: {
        diskMb: 10_240,
        bandwidthMbMonth: 102_400,
        ioReadBps: 50_000_000,
        ioWriteBps: 50_000_000,
        ioReadIops: 2000,
        ioWriteIops: 2000,
        memoryMb: 1024,
        maxProcesses: 64,
        cpuPercent: 200,
      },
      caps: {
        addonDomains: 10,
        aliasDomains: 10,
        subdomains: 20,
        mailboxes: 20,
        forwarders: 20,
        mailingLists: 5,
        ftpAccounts: 10,
        databases: 10,
        phpWorkers: 8,
      },
      dedicatedIp: false,
      shell,
      defaultMailboxQuotaMb: 1024,
    })
    await stateHandle.store.saveServerIp({
      address: '203.0.113.10',
      version: 4,
      prefixLength: 24,
      interfaceName: 'eth0',
      role: 'shared',
      ownerKind: 'root',
      ownerId: null,
      ptrHostname: 'srv1.example.com',
      isPrimary: true,
      notes: 'Primary IPv4',
    })
    await stateHandle.store.saveServerIp({ address: '2001:db8::10', version: 6, prefixLength: 64, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    await stateHandle.store.saveServerIp({ address: '203.0.113.77', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '' })
    await stateHandle.store.saveServerIp({ address: '2001:db8::77', version: 6, prefixLength: 64, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '' })
    const account = await stateHandle.store.createAccount({
      username: 'alice',
      passwordHash: ARGON2,
      primaryDomain: 'alice.example.com',
      planId: plan.id,
      ownerId: null,
      contactEmail: 'alice@example.com',
      ipv4: '203.0.113.10',
      ipv6: '2001:db8::10',
      shell,
      php: {
        version: '8.3',
        handler: 'fpm',
        fpm: {
          mode: 'ondemand',
          maxChildren: 4,
          startServers: 2,
          minSpareServers: 1,
          maxSpareServers: 3,
          maxRequests: 500,
          processIdleTimeoutSec: 10,
        },
        ini: {},
      },
    })
    alicePrincipalId = (await createUserPrincipal(dbHandle.db, { username: 'alice', passwordHash: ARGON2, accountId: account.id })).id
    return { plan, account, fl }
  }

  it('compiles desired state, renders symlink protection, jailshell, custom userdata includes, and multi-IP Postfix outbound transports', async () => {
    const { account } = await seedServerAndAccount('jailed')
    const domains = await stateHandle.store.listDomains({ accountId: account.id })
    const primaryDomain = domains[0]!

    // Save custom domain configuration (userdata)
    await stateHandle.store.saveDomainCustomConfig({
      domainId: primaryDomain.id,
      accountId: account.id,
      nginxInclude: 'expires 7d;\n',
      apacheInclude: 'Header set X-Custom-App "alice"\n',
      userIni: {
        memory_limit: '256M',
        upload_max_filesize: '64M',
      },
      customHeaders: {
        'X-Frame-Options': 'SAMEORIGIN',
      },
      cacheBypassPaths: ['/cart', '/checkout'],
    })

    // Save multi-IP pool and outbound mail IP configuration
    await stateHandle.store.saveMailIpConfig({
      mode: 'account-ip',
      defaultIpv4: '203.0.113.10',
      defaultIpv6: '2001:db8::10',
      defaultHelo: 'srv1.example.com',
      domainOverrides: [
        {
          domainName: primaryDomain.name,
          ipv4: '203.0.113.77',
          ipv6: '2001:db8::77',
          heloHostname: 'mail.alice.example.com',
        },
      ],
    })

    const events: LiveEvent[] = []
    const reconciler = new HostReconciler({
      store: stateHandle.store,
      db: dbHandle.db,
      executor,
      os,
      onEvent: (ev) => events.push(ev),
    })

    const res = await reconciler.reconcile({ actor: 'root' })
    assert.equal(res.status, 'applied')
    if (res.status !== 'applied') return

    // Verify symlink protection sysctl, jailshell wrapper, and custom domain userdata includes were written
    assert.equal(executor.files.has('/etc/sysctl.d/90-xpanel-symlink-protection.conf'), true)
    assert.equal(executor.files.has('/opt/xpanel/bin/jailshell'), true)
    assert.equal(executor.files.has(`/etc/xpanel/userdata/alice/${primaryDomain.name}/nginx.conf`), true)
    assert.equal(executor.files.has(`/etc/xpanel/userdata/alice/${primaryDomain.name}/apache.conf`), true)
    assert.equal(executor.files.has(`${primaryDomain.docRoot}/.user.ini`), true)

    // Verify Postfix outbound multi-IP transport maps were rendered
    assert.equal(executor.files.has('/etc/postfix/xpanel_sender_transports'), true)
    assert.equal(executor.files.has('/etc/postfix/xpanel_master_outbound.cf'), true)
    const senderMap = executor.files.get('/etc/postfix/xpanel_sender_transports')!
    assert.match(senderMap.content, new RegExp(`@${primaryDomain.name}\\s+xpanel-smtp-203-0-113-77:`))
    const masterOut = executor.files.get('/etc/postfix/xpanel_master_outbound.cf')!
    assert.match(masterOut.content, /-o smtp_bind_address=203\.0\.113\.77/)
    assert.match(masterOut.content, /-o smtp_bind_address6=2001:db8::77/)
    assert.match(masterOut.content, /-o smtp_helo_name=mail\.alice\.example\.com/)

    const nginxCustom = executor.files.get(`/etc/xpanel/userdata/alice/${primaryDomain.name}/nginx.conf`)!
    assert.match(nginxCustom.content, /X-Frame-Options/)
    assert.match(nginxCustom.content, /\/checkout/)
    assert.match(nginxCustom.content, /expires 7d;/)

    // Verify live reconcile stages and applied event were emitted
    const stageEvents = events.filter((e) => e.kind === 'reconcile.stage')
    assert.equal(stageEvents.length >= 8, true)
    assert.equal(events.some((e) => e.kind === 'reconcile.applied'), true)

    // Second reconcile with no state changes is a fast noop
    const noopRes = await reconciler.reconcile()
    assert.equal(noopRes.status, 'noop')
  })

  it('rolls back staged files and records failed generation when a service config test fails', async () => {
    await seedServerAndAccount('jailed')
    const reconciler = new HostReconciler({
      store: stateHandle.store,
      db: dbHandle.db,
      executor,
      os,
    })

    const first = await reconciler.reconcile()
    assert.equal(first.status, 'applied')

    // Inject failing nginx -t
    executor.failConfigTest('nginx', 'nginx: [emerg] invalid parameter in nginx.conf')
    const failed = await reconciler.reconcile({ force: true })
    assert.equal(failed.status, 'failed')
    if (failed.status === 'failed') {
      assert.equal(failed.failedTest, 'nginx')
      assert.match(failed.error, /invalid parameter/)
    }
    const currentApplied = await latestActive(dbHandle.db)
    assert.equal(currentApplied?.id, 1)
  })

  it('refuses file content access without a confined runner and does not perform fallback filesystem writes', async () => {
    const { account } = await seedServerAndAccount('jailed')
    const accountRoot = join(homeDir, 'home', account.username)
    await mkdir(join(accountRoot, 'public_html'), { recursive: true })
    const marker = join(accountRoot, 'public_html', 'index.php')
    await writeFile(marker, 'unchanged', 'utf8')
    const fm = new JailedFileManager(accountRoot, 1, { account })
    for (const operation of [
      () => fm.readText('public_html/index.php'),
      () => fm.writeText('public_html/index.php', 'unsafe replacement'),
      () => fm.mkdir('public_html/new-directory'),
      () => fm.moveToTrash('public_html/index.php'),
    ]) {
      await assert.rejects(operation, (error: unknown) => isXpanelError(error) && error.code === 'PRECONDITION_FAILED')
    }
    assert.equal(await readFile(marker, 'utf8'), 'unchanged')
    assert.equal(executor.executedCommands.length, 0)
  })

  it('allows a trusted service wakeup with the actual account actor, without root impersonation', async () => {
    const { account } = await seedServerAndAccount('jailed')
    const reconciler = new HostReconciler({ store: stateHandle.store, db: dbHandle.db, executor, os })
    let observed: Parameters<HostReconciler['reconcile']>[0]
    reconciler.reconcile = async options => {
      observed = options
      return { status: 'noop', generation: null, stateChecksum: 'a'.repeat(64) }
    }
    const app = createAgentApp({
      reconciler, store: stateHandle.store, db: dbHandle.db, agentToken: AGENT_TOKEN,
      os: { id: os.id, versionId: os.versionId, family: os.family },
    })
    const headers = { ...agentCallerHeaders({ principalId: alicePrincipalId, token: AGENT_TOKEN }), 'content-type': 'application/json' }
    const wakeup = await app.fetch(new Request('http://agent.local/state/apply', { method: 'POST', headers, body: '{"force":false}' }))
    assert.equal(wakeup.status, 200)
    assert.equal(observed?.actor, 'alice')
    assert.equal(observed?.scope?.accountId, account.id)
    assert.equal(observed?.force, false)
    const forced = await app.fetch(new Request('http://agent.local/state/apply', { method: 'POST', headers, body: '{"force":true}' }))
    assert.equal(forced.status, 403)
  })

  it('routes IO analytics, website analytics and jailed shell through a fake executor with auth, RBAC and audit logging', async () => {
    const { account, plan } = await seedServerAndAccount('jailed')
    await stateHandle.store.saveServerIp({ address: '203.0.113.11', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '' })
    const bob = await stateHandle.store.createAccount({
      username: 'bob',
      passwordHash: ARGON2,
      primaryDomain: 'bob.example.com',
      planId: plan.id,
      ownerId: null,
      contactEmail: 'bob@example.com',
      ipv4: '203.0.113.11',
      shell: 'jailed',
      php: {
        version: '8.3',
        handler: 'fpm',
        fpm: {
          mode: 'ondemand',
          maxChildren: 4,
          startServers: 2,
          minSpareServers: 1,
          maxSpareServers: 3,
          maxRequests: 500,
          processIdleTimeoutSec: 10,
        },
        ini: {},
      },
    })
    await mkdir(join(homeDir, 'home', 'alice', 'public_html'), { recursive: true })
    await mkdir(join(homeDir, 'home', 'bob', 'public_html'), { recursive: true })

    const domains = await stateHandle.store.listDomains({ accountId: account.id })
    const primaryDomain = domains[0]!

    executor.sliceMetrics.set(account.uid, {
      uid: account.uid,
      cpuUsageUsec: 250_000,
      memoryCurrentBytes: 256 * 1024 * 1024,
      ioReadBytes: 45_000_000 * 60, // ~45 MB/s (90% of 50 MB/s cap -> warn)
      ioWriteBytes: 10_000_000 * 60,
      pidsCurrent: 6,
    })

    const events: LiveEvent[] = []
    const reconciler = new HostReconciler({
      store: stateHandle.store,
      db: dbHandle.db,
      executor,
      os,
      onEvent: (ev) => events.push(ev),
    })
    const ioAnalytics = new IoAnalyticsEngine()
    const websiteAnalytics = new WebsiteAnalyticsEngine()

    const app = createAgentApp({
      reconciler,
      store: stateHandle.store,
      db: dbHandle.db,
      executor,
      ioAnalytics,
      websiteAnalytics,
      os: { id: os.id, versionId: os.versionId, family: os.family },
      homeBaseDir: homeDir,
      agentToken: AGENT_TOKEN,
    })

    const rootHeaders = {
      ...agentCallerHeaders({ principalId: rootPrincipalId, token: AGENT_TOKEN }),
      'content-type': 'application/json',
    }
    const aliceHeaders = {
      ...agentCallerHeaders({
        principalId: alicePrincipalId,
        token: AGENT_TOKEN,
      }),
      'content-type': 'application/json',
    }

    // 0. Unauthenticated requests are rejected with 401 UNAUTHENTICATED
    const unauthRes = await app.fetch(new Request('http://agent.local/reconcile', { method: 'POST' }))
    assert.equal(unauthRes.status, 401)

    // User role cannot trigger root-only /reconcile -> 403 FORBIDDEN
    const forbiddenReconcile = await app.fetch(
      new Request('http://agent.local/reconcile', { method: 'POST', headers: aliceHeaders }),
    )
    assert.equal(forbiddenReconcile.status, 403)

    // User alice cannot access user bob's files or shell -> 403 FORBIDDEN
    const crossAccountFiles = await app.fetch(
      new Request('http://agent.local/accounts/bob/files', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ op: 'list', path: '' }),
      }),
    )
    assert.equal(crossAccountFiles.status, 403)

    const crossAccountShell = await app.fetch(
      new Request('http://agent.local/accounts/bob/shell', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ command: 'whoami' }),
      }),
    )
    assert.equal(crossAccountShell.status, 403)
    assert.equal(bob.username, 'bob')

    // 1. Sample IO analytics & collect metrics as root
    const ioRes = await app.fetch(new Request('http://agent.local/analytics/io', { headers: rootHeaders }))
    assert.equal(ioRes.status, 200)
    const ioBody = (await ioRes.json()) as {
      accounts: { username: string; statusLevel: string; readBytesPerSec: number }[]
    }
    assert.equal(ioBody.accounts[0]?.username, 'alice')
    assert.equal(ioBody.accounts[0]?.statusLevel, 'warn')
    assert.equal(events.some((e) => e.kind === 'io.analytics'), true)

    const metricsRes = await app.fetch(
      new Request('http://agent.local/metrics/collect', { method: 'POST', headers: rootHeaders }),
    )
    assert.equal(metricsRes.status, 200)
    const savedMetrics = await listMetricsHistory(dbHandle.db, { scope: 'account', accountId: account.id })
    assert.equal(savedMetrics.length >= 1, true)

    // 2. Ingest Nginx JSON metrics and query website analytics
    const nowIso = new Date().toISOString()
    const ingestRes = await app.fetch(
      new Request('http://agent.local/analytics/websites/ingest', {
        method: 'POST',
        headers: rootHeaders,
        body: JSON.stringify({
          lines: [
            JSON.stringify({
              ts: nowIso,
              host: primaryDomain.name,
              ip: '198.51.100.25',
              method: 'GET',
              uri: '/products?page=1',
              status: 200,
              bytes: 14200,
              rt: 0.018,
              urt: 0.012,
              cache: 'HIT',
              ref: 'https://www.google.com/search?q=alice',
            }),
            JSON.stringify({
              ts: nowIso,
              host: primaryDomain.name,
              ip: '198.51.100.99',
              method: 'POST',
              uri: '/checkout',
              status: 201,
              bytes: 2048,
              rt: 0.064,
              urt: 0.055,
              cache: 'BYPASS',
              ref: '-',
            }),
          ],
        }),
      }),
    )
    assert.equal(ingestRes.status, 200)

    const webRes = await app.fetch(
      new Request(`http://agent.local/analytics/websites/${primaryDomain.id}?window=24h`, {
        headers: aliceHeaders,
      }),
    )
    assert.equal(webRes.status, 200)
    const webSnap = (await webRes.json()) as {
      totals: {
        requests: number
        uniqueVisitors: number
        cacheHitRatioPercent: number
      }
      topPaths: { key: string }[]
    }
    assert.equal(webSnap.totals.requests, 2)
    assert.equal(webSnap.totals.uniqueVisitors, 2)
    assert.equal(webSnap.totals.cacheHitRatioPercent, 50)
    assert.equal(webSnap.topPaths.map((p) => p.key).includes('/products'), true)
    assert.equal(events.some((e) => e.kind === 'website.analytics'), true)

    // 3. Verify the shell argv contract and propagated fake exit status; this is not kernel proof
    const shellRes = await app.fetch(
      new Request('http://agent.local/accounts/alice/shell', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ command: 'php -v' }),
      }),
    )
    assert.equal(shellRes.status, 200)
    const shellBody = (await shellRes.json()) as { code: number; argv: string[] }
    assert.equal(shellBody.code, 0)
    assert.equal(shellBody.argv.includes(`Slice=xpanel-${account.uid}.slice`), true)
    assert.equal(shellBody.argv.includes('ProtectHome=tmpfs'), true)
    assert.equal(events.some((e) => e.kind === 'terminal.output'), true)

    // Simulate non-zero exit code from systemd-run command
    executor.failCommand('/usr/bin/composer', 2, 'Composer could not find a composer.json file')
    const failShellRes = await app.fetch(
      new Request('http://agent.local/accounts/alice/shell', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ command: 'composer install' }),
      }),
    )
    assert.equal(failShellRes.status, 200)
    const failShellBody = (await failShellRes.json()) as { code: number; stderr: string }
    assert.equal(failShellBody.code, 2)
    assert.match(failShellBody.stderr, /composer\.json/)
    executor.clearCommandFailures()

    // Reject shell metacharacters & bash -c
    const metaShellRes = await app.fetch(
      new Request('http://agent.local/accounts/alice/shell', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ command: 'php -v; id' }),
      }),
    )
    assert.equal(metaShellRes.status, 422)

    const bashShellRes = await app.fetch(
      new Request('http://agent.local/accounts/alice/shell', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ command: 'bash -c id' }),
      }),
    )
    assert.equal(bashShellRes.status, 403)

    // 4. Missing confined execution fails closed and records the failure
    const writeRes = await app.fetch(
      new Request('http://agent.local/accounts/alice/files', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({
          op: 'write',
          path: 'public_html/app.php',
          content: '<?php echo 1;',
          mode: 0o640,
        }),
      }),
    )
    assert.equal(writeRes.status, 412)

    const audits = await listAudit(dbHandle.db, { limit: 50 })
    assert.equal(audits.some((a) => a.action === 'shell.exec' && a.actor === 'alice'), true)
    assert.equal(audits.some((a) => a.action === 'file.write' && a.actor === 'alice' && a.outcome === 'failed'), true)
    assert.equal(audits.some((a) => a.action === 'agent.access_denied' && a.outcome === 'denied'), true)
  })

  it('masks non-XpanelError 500 internal errors with constant detail and logs to audit_log', async () => {
    const reconciler = new HostReconciler({
      store: stateHandle.store,
      db: dbHandle.db,
      executor,
      os,
    })
    const brokenExecutor = new FakeHostExecutor()
    brokenExecutor.readSliceMetrics = async () => {
      throw new Error('SECRET_INTERNAL_STACK_PATH_/var/lib/xpanel/private')
    }
    await seedServerAndAccount('jailed')

    const app = createAgentApp({
      reconciler,
      store: stateHandle.store,
      db: dbHandle.db,
      executor: brokenExecutor,
      os: { id: os.id, versionId: os.versionId, family: os.family },
      agentToken: AGENT_TOKEN,
    })

    const res = await app.fetch(new Request('http://agent.local/analytics/io', { headers: agentCallerHeaders({ principalId: rootPrincipalId, token: AGENT_TOKEN }) }))
    assert.equal(res.status, 500)
    const body = (await res.json()) as { detail: string; title: string }
    assert.equal(body.title, 'INTERNAL_ERROR')
    assert.equal(body.detail, 'Internal agent error')
    assert.equal(body.detail.includes('SECRET_INTERNAL_STACK_PATH'), false)
  })
})
