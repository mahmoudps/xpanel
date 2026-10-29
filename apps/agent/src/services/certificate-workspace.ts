import { randomUUID } from 'node:crypto'
import { resolveServingDomain } from '@xpanel/core'
import { fail, isUuid, validateDomainName } from '@xpanel/core'
import type { Certificate, Domain, Id } from '@xpanel/core'
import { services } from '@xpanel/render'
import type { AgentExecutor } from '../executor.ts'
import { computeLeafFingerprintSha256, verifyIssuedCertificateBundle } from './acme.ts'
import { publishCertificateCandidate } from './certificate-candidate.ts'

export const MANUAL_CERTIFICATE_MAX_BYTES = 256 * 1024
export const MANUAL_PRIVATE_KEY_MAX_BYTES = 32 * 1024
const MAX_CERTIFICATE_NAMES = 100
type OwnedCertificateDomain = Pick<Domain, 'accountId' | 'name'>

/** A renewal must preserve the whole existing certificate, not just the selected display name. */
export function validateCertificateRenewalTarget(input: {
  certificateId: unknown
  certificate: Pick<Certificate, 'id' | 'accountId' | 'names' | 'source'> | null
  accountId: Id
  domain: Pick<Domain, 'accountId' | 'name' | 'certificateId'>
  domains: readonly OwnedCertificateDomain[]
}): { certificateId: Id; names: string[] } {
  if (!isUuid(input.certificateId)) return fail('VALIDATION', 'certificateId must be a saved certificate identity', { stateChanged: false })
  const certificateId = input.certificateId.toLowerCase(), certificate = input.certificate
  if (!certificate || certificate.id !== certificateId || certificate.accountId !== input.accountId || input.domain.accountId !== input.accountId) return fail('NOT_FOUND', 'renewal certificate not found', { stateChanged: false })
  if (input.domain.certificateId !== certificateId) return fail('CONFLICT', 'renewal certificate is not assigned to this domain', { stateChanged: false })
  if (certificate.source !== 'acme') return fail('VALIDATION', 'only an ACME certificate can be renewed', { stateChanged: false })
  const names = certificate.names.map(name => services.normalizeCertName(name))
  if (!names.length || names.length > MAX_CERTIFICATE_NAMES || new Set(names).size !== names.length || !services.coversHost(names, input.domain.name)) return fail('VALIDATION', 'renewal names do not cover this domain', { stateChanged: false })
  const exact = input.domains.map(domain => ({ ...domain, wildcard: false }))
  for (const name of names) {
    const owner = name.startsWith('*.') ? exact.find(domain => domain.name === name.slice(2)) : resolveServingDomain(name, exact)
    if (owner?.accountId !== input.accountId) return fail('FORBIDDEN', 'every renewal name must remain owned by this account', { stateChanged: false })
  }
  return { certificateId, names }
}

export interface ManualCertificateInput {
  domain: string
  fullchainPem: string
  privateKeyPem: string
}
export interface ManualCertificateResult {
  certificate: {
    id: Id; accountId: Id; names: string[]; source: 'upload'; challenge: null
    notBefore: string; notAfter: string; autoRenew: false; certPath: string; keyPath: string; fingerprintSha256: string
  }
  application: { status: 'candidate_files_written'; nativeApplied: false; servedTlsVerified: false }
}

/** Validates every SAN against actual owned domain records, never the request's account selector. */
export function validateManualCertificate(input: unknown, accountId: Id, domains: readonly OwnedCertificateDomain[], now: Date) {
  if (!Number.isFinite(now.getTime())) return fail('VALIDATION', 'certificate validation clock is unavailable', { stateChanged: false })
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('VALIDATION', 'manual certificate input must be an object', { stateChanged: false })
  const body = input as Record<string, unknown>
  if (Object.keys(body).some(key => !['domain', 'fullchainPem', 'privateKeyPem'].includes(key))) return fail('VALIDATION', 'unsupported manual certificate field', { stateChanged: false })
  if (typeof body.domain !== 'string' || typeof body.fullchainPem !== 'string' || typeof body.privateKeyPem !== 'string') return fail('VALIDATION', 'domain, certificate chain and private key are required', { stateChanged: false })
  if (Buffer.byteLength(body.fullchainPem, 'utf8') > MANUAL_CERTIFICATE_MAX_BYTES || Buffer.byteLength(body.privateKeyPem, 'utf8') > MANUAL_PRIVATE_KEY_MAX_BYTES) return fail('VALIDATION', 'certificate or private key exceeds its size limit', { stateChanged: false })
  const domainName = validateDomainName(body.domain)
  const ownedNames = new Set(domains.filter(domain => domain.accountId === accountId).map(domain => domain.name))
  if (!ownedNames.has(domainName)) return fail('NOT_FOUND', 'domain not found', { stateChanged: false })
  const bundle = verifyIssuedCertificateBundle(body.fullchainPem, body.privateKeyPem, [domainName], now)
  const metadata = computeLeafFingerprintSha256(bundle.fullchain)
  if (!metadata.leaf.subjectAltName?.split(',').every(part => /^DNS:[a-z0-9*.-]+$/i.test(part.trim()))) return fail('VALIDATION', 'only explicit DNS subject alternative names are supported', { stateChanged: false })
  const names = [...new Set(bundle.dnsSans.map(name => services.normalizeCertName(name)))].sort()
  if (names.length === 0 || names.length > MAX_CERTIFICATE_NAMES) return fail('VALIDATION', 'a bounded DNS subject alternative name list is required', { stateChanged: false })
  for (const name of names) {
    const exact = domains.map(domain => ({ ...domain, wildcard: false }))
    const owner = name.startsWith('*.') ? exact.find(domain => domain.name === name.slice(2)) : resolveServingDomain(name, exact)
    if (owner?.accountId !== accountId) return fail('FORBIDDEN', 'every certificate DNS name must belong to this account', { stateChanged: false })
  }
  return { bundle, names, domainName, notBefore: metadata.notBefore.toISOString() }
}

/** Writes a fresh immutable candidate through the real host executor; activation is a separate reconcile. */
export async function installManualCertificate(input: {
  executor: AgentExecutor; accountId: Id; domains: readonly OwnedCertificateDomain[]; body: unknown; now?: Date
}): Promise<ManualCertificateResult> {
  const { bundle, names, notBefore } = validateManualCertificate(input.body, input.accountId, input.domains, input.now ?? new Date())
  const certificateId = randomUUID()
  const files = await publishCertificateCandidate({ executor: input.executor, certificateId, fullchain: bundle.fullchain, privateKey: bundle.privkey })
  return {
    certificate: { id: certificateId, accountId: input.accountId, names, source: 'upload', challenge: null,
      notBefore, notAfter: bundle.notAfterIso, autoRenew: false, certPath: files.certPath, keyPath: files.keyPath,
      fingerprintSha256: bundle.fingerprintSha256 },
    application: { status: 'candidate_files_written', nativeApplied: false, servedTlsVerified: false },
  }
}
