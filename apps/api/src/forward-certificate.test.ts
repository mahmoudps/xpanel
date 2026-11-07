import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SERVER_OPERATIONS_STATE } from '@xpanel/core'
import { edge } from '@xpanel/render'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readIssuedCertificate, recordForwardCertificate, renewForwardCertificates } from './forward-certificate.ts'
import { observeDomainResolution } from './domain-resolution.ts'

const CERT = '11111111-1111-4111-8111-111111111111'
const forward = { domain: 'old.example.test', url: 'https://new.example.test/', ip: '192.0.2.9', createdAt: '2026-11-07T00:00:00.000Z' }
describe('forward certificates', () => {
  let rootDir: string
  beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'fwd-')) })
  afterEach(() => rm(rootDir, { recursive: true, force: true }))
  const save = async () => { const path = join(rootDir, SERVER_OPERATIONS_STATE.domainForwards); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify([forward])) }

  it('reads only a complete host reply', () => {
    expect(readIssuedCertificate({ certificate: { id: CERT, names: ['a.test'], notAfter: 'x' } })?.id).toBe(CERT)
    expect(readIssuedCertificate({ certificate: { id: CERT } })).toBeNull()
    expect(readIssuedCertificate(null)).toBeNull()
  })
  it('records the certificate without an account', async () => {
    const store = { createCertificate: vi.fn(async () => ({})) }
    await recordForwardCertificate(store as never, { id: CERT, names: ['a.test'], notAfter: '2027-01-01T00:00:00.000Z' })
    expect(store.createCertificate).toHaveBeenCalledWith(expect.objectContaining({ id: CERT, accountId: null, source: 'acme', challenge: 'http-01', autoRenew: true }))
  })
  it('renews only a due certificate that belongs to a saved forward', async () => {
    await save()
    const due = { id: CERT, accountId: null, names: [forward.domain], notAfter: '2026-11-10T00:00:00.000Z', autoRenew: true, source: 'acme', challenge: 'http-01' }
    const other = { ...due, id: '22222222-2222-4222-8222-222222222222', names: ['host.example.test'] }
    const store = { rootDir, readSnapshot: vi.fn(async () => ({ certificates: [due, other] })), createCertificate: vi.fn(async () => ({})) }
    const call = vi.fn(async () => new Response(JSON.stringify({ certificate: { id: CERT, names: [forward.domain], notAfter: '2027-02-01T00:00:00.000Z' } })))
    await renewForwardCertificates(store as never, call, new Date('2026-11-07T00:00:00.000Z'))
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('/host/domain-forwards/certificate', { method: 'POST', body: { domain: forward.domain } })
    expect(store.createCertificate).toHaveBeenCalledTimes(1)
  })
  it('renders the 301 on 443 only with a certificate and answers ACME on 80', () => {
    const os = { paths: { nginxVhostDir: '/etc/nginx/conf.d' } } as never
    const plain = edge.domainForwardsFile([forward], os).content
    expect(plain).toContain('/.well-known/acme-challenge/')
    expect(plain).not.toContain(':443')
    const secure = edge.domainForwardsFile([forward], os, [{ id: CERT, accountId: null, names: [forward.domain] }]).content
    expect(secure).toContain('listen 192.0.2.9:443 ssl;')
    expect(secure).toContain(CERT)
    expect(edge.domainForwardsFile([forward], os, [{ id: CERT, accountId: 'a1', names: [forward.domain] }]).content).not.toContain(':443')
  })
})

describe('domain resolution', () => {
  it('tells here, elsewhere, unregistered and unknown apart', async () => {
    expect(await observeDomainResolution('a.test', ['192.0.2.1'], async () => ['192.0.2.1'])).toBe('here')
    expect(await observeDomainResolution('a.test', ['192.0.2.1'], async () => ['198.51.100.1'])).toBe('elsewhere')
    expect(await observeDomainResolution('a.test', [], async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }) })).toBe('unregistered')
    expect(await observeDomainResolution('a.test', [], async () => { throw Object.assign(new Error('x'), { code: 'ETIMEOUT' }) })).toBe('unknown')
  })
})
