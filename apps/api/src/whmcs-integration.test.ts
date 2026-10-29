import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleWhmcsRoute, parseWhmcsProvision, parseWhmcsUpdate, readSavedWhmcs, readWhmcsActivity, whmcsRevision, WHMCS_ACTIVITY_KEEP } from './whmcs-integration.ts'
import type { WhmcsActivityEntry, WhmcsRouteHelpers, WhmcsView } from './whmcs-integration.ts'

const ROOT = { principal: { id: '11111111-1111-4111-8111-111111111111', kind: 'root', username: 'root' }, sessionId: 'one', apiTokenId: null } as AuthenticatedCaller
const RESELLER = { principal: { id: '22222222-2222-4222-8222-222222222222', kind: 'reseller', username: 'reseller1' }, sessionId: 'two', apiTokenId: null } as AuthenticatedCaller
const PLANS = [{ id: 'plan-basic', name: 'Basic' }, { id: 'plan-pro', name: 'Pro' }]
const ACCOUNTS = [{ username: 'alice', planId: 'plan-basic' }, { username: 'bob', planId: 'plan-basic' }, { username: 'carol', planId: 'plan-pro' }]
const STAMP = '2026-10-29T10:00:00.000Z'
const settings = { enabled: true, whmcsUrl: 'https://billing.example.test', allowedAddresses: ['203.0.113.10', '2001:db8::/32'], ssoTarget: 'xwhm', autoCreate: true,
  planMap: [{ package: 'Starter', planId: 'plan-basic' }, { package: 'Business Pro', planId: 'plan-pro' }] }
let root = ''
let ipSeq = 0
const configFile = () => join(root, 'extended', 'integrations', 'whmcs.json')

function harness(caller = ROOT, overrides: Partial<WhmcsRouteHelpers> = {}) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const ports = { createAccount: vi.fn(async () => undefined), suspendAccount: vi.fn(async () => undefined), unsuspendAccount: vi.fn(async () => undefined),
    terminateAccount: vi.fn(async () => undefined), changePlan: vi.fn(async () => undefined) }
  let ip: string | null = '203.0.113.10'
  const helpers = {
    requireCaller: vi.fn(async () => caller), emitAudit: vi.fn(async () => undefined), now: () => new Date(STAMP),
    assertRoot: vi.fn(async (who: AuthenticatedCaller) => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required') }),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }), listPlans: async () => PLANS, listAccounts: async () => ACCOUNTS,
      getAccountByUsername: async (name: string) => ACCOUNTS.find(account => account.username === name) ?? null },
    clientIp: () => ip, ports, ...overrides,
  } as unknown as WhmcsRouteHelpers
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => handleWhmcsRoute(new Request('https://api.test' + path, { method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }),
  new URL('https://api.test' + path), method, helpers)
  const read = async () => (await (await send('GET', '/api/server/panel/whmcs'))!.json()) as WhmcsView
  const rotate = async () => (await (await send('POST', '/api/server/panel/whmcs/token', { expectedRevision: (await read()).revision }))!.json()) as WhmcsView & { secret: string }
  const save = async (values: Record<string, unknown> = settings) => (await (await send('PUT', '/api/server/panel/whmcs', { ...values, expectedRevision: (await read()).revision }))!.json()) as WhmcsView
  /** A token, then the saved settings: the order the page requires. */
  const configure = async (values: Record<string, unknown> = settings) => { const { secret, apiIdentifier } = await rotate(); await save(values); return { secret, apiIdentifier: apiIdentifier! } }
  const call = (body: unknown, auth: { secret: string; apiIdentifier: string }, from: string | null = '203.0.113.10') => {
    ip = from
    return send('POST', '/api/integrations/whmcs/provision', body, { authorization: 'Bearer ' + auth.secret, 'x-xpanel-whmcs-id': auth.apiIdentifier })
  }
  return { helpers, lease, ports, send, read, rotate, save, configure, call }
}
const uniqueIp = () => `198.51.100.${++ipSeq}`
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-whmcs-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('WHMCS settings grammar', () => {
  const revision = 'a'.repeat(64)
  it('accepts the exact settings and normalizes nothing', () => {
    expect(parseWhmcsUpdate({ ...settings, expectedRevision: revision })).toEqual({ ...settings, expectedRevision: revision })
    expect(parseWhmcsUpdate({ ...settings, enabled: false, whmcsUrl: '', allowedAddresses: [], expectedRevision: revision })).toMatchObject({ enabled: false })
  })
  it('refuses unsafe URLs, addresses, mappings and extra keys', () => {
    for (const bad of [{ whmcsUrl: 'http://billing.example.test' }, { whmcsUrl: 'https://user:pw@billing.example.test' }, { whmcsUrl: 'javascript:alert(1)' }, { whmcsUrl: '' },
      { allowedAddresses: [] }, { allowedAddresses: ['10.0.0.1/24'] }, { allowedAddresses: ['not-an-ip'] }, { allowedAddresses: ['203.0.113.10', '203.0.113.10'] },
      { allowedAddresses: Array.from({ length: 33 }, (_, index) => `10.0.0.${index}`) }, { ssoTarget: 'other' }, { autoCreate: 'yes' },
      { planMap: [{ package: ' Starter', planId: 'plan-basic' }] }, { planMap: [{ package: 'A', planId: 'p' }, { package: 'a', planId: 'q' }] },
      { planMap: [{ package: 'x'.repeat(65), planId: 'p' }] }, { planMap: [{ package: 'a\u0000', planId: 'p' }] }, { planMap: [{ package: 'A', planId: 'p', accounts: 1 }] }, { token: 'x' }])
      expect(() => parseWhmcsUpdate({ ...settings, ...bad, expectedRevision: revision }), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(() => parseWhmcsUpdate({ ...settings, expectedRevision: 'x' })).toThrow()
  })
  it('reads only exact saved records', () => {
    const record = { version: 1, apiIdentifier: 'whmcs_0123456789ab', ...settings, token: null, updatedAt: STAMP }
    expect(readSavedWhmcs(record)).toEqual(record)
    for (const bad of [{ apiIdentifier: 'x' }, { updatedAt: 'today' }, { extra: 1 }, { token: { sha256: 'x', hint: 'abcd', createdAt: STAMP, issuedBy: ROOT.principal.id } }])
      expect(readSavedWhmcs({ ...record, ...bad })).toBeNull()
  })
})

describe('WHMCS provisioning grammar', () => {
  it('requires exactly the fields of each action', () => {
    expect(parseWhmcsProvision({ action: 'create', username: 'alice2', domain: 'alice.example', package: 'Starter', password: 'S3cret-pass', contactEmail: 'a@b.example' }))
      .toMatchObject({ action: 'create', username: 'alice2', domain: 'alice.example', package: 'Starter', contactEmail: 'a@b.example', reason: null })
    expect(parseWhmcsProvision({ action: 'suspend', username: 'alice', reason: '' })).toMatchObject({ reason: null })
    expect(parseWhmcsProvision({ action: 'test' })).toMatchObject({ action: 'test', username: null })
    for (const bad of [{ action: 'delete', username: 'alice' }, { action: 'create', username: 'alice' }, { action: 'unsuspend', username: 'alice', reason: 'x' },
      { action: 'terminate', username: 'Alice!' }, { action: 'change_package', username: 'alice' }, { action: 'test', username: 'alice' },
      { action: 'create', username: 'alice2', domain: 'alice.example', package: 'Starter', password: 'pw\n' }])
      expect(() => parseWhmcsProvision(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
  })
})

describe('WHMCS configuration API', () => {
  it('leaves other paths alone and is root only', async () => {
    expect(await harness().send('GET', '/api/server/panel/whmcsx')).toBeNull()
    expect(await harness().send('GET', '/api/server/panel/whmcs/other')).toBeNull()
    await expect(harness(RESELLER).read()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(harness().send('GET', '/api/server/panel/whmcs?x=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    const wrong = (await harness().send('DELETE', '/api/server/panel/whmcs'))!
    expect(wrong.status).toBe(405); expect(wrong.headers.get('allow')).toBe('GET, PUT')
  })
  it('reads defaults with plan account counts and no identifier', async () => {
    const view = await harness().read()
    expect(view).toEqual({ state: 'default', settings: { enabled: false, whmcsUrl: '', allowedAddresses: [], ssoTarget: 'xpanel', autoCreate: false, planMap: [] }, apiIdentifier: null, token: null,
      updatedAt: null, revision: whmcsRevision(null), plans: [{ id: 'plan-basic', name: 'Basic', accounts: 2 }, { id: 'plan-pro', name: 'Pro', accounts: 1 }] })
  })
  it('issues a token once, stores only its hash and requires it before enabling', async () => {
    const h = harness()
    await expect(h.save()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    const issued = await h.rotate()
    expect(issued.secret).toMatch(/^xpw_[A-Za-z0-9_-]{43}$/)
    expect(issued.apiIdentifier).toMatch(/^whmcs_[0-9a-f]{12}$/)
    expect(issued.token).toEqual({ hint: issued.secret.slice(-4), createdAt: STAMP })
    const saved = await readFile(configFile(), 'utf8')
    expect(saved).not.toContain(issued.secret)
    expect(JSON.stringify(await h.read())).not.toContain(issued.secret)
    expect(JSON.stringify(vi.mocked(h.helpers.emitAudit).mock.calls)).not.toContain(issued.secret)
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'whmcs.token.rotated', principalId: ROOT.principal.id }))
    const view = await h.save()
    expect(view).toMatchObject({ state: 'saved', settings, apiIdentifier: issued.apiIdentifier, updatedAt: STAMP })
    expect(h.lease.release).toHaveBeenCalledTimes(3)
    const second = await h.rotate()
    expect(second.secret).not.toBe(issued.secret)
    expect(second.apiIdentifier).toBe(issued.apiIdentifier)
  })
  it('refuses unknown plans, stale revisions and invalid saved files', async () => {
    const h = harness()
    await h.rotate()
    await expect(h.save({ ...settings, planMap: [{ package: 'Gold', planId: 'plan-missing' }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('PUT', '/api/server/panel/whmcs', { ...settings, expectedRevision: whmcsRevision(null) })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    await expect(h.send('POST', '/api/server/panel/whmcs/token', { expectedRevision: whmcsRevision(null), extra: 1 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await writeFile(configFile(), JSON.stringify({ version: 1 }))
    const invalid = await h.read()
    expect(invalid).toMatchObject({ state: 'invalid', settings: null, token: null })
    await expect(h.send('PUT', '/api/server/panel/whmcs', { ...settings, expectedRevision: invalid.revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('reports an audit failure after a token rotation without returning the secret', async () => {
    const h = harness(ROOT, { emitAudit: vi.fn(async () => fail('SERVICE_UNAVAILABLE', 'audit down')) })
    await expect(h.send('POST', '/api/server/panel/whmcs/token', { expectedRevision: whmcsRevision(null) })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true } })
  })
  it('downloads the module as an attachment', async () => {
    const response = (await harness().send('GET', '/api/server/panel/whmcs/module'))!
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="xpanel.php"')
    expect(await response.text()).toContain('function xpanel_CreateAccount')
    await expect(harness(RESELLER).send('GET', '/api/server/panel/whmcs/module')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('WHMCS provisioning endpoint', () => {
  it('refuses while disabled, from other addresses and with a wrong token or identifier', async () => {
    const h = harness()
    const auth = { secret: 'xpw_' + 'a'.repeat(43), apiIdentifier: 'whmcs_000000000000' }
    await expect(h.call({ action: 'test' }, auth, uniqueIp())).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const real = await h.configure()
    await expect(h.call({ action: 'test' }, real, uniqueIp())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(h.call({ action: 'test' }, real, null)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(h.call({ action: 'test' }, { ...real, secret: auth.secret }, '2001:db8::7')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    await expect(h.call({ action: 'test' }, { ...real, apiIdentifier: auth.apiIdentifier }, '2001:db8::8')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    expect((await h.call({ action: 'test' }, real))!.status).toBe(200)
    expect(Object.values(h.ports).every(port => port.mock.calls.length === 0)).toBe(true)
    const log = await readWhmcsActivity(root)
    expect(log.map(entry => [entry.result, entry.reason])).toEqual([['ok', 'completed'], ['refused', 'token_invalid'], ['refused', 'token_invalid'], ['refused', 'address_not_allowed'], ['refused', 'address_not_allowed'], ['refused', 'integration_disabled']])
    expect(JSON.stringify(log)).not.toContain(real.secret)
  })
  it('records repeated unauthenticated refusals from one address once a minute', async () => {
    const h = harness(), ip = uniqueIp()
    const auth = { secret: 'xpw_' + 'b'.repeat(43), apiIdentifier: 'whmcs_000000000000' }
    for (let index = 0; index < 5; index++) await expect(h.call({ action: 'test' }, auth, ip)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await readWhmcsActivity(root)).toHaveLength(1)
    expect(h.helpers.emitAudit).toHaveBeenCalledTimes(1)
  })
  it('runs each action through its port as the token issuer with the mapped plan', async () => {
    const h = harness(), auth = await h.configure()
    const ok = async (body: Record<string, unknown>) => expect(await (await h.call(body, auth))!.json()).toEqual({ ok: true, action: body.action, username: body.username })
    await ok({ action: 'create', username: 'dave', domain: 'dave.example', package: 'Starter', password: 'S3cret-pass', contactEmail: 'dave@example.test' })
    await ok({ action: 'suspend', username: 'alice', reason: 'Overdue invoice' })
    await ok({ action: 'unsuspend', username: 'alice' })
    await ok({ action: 'change_package', username: 'alice', package: 'Business Pro' })
    await ok({ action: 'terminate', username: 'bob' })
    const actor = ROOT.principal.id
    expect(h.ports.createAccount).toHaveBeenCalledWith({ actor, username: 'dave', primaryDomain: 'dave.example', planId: 'plan-basic', password: 'S3cret-pass', contactEmail: 'dave@example.test' })
    expect(h.ports.suspendAccount).toHaveBeenCalledWith({ actor, username: 'alice', reason: 'Overdue invoice' })
    expect(h.ports.unsuspendAccount).toHaveBeenCalledWith({ actor, username: 'alice' })
    expect(h.ports.changePlan).toHaveBeenCalledWith({ actor, username: 'alice', planId: 'plan-pro' })
    expect(h.ports.terminateAccount).toHaveBeenCalledWith({ actor, username: 'bob' })
    const log = await readWhmcsActivity(root)
    expect(log.slice(0, 5).map(entry => entry.action)).toEqual(['terminate', 'change_package', 'unsuspend', 'suspend', 'create'])
    expect(JSON.stringify(log)).not.toContain('S3cret-pass')
    expect(JSON.stringify(vi.mocked(h.helpers.emitAudit).mock.calls)).not.toContain('S3cret-pass')
    const view = await (await h.send('GET', '/api/server/panel/whmcs/activity'))!.json() as { entries: WhmcsActivityEntry[] }
    expect(view.entries[0]).toEqual({ at: STAMP, action: 'terminate', username: 'bob', result: 'ok', reason: 'completed', ip: '203.0.113.10' })
  })
  it('refuses unmapped packages, unknown accounts and creation when turned off', async () => {
    const h = harness(), auth = await h.configure({ ...settings, autoCreate: false })
    await expect(h.call({ action: 'create', username: 'dave', domain: 'dave.example', package: 'Starter', password: 'S3cret-pass' }, auth)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'create_disabled' } })
    await expect(h.call({ action: 'change_package', username: 'alice', package: 'Gold' }, auth)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'package_not_mapped' } })
    await expect(h.call({ action: 'terminate', username: 'zed' }, auth)).rejects.toMatchObject({ code: 'NOT_FOUND', detail: { reason: 'account_not_found' } })
    await expect(h.call({ action: 'terminate', username: 'alice', extra: 1 }, auth)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(Object.values(h.ports).every(port => port.mock.calls.length === 0)).toBe(true)
    expect((await readWhmcsActivity(root)).map(entry => entry.reason)).toEqual(['invalid_request', 'account_not_found', 'package_not_mapped', 'create_disabled'])
  })
  it('logs a port failure with its reason and passes the error on', async () => {
    const h = harness(), auth = await h.configure()
    h.ports.suspendAccount.mockRejectedValueOnce(Object.assign(new Error('x'), {}))
    await expect(h.call({ action: 'suspend', username: 'alice' }, auth)).rejects.toThrow('x')
    h.ports.unsuspendAccount.mockImplementationOnce(async () => fail('PRECONDITION_FAILED', 'agent missing', { reason: 'host_agent_unavailable' }))
    await expect(h.call({ action: 'unsuspend', username: 'alice' }, auth)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await readWhmcsActivity(root)).slice(0, 2).map(entry => [entry.result, entry.reason])).toEqual([['failed', 'host_agent_unavailable'], ['failed', 'internal_error']])
  })
})

describe('WHMCS activity log bounds', () => {
  it('keeps the newest entries after rotation and returns the newest 100', async () => {
    const dir = join(root, 'extended', 'integrations')
    await mkdir(dir, { recursive: true })
    const line = (index: number) => JSON.stringify({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), action: 'suspend', username: 'user' + index, result: 'ok', reason: 'completed', ip: '203.0.113.10' })
    await writeFile(join(dir, 'whmcs-activity.jsonl'), Array.from({ length: 2500 }, (_, index) => line(index)).join('\n') + '\n')
    const h = harness(), auth = await h.configure()
    await h.call({ action: 'test' }, auth)
    const lines = (await readFile(join(dir, 'whmcs-activity.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(lines).toHaveLength(WHMCS_ACTIVITY_KEEP)
    const entries = await readWhmcsActivity(root)
    expect(entries).toHaveLength(100)
    expect(entries[0]).toMatchObject({ action: 'test', result: 'ok' })
    expect(entries[1]).toMatchObject({ username: 'user2499' })
  })
})
