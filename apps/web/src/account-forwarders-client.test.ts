// @vitest-environment jsdom
import { renderAccountForwarders } from './board-port/extensions/account-forwarders.ts'
import { describe, expect, it, vi } from 'vitest'
import { ACCOUNT_FORWARDERS_CLIENT_BINDING, forwarderConfigurationOnly, forwarderWriteUncertain, readForwarderConfigurations } from './account-forwarders-client.ts'

const application = { status: 'configuration_only', nativeApplied: false }
describe('forwarder application evidence and retry boundary', () => {
  it.each([undefined, {}, { application: { status: 'applied', nativeApplied: true } }, { application: { status: 'configuration_only' } }])('rejects unproved or native-success-shaped state %j', value => {
    expect(forwarderConfigurationOnly(value)).toBe(false)
    expect(() => readForwarderConfigurations(value)).toThrow()
  })
  it('preserves an authoritative empty read rather than substituting demo data', () => {
    expect(readForwarderConfigurations({ application, forwarders: [] })).toEqual([])
  })
  it('copies actual records and excludes account IDs from view data', () => {
    const result = readForwarderConfigurations({ application, forwarders: [{ id: 'r1', accountId: 'private', sourceAddress: 'a@tenant.test', destinations: ['b@recipient.test'] }] })
    expect(result).toEqual([{ id: 'r1', sourceAddress: 'a@tenant.test', destinations: ['b@recipient.test'] }])
  })
  it.each([undefined, 'not-an-array', [{ id: 'r1', sourceAddress: 'a@tenant.test', destinations: [] }], [{ id: 'r1', sourceAddress: 'a@tenant.test', destinations: [null] }]])('fails closed on malformed collection %j', forwarders => {
    expect(() => readForwarderConfigurations({ application, forwarders })).toThrow()
  })
  it.each([{ status: 409, unknownOutcome: true }, { status: 422, details: { stateChanged: true } }, { status: 403, verificationRequired: true }, { status: 400, details: { stateChanged: false, needsAttention: true } }, { status: 408 }, new Error('connection_lost')])('locks retries when the outcome may have changed %j', failure => {
    expect(forwarderWriteUncertain(failure)).toBe(true)
  })
  it.each([{ status: 422 }, { status: 409 }, { status: 503, details: { stateChanged: false } }])('permits correction after a definite refusal %j', failure => {
    expect(forwarderWriteUncertain(failure)).toBe(false)
  })
  it('produces a syntactically valid standalone browser binding', () => {
    expect(() => new Function(ACCOUNT_FORWARDERS_CLIENT_BINDING)).not.toThrow()
  })
})


describe('forwarder human created dates preserve raw records and action targets', () => {
  it.each(['en', 'ar'] as const)('formats the visible date in %s without changing raw createdAt or delete identity', async lang => {
    const rawAt = '2026-10-27T11:01:02.123456+02:00'
    const value = { application, forwarders: [{ id: 'r-date', sourceAddress: 'date@tenant.test', destinations: ['recipient@example.test'], createdAt: rawAt }, { id: 'r-unread', sourceAddress: 'unread@tenant.test', destinations: ['recipient@example.test'] }] }
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
      expect(readForwarderConfigurations(value)[0]!.createdAt).toBe(rawAt)
      const remove = document.querySelector<HTMLButtonElement>('[data-forwarder-delete="r-date"]')!
      expect(remove.dataset.forwarderSource).toBe('date@tenant.test'); remove.click()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(ask).toHaveBeenCalledTimes(1); expect(ask.mock.calls[0]![0].body).toContain('date@tenant.test')
      expect(send.mock.calls).toEqual([['GET', '/api/mail/forwarders']])
      expect(JSON.stringify(value)).toBe(original)
    } finally {
      document.documentElement.lang = previousLang
      delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
      document.body.replaceChildren(); vi.restoreAllMocks()
    }
  })
})
