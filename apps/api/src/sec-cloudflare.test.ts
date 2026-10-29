import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { CLOUDFLARE_API, compareCloudflareRecords, handleSecCloudflareRoute, providersRevision, SEC_DNS_PROVIDERS_STATE } from './sec-cloudflare.ts'
import type { SecCloudflareHelpers } from './sec-cloudflare.ts'

const ROOT = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 'one', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
const ACCOUNT = { id: '22222222-2222-4222-8222-222222222222', username: 'alice', status: 'active', planId: 'p' }
const OWNER = { principal: { kind: 'user', id: '33333333-3333-4333-8333-333333333333', username: 'alice', accountId: ACCOUNT.id }, sessionId: 'two', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
const TOKEN = 'A'.repeat(36) + 'b_-9', TOKEN_ID = 'c'.repeat(32), ZONE = 'd'.repeat(32)
let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-cf-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const envelope = (result: unknown, success = true, status = 200) => new Response(JSON.stringify({ success, errors: success ? [] : [{ code: 9109, message: 'Invalid access token' }], messages: [], result }), { status })
function cloudflare(overrides: Record<string, () => Response> = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), path = url.slice(CLOUDFLARE_API.length).split('?')[0]!
    expect(url.startsWith(CLOUDFLARE_API)).toBe(true)
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer ' + TOKEN)
    if (overrides[path]) return overrides[path]!()
    if (path === '/user/tokens/verify') return envelope({ id: TOKEN_ID, status: 'active' })
    if (path === '/zones') return envelope([{ id: ZONE, name: 'alice.test' }, { id: 'e'.repeat(32), name: 'other.test' }])
    if (path === '/zones/' + ZONE) return envelope({ id: ZONE, name: 'alice.test', status: 'active', paused: false, name_servers: ['ada.ns.cloudflare.com'] })
    if (path === `/zones/${ZONE}/settings/ssl`) return envelope({ id: 'ssl', value: 'strict' })
    if (path === `/zones/${ZONE}/dns_records`) return envelope([{ name: 'alice.test', type: 'A', content: '104.16.1.1', proxied: true }, { name: 'mail.alice.test', type: 'A', content: '203.0.113.9', proxied: false }, { name: 'alice.test', type: 'TXT', content: '"v=spf1 -all"', proxied: false }])
    if (path === `/zones/${ZONE}/purge_cache`) { expect(init?.method).toBe('POST'); expect(JSON.parse(String(init?.body))).toEqual({ purge_everything: true }); return envelope({ id: ZONE }) }
    return envelope(null, false, 404)
  })
}
function harness(fetcher = cloudflare(), caller = ROOT) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const helpers = {
    requireCaller: vi.fn(async () => caller), assertRoot: vi.fn(async (current: AuthenticatedCaller) => { if (current.principal.kind !== 'root') fail('FORBIDDEN', 'root required', { stateChanged: false }) }), emitAudit: vi.fn(async () => undefined), fetch: fetcher,
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }), getAccount: async () => ACCOUNT, getPlan: async () => ({ featureListId: 'f' }), getFeatureList: async () => ({ disabled: [] }),
      listDomains: async (filter: { accountId?: string } = {}) => filter.accountId && filter.accountId !== ACCOUNT.id ? [] : [{ name: 'alice.test' }, ...(filter.accountId ? [] : [{ name: 'bob.test' }])],
      getDnsZone: async (name: string) => name === 'alice.test' ? { name, records: [{ name: '@', type: 'A', content: '203.0.113.5', priority: null }, { name: 'mail', type: 'A', content: '203.0.113.10', priority: null }, { name: '@', type: 'TXT', content: 'v=spf1 -all', priority: null }, { name: 'www', type: 'CNAME', content: 'alice.test.', priority: null }] } : null },
    now: () => new Date('2026-10-28T12:00:00.000Z'),
  } as unknown as SecCloudflareHelpers
  const send = (path: string, method = 'GET', body?: unknown) => handleSecCloudflareRoute(new Request('http://api.test' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://api.test' + path), method, helpers)
  return { helpers, send }
}

describe('sec Cloudflare provider accounts', () => {
  it('verifies a token before saving it, never returns it and stores it 0600', async () => {
    const h = harness()
    const empty = await (await h.send('/api/server/sec/dns-providers'))!.json()
    expect(empty).toEqual({ revision: providersRevision(null), accounts: [], links: [], domains: ['alice.test', 'bob.test'] })
    const saved = await (await h.send('/api/server/sec/dns-providers/accounts', 'POST', { label: 'Main', token: TOKEN, expectedRevision: empty.revision }))!.json()
    expect(saved.accounts).toEqual([expect.objectContaining({ label: 'Main', tokenId: TOKEN_ID })])
    expect(JSON.stringify(saved)).not.toContain(TOKEN)
    expect(JSON.stringify((h.helpers.emitAudit as unknown as { mock: { calls: unknown[] } }).mock.calls)).not.toContain(TOKEN)
    expect(JSON.parse(await readFile(join(root, SEC_DNS_PROVIDERS_STATE), 'utf8')).accounts[0].token).toBe(TOKEN)
    if (process.platform !== 'win32') expect((await stat(join(root, SEC_DNS_PROVIDERS_STATE))).mode & 0o777).toBe(0o600)
    await expect(h.send('/api/server/sec/dns-providers/accounts', 'POST', { label: 'Again', token: TOKEN, expectedRevision: saved.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('refuses inactive tokens, malformed tokens and Cloudflare refusals without saving', async () => {
    const inactive = harness(cloudflare({ '/user/tokens/verify': () => envelope({ id: TOKEN_ID, status: 'disabled' }) }))
    await expect(inactive.send('/api/server/sec/dns-providers/accounts', 'POST', { label: 'Main', token: TOKEN, expectedRevision: providersRevision(null) })).rejects.toMatchObject({ detail: { reason: 'token_inactive' } })
    const refused = harness(cloudflare({ '/user/tokens/verify': () => envelope(null, false, 401) }))
    await expect(refused.send('/api/server/sec/dns-providers/accounts', 'POST', { label: 'Main', token: TOKEN, expectedRevision: providersRevision(null) })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { providerCodes: [9109] } })
    await expect(harness().send('/api/server/sec/dns-providers/accounts', 'POST', { label: 'Main', token: 'short', expectedRevision: providersRevision(null) })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(readFile(join(root, SEC_DNS_PROVIDERS_STATE), 'utf8')).rejects.toThrow()
  })
  it('links a hosted domain to its exact zone, reads the live zone and purges only linked zones', async () => {
    const h = harness()
    let view = await (await h.send('/api/server/sec/dns-providers/accounts', 'POST', { label: 'Main', token: TOKEN, expectedRevision: providersRevision(null) }))!.json()
    await expect(h.send('/api/server/sec/dns-providers/links', 'POST', { domain: 'nothosted.test', accountId: view.accounts[0].id, expectedRevision: view.revision })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    view = await (await h.send('/api/server/sec/dns-providers/links', 'POST', { domain: 'alice.test', accountId: view.accounts[0].id, expectedRevision: view.revision }))!.json()
    expect(view.links).toEqual([expect.objectContaining({ domain: 'alice.test', zoneId: ZONE })])
    const zone = await (await h.send('/api/server/sec/dns-providers/zone?domain=alice.test'))!.json()
    expect(zone).toMatchObject({ status: 'active', sslMode: 'strict', localZone: true, truncated: false })
    expect(zone.records.map((row: { name: string; type: string; state: string }) => `${row.name} ${row.type} ${row.state}`)).toEqual(['alice.test A match', 'alice.test TXT match', 'mail.alice.test A differs', 'www.alice.test CNAME missing_at_cloudflare'])
    expect(await (await h.send('/api/server/sec/dns-providers/purge', 'POST', { domain: 'alice.test' }))!.json()).toEqual({ domain: 'alice.test', outcome: 'accepted', observedAt: '2026-10-28T12:00:00.000Z' })
    await expect(h.send('/api/server/sec/dns-providers/purge', 'POST', { domain: 'bob.test' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const removed = await (await h.send('/api/server/sec/dns-providers/accounts/remove', 'POST', { accountId: view.accounts[0].id, expectedRevision: view.revision }))!.json()
    expect(removed).toMatchObject({ accounts: [], links: [] })
  })
  it('reports an unknown purge outcome when Cloudflare cannot be reached after sending', async () => {
    const h = harness(cloudflare({ [`/zones/${ZONE}/purge_cache`]: () => { throw new Error('reset') } }))
    let view = await (await h.send('/api/server/sec/dns-providers/accounts', 'POST', { label: 'Main', token: TOKEN, expectedRevision: providersRevision(null) }))!.json()
    view = await (await h.send('/api/server/sec/dns-providers/links', 'POST', { domain: 'alice.test', accountId: view.accounts[0].id, expectedRevision: view.revision }))!.json()
    await expect(h.send('/api/server/sec/dns-providers/purge', 'POST', { domain: 'alice.test' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
  })
})

describe('sec Cloudflare for account owners', () => {
  it('shows only owned domains and refuses unlinked or foreign domains', async () => {
    const admin = harness()
    let view = await (await admin.send('/api/server/sec/dns-providers/accounts', 'POST', { label: 'Main', token: TOKEN, expectedRevision: providersRevision(null) }))!.json()
    view = await (await admin.send('/api/server/sec/dns-providers/links', 'POST', { domain: 'alice.test', accountId: view.accounts[0].id, expectedRevision: view.revision }))!.json()
    const owner = harness(cloudflare(), OWNER)
    expect(await (await owner.send('/api/account/sec/cloudflare'))!.json()).toEqual({ domains: [{ domain: 'alice.test', linked: true, zoneId: ZONE }] })
    await expect(owner.send('/api/account/sec/cloudflare/zone?domain=bob.test')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await (await owner.send('/api/account/sec/cloudflare/purge', 'POST', { domain: 'alice.test' }))!.json()).toMatchObject({ outcome: 'accepted' })
    await expect(owner.send('/api/server/sec/dns-providers')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(JSON.stringify(await (await owner.send('/api/account/sec/cloudflare/zone?domain=alice.test'))!.json())).not.toContain(TOKEN)
  })
  it('compares records by name, type and normalized content', () => {
    expect(compareCloudflareRecords('a.test', [{ name: 'www', type: 'CNAME', content: 'A.test.', priority: null }, { name: '@', type: 'MX', content: 'mx.a.test.', priority: 10 }], [{ name: 'www.a.test', type: 'CNAME', content: 'a.test', proxied: false, priority: null }, { name: 'a.test', type: 'MX', content: 'mx.a.test', proxied: null, priority: 20 }, { name: 'x.a.test', type: 'NS', content: 'n', proxied: null, priority: null }]).map(row => row.state)).toEqual(['differs', 'match'])
  })
})
