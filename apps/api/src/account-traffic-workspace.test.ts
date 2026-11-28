import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Domain, Plan } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ReadAgent } from './account-ssh-workspace.ts'
import { edgeRevision, edgeStatePath, readAccountEdge } from '../../agent/src/account-edge.ts'
import { handleAccountLogsRoute as handleAgentLogs } from '../../agent/src/account-logs.ts'
import type { LogTail } from '../../agent/src/account-logs.ts'
import { handleAccountTrafficRoute, type AccountTrafficPorts } from './account-traffic-workspace.ts'

const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'
const DOMAIN_ID = '33333333-3333-4333-8333-333333333333'
const ADDON_ID = '44444444-4444-4444-8444-444444444444'
const FOREIGN_DOMAIN_ID = '55555555-5555-4555-8555-555555555555'

const account = { id: ACCOUNT_ID, username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', planId: 'plan', primaryDomain: 'alice.example.test' } as Account
const primary = { id: DOMAIN_ID, accountId: ACCOUNT_ID, name: 'alice.example.test', kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3' }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' } as unknown as Domain
const addon = { ...primary, id: ADDON_ID, name: 'shop.alice.example.test', kind: 'addon' } as Domain
const foreign = { ...primary, id: FOREIGN_DOMAIN_ID, accountId: '99999999-9999-4999-8999-999999999999', name: 'other.example.test' } as Domain

const owner = { principal: { kind: 'user', id: 'user-alice', username: 'alice', accountId: ACCOUNT_ID }, sessionId: 's1', apiTokenId: null, scopes: [], principalRecord: { forcePasswordChange: false } } as unknown as AuthenticatedCaller
const rootCaller = { principal: { kind: 'root', id: 'root', username: 'root' }, sessionId: 's2', apiTokenId: null, scopes: [], principalRecord: { forcePasswordChange: false } } as unknown as AuthenticatedCaller
const mailboxCaller = { principal: { kind: 'mailbox', id: 'mb-1', username: 'inbox@alice.example.test', accountId: ACCOUNT_ID, mailbox: 'inbox@alice.example.test' }, sessionId: 's3', apiTokenId: null, scopes: ['mailbox:inbox@alice.example.test'], principalRecord: {} } as unknown as AuthenticatedCaller

const logLine = (opts: { time?: string; ip?: string; method?: string; uri?: string; status?: number; bytes?: number; agent?: string } = {}) => JSON.stringify({
  time: opts.time ?? '2026-11-10T10:00:00+00:00',
  host: 'alice.example.test',
  ip: opts.ip ?? '198.51.100.7',
  method: opts.method ?? 'GET',
  uri: opts.uri ?? '/index.html',
  status: opts.status ?? 200,
  body_bytes: opts.bytes ?? 512,
  bytes: (opts.bytes ?? 512) + 80,
  request_bytes: 120,
  request_time: 0.01,
  upstream_time: '0.010',
  cache: '-',
  referer: '',
  agent: opts.agent ?? 'Mozilla/5.0',
})

let stateRoot = ''
beforeEach(async () => { stateRoot = await mkdtemp(join(tmpdir(), 'xp-traffic-')) })
afterEach(async () => { await rm(stateRoot, { recursive: true, force: true }) })

function setup(options: { caller?: AuthenticatedCaller; disabled?: string[]; domains?: Domain[]; text?: string; reply?: (v: Record<string, unknown>) => unknown } = {}) {
  const domains = options.domains ?? [primary, addon]
  const sampleText = options.text ?? [
    logLine({ time: '2026-11-09T12:00:00+00:00', ip: '198.51.100.7', uri: '/a\u0007', status: 200, bytes: 100, agent: 'AgentA\u001b' }),
    logLine({ time: '2026-11-10T09:00:00+00:00', ip: '198.51.100.7', uri: '/b', status: 502, bytes: 200, agent: 'AgentA' }),
    logLine({ time: '2026-11-10T10:00:00+00:00', ip: '203.0.113.42', uri: '/c', status: 404, bytes: 300, agent: 'AgentB' }),
    'malformed-json',
  ].join('\n') + '\n'
  const tail: LogTail = { exists: true, sizeBytes: Buffer.byteLength(sampleText), mtime: '2026-11-10T10:05:00.000Z', text: sampleText, truncated: false }
  const readTail = vi.fn(async () => tail)
  const readAgent = vi.fn(async (_caller: AuthenticatedCaller, path: string) => {
    const url = new URL('http://agent.local' + path)
    const response = await handleAgentLogs(new Request(url), url, 'GET', {
      caller: { principalId: 'user-alice', actor: 'alice', role: 'user', accountId: ACCOUNT_ID, resellerId: null },
      readTail,
      store: { getAccountByUsername: async () => account, listDomains: async () => domains, getPlan: async () => ({ featureListId: 'f' }) as Plan, getFeatureList: async () => ({ id: 'f', name: 'f', ownerId: null, disabled: [] }) },
      currentPrincipal: async () => ({ kind: 'user', id: 'user-alice', username: 'alice', accountId: ACCOUNT_ID, disabled: false }),
      now: () => new Date('2026-11-10T10:10:00.000Z'),
    })
    const parsed = await response!.json() as Record<string, unknown>
    return options.reply ? options.reply(parsed) : parsed
  })
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const store = {
    rootDir: stateRoot,
    getWriterLock: () => ({ acquire: async () => lease }),
    getAccount: async (id: string) => id === ACCOUNT_ID ? account : null,
    getDomain: async (id: string) => [...domains, foreign].find(d => d.id === id) ?? null,
    listDomains: async ({ accountId }: { accountId: string }) => domains.filter(d => d.accountId === accountId),
    getPlan: async () => ({ featureListId: 'f' }),
    getFeatureList: async () => ({ id: 'f', name: 'f', ownerId: null, disabled: options.disabled ?? [] }),
  } as unknown as StateStore
  const emitAudit = vi.fn(async () => undefined)
  const triggerReconcile = vi.fn(async () => ({ ok: true, status: 200, body: {} }))
  const ports: AccountTrafficPorts = {
    store,
    requireCaller: async () => options.caller ?? owner,
    readAgent: readAgent as unknown as ReadAgent,
    emitAudit,
    triggerReconcile,
    now: () => new Date('2026-11-10T10:10:00.000Z'),
  }
  const send = (path: string, method = 'GET', body?: unknown) => {
    const url = new URL('http://panel.test' + path)
    return handleAccountTrafficRoute(
      new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }),
      url,
      method,
      ports,
    )
  }
  return { send, readAgent, emitAudit, triggerReconcile }
}

describe('account traffic monitor workspace', () => {
  it('projects bounded telemetry without internal IDs or control characters and allows owned domain selection', async () => {
    const h = setup()
    const response = await h.send('/api/account/traffic-monitor?domain=shop.alice.example.test')
    expect(response!.status).toBe(200)
    const body = await response!.json() as Record<string, any>
    const rawText = JSON.stringify(body)
    expect(rawText).not.toContain(ACCOUNT_ID)
    expect(rawText).not.toContain(DOMAIN_ID)
    expect(rawText).not.toContain(ADDON_ID)
    expect(rawText).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(body.context).toEqual({ username: 'alice', domain: 'shop.alice.example.test', domains: ['alice.example.test', 'shop.alice.example.test'] })
    expect(body.summary).toMatchObject({ totalRequests: 3, uniqueVisitors: 2, totalBytes: 600, error5xx: 1, unparsedLines: 1, fileExists: true })
    expect(body.dailyVisitors).toEqual([
      { date: '2026-11-09', uniqueVisitors: 1, requests: 1, bytes: 100 },
      { date: '2026-11-10', uniqueVisitors: 2, requests: 2, bytes: 500 },
    ])
    expect(body.recentRequests[0]).toMatchObject({ ip: '203.0.113.42', path: '/c', status: 404 })
    expect(body.recentRequests[2]).toMatchObject({ path: '/a', agent: 'AgentA' })
    expect(body.topUserAgents[0]).toEqual({ agent: 'AgentA', requests: 2, bytes: 300 })
    expect(body.topClientIps[0]).toMatchObject({ ip: '198.51.100.7', requests: 2, errors: 1, blocked: false })
  })

  it('refuses foreign domains with NOT_FOUND and enforces owner-only feature checks', async () => {
    const h = setup()
    await expect(h.send('/api/account/traffic-monitor?domain=other.example.test')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(h.send('/api/account/traffic-monitor?domain=alice.example.test&extra=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(setup({ caller: rootCaller }).send('/api/account/traffic-monitor')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setup({ caller: mailboxCaller }).send('/api/account/traffic-monitor')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setup({ disabled: ['traffic-monitor-account'] }).send('/api/account/traffic-monitor')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await h.send('/api/account/traffic-monitor', 'POST'))!.status).toBe(405)
    expect(h.readAgent).not.toHaveBeenCalled()
  })

  it('validates IPv4/IPv6/CIDR, checks ip-blocker feature, blocks with revision check + audit, and marks blocked IPs on readback', async () => {
    const h = setup()
    const before = await (await h.send('/api/account/traffic-monitor'))!.json() as Record<string, any>
    expect(before.ipBlocker).toEqual({ available: true, revision: edgeRevision(null), blockedCount: 0 })

    const blocked = await (await h.send('/api/account/traffic-monitor/block-ip', 'POST', { expectedRevision: before.ipBlocker.revision, ip: '198.51.100.0/24' }))!.json() as Record<string, any>
    expect(blocked).toMatchObject({ stateChanged: true, blocked: ['198.51.100.0/24'], reconcile: 'requested' })
    expect(h.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'account.ip_blocker.added', target: 'account:alice', detail: { entries: 1, source: 'traffic-monitor' } }))
    expect((await readAccountEdge(stateRoot, [account])).get(ACCOUNT_ID)?.policy.deny).toEqual(['198.51.100.0/24'])

    const after = await (await h.send('/api/account/traffic-monitor'))!.json() as Record<string, any>
    expect(after.topClientIps.find((row: { ip: string }) => row.ip === '198.51.100.7')?.blocked).toBe(true)
    expect(after.topClientIps.find((row: { ip: string }) => row.ip === '203.0.113.42')?.blocked).toBe(false)

    // Rejects stale revision, duplicates, loopback, hostnames, and disabled ip-blocker feature
    await expect(h.send('/api/account/traffic-monitor/block-ip', 'POST', { expectedRevision: before.ipBlocker.revision, ip: '203.0.113.42' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(h.send('/api/account/traffic-monitor/block-ip', 'POST', { expectedRevision: after.ipBlocker.revision, ip: '198.51.100.0/24' })).rejects.toMatchObject({ code: 'VALIDATION', detail: { fields: [{ field: 'ip', code: 'duplicate' }] } })
    for (const invalid of ['127.0.0.1', '::1', 'bad.example.test', '10.5.3.3-40', '10.']) {
      await expect(h.send('/api/account/traffic-monitor/block-ip', 'POST', { expectedRevision: after.ipBlocker.revision, ip: invalid })).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    await expect(setup({ disabled: ['ip-blocker'] }).send('/api/account/traffic-monitor/block-ip', 'POST', { expectedRevision: edgeRevision(null), ip: '203.0.113.42' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(JSON.parse(await readFile(join(stateRoot, edgeStatePath('ip-blocker', ACCOUNT_ID)), 'utf8')).entries).toEqual(['198.51.100.0/24'])
  })
})
