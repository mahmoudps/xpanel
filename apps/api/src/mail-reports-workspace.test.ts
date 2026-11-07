import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail, isXpanelError } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { MAIL_SEND_LIMIT_DEFAULTS, flagSentDomain, handleMailReportsWorkspaceRoute } from './mail-reports-workspace.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const task of cleanup.splice(0)) await task() })
const NOW = new Date('2026-11-07T12:00:00.500Z')
const root = { principal: { id: 'root-id', kind: 'root', username: 'root' }, sessionId: 's1' } as unknown as AuthenticatedCaller
const report = { state: 'read', reason: null, observedAt: NOW.toISOString(), window: {}, complete: true, relayers: [{ user: 'a@b.test', messages: 3 }], relayersOmitted: 0,
  domains: [{ domain: 'b.test', account: 'alice', messages: 120, sent: 100, deferred: 15, failed: 5, bytes: 9 }], domainsOmitted: 0 }

async function fixture(host = true) {
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  let current = root
  const audits: { action: string; detail?: unknown }[] = []
  const callHost = vi.fn(async (_caller: AuthenticatedCaller, path: string, body?: unknown) => path.startsWith('/host/mail/log/report') ? report : path === '/host/mail/trace' ? { address: (body as { address: string }).address, deliverable: true, steps: [] } : { accounts: 2, jobs: [{ id: 'j1', kind: 'k', status: 'queued' }] })
  const helpers = { store: state.store, requireCaller: async () => current, assertRoot: async (who: AuthenticatedCaller) => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root required') },
    emitAudit: async (entry: unknown) => { audits.push(entry as { action: string }) }, now: () => NOW, ...(host ? { callHost } : {}) }
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const request = new Request('http://localhost' + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    try { const response = await handleMailReportsWorkspaceRoute(request, new URL(request.url), method, helpers); return { status: response?.status ?? 404, body: response && response.status !== 405 ? await response.json() as Record<string, any> : {} } }
    catch (error) { if (isXpanelError(error)) return { status: 0, code: error.code, detail: error.detail, body: {} as Record<string, any> }; throw error }
  }
  return { call, callHost, audits, as: (who: AuthenticatedCaller) => { current = who } }
}

describe('sent summary flags', () => {
  const row = { domain: 'b.test', account: 'alice', messages: 120, sent: 100, deferred: 15, failed: 5, bytes: 9 }
  it('flags a domain over its hourly limit only', () => {
    expect(flagSentDomain(row, { ...MAIL_SEND_LIMIT_DEFAULTS, domainHourlyLimit: 100 })).toMatchObject({ overHourly: true, overDeferFail: false })
    expect(flagSentDomain(row, { ...MAIL_SEND_LIMIT_DEFAULTS, domainHourlyLimit: 120 })).toMatchObject({ overHourly: false })
  })
  it('applies the deferred and failed share after the minimum', () => {
    expect(flagSentDomain(row, { domainHourlyLimit: 0, deferFailPercent: 15, deferFailMinimum: 5 }).overDeferFail).toBe(true)
    expect(flagSentDomain(row, { domainHourlyLimit: 0, deferFailPercent: 15, deferFailMinimum: 21 }).overDeferFail).toBe(false)
    expect(flagSentDomain(row, { domainHourlyLimit: 0, deferFailPercent: 0, deferFailMinimum: 0 }).overDeferFail).toBe(false)
  })
})

describe('mail reports workspace', () => {
  it('returns relayers from the agent read', async () => {
    const f = await fixture()
    expect((await f.call('/api/server/mail-reports/relayers')).body).toMatchObject({ rows: [{ user: 'a@b.test' }], omitted: 0, complete: true })
    expect(String(f.callHost.mock.calls[0]![1])).toContain('since=2026-11-06T12%3A00%3A00Z')
  })
  it('reads the last hour for the current view and flags against saved limits', async () => {
    const f = await fixture()
    expect((await f.call('/api/server/mail-reports/send-limits', 'PUT', { domainHourlyLimit: 100, deferFailPercent: 0, deferFailMinimum: 5 })).status).toBe(200)
    const reply = await f.call('/api/server/mail-reports/sent-summary?view=current')
    expect(reply.body).toMatchObject({ view: 'current', rows: [{ domain: 'b.test', overHourly: true }] })
    expect(String(f.callHost.mock.calls[0]![1])).toContain('since=2026-11-07T11%3A00%3A00Z')
    expect(f.audits.map(item => item.action)).toEqual(['server.mail_reports.limits_saved'])
  })
  it('leaves the history view unflagged', async () => {
    const f = await fixture()
    expect((await f.call('/api/server/mail-reports/sent-summary')).body.rows[0]).not.toHaveProperty('overHourly')
  })
  it('refuses selectors outside the route, a window with the current view and bad limits', async () => {
    const f = await fixture()
    expect(await f.call('/api/server/mail-reports/relayers?view=current')).toMatchObject({ code: 'VALIDATION' })
    expect(await f.call('/api/server/mail-reports/sent-summary?view=current&since=2026-11-07T00:00:00Z&until=2026-11-07T01:00:00Z')).toMatchObject({ code: 'VALIDATION' })
    expect(await f.call('/api/server/mail-reports/send-limits', 'PUT', { domainHourlyLimit: -1, deferFailPercent: 101, deferFailMinimum: 0 })).toMatchObject({ code: 'VALIDATION' })
  })
  it('refuses an observation of the wrong shape and a missing agent', async () => {
    const f = await fixture()
    f.callHost.mockResolvedValueOnce({ state: 'read' } as never)
    expect(await f.call('/api/server/mail-reports/relayers')).toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(await (await fixture(false)).call('/api/server/mail-reports/relayers')).toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('passes one normalized address to the trace', async () => {
    const f = await fixture()
    expect((await f.call('/api/server/mail-trace', 'POST', { address: ' X@Remote.test ' })).body).toMatchObject({ address: 'x@remote.test', deliverable: true })
    expect(await f.call('/api/server/mail-trace', 'POST', { address: 'x@y.test', extra: 1 })).toMatchObject({ code: 'VALIDATION' })
  })
  it('submits and audits the repair', async () => {
    const f = await fixture()
    expect(await f.call('/api/server/mail-maintenance/repair', 'POST', { accounts: 'all' })).toMatchObject({ status: 202, body: { accounts: 2 } })
    expect(f.audits.map(item => item.action)).toEqual(['server.mail_maintenance.repair_requested'])
    expect(await f.call('/api/server/mail-maintenance/repair', 'POST', { accounts: 'everyone' })).toMatchObject({ code: 'VALIDATION' })
  })
  it('is root only', async () => {
    const f = await fixture()
    f.as({ principal: { id: 'u', kind: 'user', username: 'alice', accountId: 'a' }, sessionId: 's2' } as unknown as AuthenticatedCaller)
    expect(await f.call('/api/server/mail-reports/relayers')).toMatchObject({ code: 'FORBIDDEN' })
  })
})
