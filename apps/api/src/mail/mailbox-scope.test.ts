import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { auditActorQuery, establishMailboxSession, mailboxAddressIndex, mailboxPrincipalUsername, openAuthorizedMailboxSession, rewriteMailboxIds } from './inbox.ts'
import type { AuthenticatedCaller } from '../auth.ts'
import type { MailboxTransport } from './inbox.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const SECRET = 'synthetic-mailbox-scope-server-secret-32'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const fixture = async () => {
  const database = await createTestDb()
  const state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  const features = await state.store.createFeatureList({ name: 'Mailbox fixture', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Mailbox fixture', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1024, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
    caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const php = { version: '8.3', handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }
  const account = await state.store.createAccount({ username: 'alpha', primaryDomain: 'alpha.example.test', passwordHash: HASH, planId: plan.id, ownerId: null, contactEmail: 'owner@alpha.example.test', ipv4: '192.0.2.10', shell: 'none', php })
  const serviceUser = await state.store.createServiceUser({ accountId: account.id, login: 'a@alpha.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: HASH })
  const transport: MailboxTransport = { async verify() {}, async list() { return [] }, async read() { throw new Error('unused') }, async remove() {}, async send() { return { messageId: '<synthetic@example.test>' } } }
  const established = await establishMailboxSession({ db: database.db, store: state.store, serverSecret: SECRET, transport, entryPoint: 'xmail', mailbox: serviceUser.login, password: 'synthetic-mailbox-password', ip: '192.0.2.5', userAgent: 'fixture' })
  const caller: AuthenticatedCaller = { principal: established.principal, principalRecord: established.principalRecord, sessionId: established.session.id, sessionToken: established.rawToken, apiTokenId: null, scopes: ['*'], csrfValid: true, mfaVerified: true }
  const open = (value = caller) => openAuthorizedMailboxSession(database.db, state.store, SECRET, value)
  return { state, account, serviceUser, features, caller, open }
}

describe('live mailbox session policy', () => {
  it('projects deleted mailbox audit identities without exposing the stored internal hash', () => {
    const address = 'known@example.test'
    const known = mailboxPrincipalUsername(address)
    const orphan = mailboxPrincipalUsername('deleted@example.test')
    const index = mailboxAddressIndex([address])
    expect(rewriteMailboxIds(known, index)).toBe(address)
    expect(rewriteMailboxIds(`mailbox:${orphan}`, index)).toBe('mailbox:Unavailable mailbox')
    expect(auditActorQuery(address)).toBe(known)
    expect(rewriteMailboxIds('root', index)).toBe('root')
  })
  it('opens only the mailbox bound to the caller and account', async () => {
    const f = await fixture()
    expect((await f.open()).record.mailbox).toBe(f.serviceUser.login)
    expect((await f.open()).password).toBe('synthetic-mailbox-password')
    await expect(f.open({ ...f.caller, principal: { ...f.caller.principal, kind: 'user', accountId: f.account.id, username: 'another-user' } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(f.open({ ...f.caller, principal: { kind: 'user', id: 'untrusted-fixture', username: f.caller.principal.username, accountId: 'another-account' } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(f.open({ ...f.caller, sessionId: null })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('refuses an existing session after email capability is disabled', async () => {
    const f = await fixture()
    await f.open()
    await f.state.store.updateServiceUser(f.serviceUser.id, { services: { email: false, ftp: true, webdisk: false } })
    await expect(f.open()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('refuses an existing session when the mail feature is disabled', async () => {
    const f = await fixture()
    await f.open()
    await f.state.store.updateFeatureList(f.features.id, { disabled: ['email-accounts'] })
    await expect(f.open()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('refuses an existing session after the mailbox is deleted', async () => {
    const f = await fixture()
    await f.state.store.deleteServiceUser(f.serviceUser.id)
    await expect(f.open()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
