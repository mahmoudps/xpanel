import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiToken, createTestDb, createUserPrincipal } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'

// Real-loopback acceptance for the account spam-settings route. Synthetic temporary API tokens only;
// no MTA/spamassassin effect is claimed.

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: Array<() => Promise<unknown>> = []
interface SpamSettings {
  enabled: boolean; rewriteSubjectScore: number; addHeaderScore: number; greylistScore: number; rejectScore: number
  spamBoxEnabled: boolean; autoDeleteSpam: boolean; autoDeleteScore: number; allowlist: string[]; blocklist: string[]; updatedAt: string
}

const fixture = async () => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Spam policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Spam plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.55', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = async (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null,
    contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.55', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const owner = await account('spama'), other = await account('spamb')
  const principal = await createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  const otherPrincipal = await createUserPrincipal(database.db, { username: other.username, accountId: other.id, passwordHash: HASH })
  const token = async (principalId = principal.id) => {
    const raw = 'xp_' + randomUUID()
    await createApiToken(database.db, { principalId, name: 'Synthetic spam settings', tokenHash: sha256Hex(raw), scopes: ['mail:read', 'mail:write'], expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const credential = await token()
  const otherCredential = await token(otherPrincipal.id)
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: 'spam-settings-synthetic-server-secret' })
  const request = (body?: unknown, raw: string | null = credential, query = '') => app.fetch(new Request('http://localhost/api/mail/spam-settings' + query, { method: body === undefined ? 'GET' : 'PUT',
    headers: { ...(raw ? { authorization: 'Bearer ' + raw } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  const spamPath = join(state.rootDir, 'extended', 'mail', 'accounts', owner.id, 'spam-settings.json')
  const bytes = () => readFile(spamPath, 'utf8').catch(() => '')
  const persisted = async () => JSON.parse(await readFile(spamPath, 'utf8')) as SpamSettings
  const auditRows = () => database.db.query<{ action: string }>('SELECT action FROM audit_log WHERE action = $1', ['mail.spam_settings.updated'])
  return { database, state, owner, other, principal, credential, otherCredential, request, spamPath, bytes, persisted, auditRows, features }
}

describe('account spam settings HTTP security acceptance', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    vi.restoreAllMocks()
    const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Synthetic spam settings cleanup failed')
  })

  it('reads documented defaults for the signed-in owner', async () => {
    const response = await f.request()
    expect(response.status).toBe(200)
    const body = await response.json() as { settings: SpamSettings }
    expect(body.settings).toMatchObject({ enabled: true, spamBoxEnabled: true, autoDeleteSpam: false, rejectScore: 15, allowlist: [], blocklist: [] })
    expect(body.settings.updatedAt).toEqual(expect.any(String))
  })

  it('stores validated settings with an account-scoped audit and persisted readback', async () => {
    const response = await f.request({ enabled: false, rejectScore: 22.5, spamBoxEnabled: false, autoDeleteSpam: true, autoDeleteScore: 30, allowlist: [' 192.0.2.10 ', '2001:db8::1'], blocklist: ['bad.example.test'] })
    expect(response.status).toBe(200)
    const body = await response.json() as { settings: SpamSettings }
    expect(body.settings).toMatchObject({ enabled: false, rejectScore: 22.5, spamBoxEnabled: false, autoDeleteSpam: true, autoDeleteScore: 30, allowlist: ['192.0.2.10', '2001:db8::1'], blocklist: ['bad.example.test'] })
    const persisted = await f.persisted()
    expect(persisted).toEqual(body.settings)
    expect((await f.auditRows()).length).toBe(1)
  })

  it.each([
    ['string score', { rejectScore: '15' }],
    ['out-of-range score', { rejectScore: 101 }],
    ['negative score', { greylistScore: -1 }],
    ['invalid boolean', { enabled: 'yes' }],
    ['non-array list', { allowlist: '192.0.2.10' }],
    ['invalid list entry', { blocklist: ['bad entry'] }],
    ['duplicate list entry', { allowlist: ['192.0.2.10', '192.0.2.10'] }],
    ['unknown field', { smtp: 'synthetic' }],
    ['non-object body', 'not-an-object'],
  ])('refuses %s without writing', async (_name, body) => {
    await f.request({ rejectScore: 20 })
    const before = await f.bytes()
    const response = await f.request(body)
    expect([400, 422]).toContain(response.status)
    expect(await f.bytes()).toBe(before)
  })

  it('refuses a foreign account selector and anonymous access', async () => {
    const before = await f.bytes()
    const foreign = await f.request({ rejectScore: 20 }, f.credential, '?accountId=' + f.other.id)
    expect([403, 404]).toContain(foreign.status)
    const anonymous = await f.request({ rejectScore: 20 }, null)
    expect(anonymous.status).toBe(401)
    const anonymousRead = await f.request(undefined, null)
    expect(anonymousRead.status).toBe(401)
    expect(await f.bytes()).toBe(before)
  })

  it('does not let another account overwrite the owner settings', async () => {
    expect((await f.request({ rejectScore: 25 })).status).toBe(200)
    const before = await f.bytes()
    const other = await f.request({ rejectScore: 99 }, f.otherCredential)
    expect(other.status).toBe(200)
    expect(await f.bytes()).toBe(before)
    const otherFile = join(f.state.rootDir, 'extended', 'mail', 'accounts', f.other.id, 'spam-settings.json')
    const otherSettings = JSON.parse(await readFile(otherFile, 'utf8')) as SpamSettings
    expect(otherSettings.rejectScore).toBe(99)
  })

  it('serializes concurrent partial updates so independent account policy fields are retained', async () => {
    expect((await f.request({ addHeaderScore: 5 })).status).toBe(200)
    const replies = await Promise.all([f.request({ rejectScore: 22 }), f.request({ spamBoxEnabled: false }), f.request({ allowlist: ['sender@example.test'] })])
    expect(replies.map(reply => reply.status)).toEqual([200, 200, 200])
    expect(await f.persisted()).toMatchObject({ addHeaderScore: 5, rejectScore: 22, spamBoxEnabled: false, allowlist: ['sender@example.test'] })
  })

  it.each(['token', 'feature'] as const)('rechecks %s revocation after waiting for the policy writer without overwriting settings', async kind => {
    expect((await f.request({ rejectScore: 20 })).status).toBe(200)
    const before = await f.bytes(), auditBefore = (await f.auditRows()).length, lock = f.state.store.getWriterLock(), held = await lock.acquire()
    let owned = true, notify!: () => void
    const queued = new Promise<void>(resolve => { notify = resolve }), acquire = lock.acquire.bind(lock)
    vi.spyOn(lock, 'acquire').mockImplementation((...args) => { notify(); return acquire(...args) })
    const pending = f.request({ rejectScore: 99 })
    try {
      await queued
      if (kind === 'token') await f.database.db.query('UPDATE api_tokens SET revoked_at=$1 WHERE token_hash=$2', [new Date().toISOString(), sha256Hex(f.credential)])
      else {
        const readFeature = f.state.store.getFeatureList.bind(f.state.store)
        vi.spyOn(f.state.store, 'getFeatureList').mockImplementation(async id => { const policy = await readFeature(id); return policy && id === f.features.id ? { ...policy, disabled: [...policy.disabled, 'spam-filters'] } : policy })
      }
      await held.release(); owned = false
      expect([401, 403]).toContain((await pending).status)
      expect(await f.bytes()).toBe(before)
      expect((await f.auditRows()).length).toBe(auditBefore)
    } finally { if (owned) await held.release(); await pending.catch(() => undefined) }
  })
})
