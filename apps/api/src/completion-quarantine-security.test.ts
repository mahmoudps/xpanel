import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApiToken, createSession, createTestDb, createUserPrincipal } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { fail } from '@xpanel/core'
import { createApiApp, listenApiServer } from './server.ts'
import { deriveCsrfToken, sha256Hex } from './auth.ts'
import type { QuarantineGateway } from './mail/quarantine-routes.ts'
import type { QuarantineMessage, QuarantineScope, QuarantineMutation, QuarantineActionResult } from '../../agent/src/services/mail-quarantine.ts'

// Real authenticated loopback HTTP with disposable state/database and an explicit native-gateway
// double. This verifies API authorization, CSRF, scope and audit; it is not Dovecot/Bayes proof.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = randomUUID() + randomUUID()
const cleanup: Array<() => Promise<unknown>> = []
const fixture = async () => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Quarantine fixture', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Quarantine fixture', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.66', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const makeAccount = (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null, contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.66', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const account = await makeAccount('quarowner'), foreign = await makeAccount('quarother'), mailbox = 'held@' + account.primaryDomain
  const principal = await createUserPrincipal(database.db, { username: account.username, accountId: account.id, passwordHash: HASH })
  const foreignPrincipal = await createUserPrincipal(database.db, { username: foreign.username, accountId: foreign.id, passwordHash: HASH })
  await state.store.createServiceUser({ accountId: account.id, login: mailbox, passwordHash: '{ARGON2ID}' + HASH, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const token = async (principalId = principal.id, scopes = ['mail:read', 'mail:write']) => {
    const raw = 'xp_' + randomUUID(); await createApiToken(database.db, { principalId, name: 'Quarantine synthetic token', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() }); return raw
  }
  const credential = await token(), otherCredential = await token(foreignPrincipal.id)
  const locator = { mailboxGuid: 'b'.repeat(32), uidValidity: 7, uid: 10, messageGuid: 'd'.repeat(32) }
  let messages: QuarantineMessage[] = [{ locator, revision: 'a'.repeat(64), from: 'sender@example.test', to: mailbox, subject: 'Synthetic held message', receivedAt: '2026-08-01T00:00:00.000Z', heldAt: '2026-08-01T00:00:00.000Z', sizeBytes: 120, score: 8.5, reason: 'score=8.5', headers: 'Subject: Synthetic held message', releaseEligible: true }]
  let mode = 'normal'
  const calls: Array<{ action: string; scope: QuarantineScope }> = []
  const action = async (kind: 'release' | 'delete', scope: QuarantineScope, input: QuarantineMutation): Promise<QuarantineActionResult> => {
    calls.push({ action: kind, scope })
    const selected = messages.find(message => JSON.stringify(message.locator) === JSON.stringify(input.locator))
    if (!selected || selected.revision !== input.expectedRevision) return fail('CONFLICT', 'declared source changed', { stateChanged: false })
    const result: QuarantineActionResult = { state: kind === 'release' ? 'released' : 'deleted', scope: { ...scope }, locator: { ...input.locator }, sourceRevision: input.expectedRevision, correction: kind === 'release' ? 'applied' : 'not_attempted', deliveredToInbox: kind === 'release', deleted: kind === 'delete', sourcePresent: false, stateChanged: true, verificationRequired: false, observedAt: '2026-10-26T12:00:00.000Z' }
    if (mode === 'unknown') return { ...result, state: 'unknown', deliveredToInbox: null, sourcePresent: null, verificationRequired: true }
    if (mode === 'wrong-scope') return { ...result, scope: { accountId: foreign.id, mailbox } }
    messages = messages.filter(message => message !== selected)
    return result
  }
  const gateway: QuarantineGateway = {
    list: async (_caller, scope) => { calls.push({ action: 'list', scope }); return { state: 'available', scope, source: { kind: 'dovecot', folder: 'Spam', observedAt: '2026-10-26T12:00:00.000Z' }, revision: 'b'.repeat(64), messages, totalMessages: messages.length, nextBeforeUid: null, policy: { retentionDays: 30, retentionMode: 'manual_expiry', senderAllowAvailable: false, digestAvailable: false } } },
    release: (_caller, scope, input) => action('release', scope, input),
    delete: (_caller, scope, input) => action('delete', scope, input),
    expire: async (_caller, scope, expected) => {
      if (expected !== 'b'.repeat(64)) return fail('CONFLICT', 'declared page changed', { stateChanged: false })
      const results = await Promise.all(messages.map(message => action('delete', scope, { locator: message.locator, expectedRevision: message.revision })))
      return { state: 'expired', scope, removed: results.length, considered: results.length, results }
    },
  }
  const deps = { db: database.db, store: state.store, serverSecret: SECRET, quarantineGateway: gateway }
  const server = await listenApiServer(createApiApp(deps)); cleanup.push(() => server.close())
  const request = (path = '/api/mail/quarantine', method = 'GET', body?: unknown, bearer: string | null = credential, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${server.port}` + path, { method, headers: { ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
  const input = () => ({ mailbox, locator: { ...locator }, expectedRevision: 'a'.repeat(64) })
  return { database, state, account, foreign, principal, features, credential, otherCredential, mailbox, calls, request, input, token, gateway, setMode: (value: string) => { mode = value }, messages: () => messages }
}

describe('quarantine authenticated loopback HTTP', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => { const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close())); const failures = results.filter(result => result.status === 'rejected').map(result => result.reason); if (failures.length) throw new AggregateError(failures, 'Quarantine HTTP cleanup failed') })
  it('reads only the owned source through the native gateway with a pinned context', async () => {
    const response = await f.request(); expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ context: { accountId: f.account.id, mailbox: f.mailbox, mailboxes: [f.mailbox] }, quarantine: { state: 'available', totalMessages: 1 } })
    expect(f.calls).toEqual([{ action: 'list', scope: { accountId: f.account.id, mailbox: f.mailbox } }])
  })
  it.each(['release', 'delete'])('performs %s with exact source identity, readback and scoped audit', async action => {
    const response = await f.request('/api/mail/quarantine/' + action, 'POST', f.input())
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ result: { state: action === 'release' ? 'released' : 'deleted', sourcePresent: false, verificationRequired: false } })
    expect(f.messages()).toEqual([])
    expect((await (await f.request()).json() as { quarantine: { totalMessages: number } }).quarantine.totalMessages).toBe(0)
    expect((await f.database.db.query('SELECT action FROM audit_log WHERE action = $1', ['mail.quarantine.' + action])).length).toBe(1)
  })
  it('keeps an unknown outcome explicit without a success claim or a source retry', async () => {
    f.setMode('unknown'); const response = await f.request('/api/mail/quarantine/release', 'POST', f.input())
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ result: { state: 'unknown', verificationRequired: true, deliveredToInbox: null } })
    expect(f.calls.filter(call => call.action === 'release')).toHaveLength(1); expect(f.messages()).toHaveLength(1)
    expect((await f.database.db.query<{ outcome: string }>('SELECT outcome FROM audit_log WHERE action = $1', ['mail.quarantine.release']))[0]?.outcome).toBe('failed')
  })
  it('refuses a wrong native scope as an uncertain result instead of leaking its data', async () => {
    f.setMode('wrong-scope'); const response = await f.request('/api/mail/quarantine/delete', 'POST', f.input())
    expect(response.status).toBe(412); expect(await response.json()).toMatchObject({ details: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    expect((await f.database.db.query<{ outcome: string }>('SELECT outcome FROM audit_log WHERE action = $1', ['mail.quarantine.delete']))[0]?.outcome).toBe('failed')
  })
  it('refuses foreign account and mailbox selection before any native request', async () => {
    expect([403, 404]).toContain((await f.request('/api/mail/quarantine?accountId=' + f.foreign.id)).status)
    expect((await f.request('/api/mail/quarantine?mailbox=' + encodeURIComponent('foreign@' + f.foreign.primaryDomain))).status).toBe(404)
    expect((await f.request('/api/mail/quarantine?mailbox=' + encodeURIComponent(f.mailbox), 'GET', undefined, f.otherCredential)).status).toBe(404)
    expect(f.calls).toEqual([])
  })
  it.each([
    ['account injection', (input: Record<string, unknown>) => ({ ...input, accountId: 'foreign' })],
    ['revision missing', (input: Record<string, unknown>) => ({ mailbox: input.mailbox, locator: input.locator })],
    ['revision malformed', (input: Record<string, unknown>) => ({ ...input, expectedRevision: 'invalid' })],
    ['locator field injection', (input: Record<string, unknown>) => ({ ...input, locator: { ...(input.locator as Record<string, unknown>), command: 'ALL' } })],
  ])('refuses %s without native effects', async (_label, alter) => {
    const response = await f.request('/api/mail/quarantine/release', 'POST', alter(f.input()))
    expect(response.status).toBe(422); expect(f.messages()).toHaveLength(1); expect(f.calls).toEqual([])
  })
  it('refuses an oversized valid JSON stream before the captured mutation reaches the gateway', async () => {
    const response = await f.request('/api/mail/quarantine/release', 'POST', JSON.stringify(f.input()) + '\n' + ' '.repeat(16384))
    expect(response.status).toBe(422)
    expect(f.messages()).toHaveLength(1); expect(f.calls).toEqual([])
  })
  it('preserves feature and bearer scope gates', async () => {
    expect((await f.request('/api/mail/quarantine/delete', 'POST', f.input(), await f.token(f.principal.id, ['mail:read']))).status).toBe(403)
    await f.state.store.updateFeatureList(f.features.id, { disabled: ['spam-quarantine'] })
    expect((await f.request()).status).toBe(403); expect((await f.request('/api/mail/quarantine/delete', 'POST', f.input())).status).toBe(403)
    expect(f.calls).toEqual([])
  })
  it('requires authentication and valid session CSRF before the gateway is called', async () => {
    expect((await f.request('/api/mail/quarantine', 'GET', undefined, null)).status).toBe(401)
    expect((await f.request('/api/mail/quarantine/delete', 'POST', f.input(), null)).status).toBe(401)
    const raw = randomUUID() + randomUUID(); await createSession(f.database.db, { principalId: f.principal.id, tokenHash: sha256Hex(raw), expiresAt: new Date(Date.now() + 60000).toISOString() })
    const headers = { cookie: 'xpanel_session=' + raw }
    expect((await f.request('/api/mail/quarantine/delete', 'POST', f.input(), null, headers)).status).toBe(403)
    expect((await f.request('/api/mail/quarantine/delete', 'POST', f.input(), null, { ...headers, 'x-csrf-token': 'wrong' })).status).toBe(403)
    expect(f.calls).toEqual([])
    expect((await f.request('/api/mail/quarantine/delete', 'POST', f.input(), null, { ...headers, 'x-csrf-token': deriveCsrfToken(raw, SECRET) })).status).toBe(200)
  })
  it('expires the displayed page only against the captured page revision', async () => {
    const response = await f.request('/api/mail/quarantine/expire', 'POST', { mailbox: f.mailbox, expectedRevision: 'b'.repeat(64) })
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ result: { state: 'expired', removed: 1, considered: 1 } })
    expect(f.messages()).toEqual([])
  })
})
