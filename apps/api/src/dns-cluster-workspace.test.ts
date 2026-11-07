import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { DNS_CLUSTER_STATE, dnsClusterRevision } from '../../agent/src/dns-cluster-model.ts'
import { DnsClusterTransportError } from '../../agent/src/dns-cluster-transport.ts'
import type { DnsClusterCall } from '../../agent/src/dns-cluster-transport.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { handleDnsClusterWorkspaceRoute } from './dns-cluster-workspace.ts'
import type { DnsClusterWorkspaceHelpers } from './dns-cluster-workspace.ts'

const ROOT = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 'one', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
const OWNER = { ...ROOT, principal: { kind: 'user', id: '33333333-3333-4333-8333-333333333333', username: 'alice' } } as unknown as AuthenticatedCaller
const TOKEN = 'xpdc_' + 'z'.repeat(43), PIN = 'd'.repeat(64)
let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-dns-cluster-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const hello: DnsClusterCall = async () => ({ status: 200, body: { protocol: 1, member: 'ns1.alpha.test' } })
function harness(overrides: Partial<DnsClusterWorkspaceHelpers> = {}, caller = ROOT) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const callHost = vi.fn(async (_caller: AuthenticatedCaller, path: string, _body?: Record<string, unknown>): Promise<unknown> => path === '/host/dns-cluster' ? { members: { 'ns2.beta.test': { state: 'outage', failures: 2 } }, conflicts: [{ member: 'ns2.beta.test', zone: 'one.test', state: 'conflict', reason: 'modified_here', serial: 5, at: '2026-11-07T12:00:00.000Z' }], pin: PIN } : { observedAt: 'now', mode: 'push', members: [] })
  const helpers = {
    requireCaller: vi.fn(async () => caller), assertRoot: vi.fn(async (current: AuthenticatedCaller) => { if (current.principal.kind !== 'root') fail('FORBIDDEN', 'root required', { stateChanged: false }) }),
    emitAudit: vi.fn(async () => undefined), store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }) }, callHost, call: hello, now: () => new Date('2026-11-07T12:00:00.000Z'), ...overrides,
  } as unknown as DnsClusterWorkspaceHelpers
  const send = async (path: string, method = 'GET', body?: unknown): Promise<Response> => (await handleDnsClusterWorkspaceRoute(new Request('http://api.test/api/server/dns-cluster' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://api.test/api/server/dns-cluster' + path), method, helpers))!
  const view = async (): Promise<{ revision: string; members: Record<string, unknown>[]; inbound: Record<string, unknown>[]; enabled: boolean }> => (await send('')).json() as never
  return { helpers, send, view, callHost }
}
const memberBody = (expectedRevision: string, over: Record<string, unknown> = {}) => ({ name: 'ns2.beta.test', address: '192.0.2.2', port: 2087, pin: PIN, token: TOKEN, role: 'synchronize', expectedRevision, ...over })
const saved = async (): Promise<string> => readFile(join(root, DNS_CLUSTER_STATE), 'utf8')

describe('dns cluster workspace', () => {
  it('is root only and shows a default that is off', async () => {
    await expect(harness({}, OWNER).send('')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await harness().view()).toMatchObject({ state: 'default', enabled: false, failureThreshold: 10, members: [], inbound: [], observation: 'read', pin: PIN })
  })
  it('stores a member only after its pin and token were proved, in a 0600 file, and no view ever carries the token', async () => {
    const h = harness()
    const added = await h.send('/members', 'POST', memberBody(dnsClusterRevision(null)))
    const text = await added.text()
    expect(text).not.toContain('xpdc_')
    expect(JSON.parse(text)).toMatchObject({ state: 'saved', members: [{ name: 'ns2.beta.test', role: 'synchronize', runtime: { state: 'outage' } }], conflicts: [{ zone: 'one.test' }] })
    expect((await stat(join(root, DNS_CLUSTER_STATE))).mode & 0o777).toBe(0o600)
    expect(await saved()).toContain(TOKEN)
    expect(JSON.stringify((h.helpers.emitAudit as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('xpdc_')
    expect(await (await h.send('')).text()).not.toContain('xpdc_')
  })
  it.each([
    ['pin_mismatch', (async () => { throw new DnsClusterTransportError('pin_mismatch') }) as DnsClusterCall],
    ['member_unreachable', (async () => { throw new DnsClusterTransportError('unreachable') }) as DnsClusterCall],
    ['tls_failed', (async () => { throw new DnsClusterTransportError('tls_failed') }) as DnsClusterCall],
    ['token_invalid', (async () => ({ status: 401, body: { code: 'token_invalid' } })) as DnsClusterCall],
    ['address_not_allowed', (async () => ({ status: 403, body: { code: 'address_not_allowed' } })) as DnsClusterCall],
    ['protocol_mismatch', (async () => ({ status: 200, body: { protocol: 2 } })) as DnsClusterCall],
  ])('refuses a member with %s and saves nothing', async (reason, call) => {
    await expect(harness({ call }).send('/members', 'POST', memberBody(dnsClusterRevision(null)))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason, stateChanged: false } })
    await expect(saved()).rejects.toThrow()
  })
  it('validates the member fields before it calls out', async () => {
    const call = vi.fn(hello), h = harness({ call })
    const revision = dnsClusterRevision(null)
    for (const over of [{ name: 'single' }, { address: 'ns2.beta.test' }, { port: 0 }, { pin: 'abc' }, { token: 'short' }, { role: 'primary' }]) await expect(h.send('/members', 'POST', memberBody(revision, over))).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(call).not.toHaveBeenCalled()
  })
  it('refuses a stale revision and a duplicate member', async () => {
    const h = harness()
    await h.send('/members', 'POST', memberBody(dnsClusterRevision(null)))
    await expect(h.send('/members', 'POST', memberBody(dnsClusterRevision(null)))).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(h.send('/members', 'POST', memberBody((await h.view()).revision))).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'member_exists' } })
  })
  it('returns an issued token once and keeps only its hash', async () => {
    const h = harness()
    const issued = await (await h.send('/inbound', 'POST', { name: 'ns1.alpha.test', address: '192.0.2.1', expectedRevision: dnsClusterRevision(null) })).json() as { token: string; inbound: Record<string, unknown>[] }
    expect(issued.token).toMatch(/^xpdc_[A-Za-z0-9_-]{43}$/)
    expect(issued.inbound).toEqual([{ name: 'ns1.alpha.test', address: '192.0.2.1', hint: issued.token.slice(-4), createdAt: '2026-11-07T12:00:00.000Z' }])
    expect(await saved()).not.toContain(issued.token)
    const after = await (await h.send('')).text()
    expect(after).not.toContain(issued.token); expect(after).not.toContain('tokenHash'); expect(after).not.toContain('issuedBy')
    const next = await (await h.send('/inbound/ns1.alpha.test', 'DELETE', { expectedRevision: JSON.parse(after).revision })).json() as { inbound: unknown[] }
    expect(next.inbound).toEqual([])
  })
  it('turns clustering on and bounds the threshold', async () => {
    const h = harness()
    await expect(h.send('', 'PUT', { enabled: true, failureThreshold: 0, expectedRevision: dnsClusterRevision(null) })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await (await h.send('', 'PUT', { enabled: true, failureThreshold: 5, expectedRevision: dnsClusterRevision(null) })).json()).toMatchObject({ enabled: true, failureThreshold: 5 })
  })
  it('proves a new pin before it replaces the one that works', async () => {
    const h = harness()
    await h.send('/members', 'POST', memberBody(dnsClusterRevision(null)))
    const revision = (await h.view()).revision, refused = harness({ call: async () => { throw new DnsClusterTransportError('pin_mismatch') } })
    await expect(refused.send('/members/ns2.beta.test', 'PUT', { role: 'write-only', pin: 'e'.repeat(64), token: null, expectedRevision: revision })).rejects.toMatchObject({ detail: { reason: 'pin_mismatch' } })
    expect(await saved()).toContain(PIN)
    expect(await (await h.send('/members/ns2.beta.test', 'PUT', { role: 'write-only', pin: null, token: null, expectedRevision: revision })).json()).toMatchObject({ members: [{ role: 'write-only' }] })
  })
  it('passes sync and re-enable to the agent, and refuses them without one', async () => {
    const h = harness()
    const body = { mode: 'push', zone: 'one.test', member: null, includeMissing: false, force: false }
    expect(await (await h.send('/sync', 'POST', body)).json()).toMatchObject({ mode: 'push' })
    expect(h.callHost).toHaveBeenCalledWith(expect.anything(), '/host/dns-cluster/sync', body)
    await h.send('/members/ns2.beta.test/reset', 'POST', {})
    expect(h.callHost).toHaveBeenCalledWith(expect.anything(), '/host/dns-cluster/reset', { member: 'ns2.beta.test' })
    const lone = harness({ callHost: undefined as never })
    await expect(lone.send('/sync', 'POST', body)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'host_agent_unavailable' } })
    expect(await lone.view()).toMatchObject({ observation: 'unavailable', pin: null })
  })
})
