// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmServerHealth, renderWhmServerLimits } from './board-port/whm-server-health-workspace.ts'
import { readServerHealthReport, readServerLimitsReport, WHM_SERVER_HEALTH_CLIENT_BINDING } from './whm-server-health-client.ts'

const tick = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const at = '2026-10-27T10:00:00.000Z'
const RLO = String.fromCharCode(0x202e)
const check = (id: string, state: string, reason: string, extra: Record<string, unknown> = {}) => ({ id, state, reason, evidence: 'evidence for ' + id, ...extra })
const health = () => ({
  observedAt: at, host: 'read',
  thresholds: { loadPerCore: { warning: 1, problem: 2 }, memoryAvailablePercent: { warning: 15, problem: 5 }, swapUsedPercent: { warning: 50, problem: 80 }, diskUsedPercent: { warning: 85, problem: 95 }, inodeUsedPercent: { warning: 85, problem: 95 }, certificateExpiryDays: 14, bandwidthUsedPercent: { warning: 80, problem: 100 } },
  counts: { ok: 5, warning: 2, problem: 2, unavailable: 1 },
  checks: [
    check('load', 'warning', 'load_high'), check('memory', 'ok', 'memory_ok'), check('swap', 'ok', 'swap_none'),
    check('disk-space', 'problem', 'filesystems_problem', { items: [{ name: '/', state: 'problem', reason: 'space_full', evidence: '96% used' }, { name: '/home', state: 'ok', reason: 'space_ok', evidence: '10% used' }], omitted: 0 }),
    check('disk-inodes', 'ok', 'no_inode_tables'),
    check('services', 'problem', 'services_failed', { items: [{ name: 'nginx', state: 'problem', reason: 'service_failed', evidence: 'unit=nginx.service' }], omitted: 0 }),
    check('drift', 'ok', 'drift_none', { items: [], omitted: 0 }),
    check('certificates', 'warning', 'certificates_warning', { items: [{ name: 'soon.example.test', state: 'warning', reason: 'cert_expiring', evidence: 'notAfter=2026-10-30' }], omitted: 0 }),
    check('reboot', 'ok', 'reboot_not_required'),
    check('bandwidth', 'unavailable', 'bandwidth_unread'),
  ],
})
const IDS = ['cpu', 'memory', 'processes', 'io-read-bps', 'io-write-bps', 'io-read-iops', 'io-write-iops', 'disk']
const account = (username: string, overrides: Record<string, Record<string, unknown>> = {}) => {
  const rows = IDS.map(id => ({ id, limit: 100, enforced: '100', enforcement: 'match', usage: 10, percent: 10, usageState: 'ok', ...overrides[id] }))
  return { username, status: 'active', plan: 'Standard', slice: 'read', quota: 'read', rows,
    high: rows.filter(row => row.usageState === 'high').length, drift: rows.filter(row => row.enforcement === 'drift').length,
    unavailable: rows.filter(row => row.enforcement === 'unavailable' || row.usageState === 'unavailable').length }
}
const limits = (accounts: unknown[], pending: string[] = []) => ({ observedAt: at, host: 'read', highPercent: 90, sample: { state: 'read', observedAt: at, reason: null }, accounts, pending, truncated: false })
const alice = () => account('alice', { cpu: { usage: 95, percent: 95, usageState: 'high' } })
const bob = () => account('bob', { memory: { enforced: '50', enforcement: 'drift' } })
const carol = () => account('carol', { disk: { usage: null, percent: null, usageState: 'unavailable', enforced: null, enforcement: 'unavailable' } })

const mount = (kind: 'health' | 'limits', locale: 'en' | 'ar' = 'en', canRead = true, wrapper = 'data-capability-state="authorized"') => {
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = `<section ${wrapper}>${(kind === 'health' ? renderWhmServerHealth : renderWhmServerLimits)({ locale, canRead })}</section>`
}
const boot = (request?: (method: string, path: string) => Promise<unknown>) => {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + WHM_SERVER_HEALTH_CLIENT_BINDING)()()
}
const status = () => document.querySelector<HTMLElement>('[data-whm-server-health-status]')!
const fact = (name: string) => document.querySelector(`[data-whm-server-health-${name}]`)!.textContent
const visible = () => [...document.querySelectorAll<HTMLElement>('[data-whm-server-health-account]')].filter(row => !row.hidden).map(row => row.dataset.whmServerHealthAccount)
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('server health client parsers', () => {
  it('accept projected reports and drop unknown fields', () => {
    expect(JSON.stringify(readServerHealthReport({ ...health(), secret: 'x' }))).not.toContain('secret')
    expect(readServerHealthReport(health()).checks[3]!.items).toHaveLength(2)
    expect(readServerLimitsReport(limits([alice(), bob()], ['carol']), undefined).accounts[1]!.drift).toBe(1)
  })
  it('refuse reasons that do not imply the state, wrong order, unsafe text and inconsistent counts', () => {
    const base = health()
    for (const bad of [
      { ...base, checks: base.checks.map(entry => entry.id === 'load' ? { ...entry, state: 'ok' } : entry) },
      { ...base, checks: [...base.checks].reverse() },
      { ...base, counts: { ...base.counts, ok: 6 } },
      { ...base, checks: base.checks.map(entry => entry.id === 'services' ? { ...entry, items: [{ name: 'nginx' + RLO, state: 'problem', reason: 'service_failed', evidence: '' }] } : entry) },
      { ...base, checks: base.checks.map(entry => entry.id === 'disk-space' ? { ...entry, state: 'warning', reason: 'filesystems_warning' } : entry), counts: { ...base.counts, warning: 3, problem: 1 } },
      { ...base, checks: base.checks.map(entry => entry.id === 'load' ? { ...entry, items: [] } : entry) },
    ]) expect(() => readServerHealthReport(bad)).toThrow()
    for (const bad of [
      limits([account('alice', { cpu: { usage: 95, percent: 95, usageState: 'ok' } })]),
      limits([{ ...alice(), high: 0 }]),
      limits([{ ...alice(), rows: alice().rows.slice().reverse() }]),
      limits([account('alice', { cpu: { limit: 'unlimited', percent: 5, usageState: 'unlimited' } })]),
      limits([account('alice', { cpu: { limit: null, usageState: 'unavailable', percent: null } })]),
    ]) expect(() => readServerLimitsReport(bad)).toThrow()
    expect(() => readServerLimitsReport(limits([alice()]), ['bob'])).toThrow()
  })
})

describe('server health client binding', () => {
  it('makes no request and disables every control without transport or admission', async () => {
    mount('health'); boot(); await tick()
    expect(status().dataset.state).toBe('unavailable')
    for (const [kind, canRead, wrapper] of [['limits', false, 'data-capability-state="authorized"'], ['health', true, 'data-capability-state="unavailable"'], ['limits', true, 'data-wiring="soon"']] as const) {
      mount(kind, 'en', canRead, wrapper); const send = vi.fn(); boot(send); await tick()
      expect(send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable')
      expect(document.querySelector('form')).toBeNull()
      for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) expect(control.disabled).toBe(true)
    }
    expect(WHM_SERVER_HEALTH_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_SERVER_HEALTH_CLIENT_BINDING).not.toContain('fetch(')
  })

  it('reads health on load and links every non-ok check to the page that fixes it', async () => {
    mount('health'); const send = vi.fn(async () => health()); boot(send); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/server-health')
    expect(status().dataset.state).toBe('problem')
    expect(fact('count-problem')).toBe('2')
    expect(fact('observed-at')).toBe('2026-10-27 10:00 UTC')
    const cards = [...document.querySelectorAll<HTMLElement>('[data-whm-server-health-check]')]
    expect(cards.map(card => card.dataset.whmServerHealthCheck)).toHaveLength(10)
    const fixes = Object.fromEntries([...document.querySelectorAll<HTMLAnchorElement>('[data-whm-server-health-fix]')].map(link => [link.dataset.whmServerHealthFix, link.getAttribute('href')]))
    expect(fixes).toEqual({ load: '/whm/monitoring/processes', 'disk-space': '/whm/monitoring/disk', services: '/whm/services', certificates: '/whm/ssl', bandwidth: '/whm/accounts/bandwidth' })
    expect(document.querySelector('[data-whm-server-health-check="disk-space"] bdi')!.textContent).toBe('/')
    expect(document.querySelectorAll('[data-whm-server-health-thresholds] tr')).toHaveLength(7)
    expect([...document.querySelectorAll<HTMLTableRowElement>('[data-whm-server-health-thresholds] tr')].at(-2)!.cells[1]!.textContent).toBe('< 14 days')
    send.mockRejectedValueOnce(new Error('down'))
    document.querySelector<HTMLButtonElement>('[data-whm-server-health-refresh]')!.click(); await tick()
    expect(status().dataset.state).toBe('failed')
    expect(document.querySelectorAll('[data-whm-server-health-check]')).toHaveLength(10)
  })

  it('renders Arabic copy with ASCII digits and refuses a malformed report without painting it', async () => {
    mount('health', 'ar'); boot(vi.fn(async () => ({ ...health(), counts: { ok: 0, warning: 0, problem: 0, unavailable: 9 } }))); await tick()
    expect(status().dataset.state).toBe('failed')
    expect(document.querySelectorAll('[data-whm-server-health-check]')).toHaveLength(0)
    mount('health', 'ar'); boot(vi.fn(async () => health())); await tick()
    expect(status().textContent).toMatch(/[\u0600-\u06ff]/)
    expect([...document.querySelectorAll<HTMLTableRowElement>('[data-whm-server-health-thresholds] tr')].at(-2)!.cells[1]!.textContent).toBe('< 14 \u064a\u0648\u0645\u064b\u0627')
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })

  it('reads limits in batches on request, filters findings and links to plan editing', async () => {
    mount('limits')
    const send = vi.fn(async (_method: string, path: string) => path === '/api/server/server-limits' ? limits([alice(), bob()], ['carol']) : limits([carol()]))
    boot(send); await tick()
    expect(send).not.toHaveBeenCalled()
    document.querySelector<HTMLButtonElement>('[data-whm-server-health-refresh]')!.click(); await tick()
    expect(send.mock.calls.map(call => call[1])).toEqual(['/api/server/server-limits', '/api/server/server-limits?username=carol'])
    expect(visible()).toEqual(['alice', 'bob', 'carol'])
    expect(status().dataset.state).toBe('problem')
    expect(fact('count-high')).toBe('1')
    expect(fact('count-drift')).toBe('1')
    const filter = document.querySelector<HTMLSelectElement>('[data-whm-server-health-filter]')!
    for (const [value, expected] of [['high', ['alice']], ['drift', ['bob']], ['unavailable', ['carol']], ['ok', []]] as const) { filter.value = value; filter.dispatchEvent(new Event('change')); expect(visible()).toEqual(expected) }
    filter.value = 'all'; filter.dispatchEvent(new Event('change'))
    const search = document.querySelector<HTMLInputElement>('[data-whm-server-health-search]')!
    search.value = 'bo'; search.dispatchEvent(new Event('input')); expect(visible()).toEqual(['bob'])
    expect([...document.querySelectorAll<HTMLAnchorElement>('[data-whm-server-health-fix]')].map(link => [link.dataset.whmServerHealthFix, link.getAttribute('href')])).toEqual([['alice', '/whm/plans'], ['bob', '/whm/plans']])
    const cpu = document.querySelector<HTMLElement>('[data-whm-server-health-account="alice"] [data-whm-server-health-resource="cpu"]')!
    expect(cpu.dataset.usageState).toBe('high')
    expect(cpu.textContent).toContain('95%')
    expect(document.querySelector<HTMLElement>('[data-whm-server-health-account="bob"] [data-whm-server-health-resource="memory"]')!.dataset.enforcement).toBe('drift')
  })

  it('reports an unavailable resource sample and keeps earlier rows when a later read fails', async () => {
    mount('limits')
    const send = vi.fn(async () => ({ ...limits([carol()]), sample: { state: 'unavailable', observedAt: null, reason: 'stale' } }))
    boot(send); document.querySelector<HTMLButtonElement>('[data-whm-server-health-refresh]')!.click(); await tick()
    expect(status().dataset.state).toBe('partial')
    expect(status().textContent).toContain('The last resource sample is too old.')
    send.mockRejectedValueOnce(new Error('down'))
    document.querySelector<HTMLButtonElement>('[data-whm-server-health-refresh]')!.click(); await tick()
    expect(status().dataset.state).toBe('failed')
    expect(visible()).toEqual(['carol'])
  })
})

describe('server health full timestamp display', () => {
  it.each([['health', 'en'], ['health', 'ar'], ['limits', 'en'], ['limits', 'ar']] as const)('preserves complete %s observation instants in %s', async (kind, locale) => {
    const observedAt = '2026-10-27T10:00:09.987Z', sampleAt = '2026-10-27T10:00:08.654Z'
    const payload = kind === 'health' ? { ...health(), observedAt } : { ...limits([alice()]), observedAt, sample: { state: 'read', observedAt: sampleAt, reason: null } }
    const canonicalPayload = JSON.stringify(payload)
    const send = vi.fn(async (_method: string, _path: string) => payload)
    mount(kind, locale); boot(send)
    if (kind === 'limits') document.querySelector<HTMLButtonElement>('[data-whm-server-health-refresh]')!.click()
    await tick()
    expect(fact('observed-at')).toBe('2026-10-27 10:00 UTC')
    expect(document.querySelector('[data-whm-server-health-observed-at]')!.getAttribute('dir')).toBe('ltr')
    if (kind === 'limits') {
      expect(fact('sample-at')).toBe('2026-10-27 10:00 UTC')
      expect(document.querySelector('[data-whm-server-health-sample-at]')!.getAttribute('dir')).toBe('ltr')
    }
    expect(JSON.stringify(payload)).toBe(canonicalPayload)
    expect(send.mock.calls.map(([method]) => method)).toEqual(['GET'])
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })

  it.each(['en', 'ar'] as const)('keeps an unavailable resource sample truthful in %s', async locale => {
    const payload = { ...limits([carol()]), sample: { state: 'unavailable', observedAt: null, reason: 'stale' } }
    const canonicalPayload = JSON.stringify(payload)
    const send = vi.fn(async (_method: string, _path: string) => payload)
    mount('limits', locale); boot(send)
    document.querySelector<HTMLButtonElement>('[data-whm-server-health-refresh]')!.click(); await tick()
    expect(status().dataset.state).toBe('partial')
    expect(fact('sample-at')).toBe(locale === 'ar' ? 'غير مقروء' : 'Not read')
    expect(status().textContent).toContain(locale === 'ar' ? 'استخدام المعالج والإدخال والإخراج غير مقاس: آخر عينة للموارد قديمة جدًا.' : 'CPU and IO usage is not measured: The last resource sample is too old.')
    expect(JSON.stringify(payload)).toBe(canonicalPayload)
    expect(send.mock.calls.map(([method]) => method)).toEqual(['GET'])
  })
})
