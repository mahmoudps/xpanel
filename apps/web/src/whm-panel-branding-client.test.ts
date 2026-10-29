// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmPanelBrandingWorkspace } from './board-port/whm-panel-branding-workspace.ts'
import { readBrandingView, WHM_PANEL_BRANDING_CLIENT_BINDING } from './whm-panel-branding-client.ts'
import type { BrandingView } from './whm-panel-branding-client.ts'

const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64), R3 = 'c'.repeat(64), STAMP = '2026-10-29T08:00:00.000Z'
const fields = { companyName: '', productName: '', footerText: '', hidePoweredBy: false, primaryColor: '', accentColor: '', supportUrl: '', supportEmail: '', defaultTheme: 'light', defaultDensity: 'comfortable' } as const
const defaults = (): BrandingView => ({ state: 'default', branding: { ...fields, logo: null, favicon: null }, updatedAt: null, revision: R1 })
const logo = { sha256: 'd'.repeat(64), contentType: 'image/png', bytes: 2048, width: 240, height: 64, uploadedAt: STAMP }
type Requester = (method: string, path: string, body?: unknown) => Promise<unknown>
const flush = async () => { for (let index = 0; index < 10; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const boot = (send?: Requester, canManage = true, confirm: unknown = async () => true) => {
  document.body.innerHTML = renderWhmPanelBrandingWorkspace({ locale: 'en', canManage })
  if (send) (window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest = send
  new Function('return ' + WHM_PANEL_BRANDING_CLIENT_BINDING)()(confirm)
}
afterEach(() => { document.body.innerHTML = ''; delete (window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest })

describe('branding page', () => {
  it('parses exact views and renders both locales with every hook', () => {
    expect(readBrandingView(defaults())).toEqual(defaults())
    for (const bad of [{ ...defaults(), extra: 1 }, { ...defaults(), branding: { ...defaults().branding, logo: { ...logo, sha256: 'x' } } }, { ...defaults(), updatedAt: STAMP }])
      expect(() => readBrandingView(bad)).toThrow()
    for (const locale of ['en', 'ar'] as const) {
      const html = renderWhmPanelBrandingWorkspace({ locale, canManage: true })
      expect(html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`); expect(html).not.toMatch(/[٠-٩]/)
      for (const hook of ['data-branding-input="productName"', 'data-branding-input="primaryColor"', 'data-branding-file="logo"', 'data-branding-file="favicon"', 'data-branding-save'])
        expect(html).toContain(hook)
    }
  })

  it('saves text with the captured revision, uploads a chosen image as raw bytes and removes it after confirmation', async () => {
    let current = defaults()
    const saved = (): BrandingView => ({ state: 'saved', branding: { ...fields, productName: 'Example Panel', primaryColor: '#1d5bd6', logo: null, favicon: null }, updatedAt: STAMP, revision: R2 })
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'PUT' && path === '/api/server/panel/branding') { expect(body).toMatchObject({ productName: 'Example Panel', primaryColor: '#1d5bd6', expectedRevision: R1 }); current = saved() }
      if (method === 'PUT' && path.startsWith('/api/server/panel/branding/logo')) {
        expect(path).toBe('/api/server/panel/branding/logo?expectedRevision=' + R2); expect(body).toBeInstanceOf(Blob); expect((body as Blob).type).toBe('image/png')
        current = { ...saved(), branding: { ...saved().branding!, logo }, revision: R3 }
      }
      if (method === 'DELETE') { expect(path).toBe('/api/server/panel/branding/logo?expectedRevision=' + R3); current = { ...saved(), revision: R1 } }
      return structuredClone(current)
    })
    boot(send); await flush()
    expect($('[data-branding-status]').dataset.state).toBe('read'); expect($<HTMLButtonElement>('[data-branding-remove="logo"]').disabled).toBe(true)
    $<HTMLInputElement>('[data-branding-input="productName"]').value = 'Example Panel'; $<HTMLInputElement>('[data-branding-input="primaryColor"]').value = '#1D5BD6'
    $<HTMLButtonElement>('[data-branding-save]').click(); await flush()
    expect($('[data-branding-save-status]').dataset.state).toBe('saved')
    const input = $<HTMLInputElement>('[data-branding-file="logo"]')
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([new Uint8Array(64)], 'logo.png', { type: 'image/png' })] })
    input.dispatchEvent(new Event('change')); await flush()
    expect($('[data-branding-asset-status]').dataset.state).toBe('saved'); expect($('[data-branding-asset-state="logo"]').textContent).toBe('240 × 64 pixels, 2 KiB')
    expect($<HTMLImageElement>('[data-branding-preview="logo"] img').getAttribute('src')).toBe('/branding/logo?v=' + 'd'.repeat(16))
    $<HTMLButtonElement>('[data-branding-remove="logo"]').click(); await flush()
    expect($('[data-branding-asset-state="logo"]').textContent).toBe('None uploaded')
    expect(send.mock.calls.map(call => call[0])).toEqual(['GET', 'PUT', 'GET', 'PUT', 'GET', 'DELETE', 'GET'])
  })

  it('refuses an oversized file before sending, maps a field refusal and stays inert without root access', async () => {
    const send = vi.fn(async (method: string) => { if (method === 'PUT') throw Object.assign(new Error('bad'), { status: 400, details: { stateChanged: false, fields: [{ field: 'supportUrl', code: 'invalid' }] } }); return defaults() })
    boot(send); await flush()
    const input = $<HTMLInputElement>('[data-branding-file="favicon"]')
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([new Uint8Array(129 * 1024)], 'icon.png', { type: 'image/png' })] })
    input.dispatchEvent(new Event('change')); await flush()
    expect(send.mock.calls.map(call => call[0])).toEqual(['GET']); expect($('[data-branding-asset-status]').textContent).toBe('The image is too large.')
    $<HTMLButtonElement>('[data-branding-save]').click(); await flush()
    expect($('[data-branding-save-status]').textContent).toBe('The support URL must start with https://.')
    const inert = vi.fn(async () => defaults())
    boot(inert, false); await flush()
    expect(inert).not.toHaveBeenCalled(); expect($('[data-branding-status]').dataset.state).toBe('unavailable')
  })
})
