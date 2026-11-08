import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import { services } from '@xpanel/render'
import { AUTOSSL_DEFAULT } from '../../agent/src/mail-cert-policy.ts'
import { AUTOSSL_STATE, autoSslCandidates, autoSslReportable, caaAllows, nextAutoSslRun, readAutoSslScheduler, requestAutoSslRun, runAutoSslTick } from './autossl.ts'
import type { AutoSslPorts, AutoSslSnapshot, AutoSslState } from './autossl.ts'

const NOW = new Date('2026-11-07T12:00:00.000Z')
const days = (count: number): string => new Date(NOW.getTime() + count * 86_400_000).toISOString()
const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', status: 'active' as const }
const domain = (name: string, certificateId: string | null) => ({ id: name, accountId: account.id, name, certificateId })
const certificate = (id: string, source: string, expires: number, names: string[], extra: Record<string, unknown> = {}) => ({ id, accountId: account.id, names, source, challenge: source === 'acme' ? 'http-01' : null, autoRenew: source !== 'upload', notAfter: days(expires), ...extra }) as never
const snapshot = (domains: AutoSslSnapshot['domains'], certificates: AutoSslSnapshot['certificates']): AutoSslSnapshot => ({ accounts: [account], domains, certificates })

describe('AutoSSL candidates', { tags: ['unit'] }, () => {
  it('never replaces a valid uploaded certificate expiring in 10 days', () => {
    const view = snapshot([domain('paid.test', 'c1')], [certificate('c1', 'upload', 10, ['paid.test'])])
    expect(autoSslCandidates(view, AUTOSSL_DEFAULT, NOW)).toEqual([])
    expect(autoSslCandidates(view, { ...AUTOSSL_DEFAULT, replaceInvalid: true }, NOW)).toEqual([])
  })
  it('replaces an expiring upload only with replacement on', () => {
    const view = snapshot([domain('paid.test', 'c1')], [certificate('c1', 'upload', 2, ['paid.test'])])
    expect(autoSslCandidates(view, AUTOSSL_DEFAULT, NOW)).toEqual([])
    expect(autoSslCandidates(view, { ...AUTOSSL_DEFAULT, replaceInvalid: true }, NOW)).toEqual([{ username: 'alice', domain: 'paid.test', certificateId: null, reason: 'replacement' }])
  })
  it('orders for a domain without a certificate and renews a shared certificate once', () => {
    const view = snapshot([domain('new.test', null), domain('a.test', 'c1'), domain('b.test', 'c1')], [certificate('c1', 'acme', 20, ['a.test', 'b.test'])])
    expect(autoSslCandidates(view, AUTOSSL_DEFAULT, NOW)).toEqual([{ username: 'alice', domain: 'new.test', certificateId: null, reason: 'missing' }, { username: 'alice', domain: 'a.test', certificateId: 'c1', reason: 'renewal' }])
  })
  it('leaves out a current certificate, DNS-01, an excluded account or domain and another account on request', () => {
    const view = snapshot([domain('ok.test', 'c1'), domain('dns.test', 'c2'), domain('skip.test', null)], [certificate('c1', 'acme', 60, ['ok.test']), certificate('c2', 'acme', 5, ['dns.test'], { challenge: 'dns-01' })])
    expect(autoSslCandidates(view, { ...AUTOSSL_DEFAULT, excludedDomains: ['skip.test'] }, NOW)).toEqual([])
    expect(autoSslCandidates(view, { ...AUTOSSL_DEFAULT, excludedAccounts: ['alice'] }, NOW)).toEqual([])
    expect(autoSslCandidates(view, AUTOSSL_DEFAULT, NOW, 'bob')).toEqual([])
  })
})

describe('CAA pre-check', { tags: ['unit'] }, () => {
  const nothing = Object.assign(new Error('none'), { code: 'ENODATA' })
  it('allows a name with no CAA anywhere', async () => expect(await caaAllows('www.example.test', async () => { throw nothing })).toBe(true))
  it('uses the closest set while climbing', async () => {
    const resolve = vi.fn(async (name: string) => { if (name === 'example.test') return [{ tag: 'issue', value: 'digicert.com' }]; throw nothing })
    expect(await caaAllows('www.example.test', resolve)).toBe(false)
    expect(resolve.mock.calls.map(call => call[0])).toEqual(['www.example.test', 'example.test'])
  })
  it('accepts the provider with parameters, and a set without an issue tag', async () => {
    expect(await caaAllows('example.test', async () => [{ tag: 'issue', value: 'letsencrypt.org; validationmethods=http-01' }])).toBe(true)
    expect(await caaAllows('example.test', async () => [{ tag: 'iodef', value: 'mailto:a@example.test' }])).toBe(true)
  })
  it('passes a resolver failure up, so the order waits', async () => {
    await expect(caaAllows('example.test', async () => { throw Object.assign(new Error('x'), { code: 'ESERVFAIL' }) })).rejects.toThrow()
  })
})

it('picks one fixed hour per host, always in the future', { tags: ['unit'] }, () => {
  const first = nextAutoSslRun(NOW, 'server.test'), hour = new Date(first).getUTCHours()
  expect(Date.parse(first)).toBeGreaterThan(NOW.getTime())
  expect(hour).toBeGreaterThanOrEqual(1); expect(hour).toBeLessThan(5)
  expect(nextAutoSslRun(new Date(first), 'server.test')).toBe(new Date(Date.parse(first) + 86_400_000).toISOString())
})

describe('AutoSSL ticks', { tags: ['unit'] }, () => {
  let root = ''
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-autossl-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  const state = (): Promise<AutoSslState> => readJsonIfExists<AutoSslState>(join(root, AUTOSSL_STATE)) as Promise<AutoSslState>
  const ack = (id: string, names: string[]) => { const files = services.certFiles(id); return new Response(JSON.stringify({ certificate: { id, names, notAfter: days(90), notBefore: days(0), fingerprintSha256: 'a'.repeat(64), certPath: files.fullchain, keyPath: files.privkey } })) }
  function harness(view: AutoSslSnapshot, overrides: Partial<AutoSslPorts> = {}) {
    const issued = vi.fn(async (path: string) => { const id = '22222222-2222-4222-8222-222222222222'; return ack(id, [path.includes('alice') ? 'new.test' : '']) })
    const saveCertificateBinding = vi.fn(async (input: { id: string }) => input)
    const store = { rootDir: root, readSnapshot: async () => ({ ...view, revision: 7 }), saveCertificateBinding } as unknown as AutoSslPorts['store']
    const ports: AutoSslPorts = { store, call: issued, reconcile: vi.fn(async () => true), audit: vi.fn(async () => undefined), report: vi.fn(async () => undefined), caa: async () => [], resolves: async () => true, seed: 'server.test', now: () => NOW, ...overrides }
    return { ports, issued, saveCertificateBinding }
  }
  const due = async (): Promise<void> => { await atomicWriteJson(join(root, AUTOSSL_STATE), { version: 1, nextRunAt: days(-1), lastRunAt: null, pending: null, queue: [], log: [], unreported: [] }) }

  it('writes a schedule on the first tick and reports it as active', async () => {
    const { ports, issued } = harness(snapshot([], []))
    expect((await readAutoSslScheduler(ports.store)).state).toBe('unavailable')
    await runAutoSslTick(ports)
    expect(issued).not.toHaveBeenCalled()
    expect(await readAutoSslScheduler(ports.store)).toMatchObject({ state: 'active', reason: null })
  })
  it('orders a due domain, saves the binding, reconciles, audits and logs', async () => {
    await due()
    const { ports, issued, saveCertificateBinding } = harness(snapshot([domain('new.test', null)], []))
    await runAutoSslTick(ports)
    expect(issued).toHaveBeenCalledWith('/accounts/alice/certificates', { method: 'POST', body: { domain: 'new.test', expectedRevision: 7 } })
    expect(saveCertificateBinding).toHaveBeenCalledWith(expect.objectContaining({ source: 'acme', challenge: 'http-01', autoRenew: true }), 'new.test', expect.objectContaining({ expectedRevision: 7 }))
    expect(ports.reconcile).toHaveBeenCalled()
    expect(ports.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'certificate.issued', target: 'domain:new.test' }))
    const after = await state()
    expect(after.queue).toEqual([]); expect(after.log[0]).toMatchObject({ domain: 'new.test', result: 'issued', trigger: 'nightly' })
    expect(ports.report).toHaveBeenCalledOnce()
  })
  it('skips a CAA refusal with no order placed', async () => {
    await due()
    const { ports, issued } = harness(snapshot([domain('new.test', null)], []), { caa: async () => [{ tag: 'issue', value: 'digicert.com' }] })
    await runAutoSslTick(ports)
    expect(issued).not.toHaveBeenCalled()
    expect((await state()).log[0]).toMatchObject({ result: 'skipped', code: 'caa_forbids' })
  })
  it('defers an unresolved name and backs off after a failed order', async () => {
    await due()
    const unresolved = harness(snapshot([domain('new.test', null)], []), { resolves: async () => false })
    await runAutoSslTick(unresolved.ports)
    expect(unresolved.issued).not.toHaveBeenCalled()
    const row = (await state()).queue[0]!
    expect(row).toMatchObject({ attempts: 1, lastCode: 'dns_unresolved' })
    expect(Date.parse(row.nextAttemptAt)).toBe(NOW.getTime() + 86_400_000)
  })
  it('places one order each tick', async () => {
    await due()
    const { ports, issued } = harness(snapshot([domain('new.test', null), domain('two.test', null)], []), { call: vi.fn(async () => new Response('{}', { status: 500 })) })
    await runAutoSslTick(ports)
    expect(ports.call).toHaveBeenCalledOnce()
    expect(issued).not.toHaveBeenCalled()
    expect((await state()).queue.map(row => row.domain)).toEqual(['new.test', 'two.test'])
  })
  it('runs for one account on request and stops when turned off', async () => {
    const { ports, issued } = harness(snapshot([domain('new.test', null)], []))
    await runAutoSslTick({ ...ports, resolves: async () => false })
    await requestAutoSslRun(ports.store, 'bob')
    await runAutoSslTick({ ...ports, resolves: async () => false })
    expect((await state()).pending).toBeNull()
    expect(issued).not.toHaveBeenCalled()
    await atomicWriteJson(join(root, 'extended/tls/autossl.json'), { version: 1, policy: { ...AUTOSSL_DEFAULT, enabled: false }, updatedAt: NOW.toISOString() })
    await runAutoSslTick(ports)
    expect(await readAutoSslScheduler(ports.store)).toMatchObject({ state: 'disabled', nextRunAt: null })
    expect((await state()).queue).toEqual([])
  })
})

it('filters a report by notice level', { tags: ['unit'] }, () => {
  const rows = (['renewed', 'skipped', 'deferred', 'failed'] as const).map(result => ({ at: '', trigger: 'nightly' as const, username: 'a', domain: 'd', result, code: null, message: '' }))
  expect(autoSslReportable(rows, 'all')).toHaveLength(4)
  expect(autoSslReportable(rows, 'problems').map(row => row.result)).toEqual(['skipped', 'deferred', 'failed'])
  expect(autoSslReportable(rows, 'failures').map(row => row.result)).toEqual(['failed'])
  expect(autoSslReportable(rows, 'none')).toEqual([])
})
