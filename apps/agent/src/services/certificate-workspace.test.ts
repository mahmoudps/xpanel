import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FakeHostExecutor } from '../executor.ts'
import type { RenderedFile } from '@xpanel/core'
import { services } from '@xpanel/render'
import { installManualCertificate, MANUAL_CERTIFICATE_MAX_BYTES, validateCertificateRenewalTarget, validateManualCertificate } from './certificate-workspace.ts'

// Runtime-generated self-signed X.509/key material is a declared portable fixture only.
const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const certificateId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const now = new Date('2026-10-26T12:00:00.000Z')
const domains = [{ accountId, name: 'example.test' }, { accountId, name: 'www.example.test' }]
const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts)
  const bytes = body.length < 128 ? Buffer.from([body.length]) : (() => { let value = body.length, length: number[] = []; while (value) { length.unshift(value & 255); value >>>= 8 } return Buffer.from([128 | length.length, ...length]) })()
  return Buffer.concat([Buffer.from([tag]), bytes, body])
}
const sequence = (...parts: Buffer[]) => der(0x30, ...parts)
const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'))
const bundle = (names = ['example.test']) => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const algorithm = sequence(oid('2a8648ce3d040302'))
  const name = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('Portable certificate fixture')))))
  const extensions = der(0xa3, sequence(sequence(oid('551d11'), der(0x04, sequence(...names.map(name => der(0x82, Buffer.from(name))))))))
  const tbs = sequence(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), algorithm, name,
    sequence(der(0x17, Buffer.from('250101000000Z')), der(0x17, Buffer.from('280101000000Z'))), name,
    pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer, extensions)
  const bytes = sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, pair.privateKey)])))
  return { fullchainPem: '-----BEGIN CERTIFICATE-----\n' + bytes.toString('base64').match(/.{1,64}/g)!.join('\n') + '\n-----END CERTIFICATE-----\n', privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }
}

describe('manual certificate host adapter', () => {
  it('writes immutable validated files with restrictive key permissions and verified bytes', async () => {
    const executor = new FakeHostExecutor(), pem = bundle()
    const result = await installManualCertificate({ executor, accountId, domains, body: { domain: 'example.test', ...pem }, now })
    expect(result.certificate.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.certificate).toMatchObject({ accountId, names: ['example.test'], source: 'upload', autoRenew: false, notBefore: '2025-01-01T00:00:00.000Z', notAfter: '2028-01-01T00:00:00.000Z' })
    const paths = services.certFiles(result.certificate.id)
    expect(executor.files.get(paths.privkey)).toMatchObject({ mode: 0o600, owner: 'root', group: 'root' })
    expect(executor.files.get(paths.privkey)?.content === pem.privateKeyPem).toBe(true)
    expect(executor.files.get(paths.fullchain)?.content).toBe(pem.fullchainPem)
    expect(executor.files.size).toBe(2)
    expect(result.application).toEqual({ status: 'candidate_files_written', nativeApplied: false, servedTlsVerified: false })
    expect(JSON.stringify(result)).not.toContain('BEGIN PRIVATE KEY')
  })
  it('preserves all owned SANs and refuses an extra foreign SAN before any host write', async () => {
    const good = bundle(['example.test', 'www.example.test'])
    expect(validateManualCertificate({ domain: 'example.test', ...good }, accountId, domains, now).names).toEqual(['example.test', 'www.example.test'])
    expect(validateManualCertificate({ domain: 'example.test', ...good }, accountId, domains.slice(0, 1), now).names).toEqual(['example.test', 'www.example.test'])
    const executor = new FakeHostExecutor()
    await expect(installManualCertificate({ executor, accountId, domains, body: { domain: 'example.test', ...bundle(['example.test', 'foreign.test']) }, now })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(executor.files.size).toBe(0)
  })
  it('supports a wildcard only for its exact owned base and a covered owned target', () => {
    const pem = bundle(['*.example.test'])
    expect(validateManualCertificate({ domain: 'www.example.test', ...pem }, accountId, domains, now).names).toEqual(['*.example.test'])
    expect(() => validateManualCertificate({ domain: 'www.example.test', ...pem }, accountId, domains.slice(1), now)).toThrow(/every certificate DNS name/)
  })
  it('rejects mismatched keys, expired certificates, invalid clocks and oversized bodies', () => {
    const first = bundle(), second = bundle()
    expect(() => validateManualCertificate({ domain: 'example.test', ...first, privateKeyPem: second.privateKeyPem }, accountId, domains, now)).toThrow()
    expect(() => validateManualCertificate({ domain: 'example.test', ...first }, accountId, domains, new Date('2030-01-01T00:00:00Z'))).toThrow(/expired/)
    expect(() => validateManualCertificate({ domain: 'example.test', ...first }, accountId, domains, new Date('invalid'))).toThrow(/clock/)
    expect(() => validateManualCertificate({ domain: 'example.test', ...first, fullchainPem: 'x'.repeat(MANUAL_CERTIFICATE_MAX_BYTES + 1) }, accountId, domains, now)).toThrow(/size limit/)
  })
  it('refuses foreign targets and request-controlled paths or identities', () => {
    const pem = bundle()
    expect(() => validateManualCertificate({ domain: 'foreign.test', ...pem }, accountId, domains, now)).toThrow(/not found/)
    expect(() => validateManualCertificate({ domain: 'example.test', ...pem, certificateId: '../../foreign' }, accountId, domains, now)).toThrow(/unsupported/)
  })
  it('removes only its exact published candidate files after a partial write and reports review required', async () => {
    class PartialWriteExecutor extends FakeHostExecutor {
      override async writeFile(file: RenderedFile): Promise<void> { await super.writeFile(file); if (file.mode === 0o600) throw new Error('synthetic failure after publication') }
    }
    const executor = new PartialWriteExecutor()
    await expect(installManualCertificate({ executor, accountId, domains, body: { domain: 'example.test', ...bundle() }, now })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, candidateFilesRemoved: true } })
    expect(executor.files.size).toBe(0)
  })
  it('does not hide a failed candidate cleanup or expose key material in the error', async () => {
    class FailedRecoveryExecutor extends FakeHostExecutor {
      override async writeFile(file: RenderedFile): Promise<void> { await super.writeFile(file); if (file.mode === 0o600) throw new Error('synthetic publication failure') }
      override async removePath(): Promise<void> { throw new Error('synthetic cleanup failure') }
    }
    const executor = new FailedRecoveryExecutor()
    const error = await installManualCertificate({ executor, accountId, domains, body: { domain: 'example.test', ...bundle() }, now }).catch(error => error)
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, candidateFilesRemoved: false } })
    expect(String(error.message) + JSON.stringify(error)).not.toContain('BEGIN PRIVATE KEY')
    expect(executor.files.size).toBe(2)
  })
})

describe('certificate renewal target authority', () => {
  const certificate = { id: certificateId, accountId, names: ['example.test', 'www.example.test'], source: 'acme' as const }
  const domain = { ...domains[0]!, certificateId }
  const target = () => ({ certificateId, certificate, accountId, domain, domains })
  it('returns every existing SAN in the original order for the same bound certificate', () => {
    expect(validateCertificateRenewalTarget(target())).toEqual({ certificateId, names: ['example.test', 'www.example.test'] })
  })
  it('refuses a foreign certificate identity or a selected domain that is not bound to it', () => {
    expect(() => validateCertificateRenewalTarget({ ...target(), certificate: { ...certificate, accountId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } })).toThrow(/not found/)
    expect(() => validateCertificateRenewalTarget({ ...target(), domain: { ...domain, certificateId: null } })).toThrow(/not assigned/)
    expect(() => validateCertificateRenewalTarget({ ...target(), certificateId: 'invalid' })).toThrow(/saved certificate identity/)
  })
  it('refuses shrinking a multi-SAN renewal or renewing after SAN ownership changed', () => {
    expect(() => validateCertificateRenewalTarget({ ...target(), certificate: { ...certificate, names: ['example.test', 'app.example.test'] }, domains: domains.slice(0, 1) })).toThrow(/every renewal name/)
    expect(() => validateCertificateRenewalTarget({ ...target(), certificate: { ...certificate, names: ['unrelated.test'] } })).toThrow(/do not cover/)
    expect(() => validateCertificateRenewalTarget({ ...target(), certificate: { ...certificate, source: 'upload' } })).toThrow(/only an ACME/)
  })
})
