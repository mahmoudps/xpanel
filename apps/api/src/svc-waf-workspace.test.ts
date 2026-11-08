import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { handleSecWorkspaceRoute } from './sec-workspace.ts'
import type { SecWorkspaceHelpers } from './sec-workspace.ts'
import { handleSvcWorkspaceRoute } from './svc-workspace.ts'
import { SEC_STATE_PATHS, secRevision } from '../../agent/src/sec-policy.ts'

const ROOT = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 'one', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
const RULE = 'SecRule REQUEST_URI "@contains /blocked" "id:1001,phase:1,deny,status:403"'
const stored = { id: 1001, text: RULE, note: 'test', enabled: true }
const waf = (modsecurity: boolean) => ({ observedAt: '2026-11-07T12:00:00.000Z', family: 'debian', connector: { nginx: modsecurity, apache: false }, engineConf: { path: null, ruleEngine: null }, crs: { dir: null, version: null }, active: { lists: true, modsecurity } })
const vendor = { id: 'acme', name: 'Acme', description: '', docsUrl: null, metadataUrl: 'https://x.test/m.json', archiveSha256: 'a'.repeat(64), version: '1.0' }
let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-svc-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function harness(overrides: Partial<SecWorkspaceHelpers> = {}, live = true) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const helpers = {
    requireCaller: vi.fn(async () => ROOT), assertRoot: vi.fn(async () => undefined), emitAudit: vi.fn(async () => undefined), triggerReconcile: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }) }, readClient: () => ({ listener: 'xwhm', address: '203.0.113.7' }), panelAccessEnforced: true,
    callHost: vi.fn(async (_caller: AuthenticatedCaller, path: string) => path === '/host/sec/waf' ? waf(live) : path === '/host/svc/waf-vendors/install' ? { vendor, files: ['a.conf'] } : path === '/host/svc/waf-hits' ? { state: 'empty', hits: [] } : { crs: [], vendors: {}, installed: {} }),
    now: () => new Date('2026-11-07T12:00:00.000Z'), ...overrides,
  } as unknown as SecWorkspaceHelpers
  const send = (path: string, method = 'GET', body?: unknown) => {
    const request = new Request('http://api.test' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
    const url = new URL(request.url)
    return handleSvcWorkspaceRoute(request, url, method, helpers).then(response => response ?? handleSecWorkspaceRoute(request, url, method, helpers))
  }
  return { helpers, send }
}
const saved = async (kind: 'waf-rules' | 'waf-vendors') => JSON.parse(await readFile(join(root, SEC_STATE_PATHS[kind]), 'utf8')) as { policy: Record<string, unknown> }
const stage = async (h: ReturnType<typeof harness>) => {
  const view = await (await h.send('/api/server/sec/waf-rules'))!.json() as { revision: string; policy: Record<string, unknown> }
  return await (await h.send('/api/server/sec/waf-rules', 'PUT', { expectedRevision: view.revision, policy: { ...view.policy, engine: 'On', staged: [stored], deployed: [stored], deployedEngine: 'On' } }))!.json() as { revision: string }
}

describe('custom WAF rules', { tags: ['feature'] }, () => {
  it('keeps a saved rule staged, whatever the request says about deployed rules', async () => {
    const h = harness()
    await stage(h)
    expect((await saved('waf-rules')).policy).toMatchObject({ staged: [stored], deployed: [], deployedEngine: 'inherit', engine: 'On' })
    expect(h.helpers.triggerReconcile).not.toHaveBeenCalled()
  })
  it('deploys the staged rules with their engine, then reconciles', async () => {
    const h = harness(), { revision } = await stage(h)
    const body = await (await h.send('/api/server/sec/waf-rules/deploy', 'POST', { expectedRevision: revision }))!.json() as { reconcile: string }
    expect(body.reconcile).toBe('requested')
    expect((await saved('waf-rules')).policy).toMatchObject({ deployed: [stored], deployedEngine: 'On' })
  })
  it('refuses to deploy rules that nothing would enforce', async () => {
    const h = harness({}, false), { revision } = await stage(h)
    await expect(h.send('/api/server/sec/waf-rules/deploy', 'POST', { expectedRevision: revision })).rejects.toMatchObject({ detail: { reason: 'waf_connector_unavailable', stateChanged: false } })
    expect((await saved('waf-rules')).policy).toMatchObject({ deployed: [] })
  })
  it('puts the previous rules back when the web server refuses the new ones', async () => {
    const h = harness({ triggerReconcile: vi.fn(async () => ({ ok: false, status: 500, body: {} })) } as never), { revision } = await stage(h)
    await expect(h.send('/api/server/sec/waf-rules/deploy', 'POST', { expectedRevision: revision })).rejects.toMatchObject({ detail: { rolledBack: true, stateChanged: false } })
    expect((await saved('waf-rules')).policy).toMatchObject({ deployed: [], staged: [stored] })
  })
  it('refuses a stale revision', async () => {
    const h = harness()
    await stage(h)
    await expect(h.send('/api/server/sec/waf-rules/deploy', 'POST', { expectedRevision: secRevision('waf-rules', null) })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('WAF vendors', { tags: ['feature'] }, () => {
  it('admits a vendor only through install, which the host verifies, and switches stay editable', async () => {
    const h = harness()
    const view = await (await h.send('/api/server/sec/waf-vendors'))!.json() as { revision: string; policy: { crsDisabledFiles: string[]; vendors: unknown[] } }
    await expect(h.send('/api/server/sec/waf-vendors', 'PUT', { expectedRevision: view.revision, policy: { crsDisabledFiles: [], vendors: [{ ...vendor, enabled: true, autoUpdate: false, disabledFiles: [] }] } })).rejects.toMatchObject({ code: 'VALIDATION' })
    await (await h.send('/api/server/sec/waf-vendors/install', 'POST', { url: vendor.metadataUrl, expectedRevision: view.revision }))!.json()
    const after = await (await h.send('/api/server/sec/waf-vendors'))!.json() as { revision: string; policy: { vendors: Record<string, unknown>[] } }
    expect(after.policy.vendors).toMatchObject([{ id: 'acme', enabled: true, autoUpdate: false, disabledFiles: [] }])
    const edited = { crsDisabledFiles: [], vendors: [{ ...after.policy.vendors[0], archiveSha256: 'b'.repeat(64), disabledFiles: ['a.conf'] }] }
    await h.send('/api/server/sec/waf-vendors', 'PUT', { expectedRevision: after.revision, policy: edited })
    // The digest stays what install verified; only the switch changed.
    expect((await saved('waf-vendors')).policy).toMatchObject({ vendors: [{ archiveSha256: vendor.archiveSha256, disabledFiles: ['a.conf'] }] })
  })
  it('removes the files only after the configuration no longer includes them', async () => {
    const order: string[] = []
    const h = harness({ triggerReconcile: vi.fn(async () => { order.push('reconcile'); return { ok: true, status: 200, body: {} } }) } as never)
    const view = await (await h.send('/api/server/sec/waf-vendors'))!.json() as { revision: string }
    await h.send('/api/server/sec/waf-vendors/install', 'POST', { url: vendor.metadataUrl, expectedRevision: view.revision })
    order.length = 0
    const callHost = h.helpers.callHost as ReturnType<typeof vi.fn>
    callHost.mockImplementation(async (_caller: AuthenticatedCaller, path: string) => { if (path.endsWith('/remove')) order.push('files'); return { crs: [], vendors: {}, installed: {} } })
    const after = await (await h.send('/api/server/sec/waf-vendors'))!.json() as { revision: string }
    await h.send('/api/server/sec/waf-vendors/remove', 'POST', { id: 'acme', expectedRevision: after.revision })
    expect(order).toEqual(['reconcile', 'files'])
  })
})
