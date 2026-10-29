import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain, Plan } from '@xpanel/core'
import { LOG_TAIL_MAX_BYTES, LOG_TAIL_MAX_LINES, handleAccountLogsRoute, parseAccessLogLine, parseErrorLogLine, readProtectedLogTail, resolveAccountLogPath, tailLines } from './account-logs.ts'
import type { AccountLogsRouteDeps, LogTail } from './account-logs.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111', MAIN = '22222222-2222-4222-8222-222222222222', ALIAS = '33333333-3333-4333-8333-333333333333', SUB = '44444444-4444-4444-8444-444444444444', FOREIGN = '55555555-5555-4555-8555-555555555555'
const account = { id: ACCOUNT, username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', planId: 'plan', primaryDomain: 'example.test' } as Account
const domain = (id: string, name: string, kind: Domain['kind'], parentId: string | null = null): Domain => ({ id, accountId: ACCOUNT, name, kind, parentId, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3' } as Domain['php'], wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' })
const domains = [domain(MAIN, 'example.test', 'primary'), domain(ALIAS, 'example.org', 'alias', MAIN), domain(SUB, 'blog.example.test', 'subdomain', MAIN)]

describe('edge log resolution and bounded tails', () => {
  it('derives the log from the rendered site grouping, never from the request', () => {
    expect(resolveAccountLogPath(account, domains, MAIN, 'access')).toMatchObject({ path: '/var/log/xpanel/nginx/example.test.access.log', site: 'example.test' })
    expect(resolveAccountLogPath(account, domains, ALIAS, 'error')).toMatchObject({ path: '/var/log/xpanel/nginx/example.test.error.log', site: 'example.test', domain: { name: 'example.org' } })
    expect(resolveAccountLogPath(account, domains, SUB, 'access').path).toBe('/var/log/xpanel/nginx/blog.example.test.access.log')
    expect(() => resolveAccountLogPath(account, [...domains, { ...domain(FOREIGN, 'other.test', 'addon'), accountId: FOREIGN }], FOREIGN, 'access')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => resolveAccountLogPath(account, [{ ...domains[0]!, docRoot: '/etc' }], MAIN, 'access')).toThrow(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
  })
  it('keeps at most 2000 whole lines, drops a cut first line and neutralizes controls', () => {
    const many = Array.from({ length: LOG_TAIL_MAX_LINES + 5 }, (_, index) => 'line ' + index).join('\n') + '\n'
    const result = tailLines({ text: many, truncated: false })
    expect(result.lines).toHaveLength(LOG_TAIL_MAX_LINES); expect(result.dropped).toBe(5); expect(result.lines[0]).toBe('line 5'); expect(result.lines.at(-1)).toBe('line 2004')
    expect(tailLines({ text: 'partial\nwhole\r\nbell\u0007\u001b[31m\n', truncated: true }).lines).toEqual(['whole', 'bell\ufffd\ufffd[31m'])
    expect(tailLines({ text: 'x'.repeat(9000), truncated: false }).lines[0]!.length).toBe(8193)
  })
  it('refuses any path outside the edge log directory before touching the filesystem', async () => {
    for (const path of ['/etc/shadow', '/var/log/xpanel/nginx/../../../etc/shadow', '/var/log/xpanel/nginx/sub/x.access.log', '/var/log/xpanel/apache/error.log', '/var/log/xpanel/nginx/access.log.1'])
      await expect(readProtectedLogTail(path, LOG_TAIL_MAX_BYTES)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(readProtectedLogTail('/var/log/xpanel/nginx/example.test.access.log', LOG_TAIL_MAX_BYTES + 1)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('parses the edge JSON access format and nginx error lines strictly', () => {
    const line = JSON.stringify({ time: '2026-10-27T01:00:00+00:00', host: 'example.test', ip: '192.0.2.9', method: 'GET', uri: '/a?b=1', status: 404, body_bytes: 12, bytes: 200, request_bytes: 80, request_time: 0.001, upstream_time: '0.001', cache: '-', referer: '', agent: 'curl/8' })
    expect(parseAccessLogLine(line)).toEqual({ time: '2026-10-27T01:00:00+00:00', host: 'example.test', ip: '192.0.2.9', method: 'GET', uri: '/a?b=1', status: 404, bytes: 12, referer: '', agent: 'curl/8' })
    for (const bad of ['not json', '[]', JSON.stringify({ ...JSON.parse(line), status: '404' }), JSON.stringify({ ...JSON.parse(line), status: 99 }), JSON.stringify({ ...JSON.parse(line), body_bytes: -1 })]) expect(parseAccessLogLine(bad)).toBeNull()
    expect(parseErrorLogLine('2026/10/27 01:00:00 [error] 12#12: *3 connect() failed')).toEqual({ time: '2026/10/27 01:00:00', level: 'error', message: '*3 connect() failed' })
    expect(parseErrorLogLine('continued text')).toEqual({ time: null, level: null, message: 'continued text' })
  })
})

describe('agent account log route', () => {
  const principal = { kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT, disabled: false }
  const setup = (over: { role?: 'user' | 'reseller' | 'root'; disabled?: string[]; readTail?: AccountLogsRouteDeps['readTail']; principals?: (typeof principal | null)[] } = {}) => {
    const tail: LogTail = { exists: true, sizeBytes: 300000, mtime: '2026-10-27T00:00:00.000Z', text: 'cut\nfirst\nsecond\n', truncated: true }
    const readTail = over.readTail === undefined ? vi.fn(async () => tail) : over.readTail, principals = [...(over.principals ?? [])]
    const deps: AccountLogsRouteDeps = { caller: { principalId: 'p-alice', actor: 'alice', role: over.role ?? 'user', accountId: over.role && over.role !== 'user' ? null : ACCOUNT, resellerId: null },
      store: { getAccountByUsername: async name => name === 'alice' ? account : null, listDomains: async () => domains, getPlan: async () => ({ featureListId: 'list' }) as Plan, getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: over.disabled ?? [] }) },
      currentPrincipal: async () => principals.length ? principals.shift()! : principal, readTail, now: () => new Date('2026-10-27T02:00:00.000Z') }
    const call = (path: string, method = 'GET') => { const url = new URL('http://agent.local' + path); return handleAccountLogsRoute(new Request(url, { method }), url, method, deps) }
    return { call, readTail }
  }
  it('returns the bounded tail of an owned domain with its serving site', async () => {
    const t = setup(), response = await t.call('/accounts/alice/logs/' + ALIAS + '/access')
    expect(t.readTail).toHaveBeenCalledWith('/var/log/xpanel/nginx/example.test.access.log', LOG_TAIL_MAX_BYTES)
    expect(await response!.json()).toEqual({ context: { accountId: ACCOUNT, domainId: ALIAS, domainName: 'example.org', site: 'example.test', kind: 'access' }, file: { exists: true, sizeBytes: 300000, mtime: '2026-10-27T00:00:00.000Z', truncated: true },
      lines: ['first', 'second'], limits: { maxBytes: LOG_TAIL_MAX_BYTES, maxLines: LOG_TAIL_MAX_LINES, linesDropped: 0 }, observedAt: '2026-10-27T02:00:00.000Z' })
    expect(await t.call('/accounts/alice/files')).toBeNull()
  })
  it('refuses foreign domains, other roles, disabled features, revoked owners and hosts without a reader', async () => {
    await expect(setup().call('/accounts/alice/logs/' + FOREIGN + '/access')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(setup().call('/accounts/bob/logs/' + MAIN + '/access')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    for (const role of ['reseller', 'root'] as const) await expect(setup({ role }).call('/accounts/alice/logs/' + MAIN + '/access')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const disabled = setup({ disabled: ['Error Log'] }); await expect(disabled.call('/accounts/alice/logs/' + MAIN + '/error')).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(disabled.readTail).not.toHaveBeenCalled()
    expect((await setup({ disabled: ['errors'] }).call('/accounts/alice/logs/' + MAIN + '/access'))!.status).toBe(200)
    const revoked = setup({ principals: [principal, { ...principal, disabled: true }] })
    await expect(revoked.call('/accounts/alice/logs/' + MAIN + '/access')).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(revoked.readTail).toHaveBeenCalledTimes(1)
    await expect(setup({ readTail: null }).call('/accounts/alice/logs/' + MAIN + '/access')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(setup({ readTail: async () => { throw new Error('EACCES') } }).call('/accounts/alice/logs/' + MAIN + '/access')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(setup().call('/accounts/alice/logs/' + MAIN + '/access?path=/etc/shadow')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await setup().call('/accounts/alice/logs/' + MAIN + '/access', 'POST'))!.status).toBe(405)
  })
})
