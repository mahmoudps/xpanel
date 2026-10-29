import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultFirewallRules, suggestServerSettings } from '@xpanel/core'
import type { HostAction } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { postgresqlScramVerifier } from '../../../packages/state/src/pg-state.ts'
import { compileDesiredGeneration } from './reconciler.ts'

const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
const verifier = postgresqlScramVerifier('pencil-pencil', Buffer.alloc(16, 5))
let state: TestStateStoreHandle
beforeEach(async () => { state = await createTestStateStore() })
afterEach(async () => { await state.close() })

async function seed() {
  const store = state.store, suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
  await store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
  for (const rule of defaultFirewallRules({ panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 })) await store.createFirewallRule(rule, { lockout: null })
  const features = await store.createFeatureList({ name: 'Standard', ownerId: null, disabled: [] })
  const plan = await store.createPlan({ name: 'Pro', ownerId: null, featureListId: features.id, resources: { diskMb: 1024, bandwidthMbMonth: 1024, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 256, maxProcesses: 32, cpuPercent: 100 }, caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 5, phpWorkers: 2 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: 'PostgreSQL reconcile fixture' })
  const account = await store.createAccount({ username: 'alice', passwordHash: ARGON2, primaryDomain: 'alice.example.com', planId: plan.id, ownerId: null, contactEmail: 'alice@example.com', ipv4: '203.0.113.10', shell: 'none', php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} } })
  return account
}
const postgresql = (actions: readonly HostAction[]) => actions.filter((action): action is Extract<HostAction, { kind: 'sql' }> => action.kind === 'sql' && action.engine === 'postgresql')

describe('PostgreSQL reconciliation', () => {
  it('adds one PostgreSQL SQL action only for accounts with saved PostgreSQL users', async () => {
    const account = await seed()
    expect(postgresql(compileDesiredGeneration(await state.store.readSnapshot(), { os }).postActions)).toEqual([])
    await state.store.createPostgresqlUser({ accountId: account.id, name: 'alice_app', authString: verifier })
    await state.store.createPostgresqlDatabase({ accountId: account.id, name: 'alice_shop', owner: 'alice_app' })
    const [action] = postgresql(compileDesiredGeneration(await state.store.readSnapshot(), { os }).postActions)
    expect(action!.statements).toContain(`ALTER ROLE "alice_app" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${verifier}';`)
    expect(action!.statements).toContain('REVOKE ALL ON DATABASE "alice_shop" FROM PUBLIC;')
    await state.store.suspendAccount(account.id, 'billing')
    expect(postgresql(compileDesiredGeneration(await state.store.readSnapshot(), { os }).postActions)[0]!.statements.some(statement => statement.includes('WITH NOLOGIN'))).toBe(true)
    await state.store.markTerminating(account.id)
    expect(postgresql(compileDesiredGeneration(await state.store.readSnapshot(), { os }).postActions)[0]!.statements).toEqual([
      'DROP DATABASE IF EXISTS "alice_shop" WITH (FORCE);',
      `SELECT 'DROP OWNED BY "alice_app"' FROM pg_catalog.pg_roles WHERE rolname = 'alice_app'\\gexec`, 'DROP ROLE IF EXISTS "alice_app";',
    ])
  })
})
