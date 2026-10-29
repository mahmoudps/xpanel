import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailboxMetadataAuthority } from '@xpanel/core'
import { createApiToken, createTestDb, createUserPrincipal } from '@xpanel/db'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import { sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'

// Real-loopback acceptance for account mailing lists. Synthetic temporary API tokens only;
// list delivery/moderation effects are not claimed.

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: Array<() => Promise<unknown>> = []
interface MailingList { id: string; accountId: string; name: string; domain: string; address: string; members: string[]; moderation: string; archiveEnabled: boolean; createdAt: string; selfSubscription?: 'open' | 'closed'; memberAuthorities?: Record<string, MailboxMetadataAuthority> }

const fixture = async () => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Mailing lists policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Mailing lists plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.44', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const php = { version: '8.3', handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }
  const account = async (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null,
    contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.44', shell: 'none', php })
  const owner = await account('mlista'), other = await account('mlistb')
  const principal = await createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  const otherPrincipal = await createUserPrincipal(database.db, { username: other.username, accountId: other.id, passwordHash: HASH })
  const token = async (principalId = principal.id) => {
    const raw = 'xp_' + randomUUID()
    await createApiToken(database.db, { principalId, name: 'Synthetic mailing lists', tokenHash: sha256Hex(raw), scopes: ['mail:read', 'mail:write'], expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const credential = await token()
  const otherCredential = await token(otherPrincipal.id)
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: 'mailing-lists-synthetic-server-secret' })
  const request = (method = 'GET', body?: unknown, raw: string | null = credential, path = '/api/mail/mailing-lists') => app.fetch(new Request('http://localhost' + path, { method,
    headers: { ...(raw ? { authorization: 'Bearer ' + raw } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  const path = join(state.rootDir, 'extended', 'mail', 'mailing-lists.json')
  const seed = async (lists: MailingList[]) => atomicWriteJson(path, lists)
  const bytes = () => readFile(path, 'utf8').catch(() => '')
  const persisted = async () => JSON.parse(await readFile(path, 'utf8')) as MailingList[]
  const list = (accountId: string, patch: Partial<MailingList> = {}): MailingList => ({
    id: randomUUID(), accountId, name: 'announce', domain: 'mlista.example.test', address: 'announce@mlista.example.test',
    members: ['one@example.test'], moderation: 'members', archiveEnabled: true, createdAt: '2026-01-01T00:00:00.000Z', ...patch,
  })
  const auditRows = (action: string) => database.db.query<{ [column: string]: unknown; action: string }>('SELECT action FROM audit_log WHERE action = $1', [action])
  return { database, state, owner, other, principal, credential, otherCredential, request, seed, bytes, persisted, list, auditRows, features }
}

describe('account mailing lists HTTP security acceptance', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    vi.restoreAllMocks()
    const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Synthetic mailing lists cleanup failed')
  })

  it('creates a normalized mailing list with validated members and audit', async () => {
    const response = await f.request('POST', { name: ' Announce ', domain: 'MLISTA.example.test', members: [' One@Example.Test ', 'two@example.test'], moderation: 'moderated', archiveEnabled: false })
    expect(response.status).toBe(201)
    const body = await response.json() as { mailingList: MailingList }
    expect(body.mailingList).toMatchObject({ accountId: f.owner.id, name: 'Announce', domain: 'mlista.example.test', address: 'announce@mlista.example.test', members: ['one@example.test', 'two@example.test'], moderation: 'moderated', archiveEnabled: false })
    expect(await f.persisted()).toEqual([body.mailingList])
    expect((await f.auditRows('mail.mailing_list.created')).length).toBe(1)
  })

  it('lists only the caller account records', async () => {
    await f.seed([f.list(f.owner.id), f.list(f.other.id, { name: 'other', address: 'other@mlistb.example.test', domain: 'mlistb.example.test' })])
    const response = await f.request('GET')
    expect(response.status).toBe(200)
    const lists = (await response.json() as { mailingLists: MailingList[] }).mailingLists
    expect(lists.map(item => item.accountId)).toEqual([f.owner.id])
    const other = await f.request('GET', undefined, f.otherCredential)
    expect(((await other.json()) as { mailingLists: MailingList[] }).mailingLists.map(item => item.accountId)).toEqual([f.other.id])
  })

  it('refuses duplicate addresses and foreign account selectors without writing', async () => {
    await f.seed([f.list(f.owner.id)])
    const before = await f.bytes()
    const duplicate = await f.request('POST', { name: 'announce', domain: 'mlista.example.test' })
    expect(duplicate.status).toBe(409)
    const foreign = await f.request('POST', { name: 'foreign', domain: 'mlistb.example.test', accountId: f.other.id })
    expect([403, 404]).toContain(foreign.status)
    expect(await f.bytes()).toBe(before)
  })

  it.each([
    ['invalid list name', { name: 'bad name', domain: 'mlista.example.test' }],
    ['invalid address', { address: 'not-an-email', domain: 'mlista.example.test' }],
    ['invalid domain', { name: 'announce', domain: 'bad domain' }],
    ['invalid member', { name: 'announce', domain: 'mlista.example.test', members: ['not-an-email'] }],
    ['duplicate member', { name: 'announce', domain: 'mlista.example.test', members: ['a@b.test', 'a@b.test'] }],
    ['invalid moderation', { name: 'announce', domain: 'mlista.example.test', moderation: 'owner' }],
    ['invalid archive flag', { name: 'announce', domain: 'mlista.example.test', archiveEnabled: 'yes' }],
  ])('refuses %s without changing stored lists', async (_name, body) => {
    const before = await f.bytes()
    const response = await f.request('POST', body)
    expect([422, 400]).toContain(response.status)
    expect(await f.bytes()).toBe(before)
  })

  it('deletes an owned list and verifies it is absent', async () => {
    const seeded = f.list(f.owner.id)
    await f.seed([seeded])
    const response = await f.request('DELETE', undefined, f.credential, '/api/mail/mailing-lists/' + seeded.id)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(await f.persisted()).toEqual([])
    expect((await f.auditRows('mail.mailing_list.deleted')).length).toBe(1)
  })

  it('refuses deleting another account list and leaves it intact', async () => {
    const foreign = f.list(f.other.id, { domain: 'mlistb.example.test', address: 'announce@mlistb.example.test' })
    await f.seed([foreign])
    const before = await f.bytes()
    const response = await f.request('DELETE', undefined, f.credential, '/api/mail/mailing-lists/' + foreign.id)
    expect([403, 404]).toContain(response.status)
    expect(await f.bytes()).toBe(before)
  })

  it('requires authentication for the workspace', async () => {
    const anonymous = await f.request('GET', undefined, null)
    expect(anonymous.status).toBe(401)
    const anonymousCreate = await f.request('POST', { name: 'announce', domain: 'mlista.example.test' }, null)
    expect(anonymousCreate.status).toBe(401)
  })

  it('defaults self subscription to closed, requires explicit open policy and refuses caller lifetime metadata', async () => {
    const closed = await f.request('POST', { address: 'private@mlista.example.test' })
    expect(closed.status).toBe(201)
    expect((await closed.json() as { mailingList: MailingList }).mailingList.selfSubscription).toBe('closed')
    const open = await f.request('POST', { address: 'public@mlista.example.test', selfSubscription: 'open' })
    expect(open.status).toBe(201)
    expect((await open.json() as { mailingList: MailingList }).mailingList.selfSubscription).toBe('open')
    const before = await f.bytes()
    for (const body of [{ address: 'invalid@mlista.example.test', selfSubscription: 'members' }, { address: 'forged@mlista.example.test', memberAuthorities: {} }]) {
      expect([400, 422]).toContain((await f.request('POST', body)).status)
      expect(await f.bytes()).toBe(before)
    }
  })

  it('serializes concurrent creates without losing an existing membership lifetime binding', async () => {
    const authority = { accountId: f.owner.id, serviceUserId: randomUUID(), mailbox: 'one@example.test' }
    const seeded = f.list(f.owner.id, { memberAuthorities: { 'one@example.test': authority }, selfSubscription: 'open' })
    await f.seed([seeded])
    const addresses = ['first@mlista.example.test', 'second@mlista.example.test', 'third@mlista.example.test']
    const replies = await Promise.all(addresses.map(address => f.request('POST', { address })))
    expect(replies.map(reply => reply.status)).toEqual([201, 201, 201])
    const saved = await f.persisted()
    expect(saved.map(item => item.address).sort()).toEqual([seeded.address, ...addresses].sort())
    expect(saved.find(item => item.id === seeded.id)).toEqual(seeded)
    const projected = await f.request('GET')
    const visible = await projected.json() as { mailingLists: MailingList[] }
    expect(visible.mailingLists.find(item => item.id === seeded.id)?.memberAuthorities).toBeUndefined()
  })

  it.each(['token', 'feature'] as const)('rechecks %s revocation after waiting for the writer and leaves lists unchanged', async kind => {
    await f.seed([f.list(f.owner.id)])
    const before = await f.bytes(), lock = f.state.store.getWriterLock(), held = await lock.acquire()
    let owned = true, notify!: () => void
    const queued = new Promise<void>(resolve => { notify = resolve }), acquire = lock.acquire.bind(lock)
    vi.spyOn(lock, 'acquire').mockImplementation((...args) => { notify(); return acquire(...args) })
    const pending = f.request('POST', { address: 'revoked@mlista.example.test' })
    try {
      await queued
      if (kind === 'token') await f.database.db.query('UPDATE api_tokens SET revoked_at=$1 WHERE token_hash=$2', [new Date().toISOString(), sha256Hex(f.credential)])
      else {
        const readFeature = f.state.store.getFeatureList.bind(f.state.store)
        vi.spyOn(f.state.store, 'getFeatureList').mockImplementation(async id => { const policy = await readFeature(id); return policy && id === f.features.id ? { ...policy, disabled: [...policy.disabled, 'mailing-lists'] } : policy })
      }
      await held.release(); owned = false
      const response = await pending
      expect([401, 403]).toContain(response.status)
      expect(await f.bytes()).toBe(before)
      expect(await f.auditRows('mail.mailing_list.created')).toEqual([])
    } finally { if (owned) await held.release(); await pending.catch(() => undefined) }
  })
})
