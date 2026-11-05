import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { defaultFirewallRules, suggestServerSettings } from '@xpanel/core'
import { createTestDb, latestActive, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import { HostReconciler } from './reconciler.ts'

const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'

/**
 * A database (or quota/runtime) change only produces host actions. It keeps the rendered file
 * set identical, so the reconciler must compare the ordered action list as well as file checksums
 * and must reach an applied generation instead of reporting `noop`/needsAttention.
 */
describe('database-only desired state applies as host effects', { tags: ['feature'] }, () => {
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

  const seed = async () => {
    const suggested = suggestServerSettings({ cores: 4, memoryMb: 8192 })
    await stateHandle.store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'],
      adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22,
      nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
    for (const rule of defaultFirewallRules({ panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 })) {
      await stateHandle.store.createFirewallRule(rule, { lockout: null })
    }
    const features = await stateHandle.store.createFeatureList({ name: 'Standard', ownerId: null, disabled: [] })
    const plan = await stateHandle.store.createPlan({ name: 'Pro', ownerId: null, featureListId: features.id,
      resources: { diskMb: 10_240, bandwidthMbMonth: 102_400, ioReadBps: 50_000_000, ioWriteBps: 50_000_000,
        ioReadIops: 2000, ioWriteIops: 2000, memoryMb: 1024, maxProcesses: 64, cpuPercent: 200 },
      caps: { addonDomains: 10, aliasDomains: 10, subdomains: 20, mailboxes: 20, forwarders: 20, mailingLists: 5,
        ftpAccounts: 10, databases: 10, phpWorkers: 8 },
      dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 1024 })
    await stateHandle.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0',
      role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const account = await stateHandle.store.createAccount({ username: 'alice', passwordHash: ARGON2, primaryDomain: 'alice.example.com',
      planId: plan.id, ownerId: null, contactEmail: 'alice@example.com', ipv4: '203.0.113.10', shell: 'jailed',
      php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 2, minSpareServers: 1,
        maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} } })
    return { account, plan }
  }

  it('applies a database-only change, then returns to noop without a second effect', async () => {
    const { account } = await seed()
    const reconciler = new HostReconciler({ store: stateHandle.store, db: dbHandle.db, executor, os })
    const initial = await reconciler.reconcile({ actor: 'root', mailAuth: null })
    assert.equal(initial.status, 'applied')
    assert.ok(initial.generation)
    assert.equal((await reconciler.reconcile({ actor: 'root', mailAuth: null })).status, 'noop')

    await stateHandle.store.createDatabase({ accountId: account.id, name: 'alice_app' })
    const applied = await reconciler.reconcile({ actor: 'root', mailAuth: null })
    assert.equal(applied.status, 'applied', 'a database-only change must not be reported as noop')
    assert.ok(applied.generation)
    assert.equal(applied.generation.checksum, initial.generation.checksum, 'the rendered file set is unchanged')
    const statements = executor.sqlStatements.map(entry => entry.statement)
    assert.ok(statements.some(statement => /^CREATE DATABASE IF NOT EXISTS `alice_app`/.test(statement)), JSON.stringify(statements))

    assert.equal((await reconciler.reconcile({ actor: 'root', mailAuth: null })).status, 'noop')
    const active = await latestActive(dbHandle.db)
    assert.ok(active)
    assert.equal(active.checksum, initial.generation.checksum)
  })

  it('applies once for a legacy manifest that predates the host-effect identity, then noops', async () => {
    const { account } = await seed()
    const reconciler = new HostReconciler({ store: stateHandle.store, db: dbHandle.db, executor, os })
    const initial = await reconciler.reconcile({ actor: 'root', mailAuth: null })
    assert.equal(initial.status, 'applied')
    assert.ok(initial.generation)
    const manifestPath = join(stateHandle.store.rootDir, 'generations', 'manifests', `gen-${initial.generation.id}.json`)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    assert.equal(typeof manifest.effectsChecksum, 'string')
    delete manifest.effectsChecksum
    await writeFile(manifestPath, JSON.stringify(manifest))
    // A generation recorded before this fix has no host-effect identity; apply once so the
    // action list is re-affirmed, then the same state becomes a noop again.
    const migrated = await reconciler.reconcile({ actor: 'root', mailAuth: null })
    assert.equal(migrated.status, 'applied')
    assert.equal((await reconciler.reconcile({ actor: 'root', mailAuth: null })).status, 'noop')
    // A second database-only change still applies on the migrated manifest.
    await stateHandle.store.createDatabase({ accountId: account.id, name: 'alice_shop' })
    assert.equal((await reconciler.reconcile({ actor: 'root', mailAuth: null })).status, 'applied')
  })
})
