import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createAgentApp,
  FakeHostExecutor,
  HostReconciler,
  IoAnalyticsEngine,
  WebsiteAnalyticsEngine,
} from '@xpanel/agent'
import type { PhpSettings } from '@xpanel/core'
import { createRootPrincipal, createTestDb, createUserPrincipal } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { CSRF_HEADER_NAME, hashPasswordArgon2id, HOST_SESSION_COOKIE_NAME, parseCookies, SESSION_COOKIE_NAME } from './auth.ts'
import { policyForRequest } from './authorization.ts'
import { entryPointAllowsApiRoute } from './entry-points.ts'
import { createApiApp } from './server.ts'
import type { ApiApp } from './server.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

const OS_RELEASE = ['ID=ubuntu', 'VERSION_ID="24.04"', 'VERSION_CODENAME=noble', 'NAME="Ubuntu"'].join('\n')
const OS = profileFor(OS_RELEASE)
const php: PhpSettings = {
  version: '8.3',
  handler: 'fpm',
  fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 },
  ini: {},
}

describe('account certificate issuance', () => {
  let tmpDir: string
  let db: TestDbHandle
  let state: TestStateStoreHandle
  let executor: FakeHostExecutor
  let app: ApiApp
  let passwordHash: string

  beforeAll(async () => {
    passwordHash = await hashPasswordArgon2id('CertificatePassword!2026')
  })

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xpanel-cert-'))
    db = await createTestDb()
    state = await createTestStateStore()
    executor = new FakeHostExecutor()
    await executor.writeFile({ path: '/etc/os-release', content: OS_RELEASE, mode: 0o644, owner: 'root', group: 'root' })
    const reconciler = new HostReconciler({
      store: state.store,
      db: db.db,
      executor,
      os: OS,
      quotaFilesystem: '/home',
      ioDevices: ['/dev/nvme0n1'],
    })
    const agentApp = createAgentApp({
      agentToken: TEST_AGENT_TOKEN,
      reconciler,
      store: state.store,
      db: db.db,
      executor,
      ioAnalytics: new IoAnalyticsEngine(),
      websiteAnalytics: new WebsiteAnalyticsEngine(),
      os: { id: OS.id, versionId: OS.versionId, family: OS.family },
      homeBaseDir: join(tmpDir, 'host'),
    })
    await createRootPrincipal(db.db, { username: 'root', passwordHash, forcePasswordChange: false })
    const features = await state.store.createFeatureList({ name: 'Cert features', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({
      name: 'Cert plan',
      ownerId: null,
      featureListId: features.id,
      resources: {
        diskMb: 5000, bandwidthMbMonth: 50000, ioReadBps: 1048576, ioWriteBps: 1048576,
        ioReadIops: 100, ioWriteIops: 100, memoryMb: 512, maxProcesses: 32, cpuPercent: 100,
      },
      caps: {
        addonDomains: 10, aliasDomains: 10, subdomains: 10, mailboxes: 10, forwarders: 10,
        mailingLists: 10, ftpAccounts: 10, databases: 10, phpWorkers: 8,
      },
      dedicatedIp: false,
      shell: 'jailed',
      defaultMailboxQuotaMb: 250,
    })
    await state.store.saveServerIp({
      address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared',
      ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '',
    })
    const alice = await state.store.createAccount({
      username: 'alice', passwordHash, primaryDomain: 'alice.example.test', planId: plan.id, ownerId: null,
      contactEmail: 'owner@alice.example.test', ipv4: '192.0.2.10', shell: 'jailed', php,
    })
    const bob = await state.store.createAccount({
      username: 'bobby', passwordHash, primaryDomain: 'bob.example.test', planId: plan.id, ownerId: null,
      contactEmail: 'owner@bob.example.test', ipv4: '192.0.2.10', shell: 'jailed', php,
    })
    await createUserPrincipal(db.db, { username: alice.username, accountId: alice.id, passwordHash })
    await createUserPrincipal(db.db, { username: bob.username, accountId: bob.id, passwordHash })
    app = createApiApp({
      agentToken: TEST_AGENT_TOKEN,
      serverSecret: TEST_SERVER_SECRET,
      db: db.db,
      store: state.store,
      agentApp,
      os: OS,
    })
  })

  afterEach(async () => {
    await state.close()
    await db.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  const session = async (username: string) => {
    const login = await app.fetch(new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'CertificatePassword!2026' }),
    }), { remoteAddress: '192.0.2.5' })
    expect(login.status).toBe(200)
    const body = await login.json() as { csrfToken?: string }
    const cookies = parseCookies(login.headers.get('set-cookie')?.split(',').map(part => part.split(';')[0]?.trim()).filter(Boolean).join('; ') ?? null)
    const name = cookies[HOST_SESSION_COOKIE_NAME] ? HOST_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME
    return async (path: string, payload: unknown) => app.fetch(new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${name}=${cookies[name]}`,
        [CSRF_HEADER_NAME]: body.csrfToken ?? '',
      },
      body: JSON.stringify(payload),
    }), { remoteAddress: '192.0.2.5' })
  }

  it('keeps issuance on the account entry points and the ssl-install policy', () => {
    expect(entryPointAllowsApiRoute('xpanel', '/api/accounts/alice/certificates', 'POST')).toBe(true)
    expect(entryPointAllowsApiRoute('xpanel', '/api/accounts/alice/certificates', 'GET')).toBe(false)
    expect(entryPointAllowsApiRoute('xwhm', '/api/accounts/alice/certificates', 'POST')).toBe(true)
    expect(entryPointAllowsApiRoute('xmail', '/api/accounts/alice/certificates', 'POST')).toBe(false)
    expect(policyForRequest('/api/accounts/alice/certificates', 'POST')).toMatchObject({ acl: 'manage-ssl', toolIds: ['ssl-install'] })
  })

  it('refuses a missing or foreign domain and surfaces a certificate authority failure without saving a certificate', async () => {
    const root = await session('root')
    const alice = await session('alice')
    const missing = await root('/api/accounts/alice/certificates', {})
    expect(missing.status).toBe(422)
    expect((await missing.json() as { detail: string }).detail).toMatch(/domain is required/)

    const foreign = await root('/api/accounts/alice/certificates', { domain: 'bob.example.test' })
    expect(foreign.status).toBe(404)
    const otherAccount = await alice('/api/accounts/bobby/certificates', { domain: 'bob.example.test' })
    expect(otherAccount.status).toBe(404)

    const failed = await root('/api/accounts/alice/certificates', {
      domain: 'alice.example.test',
      directoryUrl: 'http://127.0.0.1:1/directory',
    })
    expect(failed.status).toBe(422)
    const problem = await failed.json() as { detail: string }
    expect(problem.detail).toMatch(/certificate authority could not be reached/)
    expect(await state.store.listCertificates()).toEqual([])
  })
})
