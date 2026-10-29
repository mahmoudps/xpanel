// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmPanelSettingsWorkspace } from './board-port/whm-panel-settings-workspace.ts'
import { readPanelSettingsView, WHM_PANEL_SETTINGS_CLIENT_BINDING } from './whm-panel-settings-client.ts'
import type { PanelSettingsView } from './whm-panel-settings-client.ts'

const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64), STAMP = '2026-10-29T08:00:00.000Z'
const defaults = (): PanelSettingsView => ({ state: 'default', settings: { offlineMode: false, offlineMessage: '', developerMode: false, liveUpdates: true, reverseProxyAllowedHosts: [] }, updatedAt: null, revision: R1 })
type Requester = (method: string, path: string, body?: unknown) => Promise<unknown>
const flush = async () => { for (let index = 0; index < 10; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const input = <T extends Element = HTMLInputElement>(key: string): T => $<T>(`[data-panel-settings-input="${key}"]`)
const boot = (send?: Requester, canManage = true, confirm: unknown = async () => true) => {
  document.body.innerHTML = renderWhmPanelSettingsWorkspace({ locale: 'en', canManage })
  if (send) (window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest = send
  new Function('return ' + WHM_PANEL_SETTINGS_CLIENT_BINDING)()(confirm)
}
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest })
afterEach(() => { document.body.innerHTML = '' })

describe('panel settings page', () => {
  it('parses only exact views and renders both locales without a form submit path', () => {
    expect(readPanelSettingsView(defaults())).toEqual(defaults())
    for (const bad of [{ ...defaults(), extra: 1 }, { ...defaults(), updatedAt: STAMP }, { ...defaults(), settings: { ...defaults().settings, liveUpdates: 'yes' } },
      { ...defaults(), settings: { ...defaults().settings, reverseProxyAllowedHosts: ['<b>'] } }]) expect(() => readPanelSettingsView(bad)).toThrow()
    for (const locale of ['en', 'ar'] as const) {
      const html = renderWhmPanelSettingsWorkspace({ locale, canManage: true })
      expect(html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`); expect(html).not.toMatch(/[٠-٩]/); expect(html).not.toContain('<form')
      for (const hook of ['offlineMode', 'offlineMessage', 'developerMode', 'liveUpdates', 'reverseProxyAllowedHosts']) expect(html).toContain(`data-panel-settings-input="${hook}"`)
      // The textarea label starts where the textarea text starts (its inline padding plus border).
      expect(html).toContain('.xp-whm-panel-settings__control>label[for]{padding-inline:13px}')
    }
  })

  it('reads, confirms going offline, saves with the captured revision and reads back', async () => {
    const saved: PanelSettingsView = { state: 'saved', settings: { offlineMode: true, offlineMessage: 'Back soon.', developerMode: true, liveUpdates: false, reverseProxyAllowedHosts: ['203.0.113.9'] }, updatedAt: STAMP, revision: R2 }
    let current = defaults()
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      expect(path).toBe('/api/server/panel/settings')
      if (method === 'PUT') { expect(body).toEqual({ ...saved.settings, expectedRevision: R1 }); current = saved }
      return structuredClone(current)
    })
    const confirm = vi.fn(async () => true)
    boot(send, true, confirm); await flush()
    expect($('[data-panel-settings-status]').dataset.state).toBe('read'); expect(input<HTMLTextAreaElement>('offlineMessage').disabled).toBe(true)
    input('offlineMode').checked = true; input('offlineMode').dispatchEvent(new Event('change'))
    expect(input<HTMLTextAreaElement>('offlineMessage').disabled).toBe(false)
    input<HTMLTextAreaElement>('offlineMessage').value = ' Back soon. '; input('developerMode').checked = true; input('liveUpdates').checked = false
    input<HTMLTextAreaElement>('reverseProxyAllowedHosts').value = '203.0.113.9\n\n'
    $<HTMLButtonElement>('[data-panel-settings-save]').click(); await flush()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(send.mock.calls.map(call => call[0])).toEqual(['GET', 'PUT', 'GET'])
    expect($('[data-panel-settings-save-status]').dataset.state).toBe('saved'); expect($('[data-panel-settings-updated]').textContent).toBe('2026-10-29 08:00 UTC')
  })

  it('sends nothing when going offline is declined, reports a stale revision and stays inert without root access', async () => {
    const send = vi.fn(async (method: string) => { if (method === 'PUT') throw Object.assign(new Error('stale'), { status: 409, details: { stateChanged: false } }); return defaults() })
    boot(send, true, async () => false); await flush()
    input('offlineMode').checked = true; $<HTMLButtonElement>('[data-panel-settings-save]').click(); await flush()
    expect(send.mock.calls.map(call => call[0])).toEqual(['GET'])
    input('offlineMode').checked = false; input('developerMode').checked = true; $<HTMLButtonElement>('[data-panel-settings-save]').click(); await flush()
    expect($('[data-panel-settings-save-status]').dataset.state).toBe('stale'); expect($<HTMLButtonElement>('[data-panel-settings-save]').disabled).toBe(true)
    const inert = vi.fn(async () => defaults())
    boot(inert, false); await flush()
    expect(inert).not.toHaveBeenCalled(); expect($('[data-panel-settings-status]').dataset.state).toBe('unavailable')
  })
})
