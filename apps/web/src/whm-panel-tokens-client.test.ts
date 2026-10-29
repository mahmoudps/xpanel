// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { renderWhmPanelTokensWorkspace } from './board-port/whm-panel-tokens-workspace.ts'
import { readPanelTokenCreatedView, readPanelTokenListView, readPanelTokenView, WHM_PANEL_TOKENS_CLIENT_BINDING } from './whm-panel-tokens-client.ts'

const ID = '0f3c2a64-8b1d-4c2e-9a7f-5d6e7f8a9b0c'
const SECRET = 'xp_' + 'A'.repeat(43)
const token = (overrides: Record<string, unknown> = {}) => ({
  id: ID, name: 'stock-sync', scopes: ['accounts:read'], allowedIps: ['198.51.100.24/32'], createdAt: '2026-10-27T10:00:00.000Z', expiresAt: '2027-01-25T10:00:00.000Z',
  lastUsedAt: null, lastUsedIp: null, revokedAt: null, state: 'active', ...overrides,
})
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const boot = (send?: Send, ask?: (options: Record<string, unknown>) => Promise<unknown>, locale: 'en' | 'ar' = 'en', canManage = true) => {
  document.body.innerHTML = renderWhmPanelTokensWorkspace({ locale, canManage })
  if (send) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  new Function('return ' + WHM_PANEL_TOKENS_CLIENT_BINDING)()(ask)
}
const routes = (handlers: Record<string, (path: string, body?: unknown) => unknown>): Mock<Send> => vi.fn<Send>(async (method, path, body) => {
  const key = Object.keys(handlers).find(prefix => (method + ' ' + path).startsWith(prefix))
  if (!key) throw Object.assign(new Error('unexpected ' + path), { status: 404 })
  return handlers[key]!(path, body)
})
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const submit = () => $<HTMLFormElement>('[data-whm-tokens-create]').dispatchEvent(new Event('submit', { cancelable: true }))

beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
afterEach(() => { document.body.innerHTML = ''; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('WHM API token client parsers', () => {
  it('accepts the API contract and rejects hashes, unsafe values and inconsistent states', () => {
    expect(readPanelTokenView(token()).allowedIps).toEqual(['198.51.100.24/32'])
    expect(readPanelTokenListView({ tokens: [token()], usageRecorded: false }).tokens).toHaveLength(1)
    expect(readPanelTokenCreatedView({ token: token(), secret: SECRET }).secret).toBe(SECRET)
    expect(() => readPanelTokenView({ ...token(), tokenHash: 'a'.repeat(64) })).toThrow()
    expect(() => readPanelTokenView(token({ id: ID.toUpperCase() }))).toThrow()
    expect(() => readPanelTokenView(token({ name: 'Bad Name' }))).toThrow()
    expect(() => readPanelTokenView(token({ scopes: ['accounts:admin'] }))).toThrow()
    expect(() => readPanelTokenView(token({ state: 'revoked' }))).toThrow()
    expect(() => readPanelTokenView(token({ revokedAt: '2026-10-27T11:00:00.000Z' }))).toThrow()
    expect(() => readPanelTokenView(token({ allowedIps: ['<script>'] }))).toThrow()
    expect(() => readPanelTokenListView({ tokens: [token(), token()], usageRecorded: false })).toThrow()
    expect(() => readPanelTokenListView({ tokens: [] })).toThrow()
    expect(() => readPanelTokenCreatedView({ token: token(), secret: 'xp_short' })).toThrow()
    expect(() => readPanelTokenCreatedView({ token: token({ state: 'expired' }), secret: SECRET })).toThrow()
  })
})

describe('WHM API token client binding', () => {
  it('sends nothing and keeps every control disabled without transport or admission', async () => {
    boot()
    await flush()
    expect($('[data-whm-tokens-status]').dataset.state).toBe('unavailable')
    expect($<HTMLButtonElement>('[data-whm-tokens-create-submit]').disabled).toBe(true)
    const send = routes({})
    boot(send, async () => true, 'en', false)
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect($('[data-whm-tokens-status]').dataset.state).toBe('unavailable')
    expect(WHM_PANEL_TOKENS_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_PANEL_TOKENS_CLIENT_BINDING).not.toContain('fetch(')
  })

  it('lists tokens truthfully, with unrecorded last use and a revoke action only for active tokens', async () => {
    const send = routes({ 'GET /api/server/panel/api-tokens': () => ({ tokens: [token(), token({ id: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d', name: 'old', state: 'expired' })], usageRecorded: false }) })
    boot(send, async () => true)
    await flush()
    const rows = document.querySelectorAll('[data-whm-tokens-rows] tr')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Not recorded')
    expect(rows[0]!.textContent).toContain('198.51.100.24/32')
    expect(rows[0]!.querySelector('[data-whm-tokens-revoke]')).not.toBeNull()
    expect(rows[1]!.querySelector('[data-whm-tokens-revoke]')).toBeNull()
    expect(rows[1]!.textContent).toContain('Expired')
    expect($('[data-whm-tokens-status]').textContent).toBe('Tokens read. Active tokens: 1.')
  })

  it('creates a token, shows the secret once, clears it on Done and re-reads the list', async () => {
    let listed: unknown[] = []
    const send = routes({
      'GET /api/server/panel/api-tokens': () => ({ tokens: listed, usageRecorded: false }),
      'POST /api/server/panel/api-tokens': () => { listed = [token()]; return { token: token(), secret: SECRET } },
    })
    boot(send, async () => true)
    await flush()
    $<HTMLInputElement>('[data-whm-tokens-name]').value = 'stock-sync'
    $<HTMLInputElement>('[data-whm-tokens-ips]').value = '198.51.100.24, 2001:db8::/32'
    $<HTMLInputElement>('input[value="accounts:read"]').checked = true
    submit(); await flush()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/panel/api-tokens', { name: 'stock-sync', scopes: ['accounts:read'], expiresInDays: 90, allowedIps: ['198.51.100.24', '2001:db8::/32'] })
    expect($('[data-whm-tokens-reveal]').hidden).toBe(false)
    expect($('[data-whm-tokens-secret]').textContent).toBe(SECRET)
    expect($('[data-whm-tokens-reveal-text]').textContent).toContain('It is shown once')
    expect($<HTMLInputElement>('[data-whm-tokens-name]').value).toBe('')
    expect(send.mock.calls.filter(([method]) => method === 'GET')).toHaveLength(2)
    expect(document.querySelectorAll('[data-whm-tokens-rows] tr')).toHaveLength(1)
    $<HTMLButtonElement>('[data-whm-tokens-done]').click()
    expect($('[data-whm-tokens-secret]').textContent).toBe('')
    expect($('[data-whm-tokens-reveal]').hidden).toBe(true)
  })

  it('validates locally and asks before a full-access token', async () => {
    const send = routes({ 'GET /api/server/panel/api-tokens': () => ({ tokens: [], usageRecorded: false }), 'POST /api/server/panel/api-tokens': () => ({ token: token({ scopes: ['*'] }), secret: SECRET }) })
    const ask = vi.fn(async () => false)
    boot(send, ask)
    await flush()
    $<HTMLInputElement>('[data-whm-tokens-name]').value = 'Bad Name'
    $<HTMLInputElement>('input[value="jobs:read"]').checked = true
    submit(); await flush()
    expect($('[data-whm-tokens-name]').getAttribute('aria-invalid')).toBe('true')
    $<HTMLInputElement>('[data-whm-tokens-name]').value = 'ci'
    const all = $<HTMLInputElement>('[data-whm-tokens-all]')
    all.checked = true; all.dispatchEvent(new Event('change'))
    expect($<HTMLInputElement>('input[value="jobs:read"]').checked).toBe(false)
    expect($<HTMLInputElement>('input[value="jobs:read"]').disabled).toBe(true)
    submit(); await flush()
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ danger: true }))
    expect(send.mock.calls.some(([method]) => method === 'POST')).toBe(false)
    ask.mockResolvedValueOnce(true)
    submit(); await flush()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/panel/api-tokens', { name: 'ci', scopes: ['*'], expiresInDays: 90 })
  })

  it('revokes after confirmation and re-reads, and explains a 409', async () => {
    let state = 'active'
    const send = routes({
      'GET /api/server/panel/api-tokens': () => ({ tokens: [token(state === 'revoked' ? { state, revokedAt: '2026-10-27T12:00:00.000Z' } : {})], usageRecorded: false }),
      ['POST /api/server/panel/api-tokens/' + ID + '/revoke']: () => { if (state === 'revoked') throw Object.assign(new Error('x'), { status: 409 }); state = 'revoked'; return { token: token({ state, revokedAt: '2026-10-27T12:00:00.000Z' }) } },
    })
    const ask = vi.fn(async () => true)
    boot(send, ask)
    await flush()
    $<HTMLButtonElement>('[data-whm-tokens-revoke]').click(); await flush()
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Revoke this token?' }))
    expect(send).toHaveBeenCalledWith('POST', '/api/server/panel/api-tokens/' + ID + '/revoke')
    expect($('[data-whm-tokens-revoke-status]').textContent).toBe('Token revoked: stock-sync.')
    expect(document.querySelector('[data-whm-tokens-rows] tr')!.textContent).toContain('Revoked')
    expect(send.mock.calls.filter(([method]) => method === 'GET')).toHaveLength(2)
  })

  it('copies through the clipboard API and renders Arabic copy', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const send = routes({ 'GET /api/server/panel/api-tokens': () => ({ tokens: [], usageRecorded: false }), 'POST /api/server/panel/api-tokens': () => ({ token: token(), secret: SECRET }) })
    boot(send, async () => true, 'ar')
    await flush()
    expect($('[data-whm-tokens-status]').textContent).toBe('قُرئت الرموز. ليس لديك رموز API.')
    $<HTMLInputElement>('[data-whm-tokens-name]').value = 'stock-sync'
    $<HTMLInputElement>('input[value="accounts:read"]').checked = true
    submit(); await flush()
    expect($('[data-whm-tokens-reveal-text]').textContent).toBe('انسخ الرمز الخاص بـ stock-sync الآن. يُعرض مرة واحدة؛ وبعد مغادرة هذه الصفحة لا تبقى إلا تجزئته.')
    $<HTMLButtonElement>('[data-whm-tokens-copy]').click(); await flush()
    expect(writeText).toHaveBeenCalledWith(SECRET)
    expect($('[data-whm-tokens-copy-status]').textContent).toBe('نُسخ.')
    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
  })
})

describe('complete API token timestamps', () => {
  it.each(['en', 'ar'] as const)('preserves creation, expiry and recorded use instants in %s', async locale => {
    const instants = ['2026-10-27T10:11:12.345Z', '2027-01-25T11:12:13.456Z', '2026-10-27T12:13:14.567Z']
    const send = routes({ 'GET /api/server/panel/api-tokens': () => ({ tokens: [token({ createdAt: instants[0], expiresAt: instants[1], lastUsedAt: instants[2], lastUsedIp: '198.51.100.24' })], usageRecorded: true }) })
    boot(send, async () => false, locale); await flush()
    const row = $<HTMLTableRowElement>('[data-whm-tokens-rows] tr')
    expect([3, 4, 5].map(index => row.cells[index]!.textContent)).toEqual(['2026-10-27 10:11 UTC', '2027-01-25 11:12 UTC', '2026-10-27 12:13 UTC'])
    for (const index of [3, 4, 5]) expect(row.cells[index]!.querySelector('bdi')!.getAttribute('dir')).toBe('ltr')
    expect(send.mock.calls).toEqual([['GET', '/api/server/panel/api-tokens']])
  })
})
