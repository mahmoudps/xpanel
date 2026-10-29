import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { panelConfigRevision } from './panel-config-file.ts'
import { DEFAULT_PANEL_SETTINGS, handlePanelSettingsRoute, panelOfflineAdmits, panelSettingsFile, parsePanelSettingsFields } from './panel-settings.ts'
import type { PanelSettingsHelpers, PanelSettingsView } from './panel-settings.ts'

const ROOT = { principal: { id: '11111111-1111-4111-8111-111111111111', kind: 'root', username: 'root' }, sessionId: 'one', apiTokenId: null } as AuthenticatedCaller
const RESELLER = { principal: { id: '22222222-2222-4222-8222-222222222222', kind: 'reseller', username: 'reseller1' }, sessionId: 'two', apiTokenId: null } as AuthenticatedCaller
const stamp = '2026-10-29T08:00:00.000Z'
const fields = { offlineMode: true, offlineMessage: 'Back at 10:00 UTC.', developerMode: true, liveUpdates: false, reverseProxyAllowedHosts: ['203.0.113.9', 'Origin.Example.org'] }
let root = ''
function harness(caller = ROOT) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const helpers = { requireCaller: vi.fn(async () => caller), emitAudit: vi.fn(async () => undefined), now: () => new Date(stamp),
    assertRoot: vi.fn(async (who: AuthenticatedCaller) => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required') }),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }) } } as unknown as PanelSettingsHelpers
  const send = (method = 'GET', body?: unknown, path = '/api/server/panel/settings') => handlePanelSettingsRoute(new Request('http://api.test' + path, { method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://api.test' + path), method, helpers)
  const read = async () => (await (await send())!.json()) as PanelSettingsView
  return { helpers, lease, send, read }
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-panel-settings-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('panel settings grammar', () => {
  it('normalizes allowed hosts and refuses malformed values with a field code', () => {
    expect(parsePanelSettingsFields(fields).reverseProxyAllowedHosts).toEqual(['203.0.113.9', 'origin.example.org'])
    expect(parsePanelSettingsFields({ ...fields, reverseProxyAllowedHosts: ['[2001:db8::1]'] }).reverseProxyAllowedHosts).toEqual(['2001:db8::1'])
    for (const [patch, field] of [[{ offlineMode: 'yes' }, 'offlineMode'], [{ offlineMessage: 'a\nb' }, 'offlineMessage'], [{ offlineMessage: 'x'.repeat(281) }, 'offlineMessage'],
      [{ reverseProxyAllowedHosts: ['bad host'] }, 'reverseProxyAllowedHosts'], [{ reverseProxyAllowedHosts: ['a.example', 'A.example'] }, 'reverseProxyAllowedHosts'],
      [{ reverseProxyAllowedHosts: Array.from({ length: 33 }, (_, i) => `h${i}.example`) }, 'reverseProxyAllowedHosts']] as const) {
      expect(() => parsePanelSettingsFields({ ...fields, ...patch })).toThrow(expect.objectContaining({ code: 'VALIDATION', detail: expect.objectContaining({ fields: [{ field, code: 'invalid' }] }) }))
    }
  })
  it('keeps only identity and sign-out for non-root sessions while offline', () => {
    expect(panelOfflineAdmits('/api/accounts', 'root')).toBe(true)
    expect(panelOfflineAdmits('/api/auth/me', 'user')).toBe(true)
    expect(panelOfflineAdmits('/api/domains', 'reseller')).toBe(false)
  })
})

describe('panel settings API', () => {
  it('reads defaults, saves revision-bound, reads back and audits without the message text', async () => {
    const h = harness()
    const first = await h.read()
    expect(first).toEqual({ state: 'default', settings: DEFAULT_PANEL_SETTINGS(), updatedAt: null, revision: panelConfigRevision('panel-settings:v1', null) })
    const saved = await (await h.send('PUT', { ...fields, expectedRevision: first.revision }))!.json() as PanelSettingsView
    expect(saved).toMatchObject({ state: 'saved', updatedAt: stamp, settings: { ...fields, reverseProxyAllowedHosts: ['203.0.113.9', 'origin.example.org'] } })
    expect(await h.read()).toEqual(saved)
    expect(JSON.parse(await readFile(join(root, 'extended', 'panel', 'settings.json'), 'utf8'))).toMatchObject({ version: 1, updatedAt: stamp, offlineMode: true })
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'panel.settings.updated', detail: expect.not.objectContaining({ offlineMessage: expect.anything() }) }))
    expect(await panelSettingsFile(h.helpers.store).current()).toMatchObject({ offlineMode: true, liveUpdates: false })
    await expect(h.send('PUT', { ...fields, expectedRevision: first.revision })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
  })
  it('is root-only, strict about keys and query selectors, and refuses to overwrite an invalid saved file', async () => {
    await expect(harness(RESELLER).send()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const h = harness(), revision = (await h.read()).revision
    await expect(h.send('PUT', { ...fields, expectedRevision: revision, extra: 1 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('GET', undefined, '/api/server/panel/settings?x=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await h.send('GET', undefined, '/api/server/panel/settings/x')).toBeNull()
    await mkdir(join(root, 'extended', 'panel'), { recursive: true })
    await writeFile(join(root, 'extended', 'panel', 'settings.json'), JSON.stringify({ version: 1, offlineMode: 'on' }))
    const broken = await h.read()
    expect(broken).toMatchObject({ state: 'invalid', settings: null })
    // A damaged file never takes the panels offline: effects fall back to the defaults.
    expect(await panelSettingsFile(h.helpers.store).current()).toEqual(DEFAULT_PANEL_SETTINGS())
    await expect(h.send('PUT', { ...fields, expectedRevision: broken.revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
