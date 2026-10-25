/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Script } from 'node:vm'
import { generateMailboxPassword, PASSWORD_GENERATOR_CLIENT_BINDING } from './password-generate-client.ts'

const input = () => document.getElementById('mailbox-password') as HTMLInputElement
const button = () => document.querySelector<HTMLButtonElement>('[data-password-generate]')!
const boot = (attributes = '') => {
  document.body.innerHTML = '<form data-mailbox-form ' + attributes + '><input id="mailbox-password" name="password" type="password" autocomplete="new-password" value="existing-draft"><button type="button" data-password-generate data-password-target="mailbox-password">Generate</button><p data-mailbox-status hidden></p></form>'
  new Function(PASSWORD_GENERATOR_CLIENT_BINDING)()
}
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; vi.restoreAllMocks() })

describe('local mailbox creation password generator', () => {
  it('emits standalone browser JavaScript', () => { expect(() => new Script(PASSWORD_GENERATOR_CLIENT_BINDING)).not.toThrow() })
  it('uses secure random bytes for a 24-character single-line password with every category', () => {
    const secure = vi.spyOn(globalThis.crypto, 'getRandomValues')
    const fallback = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('insecure fallback') })
    const value = generateMailboxPassword()
    expect(value).toHaveLength(24)
    for (const category of [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/]) expect(value).toMatch(category)
    expect(value).not.toMatch(/[\r\n\0]/); expect(secure).toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled()
  })
  it('rejects out-of-range bytes instead of introducing modulo bias', () => {
    let calls = 0
    const random = { getRandomValues: <T extends ArrayBufferView | null>(array: T): T => { (array as Uint8Array)[0] = calls++ === 0 ? 255 : 0; return array } }
    expect(generateMailboxPassword(random)).toHaveLength(24); expect(calls).toBeGreaterThan(47)
  })
  it('only fills the creation input and does not submit, send, store or log the value', () => {
    const network = vi.fn(); Object.assign(window, { xpanelSessionRequest: network })
    const store = vi.spyOn(Storage.prototype, 'setItem'); const log = vi.spyOn(console, 'log')
    boot(); const submit = vi.fn(); document.querySelector('form')!.addEventListener('submit', submit)
    button().click()
    expect(input().value).toHaveLength(24); expect(document.activeElement).toBe(input())
    expect(document.querySelector('[data-mailbox-status]')!.textContent).not.toContain(input().value)
    expect(submit).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled(); expect(store).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled()
  })
  it.each(['aria-disabled="true"', 'data-readonly="true"', 'data-read-only="true"', 'data-capability-unavailable="true"', 'data-wiring="unavailable"'])('keeps read-only form untouched: %s', attributes => {
    boot(attributes); button().click(); expect(input().value).toBe('existing-draft')
  })
  it('rejects a disabled control, disabled fieldset and read-only password', () => {
    boot(); button().disabled = true; button().dispatchEvent(new MouseEvent('click')); expect(input().value).toBe('existing-draft')
    button().disabled = false; input().readOnly = true; button().click(); expect(input().value).toBe('existing-draft')
    input().readOnly = false; document.querySelector('form')!.innerHTML = '<fieldset disabled>' + document.querySelector('form')!.innerHTML + '</fieldset>'
    delete button().dataset.passwordGenerateBound
    new Function(PASSWORD_GENERATOR_CLIENT_BINDING)(); button().dispatchEvent(new MouseEvent('click')); expect(input().value).toBe('existing-draft')
  })
  it('cannot target another form or an existing-account password-change dialog', () => {
    boot(); document.body.insertAdjacentHTML('beforeend', '<form><input id="other-password" name="password" type="password" autocomplete="new-password" value="untouched"></form>')
    button().dataset.passwordTarget = 'other-password'; button().click(); expect((document.getElementById('other-password') as HTMLInputElement).value).toBe('untouched')
    button().dataset.passwordTarget = 'mailbox-password'; document.querySelector('form')!.removeAttribute('data-mailbox-form'); button().click(); expect(input().value).toBe('existing-draft')
  })
  it('keeps the prior draft and explains a secure random failure without a fallback', () => {
    boot(); vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => { throw new Error('unavailable') }); button().click()
    expect(input().value).toBe('existing-draft'); expect(document.querySelector('[data-mailbox-status]')!.getAttribute('data-state')).toBe('failed')
  })
})
