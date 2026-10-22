import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Account, PhpSettings } from '@xpanel/core'
import {
  createApiToken,
  createResellerPrincipal,
  createRootPrincipal,
  createTestDb,
  createUserPrincipal,
  setTotpSecret,
} from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { hashPasswordArgon2id, sealTotpSecret, sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'
import type { ApiApp } from './server.ts'

const SERVER_SECRET = 'test-only-s01-route-matrix-secret-at-least-32-bytes'
const php: PhpSettings = {
  version: '8.3',
  handler: 'fpm',
  fpm: {
    mode: 'ondemand',
    maxChildren: 2,
    startServers: 1,
    minSpareServers: 1,
    maxSpareServers: 1,
    maxRequests: 50,
    processIdleTimeoutSec: 10,
  },
  ini: {},
}

let passwordHash: string
beforeAll(async () => {
  passwordHash = await hashPasswordArgon2id('MatrixFixturePassword!2026')
})

describe('S01 central authorization route matrix & multi-principal invariants', () => {
  let db: TestDbHandle
  let state: TestStateStoreHandle
  let app: ApiApp
  let rootId: string
  let resellerFullId: string
  let resellerNoAclId: string
  let alice: Account
  let bob: Account
  let alicePrincipalId: string
  let bobPrincipalId: string
  let featureListId: string
  let aliceInboxUserId: string
  let aliceSupportUserId: string

  beforeEach(async () => {
    db = await createTestDb()
    state = await createTestStateStore()

    rootId = (
      await createRootPrincipal(db.db, {
        username: 'root',
        passwordHash,
        forcePasswordChange: false,
      })
    ).id
    await setTotpSecret(
      db.db,
      rootId,
      sealTotpSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', SERVER_SECRET),
      [],
    )

    const resellerFull = await state.store.createReseller({
      username: 'resellerfull',
      passwordHash,
      acl: [
        'list-accounts',
        'create-account',
        'edit-account',
        'suspend-account',
        'terminate-account',
        'change-plan',
        'manage-plans',
        'manage-feature-lists',
        'manage-dns',
        'manage-ssl',
        'change-password',
      ],
      maxAccounts: 10,
      totalDiskMb: 50000,
      totalBandwidthMb: 500000,
      oversell: false,
      nameservers: ['ns1.reseller.test'],
      delegatedIps: ['192.0.2.10'],
    })
    resellerFullId = resellerFull.id
    await createResellerPrincipal(db.db, {
      id: resellerFull.id,
      username: resellerFull.username,
      passwordHash,
    })

    const resellerNoAcl = await state.store.createReseller({
      username: 'resellernoacl',
      passwordHash,
      acl: [],
      maxAccounts: 10,
      totalDiskMb: 50000,
      totalBandwidthMb: 500000,
      oversell: false,
      nameservers: [],
      delegatedIps: [],
    })
    resellerNoAclId = resellerNoAcl.id
    await createResellerPrincipal(db.db, {
      id: resellerNoAcl.id,
      username: resellerNoAcl.username,
      passwordHash,
    })

    featureListId = (
      await state.store.createFeatureList({
        name: 'Matrix Feature List',
        ownerId: null,
        disabled: [],
      })
    ).id
    const plan = await state.store.createPlan({
      name: 'Matrix Plan',
      ownerId: null,
      featureListId,
      resources: {
        diskMb: 5000,
        bandwidthMbMonth: 50000,
        ioReadBps: 1048576,
        ioWriteBps: 1048576,
        ioReadIops: 100,
        ioWriteIops: 100,
        memoryMb: 512,
        maxProcesses: 32,
        cpuPercent: 100,
      },
      caps: {
        addonDomains: 10,
        aliasDomains: 10,
        subdomains: 10,
        mailboxes: 10,
        forwarders: 10,
        mailingLists: 10,
        ftpAccounts: 10,
        databases: 10,
        phpWorkers: 8,
      },
      dedicatedIp: false,
      shell: 'jailed',
      defaultMailboxQuotaMb: 250,
    })

    alice = await state.store.createAccount({
      username: 'alice',
      passwordHash,
      primaryDomain: 'alice.example.test',
      planId: plan.id,
      ownerId: resellerFull.id,
      contactEmail: 'owner@alice.example.test',
      ipv4: '192.0.2.10',
      shell: 'jailed',
      php,
    })
    bob = await state.store.createAccount({
      username: 'bobby',
      passwordHash,
      primaryDomain: 'bob.example.test',
      planId: plan.id,
      ownerId: null,
      contactEmail: 'owner@bob.example.test',
      ipv4: '192.0.2.10',
      shell: 'jailed',
      php,
    })

    alicePrincipalId = (
      await createUserPrincipal(db.db, {
        username: alice.username,
        accountId: alice.id,
        passwordHash,
      })
    ).id
    bobPrincipalId = (
      await createUserPrincipal(db.db, {
        username: bob.username,
        accountId: bob.id,
        passwordHash,
      })
    ).id

    aliceInboxUserId = (
      await state.store.createServiceUser({
        accountId: alice.id,
        login: `inbox@${alice.primaryDomain}`,
        passwordHash: `{ARGON2ID}${passwordHash}`,
        services: { email: true, ftp: false, webdisk: false },
        mailboxQuotaMb: 250,
        ftpDir: 'public_html',
      })
    ).id
    aliceSupportUserId = (
      await state.store.createServiceUser({
        accountId: alice.id,
        login: `support@${alice.primaryDomain}`,
        passwordHash: `{ARGON2ID}${passwordHash}`,
        services: { email: true, ftp: false, webdisk: false },
        mailboxQuotaMb: 250,
        ftpDir: 'public_html',
      })
    ).id
    await state.store.createServiceUser({
      accountId: bob.id,
      login: `inbox@${bob.primaryDomain}`,
      passwordHash: `{ARGON2ID}${passwordHash}`,
      services: { email: true, ftp: false, webdisk: false },
      mailboxQuotaMb: 250,
      ftpDir: 'public_html',
    })

    app = createApiApp({ db: db.db, store: state.store, serverSecret: SERVER_SECRET })
  })

  afterEach(async () => {
    await state.close()
    await db.close()
  })

  const tokenFor = async (principalId: string, scopes: string[]) => {
    const raw = `xp_${randomUUID()}`
    await createApiToken(db.db, {
      principalId,
      name: 'Matrix token',
      tokenHash: sha256Hex(raw),
      scopes,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    })
    return raw
  }

  const request = (token: string, path: string, method = 'GET', body?: unknown) =>
    app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    )

  it('validates that docs/planning/authorization-route-matrix.json covers HTTP, WS, HTML UI, CLI, and Agent surfaces', async () => {
    const matrixPath = join(process.cwd(), 'docs/planning/authorization-route-matrix.json')
    const raw = JSON.parse(await readFile(matrixPath, 'utf8')) as {
      schemaVersion: string
      package: string
      gapsCovered: string[]
      surfaces: Record<string, string>
      routes: {
        method: string
        path: string
        surface: 'api' | 'websocket' | 'html' | 'cli' | 'agent' | string
        resource: string
        requiredScope: string | null
        resellerAcl: string | null
        featureEntitlement: string[]
        ownershipSource: string
        allowedPrincipals: string[]
        enforcementPoint: string
      }[]
    }

    expect(raw.package).toBe('S01')
    expect(raw.gapsCovered).toEqual(
      expect.arrayContaining(['A05', 'A06', 'A07', 'A08', 'A12', 'A30', 'A34', 'A46']),
    )
    expect(raw.routes.filter(r => r.surface === 'api').length).toBeGreaterThanOrEqual(100)
    expect(raw.routes.filter(r => r.surface === 'websocket').length).toBeGreaterThanOrEqual(1)
    expect(raw.routes.filter(r => r.surface === 'html').length).toBeGreaterThanOrEqual(5)
    expect(raw.routes.filter(r => r.surface === 'cli').length).toBeGreaterThanOrEqual(5)
    expect(raw.routes.filter(r => r.surface === 'agent').length).toBeGreaterThanOrEqual(10)

    for (const route of raw.routes) {
      expect(route.method).toBeTruthy()
      expect(route.path).toBeTruthy()
      expect(Array.isArray(route.allowedPrincipals)).toBe(true)
      expect(route.enforcementPoint).toBeTruthy()
    }
  })

  it('enforces root-only administrative routes across reseller, user, and mailbox principals with zero side effects', async () => {
    const rootToken = await tokenFor(rootId, ['*'])
    const resellerToken = await tokenFor(resellerFullId, ['*'])
    const userToken = await tokenFor(alicePrincipalId, ['*'])
    const mailboxToken = await tokenFor(alicePrincipalId, [`mailbox:${aliceInboxUserId}`, 'webmail:*'])

    const rootOnlyProbes: { method: string; path: string; body?: unknown }[] = [
      { method: 'GET', path: '/api/setup/wizard' },
      { method: 'POST', path: '/api/server/hostname', body: { hostname: 'unauthorized.example.test' } },
      { method: 'POST', path: '/api/server/quotas/init', body: {} },
      { method: 'GET', path: '/api/server/settings' },
      { method: 'GET', path: '/api/server/fine-settings' },
      { method: 'GET', path: '/api/firewall' },
      { method: 'GET', path: '/api/generations' },
      { method: 'GET', path: '/api/mail/ips' },
      { method: 'GET', path: '/api/mail/caldav-carddav' },
      { method: 'GET', path: '/api/transfers/sessions' },
      { method: 'POST', path: '/api/lifecycle/cpanel-import', body: { username: 'rogueimport' } },
      { method: 'GET', path: '/api/cluster/nodes' },
      { method: 'PUT', path: '/api/branding', body: { companyName: 'Hijacked' } },
      { method: 'PUT', path: '/api/languages/en', body: { overrides: { a: 'b' } } },
      { method: 'GET', path: '/api/whmcs' },
    ]

    for (const probe of rootOnlyProbes) {
      for (const nonRootToken of [resellerToken, userToken, mailboxToken]) {
        const res = await request(nonRootToken, probe.path, probe.method, probe.body)
        expect(res.status, `${probe.method} ${probe.path}`).toBe(403)
      }
    }

    // Root succeeds on GET probes
    for (const probe of rootOnlyProbes.filter(p => p.method === 'GET')) {
      const res = await request(rootToken, probe.path, 'GET')
      expect(res.status, `root GET ${probe.path}`).toBe(200)
    }
  })

  it('enforces cross-account 404 isolation and reseller ACL / ownership checks across extended and core routes', async () => {
    const rootToken = await tokenFor(rootId, ['*'])
    const resellerFullToken = await tokenFor(resellerFullId, ['*'])
    const resellerNoAclToken = await tokenFor(resellerNoAclId, ['*'])
    const aliceToken = await tokenFor(alicePrincipalId, ['*'])
    const bobToken = await tokenFor(bobPrincipalId, ['*'])

    // Create resources for both alice and bob via root
    expect(
      (
        await request(rootToken, '/api/databases/postgres', 'POST', {
          accountId: alice.id,
          name: 'analytics',
        })
      ).status,
    ).toBe(201)
    const bobPgRes = await request(rootToken, '/api/databases/postgres', 'POST', {
      accountId: bob.id,
      name: 'secretpg',
    })
    expect(bobPgRes.status).toBe(201)
    const bobPgId = ((await bobPgRes.json()) as { database: { id: string } }).database.id

    const bobMongoRes = await request(rootToken, '/api/databases/mongo', 'POST', {
      accountId: bob.id,
      name: 'secretmongo',
    })
    expect(bobMongoRes.status).toBe(201)
    const bobMongoId = ((await bobMongoRes.json()) as { database: { id: string } }).database.id

    // Alice cannot create a Postgres user referencing Bob's Postgres database ID
    expect(
      (
        await request(aliceToken, '/api/databases/postgres/users', 'POST', {
          username: 'reader',
          password: 'ValidPgPassword!2026',
          databaseIds: [bobPgId],
        })
      ).status,
    ).toBe(404)

    // Alice cannot delete Bob's Postgres or Mongo database
    expect((await request(aliceToken, `/api/databases/postgres/${bobPgId}`, 'DELETE')).status).toBe(404)
    expect((await request(aliceToken, `/api/databases/mongo/${bobMongoId}`, 'DELETE')).status).toBe(404)

    // Alice cannot run database maintenance on Bob's account or Bob's database namespace
    expect(
      (
        await request(aliceToken, `/api/databases/${bob.id}/maintenance`, 'POST', {
          operation: 'repair',
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await request(aliceToken, '/api/databases/repair', 'POST', {
          accountId: bob.id,
          operation: 'repair',
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await request(aliceToken, `/api/databases/${alice.id}/maintenance`, 'POST', {
          database: `${bob.username}_app`,
          operation: 'repair',
        })
      ).status,
    ).toBe(403)

    // Alice cannot create backup snapshots for Bob's account or list Bob's snapshots
    expect(
      (
        await request(aliceToken, '/api/backups/snapshots', 'POST', {
          accountId: bob.id,
          files: [{ path: 'index.php', content: 'test' }],
        })
      ).status,
    ).toBe(404)
    expect((await request(aliceToken, `/api/backups/snapshots?accountId=${bob.id}`)).status).toBe(404)

    // Alice cannot install an app on Bob's domain even under her own account route
    expect(
      (
        await request(aliceToken, `/api/apps/${alice.id}`, 'POST', {
          appType: 'wordpress',
          domain: bob.primaryDomain,
        })
      ).status,
    ).toBe(404)

    // Reseller with full ACL can access owned account (alice) but gets 404 on unowned account (bob)
    expect((await request(resellerFullToken, `/api/web-features/${alice.id}/extras`)).status).toBe(200)
    expect((await request(resellerFullToken, `/api/web-features/${bob.id}/extras`)).status).toBe(404)
    expect((await request(resellerFullToken, `/api/git/${alice.id}/repos`)).status).toBe(200)
    expect((await request(resellerFullToken, `/api/git/${bob.id}/repos`)).status).toBe(404)
    expect((await request(resellerFullToken, `/api/cache/${alice.id}`)).status).toBe(200)
    expect((await request(resellerFullToken, `/api/cache/${bob.id}`)).status).toBe(404)
    expect((await request(resellerFullToken, `/api/containers/${alice.id}`)).status).toBe(200)
    expect((await request(resellerFullToken, `/api/containers/${bob.id}`)).status).toBe(404)
    expect((await request(resellerFullToken, `/api/apps/${alice.id}`)).status).toBe(200)
    expect((await request(resellerFullToken, `/api/apps/${bob.id}`)).status).toBe(404)

    // Reseller without ACL gets 403 even on an account transferred to them
    await state.store.changeOwner(bob.id, resellerNoAclId)
    expect((await request(resellerNoAclToken, `/api/accounts/${bob.id}`)).status).toBe(403)
    expect((await request(resellerNoAclToken, `/api/web-features/${bob.id}/extras`)).status).toBe(403)
    expect((await request(resellerNoAclToken, `/api/git/${bob.id}/repos`)).status).toBe(403)
    expect((await request(resellerNoAclToken, `/api/cache/${bob.id}`)).status).toBe(403)
    expect((await request(resellerNoAclToken, `/api/containers/${bob.id}`)).status).toBe(403)
    expect((await request(resellerNoAclToken, `/api/apps/${bob.id}`)).status).toBe(403)

    // Bob's own token still works when owned by resellerNoAcl
    expect((await request(bobToken, `/api/accounts/${bob.id}`)).status).toBe(200)
  })

  it('enforces feature-list entitlements across every feature-gated route family', async () => {
    const aliceToken = await tokenFor(alicePrincipalId, ['*'])

    const featureCases: {
      feature: string
      method: string
      path: string
      body?: unknown
    }[] = [
      { feature: 'mysql-databases', method: 'GET', path: '/api/databases' },
      { feature: 'postgresql-databases', method: 'GET', path: '/api/databases/postgres' },
      { feature: 'postgresql-databases', method: 'GET', path: '/api/databases/postgres/users' },
      { feature: 'mysql-databases', method: 'GET', path: `/api/databases/${alice.id}/remote-hosts` },
      { feature: 'domains', method: 'GET', path: '/api/domains' },
      { feature: 'zone-editor', method: 'GET', path: '/api/dns/zones' },
      { feature: 'forwarders', method: 'GET', path: '/api/mail/forwarders' },
      { feature: 'domain-forwarders', method: 'GET', path: '/api/mail/domain-forwarders' },
      { feature: 'mailing-lists', method: 'GET', path: '/api/mail/mailing-lists' },
      { feature: 'email-accounts', method: 'GET', path: '/api/mail/spam-settings' },
      { feature: 'email-filters', method: 'GET', path: '/api/mail/filters' },
      { feature: 'email-accounts', method: 'GET', path: '/api/mail/delivery-reports' },
      { feature: 'email-accounts', method: 'GET', path: `/api/webmail/messages?mailbox=${encodeURIComponent(`inbox@${alice.primaryDomain}`)}` },
      { feature: 'email-accounts', method: 'GET', path: `/api/webmail/calendars?mailbox=${encodeURIComponent(`inbox@${alice.primaryDomain}`)}` },
      { feature: 'email-accounts', method: 'GET', path: `/api/webmail/contacts?mailbox=${encodeURIComponent(`inbox@${alice.primaryDomain}`)}` },
      { feature: 'backup', method: 'GET', path: `/api/backups/snapshots?accountId=${alice.id}` },
      { feature: 'directory-privacy', method: 'GET', path: `/api/web-features/${alice.id}/directory-privacy` },
      { feature: 'hotlink-protection', method: 'GET', path: `/api/web-features/${alice.id}/hotlink-protection` },
      { feature: 'web-disk', method: 'GET', path: `/api/web-features/${alice.id}/web-disk` },
      { feature: 'file-manager', method: 'GET', path: `/api/web-features/${alice.id}/extras` },
      { feature: 'git-version-control', method: 'GET', path: `/api/git/${alice.id}/repos` },
      { feature: 'account-cache-services', method: 'GET', path: `/api/cache/${alice.id}` },
      { feature: 'account-containers', method: 'GET', path: `/api/containers/${alice.id}` },
      { feature: 'web-apps', method: 'GET', path: `/api/apps/${alice.id}` },
    ]

    for (const testCase of featureCases) {
      await state.store.updateFeatureList(featureListId, { disabled: [] })
      const allowedRes = await request(aliceToken, testCase.path, testCase.method, testCase.body)
      expect(allowedRes.status, `enabled ${testCase.feature} -> ${testCase.path}`).toBe(200)

      await state.store.updateFeatureList(featureListId, { disabled: [testCase.feature] })
      const deniedRes = await request(aliceToken, testCase.path, testCase.method, testCase.body)
      expect(deniedRes.status, `disabled ${testCase.feature} -> ${testCase.path}`).toBe(403)
    }

    await state.store.updateFeatureList(featureListId, { disabled: [] })
  })

  it('enforces mailbox principal isolation across identities, folders, messages, attachments, calendars, contacts, and filters', async () => {
    const inboxLogin = `inbox@${alice.primaryDomain}`
    const inboxToken = await tokenFor(alicePrincipalId, [`mailbox:${aliceInboxUserId}`, 'webmail:*', 'mail:*'])
    const supportToken = await tokenFor(alicePrincipalId, [`mailbox:${aliceSupportUserId}`, 'webmail:*', 'mail:*'])

    // Create identity for inbox
    const idRes = await request(inboxToken, '/api/webmail/identities', 'POST', {
      email: inboxLogin,
      displayName: 'Alice Inbox Identity',
      textSignature: '-- Alice Inbox',
    })
    expect(idRes.status).toBe(201)
    const identity = ((await idRes.json()) as { identity: { id: string; mailbox: string } }).identity
    expect(identity.mailbox).toBe(inboxLogin)

    // Support mailbox cannot PATCH or DELETE inbox's identity
    expect(
      (
        await request(supportToken, `/api/webmail/identities/${identity.id}`, 'PATCH', {
          displayName: 'Spoofed',
        })
      ).status,
    ).toBe(404)
    expect((await request(supportToken, `/api/webmail/identities/${identity.id}`, 'DELETE')).status).toBe(404)

    // Inbox can PATCH and DELETE its own identity
    expect(
      (
        await request(inboxToken, `/api/webmail/identities/${identity.id}`, 'PATCH', {
          displayName: 'Alice Verified Inbox',
        })
      ).status,
    ).toBe(200)
    expect((await request(inboxToken, `/api/webmail/identities/${identity.id}`, 'DELETE')).status).toBe(200)

    // Support mailbox cannot list inbox's folders or attachments
    expect((await request(supportToken, `/api/webmail/folders?mailbox=${encodeURIComponent(inboxLogin)}`)).status).toBe(404)
    expect((await request(supportToken, `/api/webmail/attachments?mailbox=${encodeURIComponent(inboxLogin)}`)).status).toBe(404)
  })
})
