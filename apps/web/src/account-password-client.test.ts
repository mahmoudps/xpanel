// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_SELF_PASSWORD_MIN_LENGTH } from '@xpanel/core'
import { ACCOUNT_PASSWORD_CLIENT_BINDING, bindAccountPassword } from './account-password-client.ts'

const previous = 'Old-password-fixture-2026', desired = 'New-password-fixture-2026'
const element = <T extends Element>(selector: string, type: { new(...args: never[]): T }): T => {
  const found = document.querySelector(selector)
  if (!(found instanceof type)) throw new Error('missing_fixture_element:' + selector)
  return found
}
const form = () => element('[data-account-password-form]', HTMLFormElement)
const root = () => element('[data-account-password]', HTMLElement)
const status = () => element('[data-account-password-status]', HTMLElement)
const submit = () => element('[data-account-password-submit]', HTMLButtonElement)
const input = (name: string) => element('input[name="' + name + '"]', HTMLInputElement)
const settle = async () => { await Promise.resolve(); await Promise.resolve() }
const send = () => form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
const fill = () => { input('currentPassword').value = previous; input('newPassword').value = desired; input('confirmPassword').value = desired }
const deferred = <T>() => {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve(value: T) { if (!resolve) throw new Error('fixture_not_ready'); resolve(value) } }
}
const markup = () => '<section data-account-password data-account-password-can-change="true"><form data-account-password-form method="post" action="/api/auth/change-password">'
  + '<input type="password" name="currentPassword" required><p data-account-password-current-error hidden></p>'
  + '<input type="password" name="newPassword" minlength="' + ACCOUNT_SELF_PASSWORD_MIN_LENGTH + '" required><p data-account-password-new-error hidden></p>'
  + '<input type="password" name="confirmPassword" minlength="' + ACCOUNT_SELF_PASSWORD_MIN_LENGTH + '" required><p data-account-password-confirm-error hidden></p>'
  + '<button type="submit" data-account-password-submit>Change password</button></form>'
  + '<input type="checkbox" data-account-password-show><p data-account-password-status role="status"></p>'
  + '<li data-account-password-rule="length"><span data-account-password-rule-state></span></li><li data-account-password-rule="breach" data-state="unavailable"></li></section>'
const boot = (transport: (method: string, path: string, body?: unknown) => Promise<unknown>, navigation = vi.fn<(href: string) => void>()) => {
  ;(window as Window & { xpanelSessionRequest?: typeof transport }).xpanelSessionRequest = transport
  bindAccountPassword(navigation)
  return navigation
}

describe('independent account password binding', () => {
  beforeEach(() => {
    document.body.innerHTML = markup(); delete document.body.dataset.readonly
    document.documentElement.lang = 'en'
    delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('uses the shared transport and requires fresh sign-in without login-page DOM', { tags: ['feature'] }, async () => {
    document.documentElement.lang = 'ar'; fill()
    const transport = vi.fn(async () => ({ ok: true, reauthenticationRequired: true }))
    const navigation = boot(transport)
    expect(document.getElementById('login-password')).toBeNull()
    send(); await settle()
    expect(transport).toHaveBeenCalledExactlyOnceWith('POST', '/api/auth/change-password', { currentPassword: previous, newPassword: desired })
    expect(navigation).toHaveBeenCalledExactlyOnceWith('/login?lang=ar')
    expect(root().dataset.accountPasswordState).toBe('saved')
    expect(submit().disabled).toBe(true)
    for (const name of ['currentPassword', 'newPassword', 'confirmPassword']) expect(input(name).value).toBe('')
    expect(document.body.textContent).not.toContain(previous); expect(document.body.textContent).not.toContain(desired)
  })

  it('fails closed without transport, with missing authority, readonly ancestry or a handoff', { tags: ['feature'] }, async () => {
    for (const mode of ['no-transport', 'missing', 'denied', 'readonly', 'handoff']) {
      document.body.innerHTML = markup()
      if (mode === 'missing') root().removeAttribute('data-account-password-can-change')
      if (mode === 'denied') root().dataset.accountPasswordCanChange = 'false'
      if (mode === 'readonly') document.body.dataset.readonly = 'true'
      if (mode === 'handoff') document.body.insertAdjacentHTML('afterbegin', '<div data-impersonation></div>')
      const transport = vi.fn(async () => ({ ok: true, reauthenticationRequired: true }))
      if (mode === 'no-transport') bindAccountPassword()
      else boot(transport)
      fill(); expect(send()).toBe(false); await settle()
      expect(transport).not.toHaveBeenCalled(); expect(submit().disabled).toBe(true)
      expect(root().dataset.accountPasswordState).toBe('unavailable')
      delete document.body.dataset.readonly
      delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
    }
  })

  it('rejects mismatched and empty values before transport with owned inline errors', { tags: ['feature'] }, async () => {
    const transport = vi.fn(async () => ({ ok: true, reauthenticationRequired: true })); boot(transport)
    fill(); input('confirmPassword').value = desired + 'x'; send(); await settle()
    expect(transport).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('invalid')
    expect(input('confirmPassword').getAttribute('aria-invalid')).toBe('true')
    expect(element('[data-account-password-confirm-error]', HTMLElement).hidden).toBe(false)
    input('currentPassword').value = ''; send(); await settle()
    expect(transport).not.toHaveBeenCalled(); expect(input('currentPassword').getAttribute('aria-invalid')).toBe('true')
  })

  it('sends once while pending and permits another attempt only after a certain refusal', { tags: ['feature'] }, async () => {
    const reply = deferred<unknown>()
    const transport = vi.fn(() => reply.promise), navigate = boot(transport)
    fill(); send(); send(); expect(transport).toHaveBeenCalledTimes(1)
    expect(root().getAttribute('aria-busy')).toBe('true'); expect(submit().disabled).toBe(true)
    reply.resolve(Promise.reject({ status: 403, code: 'FORBIDDEN' })); await settle(); await settle()
    expect(status().dataset.state).toBe('failed'); expect(submit().disabled).toBe(false); expect(navigate).not.toHaveBeenCalled()
    for (const name of ['currentPassword', 'newPassword', 'confirmPassword']) expect(input(name).value).toBe('')
  })

  it('locks after an unknown outcome or malformed success and never retries or navigates', { tags: ['feature'] }, async () => {
    for (const payload of [{ ok: true }, { ok: false, reauthenticationRequired: true }, null]) {
      document.body.innerHTML = markup(); fill()
      const transport = vi.fn(async () => payload), navigate = boot(transport)
      send(); await settle(); fill(); send(); await settle()
      expect(transport).toHaveBeenCalledTimes(1); expect(status().dataset.state).toBe('uncertain')
      expect(submit().disabled).toBe(true); expect(navigate).not.toHaveBeenCalled()
    }
    document.body.innerHTML = markup(); fill()
    const transport = vi.fn(async () => { throw { status: 403, code: 'FORBIDDEN', details: { stateChanged: false, unknownOutcome: true } } })
    boot(transport); send(); await settle()
    expect(status().dataset.state).toBe('uncertain'); expect(submit().disabled).toBe(true)
  })

  it('does not submit after authority or shared transport changes and keeps show-password local', { tags: ['feature'] }, async () => {
    const transport = vi.fn(async () => ({ ok: true, reauthenticationRequired: true })); boot(transport)
    const show = element('[data-account-password-show]', HTMLInputElement)
    show.checked = true; show.dispatchEvent(new Event('change'))
    expect(input('currentPassword').type).toBe('text')
    root().dataset.accountPasswordCanChange = 'false'; fill(); send(); await settle()
    expect(transport).not.toHaveBeenCalled(); expect(submit().disabled).toBe(true)
    root().dataset.accountPasswordCanChange = 'true'
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = vi.fn()
    send(); await settle(); expect(transport).not.toHaveBeenCalled()
  })

  it('keeps the shared self-password minimum and length row truthful without inventing a breach provider', { tags: ['feature'] }, async () => {
    const transport = vi.fn(async () => ({ ok: true, reauthenticationRequired: true }))
    boot(transport)
    const rule = element('[data-account-password-rule="length"]', HTMLElement)
    expect(rule.dataset.state).toBe('unknown'); expect(rule.textContent).toBe('Not read')
    input('newPassword').value = 'short'; input('newPassword').dispatchEvent(new Event('input'))
    expect(rule.dataset.state).toBe('unmet'); expect(rule.textContent).toBe('Invalid')
    input('newPassword').value = desired; input('newPassword').dispatchEvent(new Event('input'))
    expect(rule.dataset.state).toBe('passed'); expect(rule.textContent).toBe('Valid')
    expect(element('[data-account-password-rule="breach"]', HTMLElement).dataset.state).toBe('unavailable')
    expect(input('newPassword').minLength).toBe(ACCOUNT_SELF_PASSWORD_MIN_LENGTH)
    fill(); input('newPassword').value = 'a'.repeat(ACCOUNT_SELF_PASSWORD_MIN_LENGTH - 1)
    input('confirmPassword').value = input('newPassword').value; send(); await settle()
    expect(transport).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('invalid')
    input('newPassword').value = 'a'.repeat(ACCOUNT_SELF_PASSWORD_MIN_LENGTH)
    input('confirmPassword').value = input('newPassword').value; send(); await settle()
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport).toHaveBeenCalledWith('POST', '/api/auth/change-password', { currentPassword: previous, newPassword: 'a'.repeat(ACCOUNT_SELF_PASSWORD_MIN_LENGTH) })
  })

  it('fails closed for malformed form ownership and never enables native submission', { tags: ['feature'] }, async () => {
    form().append(input('newPassword').cloneNode(true))
    const transport = vi.fn(async () => ({ ok: true, reauthenticationRequired: true })); boot(transport)
    expect(send()).toBe(false); await settle()
    expect(transport).not.toHaveBeenCalled(); expect(submit().disabled).toBe(true)
  })

  it('serializes the normal-page binding and binds each workspace only once', { tags: ['feature'] }, async () => {
    const transport = vi.fn(async () => ({ ok: true, reauthenticationRequired: true })), navigate = boot(transport)
    new Function('navigate', '(' + ACCOUNT_PASSWORD_CLIENT_BINDING + ')(navigate);')(navigate)
    fill(); send(); await settle()
    expect(transport).toHaveBeenCalledTimes(1); expect(navigate).toHaveBeenCalledTimes(1)
    expect(ACCOUNT_PASSWORD_CLIENT_BINDING).not.toContain('fetch(')
    expect(ACCOUNT_PASSWORD_CLIENT_BINDING).not.toContain('login-password')
  })

  it('does not inherit outer password authority for a nested workspace form', { tags: ['feature'] }, async () => {
    const outer = root(), captured = form(), nested = document.createElement('section')
    nested.setAttribute('data-account-password', ''); nested.dataset.accountPasswordCanChange = 'false'
    nested.append(captured); outer.insertBefore(nested, status())
    fill()
    const transport = vi.fn(async () => ({ ok: true, reauthenticationRequired: true }))
    const navigate = vi.fn<(href: string) => void>()
    ;(window as Window & { xpanelSessionRequest?: typeof transport }).xpanelSessionRequest = transport
    new Function('navigate', '(' + ACCOUNT_PASSWORD_CLIENT_BINDING + ')(navigate);')(navigate)
    captured.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
    expect(transport).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
    expect(outer.dataset.accountPasswordState).toBe('unavailable')
  })

  it('revalidates serialized form and control ownership after moves, replacements and form reassociation', { tags: ['feature'] }, async () => {
    for (const mode of ['form-moved', 'form-replaced', 'input-moved', 'input-replaced', 'submit-replaced', 'status-replaced', 'form-reassociated', 'show-moved']) {
      document.body.innerHTML = markup(); fill()
      const capturedForm = form(), capturedNext = input('newPassword'), capturedSubmit = submit(), capturedStatus = status()
      const capturedShow = element('[data-account-password-show]', HTMLInputElement)
      const transport = vi.fn(async () => ({ ok: true, reauthenticationRequired: true }))
      const navigate = vi.fn<(href: string) => void>()
      ;(window as Window & { xpanelSessionRequest?: typeof transport }).xpanelSessionRequest = transport
      new Function('navigate', '(' + ACCOUNT_PASSWORD_CLIENT_BINDING + ')(navigate);')(navigate)
      const foreign = document.createElement('section')
      foreign.setAttribute('data-account-password', ''); foreign.dataset.accountPasswordCanChange = 'false'
      document.body.append(foreign)
      if (mode === 'form-moved') foreign.append(capturedForm)
      if (mode === 'form-replaced') capturedForm.replaceWith(capturedForm.cloneNode(true))
      if (mode === 'input-moved') foreign.append(capturedNext)
      if (mode === 'input-replaced') capturedNext.replaceWith(capturedNext.cloneNode(true))
      if (mode === 'submit-replaced') capturedSubmit.replaceWith(capturedSubmit.cloneNode(true))
      if (mode === 'status-replaced') capturedStatus.replaceWith(capturedStatus.cloneNode(true))
      if (mode === 'show-moved') {
        capturedShow.checked = true; foreign.append(capturedShow)
        capturedShow.dispatchEvent(new Event('change')); expect(capturedShow.checked).toBe(true)
      }
      if (mode === 'form-reassociated') {
        const other = document.createElement('form'); other.id = 'foreign-password-form'; foreign.append(other)
        input('currentPassword').setAttribute('form', other.id)
      }
      capturedForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
      expect(transport, mode).not.toHaveBeenCalled(); expect(navigate, mode).not.toHaveBeenCalled()
      expect(root().dataset.accountPasswordState, mode).not.toBe('saved')
      if (mode === 'input-moved') expect(capturedNext.value).toBe(desired)
    }
  })

})
