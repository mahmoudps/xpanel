import { describe, expect, it, vi } from 'vitest'
import type { Account, Certificate, Domain } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { SITE_HEALTH_MAX_DOMAINS, handleSiteHealthRoute } from './site-health-workspace.ts'
import type { SiteHealthDns } from './site-health-workspace.ts'
import type { HtaccessTarget } from '../../agent/src/htaccess-workspace.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111', id = (n: number) => '2222222' + n + '-2222-4222-8222-222222222222'
const account = { id: ACCOUNT, username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', planId: 'plan', ipv4: '192.0.2.10', ipv6: null } as unknown as Account
const domain = (n: number, name: string, over: Partial<Domain> = {}): Domain => ({ id: id(n), accountId: ACCOUNT, name, kind: 'addon', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3' } as Domain['php'], wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ...over })
const now = new Date('2026-10-27T00:00:00.000Z'), days = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString()
const cert = (n: number, names: string[], notAfter: string): Certificate => ({ id: '3333333' + n + '-3333-4333-8333-333333333333', accountId: ACCOUNT, names, source: 'acme', challenge: 'http-01', notAfter, autoRenew: true })
const owner = { principal: { kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT }, apiTokenId: null, scopes: [], principalRecord: { forcePasswordChange: false } } as unknown as AuthenticatedCaller
const coded = (code: string) => Object.assign(new Error(code), { code })
const records: Record<string, { a: string[] | Error; aaaa: string[] | Error }> = {
  'example.test': { a: ['192.0.2.10'], aaaa: coded('ENODATA') }, 'example.org': { a: ['198.51.100.7'], aaaa: coded('ENODATA') }, 'blog.example.test': { a: ['192.0.2.10'], aaaa: ['2001:DB8::1'] },
  'shop.test': { a: coded('ESERVFAIL'), aaaa: coded('ENODATA') }, 'old.test': { a: coded('ENOTFOUND'), aaaa: coded('ENOTFOUND') }, 'v6.test': { a: ['192.0.2.10'], aaaa: ['2001:db8:0:0::5'] },
}
const lookup = (kind: 'a' | 'aaaa') => async (name: string): Promise<string[]> => { const value = records[name]?.[kind] ?? coded('ENODATA'); if (value instanceof Error) throw value; return value }

function setup(options: { domains?: Domain[]; engine?: string; disabled?: string[]; callers?: AuthenticatedCaller[] } = {}) {
  const main = domain(1, 'example.test', { kind: 'primary' })
  const domains = options.domains ?? [main, domain(2, 'example.org', { kind: 'alias', parentId: id(1) }), domain(3, 'blog.example.test', { kind: 'subdomain', parentId: id(1), certificateId: '33333333-3333-4333-8333-333333333333', php: { version: '5.6' } as Domain['php'] }),
    domain(4, 'shop.test', { siteType: 'static' }), domain(5, 'old.test', { redirect: { to: 'https://example.test/', code: 301 } }), domain(6, 'v6.test', { ipv6: '2001:db8::5', siteType: 'proxy' })]
  const certificates = [cert(1, ['example.test', '*.example.test'], days(60)), cert(2, ['example.org'], days(-1)), cert(3, ['blog.example.test'], days(5))]
  const probe = vi.fn(async (target: HtaccessTarget) => { if (target.domainName === 'shop.test') throw new Error('ECONNREFUSED'); return target.domainName === 'blog.example.test' ? 500 : 200 })
  const dns: SiteHealthDns = { resolve4: vi.fn(lookup('a')), resolve6: vi.fn(lookup('aaaa')) }
  const store = { getAccount: async (value: string) => value === ACCOUNT ? account : null, listDomains: async () => domains, getServerSettings: async () => ({ engine: options.engine ?? 'apache', backendPort: 8080 }), listCertificates: async () => certificates,
    getPlan: async () => ({ featureListId: 'list' }), getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: options.disabled ?? [] }) } as unknown as StateStore
  const callers = [...(options.callers ?? [])]
  const ports = { store, requireCaller: async () => callers.length ? callers.shift()! : owner, dns, probe, now: () => now }
  const route = async (method = 'GET', search = '') => { const url = new URL('http://panel.test/api/account/site-health' + search); return handleSiteHealthRoute(new Request(url, { method }), url, method, ports) }
  return { route, probe, dns }
}
const byName = (body: { domains: { name: string; checks: { id: string; state: string; cause: string; fix: string; detail: Record<string, unknown> }[] }[] }) => Object.fromEntries(body.domains.map(item => [item.name, Object.fromEntries(item.checks.map(check => [check.id, check.state + ':' + check.cause]))]))

describe('account site health', () => {
  it('reports DNS, local HTTP, saved certificate and PHP findings per owned domain with fix links', async () => {
    const t = setup(), body = await (await t.route())!.json() as Record<string, any>
    expect(byName(body as never)).toEqual({
      'example.test': { dns: 'ok:matches', http: 'ok:reachable', certificate: 'ok:valid', php: 'ok:supported' },
      'example.org': { dns: 'problem:points_elsewhere', http: 'ok:reachable', certificate: 'problem:expired', php: 'ok:supported' },
      'blog.example.test': { dns: 'problem:ipv6_unexpected', http: 'problem:server_error', certificate: 'problem:expiring', php: 'problem:unsupported' },
      'shop.test': { dns: 'unavailable:lookup_failed', http: 'unavailable:probe_failed', certificate: 'problem:missing', php: 'ok:not_php' },
      'old.test': { dns: 'problem:name_not_found', http: 'unavailable:redirect_site', certificate: 'problem:missing', php: 'ok:supported' },
      'v6.test': { dns: 'ok:matches', http: 'unavailable:inactive_site', certificate: 'problem:missing', php: 'ok:not_php' },
    })
    expect(body.domains[0].name).toBe('example.test'); expect(body).toMatchObject({ total: 6, truncated: false, checkedAt: now.toISOString(), scope: { http: 'local-backend', certificate: 'saved-store' } })
    const alias = body.domains.find((item: { name: string }) => item.name === 'example.org')
    expect(alias.checks.map((check: { fix: string }) => check.fix)).toEqual(['/domains/zone-editor', '/metrics/logs', '/security/ssl', '/software/php'])
    expect(alias.checks[0].detail).toEqual({ expected: { ipv4: '192.0.2.10', ipv6: null }, found: { ipv4: ['198.51.100.7'], ipv6: [] } })
    expect(t.probe.mock.calls.map(call => [call[0].domainName, call[0].backendPort, call[0].docRoot])).toContainEqual(['example.org', 8080, '/home/alice/public_html'])
    expect(t.probe.mock.calls.map(call => call[0].domainName)).not.toContain('old.test')
  })
  it('keeps HTTP unavailable off Apache, bounds the domain count and probes nothing it cannot attribute', async () => {
    const nginx = await (await setup({ engine: 'openlitespeed' }).route())!.json() as Record<string, any>
    expect(nginx.domains[0].checks[1]).toMatchObject({ state: 'unavailable', cause: 'engine' })
    const many = Array.from({ length: SITE_HEALTH_MAX_DOMAINS + 3 }, (_, index) => domain(1, 'site' + index + '.test', { id: index.toString(16).padStart(8, '0') + '-2222-4222-8222-222222222222' }))
    const bounded = setup({ domains: many }), body = await (await bounded.route())!.json() as Record<string, any>
    expect(body).toMatchObject({ total: SITE_HEALTH_MAX_DOMAINS + 3, truncated: true }); expect(body.domains).toHaveLength(SITE_HEALTH_MAX_DOMAINS); expect(bounded.dns.resolve4).toHaveBeenCalledTimes(SITE_HEALTH_MAX_DOMAINS)
  })
  it('serves the account owner only and withholds findings when authority changes during the checks', async () => {
    for (const kind of ['root', 'reseller'] as const) { const t = setup({ callers: [{ ...owner, principal: { kind, id: kind, username: kind } } as unknown as AuthenticatedCaller] }); await expect(t.route()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(t.probe).not.toHaveBeenCalled() }
    await expect(setup({ disabled: ['account-health-overview'] }).route()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const changed = setup({ callers: [owner, { ...owner, principal: { kind: 'user', id: 'p-new', username: 'alice', accountId: ACCOUNT } } as unknown as AuthenticatedCaller] })
    await expect(changed.route()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setup().route('GET', '?domain=x')).rejects.toMatchObject({ code: 'VALIDATION' }); expect((await setup().route('POST'))!.status).toBe(405)
  })
})
