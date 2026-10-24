import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, afterEach, beforeEach, it } from 'vitest'
import { defaultFirewallRules, isXpanelError, suggestServerSettings } from '@xpanel/core'
import type { HostAction, RenderedFile } from '@xpanel/core'
import { createGeneration, createTestDb, getGeneration, latestActive, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import { compileDesiredGeneration, HostReconciler, rollbackReloadAction, sha256Text, type ReconcileJournalPhase } from './reconciler.ts'
import { SERIAL_RE } from './zone-serial.ts'

const ARGON2 =
  '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'

describe('R02 & R03 (A19, A20, A21, A22) — Staged generations, removal manifests, drift repair, health rollback & crash recovery', () => {
  let stateHandle: TestStateStoreHandle
  let dbHandle: TestDbHandle
  let executor: FakeHostExecutor
  const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')

  beforeEach(async () => {
    stateHandle = await createTestStateStore()
    dbHandle = await createTestDb()
    executor = new FakeHostExecutor()
  })

  afterEach(async () => {
    await stateHandle.close()
    await dbHandle.close()
  })

  const seedEnvironment = async () => {
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
      shell: 'jailed',
      defaultMailboxQuotaMb: 1024,
    })
    await stateHandle.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    await stateHandle.store.saveServerIp({ address: '2001:db8::10', version: 6, prefixLength: 64, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const account = await stateHandle.store.createAccount({
      username: 'alice',
      passwordHash: ARGON2,
      primaryDomain: 'alice.example.com',
      planId: plan.id,
      ownerId: null,
      contactEmail: 'alice@example.com',
      ipv4: '203.0.113.10',
      ipv6: '2001:db8::10',
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
    return { plan, account, fl }
  }

  it('refuses a stale compiled snapshot before live activation and records the pending generation as failed', async () => {
    await seedEnvironment()
    const reconciler = new HostReconciler({ store: stateHandle.store, db: dbHandle.db, executor, os })
    const initial = await reconciler.reconcile({ actor: 'root', mailAuth: null })
    assert.equal(initial.status, 'applied')
    const active = await latestActive(dbHandle.db)
    assert.ok(active)

    const settings = (await stateHandle.store.getServerSettings())!
    await stateHandle.store.saveServerSettings({ ...settings, sshPort: 2222 })
    const liveFiles = JSON.stringify([...executor.files])
    const liveActionCount = executor.executedActions.length
    const configTestCount = executor.executedTests.length
    const originalPreflight = executor.preflight.bind(executor)
    let changedAfterCompilation = false
    executor.preflight = async (plan) => {
      await originalPreflight(plan)
      if (!changedAfterCompilation) {
        changedAfterCompilation = true
        await stateHandle.store.saveServerSettings({ ...settings, sshPort: 2223 })
      }
    }

    await assert.rejects(
      reconciler.reconcile({ actor: 'root', force: true, mailAuth: null }),
      (error: unknown) => isXpanelError(error) && error.code === 'CONFLICT',
    )

    assert.equal(changedAfterCompilation, true)
    assert.equal((await latestActive(dbHandle.db))?.id, active.id)
    assert.equal((await getGeneration(dbHandle.db, active.id + 1))?.status, 'failed')
    assert.equal(await stateHandle.store.readGenerationSnapshot(active.id + 1), null)
    assert.equal(await reconciler.journal.readActiveJournal(), null)
    assert.equal(JSON.stringify([...executor.files]), liveFiles)
    assert.equal(executor.executedActions.length, liveActionCount)
    assert.equal(executor.executedTests.length, configTestCount)
  })

  it('bumps a stamped zone after body drift, then remains stable without changing TTLs', async () => {
    const { account } = await seedEnvironment()
    await stateHandle.store.saveDnsZone({ id: randomUUID(), accountId: account.id, name: 'alice.example.com', serial: 2026102400, records: [{ id: randomUUID(), zone: 'alice.example.com', name: 'www', type: 'A', ttl: 300, content: '192.0.2.10', priority: null }] })
    const reconciler = new HostReconciler({ store: stateHandle.store, db: dbHandle.db, executor, os })
    await reconciler.reconcile({ actor: 'root', mailAuth: null })
    const path = '/var/lib/powerdns/zones/alice.example.com.zone'
    const original = executor.files.get(path)!
    assert.ok(original.content.includes('; xpanel-content '))
    executor.files.set(path, { ...original, content: original.content.replace('192.0.2.10', '192.0.2.11') })
    await reconciler.reconcile({ actor: 'root', mailAuth: null })
    const repaired = executor.files.get(path)!.content
    assert.ok(Number(SERIAL_RE.exec(repaired)?.[2]) > Number(SERIAL_RE.exec(original.content)?.[2]))
    assert.ok(repaired.includes('192.0.2.10'))
    assert.ok(repaired.includes('300'))
    await reconciler.reconcile({ actor: 'root', mailAuth: null })
    assert.equal(executor.files.get(path)!.content, repaired)
  })

  it('uses per-account IO devices without falling back to a global device, while retaining explicit overrides', async () => {
    const { account } = await seedEnvironment()
    const snapshot = await stateHandle.store.readSnapshot()
    const mapped = compileDesiredGeneration(snapshot, { os, ioDevices: ['/dev/block/8:1'], ioDevicesByAccount: new Map([[account.id, []]]) })
    const slice = mapped.files.find(file => file.path.endsWith(`/xpanel-${account.uid}.slice`))!
    assert.equal(slice.content.includes('IOWriteBandwidthMax='), false)
    const explicit = compileDesiredGeneration(snapshot, { os, ioDevices: ['/dev/block/8:3'] })
    assert.ok(explicit.files.find(file => file.path.endsWith(`/xpanel-${account.uid}.slice`))!.content.includes('/dev/block/8:3'))
    executor.files.set('/proc/self/mountinfo', { path: '/proc/self/mountinfo', content: '1 0 8:1 / / rw - ext4 /dev/sda1 rw\n2 1 0:40 / /home rw - tmpfs tmpfs rw\n', mode: 0o444, owner: 'root', group: 'root' })
    executor.files.set('/sys/fs/cgroup/cgroup.subtree_control', { path: '/sys/fs/cgroup/cgroup.subtree_control', content: 'cpu memory io pids', mode: 0o444, owner: 'root', group: 'root' })
    const automatic = new HostReconciler({ store: stateHandle.store, db: dbHandle.db, executor, os })
    await automatic.reconcile({ actor: 'root', mailAuth: null })
    assert.equal(executor.files.get(slice.path)!.content.includes('IOWriteBandwidthMax='), false)
    const overridden = new HostReconciler({ store: stateHandle.store, db: dbHandle.db, executor, os, ioDevices: ['/dev/block/8:3'] })
    await overridden.reconcile({ actor: 'root', mailAuth: null, force: true })
    assert.ok(executor.files.get(slice.path)!.content.includes('/dev/block/8:3'))
  })

  it('A19: validates candidate configs in isolated staging before touching live paths; syntax failure never writes broken config to live targets', async () => {
    await seedEnvironment()
    const reconciler = new HostReconciler({
      store: stateHandle.store,
      db: dbHandle.db,
      executor,
      os,
    })

    const gen1 = await reconciler.reconcile({ actor: 'root' })
    assert.equal(gen1.status, 'applied')
    const sshDropinPath = [...executor.files.keys()].find((k) => k.includes('ssh'))!
    assert.ok(sshDropinPath)
    const originalSshDropin = executor.files.get(sshDropinPath)?.content
    assert.ok(originalSshDropin)

    // Mutate server sshPort so generation #2 has new rendered content
    const currentSettings = (await stateHandle.store.getServerSettings())!
    await stateHandle.store.saveServerSettings({
      ...currentSettings,
      sshPort: 2222,
    })

    // Observe live files DURING runTest to prove candidate files have NOT been written to live paths yet
    let observedSshDuringTest: string | undefined
    const origRunTest = executor.runTest.bind(executor)
    executor.runTest = async (test) => {
      observedSshDuringTest = executor.files.get(sshDropinPath)?.content
      return origRunTest(test)
    }

    executor.failConfigTest('sshd', 'sshd: invalid port directive in candidate config')
    const failed = await reconciler.reconcile({ actor: 'root' })

    assert.equal(failed.status, 'failed')
    if (failed.status === 'failed') {
      assert.equal(failed.failedTest, 'sshd')
      assert.equal(failed.generation.status, 'failed')
    }

    // Prove that during syntax test AND after failure, the live sshd drop-in was never overwritten
    assert.equal(observedSshDuringTest, originalSshDropin)
    assert.equal(executor.files.get(sshDropinPath)?.content, originalSshDropin)
    assert.equal((await latestActive(dbHandle.db))?.id, 1)
  })

  it('A22: removes ONLY obsolete owned files and stops obsolete units when the last mailbox, FTP user, or cron job is deleted, preserving unmanaged neighbor files', async () => {
    const { account } = await seedEnvironment()

    // Create a mailbox + FTP user and a cron job on alice
    const serviceUser = await stateHandle.store.createServiceUser({
      accountId: account.id,
      login: 'ftp_and_mail@alice.example.com',
      passwordHash: `{ARGON2ID}${ARGON2}`,
      services: { email: true, ftp: true, webdisk: false },
      mailboxQuotaMb: 512,
      ftpDir: '',
    })
    const cronId = randomUUID()
    const [cron] = await stateHandle.store.saveCronJobs(account.id, [
      {
        id: cronId,
        accountId: account.id,
        schedule: '*/15 * * * *',
        command: '/usr/bin/php /home/alice/public_html/cron.php',
        comment: 'Every 15m',
        enabled: true,
      },
    ])
    assert.ok(cron)

    // Plant unmanaged neighbor files on the host that xPanel does NOT own
    executor.files.set('/etc/nginx/conf.d/unmanaged-neighbor.conf', {
      path: '/etc/nginx/conf.d/unmanaged-neighbor.conf',
      content: '# custom operator config',
      mode: 0o644,
      owner: 'root',
      group: 'root',
    })
    executor.files.set('/home/alice/public_html/index.php', {
      path: '/home/alice/public_html/index.php',
      content: '<?php echo "customer site";',
      mode: 0o640,
      owner: 'alice',
      group: 'alice',
    })

    const reconciler = new HostReconciler({
      store: stateHandle.store,
      db: dbHandle.db,
      executor,
      os,
    })

    const r1 = await reconciler.reconcile({ actor: 'root' })
    assert.equal(r1.status, 'applied')

    const dovecotPath = [...executor.files.keys()].find((k) => k.includes('dovecot'))!
    const ftpPasswdPath = [...executor.files.keys()].find((k) => k.includes('pure-ftpd'))!
    const shortCronId = cron.id.replace(/[^a-z0-9]/gi, '').slice(0, 16)
    const cronTimerUnit = `xpanel-cron-alice-${shortCronId}.timer`
    const cronTimerPath = [...executor.files.keys()].find((k) => k.endsWith(cronTimerUnit))!

    assert.ok(dovecotPath)
    assert.ok(ftpPasswdPath)
    assert.ok(cronTimerPath)
    assert.equal(executor.units.get(cronTimerUnit)?.active, true)

    // Delete the last service user (mailbox + FTP) and last cron job
    await stateHandle.store.deleteServiceUser(serviceUser.id)
    await stateHandle.store.saveCronJobs(account.id, [])

    const r2 = await reconciler.reconcile({ actor: 'root' })
    assert.equal(r2.status, 'applied')
    if (r2.status === 'applied') {
      assert.equal((r2.removedFilesCount ?? 0) >= 3, true)
    }

    // Obsolete owned files are removed and cron timer unit is stopped/disabled
    assert.equal(executor.files.has(dovecotPath), false)
    assert.equal(executor.files.has(ftpPasswdPath), false)
    assert.equal(executor.files.has(cronTimerPath), false)
    assert.equal(executor.units.get(cronTimerUnit)?.active, false)
    assert.equal(executor.units.get(cronTimerUnit)?.enabled, false)

    assert.equal(
      executor.executedActions.some(action => action.kind === 'remove-path' && action.path === '/home/alice/mail/alice.example.com/ftp_and_mail'),
      true,
    )

    // Unmanaged neighbor files and customer data are untouched
    assert.equal(
      executor.files.get('/etc/nginx/conf.d/unmanaged-neighbor.conf')?.content,
      '# custom operator config',
    )
    assert.equal(
      executor.files.get('/home/alice/public_html/index.php')?.content,
      '<?php echo "customer site";',
    )
  })

  it('A22: detects and repairs out-of-band host drift even when desired state checksum is unchanged and force is false (including after restart)', async () => {
    await seedEnvironment()
    const reconciler1 = new HostReconciler({
      store: stateHandle.store,
      db: dbHandle.db,
      executor,
      os,
    })

    const r1 = await reconciler1.reconcile({ actor: 'root' })
    assert.equal(r1.status, 'applied')

    // With no drift, reconcile({ force: false }) is a fast noop
    const noop = await reconciler1.reconcile({ force: false })
    assert.equal(noop.status, 'noop')

    const originalNginx = executor.files.get('/etc/nginx/nginx.conf')!
    // Simulate out-of-band tampering of /etc/nginx/nginx.conf and deletion of /opt/xpanel/bin/jailshell
    executor.files.set('/etc/nginx/nginx.conf', {
      ...originalNginx,
      content: '# CORRUPTED OUT OF BAND BY EXTERNAL PROCESS\n',
    })
    executor.files.delete('/opt/xpanel/bin/jailshell')

    // Instantiate a brand-new HostReconciler (simulating daemon restart) and call reconcile({ force: false })
    const reconcilerAfterRestart = new HostReconciler({
      store: stateHandle.store,
      db: dbHandle.db,
      executor,
      os,
    })

    const driftReport = await reconcilerAfterRestart.checkDrift()
    assert.equal(driftReport.hasDrift, true)
    assert.equal(driftReport.items.length, 2)

    const repaired = await reconcilerAfterRestart.reconcile({ force: false, actor: 'agent' })
    assert.equal(repaired.status, 'applied')
    if (repaired.status === 'applied') {
      assert.equal(repaired.repairedDriftCount, 2)
    }

    assert.equal(executor.files.get('/etc/nginx/nginx.conf')?.content, originalNginx.content)
    assert.equal(executor.files.has('/opt/xpanel/bin/jailshell'), true)
  })

  it('A20: rolls back files/metadata, reloads affected services in reverse order, and verifies health when reload or health probe fails on the 2nd service', async () => {
    await seedEnvironment()
    let failNginxHealthForGen: number | null = null

    const reconciler = new HostReconciler({
      store: stateHandle.store,
      db: dbHandle.db,
      executor,
      os,
      healthProbe: async (unit, genId) => {
        if (unit === os.services.nginx && genId === failNginxHealthForGen) {
          return { ok: false, error: 'nginx worker failed to bind socket on generation ' + genId }
        }
        return { ok: true }
      },
    })

    const r1 = await reconciler.reconcile({ actor: 'root' })
    assert.equal(r1.status, 'applied')
    const gen1Ssh = executor.files.get('/etc/ssh/sshd_config.d/60-xpanel.conf')!

    // Update sshPort to trigger generation #2
    const settings = (await stateHandle.store.getServerSettings())!
    await stateHandle.store.saveServerSettings({ ...settings, sshPort: 2200 })

    // 1. Fail on the 2nd service reload in batch (apache2 reloads first, then nginx reload throws)
    const origRunAction = executor.runAction.bind(executor)
    let failSecondReloadOnce = true
    executor.runAction = async (action: HostAction) => {
      if (
        failSecondReloadOnce &&
        action.kind === 'systemd' &&
        action.verb === 'reload' &&
        action.unit === os.services.nginx
      ) {
        failSecondReloadOnce = false
        throw new Error('systemctl reload nginx.service failed (exit 1)')
      }
      return origRunAction(action)
    }

    const r2 = await reconciler.reconcile({ actor: 'root' })
    assert.equal(r2.status, 'failed')
    if (r2.status === 'failed') {
      assert.equal(r2.rolledBack, true)
      assert.equal(r2.restoredGenerationId, 1)
      assert.equal(r2.generation.status, 'rolled_back')
      assert.equal(r2.failedTest, os.services.nginx)
    }

    // Verify generation #1 is active in SQLite and live files match generation #1 bytes/mode/owner/group
    assert.equal((await latestActive(dbHandle.db))?.id, 1)
    assert.deepEqual(executor.files.get('/etc/ssh/sshd_config.d/60-xpanel.conf'), gen1Ssh)

    // 2. Now let reload succeed, but fail post-reload health verification on the 2nd service (generation #3)
    failNginxHealthForGen = 3
    const r3 = await reconciler.reconcile({ actor: 'root', force: true })
    assert.equal(r3.status, 'failed')
    if (r3.status === 'failed') {
      assert.equal(r3.rolledBack, true)
      assert.equal(r3.restoredGenerationId, 1)
      assert.equal(r3.generation.status, 'rolled_back')
    }
    assert.equal((await latestActive(dbHandle.db))?.id, 1)
    assert.deepEqual(executor.files.get('/etc/ssh/sshd_config.d/60-xpanel.conf'), gen1Ssh)
  })

  it('A20: rolls back partially written files when ENOSPC or chown/write failure occurs mid-activation', async () => {
    await seedEnvironment()
    const reconciler = new HostReconciler({
      store: stateHandle.store,
      db: dbHandle.db,
      executor,
      os,
    })

    const r1 = await reconciler.reconcile({ actor: 'root' })
    assert.equal(r1.status, 'applied')
    const snapshotGen1Files = new Map(
      [...executor.files.entries()].map(([k, v]) => [k, { ...v }]),
    )

    const settings = (await stateHandle.store.getServerSettings())!
    await stateHandle.store.saveServerSettings({ ...settings, sshPort: 2299 })

    // Inject ENOSPC on the 2nd writeFile call during activate
    const origWriteFile = executor.writeFile.bind(executor)
    let writesInGen2 = 0
    let injectEnospc = true
    executor.writeFile = async (file: RenderedFile) => {
      if (injectEnospc) {
        writesInGen2++
        if (writesInGen2 === 2) {
          injectEnospc = false
          const err = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
          throw err
        }
      }
      return origWriteFile(file)
    }

    const r2 = await reconciler.reconcile({ actor: 'root' })
    assert.equal(r2.status, 'failed')
    if (r2.status === 'failed') {
      assert.equal(r2.rolledBack, true)
      assert.equal(r2.generation.status, 'rolled_back')
      assert.equal(r2.restoredGenerationId, 1)
    }

    // Every single live file on the host was restored to generation #1's exact state
    assert.equal((await latestActive(dbHandle.db))?.id, 1)
    assert.deepEqual(executor.files, snapshotGen1Files)
  })

  it.each(['stage', 'test', 'activate', 'reload', 'verify'] as const)(
    'A21: recovers deterministically from a simulated process kill at phase "%s" with zero partial state or false active rows',
    async (crashPhase: ReconcileJournalPhase) => {
      await seedEnvironment()
      const baseReconciler = new HostReconciler({
        store: stateHandle.store,
        db: dbHandle.db,
        executor,
        os,
      })

      const gen1 = await baseReconciler.reconcile({ actor: 'root' })
      assert.equal(gen1.status, 'applied')
      const gen1FilesSnapshot = new Map(
        [...executor.files.entries()].map(([k, v]) => [k, { ...v }]),
      )

      // Mutate desired state for generation #2
      const settings = (await stateHandle.store.getServerSettings())!
      await stateHandle.store.saveServerSettings({ ...settings, sshPort: 2244 })

      // Run reconcile with a simulated SIGKILL at `crashPhase`
      const crashingReconciler = new HostReconciler({
        store: stateHandle.store,
        db: dbHandle.db,
        executor,
        os,
        onPhaseHook: (phase) => {
          if (phase === crashPhase) {
            throw new Error(`SIMULATED_SIGKILL_AT_${crashPhase.toUpperCase()}`)
          }
        },
      })

      await assert.rejects(
        () => crashingReconciler.reconcile({ actor: 'root' }),
        new RegExp(`SIMULATED_SIGKILL_AT_${crashPhase.toUpperCase()}`),
      )

      // Immediately after the crash (before recovery), generation #2 is NEVER marked 'active' in SQLite
      const activeDuringCrash = await latestActive(dbHandle.db)
      assert.equal(activeDuringCrash?.id, 1)

      const persistedJournal = await crashingReconciler.journal.readActiveJournal()
      assert.ok(persistedJournal)
      assert.equal(persistedJournal.phase, crashPhase)

      // Start a fresh HostReconciler instance (simulating agent restart) and run crash recovery
      const restartedReconciler = new HostReconciler({
        store: stateHandle.store,
        db: dbHandle.db,
        executor,
        os,
      })
      const recovery = await restartedReconciler.recoverInterruptedReconciliation()
      assert.equal(recovery.recovered, true)
      assert.equal(recovery.interruptedPhase, crashPhase)
      assert.equal(recovery.restoredGenerationId, 1)

      const gen2Row = await getGeneration(dbHandle.db, 2)
      assert.ok(gen2Row)
      if (crashPhase === 'stage' || crashPhase === 'test') {
        assert.equal(recovery.outcome, 'failed')
        assert.equal(gen2Row.status, 'failed')
      } else {
        assert.equal(recovery.outcome, 'rolled_back')
        assert.equal(gen2Row.status, 'rolled_back')
      }

      // Active generation is still #1 and live host files match generation #1
      assert.equal((await latestActive(dbHandle.db))?.id, 1)
      assert.deepEqual(executor.files, gen1FilesSnapshot)
      assert.equal(await restartedReconciler.journal.readActiveJournal(), null)
    },
  )

  it('reloads PowerDNS with reload-or-restart and tolerates a missing slice drop-in temp', async () => {
    assert.deepEqual(rollbackReloadAction('pdns.service'), {
      kind: 'exec',
      argv: ['/usr/bin/systemctl', 'reload-or-restart', 'pdns.service'],
    })
    assert.deepEqual(rollbackReloadAction('nginx.service'), {
      kind: 'systemd',
      verb: 'reload',
      unit: 'nginx.service',
    })

    await seedEnvironment()
    const reconciler = new HostReconciler({
      store: stateHandle.store,
      db: dbHandle.db,
      executor,
      os,
    })
    const first = await reconciler.reconcile({ actor: 'root' })
    assert.equal(first.status, 'applied')
    const dropin = [...executor.files.keys()].find((path) => path.endsWith('/user-20000.slice.d/50-xpanel.conf') || path.includes('.slice.d/50-xpanel.conf'))
    assert.ok(dropin)
    const dropinDir = dropin.slice(0, dropin.lastIndexOf('/'))
    assert.ok(executor.executedActions.some((action) => action.kind === 'ensure-dir' && action.path === dropinDir))

    const settings = (await stateHandle.store.getServerSettings())!
    await stateHandle.store.saveServerSettings({ ...settings, sshPort: 2222 })
    const origWrite = executor.writeFile.bind(executor)
    let sliceWrites = 0
    executor.writeFile = async (file) => {
      if (file.path === dropin) {
        sliceWrites += 1
        if (sliceWrites <= 2) {
          throw Object.assign(
            new Error(`ENOENT: no such file or directory, open '${dropinDir}/.missing.tmp'`),
            { code: 'ENOENT' },
          )
        }
      }
      return origWrite(file)
    }

    const failed = await reconciler.reconcile({ actor: 'root' })
    assert.equal(failed.status, 'failed')
    if (failed.status === 'failed') assert.equal(failed.rolledBack, true)
    assert.equal(sliceWrites, 3)
    assert.equal(await reconciler.journal.readActiveJournal(), null)
    assert.equal((await latestActive(dbHandle.db))?.id, 1)
  })

  it('resolve-failed checks the disk, audits the clear, and lets reconcile continue', async () => {
    await seedEnvironment()
    const reconciler = new HostReconciler({
      store: stateHandle.store,
      db: dbHandle.db,
      executor,
      os,
    })
    const applied = await reconciler.reconcile({ actor: 'root' })
    assert.equal(applied.status, 'applied')
    const manifest = await reconciler.journal.readManifest(1)
    assert.ok(manifest)
    const stuck = await createGeneration(dbHandle.db, { checksum: manifest.filesChecksum, actor: 'root' })
    const backups = [...executor.files.entries()].map(([path, file]) => ({
      path,
      existed: true,
      content: file.content,
      sha256: sha256Text(file.content),
      mode: file.mode,
      owner: file.owner ?? 'root',
      group: file.group ?? 'root',
    }))
    const now = new Date().toISOString()
    await reconciler.journal.saveJournal({
      schemaVersion: 1,
      journalId: randomUUID(),
      generationId: stuck.id,
      previousActiveGenerationId: 1,
      actor: 'root',
      stateChecksum: manifest.stateChecksum,
      filesChecksum: manifest.filesChecksum,
      phase: 'needs_attention',
      startedAt: now,
      updatedAt: now,
      candidateManifest: { ...manifest, generationId: stuck.id },
      previousManifest: manifest,
      diff: {
        added: [],
        updated: [],
        unchanged: manifest.files,
        removed: [],
        removedUnits: [],
        affectedServices: [],
      },
      previousFilesBackup: backups,
      completedPreActions: 0,
      switchedFilePaths: [],
      removedFilePaths: [],
      stoppedObsoleteUnits: [],
      completedPostActions: 0,
      reloadedUnits: [],
      verifiedUnits: [],
      error: "ENOENT: no such file or directory, open '/etc/systemd/system/user-20003.slice.d/.missing.tmp'",
    })

    await assert.rejects(
      () => reconciler.reconcile({ actor: 'root' }),
      (err: unknown) => isXpanelError(err) && err.code === 'PRECONDITION_FAILED',
    )

    const sample = backups[0]!
    const original = executor.files.get(sample.path)!
    executor.files.set(sample.path, { ...original, content: `${original.content}\n# drifted\n` })
    await assert.rejects(
      () => reconciler.resolveFailedGeneration(stuck.id, 'root'),
      (err: unknown) => isXpanelError(err) && err.code === 'PRECONDITION_FAILED',
    )
    executor.files.set(sample.path, original)
    assert.equal((await reconciler.journal.readActiveJournal())?.phase, 'needs_attention')

    await assert.rejects(
      () => reconciler.resolveFailedGeneration(stuck.id + 9, 'root'),
      (err: unknown) => isXpanelError(err) && err.code === 'PRECONDITION_FAILED',
    )

    const resolved = await reconciler.resolveFailedGeneration(stuck.id, 'root')
    assert.equal(resolved.generationId, stuck.id)
    assert.equal(resolved.previousGenerationId, 1)
    assert.equal(await reconciler.journal.readActiveJournal(), null)
    assert.equal((await getGeneration(dbHandle.db, stuck.id))?.status, 'failed')
    const audits = await dbHandle.db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE action = $1`,
      ['reconcile.attention_resolved'],
    )
    assert.equal(audits.length, 1)

    const continued = await reconciler.reconcile({ actor: 'root' })
    assert.equal(continued.status, 'noop')
  })
})
