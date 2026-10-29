import { X509Certificate, createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { fail, isXpanelError, resolveServingDomain, validateDomainName } from '@xpanel/core'
import type { Domain, Id } from '@xpanel/core'
import { services } from '@xpanel/render'
import type { StateStore } from '@xpanel/state'
import type { CertificateWorkspaceHelpers, CertificateWorkspaceInstall } from './certificate-workspace.ts'

export const MANUAL_CHAIN_MAX_CERTIFICATES = 10
export const MANUAL_MATERIAL_MAX_BYTES = 64 * 1024
const MAX_REQUIRED_NAMES = 20
const KEY_LABELS = new Set(['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY'])
const EC_CURVES = new Set(['prime256v1', 'secp384r1'])

/** Stable refusal reasons the web client localizes; messages never contain key material. */
export type ManualCertificateReason = 'certificate_format' | 'key_format' | 'key_encrypted' | 'too_large' | 'leaf_ca' | 'not_yet_valid'
  | 'expired' | 'names' | 'name_owner' | 'chain_order' | 'key_mismatch' | 'key_strength'
type InstallCertificate = NonNullable<CertificateWorkspaceHelpers['installCertificate']>
type InstallBody = CertificateWorkspaceInstall & { requiredNames?: readonly string[] }
export interface ManualCertificateCheck {
  fullchainPem: string; privateKeyPem: string; names: string[]; requiredNames: string[]
  notBefore: string; notAfter: string; fingerprintSha256: string
}

const refuse = (reason: ManualCertificateReason, message: string, extra: Record<string, unknown> = {}): never =>
  fail(reason === 'name_owner' ? 'FORBIDDEN' : 'VALIDATION', message, { stateChanged: false, reason, ...extra })

/** RFC 7468 strict encapsulation: only BEGIN/END lines and canonical base64 text, rewrapped at 64 columns. */
function pemBlocks(text: string, field: 'certificate' | 'key'): { label: string; pem: string }[] {
  const reason = field === 'certificate' ? 'certificate_format' : 'key_format'
  const blocks: { label: string; pem: string }[] = []
  let current: { label: string; lines: string[] } | null = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[ \t\r]+$/, '')
    if (!current) {
      if (!line) continue
      const begin = /^-----BEGIN ([A-Z0-9]+(?: [A-Z0-9]+)*)-----$/.exec(line)
      if (!begin) return refuse(reason, field === 'certificate' ? 'the certificate fields must contain only PEM blocks' : 'the private key field must contain only one PEM block')
      current = { label: begin[1]!, lines: [] }
      continue
    }
    if (line === '-----END ' + current.label + '-----') {
      const body = current.lines.join('')
      const bytes = Buffer.from(body, 'base64')
      if (!body || bytes.toString('base64') !== body) return refuse(reason, 'a PEM block contains invalid base64 text')
      blocks.push({ label: current.label, pem: '-----BEGIN ' + current.label + '-----\n' + body.match(/.{1,64}/g)!.join('\n') + '\n-----END ' + current.label + '-----\n' })
      current = null
      continue
    }
    // RFC 1421 encapsulated headers mark a legacy passphrase-protected key.
    if (field === 'key' && /^(?:Proc-Type|DEK-Info):/i.test(line)) return refuse('key_encrypted', 'the private key is passphrase-protected; remove the passphrase before installing it')
    if (!/^[A-Za-z0-9+/=]{1,76}$/.test(line)) return refuse(reason, 'a PEM block contains invalid base64 text')
    current.lines.push(line)
  }
  if (current) return refuse(reason, 'a PEM block is not terminated')
  return blocks
}

const parseCertificate = (pem: string, position: number): X509Certificate => {
  try { return new X509Certificate(pem) } catch { return refuse('certificate_format', 'certificate ' + position + ' is not a parsable X.509 certificate', { position }) }
}
const spki = (key: KeyObject): Buffer => key.export({ type: 'spki', format: 'der' })

/** Validates uploaded material against owned saved domains; returns normalized PEM and the leaf identity. */
export function validateManualCertificateInstall(input: {
  accountId: Id; domain: string; requiredNames?: readonly unknown[]; fullchainPem: string; privateKeyPem: string
  domains: readonly Pick<Domain, 'accountId' | 'name'>[]; now: Date
}): ManualCertificateCheck {
  if (!Number.isFinite(input.now.getTime())) return fail('VALIDATION', 'certificate validation clock is unavailable', { stateChanged: false })
  if (Buffer.byteLength(input.fullchainPem, 'utf8') + Buffer.byteLength(input.privateKeyPem, 'utf8') > MANUAL_MATERIAL_MAX_BYTES) return refuse('too_large', 'certificate material exceeds 64 KiB', { limitBytes: MANUAL_MATERIAL_MAX_BYTES })
  const certificateBlocks = pemBlocks(input.fullchainPem.replace(/\r\n/g, '\n'), 'certificate')
  if (!certificateBlocks.length || certificateBlocks.some(block => block.label !== 'CERTIFICATE')) return refuse('certificate_format', 'the certificate fields accept only CERTIFICATE blocks')
  if (certificateBlocks.length > MANUAL_CHAIN_MAX_CERTIFICATES) return refuse('too_large', 'a certificate chain holds at most ' + MANUAL_CHAIN_MAX_CERTIFICATES + ' certificates', { limitCertificates: MANUAL_CHAIN_MAX_CERTIFICATES })
  const keyBlocks = pemBlocks(input.privateKeyPem.replace(/\r\n/g, '\n'), 'key')
  if (keyBlocks.some(block => block.label === 'ENCRYPTED PRIVATE KEY')) return refuse('key_encrypted', 'the private key is passphrase-protected; remove the passphrase before installing it')
  if (keyBlocks.length !== 1 || !KEY_LABELS.has(keyBlocks[0]!.label)) return refuse('key_format', 'the private key field must contain exactly one PRIVATE KEY, RSA PRIVATE KEY or EC PRIVATE KEY block')

  const certificates = certificateBlocks.map((block, index) => parseCertificate(block.pem, index + 1))
  if (new Set(certificates.map(certificate => certificate.fingerprint256)).size !== certificates.length) return refuse('certificate_format', 'the chain repeats a certificate')
  const leaf = certificates[0]!
  if (leaf.ca) return refuse('leaf_ca', 'the first certificate must be the site certificate, not a certificate authority')
  const notBefore = new Date(leaf.validFrom), notAfter = new Date(leaf.validTo)
  if (!Number.isFinite(notBefore.getTime()) || !Number.isFinite(notAfter.getTime())) return refuse('certificate_format', 'certificate validity dates could not be read')
  if (input.now < notBefore) return refuse('not_yet_valid', 'the certificate is not valid until ' + notBefore.toISOString(), { notBefore: notBefore.toISOString() })
  if (input.now >= notAfter) return refuse('expired', 'the certificate expired at ' + notAfter.toISOString(), { notAfter: notAfter.toISOString() })
  for (let index = 0; index + 1 < certificates.length; index++) {
    const child = certificates[index]!, issuer = certificates[index + 1]!
    if (child.issuer !== issuer.subject || !issuer.ca || !child.checkIssued(issuer) || !child.verify(issuer.publicKey)) return refuse('chain_order', 'certificate ' + (index + 2) + ' did not issue certificate ' + (index + 1) + '; list the chain from the site certificate up to the root', { position: index + 2 })
  }

  // Node prints subjectAltName as "DNS:a, DNS:b"; any other entry type is refused like the host adapter does.
  const parts = (leaf.subjectAltName ?? '').split(',').map(part => part.trim()).filter(Boolean)
  if (!parts.length || parts.some(part => !/^DNS:[a-z0-9*.-]+$/i.test(part))) return refuse('names', 'the certificate must list only DNS subject alternative names')
  let names: string[]
  try { names = [...new Set(parts.map(part => services.normalizeCertName(part.slice(4).toLowerCase())))].sort() }
  catch { return refuse('names', 'the certificate lists an invalid DNS name') }
  if (names.length > 100) return refuse('names', 'the certificate lists more than 100 DNS names')
  if (input.requiredNames !== undefined && (!Array.isArray(input.requiredNames) || input.requiredNames.length > MAX_REQUIRED_NAMES)) return refuse('names', 'choose at most ' + MAX_REQUIRED_NAMES + ' names to cover')
  let requiredNames: string[]
  try { requiredNames = [...new Set((input.requiredNames ?? []).map(name => validateDomainName(name)))].sort() }
  catch { return refuse('names', 'a chosen name to cover is not a valid host name') }
  const exact = input.domains.map(domain => ({ ...domain, wildcard: false }))
  const ownedBy = (name: string) => (name.startsWith('*.') ? exact.find(domain => domain.name === name.slice(2)) : resolveServingDomain(name, exact))?.accountId
  for (const name of [input.domain, ...requiredNames]) {
    if (ownedBy(name) !== input.accountId) return refuse('name_owner', 'every name to cover must belong to this account', { name })
    if (!services.coversHost(names, name)) return refuse('names', 'the certificate does not cover ' + name, { missingName: name })
  }
  for (const name of names) if (ownedBy(name) !== input.accountId) return refuse('name_owner', 'every certificate DNS name must belong to this account', { name })

  let privateKey: KeyObject
  try { privateKey = createPrivateKey({ key: keyBlocks[0]!.pem, format: 'pem' }) } catch { return refuse('key_format', 'the private key could not be read') }
  if (!spki(createPublicKey(privateKey)).equals(spki(leaf.publicKey))) return refuse('key_mismatch', 'the private key does not match the site certificate')
  const details = privateKey.asymmetricKeyDetails ?? {}
  const strong = privateKey.asymmetricKeyType === 'rsa' ? (details.modulusLength ?? 0) >= 2048
    : privateKey.asymmetricKeyType === 'ec' && EC_CURVES.has(details.namedCurve ?? '')
  if (!strong) return refuse('key_strength', 'only RSA keys of 2048 bits or more and EC P-256 or P-384 keys are supported')

  return { fullchainPem: certificateBlocks.map(block => block.pem).join(''), privateKeyPem: keyBlocks[0]!.pem, names, requiredNames,
    notBefore: notBefore.toISOString(), notAfter: notAfter.toISOString(), fingerprintSha256: createHash('sha256').update(leaf.raw).digest('hex') }
}

/** Validates before the shared upload commit path, then proves the stored record is the validated leaf. */
export function createManualCertificateInstall(input: { store: Pick<StateStore, 'readSnapshot'>; install: InstallCertificate; now?: () => Date }): InstallCertificate {
  return async request => {
    const body = request.body as InstallBody
    const snapshot = await input.store.readSnapshot()
    if (snapshot.revision !== body.expectedRevision) return fail('CONFLICT', 'certificate workspace changed; reload before retrying', { stateChanged: false })
    const checked = validateManualCertificateInstall({ accountId: request.account.id, domain: request.domain.name, ...(body.requiredNames !== undefined ? { requiredNames: body.requiredNames } : {}),
      fullchainPem: body.fullchainPem, privateKeyPem: body.privateKeyPem, domains: snapshot.domains, now: (input.now ?? (() => new Date()))() })
    const forwarded: CertificateWorkspaceInstall = { username: body.username, domain: body.domain, expectedRevision: body.expectedRevision, fullchainPem: checked.fullchainPem, privateKeyPem: checked.privateKeyPem }
    let result: Awaited<ReturnType<InstallCertificate>>
    try { result = await input.install({ ...request, body: forwarded }) }
    catch (error) { throw isXpanelError(error) ? error : fail('SERVICE_UNAVAILABLE', 'certificate installation requires verification', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
    const stored = result.certificate
    if (stored.source !== 'upload' || stored.fingerprintSha256?.toLowerCase() !== checked.fingerprintSha256 || stored.notAfter !== checked.notAfter
      || JSON.stringify([...stored.names].sort()) !== JSON.stringify(checked.names) || !checked.requiredNames.every(name => services.coversHost(stored.names, name))) {
      return fail('SERVICE_UNAVAILABLE', 'stored certificate does not match the validated upload', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    }
    return result
  }
}
