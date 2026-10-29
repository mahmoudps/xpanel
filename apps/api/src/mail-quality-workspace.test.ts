import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { services as render } from '@xpanel/render'
import type { AuthenticatedCaller } from './auth.ts'
import { MAIL_QUALITY_MAX_CHECK, handleMailQualityWorkspaceRoute, hostedMailDomains, mailQualityTarget, parseSpf, runMailQualityChecks } from './mail-quality-workspace.ts'
import type { MailQualityResolver, MailQualitySaved, MailQualityWorkspaceHelpers } from './mail-quality-workspace.ts'

const root = { principal: { kind: 'root', id: 'root-1', username: 'root' } } as AuthenticatedCaller
const pem = () => generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).publicKey
const signing = pem(), other = pem()
const dkimTxt = (key: string) => render.dkimDnsRecord('example.test', 'xp202610', key).content
const chunks = (text: string) => text.match(/.{1,255}/g)!
const saved = (overrides: Partial<MailQualitySaved> = {}) => ({
  server: { settings: { hostname: 'Host.Example.test' } },
  ipPool: [{ address: '192.0.2.10', version: 4, isPrimary: true }, { address: '2001:db8::10', version: 6, isPrimary: true }],
  mailIpConfig: null,
  accounts: [{ id: 'a1', username: 'alice', status: 'active', ipv4: '192.0.2.10' }],
  domains: [{ id: 'd1', accountId: 'a1', name: 'example.test' }, { id: 'd2', accountId: 'a1', name: 'nomail.test' }, { id: 'd3', accountId: 'a1', name: 'shop.example.test' }],
  serviceUsers: [{ domainId: 'd1', services: { email: true } }, { domainId: 'd3', services: { email: true } }],
  zones: [{ name: 'example.test', records: [{ name: '@', type: 'MX', priority: 10, content: 'mail.example.test.' }, { name: 'xp202610._domainkey', type: 'TXT', priority: null, content: dkimTxt(signing) },
    { name: 'shop', type: 'MX', priority: 10, content: 'mail.example.test' }]}],
  ...overrides,
}) as unknown as MailQualitySaved
const healthy = (): Record<string, unknown> => ({
  'MX example.test': [{ exchange: 'mail.example.test', priority: 10 }],
  'A mail.example.test': ['192.0.2.10'],
  'TXT example.test': [['v=spf1 a mx ', 'ip4:192.0.2.10 ip6:2001:db8::/64 ~all'], ['google-site-verification=abc']],
  'A example.test': ['192.0.2.10'],
  'TXT xp202610._domainkey.example.test': [chunks(dkimTxt(signing))],
  'TXT _dmarc.example.test': [['v=DMARC1; p=quarantine; rua=mailto:postmaster@example.test']],
  'PTR 192.0.2.10': ['host.example.test'], 'A host.example.test': ['192.0.2.10'],
  'PTR 2001:db8::10': ['host.example.test'], 'AAAA host.example.test': ['2001:db8::10'],
})
const code = (value: string) => Object.assign(new Error('query ' + value), { code: value })
const resolver = (table: Record<string, unknown>, calls: string[] = []): MailQualityResolver => {
  const answer = (key: string): Promise<unknown> => {
    calls.push(key)
    const value = table[key]
    return value === undefined ? Promise.reject(code('ENODATA')) : value instanceof Error ? Promise.reject(value) : value === 'hang' ? new Promise(() => {}) : Promise.resolve(value)
  }
  return { resolveMx: name => answer('MX ' + name), resolveTxt: name => answer('TXT ' + name), resolve4: name => answer('A ' + name), resolve6: name => answer('AAAA ' + name), reverse: address => answer('PTR ' + address) }
}
const run = async (table: Record<string, unknown>, options: { state?: MailQualitySaved; material?: boolean | string; domain?: string; lookupMs?: number; totalMs?: number } = {}) => {
  const state = options.state ?? saved(), row = hostedMailDomains(state).rows.find(item => item.domain === (options.domain ?? 'example.test'))!
  const key = options.material === undefined || options.material === true ? signing : options.material || null
  const { results } = await runMailQualityChecks({ targets: [mailQualityTarget(state, row)], resolver: resolver(table), ...(key ? { material: async () => ({ selector: 'xp202610', publicKeyPem: key }) } : {}), lookupMs: options.lookupMs ?? 1000, totalMs: options.totalMs ?? 5000 })
  return results[0]!
}
const states = (result: Awaited<ReturnType<typeof run>>) => ({ mx: result.mx.cause, spf: result.spf.cause, dkim: result.dkim.cause, dmarc: result.dmarc.cause, ptr: result.ptr.cause })

describe('mail quality checks', () => {
  it('uses the reconciler mail-domain rule and reports every check ok against live DNS', async () => {
    expect(hostedMailDomains(saved()).rows.map(row => row.domain)).toEqual(['example.test', 'shop.example.test'])
    const result = await run(healthy())
    expect(states(result)).toEqual({ mx: 'ok', spf: 'ok', dkim: 'ok', dmarc: 'ok', ptr: 'ok' })
    expect(result.mx).toEqual({ state: 'ok', cause: 'ok', fix: null, detail: { published: [{ priority: 10, host: 'mail.example.test' }], saved: [{ priority: 10, host: 'mail.example.test' }], hostname: 'host.example.test', pointsHere: true } })
    expect(result.spf.detail).toEqual({ record: 'v=spf1 a mx ip4:192.0.2.10 ip6:2001:db8::/64 ~all', records: 1, addresses: [{ address: '192.0.2.10', result: 'pass' }, { address: '2001:db8::10', result: 'pass' }] })
    expect(result.dkim.detail).toEqual({ selector: 'xp202610', source: 'signing-key', records: 1 })
    expect(result.dmarc.detail.policy).toBe('quarantine')
    expect(result.ptr.detail).toEqual({ expected: 'host.example.test', addresses: [{ address: '192.0.2.10', names: ['host.example.test'], confirmed: ['host.example.test'] }, { address: '2001:db8::10', names: ['host.example.test'], confirmed: ['host.example.test'] }] })
  })
  it('reports MX problems with the zone editor link and lookup failures as unavailable', async () => {
    expect((await run({ ...healthy(), 'MX example.test': undefined })).mx).toMatchObject({ state: 'problem', cause: 'mx_missing', fix: '/whm/dns' })
    expect((await run({ ...healthy(), 'MX example.test': [{ exchange: '', priority: 0 }] })).mx.cause).toBe('mx_null')
    expect((await run({ ...healthy(), 'MX example.test': [{ exchange: 'mx.elsewhere.test', priority: 10 }] })).mx).toMatchObject({ state: 'problem', cause: 'mx_differs_saved', detail: { published: [{ host: 'mx.elsewhere.test' }] } })
    const elsewhere = saved({ zones: [{ name: 'example.test', records: [{ name: '@', type: 'MX', priority: 10, content: 'mx.elsewhere.test' }] }] } as Partial<MailQualitySaved>)
    const table = { ...healthy(), 'MX example.test': [{ exchange: 'mx.elsewhere.test', priority: 10 }], 'A mx.elsewhere.test': ['198.51.100.7'] }
    expect((await run(table, { state: elsewhere })).mx).toMatchObject({ state: 'problem', cause: 'mx_not_this_server', detail: { pointsHere: false } })
    expect((await run({ ...table, 'A mx.elsewhere.test': code('ESERVFAIL') }, { state: elsewhere })).mx).toMatchObject({ state: 'unavailable', cause: 'mx_target_unverified', fix: null, detail: { pointsHere: null } })
    expect((await run({ ...table, 'AAAA mx.elsewhere.test': ['2001:db8::10'] }, { state: elsewhere })).mx.cause).toBe('ok')
    expect((await run({ ...healthy(), 'MX example.test': code('ESERVFAIL') })).mx).toMatchObject({ state: 'unavailable', cause: 'lookup_failed', fix: null })
  })
  it('parses SPF strictly and evaluates the server addresses', async () => {
    expect(parseSpf('v=spf1 ip4:192.0.2.0/24 -all')).toHaveLength(2)
    for (const bad of ['v=spf1 ip4:999.1.1.1 -all', 'v=spf1 ip6:192.0.2.1 -all', 'v=spf1 include -all', 'v=spf1 a/33 -all', 'v=spf1 frobnicate -all', 'v=spf1 redirect=a.test redirect=b.test']) expect(parseSpf(bad)).toBeNull()
    expect(parseSpf('v=spf1 exp=explain.example.test ?all')).toHaveLength(1)
    const spf = async (...records: string[][]) => (await run({ ...healthy(), 'TXT example.test': records })).spf
    expect(await spf(['v=spf1 -all'], ['v=spf1 ~all'])).toMatchObject({ state: 'problem', cause: 'spf_multiple', fix: '/whm/dns', detail: { records: 2 } })
    expect(await spf(['google-site-verification=abc'])).toMatchObject({ state: 'problem', cause: 'spf_missing' })
    expect(await spf(['v=spf1 ip4:999.1.1.1 -all'])).toMatchObject({ state: 'problem', cause: 'spf_invalid' })
    expect(await spf(['v=spf1 ip4:198.51.100.0/24 -all'])).toMatchObject({ state: 'problem', cause: 'spf_not_authorized', detail: { addresses: [{ address: '192.0.2.10', result: 'fail' }, { address: '2001:db8::10', result: 'fail' }] } })
    expect(await spf(['v=spf1 ' + Array.from({ length: 11 }, (_, index) => `a:h${index}.example.test`).join(' ') + ' -all'])).toMatchObject({ cause: 'spf_too_many_lookups' })
    expect(await spf(['v=spf1 exists:%{i}.rbl.example.test -all'])).toMatchObject({ state: 'unavailable', cause: 'spf_not_decidable', fix: null })
    expect(await spf(['v=spf1 ptr -all'])).toMatchObject({ cause: 'spf_not_decidable' })
  })
  it('follows include and redirect one level only', async () => {
    const table = { ...healthy(), 'TXT example.test': [['v=spf1 include:_spf.example.net -all']], 'TXT _spf.example.net': [['v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all']] }
    expect((await run(table)).spf).toMatchObject({ state: 'ok', detail: { addresses: [{ result: 'pass' }, { result: 'pass' }] } })
    expect((await run({ ...table, 'TXT _spf.example.net': [['v=spf1 include:_deeper.example.net -all']] })).spf).toMatchObject({ state: 'unavailable', cause: 'spf_not_decidable' })
    expect((await run({ ...table, 'TXT _spf.example.net': undefined })).spf).toMatchObject({ state: 'problem', cause: 'spf_not_authorized', detail: { addresses: [{ result: 'permerror' }, { result: 'permerror' }] } })
    expect((await run({ ...table, 'TXT _spf.example.net': code('ETIMEOUT') })).spf).toMatchObject({ state: 'unavailable', cause: 'lookup_failed' })
    expect((await run({ ...table, 'TXT example.test': [['v=spf1 redirect=_spf.example.net']] })).spf.state).toBe('ok')
  })
  it('compares the published DKIM key exactly with the signing key', async () => {
    expect((await run({ ...healthy(), 'TXT xp202610._domainkey.example.test': [chunks(dkimTxt(other))] })).dkim).toMatchObject({ state: 'problem', cause: 'dkim_mismatch', fix: '/whm/dns' })
    expect((await run({ ...healthy(), 'TXT xp202610._domainkey.example.test': undefined })).dkim.cause).toBe('dkim_missing')
    expect((await run({ ...healthy(), 'TXT xp202610._domainkey.example.test': [['v=DKIM1; k=rsa; p=']] })).dkim.cause).toBe('dkim_revoked')
    expect((await run({ ...healthy(), 'TXT xp202610._domainkey.example.test': [['v=DKIM1; p=a; p=b']] })).dkim.cause).toBe('dkim_invalid')
    expect((await run({ ...healthy(), 'TXT xp202610._domainkey.example.test': [chunks(dkimTxt(signing)), ['v=DKIM1; p=abc']] })).dkim.cause).toBe('dkim_multiple')
    // Folding whitespace inside p= is not a mismatch (RFC 6376 3.6.1).
    expect((await run({ ...healthy(), 'TXT xp202610._domainkey.example.test': [chunks(dkimTxt(signing).replace(/(p=.{40})/, '$1 '))] })).dkim.cause).toBe('ok')
    expect((await run(healthy(), { material: false })).dkim).toMatchObject({ state: 'ok', detail: { source: 'saved-zone', selector: 'xp202610' } })
    expect((await run(healthy(), { material: other })).dkim.cause).toBe('dkim_mismatch')
    const noKey = saved({ zones: [] })
    expect((await run(healthy(), { state: noKey, material: false })).dkim).toMatchObject({ state: 'unavailable', cause: 'dkim_key_unknown', fix: '/whm/email/server', detail: { selector: null, source: null } })
  })
  it('parses DMARC (RFC 7489 6.4) and reports its policy', async () => {
    const dmarc = async (...records: string[][]) => (await run({ ...healthy(), 'TXT _dmarc.example.test': records })).dmarc
    expect(await dmarc(['v=DMARC1;p=reject;pct=100'])).toMatchObject({ state: 'ok', detail: { policy: 'reject' } })
    expect(await dmarc(['v=DMARC1; p=maybe'])).toMatchObject({ state: 'problem', cause: 'dmarc_invalid', fix: '/whm/dns' })
    expect(await dmarc(['v=DMARC1; rua=mailto:x@example.test'])).toMatchObject({ cause: 'dmarc_invalid' })
    expect(await dmarc(['v=DMARC1; p=none; pct=150'])).toMatchObject({ cause: 'dmarc_invalid' })
    expect(await dmarc(['v=DMARC1; p=none'], ['v=DMARC1; p=reject'])).toMatchObject({ cause: 'dmarc_multiple' })
    expect(await dmarc(['p=reject'])).toMatchObject({ cause: 'dmarc_missing' })
    expect((await run({ ...healthy(), 'TXT _dmarc.example.test': code('ENOTFOUND') })).dmarc.cause).toBe('dmarc_missing')
  })
  it('requires forward-confirmed reverse DNS naming the HELO host', async () => {
    expect((await run({ ...healthy(), 'A host.example.test': ['192.0.2.99'] })).ptr).toMatchObject({ state: 'problem', cause: 'ptr_not_confirmed', fix: '/whm/email/server', detail: { addresses: [{ address: '192.0.2.10', names: ['host.example.test'], confirmed: [] }, { confirmed: ['host.example.test'] }] } })
    expect((await run({ ...healthy(), 'PTR 192.0.2.10': ['static.provider.example.net'], 'A static.provider.example.net': ['192.0.2.10'] })).ptr.cause).toBe('ptr_hostname_mismatch')
    expect((await run({ ...healthy(), 'PTR 2001:db8::10': code('ENOTFOUND') })).ptr.cause).toBe('ptr_missing')
    expect((await run({ ...healthy(), 'PTR 192.0.2.10': code('ESERVFAIL') })).ptr).toMatchObject({ state: 'unavailable', cause: 'lookup_failed' })
    const lan = saved({ ipPool: [{ address: '10.0.0.5', version: 4, isPrimary: true }] } as Partial<MailQualitySaved>)
    const result = await run(healthy(), { state: lan })
    expect(result.ptr).toMatchObject({ state: 'unavailable', cause: 'address_not_public' }); expect(result.spf.cause).toBe('address_not_public')
    expect((await run(healthy(), { state: saved({ server: null, ipPool: [] }) })).ptr.cause).toBe('hostname_unknown')
    expect((await run(healthy(), { state: saved({ ipPool: [] }) })).ptr.cause).toBe('no_server_address')
    const helo = saved({ mailIpConfig: { mode: 'custom-map', defaultIpv4: null, defaultIpv6: null, defaultHelo: null, domainOverrides: [{ domainName: 'example.test', ipv4: '198.51.100.20', ipv6: null, heloHostname: 'out.example.test' }] } } as Partial<MailQualitySaved>)
    const mapped = await run({ ...healthy(), 'PTR 198.51.100.20': ['out.example.test'], 'A out.example.test': ['198.51.100.20'], 'TXT example.test': [['v=spf1 ip4:198.51.100.20 ip6:2001:db8::/64 -all']] }, { state: helo })
    // The override keeps the default IPv6 address, whose PTR names the server hostname rather than the mapped HELO name.
    expect(mapped.ptr).toMatchObject({ state: 'problem', cause: 'ptr_hostname_mismatch', detail: { expected: 'out.example.test', addresses: [{ address: '198.51.100.20', confirmed: ['out.example.test'] }, { address: '2001:db8::10', confirmed: ['host.example.test'] }] } })
    expect(mapped.spf.state).toBe('ok')
  })
  it('treats malformed and oversized resolver answers as unavailable, never as data', async () => {
    const result = await run({ ...healthy(), 'MX example.test': [{ exchange: 42, priority: 10 }], 'TXT example.test': 'v=spf1 -all', 'TXT _dmarc.example.test': [['x'.repeat(300)]], 'PTR 192.0.2.10': Array(17).fill('host.example.test') })
    expect(states(result)).toMatchObject({ mx: 'lookup_failed', spf: 'lookup_failed', dmarc: 'lookup_failed', ptr: 'lookup_failed' })
    expect(result.mx.state).toBe('unavailable')
  })
  it('bounds every lookup and the whole run by timeouts', async () => {
    const hang = Object.fromEntries(Object.keys(healthy()).map(key => [key, 'hang']))
    const started = Date.now(), result = await run(hang, { lookupMs: 20, totalMs: 1000 })
    expect(Date.now() - started).toBeLessThan(900)
    expect(states(result)).toEqual({ mx: 'lookup_timeout', spf: 'lookup_timeout', dkim: 'lookup_timeout', dmarc: 'lookup_timeout', ptr: 'lookup_timeout' })
    const state = saved(), rows = hostedMailDomains(state).rows
    const { results, timedOut } = await runMailQualityChecks({ targets: Array.from({ length: 12 }, () => mailQualityTarget(state, rows[0]!)), resolver: resolver(hang), lookupMs: 1000, totalMs: 50 })
    expect(timedOut).toBe(true)
    expect(results).toHaveLength(12)
    expect(results.every(item => item.mx.cause === 'lookup_timeout')).toBe(true)
  })
  it('runs at most five domains at a time and memoizes shared lookups', async () => {
    let active = 0, peak = 0
    const calls: string[] = [], base = resolver(healthy(), calls)
    const slow = Object.fromEntries(Object.entries(base).map(([name, call]) => [name, async (value: string) => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); try { return await call(value) } finally { active-- } }])) as unknown as MailQualityResolver
    const domains = Array.from({ length: 12 }, (_, index) => ({ id: 'x' + index, accountId: 'a1', name: `d${index}.test` }))
    const state = saved({ domains, serviceUsers: domains.map(domain => ({ domainId: domain.id, services: { email: true } })), zones: [] } as unknown as Partial<MailQualitySaved>)
    const targets = hostedMailDomains(state).rows.map(row => mailQualityTarget(state, row))
    let domainsActive = 0, domainPeak = 0
    const { results } = await runMailQualityChecks({ targets, resolver: slow, material: async () => { domainsActive++; domainPeak = Math.max(domainPeak, domainsActive); await new Promise(resolve => setTimeout(resolve, 10)); domainsActive--; return null } })
    expect(results.map(item => item.domain)).toEqual(targets.map(item => item.domain))
    expect(domainPeak).toBe(5)
    expect(calls.filter(call => call === 'PTR 192.0.2.10')).toHaveLength(1)
  })
})

describe('API mail quality workspace', () => {
  const call = (path: string, helpers: MailQualityWorkspaceHelpers, method = 'GET', body?: unknown, type = 'application/json') => {
    const req = new Request('http://localhost' + path, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': type } }) })
    return handleMailQualityWorkspaceRoute(req, new URL(req.url), method, helpers)
  }
  const helpers = (overrides: Partial<MailQualityWorkspaceHelpers> = {}) => {
    const events: string[] = [], calls: string[] = []
    const value: MailQualityWorkspaceHelpers = { requireCaller: vi.fn(async () => { events.push('auth'); return root }), assertRoot: vi.fn(async (_caller, action: string) => { events.push('root:' + action) }),
      readSaved: vi.fn(async () => { events.push('saved'); return saved() }), readDkimPublicMaterial: vi.fn(async (_caller, domain: string) => { events.push('dkim:' + domain); return { selector: 'xp202610', publicKeyPem: signing } }), resolver: resolver(healthy(), calls), ...overrides }
    return { value, events, calls }
  }
  it('leaves unrelated routes untouched', async () => {
    const { value } = helpers()
    for (const path of ['/api/server/mail-quality/x', '/api/server/mail-server/server']) expect(await call(path, value)).toBeNull()
    expect(value.requireCaller).not.toHaveBeenCalled()
  })
  it('returns 403 for non-root and 400 for selectors and bad bodies before any lookup', async () => {
    const denied = helpers({ assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN', status: 403 }) } })
    await expect(call('/api/server/mail-quality', denied.value)).rejects.toMatchObject({ status: 403 })
    await expect(call('/api/server/mail-quality/check', denied.value, 'POST', { domains: ['example.test'] })).rejects.toMatchObject({ status: 403 })
    const { value, calls } = helpers()
    expect((await call('/api/server/mail-quality', value, 'POST'))!.headers.get('allow')).toBe('GET')
    expect((await call('/api/server/mail-quality/check', value, 'GET'))!.status).toBe(405)
    await expect(call('/api/server/mail-quality?domain=example.test', value)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    for (const body of [{ domains: ['example.test'], resolver: '8.8.8.8' }, { domains: [] }, { domains: ['Example.test'] }, { domains: ['example.test', 'example.test'] }, { domains: Array.from({ length: MAIL_QUALITY_MAX_CHECK + 1 }, (_, index) => `d${index}.test`) }, [], 'not json'])
      await expect(call('/api/server/mail-quality/check', value, 'POST', body)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/api/server/mail-quality/check', value, 'POST', { domains: ['example.test'] }, 'text/plain')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/api/server/mail-quality/check', value, 'POST', { domains: ['nomail.test'] })).rejects.toMatchObject({ code: 'VALIDATION', detail: { domain: 'nomail.test' } })
    expect(calls).toEqual([]); expect(denied.value.readSaved).not.toHaveBeenCalled()
  })
  it('lists hosted mail domains and the server identity without DNS lookups', async () => {
    const { value, events, calls } = helpers()
    const response = (await call('/api/server/mail-quality', value))!
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ hostname: 'host.example.test', helo: 'host.example.test', addresses: [{ address: '192.0.2.10', version: 4, public: true }, { address: '2001:db8::10', version: 6, public: true }],
      domains: [{ domain: 'example.test', account: 'alice', mailboxes: 1, zone: 'example.test' }, { domain: 'shop.example.test', account: 'alice', mailboxes: 1, zone: 'example.test' }], truncated: false, maxCheck: 50 })
    expect(events).toEqual(['auth', 'root:server.mail-quality.read', 'saved', 'auth', 'root:server.mail-quality.read'])
    expect(calls).toEqual([])
  })
  it('checks the selected domains and re-checks root before answering', async () => {
    const { value, events } = helpers()
    const body = await (await call('/api/server/mail-quality/check', value, 'POST', { domains: ['example.test'] }))!.json()
    expect(body).toMatchObject({ timedOut: false, results: [{ domain: 'example.test', mx: { state: 'ok' }, spf: { state: 'ok' }, dkim: { state: 'ok', detail: { source: 'signing-key' } }, dmarc: { state: 'ok' }, ptr: { state: 'ok' } }] })
    expect(body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(events).toEqual(['auth', 'root:server.mail-quality.read', 'saved', 'dkim:example.test', 'auth', 'root:server.mail-quality.read'])
    let count = 0
    const changed = helpers({ requireCaller: vi.fn(async () => (count++ ? { principal: { ...root.principal, id: 'root-2' } } : root) as AuthenticatedCaller) })
    await expect(call('/api/server/mail-quality/check', changed.value, 'POST', { domains: ['example.test'] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
