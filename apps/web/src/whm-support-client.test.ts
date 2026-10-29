// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmSupportWorkspace } from './board-port/whm-support-workspace.ts'
import { readSupportView, WHM_SUPPORT_CLIENT_BINDING } from './whm-support-client.ts'
import { SUPPORT_BUNDLE_EXCLUDED, SUPPORT_BUNDLE_SECTIONS, SUPPORT_LIMITS } from '../../agent/src/support-bundle.ts'
import { SUPPORT_HASH_RULE, SUPPORT_REDACTION_RULES } from '../../agent/src/support-bundle-redaction.ts'

const tick = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const at = '2026-10-27T10:00:00.000Z'
const RLO = String.fromCharCode(0x202e)
// Real manifest messages from the agent; the id is a fixture value.
const manifest = () => ({
  id: '0123456789abcdef', schemaVersion: 1, format: 'application/json',
  sections: SUPPORT_BUNDLE_SECTIONS.filter(entry => entry.id === 'versions' || entry.id === 'journal'),
  excluded: SUPPORT_BUNDLE_EXCLUDED.filter(entry => entry.id === 'secrets'),
  redaction: SUPPORT_REDACTION_RULES.filter(rule => rule.id === 'email-address'),
  hashing: SUPPORT_HASH_RULE, limits: SUPPORT_LIMITS,
})
const summary = () => ({
  observedAt: at, host: 'read',
  versions: { panel: { state: 'read', version: '1.4.2', releasePath: '/opt/xpanel/releases/1.4.2' }, node: 'v26.12.1' },
  os: { profile: { id: 'ubuntu', versionId: '24.04', family: 'debian' }, release: { state: 'read', id: 'ubuntu', versionId: '24.04', prettyName: 'Ubuntu 24.04.1 LTS' } },
  uptime: { state: 'read', seconds: 93784 },
  services: { state: 'read', items: [{ id: 'nginx', label: 'nginx', unit: 'nginx.service', state: 'active' }, { id: 'postfix', label: 'Postfix', unit: 'postfix.service', state: 'failed' }] },
  generation: { state: 'read', id: 7, status: 'active', createdAt: at, testedAt: null, activatedAt: at, checksum: 'a'.repeat(64) },
  drift: { state: 'read', generationId: 7, manifestMissing: false, count: 2, byReason: { missing: 2 } },
  failedJobs: { state: 'read', items: [{ id: 'job-1', referenceCode: 'XP-JOB-2026-000123', kind: 'system-updates.apply', failureClass: 'permanent', createdAt: at, startedAt: at, finishedAt: at, error: 'step apt exited 100', steps: [] }] },
})
const view = (overrides: Record<string, unknown> = {}) => ({ summary: summary(), manifest: manifest(), contact: { state: 'not-configured' }, ...overrides })
const mount = (locale: 'en' | 'ar' = 'en', canRead = true, wrapper = 'data-capability-state="authorized"') => {
  // The client translator follows the document language, as it does in a page.
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = `<section ${wrapper}>${renderWhmSupportWorkspace({ locale, canRead })}</section>`
}
const boot = (request?: (method: string, path: string) => Promise<unknown>) => {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + WHM_SUPPORT_CLIENT_BINDING)()()
}
const q = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
const fact = (key: string) => q(`[data-whm-support-fact="${key}"]`).textContent
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
afterEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('support client parser', () => {
  it('accepts the projected view and drops unknown fields', () => {
    expect(JSON.stringify(readSupportView({ ...view(), extra: 'x' }))).not.toContain('extra')
    expect(readSupportView(view()).summary!.failedJobs.items[0]!.referenceCode).toBe('XP-JOB-2026-000123')
    for (const referenceCode of [undefined, '22222222-2222-4222-8222-222222222222', 'XP-JOB-000000', 'bad\u202eref']) expect(() => readSupportView(view({ summary: { ...summary(), failedJobs: { state: 'read', items: [{ ...summary().failedJobs.items[0], referenceCode }] } } }))).toThrow()
    expect(readSupportView(view({ summary: null })).summary).toBeNull()
    expect(readSupportView(view({ contact: { state: 'unavailable' } })).contact).toEqual({ state: 'unavailable' })
    expect(readSupportView(view({ contact: { state: 'configured', url: 'https://help.provider.test', email: null } })).contact).toEqual({ state: 'configured', url: 'https://help.provider.test', email: null })
  })
  it('refuses unsafe text, read states without values, bad manifests and invented contacts', () => {
    const s = summary()
    for (const bad of [
      view({ summary: { ...s, versions: { ...s.versions, panel: { state: 'read', version: null, releasePath: null } } } }),
      view({ summary: { ...s, os: { ...s.os, release: { state: 'read', prettyName: 'Ubuntu' + RLO } } } }),
      view({ manifest: { ...manifest(), id: 'not-hex' } }),
      view({ manifest: { ...manifest(), sections: [] } }),
      view({ manifest: { ...manifest(), sections: [{ id: 'versions', en: 'Panel release', ar: 'Panel release' }] } }),
      view({ manifest: { ...manifest(), hashing: { en: 'Keyed hash', ar: 'Keyed hash' } } }),
      view({ manifest: { ...manifest(), limits: { journalLines: 500 } } }),
      view({ contact: { state: 'configured', url: 'javascript:alert(1)', email: null } }),
      view({ contact: { state: 'configured', url: null, email: null } }),
      view({ contact: { state: 'not-configured', email: 'a@b.test' } }),
    ]) expect(() => readSupportView(bad)).toThrow()
  })
})

describe('support client binding', () => {
  it('paints observed facts, services, jobs, the manifest and the unconfigured contact', async () => {
    mount()
    const request = vi.fn(async () => view())
    boot(request)
    await tick()
    expect(request).toHaveBeenCalledWith('GET', '/api/server/support')
    expect(fact('panel-version')).toBe('1.4.2')
    expect(q('[data-whm-support-fact="panel-version"] bdi').getAttribute('dir')).toBe('ltr')
    expect(fact('os')).toBe('Ubuntu 24.04.1 LTS')
    expect(fact('os-profile')).toBe('ubuntu 24.04 (debian)')
    expect(fact('uptime')).toBe('1 d 2 h 3 min')
    expect(fact('generation')).toBe('#7')
    expect(fact('drift')).toBe('2 managed files differ')
    expect(q('[data-whm-support-services]').textContent).toContain('Failed')
    expect(q('[data-whm-support-jobs]').textContent).toContain('step apt exited 100')
    expect(q('[data-whm-support-jobs]').textContent).toContain('XP-JOB-2026-000123')
    expect(q('[data-whm-support-jobs]').textContent).not.toContain('job-1')
    expect([...document.querySelectorAll('[data-whm-support-included] li')].map(item => item.textContent)).toEqual([
      'Panel release named by /opt/xpanel/current and confirmed by its VERSION marker; the agent Node.js runtime version.',
      'Up to the last 500 journal entries of each of xpanel-agent.service and xpanel-api.service: time, priority, pid and the redacted message, newest first, at most 384 KiB per unit after redaction.',
    ])
    expect(q('[data-whm-support-hashing]').textContent).toBe(SUPPORT_HASH_RULE.text)
    expect(q('[data-whm-support-contact]').textContent).toContain('No support contact is configured')
    expect(q<HTMLElement>('[data-whm-support-status]').dataset.state).toBe('read')
  })

  it('requires the confirmation before downloading the bundle bound to the shown manifest id', async () => {
    mount()
    const bundle = { manifest: manifest(), generatedAt: at, versions: {} }
    const request = vi.fn(async (_method: string, path: string) => path === '/api/server/support' ? view() : bundle)
    const created: { download: string; href: string }[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { created.push({ download: this.download, href: this.href }) })
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:support'), revokeObjectURL: vi.fn() })
    boot(request)
    await tick()
    const confirm = q<HTMLInputElement>('[data-whm-support-confirm]'), download = q<HTMLButtonElement>('[data-whm-support-download]')
    expect(confirm.disabled).toBe(false)
    expect(download.disabled).toBe(true)
    download.click(); await tick()
    expect(request).toHaveBeenCalledTimes(1)
    confirm.checked = true; confirm.dispatchEvent(new Event('change'))
    expect(download.disabled).toBe(false)
    download.click(); await tick()
    expect(request).toHaveBeenLastCalledWith('GET', '/api/server/support/bundle?manifest=0123456789abcdef')
    expect(created).toEqual([{ download: 'xpanel-support-20261027T100000Z.json', href: 'blob:support' }])
    expect(q<HTMLElement>('[data-whm-support-bundle-status]').dataset.state).toBe('read')
    expect(confirm.checked).toBe(false)
    expect(download.disabled).toBe(true)
    click.mockRestore()
  })

  it('refuses a bundle for another manifest and re-reads the manifest after a 409', async () => {
    mount()
    let calls = 0
    const request = vi.fn(async (_method: string, path: string) => {
      if (path === '/api/server/support') return view()
      calls++
      if (calls === 1) return { manifest: { id: 'ffffffffffffffff' }, generatedAt: at }
      throw Object.assign(new Error('changed'), { status: 409 })
    })
    boot(request)
    await tick()
    const confirm = q<HTMLInputElement>('[data-whm-support-confirm]'), download = q<HTMLButtonElement>('[data-whm-support-download]')
    confirm.checked = true; confirm.dispatchEvent(new Event('change')); download.click(); await tick()
    expect(q<HTMLElement>('[data-whm-support-bundle-status]').dataset.state).toBe('failed')
    confirm.checked = true; confirm.dispatchEvent(new Event('change')); download.click(); await tick()
    expect(request.mock.calls.filter(([, path]) => path === '/api/server/support')).toHaveLength(2)
  })

  it('shows a configured contact as links and keeps the bundle off without an agent', async () => {
    mount('ar')
    boot(vi.fn(async () => view({ summary: null, contact: { state: 'configured', url: 'https://help.provider.test', email: 'help@provider.test' } })))
    await tick()
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-whm-support-contact] a')].map(link => link.getAttribute('href'))
    expect(links).toEqual(['https://help.provider.test', 'mailto:help@provider.test'])
    expect(q('[data-whm-support-contact]').textContent).toContain('موقع الدعم')
    expect(q<HTMLInputElement>('[data-whm-support-confirm]').disabled).toBe(true)
    expect(q<HTMLButtonElement>('[data-whm-support-download]').disabled).toBe(true)
    expect(q<HTMLElement>('[data-whm-support-status]').dataset.state).toBe('unavailable')
    expect(fact('panel-version')).toBe('غير مقروء')
    // The manifest stays readable without the agent; its messages and limit values render in Arabic.
    expect(q('[data-whm-support-included]').textContent).toContain('حتى آخر 500 إدخال من اليومية')
    expect(q('[data-whm-support-excluded]').textContent).toBe('المفاتيح والشهادات والرموز وكلمات المرور ومجلد .secrets.')
    expect(q('[data-whm-support-hashing]').textContent).toMatch(/^التجزئة هي أول 12 رقمًا/)
  })

  it('reports a failed or invalid read and stays inert on an unavailable page', async () => {
    mount()
    boot(vi.fn(async () => { throw Object.assign(new Error('denied'), { status: 403 }) }))
    await tick()
    expect(q('[data-whm-support-status]').textContent).toContain('Root authorization')
    mount()
    boot(vi.fn(async () => ({ summary: 'x' })))
    await tick()
    expect(q<HTMLElement>('[data-whm-support-status]').dataset.state).toBe('failed')
    mount('en', true, 'data-capability-state="unavailable"')
    const request = vi.fn(async () => view())
    boot(request)
    await tick()
    expect(request).not.toHaveBeenCalled()
    expect(q<HTMLButtonElement>('[data-whm-support-refresh]').disabled).toBe(true)
    expect(q<HTMLElement>('[data-whm-support-status]').dataset.state).toBe('unavailable')
  })
})


describe('readable metadata datetime - support', () => {
  it.each(['en', 'ar'] as const)('renders precise readonly metadata in %s without rewriting raw records or log text', async locale => {
    const machineLog = 'unchanged log event at 2026-10-27T10:01:02.123Z'
    const current = summary()
    current.observedAt = '2026-10-27T10:00:00.123456Z'
    current.generation.activatedAt = '2026-10-27T09:00:00.000Z'
    current.failedJobs.items[0]!.finishedAt = '2026-10-27T10:01:02.123Z'
    current.failedJobs.items[0]!.error = machineLog
    const raw = view({ summary: current }), before = JSON.stringify(raw)
    const request = vi.fn(async (_method: string, _path: string) => raw)
    mount(locale); boot(request); await tick()
    expect(fact('observed-at')).toBe('2026-10-27 10:00 UTC')
    expect(fact('generation-activated')).toBe('2026-10-27 09:00 UTC')
    expect(q('[data-whm-support-jobs] tr td:nth-child(4) bdi[dir="ltr"]').textContent).toBe('2026-10-27 10:01 UTC')
    expect(q('[data-whm-support-fact="observed-at"] bdi').getAttribute('dir')).toBe('ltr')
    expect(q('[data-whm-support-jobs]').textContent).toContain(machineLog)
    expect(q('[data-whm-support-jobs]').textContent).toContain('XP-JOB-2026-000123')
    expect(q('[data-whm-support-jobs]').textContent).not.toContain('job-1')
    expect(fact('uptime')).toBe(locale === 'ar' ? '1 يوم 2 ساعة 3 دقيقة' : '1 d 2 h 3 min')
    expect(fact('drift')).toBe(locale === 'ar' ? '2 من الملفات المُدارة مختلفة' : '2 managed files differ')
    expect(request.mock.calls).toEqual([['GET', '/api/server/support']])
    const parsed = readSupportView(raw).summary!
    expect(parsed.observedAt).toBe('2026-10-27T10:00:00.123456Z')
    expect(parsed.generation.activatedAt).toBe('2026-10-27T09:00:00.000Z')
    expect(parsed.failedJobs.items[0]!.finishedAt).toBe('2026-10-27T10:01:02.123Z')
    expect(JSON.stringify(raw)).toBe(before)
  })
  it.each(['en', 'ar'] as const)('keeps missing metadata and explicit zero fractions distinct in %s', async locale => {
    const current = { ...summary(), generation: { ...summary().generation, activatedAt: null }, failedJobs: { state: 'read', items: [{ ...summary().failedJobs.items[0]!, finishedAt: null }] } }
    const request = vi.fn(async (_method: string, _path: string) => view({ summary: current }))
    mount(locale); boot(request); await tick()
    expect(fact('observed-at')).toBe('2026-10-27 10:00 UTC')
    expect(fact('generation-activated')).toBe(locale === 'ar' ? 'غير مقروء' : 'Not read')
    expect(q('[data-whm-support-jobs] tr td:nth-child(4)').textContent).toBe('-')
    expect(request.mock.calls).toEqual([['GET', '/api/server/support']])
    expect(readSupportView(view({ summary: current })).summary!.failedJobs.items[0]!.finishedAt).toBeNull()
  })
})
