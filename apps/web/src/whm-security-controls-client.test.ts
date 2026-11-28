// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderV2WhmSecurityOverview } from './themes/v2/pages/xwhm/security/overview.ts'
import { renderV2WhmSsh } from './themes/v2/pages/xwhm/security/ssh.ts'
import { WHM_SECURITY_CONTROLS_CLIENT_BINDING } from './whm-security-controls-client.ts'

const ROOT = { kind: 'root' as const, id: 'synthetic-root', username: 'synthetic-root' }
const R1 = 'a'.repeat(64)
const R2 = 'b'.repeat(64)
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  document.documentElement.lang = 'en'
  document.documentElement.dir = 'ltr'
})

describe('WHM security C1 controls markup and client binding', () => {
  it('removes bare inert inputs on overview and wires PHP functions controls without innerHTML', () => {
    const html = renderV2WhmSecurityOverview({ activeRoute: '/whm/security', principal: ROOT, locale: 'en', observationAuthority: { canRead: true, canManage: true } })
    expect(html).not.toContain('v2-security-token-name')
    expect(html).not.toContain('v2-security-rate')
    expect(html).not.toContain('This setting has no connected host operation')
    expect(html).toContain('/whm/panel/api-tokens')
    expect(html).toContain('/whm/security/waf')
    expect(html).toContain('data-whm-php-functions')
    expect(html).toContain('data-sec-php-fn="exec"')
    expect(html).toContain('data-sec-php-save')
    expect(html).toContain('data-sec-php-status')
    expect(WHM_SECURITY_CONTROLS_CLIENT_BINDING).not.toContain('innerHTML')
  })

  it('loads and saves global disabled PHP functions and displays per-account exceptions', async () => {
    document.body.innerHTML = renderV2WhmSecurityOverview({ activeRoute: '/whm/security', principal: ROOT, locale: 'en', observationAuthority: { canRead: true, canManage: true } })
    let disabled = ['exec', 'shell_exec', 'system', 'passthru', 'proc_open', 'popen']
    let rev = R1
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (path !== '/api/server/sec/php-functions') return {}
      if (method === 'PUT') {
        const next = body as { disabled: string[] }
        disabled = next.disabled
        rev = R2
      }
      return { state: method === 'PUT' ? 'saved' : 'default', disabled, exceptions: [{ account: 'alice', functions: ['exec'], reason: 'queue worker' }], updatedAt: null, revision: rev, reconcile: 'requested' }
    })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    new Function('return ' + WHM_SECURITY_CONTROLS_CLIENT_BINDING)()(undefined)
    await tick()

    expect($<HTMLInputElement>('[data-sec-php-fn="exec"]').checked).toBe(true)
    expect($('[data-v2-security-php-exceptions]').textContent).toContain('alice')
    $<HTMLInputElement>('[data-sec-php-fn="exec"]').checked = false
    $<HTMLButtonElement>('[data-sec-php-save]').click()
    await tick()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/sec/php-functions', { expectedRevision: R1, disabled: ['shell_exec', 'system', 'passthru', 'proc_open', 'popen'] })
    expect($('[data-sec-php-status]').dataset.state).toBe('saved')
  })

  it('wires SSH auto-ban rule controls and manual unban inside [data-whm-ssh-autoban]', async () => {
    const html = renderV2WhmSsh({ activeRoute: '/whm/security/ssh', principal: ROOT, locale: 'en', observationAuthority: { canRead: true, canManage: true } })
    expect(html).not.toContain('not connected on this page')
    expect(html).toContain('data-whm-ssh-autoban')
    expect(html).toContain('data-v2-ssh-banned')

    document.body.innerHTML = html
    let policy = { enabled: false, failures: 5, windowMin: 10, banMin: 60 }
    let banned = [{ address: '203.0.113.10', since: '2026-11-20T09:00:00.000Z', until: '2026-11-20T10:00:00.000Z', reason: 'sshd', jail: 'sshd' }]
    let rev = R1
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (path === '/api/server/sec/ssh-autoban/unban') {
        banned = []
        return { address: '203.0.113.10', jail: 'sshd', outcome: 'confirmed' }
      }
      if (method === 'PUT') {
        policy = (body as { policy: typeof policy }).policy
        rev = R2
      }
      return { state: 'saved', policy, updatedAt: '2026-11-20T09:00:00.000Z', revision: rev, banned, source: 'state', reconcile: 'requested' }
    })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    new Function('return ' + WHM_SECURITY_CONTROLS_CLIENT_BINDING)()(async () => true)
    await tick()

    expect($<HTMLInputElement>('[data-ssh-autoban-failures]').value).toBe('5')
    expect($('[data-v2-ssh-banned]').textContent).toContain('203.0.113.10')
    $<HTMLInputElement>('[data-ssh-autoban-enabled]').checked = true
    $<HTMLInputElement>('[data-ssh-autoban-failures]').value = '501'
    $<HTMLButtonElement>('[data-ssh-autoban-save]').click()
    await tick()
    expect($('[data-ssh-autoban-status]').dataset.state).toBe('failed')
    expect(send).not.toHaveBeenCalledWith('PUT', '/api/server/sec/ssh-autoban', expect.anything())

    $<HTMLInputElement>('[data-ssh-autoban-failures]').value = '4'
    $<HTMLButtonElement>('[data-ssh-autoban-save]').click()
    await tick()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/sec/ssh-autoban', { expectedRevision: R1, policy: { enabled: true, failures: 4, windowMin: 10, banMin: 60 } })
    expect($('[data-ssh-autoban-status]').dataset.state).toBe('saved')

    $<HTMLButtonElement>('[data-ssh-autoban-unban]').click()
    await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/sec/ssh-autoban/unban', { address: '203.0.113.10', jail: 'sshd' })
    expect($('[data-v2-ssh-banned]').textContent).toContain('No SSH addresses are currently banned.')
  })
})
