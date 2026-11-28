import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FPM, fail } from '@xpanel/core'
import type { Account, Database, DatabaseUser, Domain, Plan } from '@xpanel/core'
import type { StoredCertificate } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import {
  ALLOWED_DB_CHARSETS,
  computeCronNextRuns,
  handleWorkspaceControlsRoute,
  MONITORING_RING_CAPACITY,
  recordMonitoringSample,
} from './workspace-controls-routes.ts'
import type { WorkspaceControlsHelpers } from './workspace-controls-routes.ts'

const ROOT_ID = '11111111-1111-4111-8111-111111111111'
const ALICE_USER_ID = '22222222-2222-4222-8222-222222222222'
const ALICE_ACCT_ID = '33333333-3333-4333-8333-333333333333'
const BOB_ACCT_ID = '44444444-4444-4444-8444-444444444444'
const ALICE_DOM_ID = '55555555-5555-4555-8555-555555555555'
const BOB_DOM_ID = '66666666-6666-4666-8666-666666666666'
const ALICE_DB_ID = '77777777-7777-4777-8777-777777777777'
const BOB_DB_ID = '88888888-8888-4888-8888-888888888888'
const CERT_ID = '99999999-9999-4999-8999-999999999999'

const ROOT_CALLER = {
  principal: { kind: 'root', id: ROOT_ID, username: 'root' },
  sessionId: 'sess-root',
  apiTokenId: null,
  scopes: [],
  principalRecord: {},
} as unknown as AuthenticatedCaller

const ALICE_CALLER = {
  principal: { kind: 'user', id: ALICE_USER_ID, username: 'alice', accountId: ALICE_ACCT_ID },
  sessionId: 'sess-alice',
  apiTokenId: null,
  scopes: [],
  principalRecord: {},
} as unknown as AuthenticatedCaller

const MAILBOX_CALLER = {
  principal: { kind: 'mailbox', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'mail@alice.example', accountId: ALICE_ACCT_ID },
  sessionId: 'sess-mail',
  apiTokenId: null,
  scopes: ['mailbox:mail@alice.example'],
  principalRecord: {},
} as unknown as AuthenticatedCaller

let root = ''
let homeBase = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'xp-wc-routes-'))
  homeBase = join(root, 'homes')
  await mkdir(join(homeBase, 'alice', 'public_html'), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function buildHarness(caller: AuthenticatedCaller = ALICE_CALLER, overrides: Partial<WorkspaceControlsHelpers> = {}) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const alice: Account = {
    id: ALICE_ACCT_ID,
    username: 'alice',
    uid: 1001,
    gid: 1001,
    primaryDomain: 'alice.example',
    planId: 'plan-1',
    ownerId: null,
    home: '/home/alice',
    shell: 'none',
    contactEmail: 'alice@alice.example',
    status: 'active',
    suspendReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ipv4: '192.0.2.10',
  }
  const bob: Account = {
    ...alice,
    id: BOB_ACCT_ID,
    username: 'bob',
    uid: 1002,
    gid: 1002,
    primaryDomain: 'bob.example',
    home: '/home/bob',
  }

  const domains: Domain[] = [
    {
      id: ALICE_DOM_ID,
      accountId: ALICE_ACCT_ID,
      name: 'alice.example',
      kind: 'primary',
      parentId: null,
      docRoot: '/home/alice/public_html',
      siteType: 'php',
      upstream: null,
      redirect: null,
      php: { version: '8.3', handler: 'fpm', fpm: { ...DEFAULT_FPM }, ini: { memory_limit: '128M' } },
      wildcard: false,
      certificateId: CERT_ID,
      suspended: false,
      expiresAt: null,
      pathQuotaMb: 'unlimited',
    },
    {
      id: BOB_DOM_ID,
      accountId: BOB_ACCT_ID,
      name: 'bob.example',
      kind: 'primary',
      parentId: null,
      docRoot: '/home/bob/public_html',
      siteType: 'php',
      upstream: null,
      redirect: null,
      php: { version: '8.3', handler: 'fpm', fpm: { ...DEFAULT_FPM }, ini: {} },
      wildcard: false,
      certificateId: null,
      suspended: false,
      expiresAt: null,
      pathQuotaMb: 'unlimited',
    },
  ]

  const certificates: StoredCertificate[] = [
    {
      id: CERT_ID,
      accountId: ALICE_ACCT_ID,
      names: ['alice.example', 'www.alice.example'],
      source: 'acme',
      challenge: 'http-01',
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2027-12-31T00:00:00.000Z',
      autoRenew: true,
      certPath: '/etc/ssl/alice.crt',
      keyPath: '/etc/ssl/alice.key',
      chainPath: null,
      fingerprintSha256: null,
      lastError: null,
      renewedAt: null,
    },
  ]

  const databases: Database[] = [
    { id: ALICE_DB_ID, accountId: ALICE_ACCT_ID, engine: 'mariadb', name: 'alice_app', trashedAt: null },
    { id: BOB_DB_ID, accountId: BOB_ACCT_ID, engine: 'mariadb', name: 'bob_app', trashedAt: null },
  ]

  const dbUsers: DatabaseUser[] = [
    { id: '12121212-1212-4121-8121-121212121212', accountId: ALICE_ACCT_ID, name: 'alice_usr', grants: [{ databaseId: ALICE_DB_ID, privileges: ['SELECT', 'INSERT'] }] } as unknown as DatabaseUser,
  ]

  const plan: Plan = {
    id: 'plan-1',
    name: 'Starter',
    featureListId: 'fl-1',
    resources: { diskMb: 2048, memoryMb: 1024, cpuPercent: 100, ioReadBps: 10485760, ioWriteBps: 5242880, bandwidthGb: 100, inodes: 100000, nproc: 32 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 10, databases: 10, mailboxes: 10, ftpAccounts: 5, cronJobs: 20, maxPhpWorkers: 8 },
  } as unknown as Plan

  const accounts = [alice, bob]
  const helpers: WorkspaceControlsHelpers = {
    requireCaller: vi.fn(async () => caller),
    assertRoot: vi.fn(async (c: AuthenticatedCaller) => {
      if (c.principal.kind !== 'root') fail('FORBIDDEN', 'root required', { stateChanged: false })
    }),
    emitAudit: vi.fn(async () => undefined),
    triggerReconcile: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
    applyServerPhpIni: vi.fn(async () => ({ applied: true, reconcile: 'requested' })),
    applyDatabaseCharset: vi.fn(async () => undefined),
    applyAddonServiceConfig: vi.fn(async () => ({ applied: true })),
    homeBaseDir: homeBase,
    now: () => new Date('2026-11-20T12:00:00.000Z'),
    store: {
      rootDir: root,
      getWriterLock: (() => ({ acquire: async () => lease })) as never,
      getAccount: async (id) => accounts.find(a => a.id === id) ?? null,
      getAccountByUsername: async (username) => accounts.find(a => a.username === username) ?? null,
      listAccounts: async () => [...accounts],
      getDomain: async (id) => domains.find(d => d.id === id) ?? null,
      listDomains: async (f = {}) => domains.filter(d => !f.accountId || d.accountId === f.accountId),
      updateDomain: async (id, patch) => {
        const idx = domains.findIndex(d => d.id === id)
        if (idx < 0) fail('NOT_FOUND', 'domain not found')
        domains[idx] = { ...domains[idx]!, ...patch } as Domain
        return domains[idx]!
      },
      setDomainsForceHttps: async (accountId, ids, enabled) => {
        const out: Domain[] = []
        for (const id of ids) {
          const idx = domains.findIndex(d => d.id === id && d.accountId === accountId)
          if (idx >= 0) {
            domains[idx] = { ...domains[idx]!, forceHttps: enabled }
            out.push(domains[idx]!)
          }
        }
        return out
      },
      renameDomain: async (id, newName) => {
        const idx = domains.findIndex(d => d.id === id)
        if (idx < 0) fail('NOT_FOUND', 'domain not found')
        domains[idx] = { ...domains[idx]!, name: newName }
        alice.primaryDomain = newName
        return domains[idx]!
      },
      createDomain: async (input) => {
        const created: Domain = {
          id: 'abababab-abab-4bab-8bab-abababababab',
          accountId: input.accountId,
          name: input.name,
          kind: input.kind,
          parentId: input.parentId ?? null,
          docRoot: input.docRoot ?? '/home/alice/public_html',
          siteType: input.siteType ?? 'php',
          upstream: null,
          redirect: null,
          php: { version: '8.3', handler: 'fpm', fpm: { ...DEFAULT_FPM }, ini: {} },
          wildcard: false,
          certificateId: null,
          suspended: false,
          expiresAt: null,
          pathQuotaMb: 'unlimited',
        }
        domains.push(created)
        return created
      },
      listCertificates: async (accountId) => certificates.filter(c => !accountId || c.accountId === accountId),
      getDatabase: async (id) => databases.find(d => d.id === id) ?? null,
      listDatabases: async (accountId) => databases.filter(d => d.accountId === accountId),
      listDatabaseUsers: async (accountId) => dbUsers.filter(u => u.accountId === accountId),
      getPlan: async () => plan,
      getFeatureList: async () => ({ id: 'fl-1', name: 'default', ownerId: null, disabled: [] }),
      getServerSettings: async () => null,
    },
    ...overrides,
  }

  const send = (path: string, method = 'GET', body?: unknown) =>
    handleWorkspaceControlsRoute(
      new Request('http://api.test' + path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      }),
      new URL('http://api.test' + path),
      method,
      helpers,
    )

  return { helpers, send, domains, alice }
}

describe('Workspace controls API routes', () => {
  it('enforces root authority and allowlist validation on server PHP INI preview and apply', async () => {
    const userHarness = buildHarness(ALICE_CALLER)
    await expect(userHarness.send('/api/server/php/ini')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const h = buildHarness(ROOT_CALLER)
    const initial = await (await h.send('/api/server/php/ini'))!.json()
    expect(initial.version).toBe('8.3')

    const preview = await (await h.send('/api/server/php/ini/preview', 'POST', {
      version: '8.3',
      ini: {
        memory_limit: '256M',
        upload_max_filesize: '32M',
        post_max_size: '64M',
        max_execution_time: '60',
        max_input_vars: '2000',
        display_errors: 'Off',
      },
    }))!.json()
    expect(preview.stateChanged).toBe(false)
    expect(preview.previewText).toContain('memory_limit = 256M')
    expect(preview.previewText).toContain('display_errors = Off')

    await expect(h.send('/api/server/php/ini/preview', 'POST', {
      ini: { allow_url_fopen: 'On' },
    })).rejects.toMatchObject({ code: 'VALIDATION' })

    await expect(h.send('/api/server/php/ini/preview', 'POST', {
      ini: { upload_max_filesize: '128M', post_max_size: '64M' },
    })).rejects.toMatchObject({ code: 'VALIDATION' })

    const applied = await (await h.send('/api/server/php/ini/apply', 'POST', {
      version: '8.3',
      ini: { memory_limit: '256M', display_errors: 'Off' },
      expectedRevision: initial.revision,
    }))!.json()
    expect(applied.stateChanged).toBe(true)
    expect(applied.ini).toEqual({ memory_limit: '256M', display_errors: 'Off' })
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'server.php.ini.updated',
      target: 'php:8.3',
      outcome: 'ok',
    }))
  })

  it('scopes account PHP INI preview and apply to owned domains and rejects cross-tenant domains', async () => {
    const h = buildHarness(ALICE_CALLER)
    const mailboxHarness = buildHarness(MAILBOX_CALLER)
    await expect(mailboxHarness.send('/api/account/php/ini')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(h.send(`/api/account/php/ini?domainId=${BOB_DOM_ID}`)).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const preview = await (await h.send('/api/account/php/ini/preview', 'POST', {
      domainId: ALICE_DOM_ID,
      ini: { max_input_vars: '3000', display_errors: 'Off', memory_limit: '256M' },
    }))!.json()
    expect(preview.stateChanged).toBe(false)
    expect(preview.previewText).toContain('max_input_vars = 3000')

    const applied = await (await h.send('/api/account/php/ini/apply', 'POST', {
      domainId: ALICE_DOM_ID,
      ini: { max_input_vars: '3000', display_errors: 'Off', 'date.timezone': 'UTC' },
    }))!.json()
    expect(applied.stateChanged).toBe(true)
    expect(applied.ini).toMatchObject({ memory_limit: '128M', max_input_vars: '3000', display_errors: 'Off', 'date.timezone': 'UTC' })
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'account.php.ini.updated',
      target: 'domain:alice.example',
      outcome: 'ok',
    }))
  })

  it('reads bounded tenant-isolated disk folder breakdown while ignoring symlinks and rejecting selectors', async () => {
    await writeFile(join(homeBase, 'alice', 'public_html', 'index.php'), 'x'.repeat(200))
    await writeFile(join(homeBase, 'alice', '.bashrc'), 'y'.repeat(50))
    await mkdir(join(homeBase, 'bob', 'secret'), { recursive: true })
    await writeFile(join(homeBase, 'bob', 'secret', 'data.bin'), 'z'.repeat(999))
    try {
      await symlink(join(homeBase, 'bob'), join(homeBase, 'alice', 'bob-link'))
    } catch {
      // Symlinks may require privilege on some Windows hosts; regular test still verifies isolation
    }

    const h = buildHarness(ALICE_CALLER)
    await expect(h.send('/api/account/resources/folders?path=/etc')).rejects.toMatchObject({ code: 'VALIDATION' })

    const res = await (await h.send('/api/account/resources/folders'))!.json()
    expect(res.state).toBe('read')
    expect(res.totalBytes).toBe(250)
    expect(res.folders.map((f: { path: string }) => f.path)).toEqual(['~/public_html', '~/(root files)'])
    expect(res.folders[0]!.sizeBytes).toBe(200)
    expect(res.folders[0]!.sharePercent).toBe(80)
  })

  it('computes deterministic cron next UTC runs and persists/clears MAILTO with validation', async () => {
    const h = buildHarness(ALICE_CALLER)
    const preview = await (await h.send('/api/account/cron/preview', 'POST', { schedule: '*/15 * * * *', count: 3 }))!.json()
    expect(preview.nextRuns).toEqual([
      '2026-11-20T12:15:00.000Z',
      '2026-11-20T12:30:00.000Z',
      '2026-11-20T12:45:00.000Z',
    ])
    const helperPreview = computeCronNextRuns('@daily', new Date('2026-11-20T12:00:00.000Z'), 2)
    expect(helperPreview.nextRuns).toEqual(['2026-11-21T00:00:00.000Z', '2026-11-22T00:00:00.000Z'])

    await expect(h.send('/api/account/cron/preview', 'POST', { schedule: 'bad cron' })).rejects.toMatchObject({ code: 'VALIDATION' })

    const initialMail = await (await h.send('/api/account/cron/mailto'))!.json()
    expect(initialMail.mailto).toBeNull()

    await expect(h.send('/api/account/cron/mailto', 'PUT', { mailto: 'not-an-email' })).rejects.toMatchObject({ code: 'VALIDATION' })

    const saved = await (await h.send('/api/account/cron/mailto', 'PUT', {
      mailto: 'ops@alice.example',
      mode: 'failures',
      expectedRevision: initialMail.revision,
    }))!.json()
    expect(saved.mailto).toBe('ops@alice.example')
    expect(saved.mode).toBe('failures')
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'account.cron.mailto_updated',
      outcome: 'ok',
    }))

    const cleared = await (await h.send('/api/account/cron/mailto', 'PUT', {
      mailto: null,
      expectedRevision: saved.revision,
    }))!.json()
    expect(cleared.mailto).toBeNull()
    expect(cleared.mode).toBe('never')
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'account.cron.mailto_cleared',
      outcome: 'ok',
    }))
  })

  it('handles domain certificate inspect, force-https toggle, redirect, and primary rename with ownership isolation', async () => {
    const h = buildHarness(ALICE_CALLER)
    await expect(h.send(`/api/account/domains/${BOB_DOM_ID}/certificate`)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(h.send(`/api/account/domains/${BOB_DOM_ID}/force-https`, 'POST', { enabled: true })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const cert = await (await h.send(`/api/account/domains/${ALICE_DOM_ID}/certificate`))!.json()
    expect(cert.covered).toBe(true)
    expect(cert.certificate.source).toBe('acme')
    expect(cert.certificate.issuer).toBe('ACME')

    const httpsRes = await (await h.send(`/api/account/domains/${ALICE_DOM_ID}/force-https`, 'POST', { enabled: true }))!.json()
    expect(httpsRes.forceHttps).toBe(true)
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'account.domain.force_https_updated',
      target: 'domain:alice.example',
    }))

    const redirRes = await (await h.send(`/api/account/domains/${ALICE_DOM_ID}/redirect`, 'PUT', { to: 'https://target.example/app', code: 301 }))!.json()
    expect(redirRes.redirect).toEqual({ to: 'https://target.example/app', code: 301 })

    await expect(h.send('/api/account/domains/rename-primary', 'POST', {
      newDomain: 'alice-new.example',
      confirmCurrentDomain: 'wrong.example',
    })).rejects.toMatchObject({ code: 'VALIDATION' })

    const renamed = await (await h.send('/api/account/domains/rename-primary', 'POST', {
      newDomain: 'alice-new.example',
      confirmCurrentDomain: 'alice.example',
      keepOldAsAlias: true,
    }))!.json()
    expect(renamed.primaryDomain).toBe('alice-new.example')
    expect(renamed.aliasCreated.name).toBe('alice.example')
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'account.domain.primary_renamed',
      target: 'account:alice',
    }))
  })

  it('validates MariaDB database inspect, SQL preview allowlists, and charset updates with tenant isolation', async () => {
    const h = buildHarness(ALICE_CALLER)
    const inspected = await (await h.send('/api/account/databases/inspect'))!.json()
    expect(inspected.prefix).toBe('alice_')
    expect(inspected.allowedCharsets).toEqual(ALLOWED_DB_CHARSETS)
    expect(inspected.databases).toHaveLength(1)
    expect(inspected.databases[0].name).toBe('alice_app')

    const preview = await (await h.send('/api/account/databases/sql-preview', 'POST', {
      kind: 'create-database',
      databaseName: 'alice_store',
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_520_ci',
    }))!.json()
    expect(preview.sqlPreview).toBe('CREATE DATABASE `alice_store` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci;')

    await expect(h.send('/api/account/databases/sql-preview', 'POST', {
      kind: 'create-database',
      databaseName: 'bob_store',
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
    })).rejects.toMatchObject({ code: 'VALIDATION' })

    await expect(h.send(`/api/account/databases/${BOB_DB_ID}/charset`, 'PUT', {
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await expect(h.send(`/api/account/databases/${ALICE_DB_ID}/charset`, 'PUT', {
      charset: 'utf8mb4',
      collation: 'latin1_swedish_ci',
    })).rejects.toMatchObject({ code: 'VALIDATION' })

    const updated = await (await h.send(`/api/account/databases/${ALICE_DB_ID}/charset`, 'PUT', {
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_520_ci',
    }))!.json()
    expect(updated.charset).toBe('utf8mb4')
    expect(updated.collation).toBe('utf8mb4_unicode_520_ci')
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'account.database.charset_updated',
      target: 'database:alice_app',
    }))
  })

  it('maintains bounded monitoring history ring buffer and serves traffic/io history to root', async () => {
    const h = buildHarness(ROOT_CALLER, {
      sampleMonitoring: vi.fn(async (_caller, kind) =>
        kind === 'traffic'
          ? { observedAt: '2026-11-20T12:00:00.000Z', rxBps: 1024, txBps: 2048, summary: 'eth0 rx 1024 B/s tx 2048 B/s' }
          : { observedAt: '2026-11-20T12:00:00.000Z', readBps: 4096, writeBps: 8192, iops: 15, summary: 'nvme0n1 r 4096 B/s w 8192 B/s' }),
    })

    for (let i = 0; i < MONITORING_RING_CAPACITY + 5; i++) {
      await recordMonitoringSample(h.helpers.store, 'traffic', {
        observedAt: `2026-11-20T11:${String(i % 60).padStart(2, '0')}:00.000Z`,
        rxBps: i,
        txBps: i * 2,
        summary: `sample-${i}`,
      })
    }
    const traffic = await (await h.send('/api/server/monitoring/history?kind=traffic'))!.json()
    expect(traffic.capacity).toBe(MONITORING_RING_CAPACITY)
    expect(traffic.samples).toHaveLength(MONITORING_RING_CAPACITY)
    expect(traffic.samples.at(-1).rxBps).toBe(1024)

    const io = await (await h.send('/api/server/monitoring/history?kind=io'))!.json()
    expect(io.samples).toHaveLength(1)
    expect(io.samples[0].writeBps).toBe(8192)
  })

  it('previews and applies add-on service systemd drop-ins and quarantines/deletes infected files safely', async () => {
    const h = buildHarness(ROOT_CALLER)
    const cfgRead = await (await h.send('/api/server/software/addon-services/config'))!.json()
    expect(cfgRead.services.map((s: { serviceId: string }) => s.serviceId)).toEqual(['memcached', 'rabbitmq', 'elasticsearch', 'opensearch'])

    const cfgPreview = await (await h.send('/api/server/software/addon-services/config', 'POST', {
      mode: 'preview',
      serviceId: 'memcached',
      memoryLimitMb: 512,
      bindAddress: '127.0.0.1',
      maxConnections: 2048,
    }))!.json()
    expect(cfgPreview.stateChanged).toBe(false)
    expect(cfgPreview.previewText).toContain('MemoryMax=512M')

    const cfgApplied = await (await h.send('/api/server/software/addon-services/config', 'POST', {
      mode: 'apply',
      serviceId: 'memcached',
      memoryLimitMb: 512,
      bindAddress: '127.0.0.1',
      maxConnections: 2048,
      expectedRevision: cfgRead.revision,
    }))!.json()
    expect(cfgApplied.stateChanged).toBe(true)
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'server.addon_service.config_updated',
      target: 'memcached.service',
    }))

    // Antivirus quarantine + delete
    const badOne = join(homeBase, 'alice', 'public_html', 'shell.php')
    const badTwo = join(homeBase, 'alice', 'public_html', 'dropper.php')
    await writeFile(badOne, '<?php eval($_POST["x"]);')
    await writeFile(badTwo, '<?php system("id");')

    await expect(h.send('/api/server/security-tools/antivirus/quarantine', 'POST', {
      account: 'alice',
      path: '../bob/secret.php',
    })).rejects.toMatchObject({ code: 'VALIDATION' })

    const qRes = await (await h.send('/api/server/security-tools/antivirus/quarantine', 'POST', {
      account: 'alice',
      path: '/home/alice/public_html/shell.php',
    }))!.json()
    expect(qRes.stateChanged).toBe(true)
    expect(existsSync(badOne)).toBe(false)
    expect(existsSync(qRes.quarantinedPath)).toBe(true)
    expect(await readFile(qRes.quarantinedPath, 'utf8')).toContain('eval')
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'server.security_tools.antivirus_quarantined',
      target: 'account:alice',
    }))

    const dRes = await (await h.send('/api/server/security-tools/antivirus/delete', 'POST', {
      account: 'alice',
      path: 'public_html/dropper.php',
    }))!.json()
    expect(dRes.stateChanged).toBe(true)
    expect(existsSync(badTwo)).toBe(false)
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'server.security_tools.antivirus_deleted',
      target: 'account:alice',
    }))

    // Confined traversal: an intermediate symlink directory under account home must be refused without touching external files.
    const externalDir = join(root, 'external-victim-dir')
    await mkdir(externalDir, { recursive: true })
    const externalVictim = join(externalDir, 'victim.txt')
    await writeFile(externalVictim, 'keep-me-safe')
    await symlink(externalDir, join(homeBase, 'alice', 'uploads'))

    await expect(h.send('/api/server/security-tools/antivirus/delete', 'POST', {
      account: 'alice',
      path: 'uploads/victim.txt',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    await expect(h.send('/api/server/security-tools/antivirus/quarantine', 'POST', {
      account: 'alice',
      path: 'uploads/victim.txt',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(existsSync(externalVictim)).toBe(true)

    // Fail closed when host apply adapters are unavailable.
    const disconnectedRoot = buildHarness(ROOT_CALLER, {
      applyServerPhpIni: undefined,
      applyAddonServiceConfig: undefined,
    })
    const iniRead = await (await disconnectedRoot.send('/api/server/php/ini'))!.json()
    await expect(disconnectedRoot.send('/api/server/php/ini/apply', 'POST', {
      version: '8.3',
      ini: { memory_limit: '256M' },
      expectedRevision: iniRead.revision,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false, reason: 'server_php_ini_apply_unavailable' } })

    const addonRead = await (await disconnectedRoot.send('/api/server/software/addon-services/config'))!.json()
    await expect(disconnectedRoot.send('/api/server/software/addon-services/config', 'POST', {
      mode: 'apply',
      serviceId: 'memcached',
      memoryLimitMb: 512,
      bindAddress: '127.0.0.1',
      maxConnections: 2048,
      expectedRevision: addonRead.revision,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false, reason: 'addon_service_apply_unavailable' } })

    const disconnectedAlice = buildHarness(ALICE_CALLER, { applyDatabaseCharset: undefined })
    await expect(disconnectedAlice.send(`/api/account/databases/${ALICE_DB_ID}/charset`, 'PUT', {
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_520_ci',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false, reason: 'database_charset_apply_unavailable' } })
  })
})
