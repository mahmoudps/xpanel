import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Account } from '@xpanel/core'
import { createApiToken, createResellerPrincipal, createRootPrincipal, createTestDb, createUserPrincipal, listAudit, setTotpSecret } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { sealTotpSecret, sha256Hex } from './auth.ts'
import { createApiApp, listenApiServer } from './server.ts'

// Public independent Argon2 vector; only fixture API tokens are authenticated here.
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'contact-target-fixture-server-secret-minimum-32-bytes'
const actors = ['root', 'reseller', 'user', 'mailbox'] as const
type Actor = typeof actors[number]
interface Contact { id: string; owner: string; fullName: string; shares: { principal: string; permission: string }[]; vcard: string }
const evidenceDir = process.env.XPANEL_CONTACT_TARGET_EVIDENCE_DIR
let observation = 0

describe('contact metadata DELETE target contracts on real local HTTP', () => {
  let db: TestDbHandle
  let state: TestStateStoreHandle
  let listener: Awaited<ReturnType<typeof listenApiServer>> | undefined
  let baseUrl: string
  let tokens: Record<Actor, string>
  let own: Contact
  let sameAccount: Contact
  let neighbor: Contact
  let ownerMailbox: string
  let supportMailbox: string
  let metadataPath: string

  const request = (actor: Actor | null, path: string, method = 'DELETE', body?: unknown) => fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(actor ? { authorization: `Bearer ${tokens[actor]}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const snapshot = async () => {
    const value = { metadata: await readFile(metadataPath, 'utf8'), state: await state.store.readSnapshot(), audit: await listAudit(db.db) }
    // Optional private diagnostic capture; ordinary test/CI runs keep fixtures temporary.
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true })
      const name = `observation-${String(++observation).padStart(4, '0')}`
      await writeFile(join(evidenceDir, `${name}-contacts.json`), value.metadata)
      await writeFile(join(evidenceDir, `${name}-snapshot.json`), JSON.stringify({ test: expect.getState().currentTestName, ...value }, null, 2))
    }
    return value
  }
  const expectUnchanged = async (before: Awaited<ReturnType<typeof snapshot>>) => expect.soft(await snapshot()).toEqual(before)

  beforeEach(async () => {
    listener = undefined
    db = await createTestDb()
    state = await createTestStateStore()
    metadataPath = join(state.rootDir, 'extended/webmail/contacts.json')
    const root = await createRootPrincipal(db.db, { username: 'root', passwordHash: PASSWORD_HASH, forcePasswordChange: false })
    await setTotpSecret(db.db, root.id, sealTotpSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', SECRET), [])
    const reseller = await state.store.createReseller({ username: 'contactreseller', passwordHash: PASSWORD_HASH, acl: ['list-accounts', 'edit-account'], maxAccounts: 5, totalDiskMb: 10000, totalBandwidthMb: 100000, oversell: false, nameservers: [], delegatedIps: [] })
    await createResellerPrincipal(db.db, { id: reseller.id, username: reseller.username, passwordHash: PASSWORD_HASH })
    const feature = await state.store.createFeatureList({ name: 'Contacts', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({ name: 'Contacts', ownerId: null, featureListId: feature.id,
      resources: { diskMb: 1024, bandwidthMbMonth: 10240, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
      caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 5, forwarders: 5, mailingLists: 2, ftpAccounts: 5, databases: 5, phpWorkers: 4 }, dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 512 })
    const account = async (username: string, ownerId: string | null): Promise<Account> => state.store.createAccount({ username, passwordHash: PASSWORD_HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId, contactEmail: `${username}@example.test`, ipv4: '192.0.2.10', shell: 'jailed',
      php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
    await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const alice = await account('contactalice', reseller.id)
    const bob = await account('contactbob', null)
    const user = await createUserPrincipal(db.db, { username: alice.username, accountId: alice.id, passwordHash: PASSWORD_HASH })
    const mailbox = async (account: Account, local: string) => state.store.createServiceUser({ accountId: account.id, login: `${local}@${account.primaryDomain}`, passwordHash: `{ARGON2ID}${PASSWORD_HASH}`, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 256, ftpDir: 'public_html' })
    const inbox = await mailbox(alice, 'inbox')
    const support = await mailbox(alice, 'support')
    const foreign = await mailbox(bob, 'inbox')
    ownerMailbox = inbox.login
    supportMailbox = support.login
    const token = async (principalId: string, scopes: string[]) => {
      const raw = `xp_${randomUUID()}`
      await createApiToken(db.db, { principalId, name: 'contact target fixture', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
      return raw
    }
    tokens = { root: await token(root.id, ['*']), reseller: await token(reseller.id, ['webmail:*']), user: await token(user.id, ['webmail:*']), mailbox: await token(user.id, [`mailbox:${inbox.id}`, 'webmail:*']) }
    listener = await listenApiServer(createApiApp({ db: db.db, store: state.store, serverSecret: SECRET }), { host: '127.0.0.1', port: 0 })
    baseUrl = `http://127.0.0.1:${listener.port}`
    const createContact = async (owner: string, fullName: string): Promise<Contact> => {
      const response = await request('root', '/api/webmail/contacts', 'POST', { owner, fullName, email: `${fullName.toLowerCase()}@example.test` })
      expect(response.status).toBe(201)
      return ((await response.json()) as { contact: Contact }).contact
    }
    own = await createContact(ownerMailbox, 'TargetA')
    sameAccount = await createContact(ownerMailbox, 'TargetB')
    neighbor = await createContact(foreign.login, 'Neighbor')
  })

  afterEach(async () => {
    if (listener) { listener.server.closeAllConnections(); await listener.close() }
    await state?.close()
    await db?.close()
  })

  it.each(actors)('never deletes B through A export/vCard paths for authorized %s', async actor => {
    const before = await snapshot()
    for (const suffix of ['export', 'vcard']) {
      for (const selector of ['query', 'body', 'matching', 'absent'] as const) {
        const path = `/api/webmail/contacts/${own.id}/${suffix}${selector === 'query' ? `?id=${sameAccount.id}` : ''}`
        const body = selector === 'body' ? { id: sameAccount.id } : selector === 'matching' ? { id: own.id } : undefined
        const response = await request(actor, path, 'DELETE', body)
        expect.soft(response.status, `${actor} ${suffix} ${selector}`).toBe(405)
        expect.soft(response.headers.get('allow')).toBe('GET')
        await expectUnchanged(before)
      }
    }
  })

  it.each(['reseller', 'user', 'mailbox'] as const)('keeps export/vCard neighbor and missing A private for %s even when B is owned', async actor => {
    const before = await snapshot()
    for (const target of [neighbor.id, randomUUID()]) {
      for (const suffix of ['export', 'vcard']) {
        const response = await request(actor, `/api/webmail/contacts/${target}/${suffix}?id=${sameAccount.id}`, 'DELETE', { id: sameAccount.id })
        expect.soft(response.status).toBe(404)
        expect.soft(response.headers.get('allow')).toBeNull()
        await expectUnchanged(before)
      }
    }
  })

  it('preserves authentication before export/vCard method rejection', async () => {
    const before = await snapshot()
    for (const suffix of ['export', 'vcard']) {
      const response = await request(null, `/api/webmail/contacts/${own.id}/${suffix}?id=${sameAccount.id}`, 'DELETE', { id: sameAccount.id })
      expect(response.status).toBe(401)
      await expectUnchanged(before)
    }
  })

  it('rejects sealed item selectors with 422 instead of silently deleting path A or body/query B', async () => {
    const before = await snapshot()
    const probes = [
      { query: `?id=${sameAccount.id}` },
      { query: '', body: { id: sameAccount.id } },
      { query: `?id=${own.id}`, body: { id: sameAccount.id } },
      { query: `?id=${own.id}&id=${sameAccount.id}` },
      { query: `?id=${neighbor.id}` },
    ]
    for (const probe of probes) {
      const response = await request('mailbox', `/api/webmail/contacts/${own.id}${probe.query}`, 'DELETE', probe.body)
      expect.soft(response.status).toBe(422)
      const problem = await response.json() as { code?: string; detail?: string }
      expect.soft(problem.code).toBe('VALIDATION')
      expect.soft(problem.detail).toMatch(/revision|selector|unsupported/i)
      await expectUnchanged(before)
    }
  })

  it('rejects ambiguous, missing, empty and non-string selectors on supported DELETE collection/item routes', async () => {
    const before = await snapshot()
    const probes = [
      { path: `/api/webmail/contacts?id=${own.id}`, body: { id: sameAccount.id } },
      { path: `/api/webmail/contacts?id=${own.id}&id=${sameAccount.id}` },
      { path: '/api/webmail/contacts' },
      { path: '/api/webmail/contacts?id=' },
      { path: '/api/webmail/contacts', body: { id: '' } },
      { path: '/api/webmail/contacts', body: { id: 17 } },
      { path: `/api/webmail/contacts/${own.id}?id=` },
      { path: `/api/webmail/contacts/${own.id}`, body: { id: null } },
    ]
    for (const probe of probes) {
      const response = await request('user', probe.path, 'DELETE', probe.body)
      expect.soft(response.status, probe.path).toBe(400)
      expect.soft((await response.json() as { code?: string }).code).toBe('VALIDATION')
      await expectUnchanged(before)
    }
  })

  it.each(actors)('deletes rightful item A once for %s while preserving same-account B and the neighbor', async actor => {
    const listed = actor === 'mailbox' ? await (await request(actor, '/api/webmail/contacts', 'GET')).json() as { contacts: Array<{ id: string; revision: string }> } : null
    const expectedRevision = listed?.contacts.find(contact => contact.id === own.id)?.revision
    const response = actor === 'mailbox' ? await request(actor, `/api/webmail/contacts/${own.id}`, 'DELETE', { expectedRevision }) : await request(actor, `/api/webmail/contacts/${own.id}?id=${own.id}`, 'DELETE', { id: own.id })
    expect(response.status).toBe(200)
    const contacts = JSON.parse(await readFile(metadataPath, 'utf8')) as Contact[]
    expect(contacts.map(contact => contact.id)).toEqual([sameAccount.id, neighbor.id])
    expect((await request(actor, `/api/webmail/contacts/${own.id}`, 'DELETE', actor === 'mailbox' ? { expectedRevision } : undefined)).status).toBe(404)
  })

  it.each(['query', 'body', 'matching', 'duplicate-matching'] as const)('refuses the sealed collection DELETE alias using %s selectors without a current item revision', async mode => {
    const query = mode === 'body' ? '' : mode === 'duplicate-matching' ? `?id=${own.id}&id=${own.id}` : `?id=${own.id}`
    const body = mode === 'body' || mode === 'matching' ? { id: own.id } : undefined
    const before = await snapshot()
    expect((await request('mailbox', `/api/webmail/contacts${query}`, 'DELETE', body)).status).toBe(422)
    await expectUnchanged(before)
  })

  it.each(['reseller', 'user', 'mailbox'] as const)('keeps neighboring and nonexistent supported DELETE targets unchanged for %s', async actor => {
    const before = await snapshot()
    for (const id of [neighbor.id, randomUUID()]) {
      for (const path of [`/api/webmail/contacts/${id}`, `/api/webmail/contacts?id=${id}`]) {
        const response = await request(actor, path, 'DELETE', actor === 'mailbox' && !path.includes('?') ? { expectedRevision: '0'.repeat(64) } : undefined)
        expect.soft(response.status).toBe(actor === 'mailbox' && path.includes('?') ? 422 : 404)
        await expectUnchanged(before)
      }
    }
  })

  it('retains GET export/vCard aliases and the terminal DELETE share action without deleting the contact', async () => {
    const shared = await request('mailbox', `/api/webmail/contacts/${own.id}/share`, 'POST', { principal: supportMailbox, permission: 'read' })
    expect(shared.status).toBe(200)
    const before = await snapshot()
    for (const suffix of ['export', 'vcard']) {
      const response = await request('mailbox', `/api/webmail/contacts/${own.id}/${suffix}`, 'GET')
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ contactId: own.id, vcard: own.vcard })
      await expectUnchanged(before)
    }
    expect((await request('mailbox', `/api/webmail/contacts/${own.id}/share`, 'DELETE', { principal: supportMailbox })).status).toBe(200)
    const contacts = JSON.parse(await readFile(metadataPath, 'utf8')) as Contact[]
    expect(contacts.map(contact => contact.id)).toEqual([own.id, sameAccount.id, neighbor.id])
    expect(contacts.find(contact => contact.id === own.id)?.shares).toEqual([])
  })
})
