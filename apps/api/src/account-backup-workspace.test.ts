import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createApiToken, createSession, createTestDb, createUserPrincipal } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { AgentApp } from '@xpanel/agent'
import { deriveCsrfToken, sha256Hex } from './auth.ts'
import { sessionCookieName, sessionTokenHash } from './entry-points.ts'
import { createApiApp } from './server.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

// Actual authentication/authorization/state/API adapter; archive RPC replies are declared fakes.
// No native create/extract/socket or disaster-recovery claim is made by this fixture.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const endpoint = '/api/account/backups', username = 'backup9'
const file = 'xpanel-backup-' + username + '-20261026T100000Z.tar.gz'
const created = 'xpanel-backup-' + username + '-20261026T100001Z-abcdef012345.tar.gz'
const recovery = 'xpanel-backup-' + username + '-20261026T100002Z-fedcba543210.tar.gz'
const cleanup: (() => Promise<unknown>)[] = []
const fixture = async () => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Backup fixture features', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Backup fixture plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const owner = await state.store.createAccount({ username, passwordHash: HASH, primaryDomain: username + '.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@' + username + '.example.test', ipv4: '192.0.2.10', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const principal = await createUserPrincipal(database.db, { username, accountId: owner.id, passwordHash: HASH })
  const mailbox = await state.store.createServiceUser({ accountId: owner.id, login: 'inbox@' + owner.primaryDomain, passwordHash: HASH, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const token = async (scopes = ['*']) => { const raw = 'xp_' + randomUUID(); await createApiToken(database.db, { principalId: principal.id, name: 'Declared backup transport', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() }); return raw }
  const credential = await token(), bytes = gzipSync('declared synthetic archive RPC bytes')
  const archives = [{ file, bytes: bytes.length }], seen: {path:string;method:string;body:unknown;principalId:string|null}[] = []
  const preview = { file, bytes: bytes.length, scope: 'home', mailPreserved: true, revision: 'a'.repeat(64), archiveSha256: 'b'.repeat(64), rows: [{ path: 'public_html/index.html', state: 'replace', archiveBytes: 3, currentBytes: 2 }], counts: { add: 0, replace: 1, unchanged: 0, keep: 0, 'preserve-mail': 0 } }
  let override: ((path: string) => Response | undefined) | undefined
  const agent: AgentApp = { subscribe: () => () => {}, fetch: async req => {
    const path = new URL(req.url).pathname, body = req.method === 'POST' ? await req.json() : undefined
    seen.push({ path, method: req.method, body, principalId: req.headers.get('x-xpanel-principal-id') })
    const replaced = override?.(path); if (replaced) return replaced
    if (path.endsWith('/download')) return new Response(bytes, { headers: { 'content-type': 'application/gzip', 'content-length': String(bytes.length), 'content-disposition': 'attachment; filename="' + file + '"' } })
    if (path.endsWith('/preview')) return Response.json({ preview })
    if (path.endsWith('/restore')) { archives.push({ file: recovery, bytes: bytes.length }); return Response.json({ backup: { file, scope: 'home', mailPreserved: true, contentReadback: 'matched', recovery: { file: recovery, bytes: bytes.length } } }) }
    if (req.method === 'POST') { archives.push({ file: created, bytes: bytes.length }); return Response.json({ backup: { file: created, bytes: bytes.length } }, { status: 201 }) }
    return Response.json({ backups: [...archives] })
  } }
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET, agentToken: TEST_AGENT_TOKEN, agentApp: agent })
  const call = (suffix = '', body?: unknown, raw = credential, headers: Record<string,string> = {}) => app.fetch(new Request('http://localhost' + endpoint + suffix, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + raw, ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  return { database, state, principal, owner, mailbox, token, credential, bytes, archives, seen, preview, call, agent, override: (value: typeof override) => { override = value } }
}
afterEach(async () => { const closed = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close())); const failed = closed.filter(result => result.status === 'rejected'); if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Backup fixture cleanup failed') })

describe('account backup actual API authorization with declared archive transport', () => {
  it('pins every RPC to the authenticated owner and verifies creation/list readback', async () => {
    const f = await fixture(), response = await f.call()
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ context: { accountId: f.owner.id, username }, backups: [{ file, bytes: f.bytes.length }] })
    expect((await f.call('', {}, f.credential, { 'x-xpanel-principal-id': randomUUID(), 'x-role': 'root' })).status).toBe(201)
    expect(f.seen.map(item => item.method)).toEqual(['GET', 'POST', 'GET'])
    expect(f.seen.every(item => item.principalId === f.principal.id && item.path === '/accounts/' + username + '/backup-workspace')).toBe(true)
  })
  it('rejects unauthenticated, mailbox and injected account selectors before RPC dispatch', async () => {
    const f = await fixture()
    expect((await f.call('', undefined, 'invalid')).status).toBe(401)
    const mailbox = await f.token(['*', 'mailbox:' + f.mailbox.id])
    expect((await f.call('', undefined, mailbox)).status).toBe(403)
    for (const body of [{ accountId: randomUUID() }, { username: 'other9' }, { path: '/etc/passwd' }, { op: 'restore' }]) expect((await f.call('', body)).status).toBe(422)
    expect((await f.call('?accountId=' + randomUUID())).status).toBe(422)
    expect(f.seen).toHaveLength(0)
  })
  it('allows read-only archive review/download and denies creation/restoration', async () => {
    const f = await fixture(), readOnly = await f.token(['backups:read'])
    expect((await f.call('', undefined, readOnly)).status).toBe(200)
    expect((await f.call('/' + file + '/preview', {}, readOnly)).status).toBe(200)
    const downloaded = await f.call('/' + file + '/download', undefined, readOnly)
    expect(downloaded.status).toBe(200); expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(f.bytes)
    const before = f.seen.length
    expect((await f.call('', {}, readOnly)).status).toBe(403)
    expect((await f.call('/' + file + '/restore', { confirmation: username, expectedRevision: f.preview.revision }, readOnly)).status).toBe(403)
    expect(f.seen).toHaveLength(before)
  })
  it('rejects foreign archives and stale/unnamed restore requests before effects', async () => {
    const f = await fixture()
    expect((await f.call('/' + file.replace(username, 'foreign9') + '/preview', {})).status).toBe(422)
    for (const body of [{}, { confirmation: 'other9', expectedRevision: f.preview.revision }, { confirmation: username, expectedRevision: 'stale' }, { confirmation: username, expectedRevision: f.preview.revision, accountId: randomUUID() }]) expect((await f.call('/' + file + '/restore', body)).status).toBe(422)
    expect(f.seen).toHaveLength(0)
    const restored = await f.call('/' + file + '/restore', { confirmation: username, expectedRevision: f.preview.revision })
    expect(restored.status).toBe(200); expect(await restored.json()).toMatchObject({ backup: { recovery: { file: recovery }, mailPreserved: true, contentReadback: 'matched' } })
  })
  it('refuses fabricated creation acknowledgements and mismatched download headers', async () => {
    const f = await fixture()
    f.override(path => path.endsWith('/download') ? new Response(f.bytes, { headers: { 'content-type': 'application/gzip', 'content-length': String(f.bytes.length), 'content-disposition': 'attachment; filename="foreign.tar.gz"' } }) : undefined)
    expect((await f.call('/' + file + '/download')).status).toBe(412)
    f.override(() => Response.json({ backup: { file: created, bytes: f.bytes.length } }, { status: 201 }))
    const response = await f.call('', {}); expect(response.status).toBe(412); expect(await response.json()).toMatchObject({ details: { stateChanged: true, verificationRequired: true } })
  })
  it('enforces session origin and CSRF before an owner backup mutation', async () => {
    const f = await fixture(), raw = 'backup-session-' + randomUUID(), origin = 'https://panel.example.test:2083'
    await createSession(f.database.db, { principalId: f.principal.id, tokenHash: sessionTokenHash(raw, 'xpanel'), expiresAt: new Date(Date.now() + 60000).toISOString(), mfaVerified: true })
    const app = createApiApp({ db: f.database.db, store: f.state.store, serverSecret: TEST_SERVER_SECRET, entryPoint: 'xpanel', publicOrigin: origin, allowedOrigins: [origin], secureCookies: true, requireOriginHeader: true, agentToken: TEST_AGENT_TOKEN, agentApp: f.agent })
    const request = (csrf?: string, source = origin) => app.fetch(new Request(origin + endpoint, { method: 'POST', headers: { origin: source, cookie: sessionCookieName('xpanel', true) + '=' + raw, 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: '{}' }))
    expect((await request()).status).toBe(403); expect((await request('invalid')).status).toBe(403)
    expect((await request(deriveCsrfToken(raw, TEST_SERVER_SECRET, 'xpanel'), 'https://hostile.example.test')).status).toBe(403); expect(f.seen).toHaveLength(0)
    expect((await request(deriveCsrfToken(raw, TEST_SERVER_SECRET, 'xpanel'))).status).toBe(201)
  })
})