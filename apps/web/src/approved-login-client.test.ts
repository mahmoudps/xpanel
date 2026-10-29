// @vitest-environment jsdom
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { LOGIN_CLIENT_SCRIPT } from './login-client.ts'
import { translator, type MessageValues } from './i18n.ts'
import { renderLoginSurface } from './surfaces/login.ts'

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
    // The page's client translator follows the document language.
    xpT: (message: string, values?: MessageValues) => translator(options.ar ? 'ar' : 'en')(message, values),
    msgid, msgctxt,
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

describe('server lockout timestamp presentation', () => {
  it.each([
    { name: 'client clock behind', skew: -300000, deadline: '2030-02-03T04:05:06.789Z', display: '2030-02-03 04:05 UTC', delay: 3900000 },
    { name: 'client clock ahead', skew: 300000, deadline: '2030-02-03T04:05:06.789Z', display: '2030-02-03 04:05 UTC', delay: 3300000 },
    { name: 'long pause timer clamp', skew: 0, deadline: '2099-01-01T00:00:00.000Z', display: '2099-01-01 00:00 UTC', delay: 2147483647 },
    { name: 'original microsecond precision', skew: 0, deadline: '2030-02-03T04:05:06.123456Z', display: '2030-02-03 04:05 UTC', delay: 3599334 },
  ])('preserves exact server time and existing pause semantics with $name', async ({ skew, deadline, display, delay }) => {
    for (const locale of ['en', 'ar'] as const) {
      document.documentElement.lang = locale
      document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
      document.documentElement.setAttribute('data-mfa-mode', 'optional')
      document.body.innerHTML = renderLoginSurface({ audience: 'xwhm', locale, theme: 'light', mfaMode: 'optional' })
      const documentListeners: { name: string; listener: EventListenerOrEventListenerObject }[] = []
      const addListener = document.addEventListener.bind(document)
      const listenerSpy = vi.spyOn(document, 'addEventListener').mockImplementation((name, listener, options) => {
        documentListeners.push({ name, listener }); addListener(name, listener, options)
      })
      try {
        const window = { document, location: { href: 'https://whm.example.test:2087/login', origin: 'https://whm.example.test:2087' } }
        let clientNow = Date.parse('2030-02-03T03:05:06.789Z') + skew
        class ClientDate extends Date { static override now() { return clientNow } }
        const timers: { id: number; delay: number; run: () => void }[] = []
        const cleared = new Set<number>()
        const setTimeout = (run: () => void, timeout: number) => {
          const id = timers.length + 1
          timers.push({ id, delay: timeout, run })
          return id
        }
        const clearTimeout = (id: number) => cleared.add(id)
        const requests: { method: string; path: string }[] = []
        const fetch = async (url: string, init: RequestInit) => {
          requests.push({ method: init.method ?? 'GET', path: new URL(url).pathname })
          return new Response(JSON.stringify({ message: '<img src=x onerror=syntheticFailure()>', details: { lockedOut: true, lockedUntil: deadline } }), {
            status: 401, headers: { 'content-type': 'application/json' },
          })
        }
        runInNewContext(LOGIN_CLIENT_SCRIPT, { xpT, msgid, msgctxt, document, window, URL, AbortController, Date: ClientDate, setTimeout, clearTimeout, fetch })
        const username = window.document.querySelector<HTMLInputElement>('#login-username')!
        const password = window.document.querySelector<HTMLInputElement>('#login-password')!
        const submit = window.document.querySelector<HTMLButtonElement>('[data-login-form] button[type="submit"]')!
        username.value = 'synthetic-root'
        password.value = 'synthetic-password'
        submit.click()
        const shell = window.document.querySelector('[data-auth-state]')!
        await vi.waitFor(() => expect(shell.getAttribute('data-auth-state')).toBe('locked'))
        const error = window.document.querySelector<HTMLElement>('[data-auth-error]')!
        const value = error.querySelector('bdi')!
        expect(value).not.toBeNull()
        expect(value.getAttribute('dir')).toBe('ltr')
        expect(value.classList.contains('xp-mono')).toBe(true)
        expect(value.textContent).toBe(display)
        expect(error.textContent).toBe((locale === 'ar' ? 'تسجيل الدخول مقفل مؤقتًا. موعد إعادة المحاولة: ' : 'Sign-in is temporarily locked. Retry after: ') + display)
        const instant = value.querySelector('time')!
        expect(instant).not.toBeNull()
        expect(instant.getAttribute('datetime')).toBe(deadline)
        expect(instant.textContent).toBe(display)
        expect(error.querySelectorAll('time')).toHaveLength(1)
        expect(value.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T|Z\b/)
        expect(value.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
        const serverDocument = document.implementation.createHTMLDocument('Synthetic paused sign-in')
        serverDocument.body.innerHTML = renderLoginSurface({ audience: 'xwhm', locale, theme: 'light', mfaMode: 'optional', lockout: { locked: true, lockedUntil: deadline } })
        const recorded = serverDocument.querySelector('[data-observed-lockout-until] bdi')!
        expect(recorded.textContent).toBe(display)
        expect(recorded.querySelector('time')!.getAttribute('datetime')).toBe(deadline)
        expect(recorded.textContent).toBe(value.textContent)
        expect(error.querySelectorAll('bdi')).toHaveLength(1)
        expect(error.querySelector('img, script, [onerror]')).toBeNull()
        expect(error.hidden).toBe(false)
        expect(submit.disabled).toBe(true)
        expect(shell.getAttribute('data-login-audience')).toBe('xwhm')
        expect(requests).toEqual([{ method: 'POST', path: '/api/auth/login' }])
        const active = timers.filter(timer => !cleared.has(timer.id))
        expect(active).toHaveLength(1)
        expect(active[0]!.delay).toBe(delay)
        submit.click()
        expect(requests).toHaveLength(1)
        clientNow = Date.parse(deadline)
        active[0]!.run()
        expect(shell.getAttribute('data-auth-state')).toBe('credentials')
        expect(error.getAttribute('data-lockout-state')).toBe('unknown')
        expect(error.hidden).toBe(true)
        expect(submit.disabled).toBe(false)
        expect(requests).toHaveLength(1)
      } finally {
        for (const { name, listener } of documentListeners) document.removeEventListener(name, listener)
        listenerSpy.mockRestore()
        document.body.replaceChildren()
      }
    }
  })
})

describe('SSR readable lockout time', () => {
  it.each([
    { locale: 'en', deadline: '2099-01-01T00:00:00.000Z', display: '2099-01-01 00:00 UTC' },
    { locale: 'ar', deadline: '2099-01-01T00:00:00.000Z', display: '2099-01-01 00:00 UTC' },
    { locale: 'en', deadline: '2030-02-03T04:05:06.123456Z', display: '2030-02-03 04:05 UTC' },
    { locale: 'ar', deadline: '2030-02-03T04:05:06.123456Z', display: '2030-02-03 04:05 UTC' },
  ] as const)('keeps readable $locale text and original machine time for $deadline', ({ locale, deadline, display }) => {
    for (const audience of ['xpanel', 'xwhm', 'xmail'] as const) {
      const serverDocument = document.implementation.createHTMLDocument('Synthetic paused sign-in')
      serverDocument.body.innerHTML = renderLoginSurface({ audience, locale, theme: 'light', mfaMode: 'optional', lockout: { locked: true, lockedUntil: deadline } })
      const recorded = serverDocument.querySelector('[data-observed-lockout-until] bdi')!
      expect(recorded).not.toBeNull()
      expect(recorded.textContent).toBe(display)
      expect(recorded.getAttribute('dir')).toBe('ltr')
      const instant = recorded.querySelector('time')!
      expect(instant).not.toBeNull()
      expect(instant.getAttribute('datetime')).toBe(deadline)
      expect(instant.textContent).toBe(display)
      expect(recorded.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T|Z\b/)
      expect(recorded.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
      expect(serverDocument.querySelector('[data-auth-state]')!.getAttribute('data-locked-until')).toBe(deadline)
      expect(serverDocument.querySelector('[data-auth-state]')!.getAttribute('data-login-audience')).toBe(audience)
      expect(serverDocument.querySelector('script, [onerror]')).toBeNull()
    }
  })
})
