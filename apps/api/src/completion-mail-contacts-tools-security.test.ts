import { randomUUID } from 'node:crypto'
import type { MailboxMetadataAuthority } from '@xpanel/core'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApiToken, createTestDb, createUserPrincipal } from '@xpanel/db'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import { sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'

// Real-loopback acceptance for the mailbox Contacts tools that the browser page now uses:
// vCard import, vCard export and same-account contact sharing. Synthetic temporary API tokens
// authenticate only; no mail delivery, synchronisation or CardDAV is claimed.

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: Array<() => Promise<unknown>> = []
interface Contact {
  id: string; owner: string; ownerAuthority?: MailboxMetadataAuthority; fullName: string; email: string; phone: string; organization: string; title: string
  groups: string[]; shares: { principal: string; permission: 'read' | 'read-write'; sharedAt: string; granteeAuthority?: MailboxMetadataAuthority }[]
  vcard: string; createdAt: string; revision?: string
}
const vcardFor = (fullName: string, email: string) => ['BEGIN:VCARD', 'VERSION:3.0', `FN:${fullName}`, `EMAIL;TYPE=INTERNET:${email}`, 'END:VCARD'].join('\r\n')
const contact = (owner: string, patch: Partial<Contact> = {}): Contact => {
  const base = { id: randomUUID(), owner, fullName: 'Seeded contact', email: 'seeded@example.test', phone: '', organization: '', title: '', groups: [] as string[], shares: [] as Contact['shares'], createdAt: '2026-01-01T00:00:00.000Z', ...patch }
  return { ...base, vcard: patch.vcard ?? vcardFor(base.fullName, base.email) }
}

const fixture = async () => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Contacts tools policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Contacts tools plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.21', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null,
    contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.21', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const owner = await account('ctoolsa9'), other = await account('ctoolsb9')
  const mailbox = (accountId: string, login: string) => state.store.createServiceUser({ accountId, login, passwordHash: HASH,
    services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const inbox = await mailbox(owner.id, `inbox@${owner.primaryDomain}`)
  const sibling = await mailbox(owner.id, `sibling@${owner.primaryDomain}`)
  const foreign = await mailbox(other.id, `foreign@${other.primaryDomain}`)
  const principal = await createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  const foreignPrincipal = await createUserPrincipal(database.db, { username: other.username, accountId: other.id, passwordHash: HASH })
  const token = async (scopes: string[], principalId = principal.id) => {
    const raw = 'xp_' + randomUUID()
    await createApiToken(database.db, { principalId, name: 'Synthetic contacts tools', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const inboxCredential = await token([`mailbox:${inbox.id}`, 'webmail:read', 'webmail:write'])
  const siblingCredential = await token([`mailbox:${sibling.id}`, 'webmail:read', 'webmail:write'])
  const foreignCredential = await token([`mailbox:${foreign.id}`, 'webmail:read', 'webmail:write'], foreignPrincipal.id)
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: 'contacts-tools-synthetic-server-secret-32b' })
  const request = (path: string, method = 'GET', body?: unknown, raw: string | null = inboxCredential) => app.fetch(new Request('http://localhost' + path, { method,
    headers: { ...(raw ? { authorization: 'Bearer ' + raw } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  const authority = (login: string): MailboxMetadataAuthority => { const user = [inbox, sibling, foreign].find(user => user.login === login)!; return { accountId: user.accountId, serviceUserId: user.id, mailbox: user.login } }
  const boundContact = (login: string, patch: Partial<Contact>) => { const row = contact(login, patch); return { ...row, ownerAuthority: authority(login), shares: row.shares.map(share => ({ ...share, granteeAuthority: authority(share.principal) })) } }
  const own = boundContact(inbox.login, { fullName: 'Own contact' })
  const sharedToSibling = boundContact(inbox.login, { fullName: 'Shared to sibling', shares: [{ principal: sibling.login, permission: 'read', sharedAt: '2026-01-01T00:00:00.000Z' }] })
  const siblingPrivate = boundContact(sibling.login, { fullName: 'Sibling private' })
  const foreignContact = boundContact(foreign.login, { fullName: 'Foreign private' })
  const path = join(state.rootDir, 'extended', 'webmail', 'contacts.json')
  await atomicWriteJson(path, [own, sharedToSibling, siblingPrivate, foreignContact])
  const bytes = () => readFile(path, 'utf8')
  const persisted = async () => JSON.parse(await bytes()) as Contact[]
  return { database, state, owner, other, inbox, sibling, foreign, principal, inboxCredential, siblingCredential, foreignCredential, request, own, sharedToSibling, siblingPrivate, foreignContact, path, bytes, persisted }
}

describe('mailbox Contacts import/export/share HTTP security acceptance', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Synthetic contacts tools cleanup failed')
  })

  it('exports only the visible vCard document for the sealed mailbox', async () => {
    const response = await f.request('/api/webmail/contacts/export')
    expect(response.status).toBe(200)
    const body = await response.json() as { mailbox: string; vcard: string; count: number }
    expect(body.mailbox).toBe(f.inbox.login)
    expect(body.count).toBe(2)
    expect(body.vcard).toContain('Own contact')
    expect(body.vcard).toContain('Shared to sibling')
    expect(body.vcard).not.toMatch(/Sibling private|Foreign private/)
    const foreign = await f.request('/api/webmail/contacts/export', 'GET', undefined, f.foreignCredential)
    expect(foreign.status).toBe(200)
    const foreignBody = await foreign.json() as { vcard: string; count: number }
    expect(foreignBody.vcard).toContain('Foreign private')
    expect(foreignBody.vcard).not.toContain('Own contact')
    expect(foreignBody.count).toBe(1)
  })

  it('exports one accessible contact and refuses an inaccessible id', async () => {
    const visible = await f.request(`/api/webmail/contacts/${f.own.id}/export`)
    expect(visible.status).toBe(200)
    expect((await visible.json() as { contactId: string; vcard: string }).vcard).toContain('Own contact')
    const hidden = await f.request(`/api/webmail/contacts/${f.foreignContact.id}/export`)
    expect(hidden.status).toBe(404)
    const shared = await f.request(`/api/webmail/contacts/${f.sharedToSibling.id}/export`, 'GET', undefined, f.siblingCredential)
    expect(shared.status).toBe(200)
  })

  it('imports valid vCards under the sealed mailbox owner and verifies persisted readback', async () => {
    const cards = [vcardFor('Imported One', 'one@example.test'), vcardFor('Imported Two', 'two@example.test')].join('\r\n')
    const response = await f.request('/api/webmail/contacts/import', 'POST', { vcard: cards })
    expect(response.status).toBe(201)
    const body = await response.json() as { contacts: Contact[]; importedCount: number }
    expect(body.importedCount).toBe(2)
    expect(body.contacts.map(entry => entry.fullName)).toEqual(['Imported One', 'Imported Two'])
    expect(body.contacts.every(entry => entry.owner === f.inbox.login)).toBe(true)
    const stored = await f.persisted()
    for (const imported of body.contacts) expect(stored.find(entry => entry.id === imported.id)).toMatchObject({ fullName: imported.fullName, owner: f.inbox.login })
    const listed = await f.request('/api/webmail/contacts')
    expect(listed.status).toBe(200)
    const ids = (await listed.json() as { contacts: Contact[] }).contacts.map(entry => entry.id)
    for (const imported of body.contacts) expect(ids).toContain(imported.id)
  })

  it.each([
    ['unsafe payload', 'BEGIN:VCARD\nVERSION:3.0\nFN:x\nEMAIL:a@b.test\n<script>x</script>\nEND:VCARD'],
    ['missing email', 'BEGIN:VCARD\nVERSION:3.0\nFN:No Email\nEND:VCARD'],
    ['nested cards', 'BEGIN:VCARD\nBEGIN:VCARD\nFN:x\nEMAIL:a@b.test\nEND:VCARD'],
    ['unmatched end', 'END:VCARD'],
    ['empty content', '   '],
  ])('refuses %s without changing stored contacts', async (_name, vcard) => {
    const before = await f.bytes()
    const response = await f.request('/api/webmail/contacts/import', 'POST', { vcard })
    expect(response.status).toBe(422)
    expect(await f.bytes()).toBe(before)
  })

  it('refuses an oversized import and a foreign mailbox selector for the sealed principal', async () => {
    const before = await f.bytes()
    const oversized = await f.request('/api/webmail/contacts/import', 'POST', { vcard: 'BEGIN:VCARD\nFN:x\n' + 'A'.repeat(256 * 1024) })
    expect(oversized.status).toBe(422)
    const foreignSelector = await f.request('/api/webmail/contacts/import', 'POST', { vcard: vcardFor('Selected', 'selected@example.test'), owner: f.foreign.login })
    expect([403, 404, 422]).toContain(foreignSelector.status)
    expect(await f.bytes()).toBe(before)
  })

  it('shares an owned contact with a same-account mailbox and exposes it read-only', async () => {
    const response = await f.request(`/api/webmail/contacts/${f.own.id}/share`, 'POST', { principal: f.sibling.login, permission: 'read' })
    expect(response.status).toBe(200)
    const body = await response.json() as { contact: Contact }
    expect(body.contact.shares).toEqual([{ principal: f.sibling.login, permission: 'read', sharedAt: expect.any(String) }])
    const siblingList = await f.request('/api/webmail/contacts', 'GET', undefined, f.siblingCredential)
    const visible = (await siblingList.json() as { contacts: Contact[] }).contacts.find(entry => entry.id === f.own.id)
    expect(visible).toBeDefined()
    expect(visible!.owner).toBe(f.inbox.login)
  })

  it('refuses sharing to a foreign account, an invalid principal and non-owner modification', async () => {
    const before = await f.bytes()
    const foreign = await f.request(`/api/webmail/contacts/${f.own.id}/share`, 'POST', { principal: f.foreign.login, permission: 'read' })
    expect(foreign.status).toBe(404)
    const invalid = await f.request(`/api/webmail/contacts/${f.own.id}/share`, 'POST', { principal: 'not-an-email', permission: 'read' })
    expect(invalid.status).toBe(422)
    const sharedMailboxTriesToReshare = await f.request(`/api/webmail/contacts/${f.sharedToSibling.id}/share`, 'POST', { principal: f.sibling.login, permission: 'read-write' }, f.siblingCredential)
    expect(sharedMailboxTriesToReshare.status).toBe(403)
    expect(await f.bytes()).toBe(before)
  })

  it('revokes a sharing entry and verifies the stored contact', async () => {
    const response = await f.request(`/api/webmail/contacts/${f.sharedToSibling.id}/share`, 'DELETE', { principal: f.sibling.login })
    expect(response.status).toBe(200)
    const body = await response.json() as { contact: Contact }
    expect(body.contact.shares).toEqual([])
    const stored = (await f.persisted()).find(entry => entry.id === f.sharedToSibling.id)
    expect(stored!.shares).toEqual([])
    const siblingList = await f.request('/api/webmail/contacts', 'GET', undefined, f.siblingCredential)
    const ids = (await siblingList.json() as { contacts: Contact[] }).contacts.map(entry => entry.id)
    expect(ids).not.toContain(f.sharedToSibling.id)
  })
})
