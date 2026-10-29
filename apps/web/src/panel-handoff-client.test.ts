// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HANDOFF_CLIENT_BINDING, handoffFailureState, handoffRequest, readHandoffGrant, submitHandoff } from './panel-handoff-client.ts'
import { renderHandoffButton, renderImpersonationBanner } from './panel-handoff-controls.ts'

const ID = '11111111-1111-4111-8111-111111111111'
const TOKEN = 'A'.repeat(43)
const HERE = 'https://whm.example.test:2087'
const grant = (overrides: Record<string, unknown> = {}) => ({ action: 'https://panel.example.test:2083/login/handoff', token: TOKEN, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; vi.restoreAllMocks() })

describe('handoff client rules', () => {
  it('builds only the fixed issue requests of a valid target', () => {
    expect(handoffRequest('xpanel', { accountId: ID })).toEqual({ path: '/api/handoff/xpanel', body: { accountId: ID } })
    expect(handoffRequest('xmail', { mailbox: ' Inbox@Example.Test ', landing: 'contacts' })).toEqual({ path: '/api/handoff/xmail', body: { mailbox: 'inbox@example.test', landing: 'contacts' } })
    expect(handoffRequest('xmail', { mailbox: 'inbox@example.test', landing: '/whm' })).toEqual({ path: '/api/handoff/xmail', body: { mailbox: 'inbox@example.test' } })
    for (const [audience, target] of [['xpanel', { accountId: 'alice' }], ['xmail', { mailbox: '' }], ['xmail', { mailbox: 'no-at-sign' }], ['xwhm', { accountId: ID }], [undefined, {}]] as const) {
      expect(handoffRequest(audience, target)).toBeNull()
    }
  })

  it('accepts only another exact HTTPS origin with the fixed handoff path and an unexpired 43-character secret', () => {
    const now = Date.now()
    expect(readHandoffGrant(grant(), HERE, now)).toMatchObject({ action: 'https://panel.example.test:2083/login/handoff', token: TOKEN })
    expect(readHandoffGrant(grant({ expiresAt: new Date(now - 1).toISOString() }), HERE, now)).toBe('expired')
    for (const action of ['http://panel.example.test:2083/login/handoff', 'https://panel.example.test:2083/login/handoff?token=x', 'https://panel.example.test:2083/login/handoff#x',
      'https://user:pass@panel.example.test:2083/login/handoff', 'https://panel.example.test:2083/login', `${HERE}/login/handoff`, 'javascript:alert(1)']) {
      expect(readHandoffGrant(grant({ action }), HERE, now), action).toBeNull()
    }
    for (const token of ['short', `${TOKEN}A`, `${'A'.repeat(42)}=`]) expect(readHandoffGrant(grant({ token }), HERE, now)).toBeNull()
    expect(readHandoffGrant(null, HERE, now)).toBeNull()
    expect(readHandoffGrant(grant({ expiresAt: 'soon' }), HERE, now)).toBeNull()
  })

  it('reports refusals honestly and everything else as a failure', () => {
    for (const status of [403, 404, 409, 412]) expect(handoffFailureState({ status })).toBe('refused')
    for (const error of [{ status: 500 }, { status: 503 }, new Error('offline'), null]) expect(handoffFailureState(error)).toBe('failed')
  })

  it('posts the secret once in a detached urlencoded form to a new tab that keeps its exact Origin', () => {
    let submitted: HTMLFormElement | null = null
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) { submitted = this })
    submitHandoff(document, grant())
    expect(submitted).not.toBeNull()
    const form = submitted! as HTMLFormElement
    expect([form.method, form.action, form.target, form.rel, form.enctype]).toEqual(['post', 'https://panel.example.test:2083/login/handoff', '_blank', 'noopener', 'application/x-www-form-urlencoded'])
    expect([...new FormData(form)]).toEqual([['token', TOKEN]])
    expect(document.querySelector('form')).toBeNull()
  })
})

describe('handoff controls in the page', () => {
  const boot = (transport: (method: string, path: string, body?: unknown) => Promise<unknown>) => {
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = vi.fn(transport)
    new Function('return ' + HANDOFF_CLIENT_BINDING)()()
    return (window as unknown as { xpanelSessionRequest: ReturnType<typeof vi.fn> }).xpanelSessionRequest
  }
  const status = () => document.querySelector<HTMLElement>('[data-handoff-status]')!

  it('shows loading then opens the configured target once for an account', async () => {
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})
    document.body.innerHTML = renderHandoffButton('en', { audience: 'xpanel', accountId: ID, label: 'Log in to xPanel' })
    let release!: (value: unknown) => void
    const transport = boot(() => new Promise(resolve => { release = resolve }))
    const button = document.querySelector<HTMLButtonElement>('button[data-handoff]')!
    button.click()
    expect(button.dataset.handoffState).toBe('loading')
    expect(button.disabled).toBe(true)
    expect(transport).toHaveBeenCalledWith('POST', '/api/handoff/xpanel', { accountId: ID })
    release(grant())
    await tick()
    expect(button.dataset.handoffState).toBe('opened')
    expect(button.disabled).toBe(false)
    expect(status().hidden).toBe(false)
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledOnce()
  })

  it.each([
    ['refused', () => Promise.reject({ status: 403 })],
    ['failed', () => Promise.reject(new Error('offline'))],
    ['expired', () => Promise.resolve(grant({ expiresAt: new Date(Date.now() - 1000).toISOString() }))],
    ['failed', () => Promise.resolve(grant({ action: 'https://evil.example.test/collect' }))],
  ] as const)('shows the %s state without posting anywhere', async (state, transport) => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})
    document.body.innerHTML = renderHandoffButton('en', { audience: 'xmail', mailbox: 'inbox@example.test', label: 'Open webmail' })
    boot(transport)
    document.querySelector<HTMLButtonElement>('button[data-handoff]')!.click()
    await tick(); await tick()
    expect(document.querySelector<HTMLButtonElement>('button[data-handoff]')!.dataset.handoffState).toBe(state)
    expect(status().dataset.state).toBe(state)
    expect(submit).not.toHaveBeenCalled()
  })

  it('follows the mailbox select and sends its value with the landing', async () => {
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})
    document.body.innerHTML = `<select id="pick" disabled><option value="">-</option><option value="inbox@example.test">inbox@example.test</option></select>${renderHandoffButton('en', { audience: 'xmail', mailboxSelect: 'pick', landing: 'calendar', label: 'Open xMail calendars' })}`
    const transport = boot(async () => grant())
    const button = document.querySelector<HTMLButtonElement>('button[data-handoff]')!
    const select = document.querySelector<HTMLSelectElement>('#pick')!
    expect(button.disabled).toBe(true)
    select.disabled = false
    await tick()
    expect(button.disabled).toBe(true)
    select.value = 'inbox@example.test'
    select.dispatchEvent(new Event('change'))
    expect(button.disabled).toBe(false)
    button.click()
    await tick()
    expect(transport).toHaveBeenCalledWith('POST', '/api/handoff/xmail', { mailbox: 'inbox@example.test', landing: 'calendar' })
  })
})

describe('handoff markup', () => {
  it('names the target with data hooks only and renders no address, token or link', () => {
    const html = renderHandoffButton('en', { audience: 'xpanel', accountId: ID, label: 'Log in to xPanel' })
    expect(html).toContain(`data-handoff="xpanel" data-handoff-account="${ID}"`)
    expect(html).not.toMatch(/href=|https?:|action=|token/)
  })

  it('isolates both identities in the banner and ends the session with the shared sign-out action', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderImpersonationBanner(locale, { target: 'inbox@<example>.test', issuer: 'root' })
      expect(html).toContain('<bdi dir="ltr">inbox@&lt;example&gt;.test</bdi>')
      expect(html).toContain('<bdi dir="ltr">root</bdi>')
      expect(html).toContain('data-action="logout"')
      expect(html).not.toMatch(/[]|<example>/)
    }
    expect(renderImpersonationBanner('en', { target: 'alice', issuer: 'root' })).toContain('Signed in as <bdi dir="ltr">alice</bdi> by <bdi dir="ltr">root</bdi>')
  })
})
