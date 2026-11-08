import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain, Plan } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { handleAccountLogsRoute, projectLogArchives, projectRawServerLogs } from './account-logs-workspace.ts'
import type { ReadAgent } from './account-ssh-workspace.ts'
import { handleAccountLogsRoute as handleAgentLogs } from '../../agent/src/account-logs.ts'
import type { LogTail } from '../../agent/src/account-logs.ts'

// The agent route is the actual handler; only the root tail reader and the transport are doubles.
const ACCOUNT = '11111111-1111-4111-8111-111111111111', MAIN = '22222222-2222-4222-8222-222222222222', FOREIGN = '55555555-5555-4555-8555-555555555555'
const account = { id: ACCOUNT, username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', planId: 'plan', primaryDomain: 'example.test' } as Account
const main = { id: MAIN, accountId: ACCOUNT, name: 'example.test', kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3' }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' } as unknown as Domain
const foreign = { ...main, id: FOREIGN, accountId: '99999999-9999-4999-8999-999999999999', name: 'other.test' } as Domain
const owner = { principal: { kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT }, apiTokenId: null, scopes: [], principalRecord: { forcePasswordChange: false } } as unknown as AuthenticatedCaller
const access = (status: number, uri = '/'): string => JSON.stringify({ time: '2026-10-27T01:00:00+00:00', host: 'example.test', ip: '192.0.2.9', method: 'GET', uri, status, body_bytes: 10, bytes: 100, request_bytes: 50, request_time: 0.01, upstream_time: '0.010', cache: '-', referer: '', agent: 'curl/8' })

function setup(options: { disabled?: string[]; caller?: AuthenticatedCaller; text?: string; reply?: (value: Record<string, unknown>) => unknown } = {}) {
  const tail: LogTail = { exists: true, sizeBytes: 900, mtime: '2026-10-27T01:00:00.000Z', text: options.text ?? access(200) + '\n' + access(404, '/missing') + '\nnot json\n' + access(502) + '\n', truncated: false }
  const readTail = vi.fn(async () => tail)
  const readAgent = vi.fn(async (_caller: AuthenticatedCaller, path: string) => {
    const url = new URL('http://agent.local' + path)
    const response = await handleAgentLogs(new Request(url), url, 'GET', { caller: { principalId: 'p-alice', actor: 'alice', role: 'user', accountId: ACCOUNT, resellerId: null }, readTail,
      store: { getAccountByUsername: async () => account, listDomains: async () => [main], getPlan: async () => ({ featureListId: 'list' }) as Plan, getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: [] }) },
      currentPrincipal: async () => ({ kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT, disabled: false }), now: () => new Date('2026-10-27T02:00:00.000Z') })
    const value = await response!.json() as Record<string, unknown>
    return options.reply ? options.reply(value) : value
  })
  const setAccountLogSettings = vi.fn(async (_id: string, settings: Account['logs'] | null) => ({ ...account, ...(settings ? { logs: settings } : {}) }))
  const store = { rootDir: '/nonexistent-state', getAccount: async (id: string) => id === ACCOUNT ? account : null, getDomain: async (id: string) => id === MAIN ? main : id === FOREIGN ? foreign : null, getPlan: async () => ({ featureListId: 'list' }), getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: options.disabled ?? [] }), setAccountLogSettings } as unknown as StateStore
  const emitAudit = vi.fn(async () => undefined)
  const agentCalls: string[] = []
  const callAgent = async (_caller: AuthenticatedCaller, path: string): Promise<Response> => {
    agentCalls.push(path)
    return path.endsWith('/access/download') || path.startsWith('/host/logs/raw/') ? new Response(new Uint8Array([31, 139, 8, 0]), { headers: { 'content-type': 'application/gzip', 'content-disposition': 'attachment; filename="example.test.access.log.gz"' } }) : new Response(null, { status: 404 })
  }
  const assertRoot = async (caller: AuthenticatedCaller) => { if (caller.principal.kind !== 'root') throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN' }) }
  const ports = { store, requireCaller: async () => options.caller ?? owner, readAgent: readAgent as unknown as ReadAgent, assertRoot, emitAudit, callAgent }
  const route = (path: string, method = 'GET', body?: unknown) => { const url = new URL('http://panel.test' + path); return handleAccountLogsRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, method, ports) }
  return { route, readAgent, readTail, setAccountLogSettings, emitAudit, agentCalls }
}

describe('account site logs workspace', () => {
  it('returns parsed access entries for an owned domain with the unparsed count', async () => {
    const t = setup(), body = await (await t.route('/api/account/logs/' + MAIN + '/access'))!.json() as Record<string, any>
    expect(t.readAgent.mock.calls[0]![1]).toBe('/accounts/alice/logs/' + MAIN + '/access'); expect(t.readTail).toHaveBeenCalledWith('/var/log/xpanel/nginx/example.test.access.log', 256 * 1024)
    expect(body.context).toEqual({ accountId: ACCOUNT, domainId: MAIN, domainName: 'example.test', site: 'example.test', kind: 'access' })
    expect(body.entries.map((entry: { status: number }) => entry.status)).toEqual([200, 404, 502]); expect(body.unparsedLines).toBe(1)
    const errors = setup({ text: '2026/10/27 01:00:00 [error] 1#1: *2 upstream timed out\ncontinued\n' }), log = await (await errors.route('/api/account/logs/' + MAIN + '/error'))!.json() as Record<string, any>
    expect(log.entries).toEqual([{ time: '2026/10/27 01:00:00', level: 'error', message: '*2 upstream timed out' }, { time: null, level: null, message: 'continued' }]); expect(log.unparsedLines).toBe(1)
  })
  it('hides foreign domains and refuses other roles or disabled log features before any agent read', async () => {
    const t = setup()
    await expect(t.route('/api/account/logs/' + FOREIGN + '/access')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(t.route('/api/account/logs/66666666-6666-4666-8666-666666666666/error')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    for (const kind of ['root', 'reseller'] as const) await expect(setup({ caller: { ...owner, principal: { kind, id: kind, username: kind } } as unknown as AuthenticatedCaller }).route('/api/account/logs/' + MAIN + '/access')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setup({ disabled: ['raw-access'] }).route('/api/account/logs/' + MAIN + '/access')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setup({ disabled: ['Error Log'] }).route('/api/account/logs/' + MAIN + '/error')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await setup({ disabled: ['errors'] }).route('/api/account/logs/' + MAIN + '/access'))!.status).toBe(200)
    expect(t.readAgent).not.toHaveBeenCalled()
    await expect(t.route('/api/account/logs/' + MAIN + '/access?status=500')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await t.route('/api/account/logs/' + MAIN + '/access', 'POST'))!.status).toBe(405)
    expect(await t.route('/api/account/logs/' + MAIN + '/debug')).toBeNull()
  })
  it('refuses agent replies that are foreign, unbounded or multi-line', async () => {
    for (const reply of [(v: Record<string, unknown>) => ({ ...v, context: { ...(v.context as object), domainId: FOREIGN } }), (v: Record<string, unknown>) => ({ ...v, lines: ['a\nb'] }),
      (v: Record<string, unknown>) => ({ ...v, lines: Array.from({ length: 2001 }, () => 'x') }), (v: Record<string, unknown>) => ({ ...v, limits: { ...(v.limits as object), maxBytes: 1 << 30 } }), (v: Record<string, unknown>) => ({ ...v, file: { exists: false, sizeBytes: 0, mtime: null, truncated: false } })])
      await expect(setup({ reply }).route('/api/account/logs/' + MAIN + '/access')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
  })
  it('saves raw access archive settings for the owner, or returns the account to the server defaults', async () => {
    const t = setup()
    expect(await (await t.route('/api/account/logs/settings'))!.json()).toEqual({ context: { accountId: ACCOUNT }, settings: { archive: true, removePreviousMonthArchive: false, retentionDays: null }, source: 'server', serverDefaults: { archive: true, removePreviousMonthArchive: false, retentionDays: null } })
    const saved = await (await t.route('/api/account/logs/settings', 'PUT', { settings: { archive: true, removePreviousMonthArchive: true, retentionDays: 7 } }))!.json() as Record<string, any>
    expect(saved).toMatchObject({ source: 'account', settings: { retentionDays: 7 } })
    expect(t.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'account.logs.settings.updated', target: 'account:alice' }), expect.anything())
    expect(await (await t.route('/api/account/logs/settings', 'PUT', { settings: null }))!.json()).toMatchObject({ source: 'server' })
    await expect(t.route('/api/account/logs/settings', 'PUT', { settings: { archive: 'yes' } })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(t.route('/api/account/logs/settings', 'PUT', { archive: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(setup({ disabled: ['raw-access'] }).route('/api/account/logs/settings')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(t.setAccountLogSettings).toHaveBeenCalledTimes(2)
  })
  it('lists archives through the agent and refuses a foreign or malformed listing', async () => {
    const t = setup()
    // no ~/logs directory on this host: truthfully unavailable, not an empty archive
    expect(await (await t.route('/api/account/logs/archives'))!.json()).toMatchObject({ context: { accountId: ACCOUNT, username: 'alice' }, available: false, archives: [] })
    const listed = { context: { accountId: ACCOUNT, username: 'alice' }, available: true, observedAt: '2026-11-06T00:00:00.000Z', archives: [{ name: 'example.test-2026-11-05.gz', site: 'example.test', day: '2026-11-05', sizeBytes: 10, mtime: '2026-11-06T00:05:00.000Z' }] }
    expect(projectLogArchives(listed, account).archives).toHaveLength(1)
    for (const bad of [{ ...listed, context: { accountId: FOREIGN, username: 'alice' } }, { ...listed, archives: [{ ...listed.archives[0]!, name: '../../etc/shadow.gz' }] }, { ...listed, available: false }])
      expect(() => projectLogArchives(bad, account)).toThrow()
    await expect(t.route('/api/account/logs/archives/example.test-2026-11-05.gz')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(t.route('/api/account/logs/archives?all=1')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('streams the current access log of an owned domain from the agent and nothing for another domain', async () => {
    const t = setup()
    const response = (await t.route('/api/account/logs/' + MAIN + '/access/download'))!
    expect(response.headers.get('content-type')).toBe('application/gzip')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="example.test.access.log.gz"')
    expect(t.agentCalls).toEqual(['/accounts/alice/logs/' + MAIN + '/access/download'])
    await expect(t.route('/api/account/logs/' + FOREIGN + '/access/download')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(setup({ disabled: ['raw-access'] }).route('/api/account/logs/' + MAIN + '/access/download')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await t.route('/api/account/logs/' + MAIN + '/access/download', 'POST'))!.status).toBe(405)
  })
  it('lets only root list and download the web servers own logs by their fixed names', async () => {
    const root = setup({ caller: { ...owner, principal: { kind: 'root', id: 'root', username: 'root' } } as unknown as AuthenticatedCaller })
    const file = (await root.route('/api/server/logs/raw/nginx/access.log.2.gz'))!
    expect(file.headers.get('content-disposition')).toBe('attachment; filename="nginx-access.log.2.gz"')
    expect(root.agentCalls).toEqual(['/host/logs/raw/nginx/access.log.2.gz'])
    for (const bad of ['/api/server/logs/raw/nginx/shadow', '/api/server/logs/raw/nginx/..%2Faccess.log', '/api/server/logs/raw/mysql/access.log']) await expect(root.route(bad)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(setup().route('/api/server/logs/raw/nginx')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const listed = { server: 'nginx', state: 'read', files: [{ name: 'error.log', sizeBytes: 10, mtime: '2026-11-06T00:00:00.000Z', compressed: false, downloadable: true }], maxBytes: 1 << 30, observedAt: '2026-11-06T00:00:00.000Z' }
    expect(projectRawServerLogs(listed, 'nginx').files).toHaveLength(1)
    for (const bad of [{ ...listed, server: 'apache' }, { ...listed, files: [{ ...listed.files[0]!, name: '../../etc/shadow' }] }, { ...listed, state: 'unavailable' }]) expect(() => projectRawServerLogs(bad, 'nginx')).toThrow()
  })
})
