import { X509Certificate, createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { assertAcl } from '@xpanel/core'
import type { Account, Domain, Reseller } from '@xpanel/core'
import { services } from '@xpanel/render'
import type { StateStore, StoredCertificate } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { assertAccountAuthorized, assertRequestAuthorized } from './authorization.ts'
import { createManualCertificateInstall, validateManualCertificateInstall } from './certificate-install.ts'
import { createCertificateWorkspaceRouter } from './certificate-workspace.ts'
import type { CertificateWorkspaceHelpers } from './certificate-workspace.ts'

// Runtime-generated X.509 chains (minimal DER encoder below) are portable fixtures; the host adapter and served TLS are not exercised.
const id = (value: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(value).padStart(12, '0')
const now = new Date('2026-10-27T12:00:00.000Z')
const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts), length: number[] = []
  if (body.length > 127) for (let value = body.length; value; value >>>= 8) length.unshift(value & 255)
  return Buffer.concat([Buffer.from([tag]), Buffer.from(length.length ? [128 | length.length, ...length] : [body.length]), body])
}
const seq = (...parts: Buffer[]) => der(0x30, ...parts)
const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'))
const dn = (cn: string) => seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from(cn)))))
const utc = (day: string) => der(0x17, Buffer.from(day.slice(2).replaceAll('-', '') + '000000Z'))
const issue = (o: { subject: string; issuer: string; key: KeyObject; signer: KeyObject; serial: number; ca?: boolean; names?: string[]; from?: string; to?: string }): string => {
  const alg = seq(oid('2a8648ce3d040302'))
  const extensions = [...o.ca ? [seq(oid('551d13'), der(0x01, Buffer.from([255])), der(0x04, seq(der(0x01, Buffer.from([255])))))] : [],
    ...o.names?.length ? [seq(oid('551d11'), der(0x04, seq(...o.names.map(name => der(0x82, Buffer.from(name))))))] : []]
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([o.serial])), alg, dn(o.issuer), seq(utc(o.from ?? '2026-01-01'), utc(o.to ?? '2027-12-31')),
    dn(o.subject), o.key.export({ type: 'spki', format: 'der' }), ...extensions.length ? [der(0xa3, seq(...extensions))] : [])
  const bytes = seq(tbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, o.signer)])))
  return '-----BEGIN CERTIFICATE-----\n' + bytes.toString('base64').match(/.{1,64}/g)!.join('\n') + '\n-----END CERTIFICATE-----\n'
}
const ec = (namedCurve = 'prime256v1') => generateKeyPairSync('ec', { namedCurve })
const pem = (key: KeyObject) => key.export({ type: 'pkcs8', format: 'pem' }) as string
const root = ec(), intermediate = ec(), otherCa = ec(), site = generateKeyPairSync('rsa', { modulusLength: 2048 }), other = ec('secp384r1')
const rootPem = issue({ subject: 'Portable Root', issuer: 'Portable Root', key: root.publicKey, signer: root.privateKey, serial: 1, ca: true })
const intermediatePem = issue({ subject: 'Portable Intermediate', issuer: 'Portable Root', key: intermediate.publicKey, signer: root.privateKey, serial: 2, ca: true })
const leaf = (o: { names?: string[]; from?: string; to?: string; key?: KeyObject; ca?: boolean } = {}) =>
  issue({ subject: 'example.test', issuer: 'Portable Intermediate', key: o.key ?? site.publicKey, signer: intermediate.privateKey, serial: 3, names: o.names ?? ['example.test', 'www.example.test'], ...o })
const chain = leaf() + intermediatePem + rootPem

const reseller = (value: number, acl: Reseller['acl']) => ({ id: id(value), username: 'reseller' + value, acl } as Reseller)
const caller = (principal: AuthenticatedCaller['principal']): AuthenticatedCaller => ({ principal, principalRecord: { ...principal, passwordHash: 'unused-unit-verifier', forcePasswordChange: false,
  totpSecretEnc: null, totpEnabled: false, totpRecoveryHashes: [], totpLastStep: null, accountId: null, disabled: false, lastLoginAt: null,
  createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z' }, sessionId: null, sessionToken: null, apiTokenId: null, scopes: ['*'], csrfValid: true, mfaVerified: true } as AuthenticatedCaller)
const rootCaller = caller({ kind: 'root', id: id(9), username: 'root' })
const fixture = () => {
  const accounts = [{ id: id(1), username: 'alice', ownerId: id(20), status: 'active', planId: id(30) }, { id: id(2), username: 'bob', ownerId: id(21), status: 'active', planId: id(30) }] as Account[]
  const domains = [{ id: id(11), accountId: id(1), name: 'example.test', certificateId: null }, { id: id(12), accountId: id(1), name: 'shop.test', certificateId: null },
    { id: id(13), accountId: id(2), name: 'foreign.test', certificateId: null }] as Domain[]
  const snapshot = { revision: 7, accounts, domains, certificates: [] as StoredCertificate[] }
  const resellers = [reseller(20, ['manage-ssl']), reseller(21, [])]
  let reads = 0, raceAfter = Infinity, tamper = false
  const store = { readSnapshot: async () => { if (++reads > raceAfter) snapshot.revision++; return snapshot }, getRevision: async () => snapshot.revision,
    listAccounts: async (filter?: { ownerId?: string }) => accounts.filter(account => !filter?.ownerId || account.ownerId === filter.ownerId),
    getAccount: async (accountId: string) => accounts.find(account => account.id === accountId) ?? null, getReseller: async (resellerId: string) => resellers.find(row => row.id === resellerId) ?? null,
    getPlan: async () => ({ featureListId: id(31) }), getFeatureList: async () => ({ disabled: [] }) } as unknown as StateStore
  // Stands in for the runtime's shared upload commit path (agent candidate + guarded binding + reconcile + audit).
  const commit = vi.fn<NonNullable<CertificateWorkspaceHelpers['installCertificate']>>(async ({ account, domain, body }) => {
    const first = new X509Certificate(body.fullchainPem.slice(0, body.fullchainPem.indexOf('-----END CERTIFICATE-----') + 25))
    const certificate: StoredCertificate = { id: id(99), accountId: account.id, names: [...new Set(first.subjectAltName!.split(', ').map(part => part.slice(4)))].sort(), source: 'upload', challenge: null,
      notBefore: new Date(first.validFrom).toISOString(), notAfter: new Date(first.validTo).toISOString(), autoRenew: false, certPath: services.certFiles(id(99)).fullchain, keyPath: services.certFiles(id(99)).privkey,
      chainPath: null, fingerprintSha256: tamper ? 'f'.repeat(64) : createHash('sha256').update(first.raw).digest('hex'), lastError: null, renewedAt: null }
    snapshot.certificates.push(certificate); domains.find(row => row.id === domain.id)!.certificateId = certificate.id; snapshot.revision++
    return { certificate, reconcile: { status: 'applied', scope: 'global_configuration', targetVerified: false, generation: { id: 3, status: 'active', checksum: 'c'.repeat(64) } } }
  })
  const install = createManualCertificateInstall({ store, install: commit, now: () => now })
  const post = (body: Record<string, unknown>, who = rootCaller) => {
    const router = createCertificateWorkspaceRouter({ store, requireCaller: async request => { await assertRequestAuthorized(store, who, request); return who },
      assertAdministrator: async current => { if (current.principal.kind === 'reseller') assertAcl(current.principal, await store.getReseller(current.principal.id), 'manage-ssl') },
      assertCanReadAccount: async () => {}, assertCanWriteAccount: (current, account) => assertAccountAuthorized(store, current, account, 'certificates'),
      removeCertificate: async () => ({}), installCertificate: install })
    const url = new URL('/api/certificate-workspace/install', 'http://localhost')
    return router(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', domain: 'example.test', expectedRevision: 7, fullchainPem: chain, privateKeyPem: pem(site.privateKey), ...body }) }), url, 'POST')
  }
  // race(): the router's read sees the saved revision; the next read (the install helper's) sees a newer one.
  return { snapshot, commit, install, post, race: () => { raceAfter = reads + 1 }, tamper: () => { tamper = true } }
}
const check = (fullchainPem: string, privateKeyPem = pem(site.privateKey), extra: { domain?: string; requiredNames?: unknown[] } = {}) => validateManualCertificateInstall({ accountId: id(1), domain: 'example.test',
  domains: [{ accountId: id(1), name: 'example.test' }, { accountId: id(1), name: 'shop.test' }, { accountId: id(2), name: 'foreign.test' }], now, fullchainPem, privateKeyPem, ...extra })
const reason = (run: () => unknown) => { try { run() } catch (error) { return (error as { detail?: { reason?: string } }).detail?.reason } return 'accepted' }

describe('manual certificate installation', () => {
  it('installs a verified chain through the shared commit path with normalized PEM and no key echo', async () => {
    const f = fixture(), leafPem = leaf(), messy = (leafPem +'\n\n' + intermediatePem + '\n' + rootPem).replaceAll('\n', '\r\n')
    const response = await f.post({ fullchainPem: messy })
    expect(response?.status).toBe(200)
    const text = await response!.text(), body = JSON.parse(text)
    expect(body).toMatchObject({ certificate: { names: ['example.test', 'www.example.test'], source: 'upload', assignedDomains: ['example.test'] }, reconcile: { status: 'applied' }, application: { scope: 'stored_configuration', servedTlsVerified: false } })
    expect(text).not.toMatch(/PRIVATE KEY|BEGIN CERTIFICATE|keyPath|certPath/)
    expect(f.commit).toHaveBeenCalledOnce()
    const forwarded = f.commit.mock.calls[0]![0].body
    expect(forwarded).toEqual({ username: 'alice', domain: 'example.test', expectedRevision: 7, fullchainPem: leafPem + intermediatePem + rootPem, privateKeyPem: pem(site.privateKey) })
  })
  it('requires the chosen www and alias names to be covered and owned by the account', () => {
    expect(check(chain, undefined, { requiredNames: ['www.example.test'] }).requiredNames).toEqual(['www.example.test'])
    expect(reason(() => check(chain, undefined, { requiredNames: ['shop.test'] }))).toBe('names')
    expect(reason(() => check(leaf({ names: ['example.test', 'shop.test'] }) + intermediatePem, undefined, { requiredNames: ['foreign.test'] }))).toBe('name_owner')
    expect(check(leaf({ names: ['example.test', 'shop.test'] }) + intermediatePem, undefined, { requiredNames: ['shop.test'] }).names).toEqual(['example.test', 'shop.test'])
    expect(reason(() => check(chain, undefined, { requiredNames: ['*.example.test'] }))).toBe('names')
  })
  it('refuses expired, not-yet-valid and CA leaf certificates', () => {
    expect(reason(() => check(leaf({ from: '2024-01-01', to: '2025-01-01' }) + intermediatePem))).toBe('expired')
    expect(reason(() => check(leaf({ from: '2027-01-01', to: '2028-01-01' }) + intermediatePem))).toBe('not_yet_valid')
    expect(reason(() => check(leaf({ ca: true }) + intermediatePem))).toBe('leaf_ca')
  })
  it('refuses a certificate whose SAN misses the domain or lists a foreign name', () => {
    expect(reason(() => check(leaf({ names: ['shop.test'] }) + intermediatePem))).toBe('names')
    expect(reason(() => check(leaf({ names: ['example.test', 'foreign.test'] }) + intermediatePem))).toBe('name_owner')
    expect(reason(() => check(leaf({ names: [] }) + intermediatePem))).toBe('names')
  })
  it('refuses a chain out of order or signed by a different key with the same issuer name', () => {
    expect(reason(() => check(leaf() + rootPem + intermediatePem))).toBe('chain_order')
    const impostor = issue({ subject: 'Portable Intermediate', issuer: 'Portable Root', key: otherCa.publicKey, signer: root.privateKey, serial: 4, ca: true })
    expect(reason(() => check(leaf() + impostor + rootPem))).toBe('chain_order')
    expect(reason(() => check(leaf() + leaf({ names: ['shop.test'] })))).toBe('chain_order')
    expect(check(leaf() + intermediatePem).names).toEqual(['example.test', 'www.example.test'])
  })
  it('refuses a mismatched, encrypted, weak or malformed private key without echoing it', () => {
    const mismatch = pem(other.privateKey)
    try { check(chain, mismatch); throw new Error('accepted') } catch (error) { expect(JSON.stringify(error)).not.toContain(mismatch.split('\n')[1]); expect((error as { detail: { reason: string } }).detail.reason).toBe('key_mismatch') }
    expect(reason(() => check(chain, site.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'portable' }) as string))).toBe('key_encrypted')
    expect(reason(() => check(chain, site.privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'portable' }) as string))).toBe('key_encrypted')
    expect(check(chain, site.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string).fingerprintSha256).toMatch(/^[0-9a-f]{64}$/)
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }), p521 = ec('secp521r1'), ed = generateKeyPairSync('ed25519')
    for (const pair of [weak, p521, ed]) expect(reason(() => check(leaf({ key: pair.publicKey }) + intermediatePem, pem(pair.privateKey)))).toBe('key_strength')
    const sec1 = other.privateKey.export({ type: 'sec1', format: 'pem' }) as string
    expect(check(leaf({ key: other.publicKey }) + intermediatePem, sec1).names).toEqual(['example.test', 'www.example.test'])
    expect(reason(() => check(chain, pem(site.privateKey) + pem(other.privateKey)))).toBe('key_format')
    expect(reason(() => check(chain, rootPem))).toBe('key_format')
    expect(reason(() => check(chain, 'not a key'))).toBe('key_format')
  })
  it('refuses foreign blocks, oversized material and too many certificates', () => {
    expect(reason(() => check(chain + pem(site.privateKey)))).toBe('certificate_format')
    expect(reason(() => check('junk\n' + chain))).toBe('certificate_format')
    expect(reason(() => check(chain.replace('MI', 'M!')))).toBe('certificate_format')
    expect(reason(() => check(chain + intermediatePem))).toBe('certificate_format')
    expect(reason(() => check(leaf() + (intermediatePem + rootPem).repeat(5)))).toBe('too_large')
    expect(reason(() => check(chain + '\n'.repeat(64 * 1024)))).toBe('too_large')
  })
  it('scopes resellers to owned accounts and to the manage-ssl privilege', async () => {
    const own = fixture(), ownReseller = caller({ kind: 'reseller', id: id(20), username: 'reseller20' })
    expect((await own.post({}, ownReseller))?.status).toBe(200)
    const foreign = fixture()
    await expect(foreign.post({ username: 'bob', domain: 'foreign.test', fullchainPem: leaf({ names: ['foreign.test'] }) + intermediatePem }, ownReseller)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(foreign.post({}, caller({ kind: 'reseller', id: id(21), username: 'reseller21' }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(foreign.post({ fullchainPem: leaf({ names: ['example.test', 'foreign.test'] }) + intermediatePem }, ownReseller)).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { reason: 'name_owner', stateChanged: false } })
    expect(foreign.commit).not.toHaveBeenCalled()
  })
  it('maps refusals to 422 validation, 403 and 409 conflict before any commit', async () => {
    const f = fixture()
    await expect(f.post({ fullchainPem: leaf({ from: '2024-01-01', to: '2025-01-01' }) })).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'expired', stateChanged: false } })
    await expect(f.post({ expectedRevision: 6 })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    await expect(f.post({ requiredNames: 'www.example.test' })).rejects.toMatchObject({ code: 'VALIDATION' })
    f.race()
    await expect(f.post({})).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(f.commit).not.toHaveBeenCalled()
  })
  it('reports verification required when the stored record is not the validated leaf', async () => {
    const f = fixture(); f.tamper()
    await expect(f.post({})).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    const failing = createManualCertificateInstall({ store: { readSnapshot: async () => ({ revision: 7, domains: [{ accountId: id(1), name: 'example.test' }] }) } as unknown as StateStore,
      install: async () => { throw new Error('transport') }, now: () => now })
    await expect(failing({ request: new Request('http://localhost'), caller: rootCaller, account: { id: id(1) } as Account, domain: { id: id(11), name: 'example.test' } as Domain,
      body: { username: 'alice', domain: 'example.test', expectedRevision: 7, fullchainPem: chain, privateKeyPem: pem(site.privateKey) }, scope: 'workspace' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
  })
})
