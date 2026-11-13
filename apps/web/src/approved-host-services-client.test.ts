/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Script } from 'node:vm'
import { APPROVED_HOST_SERVICES_CLIENT } from './approved-host-services-client.ts'
import { renderWhmServiceClientTemplates } from './board-port/whm-service-client-templates.ts'
import { renderV2WhmServiceClientTemplates } from './themes/v2/pages/xwhm/host/service-client-templates.ts'
type Request = (method: string, path: string, body?: unknown) => Promise<unknown>
const service = { id: 'apache', label: 'Apache', unit: 'apache2.service', state: 'active' }
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const button = () => document.querySelector<HTMLButtonElement>('button[data-service-id]')!
const status = () => document.querySelector<HTMLElement>('[data-host-service-status]')!
const defaultHostTemplates = renderWhmServiceClientTemplates('host')
const v2HostTemplates = renderV2WhmServiceClientTemplates('host')
const runApprovedHostServices = new Function('confirm', '(' + APPROVED_HOST_SERVICES_CLIENT + ')(confirm);') as (confirm: unknown) => void
const bodyTemplateCache = new Map<string, HTMLTemplateElement>()
const getCachedBodyTemplate = (html: string): HTMLTemplateElement => {
  let tpl = bodyTemplateCache.get(html)
  if (!tpl) {
    tpl = document.createElement('template')
    tpl.innerHTML = html
    bodyTemplateCache.set(html, tpl)
  }
  return tpl
}
beforeAll(() => {
  getCachedBodyTemplate('<section data-host-services ><table><tbody data-host-service-rows></tbody></table><p data-host-service-status></p>' + defaultHostTemplates + '</section>')
  getCachedBodyTemplate('<section data-host-services ><table><tbody data-host-service-rows></tbody></table><p data-host-service-status></p>' + v2HostTemplates + '</section>')
})
const boot = (send: Request, confirm = vi.fn().mockResolvedValue(true), attributes = '', templates = defaultHostTemplates) => {
  const html = '<section data-host-services ' + attributes + '><table><tbody data-host-service-rows></tbody></table><p data-host-service-status></p>' + templates + '</section>'
  const tpl = getCachedBodyTemplate(html)
  document.body.replaceChildren(tpl.content.cloneNode(true))
  ;(window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest = send
  runApprovedHostServices(confirm)
  return confirm
}
beforeEach(() => { document.documentElement.lang = 'en' })
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest; vi.restoreAllMocks() })

describe('confirmed native service restart', () => {
  it.each(['classic', 'v2'] as const)('keeps the selected %s action markup through confirmed restart and verified readback', async theme => {
    const send = vi.fn<Request>().mockResolvedValueOnce({ services: [service] }).mockResolvedValueOnce({ service }).mockResolvedValueOnce({ services: [service] })
    boot(send, undefined, '', theme === 'classic' ? renderWhmServiceClientTemplates('host') : renderV2WhmServiceClientTemplates('host')); await tick()
    expect(button().classList.contains(theme === 'classic' ? 'xp-btn' : 'v2-btn')).toBe(true)
    expect(document.querySelector('[data-host-service-rows] [data-xp-slot="unit"]')?.getAttribute('dir')).toBe('ltr')
    button().click(); await tick()
    expect(send.mock.calls.map(call => call[0])).toEqual(['GET', 'POST', 'GET'])
    expect(status().dataset.state).toBe('active')
    expect(button().classList.contains(theme === 'classic' ? 'xp-btn' : 'v2-btn')).toBe(true)
  })
  it('refuses ambiguous service templates before reading or restarting a service', async () => {
    const templates = renderWhmServiceClientTemplates('host')
    const send = vi.fn<Request>(); boot(send, undefined, '', templates + templates); await tick()
    expect(send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable')
  })
  it('emits standalone JavaScript', () => { expect(() => new Script('(' + APPROVED_HOST_SERVICES_CLIENT + ')();')).not.toThrow(); expect(APPROVED_HOST_SERVICES_CLIENT).not.toContain('__vite_ssr_import_') })
  it('cancels before POST and restores the control', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ services: [service] }); const confirm = boot(send, vi.fn().mockResolvedValue(null)); await tick()
    button().click(); await tick()
    expect(confirm).toHaveBeenCalledTimes(1); expect(send.mock.calls).toEqual([['GET', '/api/server/services']]); expect(button().disabled).toBe(false); expect(status().dataset.state).toBe('cancelled')
  })
  it('blocks duplicate confirmation and submits only once before checking active readback', async () => {
    let done!: (value: boolean) => void
    const send = vi.fn<Request>().mockResolvedValueOnce({ services: [service] }).mockResolvedValueOnce({ service }).mockResolvedValueOnce({ services: [service] })
    const confirm = boot(send, vi.fn().mockImplementation(() => new Promise(resolve => { done = resolve }))); await tick()
    button().click(); button().dispatchEvent(new MouseEvent('click')); expect(confirm).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1)
    done(true); await tick()
    expect(send.mock.calls).toEqual([['GET', '/api/server/services'], ['POST', '/api/server/services/apache/restart', {}], ['GET', '/api/server/services']])
    expect(status().dataset.state).toBe('active'); expect(button().disabled).toBe(false)
  })
  it.each([{ status: 503 }, { status: 409, unknownOutcome: true, details: { stateChanged: false } }])('locks uncertain restart outcomes: %j', async error => {
    const send = vi.fn<Request>().mockResolvedValueOnce({ services: [service] }).mockRejectedValueOnce(error); boot(send); await tick(); button().click(); await tick(); button().dispatchEvent(new MouseEvent('click')); await tick()
    expect(send).toHaveBeenCalledTimes(2); expect(button().disabled).toBe(true); expect(status().dataset.state).toBe('uncertain')
  })
  it('permits correction after a definite refusal without claiming restart', async () => {
    const send = vi.fn<Request>().mockResolvedValueOnce({ services: [service] }).mockRejectedValueOnce({ status: 403, details: { stateChanged: false } }); boot(send); await tick(); button().click(); await tick()
    expect(button().disabled).toBe(false); expect(status().dataset.state).toBe('failed'); expect(status().textContent).not.toContain('completed')
  })
  it('keeps review required after a successful POST followed by a readback refusal', async () => {
    const send = vi.fn<Request>().mockResolvedValueOnce({ services: [service] }).mockResolvedValueOnce({ service }).mockRejectedValueOnce({ status: 403, details: { stateChanged: false } }); boot(send); await tick(); button().click(); await tick()
    expect(button().disabled).toBe(true); expect(status().dataset.state).toBe('uncertain')
  })
  it('does not claim an active restart for mismatched or inactive receipts', async () => {
    const send = vi.fn<Request>().mockResolvedValueOnce({ services: [service] }).mockResolvedValueOnce({ service: { ...service, state: 'inactive' } }); boot(send); await tick(); button().click(); await tick()
    expect(status().dataset.state).toBe('uncertain'); expect(send).toHaveBeenCalledTimes(2)
  })
  it('reads an unavailable service component but never mutates it', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ services: [service] }); boot(send, vi.fn().mockResolvedValue(true), 'data-capability-unavailable="true"'); await tick()
    button()?.click(); await tick()
    expect(send).toHaveBeenCalled(); expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true); expect(button()?.disabled ?? true).toBe(true)
  })
})

describe('PHP-FPM version rows', { tags: ['unit'] }, () => {
  const fpm = (version: string, masters: number, running: number, failed: number) => ({
    id: 'php-fpm-' + version.replace('.', ''), label: 'PHP-FPM ' + version, unit: null, fpm: { version, masters, running, failed },
    state: masters > 0 && running === masters ? 'active' : failed > 0 ? 'failed' : 'inactive',
  })
  const versions = [fpm('8.2', 3, 2, 1), fpm('8.3', 2, 2, 0), fpm('8.4', 0, 0, 0), fpm('8.1', 2, 1, 0)]
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-service-key="${id}"]`)!
  const slot = (id: string, name: string) => row(id).querySelector(`[data-xp-slot="${name}"]`)?.textContent

  it('shows each installed version with its master counts and restarts only versions that have masters', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ services: [service, ...versions] }); boot(send); await tick()
    expect(['php-fpm-82', 'php-fpm-83', 'php-fpm-84', 'php-fpm-81'].map(id => slot(id, 'state'))).toEqual(['Partly failed: 1 of 3 masters failed', 'Running: 2 of 2 masters', 'No account masters', 'Stopped: 1 of 2 masters'])
    expect(slot('php-fpm-83', 'unit')).toBe('xpanel-php-fpm-*-8.3.service')
    expect(slot('php-fpm-83', 'version')).toBe('8.3')
    expect(slot('php-fpm-83', 'role')).toBe('PHP pools: 2 account masters, each in its slice')
    expect(slot('php-fpm-84', 'role')).toBe('No account uses this PHP version')
    expect(row('php-fpm-84').dataset.serviceArea).toBe('web')
    expect([...document.querySelectorAll<HTMLButtonElement>('button[data-service-id]')].map(item => item.dataset.serviceId)).toEqual(['apache', 'php-fpm-82', 'php-fpm-83', 'php-fpm-81'])
  })

  it('confirms the version restart by master count and verifies the read-back by id', async () => {
    const send = vi.fn<Request>().mockResolvedValueOnce({ services: versions }).mockResolvedValueOnce({ service: versions[1] }).mockResolvedValueOnce({ services: versions })
    const confirm = boot(send); await tick()
    row('php-fpm-83').querySelector<HTMLButtonElement>('button[data-service-id]')!.click(); await tick()
    expect(confirm.mock.calls[0]![0]).toMatchObject({ body: 'Restart all 2 PHP-FPM 8.3 account masters? PHP requests in progress fail.' })
    expect(send.mock.calls[1]).toEqual(['POST', '/api/server/services/php-fpm-83/restart', {}])
    expect(status().dataset.state).toBe('active')
  })

  it('does not claim a restart while any master of the version is still down', async () => {
    const send = vi.fn<Request>().mockResolvedValueOnce({ services: versions }).mockResolvedValueOnce({ service: versions[0] })
    boot(send); await tick()
    row('php-fpm-82').querySelector<HTMLButtonElement>('button[data-service-id]')!.click(); await tick()
    expect(status().dataset.state).toBe('uncertain')
  })

  it.each([
    { ...fpm('8.3', 2, 1, 0), state: 'active' }, { ...fpm('8.3', 1, 1, 1) }, { ...fpm('8.3', 1, 1, 0), id: 'php-fpm-84' }, { ...fpm('8.3', 1, 1, 0), unit: 'xpanel-php-fpm-alice-8.3.service' },
  ])('refuses a version row whose counts, id or unit disagree: %j', async bad => {
    const send = vi.fn<Request>().mockResolvedValue({ services: [bad] }); boot(send); await tick()
    expect(status().dataset.state).toBe('failed'); expect(button()).toBeNull()
  })
})
