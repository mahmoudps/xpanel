import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { createRootPrincipal, createTestDb, createUserPrincipal } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { createExtendedApiRouter } from './extended-routes.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const fixture = async () => {
  const database = await createTestDb()
  const state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  const features = await state.store.createFeatureList({ name: 'Fixture features', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Fixture plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1024, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
    caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const php = { version: '8.3', handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }
  const account = await state.store.createAccount({ username: 'alpha', primaryDomain: 'alpha.example.test', passwordHash: HASH, planId: plan.id, ownerId: null, contactEmail: 'owner@alpha.example.test', ipv4: '192.0.2.10', shell: 'none', php })
  const other = await state.store.createAccount({ username: 'beta', primaryDomain: 'beta.example.test', passwordHash: HASH, planId: plan.id, ownerId: null, contactEmail: 'owner@beta.example.test', ipv4: '192.0.2.10', shell: 'none', php })
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH })
  const user = await createUserPrincipal(database.db, { username: 'alpha', passwordHash: HASH, accountId: account.id })
  let caller: AuthenticatedCaller = { principal: { kind: 'root', id: root.id, username: root.username }, principalRecord: root, sessionId: null, sessionToken: null, apiTokenId: null, scopes: [], csrfValid: true, mfaVerified: true }
  const material = vi.fn(async (_caller: AuthenticatedCaller, _domain: string): Promise<{ selector: string; publicKeyPem: string } | null> => ({ selector: 'xp202610', publicKeyPem: pair.publicKey }))
  const helpers: ExtendedRouteHelpers = {
    db: database.db, store: state.store, requireCaller: async () => caller,
    assertRoot: async value => { if (value.principal.kind !== 'root') fail('FORBIDDEN', 'root required') },
    assertCanAccessAccount: async (value, target) => { if (value.principal.kind === 'user' && value.principal.accountId !== target.id) fail('FORBIDDEN', 'account access denied') },
    resolveAccountParam: async () => account, resolveResellerId: async () => null, emitAudit: async () => {}, triggerReconcile: async () => null,
    readDkimPublicMaterial: material,
  }
  const router = createExtendedApiRouter(helpers)
  const post = (domains = [account.primaryDomain]) => {
    const url = new URL('https://panel.example.test/api/dns/email-auth/batch')
    return router.handleExtendedRoute(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domains }) }), url, 'POST')
  }
  return { state, account, other, material, helpers, post, useTenant: () => { caller = { ...caller, principal: { kind: 'user', id: user.id, username: user.username, accountId: account.id }, principalRecord: user } } }
}

describe('DNS email-auth public key provisioning', () => {
  it('publishes the actual public key and active selector without leaking a private key', async () => {
    const f = await fixture()
    const response = await f.post()
    const body = await response!.json() as { provisioned: Array<{ dkim: string }> }
    const zone = await f.state.store.getDnsZone(f.account.primaryDomain)
    const record = zone?.records.find(r => r.name === 'xp202610._domainkey')
    const encoded = /\bp=([^;\s]+)/.exec(record?.content ?? '')?.[1]
    const reconstructed = createPublicKey({ key: Buffer.from(encoded ?? '', 'base64'), type: 'spki', format: 'der' })
    expect(reconstructed.export({ type: 'spki', format: 'pem' }).toString()).toBe(pair.publicKey)
    expect(body.provisioned[0]?.dkim).toBe(record?.content)
    expect(JSON.stringify(body)).not.toContain('PRIVATE KEY')
    expect(JSON.stringify(zone)).not.toContain('PRIVATE KEY')
    expect(zone?.records.some(r => r.name === 'default._domainkey')).toBe(false)
  })

  it('keeps existing SPF, DMARC and overlapping selectors', async () => {
    const f = await fixture()
    const records = [
      { id: randomUUID(), zone: f.account.primaryDomain, name: '@', type: 'TXT' as const, ttl: 3600, content: 'v=spf1 mx -all', priority: null },
      { id: randomUUID(), zone: f.account.primaryDomain, name: '_dmarc', type: 'TXT' as const, ttl: 3600, content: 'v=DMARC1; p=reject', priority: null },
      { id: randomUUID(), zone: f.account.primaryDomain, name: 'xp202609._domainkey', type: 'TXT' as const, ttl: 3600, content: 'v=DKIM1; k=rsa; p=synthetic-old-selector', priority: null },
    ]
    await f.state.store.saveDnsZone({ id: randomUUID(), accountId: f.account.id, name: f.account.primaryDomain, serial: 2026102400, records })
    await f.post()
    const zone = await f.state.store.getDnsZone(f.account.primaryDomain)
    for (const record of records) expect(zone?.records).toContainEqual(record)
  })

  it.each(['missing', 'label-hash', 'private', 'selector'])('fails closed for %s material without mutating any zone', async kind => {
    const f = await fixture()
    const before = await f.state.store.getDnsZone(f.account.primaryDomain)
    f.material.mockResolvedValue(kind === 'missing' ? null : { selector: kind === 'selector' ? '../wrong' : 'xp202610', publicKeyPem: kind === 'private' ? pair.privateKey : kind === 'label-hash' ? 'eA==': pair.publicKey })
    await expect(f.post()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await f.state.store.getDnsZone(f.account.primaryDomain)).toEqual(before)
  })

  it('authorizes the complete domain batch before requesting material', async () => {
    const f = await fixture()
    f.useTenant()
    const before = await f.state.store.getDnsZone(f.account.primaryDomain)
    await expect(f.post([f.account.primaryDomain, f.other.primaryDomain])).rejects.toBeDefined()
    expect(f.material).not.toHaveBeenCalled()
    expect(await f.state.store.getDnsZone(f.account.primaryDomain)).toEqual(before)
  })

  it('validates every requested key before the first desired-zone mutation', async () => {
    const f = await fixture()
    const before = await f.state.store.getDnsZone(f.account.primaryDomain)
    f.material.mockResolvedValueOnce({ selector: 'xp202610', publicKeyPem: pair.publicKey }).mockResolvedValueOnce(null)
    await expect(f.post([f.account.primaryDomain, f.other.primaryDomain])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await f.state.store.getDnsZone(f.account.primaryDomain)).toEqual(before)
  })
})
