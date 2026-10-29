// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmDeveloperWorkspace } from './board-port/whm-developer-workspace.ts'
import { renderWhmIntegrationWorkspace } from './board-port/whm-integration-workspace.ts'
import { parseDeveloperView, WHM_DEVELOPER_CLIENT_BINDING } from './whm-developer-client.ts'
import type { DeveloperBrowserManifest, DeveloperBrowserResult, DeveloperBrowserSurface } from './whm-developer-client.ts'

const STAMP = '2026-10-27T12:00:00.000Z'
const manifest = (surface: DeveloperBrowserSurface = 'administrator'): DeveloperBrowserManifest => ({ surface, available: true, writes: false, rawResponses: false, operations: surface === 'integrations' ? [{ operation: 'tokens', method: 'GET', path: '/api/server/panel/api-tokens' }]
  : [{ operation: 'identity', method: 'GET', path: '/api/auth/me' }, { operation: 'preferences', method: 'GET', path: surface === 'account' ? '/api/account/preferences' : '/api/admin/preferences' }, ...(surface === 'administrator' ? [{ operation: 'tokens' as const, method: 'GET' as const, path: '/api/server/panel/api-tokens' }] : [])] })
const identity = (): DeveloperBrowserResult => ({ operation: 'identity', request: { method: 'GET', path: '/api/auth/me' }, state: 'read', status: 200, observedAt: STAMP, fields: [{ key: 'username', value: 'root' }, { key: 'role', value: 'root' }], tokens: [] })
const tokens = (): DeveloperBrowserResult => ({ operation: 'tokens', request: { method: 'GET', path: '/api/server/panel/api-tokens' }, state: 'read', status: 200, observedAt: STAMP, fields: [{ key: 'tokenCount', value: '1' }], tokens: [{ name: 'inventory-reader', scopes: ['catalog:read'], expiresAt: STAMP, state: 'active' }] })
type Requester = (method: string, path: string, body?: unknown) => Promise<unknown>
const $ = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
function boot(send?: Requester, surface: DeveloperBrowserSurface = 'administrator', locale: 'en' | 'ar' = 'en', canRead = true, parent = '') {
  const html = surface === 'integrations' ? renderWhmIntegrationWorkspace({ locale, canRead }) : renderWhmDeveloperWorkspace({ locale, canRead, surface })
  document.body.innerHTML = parent ? `<section ${parent}>${html}</section>` : html
  if (send) (window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest = send
  new Function('return ' + WHM_DEVELOPER_CLIENT_BINDING)()()
}
const submit = () => $<HTMLFormElement>('[data-dev-form]').dispatchEvent(new Event('submit', { cancelable: true }))
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest })
afterEach(() => { document.body.innerHTML = '' })

describe('finite developer browser protocol', () => {
  it('rejects arbitrary paths, methods, operation extensions and credential-bearing responses', () => {
    expect(parseDeveloperView(manifest(), 'administrator')).toEqual(manifest())
    expect(parseDeveloperView(identity(), 'administrator', 'identity')).toEqual(identity())
    for (const bad of [{ ...manifest(), writes: true }, { ...manifest(), rawResponses: true }, { ...manifest(), url: 'https://outside.test' }, { ...manifest(), operations: [{ operation: 'identity', method: 'POST', path: '/api/server/settings' }] }]) expect(() => parseDeveloperView(bad, 'administrator')).toThrow()
    for (const bad of [{ ...identity(), csrfToken: 'private-fixture' }, { ...identity(), request: { method: 'GET', path: '/api/accounts' } }, { ...identity(), fields: [{ key: 'principalId', value: 'internal' }] }, { ...identity(), status: 302 }, { ...identity(), state: 'refused' }]) expect(() => parseDeveloperView(bad, 'administrator', 'identity')).toThrow()
    expect(() => parseDeveloperView({ ...tokens(), tokens: [{ ...tokens().tokens[0], id: 'internal' }] }, 'administrator', 'tokens')).toThrow()
    expect(() => parseDeveloperView({ ...tokens(), fields: [{ key: 'tokenCount', value: '0' }] }, 'integrations', 'tokens')).toThrow()
  })
})
describe('developer console read workflow', () => {

  it.each([
    { surface: 'account', locale: 'en' }, { surface: 'account', locale: 'ar' },
    { surface: 'administrator', locale: 'en' }, { surface: 'administrator', locale: 'ar' },
    { surface: 'integrations', locale: 'en' }, { surface: 'integrations', locale: 'ar' },
  ] as const)('renders readable datetime metadata for developer reads while preserving response fields and copied ISO ($surface/$locale)', async ({ surface, locale }) => {
    const stamp = locale === 'en' ? '2026-10-27T12:34:56.123Z' : '2026-10-27T12:34:56.000Z'
    const expected = locale === 'en' ? '2026-10-27 12:34 UTC' : '2026-10-27 12:34 UTC'
    const expiresAt = locale === 'en' ? '2026-10-28T13:14:15.120Z' : '2026-10-28T13:14:15.000Z'
    const expiresShown = locale === 'en' ? '2026-10-28 13:14 UTC' : '2026-10-28 13:14 UTC'
    const operation = surface === 'account' ? 'identity' : 'tokens'
    const response: DeveloperBrowserResult = surface === 'account'
      ? { ...identity(), observedAt: stamp, fields: [{ key: 'username', value: stamp }, { key: 'role', value: 'owner' }] }
      : { ...tokens(), observedAt: stamp, tokens: [{ ...tokens().tokens[0]!, expiresAt }] }
    const endpoint = surface === 'account' ? '/api/account/developer' : surface === 'integrations' ? '/api/server/panel/integrations' : '/api/server/panel/developer'
    const send = vi.fn<Requester>(async method => method === 'GET' ? manifest(surface) : response)
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writeText = vi.fn(async (_value: string) => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      boot(send, surface, locale); await flush()
      const select = $<HTMLSelectElement>('[data-dev-operation]')
      select.value = operation; select.dispatchEvent(new Event('change')); submit(); await flush()
      expect($('[data-dev-fact="observed"]').textContent).toBe(expected)
      expect($('[data-dev-fact="observed"] bdi').getAttribute('dir')).toBe('ltr')
      const parsed = parseDeveloperView(response, surface, operation) as DeveloperBrowserResult
      expect(parsed.observedAt).toBe(stamp)
      if (operation === 'tokens') {
        const expiry = $('[data-dev-token-rows] tr td:nth-child(3) bdi')
        expect(expiry.textContent).toBe(expiresShown); expect(expiry.getAttribute('dir')).toBe('ltr')
        expect(parsed.tokens[0]!.expiresAt).toBe(expiresAt)
      } else expect($('[data-dev-result-fields]').textContent).toContain(stamp)
      $<HTMLButtonElement>('[data-dev-copy]').click(); await flush()
      expect(writeText).toHaveBeenCalledExactlyOnceWith(JSON.stringify(response, null, 2))
      expect(send.mock.calls).toEqual([['GET', endpoint], ['POST', endpoint, { operation }]])
      expect($('[data-dev-status]').dataset.state).toBe('read')
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  it('retains every control without executing in unqualified/read-only/missing transport contexts', async () => {
    const send = vi.fn<Requester>(async () => manifest())
    boot(); await flush(); expect($('[data-dev-status]').dataset.state).toBe('unavailable')
    boot(send, 'administrator', 'en', false); await flush(); expect(send).not.toHaveBeenCalled()
    boot(send, 'administrator', 'en', true, 'data-wiring="soon"'); await flush(); expect(send).not.toHaveBeenCalled()
    expect($<HTMLButtonElement>('[data-dev-run]').disabled).toBe(true)
    expect($('[data-dev-form]')).not.toBeNull(); expect($('[data-dev-token-table]')).not.toBeNull()
    expect(WHM_DEVELOPER_CLIENT_BINDING).not.toContain('innerHTML'); expect(WHM_DEVELOPER_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('retains unavailable controls without a form or HTTP on all 3 surfaces and keeps active form semantics', async () => {
    for (const surface of ['administrator', 'integrations', 'account'] as const) {
      for (const locale of ['en', 'ar'] as const) {
        const send = vi.fn<Requester>(async () => manifest(surface))
        boot(send, surface, locale, false); await flush()
        const root = $('[data-developer-workspace]')
        expect(root.querySelector('form')).toBeNull()
        expect($('[data-dev-form]').tagName).toBe('DIV')
        const controls = [...root.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select')]
        expect(controls.length).toBeGreaterThan(0)
        expect(controls.every(control => control.disabled)).toBe(true)
        expect($('[data-dev-form]').classList.contains('xp-dev__group')).toBe(true)
        expect($('[data-dev-fact="method"]')).not.toBeNull()
        expect($('[data-dev-fact="path"]')).not.toBeNull()
        expect($('[data-dev-token-table]')).not.toBeNull()
        submit(); await flush(); expect(send).not.toHaveBeenCalled()
        boot(send, surface, locale, true); await flush()
        expect($('[data-dev-form]').tagName).toBe('FORM')
        expect($('[data-dev-form]').classList.contains('xp-dev__group')).toBe(true)
        expect($<HTMLButtonElement>('[data-dev-run]').type).toBe('submit')
        expect(send.mock.calls).toEqual([['GET', surface === 'account' ? '/api/account/developer' : surface === 'integrations' ? '/api/server/panel/integrations' : '/api/server/panel/developer']])
      }
    }
  })
  it('reads a real descriptor manifest before dispatching a finite operation with no caller-selected route', async () => {
    const send = vi.fn<Requester>(async method => method === 'GET' ? manifest() : identity())
    boot(send); await flush()
    expect($('[data-dev-fact="path"]').textContent).toBe('/api/auth/me')
    submit(); await flush()
    expect(send.mock.calls).toEqual([['GET', '/api/server/panel/developer'], ['POST', '/api/server/panel/developer', { operation: 'identity' }]])
    expect($('[data-dev-status]').dataset.state).toBe('read')
    expect($('[data-dev-result-fields]').textContent).toContain('root')
    expect($('[data-dev-fact="path"] bdi').getAttribute('dir')).toBe('ltr')
    expect($('[data-dev-result-fields]').querySelector('dt')?.textContent).toBe('Username')
  })
  it('renders the integrations inventory through the same guarded reader and leaves external provider configuration disabled', async () => {
    const send = vi.fn<Requester>(async method => method === 'GET' ? manifest('integrations') : tokens())
    boot(send, 'integrations', 'ar'); await flush(); submit(); await flush()
    expect(send.mock.calls).toEqual([['GET', '/api/server/panel/integrations'], ['POST', '/api/server/panel/integrations', { operation: 'tokens' }]])
    expect($('[data-dev-token-table]').hidden).toBe(false); expect($('[data-dev-token-rows]').textContent).toContain('inventory-reader')
    expect($('[data-developer-workspace]').getAttribute('dir')).toBe('rtl')
    expect(document.body.textContent).toContain('الخطافات الموقّعة')
    expect([...document.querySelectorAll<HTMLButtonElement>('aside button')].every(button => button.disabled)).toBe(true)
    expect(document.body.textContent).not.toMatch(/private-fixture|tokenHash|csrfToken|principalId/)
  })
  it('keeps requests unavailable without their provider and rejects a response for a different operation', async () => {
    const send = vi.fn<Requester>(async () => ({ ...manifest(), available: false }))
    boot(send); await flush(); expect($<HTMLButtonElement>('[data-dev-run]').disabled).toBe(true); submit(); await flush(); expect(send).toHaveBeenCalledTimes(1)
    const mismatch = vi.fn<Requester>(async method => method === 'GET' ? manifest() : tokens())
    boot(mismatch); await flush(); submit(); await flush()
    expect($('[data-dev-status]').dataset.state).toBe('failed'); expect($('[data-dev-result-fields]').textContent).toBe('')
  })
  it('renders API refusals without private error bodies and never displays HTML as markup', async () => {
    const send = vi.fn<Requester>(async method => method === 'GET' ? manifest('account') : { ...identity(), state: 'refused', status: 403, fields: [], tokens: [] })
    boot(send, 'account'); await flush(); submit(); await flush()
    expect($('[data-dev-status]').dataset.state).toBe('refused'); expect($('[data-dev-fact="status"]').textContent).toBe('403')
    const safeText = vi.fn<Requester>(async method => method === 'GET' ? manifest() : { ...identity(), fields: [{ key: 'username', value: '<img src=x onerror=alert(1)>' }, { key: 'role', value: 'root' }] })
    boot(safeText); await flush(); submit(); await flush()
    expect($('[data-dev-result-fields]').textContent).toContain('<img src=x'); expect(document.querySelector('img')).toBeNull()
  })
  it('clears a previous result when changing operation and cannot launch duplicate submissions', async () => {
    let resolve: (value: unknown) => void = () => undefined
    const send = vi.fn<Requester>(async method => method === 'GET' ? manifest() : new Promise(done => { resolve = done }))
    boot(send); await flush(); submit(); submit(); await flush(); expect(send).toHaveBeenCalledTimes(2)
    resolve(identity()); await flush()
    const select = $<HTMLSelectElement>('[data-dev-operation]'); select.value = 'preferences'; select.dispatchEvent(new Event('change'))
    expect($('[data-dev-result-fields]').textContent).toBe(''); expect($('[data-dev-fact="path"]').textContent).toBe('/api/admin/preferences')
  })
})
