import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { createExtendedApiRouter, ExtendedFeaturesStore } from './extended-routes.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

const caller = { principal: { id: 'root-fixture', kind: 'root', username: 'root' }, sessionId: 'root-session' } as AuthenticatedCaller
const account = { id: '00000000-0000-4000-8000-000000000001', username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', primaryDomain: 'alice.test' } as Account

const fixture = () => {
  vi.spyOn(ExtendedFeaturesStore.prototype, 'readOrDefault').mockImplementation(async <T>(_key: string, fallback: T): Promise<T> => fallback)
  const writes = vi.spyOn(ExtendedFeaturesStore.prototype, 'write').mockImplementation(async <T>(_key: string, value: T): Promise<T> => value)
  const emitAudit = vi.fn(async () => undefined)
  const requireCaller = vi.fn(async () => caller)
  const helpers = {
    store: { rootDir: '/unused-truthfulness-fixture' }, db: {}, requireCaller, emitAudit,
    assertRoot: vi.fn(async () => undefined), assertCanAccessAccount: vi.fn(async () => undefined), resolveAccountParam: vi.fn(async () => account),
  } as unknown as ExtendedRouteHelpers
  const router = createExtendedApiRouter(helpers)
  const request = (method: string, path: string, body?: unknown) => {
    const req = new Request('https://panel.example' + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    return router.handleExtendedRoute(req, new URL(req.url), method)
  }
  return { request, writes, emitAudit, requireCaller }
}

const rejectsWithoutWriting = (path: string) => async (_label: unknown, body: unknown) => {
  const host = fixture()
  await expect(host.request('PUT', path, body)).rejects.toMatchObject({ code: 'VALIDATION' })
  expect(host.writes).not.toHaveBeenCalled()
  expect(host.emitAudit).not.toHaveBeenCalled()
}

afterEach(() => { vi.restoreAllMocks() })

describe('extended routes never invent host data or success', { tags: ['unit'] }, () => {
  it.each([
    ['GET', '/api/analytics/legacy/alice.test'],
    ['GET', '/api/cluster/nodes'],
    ['POST', '/api/cluster/nodes'],
    ['DELETE', '/api/cluster/nodes/node-1'],
    ['GET', '/api/mail/delivery-reports'],
    ['POST', '/api/mail/delivery-reports'],
    ['GET', '/api/git/alice/repos'],
    ['POST', '/api/git/alice/repos'],
    ['POST', '/api/git/alice/repos/storefront/deploy'],
    ['DELETE', '/api/git/alice/repos/storefront'],
    ['GET', `/api/web-features/${account.id}/web-disk`],
    ['PUT', `/api/web-features/${account.id}/web-disk`],
    ['GET', '/api/mail/caldav-carddav'],
    ['PUT', '/api/mail/caldav-carddav'],
  ])('serves no fabricated %s %s', async (method, path) => {
    const host = fixture()
    expect(await host.request(method, path, method === 'GET' ? undefined : {})).toBeNull()
    expect(host.requireCaller).not.toHaveBeenCalled()
    expect(host.writes).not.toHaveBeenCalled()
  })

  it.each(['/api/databases/alice/maintenance', '/api/databases/repair'])('refuses %s with a stable code instead of a processed-table count', async path => {
    const host = fixture()
    await expect(host.request('POST', path, { accountId: account.id, engine: 'mariadb', database: 'alice_app', operation: 'repair' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED', detail: { reason: 'database_maintenance_unavailable', stateChanged: false, nativeApplied: false },
    })
    await expect(host.request('POST', path, { accountId: account.id, database: 'bob_app' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(host.emitAudit).not.toHaveBeenCalled()
    expect(host.writes).not.toHaveBeenCalled()
  })
})

describe('hotlink protection input reaches nginx and Apache lines only after strict validation', { tags: ['unit'] }, () => {
  const path = `/api/web-features/${account.id}/hotlink-protection`

  it('compiles canonical referrer domains, plain extensions and a checked redirect', async () => {
    const host = fixture()
    const response = await host.request('PUT', path, { enabled: true, allowedUrls: ['alice.test', 'CDN.alice.test'], protectedExtensions: ['jpg', 'png'], redirectUrl: 'https://alice.test/blocked.png' })
    const { config } = await response!.json() as { config: Record<string, unknown> & { compiledNginx: string } }
    expect(config.allowedUrls).toEqual(['alice.test', 'cdn.alice.test'])
    expect(config.compiledNginx).toContain('location ~* \\.(jpg|png)$ {')
    expect(config.compiledNginx).toContain('  valid_referers none blocked alice.test cdn.alice.test;')
    expect(config.compiledNginx).toContain('    return 302 https://alice.test/blocked.png;')
    expect(Object.keys(config).sort()).toEqual(['accountId', 'allowDirectRequests', 'allowedUrls', 'compiledApache', 'compiledNginx', 'enabled', 'protectedExtensions', 'redirectUrl', 'updatedAt'])
  })

  it.each([
    ['newline in a referrer domain', { allowedUrls: ['alice.test\nlocation / {'] }],
    ['quote in a referrer domain', { allowedUrls: ['alice.test"'] }],
    ['directive in a referrer domain', { allowedUrls: ['alice.test; return 200'] }],
    ['referrer list as a string', { allowedUrls: 'alice.test' }],
    ['too many referrer domains', { allowedUrls: Array.from({ length: 101 }, (_, i) => `d${i}.alice.test`) }],
    ['regex alternation in an extension', { protectedExtensions: ['jpg|.*'] }],
    ['location break in an extension', { protectedExtensions: ['jpg)$ {'] }],
    ['control character in an extension', { protectedExtensions: ['jp\u0007g'] }],
    ['enabled without extensions', { enabled: true, protectedExtensions: [] }],
    ['directive in the redirect', { redirectUrl: 'https://alice.test/x; return 200' }],
    ['newline in the redirect', { redirectUrl: 'https://alice.test/x\nlocation' }],
    ['non-http redirect', { redirectUrl: 'javascript:alert(1)' }],
    ['string flag', { enabled: 'true' }],
    ['numeric flag', { allowDirectRequests: 1 }],
    ['compiled text', { compiledNginx: 'location / {}' }],
  ])('rejects %s without writing', rejectsWithoutWriting(path))
})

describe('web extras input reaches nginx and Apache lines only after strict validation', { tags: ['unit'] }, () => {
  const path = `/api/web-features/${account.id}/extras`

  it('compiles validated error pages, networks and MIME types', async () => {
    const host = fixture()
    const response = await host.request('PUT', path, {
      errorPages: { '404': '/errors/404.html' }, deniedCidrs: ['198.51.100.0/24', '2001:db8::/32'], directoryIndexMode: 'fancy',
      mimeTypes: [{ extension: '.webmanifest', mimeType: 'application/manifest+json' }], redirects: [{ source: '/old', target: 'https://alice.test/new', code: 301, wildcard: false }],
    })
    const { config } = await response!.json() as { config: { compiledNginx: string; compiledApache: string } }
    expect(config.compiledNginx.split('\n')).toEqual(['error_page 404 /errors/404.html;', 'deny 198.51.100.0/24;', 'deny 2001:db8::/32;', 'autoindex on;'])
    expect(config.compiledApache.split('\n')).toEqual(['Options +Indexes', 'ErrorDocument 404 /errors/404.html', 'AddType application/manifest+json .webmanifest'])
  })

  it.each([
    ['non-error status code', { errorPages: { '200': '/ok.html' } }],
    ['non-numeric status code', { errorPages: { abc: '/x.html' } }],
    ['error pages as a list', { errorPages: ['/404.html'] }],
    ['newline in an error page', { errorPages: { '404': '/404.html;\nlocation / {' } }],
    ['traversal in an error page', { errorPages: { '404': '/../etc/passwd' } }],
    ['relative error page', { errorPages: { '404': 'errors/404.html' } }],
    ['quote in an error page', { errorPages: { '404': '/a"b.html' } }],
    ['keyword network', { deniedCidrs: ['all'] }],
    ['network with host bits', { deniedCidrs: ['198.51.100.1/24'] }],
    ['directive after a network', { deniedCidrs: ['198.51.100.0/24; allow all'] }],
    ['directive in a MIME extension', { mimeTypes: [{ extension: 'php;', mimeType: 'text/html' }] }],
    ['newline in a MIME type', { mimeTypes: [{ extension: 'html', mimeType: 'text/html\nAddHandler cgi-script .html' }] }],
    ['extra MIME field', { mimeTypes: [{ extension: 'html', mimeType: 'text/html', handler: 'cgi-script' }] }],
    ['spaced redirect target', { redirects: [{ source: '/old', target: 'https://alice.test/ new', code: 301, wildcard: false }] }],
    ['unsupported redirect code', { redirects: [{ source: '/old', target: 'https://alice.test/new', code: 307, wildcard: false }] }],
    ['traversal in a redirect source', { redirects: [{ source: '/../old', target: 'https://alice.test/new', code: 301, wildcard: false }] }],
    ['unknown index mode', { directoryIndexMode: 'on' }],
    ['compiled text', { compiledApache: 'Options +ExecCGI' }],
  ])('rejects %s without writing', rejectsWithoutWriting(path))
})

describe('remote database hosts reach pg_hba lines and GRANT statements only as canonical addresses', { tags: ['unit'] }, () => {
  const path = `/api/databases/${account.id}/remote-hosts`

  it('compiles IPv4, IPv6 and network entries per engine', async () => {
    const host = fixture()
    const response = await host.request('PUT', path, { hosts: [
      { address: '198.51.100.25', engine: 'both', comment: 'BI worker' }, { address: '2001:db8::1', engine: 'postgresql' }, { address: '203.0.113.0/24', engine: 'mariadb' },
    ] })
    const { config } = await response!.json() as { config: { compiledPgHba: string; compiledMariaDbGrants: string } }
    expect(config.compiledPgHba.split('\n')).toEqual(['host all +alice 198.51.100.25/32 scram-sha-256', 'host all +alice 2001:db8::1/128 scram-sha-256'])
    expect(config.compiledMariaDbGrants.split('\n')).toEqual(["GRANT USAGE ON `alice_%`.* TO 'alice'@'198.51.100.25';", "GRANT USAGE ON `alice_%`.* TO 'alice'@'203.0.113.0/24';"])
  })

  it.each([
    ['quote and statement in an address', { hosts: [{ address: "198.51.100.25'; DROP USER 'alice'; --" }] }],
    ['hostname address', { hosts: [{ address: 'db.example.com' }] }],
    ['wildcard address', { hosts: [{ address: '%' }] }],
    ['newline in an address', { hosts: [{ address: '198.51.100.25\nhost all all 0.0.0.0/0 trust' }] }],
    ['padded address', { hosts: [{ address: ' 198.51.100.25' }] }],
    ['network with host bits', { hosts: [{ address: '198.51.100.25/24' }] }],
    ['unknown engine', { hosts: [{ address: '198.51.100.25', engine: 'oracle' }] }],
    ['control character in a comment', { hosts: [{ address: '198.51.100.25', comment: 'note\u0000' }] }],
    ['extra host field', { hosts: [{ address: '198.51.100.25', grant: 'ALL PRIVILEGES' }] }],
    ['hosts as an object', { hosts: { address: '198.51.100.25' } }],
    ['compiled text', { compiledPgHba: 'host all all 0.0.0.0/0 trust' }],
  ])('rejects %s without writing', rejectsWithoutWriting(path))
})
