import { describe, expect, it, vi } from 'vitest'
import { buildSupportBundle, readSupportSummary, SUPPORT_BUNDLE_MANIFEST } from '../../agent/src/support-bundle.ts'
import type { SupportRouteContext } from '../../agent/src/support-bundle.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { handleSupportWorkspaceRoute, projectSupportBundle, projectSupportContact, projectSupportSummary } from './support-workspace.ts'
import type { SupportWorkspaceHelpers } from './support-workspace.ts'

const root = { principal: { kind: 'root', id: 'root-1', username: 'root' }, sessionId: 's1', apiTokenId: null } as unknown as AuthenticatedCaller
const agent: SupportRouteContext = {
  assertRoot: async () => ({ actor: 'root' }), host: null, os: { id: 'debian', versionId: '12', family: 'debian' },
  latestGeneration: async () => ({ id: 3, createdAt: '2026-10-27T07:00:00.000Z', status: 'active', checksum: 'b'.repeat(64), error: null, actor: 'root', testedAt: null, activatedAt: '2026-10-27T07:00:02.000Z' }),
  readDrift: async () => ({ hasDrift: false, manifestMissing: false, generationId: 3, items: [] }),
  listFailedJobs: async () => [{ id: 'job-1', referenceCode: 'XP-JOB-2026-000123', kind: 'security-tools.scan', status: 'failed', progress: 100, summary: 's', accountId: null, actor: 'root', createdAt: '2026-10-27T08:00:00.000Z', startedAt: null, finishedAt: '2026-10-27T08:00:05.000Z',
    steps: [{ id: 'clamscan', title: 'Scan', state: 'failed', exitCode: 2 }], error: 'mirror 192.0.2.80 refused password=abc', failureClass: 'retryable', cancelRequested: false, verification: null, logBytes: 0 }],
  now: () => new Date('2026-10-27T10:00:00.000Z'), redactionKey: new Uint8Array(32).fill(1),
}
const get = (path: string, init?: RequestInit) => new Request('http://localhost' + path, init)
const call = (req: Request, helpers: SupportWorkspaceHelpers) => handleSupportWorkspaceRoute(req, new URL(req.url), req.method, helpers)
const BUNDLE = '/api/server/support/bundle?manifest=' + SUPPORT_BUNDLE_MANIFEST.id
const helpers = (overrides: Partial<SupportWorkspaceHelpers> = {}, host?: (path: string) => Promise<unknown>) => {
  const events: string[] = []
  const value: SupportWorkspaceHelpers = {
    requireCaller: vi.fn(async () => { events.push('auth'); return root }),
    assertRoot: vi.fn(async (_caller, action: string) => { events.push('root:' + action) }),
    emitAudit: vi.fn(async (entry: { action: string }) => { events.push('audit:' + entry.action) }),
    readBranding: vi.fn(async () => null),
    readHost: vi.fn(async (_caller, path: string) => { events.push('agent:' + path); return host ? host(path) : path === '/host/support' ? readSupportSummary(agent) : buildSupportBundle(agent) }),
    ...overrides,
  }
  return { value, events }
}

describe('API support workspace', () => {
  it.each(['XP-JOB-2026-000123', 'LEGACY/77-A', null])('preserves failed job references in summary and downloaded bundle: %s', async referenceCode => {
    const ctx: SupportRouteContext = { ...agent, listFailedJobs: async limit => (await agent.listFailedJobs!(limit)).map(job => ({ ...job, referenceCode })) }
    expect(projectSupportSummary(await readSupportSummary(ctx)).failedJobs.items[0]!.referenceCode).toBe(referenceCode)
    expect(projectSupportBundle(await buildSupportBundle(ctx)).failedJobs.items[0]!.referenceCode).toBe(referenceCode)
  })
  it('leaves unrelated routes untouched', async () => {
    const { value } = helpers()
    expect(await call(get('/api/server/supported'), value)).toBeNull()
    expect(value.requireCaller).not.toHaveBeenCalled()
  })

  it('returns the projected summary, the manifest and an unconfigured contact, authorizing root before and after the host read', async () => {
    const { value, events } = helpers()
    const response = (await call(get('/api/server/support'), value))!
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json() as { summary: { host: string; generation: { id: number }; failedJobs: { items: { error: string }[] } }; manifest: { id: string }; contact: { state: string } }
    expect(body.summary).toMatchObject({ host: 'unavailable', generation: { id: 3 } })
    expect(body.summary.failedJobs.items[0]!.error).toBe('mirror 192.0.2.80 refused password=abc')
    expect(body.manifest).toEqual(JSON.parse(JSON.stringify(SUPPORT_BUNDLE_MANIFEST)))
    expect(body.contact).toEqual({ state: 'not-configured' })
    expect(events).toEqual(['auth', 'root:server.support.read', 'agent:/host/support', 'auth', 'root:server.support.read'])
  })

  it('shows only owner-saved support contacts and never the built-in placeholders', () => {
    expect(projectSupportContact(null)).toEqual({ state: 'not-configured' })
    expect(projectSupportContact({ supportUrl: 'https://support.xpanel.internal', supportEmail: 'support@xpanel.internal' })).toEqual({ state: 'not-configured' })
    expect(projectSupportContact({ supportUrl: 'https://help.provider.test/tickets', supportEmail: 'bad address' })).toEqual({ state: 'configured', url: 'https://help.provider.test/tickets', email: null })
    expect(projectSupportContact({ supportUrl: 'javascript:alert(1)', supportEmail: 'help@provider.test' })).toEqual({ state: 'configured', url: null, email: 'help@provider.test' })
  })

  it('reports an unreadable branding setting as unavailable, not as unconfigured', async () => {
    const { value } = helpers({ readBranding: vi.fn(async () => { throw new Error('EACCES') }) })
    expect(((await (await call(get('/api/server/support'), value))!.json()) as { contact: unknown }).contact).toEqual({ state: 'unavailable' })
  })

  it('refuses non-root callers with 403 before any host read on both routes', async () => {
    const denied = Object.assign(new Error('root role is required'), { code: 'FORBIDDEN', status: 403 })
    const { value } = helpers({ assertRoot: vi.fn(async () => { throw denied }) })
    for (const path of ['/api/server/support', BUNDLE]) await expect(call(get(path), value)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(value.readHost).not.toHaveBeenCalled()
    expect(value.emitAudit).not.toHaveBeenCalled()
  })

  it('downloads the redacted bundle as a no-store JSON attachment bound to the reviewed manifest and audits it', async () => {
    const { value, events } = helpers()
    const response = (await call(get(BUNDLE), value))!
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="xpanel-support-20261027T100000Z.json"')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const text = await response.text(), body = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['manifest', 'generatedAt', 'versions', 'os', 'uptime', 'services', 'resources', 'generation', 'drift', 'failedJobs', 'journal'])
    expect(text).not.toMatch(/192\.0\.2\.80|password=abc/)
    expect(text).toMatch(/\[ipv4:[0-9a-f]{12}\]/)
    expect(events).toEqual(['auth', 'root:server.support.bundle', 'agent:/host/support/bundle', 'auth', 'root:server.support.bundle', 'audit:server.support.bundle_downloaded'])
  })

  it('rejects a missing, malformed or stale manifest id, selectors on the summary, bodies and other methods', async () => {
    const { value } = helpers()
    for (const path of ['/api/server/support/bundle', '/api/server/support/bundle?manifest=xyz', BUNDLE + '&x=1', '/api/server/support?x=1'])
      await expect(call(get(path), value)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(get('/api/server/support/bundle?manifest=' + '0'.repeat(16)), value)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await call(get('/api/server/support', { method: 'POST', body: '{}' }), value))!.status).toBe(405)
    expect(value.readHost).not.toHaveBeenCalled()
  })

  it('refuses a bundle with unredacted text, an unknown section, a changed manifest or a failed audit', async () => {
    const good = JSON.parse(JSON.stringify(await buildSupportBundle(agent))) as Record<string, any>
    expect(() => projectSupportBundle({ ...good, failedJobs: { state: 'read', items: [{ ...good.failedJobs.items[0], error: 'from 198.51.100.4' }] } })).toThrow(/redaction/)
    expect(() => projectSupportBundle({ ...good, stateFiles: [] })).toThrow()
    expect(() => projectSupportBundle({ ...good, manifest: { ...good.manifest, sections: [] } })).toThrow()
    expect(() => projectSupportBundle({ ...good, journal: { ...good.journal, 'mariadb.service': good.journal['xpanel-api.service'] } })).toThrow()
    const failing = helpers({ emitAudit: vi.fn(async () => { throw new Error('audit down') }) })
    await expect(call(get(BUNDLE), failing.value)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('refuses summaries whose read state disagrees with the value or whose text is unsafe', async () => {
    const good = JSON.parse(JSON.stringify(await readSupportSummary(agent))) as Record<string, any>
    expect(projectSupportSummary(good).generation.id).toBe(3)
    for (const bad of [
      { ...good, versions: { ...good.versions, panel: { state: 'read', version: null, releasePath: null } } },
      { ...good, uptime: { state: 'unavailable', seconds: 5 } },
      { ...good, os: { ...good.os, profile: { ...good.os.profile, id: 'deb' + String.fromCharCode(0x202e) } } },
      { ...good, failedJobs: { state: 'read', items: Array.from({ length: 11 }, () => good.failedJobs.items[0]) } },
    ]) expect(() => projectSupportSummary(bad)).toThrow()
  })

  it('refuses when authority changes during the read and stays truthful without an agent', async () => {
    const callers = [root, { ...root, sessionId: 's2' } as AuthenticatedCaller]
    const changed = helpers({ requireCaller: vi.fn(async () => callers.shift()!) })
    await expect(call(get('/api/server/support'), changed.value)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const { readHost: _readHost, ...rest } = helpers({ readBranding: vi.fn(async () => ({ supportEmail: 'help@provider.test' })) }).value
    const body = await (await call(get('/api/server/support'), rest))!.json() as { summary: null; contact: unknown }
    expect(body).toMatchObject({ summary: null, contact: { state: 'configured', email: 'help@provider.test' } })
    await expect(call(get(BUNDLE), rest)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
