// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderAcctConvertAddonWorkspace } from './board-port/acct-convert-addon.ts'
import { ACCT_CONVERT_ADDON_CLIENT_BINDING, readConvertAddonCandidates, readConvertAddonReview } from './acct-convert-addon-client.ts'

const id = (value: number) => 'bbbbbbbb-bbbb-4bbb-8bbb-' + String(value).padStart(12, '0')
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const candidates = (apply = false) => ({ candidates: [{ domainId: id(1), domain: 'shop.example.test', docRoot: '/home/alice/shop.example.test', account: { id: id(5), username: 'alice', status: 'active' } }], plans: [{ id: id(4), name: 'gold' }], capabilities: { preview: true, apply, reason: 'atomic-ownership-move-unavailable' } })
const preview = (conflicts: { kind: string; value: string }[] = []) => ({ revision: 'c'.repeat(64), capabilities: candidates().capabilities, plan: {
  source: { accountId: id(5), username: 'alice', domainId: id(1), domain: 'shop.example.test', docRoot: '/home/alice/shop.example.test' },
  target: { username: 'shop', planId: id(4), planName: 'gold', home: '/home/shop', documentRoot: '/home/shop/public_html' },
  domains: [{ id: id(1), name: 'shop.example.test', kind: 'addon', docRoot: '/home/alice/shop.example.test' }], mail: { mailboxes: ['info@shop.example.test'], otherServiceUsers: [] },
  dns: [{ zone: 'shop.example.test', records: 3 }], certificates: 1, conflicts } })
const q = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
const boot = (send: (method: string, path: string, body?: unknown) => Promise<unknown>, canManage = true) => {
  document.body.innerHTML = renderAcctConvertAddonWorkspace({ locale: 'en', canManage })
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  const ask = vi.fn(async () => true)
  new Function('return ' + ACCT_CONVERT_ADDON_CLIENT_BINDING)()(ask)
  return ask
}
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('addon conversion readers', () => {
  it('accept the server shapes and refuse unknown conflicts or malformed ids', () => {
    expect(readConvertAddonCandidates(candidates()).candidates).toHaveLength(1)
    expect(readConvertAddonReview(preview()).plan.target.home).toBe('/home/shop')
    expect(() => readConvertAddonCandidates({ ...candidates(), plans: [{ id: 'x', name: 'gold' }] })).toThrow()
    expect(() => readConvertAddonReview(preview([{ kind: 'guess', value: 'x' }]))).toThrow()
    expect(() => readConvertAddonReview({ ...preview(), revision: 'x' })).toThrow()
  })
})

describe('addon conversion workspace', () => {
  it('reviews what moves and keeps converting disabled while the server reports it unavailable', async () => {
    const send = vi.fn(async (method: string) => method === 'GET' ? candidates() : preview())
    boot(send); await tick()
    expect(q<HTMLSelectElement>('[data-acct-convert-input="domainId"]').value).toBe(id(1))
    expect(q<HTMLElement>('[data-acct-convert-capability]').textContent).toMatch(/unavailable on this server/)
    q<HTMLInputElement>('[data-acct-convert-input="username"]').value = 'shop'
    q<HTMLFormElement>('[data-acct-convert-form]').requestSubmit(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/transfers/convert-addon/preview', { domainId: id(1), username: 'shop', planId: id(4) })
    expect(q<HTMLElement>('[data-acct-convert-review-status]').dataset.state).toBe('read')
    expect(q<HTMLElement>('[data-acct-convert-rows="mail"]').textContent).toContain('info@shop.example.test')
    expect(q<HTMLElement>('[data-acct-convert-facts]').textContent).toContain('/home/shop/public_html')
    expect(q<HTMLInputElement>('[data-acct-convert-input="confirm"]').disabled).toBe(true)
    expect(q<HTMLButtonElement>('[data-acct-convert-apply]').disabled).toBe(true)
  })
  it('requires a fresh review after edits and the exact confirmation when converting is available', async () => {
    const send = vi.fn(async (method: string, path: string) => method === 'GET' ? candidates(true) : path.endsWith('/preview') ? preview() : Promise.reject({ status: 412, details: { stateChanged: false } }))
    boot(send); await tick()
    q<HTMLInputElement>('[data-acct-convert-input="username"]').value = 'shop'
    q<HTMLFormElement>('[data-acct-convert-form]').requestSubmit(); await tick()
    const confirm = q<HTMLInputElement>('[data-acct-convert-input="confirm"]'), apply = q<HTMLButtonElement>('[data-acct-convert-apply]')
    confirm.value = 'convert shop'; confirm.dispatchEvent(new Event('input')); expect(apply.disabled).toBe(true)
    confirm.value = 'convert shop.example.test'; confirm.dispatchEvent(new Event('input')); expect(apply.disabled).toBe(false)
    const user = q<HTMLInputElement>('[data-acct-convert-input="username"]'); user.value = 'shop2'; user.dispatchEvent(new Event('input'))
    expect(apply.disabled).toBe(true); expect(q<HTMLElement>('[data-acct-convert-review-status]').dataset.state).toBe('stale')
    user.value = 'shop'; user.dispatchEvent(new Event('input')); expect(apply.disabled).toBe(false)
    apply.click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/transfers/convert-addon/apply', { domainId: id(1), username: 'shop', planId: id(4), expectedRevision: 'c'.repeat(64), confirm: 'convert shop.example.test' })
    expect(q<HTMLElement>('[data-acct-convert-review-status]').textContent).toMatch(/refused the conversion. Nothing was changed/)
  })
  it('reports a verified conversion, and a rolled-back one without claiming success', async () => {
    const done = { converted: true, conversion: id(9), account: { id: id(8), username: 'shop', primaryDomain: 'shop.example.test' }, moved: { domains: ['shop.example.test'], serviceUsers: [], zones: [], certificates: 0 }, files: { files: 12, bytes: 4096, digest: 'd'.repeat(64) }, sourceCleanup: 'moved-to-trash', passwordResetRequired: true }
    for (const [outcome, state, text] of [[() => done, 'done', /12 files were copied and read back, and the old copies are in the trash of alice/], [() => ({ converted: true }), 'uncertain', /could not be verified/],
      [() => Promise.reject({ status: 412, details: { stateChanged: true, rolledBack: true } }), 'uncertain', /saved settings were restored/]] as const) {
      document.body.innerHTML = ''
      const send = vi.fn(async (method: string, path: string) => method === 'GET' ? candidates(true) : path.endsWith('/preview') ? preview() : outcome())
      boot(send); await tick()
      q<HTMLInputElement>('[data-acct-convert-input="username"]').value = 'shop'
      q<HTMLFormElement>('[data-acct-convert-form]').requestSubmit(); await tick()
      const confirm = q<HTMLInputElement>('[data-acct-convert-input="confirm"]')
      confirm.value = 'convert shop.example.test'; confirm.dispatchEvent(new Event('input'))
      q<HTMLButtonElement>('[data-acct-convert-apply]').click(); await tick()
      expect(q<HTMLElement>('[data-acct-convert-review-status]').dataset.state).toBe(state)
      expect(q<HTMLElement>('[data-acct-convert-review-status]').textContent).toMatch(text)
    }
  })
  it('lists conflicts and refuses a malformed username before sending', async () => {
    const send = vi.fn(async (method: string) => method === 'GET' ? candidates(true) : preview([{ kind: 'username-taken', value: 'shop' }]))
    boot(send); await tick()
    q<HTMLInputElement>('[data-acct-convert-input="username"]').value = 'Shop!'
    q<HTMLFormElement>('[data-acct-convert-form]').requestSubmit(); await tick()
    expect(send).toHaveBeenCalledTimes(1)
    q<HTMLInputElement>('[data-acct-convert-input="username"]').value = 'shop'
    q<HTMLFormElement>('[data-acct-convert-form]').requestSubmit(); await tick()
    expect(q<HTMLElement>('[data-acct-convert-rows="conflicts"]').textContent).toContain('already in use')
    expect(q<HTMLInputElement>('[data-acct-convert-input="confirm"]').disabled).toBe(true)
  })
  it('shows empty, failed and denied states truthfully', async () => {
    boot(vi.fn(async () => ({ ...candidates(), candidates: [] }))); await tick()
    expect(q<HTMLElement>('[data-acct-convert-empty]').hidden).toBe(false)
    expect(q<HTMLElement>('[data-acct-convert-status]').dataset.state).toBe('empty')
    boot(vi.fn(async () => { throw { status: 503 } })); await tick()
    expect(q<HTMLElement>('[data-acct-convert-status]').dataset.state).toBe('failed')
    const send = vi.fn(async () => candidates())
    boot(send, false); await tick()
    expect(send).not.toHaveBeenCalled(); expect(q<HTMLElement>('[data-acct-convert-status]').dataset.state).toBe('denied')
  })
})
