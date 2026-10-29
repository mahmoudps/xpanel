// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderMailxWhmWorkspace } from './board-port/mailx-whm-workspace.ts'
import type { MailxWhmPage } from './board-port/mailx-whm-workspace.ts'
import { MAILX_WHM_CLIENT_BINDING, readMailxSectionView } from './mailx-whm-client.ts'

const tick = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const policies: Record<MailxWhmPage, Record<string, unknown>> = {
  spam: { enabled: true, rejectScore: 15, headerScore: 6, greylistScore: 4, blockedDomains: ['spam.example'] },
  relay: { enabled: true, host: 'smtp.relay.example', port: 587, username: 'relayuser', passwordSet: true },
  bcc: { alwaysBcc: null, recipient: [{ match: '@shop.example', copyTo: 'audit@corp.example' }], sender: [] },
  marketing: { messageRateLimit: 100, recipientRateLimit: 0, recipientsPerMessage: 1000, destinationRateDelay: 0, destinationConcurrency: 20, rateWindow: 3600 },
}
const view = (section: MailxWhmPage, extra: Record<string, unknown> = {}) => ({ section, saved: true, revision: 'a'.repeat(64), compositeRevision: 'b'.repeat(64), policy: policies[section], defaults: policies[section],
  host: 'connected', observedAt: '2026-10-28T10:00:00.000Z', state: 'applied', updatedAt: '2026-10-28T09:00:00.000Z', updatedBy: 'root',
  engine: section === 'spam' ? { engine: 'rspamd', wiring: 'not-wired', units: {} } : null, application: null, ...extra })
const mount = (page: MailxWhmPage, canManage = true, wrapper = '') => {
  document.body.innerHTML = `<section ${wrapper}>${renderMailxWhmWorkspace({ locale: 'en', page, canRead: true, canManage })}</section>`
}
const boot = (request?: (method: string, path: string, body?: unknown) => Promise<unknown>) => {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + MAILX_WHM_CLIENT_BINDING)()()
}
const status = () => document.querySelector<HTMLElement>('[data-mailx-status]')!
const field = (key: string) => document.querySelector<HTMLInputElement>(`[data-mailx-field="${key}"]`)!
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('mail policy client parser', () => {
  it('accepts each section, drops unknown fields and refuses inconsistent states', () => {
    for (const page of ['spam', 'relay', 'bcc', 'marketing'] as const) expect(readMailxSectionView(view(page), page).section).toBe(page)
    expect(JSON.stringify(readMailxSectionView(view('relay', { policy: { ...policies.relay, password: 'S3cret' } }), 'relay'))).not.toContain('S3cret')
    for (const [bad, page] of [[view('spam'), 'relay'], [view('spam', { saved: false }), 'spam'], [view('spam', { state: 'ok' }), 'spam'], [view('spam', { revision: 'x' }), 'spam'],
      [view('relay', { policy: { ...policies.relay, passwordSet: undefined } }), 'relay'], [view('bcc', { policy: { ...policies.bcc, recipient: 'x' } }), 'bcc'], [view('spam', { observedAt: 'yesterday' }), 'spam']] as const)
      expect(() => readMailxSectionView(bad, page)).toThrow()
  })
})

describe('mail policy client binding', () => {
  it('stays inert without transport or inside an unavailable capability', async () => {
    mount('relay'); boot(); expect(status().dataset.state).toBe('unavailable')
    const send = vi.fn(async () => view('relay'))
    mount('relay', true, 'data-capability-unavailable="true"'); boot(send); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLButtonElement>('[data-mailx-save]')!.disabled).toBe(true)
  })
  it('paints the saved relay without the password and sends null to keep it', async () => {
    const calls: [string, string, unknown][] = []
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body])
      return method === 'GET' ? view('relay') : { ...view('relay'), application: { outcome: 'rolled-back', verificationRequired: false, spam: null } }
    })
    mount('relay'); boot(send); await tick()
    expect(field('host').value).toBe('smtp.relay.example')
    expect(field('password').value).toBe('')
    expect(field('password').placeholder).toBe('A password is saved')
    expect(status().dataset.state).toBe('read')
    field('port').value = '2525'
    document.querySelector<HTMLFormElement>('[data-mailx-form]')!.requestSubmit(); await tick()
    expect(calls[1]).toEqual(['PUT', '/api/server/mailx/relay', { policy: { enabled: true, host: 'smtp.relay.example', port: 2525, username: 'relayuser' }, expectedRevision: 'a'.repeat(64), password: null }])
    expect(document.querySelector('[data-mailx-form-status]')!.textContent).toContain('previous settings were restored')
  })
  it('reports spam wiring, parses BCC lines and maps conflicts and read-only access', async () => {
    mount('spam'); boot(async () => view('spam')); await tick()
    expect(document.querySelector('[data-mailx-fact="wiring"]')!.textContent).toContain('Postfix gets the filter after the saved policy is applied')
    expect(field('blockedDomains').value).toBe('spam.example')
    const refused = vi.fn(async (method: string) => method === 'GET' ? view('spam') : { ...view('spam'), application: { outcome: 'applied', verificationRequired: false, spam: 'applied', reconcile: 'failed' } })
    mount('spam'); boot(refused); await tick()
    document.querySelector<HTMLFormElement>('[data-mailx-form]')!.requestSubmit(); await tick()
    expect(document.querySelector('[data-mailx-form-status]')!.getAttribute('data-state')).toBe('partial')
    expect(document.querySelector('[data-mailx-form-status]')!.textContent).toContain('adds the filter to Postfix failed and was rolled back')
    const send = vi.fn(async (method: string) => { if (method === 'GET') return view('bcc'); throw { status: 409, code: 'CONFLICT', details: { stateChanged: false } } })
    mount('bcc'); boot(send); await tick()
    expect(field('recipient').value).toBe('@shop.example audit@corp.example')
    field('sender').value = 'just-one-token'
    document.querySelector<HTMLFormElement>('[data-mailx-form]')!.requestSubmit(); await tick()
    expect(send).toHaveBeenCalledTimes(1)
    field('sender').value = '@corp.example archive@corp.example'
    document.querySelector<HTMLFormElement>('[data-mailx-form]')!.requestSubmit(); await tick()
    expect(document.querySelector('[data-mailx-form-status]')!.textContent).toContain('changed since it was read')
    mount('marketing', false); boot(async () => view('marketing')); await tick()
    expect(field('messageRateLimit').value).toBe('100')
    expect(field('messageRateLimit').disabled).toBe(true)
  })
  it('translates through the page catalog in Arabic', async () => {
    document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl'
    mount('marketing'); boot(); expect(status().textContent).not.toBe('')
  })
})
