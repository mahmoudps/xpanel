// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderClassicSvcPanels } from './board-port/svc-panels-workspace.ts'
import { SVC_PANELS_CLIENT_BINDING } from './svc-panels-client.ts'
import { v2Messages } from './themes/v2/messages.ts'
import { renderV2SvcPanels } from './themes/v2/pages/xwhm/svc-panels.ts'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
type Theme = 'classic' | 'v2'
const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64)
const tick = async () => { for (let index = 0; index < 12; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const panel = (id: string) => $(`[data-svc-panel="${id}"]`)
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll('button')].find(item => item.textContent === text)!
const html = (theme: Theme, route: string, canManage: boolean): string => theme === 'classic'
  ? renderClassicSvcPanels(route, { locale: 'en', canRead: true, canManage: () => canManage })
  : renderV2SvcPanels(route, v2Messages.translator('en'), 'en', true, () => canManage)
const boot = async (theme: Theme, route: string, send: Send, canManage = true, ask?: (options: Record<string, unknown>) => Promise<unknown>) => {
  document.body.innerHTML = html(theme, route, canManage)
  ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + SVC_PANELS_CLIENT_BINDING)()(ask)
  await tick()
}
afterEach(() => { document.body.innerHTML = '' })

const THEMES = ['classic', 'v2'] as const
describe.each(THEMES)('services centre client in %s', theme => {
  const traceroute = { state: 'saved', policy: { allowed: false }, updatedAt: '2026-11-07T10:00:00.000Z', revision: R1, observation: { state: 'drift', binaries: [{ path: '/usr/bin/traceroute.db', mode: 0o755 }] }, reason: null }
  const forkBomb = { state: 'default', policy: { enabled: false }, updatedAt: null, revision: R1, observation: { application: 'pam_missing', pam: false, expectedUsers: 2, limitedUsers: 2, limits: { nproc: 35, nofile: 100, data: 200000, stack: 8192, core: 200000 } }, reason: null }
  const isolation = (path: string): unknown => path.endsWith('/traceroute') ? traceroute : forkBomb

  it('paints host facts with their labels and never invents a missing one', async () => {
    await boot(theme, '/whm/security/isolation', vi.fn(async (_method, path) => isolation(path)))
    const root = panel('traceroute')
    expect(root.querySelector('[data-svc-field="observation.state"]')!.textContent).toBe('Drift: the host differs from the saved choice')
    expect(root.querySelector('tbody')!.textContent).toContain('/usr/bin/traceroute.db')
    expect(root.querySelector('tbody')!.textContent).toContain('0755')
    expect(panel('fork-bomb').querySelector('[data-svc-field="observation.application"]')!.textContent).toBe('Saved, but PAM does not load pam_limits for SSH, so the limits do nothing')
    expect(panel('fork-bomb').querySelector('[data-svc-field="observation.pam"]')!.textContent).toBe('No')
  })
  it('saves the revision it read and reports that the server was asked to apply', async () => {
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      void body
      return method === 'PUT' ? { ...traceroute, revision: R2, reconcile: 'requested' } : isolation(path)
    })
    await boot(theme, '/whm/security/isolation', send)
    const root = panel('traceroute'), box = root.querySelector<HTMLInputElement>('[data-svc-input="policy.allowed"]')!
    box.checked = true
    button(root, 'Save').click()
    await tick()
    expect(send.mock.calls.find(([method]) => method === 'PUT')).toEqual(['PUT', '/api/server/sec/traceroute', { expectedRevision: R1, policy: { allowed: true } }])
    expect(root.querySelector('[data-svc-status]')!.textContent).toContain('asked to apply')
  })
  it('keeps writes closed when the tool is not admitted, and reads anyway', async () => {
    const send = vi.fn(async (_method: string, path: string) => isolation(path))
    await boot(theme, '/whm/security/isolation', send, false)
    const root = panel('traceroute')
    expect(button(root, 'Save').disabled).toBe(true)
    expect(root.querySelector<HTMLInputElement>('[data-svc-input="policy.allowed"]')!.disabled).toBe(true)
    expect(button(root, 'Refresh').disabled).toBe(false)
  })
  it('says a stale save changed nothing', async () => {
    const send = vi.fn(async (method: string, path: string) => { if (method === 'PUT') throw Object.assign(new Error('conflict'), { status: 409 }); return isolation(path) })
    await boot(theme, '/whm/security/isolation', send)
    const root = panel('traceroute')
    button(root, 'Save').click()
    await tick()
    expect(root.querySelector('[data-svc-status]')!.textContent).toContain('Nothing was changed')
  })
  it('stages a new rule, toggles it, and deploys only after confirmation', async () => {
    const rule = 'SecRule ARGS "@rx x" "id:7,deny"'
    let policy: Record<string, unknown> = { engine: 'inherit', deployedEngine: 'inherit', staged: [], deployed: [] }
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'PUT' && path.endsWith('/waf-rules')) policy = (body as { policy: Record<string, unknown> }).policy
      return path.endsWith('/waf-rules') ? { state: 'saved', policy, revision: R1, observation: { hits: [] }, engineLive: null, reason: null, reconcile: null } : path.endsWith('/waf-vendors') ? { state: 'default', policy: { crsDisabledFiles: [], vendors: [] }, revision: R1, observation: { crs: [], vendors: {} } } : { ok: true }
    })
    const ask = vi.fn(async () => false)
    await boot(theme, '/whm/security/waf', send, true, ask)
    const root = panel('waf-rules')
    root.querySelector<HTMLInputElement>('[data-svc-input="id"]')!.value = '7'
    root.querySelector<HTMLTextAreaElement>('[data-svc-input="text"]')!.value = rule
    button(root, 'Stage rule').click()
    await tick()
    expect(policy.staged).toEqual([{ enabled: true, id: 7, note: '', text: rule }])
    button(root, 'Enable or disable').click()
    await tick()
    expect((policy.staged as { enabled: boolean }[])[0]!.enabled).toBe(false)
    button(root, 'Deploy and test').click()
    await tick()
    expect(ask).toHaveBeenCalled()
    expect(send.mock.calls.some(([, path]) => path.endsWith('/deploy'))).toBe(false)
    ask.mockResolvedValue(true)
    button(root, 'Deploy and test').click()
    await tick()
    expect(send.mock.calls.find(([, path]) => path.endsWith('/deploy'))).toEqual(['POST', '/api/server/sec/waf-rules/deploy', { expectedRevision: R1 }])
  })
  it('switches one rule file through the policy of its owner', async () => {
    const policy = { crsDisabledFiles: [], vendors: [{ id: 'acme', name: 'Acme', version: '1', enabled: true, autoUpdate: false, disabledFiles: [], metadataUrl: 'https://x.test/m' }] }
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      void body
      return path.endsWith('/waf-vendors') ? { state: 'saved', policy, revision: R1, observation: { crs: ['a.conf'], vendors: { acme: ['b.conf'] }, installed: { acme: { version: '2' } } }, reason: null } : { state: 'default', policy: { engine: 'inherit', deployedEngine: 'inherit', staged: [], deployed: [] }, revision: R1 }
    })
    await boot(theme, '/whm/security/waf', send)
    const root = panel('waf-vendors'), rows = [...root.querySelectorAll('tbody')].at(1)!.querySelectorAll('tr')
    expect(root.querySelector('tbody')!.textContent).toContain('2')
    rows[1]!.querySelector('button')!.click()
    await tick()
    const put = send.mock.calls.find(([method, path]) => method === 'PUT' && path.endsWith('/waf-vendors'))![2] as { policy: typeof policy }
    expect(put.policy.vendors[0]!.disabledFiles).toEqual(['b.conf'])
    expect(put.policy.crsDisabledFiles).toEqual([])
  })
  it('sends a reselected PHP version and a return to the server defaults', async () => {
    const fpm = { mode: 'ondemand', maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 }
    const send = vi.fn(async (_method: string, path: string, body?: unknown) => {
      void body
      return path.endsWith('/manage') ? { revision: R1, domains: [{ name: 'a.test', account: 'alice', version: '8.3', handler: 'fpm', inherited: true, fpm }] } : path.endsWith('/php-fpm-defaults') ? { state: 'default', policy: { pool: fpm, ini: { allow_url_fopen: null, short_open_tag: null, log_errors: null, error_reporting: null } }, revision: R1, observation: null } : { ok: true }
    })
    await boot(theme, '/whm/software/php', send)
    const root = panel('php-domains')
    root.querySelector('tbody button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(root.querySelector<HTMLInputElement>('[data-svc-input="domain"]')!.value).toBe('a.test')
    button(root, 'Return to server defaults').click()
    await tick()
    expect(send.mock.calls.find(([, path]) => path === '/api/server/php/domain')).toEqual(['POST', '/api/server/php/domain', { domain: 'a.test', version: '8.3', fpm: null, expectedRevision: R1 }])
  })
  it('leaves an INI default unset until one is chosen', async () => {
    const fpm = { mode: 'ondemand', maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 }
    const ini = { allow_url_fopen: null, short_open_tag: null, log_errors: null, error_reporting: null }
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      void body
      return path.endsWith('/php-fpm-defaults') ? { state: 'default', policy: { pool: fpm, ini }, revision: R1, observation: null, reconcile: method === 'PUT' ? 'requested' : undefined } : { revision: R1, domains: [] }
    })
    await boot(theme, '/whm/software/php', send)
    const root = panel('php-fpm-defaults')
    root.querySelector<HTMLSelectElement>('[data-svc-input="policy.ini.short_open_tag.value"]')!.value = 'Off'
    root.querySelector<HTMLInputElement>('[data-svc-input="policy.ini.short_open_tag.locked"]')!.checked = true
    button(root, 'Save').click()
    await tick()
    const put = send.mock.calls.find(([method]) => method === 'PUT')![2] as { policy: { ini: Record<string, unknown> } }
    expect(put.policy.ini).toEqual({ ...ini, short_open_tag: { value: 'Off', locked: true } })
  })
})
