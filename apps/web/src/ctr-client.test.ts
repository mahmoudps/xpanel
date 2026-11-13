// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSwContainerEngineWorkspace, renderSwContainersWorkspace } from './board-port/sw-containers-workspace.ts'
import { CTR_CLIENT_BINDING } from './ctr-client.ts'
import { renderV2WhmContainers } from './themes/v2/pages/xwhm/software/containers.ts'

const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const id = 'a'.repeat(64), revision = 'b'.repeat(64)
const accounts = { state: 'read', reason: null, observedAt: '2026-11-07T00:00:00.000Z', version: '4.9.3', accounts: [{ username: 'alice', available: true, reason: null, stacks: 1, services: 1, running: 1 }, { username: 'bob', available: false, reason: 'no-subordinate-ids', stacks: 0, services: 0, running: 0 }] }
const policy = { revision, catalog: { source: 'signed', sequence: 7, expiresAt: '2026-12-01T00:00:00.000Z', reason: null }, feedUrl: 'https://updates.example.com/apps.json', configPath: '/etc/containers/registries.conf.d/90-xpanel.conf', stackPath: '~/containers/<stack>', registries: [{ host: 'docker.io', namespace: null, mirror: null }], templates: [{ name: 'web', description: 'One service', yaml: 'services: {}', env: 'A=' }], apps: [{ id: 'adminer', name: 'Adminer', description: 'Database manager in a single page.', version: '4', port: 8080 }] }
const host = { scope: 'host', account: null, state: 'read', reason: null, observedAt: '2026-11-07T00:00:00.000Z', revision, version: '4.9.3', stats: [], images: [], networks: [], volumes: [], stacks: [], logins: [], actions: { write: false, jobs: false } }
const scope = { ...host, scope: 'account', account: 'alice', actions: { write: true, jobs: true }, stats: [{ name: 'shop-web', engine: 'podman', state: 'running', cpu: '1.00%', memory: '5MB / 1GB', network: '1kB / 2kB', id }], images: [{ id, tags: ['docker.io/library/nginx:1.27'], size: '1.0 MB' }], networks: [{ name: 'net', driver: 'bridge', subnets: ['10.9.0.0/24'] }], volumes: [{ name: 'junk', driver: 'local' }], logins: [{ host: 'ghcr.io', username: 'bob' }],
  stacks: [{ name: 'shop', app: null, enabled: true, yaml: 'services: {}', envKeys: ['DB'], notes: '', folder: '/home/alice/containers/shop', networks: [], updatedAt: '2026-11-07T00:00:00.000Z', services: [{ name: 'web', image: 'docker.io/library/nginx:1.27', unit: 'xpanel-ctr-alice-shop-web.service', state: 'running', ports: ['127.0.0.1:8080->80/tcp'], restart: 'always' }] }] }
const detail = { scope: 'account', account: 'alice', id, name: 'shop-web', image: 'docker.io/library/nginx:1.27', state: 'running', startedAt: '2026-11-07T00:00:00Z', exitCode: 0, ips: ['10.0.2.100'], ports: ['127.0.0.1:8080->80/tcp'], networks: ['podman'], restart: 'always', mounts: [], managed: { stack: 'shop', service: 'web', primary: true, restart: 'always' }, logs: ['line one'] }
const boot = (send: (method: string, path: string, body?: unknown) => Promise<unknown>, ask = async () => true) => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + CTR_CLIENT_BINDING)()(ask) }
const api = (over: (method: string, path: string, body?: unknown) => unknown = () => undefined) => vi.fn(async (method: string, path: string, body?: unknown) => {
  const custom = over(method, path, body)
  if (custom !== undefined) return custom
  if (path.endsWith('/accounts')) return accounts
  if (path.endsWith('/policy')) return policy
  if (path.includes('/detail')) return detail
  return path.includes('account=alice') ? scope : host
})
const stream = (text: string) => ({ ok: true, body: new Response(text).body })
const field = <T extends HTMLElement>(key: string): T => document.querySelector<T>(`[data-ctr-field="${key}"]`)!
const pick = async () => { const select = field<HTMLSelectElement>('account'); select.value = 'alice'; select.dispatchEvent(new Event('change')); await tick() }

describe.each([
  ['classic', () => renderSwContainersWorkspace({ locale: 'en', canRead: true, canManage: true }), () => renderSwContainerEngineWorkspace({ locale: 'en', canRead: true, canManage: true })],
  ['v2', () => renderV2WhmContainers({ locale: 'en', dataAuthority: { canRead: true, canManage: true } } as never), () => renderV2WhmContainers({ locale: 'en', dataAuthority: { canRead: true, canManage: true } } as never, true)],
])('rootless workspace on the %s theme', { tags: ['feature'] }, (_name, listPage, enginePage) => {
  beforeEach(() => { document.body.innerHTML = ''; document.body.removeAttribute('data-capability-state'); vi.stubGlobal('fetch', vi.fn(async () => stream('{"line":"live one"}\n{"alive":true}\n{"end":"exit"}\n'))) })
  it('reads accounts, keeps writes off on the host scope and scopes writes to the chosen account', async () => {
    document.body.innerHTML = listPage()
    const send = api(); boot(send); await tick()
    expect(document.querySelector<HTMLButtonElement>('[data-ctr-do="stack-save"]')!.disabled).toBe(true)
    expect(field('total-services').textContent).toBe('1')
    await pick()
    expect(document.querySelector('[data-ctr-rows="stats"]')!.textContent).toContain('shop-web')
    expect(document.querySelector('[data-ctr-rows="stacks"]')!.textContent).toContain('shop')
    field<HTMLInputElement>('stack-name').value = 'new'; field<HTMLTextAreaElement>('stack-yaml').value = 'services: {}'
    document.querySelector<HTMLButtonElement>('[data-ctr-do="stack-save"]')!.click(); await tick()
    expect(send.mock.calls.find(call => call[0] === 'POST')).toEqual(['POST', '/api/server/software/containers/op', { account: 'alice', expectedRevision: revision, action: { op: 'stack.save', name: 'new', yaml: 'services: {}', env: '', notes: '', template: null } }])
  })
  it('opens details, keeps the env of an edited stack and asks before a removal', async () => {
    document.body.innerHTML = listPage()
    const send = api(), ask = vi.fn(async () => false); boot(send, ask); await tick(); await pick()
    document.querySelector<HTMLButtonElement>('[data-ctr-rows="stats"] [data-xp-action="details"]')!.click(); await tick()
    expect(field('detail').hidden).toBe(false)
    await tick()
    expect(field('detail-logs').textContent).toBe('live one')
    expect(String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toBe('/api/server/software/containers/log-stream?account=alice&id=' + id)
    expect(field('logs-state').textContent).toContain('ended')
    expect(field('terminal').hidden).toBe(false)
    const shell = field<HTMLSelectElement>('terminal-shell'); shell.value = 'bash'; shell.dispatchEvent(new Event('change'))
    expect(field<HTMLAnchorElement>('terminal-link').getAttribute('href')).toBe('/whm/server/terminal?account=alice&container=' + id + '&shell=bash&user=image')
    document.querySelector<HTMLButtonElement>('[data-ctr-rows="stacks"] [data-xp-action="edit"]')!.click()
    expect(field<HTMLTextAreaElement>('stack-env').value).toBe('')
    document.querySelector<HTMLButtonElement>('[data-ctr-do="stack-save"]')!.click(); await tick()
    expect((send.mock.calls.find(call => call[0] === 'POST')![2] as { action: { env: unknown } }).action.env).toBeNull()
    document.querySelector<HTMLButtonElement>('[data-ctr-rows="stacks"] [data-xp-action="remove"]')!.click(); await tick()
    expect(ask).toHaveBeenCalled()
    expect(send.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(1)
  })
  it('names a refusal by its stable reason and locks after an unknown outcome', async () => {
    document.body.innerHTML = listPage()
    let failure: unknown = { status: 409, details: { stateChanged: false, reason: 'PORT_IN_USE' } }
    const send = api((method) => { if (method === 'POST') throw failure }); boot(send); await tick(); await pick()
    field<HTMLInputElement>('stack-name').value = 'x'
    document.querySelector<HTMLButtonElement>('[data-ctr-do="stack-save"]')!.click(); await tick()
    expect(field('status').textContent).toContain('host port')
    failure = { status: 503, details: { stateChanged: true } }
    document.querySelector<HTMLButtonElement>('[data-ctr-do="stack-save"]')!.click(); await tick()
    expect(field('status').dataset.state).toBe('uncertain')
    expect(document.querySelector<HTMLButtonElement>('[data-ctr-do="stack-save"]')!.disabled).toBe(true)
  })
  it('drives the engine page: job link, trust policy and login password', async () => {
    document.body.innerHTML = enginePage()
    const send = api((method, path) => method === 'POST' && path.endsWith('/op') ? { job: { id: 'job-1', kind: 'software.container.image.pull' } } : method === 'POST' ? policy : undefined); boot(send); await tick(); await pick()
    expect(field('config-path').textContent).toContain('90-xpanel.conf')
    field<HTMLInputElement>('registry-host').value = 'ghcr.io'; field<HTMLInputElement>('registry-mirror').value = 'mirror.example.com'
    document.querySelector<HTMLButtonElement>('[data-ctr-do="registry-save"]')!.click(); await tick()
    expect(send.mock.calls.find(call => call[1].endsWith('/policy') && call[0] === 'POST')![2]).toEqual({ expectedRevision: revision, policy: { registries: [policy.registries[0], { host: 'ghcr.io', namespace: null, mirror: 'mirror.example.com' }], templates: policy.templates, feedUrl: policy.feedUrl } })
    field<HTMLInputElement>('login-host').value = 'ghcr.io'; field<HTMLInputElement>('login-username').value = 'bob'; field<HTMLInputElement>('login-password').value = 'pw'
    document.querySelector<HTMLButtonElement>('[data-ctr-do="login"]')!.click(); await tick()
    expect(field<HTMLInputElement>('login-password').value).toBe('')
    expect(field('job').hidden).toBe(false); expect(field<HTMLAnchorElement>('job-link').getAttribute('href')).toBe('/whm/jobs?job=job-1')
  })
  it('searches a trusted registry, pushes a row and updates the catalog', async () => {
    document.body.innerHTML = enginePage()
    const send = api((method, path) => path.includes('/search') ? { registry: 'docker.io', results: [{ name: 'docker.io/library/nginx', description: 'Web server', stars: 9, official: true }] } : method === 'POST' && path.endsWith('/op') ? { job: { id: 'job-2', kind: 'software.container.image.push' } } : undefined); boot(send); await tick(); await pick()
    field<HTMLInputElement>('search-term').value = 'nginx'
    document.querySelector<HTMLButtonElement>('[data-ctr-do="search"]')!.click(); await tick()
    expect(send.mock.calls.find(call => call[1].includes('/search'))![1]).toBe('/api/server/software/containers/search?account=alice&registry=docker.io&term=nginx')
    document.querySelector<HTMLButtonElement>('[data-ctr-rows="search"] [data-xp-action="use"]')!.click()
    expect(field<HTMLInputElement>('image').value).toBe('docker.io/library/nginx:latest')
    field<HTMLInputElement>('push-destination').value = 'ghcr.io/acme/app:1'
    document.querySelector<HTMLButtonElement>('[data-ctr-rows="images"] [data-xp-action="push"]')!.click(); await tick()
    expect((send.mock.calls.find(call => call[0] === 'POST')![2] as { action: unknown }).action).toEqual({ op: 'image.push', id, destination: 'ghcr.io/acme/app:1' })
    document.body.innerHTML = listPage()
    const catalog = api((method, path) => method === 'POST' && path.endsWith('/catalog') ? policy : undefined); boot(catalog); await tick()
    expect(field('catalog-source').textContent).toContain('7'); expect(field<HTMLInputElement>('feed-url').value).toBe(policy.feedUrl)
    document.querySelector<HTMLButtonElement>('[data-ctr-do="catalog-update"]')!.click(); await tick()
    expect(catalog.mock.calls.find(call => call[0] === 'POST')![2]).toEqual({ envelope: null, url: policy.feedUrl })
  })
  it('stays truthful without read authority', async () => {
    document.body.innerHTML = listPage().replaceAll('data-ctr-can-read="true"', 'data-ctr-can-read="false"')
    const send = api(); boot(send); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(field('status').dataset.state).toBe('unavailable')
  })
})
