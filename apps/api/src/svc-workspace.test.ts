import { describe, expect, it } from 'vitest'
import { sessionAddressAdmitted } from './auth.ts'
import { killerReportText } from './svc-killer-report.ts'
import { projectSvcObservation } from './sec-workspace.ts'
import { handleSvcWorkspaceRoute } from './svc-workspace.ts'
import type { SvcWorkspaceHelpers } from './svc-workspace.ts'

const caller = { principal: { id: 'root-id', username: 'root' } } as never
const helpers = (over: Partial<SvcWorkspaceHelpers> = {}): SvcWorkspaceHelpers => ({
  requireCaller: async () => caller, assertRoot: async () => {}, emitAudit: async () => undefined, triggerReconcile: async () => ({ ok: true }), store: { rootDir: '/nonexistent' } as never, ...over,
} as SvcWorkspaceHelpers)
const route = (path: string, init?: RequestInit) => { const request = new Request('http://panel.test' + path, init); return handleSvcWorkspaceRoute(request, new URL(request.url), request.method, helpers()) }

describe('session address validation', { tags: ['unit'] }, () => {
  it('refuses a cookie replayed from another address in strict mode', () => {
    expect(sessionAddressAdmitted('strict', '203.0.113.9', '203.0.113.9')).toBe(true)
    expect(sessionAddressAdmitted('strict', '203.0.113.9', '203.0.113.10')).toBe(false)
  })
  it('accepts the same network in loose mode, and every address when disabled', () => {
    expect(sessionAddressAdmitted('loose', '203.0.113.9', '203.0.113.200')).toBe(true)
    expect(sessionAddressAdmitted('loose', '203.0.113.9', '203.0.114.1')).toBe(false)
    expect(sessionAddressAdmitted('loose', '2001:db8:1:2::1', '2001:db8:1:2:ffff::1')).toBe(true)
    expect(sessionAddressAdmitted('disabled', '203.0.113.9', '198.51.100.1')).toBe(true)
  })
  it('does not compare an address it does not know, and refuses a family change', () => {
    expect(sessionAddressAdmitted('strict', null, '203.0.113.9')).toBe(true)
    expect(sessionAddressAdmitted('strict', '203.0.113.9', null)).toBe(true)
    expect(sessionAddressAdmitted('strict', '203.0.113.9', '2001:db8::1')).toBe(false)
  })
})

describe('services workspace', { tags: ['unit'] }, () => {
  it('passes plain bounded JSON and refuses what could not be drawn safely', () => {
    expect(projectSvcObservation({ a: [1, 'x', null, { b: true }] })).toEqual({ a: [1, 'x', null, { b: true }] })
    expect(() => projectSvcObservation({ a: 'x'.repeat(9000) })).toThrow()
    expect(() => projectSvcObservation({ a: 'bad\u202etext' })).toThrow()
    expect(() => projectSvcObservation(Number.NaN)).toThrow()
  })
  it('names the installed version from the host and marks only that entry', async () => {
    const response = await handleSvcWorkspaceRoute(new Request('http://panel.test/api/server/services/change-log'), new URL('http://panel.test/api/server/services/change-log'), 'GET', helpers({ callHost: async () => ({ current: { version: '0.1.30' } }) }))
    const body = await response!.json() as { installed: string; entries: { version: string; installed: boolean }[] }
    expect(body.installed).toBe('0.1.30')
    expect(body.entries.filter(entry => entry.installed).map(entry => entry.version)).toEqual(['0.1.30'])
  })
  it('passes the source build state through and refuses a selector', async () => {
    const path = '/api/server/services/source-builds', view = { hook: true, modules: [{ id: 'fts-xapian', state: 'rebuild_failed', builtAgainst: '2.3.16', installed: '2.3.21', failedAt: '2026-11-07T10:00:00.000Z' }] }
    const paths: string[] = [], read = (target: string) => handleSvcWorkspaceRoute(new Request('http://panel.test' + target), new URL('http://panel.test' + target), 'GET', helpers({ callHost: async (_caller, host) => { paths.push(host); return view } }))
    expect(await (await read(path))!.json()).toEqual(view)
    expect(paths).toEqual(['/host/svc/source-builds'])
    await expect(read(path + '?module=awstats')).rejects.toThrow()
  })
  it('says no version is installed when the host cannot tell, rather than guessing', async () => {
    const body = await (await route('/api/server/services/change-log'))!.json() as { installed: unknown; entries: { installed: boolean }[] }
    expect(body.installed).toBeNull()
    expect(body.entries.some(entry => entry.installed)).toBe(false)
  })
  it('refuses a read without the host agent with a stable reason', async () => {
    await expect(route('/api/server/services/web-status')).rejects.toMatchObject({ detail: { reason: 'host_agent_unavailable' } })
  })
  it('allows only the declared method and selectors', async () => {
    expect((await route('/api/server/services/web-status', { method: 'POST' }))!.status).toBe(405)
    await expect(route('/api/server/services/process-log?host=x')).rejects.toThrow()
    expect(await route('/api/server/other')).toBeNull()
  })
})

describe('process killer report', { tags: ['unit'] }, () => {
  it('lists what was stopped, and says so when the list could not be read', () => {
    const run = { at: '2026-11-07T02:00:00.000Z', trigger: 'nightly', state: 'completed', killed: [{ pid: 5, user: 'alice', comm: 'eggdrop', outcome: 'confirmed' }], trustedSkipped: 1, mailed: false }
    expect(killerReportText(run)).toContain('alice eggdrop pid 5: confirmed')
    expect(killerReportText({ ...run, state: 'unavailable', killed: [] })).toContain('nothing was stopped')
  })
})
