import { randomUUID } from 'node:crypto'
import type { MailboxMetadataAuthority } from '@xpanel/core'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiToken, createTestDb, createUserPrincipal, revokeAllApiTokensForPrincipal } from '@xpanel/db'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import { sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'

// Public independent Argon2 fixture vector; these requests authenticate synthetic temporary API tokens only.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const route = '/api/webmail/contacts'
const cleanup: Array<() => Promise<unknown>> = []
const editable = ['fullName', 'email', 'phone', 'organization', 'title'] as const
interface Contact {
  id: string; owner: string; ownerAuthority?: MailboxMetadataAuthority; fullName: string; email: string; phone: string; organization: string; title: string
  groups: string[]; shares: { principal: string; permission: 'read' | 'read-write'; sharedAt: string; granteeAuthority?: MailboxMetadataAuthority }[]
  vcard: string; createdAt: string; revision?: string
}
interface View { context: { mailbox: string }; contacts: Contact[] }
interface Ack { context: { mailbox: string }; contact: Contact; stateChanged: true }
const draft = (patch: Record<string, unknown> = {}) => ({ fullName: 'Alex Example', email: 'alex@example.test', phone: '+123456789', organization: 'Example Team', title: 'Coordinator', ...patch })
const fields = (contact: Contact) => Object.fromEntries(editable.map(key => [key, contact[key]]))

const fixture = async () => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Contacts policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Contacts plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null,
    contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.10', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const owner = await account('contactworka9'), other = await account('contactworkb9')
  const mailbox = (accountId: string, login: string) => state.store.createServiceUser({ accountId, login, passwordHash: HASH,
    services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const inbox = await mailbox(owner.id, `inbox@${owner.primaryDomain}`)
  const sibling = await mailbox(owner.id, `support@${owner.primaryDomain}`)
  const foreign = await mailbox(other.id, `inbox@${other.primaryDomain}`)
  const principal = await createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  const foreignPrincipal = await createUserPrincipal(database.db, { username: other.username, accountId: other.id, passwordHash: HASH })
  const token = async (scopes: string[], principalId = principal.id) => {
    const raw = `xp_${randomUUID()}`
    await createApiToken(database.db, { principalId, name: 'Synthetic contacts acceptance', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const credential = await token([`mailbox:${inbox.id}`, 'webmail:read', 'webmail:write'])
  const readOnly = await token([`mailbox:${inbox.id}`, 'webmail:read'])
  const foreignCredential = await token([`mailbox:${foreign.id}`, 'webmail:read', 'webmail:write'], foreignPrincipal.id)
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: 'contacts-synthetic-server-secret-at-least-32-bytes' })
  const request = (path: string, method = 'GET', body?: unknown, raw: string | null = credential) => app.fetch(new Request(`http://localhost${path}`, { method,
    headers: { ...(raw ? { authorization: `Bearer ${raw}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  const authority = (login: string): MailboxMetadataAuthority => { const user = [inbox, sibling, foreign].find(user => user.login === login)!; return { accountId: user.accountId, serviceUserId: user.id, mailbox: user.login } }
  const record = (mailboxOwner: string, patch: Partial<Contact> = {}): Contact => ({ id: randomUUID(), owner: mailboxOwner,
    fullName: 'Seeded contact', email: 'seeded@example.test', phone: '+123456789', organization: 'Seeded Team', title: 'Member', groups: ['Preserved group'],
    vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Seeded contact\r\nEMAIL;TYPE=INTERNET:seeded@example.test\r\nTEL;TYPE=CELL:+123456789\r\nORG:Seeded Team\r\nTITLE:Member\r\nEND:VCARD',
    createdAt: '2026-01-01T00:00:00.000Z', ...patch, ownerAuthority: authority(mailboxOwner), shares: (patch.shares ?? []).map(share => ({ ...share, granteeAuthority: authority(share.principal) })) })
  const own = record(inbox.login), siblingOnly = record(sibling.login, { fullName: 'SIBLING_PRIVATE' })
  const shared = record(sibling.login, { fullName: 'Shared read only', shares: [{ principal: inbox.login, permission: 'read', sharedAt: '2026-01-01T00:00:00.000Z' }] })
  const neighbor = record(foreign.login, { fullName: 'FOREIGN_PRIVATE' })
  const path = join(state.rootDir, 'extended', 'webmail', 'contacts.json')
  await atomicWriteJson(path, [own, siblingOnly, shared, neighbor])
  const bytes = () => readFile(path, 'utf8')
  return { database, state, features, owner, other, inbox, sibling, foreign, principal, token, credential, readOnly, foreignCredential, request, record, own, siblingOnly, shared, neighbor, path, bytes }
}

describe('sealed mailbox Contacts list/create/edit HTTP security acceptance', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    vi.restoreAllMocks()
    const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Synthetic contacts fixture cleanup failed')
  })
  const view = async (raw = f.credential) => {
    const response = await f.request(route, 'GET', undefined, raw)
    expect(response.status).toBe(200)
    const result = await response.json() as View
    expect(result.context).toEqual({ mailbox: raw === f.foreignCredential ? f.foreign.login : f.inbox.login })
    for (const contact of result.contacts) expect(contact.revision).toMatch(/^[0-9a-f]{64}$/)
    return result
  }
  const selected = async (id = f.own.id) => {
    const contact = (await view()).contacts.find(item => item.id === id)
    expect(contact).toBeDefined()
    return contact!
  }
  const update = (contact: Contact, patch: Record<string, unknown> = {}, raw = f.credential) => f.request(`${route}/${contact.id}`, 'PATCH', { ...fields(contact), expectedRevision: contact.revision, ...patch }, raw)
  const persisted = async () => JSON.parse(await f.bytes()) as Contact[]

  it('lists only bound-mailbox owned and same-account shared records without allocating state', async () => {
    const before = await f.bytes(), first = await view(), second = await view()
    expect(first.contacts.map(item => item.id)).toEqual([f.own.id, f.shared.id])
    expect(first).toEqual(second)
    expect(JSON.stringify(first)).not.toMatch(/SIBLING_PRIVATE|FOREIGN_PRIVATE/)
    expect(await f.bytes()).toBe(before)
    expect((await view(f.foreignCredential)).contacts.map(item => item.id)).toEqual([f.neighbor.id])
  })

  it('does not expose a corrupt cross-account share to a trusted mailbox', async () => {
    await atomicWriteJson(f.path, [f.own, { ...f.neighbor, shares: [{ principal: f.inbox.login, permission: 'read', sharedAt: f.neighbor.createdAt }] }])
    const before = await f.bytes(), result = await view()
    expect(result.contacts.map(item => item.id)).toEqual([f.own.id])
    expect(JSON.stringify(result)).not.toContain('FOREIGN_PRIVATE')
    expect(await f.bytes()).toBe(before)
  })

  it('creates normalized metadata and vCard with a trusted owner and verifies exact readback', async () => {
    const original = await persisted()
    const response = await f.request(route, 'POST', draft({ fullName: '  Alex Example  ', email: '  ALEX@EXAMPLE.TEST  ', phone: ' +123456789 ', organization: ' Example Team ', title: ' Coordinator ' }))
    expect(response.status).toBe(201)
    const result = await response.json() as Ack
    expect(result).toMatchObject({ context: { mailbox: f.inbox.login }, stateChanged: true, contact: { ...draft(), owner: f.inbox.login, groups: [], shares: [] } })
    expect(result.contact.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.contact.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(result.contact.vcard).toBe('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Alex Example\r\nEMAIL;TYPE=INTERNET:alex@example.test\r\nTEL;TYPE=CELL:+123456789\r\nORG:Example Team\r\nTITLE:Coordinator\r\nEND:VCARD')
    expect((await view()).contacts.find(item => item.id === result.contact.id)).toEqual(result.contact)
    expect((await persisted()).filter(item => item.id !== result.contact.id)).toEqual(original)
    expect((await persisted()).find(item => item.id === result.contact.id)).not.toHaveProperty('revision')
  })

  it('edits one stable target and preserves its owner, groups, sharing and creation identity', async () => {
    const initial = await selected(), original = await persisted()
    const response = await update(initial, draft({ fullName: '  Edited person  ', email: ' EDITED@EXAMPLE.TEST ' }))
    expect(response.status).toBe(200)
    const result = await response.json() as Ack
    expect(result).toMatchObject({ context: { mailbox: f.inbox.login }, stateChanged: true, contact: { id: initial.id, owner: initial.owner, fullName: 'Edited person', email: 'edited@example.test', groups: initial.groups, shares: initial.shares, createdAt: initial.createdAt } })
    expect(result.contact.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(result.contact.revision).not.toBe(initial.revision)
    expect(result.contact.vcard).toContain('FN:Edited person\r\nEMAIL;TYPE=INTERNET:edited@example.test')
    expect(await selected()).toEqual(result.contact)
    expect((await persisted()).filter(item => item.id !== initial.id)).toEqual(original.filter(item => item.id !== initial.id))
  })

  it('allows clearing optional fields without retaining stale vCard properties', async () => {
    const response = await update(await selected(), { phone: '', organization: '', title: '' })
    expect(response.status).toBe(200)
    const result = await response.json() as Ack
    expect(result.contact).toMatchObject({ phone: '', organization: '', title: '' })
    expect(result.contact.vcard).not.toMatch(/TEL;|ORG:|TITLE:/)
    expect(await selected()).toEqual(result.contact)
  })

  it('preserves authentication and read/write token scopes with no metadata effects', async () => {
    const initial = await selected(), before = await f.bytes()
    expect((await f.request(route, 'GET', undefined, null)).status).toBe(401)
    expect((await f.request(route, 'POST', draft(), null)).status).toBe(401)
    expect((await f.request(`${route}/${initial.id}`, 'PATCH', { ...fields(initial), expectedRevision: initial.revision }, null)).status).toBe(401)
    expect((await view(f.readOnly)).contacts.map(item => item.id)).toContain(initial.id)
    expect((await f.request(route, 'POST', draft(), f.readOnly)).status).toBe(403)
    expect((await update(initial, { fullName: 'Denied' }, f.readOnly)).status).toBe(403)
    expect(await f.bytes()).toBe(before)
  })

  it('refuses editing a visible read-only shared contact', async () => {
    const initial = await selected(f.shared.id), before = await f.bytes()
    expect((await update(initial, { fullName: 'Denied shared edit' })).status).toBe(403)
    expect(await f.bytes()).toBe(before)
  })

  it('retains existing read-write-share API permission without changing owner or sharing', async () => {
    await atomicWriteJson(f.path, [f.own, { ...f.shared, shares: [{ ...f.shared.shares[0]!, permission: 'read-write' }] }, f.neighbor])
    const initial = await selected(f.shared.id)
    const response = await update(initial, { title: 'Authorized shared edit' })
    expect(response.status).toBe(200)
    expect((await response.json() as Ack).contact).toMatchObject({ owner: initial.owner, shares: initial.shares, title: 'Authorized shared edit' })
  })

  it('keeps foreign, unshared sibling and missing item IDs private and unchanged', async () => {
    const initial = await selected(), before = await f.bytes()
    for (const id of [f.neighbor.id, f.siblingOnly.id, randomUUID()]) {
      expect((await f.request(`${route}/${id}`, 'PATCH', { ...fields(initial), expectedRevision: initial.revision })).status).toBe(404)
    }
    expect(await f.bytes()).toBe(before)
  })

  it.each(['owner', 'mailbox', 'accountId', 'id', 'groups', 'shares', 'vcard', 'createdAt'])('refuses sealed write selector or metadata injection: %s', async key => {
    const initial = await selected(), before = await f.bytes()
    const extra = key === 'groups' || key === 'shares' ? [] : key === 'vcard' ? 'BEGIN:VCARD\r\nFN:injected\r\nEND:VCARD' : f.foreign.login
    expect((await f.request(route, 'POST', draft({ [key]: extra }))).status).toBe(422)
    expect((await update(initial, { [key]: extra })).status).toBe(422)
    expect(await f.bytes()).toBe(before)
  })

  it('refuses every query selector on the sealed Contacts workspace without switching authority', async () => {
    const initial = await selected(), before = await f.bytes()
    for (const query of [`mailbox=${encodeURIComponent(f.foreign.login)}`, `owner=${encodeURIComponent(f.sibling.login)}`, `id=${f.neighbor.id}`, 'unexpected=1']) {
      expect((await f.request(`${route}?${query}`)).status).toBe(422)
      expect((await f.request(`${route}?${query}`, 'POST', draft())).status).toBe(422)
      expect((await f.request(`${route}/${initial.id}?${query}`, 'PATCH', { ...fields(initial), expectedRevision: initial.revision })).status).toBe(422)
    }
    expect(await f.bytes()).toBe(before)
  })

  it.each([null, [], 42, 'contact'])('rejects a non-object write body without a server error: case %#', async value => {
    const initial = await selected(), before = await f.bytes()
    expect((await f.request(route, 'POST', value)).status).toBe(422)
    expect((await f.request(`${route}/${initial.id}`, 'PATCH', value)).status).toBe(422)
    expect(await f.bytes()).toBe(before)
  })

  it.each(editable)('rejects control/vCard injection in %s before any write', async field => {
    const initial = await selected(), before = await f.bytes()
    for (const value of ['Injected\r\nX-INJECTED:yes', 'Injected\u0000value']) {
      expect((await f.request(route, 'POST', draft({ [field]: value }))).status).toBe(422)
      expect((await update(initial, { [field]: value })).status).toBe(422)
    }
    expect(await f.bytes()).toBe(before)
  })

  it('requires all five primitive fields, a nonblank name and a valid email', async () => {
    const initial = await selected(), before = await f.bytes()
    const invalid: Record<string, unknown>[] = [
      { fullName: '   ' }, { fullName: false }, { email: 'two@@example.test' }, { email: 'bad address@example.test' },
      { phone: 0 }, { organization: null }, { title: [] },
    ]
    for (const patch of invalid) {
      expect((await f.request(route, 'POST', draft(patch))).status).toBe(422)
      expect((await update(initial, patch)).status).toBe(422)
    }
    for (const key of editable) {
      const body = draft() as Record<string, unknown>; delete body[key]
      expect((await f.request(route, 'POST', body)).status).toBe(422)
      expect((await f.request(`${route}/${initial.id}`, 'PATCH', { ...body, expectedRevision: initial.revision })).status).toBe(422)
    }
    expect(await f.bytes()).toBe(before)
  })

  it('requires an exact captured record revision before editing', async () => {
    const initial = await selected(), before = await f.bytes()
    for (const value of [undefined, null, 42, '', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}\n`]) {
      const body = { ...fields(initial), ...(value !== undefined ? { expectedRevision: value } : {}) }
      expect((await f.request(`${route}/${initial.id}`, 'PATCH', body)).status).toBe(422)
    }
    expect(await f.bytes()).toBe(before)
  })

  it('rejects a stale edit without overwriting the saved target or neighbors', async () => {
    const initial = await selected()
    expect((await update(initial, { title: 'Saved by another editor' })).status).toBe(200)
    const before = await f.bytes(), response = await update(initial, { fullName: 'Stale overwrite' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'CONFLICT', details: { stateChanged: false } })
    expect(await f.bytes()).toBe(before)
    expect(await selected()).toMatchObject({ fullName: initial.fullName, title: 'Saved by another editor' })
  })

  it('binds the captured revision to the exact target rather than another owned contact', async () => {
    const extra = f.record(f.inbox.login, { fullName: 'Other owned contact' })
    await atomicWriteJson(f.path, [f.own, extra, f.shared, f.neighbor])
    const first = await selected(), second = await selected(extra.id), before = await f.bytes()
    expect(second.revision).not.toBe(first.revision)
    const response = await update(second, { expectedRevision: first.revision, fullName: 'Wrong target revision' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'CONFLICT', details: { stateChanged: false } })
    expect(await f.bytes()).toBe(before)
  })

  it('does not invalidate an owned edit merely because an unrelated contact changed', async () => {
    const extra = f.record(f.inbox.login, { fullName: 'Unrelated editor' })
    await atomicWriteJson(f.path, [f.own, extra, f.shared, f.neighbor])
    const first = await selected(), second = await selected(extra.id)
    expect((await update(second, { title: 'Changed neighbor' })).status).toBe(200)
    expect((await update(first, { title: 'Still current target' })).status).toBe(200)
    expect(await selected(first.id)).toMatchObject({ title: 'Still current target' })
    expect(await selected(second.id)).toMatchObject({ title: 'Changed neighbor' })
  })

  it.each(['suspended', 'email-disabled', 'feature-disabled', 'token-revoked'] as const)('rechecks current authorization after view: %s', async change => {
    const initial = await selected()
    if (change === 'suspended') await f.state.store.suspendAccount(f.owner.id, 'Synthetic contacts hold')
    if (change === 'email-disabled') await f.state.store.updateServiceUser(f.inbox.id, { services: { email: false, ftp: true, webdisk: false } })
    if (change === 'feature-disabled') await f.state.store.updateFeatureList(f.features.id, { disabled: ['email-accounts'] })
    if (change === 'token-revoked') await revokeAllApiTokensForPrincipal(f.database.db, f.principal.id)
    const before = await f.bytes(), status = change === 'token-revoked' ? 401 : 403
    expect((await f.request(route)).status).toBe(status)
    expect((await f.request(route, 'POST', draft())).status).toBe(status)
    expect((await update(initial, { title: 'Denied after view' })).status).toBe(status)
    expect(await f.bytes()).toBe(before)
  })

  it('serializes concurrent creates without losing either record or existing contacts', async () => {
    const original = await persisted()
    const responses = await Promise.all([f.request(route, 'POST', draft({ fullName: 'Concurrent A' })), f.request(route, 'POST', draft({ fullName: 'Concurrent B' }))])
    expect(responses.map(response => response.status)).toEqual([201, 201])
    const saved = await Promise.all(responses.map(response => response.json() as Promise<Ack>))
    expect(new Set(saved.map(result => result.contact.id)).size).toBe(2)
    const ids = new Set(saved.map(result => result.contact.id)), current = await persisted()
    expect(current.filter(item => !ids.has(item.id))).toEqual(original)
    expect(current.filter(item => ids.has(item.id)).map(item => item.fullName).sort()).toEqual(['Concurrent A', 'Concurrent B'])
    expect((await view()).contacts.filter(item => ids.has(item.id))).toHaveLength(2)
  })

  it('revalidates a queued mailbox token after acquiring the existing writer lease', async () => {
    const initial = await selected(), before = await f.bytes()
    const lock = f.state.store.getWriterLock(), held = await lock.acquire()
    const acquire = lock.acquire.bind(lock)
    let queued!: () => void
    const reached = new Promise<void>(resolve => { queued = resolve })
    const spy = vi.spyOn(lock, 'acquire').mockImplementation((...args) => { queued(); return acquire(...args) })
    let timer: ReturnType<typeof setTimeout> | undefined
    let released = false
    const pending = update(initial, { title: 'Denied queued edit' })
    try {
      await Promise.race([reached, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Contacts request did not reach the queued writer checkpoint')), 5000) })])
      await revokeAllApiTokensForPrincipal(f.database.db, f.principal.id)
      await held.release(); released = true
      expect((await pending).status).toBe(401)
      expect(await f.bytes()).toBe(before)
    } finally {
      if (timer) clearTimeout(timer)
      if (!released) await held.release()
      spy.mockRestore()
      await pending.catch(() => undefined)
    }
  })

  it('admits only one concurrent edit using the same captured current value', async () => {
    const initial = await selected(), original = await persisted()
    const responses = await Promise.all([update(initial, { title: 'Concurrent A' }), update(initial, { title: 'Concurrent B' })])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    const saved = await responses.find(response => response.status === 200)!.json() as Ack
    expect(await selected()).toEqual(saved.contact)
    expect((await persisted()).filter(item => item.id !== initial.id)).toEqual(original.filter(item => item.id !== initial.id))
  })
})
