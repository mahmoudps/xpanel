import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { createApiToken, createRootPrincipal, createTestDb, findActiveApiTokenByHash, listApiTokensForPrincipal } from '@xpanel/db'
import type { AuthenticatedCaller } from './auth.ts'
import { sha256Hex } from './auth.ts'
import { policyForRequest } from './authorization.ts'
import { API_TOKEN_MAX_ACTIVE, API_TOKEN_SCOPE_RESOURCES, handlePanelTokensWorkspaceRoute, parseApiTokenCreate } from './panel-tokens-workspace.ts'
import type { PanelTokensWorkspaceHelpers } from './panel-tokens-workspace.ts'
import { PANEL_TOKEN_SCOPE_LABELS } from '../../web/src/board-port/whm-panel-tokens-workspace.ts'

const hash = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const BASE = '/api/server/panel/api-tokens'
const OTHER_ID = '00000000-0000-4000-8000-000000000000'
let database: Awaited<ReturnType<typeof createTestDb>>
let root: AuthenticatedCaller

const helpers = (overrides: Partial<PanelTokensWorkspaceHelpers> = {}) => {
  const audits: Record<string, unknown>[] = []
  const base: PanelTokensWorkspaceHelpers = {
    db: database.db,
    requireCaller: vi.fn(async () => root),
    assertRoot: vi.fn(async (caller: AuthenticatedCaller) => { if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required for this operation') }),
    emitAudit: vi.fn(async (entry: Record<string, unknown>) => { audits.push(entry) }),
    ...overrides,
  }
  return { helpers: base, audits }
}
const call = (path: string, method: string, h: PanelTokensWorkspaceHelpers, body?: unknown, type = 'application/json') => {
  const url = new URL('http://localhost' + path)
  return handlePanelTokensWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': type } }) }), url, method, h)
}
const create = (h: PanelTokensWorkspaceHelpers, overrides: Record<string, unknown> = {}) => call(BASE, 'POST', h, { name: 'stock-sync', scopes: ['accounts:read'], expiresInDays: 30, ...overrides })
const rows = () => database.db.query<Record<string, unknown>>('SELECT * FROM api_tokens')

beforeEach(async () => {
  database = await createTestDb()
  const principal = await createRootPrincipal(database.db, { username: 'root', passwordHash: hash, forcePasswordChange: false })
  root = { principal: { kind: 'root', id: principal.id, username: 'root' }, sessionId: 'session-1', apiTokenId: null, scopes: ['*'] } as unknown as AuthenticatedCaller
})
afterEach(async () => { await database.close() })

describe('API token scope vocabulary', () => {
  it('is exactly the resources the route policy assigns, and the web labels cover the same list', () => {
    const sample: Record<string, string> = {
      accounts: '/api/accounts', 'account-preferences': '/api/account/preferences', analytics: '/api/analytics', apps: '/api/apps/x', audit: '/api/audit', auth: '/api/auth/me',
      backups: '/api/backups', branding: '/api/branding', cache: '/api/cache/x', catalog: '/api/catalog', cluster: '/api/cluster', containers: '/api/containers/x', cron: '/api/account/cron',
      databases: '/api/databases', dns: '/api/dns', domains: '/api/domains', events: '/api/events/recent', 'feature-lists': '/api/feature-lists', files: '/api/accounts/x/files',
      firewall: '/api/firewall', generations: '/api/generations', git: '/api/git', ips: '/api/ips', jobs: '/api/jobs', languages: '/api/languages', lifecycle: '/api/transfers',
      mail: '/api/mail', plans: '/api/plans', reconcile: '/api/reconcile', resellers: '/api/resellers', search: '/api/search', security: '/api/security/workspace', server: BASE,
      'service-users': '/api/service-users', shell: '/api/accounts/x/shell', tls: '/api/certificate-workspace', webmail: '/api/webmail/x', whmcs: '/api/whmcs',
    }
    expect(Object.keys(sample).sort()).toEqual([...API_TOKEN_SCOPE_RESOURCES].sort())
    for (const [resource, path] of Object.entries(sample)) expect(policyForRequest(path, 'GET').resource, path).toBe(resource)
    expect(Object.keys(PANEL_TOKEN_SCOPE_LABELS).sort()).toEqual([...API_TOKEN_SCOPE_RESOURCES].sort())
  })

  it.each([
    [['accounts:admin']], [['mailbox:x']], [[]], [['accounts:read', 'accounts:read']], [['*', 'accounts:read']], [['nope:read']], ['accounts:read'], [[1]],
  ])('rejects scopes %j', scopes => {
    expect(() => parseApiTokenCreate({ name: 'x', scopes, expiresInDays: 1 })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
  })

  it('accepts a known subset or the all-scopes grant alone', () => {
    expect(parseApiTokenCreate({ name: 'x', scopes: ['server:read', 'jobs:write'], expiresInDays: 365 }).scopes).toEqual(['server:read', 'jobs:write'])
    expect(parseApiTokenCreate({ name: 'ci-1', scopes: ['*'], expiresInDays: 1 }).scopes).toEqual(['*'])
  })

  it.each([0, 366, 1.5, '30', null])('rejects expiry %j', expiresInDays => {
    expect(() => parseApiTokenCreate({ name: 'x', scopes: ['jobs:read'], expiresInDays })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
  })

  it.each(['Bad Name', '-x', 'x-', 'a'.repeat(65), '', 'naïve'])('rejects name %j', name => {
    expect(() => parseApiTokenCreate({ name, scopes: ['jobs:read'], expiresInDays: 1 })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
  })

  it('normalizes strict IPv4/IPv6/CIDR addresses and refuses everything else', () => {
    expect(parseApiTokenCreate({ name: 'x', scopes: ['jobs:read'], expiresInDays: 1, allowedIps: ['198.51.100.24', '2001:DB8::/32', '10.0.0.0/8'] }).allowedIps).toEqual(['198.51.100.24', '2001:db8::/32', '10.0.0.0/8'])
    for (const bad of [['010.0.0.1'], ['10.0.0.1/33'], ['10.0.0.1/8'], ['fe80::1%eth0'], ['example.com'], ['10.0.0.1', '10.0.0.1'], Array.from({ length: 17 }, (_, i) => '192.0.2.' + i), '10.0.0.1', [' 10.0.0.1']])
      expect(() => parseApiTokenCreate({ name: 'x', scopes: ['jobs:read'], expiresInDays: 1, allowedIps: bad }), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(() => parseApiTokenCreate({ name: 'x', scopes: ['jobs:read'], expiresInDays: 1, extra: true })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
  })
})

describe('API tokens workspace', () => {
  it('leaves unrelated routes untouched', async () => {
    const { helpers: h } = helpers()
    expect(await call('/api/server/panel/api-tokensx', 'GET', h)).toBeNull()
    expect(await call('/api/server/panel/notifications', 'GET', h)).toBeNull()
    expect(h.requireCaller).not.toHaveBeenCalled()
  })

  it('shows the raw token exactly once, stores only its sha256 and never lists the hash', async () => {
    const { helpers: h, audits } = helpers()
    const response = (await create(h, { allowedIps: ['198.51.100.24'] }))!
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json() as { secret: string; token: Record<string, unknown> }
    expect(body.secret).toMatch(/^xp_[A-Za-z0-9_-]{43}$/)
    expect(body.token).toMatchObject({ name: 'stock-sync', scopes: ['accounts:read'], allowedIps: ['198.51.100.24/32'], state: 'active', lastUsedAt: null, revokedAt: null })
    expect(body.token).not.toHaveProperty('tokenHash')
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.token_hash).toBe(sha256Hex(body.secret))
    expect(JSON.stringify(stored)).not.toContain(body.secret)
    expect((await findActiveApiTokenByHash(database.db, sha256Hex(body.secret)))?.id).toBe(body.token.id)
    expect(Date.parse(String(body.token.expiresAt)) - Date.now()).toBeGreaterThan(29 * 86_400_000)
    expect(audits).toEqual([expect.objectContaining({ action: 'auth.api_token.created', target: 'api-token:' + body.token.id, outcome: 'ok' })])
    expect(JSON.stringify(audits)).not.toContain(body.secret)
    const listed = await (await call(BASE, 'GET', h))!.text()
    expect(listed).not.toContain(body.secret)
    expect(listed).not.toContain(String(stored[0]!.token_hash))
    expect(JSON.parse(listed)).toMatchObject({ usageRecorded: false, tokens: [{ id: body.token.id, state: 'active' }] })
  })

  it('refuses resellers and bearer-token callers with 403 before any write', async () => {
    const reseller = { ...root, principal: { kind: 'reseller', id: OTHER_ID, username: 'res1' } } as unknown as AuthenticatedCaller
    const bearer = { ...root, sessionId: null, apiTokenId: OTHER_ID } as unknown as AuthenticatedCaller
    for (const caller of [reseller, bearer]) {
      const { helpers: h } = helpers({ requireCaller: vi.fn(async () => caller) })
      await expect(call(BASE, 'GET', h)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(create(h)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(call(`${BASE}/${OTHER_ID}/revoke`, 'POST', h)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    expect(await rows()).toHaveLength(0)
  })

  it('rejects malformed requests with 400 and wrong methods with 405', async () => {
    const { helpers: h } = helpers()
    await expect(create(h, { scopes: ['accounts:admin'] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(BASE, 'POST', h, '{"name":', 'application/json')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(BASE, 'POST', h, { name: 'x', scopes: ['jobs:read'], expiresInDays: 1 }, 'text/plain')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(BASE + '?limit=1', 'GET', h)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(`${BASE}/AAAAAAAA-0000-4000-8000-000000000000/revoke`, 'POST', h)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call(BASE, 'DELETE', h))!.status).toBe(405)
    const wrong = (await call(`${BASE}/${OTHER_ID}/revoke`, 'GET', h))!
    expect(wrong.status).toBe(405); expect(wrong.headers.get('allow')).toBe('POST')
    expect(await rows()).toHaveLength(0)
  })

  it('re-checks fresh root authority right before the write', async () => {
    const changed = { ...root, sessionId: 'session-2' } as unknown as AuthenticatedCaller
    const requireCaller = vi.fn<PanelTokensWorkspaceHelpers['requireCaller']>().mockResolvedValueOnce(root).mockResolvedValue(changed)
    const { helpers: h } = helpers({ requireCaller })
    await expect(create(h)).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(await rows()).toHaveLength(0)
  })

  it('revokes an unaudited token instead of issuing it', async () => {
    const { helpers: h } = helpers({ emitAudit: vi.fn(async () => { throw new Error('audit down') }) })
    await expect(create(h)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.revoked_at).not.toBeNull()
  })

  it('refuses a token beyond the active limit with 409', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
    for (let i = 0; i < API_TOKEN_MAX_ACTIVE; i++) await createApiToken(database.db, { principalId: root.principal.id, name: 'fixture', tokenHash: sha256Hex('fixture-' + i), scopes: ['jobs:read'], expiresAt })
    const { helpers: h } = helpers()
    await expect(create(h)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await rows()).toHaveLength(API_TOKEN_MAX_ACTIVE)
  })

  it('revokes one owned token with audit and re-read, then answers 409 and 404', async () => {
    const { helpers: h, audits } = helpers()
    const { token } = await (await create(h))!.json() as { token: { id: string } }
    const revoked = (await call(`${BASE}/${token.id}/revoke`, 'POST', h))!
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toMatchObject({ token: { id: token.id, state: 'revoked' } })
    expect((await listApiTokensForPrincipal(database.db, root.principal.id))[0]!.revokedAt).not.toBeNull()
    expect(audits.map(entry => entry.action)).toEqual(['auth.api_token.created', 'auth.api_token.revoked'])
    await expect(call(`${BASE}/${token.id}/revoke`, 'POST', h)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call(`${BASE}/${OTHER_ID}/revoke`, 'POST', h)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call(`${BASE}/${token.id}/revoke`, 'POST', h, 'x', 'text/plain')).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('answers 409 for an expired token and 404 for another principal\'s token', async () => {
    const { helpers: h } = helpers()
    const expired = await createApiToken(database.db, { principalId: root.principal.id, name: 'old', tokenHash: sha256Hex('old'), scopes: ['jobs:read'], expiresAt: new Date(Date.now() + 60_000).toISOString() })
    await database.db.query('UPDATE api_tokens SET created_at = $1, expires_at = $2 WHERE id = $3', [new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 1000).toISOString(), expired.id])
    await expect(call(`${BASE}/${expired.id}/revoke`, 'POST', h)).rejects.toMatchObject({ code: 'CONFLICT' })
    const other = await createRootPrincipal(database.db, { username: 'root2', passwordHash: hash, forcePasswordChange: false })
    const foreign = await createApiToken(database.db, { principalId: other.id, name: 'foreign', tokenHash: sha256Hex('foreign'), scopes: ['jobs:read'], expiresAt: new Date(Date.now() + 60_000).toISOString() })
    await expect(call(`${BASE}/${foreign.id}/revoke`, 'POST', h)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const listed = await (await call(BASE, 'GET', h))!.json() as { tokens: { id: string; state: string }[] }
    expect(listed.tokens).toEqual([expect.objectContaining({ id: expired.id, state: 'expired' })])
  })
})
