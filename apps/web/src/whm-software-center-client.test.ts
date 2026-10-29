// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmModuleInstallers, renderWhmRuntimes, renderWhmSoftwareCatalog } from './board-port/whm-software-center-workspace.ts'
import { parseSoftwareCenterResponse, WHM_SOFTWARE_CENTER_CLIENT_BINDING } from './whm-software-center-client.ts'
import { previewComponentChange, readSoftwareCenter } from '../../agent/src/software-center.ts'
import type { SoftwareCenterRun } from '../../agent/src/software-center.ts'
import { softwareCenterView } from '../../agent/src/software-center-routes.ts'

const installed: Record<string, string> = { nginx: '1.24.0', 'php8.3-cli': '8.3.6', 'php8.3-fpm': '8.3.6', git: '1:2.43.0', 'libdbi-perl': '1.643', 'libclass-dbi-perl': '3.0.17' }
const simulations: Record<string, string> = {
  'install memcached': 'Inst memcached (1.6.24 Ubuntu:24.04/noble [amd64])\nConf memcached (1.6.24 Ubuntu:24.04/noble [amd64])\n',
  'remove libdbi-perl': 'Remv libclass-dbi-perl [3.0.17]\nRemv libdbi-perl [1.643]\n',
}
const run: SoftwareCenterRun = async argv => {
  const names = argv.slice(argv.indexOf('--') + 1)
  if (argv[0] === '/usr/bin/dpkg-query') return { ok: true, code: 0, stderr: '', stdout: Object.entries(installed).map(([name, version]) => `${name}\t${version}\tinstall ok installed`).join('\n') + '\n' }
  if (argv[0] === '/usr/bin/apt-cache') return { ok: true, code: 0, stderr: '', stdout: names.map(name => `${name}:\n  Installed: (none)\n  Candidate: ${name === 'ffmpeg' ? '(none)' : '1.0-1'}\n`).join('') }
  return { ok: true, code: 0, stderr: '', stdout: simulations[(argv.includes('install') ? 'install ' : 'remove ') + names.join(' ')] ?? '' }
}
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const observe = () => readSoftwareCenter({ family: 'debian', run, now: () => new Date('2026-10-27T10:00:00.000Z') })
const view = async (page: 'catalog' | 'module' | 'runtime', manage = true) => roundTrip(softwareCenterView(await observe(), page, manage))
const preview = async (action: 'install' | 'remove', id: string) => { const observed = await observe(); return roundTrip({ preview: await previewComponentChange({ action, componentIds: [id], family: 'debian', run, observed }) }) }
const tick = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const mount = (html: string, request?: Send, ask: ((options: Record<string, unknown>) => Promise<unknown>) | undefined = async () => true, locale: 'en' | 'ar' = 'en') => {
  // The client translator follows the document language, as it does in a page.
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = `<section data-whm-detail-route="/whm/software" data-capability-state="authorized">${html}</section>`
  const target = window as Window & { xpanelSessionRequest?: unknown }
  if (request) target.xpanelSessionRequest = request; else delete target.xpanelSessionRequest
  new Function('return ' + WHM_SOFTWARE_CENTER_CLIENT_BINDING)()(ask)
}
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const status = () => $<HTMLElement>('[data-sc-status]').dataset.state
const button = (id: string, action: string) => $<HTMLButtonElement>(`tr[data-sc-component="${id}"] [data-sc-action="${action}"]`)
beforeEach(() => { document.body.innerHTML = '' })
afterEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('software center response parsers', () => {
  it('accept the actual agent projections for all three pages, previews and jobs', async () => {
    for (const page of ['catalog', 'module', 'runtime'] as const) expect(parseSoftwareCenterResponse('view', await view(page)).components.length).toBeGreaterThan(0)
    expect(parseSoftwareCenterResponse('preview', await preview('install', 'memcached')).preview.state).toBe('ready')
    expect(parseSoftwareCenterResponse('preview', await preview('remove', 'perl-dbi')).preview.extraRemovals).toEqual(['libclass-dbi-perl'])
    expect(parseSoftwareCenterResponse('job', { job: { id: 'job-1', kind: 'software.component.install', status: 'queued', extra: 'ignored' } })).toEqual({ job: { id: 'job-1', kind: 'software.component.install', status: 'queued' } })
  })
  it('reject unsafe, inconsistent or synthetic observations', async () => {
    const base = await view('catalog')
    const mutate = (change: (value: any) => void) => { const copy = roundTrip(base) as any; change(copy); return () => parseSoftwareCenterResponse('view', copy) }
    expect(mutate(value => { value.components[0].name = '<img src=x>' })).toThrow()
    expect(mutate(value => { value.components[0].installed = [{ name: 'nginx', versions: ['1.0'] }] })).toThrow()
    expect(mutate(value => { value.components[0].state = 'running' })).toThrow()
    expect(mutate(value => { value.components[0].description = { en: 'Cache', ar: 'Cache' } })).toThrow()
    expect(mutate(value => { value.components[0].page = 'module' })).toThrow()
    expect(mutate(value => { value.state = 'unavailable'; value.revision = null })).toThrow()
    expect(mutate(value => { value.revision = 'abc' })).toThrow()
    expect(mutate(value => { value.components.push(value.components[0]) })).toThrow()
    const extra = await preview('remove', 'perl-dbi') as any
    extra.preview.extraRemovalsFingerprint = null
    expect(() => parseSoftwareCenterResponse('preview', extra)).toThrow()
    const refused = await preview('install', 'git') as any
    expect(parseSoftwareCenterResponse('preview', refused).preview.reason).toBe('nothing-to-do')
    refused.preview.reason = null
    expect(() => parseSoftwareCenterResponse('preview', refused)).toThrow()
    expect(() => parseSoftwareCenterResponse('job', { job: { id: 'job 1', kind: 'software.component.install', status: 'queued' } })).toThrow()
    expect(() => parseSoftwareCenterResponse('job', { job: { id: 'job-1', kind: 'system.packages.upgrade', status: 'queued' } })).toThrow()
  })
})

describe('software center client binding', () => {

  it.each([
    { page: 'catalog', locale: 'en' }, { page: 'catalog', locale: 'ar' },
    { page: 'module', locale: 'en' }, { page: 'module', locale: 'ar' },
    { page: 'runtime', locale: 'en' }, { page: 'runtime', locale: 'ar' },
  ] as const)('renders readable datetime metadata for software center without changing its snapshot ($page/$locale)', async ({ page, locale }) => {
    const stamp = locale === 'en' ? '2026-10-27T12:34:56.123Z' : '2026-10-27T12:34:56.000Z'
    const expected = locale === 'en' ? '2026-10-27 12:34 UTC' : '2026-10-27 12:34 UTC'
    const observed = { ...await view(page, false), observedAt: stamp }
    const send = vi.fn(async () => observed)
    const render = page === 'catalog' ? renderWhmSoftwareCatalog : page === 'module' ? renderWhmModuleInstallers : renderWhmRuntimes
    mount(render({ locale, canRead: true, canManage: false }), send, async () => false, locale)
    await tick()
    const shown = $<HTMLElement>('[data-sc-observed-at]')
    expect(shown.textContent).toBe(expected)
    expect(shown.tagName).toBe('BDI'); expect(shown.dir).toBe('ltr')
    expect(parseSoftwareCenterResponse('view', observed).observedAt).toBe(stamp)
    expect(parseSoftwareCenterResponse('view', observed).revision).toBe(observed.revision)
    expect(send.mock.calls).toEqual([['GET', '/api/server/software-center?page=' + page]])
    expect(status()).toBe('read')
    expect([...document.querySelectorAll<HTMLButtonElement>('[data-sc-action]')].every(control => control.disabled)).toBe(true)
  })

  it('makes no request without transport or read admission', async () => {
    mount(renderWhmSoftwareCatalog({ locale: 'en', canRead: true, canManage: true }))
    expect(status()).toBe('unavailable')
    const send = vi.fn()
    mount(renderWhmSoftwareCatalog({ locale: 'en', canRead: false, canManage: true }), send)
    await tick()
    expect(send).not.toHaveBeenCalled()
    expect(status()).toBe('unavailable')
  })
  it('renders observed rows grouped by category with state-driven actions and filters', async () => {
    const send = vi.fn(async (_method: string, path: string) => view(new URL(path, 'http://x').searchParams.get('page') as 'catalog'))
    mount(renderWhmSoftwareCatalog({ locale: 'en', canRead: true, canManage: true }), send)
    await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/software-center?page=catalog')
    expect(status()).toBe('read')
    expect($('[data-sc-family]').textContent).toBe('dpkg / apt')
    expect([...document.querySelectorAll<HTMLElement>('[data-sc-group]')].map(group => group.dataset.scGroup)).toEqual(['cache', 'media', 'security', 'developer', 'utilities'])
    expect($('[data-sc-group="media"] h3').textContent).toBe('Media')
    expect(button('memcached', 'install').disabled).toBe(false)
    expect(button('memcached', 'remove').disabled).toBe(true)
    expect(button('git', 'install').disabled).toBe(true)
    expect(button('git', 'remove').disabled).toBe(false)
    expect($('tr[data-sc-component="git"]').textContent).toContain('1:2.43.0')
    expect($('tr[data-sc-component="ffmpeg"]').textContent).toContain('not in repositories')
    expect($('tr[data-sc-component="memcached"]').textContent).toContain('memcached.service')
    expect($('tr[data-sc-component="memcached"] bdi').getAttribute('dir')).toBe('ltr')
    const category = $<HTMLSelectElement>('[data-sc-category]')
    category.value = 'media'; category.dispatchEvent(new Event('change'))
    expect($<HTMLElement>('[data-sc-group="cache"]').hidden).toBe(true)
    expect($<HTMLElement>('[data-sc-group="media"]').hidden).toBe(false)
    category.value = ''; category.dispatchEvent(new Event('change'))
    const search = $<HTMLInputElement>('[data-sc-search]')
    search.value = 'version control'; search.dispatchEvent(new Event('input'))
    expect([...document.querySelectorAll<HTMLTableRowElement>('tr[data-sc-component]')].filter(row => !row.hidden).map(row => row.dataset.scComponent)).toEqual(['git'])
    search.value = 'zzz-none'; search.dispatchEvent(new Event('input'))
    expect($<HTMLElement>('[data-sc-no-match]').hidden).toBe(false)
  })
  it('previews, confirms and submits a reviewed install, then links the job and locks', async () => {
    const ask = vi.fn(async () => true)
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET') return view('catalog')
      if (path.endsWith('/preview')) return preview('install', 'memcached')
      return { job: { id: 'job-7', kind: 'software.component.install', status: 'queued' } }
    })
    mount(renderWhmSoftwareCatalog({ locale: 'en', canRead: true, canManage: true }), send, ask)
    await tick()
    button('memcached', 'install').click(); await tick()
    const revision = (await view('catalog')).revision
    expect(send).toHaveBeenCalledWith('POST', '/api/server/software-center/preview', { action: 'install', componentIds: ['memcached'], expectedRevision: revision })
    expect($<HTMLElement>('[data-sc-preview]').hidden).toBe(false)
    expect($('[data-sc-preview-install]').textContent).toContain('memcached 1.6.24')
    expect($('[data-sc-preview-memory]').textContent).toBe('64 MB')
    expect($<HTMLElement>('[data-sc-preview-extra]').hidden).toBe(true)
    expect($<HTMLButtonElement>('[data-sc-confirm]').disabled).toBe(false)
    $<HTMLButtonElement>('[data-sc-confirm]').click(); await tick()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/software-center/apply', { action: 'install', componentIds: ['memcached'], expectedRevision: revision })
    expect($<HTMLElement>('[data-sc-job]').hidden).toBe(false)
    expect($<HTMLAnchorElement>('[data-sc-job-link]').getAttribute('href')).toBe('/whm/jobs?job=job-7')
    expect(status()).toBe('submitted')
    expect(button('memcached', 'install').disabled).toBe(true)
    expect(button('git', 'remove').disabled).toBe(true)
  })
  it('requires explicit review of extra removals and sends the reviewed fingerprint', async () => {
    const reviewed = await preview('remove', 'perl-dbi') as { preview: { extraRemovalsFingerprint: string } }
    const send = vi.fn(async (method: string, path: string, _body?: unknown) => method === 'GET' ? view('module') : path.endsWith('/preview') ? reviewed : { job: { id: 'job-8', kind: 'software.component.remove', status: 'queued' } })
    mount(renderWhmModuleInstallers({ locale: 'en', canRead: true, canManage: true }), send)
    await tick()
    expect([...document.querySelectorAll<HTMLElement>('[data-sc-group]')].map(group => group.dataset.scGroup)).toEqual(['perl', 'php-8.3'])
    expect($('[data-sc-group="php-8.3"] h3').textContent).toBe('PHP 8.3')
    expect($('[data-sc-php-versions]').textContent).toBe('8.3')
    button('perl-dbi', 'remove').click(); await tick()
    expect($<HTMLElement>('[data-sc-preview-extra]').hidden).toBe(false)
    expect($('[data-sc-preview-extra-list]').textContent).toContain('libclass-dbi-perl')
    expect($<HTMLButtonElement>('[data-sc-confirm]').disabled).toBe(true)
    const accept = $<HTMLInputElement>('[data-sc-accept-extra]')
    accept.checked = true; accept.dispatchEvent(new Event('change'))
    expect($<HTMLButtonElement>('[data-sc-confirm]').disabled).toBe(false)
    $<HTMLButtonElement>('[data-sc-confirm]').click(); await tick()
    expect(send.mock.calls.at(-1)![2]).toMatchObject({ action: 'remove', componentIds: ['perl-dbi'], acceptExtraRemovals: reviewed.preview.extraRemovalsFingerprint })
  })
  it('shows refused and unverifiable previews truthfully without enabling submission', async () => {
    const send = vi.fn(async (method: string, _path: string, body?: unknown) => { const input = body as { action: 'install' | 'remove'; componentIds: string[] }; return method === 'GET' ? view('runtime') : preview(input.action, input.componentIds[0]!) })
    mount(renderWhmRuntimes({ locale: 'en', canRead: true, canManage: true }), send)
    await tick()
    expect([...document.querySelectorAll<HTMLElement>('[data-sc-group]')].map(group => group.dataset.scGroup)).toEqual(['nodejs', 'python', 'go', 'java'])
    button('golang', 'install').click(); await tick()
    expect($('[data-sc-preview-summary]').textContent).toContain('could not be verified')
    expect($<HTMLButtonElement>('[data-sc-confirm]').disabled).toBe(true)
    expect(status()).toBe('failed')
    $<HTMLButtonElement>('[data-sc-cancel]').click()
    expect($<HTMLElement>('[data-sc-preview]').hidden).toBe(true)
  })
  it('locks after an unknown apply outcome and keeps actions disabled without a job runner', async () => {
    const send = vi.fn(async (method: string, path: string) => { if (method === 'GET') return view('catalog'); if (path.endsWith('/preview')) return preview('install', 'memcached'); throw new Error('network') })
    mount(renderWhmSoftwareCatalog({ locale: 'en', canRead: true, canManage: true }), send)
    await tick()
    button('memcached', 'install').click(); await tick()
    $<HTMLButtonElement>('[data-sc-confirm]').click(); await tick()
    expect(status()).toBe('uncertain')
    expect($<HTMLElement>('[data-sc-status]').getAttribute('role')).toBe('alert')
    expect(button('memcached', 'install').disabled).toBe(true)
    mount(renderWhmSoftwareCatalog({ locale: 'en', canRead: true, canManage: true }), vi.fn(async () => view('catalog', false)))
    await tick()
    expect($('[data-sc-status]').textContent).toContain('host job runner is not connected')
    expect(button('memcached', 'install').disabled).toBe(true)
  })
  it('renders Arabic status and labels with LTR technical values', async () => {
    mount(renderWhmSoftwareCatalog({ locale: 'ar', canRead: true, canManage: true }), vi.fn(async () => view('catalog')), async () => true, 'ar')
    await tick()
    expect($('[data-whm-software-center]').getAttribute('dir')).toBe('rtl')
    expect($('[data-sc-status]').textContent).toMatch(/[؀-ۿ]/)
    expect($('[data-sc-group="media"] h3').textContent).toBe('الوسائط')
    expect(button('memcached', 'install').textContent).toBe('تثبيت')
    expect($('tr[data-sc-component="memcached"]').textContent).toContain('خادم تخزين مؤقت في الذاكرة لجلسات التطبيقات وكائناتها.')
    expect($('tr[data-sc-component="memcached"]').textContent).toContain('يوفر: memcached.service')
    expect($('tr[data-sc-component="memcached"]').textContent).toMatch(/تقدير: الذاكرة \d+ MB · القرص \d+ MB/)
    expect($('tr[data-sc-component="ffmpeg"]').textContent).toContain('ffmpeg غير موجود في المستودعات')
    expect($('tr[data-sc-component="memcached"]').textContent).not.toMatch(/[٠-٩۰-۹]/)
    expect(WHM_SOFTWARE_CENTER_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_SOFTWARE_CENTER_CLIENT_BINDING).not.toContain('fetch(')
  })
})
