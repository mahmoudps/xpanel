// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmDnsToolsWorkspace } from './board-port/whm-dns-tools-workspace.ts'
import { WHM_DNS_TOOLS_CLIENT_BINDING, readDnsToolsView } from './whm-dns-tools-client.ts'

const tick = async () => { for (let index = 0; index < 12; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const observedAt = '2026-10-27T10:00:00.000Z', jobId = '11111111-1111-4111-8111-111111111111'
const revA = 'a'.repeat(64), revB = 'b'.repeat(64), revA2 = 'c'.repeat(64)
const overview = { observedAt, zones: [{ zone: 'a.example', revision: revA, records: 2, minTtl: 300, maxTtl: 3600 }, { zone: 'b.example', revision: revB, records: 1, minTtl: 600, maxTtl: 600 }] }
const jobSummary = { id: jobId, status: 'succeeded', summary: 'Check DNS zones 1-2 of 2', zones: 2, createdAt: observedAt, startedAt: observedAt, finishedAt: observedAt, error: null }
const job = { job: jobSummary, logAvailable: true, logTruncated: false, results: [{ zone: 'a.example', state: 'passed', records: 4, errors: 0, warnings: 0, messages: [] }, { zone: 'b.example', state: 'failed', records: 2, errors: 1, warnings: 0, messages: ['[Error] bad record'] }] }
const compareRow = (zone: string, drift: string[] = []) => ({ zone, saved: { stateSerial: 1, file: 'parsed', fileSerial: 2, ns: ['ns1.host.test'] }, live: { state: 'answered', serial: 2, nsState: 'answered', ns: ['ns1.host.test'] }, drift })
const compare = (page: number) => ({ observedAt, server: '127.0.0.1', control: 'reachable', page, pages: 2, total: 26, zones: page === 1 ? [compareRow('a.example'), compareRow('b.example', ['ns-differs'])] : [compareRow('z.example')] })
const nameservers = { observedAt, server: '127.0.0.1', page: 1, pages: 1, total: 2, zones: [
  { zone: 'a.example', soa: 'answered', truncated: false, nameservers: [{ host: 'ns1.host.test', state: 'answered', addresses: [{ address: '192.0.2.1', thisServer: true }], result: 'answers' }, { host: 'ns2.other.test', state: 'refused', addresses: [], result: 'not-local' }] },
  { zone: 'b.example', soa: 'answered', truncated: false, nameservers: [] }] }
const preview = { observedAt, ttl: 600, zones: [{ zone: 'a.example', state: 'ready', revision: revA, records: 2, changes: 2, minTtl: 300, maxTtl: 3600 }, { zone: 'b.example', state: 'unchanged', revision: revB, records: 1, changes: 0, minTtl: 600, maxTtl: 600 }] }
const applied = { ttl: 600, reconcile: 'requested', auditIncomplete: false, results: [{ zone: 'a.example', state: 'applied', revision: revA2, changes: 2 }] }
const ack = { jobs: [{ id: jobId, kind: 'dns.tools.check-zones', status: 'queued', zones: 2 }], zones: 2, notQueued: 0, incomplete: false }
const reply = (method: string, path: string): unknown => method === 'POST' ? path.endsWith('/check-jobs') ? ack : path.endsWith('/preview') ? preview : applied
  : path === '/api/server/dns-tools' ? overview : path.endsWith('/check-jobs') ? { jobs: [jobSummary] } : path.includes('/check-jobs/') ? job : path.startsWith('/api/server/dns-tools/compare') ? compare(Number(path.split('=')[1])) : nameservers
const mount = (canRead = true, canManage = true, locale: 'en' | 'ar' = 'en') => { document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'; document.body.innerHTML = `<section data-whm-detail-route="/whm/dns/more" data-capability-state="authorized">${renderWhmDnsToolsWorkspace({ locale, canRead, canManage })}</section>` }
const boot = (request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ask?: (options: Record<string, unknown>) => Promise<unknown>) => {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + WHM_DNS_TOOLS_CLIENT_BINDING)()(ask)
}
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const rows = (key: string) => [...document.querySelectorAll(`[data-whm-dns-tools-rows="${key}"] tr`)]
const pick = (zone: string) => { const box = $<HTMLInputElement>(`[data-whm-dns-tools-pick="${zone}"]`); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })) }
const ttl = (value: string) => { const input = $<HTMLInputElement>('[data-whm-dns-tools-ttl]'); input.value = value; input.dispatchEvent(new Event('input')) }
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('DNS tools client parser', () => {
  it('accepts projected views and drops unknown fields', () => {
    expect(JSON.stringify(readDnsToolsView('overview', { ...overview, secret: 1 }))).not.toContain('secret')
    expect(readDnsToolsView('job', job, jobId).results[1]!.errors).toBe(1)
    expect(readDnsToolsView('compare', compare(2), 2).zones[0]!.zone).toBe('z.example')
    expect(readDnsToolsView('nameservers', nameservers, 1).zones[0]!.nameservers[1]!.result).toBe('not-local')
    expect(readDnsToolsView('submit', ack).jobs).toEqual([{ id: jobId, status: 'queued', zones: 2 }])
    expect(readDnsToolsView('preview', preview, { ttl: 600, zones: ['a.example', 'b.example'] }).zones[0]!.changes).toBe(2)
    expect(readDnsToolsView('apply', applied, { ttl: 600, zones: ['a.example'] }).results[0]!.revision).toBe(revA2)
  })
  it('refuses foreign, inconsistent or malformed evidence', () => {
    expect(() => readDnsToolsView('job', job, '22222222-2222-4222-8222-222222222222')).toThrow()
    expect(() => readDnsToolsView('job', { ...job, results: [job.results[0]] }, jobId)).toThrow()
    expect(() => readDnsToolsView('job', { ...job, results: [{ ...job.results[0], errors: 2 }, job.results[1]] }, jobId)).toThrow()
    expect(() => readDnsToolsView('compare', compare(1), 2)).toThrow()
    expect(() => readDnsToolsView('compare', { ...compare(1), server: '9.9.9.9' }, 1)).toThrow()
    expect(() => readDnsToolsView('compare', { ...compare(1), zones: [{ ...compareRow('a.example'), drift: ['everything'] }] }, 1)).toThrow()
    expect(() => readDnsToolsView('overview', { ...overview, zones: [{ ...overview.zones[0], zone: 'A.example' }] })).toThrow()
    expect(() => readDnsToolsView('submit', { ...ack, jobs: [{ ...ack.jobs[0], kind: 'system.packages.upgrade' }] })).toThrow()
    expect(() => readDnsToolsView('preview', preview, { ttl: 300, zones: ['a.example', 'b.example'] })).toThrow()
    expect(() => readDnsToolsView('preview', preview, { ttl: 600, zones: ['b.example', 'a.example'] })).toThrow()
    expect(() => readDnsToolsView('apply', { ...applied, results: [{ zone: 'a.example', state: 'conflict', revision: revA, changes: 0 }] }, { ttl: 600, zones: ['a.example'] })).toThrow()
    expect(() => readDnsToolsView('apply', { ...applied, reconcile: 'not-needed' }, { ttl: 600, zones: ['a.example'] })).toThrow()
  })
})

describe('DNS tools client binding', () => {
  it('makes no request without transport or read authority and stays inert', async () => {
    mount(); boot(); expect($('[data-whm-dns-tools-status="summary"]').dataset.state).toBe('unavailable')
    mount(false); const send = vi.fn(); boot(send); await tick()
    expect(send).not.toHaveBeenCalled()
    for (const control of document.querySelectorAll<HTMLInputElement>('input,select,textarea,button')) expect(control.disabled).toBe(true)
    expect(document.querySelector('form')).toBeNull()
    expect(WHM_DNS_TOOLS_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_DNS_TOOLS_CLIENT_BINDING).not.toContain('fetch(')
  })
  it.each(['en', 'ar'] as const)('preserves complete DNS observation and job instants in %s using read-only requests', async locale => {
    const instant = '2026-10-27T10:11:12.345Z', createdAt = '2026-10-27T09:08:07.654Z', finishedAt = '2026-10-27T09:09:08.765Z'
    const queued = { ...jobSummary, id: '33333333-3333-4333-8333-333333333333', status: 'queued', createdAt, startedAt: null, finishedAt: null }
    mount(true, false, locale)
    const send = vi.fn(async (method: string, path: string) => path === '/api/server/dns-tools' ? { ...overview, observedAt: instant }
      : path.endsWith('/check-jobs') ? { jobs: [{ ...jobSummary, createdAt, finishedAt }, queued] } : reply(method, path))
    boot(send); await tick()
    expect($('[data-whm-dns-tools-fact="observed-at"]').textContent).toBe('2026-10-27 10:11 UTC')
    $<HTMLButtonElement>('[data-whm-dns-tools-load="jobs"]').click(); await tick()
    expect(rows('jobs')[0]!.querySelector('td:nth-child(4) bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 09:08 UTC')
    expect(rows('jobs')[0]!.querySelector('td:nth-child(5) bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 09:09 UTC')
    expect(rows('jobs')[1]!.querySelector('td:nth-child(5)')!.textContent).toBe(locale === 'ar' ? 'ليس بعد' : 'Not yet')
    expect(send).toHaveBeenLastCalledWith('GET', '/api/server/dns-tools/check-jobs')
    expect(send.mock.calls.every(([method]) => method === 'GET')).toBe(true)
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('queues the check after confirmation, lists jobs and reads one job per zone', async () => {
    mount()
    const send = vi.fn(async (method: string, path: string) => reply(method, path)), ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/dns-tools')
    expect($('[data-whm-dns-tools-fact="zones"]').textContent).toBe('2')
    expect(rows('zones')).toHaveLength(2)
    $<HTMLButtonElement>('[data-whm-dns-tools-run="check"]').click(); await tick()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('POST', '/api/server/dns-tools/check-jobs', {})
    expect($('[data-whm-dns-tools-result="check"]').dataset.outcome).toBe('submitted')
    expect(send).toHaveBeenLastCalledWith('GET', '/api/server/dns-tools/check-jobs')
    expect(rows('jobs')).toHaveLength(1)
    $<HTMLButtonElement>(`[data-whm-dns-tools-job="${jobId}"]`).click(); await tick()
    expect(send).toHaveBeenLastCalledWith('GET', '/api/server/dns-tools/check-jobs/' + jobId)
    expect(rows('results').map(row => row.textContent)).toEqual(['a.examplePassed400', 'b.exampleErrors found210[Error] bad record'])
    expect(rows('results')[0]!.querySelector('bdi[dir="ltr"]')!.textContent).toBe('a.example')
    expect($<HTMLAnchorElement>('[data-whm-dns-tools-job-link]').getAttribute('href')).toBe('/whm/jobs?job=' + jobId)
  })
  it('pages the published versus saved comparison and lists nameserver results', async () => {
    mount()
    const send = vi.fn(async (method: string, path: string) => reply(method, path))
    boot(send, async () => true); await tick()
    const next = $<HTMLButtonElement>('[data-whm-dns-tools-page="compare"][data-direction="next"]')
    expect(next.disabled).toBe(true)
    $<HTMLButtonElement>('[data-whm-dns-tools-load="compare"]').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('GET', '/api/server/dns-tools/compare?page=1')
    expect(rows('compare')[1]!.textContent).toContain('Published NS differ from saved NS')
    expect(rows('compare')[0]!.textContent).toContain('In sync')
    expect($('[data-whm-dns-tools-page-label="compare"]').textContent).toBe('Page 1 / 2')
    expect(next.disabled).toBe(false)
    next.click(); await tick()
    expect(send).toHaveBeenLastCalledWith('GET', '/api/server/dns-tools/compare?page=2')
    expect(rows('compare')).toHaveLength(1)
    expect(next.disabled).toBe(true)
    $<HTMLButtonElement>('[data-whm-dns-tools-load="nameservers"]').click(); await tick()
    expect(rows('nameservers').map(row => row.textContent)).toEqual(['a.exampleAnsweredns1.host.test192.0.2.1 (this server)Answers from this server', 'a.exampleAnsweredns2.other.testRefused: not served hereOutside zones served here; not checked', 'b.exampleAnsweredNo saved apex NS records-Not checked'])
    expect($('[data-whm-dns-tools-status="nameservers"]').textContent).toBe('Zones with a nameserver not confirmed on this server: 2 / 2')
  })
  it('previews and applies a TTL per zone with each previewed revision; a stale preview cannot be applied', async () => {
    mount()
    const send = vi.fn(async (method: string, path: string) => reply(method, path)), ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    const previewButton = $<HTMLButtonElement>('[data-whm-dns-tools-run="preview"]'), apply = $<HTMLButtonElement>('[data-whm-dns-tools-run="apply"]')
    pick('b.example'); pick('a.example')
    expect(previewButton.disabled).toBe(true)
    ttl('600.5'); expect(previewButton.disabled).toBe(true)
    ttl('600'); expect(previewButton.disabled).toBe(false)
    expect($('[data-whm-dns-tools-selected]').textContent).toBe('Selected zones: 2 / 32')
    previewButton.click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/dns-tools/ttl/preview', { ttl: 600, zones: ['a.example', 'b.example'] })
    expect(rows('preview').map(row => row.lastElementChild!.textContent)).toEqual(['Will change', 'Already at this TTL'])
    expect(apply.disabled).toBe(false)
    ttl('601'); expect(apply.disabled).toBe(true)
    ttl('600'); expect(apply.disabled).toBe(false)
    apply.click(); await tick()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('POST', '/api/server/dns-tools/ttl/apply', { ttl: 600, zones: [{ zone: 'a.example', expectedZoneRevision: revA }] })
    expect(rows('applied')[0]!.textContent).toBe('a.example2Applied and read back')
    expect($('[data-whm-dns-tools-result="ttl"]').dataset.outcome).toBe('applied')
    expect($('[data-whm-dns-tools-result="ttl"]').textContent).toContain('Use Compare to confirm the published serials.')
    expect(send).toHaveBeenLastCalledWith('GET', '/api/server/dns-tools')
    expect(apply.disabled).toBe(true)
  })
  it('does nothing when confirmation is declined and reports refusals and unknown outcomes', async () => {
    mount()
    const send = vi.fn(async (method: string, path: string) => reply(method, path))
    boot(send, async () => false); await tick()
    $<HTMLButtonElement>('[data-whm-dns-tools-run="check"]').click(); await tick()
    expect(send).toHaveBeenCalledTimes(1)
    mount()
    boot(async (method: string, path: string) => { if (method === 'GET') return reply(method, path); throw Object.assign(new Error('refused'), { status: 412, code: 'PRECONDITION_FAILED', details: { stateChanged: false } }) }, async () => true); await tick()
    $<HTMLButtonElement>('[data-whm-dns-tools-run="check"]').click(); await tick()
    expect($('[data-whm-dns-tools-result="check"]').dataset.outcome).toBe('unavailable')
    expect($('[data-whm-dns-tools-result="check"]').textContent).toContain('Nothing was changed')
    mount()
    boot(async (method: string, path: string) => method === 'GET' ? reply(method, path) : { ...ack, jobs: [{ ...ack.jobs[0], kind: 'other' }] }, async () => true); await tick()
    $<HTMLButtonElement>('[data-whm-dns-tools-run="check"]').click(); await tick()
    expect($('[data-whm-dns-tools-result="check"]').dataset.outcome).toBe('unknown')
    mount()
    boot(async (method: string, path: string) => method === 'GET' ? reply(method, path) : { ...preview, ttl: 5 }, async () => true); await tick()
    pick('a.example'); ttl('600'); $<HTMLButtonElement>('[data-whm-dns-tools-run="preview"]').click(); await tick()
    expect($('[data-whm-dns-tools-status="ttl"]').dataset.state).toBe('failed')
    expect($<HTMLButtonElement>('[data-whm-dns-tools-run="apply"]').disabled).toBe(true)
  })
  it('keeps changes disabled without manage authority, in Arabic with ASCII digits', async () => {
    mount(true, false, 'ar')
    boot(async (method: string, path: string) => reply(method, path), async () => true); await tick()
    expect($<HTMLInputElement>('[data-whm-dns-tools-pick="a.example"]').disabled).toBe(true)
    expect($<HTMLInputElement>('[data-whm-dns-tools-ttl]').disabled).toBe(true)
    for (const action of ['check', 'preview', 'apply']) expect($<HTMLButtonElement>(`[data-whm-dns-tools-run="${action}"]`).disabled).toBe(true)
    expect($<HTMLButtonElement>('[data-whm-dns-tools-load="compare"]').disabled).toBe(false)
    expect($('[data-whm-dns-tools-status="summary"]').textContent).toBe('قُرئت المناطق المحفوظة.')
    expect($('[data-whm-dns-tools-selected]').textContent).toBe('المناطق المحددة: 0 / 32')
    $<HTMLButtonElement>('[data-whm-dns-tools-load="compare"]').click(); await tick()
    expect($('[data-whm-dns-tools-page-label="compare"]').textContent).toBe('الصفحة 1 / 2')
    expect($('[data-whm-dns-tools-status="compare"]').textContent).toBe('المناطق ذات الانحراف في هذه الصفحة: 1 / 2. المناطق المحفوظة: 26')
    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
  })
})
