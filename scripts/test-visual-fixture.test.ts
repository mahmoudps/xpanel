import { request } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVisualFixture } from '../tests/browser/visual-fixture.mjs'

type Fixture = Awaited<ReturnType<typeof createVisualFixture>>
const fixtures: Fixture[] = []
const openFixture = async (options: Record<string, unknown> = {}) => {
  const fixture = await createVisualFixture(options)
  fixtures.push(fixture)
  return fixture
}
const read = (fixture: Fixture, path: string, method = 'GET') => new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
  const incoming = request(new URL(path, fixture.baseUrl), { method }, response => {
    const chunks: Buffer[] = []
    response.on('data', chunk => chunks.push(Buffer.from(chunk)))
    response.on('error', reject)
    response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
  })
  incoming.on('error', reject)
  incoming.setTimeout(5000, () => incoming.destroy(new Error('Synthetic fixture request timed out.')))
  incoming.end()
})
const componentHtml = '<!doctype html><html lang="en"><head><title>Synthetic component</title></head><body class="component-sample"><main>Complete synthetic component</main></body></html>'

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected outbound transport.')) })
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close()
  expect(globalThis.fetch).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})

describe('trusted synthetic visual state projection', () => {
  it('keeps default rendering byte-identical to an identity projection', async () => {
    const plain = await openFixture()
    const identity = await openFixture({ transformState: ({ state }: { state: object }) => state })
    for (const path of ['/panel?lang=en', '/files/web-disk?lang=ar&theme=dark']) {
      const original = await read(plain, path), projected = await read(identity, path)
      expect(projected.status).toBe(original.status); expect(projected.body).toBe(original.body)
      expect(original.status).toBe(200)
      expect(original.body).toContain('data-visual-fixture="synthetic"')
      expect(original.headers['x-visual-fixture']).toBe('synthetic')
      expect(original.headers['x-visual-fixture-scope']).toBeUndefined()
      expect(original.headers['set-cookie']).toBeUndefined()
    }
  })

  it('receives the actual resolved alias route and current synthetic state', async () => {
    const seen: { route: unknown; account: string; stateRoute: string }[] = []
    const fixture = await openFixture({ transformState: ({ state, route }: { state: any; route: unknown }) => {
      seen.push({ route, account: state.panel.account.username, stateRoute: state.activeRoute })
      return { ...state, title: 'Synthetic scoped document' }
    } })
    const response = await read(fixture, '/panel/files/web-disk?lang=ar')
    expect(response.status).toBe(200)
    expect(response.body).toContain('Synthetic scoped document')
    expect(seen).toEqual([{ route: { surface: 'xpanel', activeRoute: '/files/web-disk' }, account: 'preview', stateRoute: '/files/web-disk' }])
  })

  it('projects after the existing unresolved-account summary is selected', async () => {
    let projected = false
    const fixture = await openFixture({ resolvedAccount: false, transformState: ({ state }: { state: any }) => {
      expect(state.panel).toEqual({})
      expect(state.workspaceSummary.account.username).toBe('preview')
      projected = true
      return state
    } })
    expect((await read(fixture, '/files/web-disk')).status).toBe(200)
    expect(projected).toBe(true)
  })

  it.each([null, 42, {}, [], true].map(transformState => ({ transformState })))('rejects a nonfunction projection option: ', async ({ transformState }) => {
    await expect(createVisualFixture({ transformState })).rejects.toThrow(/function/i)
  })

  it.each([undefined, null, [], 42, 'state', () => ({})].map(result => ({ result })))('rejects malformed state results: ', async ({ result }) => {
    const fixture = await openFixture({ transformState: () => result })
    const response = await read(fixture, '/files/web-disk')
    expect(response.status).toBe(500)
    expect(response.body).toBe('Synthetic visual fixture could not render this document.')
  })

  it.each(['resolved', 'rejected', 'thenable'])('rejects asynchronous projection results without an unhandled rejection: %s', async mode => {
    const fixture = await openFixture({ transformState: ({ state }: { state: object }) => {
      if (mode === 'resolved') return Promise.resolve(state)
      if (mode === 'rejected') return Promise.reject(new Error('Synthetic projection refusal.'))
      return { then(_resolve: unknown, reject: (error: Error) => void) { reject(new Error('Synthetic thenable refusal.')) } }
    } })
    const response = await read(fixture, '/files/web-disk')
    expect(response.status).toBe(500)
    expect(response.body).not.toContain('refusal')
  })

  it('keeps GET/HEAD, assets, the existing read-only API, unknown paths and POST boundaries intact', async () => {
    const routes: unknown[] = []
    const fixture = await openFixture({ transformState: ({ state, route }: { state: object; route: unknown }) => { routes.push(route); return state } })
    expect((await read(fixture, '/files/web-disk')).status).toBe(200)
    const head = await read(fixture, '/files/web-disk', 'HEAD')
    expect(head.status).toBe(200); expect(head.body).toBe('')
    expect(routes).toEqual([{ surface: 'xpanel', activeRoute: '/files/web-disk' }, { surface: 'xpanel', activeRoute: '/files/web-disk' }])
    const asset = await read(fixture, '/favicon.ico')
    expect(asset.status).toBe(200); expect(asset.headers['content-type']).not.toContain('text/html')
    const ips = await read(fixture, '/api/ips')
    expect(ips.status).toBe(200); expect(JSON.parse(ips.body).hostBinding).toBe('unverified')
    expect((await read(fixture, '/api/other')).status).toBe(404)
    expect((await read(fixture, '/__visual-components/sample')).status).toBe(404)
    const refused = await read(fixture, '/files/web-disk', 'POST')
    expect(refused.status).toBe(405); expect(refused.headers.allow).toBe('GET, HEAD')
    expect(routes).toHaveLength(2)
  })
})

describe('explicit synthetic component documents', () => {
  it('serves only the configured component path with an explicit scope and visible watermark', async () => {
    const urls: URL[] = []
    const routes: unknown[] = []
    const fixture = await openFixture({
      transformState: ({ state, route }: { state: object; route: unknown }) => { routes.push(route); return state },
      componentDocument: { path: '/__visual-components/sample', render: ({ url }: { url: URL }) => { urls.push(url); return componentHtml } },
    })
    const response = await read(fixture, '/__visual-components/sample?lang=ar&theme=dark')
    expect(response.status).toBe(200)
    expect(response.headers['x-visual-fixture']).toBe('synthetic')
    expect(response.headers['x-visual-fixture-scope']).toBe('component')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.body).toContain('data-visual-fixture-scope="component"')
    expect(response.body).toContain('Synthetic component fixture')
    expect(response.body).toContain('not a product route')
    expect(response.body).toContain('Complete synthetic component')
    expect(response.body).toContain('class="component-sample"')
    expect(urls).toHaveLength(1); expect(urls[0]!.searchParams.get('lang')).toBe('ar')
    expect(routes).toEqual([])
    const head = await read(fixture, '/__visual-components/sample', 'HEAD')
    expect(head.status).toBe(200); expect(head.body).toBe(''); expect(head.headers['x-visual-fixture-scope']).toBe('component')
    expect((await read(fixture, '/__visual-components/other')).status).toBe(404)
    expect((await read(fixture, '/__visual-components/sample', 'POST')).status).toBe(405)
    expect(urls).toHaveLength(2)
  })

  it('preserves actual product-route admission when a component document is configured', async () => {
    const plain = await openFixture()
    const component = await openFixture({ componentDocument: { path: '/__visual-components/htaccess', render: () => componentHtml } })
    for (const path of ['/software/htaccess', '/domains/site-settings']) {
      const original = await read(plain, path), scoped = await read(component, path)
      expect(scoped.status).toBe(original.status); expect(scoped.body).toBe(original.body)
      expect(scoped.body).not.toContain('data-htaccess-workspace')
      expect(scoped.headers['x-visual-fixture-scope']).toBeUndefined()
    }
  })

  it.each([
    null, {}, { path: '/software/htaccess', render: () => componentHtml },
    { path: '/__visual-components/../sample', render: () => componentHtml },
    { path: '/__visual-components/sample?mode=loaded', render: () => componentHtml },
    { path: '/__visual-components/sample', render: 'document' },
  ].map(componentDocument => ({ componentDocument })))('rejects invalid component configuration: ', async ({ componentDocument }) => {
    await expect(createVisualFixture({ componentDocument })).rejects.toThrow(/component/i)
  })

  it.each([undefined, null, 42, {}, '', '<main>fragment</main>'].map(result => ({ result })))('rejects incomplete component document results: ', async ({ result }) => {
    const fixture = await openFixture({ componentDocument: { path: '/__visual-components/sample', render: () => result } })
    const response = await read(fixture, '/__visual-components/sample')
    expect(response.status).toBe(500)
    expect(response.body).toBe('Synthetic visual fixture could not render this document.')
  })

  it('rejects a rejected asynchronous component document without leaking its error', async () => {
    const fixture = await openFixture({ componentDocument: { path: '/__visual-components/sample', render: () => Promise.reject(new Error('Synthetic component refusal.')) } })
    const response = await read(fixture, '/__visual-components/sample')
    expect(response.status).toBe(500); expect(response.body).not.toContain('refusal')
  })
})
