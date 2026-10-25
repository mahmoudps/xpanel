/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Script } from 'node:vm'
import { APPROVED_HOST_SERVICES_CLIENT } from './approved-host-services-client.ts'
type Request = (method: string, path: string, body?: unknown) => Promise<unknown>
const service = { id: 'apache', label: 'Apache', unit: 'apache2.service', state: 'active' }
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const button = () => document.querySelector<HTMLButtonElement>('button[data-service-id]')!
const status = () => document.querySelector<HTMLElement>('[data-host-service-status]')!
const boot = (send: Request, confirm = vi.fn().mockResolvedValue(true), attributes = '') => {
  document.body.innerHTML = '<section data-host-services ' + attributes + '><table><tbody data-host-service-rows></tbody></table><p data-host-service-status></p></section>'
  ;(window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest = send
  new Function('confirm', '(' + APPROVED_HOST_SERVICES_CLIENT + ')(confirm);')(confirm)
  return confirm
}
beforeEach(() => { document.documentElement.lang = 'en' })
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest; vi.restoreAllMocks() })

describe('confirmed native service restart', () => {
  it('emits standalone JavaScript', () => { expect(() => new Script('(' + APPROVED_HOST_SERVICES_CLIENT + ')();')).not.toThrow() })
  it('cancels before POST and restores the control', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ services: [service] }); const confirm = boot(send, vi.fn().mockResolvedValue(null)); await tick()
    button().click(); await tick()
    expect(confirm).toHaveBeenCalledTimes(1); expect(send.mock.calls).toEqual([['GET', '/api/server/services']]); expect(button().disabled).toBe(false); expect(status().dataset.state).toBe('cancelled')
  })
  it('blocks duplicate confirmation and submits only once before checking active readback', async () => {
    let done!: (value: boolean) => void
    const send = vi.fn<Request>().mockResolvedValueOnce({ services: [service] }).mockResolvedValueOnce({ service }).mockResolvedValueOnce({ services: [service] })
    const confirm = boot(send, vi.fn().mockImplementation(() => new Promise(resolve => { done = resolve }))); await tick()
    button().click(); button().dispatchEvent(new MouseEvent('click')); expect(confirm).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1)
    done(true); await tick()
    expect(send.mock.calls).toEqual([['GET', '/api/server/services'], ['POST', '/api/server/services/apache/restart', {}], ['GET', '/api/server/services']])
    expect(status().dataset.state).toBe('active'); expect(button().disabled).toBe(false)
  })
  it.each([{ status: 503 }, { status: 409, unknownOutcome: true, details: { stateChanged: false } }])('locks uncertain restart outcomes: %j', async error => {
    const send = vi.fn<Request>().mockResolvedValueOnce({ services: [service] }).mockRejectedValueOnce(error); boot(send); await tick(); button().click(); await tick(); button().dispatchEvent(new MouseEvent('click')); await tick()
    expect(send).toHaveBeenCalledTimes(2); expect(button().disabled).toBe(true); expect(status().dataset.state).toBe('uncertain')
  })
  it('permits correction after a definite refusal without claiming restart', async () => {
    const send = vi.fn<Request>().mockResolvedValueOnce({ services: [service] }).mockRejectedValueOnce({ status: 403, details: { stateChanged: false } }); boot(send); await tick(); button().click(); await tick()
    expect(button().disabled).toBe(false); expect(status().dataset.state).toBe('failed'); expect(status().textContent).not.toContain('completed')
  })
  it('keeps review required after a successful POST followed by a readback refusal', async () => {
    const send = vi.fn<Request>().mockResolvedValueOnce({ services: [service] }).mockResolvedValueOnce({ service }).mockRejectedValueOnce({ status: 403, details: { stateChanged: false } }); boot(send); await tick(); button().click(); await tick()
    expect(button().disabled).toBe(true); expect(status().dataset.state).toBe('uncertain')
  })
  it('does not claim an active restart for mismatched or inactive receipts', async () => {
    const send = vi.fn<Request>().mockResolvedValueOnce({ services: [service] }).mockResolvedValueOnce({ service: { ...service, state: 'inactive' } }); boot(send); await tick(); button().click(); await tick()
    expect(status().dataset.state).toBe('uncertain'); expect(send).toHaveBeenCalledTimes(2)
  })
  it('does not read or mutate an unavailable service component', async () => {
    const send = vi.fn<Request>(); boot(send, vi.fn(), 'data-capability-unavailable="true"'); await tick(); expect(send).not.toHaveBeenCalled(); expect(button()).toBeNull()
  })
})
