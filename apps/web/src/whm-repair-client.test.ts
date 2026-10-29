// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmRepairWorkspace } from './board-port/whm-repair-workspace.ts'
import { readRepairJobAck, readRepairPreview, readRepairReport, WHM_REPAIR_CLIENT_BINDING } from './whm-repair-client.ts'

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const revision = 'a'.repeat(64), removals = 'b'.repeat(64)
const report = () => ({
  observedAt: '2026-10-27T10:00:00.000Z', family: 'debian', revision,
  diagnostics: [
    { id: 'dpkg-interrupted', area: 'packages', state: 'ok', cause: 'No interrupted or partially installed packages were reported.', evidence: '$ /usr/bin/dpkg --audit\n(exit 0)', repair: { id: 'dpkg-configure', available: false, reason: 'no_problem', kind: 'job' } },
    { id: 'apt-broken-dependencies', area: 'packages', state: 'problem', cause: 'Installed packages have unmet dependencies. Package installs and updates will fail until they are corrected.', evidence: ' php8.3-fpm : Depends: php8.3-common', repair: { id: 'apt-fix-broken', available: true, kind: 'job' } },
    { id: 'service-config:nginx', area: 'services', state: 'problem', cause: 'The configuration test failed. The service may refuse to start or reload until its configuration is corrected or a reviewed generation is restored.', evidence: 'nginx: [emerg] unknown directive', repair: { id: 'configuration-generations', available: true, kind: 'existing-workflow', href: '/whm/services/web' } },
    // The agent sends this cause as a gettext context key: its Arabic differs from the same English elsewhere.
    { id: 'configuration-drift', area: 'configuration', state: 'unavailable', cause: msgctxt('repair-center', 'No configuration generation is active, so there is nothing to compare.'), evidence: '', repair: { id: 'configuration-generations', available: false, reason: 'diagnostic_unavailable', kind: 'existing-workflow', href: '/whm/services/web' } },
  ],
})
const preview = () => ({ revision, preview: { repairId: 'apt-fix-broken', source: 'apt-simulation', state: 'ready', install: ['php8.3-common'], remove: ['php8.3-fpm'], configure: ['php8.3-common'], counts: { install: 1, remove: 1, configure: 1 }, removalFingerprint: removals, evidence: 'Remv php8.3-fpm [8.3.11-1]' } })
const ack = () => ({ revision, job: { id: 'job-1', referenceCode: 'XP-JOB-2026-000123', kind: 'system.repair.apt-fix-broken', status: 'queued' } })
const rhelReport = (available = true) => ({ ...report(), family: 'rhel', diagnostics: [{ id: 'dnf-metadata-cache', area: 'packages', state: 'problem', cause: 'At least one enabled repository has no usable cached metadata. The bounded repair refreshes repository metadata only; it does not repair or change installed packages.', evidence: 'Cache-only enabled but no cache', repair: { id: 'dnf-cache-refresh', available, kind: 'job', ...(!available ? { reason: 'cache_recovery_unavailable' } : {}) } }] })
const rhelPreview = () => { const install: string[] = [], remove: string[] = [], configure: string[] = []; return { revision, preview: { repairId: 'dnf-cache-refresh', source: 'dnf-cache-only', state: 'ready', install, remove, configure, counts: { install: 0, remove: 0, configure: 0 }, removalFingerprint: removals, evidence: 'Cached repository metadata is missing.' } } }
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
const mount = (locale: 'en' | 'ar' = 'en', canRead = true, canRepair = true) => {
  // The client translator follows the document language, as it does in a page.
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = `<section data-whm-detail-route="/whm/monitoring/repair" data-capability-state="authorized">${renderWhmRepairWorkspace({ locale, canRead, canRepair })}</section>`
}
const boot = (request?: Transport, ask?: (options: Record<string, unknown>) => Promise<unknown>) => {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + WHM_REPAIR_CLIENT_BINDING)()(ask)
}
const q = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; mount() })
afterEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('WHM repair workspace renderer', () => {
  it('renders the English workspace with summary, findings, preview and job sections', () => {
    const html = renderWhmRepairWorkspace({ locale: 'en', canRead: true, canRepair: true })
    expect(html).toContain('dir="ltr"'); expect(html).toContain('Run diagnostics'); expect(html).toContain('Observed at (UTC)')
    expect(html).toContain('data-repair-can-repair="true"'); expect(html).toContain('<bdi dir="ltr" data-whm-repair-observed-at>')
    for (const section of ['repair-summary', 'repair-findings', 'repair-preview', 'repair-job']) expect(html).toContain(`data-whm-detail-section="${section}"`)
  })
  it('renders Arabic RTL copy with ASCII digits only and an unavailable state without root', () => {
    const html = renderWhmRepairWorkspace({ locale: 'ar', canRead: false, canRepair: true })
    expect(html).toContain('dir="rtl"'); expect(html).toContain('lang="ar"'); expect(html).toContain('تشغيل التشخيص')
    expect(html).toContain('data-repair-can-repair="false"'); expect(html).toContain('data-state="unavailable"'); expect(html).toMatch(/data-whm-repair-diagnose disabled/)
    expect(/[\u0660-\u0669\u06f0-\u06f9]/.test(html)).toBe(false)
    expect(html).toMatch(/gap:(?:8|16|24|32)px/); expect(html).not.toMatch(/gap:(?:12|20|10)px/)
  })
})

describe('WHM repair parsers', () => {
  it('accepts metadata-only RHEL repair and rejects package operations or a foreign platform', () => {
    expect(readRepairReport(rhelReport()).diagnostics[0]!.repair.id).toBe('dnf-cache-refresh')
    expect(readRepairPreview(rhelPreview(), revision, 'dnf-cache-refresh').source).toBe('dnf-cache-only')
    expect(() => readRepairReport({ ...rhelReport(), family: 'debian' })).toThrow()
    const removal = rhelPreview(); removal.preview.remove = ['nginx']; removal.preview.counts.remove = 1
    expect(() => readRepairPreview(removal, revision, 'dnf-cache-refresh')).toThrow()
    expect(() => readRepairPreview({ ...rhelPreview(), preview: { ...rhelPreview().preview, source: 'apt-simulation' } }, revision, 'dnf-cache-refresh')).toThrow()
  })
  it('accepts the reviewed contracts', () => {
    expect(readRepairReport(report()).diagnostics.map(item => item.state)).toEqual(['ok', 'problem', 'problem', 'unavailable'])
    expect(readRepairPreview(preview(), revision, 'apt-fix-broken').remove).toEqual(['php8.3-fpm'])
    expect(readRepairJobAck(ack(), revision, 'apt-fix-broken')).toEqual({ revision, jobId: 'job-1', referenceCode: 'XP-JOB-2026-000123', kind: 'system.repair.apt-fix-broken', status: 'queued' })
    expect(readRepairJobAck({ ...ack(), job: { ...ack().job, referenceCode: null } }, revision, 'apt-fix-broken').referenceCode).toBeNull()
    for (const referenceCode of [undefined, '22222222-2222-4222-8222-222222222222', 'XP-JOB-000000', 'bad\u202eref']) expect(() => readRepairJobAck({ ...ack(), job: { ...ack().job, referenceCode } }, revision, 'apt-fix-broken')).toThrow()
  })
  it('refuses unreviewed links, synthetic availability, unsafe text and mismatched counts', () => {
    const external = report(); external.diagnostics[2]!.repair.href = 'https://example.test/'
    expect(() => readRepairReport(external)).toThrow()
    const synthetic = report(); synthetic.diagnostics[0]!.repair.available = true
    expect(() => readRepairReport(synthetic)).toThrow()
    const bidi = report(); bidi.diagnostics[1]!.cause = 'ok\u202e'
    expect(() => readRepairReport(bidi)).toThrow()
    const bell = report(); bell.diagnostics[1]!.cause = 'ok\u0007'
    expect(() => readRepairReport(bell)).toThrow()
    const context = report(); context.diagnostics[1]!.cause = 'Not A Context\u0004ok'
    expect(() => readRepairReport(context)).toThrow()
    const legacy = report() as unknown as { diagnostics: Record<string, unknown>[] }; legacy.diagnostics[1]!.cause = { en: 'ok', ar: 'ok' }
    expect(() => readRepairReport(legacy)).toThrow()
    const control = report(); control.diagnostics[1]!.evidence = 'a\u0007b'
    expect(() => readRepairReport(control)).toThrow()
    expect(() => readRepairReport({ ...report(), revision: 'stale' })).toThrow()
    const miscount = preview(); miscount.preview.counts.remove = 0
    expect(() => readRepairPreview(miscount, revision, 'apt-fix-broken')).toThrow()
    expect(() => readRepairPreview(preview(), 'c'.repeat(64), 'apt-fix-broken')).toThrow()
    const badName = preview(); badName.preview.remove = ['<img src=x>']; badName.preview.counts.remove = 1
    expect(() => readRepairPreview(badName, revision, 'apt-fix-broken')).toThrow()
    expect(() => readRepairJobAck({ ...ack(), job: { ...ack().job, kind: 'system.packages.upgrade' } }, revision, 'apt-fix-broken')).toThrow()
    expect(() => readRepairJobAck({ ...ack(), job: { ...ack().job, id: '../x' } }, revision, 'apt-fix-broken')).toThrow()
  })
})

describe('WHM repair binding', () => {
  it.each(['en', 'ar'] as const)('previews metadata recovery, preserves all sections and submits only after confirmation: %s', async locale => {
    mount(locale)
    const send = vi.fn<Transport>(async (_method, path) => path.endsWith('/diagnostics') ? rhelReport() : path.endsWith('/preview') ? rhelPreview() : { ...ack(), job: { ...ack().job, kind: 'system.repair.dnf-cache-refresh' } })
    const ask = vi.fn(async () => true); boot(send, ask)
    q<HTMLButtonElement>('[data-whm-repair-diagnose]').click(); await tick()
    q<HTMLButtonElement>('[data-whm-repair-preview-action="dnf-cache-refresh"]').click(); await tick()
    expect(q('[data-whm-repair-preview]').hidden).toBe(false); expect(q('[data-whm-repair-removals]').hidden).toBe(true)
    q<HTMLButtonElement>('[data-whm-repair-start]').click(); await tick()
    expect(send.mock.calls.at(-1)).toEqual(['POST', '/api/server/repair/run', { repairId: 'dnf-cache-refresh', expectedRevision: revision }])
    expect(ask).toHaveBeenCalledTimes(1); expect(q('[data-whm-repair-job]').hidden).toBe(false)
    expect(q('[data-whm-repair-job-status]').textContent).toContain('XP-JOB-2026-000123')
  })
  it('keeps metadata repair disabled when recovery is unavailable', async () => {
    boot(async () => rhelReport(false)); q<HTMLButtonElement>('[data-whm-repair-diagnose]').click(); await tick()
    expect(document.querySelector('[data-whm-repair-preview-action="dnf-cache-refresh"]')).toBeNull()
    expect(q('[data-whm-repair-diagnostic="dnf-metadata-cache"]').textContent).toContain('snapshot and recovery')
  })
  it.each(['en', 'ar'] as const)('uses the explicit unnumbered state after submission and keeps the internal job link: %s', async locale => {
    mount(locale)
    const send = vi.fn<Transport>(async (_method, path) => path.endsWith('/diagnostics') ? report() : path.endsWith('/preview') ? preview() : { ...ack(), job: { ...ack().job, referenceCode: null } })
    boot(send, async () => true)
    q<HTMLButtonElement>('[data-whm-repair-diagnose]').click(); await tick()
    q<HTMLButtonElement>('[data-whm-repair-preview-action="apt-fix-broken"]').click(); await tick()
    q<HTMLButtonElement>('[data-whm-repair-start]').click(); await tick()
    expect(q('[data-whm-repair-job-status]').textContent).toContain(locale === 'ar' ? 'أُرسلت مهمة الإصلاح غير مرقمة. لا يُؤكَّد' : 'Repair job Unnumbered was submitted.')
    expect(q('[data-whm-repair-job-status]').textContent).not.toContain('job-1')
    expect(q('[data-whm-repair-job-link]').getAttribute('href')).toBe('/whm/jobs?job=job-1')
  })
  it('makes no request without transport or authorization', async () => {
    boot(); expect(q('[data-whm-repair-status]').dataset.state).toBe('unavailable')
    expect(q<HTMLButtonElement>('[data-whm-repair-diagnose]').disabled).toBe(true)
    mount('en', false)
    const send = vi.fn(); boot(send); await tick()
    q<HTMLButtonElement>('[data-whm-repair-diagnose]').click(); await tick()
    expect(send).not.toHaveBeenCalled()
  })

  it('runs diagnostics, previews with removals highlighted and submits only the confirmed removal list', async () => {
    const send = vi.fn<Transport>(async (_method, path) => path.endsWith('/diagnostics') ? report() : path.endsWith('/preview') ? preview() : ack())
    const ask = vi.fn(async (_options: Record<string, unknown>) => true)
    boot(send, ask)
    expect(send).not.toHaveBeenCalled()
    q<HTMLButtonElement>('[data-whm-repair-diagnose]').click(); await tick()
    expect(send.mock.calls[0]!.slice(0, 2)).toEqual(['GET', '/api/server/repair/diagnostics'])
    expect(q('[data-whm-repair-count-problem]').textContent).toBe('2')
    expect(q('[data-whm-repair-count-ok]').textContent).toBe('1')
    expect(q('[data-whm-repair-count-unavailable]').textContent).toBe('1')
    expect(q('[data-whm-repair-observed-at]').textContent).toBe('2026-10-27 10:00 UTC')
    expect(q('[data-whm-repair-status]').dataset.state).toBe('problem')
    expect(document.querySelectorAll('[data-whm-repair-diagnostic]')).toHaveLength(4)
    expect(q('[data-whm-repair-diagnostic="service-config:nginx"] a').getAttribute('href')).toBe('/whm/services/web')
    expect(q('[data-whm-repair-diagnostic="service-config:nginx"] bdi').textContent).toBe('nginx')
    expect(q('[data-whm-repair-diagnostic="apt-broken-dependencies"] pre').getAttribute('dir')).toBe('ltr')
    expect(q('[data-whm-repair-diagnostic="configuration-drift"]').textContent).toContain('unavailable until this check can be read')
    expect(document.querySelectorAll('[data-whm-repair-preview-action]')).toHaveLength(1)

    q<HTMLButtonElement>('[data-whm-repair-preview-action="apt-fix-broken"]').click(); await tick()
    expect(send.mock.calls[1]).toEqual(['POST', '/api/server/repair/preview', { repairId: 'apt-fix-broken', expectedRevision: revision }])
    expect(q('[data-whm-repair-preview]').hidden).toBe(false)
    expect(q('[data-whm-repair-removals]').hidden).toBe(false)
    expect(q('[data-whm-repair-remove-list]').textContent).toBe('php8.3-fpm')
    expect(q('[data-whm-repair-preview-remove]').textContent).toBe('1')
    expect(q<HTMLButtonElement>('[data-whm-repair-start]').className).toContain('xp-btn--danger')

    q<HTMLButtonElement>('[data-whm-repair-start]').click(); await tick()
    const options = ask.mock.calls[0]![0] as Record<string, unknown>
    expect(options.danger).toBe(true); expect(String(options.body)).toContain('php8.3-fpm')
    expect(send.mock.calls[2]).toEqual(['POST', '/api/server/repair/run', { repairId: 'apt-fix-broken', expectedRevision: revision, acceptRemovals: true, expectedRemovals: removals }])
    expect(q('[data-whm-repair-job]').hidden).toBe(false)
    expect(q('[data-whm-repair-preview]').hidden).toBe(true)
    expect(q<HTMLAnchorElement>('[data-whm-repair-job-link]').getAttribute('href')).toBe('/whm/jobs?job=job-1')
    expect(q('[data-whm-repair-job-status]').textContent).toContain('re-run diagnostics')
    expect(q('[data-whm-repair-job-status]').textContent).toContain('XP-JOB-2026-000123')
    expect(q('[data-whm-repair-job-status]').textContent).not.toContain('job-1')
    expect(q<HTMLButtonElement>('[data-whm-repair-preview-action]').disabled).toBe(true)

    q<HTMLButtonElement>('[data-whm-repair-rerun]').click(); await tick()
    expect(send.mock.calls[3]!.slice(0, 2)).toEqual(['GET', '/api/server/repair/diagnostics'])
    expect(q('[data-whm-repair-job]').hidden).toBe(true)
    expect(WHM_REPAIR_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_REPAIR_CLIENT_BINDING).not.toContain('fetch(')
  })

  it('does not run a repair when confirmation is declined', async () => {
    const send = vi.fn<Transport>(async (_method, path) => path.endsWith('/diagnostics') ? report() : preview())
    boot(send, async () => false)
    q<HTMLButtonElement>('[data-whm-repair-diagnose]').click(); await tick()
    q<HTMLButtonElement>('[data-whm-repair-preview-action]').click(); await tick()
    q<HTMLButtonElement>('[data-whm-repair-start]').click(); await tick()
    expect(send.mock.calls.map(call => call[1])).toEqual(['/api/server/repair/diagnostics', '/api/server/repair/preview'])
    expect(q('[data-whm-repair-status]').textContent).toContain('No repair was started')
  })

  it('reports a stale revision and an unknown run outcome truthfully', async () => {
    let fail: 'conflict' | 'unknown' = 'conflict'
    const send = vi.fn<Transport>(async (_method, path) => {
      if (path.endsWith('/diagnostics')) return report()
      if (path.endsWith('/preview') && fail === 'conflict') throw Object.assign(new Error('changed'), { code: 'CONFLICT', details: { stateChanged: false } })
      if (path.endsWith('/preview')) return preview()
      throw Object.assign(new Error('lost'), { code: 'SERVICE_UNAVAILABLE', details: { stateChanged: true, unknownOutcome: true } })
    })
    boot(send, async () => true)
    q<HTMLButtonElement>('[data-whm-repair-diagnose]').click(); await tick()
    q<HTMLButtonElement>('[data-whm-repair-preview-action]').click(); await tick()
    expect(q('[data-whm-repair-status]').dataset.state).toBe('stale')
    expect(q('[data-whm-repair-preview]').hidden).toBe(true)
    fail = 'unknown'
    q<HTMLButtonElement>('[data-whm-repair-preview-action]').click(); await tick()
    q<HTMLButtonElement>('[data-whm-repair-start]').click(); await tick()
    expect(q('[data-whm-repair-status]').dataset.state).toBe('uncertain')
    expect(q('[data-whm-repair-status]').getAttribute('role')).toBe('alert')
    expect(q('[data-whm-repair-job]').hidden).toBe(true)
  })

  it('renders Arabic findings with the catalog translation of the agent cause', async () => {
    mount('ar')
    boot(async () => report())
    q<HTMLButtonElement>('[data-whm-repair-diagnose]').click(); await tick()
    expect(q('[data-whm-repair-diagnostic="configuration-drift"]').textContent).toContain('لا يوجد جيل إعدادات نشط، لذا لا يوجد ما تُقارَن به الملفات.')
    expect(q('[data-whm-repair-diagnostic="configuration-drift"]').textContent).not.toContain('repair-center')
    expect(q('[data-whm-repair-diagnostic="apt-broken-dependencies"]').textContent).toContain('توجد حزم مثبتة باعتماديات غير مستوفاة. ستفشل عمليات تثبيت الحزم وتحديثها حتى تُصحَّح.')
    expect(q('[data-whm-repair-diagnostic="apt-broken-dependencies"] .xp-badge').textContent).toBe('توجد مشكلة')
    expect(q('[data-whm-repair-diagnostic="service-config:nginx"] h3').textContent).toBe('اختبار إعدادات الخدمة nginx')
  })
})


describe('full timestamp display additional repair diagnostics', () => {
  it.each(['en', 'ar'] as const)('formats diagnostic observation without changing raw evidence or revision in %s', async locale => {
    mount(locale)
    const raw = { ...report(), observedAt: '2026-10-27T10:00:08.345Z' }
    raw.diagnostics[0]!.evidence = 'raw diagnostic timestamp=2026-10-27T09:59:09.123Z'
    const before = JSON.stringify(raw), send = vi.fn<Transport>(async () => raw)
    boot(send); q<HTMLButtonElement>('[data-whm-repair-diagnose]').click(); await tick()
    expect(q('[data-whm-repair-observed-at]').textContent).toBe('2026-10-27 10:00 UTC')
    expect(q('[data-whm-repair-observed-at]').getAttribute('dir')).toBe('ltr')
    expect(q('[data-whm-repair-diagnostic="dpkg-interrupted"] pre').textContent).toBe('raw diagnostic timestamp=2026-10-27T09:59:09.123Z')
    expect(readRepairReport(raw).revision).toBe(revision)
    expect(readRepairReport(raw).observedAt).toBe('2026-10-27T10:00:08.345Z')
    expect(send).toHaveBeenCalledWith('GET', '/api/server/repair/diagnostics')
    expect(JSON.stringify(raw)).toBe(before)
  })
})

describe('RPM database rebuild client contract', () => {
  const rpm = (family: 'rhel' | 'debian' = 'rhel', id = 'rpm-database-integrity') => ({ observedAt: '2026-10-27T10:00:00.000Z', family, revision: 'a'.repeat(64), diagnostics: [{ id, area: 'packages', state: 'problem', cause: 'The RPM database failed its integrity check while its installed package list is still readable. A rebuild runs after a verified snapshot and is restored unless the same packages remain installed.', evidence: '$ /usr/bin/rpmdb --verifydb', repair: { id: 'rpmdb-rebuild', kind: 'job', available: true } }] })
  it('accepts the rebuild only for the RHEL integrity diagnostic and its empty rpm-database preview', () => {
    expect(readRepairReport(rpm()).diagnostics[0]!.repair).toEqual({ id: 'rpmdb-rebuild', kind: 'job', available: true })
    expect(() => readRepairReport(rpm('debian'))).toThrow()
    expect(() => readRepairReport(rpm('rhel', 'dnf-package-problems'))).toThrow()
    const preview = (change: Record<string, unknown> = {}) => ({ revision: 'a'.repeat(64), preview: { repairId: 'rpmdb-rebuild', source: 'rpm-database', state: 'ready', install: [], remove: [], configure: [], counts: { install: 0, remove: 0, configure: 0 }, removalFingerprint: 'b'.repeat(64), evidence: '', ...change } })
    expect(readRepairPreview(preview(), 'a'.repeat(64), 'rpmdb-rebuild').source).toBe('rpm-database')
    expect(() => readRepairPreview(preview({ source: 'dnf-cache-only' }), 'a'.repeat(64), 'rpmdb-rebuild')).toThrow()
    expect(() => readRepairPreview(preview({ remove: ['bash'], counts: { install: 0, remove: 1, configure: 0 } }), 'a'.repeat(64), 'rpmdb-rebuild')).toThrow()
    expect(() => readRepairPreview({ ...preview(), preview: { ...preview().preview, repairId: 'apt-fix-broken' } }, 'a'.repeat(64), 'apt-fix-broken')).toThrow()
  })
})
