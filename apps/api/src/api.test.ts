import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import {
  createAgentApp,
  FakeHostExecutor,
  HostReconciler,
  IoAnalyticsEngine,
  WebsiteAnalyticsEngine,
} from '@xpanel/agent'
import { canReceiveLiveEvent, suggestServerSettings } from '@xpanel/core'
import type { LiveEvent, OsProfile, ServerSettings } from '@xpanel/core'
import { createRootPrincipal, createTestDb, listAudit } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import {
  computeTotpCode,
  hashPasswordArgon2id,
  CSRF_HEADER_NAME,
  HOST_SESSION_COOKIE_NAME,
  parseCookies,
  SESSION_COOKIE_NAME,
} from './auth.ts'
import { runCli } from './cli.ts'
import { createApiApp, listenApiServer } from './server.ts'
import type { ApiApp } from './server.ts'
import { enrollRootSession, TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

const UBUNTU_OS: OsProfile = profileFor(
  ['ID=ubuntu', 'VERSION_ID="24.04"', 'VERSION_CODENAME=noble', 'NAME="Ubuntu"'].join('\n'),
)

const SUGGESTED = suggestServerSettings({ cores: 4, memoryMb: 8192 })

const DEFAULT_SETTINGS: ServerSettings = {
  hostname: 'panel.xpanel.test',
  nameservers: ['ns1.xpanel.test', 'ns2.xpanel.test'],
  adminEmail: 'admin@xpanel.test',
  engine: 'apache',
  apacheMpm: 'itk',
  panelPort: 2087,
  sshPort: 2222,
  nginx: SUGGESTED.nginx,
  apache: SUGGESTED.apache,
  backendPort: 8080,
  backendTlsPort: 8443,
}

interface SessionClient {
  cookie: string
  csrfToken: string
  request(
    path: string,
    opts?: { method?: string; body?: unknown; csrf?: string | null; headers?: Record<string, string> },
  ): Promise<Response>
}

// The injected executor proves configuration flow only, never native account readiness.
const assertConfiguredAccountCreation = async (response: Response, username: string): Promise<void> => {
  assert.equal(response.status, 201, await response.clone().text())
  const body = await response.clone().json() as { account: { username: string }; execution: unknown }
  assert.equal(body.account.username, username)
  assert.deepEqual(body.execution, {
    status: 'configuration_applied', scope: 'global_configuration', targetVerified: false, verificationRequired: true,
  })
}

const createSessionClient = (app: ApiApp, setCookieHeader: string | null, csrfToken: string): SessionClient => {
  const cookies = parseCookies(
    setCookieHeader
      ? setCookieHeader
          .split(',')
          .map((part) => part.split(';')[0]?.trim())
          .filter(Boolean)
          .join('; ')
      : null,
  )
  const cookieName = cookies[HOST_SESSION_COOKIE_NAME] ? HOST_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME
  const cookieHeader = `${cookieName}=${cookies[cookieName] ?? ''}`

  return {
    cookie: cookieHeader,
    csrfToken,
    request: async (path, opts = {}) => {
      const method = (opts.method ?? 'GET').toUpperCase()
      const headers: Record<string, string> = {
        cookie: cookieHeader,
        ...(opts.headers ?? {}),
      }
      if (opts.csrf !== null && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
        headers[CSRF_HEADER_NAME] = opts.csrf ?? csrfToken
      }
      if (opts.body !== undefined) {
        headers['content-type'] = 'application/json'
      }
      return app.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers,
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        }),
      )
    },
  }
}

describe('@xpanel/api HTTP integration with explicit fake host execution', () => {
  let tmpDir: string
  let dbHandle: TestDbHandle
  let stateHandle: TestStateStoreHandle
  let executor: FakeHostExecutor
  let reconciler: HostReconciler
  let ioAnalytics: IoAnalyticsEngine
  let websiteAnalytics: WebsiteAnalyticsEngine
  let app: ApiApp
  let recoveryCodes: string[]

  beforeEach(async () => {
    recoveryCodes = []
    tmpDir = await mkdtemp(join(tmpdir(), 'xpanel-api-test-'))
    dbHandle = await createTestDb()
    stateHandle = await createTestStateStore()
    executor = new FakeHostExecutor()
    ioAnalytics = new IoAnalyticsEngine()
    websiteAnalytics = new WebsiteAnalyticsEngine()

    reconciler = new HostReconciler({
      store: stateHandle.store,
      db: dbHandle.db,
      executor,
      os: UBUNTU_OS,
      quotaFilesystem: '/home',
      ioDevices: ['/dev/nvme0n1'],
    })

    const agentApp = createAgentApp({
      agentToken: TEST_AGENT_TOKEN,
      reconciler,
      store: stateHandle.store,
      db: dbHandle.db,
      executor,
      ioAnalytics,
      websiteAnalytics,
      os: { id: UBUNTU_OS.id, versionId: UBUNTU_OS.versionId, family: UBUNTU_OS.family },
      homeBaseDir: join(tmpDir, 'host'),
    })

    await createRootPrincipal(dbHandle.db, { username: 'root', passwordHash: await hashPasswordArgon2id('RootPassword!2026'), forcePasswordChange: false })

    app = createApiApp({
      agentToken: TEST_AGENT_TOKEN,
      serverSecret: TEST_SERVER_SECRET,
      db: dbHandle.db,
      store: stateHandle.store,
      agentApp,
      os: UBUNTU_OS,
      lockoutThreshold: 3,
      lockoutDurationMs: 60_000,
    })
  })

  afterEach(async () => {
    await stateHandle.close()
    await dbHandle.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  const loginAs = async (
    username: string,
    password: string,
    extra?: { totpCode?: string; recoveryCode?: string },
    peerAddress = '192.0.2.5',
  ): Promise<{ res: Response; body: Record<string, unknown>; client: SessionClient }> => {
    const res = await app.fetch(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, ...extra }),
      }),
      { remoteAddress: peerAddress },
    )
    const body = (await res.json()) as Record<string, unknown>
    const setCookie = res.headers.get('set-cookie')
    const csrfToken = typeof body.csrfToken === 'string' ? body.csrfToken : ''
    return {
      res,
      body,
      client: createSessionClient(app, setCookie, csrfToken),
    }
  }

  const loginRoot = async () => {
    const login = await loginAs('root', 'RootPassword!2026', recoveryCodes.length
      ? { recoveryCode: recoveryCodes.shift()! }
      : undefined)
    assert.equal(login.res.status, 200)
    if (login.body.mfaEnrollmentRequired) recoveryCodes = await enrollRootSession(login.client, 'RootPassword!2026')
    return login
  }

  it('1. Root login, TOTP 2FA setup & verification, failed login lockout, CSRF protection, and CLI reset-password / disable-2fa', async () => {
    // Initial root login succeeds
    const { res: loginRes, body: loginBody, client: rootClient } = await loginAs('root', 'RootPassword!2026')
    assert.equal(loginRes.status, 200)
    assert.equal((loginBody.principal as { username: string }).username, 'root')
    assert.ok(typeof loginBody.csrfToken === 'string' && loginBody.csrfToken.length > 10)

    // Mutating request without CSRF token is rejected with 403 FORBIDDEN
    const noCsrfRes = await rootClient.request('/api/feature-lists', {
      method: 'POST',
      csrf: null,
      body: { name: 'ShouldFail', ownerId: null, disabled: [] },
    })
    assert.equal(noCsrfRes.status, 403)
    const noCsrfBody = (await noCsrfRes.json()) as { code: string }
    assert.equal(noCsrfBody.code, 'FORBIDDEN')

    // Setup and enable TOTP 2FA
    const setupRes = await rootClient.request('/api/auth/2fa/setup', { method: 'POST', body: { password: 'RootPassword!2026' } })
    assert.equal(setupRes.status, 200)
    const setupData = (await setupRes.json()) as { secret: string; recoveryCodes: string[] }
    assert.ok(setupData.secret.length >= 16)
    assert.equal(setupData.recoveryCodes.length, 8)

    const validTotp = computeTotpCode(setupData.secret)
    const enableRes = await rootClient.request('/api/auth/2fa/enable', {
      method: 'POST',
      body: { code: validTotp },
    })
    assert.equal(enableRes.status, 200)

    // Subsequent login without TOTP code is rejected with 401 mfaRequired
    const missingMfa = await loginAs('root', 'RootPassword!2026')
    assert.equal(missingMfa.res.status, 401)
    assert.equal((missingMfa.body.details as { mfaRequired?: boolean })?.mfaRequired, true)

    // The enrollment step has already been consumed; replay must fail.
    const replay = await loginAs('root', 'RootPassword!2026', { totpCode: validTotp })
    assert.equal(replay.res.status, 401)

    // A fresh, single-use recovery code authenticates without reusing the TOTP step.
    const withMfa = await loginAs('root', 'RootPassword!2026', {
      recoveryCode: setupData.recoveryCodes[0]!,
    })
    assert.equal(withMfa.res.status, 200)

    // Use a fresh trusted peer to measure exactly 3 password failures, independent of the earlier MFA replay.
    const bad1 = await loginAs('root', 'WrongPassword1!', undefined, '192.0.2.6')
    assert.equal(bad1.res.status, 401)
    const bad2 = await loginAs('root', 'WrongPassword2!', undefined, '192.0.2.6')
    assert.equal(bad2.res.status, 401)
    const bad3 = await loginAs('root', 'WrongPassword3!', undefined, '192.0.2.6')
    assert.equal(bad3.res.status, 429)
    assert.equal(bad3.body.code, 'LOCKED_OUT')

    // Even valid credentials fail with 429 while locked out
    const whileLocked = await loginAs('root', 'RootPassword!2026', {
      totpCode: computeTotpCode(setupData.secret),
    }, '192.0.2.6')
    assert.equal(whileLocked.res.status, 429)

    // CLI reset-password clears lockout and updates password; CLI disable-2fa disables TOTP
    const logs: string[] = []
    const resetRes = await runCli(['reset-password', 'root', '--password-stdin'], {
      db: dbHandle.db,
      store: stateHandle.store,
      readPassword: async () => 'NewRootPassword!2026',
      stdout: (msg) => logs.push(msg),
    })
    assert.equal(resetRes.code, 0)

    const disable2faRes = await runCli(['disable-2fa', 'root'], {
      db: dbHandle.db,
      store: stateHandle.store,
      stdout: (msg) => logs.push(msg),
    })
    assert.equal(disable2faRes.code, 0)

    // Resetting a username does not remove the independent IP throttle.
    const stillIpLocked = await loginAs('root', 'NewRootPassword!2026', undefined, '192.0.2.6')
    assert.equal(stillIpLocked.res.status, 429)

    // A different trusted peer may authenticate, then root must enroll again before administrative actions.
    const afterCli = await loginAs('root', 'NewRootPassword!2026')
    assert.equal(afterCli.res.status, 200)
    assert.equal(afterCli.body.totpEnabled, false)
    assert.equal(afterCli.body.mfaEnrollmentRequired, true)
    const needsEnrollment = await afterCli.client.request('/api/accounts')
    assert.equal(needsEnrollment.status, 403)
  })

  it('2. Feature list + Plan creation + Account creation (alice and bob) with host reconciliation and search index', async () => {
    const { client: root } = await loginRoot()

    // Save server settings first so reconciler renders edge/backend configs
    const settingsRes = await root.request('/api/server/settings', {
      method: 'PUT',
      body: DEFAULT_SETTINGS,
    })
    assert.equal(settingsRes.status, 200)

    // Create Feature List
    const flRes = await root.request('/api/feature-lists', {
      method: 'POST',
      body: { name: 'Pro Features', ownerId: null, disabled: [] },
    })
    assert.equal(flRes.status, 201)
    const { featureList } = (await flRes.json()) as { featureList: { id: string } }

    // Create Plan
    const planRes = await root.request('/api/plans', {
      method: 'POST',
      body: {
        name: 'Starter 10M',
        featureListId: featureList.id,
        resources: {
          diskMb: 1,
          bandwidthMbMonth: 10_240,
          ioReadBps: 50_000_000,
          ioWriteBps: 50_000_000,
          ioReadIops: 1000,
          ioWriteIops: 1000,
          memoryMb: 512,
          maxProcesses: 32,
          cpuPercent: 100,
        },
      },
    })
    assert.equal(planRes.status, 201)
    const { plan } = (await planRes.json()) as { plan: { id: string } }

    await stateHandle.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    // Create Account alice
    const aliceRes = await root.request('/api/accounts', {
      method: 'POST',
      body: {
        username: 'alice',
        password: 'AlicePassword!2026',
        primaryDomain: 'alice.example.com',
        planId: plan.id,
        ipv4: '203.0.113.10',
      },
    })
    await assertConfiguredAccountCreation(aliceRes, 'alice')
    const aliceData = (await aliceRes.json()) as {
      account: { id: string; username: string; uid: number }
      primaryDomain: { id: string; name: string }
    }
    assert.equal(aliceData.account.username, 'alice')
    assert.equal(aliceData.primaryDomain.name, 'alice.example.com')

    // Create Account bob
    const bobRes = await root.request('/api/accounts', {
      method: 'POST',
      body: {
        username: 'bob',
        password: 'BobPassword!2026',
        primaryDomain: 'bob.example.com',
        planId: plan.id,
        ipv4: '203.0.113.10',
      },
    })
    await assertConfiguredAccountCreation(bobRes, 'bob')

    // Verify rendered files in FakeHostExecutor
    assert.ok(executor.files.has(`${UBUNTU_OS.paths.nginxVhostDir}/xpanel-alice.conf`))
    assert.ok(executor.files.has(`/etc/systemd/system/xpanel-${aliceData.account.uid}.slice`))
    assert.ok(executor.files.has('/etc/xpanel/php-fpm/8.3/alice.pool.conf'))

    // Verify FTS search index finds alice
    const searchRes = await root.request('/api/search?q=alice')
    assert.equal(searchRes.status, 200)
    const { hits } = (await searchRes.json()) as { hits: { title: string }[] }
    assert.ok(hits.some((h) => h.title.includes('alice')))
  })

  it('3. Account scope rejects cross-tenant operations and file I/O fails closed without a confined runner', async () => {
    const { client: root } = await loginRoot()
    await root.request('/api/server/settings', { method: 'PUT', body: DEFAULT_SETTINGS })

    await stateHandle.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const planRes = await root.request('/api/plans', {
      method: 'POST',
      body: { name: 'IsolationPlan' },
    })
    const { plan } = (await planRes.json()) as { plan: { id: string } }

    const aliceCreateRes = await root.request('/api/accounts', {
      method: 'POST',
      body: {
        username: 'alice',
        password: 'AlicePassword!2026',
        primaryDomain: 'alice.example.com',
        planId: plan.id,
        ipv4: '203.0.113.10',
      },
    })
    await assertConfiguredAccountCreation(aliceCreateRes, 'alice')
    const bobCreateRes = await root.request('/api/accounts', {
      method: 'POST',
      body: {
        username: 'bob',
        password: 'BobPassword!2026',
        primaryDomain: 'bob.example.com',
        planId: plan.id,
        ipv4: '203.0.113.10',
      },
    })
    await assertConfiguredAccountCreation(bobCreateRes, 'bob')

    const { res: aliceLoginRes, client: alice } = await loginAs('alice', 'AlicePassword!2026')
    assert.equal(aliceLoginRes.status, 200)

    // An authorized account still cannot perform file I/O without a confined runner.
    const writeRes = await alice.request('/api/accounts/alice/files', {
      method: 'POST',
      body: {
        op: 'write',
        path: 'public_html/index.php',
        content: '<?php echo "Hello from Alice"; ?>',
      },
    })
    assert.equal(writeRes.status, 412)

    // Reads fail closed as well; no root-process fallback may touch the host filesystem.
    const readRes = await alice.request('/api/accounts/alice/files', {
      method: 'POST',
      body: { op: 'read', path: 'public_html/index.php' },
    })
    assert.equal(readRes.status, 412)
    assert.equal((await readRes.json() as { code: string }).code, 'PRECONDITION_FAILED')
    await assert.rejects(access(join(tmpDir, 'host', 'alice', 'public_html', 'index.php')), { code: 'ENOENT' })

    // The injected executor records argv construction; this does not prove Linux execution.
    const shellRes = await alice.request('/api/accounts/alice/shell', {
      method: 'POST',
      body: { command: 'php -v' },
    })
    assert.equal(shellRes.status, 200)
    const shellData = (await shellRes.json()) as { code: number; argv: string[] }
    assert.equal(shellData.code, 0)
    assert.ok(shellData.argv.some((a) => /^Slice=xpanel-\d+\.slice$/.test(a)))

    // Alice is rejected with 403 FORBIDDEN when accessing bob's files or shell or root endpoints
    const bobFilesRes = await alice.request('/api/accounts/bob/files', {
      method: 'POST',
      body: { op: 'list', path: '' },
    })
    assert.equal(bobFilesRes.status, 404)

    const bobShellRes = await alice.request('/api/accounts/bob/shell', {
      method: 'POST',
      body: { command: 'whoami' },
    })
    assert.equal(bobShellRes.status, 404)

    const reconcileForbidden = await alice.request('/api/reconcile', {
      method: 'POST',
      body: { force: true },
    })
    assert.equal(reconcileForbidden.status, 403)

    const upgradeForbidden = await alice.request('/api/lifecycle/upgrade', {
      method: 'POST',
      body: { dryRun: true },
    })
    assert.equal(upgradeForbidden.status, 403)
  })

  it('4. File requests validate permissions and require a confined runner without filesystem effects or false success audits', async () => {
    const { client: root } = await loginRoot()
    await root.request('/api/server/settings', { method: 'PUT', body: DEFAULT_SETTINGS })

    await stateHandle.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    // Create plan with 1 MiB disk quota
    const planRes = await root.request('/api/plans', {
      method: 'POST',
      body: {
        name: 'SmallQuotaPlan',
        resources: {
          diskMb: 1,
          bandwidthMbMonth: 10_000,
          ioReadBps: 10_000_000,
          ioWriteBps: 10_000_000,
          ioReadIops: 500,
          ioWriteIops: 500,
          memoryMb: 512,
          maxProcesses: 20,
          cpuPercent: 100,
        },
      },
    })
    const { plan } = (await planRes.json()) as { plan: { id: string } }

    const aliceCreateRes = await root.request('/api/accounts', {
      method: 'POST',
      body: {
        username: 'alice',
        password: 'AlicePassword!2026',
        primaryDomain: 'alice.example.com',
        planId: plan.id,
        ipv4: '203.0.113.10',
      },
    })
    await assertConfiguredAccountCreation(aliceCreateRes, 'alice')

    const { client: alice } = await loginAs('alice', 'AlicePassword!2026')

    const writeRes = await alice.request('/api/accounts/alice/files', {
      method: 'POST',
      body: {
        op: 'write',
        path: 'public_html/index.php',
        content: '<?php echo "Quota test"; ?>',
      },
    })
    assert.equal(writeRes.status, 412)

    const shellRes = await alice.request('/api/accounts/alice/shell', {
      method: 'POST',
      body: { command: 'php -v' },
    })
    assert.equal(shellRes.status, 200)

    // Jailed file manager rejects chmod 0o777 (must be <= 0o640 for files)
    const chmod777Res = await alice.request('/api/accounts/alice/files', {
      method: 'POST',
      body: {
        op: 'chmod',
        path: 'public_html/index.php',
        mode: 0o777,
      },
    })
    assert.equal(chmod777Res.status, 422)
    const chmod777Body = (await chmod777Res.json()) as { code: string }
    assert.equal(chmod777Body.code, 'VALIDATION')

    // Oversized file content is rejected before execution; this is an input limit, not kernel quota proof.
    const oversizedPayload = 'X'.repeat(1_200_000)
    const overQuotaRes = await alice.request('/api/accounts/alice/files', {
      method: 'POST',
      body: {
        op: 'write',
        path: 'public_html/huge.bin',
        content: oversizedPayload,
      },
    })
    assert.equal(overQuotaRes.status, 422)
    const overQuotaBody = (await overQuotaRes.json()) as { code: string }
    assert.equal(overQuotaBody.code, 'LIMIT_EXCEEDED')

    // Denied file requests must not be recorded as successful writes.
    const audits = await listAudit(dbHandle.db, { limit: 100 })
    assert.ok(!audits.some((a) => a.actor === 'alice' && a.action === 'file.write' && a.outcome === 'ok'))
    await assert.rejects(access(join(tmpDir, 'host', 'alice', 'public_html', 'huge.bin')), { code: 'ENOENT' })
    assert.ok(audits.some((a) => a.actor === 'alice' && a.action === 'shell.exec' && a.outcome === 'ok'))
  })

  it('5. Multi-IPv4/IPv6 pool management and Mail Outbound IP Postfix transport rendering', async () => {
    const { client: root } = await loginRoot()
    await root.request('/api/server/settings', { method: 'PUT', body: DEFAULT_SETTINGS })

    // Add primary IPv4, secondary dedicated IPv4, and IPv6 to server IP pool
    const ip1Res = await root.request('/api/ips', {
      method: 'POST',
      body: {
        address: '203.0.113.10',
        version: 4,
        prefixLength: 24,
        interfaceName: 'eth0',
        role: 'shared',
        ownerKind: 'root',
        ownerId: null,
        ptrHostname: 'mail1.xpanel.test',
        isPrimary: true,
      },
    })
    assert.equal(ip1Res.status, 201)

    const ip2Res = await root.request('/api/ips', {
      method: 'POST',
      body: {
        address: '203.0.113.25',
        version: 4,
        prefixLength: 24,
        interfaceName: 'eth0',
        role: 'dedicated',
        ownerKind: 'root',
        ownerId: null,
        ptrHostname: 'vip.alice.example.com',
        isPrimary: false,
      },
    })
    assert.equal(ip2Res.status, 201)

    const ip6Res = await root.request('/api/ips', {
      method: 'POST',
      body: {
        address: '2001:db8::25',
        version: 6,
        prefixLength: 64,
        interfaceName: 'eth0',
        role: 'shared',
        ownerKind: 'root',
        ownerId: null,
        ptrHostname: 'vip6.alice.example.com',
        isPrimary: true,
      },
    })
    assert.equal(ip6Res.status, 201)

    // Create plan and account using dedicated IPv4 + IPv6
    const planRes = await root.request('/api/plans', {
      method: 'POST',
      body: { name: 'DedicatedIpPlan', dedicatedIp: true },
    })
    const { plan } = (await planRes.json()) as { plan: { id: string } }

    const accRes = await root.request('/api/accounts', {
      method: 'POST',
      body: {
        username: 'alice',
        password: 'AlicePassword!2026',
        primaryDomain: 'alice.example.com',
        planId: plan.id,
        ipv4: '203.0.113.25',
        ipv6: '2001:db8::25',
      },
    })
    await assertConfiguredAccountCreation(accRes, 'alice')

    // Configure Mail Outbound IP with custom per-domain override
    const mailIpRes = await root.request('/api/mail/ips', {
      method: 'PUT',
      body: {
        mode: 'custom-map',
        defaultIpv4: '203.0.113.10',
        defaultIpv6: '2001:db8::25',
        defaultHelo: 'mail1.xpanel.test',
        domainOverrides: [
          {
            domainName: 'alice.example.com',
            ipv4: '203.0.113.25',
            ipv6: '2001:db8::25',
            heloHostname: 'vip.alice.example.com',
          },
        ],
      },
    })
    assert.equal(mailIpRes.status, 200)

    // Verify Postfix sender transport map and master.cf outbound transport files were rendered
    const senderTransports = executor.files.get('/etc/postfix/xpanel_sender_transports')
    const masterOutbound = executor.files.get('/etc/postfix/xpanel_master_outbound.cf')
    assert.ok(senderTransports, 'Expected /etc/postfix/xpanel_sender_transports to be rendered')
    assert.ok(masterOutbound, 'Expected /etc/postfix/xpanel_master_outbound.cf to be rendered')
    assert.match(senderTransports.content, /@alice\.example\.com/)
    assert.match(masterOutbound.content, /smtp_bind_address=203\.0\.113\.25/)
    assert.match(masterOutbound.content, /smtp_helo_name=vip\.alice\.example\.com/)
  })

  it('6. Smart & dynamic Domain Custom Config (userdata) + automatic rollback when nginx -t fails', async () => {
    const { client: root } = await loginRoot()
    await root.request('/api/server/settings', { method: 'PUT', body: DEFAULT_SETTINGS })

    await stateHandle.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const planRes = await root.request('/api/plans', { method: 'POST', body: { name: 'CustomCfgPlan' } })
    const { plan } = (await planRes.json()) as { plan: { id: string } }

    const accRes = await root.request('/api/accounts', {
      method: 'POST',
      body: {
        username: 'alice',
        password: 'AlicePassword!2026',
        primaryDomain: 'alice.example.com',
        planId: plan.id,
        ipv4: '203.0.113.10',
      },
    })
    await assertConfiguredAccountCreation(accRes, 'alice')
    const { primaryDomain } = (await accRes.json()) as {
      primaryDomain: { id: string; docRoot: string }
    }

    // Apply valid custom config
    const validCustomRes = await root.request(`/api/domains/${primaryDomain.id}/custom-config`, {
      method: 'PUT',
      body: {
        customHeaders: { 'X-Frame-Options': 'SAMEORIGIN' },
        nginxInclude: 'expires 7d;\n',
        userIni: { memory_limit: '256M' },
      },
    })
    assert.equal(validCustomRes.status, 200)
    assert.ok(executor.files.has('/etc/xpanel/userdata/alice/alice.example.com/nginx.conf'))
    assert.ok(executor.files.has(`${primaryDomain.docRoot}/.user.ini`))

    // Simulate `nginx -t` failing on the next config test
    executor.failConfigTest(
      'nginx',
      'nginx: [emerg] unknown directive "broken_directive" in /etc/xpanel/userdata/alice/alice.example.com/nginx.conf:1',
    )

    const brokenCustomRes = await root.request(`/api/domains/${primaryDomain.id}/custom-config`, {
      method: 'PUT',
      body: {
        customHeaders: { 'X-Frame-Options': 'DENY' },
        nginxInclude: 'expires 1d;\n',
        userIni: { memory_limit: '512M' },
      },
    })
    assert.equal(brokenCustomRes.status, 422)
    const brokenBody = (await brokenCustomRes.json()) as {
      code: string
      details: { rolledBack: boolean }
    }
    assert.equal(brokenBody.code, 'CONFIG_TEST_FAILED')
    assert.equal(brokenBody.details.rolledBack, true)

    // Restore normal nginx -t behavior and verify the previous valid custom config was restored in StateStore
    executor.clearConfigTestFailures()
    const getCfgRes = await root.request(`/api/domains/${primaryDomain.id}/custom-config`)
    assert.equal(getCfgRes.status, 200)
    const getCfgData = (await getCfgRes.json()) as {
      config: { customHeaders: Record<string, string>; userIni: Record<string, string> }
    }
    assert.equal(getCfgData.config.customHeaders['X-Frame-Options'], 'SAMEORIGIN')
    assert.equal(getCfgData.config.userIni.memory_limit, '256M')
  })

  it('7. Server IO Monitor & Website Analytics ingestion/querying + real-time WebSocket RBAC event filtering', async () => {
    const { client: root } = await loginRoot()
    await root.request('/api/server/settings', { method: 'PUT', body: DEFAULT_SETTINGS })

    await stateHandle.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const planRes = await root.request('/api/plans', { method: 'POST', body: { name: 'AnalyticsPlan' } })
    const { plan } = (await planRes.json()) as { plan: { id: string } }

    const aliceAccRes = await root.request('/api/accounts', {
      method: 'POST',
      body: {
        username: 'alice',
        password: 'AlicePassword!2026',
        primaryDomain: 'alice.example.com',
        planId: plan.id,
        ipv4: '203.0.113.10',
      },
    })
    await assertConfiguredAccountCreation(aliceAccRes, 'alice')
    const aliceAccData = (await aliceAccRes.json()) as {
      account: { id: string }
      primaryDomain: { id: string }
    }

    const bobAccRes = await root.request('/api/accounts', {
      method: 'POST',
      body: {
        username: 'bob',
        password: 'BobPassword!2026',
        primaryDomain: 'bob.example.com',
        planId: plan.id,
        ipv4: '203.0.113.10',
      },
    })
    await assertConfiguredAccountCreation(bobAccRes, 'bob')
    const bobAccData = (await bobAccRes.json()) as {
      account: { id: string }
      primaryDomain: { id: string }
    }

    // Global IO analytics require administrative authority; account users cannot read the global endpoint.
    const rootIoRes = await root.request('/api/analytics/io')
    assert.equal(rootIoRes.status, 200)
    const rootIo = (await rootIoRes.json()) as { accounts: { username: string }[] }
    assert.equal(rootIo.accounts.length, 2)

    const { client: alice } = await loginAs('alice', 'AlicePassword!2026')
    const aliceIoRes = await alice.request('/api/analytics/io')
    assert.equal(aliceIoRes.status, 403)

    // Ingest structured website access logs as root
    const nowIso = new Date().toISOString()
    const ingestRes = await root.request('/api/analytics/websites/ingest', {
      method: 'POST',
      body: {
        lines: [
          JSON.stringify({
            ts: nowIso,
            host: 'alice.example.com',
            ip: '198.51.100.42',
            method: 'GET',
            uri: '/index.php',
            status: 200,
            bytes: 4096,
            rt: 0.012,
            urt: 0.009,
            cache: 'HIT',
            ref: 'https://www.google.com',
          }),
          JSON.stringify({
            ts: nowIso,
            host: 'bob.example.com',
            ip: '198.51.100.99',
            method: 'GET',
            uri: '/secret',
            status: 502,
            bytes: 512,
            rt: 0.095,
            urt: 0.08,
            cache: 'BYPASS',
            ref: '-',
          }),
        ],
      },
    })
    assert.equal(ingestRes.status, 200)
    const ingestData = (await ingestRes.json()) as { ingested: number }
    assert.equal(ingestData.ingested, 2)

    // Alice can query her own domain's website analytics
    const aliceWebRes = await alice.request(`/api/analytics/websites/${aliceAccData.primaryDomain.id}?window=24h`)
    assert.equal(aliceWebRes.status, 200)
    const aliceWeb = (await aliceWebRes.json()) as {
      totals: { requests: number; uniqueVisitors: number; cacheHitRatioPercent: number }
    }
    assert.equal(aliceWeb.totals.requests, 1)
    assert.equal(aliceWeb.totals.uniqueVisitors, 1)

    // Alice is forbidden from querying Bob's domain website analytics
    const aliceBobWebRes = await alice.request(`/api/analytics/websites/${bobAccData.primaryDomain.id}?window=24h`)
    assert.equal(aliceBobWebRes.status, 404)

    // Verify LiveEvent RBAC filtering via `/api/events/recent` and `canReceiveLiveEvent`
    const bobScopedEvent: LiveEvent = {
      id: 'ev-bob-only',
      at: nowIso,
      kind: 'terminal.output',
      scope: { accountId: bobAccData.account.id, resellerId: null },
      data: {
        sessionId: 'sess-bob',
        username: 'bob',
        stream: 'stdout',
        chunk: 'secret bob output',
      },
    }
    app.hub.broadcast(bobScopedEvent)

    assert.equal(
      canReceiveLiveEvent(
        { kind: 'user', id: 'u-alice', accountId: aliceAccData.account.id },
        bobScopedEvent,
      ),
      false,
    )

    const aliceRecentRes = await alice.request('/api/events/recent')
    assert.equal(aliceRecentRes.status, 200)
    const { events: aliceEvents } = (await aliceRecentRes.json()) as { events: LiveEvent[] }
    assert.ok(!aliceEvents.some((e) => e.id === 'ev-bob-only'))
  })

  it('8. Root-gated upgrade & transfer endpoints + non-200 error contract (never leaks internal 500 error details)', async () => {
    const { client: root } = await loginRoot()

    // Root-gated upgrade endpoint runs preflight and records an upgrade row
    const upgradeRes = await root.request('/api/lifecycle/upgrade', {
      method: 'POST',
      body: {
        currentVersion: '0.1.0',
        targetVersion: '0.2.0',
      },
    })
    assert.equal(upgradeRes.status, 200)
    const upgradeBody = (await upgradeRes.json()) as {
      ok: boolean
      report: { ok: boolean }
      upgrade: { id: number; toVersion: string }
    }
    assert.equal(upgradeBody.ok, true)
    assert.equal(upgradeBody.report.ok, true)
    assert.equal(upgradeBody.upgrade.toVersion, '0.2.0')

    // A transfer cannot accept client-supplied progress as a real host operation.
    const transferRes = await root.request('/api/lifecycle/transfer', {
      method: 'POST',
      body: {
        events: [
          {
            type: 'connected',
            source: { hostname: 'source.example.com', version: '0.1.0' },
          },
          {
            type: 'inventory',
            accounts: [
              {
                username: 'migrated',
                uid: 2050,
                primaryDomain: 'migrated.example.com',
                domains: ['migrated.example.com'],
                plan: 'Starter',
                diskBytes: 250 * 1024 * 1024,
                databases: ['migrated_wp'],
                mailboxes: 1,
                phpVersions: ['8.3'],
              },
            ],
            plans: [{ name: 'Starter' }],
          },
          {
            type: 'select',
            accounts: ['migrated'],
            plans: ['Starter'],
          },
          {
            type: 'review',
          },
        ],
      },
    })
    assert.equal(transferRes.status, 412)
    assert.equal((await transferRes.json() as { code: string }).code, 'PRECONDITION_FAILED')

    // Verify HTTP server listen + 500 internal error redaction contract
    const failingApp = createApiApp({
      serverSecret: TEST_SERVER_SECRET,
      db: dbHandle.db,
      store: stateHandle.store,
      os: UBUNTU_OS,
      webRenderer: () => {
        throw new Error('SENSITIVE_SQL_CONNECTION_STRING_SECRET_12345')
      },
    })
    const { port, close } = await listenApiServer(failingApp)
    try {
      const errRes = await fetch(`http://127.0.0.1:${port}/dashboard`)
      assert.equal(errRes.status, 500)
      const errJson = (await errRes.json()) as { detail: string; code: string }
      assert.equal(errJson.detail, 'Internal server error')
      assert.equal(errJson.code, 'INTERNAL_ERROR')
      assert.ok(!JSON.stringify(errJson).includes('SENSITIVE_SQL_CONNECTION_STRING_SECRET_12345'))
    } finally {
      await close()
    }
  })
})
