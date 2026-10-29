// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmMailQualityWorkspace } from './board-port/whm-mail-quality-workspace.ts'
import { readMailQualityList, readMailQualityResults, WHM_MAIL_QUALITY_CLIENT_BINDING } from './whm-mail-quality-client.ts'

const tick = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const listing = (count = 2) => ({ hostname: 'host.example.test', helo: 'host.example.test', addresses: [{ address: '192.0.2.10', version: 4, public: true }, { address: '10.0.0.5', version: 4, public: false }],
  domains: Array.from({ length: count }, (_, index) => ({ domain: index ? `d${index}.test` : 'example.test', account: 'alice', mailboxes: 1, zone: null })), truncated: false, maxCheck: 50 })
const ok = (detail: Record<string, unknown>) => ({ state: 'ok', cause: 'ok', fix: null, detail })
const healthy = (domain: string) => ({ domain,
  mx: ok({ published: [{ priority: 10, host: 'mail.example.test' }], saved: [{ priority: 10, host: 'mail.example.test' }], hostname: 'host.example.test', pointsHere: true }),
  spf: ok({ record: 'v=spf1 a mx -all', records: 1, addresses: [{ address: '192.0.2.10', result: 'pass' }] }),
  dkim: ok({ selector: 'xp202610', source: 'signing-key', records: 1 }),
  dmarc: ok({ record: 'v=DMARC1; p=reject', policy: 'reject' }),
  ptr: ok({ expected: 'host.example.test', addresses: [{ address: '192.0.2.10', names: ['host.example.test'], confirmed: ['host.example.test'] }] }) })
const broken = (domain: string) => ({ ...healthy(domain),
  spf: { state: 'problem', cause: 'spf_multiple', fix: '/whm/dns', detail: { record: 'v=spf1 -all', records: 2, addresses: [] } },
  ptr: { state: 'problem', cause: 'ptr_not_confirmed', fix: '/whm/email/server', detail: { expected: 'host.example.test', addresses: [{ address: '192.0.2.10', names: ['host.example.test'], confirmed: [] }] } },
  dkim: { state: 'unavailable', cause: 'lookup_timeout', fix: null, detail: { selector: 'xp202610', source: 'saved-zone', records: 0 } } })
const run = (results: unknown[], timedOut = false) => ({ checkedAt: '2026-10-27T10:00:00.000Z', timedOut, results })
const status = () => document.querySelector<HTMLElement>('[data-whm-mail-quality-status]')!
const banner = () => document.querySelector<HTMLElement>('[data-whm-mail-quality-result]')!
const button = () => document.querySelector<HTMLButtonElement>('[data-whm-mail-quality-check]')!
const fact = (key: string) => document.querySelector(`[data-whm-mail-quality-fact="${key}"]`)!.textContent
const select = (domain: string) => { const box = document.querySelector<HTMLInputElement>(`[data-whm-mail-quality-select="${domain}"]`)!; box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })) }
const cell = (domain: string, check: string) => document.querySelector<HTMLInputElement>(`[data-whm-mail-quality-select="${domain}"]`)!.closest('tr')!.querySelector<HTMLElement>(`[data-check="${check}"]`)!
const mount = (locale: 'en' | 'ar' = 'en', canRead = true, capability = 'authorized') => { document.body.innerHTML = `<section data-whm-detail-route="/whm/email/quality" data-capability-state="${capability}">${renderWhmMailQualityWorkspace({ locale, canRead })}</section>` }
const boot = (request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ar = false) => {
  document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + WHM_MAIL_QUALITY_CLIENT_BINDING)()()
}
beforeEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; mount(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('mail quality client parsers', () => {
  it('accepts the listing and results and drops unknown fields', () => {
    expect(readMailQualityList({ ...listing(), extra: 'x' }).domains).toHaveLength(2)
    const parsed = readMailQualityResults({ ...run([{ ...broken('example.test'), secret: 'x' }]), extra: 1 }, ['example.test'])
    expect(parsed.results[0]!.spf.cause).toBe('spf_multiple')
    expect(JSON.stringify(parsed)).not.toContain('secret')
  })
  it('refuses inconsistent listings', () => {
    for (const bad of [{ ...listing(), maxCheck: 500 }, { ...listing(), domains: [listing().domains[0], listing().domains[0]] }, { ...listing(), domains: [{ ...listing().domains[0], domain: 'Example.test' }] },
      { ...listing(), domains: [{ ...listing().domains[0], mailboxes: 0 }] }, { ...listing(), hostname: '<b>' }, { ...listing(), addresses: [{ address: 'x', version: 4, public: true }] }]) expect(() => readMailQualityList(bad)).toThrow()
  })
  it('refuses results that claim ok with a cause or fix, unknown causes, malformed details or another domain', () => {
    const one = healthy('example.test')
    for (const bad of [run([{ ...one, mx: { ...one.mx, cause: 'mx_missing' } }]), run([{ ...one, mx: { ...one.mx, fix: '/whm/dns' } }]), run([{ ...one, spf: { state: 'problem', cause: 'dmarc_missing', fix: '/whm/dns', detail: one.spf.detail } }]),
      run([{ ...one, dmarc: ok({ record: null, policy: null }) }]), run([{ ...one, ptr: ok({ expected: 'host.example.test', addresses: 'x' }) }]), run([{ ...one, spf: { ...one.spf, fix: '/etc/passwd' } }]),
      run([healthy('other.test')]), run([]), { ...run([one]), checkedAt: 'yesterday' }]) expect(() => readMailQualityResults(bad, ['example.test'])).toThrow()
  })
})

describe('mail quality client binding', () => {
  it('makes no request without transport or admission', async () => {
    boot(); expect(status().dataset.state).toBe('unavailable')
    mount('en', false); const send = vi.fn(); boot(send); await tick()
    expect(send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable')
    mount('en', true, 'unavailable'); boot(send); await tick()
    expect(send).not.toHaveBeenCalled(); expect(button().disabled).toBe(true)
    expect(WHM_MAIL_QUALITY_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_MAIL_QUALITY_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('lists domains, checks the selection and paints each check with its cause and fix link', async () => {
    const send = vi.fn(async (method: string, _path: string, body?: unknown) => method === 'GET' ? listing() : run((body as { domains: string[] }).domains.map(domain => domain === 'example.test' ? broken(domain) : healthy(domain)), true))
    boot(send); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/mail-quality')
    expect(status().dataset.state).toBe('read')
    expect(fact('hostname')).toBe('host.example.test')
    expect(fact('addresses')).toBe('192.0.2.10, 10.0.0.5 (not public)')
    expect(fact('checked')).toBe('0')
    expect(cell('example.test', 'mx').textContent).toBe('Not checked')
    expect(button().disabled).toBe(true)
    select('example.test'); select('d1.test')
    expect(button().disabled).toBe(false)
    button().click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/mail-quality/check', { domains: ['example.test', 'd1.test'] })
    expect(banner().dataset.outcome).toBe('problem')
    expect(banner().textContent).toContain('Checked 2 domains: 1 with problems, 1 with unavailable checks. Nothing was changed.')
    expect(banner().textContent).toContain('reached its time limit')
    expect(fact('checked')).toBe('2'); expect(fact('problems')).toBe('1'); expect(fact('checked-at')).toBe('2026-10-27 10:00 UTC')
    const spf = cell('example.test', 'spf')
    expect(spf.querySelector('strong')!.dataset.state).toBe('problem')
    expect(spf.textContent).toContain('More than one SPF record is published')
    expect(spf.querySelector('bdi[dir="ltr"]')!.textContent).toBe('v=spf1 -all')
    expect(spf.querySelector('a')!.getAttribute('href')).toBe('/whm/dns')
    expect(cell('example.test', 'ptr').querySelector('a')!.getAttribute('href')).toBe('/whm/email/server')
    expect(cell('example.test', 'dkim').textContent).toContain('The DNS lookup timed out.')
    expect(cell('example.test', 'dkim').querySelector('a')).toBeNull()
    expect(cell('d1.test', 'dmarc').textContent).toContain('Policy: reject')
    expect(cell('d1.test', 'mx').querySelector('bdi')!.textContent).toBe('10 mail.example.test')
    expect(cell('d1.test', 'mx').querySelector('a')).toBeNull()
  })
  it('selects at most the first 50 domains and keeps earlier results when a check is refused', async () => {
    let fail = false
    const send = vi.fn(async (method: string, _path: string, body?: unknown) => {
      if (method === 'GET') return listing(60)
      if (fail) throw Object.assign(new Error('forbidden'), { status: 403 })
      return run((body as { domains: string[] }).domains.map(healthy))
    })
    boot(send); await tick()
    const all = document.querySelector<HTMLInputElement>('[data-whm-mail-quality-select-all]')!
    all.checked = true; all.dispatchEvent(new Event('change'))
    expect(document.querySelector('[data-whm-mail-quality-selected]')!.textContent).toBe('Selected: 50')
    button().click(); await tick()
    expect((send.mock.calls.at(-1)![2] as { domains: string[] }).domains).toHaveLength(50)
    expect(cell('example.test', 'mx').querySelector('strong')!.textContent).toBe('OK')
    fail = true; button().click(); await tick()
    expect(banner().dataset.outcome).toBe('denied')
    expect(banner().getAttribute('role')).toBe('alert')
    expect(cell('example.test', 'mx').querySelector('strong')!.textContent).toBe('OK')
  })
  it('paints Arabic labels', async () => {
    mount('ar')
    boot(vi.fn(async (method: string, _path: string, body?: unknown) => method === 'GET' ? listing(1) : run((body as { domains: string[] }).domains.map(broken))), true); await tick()
    expect(status().textContent).toContain('قُرئت نطاقات البريد المستضافة')
    expect(fact('addresses')).toBe('192.0.2.10, 10.0.0.5 (غير عام)')
    select('example.test'); button().click(); await tick()
    expect(cell('example.test', 'spf').textContent).toContain('يوجد أكثر من سجل SPF منشور')
    expect(cell('example.test', 'spf').querySelector('a')!.textContent).toBe('الإصلاح في مناطق DNS')
    expect(cell('example.test', 'mx').querySelector('strong')!.textContent).toBe('سليم')
    expect(cell('example.test', 'dkim').textContent).toContain('xp202610 (المنطقة المحفوظة)')
    expect(banner().textContent).toContain('النطاقات المفحوصة: 1؛ بها مشكلات: 1؛')
    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
  })
})

describe('mail quality timestamp precision', () => {
  it.each(['en', 'ar'] as const)('preserves complete check UTC timestamps in summary and domain rows in %s', async locale => {
    const checkedAt = '2026-10-27T12:34:56.789Z'
    mount(locale)
    const send = vi.fn(async (method: string, _path: string) => method === 'GET' ? listing(1) : { ...run([healthy('example.test')]), checkedAt })
    boot(send, locale === 'ar')
    await tick()
    select('example.test')
    button().click()
    await tick()
    expect(fact('checked-at')).toBe('2026-10-27 12:34 UTC')
    const checkedCell = document.querySelector<HTMLTableRowElement>('[data-whm-mail-quality-rows] tr')!.cells[8]!
    expect(checkedCell.querySelector('bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 12:34 UTC')
    expect(send).toHaveBeenCalledWith('POST', '/api/server/mail-quality/check', { domains: ['example.test'] })
    expect(send).toHaveBeenCalledTimes(2)
  })
})
