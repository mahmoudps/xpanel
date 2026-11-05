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

describe('web disk input reaches the WebDAV alias line only after strict validation', { tags: ['unit'] }, () => {
  const path = `/api/web-features/${account.id}/web-disk`

  it('compiles a validated relative root and a read-only method set', async () => {
    const host = fixture()
    const response = await host.request('PUT', path, { enabled: true, rootPath: 'public_html/dav', readOnly: true })
    const { config } = await response!.json() as { config: { compiledConfig: string; rootPath: string } }
    expect(config.rootPath).toBe('public_html/dav')
    expect(config.compiledConfig).toContain('  alias /home/alice/public_html/dav/;')
    expect(config.compiledConfig).toContain('  dav_methods off;')
    expect(host.writes).toHaveBeenCalledOnce()
  })

  it.each([
    ['newline', { rootPath: 'public_html;\n}\nlocation / {' }],
    ['carriage return', { rootPath: 'public_html\r' }],
    ['double quote', { rootPath: 'public_html"' }],
    ['single quote', { rootPath: "public_html'" }],
    ['parent traversal', { rootPath: '../root' }],
    ['nested traversal', { rootPath: 'public_html/../../etc' }],
    ['absolute path', { rootPath: '/etc' }],
    ['hidden directory', { rootPath: '.ssh' }],
    ['control character', { rootPath: 'public\u0007html' }],
    ['NUL byte', { rootPath: 'public_html\u0000' }],
    ['space and semicolon', { rootPath: 'public_html; deny all' }],
    ['non-string root', { rootPath: ['public_html'] }],
    ['non-boolean flag', { readOnly: 'yes' }],
    ['server-derived port', { port: 80 }],
    ['server-derived endpoint', { endpointUrl: 'https://evil.example' }],
    ['compiled text', { compiledConfig: 'location / {}' }],
    ['foreign account id', { accountId: '00000000-0000-4000-8000-000000000002' }],
  ])('rejects %s without writing', async (_label, body) => {
    const host = fixture()
    await expect(host.request('PUT', path, body)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(host.writes).not.toHaveBeenCalled()
    expect(host.emitAudit).not.toHaveBeenCalled()
  })
})
