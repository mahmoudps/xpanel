import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleSecWorkspaceRoute } from './sec-workspace.ts'
import type { SecWorkspaceHelpers } from './sec-workspace.ts'
import { secPanelAccessGate } from './sec-panel-access.ts'
import { SEC_DEFAULTS, SEC_PANEL_ACCESS_STATE, SEC_STATE_PATHS, SEC_WAF_SITES_STATE, secRevision } from '../../agent/src/sec-policy.ts'

const ROOT = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 'one', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
const ACCOUNT = { id: '22222222-2222-4222-8222-222222222222', username: 'alice', status: 'active', planId: 'p' }
const OWNER = { principal: { kind: 'user', id: '33333333-3333-4333-8333-333333333333', username: 'alice', accountId: ACCOUNT.id }, sessionId: 'two', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-sec-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const wafHost = { observedAt: '2026-10-28T12:00:00.000Z', family: 'debian', connector: { nginx: false, apache: true }, engineConf: { path: '/etc/modsecurity/modsecurity.conf', ruleEngine: 'DetectionOnly' }, crs: { dir: '/usr/share/modsecurity-crs', version: '3.3.4' }, active: { lists: true, modsecurity: false } }
function harness(overrides: Partial<SecWorkspaceHelpers> = {}, caller = ROOT) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const helpers = {
    requireCaller: vi.fn(async () => caller), assertRoot: vi.fn(async (current: AuthenticatedCaller) => { if (current.principal.kind !== 'root') fail('FORBIDDEN', 'root required', { stateChanged: false }) }),
    emitAudit: vi.fn(async () => undefined), triggerReconcile: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }), getAccount: async () => ACCOUNT, getPlan: async () => ({ featureListId: 'f' }), getFeatureList: async () => ({ disabled: [] }), listDomains: async (filter: { accountId?: string } = {}) => filter.accountId === ACCOUNT.id ? [{ name: 'alice.test' }, { name: 'shop.alice.test' }] : [] },
    readClient: () => ({ listener: 'xwhm', address: '203.0.113.7' }), panelAccessEnforced: true,
    callHost: vi.fn(async (_caller: AuthenticatedCaller, path: string) => path.startsWith('/host/sec/waf') ? wafHost : path === '/host/sec/flood' ? { observedAt: wafHost.observedAt, state: 'not_applied', reason: null, rules: { connections: 0, rate: 0, ping: 0 }, tracked: [] } : null),
    now: () => new Date('2026-10-28T12:00:00.000Z'), ...overrides,
  } as unknown as SecWorkspaceHelpers
  const send = (path: string, method = 'GET', body?: unknown) => handleSecWorkspaceRoute(new Request('http://api.test' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://api.test' + path), method, helpers)
  return { helpers, send, lease }
}
const access = (xwhm: { cidr: string; note: string }[]) => ({ listeners: { xpanel: [], xwhm, xmail: [] } })

describe('sec server workspaces', () => {
  it('reads defaults with the strict host observation and refuses selectors, methods and non-root callers', async () => {
    const h = harness()
    const view = await (await h.send('/api/server/sec/waf'))!.json()
    expect(view).toMatchObject({ state: 'default', policy: SEC_DEFAULTS.waf, revision: secRevision('waf', null), observation: { connector: { nginx: false, apache: true }, active: { lists: true } }, reason: null })
    await expect(h.send('/api/server/sec/waf?x=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await h.send('/api/server/sec/waf', 'DELETE'))!.status).toBe(405)
    await expect(harness({}, OWNER).send('/api/server/sec/flood')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const bad = harness({ callHost: vi.fn(async () => ({ ...wafHost, active: { lists: 'yes', modsecurity: false } })) })
    expect(await (await bad.send('/api/server/sec/waf'))!.json()).toMatchObject({ observation: null, reason: 'observation_unverified' })
    expect(await (await harness({ callHost: undefined }).send('/api/server/sec/flood'))!.json()).toMatchObject({ observation: null, reason: 'host_agent_unavailable' })
  })
  it('saves under CAS with a re-read, audits, then requests reconciliation', async () => {
    const h = harness(), policy = { ...SEC_DEFAULTS.flood, enabled: true, connectionsPerAddress: 100 }
    const saved = await (await h.send('/api/server/sec/flood', 'PUT', { policy, expectedRevision: secRevision('flood', null) }))!.json()
    expect(saved).toMatchObject({ state: 'saved', policy, reconcile: 'requested' })
    expect(JSON.parse(await readFile(join(root, SEC_STATE_PATHS.flood), 'utf8'))).toEqual({ version: 1, policy, updatedAt: '2026-10-28T12:00:00.000Z' })
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.sec.flood.saved' }))
    await expect(h.send('/api/server/sec/flood', 'PUT', { policy, expectedRevision: secRevision('flood', null) })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(h.send('/api/server/sec/flood', 'PUT', { policy: { ...policy, enabled: 1 }, expectedRevision: saved.revision })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('/api/server/sec/flood', 'PUT', { policy, expectedRevision: saved.revision, force: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await (await harness({ triggerReconcile: vi.fn(async () => null) }).send('/api/server/sec/flood', 'PUT', { policy: SEC_DEFAULTS.flood, expectedRevision: saved.revision }))!.json()).toMatchObject({ reconcile: 'not_connected' })
  })
  it('refuses a panel allowlist that would lock out the current address and reports enforcement truthfully', async () => {
    const h = harness()
    await expect(h.send('/api/server/sec/panel-access', 'PUT', { policy: access([{ cidr: '198.51.100.0/24', note: 'other' }]), expectedRevision: secRevision('panel-access', null) })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'self_lockout' } })
    const ok = await (await h.send('/api/server/sec/panel-access', 'PUT', { policy: access([{ cidr: '203.0.113.0/24', note: 'office' }]), expectedRevision: secRevision('panel-access', null) }))!.json()
    expect(ok).toMatchObject({ state: 'saved', reconcile: null })
    expect(await (await h.send('/api/server/sec/panel-access'))!.json()).toMatchObject({ enforcement: 'api_listener', client: { listener: 'xwhm', address: '203.0.113.7', admitted: { xpanel: true, xwhm: true, xmail: true } } })
    expect(await (await harness({ panelAccessEnforced: false }).send('/api/server/sec/panel-access'))!.json()).toMatchObject({ enforcement: 'not_connected' })
    await expect(harness({ readClient: () => ({ listener: null, address: null }) }).send('/api/server/sec/panel-access', 'PUT', { policy: access([{ cidr: '203.0.113.0/24', note: '' }]), expectedRevision: ok.revision })).rejects.toMatchObject({ detail: { reason: 'self_lockout' } })
  })
  it('gates entry points from the saved file and fails closed on an invalid file', async () => {
    expect(await secPanelAccessGate(root, 'xwhm', '198.51.100.1')).toBe(true)
    await mkdir(join(root, 'extended', 'server'), { recursive: true })
    await writeFile(join(root, SEC_PANEL_ACCESS_STATE), JSON.stringify({ version: 1, policy: access([{ cidr: '203.0.113.0/24', note: '' }]), updatedAt: '2026-10-28T12:00:00.000Z' }))
    expect(await secPanelAccessGate(root, 'xwhm', '203.0.113.9')).toBe(true)
    expect(await secPanelAccessGate(root, 'xwhm', '198.51.100.1')).toBe(false)
    expect(await secPanelAccessGate(root, 'xpanel', '198.51.100.1')).toBe(true)
    await writeFile(join(root, SEC_PANEL_ACCESS_STATE), '{"version":1,"policy":{}}')
    expect(await secPanelAccessGate(root, 'xpanel', '198.51.100.1')).toBe(false)
  })
  it('verifies peers and applies the exact saved cluster revision through the host only', async () => {
    const peers = { peers: [{ name: 'ns2.example.net', address: '198.51.100.53' }] }
    const host = vi.fn(async (_caller: AuthenticatedCaller, path: string) => path.includes('verify') ? { observedAt: wafHost.observedAt, peer: peers.peers[0], zones: [{ zone: 'alice.test', localSerial: 3, peerSerial: 3, state: 'in_sync' }], counts: { in_sync: 1, behind: 0, ahead: 0, not_served: 0, refused: 0, unreachable: 0, local_unavailable: 0 }, truncated: false }
      : path.endsWith('/apply') ? { outcome: 'applied', observation: { observedAt: wafHost.observedAt, state: 'read', settings: { launch: 'bind', primary: true, disableAxfr: false, allowAxfrIps: ['127.0.0.0/8', '::1', '198.51.100.53'], alsoNotify: ['198.51.100.53'], includeDir: '/etc/powerdns/pdns.d' }, application: 'applied', peers: [{ ...peers.peers[0], transferAllowed: true, notified: true }] } } : null)
    const h = harness({ callHost: host as never })
    await expect(h.send('/api/server/sec/dns-cluster/apply', 'POST', { expectedRevision: secRevision('dns-cluster', null) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const saved = await (await h.send('/api/server/sec/dns-cluster', 'PUT', { policy: peers, expectedRevision: secRevision('dns-cluster', null) }))!.json()
    expect(await (await h.send('/api/server/sec/dns-cluster/verify?peer=ns2.example.net'))!.json()).toMatchObject({ counts: { in_sync: 1 } })
    await expect(h.send('/api/server/sec/dns-cluster/verify?peer=ns2.example.net&peer=x')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await (await h.send('/api/server/sec/dns-cluster/apply', 'POST', { expectedRevision: saved.revision }))!.json()).toMatchObject({ outcome: 'applied', observation: { application: 'applied' } })
    expect(host).toHaveBeenCalledWith(expect.anything(), '/host/sec/dns-cluster/apply', { expectedRevision: saved.revision })
    const lying = harness({ callHost: vi.fn(async () => ({ outcome: 'applied', observation: { observedAt: wafHost.observedAt, state: 'read', settings: { launch: null, primary: false, disableAxfr: false, allowAxfrIps: [], alsoNotify: [], includeDir: null }, application: 'drift', peers: [] } })) })
    await expect(lying.send('/api/server/sec/dns-cluster/apply', 'POST', { expectedRevision: saved.revision })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { verificationRequired: true } })
  })
})

describe('sec account WAF switch', () => {
  it('lists only the owner domains with server limits and saves an off switch for an owned domain only', async () => {
    const h = harness({}, OWNER)
    const view = await (await h.send('/api/account/sec/waf'))!.json()
    expect(view).toMatchObject({ server: { modsecurity: true, lists: { addresses: 0 } }, live: { connector: false, crsVersion: '3.3.4' }, domains: [{ domain: 'alice.test', modsecurity: true }, { domain: 'shop.alice.test', modsecurity: true }] })
    expect(h.helpers.callHost).toHaveBeenCalledWith(OWNER, '/host/sec/waf/summary')
    await expect(h.send('/api/account/sec/waf', 'PUT', { domain: 'bob.test', modsecurity: false, expectedRevision: view.revision })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const saved = await (await h.send('/api/account/sec/waf', 'PUT', { domain: 'alice.test', modsecurity: false, expectedRevision: view.revision }))!.json()
    expect(saved.domains[0]).toEqual({ domain: 'alice.test', modsecurity: false })
    expect(saved.reconcile).toBe('requested')
    expect(JSON.parse(await readFile(join(root, SEC_WAF_SITES_STATE), 'utf8')).policy).toEqual({ sites: { 'alice.test': { accountId: ACCOUNT.id, modsecurity: false } } })
    const back = await (await h.send('/api/account/sec/waf', 'PUT', { domain: 'alice.test', modsecurity: true, expectedRevision: saved.revision }))!.json()
    expect(JSON.parse(await readFile(join(root, SEC_WAF_SITES_STATE), 'utf8')).policy).toEqual({ sites: {} })
    expect(back.domains[0].modsecurity).toBe(true)
    await expect(h.send('/api/account/sec/waf', 'PUT', { domain: 'alice.test', modsecurity: 'no', expectedRevision: back.revision })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
