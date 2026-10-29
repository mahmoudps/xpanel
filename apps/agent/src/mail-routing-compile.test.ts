import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { suggestServerSettings } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { compileDesiredGeneration } from './reconciler.ts'

const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
let state: TestStateStoreHandle
beforeEach(async () => { state = await createTestStateStore() })
afterEach(async () => { await state.close() })

async function seed() {
  const store = state.store, suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
  await store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
  const features = await store.createFeatureList({ name: 'Standard', ownerId: null, disabled: [] })
  const plan = await store.createPlan({ name: 'Pro', ownerId: null, featureListId: features.id, resources: { diskMb: 1024, bandwidthMbMonth: 1024, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 256, maxProcesses: 32, cpuPercent: 100 }, caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 2, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 5, phpWorkers: 2 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: 'mail routing fixture' })
  const account = await store.createAccount({ username: 'alice', passwordHash: ARGON2, primaryDomain: 'alice.example.com', planId: plan.id, ownerId: null, contactEmail: 'alice@example.com', ipv4: '203.0.113.10', shell: 'none', php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} } })
  await store.createServiceUser({ accountId: account.id, login: 'info@alice.example.com', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: `{ARGON2ID}${ARGON2}` })
  return store.readSnapshot()
}
const file = (compiled: ReturnType<typeof compileDesiredGeneration>, suffix: string): string => compiled.files.find(item => item.path.endsWith(suffix))?.content ?? ''

describe('server mail routing in the generation', () => {
  it('keeps a backup or remote domain out of local delivery and uses the chosen submission certificate', async () => {
    const snapshot = await seed()
    const local = compileDesiredGeneration(snapshot, { os, mailTls: undefined, mailFx: { spamMilter: null, sieve: [] } })
    expect(file(local, '/virtual_domains')).toContain('alice.example.com')
    const routed = compileDesiredGeneration(snapshot, { os, mailFx: { spamMilter: null, sieve: [], routing: new Map([['alice.example.com', 'remote']]),
      submissionTls: { certFile: '/etc/xpanel/ssl/mail/fullchain.pem', keyFile: '/etc/xpanel/ssl/mail/privkey.pem' } } })
    expect(file(routed, '/virtual_domains')).not.toContain('alice.example.com')
    // The mailbox stays on disk but cannot sign in while the domain is hosted elsewhere.
    expect(file(local, '/alice.example.com.passwd')).not.toContain('nologin=y')
    expect(file(routed, '/alice.example.com.passwd')).toMatch(/^info@alice\.example\.com:.*nologin=y/m)
    expect(file(routed, '/main.cf.fragment')).toContain('smtpd_tls_cert_file = /etc/xpanel/ssl/mail/fullchain.pem')
  })
})
