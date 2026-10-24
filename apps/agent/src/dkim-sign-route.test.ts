import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { defaultFirewallRules, suggestServerSettings } from '@xpanel/core'
import { createRootPrincipal, createTestDb, createUserPrincipal, listAudit } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import { HostReconciler } from './reconciler.ts'
import { agentCallerHeaders, createAgentApp } from './server.ts'
import { verifySignedMime } from './services/dkim-sign.ts'

const TOKEN = 'b'.repeat(64)
const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'

const mimeFor = (from: string): string => [
  `From: ${from}`,
  'To: b@demo.example.test',
  'Subject: hi',
  'Date: Sat, 24 Oct 2026 00:00:00 +0000',
  'Message-ID: <1@demo.example.test>',
  '',
  'Hello',
  '',
].join('\r\n')

describe('POST /host/dkim-sign', () => {
  it('signs only the account From domain from the webmail send path', async () => {
    const state = await createTestStateStore()
    const db = await createTestDb()
    const executor = new FakeHostExecutor()
    const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
    const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
    await state.store.saveServerSettings({
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
    for (const rule of defaultFirewallRules({ panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 })) {
      await state.store.createFirewallRule(rule, { lockout: null })
    }
    const features = await state.store.createFeatureList({ name: 'Standard', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({
      name: 'Pro',
      ownerId: null,
      featureListId: features.id,
      resources: {
        diskMb: 10_240, bandwidthMbMonth: 102_400, ioReadBps: 50_000_000, ioWriteBps: 50_000_000,
        ioReadIops: 2000, ioWriteIops: 2000, memoryMb: 1024, maxProcesses: 64, cpuPercent: 200,
      },
      caps: {
        addonDomains: 10, aliasDomains: 10, subdomains: 20, mailboxes: 20, forwarders: 20,
        mailingLists: 5, ftpAccounts: 10, databases: 10, phpWorkers: 8,
      },
      dedicatedIp: false,
      shell: 'none',
      defaultMailboxQuotaMb: 1024,
    })
    await state.store.saveServerIp({
      address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared',
      ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '',
    })
    const php = {
      version: '8.3' as const,
      handler: 'fpm' as const,
      fpm: { mode: 'ondemand' as const, maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 },
      ini: {},
    }
    const alice = await state.store.createAccount({
      username: 'alice', passwordHash: ARGON2, primaryDomain: 'alice.example.com', planId: plan.id,
      ownerId: null, contactEmail: 'alice@example.com', ipv4: '203.0.113.10', shell: 'none', php,
    })
    await state.store.saveServerIp({
      address: '203.0.113.11', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared',
      ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '',
    })
    const bob = await state.store.createAccount({
      username: 'bob', passwordHash: ARGON2, primaryDomain: 'bob.example.com', planId: plan.id,
      ownerId: null, contactEmail: 'bob@example.com', ipv4: '203.0.113.11', shell: 'none', php,
    })
    await state.store.createServiceUser({
      accountId: alice.id, login: 'a@alice.example.com', services: { email: true, ftp: false, webdisk: false },
      mailboxQuotaMb: 512, ftpDir: 'public_html', passwordHash: ARGON2,
    })
    await state.store.createServiceUser({
      accountId: bob.id, login: 'b@bob.example.com', services: { email: true, ftp: false, webdisk: false },
      mailboxQuotaMb: 512, ftpDir: 'public_html', passwordHash: ARGON2,
    })
    const aliceId = (await createUserPrincipal(db.db, { username: 'alice', passwordHash: ARGON2, accountId: alice.id })).id
    await createRootPrincipal(db.db, { username: 'root', passwordHash: ARGON2 })
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const signing = {
      domains: {
        'alice.example.com': { selector: 'xp202610', publicKeyPem: pair.publicKey, dnsTxt: 'v=DKIM1; k=rsa; p=abc' },
      },
    }
    executor.files.set('/etc/opendkim/signing.json', {
      path: '/etc/opendkim/signing.json', content: `${JSON.stringify(signing)}\n`, mode: 0o644, owner: 'root', group: 'root',
    })
    executor.files.set('/etc/opendkim/keys/alice.example.com/xp202610.private', {
      path: '/etc/opendkim/keys/alice.example.com/xp202610.private', content: pair.privateKey, mode: 0o600, owner: 'opendkim', group: 'opendkim',
    })
    const app = createAgentApp({
      reconciler: new HostReconciler({ store: state.store, db: db.db, executor, os }),
      store: state.store,
      db: db.db,
      executor,
      agentToken: TOKEN,
      os: { id: os.id, versionId: os.versionId, family: os.family },
    })
    const headers = { ...agentCallerHeaders({ principalId: aliceId, token: TOKEN }), 'content-type': 'application/json' }
    const post = (body: unknown) => app.fetch(new Request('http://agent.local/host/dkim-sign', {
      method: 'POST', headers, body: JSON.stringify(body),
    }))
    const open = await post({ mailbox: 'a@alice.example.com', rawMime: mimeFor('a@alice.example.com') })
    expect(open.status).toBe(403)
    const foreign = await post({ purpose: 'webmail-send', mailbox: 'a@alice.example.com', rawMime: mimeFor('a@foreign.example.test') })
    expect(foreign.status).toBe(403)
    expect(await foreign.text()).not.toContain('DKIM-Signature')
    const cross = await post({ purpose: 'webmail-send', mailbox: 'b@bob.example.com', rawMime: mimeFor('b@bob.example.com') })
    expect(cross.status).toBe(403)
    expect(await cross.text()).not.toContain('DKIM-Signature')
    const huge = await post({ purpose: 'webmail-send', mailbox: 'a@alice.example.com', rawMime: `${'x'.repeat(12_000_001)}` })
    expect(huge.status).toBe(422)
    const invalid = await post({ purpose: 'webmail-send', mailbox: 'not-an-address', rawMime: mimeFor('a@alice.example.com') })
    expect(invalid.status).toBe(422)
    const mixed = await post({
      purpose: 'webmail-send',
      mailbox: 'a@alice.example.com',
      rawMime: mimeFor('a@foreign.example, b@alice.example.com'),
    })
    expect(mixed.status).toBe(403)
    expect(await mixed.text()).not.toContain('DKIM-Signature')
    const wide = 'é'.repeat(6_000_001)
    expect(wide.length).toBeLessThan(12_000_000)
    expect(Buffer.byteLength(wide, 'utf8')).toBeGreaterThan(12_000_000)
    const multibyte = await post({ purpose: 'webmail-send', mailbox: 'a@alice.example.com', rawMime: wide })
    expect(multibyte.status).toBe(422)
    const signed = await post({ purpose: 'webmail-send', mailbox: 'a@alice.example.com', rawMime: mimeFor('a@alice.example.com') })
    expect(signed.status).toBe(200)
    const body = await signed.json() as { rawMime?: string }
    expect(body.rawMime?.includes('DKIM-Signature:')).toBe(true)
    expect(verifySignedMime(body.rawMime ?? '', pair.publicKey)).toBe(true)
    for (let i = 0; i < 29; i += 1) {
      const again = await post({ purpose: 'webmail-send', mailbox: 'a@alice.example.com', rawMime: mimeFor('a@alice.example.com') })
      expect(again.status).toBe(200)
    }
    const limited = await post({ purpose: 'webmail-send', mailbox: 'a@alice.example.com', rawMime: mimeFor('a@alice.example.com') })
    expect(limited.status).toBe(403)
    const audit = await listAudit(db.db, { action: 'host.dkim-sign', limit: 100 })
    expect(audit.some(row => row.outcome === 'denied' && row.detail && JSON.stringify(row.detail).includes('from-domain'))).toBe(true)
    expect(audit.some(row => row.outcome === 'denied' && row.detail && JSON.stringify(row.detail).includes('cross-account'))).toBe(true)
    expect(audit.some(row => row.outcome === 'denied' && row.detail && JSON.stringify(row.detail).includes('"reason":"mailbox"'))).toBe(true)
    expect(audit.some(row => row.outcome === 'denied' && row.detail && JSON.stringify(row.detail).includes('"reason":"size"'))).toBe(true)
    expect(audit.some(row => row.outcome === 'ok')).toBe(true)
    await state.close()
    await db.close()
  })
})
