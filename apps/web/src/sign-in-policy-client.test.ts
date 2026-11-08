// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultServerWebSettings, parseTweakValues, suggestServerSettings } from '@xpanel/core'
import type { ServerSettings } from '@xpanel/core'
import { tools } from '@xpanel/catalog'
import { renderWhmDetailPage } from './board-port/approved-xwhm.ts'
import { renderV2WhmSecurityOverview } from './themes/v2/pages/xwhm/security/overview.ts'
import { renderV2WhmSetup } from './themes/v2/pages/xwhm/server/setup.ts'
import { renderV2WhmWebServer } from './themes/v2/pages/xwhm/service-tools/web.ts'
import { v2Messages } from './themes/v2/messages.ts'
import { AUTHORITATIVE_CONTROLLER_DECLARATIONS } from './themes/controller-hooks.ts'
import { checkControllerDeclarations } from './themes/controller-conformance.ts'
import { parseMarkup } from './themes/markup.ts'
import { buildSignInPolicy, readSignInLockouts, SIGN_IN_POLICY_CLIENT_BINDING } from './sign-in-policy-client.ts'
import { buildWebDirectives, WHM_WEB_DIRECTIVES_CLIENT_BINDING } from './whm-web-directives-client.ts'
import { WHM_TWEAK_SETTINGS_CLIENT_BINDING } from './whm-tweak-settings-client.ts'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
type Theme = 'classic' | 'v2'
const tick = async () => { for (let index = 0; index < 10; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const ROOT = { kind: 'root' as const, id: 'synthetic-root', username: 'synthetic-root' }
const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64)
const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
const settings: ServerSettings = { hostname: 'srv1.example.test', nameservers: ['ns1.example.test', 'ns2.example.test'], adminEmail: 'ops@example.test', engine: 'apache', apacheMpm: 'itk',
  panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 }
const catalog = tools.map(tool => tool.id === 'server-settings-edit' ? { ...tool, status: 'verified' as const } : tool)
const policy = () => ({ lockout: { username: { attempts: 5, windowMin: 15, durationMin: 15 }, ip: { attempts: 5, windowMin: 15, durationMin: 15 }, ipAllow: [], ipDeny: [] },
  passwordStrength: { default: 0, perService: { panel: null, mail: null, ftp: null, database: null, webdisk: null, directory: null } }, session: { idleMin: 30, absoluteHours: 24 } })
const page = (theme: Theme, route: '/whm/security' | '/whm/services/web' | '/whm/server/setup'): string => {
  if (theme === 'classic') return renderWhmDetailPage({ activeRoute: route, principal: ROOT, locale: 'en', catalog, serverSettings: settings })!
  if (route === '/whm/security') return renderV2WhmSecurityOverview({ activeRoute: route, principal: ROOT, locale: 'en', observationAuthority: { canRead: true, canManage: true } })
  if (route === '/whm/services/web') return renderV2WhmWebServer({ activeRoute: route, principal: ROOT, locale: 'en', serverSettings: settings, dataAuthority: { canRead: true, canManage: true } })
  return renderV2WhmSetup(v2Messages.translator('en'), { activeRoute: route, principal: ROOT, locale: 'en', serverSettings: settings }, { canRead: true, canManage: true })
}
const boot = (html: string, binding: string, send: Send, ask?: (options: Record<string, unknown>) => Promise<unknown>) => {
  document.body.innerHTML = html
  ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + binding)()(ask)
}
afterEach(() => { document.body.innerHTML = ''; delete (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest })

describe('sign-in policy, web directive and tweak setting readers', { tags: ['unit'] }, () => {
  it('applies only the shown fields to the saved policy', () => {
    const next = buildSignInPolicy(policy(), { 'lockout.username.attempts': '3', 'lockout.ipAllow': '198.51.100.7\n 2001:db8::/48 ', 'passwordStrength.perService.mail': '70', 'passwordStrength.perService.ftp': '' })
    expect(next).toMatchObject({ lockout: { username: { attempts: 3, windowMin: 15 }, ipAllow: ['198.51.100.7', '2001:db8::/48'] }, passwordStrength: { perService: { mail: 70, ftp: null } } })
    expect(() => buildSignInPolicy(policy(), { 'lockout.username.attempts': '2.5' })).toThrow()
    expect(() => buildSignInPolicy(policy(), { 'lockout.username': '3' })).toThrow()
    expect(() => readSignInLockouts({ lockouts: [{ username: 'root', ip: '198.51.100.7', failures: 3, lockedUntil: '2026-11-06T10:00:00.000Z' }] })).toThrow()
  })

  it('builds the complete web directives from the form values', () => {
    const fields = { 'web.timeoutSec': '90', 'web.clientMaxBodyMb': '256', 'web.tlsProtocols': ['TLSv1.3'], 'web.tlsCiphers': ' HIGH:!aNULL ', 'web.gzip.enabled': true, 'web.gzip.level': '6',
      'web.directoryIndex': 'index.html\nindex.php', 'web.rlimitMemMb': '', 'web.rlimitCpuSec': '240', 'web.includes.apachePreMain': '', 'web.includes.apachePreVhost': '', 'web.includes.apachePostVhost': '', 'web.includes.nginxHttp': 'server_tokens off;' }
    expect(buildWebDirectives(fields)).toEqual({ ...defaultServerWebSettings(), timeoutSec: 90, clientMaxBodyMb: 256, tlsProtocols: ['TLSv1.3'], tlsCiphers: 'HIGH:!aNULL', gzip: { enabled: true, level: 6 },
      directoryIndex: ['index.html', 'index.php'], rlimitCpuSec: 240, includes: { ...defaultServerWebSettings().includes, nginxHttp: 'server_tokens off;' } })
    expect(() => buildWebDirectives({ ...fields, 'web.timeoutSec': 'soon' })).toThrow()
  })
})

describe.each(['classic', 'v2'] as const)('%s theme', theme => {
  it('mounts every declared control of the three controllers', () => {
    for (const [id, route] of [['sign-in-policy', '/whm/security'], ['whm-web-directives', '/whm/services/web'], ['whm-tweak-settings', '/whm/server/setup']] as const) {
      const declaration = AUTHORITATIVE_CONTROLLER_DECLARATIONS.find(item => item.id === id)!
      expect(checkControllerDeclarations(parseMarkup(`<html><body>${page(theme, route)}</body></html>`), [declaration], { route, surface: 'xwhm', qualified: true }), id).toEqual([])
    }
  })

  it('reads the sign-in policy, saves the shown fields and lifts a lock', async () => {
    const lockouts = { at: '2026-11-06T09:00:00.000Z', truncated: false, lockouts: [{ id: 'l1', username: null, ip: '203.0.113.9', failures: 5, lockedUntil: '2026-11-06T09:15:00.000Z', createdAt: '2026-11-06T09:00:00.000Z' }] }
    const send = vi.fn<Send>(async (method, path) => path === '/api/server/sec/sign-in/lockouts' ? lockouts
      : path === '/api/server/sec/sign-in/unlock' ? { cleared: 1 }
        : { state: method === 'PUT' ? 'saved' : 'default', policy: method === 'PUT' ? { ...policy(), lockout: { ...policy().lockout, username: { attempts: 3, windowMin: 15, durationMin: 15 } } } : policy(), updatedAt: null, revision: method === 'PUT' ? R2 : R1, client: { address: '127.0.0.1' } })
    boot(page(theme, '/whm/security'), SIGN_IN_POLICY_CLIENT_BINDING, send, async () => true); await tick()
    const attempts = $<HTMLInputElement>('[data-sign-in-field="lockout.username.attempts"]')
    expect([attempts.value, attempts.disabled, $('[data-sign-in-lockouts]').textContent]).toEqual(['5', false, expect.stringContaining('203.0.113.9')])
    attempts.value = '3'
    $<HTMLButtonElement>('[data-sign-in-save]').click(); await tick()
    const put = send.mock.calls.find(([method]) => method === 'PUT')!
    expect(put[2]).toMatchObject({ expectedRevision: R1, policy: { lockout: { username: { attempts: 3 } }, session: { idleMin: 30 } } })
    expect($('[data-sign-in-status]').dataset.state).toBe('saved')
    expect($<HTMLButtonElement>('[data-sign-in-unlock="username"]').disabled).toBe(true)
    $<HTMLButtonElement>('[data-sign-in-unlock="ip"]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/sec/sign-in/unlock', { ip: '203.0.113.9' })
  })

  it('sends the complete web directives with the saved settings and reports a refused test', async () => {
    const send = vi.fn<Send>(async method => {
      if (method === 'GET') return { settings }
      throw { status: 422, code: 'CONFIG_TEST_FAILED', details: { stateChanged: false, failedTest: 'nginx', error: 'unknown directive' } }
    })
    boot(page(theme, '/whm/services/web'), WHM_WEB_DIRECTIVES_CLIENT_BINDING, send)
    $<HTMLTextAreaElement>('[name="web.includes.nginxHttp"]').value = 'bogus_directive on;'
    $<HTMLFormElement>('[data-web-directives-form]').dispatchEvent(new Event('submit', { cancelable: true })); await tick()
    const put = send.mock.calls.find(([method]) => method === 'PUT')!
    expect(put[1]).toBe('/api/server/settings')
    expect(put[2]).toMatchObject({ hostname: 'srv1.example.test', markSetupComplete: false, web: { ...defaultServerWebSettings(), includes: { ...defaultServerWebSettings().includes, nginxHttp: 'bogus_directive on;' } } })
    expect($('[data-web-directives-status]').textContent).toContain('The nginx test refused the new directives')
  })

  it('fills saved values in the settings browser, filters rows and saves a tweak', async () => {
    const send = vi.fn<Send>(async (method, path) => path === '/api/server/settings-index' ? { values: { 'server.healthCheckMinutes': 5, hostname: 'srv1.example.test', 'web.directoryIndex': ['index.php', 'index.html'] } }
      : { state: method === 'PUT' ? 'saved' : 'default', revision: method === 'PUT' ? R2 : R1, values: { ...parseTweakValues(null), 'server.healthCheckMinutes': method === 'PUT' ? 30 : 5 }, definitions: [] })
    boot(page(theme, '/whm/server/setup'), WHM_TWEAK_SETTINGS_CLIENT_BINDING, send); await tick()
    expect($('[data-setting-value="web.directoryIndex"]').textContent).toBe('index.php, index.html')
    const input = $<HTMLInputElement>('[data-tweak-input="server.healthCheckMinutes"]')
    expect([input.value, input.disabled]).toEqual(['5', false])
    const search = $<HTMLInputElement>('[data-tweak-search]')
    search.value = 'directoryindex'; search.dispatchEvent(new Event('input'))
    expect([...document.querySelectorAll<HTMLElement>('[data-setting-row]')].filter(row => !row.hidden).length).toBe(1)
    expect([$('[data-setting-group="compression"]').hidden, $('[data-setting-group="web"]').hidden]).toEqual([true, false])
    input.value = '30'
    $<HTMLButtonElement>('[data-tweak-save]').click(); await tick()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/tweak-settings', { expectedRevision: R1, values: { ...parseTweakValues(null), 'server.healthCheckMinutes': 30 } })
    expect($('[data-tweak-status]').dataset.state).toBe('saved')
  })
})
