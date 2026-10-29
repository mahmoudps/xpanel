import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeHostExecutor, HostReconciler, createAgentApp } from '@xpanel/agent'
import { createApiToken, createTestDb, createUserPrincipal } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore } from '@xpanel/state'
import { sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

// Public independent Argon2 fixture vector; these identities authenticate disposable synthetic fixtures only.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const applied = { state: 'applied', reason: null }

const fixture = async () => {
  const database = await createTestDb()
  const state = await createTestStateStore()
  const features = await state.store.createFeatureList({ name: 'Routing policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Routing plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 10, forwarders: 10, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null,
    contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.10', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const owner = await account('routea'), other = await account('routeb')
  const inbox = await state.store.createServiceUser({ accountId: owner.id, login: `info@${owner.primaryDomain}`, passwordHash: `{ARGON2ID}${HASH}`,
    services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const principal = await createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  const executor = new FakeHostExecutor()
  const osProfile = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
  const agentApp = createAgentApp({
    reconciler: new HostReconciler({ store: state.store, db: database.db, executor, os: osProfile }),
    store: state.store, db: database.db, executor,
    os: { id: osProfile.id, versionId: osProfile.versionId, family: osProfile.family },
    agentToken: TEST_AGENT_TOKEN,
  })
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET, agentApp, agentToken: TEST_AGENT_TOKEN })
  const raw = `xp_${randomUUID()}`
  await createApiToken(database.db, { principalId: principal.id, name: 'Synthetic routing test', tokenHash: sha256Hex(raw), scopes: ['mail:read', 'mail:write', 'webmail:read', 'webmail:write'], expiresAt: new Date(Date.now() + 600000).toISOString() })
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await app.fetch(new Request(`http://localhost${path}`, { method,
      headers: { authorization: `Bearer ${raw}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  const file = (suffix: string) => [...executor.files.values()].find(item => item.path.endsWith(suffix))?.content ?? null
  return { database, state, owner, other, inbox, executor, call, file }
}

describe('account mail routing applied on the host through the agent', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => { await f.state.close(); await f.database.close() })

  it('applies a rejecting forwarder and a forwarding default address, and reports each as applied', async () => {
    const domain = f.owner.primaryDomain
    const created = await f.call('/api/mail/forwarders', 'POST', { sourceAddress: `old@${domain}`, action: 'reject', rejectMessage: 'This address is no longer used' })
    expect(created.status).toBe(201)
    expect(created.body.forwarder).toMatchObject({ action: 'reject', application: applied })
    expect(f.file('/xpanel/recipient_access')).toContain(`old@${domain}\tREJECT 5.1.1 This address is no longer used\n`)
    expect((await f.call('/api/mail/forwarders', 'POST', { sourceAddress: f.inbox.login, action: 'reject', rejectMessage: 'gone' })).status).toBe(409)

    const saved = await f.call('/api/mail/default-addresses', 'PUT', { domain, kind: 'forward', destination: f.inbox.login })
    expect(saved.status).toBe(200)
    expect(saved.body.defaultAddresses).toEqual([{ domain, kind: 'forward', destination: f.inbox.login, updatedAt: expect.any(String), application: applied }])
    expect(f.file('/xpanel/virtual_aliases')).toContain(`@${domain}\t${f.inbox.login}\n`)
    expect((await f.call('/api/mail/domain-forwarders', 'POST', { sourceDomain: domain, targetDomain: 'elsewhere.example.test' })).status).toBe(409)

    expect((await f.call('/api/mail/default-addresses', 'PUT', { domain, kind: 'reject' })).body.defaultAddresses[0]).toMatchObject({ kind: 'reject', destination: null, application: applied })
    expect(f.file('/xpanel/virtual_aliases')).not.toContain(`@${domain}\t`)
  })

  it('refuses another account domain and unknown default address fields without writing', async () => {
    expect((await f.call('/api/mail/default-addresses', 'PUT', { domain: f.other.primaryDomain, kind: 'discard' })).status).toBe(404)
    expect([403, 404]).toContain((await f.call(`/api/mail/default-addresses?accountId=${f.other.id}`)).status)
    expect((await f.call('/api/mail/default-addresses', 'PUT', { domain: f.owner.primaryDomain, kind: 'pipe' })).status).toBe(422)
    expect((await f.call('/api/mail/default-addresses', 'PUT', { domain: f.owner.primaryDomain, kind: 'discard', destination: 'x@example.test' })).status).toBe(422)
    expect(f.file('/xpanel/virtual_aliases')).toBeNull()
  })

  it('lists enabled autoresponders with their host state after a save through the vacation route', async () => {
    const saved = await f.call('/api/webmail/vacation', 'PUT', { mailbox: f.inbox.login, enabled: true, subject: 'Planned maintenance', body: 'We are back at 06:00 UTC.',
      htmlBody: '', startDate: '2026-10-24T00:00:00.000Z', endDate: '2026-10-25T06:00:00.000Z', replyIntervalHours: 8 })
    expect(saved.status).toBe(200)
    expect(saved.body.application).toEqual(applied)
    expect(f.file('/info/.dovecot.sieve')).toContain('vacation :seconds 28800 :subject "Planned maintenance"')
    const listed = await f.call('/api/mail/autoresponders')
    expect(listed.body).toMatchObject({ context: { accountId: f.owner.id }, mailboxes: [f.inbox.login],
      autoresponders: [{ mailbox: f.inbox.login, subject: 'Planned maintenance', replyIntervalHours: 8, revision: expect.stringMatching(/^[0-9a-f]{64}$/), application: applied }] })
    const off = await f.call('/api/webmail/vacation', 'PUT', { mailbox: f.inbox.login, enabled: false, expectedRevision: listed.body.autoresponders[0].revision })
    expect(off.status).toBe(200)
    expect((await f.call('/api/mail/autoresponders')).body.autoresponders).toEqual([])
    expect(f.file('/info/.dovecot.sieve')).toBeNull()
  })

  it('answers for an address without a mailbox, edits it in place and removes it, with host state', async () => {
    const domain = f.owner.primaryDomain, address = `sales@${domain}`
    const fields = { enabled: true, subject: 'Thanks for writing', body: 'We answer within a day.', htmlBody: '', startDate: null, endDate: null, replyIntervalHours: 24 }
    const created = await f.call('/api/mail/autoresponders', 'PUT', { address, ...fields, expectedRevision: null })
    expect(created.status).toBe(200)
    const record = created.body.autoresponders.find((item: Record<string, unknown>) => item.address === address)
    expect(record).toMatchObject({ kind: 'address', mailbox: null, subject: 'Thanks for writing', application: applied })
    expect(f.file('/xpanel/virtual_aliases')).toMatch(new RegExp(`sales@${domain.replaceAll('.', '\\.')}\\tr[0-9a-f]{20}@a[0-9a-f]{16}\\.autoreply\\.xpanel\\.invalid\\n`))

    // edit in place: the revision binds the change to what was read
    expect((await f.call('/api/mail/autoresponders', 'PUT', { address, ...fields, subject: 'Stale', expectedRevision: null })).status).toBe(409)
    const edited = await f.call('/api/mail/autoresponders', 'PUT', { address, ...fields, subject: 'Back on Monday', expectedRevision: record.revision })
    expect(edited.status).toBe(200)
    const after = edited.body.autoresponders.find((item: Record<string, unknown>) => item.address === address)
    expect(after).toMatchObject({ subject: 'Back on Monday', application: applied })
    expect(after.revision).not.toBe(record.revision)
    expect([...f.executor.files.values()].some(item => item.path.endsWith('/.dovecot.sieve') && item.content.includes(':subject "Back on Monday" :from "' + address + '"'))).toBe(true)

    expect((await f.call('/api/mail/autoresponders', 'PUT', { address: f.inbox.login, ...fields, expectedRevision: null })).status).toBe(409)
    expect((await f.call('/api/mail/autoresponders', 'PUT', { address: `x@${f.other.primaryDomain}`, ...fields, expectedRevision: null })).status).toBe(404)
    const removed = await f.call('/api/mail/autoresponders', 'DELETE', { address, expectedRevision: after.revision })
    expect(removed.status).toBe(200)
    expect(removed.body.autoresponders).toEqual([])
    expect(f.file('/xpanel/virtual_aliases')).not.toContain('autoreply.xpanel.invalid')
  })

  it('installs a mailbox filter, and restores the previous rules when the Sieve check fails', async () => {
    const scope = { scope: 'mailbox', mailbox: f.inbox.login }
    const read = async () => (await f.call(`/api/mail/filters?scope=mailbox&mailbox=${encodeURIComponent(f.inbox.login)}`)).body
    const created = await f.call('/api/mail/filters', 'POST', { ...scope, name: 'Suppliers', conditions: [{ field: 'from', comparator: 'contains', value: '@atlas-pack.example' }],
      actions: [{ type: 'fileinto', target: 'Suppliers' }], expectedRevision: (await read()).revision })
    expect(created.status).toBe(201)
    expect(created.body.filter.application).toEqual(applied)
    const installed = f.file('/info/.dovecot.sieve')
    expect(installed).toContain('fileinto :create "Suppliers";')

    f.executor.failConfigTest('sieve', 'line 4: error: unknown extension')
    const before = await read()
    const refused = await f.call('/api/mail/filters', 'POST', { ...scope, name: 'Second', conditions: [], actions: [{ type: 'keep' }], expectedRevision: before.revision })
    expect(refused.status).toBe(422)
    expect(refused.body).toMatchObject({ code: 'CONFIG_TEST_FAILED', details: { rolledBack: true, stateChanged: false, reason: expect.stringContaining('unknown extension') } })
    const after = await read()
    expect(after.filters.map((rule: { name: string }) => rule.name)).toEqual(['Suppliers'])
    expect(after.filters[0].application).toEqual(applied)
    expect(f.file('/info/.dovecot.sieve')).toBe(installed)
  })
})
