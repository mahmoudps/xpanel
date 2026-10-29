import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain } from '@xpanel/core'
import type { StateStore, StoredCertificate } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { certificateWorkspaceRevision, createCertificateWorkspaceRouter, projectWorkspaceCertificate } from './certificate-workspace.ts'

// Pure projection/route contract tests. Authentication, CSRF and agent admission belong to the
// mounted API's loopback integration acceptance; this file does not claim them.
const id = (value: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(value).padStart(12, '0')
const account = { id: id(1), username: 'alice', ownerId: null, status: 'active' } as Account
const domain = { id: id(2), accountId: account.id, name: 'example.test', certificateId: id(3) } as Domain
const certificate: StoredCertificate = { id: id(3), accountId: account.id, names: ['example.test'], source: 'upload', challenge: null,
  notBefore: '2025-01-01T00:00:00.000Z', notAfter: '2028-01-01T00:00:00.000Z', autoRenew: false,
  certPath: '/private-host-only/certificate.pem', keyPath: '/private-host-only/private-key.pem', chainPath: '/private-host-only/chain.pem',
  fingerprintSha256: 'a'.repeat(64), lastError: 'PRIVATE-DIAGNOSTIC-DO-NOT-RETURN', renewedAt: null }
const fixture = () => {
  const snapshot = { revision: 7, accounts: [structuredClone(account)], domains: [structuredClone(domain)], certificates: [structuredClone(certificate)] }
  const store = { listAccounts: async () => snapshot.accounts, readSnapshot: async () => snapshot } as unknown as StateStore
  const principal = { kind: 'root' as const, id: id(9), username: 'root' }
  const caller: AuthenticatedCaller = {
    principal,
    principalRecord: { ...principal, passwordHash: 'unused-unit-verifier', forcePasswordChange: false,
      totpSecretEnc: null, totpEnabled: false, totpRecoveryHashes: [], totpLastStep: null,
      accountId: null, disabled: false, lastLoginAt: null,
      createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z' },
    sessionId: null, sessionToken: null, apiTokenId: null, scopes: ['*'], csrfValid: true, mfaVerified: true,
  }
  const remove = vi.fn(async (_input: unknown) => { snapshot.certificates = []; snapshot.domains.forEach(domain => { domain.certificateId = null }); return { status: 'unverified' } })
  const install = vi.fn(async (_input: unknown) => ({ certificate }))
  const router = createCertificateWorkspaceRouter({ store, requireCaller: async () => caller, assertAdministrator: async () => {}, assertCanReadAccount: async () => {}, assertCanWriteAccount: async () => {}, removeCertificate: remove, installCertificate: install })
  const request = (path = '/api/certificate-workspace', method = 'GET', body?: unknown) => {
    const url = new URL(path, 'http://localhost')
    return router(new Request(url, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }), url, method)
  }
  return { snapshot, request, remove, install, router }
}

describe('certificate workspace projection and route contract', () => {
  it('projects only public certificate metadata and readable account/domain labels', () => {
    const projected = projectWorkspaceCertificate(certificate, new Map([[account.id, account]]), [domain])
    expect(projected).toMatchObject({ username: 'alice', names: ['example.test'], assignedDomains: ['example.test'], fingerprintSha256: 'a'.repeat(64) })
    for (const field of ['certPath', 'keyPath', 'chainPath', 'lastError']) expect(Object.hasOwn(projected, field)).toBe(false)
    expect(JSON.stringify(projected)).not.toContain('/private-host-only')
    expect(JSON.stringify(projected)).not.toContain('PRIVATE-DIAGNOSTIC')
  })
  it('requires an actual saved authority revision', () => {
    expect(certificateWorkspaceRevision(0)).toBe(0)
    expect(certificateWorkspaceRevision(7)).toBe(7)
    for (const value of [null, undefined, '7', -1, 1.5, Number.NaN]) expect(() => certificateWorkspaceRevision(value)).toThrow()
  })
  it('reads sanitized persisted metadata without paths or a served-TLS claim', async () => {
    const f = fixture(), response = await f.request()
    expect(response?.status).toBe(200)
    const text = await response!.text()
    expect(text).not.toContain('/private-host-only')
    expect(text).not.toContain('PRIVATE-DIAGNOSTIC')
    expect(JSON.parse(text)).toMatchObject({ revision: 7, capabilities: { install: true }, application: { servedTlsVerified: false } })
    expect(f.remove).not.toHaveBeenCalled(); expect(f.install).not.toHaveBeenCalled()
  })
  it('refuses account selectors, stale revisions and unexpected removal properties without invoking a mutation', async () => {
    const f = fixture()
    await expect(f.request('/api/certificate-workspace?accountId=' + id(8))).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    await expect(f.request('/api/certificate-workspace/' + certificate.id, 'DELETE', { expectedRevision: 6 })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(f.request('/api/certificate-workspace/' + certificate.id, 'DELETE', { expectedRevision: 7, accountId: id(8) })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(f.remove).not.toHaveBeenCalled()
  })
  it('dispatches only the reviewed stored certificate to the trusted mutation port', async () => {
    const f = fixture(), response = await f.request('/api/certificate-workspace/' + certificate.id, 'DELETE', { expectedRevision: 7 })
    expect(response?.status).toBe(200)
    expect(await response!.json()).toMatchObject({ ok: true, removedCertificateId: certificate.id, application: { revocationPerformed: false, servedTlsVerified: false } })
    expect(f.remove).toHaveBeenCalledOnce()
    expect(f.remove.mock.calls[0]![0]).toMatchObject({ expectedRevision: 7, certificate })
  })
  it('rejects malformed JSON and missing media type without leaking request contents', async () => {
    const f = fixture(), path = '/api/certificate-workspace/' + certificate.id, url = new URL(path, 'http://localhost')
    for (const headers of [{ 'content-type': 'application/json' }, {}] as HeadersInit[]) await expect(f.router(new Request(url, { method: 'DELETE', headers, body: 'PRIVATE-REQUEST-CONTENT' }), url, 'DELETE')).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(f.remove).not.toHaveBeenCalled()
  })
  it('refuses unknown manual-install fields, foreign domains and oversized input before host dispatch', async () => {
    const f = fixture(), body = { username: 'alice', domain: 'example.test', expectedRevision: 7, fullchainPem: 'synthetic-chain', privateKeyPem: 'synthetic-key' }
    await expect(f.request('/api/certificate-workspace/install', 'POST', { ...body, certificateId: id(3) })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.request('/api/certificate-workspace/install', 'POST', { ...body, domain: 'foreign.test' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(f.request('/api/certificate-workspace/install', 'POST', { ...body, privateKeyPem: 'x'.repeat(32 * 1024 + 1) })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(f.install).not.toHaveBeenCalled()
  })
  it('returns only sanitized stored data after the trusted install port acknowledges the selected owner/domain', async () => {
    const f = fixture(), response = await f.request('/api/certificate-workspace/install', 'POST', { username: 'alice', domain: 'example.test', expectedRevision: 7, fullchainPem: 'synthetic-chain', privateKeyPem: 'synthetic-key' })
    expect(response?.status).toBe(200)
    const text = await response!.text()
    expect(text).not.toContain('/private-host-only')
    expect(text).not.toContain('synthetic-key')
    expect(f.install).toHaveBeenCalledOnce()
  })
})
