// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmServiceManagerWorkspace } from './board-port/whm-service-manager-workspace.ts'
import { readServiceManagerSubmission, readServiceManagerView, WHM_SERVICE_MANAGER_CLIENT_BINDING } from './whm-service-manager-client.ts'

const revision = 'a'.repeat(64), at = '2026-10-27T06:00:00.000Z', bootTime = 1793000000
const row = (unit: string, extra: Record<string, unknown> = {}) => ({ unit, load: 'loaded', active: 'active', sub: 'running', boot: 'enabled', restart: false, bootEditable: false, ...extra })
const view = (extra: Record<string, unknown> = {}) => ({ state: 'read', observedAt: at, revision, bootTime, manage: true, units: [row('nginx.service'), row('php8.3-fpm.service', { restart: true }), row('ssh.service', { restart: true }), row('memcached.service', { boot: 'disabled', bootEditable: true }), row('absent.service', { load: null, active: null, sub: null, boot: 'static' })], ...extra })
const accepted = (action: string, unit: string | null) => ({ action, unit, outcome: action === 'reboot' ? 'attempted' : 'submitted', verificationRequired: true, job: { id: 'job-internal-test', kind: 'services.manager.' + action, status: 'queued' } })
const tick = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const q = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const mount = (extra: { canRead?: boolean; canManage?: boolean; capability?: string; locale?: 'en' | 'ar' } = {}) => { document.documentElement.lang = extra.locale ?? 'en'; document.documentElement.dir = extra.locale === 'ar' ? 'rtl' : 'ltr'; document.body.innerHTML = `<section data-capability-state="${extra.capability ?? 'authorized'}">${renderWhmServiceManagerWorkspace({ locale: extra.locale ?? 'en', canRead: extra.canRead ?? true, canManage: extra.canManage ?? true })}</section>` }
const boot = (send?: (method: string, path: string, body?: any) => Promise<unknown>, ask?: (input: any) => Promise<unknown>) => {
  if (send) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  new Function('return ' + WHM_SERVICE_MANAGER_CLIENT_BINDING)()(ask)
}
const click = (action: string, unit: string) => q<HTMLButtonElement>(`[data-sm-action="${action}"][data-sm-unit="${unit}"]`).click()
const input = (selector: string, value: string) => { const node = q<HTMLInputElement>(selector); node.value = value; node.dispatchEvent(new Event('input')) }
beforeEach(() => { mount(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('service manager browser boundary', () => {
  it('projects only validated service facts and refuses unsafe flags or inconsistent reads', () => {
    expect(JSON.stringify(readServiceManagerView({ ...view(), secret: 'hidden', units: [row('nginx.service', { secret: 'hidden' })] }))).not.toContain('hidden')
    for (const bad of [view({ revision: null }), view({ state: 'unavailable' }), view({ units: [row('nginx.service', { restart: true })] }), view({ units: [row('ssh.service', { bootEditable: true })] }), view({ units: [row('memcached.service', { bootEditable: true, boot: 'static' })] }), view({ units: [row('a.service'), row('a.service')] }), view({ units: [row('<script>.service')] }), view({ units: [row('a.service', { load: null })] }), view({ bootTime: -1 }), view({ observedAt: 'today' })]) expect(() => readServiceManagerView(bad)).toThrow()
    expect(readServiceManagerView(view({ state: 'unavailable', revision: null, units: [], manage: false })).state).toBe('unavailable')
    expect(readServiceManagerView(view({ units: [row('systemd-fsck@dev-disk-by\\x2duuid.service')] })).units[0]!.unit).toContain('\\x2d')
    expect(() => readServiceManagerView(view({ units: [] }))).toThrow()
  })
  it('requires submission action, target, kind and attempted reboot outcome to match', () => {
    expect(readServiceManagerSubmission(accepted('restart', 'ssh.service'), 'restart', 'ssh.service').job.status).toBe('queued')
    expect(readServiceManagerSubmission(accepted('reboot', null), 'reboot', null).outcome).toBe('attempted')
    for (const bad of [accepted('restart', 'nginx.service'), { ...accepted('restart', 'ssh.service'), verificationRequired: false }, { ...accepted('restart', 'ssh.service'), outcome: 'succeeded' }, { ...accepted('restart', 'ssh.service'), job: { id: 'x', kind: 'services.manager.enable', status: 'queued' } }]) expect(() => readServiceManagerSubmission(bad, 'restart', 'ssh.service')).toThrow()
  })
})

describe('service manager client actions', () => {
  it('keeps all controls inert with no transport, authority or qualification', async () => {
    boot(); expect(q<HTMLElement>('[data-sm-status]').dataset.state).toBe('unavailable')
    for (const extra of [{ canRead: false }, { capability: 'unavailable' }]) {
      mount(extra); const send = vi.fn(); boot(send, async () => true); await tick(); expect(send).not.toHaveBeenCalled()
      for (const control of document.querySelectorAll<HTMLInputElement>('input,select,button')) expect(control.disabled).toBe(true)
    }
    expect(WHM_SERVICE_MANAGER_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_SERVICE_MANAGER_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('renders isolated facts and filters observed rows without enabling protected services', async () => {
    const send = vi.fn(async () => view()); boot(send, async () => true); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/service-manager')
    expect(q('[data-sm-fact="services"]').textContent).toBe('5')
    expect(q('[data-sm-fact="active"]').textContent).toBe('4')
    expect(q('[data-sm-fact="observed-at"]').textContent).toBe('2026-10-27 06:00 UTC')
    expect(document.querySelectorAll('[data-sm-rows] tr')).toHaveLength(5)
    expect(q('[data-sm-rows] bdi').getAttribute('dir')).toBe('ltr')
    expect(document.querySelector('[data-sm-unit="nginx.service"]')).toBeNull()
    input('[data-sm-search]', 'php8.3'); expect(document.querySelectorAll('[data-sm-rows] tr')).toHaveLength(1)
    expect(q('[data-sm-rows]').textContent).toContain('php8.3-fpm.service')
    input('[data-sm-search]', 'nothing'); expect(q('[data-sm-rows]').textContent).toContain('No services match')
    input('[data-sm-search]', ''); const filter = q<HTMLSelectElement>('[data-sm-filter]'); filter.value = 'editable'; filter.dispatchEvent(new Event('change'))
    expect(q('[data-sm-rows]').textContent).toContain('memcached.service'); expect(q('[data-sm-rows]').textContent).not.toContain('ssh.service')
  })
  it('submits the exact boot action and retains observed state until a fresh read', async () => {
    const send = vi.fn(async (method: string, _path: string, body?: any) => method === 'GET' ? view() : accepted(body.action, body.unit))
    boot(send, async () => true); await tick(); click('enable', 'memcached.service'); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/service-manager/action', { action: 'enable', unit: 'memcached.service', expectedRevision: revision })
    expect(q('[data-sm-result]').textContent).toContain('Host job submitted')
    expect(q('[data-sm-rows]').textContent).toContain('disabled')
    expect(q<HTMLButtonElement>('[data-sm-action="enable"]').disabled).toBe(true)
    expect(q<HTMLAnchorElement>('[data-sm-job-link]').href).toContain('/whm/jobs?job=job-internal-test')
    expect(document.body.textContent).not.toContain('job-internal-test')
    q<HTMLButtonElement>('[data-sm-refresh]').click(); await tick(); expect(q<HTMLButtonElement>('[data-sm-action="enable"]').disabled).toBe(false)
  })
  it('warns about SSH lockout and cancels without transport when not confirmed', async () => {
    const send = vi.fn(async () => view()), ask = vi.fn(async (_input: Record<string, unknown>) => false)
    boot(send, ask); await tick(); click('restart', 'ssh.service'); await tick()
    expect(ask.mock.calls[0]![0].body).toContain('prevent new logins')
    expect(send).toHaveBeenCalledTimes(1)
    expect(q<HTMLButtonElement>('[data-sm-action="restart"]').disabled).toBe(false)
  })
  it('rechecks admission after the confirmation await', async () => {
    let confirm!: (value: boolean) => void
    const send = vi.fn(async () => view()); boot(send, () => new Promise(resolve => { confirm = resolve })); await tick()
    click('restart', 'php8.3-fpm.service'); q<HTMLElement>('[data-whm-service-manager]').dataset.smCanManage = 'false'; confirm(true); await tick()
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('locks ambiguous submission and mismatched acknowledgment until a successful read', async () => {
    for (const submit of [() => { throw new Error('connection lost') }, () => accepted('restart', 'different.service')]) {
      mount(); const send = vi.fn(async (method: string) => method === 'GET' ? view() : submit()); boot(send, async () => true); await tick()
      click('restart', 'php8.3-fpm.service'); await tick()
      expect(q<HTMLElement>('[data-sm-result]').dataset.state).toBe('unknown')
      expect(q<HTMLButtonElement>('[data-sm-action="restart"]').disabled).toBe(true)
      expect(q<HTMLElement>('[data-sm-job]').hidden).toBe(false)
      q<HTMLButtonElement>('[data-sm-refresh]').click(); await tick(); expect(q<HTMLButtonElement>('[data-sm-action="restart"]').disabled).toBe(false)
    }
  })
  it('shows a definite refusal without claiming success or disabling retry on unchanged state', async () => {
    const send = vi.fn(async (method: string) => { if (method === 'GET') return view(); throw { status: 412, details: { stateChanged: false } } })
    boot(send, async () => true); await tick(); click('restart', 'php8.3-fpm.service'); await tick()
    expect(q<HTMLElement>('[data-sm-result]').dataset.state).toBe('refused')
    expect(q<HTMLButtonElement>('[data-sm-action="restart"]').disabled).toBe(false)
    expect(q<HTMLElement>('[data-sm-job]').hidden).toBe(true)
  })
  it('requires the exact reboot phrase, records attempted status and compares later boot time', async () => {
    let current = view(); const send = vi.fn(async (method: string, _path: string, body?: any) => method === 'GET' ? current : accepted(body.action, null))
    boot(send, async () => true); await tick(); input('[data-sm-confirm]', 'reboot server'); q<HTMLButtonElement>('[data-sm-reboot]').click(); await tick(); expect(send).toHaveBeenCalledTimes(1)
    input('[data-sm-confirm]', 'REBOOT SERVER'); q<HTMLButtonElement>('[data-sm-reboot]').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/service-manager/action', { action: 'reboot', confirmation: 'REBOOT SERVER', expectedRevision: revision })
    expect(q<HTMLElement>('[data-sm-result]').dataset.state).toBe('attempted')
    expect(q('[data-sm-result]').textContent).toContain('not yet verified')
    current = view({ bootTime: bootTime + 300 }); q<HTMLButtonElement>('[data-sm-refresh]').click(); await tick()
    expect(q<HTMLElement>('[data-sm-result]').dataset.state).toBe('verified')
    expect(q('[data-sm-result]').textContent).toContain('boot time changed')
  })
  it('honors a read-only host and clears unreadable data on refresh failure', async () => {
    let fail = false; const send = vi.fn(async () => { if (fail) throw new Error('offline'); return view({ manage: false }) })
    boot(send, async () => true); await tick(); expect(q<HTMLButtonElement>('[data-sm-action="restart"]').disabled).toBe(true)
    expect(q<HTMLButtonElement>('[data-sm-reboot]').disabled).toBe(true)
    fail = true; q<HTMLButtonElement>('[data-sm-refresh]').click(); await tick()
    expect(q('[data-sm-rows]').textContent).not.toContain('nginx.service')
    expect(q<HTMLElement>('[data-sm-status]').dataset.state).toBe('failed')
  })
  it('keeps reboot disabled without a verified boot time while allowing service restarts', async () => {
    const send = vi.fn(async () => view({ bootTime: null }))
    boot(send, async () => true); await tick(); input('[data-sm-confirm]', 'REBOOT SERVER')
    expect(q<HTMLButtonElement>('[data-sm-reboot]').disabled).toBe(true)
    expect(q<HTMLButtonElement>('[data-sm-action="restart"]').disabled).toBe(false)
    q<HTMLButtonElement>('[data-sm-reboot]').click(); await tick(); expect(send).toHaveBeenCalledTimes(1)
  })
  it('renders Arabic copy with ASCII facts and left-to-right service values', async () => {
    mount({ locale: 'ar' }); boot(async () => view(), async () => true); await tick()
    expect(q('[data-sm-status]').textContent).toContain('قُرئت حالة الخدمات')
    expect(q('[data-sm-fact="services"]').textContent).toBe('5')
    expect(q('[data-sm-rows] bdi').getAttribute('dir')).toBe('ltr')
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})


describe('full timestamp display additional service manager', () => {
  it.each(['en', 'ar'] as const)('formats boot seconds and observation without changing reboot identity in %s', async locale => {
    mount({ locale })
    const raw = view({ bootTime: 1793080805, observedAt: '2026-10-27T06:00:09.250Z' }), before = JSON.stringify(raw)
    const send = vi.fn(async (_method: string, _path: string) => raw)
    boot(send); await tick()
    expect(q('[data-sm-fact="boot-time"]').textContent).toBe('2026-10-27 06:00 UTC')
    expect(q('[data-sm-fact="observed-at"]').textContent).toBe('2026-10-27 06:00 UTC')
    expect(q('[data-sm-fact="boot-time"]').getAttribute('dir')).toBe('ltr')
    expect(q('[data-sm-fact="observed-at"]').getAttribute('dir')).toBe('ltr')
    expect(readServiceManagerView(raw).bootTime).toBe(1793080805)
    expect(readServiceManagerView(raw).observedAt).toBe('2026-10-27T06:00:09.250Z')
    expect(send).toHaveBeenCalledWith('GET', '/api/server/service-manager')
    expect(JSON.stringify(raw)).toBe(before)
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })
})
