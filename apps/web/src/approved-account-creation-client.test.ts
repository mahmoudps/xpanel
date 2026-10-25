/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Script } from 'node:vm'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'

const planId = '10000000-0000-4000-8000-000000000001'
const ownerId = '10000000-0000-4000-8000-000000000002'
type Request = (method: string, path: string, body?: Record<string, unknown>) => Promise<unknown>
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const get = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
let listeners: [EventTarget, string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][]
beforeEach(() => {
  listeners = []
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target)
    vi.spyOn(target, 'addEventListener').mockImplementation((name, callback, options) => { listeners.push([target, name, callback, options]); add(name, callback, options) })
  }
  document.documentElement.lang = 'en'; document.documentElement.dataset.realtimeEnabled = 'false'
})
afterEach(() => {
  for (const [target, name, callback, options] of listeners) target.removeEventListener(name, callback, options)
  document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest; vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const previewResponse = () => {
  let sent = false
  const bytes = new TextEncoder().encode(JSON.stringify({ scope: 'desired-state', hostBinding: 'unverified', defaultSharedIpv4: { poolId: planId, address: '192.0.2.10' }, dedicated: { entitled: false, count: 0, unallocated: [] } }))
  return { ok: true, body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }), cancel: async () => {}, releaseLock: () => {} }) } }
}
const boot = (send: Request, withChoices = true) => {
  const choice = withChoices ? '<input type="radio" name="ownerId" value="" checked><input type="radio" name="ownerId" value="' + ownerId + '"><input type="radio" name="shell" value="jailed" checked><input type="radio" name="shell" value="none">' : ''
  document.body.innerHTML = '<section data-accounts-workspace><form data-create-account-form><input name="username" value="alpha"><input name="primaryDomain" value="alpha.example.test"><input id="new-acc-password" type="password" name="password" autocomplete="new-password" value="synthetic-initial-password"><input name="contactEmail" value=""><input name="ipv6" value=""><select name="planId"><option value="' + planId + '">Standard</option></select><select name="ipAssignment"><option value="shared">Shared</option></select>' + choice + '<button type="button" data-account-ip-refresh>Refresh</button><button type="button" data-account-generate-password data-password-target="new-acc-password">Generate</button><button type="button" data-account-toggle-password data-password-target="new-acc-password" aria-pressed="false">Reveal password</button><p data-account-ip-status></p><p><bdi data-account-ip-address></bdi></p><p data-account-create-status tabindex="-1"></p><button type="submit">Create</button><button type="reset">Discard</button></form><section data-approved-account-create-status><p data-account-creation-observation></p><button type="button" disabled data-account-create-another data-create-route="/whm/accounts/new?lang=en&amp;theme=dark&amp;density=comfortable">Create another</button></section></section>'
  ;(window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest = send
  const fetch = vi.fn().mockImplementation(async () => previewResponse()); vi.stubGlobal('fetch', fetch)
  new Function('window', 'document', BROWSER_REALTIME_SCRIPT)(window, document)
  return fetch
}
const submit = () => get<HTMLFormElement>('form').dispatchEvent(new Event('submit', { cancelable: true }))
const refusal = { status: 412, details: { stateChanged: false } }

describe('approved new-account controls in the complete client', () => {
  it('emits valid whole-script JavaScript', () => { expect(() => new Script(BROWSER_REALTIME_SCRIPT)).not.toThrow() })
  it('sends checked owner/shell only and scopes a refreshed IP preview to that owner', async () => {
    let body: Record<string, unknown> = {}
    const send = vi.fn<Request>().mockImplementation(async (_method, _path, payload) => { body = { ...payload }; throw refusal })
    const fetch = boot(send); await tick()
    get<HTMLInputElement>('input[name="ownerId"][value="' + ownerId + '"]').checked = true
    get<HTMLInputElement>('input[name="ownerId"][value="' + ownerId + '"]').dispatchEvent(new Event('change')); await tick()
    get<HTMLInputElement>('input[name="shell"][value="none"]').checked = true
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/ips?view=allocation&planId=' + planId + '&ownerId=' + ownerId)
    submit(); submit(); await tick()
    expect(send).toHaveBeenCalledTimes(1); expect(body.ownerId).toBe(ownerId); expect(body.shell).toBe('none'); expect(body.ipAssignment).toEqual({ mode: 'shared' })
    expect(get<HTMLInputElement>('[name="password"]').value).toBe('')
    expect(get<HTMLInputElement>('input[name="ownerId"]:checked').value).toBe(ownerId)
  })
  it('preserves the older payload when no owner/shell controls exist', async () => {
    let body: Record<string, unknown> = {}
    const send = vi.fn<Request>().mockImplementation(async (_method, _path, payload) => { body = { ...payload }; throw refusal })
    const fetch = boot(send, false); await tick(); submit(); await tick()
    expect(body).not.toHaveProperty('ownerId'); expect(body).not.toHaveProperty('shell')
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/ips?view=allocation&planId=' + planId)
  })
  it('rejects invalid or unavailable checked owner/shell controls before POST', async () => {
    const send = vi.fn<Request>(); boot(send); await tick()
    const selected = get<HTMLInputElement>('input[name="ownerId"]:checked'); selected.value = 'not-authorized-id'; submit(); await tick(); expect(send).not.toHaveBeenCalled()
    selected.value = ''; get<HTMLInputElement>('input[name="shell"]:checked').disabled = true; submit(); await tick(); expect(send).not.toHaveBeenCalled()
  })
  it('omits fully disabled new option groups instead of issuing their values', async () => {
    let body: Record<string, unknown> = {}
    const send = vi.fn<Request>().mockImplementation(async (_method, _path, payload) => { body = { ...payload }; throw refusal }); boot(send); await tick()
    document.querySelectorAll<HTMLInputElement>('[name="ownerId"],[name="shell"]').forEach(field => { field.disabled = true })
    submit(); await tick()
    expect(send).toHaveBeenCalledTimes(1); expect(body).not.toHaveProperty('ownerId'); expect(body).not.toHaveProperty('shell')
  })
  it('does not create through an explicitly unavailable form even if its button was enabled', async () => {
    const send = vi.fn<Request>(); boot(send); await tick()
    get('form').setAttribute('data-capability-unavailable', 'true'); submit(); await tick(); expect(send).not.toHaveBeenCalled()
  })
  it('uses the same local secure generator only for the new-account password without sending', async () => {
    const send = vi.fn<Request>(); const fetch = boot(send); await tick(); fetch.mockClear()
    get('[data-account-generate-password]').click()
    const value = get<HTMLInputElement>('#new-acc-password').value
    expect(value).toHaveLength(24); expect(value).toMatch(/[A-Z]/); expect(value).toMatch(/[a-z]/); expect(value).toMatch(/[0-9]/); expect(value).toMatch(/[^a-zA-Z0-9]/)
    expect(send).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    expect(get('[data-account-create-status]').textContent).not.toContain(value)
  })
  it('reveals, generates and hides only the new-account password without a request', async () => {
    const send = vi.fn<Request>(); const fetch = boot(send); await tick(); fetch.mockClear()
    const reveal = get<HTMLButtonElement>('[data-account-toggle-password]'), password = get<HTMLInputElement>('#new-acc-password')
    const original = password.value
    reveal.click(); expect(password.type).toBe('text'); expect(password.value).toBe(original); expect(reveal.getAttribute('aria-pressed')).toBe('true'); expect(reveal.textContent).toBe('Hide password')
    get('[data-account-generate-password]').click(); const generated = password.value; expect(generated).toHaveLength(24)
    reveal.click(); expect(password.type).toBe('password'); expect(password.value).toBe(generated); expect(reveal.getAttribute('aria-pressed')).toBe('false')
    password.readOnly = true; reveal.click(); get('[data-account-generate-password]').click(); expect(password.type).toBe('password'); expect(password.value).toBe(generated)
    expect(fetch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
  })
  it('enables Create another only after a verified creation acknowledgement', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ account: { username: 'alpha', ipv4: '192.0.2.10', ownerId: null, shell: 'jailed' }, reconcile: { status: 'applied' }, execution: { status: 'configuration_applied', scope: 'global_configuration', targetVerified: false, verificationRequired: true } })
    boot(send); await tick(); expect(get<HTMLButtonElement>('[data-account-create-another]').disabled).toBe(true)
    submit(); await tick(); expect(get<HTMLButtonElement>('[data-account-create-another]').disabled).toBe(false)
    expect(get('[data-account-create-status]').textContent).toContain('Hosting verification is still required')
    expect(get<HTMLButtonElement>('[data-account-generate-password]').disabled).toBe(true); expect(get<HTMLButtonElement>('[data-account-toggle-password]').disabled).toBe(true)
  })
  it.each([{ status: 412, details: { stateChanged: false } }, { status: 409, unknownOutcome: true }])('keeps Create another disabled before a verified result: %j', async error => {
    const send = vi.fn<Request>().mockRejectedValue(error); boot(send); await tick(); submit(); await tick()
    expect(get<HTMLButtonElement>('[data-account-create-another]').disabled).toBe(true)
  })
  it('discards only a local draft and refreshes the owner-specific IP context', async () => {
    const send = vi.fn<Request>(); const fetch = boot(send); await tick()
    const owner = get<HTMLInputElement>('input[name="ownerId"][value="' + ownerId + '"]'); owner.checked = true; owner.dispatchEvent(new Event('change')); await tick()
    get<HTMLInputElement>('[name="username"]').value = 'edited'
    get<HTMLFormElement>('form').reset(); await tick()
    expect(get<HTMLInputElement>('[name="username"]').value).toBe('alpha'); expect(get<HTMLInputElement>('input[name="ownerId"]:checked').value).toBe('')
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/ips?view=allocation&planId=' + planId); expect(send).not.toHaveBeenCalled()
  })
  it('locks an explicit unknown outcome even when a refusal carries stateChanged false', async () => {
    const send = vi.fn<Request>().mockRejectedValue({ status: 409, unknownOutcome: true, details: { stateChanged: false } }); boot(send); await tick()
    submit(); await tick(); submit(); await tick()
    expect(send).toHaveBeenCalledTimes(1); expect(get<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true)
  })
  it('does not accept a response that changed the submitted owner or shell', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ account: { username: 'alpha', ipv4: '192.0.2.10', ownerId, shell: 'none' }, reconcile: { status: 'applied' }, execution: { status: 'configuration_applied', scope: 'global_configuration', targetVerified: false, verificationRequired: true } })
    boot(send); await tick(); submit(); await tick()
    expect(get('[data-account-create-status]').textContent).toContain('could not be verified'); expect(get<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true)
  })
})
