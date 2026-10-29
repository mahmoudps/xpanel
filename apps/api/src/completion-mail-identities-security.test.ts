import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApiToken, createTestDb, createUserPrincipal } from '@xpanel/db'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import { sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'

// Real-loopback acceptance for mailbox identities & signatures. Synthetic temporary API tokens
// authenticate only; no delivery/signature-in-message effect is claimed.

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: Array<() => Promise<unknown>> = []
interface Identity {
  id: string; mailbox: string; displayName: string; email: string; replyTo: string
  textSignature: string; htmlSignature: string; isDefault: boolean; createdAt: string
  ownerAuthority?: { accountId: string; serviceUserId: string; mailbox: string }
}
interface AuditRow { [column: string]: unknown; actor: string; principal_id: string | null; action: string; outcome: string }

const fixture = async () => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Identities policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Identities plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.33', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null,
    contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.33', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const owner = await account('idta'), other = await account('idtb')
  const mailbox = (accountId: string, login: string) => state.store.createServiceUser({ accountId, login, passwordHash: HASH,
    services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const inbox = await mailbox(owner.id, `inbox@${owner.primaryDomain}`)
  const sibling = await mailbox(owner.id, `sibling@${owner.primaryDomain}`)
  const foreign = await mailbox(other.id, `foreign@${other.primaryDomain}`)
  const principal = await createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  const foreignPrincipal = await createUserPrincipal(database.db, { username: other.username, accountId: other.id, passwordHash: HASH })
  const token = async (scopes: string[], principalId = principal.id) => {
    const raw = 'xp_' + randomUUID()
    await createApiToken(database.db, { principalId, name: 'Synthetic identities', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const inboxCredential = await token([`mailbox:${inbox.id}`, 'webmail:read', 'webmail:write'])
  const siblingCredential = await token([`mailbox:${sibling.id}`, 'webmail:read', 'webmail:write'])
  const foreignCredential = await token([`mailbox:${foreign.id}`, 'webmail:read', 'webmail:write'], foreignPrincipal.id)
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: 'identities-synthetic-server-secret-32b' })
  const base = '/api/webmail/identities'
  const request = (path: string, method = 'GET', body?: unknown, raw: string | null = inboxCredential) => app.fetch(new Request('http://localhost' + path, { method,
    headers: { ...(raw ? { authorization: 'Bearer ' + raw } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  const path = join(state.rootDir, 'extended', 'webmail', 'identities.json')
  const seed = async (identities: Identity[]) => atomicWriteJson(path, identities)
  const bytes = () => readFile(path, 'utf8').catch(() => '')
  const persisted = async () => JSON.parse(await readFile(path, 'utf8')) as Identity[]
  const authorityFor = (mailboxLogin: string) => {
    const service = [inbox, sibling, foreign].find(candidate => candidate.login === mailboxLogin)!
    return { accountId: service.accountId, serviceUserId: service.id, mailbox: service.login }
  }
  // Stored identities carry the owning mailbox lifetime; unbound legacy rows are withheld (metadata-authority.test.ts).
  const stored = (mailboxLogin: string, patch: Partial<Identity> = {}): Identity => ({
    id: randomUUID(), mailbox: mailboxLogin, ownerAuthority: authorityFor(mailboxLogin), displayName: 'Seed', email: mailboxLogin, replyTo: mailboxLogin,
    textSignature: '', htmlSignature: '', isDefault: true, createdAt: '2026-01-01T00:00:00.000Z', ...patch,
  })
  const auditRows = (action: string) => database.db.query<AuditRow>('SELECT actor, principal_id, action, outcome FROM audit_log WHERE action = $1 ORDER BY id ASC', [action])
  return { database, state, owner, other, inbox, sibling, foreign, principal, inboxCredential, siblingCredential, foreignCredential, request, base, seed, bytes, persisted, stored, authorityFor, auditRows }
}

describe('mailbox identities HTTP security acceptance', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Synthetic identities cleanup failed')
  })

  it('creates the first identity as the default and reads it back', async () => {
    const response = await f.request(f.base, 'POST', { email: f.inbox.login, displayName: 'Inbox Owner', replyTo: 'reply@example.test', textSignature: '— Sent', htmlSignature: '<p>— Sent</p>' })
    expect(response.status).toBe(201)
    const body = await response.json() as { identity: Identity }
    expect(body.identity).toMatchObject({ mailbox: f.inbox.login, displayName: 'Inbox Owner', email: f.inbox.login, replyTo: 'reply@example.test', isDefault: true })
    const listed = await f.request(f.base)
    const identities = (await listed.json() as { identities: Identity[] }).identities
    expect(identities).toEqual([body.identity])
    expect((await f.auditRows('webmail.identity.created')).length).toBe(1)
  })

  it('keeps exactly one default identity when a later identity requests default', async () => {
    const first = await (await f.request(f.base, 'POST', { email: f.inbox.login, displayName: 'First' })).json() as { identity: Identity }
    const second = await (await f.request(f.base, 'POST', { email: f.inbox.login, displayName: 'Second', isDefault: true })).json() as { identity: Identity }
    expect(second.identity.isDefault).toBe(true)
    const persisted = await f.persisted()
    // Persisted rows add the server-captured owner lifetime that the public projection omits.
    expect(persisted.filter(identity => identity.isDefault)).toEqual([{ ...second.identity, ownerAuthority: f.authorityFor(f.inbox.login) }])
    expect(persisted.find(identity => identity.id === first.identity.id)!.isDefault).toBe(false)
  })

  it.each([
    ['non-object body', 'not-an-object'],
    ['missing email', {}],
    ['unbounded display name', { email: 'inbox@idta.example.test', displayName: 'x'.repeat(201) }],
    ['invalid reply-to', { email: 'inbox@idta.example.test', replyTo: 'not-an-email' }],
    ['non-boolean default', { email: 'inbox@idta.example.test', isDefault: 'yes' }],
    ['control characters', { email: 'inbox@idta.example.test', displayName: 'bad\nname' }],
  ])('refuses %s without writing', async (_name, body) => {
    const before = await f.bytes()
    const response = await f.request(f.base, 'POST', typeof body === 'string' ? body : body)
    expect([400, 422]).toContain(response.status)
    expect(await f.bytes()).toBe(before)
  })

  it('refuses an identity email that differs from the authorized mailbox', async () => {
    const before = await f.bytes()
    const response = await f.request(f.base, 'POST', { email: f.sibling.login })
    expect(response.status).toBe(403)
    expect(await f.bytes()).toBe(before)
    const anonymous = await f.request(f.base, 'GET', undefined, null)
    expect(anonymous.status).toBe(401)
  })

  it('edits fields and transfers the exclusive default safely', async () => {
    const seed = [f.stored(f.inbox.login, { displayName: 'One' }), f.stored(f.inbox.login, { displayName: 'Two', isDefault: false })]
    await f.seed(seed)
    const target = seed[1]!
    const edited = await f.request(`${f.base}/${target.id}`, 'PATCH', { displayName: 'Two renamed', textSignature: 'sig', isDefault: true })
    expect(edited.status).toBe(200)
    expect((await edited.json() as { identity: Identity }).identity).toMatchObject({ displayName: 'Two renamed', textSignature: 'sig', isDefault: true })
    const persisted = await f.persisted()
    expect(persisted.filter(identity => identity.isDefault).map(identity => identity.id)).toEqual([target.id])
    expect((await f.auditRows('webmail.identity.updated')).length).toBe(1)
  })

  it('refuses invalid edits, mailbox/email changes and turning off the only default', async () => {
    const seed = [f.stored(f.inbox.login)]
    await f.seed(seed)
    const before = await f.bytes()
    const mailboxChange = await f.request(`${f.base}/${seed[0]!.id}`, 'PATCH', { mailbox: f.sibling.login })
    expect(mailboxChange.status).toBe(403)
    const emailChange = await f.request(`${f.base}/${seed[0]!.id}`, 'PATCH', { email: f.sibling.login })
    expect(emailChange.status).toBe(403)
    const invalidReply = await f.request(`${f.base}/${seed[0]!.id}`, 'PATCH', { replyTo: 'not-an-email' })
    expect(invalidReply.status).toBe(422)
    const lastDefault = await f.request(`${f.base}/${seed[0]!.id}`, 'PATCH', { isDefault: false })
    expect(lastDefault.status).toBe(422)
    expect(await f.bytes()).toBe(before)
  })

  it('deletes an identity, promotes a replacement default and audits the deletion', async () => {
    const seed = [f.stored(f.inbox.login, { displayName: 'Default' }), f.stored(f.inbox.login, { displayName: 'Next', isDefault: false })]
    await f.seed(seed)
    const response = await f.request(`${f.base}/${seed[0]!.id}`, 'DELETE')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, metadataReview: { status: 'review_required', reason: 'mailbox_metadata_binding_unverified' } })
    const persisted = await f.persisted()
    expect(persisted.map(identity => identity.id)).toEqual([seed[1]!.id])
    expect(persisted[0]!.isDefault).toBe(true)
    expect((await f.auditRows('webmail.identity.deleted')).length).toBe(1)
  })

  it('isolates identities between mailboxes and accounts', async () => {
    const seed = [f.stored(f.inbox.login), f.stored(f.sibling.login), f.stored(f.foreign.login)]
    await f.seed(seed)
    const inboxList = await (await f.request(f.base)).json() as { identities: Identity[] }
    expect(inboxList.identities.map(identity => identity.mailbox)).toEqual([f.inbox.login])
    const siblingList = await (await f.request(f.base, 'GET', undefined, f.siblingCredential)).json() as { identities: Identity[] }
    expect(siblingList.identities.map(identity => identity.mailbox)).toEqual([f.sibling.login])
    const foreignEdit = await f.request(`${f.base}/${seed[0]!.id}`, 'PATCH', { displayName: 'Hijack' }, f.foreignCredential)
    expect([403, 404]).toContain(foreignEdit.status)
    const foreignDelete = await f.request(`${f.base}/${seed[0]!.id}`, 'DELETE', undefined, f.foreignCredential)
    expect([403, 404]).toContain(foreignDelete.status)
    const persisted = await f.persisted()
    expect(persisted.find(identity => identity.id === seed[0]!.id)!.displayName).toBe('Seed')
  })
})
