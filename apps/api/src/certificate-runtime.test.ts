import { X509Certificate, createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, AuditEntry, Domain } from '@xpanel/core'
import { services } from '@xpanel/render'
import type { CertificateMutationOptions, NewCertificate, StateStore, StoredCertificate } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { createCertificateRuntimeRouter } from './certificate-runtime.ts'

// Trusted-port portable contract fixtures; these do not qualify mounted HTTP auth or a native host.
const id = (value: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(value).padStart(12, '0')
// Self-signed EC P-256 leaf for example.test built with a minimal DER encoder; manual uploads are validated before the agent port.
const der = (tag: number, ...parts: Buffer[]): Buffer => { const body = Buffer.concat(parts), length: number[] = []; if (body.length > 127) for (let value = body.length; value; value >>>= 8) length.unshift(value & 255); return Buffer.concat([Buffer.from([tag]), Buffer.from(length.length ? [128 | length.length, ...length] : [body.length]), body]) }
const manualPem = (() => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), seq = (...parts: Buffer[]) => der(0x30, ...parts), oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'))
  const alg = seq(oid('2a8648ce3d040302')), name = seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from('example.test')))))
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), alg, name, seq(der(0x17, Buffer.from('250101000000Z')), der(0x17, Buffer.from('491231000000Z'))), name,
    pair.publicKey.export({ format: 'der', type: 'spki' }), der(0xa3, seq(seq(oid('551d11'), der(0x04, seq(der(0x82, Buffer.from('example.test'))))))))
  const bytes = seq(tbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, pair.privateKey)])))
  return { fullchainPem: '-----BEGIN CERTIFICATE-----\n' + bytes.toString('base64').match(/.{1,64}/g)!.join('\n') + '\n-----END CERTIFICATE-----\n', privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }
})()
const fixture = (hostAvailable = true) => {
  const account = { id: id(1), username: 'alice', ownerId: null, status: 'active' } as Account
  const domain = { id: id(2), accountId: account.id, name: 'example.test', certificateId: id(3) } as Domain
  const certificate: StoredCertificate = { id: id(3), accountId: account.id, names: ['example.test', 'www.example.test'], source: 'acme', challenge: 'http-01',
    notBefore: null, notAfter: '2028-01-01T00:00:00.000Z', autoRenew: true, certPath: services.certFiles(id(3)).fullchain, keyPath: services.certFiles(id(3)).privkey,
    chainPath: null, fingerprintSha256: 'a'.repeat(64), lastError: null, renewedAt: null }
  const snapshot = { revision: 7, accounts: [account], domains: [domain], certificates: [certificate] }
  const principal = { id: id(9), kind: 'root' as const, username: 'root' }
  const caller: AuthenticatedCaller = { principal, principalRecord: { ...principal, passwordHash: 'unused-port-verifier', forcePasswordChange: false,
    totpSecretEnc: null, totpEnabled: false, totpRecoveryHashes: [], totpLastStep: null, accountId: null, disabled: false, lastLoginAt: null,
    createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z' }, sessionId: null, sessionToken: null, apiTokenId: null, scopes: ['*'], csrfValid: true, mfaVerified: true }
  let ackMode = 'normal', guardDenied = false, applyVerified = true
  const save = vi.fn(async (input: NewCertificate, domainId: string, opts: CertificateMutationOptions) => {
    await opts.certificateGuard?.(snapshot.certificates.find(row => row.id === input.id) ?? null, snapshot.domains)
    if (guardDenied) fail('FORBIDDEN', 'synthetic authorization revoked', { stateChanged: false })
    const saved = { ...certificate, ...input, id: input.id!, chainPath: null, lastError: null, renewedAt: null } as StoredCertificate
    snapshot.certificates = [...snapshot.certificates.filter(row => row.id !== saved.id), saved]
    snapshot.domains.find(row => row.id === domainId)!.certificateId = saved.id; snapshot.revision++
    return saved
  })
  const remove = vi.fn(async (certificateId: string, opts: CertificateMutationOptions) => {
    await opts.certificateGuard?.(snapshot.certificates.find(row => row.id === certificateId) ?? null, snapshot.domains)
    snapshot.certificates = snapshot.certificates.filter(row => row.id !== certificateId); snapshot.domains.forEach(row => { if (row.certificateId === certificateId) row.certificateId = null }); snapshot.revision++; return true
  })
  const store = { getAccount: async () => account, getAccountByUsername: async (name: string) => name === account.username ? account : null,
    getRevision: async () => snapshot.revision, readSnapshot: async () => snapshot, listAccounts: async () => snapshot.accounts,
    listDomains: async () => snapshot.domains, saveCertificateBinding: save, deleteCertificate: remove } as unknown as StateStore
  const agent = vi.fn(async (path: string, options: { body?: unknown }) => {
    if (!options.body) return new Response(JSON.stringify(path.startsWith('/host/') ? { state: 'missing', status: null, timer: { state: 'unavailable' } }
      : { scope: 'authorized_saved_certificate_ids', inventoryComplete: false, rows: [] }), { headers: { 'content-type': 'application/json' } })
    const body = options.body as Record<string, unknown>, manual = body.operation === 'install', certId = manual ? id(5) : typeof body.certificateId === 'string' ? body.certificateId : id(6)
    const paths = services.certFiles(certId), uploaded = manual ? new X509Certificate(String(body.fullchainPem)) : null
    return new Response(JSON.stringify({ certificate: { id: certId, names: ackMode === 'shrunk' ? ['example.test'] : manual || !body.certificateId ? ['example.test'] : certificate.names,
      notAfter: uploaded ? new Date(uploaded.validTo).toISOString() : '2029-01-01T00:00:00.000Z', fingerprintSha256: uploaded ? createHash('sha256').update(uploaded.raw).digest('hex') : 'b'.repeat(64), certPath: ackMode === 'foreign-path' ? '/private/other.pem' : paths.fullchain, keyPath: paths.privkey } }), { headers: { 'content-type': 'application/json' } })
  })
  const audit = vi.fn(async () => ({}) as AuditEntry)
  const router = createCertificateRuntimeRouter({ store, hostAvailable, requireCaller: async () => caller, assertCanAccessAccount: async () => {}, assertCanBindCertificate: async () => {},
    resolveResellerForCaller: async () => null, callAgent: agent, triggerReconcile: async () => ({ ok: true, status: 200, body: { status: 'applied', ...(applyVerified ? { generation: { id: 3, status: 'active', checksum: 'c'.repeat(64) } } : {}) } }), emitAudit: audit,
    requireHostAgent: () => { if (!hostAvailable) fail('PRECONDITION_FAILED', 'host is unavailable', { stateChanged: false }) }, readJsonBody: async request => await request.json() as Record<string, unknown>, jsonResponse: body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }) })
  const request = (path: string, method = 'GET', body?: unknown) => { const url = new URL(path, 'http://localhost'); return router(new Request(url, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }), url, method) }
  return { account, domain, certificate, snapshot, caller, save, remove, agent, audit, request, setAck: (mode: string) => { ackMode = mode }, revokeGuard: () => { guardDenied = true }, unverifyApply: () => { applyVerified = false } }
}

describe('certificate runtime trusted-port contract', () => {
  it('declares absent native write capability and does not mutate stored configuration', async () => {
    const f = fixture(false), response = await f.request('/api/certificate-workspace')
    expect(await response!.json()).toMatchObject({ capabilities: { issue: false, renew: false, install: false, remove: false } })
    await expect(f.request('/api/certificate-workspace/' + f.certificate.id, 'DELETE', { expectedRevision: 7 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(f.remove).not.toHaveBeenCalled(); expect(f.agent).not.toHaveBeenCalled()
  })
  it('refuses foreign/stale renewal identities and unsupported DNS renewal before host dispatch', async () => {
    const f = fixture(), path = '/api/accounts/alice/certificates'
    await expect(f.request(path, 'POST', { domain: 'example.test', certificateId: id(8), expectedRevision: 7 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(f.request(path, 'POST', { domain: 'example.test', certificateId: id(3), expectedRevision: 6 })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    f.certificate.challenge = 'dns-01'
    await expect(f.request(path, 'POST', { domain: 'example.test', certificateId: id(3), expectedRevision: 7 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    Reflect.deleteProperty(f.snapshot, 'revision')
    await expect(f.request(path, 'POST', { domain: 'example.test' })).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(f.agent).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled()
  })
  it('keeps every existing SAN and uses one guarded atomic state save before acknowledging renewal', async () => {
    const f = fixture(), response = await f.request('/api/accounts/alice/certificates', 'POST', { domain: 'example.test', certificateId: id(3), expectedRevision: 7 })
    expect(response?.status).toBe(200); expect(f.save).toHaveBeenCalledOnce()
    expect(f.save.mock.calls[0]![0].names).toEqual(['example.test', 'www.example.test'])
    expect(f.save.mock.calls[0]![2]).toMatchObject({ expectedRevision: 7, certificateGuard: expect.any(Function) })
    const text = await response!.text(); expect(text).not.toMatch(/certPath|keyPath|BEGIN PRIVATE KEY/)
    expect(JSON.parse(text)).toMatchObject({ certificate: { names: ['example.test', 'www.example.test'] }, application: { servedTlsVerified: false } })
  })
  it('rejects a shrunk renewal acknowledgement before changing metadata', async () => {
    const f = fixture(); f.setAck('shrunk')
    await expect(f.request('/api/accounts/alice/certificates', 'POST', { domain: 'example.test', certificateId: id(3), expectedRevision: 7 })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    expect(f.save).not.toHaveBeenCalled(); expect(f.snapshot.revision).toBe(7)
  })
  it('forwards a manual key only across the protected agent port and projects stored readback', async () => {
    const f = fixture(), keyLine = manualPem.privateKeyPem.split('\n')[1]!, response = await f.request('/api/certificate-workspace/install', 'POST', { username: 'alice', domain: 'example.test', expectedRevision: 7, ...manualPem })
    expect(response?.status).toBe(200)
    expect(f.agent.mock.calls[0]![1].body).toEqual({ operation: 'install', domain: 'example.test', expectedRevision: 7, ...manualPem })
    const text = await response!.text(); expect(text).not.toMatch(/PRIVATE KEY|keyPath|certPath/); expect(text).not.toContain(keyLine)
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain(keyLine)
    await expect(f.request('/api/certificate-workspace/install', 'POST', { username: 'alice', domain: 'example.test', expectedRevision: 8, fullchainPem: 'synthetic-chain', privateKeyPem: 'synthetic-private-key' })).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'certificate_format', stateChanged: false } })
    expect(f.agent).toHaveBeenCalledOnce()
  })
  it('reports uncertainty if authorization is revoked after candidate preparation', async () => {
    const f = fixture(); f.revokeGuard()
    await expect(f.request('/api/accounts/alice/certificates', 'POST', { domain: 'example.test', expectedRevision: 7 })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    expect(f.snapshot.revision).toBe(7)
    const unverified = fixture(); unverified.unverifyApply()
    await expect(unverified.request('/api/accounts/alice/certificates', 'POST', { domain: 'example.test', expectedRevision: 7 })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { verificationRequired: true, unknownOutcome: true } })
  })
  it('removes stored assignments through the guarded port without claiming CA revocation', async () => {
    const f = fixture(), response = await f.request('/api/certificate-workspace/' + f.certificate.id, 'DELETE', { expectedRevision: 7 })
    expect(f.remove).toHaveBeenCalledOnce(); expect(f.snapshot.domains[0]!.certificateId).toBeNull()
    expect(await response!.json()).toMatchObject({ ok: true, application: { revocationPerformed: false, servedTlsVerified: false } })
  })
  it('uses only already authorized account observations and marks inventory and scheduler incomplete', async () => {
    const f = fixture(), response = await f.request('/api/certificate-workspace/observations')
    expect(await response!.json()).toMatchObject({ scope: 'authorized_saved_certificate_ids', inventoryComplete: false, inspectedAccounts: 1, scheduler: { state: 'unavailable', nextRunAt: null } })
    expect(f.agent.mock.calls.map(call => call[0])).toEqual(['/accounts/alice/certificates?limit=1', '/host/management-tls-observation'])
    expect(f.save).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled()
  })
})
