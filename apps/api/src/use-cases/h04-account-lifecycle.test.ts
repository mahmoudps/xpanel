import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { FakeHostExecutor, HostReconciler } from '@xpanel/agent'
import {
  sliceUnit,
  type PhpSettings,
  type Principal,
} from '@xpanel/core'
import {
  createApiToken,
  createDb,
  createSession,
  findActiveApiTokenByHash,
  findActiveSessionByTokenHash,
  findPrincipalByAccountId,
  listIndexedAccounts,
  migrate,
} from '@xpanel/db'
import { parseOsRelease, profileFor } from '@xpanel/os'
import { StateStore } from '@xpanel/state'
import {
  AccountLifecycleCoordinator,
  SimulatedProvisionCrashError,
  userSliceUnit,
} from './account-lifecycle.ts'

// ---------------------------------------------------------------------------
// Test Fixture Helpers
// ---------------------------------------------------------------------------

const TEST_ARGON2_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'

const TEST_SERVICE_HASH = `{ARGON2ID}${TEST_ARGON2_HASH}`

const DEFAULT_PHP: PhpSettings = {
  version: '8.3',
  handler: 'fpm',
  fpm: {
    mode: 'ondemand',
    maxChildren: 8,
    startServers: 2,
    minSpareServers: 1,
    maxSpareServers: 4,
    maxRequests: 500,
    processIdleTimeoutSec: 10,
  },
  ini: {
    memory_limit: '256M',
  },
}

const ROOT_ACTOR: Principal = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'root',
  username: 'root',
}

const MIB = 1024 * 1024

async function createTestHarness() {
  const dir = await mkdtemp(join(tmpdir(), 'xpanel-h04-test-'))
  const stateRoot = join(dir, 'state')
  const dbHandle = createDb(':memory:')
  await migrate(dbHandle.runner)

  const store = new StateStore(stateRoot)

  await store.saveServerSettings({
    hostname: 'panel.xpanel.test',
    nameservers: ['ns1.xpanel.test', 'ns2.xpanel.test'],
    adminEmail: 'admin@xpanel.test',
    engine: 'apache',
    apacheMpm: 'itk',
    panelPort: 2087,
    sshPort: 22,
    nginx: {
      workerProcesses: 'auto',
      workerConnections: 2048,
      workerRlimitNofile: 65535,
      multiAccept: true,
      keepaliveTimeoutSec: 65,
    },
    apache: {
      startServers: 4,
      minSpareServers: 4,
      maxSpareServers: 16,
      maxRequestWorkers: 150,
      maxConnectionsPerChild: 4000,
      serverLimit: 150,
    },
    backendPort: 8080,
    backendTlsPort: 8443,
  })
  await store.markSetupComplete()

  for (const address of ['203.0.113.10', '203.0.113.11', '203.0.113.12', '203.0.113.15', '203.0.113.20', '203.0.113.21', '203.0.113.30', '203.0.113.40', '203.0.113.41', '203.0.113.42']) {
    await store.saveServerIp({ address, version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: address === '203.0.113.10', notes: '' })
  }
  await store.saveServerIp({ address: '2001:db8::10', version: 6, prefixLength: 64, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const featureList = await store.createFeatureList({
    name: 'default-full',
    ownerId: null,
    disabled: [],
  })

  const standardPlan = await store.createPlan({
    name: 'Standard-10G',
    ownerId: null,
    featureListId: featureList.id,
    resources: {
      diskMb: 10240,
      bandwidthMbMonth: 102400,
      cpuPercent: 200,
      memoryMb: 2048,
      ioReadBps: 100 * MIB,
      ioWriteBps: 100 * MIB,
      ioReadIops: 1000,
      ioWriteIops: 1000,
      maxProcesses: 80,
    },
    caps: {
      addonDomains: 5,
      aliasDomains: 10,
      subdomains: 10,
      databases: 5,
      mailboxes: 10,
      forwarders: 20,
      mailingLists: 5,
      ftpAccounts: 5,
      phpWorkers: 8,
    },
    dedicatedIp: false,
    shell: 'jailed',
    defaultMailboxQuotaMb: 1024,
  })

  const os = profileFor(parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\n'))
  const executor = new FakeHostExecutor()
  const reconciler = new HostReconciler({
    store,
    db: dbHandle.runner,
    executor,
    os,
    quotaFilesystem: '/',
  })

  const coordinator = new AccountLifecycleCoordinator({
    store,
    db: dbHandle.runner,
    reconciler,
    executor,
  })

  return {
    dir,
    store,
    db: dbHandle.runner,
    dbHandle,
    executor,
    reconciler,
    coordinator,
    featureList,
    standardPlan,
    os,
    cleanup: async () => {
      await dbHandle.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// H04 Account Lifecycle Suite
// ---------------------------------------------------------------------------

describe('H04 Account Lifecycle Coordinator (Plans, Resellers, Provisioning, Suspension, Termination)', () => {
  it('provisions a full account end-to-end with 0750 home dir, cgroup slice, quota, PHP-FPM, vhosts, DNS zone, and idempotent job state', async () => {
    const h = await createTestHarness()
    try {
      const result = await h.coordinator.provisionAccount({
        actor: ROOT_ACTOR,
        username: 'tenanta',
        primaryDomain: 'tenanta.example.com',
        planId: h.standardPlan.id,
        ownerId: null,
        contactEmail: 'ops@tenanta.example.com',
        ipv4: '203.0.113.10',
        ipv6: '2001:db8::10',
        shell: 'jailed',
        php: DEFAULT_PHP,
        passwordHash: TEST_ARGON2_HASH,
      })

      assert.equal(result.account.username, 'tenanta')
      assert.equal(result.account.uid, 20000)
      assert.equal(result.account.gid, 20000)
      assert.equal(result.account.status, 'active')
      assert.equal(result.job.status, 'succeeded')
      assert.equal(result.job.progress, 100)
      assert.equal(result.reconciliation?.status, 'applied')

      // Verify Linux user, group, 0750 home directory, and quota on FakeHostExecutor
      assert.equal(h.executor.groups.get('tenanta'), 20000)
      const linuxUser = h.executor.users.get('tenanta')
      assert.ok(linuxUser)
      assert.equal(linuxUser.uid, 20000)
      assert.equal(linuxUser.home, '/home/tenanta')
      assert.equal(linuxUser.shell, '/opt/xpanel/bin/jailshell')

      const homeDir = h.executor.dirs.get('/home/tenanta')
      assert.ok(homeDir)
      assert.equal(homeDir.mode, 0o750)
      assert.equal(homeDir.owner, 'tenanta')
      assert.equal(homeDir.group, 'tenanta')

      const docRoot = h.executor.dirs.get('/home/tenanta/public_html')
      assert.ok(docRoot)
      assert.equal(docRoot.mode, 0o750)

      const quota = h.executor.quotas.get('tenanta')
      assert.ok(quota)
      assert.equal(quota.blockHardKb, 10240 * 1024)

      // Verify cgroup v2 slice, Nginx edge vhost, Apache backend vhost, PHP-FPM pool & unit, and DNS zone
      assert.ok(h.executor.files.has('/etc/systemd/system/xpanel-20000.slice'))
      assert.ok(h.executor.files.has('/etc/systemd/system/user-20000.slice.d/50-xpanel.conf'))
      assert.ok(h.executor.files.has('/etc/nginx/conf.d/xpanel-tenanta.conf'))
      assert.ok(h.executor.files.has('/etc/apache2/sites-enabled/xpanel-site-tenanta.example.com.conf'))
      assert.ok(h.executor.files.has('/etc/xpanel/php-fpm/8.3/tenanta.pool.conf'))
      assert.ok(h.executor.files.has('/etc/systemd/system/xpanel-php-fpm-tenanta-8.3.service'))
      assert.ok(h.executor.files.has('/var/lib/powerdns/zones/tenanta.example.com.zone'))

      const fpmUnit = h.executor.units.get('xpanel-php-fpm-tenanta-8.3.service')
      assert.ok(fpmUnit)
      assert.equal(fpmUnit.enabled, true)
      assert.equal(fpmUnit.active, true)

      // Verify SQLite principal and search index
      const principal = await findPrincipalByAccountId(h.db, result.account.id)
      assert.ok(principal)
      assert.equal(principal.username, 'tenanta')
      assert.equal(principal.disabled, false)

      const indexed = await listIndexedAccounts(h.db)
      assert.equal(indexed.length, 1)
      assert.equal(indexed[0]?.username, 'tenanta')

      // Calling provisionAccount again with same username/idempotencyKey is idempotent
      const duplicateCall = await h.coordinator.provisionAccount({
        actor: ROOT_ACTOR,
        username: 'tenanta',
        primaryDomain: 'tenanta.example.com',
        planId: h.standardPlan.id,
        ownerId: null,
        contactEmail: 'ops@tenanta.example.com',
        ipv4: '203.0.113.10',
        ipv6: '2001:db8::10',
        shell: 'jailed',
        php: DEFAULT_PHP,
        passwordHash: TEST_ARGON2_HASH,
      })
      assert.equal(duplicateCall.account.id, result.account.id)
      assert.equal(duplicateCall.account.uid, 20000)
    } finally {
      await h.cleanup()
    }
  })

  it('handles mid-create failures without orphaned state, permanently burns failed UIDs, and resumes checkpointed jobs', async () => {
    const h = await createTestHarness()
    try {
      // Case A: Failure mid-create inside StateStore after UID 20000 is allocated
      await assert.rejects(
        () =>
          h.coordinator.provisionAccount({
            actor: ROOT_ACTOR,
            username: 'midcrash',
            primaryDomain: 'midcrash.example.com',
            planId: h.standardPlan.id,
            ownerId: null,
            contactEmail: 'ops@midcrash.example.com',
            ipv4: '203.0.113.11',
            shell: 'jailed',
            php: DEFAULT_PHP,
            passwordHash: TEST_ARGON2_HASH,
            faultInjection: { failBeforeAccountJsonCommit: true },
          }),
        /injected failure before account\.json commit/,
      )

      // Partial state must be rolled back, but UID 20000 must remain permanently burnt
      assert.equal(await h.store.getAccountByUsername('midcrash'), null)
      assert.equal(await h.store.maxAllocatedUid(), 20000)

      // Retrying the same durable job succeeds cleanly and allocates fresh UID 20001 (never reuses 20000)
      const recovered = await h.coordinator.provisionAccount({
        actor: ROOT_ACTOR,
        username: 'midcrash',
        primaryDomain: 'midcrash.example.com',
        planId: h.standardPlan.id,
        ownerId: null,
        contactEmail: 'ops@midcrash.example.com',
        ipv4: '203.0.113.11',
        shell: 'jailed',
        php: DEFAULT_PHP,
        passwordHash: TEST_ARGON2_HASH,
      })
      assert.equal(recovered.account.username, 'midcrash')
      assert.equal(recovered.account.uid, 20001)
      assert.equal(recovered.job.status, 'succeeded')

      // Case B: Worker crash after Step 2 (ensure_principal_and_zone) before host reconciliation
      await assert.rejects(
        () =>
          h.coordinator.provisionAccount({
            actor: ROOT_ACTOR,
            username: 'stepresume',
            primaryDomain: 'stepresume.example.com',
            planId: h.standardPlan.id,
            ownerId: null,
            contactEmail: 'ops@stepresume.example.com',
            ipv4: '203.0.113.12',
            shell: 'jailed',
            php: DEFAULT_PHP,
            passwordHash: TEST_ARGON2_HASH,
            faultInjection: { crashAfterStep: 'ensure_principal_and_zone' },
          }),
        (err: unknown) =>
          err instanceof SimulatedProvisionCrashError &&
          err.step === 'ensure_principal_and_zone',
      )

      // Account state was created at UID 20002, but host reconciliation has not yet applied
      const partialAcc = await h.store.getAccountByUsername('stepresume')
      assert.ok(partialAcc)
      assert.equal(partialAcc.uid, 20002)
      assert.equal(h.executor.users.has('stepresume'), false)

      // Resuming the durable job picks up from step 2 without allocating a new UID, and reconciles the host
      const resumed = await h.coordinator.provisionAccount({
        actor: ROOT_ACTOR,
        username: 'stepresume',
        primaryDomain: 'stepresume.example.com',
        planId: h.standardPlan.id,
        ownerId: null,
        contactEmail: 'ops@stepresume.example.com',
        ipv4: '203.0.113.12',
        shell: 'jailed',
        php: DEFAULT_PHP,
        passwordHash: TEST_ARGON2_HASH,
      })
      assert.equal(resumed.resumedFromStep, 2)
      assert.equal(resumed.account.id, partialAcc.id)
      assert.equal(resumed.account.uid, 20002)
      assert.equal(resumed.job.status, 'succeeded')
      assert.equal(h.executor.users.has('stepresume'), true)
      assert.ok(h.executor.files.has('/etc/systemd/system/xpanel-20002.slice'))
    } finally {
      await h.cleanup()
    }
  })

  it('previews plan change impact, blocks downgrades below current usage, and applies live upgrades to slice/quota/FPM/shell', async () => {
    const h = await createTestHarness()
    try {
      const microPlan = await h.store.createPlan({
        name: 'Micro-1G',
        ownerId: null,
        featureListId: h.featureList.id,
        resources: {
          diskMb: 1024,
          bandwidthMbMonth: 10240,
          cpuPercent: 100,
          memoryMb: 512,
          ioReadBps: 50 * MIB,
          ioWriteBps: 50 * MIB,
          ioReadIops: 500,
          ioWriteIops: 500,
          maxProcesses: 20,
        },
        caps: {
          addonDomains: 0,
          aliasDomains: 1,
          subdomains: 1,
          databases: 0,
          mailboxes: 1,
          forwarders: 5,
          mailingLists: 0,
          ftpAccounts: 1,
          phpWorkers: 8,
        },
        dedicatedIp: false,
        shell: 'none',
        defaultMailboxQuotaMb: 512,
      })

      const proPlan = await h.store.createPlan({
        name: 'Pro-50G',
        ownerId: null,
        featureListId: h.featureList.id,
        resources: {
          diskMb: 51200,
          bandwidthMbMonth: 512000,
          cpuPercent: 400,
          memoryMb: 4096,
          ioReadBps: 250 * MIB,
          ioWriteBps: 250 * MIB,
          ioReadIops: 4000,
          ioWriteIops: 4000,
          maxProcesses: 160,
        },
        caps: {
          addonDomains: 20,
          aliasDomains: 50,
          subdomains: 50,
          databases: 20,
          mailboxes: 50,
          forwarders: 100,
          mailingLists: 20,
          ftpAccounts: 20,
          phpWorkers: 16,
        },
        dedicatedIp: false,
        shell: 'jailed',
        defaultMailboxQuotaMb: 2048,
      })

      const provisioned = await h.coordinator.provisionAccount({
        actor: ROOT_ACTOR,
        username: 'planuser',
        primaryDomain: 'planuser.example.com',
        planId: h.standardPlan.id,
        ownerId: null,
        contactEmail: 'ops@planuser.example.com',
        ipv4: '203.0.113.15',
        shell: 'jailed',
        php: DEFAULT_PHP,
        passwordHash: TEST_ARGON2_HASH,
      })

      // Add 1 addon domain and 1 database so usage exceeds Micro-1G caps (addonDomains: 0, databases: 0)
      await h.store.createDomain({
        accountId: provisioned.account.id,
        name: 'addon.planuser.example.com',
        kind: 'addon',
        parentId: null,
        docRoot: '/home/planuser/domains/addon.planuser.example.com/public_html',
        siteType: 'php',
        upstream: null,
        redirect: null,
        php: DEFAULT_PHP,
        wildcard: false,
        certificateId: null,
        suspended: false,
        expiresAt: null,
        pathQuotaMb: 'unlimited',
      })
      await h.store.createDatabase({
        accountId: provisioned.account.id,
        name: 'planuser_db1',
      })

      const downgradePreview = await h.coordinator.previewPlanChange(
        provisioned.account.id,
        microPlan.id,
        { actor: ROOT_ACTOR, usageOverrides: { diskMb: 2048 } },
      )
      assert.equal(downgradePreview.allowed, false)
      assert.equal(downgradePreview.impact.losesShell, true)
      const violationKeys = downgradePreview.impact.violations.map((v) => v.key)
      assert.ok(violationKeys.includes('diskMb'))
      assert.ok(violationKeys.includes('addonDomains'))
      assert.ok(violationKeys.includes('databases'))

      await assert.rejects(
        () =>
          h.coordinator.applyPlanChange({
            accountId: provisioned.account.id,
            newPlanId: microPlan.id,
            actor: ROOT_ACTOR,
            usageOverrides: { diskMb: 2048 },
          }),
        /Account usage exceeds the new plan limits/,
      )

      // Upgrade to Pro-50G
      const upgradeResult = await h.coordinator.applyPlanChange({
        accountId: provisioned.account.id,
        newPlanId: proPlan.id,
        actor: ROOT_ACTOR,
      })

      assert.equal(upgradeResult.account.planId, proPlan.id)
      assert.equal(upgradeResult.preview.allowed, true)

      // Verify host quota and slice updated
      const updatedQuota = h.executor.quotas.get('planuser')
      assert.ok(updatedQuota)
      assert.equal(updatedQuota.blockHardKb, 51200 * 1024)

      const sliceFile = h.executor.files.get('/etc/systemd/system/xpanel-20000.slice')
      assert.ok(sliceFile)
      assert.match(sliceFile.content, /CPUQuota=400%/)
      assert.match(sliceFile.content, /MemoryMax=4096M/)
      assert.match(sliceFile.content, /TasksMax=160/)
    } finally {
      await h.cleanup()
    }
  })

  it('enforces reseller capacity caps, multi-tenant visibility boundaries (A07), and root-only ownership transfer', async () => {
    const h = await createTestHarness()
    try {
      const resellerA = await h.store.createReseller({
        username: 'resellera',
        acl: [
          'create-account',
          'edit-account',
          'suspend-account',
          'terminate-account',
          'change-plan',
          'list-accounts',
        ],
        maxAccounts: 2,
        totalDiskMb: 20480,
        totalBandwidthMb: 204800,
        oversell: false,
        nameservers: ['ns1.xpanel.test', 'ns2.xpanel.test'],
        delegatedIps: ['203.0.113.20'],
        passwordHash: TEST_ARGON2_HASH,
      })

      const resellerB = await h.store.createReseller({
        username: 'resellerb',
        acl: [
          'create-account',
          'edit-account',
          'suspend-account',
          'terminate-account',
          'change-plan',
          'list-accounts',
        ],
        maxAccounts: 5,
        totalDiskMb: 51200,
        totalBandwidthMb: 512000,
        oversell: false,
        nameservers: ['ns1.xpanel.test', 'ns2.xpanel.test'],
        delegatedIps: ['203.0.113.20', '203.0.113.21'],
        passwordHash: TEST_ARGON2_HASH,
      })

      const actorA: Principal = {
        id: resellerA.id,
        kind: 'reseller',
        username: resellerA.username,
      }
      const actorB: Principal = {
        id: resellerB.id,
        kind: 'reseller',
        username: resellerB.username,
      }

      // Reseller A creates 2 accounts within its maxAccounts=2 & totalDiskMb=20480 quota
      const accA1 = await h.coordinator.provisionAccount({
        actor: actorA,
        username: 'alphaten1',
        primaryDomain: 'alphaten1.example.com',
        planId: h.standardPlan.id,
        ownerId: resellerA.id,
        contactEmail: 'ops@alphaten1.example.com',
        ipv4: '203.0.113.20',
        shell: 'jailed',
        php: DEFAULT_PHP,
        passwordHash: TEST_ARGON2_HASH,
      })

      const accA2 = await h.coordinator.provisionAccount({
        actor: actorA,
        username: 'alphaten2',
        primaryDomain: 'alphaten2.example.com',
        planId: h.standardPlan.id,
        ownerId: resellerA.id,
        contactEmail: 'ops@alphaten2.example.com',
        ipv4: '203.0.113.20',
        shell: 'jailed',
        php: DEFAULT_PHP,
        passwordHash: TEST_ARGON2_HASH,
      })

      // 3rd account under Reseller A exceeds maxAccounts=2
      await assert.rejects(
        () =>
          h.coordinator.provisionAccount({
            actor: actorA,
            username: 'alphaten3',
            primaryDomain: 'alphaten3.example.com',
            planId: h.standardPlan.id,
            ownerId: resellerA.id,
            contactEmail: 'ops@alphaten3.example.com',
            ipv4: '203.0.113.20',
            shell: 'jailed',
            php: DEFAULT_PHP,
            passwordHash: TEST_ARGON2_HASH,
          }),
        /reseller accounts limit/,
      )

      // Reseller B creates 1 account
      const accB1 = await h.coordinator.provisionAccount({
        actor: actorB,
        username: 'betaten1',
        primaryDomain: 'betaten1.example.com',
        planId: h.standardPlan.id,
        ownerId: resellerB.id,
        contactEmail: 'ops@betaten1.example.com',
        ipv4: '203.0.113.21',
        shell: 'jailed',
        php: DEFAULT_PHP,
        passwordHash: TEST_ARGON2_HASH,
      })

      // Multi-tenant isolation (A07): Reseller A cannot inspect Reseller B's summary or mutate Reseller B's account
      await assert.rejects(
        () => h.coordinator.getResellerDashboardSummary(actorA, resellerB.id),
        /another reseller/,
      )
      await assert.rejects(
        () =>
          h.coordinator.suspendAccount({
            accountId: accB1.account.id,
            reason: 'Cross-tenant attempt',
            actor: actorA,
          }),
        /another reseller/,
      )
      await assert.rejects(
        () =>
          h.coordinator.terminateAccount({
            accountId: accB1.account.id,
            confirmUsername: accB1.account.username,
            actor: actorA,
          }),
        /another reseller/,
      )
      await assert.rejects(
        () =>
          h.coordinator.transferAccountOwnership({
            accountId: accA1.account.id,
            newOwnerId: resellerB.id,
            actor: actorA,
          }),
        /only root is allowed to transfer account ownership/,
      )

      // Root transfers alphaten2 from Reseller A to Reseller B
      const transfer = await h.coordinator.transferAccountOwnership({
        accountId: accA2.account.id,
        newOwnerId: resellerB.id,
        actor: ROOT_ACTOR,
      })
      assert.equal(transfer.previousOwnerId, resellerA.id)
      assert.equal(transfer.newOwnerId, resellerB.id)
      assert.equal(transfer.account.ownerId, resellerB.id)

      const summaryA = await h.coordinator.getResellerDashboardSummary(actorA, resellerA.id)
      const summaryB = await h.coordinator.getResellerDashboardSummary(actorB, resellerB.id)
      assert.equal(summaryA.usage.accounts, 1)
      assert.equal(summaryB.usage.accounts, 2)

      // Reseller A can no longer suspend alphaten2 now that it belongs to Reseller B
      await assert.rejects(
        () =>
          h.coordinator.suspendAccount({
            accountId: accA2.account.id,
            reason: 'Old owner attempt',
            actor: actorA,
          }),
        /another reseller/,
      )
    } finally {
      await h.cleanup()
    }
  })

  it('suspends and unsuspends an account across all 10 control-plane and host surfaces (A34)', async () => {
    const h = await createTestHarness()
    try {
      const provisioned = await h.coordinator.provisionAccount({
        actor: ROOT_ACTOR,
        username: 'suspuser',
        primaryDomain: 'susp.example.com',
        planId: h.standardPlan.id,
        ownerId: null,
        contactEmail: 'ops@susp.example.com',
        ipv4: '203.0.113.30',
        shell: 'jailed',
        php: DEFAULT_PHP,
        passwordHash: TEST_ARGON2_HASH,
      })
      const accountId = provisioned.account.id
      const uid = provisioned.account.uid

      // Add active panel session and API token
      const sessionTokenHash = '1111111111111111111111111111111111111111111111111111111111111111'
      const apiTokenHash = '2222222222222222222222222222222222222222222222222222222222222222'
      const futureExpiry = new Date(Date.now() + 86_400_000).toISOString()

      await createSession(h.db, {
        principalId: provisioned.principalId,
        tokenHash: sessionTokenHash,
        expiresAt: futureExpiry,
        ip: '198.51.100.50',
        userAgent: 'Mozilla/5.0 Test',
        mfaVerified: true,
      })
      await createApiToken(h.db, {
        principalId: provisioned.principalId,
        name: 'ci-deploy',
        tokenHash: apiTokenHash,
        scopes: ['domains:read'],
        expiresAt: futureExpiry,
      })
      assert.ok(await findActiveSessionByTokenHash(h.db, sessionTokenHash))
      assert.ok(await findActiveApiTokenByHash(h.db, apiTokenHash))

      // Add mailbox + FTP service user, MariaDB database + user + grant, and enabled cron job
      await h.store.createServiceUser({
        accountId,
        login: 'info@susp.example.com',
        passwordHash: TEST_SERVICE_HASH,
        services: { email: true, ftp: true, webdisk: true },
        mailboxQuotaMb: 512,
        ftpDir: '',
      })
      const dbRec = await h.store.createDatabase({
        accountId,
        name: 'suspuser_app',
      })
      const dbUser = await h.store.createDatabaseUser({
        accountId,
        name: 'suspuser_dbu',
        authPlugin: 'ed25519',
        authString: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq',
      })
      await h.store.setGrant({
        databaseUserId: dbUser.id,
        databaseId: dbRec.id,
        privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      })
      const cronId = '11111111-2222-4333-8444-555555555555'
      await h.store.saveCronJobs(accountId, [
        {
          id: cronId,
          accountId,
          schedule: '*/5 * * * *',
          command: '/usr/bin/php /home/suspuser/public_html/cron.php',
          comment: 'Five minute job',
          enabled: true,
        },
      ])

      // Reconcile active state with mailbox, FTP, DB, and cron
      await h.reconciler.reconcile({ actor: 'root:root', force: true })

      // Verify active baselines before suspension
      const activeDovecot = h.executor.files.get('/etc/dovecot/xpanel/domains/susp.example.com.passwd')
      assert.ok(activeDovecot)
      assert.doesNotMatch(activeDovecot.content, /nologin=y/)
      const activeFtp = h.executor.files.get('/etc/pure-ftpd/pureftpd.passwd')
      assert.ok(activeFtp)
      assert.match(activeFtp.content, /^info@susp\.example\.com:/m)
      const cronTimerUnit = 'xpanel-cron-suspuser-1111111122224333.timer'
      assert.equal(h.executor.units.get(cronTimerUnit)?.active, true)

      // SUSPEND ACCOUNT
      const suspended = await h.coordinator.suspendAccount({
        accountId,
        reason: 'Terms of service review',
        actor: ROOT_ACTOR,
      })

      assert.equal(suspended.account.status, 'suspended')
      assert.equal(suspended.account.suspendReason, 'Terms of service review')
      assert.equal(suspended.panelPrincipalDisabled, true)
      assert.equal(suspended.activeSessionsRemaining, 0)
      assert.deepEqual(suspended.lockedDatabaseUsers, ['suspuser_dbu'])

      // 1. Panel session & API token immediately invalidated; principal disabled
      assert.equal(await findActiveSessionByTokenHash(h.db, sessionTokenHash), null)
      assert.equal(await findActiveApiTokenByHash(h.db, apiTokenHash), null)
      const disabledPrincipal = await findPrincipalByAccountId(h.db, accountId)
      assert.equal(disabledPrincipal?.disabled, true)

      // 2. Shell login set to /usr/sbin/nologin
      assert.equal(h.executor.users.get('suspuser')?.shell, '/usr/sbin/nologin')

      // 3. FTP virtual user omitted from Pure-FTPd passwd
      const suspendedFtp = h.executor.files.get('/etc/pure-ftpd/pureftpd.passwd')
      if (suspendedFtp) {
        assert.doesNotMatch(suspendedFtp.content, /^info@susp\.example\.com:/m)
      }

      // 4 & 5. Dovecot mail login denied & delivery deferred
      const suspendedDovecot = h.executor.files.get('/etc/dovecot/xpanel/domains/susp.example.com.passwd')
      assert.ok(suspendedDovecot)
      assert.match(suspendedDovecot.content, /nologin=y/)
      assert.match(suspendedDovecot.content, /reason=suspended/)

      // 6. MariaDB user locked
      assert.ok(
        h.executor.sqlStatements.some(
          (s) =>
            s.engine === 'mariadb' &&
            s.statement === "ALTER USER 'suspuser_dbu'@'localhost' ACCOUNT LOCK;",
        ),
      )

      // 7. Cron timer stopped and disabled
      const stoppedCron = h.executor.units.get(cronTimerUnit)
      assert.ok(stoppedCron)
      assert.equal(stoppedCron.enabled, false)
      assert.equal(stoppedCron.active, false)

      // 8. Account cgroup slice & PHP-FPM unit stopped
      assert.equal(h.executor.units.get(sliceUnit(uid))?.active, false)
      assert.equal(h.executor.units.get(userSliceUnit(uid))?.active, false)
      assert.equal(h.executor.units.get('xpanel-php-fpm-suspuser-8.3.service')?.active, false)

      // 9. Edge Nginx & Apache vhosts serve the HTTP 503 suspended page
      const nginxVhost = h.executor.files.get('/etc/nginx/conf.d/xpanel-suspuser.conf')
      assert.ok(nginxVhost)
      assert.match(nginxVhost.content, /return 503/)

      // UNSUSPEND ACCOUNT
      const unsuspended = await h.coordinator.unsuspendAccount({
        accountId,
        actor: ROOT_ACTOR,
      })

      assert.equal(unsuspended.account.status, 'active')
      assert.equal(unsuspended.panelPrincipalDisabled, false)
      assert.deepEqual(unsuspended.unlockedDatabaseUsers, ['suspuser_dbu'])

      // Verify restoration across surfaces
      const reenabledPrincipal = await findPrincipalByAccountId(h.db, accountId)
      assert.equal(reenabledPrincipal?.disabled, false)
      // Old revoked session remains revoked (must log in fresh)
      assert.equal(await findActiveSessionByTokenHash(h.db, sessionTokenHash), null)

      assert.equal(h.executor.users.get('suspuser')?.shell, '/opt/xpanel/bin/jailshell')
      const restoredFtp = h.executor.files.get('/etc/pure-ftpd/pureftpd.passwd')
      assert.ok(restoredFtp)
      assert.match(restoredFtp.content, /^info@susp\.example\.com:/m)
      const restoredDovecot = h.executor.files.get('/etc/dovecot/xpanel/domains/susp.example.com.passwd')
      assert.ok(restoredDovecot)
      assert.doesNotMatch(restoredDovecot.content, /nologin=y/)

      assert.ok(
        h.executor.sqlStatements.some(
          (s) =>
            s.engine === 'mariadb' &&
            s.statement === "ALTER USER 'suspuser_dbu'@'localhost' ACCOUNT UNLOCK;",
        ),
      )
      assert.equal(h.executor.units.get(cronTimerUnit)?.active, true)
      assert.equal(h.executor.units.get(sliceUnit(uid))?.active, true)
      assert.equal(h.executor.units.get('xpanel-php-fpm-suspuser-8.3.service')?.active, true)

      const restoredNginx = h.executor.files.get('/etc/nginx/conf.d/xpanel-suspuser.conf')
      assert.ok(restoredNginx)
      assert.doesNotMatch(restoredNginx.content, /return 503/)
    } finally {
      await h.cleanup()
    }
  })

  it('terminates an account completely across all surfaces without UID reuse or neighbor collateral (A22, A35)', async () => {
    const h = await createTestHarness()
    try {
      // Provision neighbor account (keepme) and target account (killme)
      const neighbor = await h.coordinator.provisionAccount({
        actor: ROOT_ACTOR,
        username: 'keepme',
        primaryDomain: 'keepme.example.com',
        planId: h.standardPlan.id,
        ownerId: null,
        contactEmail: 'ops@keepme.example.com',
        ipv4: '203.0.113.40',
        shell: 'jailed',
        php: DEFAULT_PHP,
        passwordHash: TEST_ARGON2_HASH,
      })

      const target = await h.coordinator.provisionAccount({
        actor: ROOT_ACTOR,
        username: 'killme',
        primaryDomain: 'killme.example.com',
        planId: h.standardPlan.id,
        ownerId: null,
        contactEmail: 'ops@killme.example.com',
        ipv4: '203.0.113.41',
        shell: 'jailed',
        php: DEFAULT_PHP,
        passwordHash: TEST_ARGON2_HASH,
      })

      const targetId = target.account.id
      const targetUid = target.account.uid
      assert.equal(neighbor.account.uid, 20000)
      assert.equal(targetUid, 20001)

      // Populate databases, DB users, mailbox/FTP user, and cron job on killme
      await h.store.createServiceUser({
        accountId: targetId,
        login: 'sales@killme.example.com',
        passwordHash: TEST_SERVICE_HASH,
        services: { email: true, ftp: true, webdisk: false },
        mailboxQuotaMb: 256,
        ftpDir: '',
      })
      const targetDb = await h.store.createDatabase({
        accountId: targetId,
        name: 'killme_shop',
      })
      const targetDbUser = await h.store.createDatabaseUser({
        accountId: targetId,
        name: 'killme_usr',
        authPlugin: 'ed25519',
        authString: 'zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPONMLKJ',
      })
      await h.store.setGrant({
        databaseUserId: targetDbUser.id,
        databaseId: targetDb.id,
        privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      })
      await h.store.saveCronJobs(targetId, [
        {
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          accountId: targetId,
          schedule: '0 * * * *',
          command: '/usr/bin/php /home/killme/public_html/hourly.php',
          comment: 'Hourly cleanup',
          enabled: true,
        },
      ])
      await h.reconciler.reconcile({ actor: 'root:root', force: true })

      // Reject mismatched confirmation username
      await assert.rejects(
        () =>
          h.coordinator.terminateAccount({
            accountId: targetId,
            confirmUsername: 'wrongname',
            actor: ROOT_ACTOR,
          }),
        /termination confirmation must match the exact account username/,
      )

      // Execute safe termination
      const terminated = await h.coordinator.terminateAccount({
        accountId: targetId,
        confirmUsername: 'killme',
        actor: ROOT_ACTOR,
      })

      assert.equal(terminated.burnedUid, 20001)
      assert.deepEqual(terminated.removedDomains, ['killme.example.com'])
      assert.deepEqual(terminated.removedDatabases, ['killme_shop'])
      assert.deepEqual(terminated.removedDatabaseUsers, ['killme_usr'])
      assert.deepEqual(terminated.removedServiceUsers, ['sales@killme.example.com'])
      assert.deepEqual(terminated.removedZones, ['killme.example.com'])

      // Verify desired state & SQLite cleanup
      assert.equal(await h.store.getAccount(targetId), null)
      assert.equal(await findPrincipalByAccountId(h.db, targetId), null)
      const indexed = await listIndexedAccounts(h.db)
      assert.deepEqual(indexed.map((a) => a.username), ['keepme'])

      // Verify all host surfaces for killme are gone
      assert.equal(h.executor.users.has('killme'), false)
      assert.equal(h.executor.quotas.has('killme'), false)
      assert.equal(h.executor.dirs.has('/home/killme'), false)
      assert.equal(h.executor.files.has('/etc/systemd/system/xpanel-20001.slice'), false)
      assert.equal(h.executor.files.has('/etc/systemd/system/user-20001.slice.d/50-xpanel.conf'), false)
      assert.equal(h.executor.files.has('/etc/nginx/conf.d/xpanel-killme.conf'), false)
      assert.equal(h.executor.files.has('/etc/apache2/sites-enabled/xpanel-site-killme.example.com.conf'), false)
      assert.equal(h.executor.files.has('/etc/xpanel/php-fpm/8.3/killme.pool.conf'), false)
      assert.equal(h.executor.files.has('/etc/systemd/system/xpanel-php-fpm-killme-8.3.service'), false)
      assert.equal(h.executor.files.has('/etc/dovecot/xpanel/domains/killme.example.com.passwd'), false)
      assert.equal(h.executor.files.has('/var/lib/powerdns/zones/killme.example.com.zone'), false)

      // Verify MariaDB DROP DATABASE & DROP USER executed
      assert.ok(
        h.executor.sqlStatements.some(
          (s) => s.engine === 'mariadb' && s.statement.includes('DROP DATABASE IF EXISTS `killme_shop`'),
        ),
      )
      assert.ok(
        h.executor.sqlStatements.some(
          (s) => s.engine === 'mariadb' && s.statement.includes("DROP USER IF EXISTS 'killme_usr'@'localhost'"),
        ),
      )

      // Verify neighbor account keepme is 100% untouched
      assert.equal(h.executor.users.has('keepme'), true)
      assert.equal(h.executor.quotas.has('keepme'), true)
      assert.equal(h.executor.dirs.has('/home/keepme'), true)
      assert.equal(h.executor.files.has('/etc/systemd/system/xpanel-20000.slice'), true)
      assert.equal(h.executor.files.has('/etc/nginx/conf.d/xpanel-keepme.conf'), true)
      assert.equal(h.executor.files.has('/var/lib/powerdns/zones/keepme.example.com.zone'), true)

      // Provision a new account after termination: UID 20001 must NEVER be reused (next is 20002)
      const afterTerm = await h.coordinator.provisionAccount({
        actor: ROOT_ACTOR,
        username: 'freshacct',
        primaryDomain: 'freshacct.example.com',
        planId: h.standardPlan.id,
        ownerId: null,
        contactEmail: 'ops@freshacct.example.com',
        ipv4: '203.0.113.42',
        shell: 'jailed',
        php: DEFAULT_PHP,
        passwordHash: TEST_ARGON2_HASH,
      })
      assert.equal(afterTerm.account.uid, 20002)
    } finally {
      await h.cleanup()
    }
  })
})
