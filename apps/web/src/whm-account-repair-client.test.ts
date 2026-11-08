// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmAccountRepair } from './board-port/whm-account-repair-workspace.ts'
import { WHM_ACCOUNT_REPAIR_CLIENT_BINDING, readAccountRepairPreview } from './whm-account-repair-client.ts'

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const request = vi.fn(async (_method: string, path: string, _body?: unknown): Promise<unknown> => path.endsWith('preview') ? { accounts: [{ username: 'alice', ownership: 'problem', sample: '/home/alice/<b>' }] } : { job: { id: 'job-1' }, rerender: 'applied' })
async function bind(ask: unknown = async () => true, canManage = true) {
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = renderWhmAccountRepair({ locale: 'en', canManage })
  ;(new Function('return ' + WHM_ACCOUNT_REPAIR_CLIENT_BINDING)() as (input: unknown) => void)(ask)
  await settle()
}
const type = (value: string) => { const input = $<HTMLInputElement>('[data-account-repair-accounts]'); input.value = value; input.dispatchEvent(new Event('input')) }
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); request.mockClear() })

describe('Account repair client', () => {
  it('stays inert without root', async () => { await bind(undefined, false); expect($<HTMLButtonElement>('[data-account-repair-preview]').disabled).toBe(true) })
  it('needs a preview of the same accounts before it can run', async () => {
    await bind(); type('alice'); expect($<HTMLButtonElement>('[data-account-repair-run]').disabled).toBe(true)
    $<HTMLButtonElement>('[data-account-repair-preview]').click(); await settle()
    expect($('[data-account-repair-rows]').textContent).toContain('Wrong ownership found'); expect($('[data-account-repair-rows] b')).toBeNull()
    expect($<HTMLButtonElement>('[data-account-repair-run]').disabled).toBe(false)
    type('alice bob'); expect($<HTMLButtonElement>('[data-account-repair-run]').disabled).toBe(true)
  })
  it('runs the chosen fixes after confirmation and names the job', async () => {
    const ask = vi.fn(async () => false); await bind(ask); type('alice'); $<HTMLButtonElement>('[data-account-repair-preview]').click(); await settle()
    $<HTMLButtonElement>('[data-account-repair-run]').click(); await settle()
    expect(request.mock.calls.some(call => call[1].endsWith('/run'))).toBe(false)
    ask.mockResolvedValue(true as never); $<HTMLButtonElement>('[data-account-repair-run]').click(); await settle()
    expect(request).toHaveBeenLastCalledWith('POST', '/api/accounts/repair/run', { accounts: ['alice'], fixes: ['ownership', 'rerender'] })
    expect($('[data-account-repair-status]').textContent).toContain('job-1'); expect($('[data-account-repair-status]').textContent).toContain('Configuration rebuilt')
  })
  it('refuses bad input without a request', async () => { await bind(); type('../x'); $<HTMLButtonElement>('[data-account-repair-preview]').click(); await settle(); expect(request).not.toHaveBeenCalled() })
  it('refuses a malformed preview', () => { expect(() => readAccountRepairPreview({ accounts: [{ username: 'a', ownership: 'fine', sample: null }] })).toThrow() })
})
