// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseMarkup } from './themes/markup.ts'
import { renderWhmAccountHealthWorkspace } from './board-port/whm-account-health-workspace.ts'
import { readAccountHealthReport, WHM_ACCOUNT_HEALTH_CLIENT_BINDING } from './whm-account-health-client.ts'

const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const okChecks = (username: string) => [
  { id: 'status', state: 'ok', reason: 'active', evidence: 'status=active' },
  { id: 'plan', state: 'ok', reason: 'plan_ok', evidence: 'plan=Standard featureList=Default' },
  { id: 'disk', state: 'ok', reason: 'within_quota', evidence: 'repquota -u /: used=1024 KiB hard=5242880 KiB; plan diskMb=5120' },
  { id: 'system-user', state: 'ok', reason: 'user_ok', evidence: 'getent passwd: uid=20001 gid=20001 home=/home/' + username },
  { id: 'home', state: 'ok', reason: 'home_ok', evidence: 'lstat /home/' + username + ': type=directory uid=20001 gid=20001 mode=0710' },
  { id: 'mailboxes', state: 'ok', reason: 'within_limit', evidence: 'mailboxes=1 plan limit=25' },
  { id: 'certificates', state: 'ok', reason: 'domains_ok', evidence: '1 checked, 0 with problems, 0 not verified', items: [{ name: username + '.example.test', state: 'ok', reason: 'cert_valid', evidence: 'source=acme notAfter=2027-01-20T00:00:00.000Z' }], omitted: 0 },
  { id: 'dns', state: 'ok', reason: 'domains_ok', evidence: '1 checked, 0 with problems, 0 not verified', items: [{ name: username + '.example.test', state: 'ok', reason: 'zone_present', evidence: 'zone=' + username + '.example.test' }], omitted: 0 },
  { id: 'php', state: 'ok', reason: 'no_php_sites', evidence: '0 checked, 0 with problems, 0 not verified', items: [], omitted: 0 },
]
type Check = ReturnType<typeof okChecks>[number]
const healthy = (username: string) => ({ username, primaryDomain: username + '.example.test', status: 'active', problems: 0, unavailable: 0, checks: okChecks(username) as Check[] })
const broken = (username: string) => {
  const value = healthy(username)
  value.checks[2] = { id: 'disk', state: 'problem', reason: 'quota_mismatch', evidence: 'repquota -u /: used=1024 KiB hard=none; plan diskMb=5120' }
  value.checks[6] = { id: 'certificates', state: 'problem', reason: 'domains_problem', evidence: '1 checked, 1 with problems, 0 not verified', items: [{ name: username + '.example.test', state: 'problem', reason: 'cert_expired', evidence: 'source=acme notAfter=2026-10-01T00:00:00.000Z' }], omitted: 0 }
  value.checks[4] = { id: 'home', state: 'unavailable', reason: 'host_unavailable', evidence: 'native host observation is unavailable' }
  return { ...value, problems: 2, unavailable: 1 }
}
const report = (accounts: unknown[], pending: string[] = []) => ({ observedAt: '2026-10-27T10:00:00.000Z', host: 'read', accounts, pending, truncated: false })
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
const mount = (locale: 'en' | 'ar' = 'en', canRead = true, root = true) => {
  document.body.innerHTML = `<section data-whm-detail-route="/whm/accounts/health" data-capability-state="authorized">${renderWhmAccountHealthWorkspace({ locale, canRead, root })}</section>`
}
const boot = (request?: Transport, ar = false) => {
  document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + WHM_ACCOUNT_HEALTH_CLIENT_BINDING)()()
}
const q = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
beforeEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; mount() })

describe('WHM account health renderer', () => {
  it('renders the English workspace with summary, filters, bulk recheck and an empty list, without a form', () => {
    const html = renderWhmAccountHealthWorkspace({ locale: 'en', canRead: true, root: true })
    expect(html).toContain('dir="ltr"'); expect(html).toContain('Run checks'); expect(html).toContain('Recheck selected'); expect(html).toContain('Last checked (UTC)')
    expect(html).toContain('data-health-can-read="true"'); expect(html).toContain('data-health-root="true"'); expect(html).toContain('<bdi dir="ltr" data-whm-health-observed-at>')
    for (const section of ['health-summary', 'health-accounts']) expect(html).toContain(`data-whm-detail-section="${section}"`)
    expect(html).not.toMatch(/<form\b/)
  })
  it('renders Arabic RTL copy, ASCII digits, the spacing scale and a fully inert unavailable state', () => {
    const html = renderWhmAccountHealthWorkspace({ locale: 'ar', canRead: false, root: false })
    expect(html).toContain('dir="rtl"'); expect(html).toContain('lang="ar"'); expect(html).toContain('تشغيل الفحوص'); expect(html).toContain('data-state="unavailable"')
    expect(/[٠-٩۰-۹]/.test(html)).toBe(false)
    expect(html).toMatch(/gap:(?:8|16|24|32)px/); expect(html).not.toMatch(/gap:(?:12|20|10)px/)
    const markup = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    const controls = parseMarkup(markup).filter(node => node.template < 0 && ['button', 'input', 'select', 'textarea'].includes(node.tag))
    expect(controls.length).toBeGreaterThan(0)
    for (const control of controls) expect(control.attrs.has('disabled')).toBe(true)
    expect(markup).not.toMatch(/<form\b/i)
  })
})

describe('WHM account health parser', () => {
  it('accepts the reviewed contract and binds rechecks to the requested accounts', () => {
    const value = readAccountHealthReport(report([healthy('alice'), broken('bob')], ['carol']))
    expect(value.accounts.map(entry => [entry.username, entry.problems, entry.unavailable])).toEqual([['alice', 0, 0], ['bob', 2, 1]])
    expect(value.pending).toEqual(['carol'])
    expect(() => readAccountHealthReport(report([healthy('mallory')]), ['alice'])).toThrow()
  })
  it('refuses synthetic success, unknown reasons, inconsistent counts and unsafe text', () => {
    const mutate = (change: (account: ReturnType<typeof broken>) => void) => { const account = broken('bob'); change(account); return report([account]) }
    expect(() => readAccountHealthReport(mutate(account => { account.checks[2]!.state = 'ok' }))).toThrow()
    expect(() => readAccountHealthReport(mutate(account => { account.checks[2]!.reason = 'looks_fine' }))).toThrow()
    expect(() => readAccountHealthReport(mutate(account => { account.problems = 0 }))).toThrow()
    expect(() => readAccountHealthReport(mutate(account => { account.checks.pop() }))).toThrow()
    expect(() => readAccountHealthReport(mutate(account => { account.checks[1] = account.checks[0]! }))).toThrow()
    expect(() => readAccountHealthReport(mutate(account => { account.checks[0]!.evidence = 'ok\u202e' }))).toThrow()
    expect(() => readAccountHealthReport(mutate(account => { account.checks[6]!.state = 'ok'; account.checks[6]!.reason = 'domains_ok'; account.problems = 1 }))).toThrow()
    expect(() => readAccountHealthReport(mutate(account => { (account.checks[0] as Record<string, unknown>).items = [] }))).toThrow()
    expect(() => readAccountHealthReport(mutate(account => { account.checks[7]!.items![0]!.name = '<img src=x>' }))).toThrow()
    expect(() => readAccountHealthReport(mutate(account => { account.checks[7]!.omitted = 3 }))).toThrow()
    expect(() => readAccountHealthReport({ ...report([]), pending: ['Bob'] })).toThrow()
    expect(() => readAccountHealthReport({ ...report([]), observedAt: 'yesterday' })).toThrow()
    expect(() => readAccountHealthReport(report([healthy('alice'), healthy('alice')]))).toThrow()
  })
})

describe('WHM account health binding', () => {
  it('makes no request without transport or authorization', async () => {
    boot(); expect(q('[data-whm-health-status]').dataset.state).toBe('unavailable')
    expect(q<HTMLButtonElement>('[data-whm-health-run]').disabled).toBe(true)
    mount('en', false)
    const send = vi.fn(); boot(send); await tick()
    q<HTMLButtonElement>('[data-whm-health-run]').click(); await tick()
    expect(send).not.toHaveBeenCalled()
    expect([...document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('button,input,select')].every(control => control.disabled)).toBe(true)
    document.body.innerHTML = `<section data-capability-state="unavailable">${renderWhmAccountHealthWorkspace({ locale: 'en', canRead: true, root: true })}</section>`
    boot(send); q<HTMLButtonElement>('[data-whm-health-run]').click(); await tick()
    expect(send).not.toHaveBeenCalled()
  })

  it('reads the first batch, then pending accounts, and links each problem to its fixing page', async () => {
    const send = vi.fn<Transport>(async (_method, path) => path === '/api/accounts/health' ? report([broken('alice')], ['bob']) : report([healthy('bob')]))
    boot(send); q<HTMLButtonElement>('[data-whm-health-run]').click(); await tick()
    expect(send.mock.calls.map(call => call.slice(0, 2))).toEqual([['GET', '/api/accounts/health'], ['GET', '/api/accounts/health?username=bob']])
    expect(q('[data-whm-health-count-accounts]').textContent).toBe('2'); expect(q('[data-whm-health-count-affected]').textContent).toBe('1')
    expect(q('[data-whm-health-count-problems]').textContent).toBe('2'); expect(q('[data-whm-health-count-unavailable]').textContent).toBe('1')
    expect(q('[data-whm-health-observed-at]').textContent).toBe('2026-10-27 10:00 UTC')
    expect(q('[data-whm-health-status]').dataset.state).toBe('problem'); expect(q('[data-whm-health-run]').textContent).toBe('Check again')
    const alice = q('[data-whm-health-account="alice"]')
    expect(alice.dataset.state).toBe('problem')
    expect(alice.querySelector<HTMLAnchorElement>('[data-whm-health-fix="disk"]')!.getAttribute('href')).toBe('/whm/monitoring/repair')
    expect(alice.querySelector<HTMLAnchorElement>('[data-whm-health-fix="certificates"]')!.getAttribute('href')).toBe('/whm/ssl')
    expect(alice.querySelector('[data-whm-health-check="home"]')!.textContent).toContain('This server could not be observed')
    expect(alice.querySelector('[data-whm-health-check="home"] a')).toBeNull()
    expect(alice.querySelector('pre')!.dir).toBe('ltr')
    expect(q('[data-whm-health-account="bob"]').dataset.state).toBe('ok')
  })

  it('shows resellers help instead of root-only repair links', async () => {
    mount('en', true, false)
    boot(vi.fn<Transport>(async () => report([broken('alice')]))); q<HTMLButtonElement>('[data-whm-health-run]').click(); await tick()
    const disk = q('[data-whm-health-check="disk"]')
    expect(disk.querySelector('a')).toBeNull(); expect(disk.textContent).toContain('Ask the server administrator')
    expect(q<HTMLAnchorElement>('[data-whm-health-fix="certificates"]').getAttribute('href')).toBe('/whm/ssl')
  })

  it('filters rows and rechecks only the selected visible accounts', async () => {
    const send = vi.fn<Transport>(async (_method, path) => path === '/api/accounts/health' ? report([broken('alice'), healthy('bob'), healthy('carol')]) : report([healthy('alice')]))
    boot(send); q<HTMLButtonElement>('[data-whm-health-run]').click(); await tick()
    const filter = q<HTMLSelectElement>('[data-whm-health-filter]'); filter.value = 'problem'; filter.dispatchEvent(new Event('change'))
    expect(['alice', 'bob', 'carol'].map(name => q(`[data-whm-health-account="${name}"]`).hidden)).toEqual([false, true, true])
    filter.value = 'all'; filter.dispatchEvent(new Event('change'))
    const search = q<HTMLInputElement>('[data-whm-health-search]'); search.value = 'CAROL.example'; search.dispatchEvent(new Event('input'))
    expect(['alice', 'bob', 'carol'].map(name => q(`[data-whm-health-account="${name}"]`).hidden)).toEqual([true, true, false])
    search.value = 'nobody'; search.dispatchEvent(new Event('input'))
    expect(q('[data-whm-health-empty]').hidden).toBe(false)
    search.value = ''; search.dispatchEvent(new Event('input'))
    const recheck = q<HTMLButtonElement>('[data-whm-health-recheck]')
    expect(recheck.disabled).toBe(true)
    q<HTMLInputElement>('[data-whm-health-account="alice"] [data-whm-health-pick]').click()
    expect(recheck.disabled).toBe(false); expect(q('[data-whm-health-selection]').textContent).toBe('1 selected')
    recheck.click(); await tick()
    expect(send.mock.calls.at(-1)!.slice(0, 2)).toEqual(['GET', '/api/accounts/health?username=alice'])
    expect(q('[data-whm-health-account="alice"]').dataset.state).toBe('ok'); expect(q('[data-whm-health-count-problems]').textContent).toBe('0')
    expect(q<HTMLInputElement>('[data-whm-health-account="alice"] [data-whm-health-pick]').checked).toBe(true)
    const all = q<HTMLInputElement>('[data-whm-health-select-all]'); all.click()
    expect(q('[data-whm-health-selection]').textContent).toBe('3 selected')
  })

  it('reports a failed or malformed read without painting rows, in Arabic', async () => {
    mount('ar')
    boot(vi.fn<Transport>(async () => ({ ...report([healthy('alice')]), host: 'maybe' })), true); q<HTMLButtonElement>('[data-whm-health-run]').click(); await tick()
    expect(q('[data-whm-health-status]').dataset.state).toBe('failed'); expect(q('[data-whm-health-status]').getAttribute('role')).toBe('alert')
    expect(q('[data-whm-health-status]').textContent).toBe('تعذرت قراءة الفحوص. لم يُغيّر شيء.')
    expect(document.querySelector('[data-whm-health-account]')).toBeNull()
    expect(q<HTMLButtonElement>('[data-whm-health-run]').disabled).toBe(false)
  })
})


describe('full timestamp display additional account health', () => {
  it.each(['en', 'ar'] as const)('formats the observed instant and leaves server evidence canonical in %s', async locale => {
    mount(locale)
    const raw = { ...report([broken('alice')]), observedAt: '2026-10-27T10:00:07.120Z' }, before = JSON.stringify(raw)
    const send = vi.fn<Transport>(async () => raw)
    boot(send, locale === 'ar'); q<HTMLButtonElement>('[data-whm-health-run]').click(); await tick()
    expect(q('[data-whm-health-observed-at]').textContent).toBe('2026-10-27 10:00 UTC')
    expect(q('[data-whm-health-observed-at]').getAttribute('dir')).toBe('ltr')
    expect(document.querySelector('[data-whm-health-pick][value="alice"]')?.getAttribute('aria-label')).toBe(locale === 'ar' ? 'تحديد alice' : 'Select alice')
    expect(Array.from(q('[data-whm-health-check="certificates"]').querySelectorAll('pre')).map(node => node.textContent)).toEqual(['1 checked, 1 with problems, 0 not verified', 'source=acme notAfter=2026-10-01T00:00:00.000Z'])
    expect(readAccountHealthReport(raw).observedAt).toBe('2026-10-27T10:00:07.120Z')
    expect(send).toHaveBeenCalledWith('GET', '/api/accounts/health')
    expect(JSON.stringify(raw)).toBe(before)
  })
})
