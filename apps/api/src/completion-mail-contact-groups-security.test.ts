import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { createApiToken, createTestDb, createUserPrincipal } from '@xpanel/db'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import { authenticateRequest, sha256Hex } from './auth.ts'
import { assertRequestAuthorized } from './authorization.ts'
import { createApiApp, listenApiServer } from './server.ts'
import { createContactToolsRoutes } from './mail/contact-tools-routes.ts'
import { CONTACTS_PER_MAILBOX_MAX, contactWorkspaceRevision, createWorkspaceContact } from './mail/contact-workspace.ts'
import type { WebmailContact } from './extended-routes.ts'

// Real loopback HTTP + disposable database/state. Contact metadata only; no CardDAV or native sync.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = randomUUID() + randomUUID()
const cleanup: Array<() => Promise<unknown>> = []
type Group = { name: string; contactIds: string[]; revision: string }
type Listing = { context: { mailbox: string }; contacts: Array<Pick<WebmailContact, 'id' | 'owner' | 'fullName' | 'email' | 'groups'> & { revision: string }>; groups: Group[]; revision: string; capacity: { ownedContacts: number; maxContacts: number; groups: number; maxGroups: number; maxGroupsPerContact: number } }
const contactFields = { fullName: 'Contact', email: 'contact@example.test', phone: '+123456789', organization: 'Original organization', title: 'Original title' }

const fixture = async () => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Contact groups policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Contact groups plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.21', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const makeAccount = (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null,
    contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.21', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const owner = await makeAccount('cgroupsa'), foreignOwner = await makeAccount('cgroupsb')
  const mailbox = (accountId: string, login: string) => state.store.createServiceUser({ accountId, login, passwordHash: HASH, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const inbox = await mailbox(owner.id, `inbox@${owner.primaryDomain}`), sibling = await mailbox(owner.id, `sibling@${owner.primaryDomain}`), foreign = await mailbox(foreignOwner.id, `foreign@${foreignOwner.primaryDomain}`)
  const principal = await createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  const foreignPrincipal = await createUserPrincipal(database.db, { username: foreignOwner.username, accountId: foreignOwner.id, passwordHash: HASH })
  const token = async (serviceId: string | null, principalId = principal.id, scopes = ['webmail:read', 'webmail:write']) => {
    const raw = 'xp_' + randomUUID()
    await createApiToken(database.db, { principalId, name: 'Synthetic contact groups', tokenHash: sha256Hex(raw), scopes: [...(serviceId ? ['mailbox:' + serviceId] : []), ...scopes], expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const credential = await token(inbox.id), siblingCredential = await token(sibling.id), foreignCredential = await token(foreign.id, foreignPrincipal.id)
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET })
  const server = await listenApiServer(app); cleanup.push(() => server.close())
  const request = (path: string, method = 'GET', body?: unknown, raw: string | null = credential) => fetch(`http://127.0.0.1:${server.port}` + path, { method,
    headers: { ...(raw ? { authorization: 'Bearer ' + raw } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const authority = (service: typeof inbox) => ({ accountId: service.accountId, serviceUserId: service.id, mailbox: service.login })
  const boundContact = (service: typeof inbox, fields: typeof contactFields) => {
    const row = { ...createWorkspaceContact(service.login, fields), ownerAuthority: authority(service) }
    row.vcard = row.vcard.replace('END:VCARD', 'UID:urn:uuid:' + row.id + '\r\nNOTE:Preserved opaque note\r\n continued text\r\nX-ORIGINAL:unchanged\r\nEND:VCARD')
    return row
  }
  const own = boundContact(inbox, { ...contactFields, fullName: 'Own contact' })
  const shared = { ...boundContact(inbox, { ...contactFields, fullName: 'Shared contact' }), shares: [{ principal: sibling.login, permission: 'read-write' as const, granteeAuthority: authority(sibling), sharedAt: '2026-01-01T00:00:00.000Z' }] }
  const siblingPrivate = boundContact(sibling, { ...contactFields, fullName: 'Sibling private' })
  const foreignContact = boundContact(foreign, { ...contactFields, fullName: 'Foreign private' })
  const contactsPath = join(state.rootDir, 'extended', 'webmail', 'contacts.json'), groupsPath = join(state.rootDir, 'extended', 'webmail', 'contact-groups.json')
  await atomicWriteJson(contactsPath, [own, shared, siblingPrivate, foreignContact])
  const bytes = () => readFile(contactsPath, 'utf8')
  const groupBytes = () => readFile(groupsPath, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
  const contacts = async () => JSON.parse(await bytes()) as WebmailContact[]
  const list = async (raw = credential): Promise<Listing> => { const response = await request('/api/webmail/contact-groups', 'GET', undefined, raw); expect(response.status).toBe(200); return response.json() as Promise<Listing> }
  const createGroup = async (name: string, contactIds: string[] = []) => {
    const current = await list(), response = await request('/api/webmail/contact-groups', 'POST', { name, contactIds, expectedRevision: current.revision })
    expect(response.status).toBe(201)
    return (await response.json() as { group: Group; revision: string }).group
  }
  const rawRequest = (path: string, method: string, body: unknown) => new Request('http://localhost' + path, { method, headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const requireCaller = async (req: Request) => {
    const caller = await authenticateRequest(database.db, req, { serverSecret: SECRET })
    if (!caller) return fail('UNAUTHENTICATED', 'authentication required')
    await assertRequestAuthorized(state.store, caller, req)
    return caller
  }
  return { database, state, owner, inbox, sibling, foreign, authority, principal, credential, siblingCredential, foreignCredential, token, request, own, shared, siblingPrivate, foreignContact, contactsPath, groupsPath, bytes, groupBytes, contacts, list, createGroup, rawRequest, requireCaller }
}

describe('mailbox contact groups/deletion/capacity loopback acceptance', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    vi.restoreAllMocks()
    const outcomes = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
    const errors = outcomes.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Contact groups fixture cleanup failed')
  })

  it('reads an exact empty catalog and mailbox-owned capacity without writing metadata', async () => {
    const before = await f.bytes(), listing = await f.list()
    expect(listing.context.mailbox).toBe(f.inbox.login)
    expect(listing).toMatchObject({ metadataReview: { status: 'review_required', reason: 'mailbox_metadata_binding_unverified' } })
    expect(listing.groups).toEqual([])
    expect(listing.contacts.map(contact => contact.id).sort()).toEqual([f.own.id, f.shared.id].sort())
    expect(Object.keys(listing.contacts[0]!).sort()).toEqual(['email', 'fullName', 'groups', 'id', 'owner', 'revision'])
    expect(listing.capacity).toEqual({ ownedContacts: 2, maxContacts: 10000, groups: 0, maxGroups: 256, maxGroupsPerContact: 32 })
    expect(await f.bytes()).toBe(before); expect(await f.groupBytes()).toBeNull()
  })
  it('projects legacy group membership without inventing IDs or writing definitions', async () => {
    await atomicWriteJson(f.contactsPath, [{ ...f.own, groups: ['Existing group'] }, f.shared, f.siblingPrivate, f.foreignContact])
    const before = await f.bytes(), listing = await f.list()
    expect(listing.groups).toEqual([{ name: 'Existing group', contactIds: [f.own.id], revision: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    expect(await f.groupBytes()).toBeNull(); expect(await f.bytes()).toBe(before)
  })
  it('creates a real empty group with scoped audit and stable readback', async () => {
    const group = await f.createGroup('Friends')
    expect(group.contactIds).toEqual([])
    expect((await f.list()).groups).toEqual([group])
    expect(JSON.parse((await f.groupBytes())!)).toContainEqual({ owner: f.inbox.login, ownerAuthority: f.authority(f.inbox), name: 'Friends', createdAt: expect.any(String) })
    expect((await f.database.db.query('SELECT action FROM audit_log WHERE action = $1', ['webmail.contact_group.created'])).length).toBe(1)
  })
  it('renames a group and replaces exact owned memberships without changing contact fields or foreign rows', async () => {
    const group = await f.createGroup('Friends', [f.own.id])
    const before = await f.contacts()
    const response = await f.request('/api/webmail/contact-groups/Friends', 'PATCH', { name: 'Team', contactIds: [f.shared.id], expectedRevision: group.revision })
    expect(response.status).toBe(200)
    const saved = await f.contacts()
    for (const contact of saved) { const original = before.find(row => row.id === contact.id)!; const { groups: _groups, vcard: _vcard, ...rest } = contact; const { groups: _oldGroups, vcard: _oldVcard, ...oldRest } = original; expect(rest).toEqual(oldRest); expect(contact.vcard.replace(/CATEGORIES:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*\r?\n/g, '')).toBe(original.vcard.replace(/CATEGORIES:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*\r?\n/g, '')) }
    expect(saved.find(contact => contact.id === f.own.id)!.groups).toEqual([])
    expect(saved.find(contact => contact.id === f.shared.id)!.groups).toEqual(['Team'])
    expect(saved.find(contact => contact.id === f.shared.id)!.vcard).toContain('CATEGORIES:Team')
    expect(saved.find(contact => contact.id === f.foreignContact.id)).toEqual(before.find(contact => contact.id === f.foreignContact.id))
    expect((await f.list()).groups.map(group => group.name)).toEqual(['Team'])
  })
  it('deletes a group and its memberships but preserves the contacts', async () => {
    const group = await f.createGroup('Friends', [f.own.id, f.shared.id])
    const response = await f.request('/api/webmail/contact-groups/Friends', 'DELETE', { expectedRevision: group.revision })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ context: { mailbox: f.inbox.login }, deletedGroup: 'Friends', stateChanged: true })
    expect((await f.contacts()).filter(contact => contact.owner === f.inbox.login).every(contact => contact.groups.length === 0)).toBe(true)
    expect((await f.contacts())).toHaveLength(4); expect((await f.list()).groups).toEqual([])
  })
  it('assigns known groups with a contact revision and preserves the same exported categories', async () => {
    await f.createGroup('Friends, team')
    const response = await f.request(`/api/webmail/contacts/${f.own.id}/groups`, 'PUT', { groups: ['Friends, team'], expectedRevision: contactWorkspaceRevision(f.own) })
    expect(response.status).toBe(200)
    const body = await response.json() as { contact: WebmailContact & { revision: string } }
    expect(body.contact.groups).toEqual(['Friends, team'])
    expect(body.contact.vcard).toContain('CATEGORIES:Friends\\, team')
    expect((await f.list()).groups[0]!.contactIds).toEqual([f.own.id])
  })
  it('requires owner-only current-revision deletion and preserves empty groups', async () => {
    await f.createGroup('Friends', [f.own.id])
    const current = (await f.contacts()).find(contact => contact.id === f.own.id)!
    const stale = await f.request(`/api/webmail/contacts/${current.id}`, 'DELETE', { expectedRevision: contactWorkspaceRevision(f.own) })
    expect(stale.status).toBe(409)
    const before = await f.bytes()
    const sharedDelete = await f.request(`/api/webmail/contacts/${f.shared.id}`, 'DELETE', { expectedRevision: contactWorkspaceRevision(f.shared) }, f.siblingCredential)
    expect(sharedDelete.status).toBe(403); expect(await f.bytes()).toBe(before)
    const response = await f.request(`/api/webmail/contacts/${current.id}`, 'DELETE', { expectedRevision: contactWorkspaceRevision(current) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ context: { mailbox: f.inbox.login }, deletedContactId: current.id, stateChanged: true })
    expect((await f.contacts()).some(contact => contact.id === current.id)).toBe(false)
    expect((await f.list()).groups[0]!.contactIds).toEqual([])
  })
  it('refuses stale group writes and consumes a collection revision only once under concurrency', async () => {
    const listing = await f.list()
    const responses = await Promise.all(['One', 'Two'].map(name => f.request('/api/webmail/contact-groups', 'POST', { name, contactIds: [], expectedRevision: listing.revision })))
    expect(responses.map(response => response.status).sort()).toEqual([201, 409])
    const group = (await f.list()).groups[0]!
    const input = { name: group.name, contactIds: [f.own.id], expectedRevision: group.revision }
    expect((await f.request('/api/webmail/contact-groups/' + group.name, 'PATCH', input)).status).toBe(200)
    const before = await f.bytes(), metadata = await f.groupBytes()
    expect((await f.request('/api/webmail/contact-groups/' + group.name, 'PATCH', input)).status).toBe(409)
    expect(await f.bytes()).toBe(before); expect(await f.groupBytes()).toBe(metadata)
  })
  it.each([
    ['unknown field', { name: 'Friends', contactIds: [], owner: 'foreign@example.test' }],
    ['duplicate IDs', { name: 'Friends', contactIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] }],
    ['unsafe name', { name: 'bad\nname', contactIds: [] }],
    ['oversized name', { name: 'x'.repeat(65), contactIds: [] }],
  ])('refuses %s without changing either canonical file', async (_label, input) => {
    const before = await f.bytes(), revision = (await f.list()).revision
    const response = await f.request('/api/webmail/contact-groups', 'POST', { ...input, expectedRevision: revision })
    expect(response.status).toBe(422); expect(await f.bytes()).toBe(before); expect(await f.groupBytes()).toBeNull()
  })
  it('does not expose another mailbox groups or permit shared/foreign membership changes', async () => {
    await f.createGroup('Private group', [f.own.id])
    expect((await f.list(f.siblingCredential)).groups).toEqual([])
    expect((await f.list(f.foreignCredential)).groups).toEqual([])
    const before = await f.bytes()
    const response = await f.request(`/api/webmail/contacts/${f.shared.id}/groups`, 'PUT', { groups: [], expectedRevision: contactWorkspaceRevision(f.shared) }, f.siblingCredential)
    expect(response.status).toBe(403)
    const listing = await f.list()
    const foreign = await f.request('/api/webmail/contact-groups', 'POST', { name: 'Foreign', contactIds: [f.foreignContact.id], expectedRevision: listing.revision })
    expect(foreign.status).toBe(404); expect(await f.bytes()).toBe(before)
  })
  it('refuses unknown group assignment and enforces mailbox group bounds', async () => {
    expect((await f.request(`/api/webmail/contacts/${f.own.id}/groups`, 'PUT', { groups: ['Missing'], expectedRevision: contactWorkspaceRevision(f.own) })).status).toBe(404)
    await atomicWriteJson(f.groupsPath, Array.from({ length: 256 }, (_, index) => ({ owner: f.inbox.login, ownerAuthority: f.authority(f.inbox), name: 'Group ' + index, createdAt: null })))
    const before = await f.groupBytes(), listing = await f.list()
    expect((await f.request('/api/webmail/contact-groups', 'POST', { name: 'Overflow', contactIds: [], expectedRevision: listing.revision })).status).toBe(422)
    expect(await f.groupBytes()).toBe(before)
    expect((await f.request(`/api/webmail/contacts/${f.own.id}/groups`, 'PUT', { groups: Array.from({ length: 33 }, (_, index) => 'Group ' + index), expectedRevision: contactWorkspaceRevision(f.own) })).status).toBe(422)
  })
  it('bounds both create and import through the existing contact lease', async () => {
    const full = Array.from({ length: CONTACTS_PER_MAILBOX_MAX }, (_, index) => ({ ...f.own, id: randomUUID(), fullName: 'Contact ' + index }))
    await atomicWriteJson(f.contactsPath, [...full, f.siblingPrivate, f.foreignContact])
    const before = await f.bytes()
    expect((await f.request('/api/webmail/contacts', 'POST', contactFields)).status).toBe(422)
    const card = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Overflow\r\nEMAIL:overflow@example.test\r\nEND:VCARD'
    expect((await f.request('/api/webmail/contacts/import', 'POST', { vcard: card })).status).toBe(422)
    expect(await f.bytes()).toBe(before)
    expect((await f.list()).capacity.ownedContacts).toBe(CONTACTS_PER_MAILBOX_MAX)
  })
  it('imports exported category escaping into the same group membership model', async () => {
    const card = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Grouped import\r\nEMAIL:grouped@example.test\r\nCATEGORIES:Friends\\, team,Semi\\;colon\r\nEND:VCARD'
    const response = await f.request('/api/webmail/contacts/import', 'POST', { vcard: card })
    expect(response.status).toBe(201)
    const imported = (await response.json() as { contacts: WebmailContact[] }).contacts[0]!
    expect(imported.groups).toEqual(['Friends, team', 'Semi;colon'])
    expect(imported.vcard).toContain('CATEGORIES:Friends\\, team,Semi\\;colon')
    expect((await f.list()).groups.map(group => group.name).sort()).toEqual(['Friends, team', 'Semi;colon'])
  })
  it('refuses an over-budget group catalog explicitly while preserving independent contact deletion', async () => {
    await atomicWriteJson(f.groupsPath, Array.from({ length: 4097 }, (_, index) => ({ owner: f.inbox.login, ownerAuthority: f.authority(f.inbox), name: 'Legacy ' + index, createdAt: null })))
    const before = await f.bytes(), metadata = await f.groupBytes()
    const response = await f.request('/api/webmail/contact-groups')
    expect(response.status).toBe(412)
    expect(await response.json()).toMatchObject({ details: { reason: 'contact_groups_read_budget', counts: { ownedContacts: 2, groups: 4097 }, stateChanged: false } })
    expect(await f.bytes()).toBe(before); expect(await f.groupBytes()).toBe(metadata)
    const deleted = await f.request(`/api/webmail/contacts/${f.own.id}`, 'DELETE', { expectedRevision: contactWorkspaceRevision(f.own) })
    expect(deleted.status).toBe(200)
    expect((await f.contacts()).some(contact => contact.id === f.own.id)).toBe(false)
  })
  it('keeps authentication, write scope and sealed selector refusal intact', async () => {
    expect((await f.request('/api/webmail/contact-groups', 'GET', undefined, null)).status).toBe(401)
    const listing = await f.list(), input = { name: 'Scope', contactIds: [], expectedRevision: listing.revision }
    expect((await f.request('/api/webmail/contact-groups', 'POST', input, await f.token(f.inbox.id, f.principal.id, ['webmail:read']))).status).toBe(403)
    expect((await f.request('/api/webmail/contact-groups?mailbox=' + encodeURIComponent(f.foreign.login))).status).toBe(422)
    expect((await f.request('/api/webmail/contact-groups', 'GET', undefined, await f.token(null))).status).toBe(403)
  })
  it('rechecks suspended account authority after the writer lease wait', async () => {
    const listing = await f.list(), lock = f.state.store.getWriterLock(), acquire = lock.acquire.bind(lock)
    vi.spyOn(lock, 'acquire').mockImplementationOnce(async () => { await f.state.store.suspendAccount(f.owner.id, 'Synthetic concurrent suspension'); return acquire() })
    const before = await f.bytes()
    expect((await f.request('/api/webmail/contact-groups', 'POST', { name: 'Refused', contactIds: [], expectedRevision: listing.revision })).status).toBe(403)
    expect(await f.bytes()).toBe(before); expect(await f.groupBytes()).toBeNull()
  })
  it('restores exact byte preimages after the second canonical publication fails', async () => {
    await writeFile(f.contactsPath, JSON.stringify(await f.contacts(), null, 4) + '\n\n')
    const before = await f.bytes(), listing = await f.list()
    let writes = 0
    const handler = createContactToolsRoutes({ store: f.state.store, requireCaller: f.requireCaller, emitAudit: vi.fn(), writeJson: async (...args) => {
      await atomicWriteJson(...args)
      if (++writes === 2) throw Object.assign(new Error('Synthetic second-file publication failure'), { code: 'EIO' })
    } })
    const req = f.rawRequest('/api/webmail/contact-groups', 'POST', { name: 'Recovered', contactIds: [f.own.id], expectedRevision: listing.revision })
    await expect(handler(req, new URL(req.url))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
    expect(await f.bytes()).toBe(before); expect(await f.groupBytes()).toBeNull()
    expect((await f.list()).groups).toEqual([])
  })
  it('preserves unbound history without exposing content, names, quotas or revision changes', async () => {
    const { ownerAuthority: _binding, ...unbound } = f.own
    const beforeListing = await f.list()
    await atomicWriteJson(f.contactsPath, [f.shared, f.siblingPrivate, f.foreignContact])
    const baseline = await f.list()
    await atomicWriteJson(f.contactsPath, [unbound, f.shared, f.siblingPrivate, f.foreignContact])
    await atomicWriteJson(f.groupsPath, [{ owner: f.inbox.login, name: 'Hidden old group', createdAt: null }])
    const before = await f.bytes(), groups = await f.groupBytes(), listing = await f.list()
    expect(listing).toEqual(baseline)
    expect(listing.capacity.ownedContacts).toBe(beforeListing.capacity.ownedContacts - 1)
    expect(JSON.stringify(listing)).not.toContain('Hidden old group')
    const main = await (await f.request('/api/webmail/contacts')).json() as { contacts: WebmailContact[] }
    expect(main.contacts.some(contact => contact.id === unbound.id)).toBe(false)
    const refused = await f.request('/api/webmail/contacts/' + unbound.id, 'DELETE', { expectedRevision: contactWorkspaceRevision(unbound) })
    expect(refused.status).toBe(412)
    expect(await f.bytes()).toBe(before); expect(await f.groupBytes()).toBe(groups)
  })
  it('refuses old contact/group ownership after actual mailbox retirement and address recreation', async () => {
    await f.createGroup('Old lifetime', [f.own.id])
    const before = await f.bytes(), groups = await f.groupBytes()
    await f.state.store.deleteServiceUser(f.inbox.id)
    const recreated = await f.state.store.createServiceUser({ accountId: f.owner.id, login: f.inbox.login, passwordHash: HASH, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
    const credential = await f.token(recreated.id), listing = await f.list(credential)
    expect(listing.contacts).toEqual([]); expect(listing.groups).toEqual([]); expect(listing.capacity.ownedContacts).toBe(0)
    const main = await (await f.request('/api/webmail/contacts', 'GET', undefined, credential)).json() as { contacts: WebmailContact[] }
    expect(main.contacts).toEqual([])
    expect((await f.request('/api/webmail/contacts/' + f.own.id, 'DELETE', { expectedRevision: contactWorkspaceRevision(f.own) }, credential)).status).toBe(404)
    expect(await f.bytes()).toBe(before); expect(await f.groupBytes()).toBe(groups)
    const created = await f.request('/api/webmail/contacts', 'POST', contactFields, credential)
    expect(created.status).toBe(201)
    const stored = await f.contacts(), latest = stored.at(-1)!
    expect(latest.ownerAuthority).toEqual({ accountId: recreated.accountId, serviceUserId: recreated.id, mailbox: recreated.login })
    expect(stored.slice(0,-1)).toEqual(JSON.parse(before))
  })
  it('requires current owner and grantee lifetimes for shared contact access', async () => {
    const before = await f.bytes()
    await f.state.store.deleteServiceUser(f.inbox.id)
    await f.state.store.createServiceUser({ accountId: f.owner.id, login: f.inbox.login, passwordHash: HASH, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
    const response = await f.request('/api/webmail/contacts/' + f.shared.id + '/export', 'GET', undefined, f.siblingCredential)
    expect(response.status).toBe(404); expect(await f.bytes()).toBe(before)
  })

  it('refuses a historical share after actual recipient address recreation', async () => {
    const before = await f.bytes()
    await f.state.store.deleteServiceUser(f.sibling.id)
    const recreated = await f.state.store.createServiceUser({ accountId: f.owner.id, login: f.sibling.login, passwordHash: HASH, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
    const credential = await f.token(recreated.id)
    expect((await f.request('/api/webmail/contacts/' + f.shared.id + '/export', 'GET', undefined, credential)).status).toBe(404)
    const response = await f.request('/api/webmail/contacts', 'GET', undefined, credential)
    expect(response.status).toBe(200)
    expect((await response.json() as { contacts: WebmailContact[] }).contacts).toEqual([])
    expect(await f.bytes()).toBe(before)
  })

})
