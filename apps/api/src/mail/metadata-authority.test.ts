import { afterEach, describe, expect, it } from 'vitest'
import { assessMailboxMetadataAuthority } from '@xpanel/core'
import { createTestDb } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { createExtendedApiRouter, type ExtendedRouteHelpers, type WebmailIdentity, type WebmailVacationConfig } from '../extended-routes.ts'
import { vacationWorkspaceRevision } from './vacation-workspace.ts'
import {
  assertMailboxMetadataAuthority,
  captureMailboxMetadataAuthority,
  MAILBOX_METADATA_REVIEW_REQUIRED,
  resolveMailboxMetadataAuthority,
  readBoundMailboxIdentityRecords,
  type MailboxMetadataAuthorityStore,
} from './metadata-authority.ts'

const accountId = '11111111-1111-4111-8111-111111111111'
const serviceUserId = '22222222-2222-4222-8222-222222222222'
const mailbox = 'a@alpha.example.test'
const current = { accountId, serviceUserId, mailbox }
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const fakeStore = (options: { email?: boolean; status?: string; missingService?: boolean; missingAccount?: boolean; login?: string } = {}): MailboxMetadataAuthorityStore => ({
  async getServiceUserByLogin() { return options.missingService ? null : { id: serviceUserId, accountId, login: options.login ?? mailbox, services: { email: options.email ?? true } } },
  async getAccount() { return options.missingAccount ? null : { id: accountId, status: options.status ?? 'active' } },
})

const stateFixture = async () => {
  const state = await createTestStateStore()
  cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Metadata lifetime fixture', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Metadata lifetime fixture', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1024, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
    caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const makeAccount = () => state.store.createAccount({ username: 'alpha', primaryDomain: 'alpha.example.test', passwordHash: HASH, planId: plan.id, ownerId: null, contactEmail: 'owner@alpha.example.test', ipv4: '192.0.2.10', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
  })
  const makeService = (id: string) => state.store.createServiceUser({ accountId: id, login: mailbox, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: HASH })
  const account = await makeAccount()
  const service = await makeService(account.id)
  return { state, account, service, makeAccount, makeService }
}

const routeFixture = async () => {
  const f = await stateFixture()
  const caller = { principal: { kind: 'root', id: '99999999-9999-4999-8999-999999999999', username: 'root' }, sessionId: 'synthetic-session', apiTokenId: null, scopes: ['*'], csrfValid: true, mfaVerified: true }
  const audits: unknown[] = []
  const database = await createTestDb()
  cleanup.push(() => database.close())
  const helpers = { store: f.state.store, db: database.db, requireCaller: async () => caller, assertRoot: async () => {}, assertCanAccessAccount: async () => {},
    emitAudit: async (...args: unknown[]) => { await f.state.store.readSnapshot(); audits.push(args) }, resolveResellerId: async () => null, triggerReconcile: async () => null,
  } as unknown as ExtendedRouteHelpers
  const router = createExtendedApiRouter(helpers)
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const url = new URL('https://panel.example.test' + path)
    const req = new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
    const response = await router.handleExtendedRoute(req, url, method)
    if (!response) throw new Error('metadata fixture route did not match')
    return response
  }
  return { ...f, ...router, request, audits }
}

const identity = (id: string, patch: Partial<WebmailIdentity> = {}): WebmailIdentity => ({ id, mailbox, displayName: 'Preserved historical name', email: mailbox, replyTo: mailbox,
  textSignature: 'Preserved historical signature', htmlSignature: '', isDefault: true, createdAt: '2026-10-25T00:00:00.000Z', ...patch })
const vacation = (patch: Partial<WebmailVacationConfig> = {}): WebmailVacationConfig => ({ mailbox, enabled: true, subject: 'Preserved historical vacation', body: 'Historical private body', htmlBody: '', startDate: null, endDate: null,
  replyIntervalHours: 24, compiledSieve: 'Historical private source', updatedAt: '2026-10-25T00:00:00.000Z', ...patch })
const vacationKey = `webmail/vacation/${encodeURIComponent(mailbox)}.json`

describe('trusted mailbox metadata authority', () => {
  it('resolves only a current enabled service in its active bound account', async () => {
    expect(await captureMailboxMetadataAuthority(fakeStore(), mailbox)).toEqual(current)
    for (const options of [{ email: false }, { status: 'suspended' }, { status: 'terminating' }, { missingService: true }, { missingAccount: true }, { login: 'other@alpha.example.test' }]) {
      expect(await resolveMailboxMetadataAuthority(fakeStore(options), mailbox)).toBeNull()
      await expect(captureMailboxMetadataAuthority(fakeStore(options), mailbox)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    expect(await resolveMailboxMetadataAuthority(fakeStore(), { mailbox, accountId, serviceUserId })).toBeNull()
    let readAttempted = false
    await expect(readBoundMailboxIdentityRecords(fakeStore(), mailbox, async () => { readAttempted = true; return [] },
      { ...current, serviceUserId: '33333333-3333-4333-8333-333333333333' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(readAttempted).toBe(false)
  })

  it('withholds legacy metadata without adopting it or exposing history identifiers', () => {
    expect(() => assertMailboxMetadataAuthority(mailbox, undefined, current)).toThrow(expect.objectContaining({ code: 'PRECONDITION_FAILED', detail: { reason: 'mailbox_metadata_binding_unverified', stateChanged: false } }))
    expect(() => assertMailboxMetadataAuthority(mailbox, { ...current, serviceUserId: '33333333-3333-4333-8333-333333333333' }, current)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => assertMailboxMetadataAuthority(mailbox, current, current)).not.toThrow()
    expect(MAILBOX_METADATA_REVIEW_REQUIRED).toEqual({ status: 'review_required', reason: 'mailbox_metadata_binding_unverified' })
    expect(Object.isFrozen(MAILBOX_METADATA_REVIEW_REQUIRED)).toBe(true)
  })

  it('rejects preserved owner and grantee tuples after real service retirement and address reuse', async () => {
    const f = await stateFixture()
    const before = await captureMailboxMetadataAuthority(f.state.store, mailbox)
    const preserved = { id: 'preserved-contact-or-calendar', uid: 'preserved-calendar-uid', owner: mailbox, ownerAuthority: before, shares: [{ principal: mailbox, granteeAuthority: before }] }
    const bytes = JSON.stringify(preserved)
    expect(await f.state.store.deleteServiceUser(f.service.id)).toBe(true)
    expect(await resolveMailboxMetadataAuthority(f.state.store, mailbox)).toBeNull()
    const replacement = await f.makeService(f.account.id)
    const after = await captureMailboxMetadataAuthority(f.state.store, mailbox)
    expect(replacement.id).not.toBe(before.serviceUserId)
    expect(after.accountId).toBe(before.accountId)
    expect(assessMailboxMetadataAuthority(preserved.owner, preserved.ownerAuthority, after)).toBe('mismatch')
    expect(assessMailboxMetadataAuthority(preserved.shares[0]!.principal, preserved.shares[0]!.granteeAuthority, after)).toBe('mismatch')
    expect(JSON.stringify(preserved)).toBe(bytes)
  })

  it('rejects preserved metadata after real account retirement and same-name recreation', async () => {
    const f = await stateFixture()
    const before = await captureMailboxMetadataAuthority(f.state.store, mailbox)
    await f.state.store.markTerminating(f.account.id)
    expect(await f.state.store.deleteAccount(f.account.id)).toBe(true)
    expect(await resolveMailboxMetadataAuthority(f.state.store, mailbox)).toBeNull()
    const replacement = await f.makeAccount()
    await f.makeService(replacement.id)
    const after = await captureMailboxMetadataAuthority(f.state.store, mailbox)
    expect(after.accountId).not.toBe(before.accountId)
    expect(after.serviceUserId).not.toBe(before.serviceUserId)
    expect(assessMailboxMetadataAuthority(mailbox, before, after)).toBe('mismatch')
    expect(assessMailboxMetadataAuthority(mailbox, undefined, after)).toBe('unbound')
  })

  it('creates, updates, defaults and deletes current identities through the mounted routes', async () => {
    const f = await routeFixture()
    const firstResponse = await f.request('/api/webmail/identities', 'POST', { mailbox, email: mailbox, displayName: 'First' })
    expect(firstResponse.status).toBe(201)
    const first = (await firstResponse.json()).identity as WebmailIdentity
    expect(first.ownerAuthority).toBeUndefined()
    expect(first.isDefault).toBe(true)
    const second = (await (await f.request('/api/webmail/identities', 'POST', { mailbox, email: mailbox, displayName: 'Second', isDefault: true })).json()).identity as WebmailIdentity
    const patched = await f.request(`/api/webmail/identities/${first.id}`, 'PATCH', { textSignature: 'Current signature' })
    expect((await patched.json()).identity.textSignature).toBe('Current signature')
    expect((await f.request(`/api/webmail/identities/${second.id}`, 'DELETE')).status).toBe(200)
    const result = await (await f.request(`/api/webmail/identities?mailbox=${encodeURIComponent(mailbox)}`)).json()
    expect(result.identities).toMatchObject([{ id: first.id, isDefault: true }])
    expect(JSON.stringify(result)).not.toContain(f.service.id)
    const stored = await f.ext.readOrDefault<WebmailIdentity[]>('webmail/identities.json', [])
    expect(stored[0]!.ownerAuthority).toEqual(await captureMailboxMetadataAuthority(f.state.store, mailbox))
    expect(f.audits).toHaveLength(4)
  })

  it('preserves unbound and old-lifetime identities without list, default or direct-send adoption', async () => {
    const f = await routeFixture()
    const authority = await captureMailboxMetadataAuthority(f.state.store, mailbox)
    const legacy = identity('55555555-5555-4555-8555-555555555555')
    const former = identity('66666666-6666-4666-8666-666666666666', { ownerAuthority: { ...authority, serviceUserId } })
    await f.ext.write('webmail/identities.json', [legacy, former])
    const before = JSON.stringify([legacy, former])
    const result = await (await f.request(`/api/webmail/identities?mailbox=${encodeURIComponent(mailbox)}`)).json()
    expect(result).toEqual({ identities: [], metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED })
    await expect(f.request(`/api/webmail/identities/${legacy.id}`, 'PATCH', { displayName: 'Adopted' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(f.request(`/api/webmail/identities/${former.id}`, 'DELETE')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(f.request('/api/webmail/messages', 'POST', { mailbox, from: mailbox, identityId: legacy.id, to: ['recipient@example.test'] })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const created = await f.request('/api/webmail/identities', 'POST', { mailbox, email: mailbox, displayName: 'Current' })
    expect(created.status).toBe(201)
    const stored = await f.ext.readOrDefault<WebmailIdentity[]>('webmail/identities.json', [])
    expect(JSON.stringify(stored.slice(0, 2))).toBe(before)
    expect(stored[2]!.isDefault).toBe(true)
  })

  it('withholds retired identity/vacation content after address reuse and refuses historical writes', async () => {
    const f = await routeFixture()
    const authority = await captureMailboxMetadataAuthority(f.state.store, mailbox)
    const oldIdentity = identity('77777777-7777-4777-8777-777777777777', { ownerAuthority: authority })
    const oldVacation = vacation({ ownerAuthority: authority })
    await f.ext.write('webmail/identities.json', [oldIdentity])
    await f.ext.write(vacationKey, oldVacation)
    await f.state.store.deleteServiceUser(f.service.id)
    await f.makeService(f.account.id)
    const identities = await (await f.request(`/api/webmail/identities?mailbox=${encodeURIComponent(mailbox)}`)).json()
    expect(identities.identities).toEqual([])
    const visibleVacation = await (await f.request(`/api/webmail/vacation?mailbox=${encodeURIComponent(mailbox)}`)).json()
    expect(visibleVacation.vacation.enabled).toBe(false)
    expect(JSON.stringify(visibleVacation)).not.toContain('Historical private')
    expect(visibleVacation.metadataReview).toEqual(MAILBOX_METADATA_REVIEW_REQUIRED)
    await expect(f.request(`/api/webmail/identities/${oldIdentity.id}`, 'DELETE')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(f.request('/api/webmail/vacation', 'PUT', { mailbox, enabled: false })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await f.ext.readOrDefault(vacationKey, null)).toEqual(oldVacation)
    expect(await f.ext.readOrDefault('webmail/identities.json', [])).toEqual([oldIdentity])
  })

  it('guards unbound vacation storage and binds only a genuinely new current configuration', async () => {
    const f = await routeFixture()
    const legacy = vacation()
    await f.ext.write(vacationKey, legacy)
    const response = await (await f.request(`/api/webmail/vacation?mailbox=${encodeURIComponent(mailbox)}`)).json()
    expect(response.vacation.enabled).toBe(false)
    expect(JSON.stringify(response)).not.toContain(legacy.subject)
    await expect(f.request('/api/webmail/vacation', 'PUT', { mailbox, enabled: false })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'mailbox_metadata_binding_unverified', stateChanged: false } })
    expect(await f.ext.readOrDefault(vacationKey, null)).toEqual(legacy)
    const fresh = await routeFixture()
    const saved = await fresh.request('/api/webmail/vacation', 'PUT', { mailbox, enabled: true, subject: 'Current subject', body: 'Current body', replyIntervalHours: 48 })
    expect(saved.status).toBe(200)
    const publicResult = await saved.json()
    expect(publicResult.vacation.ownerAuthority).toBeUndefined()
    expect(publicResult.vacation.compiledSieve).toContain('vacation :days 2')
    const stored = await fresh.ext.readOrDefault<WebmailVacationConfig | null>(vacationKey, null)
    expect(stored?.ownerAuthority).toEqual(await captureMailboxMetadataAuthority(fresh.state.store, mailbox))
    expect(vacationWorkspaceRevision(stored)).not.toBe(vacationWorkspaceRevision({ ...stored!, ownerAuthority: undefined }))
    await expect(fresh.request('/api/webmail/vacation', 'PUT', { mailbox, ownerAuthority: current, enabled: false })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(fresh.request('/api/webmail/identities', 'POST', { mailbox, email: mailbox, ownerAuthority: current })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
