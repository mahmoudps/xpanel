// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SITE_HEALTH_CLIENT_BINDING, readSiteHealthView } from './site-health-client.ts'
import { renderSiteHealthWorkspace } from './board-port/site-health-workspace.ts'

const accountId = '11111111-1111-4111-8111-111111111111', domainId = '22222222-2222-4222-8222-222222222222'
const checks = () => [
  { id: 'dns', state: 'problem', cause: 'points_elsewhere', fix: '/domains/zone-editor', detail: { expected: { ipv4: '192.0.2.10', ipv6: null }, found: { ipv4: ['198.51.100.7'], ipv6: [] } } },
  { id: 'http', state: 'ok', cause: 'reachable', fix: '/metrics/logs', detail: { status: 200 } },
  { id: 'certificate', state: 'problem', cause: 'expiring', fix: '/security/ssl', detail: { notAfter: '2026-11-01T00:00:00.000Z', daysLeft: 5, autoRenew: true, source: 'acme' } },
  { id: 'php', state: 'ok', cause: 'supported', fix: '/software/php', detail: { version: '8.3', supported: ['8.3'] } },
]
const view = (extra: Record<string, unknown> = {}) => ({ context: { accountId }, checkedAt: '2026-10-27T00:00:00.000Z', domains: [{ domainId, name: 'example.test', kind: 'primary', checks: checks() }], total: 1, truncated: false, scope: {}, ...extra })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })
async function bind(html: string, request?: (method: string, path: string) => Promise<unknown>) {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = html; document.documentElement.lang = 'en'
  ;(new Function('return ' + SITE_HEALTH_CLIENT_BINDING)() as (confirm: unknown) => void)(undefined)
  await settle()
}
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!

describe('account site health page', () => {
  it('renders bilingual copy without forms or non-ASCII digits', () => {
    for (const lang of ['en', 'ar'] as const) {
      const html = renderSiteHealthWorkspace({ lang, accountId, canManage: true })
      expect(html).toContain(`dir="${lang === 'ar' ? 'rtl' : 'ltr'}"`); expect(html).not.toContain('<form'); expect(html).not.toMatch(/[٠-٩۰-۹]/)
      for (const part of ['data-health-run', 'data-health-rows', 'data-health-status']) expect(html).toContain(part)
    }
    expect(renderSiteHealthWorkspace({ lang: 'ar', accountId, canManage: true })).toContain('فحوص الصحة'); expect(SITE_HEALTH_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('stays inert when unavailable and never runs checks by itself', async () => {
    const request = vi.fn(async () => clone(view()))
    await bind(renderSiteHealthWorkspace({ lang: 'en', accountId, canManage: false }), request)
    expect($<HTMLButtonElement>('[data-health-run]').disabled).toBe(true); expect($('[data-health-status]').getAttribute('data-state')).toBe('unavailable')
    document.body.replaceChildren(); await bind(renderSiteHealthWorkspace({ lang: 'en', accountId, canManage: true }), request)
    expect(request).not.toHaveBeenCalled(); expect($<HTMLButtonElement>('[data-health-run]').disabled).toBe(false)
  })
  it('rejects foreign scopes, unknown causes and rewritten fix links', () => {
    expect(readSiteHealthView(clone(view()), accountId).domains[0]!.checks).toHaveLength(4)
    const bad = (mutate: (value: ReturnType<typeof view>) => void) => { const value = clone(view()); mutate(value); return value }
    for (const value of [bad(v => { v.context.accountId = '33333333-3333-4333-8333-333333333333' }), bad(v => { v.domains[0]!.checks[0]!.fix = 'https://evil.example/' }), bad(v => { v.domains[0]!.checks[1]!.cause = 'great' }),
      bad(v => { v.domains[0]!.checks.reverse() }), bad(v => { v.truncated = true }), bad(v => { (v.domains[0]!.checks[1]!.detail as { status: number }).status = 42 }), bad(v => { v.domains[0]!.name = '<b>x</b>' }), bad(v => { (v.domains[0]!.checks[0]!.detail as { found: { ipv4: string[] } }).found.ipv4 = ['evil host'] })])
      expect(() => readSiteHealthView(value, accountId)).toThrow()
  })
  it('runs on request, explains findings as text and links problems to the page that fixes them', async () => {
    const request = vi.fn(async (_method: string, path: string) => { expect(path).toBe('/api/account/site-health'); return clone(view()) })
    await bind(renderSiteHealthWorkspace({ lang: 'en', accountId, canManage: true }), request)
    $<HTMLButtonElement>('[data-health-run]').click(); await settle(); await settle()
    expect(document.querySelectorAll('[data-health-rows] tr')).toHaveLength(4); expect($('[data-health-problems]').textContent).toBe('2')
    expect([...document.querySelectorAll<HTMLAnchorElement>('[data-health-rows] a')].map(link => link.getAttribute('href'))).toEqual(['/domains/zone-editor?lang=en', '/security/ssl?lang=en'])
    expect($('[data-health-rows]').textContent).toContain('198.51.100.7'); expect($('[data-health-rows]').textContent).toContain('Expires in 5 days')
    const failing = vi.fn(async () => { throw new Error('timeout') }); document.body.replaceChildren()
    await bind(renderSiteHealthWorkspace({ lang: 'en', accountId, canManage: true }), failing)
    $<HTMLButtonElement>('[data-health-run]').click(); await settle(); await settle()
    expect($('[data-health-status]').getAttribute('data-state')).toBe('failed'); expect($<HTMLButtonElement>('[data-health-run]').disabled).toBe(false)
  })
})

describe('readable date closure site health', () => {
  for (const lang of ['en', 'ar'] as const) it('formats checked metadata and preserves the raw health response in ' + lang, async () => {
    const source = view({ checkedAt: '2026-10-27T09:01:02.123Z' }), before = JSON.stringify(source), send = vi.fn(async () => source)
    Object.assign(window, { xpanelSessionRequest: send }); document.body.innerHTML = renderSiteHealthWorkspace({ lang, accountId, canManage: true })
    document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
    new Function('return ' + SITE_HEALTH_CLIENT_BINDING)()(undefined)
    $<HTMLButtonElement>('[data-health-run]').click(); await settle(); await settle()
    expect($('[data-health-at]').textContent).toBe('2026-10-27 09:01 UTC'); expect($('[data-health-at]').getAttribute('dir')).toBe('ltr')
    expect($('[data-health-rows]').textContent).toContain('2026-11-01 00:00 UTC')
    const rowsText = $('[data-health-rows]').textContent, ar = lang === 'ar'
    expect(rowsText).toContain(ar ? 'يشير سجل A إلى عنوان آخر: 198.51.100.7' : 'The A record points to another address: 198.51.100.7'); expect(rowsText).toContain(ar ? 'تستجيب الصفحة الرئيسية (HTTP 200).' : 'The home page answers (HTTP 200).')
    expect(rowsText).toContain(ar ? 'إصدار PHP 8.3 مدعوم.' : 'PHP 8.3 is supported.'); expect($('[data-health-rows] a').getAttribute('aria-label')).toBe(ar ? 'إصلاح DNS: example.test' : 'Fix DNS: example.test')
    expect(JSON.stringify(source)).toBe(before); expect(readSiteHealthView(source, accountId).checkedAt).toBe('2026-10-27T09:01:02.123Z')
    expect(send.mock.calls).toEqual([['GET', '/api/account/site-health']]); expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})
describe('readable date closure certificate expiry explanations', () => {
  const outcomes = [
    { cause: 'valid', state: 'ok', daysLeft: 61, notAfter: '2026-12-27T09:01:02.000Z', stamp: '2026-12-27 09:01 UTC', en: 'Valid until 2026-12-27 09:01 UTC.', ar: 'صالحة حتى 2026-12-27 09:01 UTC.', problems: '1' },
    { cause: 'expiring', state: 'problem', daysLeft: 5, notAfter: '2026-11-01T09:01:02.123456Z', stamp: '2026-11-01 09:01 UTC', en: 'Expires in 5 days (2026-11-01 09:01 UTC).', ar: 'تنتهي خلال 5 أيام (2026-11-01 09:01 UTC).', problems: '2' },
    { cause: 'expired', state: 'problem', daysLeft: -2, notAfter: '2026-10-25T09:01:02.123Z', stamp: '2026-10-25 09:01 UTC', en: 'Expired on 2026-10-25 09:01 UTC.', ar: 'انتهت في 2026-10-25 09:01 UTC.', problems: '2' },
  ] as const
  for (const lang of ['en', 'ar'] as const) for (const outcome of outcomes) it('isolates readable ' + outcome.cause + ' date and retains expiry evidence in ' + lang, async () => {
    const source = view()
    source.domains[0]!.checks[2] = { id: 'certificate', state: outcome.state, cause: outcome.cause, fix: '/security/ssl', detail: { notAfter: outcome.notAfter, daysLeft: outcome.daysLeft, autoRenew: true, source: 'acme' } }
    const before = JSON.stringify(source), send = vi.fn(async () => source)
    Object.assign(window, { xpanelSessionRequest: send }); document.body.innerHTML = renderSiteHealthWorkspace({ lang, accountId, canManage: true })
    document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
    new Function('return ' + SITE_HEALTH_CLIENT_BINDING)()(undefined)
    $<HTMLButtonElement>('[data-health-run]').click(); await settle(); await settle()
    const row = document.querySelectorAll('[data-health-rows] tr')[2]!, detail = row.children[3]!, instant = detail.querySelector('bdi')!
    expect(detail.textContent).toBe(outcome[lang]); expect(detail.getAttribute('dir')).toBe('auto')
    expect(instant.textContent).toBe(outcome.stamp); expect(instant.getAttribute('dir')).toBe('ltr'); expect(detail.querySelectorAll('bdi')).toHaveLength(1)
    expect(detail.textContent).not.toContain(outcome.notAfter); expect(detail.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    expect(row.querySelector('[data-state-chip]')?.getAttribute('data-state-chip')).toBe(outcome.state); expect($('[data-health-problems]').textContent).toBe(outcome.problems)
    expect(row.children[4]!.querySelector('a')?.getAttribute('href') ?? null).toBe(outcome.cause === 'valid' ? null : '/security/ssl?lang=' + lang)
    const parsed = readSiteHealthView(source, accountId).domains[0]!.checks[2]!
    expect(parsed.detail.notAfter).toBe(outcome.notAfter); expect(parsed.detail.daysLeft).toBe(outcome.daysLeft); expect(parsed.state).toBe(outcome.state); expect(parsed.cause).toBe(outcome.cause)
    expect(JSON.stringify(source)).toBe(before); expect(send.mock.calls).toEqual([['GET', '/api/account/site-health']])
  })
})