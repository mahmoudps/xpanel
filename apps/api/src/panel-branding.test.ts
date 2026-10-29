import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { brandingForDocuments, DEFAULT_PANEL_BRANDING, handlePanelBrandingRoute, inspectBrandingImage, parseBrandingFields, servePanelBrandingAsset } from './panel-branding.ts'
import type { PanelBrandingHelpers, PanelBrandingView } from './panel-branding.ts'

const ROOT = { principal: { id: '11111111-1111-4111-8111-111111111111', kind: 'root', username: 'root' }, sessionId: 'one', apiTokenId: null } as AuthenticatedCaller
const RESELLER = { principal: { id: '22222222-2222-4222-8222-222222222222', kind: 'reseller', username: 'r1' }, sessionId: 'two', apiTokenId: null } as AuthenticatedCaller
const stamp = '2026-10-29T08:00:00.000Z'
const text = { companyName: 'Example Hosting', productName: 'Example Panel', footerText: '© 2026 Example Hosting', hidePoweredBy: true, primaryColor: '#1D5BD6', accentColor: '',
  supportUrl: 'https://help.example.com/panel', supportEmail: 'help@example.com', defaultTheme: 'dark', defaultDensity: 'compact' }
const png = (width: number, height: number): Uint8Array => {
  const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); return b
}
const jpeg = (width: number, height: number): Uint8Array => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0, 0, 0, 0])
const ico = (size: number): Uint8Array => { const b = Buffer.alloc(22); b.writeUInt16LE(1, 2); b.writeUInt16LE(1, 4); b[6] = size; b[7] = size; return b }
let root = ''
function harness(caller = ROOT) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const helpers = { requireCaller: vi.fn(async () => caller), emitAudit: vi.fn(async () => undefined), now: () => new Date(stamp),
    assertRoot: vi.fn(async (who: AuthenticatedCaller) => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required') }),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }) } } as unknown as PanelBrandingHelpers
  const call = async (method: string, path: string, body?: string | Uint8Array, type = 'application/json') => {
    const response = await handlePanelBrandingRoute(new Request('http://api.test' + path, { method, ...(body === undefined ? {} : { body: body as BodyInit, headers: { 'content-type': type } }) }), new URL('http://api.test' + path), method, helpers)
    return (await response!.json()) as PanelBrandingView
  }
  return { helpers, call, read: () => call('GET', '/api/server/panel/branding') }
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-branding-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('branding grammar and image inspection', () => {
  it('normalizes colours and refuses markup, insecure links and malformed contacts', () => {
    expect(parseBrandingFields(text)).toMatchObject({ primaryColor: '#1d5bd6', accentColor: '' })
    for (const [patch, field] of [[{ companyName: '<b>x</b>' }, 'companyName'], [{ primaryColor: 'blue' }, 'primaryColor'], [{ supportUrl: 'http://help.example.com' }, 'supportUrl'],
      [{ supportUrl: 'https://u:p@help.example.com' }, 'supportUrl'], [{ supportEmail: 'help' }, 'supportEmail'], [{ defaultTheme: 'auto' }, 'defaultTheme'], [{ productName: 'x'.repeat(41) }, 'productName']] as const) {
      expect(() => parseBrandingFields({ ...text, ...patch }), field).toThrow(expect.objectContaining({ code: 'VALIDATION', detail: expect.objectContaining({ fields: [{ field, code: 'invalid' }] }) }))
    }
  })
  it('reads PNG, JPEG and ICO dimensions and refuses spoofed, oversized or wrongly shaped images', () => {
    expect(inspectBrandingImage('logo', png(240, 64), 'image/png')).toEqual({ contentType: 'image/png', width: 240, height: 64 })
    expect(inspectBrandingImage('logo', jpeg(300, 80), 'image/jpeg')).toEqual({ contentType: 'image/jpeg', width: 300, height: 80 })
    expect(inspectBrandingImage('favicon', ico(32), 'image/x-icon')).toMatchObject({ width: 32, height: 32 })
    const code = (run: () => unknown): string => { try { run(); return 'ok' } catch (error) { return (error as { detail: { fields: { code: string }[] } }).detail.fields[0]!.code } }
    expect(code(() => inspectBrandingImage('logo', png(240, 64), 'image/jpeg'))).toBe('type')
    expect(code(() => inspectBrandingImage('logo', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'))).toBe('type')
    expect(code(() => inspectBrandingImage('favicon', jpeg(32, 32), 'image/jpeg'))).toBe('type')
    expect(code(() => inspectBrandingImage('favicon', png(64, 32), 'image/png'))).toBe('dimensions')
    expect(code(() => inspectBrandingImage('logo', png(5000, 64), 'image/png'))).toBe('dimensions')
    expect(code(() => inspectBrandingImage('logo', new Uint8Array(512 * 1024 + 1), 'image/png'))).toBe('size')
  })
})

describe('branding API and public assets', () => {
  it('saves text revision-bound, uploads and replaces a logo, serves it publicly and removes it', async () => {
    const h = harness(), first = await h.read()
    expect(first).toMatchObject({ state: 'default', branding: DEFAULT_PANEL_BRANDING() })
    const saved = await h.call('PUT', '/api/server/panel/branding', JSON.stringify({ ...text, expectedRevision: first.revision }))
    expect(saved).toMatchObject({ state: 'saved', updatedAt: stamp, branding: { productName: 'Example Panel', primaryColor: '#1d5bd6', logo: null } })
    await expect(h.call('PUT', '/api/server/panel/branding', JSON.stringify({ ...text, expectedRevision: first.revision }))).rejects.toMatchObject({ code: 'CONFLICT' })
    const logo = png(240, 64)
    const uploaded = await h.call('PUT', '/api/server/panel/branding/logo?expectedRevision=' + saved.revision, logo, 'image/png')
    expect(uploaded.branding!.logo).toMatchObject({ contentType: 'image/png', width: 240, height: 64, bytes: logo.byteLength })
    expect(uploaded.branding!.productName).toBe('Example Panel')
    const served = (await servePanelBrandingAsset(h.helpers.store, '/branding/logo'))!
    expect(served.status).toBe(200); expect(served.headers.get('content-type')).toBe('image/png')
    expect(served.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(Buffer.from(await served.arrayBuffer()).equals(Buffer.from(logo))).toBe(true)
    expect(brandingForDocuments(uploaded.branding!).logoUrl).toBe('/branding/logo?v=' + uploaded.branding!.logo!.sha256.slice(0, 16))
    const replaced = await h.call('PUT', '/api/server/panel/branding/logo?expectedRevision=' + uploaded.revision, jpeg(300, 80), 'image/jpeg')
    expect(await readdir(join(root, 'extended', 'panel', 'branding'))).toEqual([`logo-${replaced.branding!.logo!.sha256}.jpg`])
    const removed = await h.call('DELETE', '/api/server/panel/branding/logo?expectedRevision=' + replaced.revision)
    expect(removed.branding!.logo).toBeNull()
    expect((await servePanelBrandingAsset(h.helpers.store, '/branding/logo'))!.status).toBe(404)
    expect(await servePanelBrandingAsset(h.helpers.store, '/branding/other')).toBeNull()
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'panel.branding.logo_uploaded' }))
  })
  it('is root-only and refuses an upload without the observed revision or with an unknown query', async () => {
    await expect(harness(RESELLER).read()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const h = harness(), revision = (await h.read()).revision
    await expect(h.call('PUT', '/api/server/panel/branding/favicon', ico(32), 'image/x-icon')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.call('PUT', '/api/server/panel/branding/favicon?expectedRevision=' + revision + '&x=1', ico(32), 'image/x-icon')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.call('DELETE', '/api/server/panel/branding/favicon?expectedRevision=' + revision)).rejects.toMatchObject({ code: 'VALIDATION' })
    const icon = await h.call('PUT', '/api/server/panel/branding/favicon?expectedRevision=' + revision, ico(32), 'image/x-icon')
    expect(icon.branding!.favicon).toMatchObject({ contentType: 'image/x-icon', width: 32 })
  })
})
