// @vitest-environment jsdom
import { renderAccountForwarders } from './board-port/extensions/account-forwarders.ts'
import { describe, expect, it, vi } from 'vitest'
import { ACCOUNT_FORWARDERS_CLIENT_BINDING, forwarderWriteUncertain, readForwarderRecords, readRoutingApplication, utcInstant } from './account-forwarders-client.ts'

const applied = { state: 'applied', reason: null }
describe('forwarder host state and retry boundary', () => {
  it.each([undefined, {}, { state: 'configuration_only' }, { state: 'applied' }, { state: 'failed', reason: 3 }])('rejects unproved application state %j', value => {
    expect(() => readRoutingApplication(value)).toThrow()
  })
  it('keeps the failure reason the server reported', () => {
    expect(readRoutingApplication({ state: 'failed', reason: 'postfix check failed' })).toEqual({ state: 'failed', reason: 'postfix check failed' })
  })
  it('preserves an authoritative empty read rather than substituting demo data', () => {
    expect(readForwarderRecords({ forwarders: [] })).toEqual([])
  })
  it('copies actual records with their state and excludes account IDs from view data', () => {
    const result = readForwarderRecords({ forwarders: [
      { id: 'r1', accountId: 'private', sourceAddress: 'a@tenant.test', action: 'forward', destinations: ['b@recipient.test'], application: applied },
      { id: 'r2', accountId: 'private', sourceAddress: 'old@tenant.test', action: 'reject', destinations: [], rejectMessage: 'No longer here', application: { state: 'pending', reason: 'Saved' } },
    ] })
    expect(result).toEqual([
      { id: 'r1', sourceAddress: 'a@tenant.test', action: 'forward', destinations: ['b@recipient.test'], application: applied },
      { id: 'r2', sourceAddress: 'old@tenant.test', action: 'reject', destinations: [], rejectMessage: 'No longer here', application: { state: 'pending', reason: 'Saved' } },
    ])
  })
  it.each([undefined, 'not-an-array',
    [{ id: 'r1', sourceAddress: 'a@tenant.test', action: 'forward', destinations: [], application: applied }],
    [{ id: 'r1', sourceAddress: 'a@tenant.test', action: 'forward', destinations: [null], application: applied }],
    [{ id: 'r1', sourceAddress: 'a@tenant.test', action: 'reject', destinations: [], application: applied }],
    [{ id: 'r1', sourceAddress: 'a@tenant.test', action: 'forward', destinations: ['b@recipient.test'] }],
  ])('fails closed on malformed collection %j', forwarders => {
    expect(() => readForwarderRecords({ forwarders })).toThrow()
  })
  it.each([{ status: 409, unknownOutcome: true }, { status: 422, details: { stateChanged: true } }, { status: 403, verificationRequired: true }, { status: 400, details: { stateChanged: false, needsAttention: true } }, { status: 408 }, new Error('connection_lost')])('locks retries when the outcome may have changed state %j', failure => {
    expect(forwarderWriteUncertain(failure)).toBe(true)
  })
  it.each([{ status: 422 }, { status: 409 }, { status: 422, details: { stateChanged: false, rolledBack: true } }])('permits correction after a definite refusal %j', failure => {
    expect(forwarderWriteUncertain(failure)).toBe(false)
  })
  it('reads datetime-local input as a canonical UTC instant', () => {
    expect(utcInstant('')).toBeNull()
    expect(utcInstant('2026-10-24T06:30')).toBe('2026-10-24T06:30:00.000Z')
    expect(() => utcInstant('2026-02-30T00:00')).toThrow()
    expect(() => utcInstant('2026-10-24 06:30')).toThrow()
  })
  it('produces a syntactically valid standalone browser binding', () => {
    expect(() => new Function(ACCOUNT_FORWARDERS_CLIENT_BINDING)).not.toThrow()
  })
})

describe('forwarder human created dates preserve raw records and action targets', () => {
  it.each(['en', 'ar'] as const)('formats the visible date in %s without changing raw createdAt or delete identity', async lang => {
    const rawAt = '2026-10-27T11:01:02.123456+02:00'
    const value = { forwarders: [{ id: 'r-date', sourceAddress: 'date@tenant.test', action: 'forward', destinations: ['recipient@example.test'], createdAt: rawAt, application: applied }, { id: 'r-unread', sourceAddress: 'unread@tenant.test', action: 'forward', destinations: ['recipient@example.test'], application: applied }] }
    const original = JSON.stringify(value), previousLang = document.documentElement.lang
    const send = vi.fn(async (_method: string, _path: string, _body?: unknown) => value), ask = vi.fn(async (_options: Record<string, unknown>) => false)
    try {
      document.documentElement.lang = lang
      document.body.innerHTML = renderAccountForwarders({ lang, canManage: true, domains: [{ name: 'tenant.test' }] })
      ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
      new Function('return ' + ACCOUNT_FORWARDERS_CLIENT_BINDING)()(ask)
      await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0))
      const dates = [...document.querySelectorAll<HTMLElement>('[data-forwarder-rows] td:nth-child(3) bdi')]
      expect(dates[0]!.textContent).toBe('2026-10-27 09:01 UTC'); expect(dates[0]!.dir).toBe('ltr')
      expect(dates[1]!.textContent).toBe(lang === 'ar' ? 'لم تُقرأ البيانات' : 'Not read')
      expect(readForwarderRecords(value)[0]!.createdAt).toBe(rawAt)
      const remove = document.querySelector<HTMLButtonElement>('[data-forwarder-delete="r-date"]')!
      expect(remove.dataset.forwarderSource).toBe('date@tenant.test'); remove.click()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(ask).toHaveBeenCalledTimes(1); expect(ask.mock.calls[0]![0].body).toContain('date@tenant.test')
      expect(send.mock.calls.map(call => call[0])).toEqual(send.mock.calls.map(() => 'GET'))
      expect(send.mock.calls[0]).toEqual(['GET', '/api/mail/forwarders'])
      expect(JSON.stringify(value)).toBe(original)
    } finally {
      document.documentElement.lang = previousLang
      delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
      document.body.replaceChildren(); vi.restoreAllMocks()
    }
  })
})
