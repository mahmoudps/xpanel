import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { LOGIN_CLIENT_SCRIPT } from './login-client.ts'

class Element {
  attrs = new Map<string, string>()
  hidden = false
  disabled = false
  value = ''
  textContent = ''
  focused = false
  listeners = new Map<string, (event: unknown) => Promise<void> | void>()
  setAttribute(name: string, value: string) { this.attrs.set(name, value) }
  getAttribute(name: string) { return this.attrs.get(name) ?? null }
  focus() { this.focused = true }
  addEventListener(name: string, handler: (event: unknown) => Promise<void> | void) { this.listeners.set(name, handler) }
}

const harness = (options: { disabled?: boolean; state?: string; ar?: boolean } = {}) => {
  const shell = new Element(); shell.setAttribute('data-auth-state', options.state ?? 'credentials'); shell.setAttribute('data-login-audience', 'xwhm')
  const submit = new Element(), error = new Element(), status = new Element(), fields = new Element(), otpGroup = new Element(), recoveryGroup = new Element(), toggle = new Element()
  fields.hidden = true; fields.setAttribute('data-2fa-step', 'unknown'); recoveryGroup.hidden = true
  const inputs = Object.fromEntries(['username', 'password', 'totpCode', 'recoveryCode'].map(name => [name, new Element()]))
  inputs.username!.value = 'test-administrator'; inputs.password!.value = 'synthetic-password'
  const login = Object.assign(new Element(), {
    reportValidity: () => true,
    querySelector: (selector: string) => inputs[/^\[name="([^"]+)"\]$/.exec(selector)?.[1] ?? ''] ?? null,
    querySelectorAll: () => [submit],
  })
  const selectors: Record<string, Element> = {
    '[data-auth-state]': shell, '[data-login-form]': login, '[data-auth-error]': error, '[data-auth-status]': status,
    '[data-auth-mfa-fields]': fields, '[data-login-factor="totp"]': otpGroup, '[data-login-factor="recovery"]': recoveryGroup, '[data-login-factor-toggle]': toggle,
  }
  const listeners = new Map<string, (event: unknown) => Promise<void> | void>()
  const requests: Array<{ method: string; url: string; body?: string }> = []
  const responses: Array<{ status: number; body: unknown }> = []
  const destinations: string[] = []
  const window = { location: { href: 'https://whm.example.test:2087/login', origin: 'https://whm.example.test:2087', assign: (url: string) => destinations.push(url), reload: () => undefined } }
  runInNewContext(LOGIN_CLIENT_SCRIPT, {
    document: {
      documentElement: { lang: options.ar ? 'ar' : 'en', dir: options.ar ? 'rtl' : 'ltr', getAttribute: () => options.disabled ? 'disabled' : 'optional' },
      querySelector: (selector: string) => selectors[selector] ?? null,
      querySelectorAll: () => [inputs.password, inputs.totpCode, inputs.recoveryCode],
      getElementById: (id: string) => ({ 'login-otp': inputs.totpCode, 'login-recovery-code': inputs.recoveryCode, 'login-password': inputs.password }[id] ?? null),
      addEventListener: (name: string, handler: (event: unknown) => Promise<void> | void) => listeners.set(name, handler),
    },
    window, URL, Date, AbortController, setTimeout: () => 1, clearTimeout: () => undefined,
    fetch: async (url: string, init: { method: string; body?: string }) => {
      requests.push({ method: init.method, url, body: init.body })
      const response = responses.shift() ?? { status: 500, body: { message: 'unexpected test request' } }
      return { status: response.status, ok: response.status >= 200 && response.status < 300, json: async () => response.body }
    },
  })
  const send = async () => login.listeners.get('submit')!({ preventDefault() {} })
  const click = async (action: string) => {
    const button = new Element();button.setAttribute('data-action', action)
    await listeners.get('click')!({ preventDefault() {}, target: { closest: () => button } })
  }
  const challenge = async () => {
    responses.push({ status: 401, body: { message: 'two-factor verification is required', details: { mfaRequired: true } } })
    await send()
  }
  return { shell, login, fields, inputs, otpGroup, recoveryGroup, toggle, requests, responses, destinations, error, status, send, click, challenge }
}

describe('approved factor selectors use the real challenge flow', () => {
  it('opens the challenge only after the actual server response and clears the hidden factor on each toggle', async () => {
    const h = harness()
    expect(h.fields.hidden).toBe(true)
    await h.challenge()
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]?.url).toBe('https://whm.example.test:2087/api/auth/login')
    expect(h.shell.getAttribute('data-auth-state')).toBe('mfa-required')
    expect(h.fields.hidden).toBe(false)
    expect(h.fields.getAttribute('data-2fa-step')).toBe('required')
    h.inputs.totpCode!.value = '123456'
    await h.click('toggle-login-factor')
    expect(h.inputs.totpCode!.value).toBe('')
    expect(h.otpGroup.hidden).toBe(true)
    expect(h.recoveryGroup.hidden).toBe(false)
    expect(h.inputs.recoveryCode!.focused).toBe(true)
    expect(h.toggle.getAttribute('aria-pressed')).toBe('true')
    expect(h.toggle.textContent).toBe('Use an authenticator code')
    h.inputs.recoveryCode!.value = 'synthetic-recovery-code'
    await h.click('toggle-login-factor')
    expect(h.inputs.recoveryCode!.value).toBe('')
    expect(h.otpGroup.hidden).toBe(false)
    expect(h.recoveryGroup.hidden).toBe(true)
    expect(h.toggle.getAttribute('aria-pressed')).toBe('false')
    expect(h.requests).toHaveLength(1)
    expect(h.destinations).toEqual([])
  })

  it('returns to credentials without granting a session or changing the listener audience', async () => {
    const h = harness();await h.challenge()
    h.inputs.totpCode!.value = '123456';h.inputs.recoveryCode!.value = 'synthetic-recovery-code'
    await h.click('change-login-credentials')
    expect(h.shell.getAttribute('data-auth-state')).toBe('credentials')
    expect(h.shell.getAttribute('data-login-audience')).toBe('xwhm')
    expect(h.fields.hidden).toBe(true)
    expect(h.fields.getAttribute('data-2fa-step')).toBe('unknown')
    for (const name of ['password','totpCode','recoveryCode']) expect(h.inputs[name]!.value).toBe('')
    expect(h.inputs.username!.value).toBe('test-administrator')
    expect(h.inputs.username!.focused).toBe(true)
    expect(h.requests).toHaveLength(1)
    expect(h.destinations).toEqual([])
  })

  it.each(['locked', 'authenticated', 'password-change-required'])('does not reset %s or let the display controls bypass it', async state => {
    const h = harness();h.shell.setAttribute('data-auth-state', state)
    h.inputs.totpCode!.value = '123456'
    await h.click('change-login-credentials');await h.click('toggle-login-factor')
    expect(h.shell.getAttribute('data-auth-state')).toBe(state)
    expect(h.inputs.password!.value).toBe('synthetic-password')
    expect(h.inputs.totpCode!.value).toBe('123456')
    expect(h.requests).toEqual([])
    expect(h.destinations).toEqual([])
  })

  it('leaves an in-flight authentication request untouched', async () => {
    const h = harness({ state:'mfa-required' });h.login.setAttribute('aria-busy','true');h.inputs.totpCode!.value='123456'
    await h.click('change-login-credentials');await h.click('toggle-login-factor')
    expect(h.shell.getAttribute('data-auth-state')).toBe('mfa-required')
    expect(h.login.getAttribute('aria-busy')).toBe('true')
    expect(h.inputs.totpCode!.value).toBe('123456')
    expect(h.requests).toEqual([])
  })

  it('still refuses simultaneous factor values before making any further request', async () => {
    const h = harness();await h.challenge();h.inputs.totpCode!.value='123456';h.inputs.recoveryCode!.value='synthetic-recovery-code'
    await h.send()
    expect(h.requests).toHaveLength(1)
    expect(h.error.textContent).toBe('Enter either an authenticator code or one recovery code.')
    expect(h.shell.getAttribute('data-auth-state')).toBe('mfa-required')
  })

  it('does not reopen factors when the trusted development policy disables them', async () => {
    const h = harness({ disabled:true });await h.challenge()
    expect(h.fields.hidden).toBe(true)
    expect(h.shell.getAttribute('data-auth-state')).toBe('credentials')
    await h.click('toggle-login-factor')
    expect(h.fields.hidden).toBe(true)
    expect(h.requests).toHaveLength(1)
  })

  it('localizes the recovery selector independently of authentication', async () => {
    const h = harness({ ar:true });await h.challenge();await h.click('toggle-login-factor')
    expect(h.toggle.textContent).toBe('استخدم رمز تطبيق المصادقة')
    await h.click('toggle-login-factor')
    expect(h.toggle.textContent).toBe('استخدم رمز استرداد')
    expect(h.destinations).toEqual([])
  })
})
