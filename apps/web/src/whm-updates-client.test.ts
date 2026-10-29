// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmUpdatesWorkspace } from './board-port/whm-updates-workspace.ts'
import { readUpdateJobView, readUpdatePlanView, WHM_UPDATES_CLIENT_BINDING } from './whm-updates-client.ts'

const tick = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const revision = 'c'.repeat(64)
const planResponse = () => ({
  plan: {
    state: 'read', source: 'apt', observedAt: '2026-10-27T10:00:00.000Z', revision,
    packages: [
      { name: 'linux-image-6.8.0-51-generic', current: null, candidate: '6.8.0-51.52', origin: 'Ubuntu:24.04/noble-security', security: true, kernel: true, held: false, newInstall: true },
      { name: 'linux-image-generic', current: '6.8.0-50.51', candidate: '6.8.0-51.52', origin: 'Ubuntu:24.04/noble-security', security: true, kernel: true, held: false, newInstall: false },
      { name: 'openssl', current: '3.0.13-0ubuntu3.4', candidate: '3.0.13-0ubuntu3.5', origin: 'Ubuntu:24.04/noble-security', security: true, kernel: false, held: false, newInstall: false },
      { name: 'tzdata', current: '2024a-3ubuntu1.1', candidate: '2024b-0ubuntu0.24.04', origin: 'Ubuntu:24.04/noble-updates', security: false, kernel: false, held: false, newInstall: false },
    ],
    holds: ['nginx'], rebootRequired: true, counts: { total: 4, security: 3, kernel: 2, held: 1 },
  },
  safety: { state: 'read', writers: [] as { pid: number; command: string }[], database: 'clean' },
  actions: { refresh: true, apply: true },
})
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const boot = (send?: Send, ask: ((options: Record<string, unknown>) => Promise<unknown>) | undefined = async () => true, locale: 'en' | 'ar' = 'en') => {
  document.body.innerHTML = `<section data-whm-detail-route="/whm/software/updates" data-capability-state="authorized">${renderWhmUpdatesWorkspace({ locale, canRead: true, canApply: true })}</section>`
  if (send) (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  new Function('return ' + WHM_UPDATES_CLIENT_BINDING)()(ask)
}
const action = (key: string) => document.querySelector<HTMLButtonElement>('[data-whm-updates-action="' + key + '"]')!
const status = () => document.querySelector<HTMLElement>('[data-whm-updates-status]')!
const boxes = () => [...document.querySelectorAll<HTMLInputElement>('input[data-whm-updates-select]')]
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('WHM updates client parsers', () => {
  it('accepts the plan contract and rejects inconsistent or unsafe host data', () => {
    expect(readUpdatePlanView(planResponse()).packages).toHaveLength(4)
    const mutate = (change: (value: ReturnType<typeof planResponse>) => void) => { const value = planResponse(); change(value); return () => readUpdatePlanView(value) }
    expect(mutate(value => { value.plan.counts.total = 5 })).toThrow()
    expect(mutate(value => { value.plan.packages[2]!.name = '<img src=x onerror=alert(1)>' })).toThrow()
    expect(mutate(value => { value.plan.packages[0]!.current = '1' })).toThrow()
    expect(mutate(value => { (value.plan as Record<string, unknown>).revision = null })).toThrow()
    expect(mutate(value => { value.plan.packages[3]!.origin = 'x\u202ey' })).toThrow()
    expect(() => readUpdatePlanView({ plan: { state: 'unavailable', source: 'apt', observedAt: '2026-10-27T10:00:00.000Z', revision: null, packages: [], holds: null, rebootRequired: 'not-read', counts: { total: 0, security: 0, kernel: 0, held: null }, reason: 'package-manager-busy' }, safety: { state: 'read', writers: [], database: 'clean' }, actions: { refresh: true, apply: true } })).toThrow()
    expect(readUpdateJobView({ job: { id: '0f9c3c1e-2b9a-4f43-9d55-8f1b7d0b3a11', status: 'queued' } }).id).toBe('0f9c3c1e-2b9a-4f43-9d55-8f1b7d0b3a11')
    expect(() => readUpdateJobView({ job: { id: '../x', status: 'queued' } })).toThrow()
    expect(() => readUpdateJobView({ job: { id: 'a', status: 'done' } })).toThrow()
  })
})

describe('WHM updates client binding', () => {

  it.each([
    { locale: 'en', stamp: '2026-10-27T12:34:56.123Z', expected: '2026-10-27 12:34 UTC' },
    { locale: 'ar', stamp: '2026-10-27T12:34:56.000Z', expected: '2026-10-27 12:34 UTC' },
  ] as const)('renders readable datetime metadata for updates without changing plan revisions or queries ($locale)', async ({ locale, stamp, expected }) => {
    const observed = planResponse(); observed.plan.observedAt = stamp
    const send = vi.fn(async () => observed)
    boot(send, async () => false, locale)
    action('read').click(); await tick()
    const shown = document.querySelector<HTMLElement>('[data-whm-updates-fact="observed-at"]')!
    expect(shown.textContent).toBe(expected)
    expect(shown.tagName).toBe('BDI'); expect(shown.dir).toBe('ltr')
    expect(readUpdatePlanView(observed).observedAt).toBe(stamp)
    expect(readUpdatePlanView(observed).revision).toBe(revision)
    expect(send.mock.calls).toEqual([['GET', '/api/server/updates/plan']])
    expect(status().dataset.state).toBe('read')
  })

  it('stays unavailable and makes no request without a transport or admission', async () => {
    boot()
    expect(status().dataset.state).toBe('unavailable')
    expect(action('read').disabled).toBe(true)
    const send = vi.fn()
    document.body.innerHTML = `<section data-capability-state="unavailable">${renderWhmUpdatesWorkspace({ locale: 'en', canRead: true, canApply: true })}</section>`
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    new Function('return ' + WHM_UPDATES_CLIENT_BINDING)()(async () => true)
    action('read').click(); await tick()
    expect(send).not.toHaveBeenCalled()
  })
  it('reads only on request and paints facts, selectable rows, held and dependency rows', async () => {
    const send = vi.fn(async () => planResponse())
    boot(send)
    expect(send).not.toHaveBeenCalled()
    expect(action('security').disabled).toBe(true)
    action('read').click(); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/updates/plan')
    expect(status().dataset.state).toBe('read')
    expect(document.querySelector('[data-whm-updates-fact="total"]')!.textContent).toBe('4')
    expect(document.querySelector('[data-whm-updates-fact="reboot"]')!.textContent).toBe('Yes')
    expect(boxes().map(box => [box.value, box.disabled])).toEqual([['linux-image-6.8.0-51-generic', true], ['linux-image-generic', false], ['openssl', false], ['tzdata', false], ['nginx', true]])
    expect(document.querySelector('[data-whm-updates-rows]')!.textContent).toContain('Held; excluded from updates')
    expect(document.querySelector('[data-whm-updates-rows]')!.textContent).toContain('New dependency')
    expect(document.querySelector('[data-whm-updates-rows] bdi')!.getAttribute('dir')).toBe('ltr')
    expect([action('security').disabled, action('all').disabled, action('selected').disabled, action('refresh').disabled]).toEqual([false, false, true, false])
    expect(WHM_UPDATES_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_UPDATES_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('confirms with counts and the restart note, submits the revision-bound selection and hands off to the job', async () => {
    const ask = vi.fn(async () => true)
    const send = vi.fn(async (method: string) => method === 'GET' ? planResponse() : { job: { id: '0f9c3c1e-2b9a-4f43-9d55-8f1b7d0b3a11', status: 'queued' } })
    boot(send, ask)
    action('read').click(); await tick()
    boxes().find(box => box.value === 'tzdata')!.click()
    expect(action('selected').disabled).toBe(false)
    action('selected').click(); await tick()
    const confirmation = String((ask.mock.calls[0] as unknown as [Record<string, unknown>])[0].body)
    expect(confirmation).toContain('Packages to upgrade: 1 (0 security, 0 kernel)')
    expect(confirmation).toContain('needrestart only lists them')
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/updates/apply', { expectedRevision: revision, mode: 'selected', packages: ['tzdata'] })
    expect(status().dataset.state).toBe('submitted')
    expect(document.querySelector<HTMLElement>('[data-whm-updates-job]')!.hidden).toBe(false)
    expect(document.querySelector<HTMLAnchorElement>('[data-whm-updates-job-link]')!.getAttribute('href')).toBe('/whm/jobs?job=0f9c3c1e-2b9a-4f43-9d55-8f1b7d0b3a11&lang=en')
    expect([action('security').disabled, action('all').disabled, action('read').disabled]).toEqual([true, true, false])
  })
  it('sends nothing when the confirmation is declined', async () => {
    const send = vi.fn(async () => planResponse())
    boot(send, async () => false)
    action('read').click(); await tick()
    action('security').click(); await tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(status().dataset.state).toBe('read')
  })
  it('requires a re-read after a 409 conflict and reports unknown outcomes truthfully', async () => {
    const conflict = Object.assign(new Error('changed'), { status: 409, details: { stateChanged: false } })
    const send = vi.fn(async (method: string) => { if (method === 'GET') return planResponse(); throw conflict })
    boot(send)
    action('read').click(); await tick()
    action('all').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/updates/apply', { expectedRevision: revision, mode: 'all' })
    expect(status().dataset.state).toBe('stale')
    expect(status().getAttribute('role')).toBe('alert')
    expect(action('all').disabled).toBe(true)
    const unknown = vi.fn(async (method: string) => { if (method === 'GET') return planResponse(); throw Object.assign(new Error('transport'), { status: 503, details: { stateChanged: true, unknownOutcome: true } }) })
    boot(unknown)
    action('read').click(); await tick()
    action('refresh').click(); await tick()
    expect(unknown).toHaveBeenLastCalledWith('POST', '/api/server/updates/refresh', {})
    expect(status().dataset.state).toBe('uncertain')
  })
  it('shows unavailable plans and read failures without enabling changes, in Arabic', async () => {
    boot(vi.fn(async () => ({ plan: { state: 'unavailable', source: 'apt', observedAt: '2026-10-27T10:00:00.000Z', revision: null, packages: [], holds: null, rebootRequired: 'not-read', counts: { total: 0, security: 0, kernel: 0, held: null }, reason: 'package-manager-busy' }, safety: { state: 'read', writers: [], database: 'clean' }, actions: { refresh: true, apply: false } })), async () => true, 'ar')
    action('read').click(); await tick()
    expect(status().dataset.state).toBe('unavailable')
    expect(status().textContent).toContain('مدير الحزم مشغول')
    expect([action('security').disabled, action('all').disabled, action('selected').disabled]).toEqual([true, true, true])
    expect(document.querySelector('[data-whm-updates-fact="held"]')!.textContent).toBe('غير مقروء')
    boot(vi.fn(async () => { throw new Error('offline') }))
    action('read').click(); await tick()
    expect(status().dataset.state).toBe('failed')
    expect(action('read').disabled).toBe(false)
  })
})

describe('competing package writer browser state', () => {
  it('rejects offered jobs over a busy or unverified package manager', () => {
    expect(() => readUpdatePlanView({ ...planResponse(), safety: { state: 'read', writers: [{ pid: 9, command: 'dpkg' }], database: 'clean' } })).toThrow()
    expect(() => readUpdatePlanView({ ...planResponse(), safety: { state: 'unavailable', writers: [], database: 'not-read' } })).toThrow()
    expect(() => readUpdatePlanView({ ...planResponse(), safety: { state: 'read', writers: [{ pid: 9, command: '<img>' }], database: 'clean' }, actions: { refresh: false, apply: false } })).toThrow()
    expect(() => readUpdatePlanView({ ...planResponse(), safety: undefined })).toThrow()
  })
  it.each(['en', 'ar'] as const)('shows running writers and the repair route without enabling updates (%s)', async locale => {
    boot(vi.fn(async () => ({ ...planResponse(), safety: { state: 'read', writers: [{ pid: 4242, command: 'unattended-upgr' }], database: 'interrupted' }, actions: { refresh: false, apply: false } })), async () => true, locale)
    action('read').click(); await tick()
    expect(document.querySelector('[data-whm-updates-fact="writers"]')!.textContent).toBe('unattended-upgr (4242)')
    const note = document.querySelector<HTMLElement>('[data-whm-updates-safety]')!
    expect([note.hidden, note.dataset.state, note.getAttribute('role')]).toEqual([false, 'blocked', 'alert'])
    if (locale === 'en') expect(note.textContent).toContain('Another package manager is running')
    expect(document.querySelector<HTMLElement>('[data-whm-updates-repair-link]')!.hidden).toBe(false)
    expect([action('security').disabled, action('all').disabled, action('refresh').disabled]).toEqual([true, true, true])
  })
  it('hides the safety alert for an idle, consistent package manager', async () => {
    boot(vi.fn(async () => planResponse()))
    action('read').click(); await tick()
    expect(document.querySelector<HTMLElement>('[data-whm-updates-safety]')!.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-whm-updates-repair-link]')!.hidden).toBe(true)
    expect(document.querySelector('[data-whm-updates-fact="writers"]')!.textContent).toBe('None')
  })
})

describe('kernel exclusion browser workflow', () => {
  it.each(['en', 'ar'] as const)('requires a fresh option-bound preview and keeps kernel rows visible but disabled in %s', async locale => {
    const send = vi.fn(async (method: string, path: string) => method === 'GET' ? { ...planResponse(), plan: { ...planResponse().plan, ...(path.includes('excludeKernel=true') ? { excludeKernel: true } : {}) } } : { job: { id: 'job-1', status: 'queued' } })
    const ask = vi.fn(async () => true)
    boot(send, ask, locale)
    action('read').click(); await tick()
    const option = document.querySelector<HTMLInputElement>('[data-whm-updates-exclude-kernel]')!
    option.click()
    expect(status().dataset.state).toBe('stale')
    expect(action('all').disabled).toBe(true)
    action('read').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('GET', '/api/server/updates/plan?excludeKernel=true')
    expect(boxes().find(box => box.value === 'linux-image-generic')!.disabled).toBe(true)
    expect(boxes().find(box => box.value === 'linux-image-generic')!.getAttribute('aria-label')).toBe(locale === 'en' ? 'Select linux-image-generic' : 'تحديد linux-image-generic')
    expect(document.querySelector('[data-whm-updates-rows]')!.textContent).toContain('linux-image-generic')
    action('all').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/updates/apply', { expectedRevision: revision, mode: 'all', excludeKernel: true })
    expect(String((ask.mock.calls[0] as unknown as [Record<string, unknown>])[0].body)).toContain(locale === 'en' ? 'Kernel packages are excluded' : 'تُستبعد حزم النواة')
  })
  it('does not apply when the host ignores the requested kernel option', async () => {
    boot(vi.fn(async () => planResponse()))
    document.querySelector<HTMLInputElement>('[data-whm-updates-exclude-kernel]')!.click()
    action('read').click(); await tick()
    expect(status().dataset.state).toBe('failed')
    expect(action('all').disabled).toBe(true)
  })
})

