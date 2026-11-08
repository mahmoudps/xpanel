import { X509Certificate, createHash, createPrivateKey, createPublicKey, generateKeyPair, randomBytes, randomUUID, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { fail, isAccountHome, isXpanelError, validateDomainName } from '@xpanel/core'
import type { Account, FeatureList, Plan } from '@xpanel/core'
import { system } from '@xpanel/render'
import type { AgentExecutor, ConfigTestResult } from './executor.ts'
import type { FileText, JailedFileManager } from './file-manager.ts'
import type { AgentCallerIdentity } from './server.ts'
import { verifyIssuedCertificateBundle } from './services/acme.ts'
import { publishCertificateCandidate } from './services/certificate-candidate.ts'

/** cPanel layout: ~/ssl/keys, ~/ssl/csrs and ~/ssl/certs, owned by the account; the file is the record and the name sits beside it. */
export const SSL_STORE_KINDS = ['key', 'csr', 'certificate'] as const
export type SslStoreKind = typeof SSL_STORE_KINDS[number]
export const SSL_STORE_DIRECTORY = 'ssl'
export const SSL_STORE_PATHS: Readonly<Record<SslStoreKind, string>> = { key: 'ssl/keys', csr: 'ssl/csrs', certificate: 'ssl/certs' }
const EXTENSION: Readonly<Record<SslStoreKind, string>> = { key: '.key', csr: '.csr', certificate: '.crt' }
const FILE_MODE: Readonly<Record<SslStoreKind, number>> = { key: 0o600, csr: 0o640, certificate: 0o640 }
const DIRECTORY_MODE = 0o700
/** Plan feature ids per kind; the shared "SSL/TLS" key disables all three. */
export const SSL_STORE_TOOLS: Readonly<Record<SslStoreKind, string>> = { key: 'ssl-private-keys', csr: 'ssl-csrs', certificate: 'ssl-certificates' }
export const SSL_STORE_FEATURE_KEY = 'SSL/TLS'
export const SSL_STORE_MAX_ITEMS = 50
export const SSL_STORE_MAX_PEM_BYTES = 16 * 1024
export const SSL_STORE_MAX_NAMES = 100
export const SSL_STORE_MAX_DAYS = 3650
export const SSL_KEY_TYPES = ['rsa-2048', 'rsa-4096', 'ecdsa-prime256v1', 'ecdsa-secp384r1'] as const
export type SslKeyType = typeof SSL_KEY_TYPES[number]
export const SSL_STORE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const OPENSSL_BINARY = '/usr/bin/openssl'
const CURVES = new Set(['prime256v1', 'secp384r1'])
const SUBJECT_TEXT = /^[\p{L}\p{N} .,'&()_@-]{1,64}$/u
const EMAIL = /^[A-Za-z0-9._%-]{1,64}@[A-Za-z0-9.-]{1,190}$/

/** Stable refusal reasons the web clients localize; messages never contain key material. */
export type SslStoreReason = 'key_format' | 'key_encrypted' | 'key_strength' | 'certificate_format' | 'leaf_ca' | 'too_large' | 'names' | 'subject'
  | 'key_missing' | 'directory_unmanageable' | 'capacity' | 'days' | 'self_signed' | 'hostname_unset' | 'chain_order'
const refuse = (reason: SslStoreReason, message: string, code: 'VALIDATION' | 'NOT_FOUND' | 'PRECONDITION_FAILED' = 'VALIDATION'): never =>
  fail(code, message, { stateChanged: false, reason })

export interface SslSubject { country?: string; state?: string; locality?: string; organization?: string; organizationalUnit?: string; email?: string }
export interface SslRequest { names: string[]; subject: SslSubject }
interface ItemBase { id: string; label: string | null; modifiedAt: string; valid: boolean; publicKeySha256: string | null }
export interface SslKeyItem extends ItemBase { keyType: 'rsa' | 'ec' | null; bits: number | null; curve: string | null }
export interface SslCsrItem extends ItemBase { commonName: string | null; names: string[] }
export interface SslCertificateItem extends ItemBase {
  commonName: string | null; names: string[]; issuer: string | null; selfSigned: boolean | null
  notBefore: string | null; notAfter: string | null; fingerprintSha256: string | null
}
export type SslStoreItem = SslKeyItem | SslCsrItem | SslCertificateItem
export interface SslStoreView {
  context: SslStoreContext
  directory: 'absent' | 'ready' | 'unmanageable'
  keys: SslKeyItem[]; csrs: SslCsrItem[]; certificates: SslCertificateItem[]
  limits: { maxItems: number; truncated: boolean }
  application: { status: 'read' | 'created' | 'imported' | 'removed' | 'labelled'; changed: { kind: SslStoreKind; id: string }[] }
}

// ---- PEM and DER ---------------------------------------------------------------------------

const toPem = (label: string, der: Buffer): string => '-----BEGIN ' + label + '-----\n' + der.toString('base64').match(/.{1,64}/g)!.join('\n') + '\n-----END ' + label + '-----\n'
/** RFC 7468 strict text: exactly one block of one of the labels, canonical base64. */
function pemBlock(text: unknown, labels: readonly string[], reason: 'key_format' | 'certificate_format'): { label: string; der: Buffer } {
  if (typeof text !== 'string' || !text.isWellFormed()) return refuse(reason, 'the PEM text is required')
  if (Buffer.byteLength(text, 'utf8') > SSL_STORE_MAX_PEM_BYTES) return refuse('too_large', 'the PEM text exceeds 16 KiB')
  const match = /^\s*-----BEGIN ([A-Z0-9]+(?: [A-Z0-9]+)*)-----\r?\n([\s\S]*?)\r?\n-----END \1-----\s*$/.exec(text)
  if (match && (match[1] === 'ENCRYPTED PRIVATE KEY' || /^(?:Proc-Type|DEK-Info):/im.test(match[2]!))) return refuse('key_encrypted', 'the private key is passphrase-protected; remove the passphrase first')
  const body = match ? match[2]!.replace(/[\r\n\t ]/g, '') : ''
  const der = Buffer.from(body, 'base64')
  if (!match || !labels.includes(match[1]!) || !body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body) || der.toString('base64') !== body) return refuse(reason, 'the text must be exactly one ' + labels[0] + ' PEM block')
  return { label: match[1]!, der }
}

interface Tlv { tag: number; start: number; body: number; end: number }
/** X.690 DER: definite lengths only. */
function tlv(buffer: Buffer, offset: number, limit = buffer.length): Tlv {
  if (offset + 2 > limit) throw new Error('der_truncated')
  let length = buffer[offset + 1]!, body = offset + 2
  if (length & 0x80) {
    const count = length & 0x7f
    if (count < 1 || count > 3 || body + count > limit) throw new Error('der_length')
    length = 0
    for (let index = 0; index < count; index++) length = length * 256 + buffer[body + index]!
    body += count
  }
  if (body + length > limit) throw new Error('der_truncated')
  return { tag: buffer[offset]!, start: offset, body, end: body + length }
}
function children(buffer: Buffer, node: Tlv): Tlv[] {
  const out: Tlv[] = []
  for (let offset = node.body; offset < node.end;) { const child = tlv(buffer, offset, node.end); out.push(child); offset = child.end }
  return out
}
const oidOf = (buffer: Buffer, node: Tlv | undefined): string => node && node.tag === 0x06 ? buffer.subarray(node.body, node.end).toString('hex') : ''
const OID = { commonName: '550403', extensionRequest: '2a864886f70d01090e', subjectAltName: '551d11', sha256Rsa: '2a864886f70d01010b', sha256Ecdsa: '2a8648ce3d040302' }

const spkiSha256 = (key: KeyObject): string => createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
const firstLine = (text: string, prefix: string): string | null => text.split('\n').find(line => line.startsWith(prefix))?.slice(prefix.length) ?? null
const dnsNames = (values: readonly string[]): string[] => [...new Set(values.map(value => value.toLowerCase()).filter(value => /^(?:\*\.)?[a-z0-9.-]{1,253}$/.test(value)))].slice(0, SSL_STORE_MAX_NAMES)
const iso = (value: string): string | null => { const time = new Date(value).getTime(); return Number.isFinite(time) ? new Date(time).toISOString() : null }

export interface ParsedKey { pem: string; key: KeyObject; item: Omit<SslKeyItem, 'id' | 'label' | 'modifiedAt'> }
/** Unencrypted RSA (2048 to 8192 bits) or EC P-256/P-384 keys, normalized to PKCS #8. */
export function parseStoreKey(text: unknown): ParsedKey {
  const block = pemBlock(text, ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY'], 'key_format')
  let key: KeyObject
  try { key = createPrivateKey({ key: toPem(block.label, block.der), format: 'pem' }) } catch { return refuse('key_format', 'the private key could not be read') }
  const details = key.asymmetricKeyDetails ?? {}
  const bits = details.modulusLength ?? 0, curve = details.namedCurve ?? ''
  if (!(key.asymmetricKeyType === 'rsa' && bits >= 2048 && bits <= 8192) && !(key.asymmetricKeyType === 'ec' && CURVES.has(curve))) return refuse('key_strength', 'only RSA keys of 2048 to 8192 bits and EC P-256 or P-384 keys are supported')
  const rsa = key.asymmetricKeyType === 'rsa'
  return { pem: key.export({ type: 'pkcs8', format: 'pem' }) as string, key,
    item: { valid: true, publicKeySha256: spkiSha256(createPublicKey(key)), keyType: rsa ? 'rsa' : 'ec', bits: rsa ? bits : curve === 'prime256v1' ? 256 : 384, curve: rsa ? null : curve } }
}

export interface ParsedCertificate { pem: string; certificate: X509Certificate; item: Omit<SslCertificateItem, 'id' | 'label' | 'modifiedAt'> }
/** One site (non-CA) X.509 certificate; its CA bundle is supplied when it is installed. */
export function parseStoreCertificate(text: unknown): ParsedCertificate {
  const block = pemBlock(text, ['CERTIFICATE'], 'certificate_format')
  const pem = toPem('CERTIFICATE', block.der)
  let certificate: X509Certificate
  try { certificate = new X509Certificate(pem) } catch { return refuse('certificate_format', 'the certificate could not be read') }
  if (certificate.ca) return refuse('leaf_ca', 'store the site certificate, not a certificate authority')
  const names = dnsNames((certificate.subjectAltName ?? '').split(',').map(part => part.trim()).filter(part => part.startsWith('DNS:')).map(part => part.slice(4)))
  return { pem, certificate, item: { valid: true, publicKeySha256: spkiSha256(certificate.publicKey), commonName: firstLine(certificate.subject, 'CN='), names,
    issuer: firstLine(certificate.issuer, 'CN=') ?? firstLine(certificate.issuer, 'O='), selfSigned: certificate.checkIssued(certificate) && certificate.verify(certificate.publicKey),
    notBefore: iso(certificate.validFrom), notAfter: iso(certificate.validTo), fingerprintSha256: createHash('sha256').update(certificate.raw).digest('hex') } }
}

export interface ParsedCsr { pem: string; item: Omit<SslCsrItem, 'id' | 'label' | 'modifiedAt'> }
/** RFC 2986 PKCS #10 with a verified SHA-256 signature; names come from the extensionRequest subjectAltName. */
export function parseStoreCsr(text: unknown): ParsedCsr {
  const invalid = (): never => refuse('certificate_format', 'the certificate signing request could not be read')
  const block = pemBlock(text, ['CERTIFICATE REQUEST'], 'certificate_format')
  const der = block.der
  try {
    const root = tlv(der, 0)
    const [info, algorithm, signature] = root.tag === 0x30 && root.end === der.length ? children(der, root) : []
    if (!info || !algorithm || !signature || info.tag !== 0x30 || algorithm.tag !== 0x30 || signature.tag !== 0x03) return invalid()
    const [, subject, spki, attributes] = children(der, info)
    if (!subject || subject.tag !== 0x30 || !spki || spki.tag !== 0x30) return invalid()
    const publicKey = createPublicKey({ key: der.subarray(spki.start, spki.end), format: 'der', type: 'spki' })
    const algorithmOid = oidOf(der, children(der, algorithm)[0])
    if (algorithmOid !== (publicKey.asymmetricKeyType === 'rsa' ? OID.sha256Rsa : publicKey.asymmetricKeyType === 'ec' ? OID.sha256Ecdsa : '-')) return invalid()
    if (der[signature.body] !== 0 || !verify('sha256', der.subarray(info.start, info.end), publicKey, der.subarray(signature.body + 1, signature.end))) return invalid()
    let commonName: string | null = null
    for (const set of children(der, subject)) for (const pair of children(der, set)) {
      const [type, value] = children(der, pair)
      if (oidOf(der, type) === OID.commonName && value) commonName = der.subarray(value.body, value.end).toString('utf8')
    }
    const names: string[] = []
    if (attributes?.tag === 0xa0) for (const attribute of children(der, attributes)) {
      const [type, values] = children(der, attribute)
      if (oidOf(der, type) !== OID.extensionRequest || !values) continue
      for (const extensions of children(der, values)) for (const extension of children(der, extensions)) {
        const parts = children(der, extension)
        const octets = parts.at(-1)
        if (oidOf(der, parts[0]) !== OID.subjectAltName || octets?.tag !== 0x04) continue
        const general = tlv(der, octets.body, octets.end)
        for (const name of children(der, general)) if (name.tag === 0x82) names.push(der.subarray(name.body, name.end).toString('latin1'))
      }
    }
    return { pem: toPem('CERTIFICATE REQUEST', der), item: { valid: true, publicKeySha256: spkiSha256(publicKey), commonName, names: dnsNames(names) } }
  } catch (error) { if (isXpanelError(error)) throw error; return invalid() }
}

// ---- Requests ----------------------------------------------------------------------------

const hostName = (value: unknown): string => {
  if (typeof value !== 'string') return refuse('names', 'every name must be a host name')
  const text = value.trim().toLowerCase()
  try { return text.startsWith('*.') ? '*.' + validateDomainName(text.slice(2)) : validateDomainName(text) } catch { return refuse('names', 'every name must be a valid host name') }
}
const SUBJECT_FIELDS = [['country', 'C'], ['state', 'ST'], ['locality', 'L'], ['organization', 'O'], ['organizationalUnit', 'OU']] as const
/** Names and optional distinguished-name fields; the first name is the common name. */
export function parseSslRequest(names: unknown, subject: unknown): SslRequest {
  if (!Array.isArray(names) || names.length < 1 || names.length > SSL_STORE_MAX_NAMES) return refuse('names', 'list 1 to ' + SSL_STORE_MAX_NAMES + ' host names')
  const list = [...new Set(names.map(hostName))]
  if (list[0]!.length > 64) return refuse('names', 'the first name is the common name and must be at most 64 characters')
  const value = subject === undefined ? {} : subject
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse('subject', 'subject must be an object')
  const fields = value as Record<string, unknown>, out: SslSubject = {}
  for (const key of Object.keys(fields)) if (![...SUBJECT_FIELDS.map(([name]) => name), 'email'].includes(key)) return refuse('subject', 'unsupported subject field')
  for (const [name] of SUBJECT_FIELDS) {
    const text = fields[name]
    if (text === undefined || text === '') continue
    if (typeof text !== 'string' || !(name === 'country' ? /^[A-Z]{2}$/.test(text) : SUBJECT_TEXT.test(text) && text.trim() === text)) return refuse('subject', name === 'country' ? 'the country is a two-letter ISO 3166 code' : 'subject fields use letters, digits, spaces and . , \' & ( ) _ @ - only, up to 64 characters')
    out[name] = text
  }
  if (fields.email !== undefined && fields.email !== '') {
    if (typeof fields.email !== 'string' || !EMAIL.test(fields.email)) return refuse('subject', 'the contact email is not a valid address')
    out.email = fields.email
  }
  return { names: list, subject: out }
}
const subjectArgument = (request: SslRequest): string =>
  SUBJECT_FIELDS.flatMap(([name, short]) => request.subject[name] ? ['/' + short + '=' + request.subject[name]] : []).join('') + '/CN=' + request.names[0] + (request.subject.email ? '/emailAddress=' + request.subject.email : '')

export type SslStoreRequest =
  | { op: 'create'; key: { id: string } | { type: SslKeyType }; label: string | null; request: SslRequest | null; csr: boolean; days: number | null; passphrase: string | null }
  | { op: 'import'; kind: 'key' | 'certificate'; pem: string; label: string | null }
  | { op: 'view'; kind: SslStoreKind; id: string }
  | { op: 'delete'; kind: SslStoreKind; id: string; modifiedAt: string }
  | { op: 'label'; kind: SslStoreKind; id: string; label: string | null }
  | { op: 'material'; certificateId: string }
const storeId = (value: unknown): string => typeof value === 'string' && SSL_STORE_ID.test(value) ? value : fail('VALIDATION', 'a stored item id is required', { stateChanged: false })
const storeKind = (value: unknown): SslStoreKind => (SSL_STORE_KINDS as readonly unknown[]).includes(value) ? value as SslStoreKind : fail('VALIDATION', 'kind must be key, csr or certificate', { stateChanged: false })
/** A friendly name (cPanel description); the file name stays the id. */
export const SSL_STORE_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .,'&()_-]{0,63}$/u
const label = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return null
  return typeof value === 'string' && SSL_STORE_LABEL.test(value) && value.trim() === value ? value : fail('VALIDATION', 'the name uses letters, digits, spaces and . , \' & ( ) _ - only, up to 64 characters', { stateChanged: false, reason: 'label' })
}
/** RFC 2985 challengePassword: printable ASCII without surrounding spaces; it reaches openssl only through a 0600 request file. */
const PASSPHRASE = /^[\x21-\x7e](?:[\x20-\x7e]{2,62})[\x21-\x7e]$/
const passphrase = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return null
  return typeof value === 'string' && PASSPHRASE.test(value) ? value : fail('VALIDATION', 'the challenge passphrase is 4 to 64 printable ASCII characters without leading or trailing spaces', { stateChanged: false, reason: 'passphrase' })
}
const only = (body: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(body).some(key => !keys.includes(key))) fail('VALIDATION', 'unsupported SSL storage field', { stateChanged: false })
}
/** The exact JSON the API sends; every field is checked again here. */
export function parseSslStoreRequest(raw: unknown): SslStoreRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('VALIDATION', 'SSL storage request must be an object', { stateChanged: false })
  const body = raw as Record<string, unknown>
  if (body.op === 'create') {
    only(body, ['op', 'keyId', 'keyType', 'label', 'names', 'subject', 'csr', 'days', 'passphrase'])
    if ((body.keyId === undefined) === (body.keyType === undefined)) return fail('VALIDATION', 'choose a stored key or a new key type', { stateChanged: false })
    const key = body.keyId !== undefined ? { id: storeId(body.keyId) }
      : (SSL_KEY_TYPES as readonly unknown[]).includes(body.keyType) ? { type: body.keyType as SslKeyType } : fail('VALIDATION', 'unsupported key type', { stateChanged: false, reason: 'key_strength' })
    const csr = body.csr === undefined ? false : typeof body.csr === 'boolean' ? body.csr : fail('VALIDATION', 'csr must be a boolean', { stateChanged: false })
    const days = body.days === undefined || body.days === null ? null : typeof body.days === 'number' && Number.isSafeInteger(body.days) && body.days >= 1 && body.days <= SSL_STORE_MAX_DAYS ? body.days : refuse('days', 'a self-signed certificate is valid for 1 to ' + SSL_STORE_MAX_DAYS + ' days')
    const request = body.names === undefined && body.subject === undefined ? null : parseSslRequest(body.names, body.subject)
    if ((request === null) !== (!csr && days === null)) return fail('VALIDATION', 'names are required exactly when a request or certificate is created', { stateChanged: false })
    if (request === null && 'id' in key) return fail('VALIDATION', 'a stored key needs a request or certificate to create', { stateChanged: false })
    const secret = passphrase(body.passphrase)
    if (secret !== null && !csr) return fail('VALIDATION', 'a challenge passphrase belongs to a signing request', { stateChanged: false, reason: 'passphrase' })
    return { op: 'create', key, label: label(body.label), request, csr, days, passphrase: secret }
  }
  if (body.op === 'import') {
    only(body, ['op', 'kind', 'pem', 'label'])
    if (body.kind !== 'key' && body.kind !== 'certificate') return fail('VALIDATION', 'only keys and certificates can be imported', { stateChanged: false })
    if (body.kind === 'key') parseStoreKey(body.pem)
    else parseStoreCertificate(body.pem)
    return { op: 'import', kind: body.kind, pem: body.pem as string, label: label(body.label) }
  }
  if (body.op === 'view') { only(body, ['op', 'kind', 'id']); return { op: 'view', kind: storeKind(body.kind), id: storeId(body.id) } }
  if (body.op === 'delete') {
    only(body, ['op', 'kind', 'id', 'modifiedAt'])
    if (typeof body.modifiedAt !== 'string' || !Number.isFinite(Date.parse(body.modifiedAt))) return fail('VALIDATION', 'modifiedAt must be the time the item was read', { stateChanged: false })
    return { op: 'delete', kind: storeKind(body.kind), id: storeId(body.id), modifiedAt: body.modifiedAt }
  }
  if (body.op === 'label') {
    only(body, ['op', 'kind', 'id', 'label'])
    if (!Object.hasOwn(body, 'label')) return fail('VALIDATION', 'a name, or null to clear it, is required', { stateChanged: false, reason: 'label' })
    return { op: 'label', kind: storeKind(body.kind), id: storeId(body.id), label: label(body.label) }
  }
  if (body.op === 'material') { only(body, ['op', 'certificateId']); return { op: 'material', certificateId: storeId(body.certificateId) } }
  return fail('VALIDATION', 'unsupported SSL storage operation', { stateChanged: false })
}

// ---- openssl req ---------------------------------------------------------------------------

// OpenSSL NCONF values: a backslash makes the next quote, comment or variable character literal.
const confValue = (text: string): string => text.replace(/[\\"'$#]/g, character => '\\' + character)
/** The request file for a challenge passphrase: with prompt = no the subject and the attribute come from it, never from argv. */
export function requestConfig(request: SslRequest, secret: string): string {
  const dn = [...SUBJECT_FIELDS.flatMap(([name, short]) => request.subject[name] ? [short + ' = ' + confValue(request.subject[name]!)] : []),
    'CN = ' + confValue(request.names[0]!), ...(request.subject.email ? ['emailAddress = ' + confValue(request.subject.email)] : [])]
  return ['[req]', 'distinguished_name = req_dn', 'attributes = req_attributes', 'prompt = no', '[req_dn]', ...dn, '[req_attributes]', 'challengePassword = ' + confValue(secret), ''].join('\n')
}
const SAN = 'subjectAltName='
const SELF_SIGNED = ['-x509', '-days', '', '-addext', 'basicConstraints=critical,CA:FALSE']
/** One reviewed tail: a key path, the subject or a request file, the names and, for a self-signed certificate, its days. */
export function opensslRequestArgv(keyPath: string, request: SslRequest, days: number | null, configPath: string | null = null): string[] {
  return [OPENSSL_BINARY, 'req', '-new', '-key', keyPath, '-passin', 'pass:', ...(configPath === null ? ['-subj', subjectArgument(request)] : ['-config', configPath]), '-utf8', '-sha256', '-batch',
    '-addext', SAN + request.names.map(name => 'DNS:' + name).join(','), ...(days === null ? [] : SELF_SIGNED.map(token => token === '' ? String(days) : token))]
}
/** Exact tail admission; the request file variant is a signing request only. */
function admitOpensslTail(tail: readonly string[], keyPath: RegExp, configPath: RegExp): boolean {
  if (tail.length !== 14 && tail.length !== 19) return false
  const sans = tail[13]?.startsWith(SAN) ? tail[13].slice(SAN.length).split(',') : null
  const days = tail.length === 19 ? Number(tail[16]) : null
  if (!keyPath.test(tail[4] ?? '') || !sans || sans.some(name => !name.startsWith('DNS:')) || (days !== null && (!Number.isSafeInteger(days) || String(days) !== tail[16]))) return false
  try {
    const names = sans.map(name => name.slice(4))
    let request: SslRequest, config: string | null = null
    if (tail[7] === '-config') {
      if (!configPath.test(tail[8] ?? '') || days !== null) return false
      request = parseSslRequest(names, {}); config = tail[8]!
    } else {
      const fields = (tail[8] ?? '').split('/').slice(1).map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)] as const)
      const short = new Map<string, string>(SUBJECT_FIELDS.map(([name, code]) => [code, name]))
      if (fields.find(([key]) => key === 'CN')?.[1] !== names[0]) return false
      request = parseSslRequest(names, Object.fromEntries(fields.flatMap(([key, value]) => short.has(key) ? [[short.get(key)!, value]] : key === 'emailAddress' ? [['email', value]] : [])))
    }
    return JSON.stringify(tail) === JSON.stringify(opensslRequestArgv(tail[4]!, request, days, config))
  } catch { return false }
}
const ACCOUNT_KEY = /^ssl\/keys\/[a-z0-9][a-z0-9_-]{0,63}\.key$/, ACCOUNT_CONFIG = /^ssl\/\.req-[0-9a-f]{16}\.cnf$/
const sandbox = (account: Pick<Account, 'username' | 'uid' | 'gid' | 'home'>): string[] => {
  const skeleton = system.buildJailedFileOpArgv(account, ['/usr/bin/id'])
  return [...skeleton.slice(0, skeleton.lastIndexOf('--')).map(value => value === 'User=' + account.username ? 'User=' + account.uid : value === 'Group=' + account.username ? 'Group=' + account.gid : value),
    '--property', 'RuntimeMaxSec=30s', '--property', 'TimeoutStopSec=5s', '--property', 'MemoryMax=128M', '--property', 'TasksMax=4',
    '--property', 'UnsetEnvironment=OPENSSL_CONF OPENSSL_ENGINES OPENSSL_MODULES LD_PRELOAD LD_LIBRARY_PATH', '--']
}
const accountKeyPath = (id: string): string => SSL_STORE_PATHS.key + '/' + id + EXTENSION.key
/** The account's own jail and slice: openssl reads the key with the account's permissions, never root's. */
export const buildSslStoreCommand = (account: Pick<Account, 'username' | 'uid' | 'gid' | 'home'>, keyId: string, request: SslRequest, days: number | null, configPath: string | null = null): string[] =>
  [...sandbox(account), ...opensslRequestArgv(accountKeyPath(keyId), request, days, configPath)]

/** Exact outer admission: one jailed `openssl req` with reviewed flags, never another binary, option or path. */
export function isSslStoreCommand(argv: readonly string[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  // Array.isArray narrows a readonly array to any[]; keep the element type.
  const delimiter = argv.indexOf('--'), tail: readonly string[] = argv.slice(delimiter + 1)
  if (delimiter < 1 || tail[0] !== OPENSSL_BINARY) return false
  const uid = argv.find(value => /^User=[0-9]+$/.test(value))?.slice(5), gid = argv.find(value => /^Group=[0-9]+$/.test(value))?.slice(6)
  const bound = argv.find(value => value.startsWith('BindPaths='))?.slice(10), user = bound?.match(/^\/home[1-9]?[0-9]?\/([a-z][a-z0-9]{0,15})$/)?.[1]
  if (!uid || !gid || !user) return false
  try {
    const prefix: readonly string[] = argv.slice(0, delimiter + 1)
    return JSON.stringify(prefix) === JSON.stringify(sandbox({ username: user, uid: Number(uid), gid: Number(gid), home: bound! })) && admitOpensslTail(tail, ACCOUNT_KEY, ACCOUNT_CONFIG)
  } catch { return false }
}

export type SslStoreRun = (account: Account, keyId: string, request: SslRequest, days: number | null, configPath: string | null) => Promise<string>
/** Only construct this adapter for a native Linux executor. */
export function createSslStoreRun(run: (argv: string[]) => Promise<ConfigTestResult>): SslStoreRun {
  return async (account, keyId, request, days, configPath) => {
    const home = account.home
    const info = await lstat(home).catch(() => null)
    if (!isAccountHome(home, account.username) || !info?.isDirectory() || info.isSymbolicLink() || info.uid !== account.uid || info.gid !== account.gid || await realpath(home) !== home) return fail('PRECONDITION_FAILED', 'the account home identity could not be verified', { stateChanged: false })
    const argv = buildSslStoreCommand(account, keyId, request, days, configPath)
    if (!isSslStoreCommand(argv)) return fail('PRECONDITION_FAILED', 'the isolated openssl command was not admitted', { stateChanged: false })
    const result = await run(argv)
    if (!result.ok || Buffer.byteLength(result.stdout) > SSL_STORE_MAX_PEM_BYTES) return fail('PRECONDITION_FAILED', 'openssl did not produce the requested PEM', { stateChanged: false })
    return result.stdout
  }
}

/** Root's own store (WHM SSL Storage Manager): root-owned files under the root-private state of /var/lib/xpanel. */
export const ROOT_SSL_STORE_DIRECTORY = '/var/lib/xpanel/ssl-store'
const ROOT_INDEX = ROOT_SSL_STORE_DIRECTORY + '/index.json'
const rootPath = (kind: SslStoreKind, id: string): string => ROOT_SSL_STORE_DIRECTORY + '/' + id + EXTENSION[kind]
const ROOT_KEY = /^\/var\/lib\/xpanel\/ssl-store\/[a-z0-9][a-z0-9_-]{0,63}\.key$/, ROOT_CONFIG = /^\/var\/lib\/xpanel\/ssl-store\/\.req-[0-9a-f]{16}\.cnf$/
export const rootSslStoreCommand = (keyId: string, request: SslRequest, days: number | null, configPath: string | null = null): string[] => opensslRequestArgv(rootPath('key', keyId), request, days, configPath)
/** Root runs openssl only on its own store paths; the file names are fixed by this grammar. */
export const isRootSslStoreCommand = (argv: readonly string[]): boolean => Array.isArray(argv) && argv.every(value => typeof value === 'string') && argv[0] === OPENSSL_BINARY && admitOpensslTail(argv, ROOT_KEY, ROOT_CONFIG)

// ---- Store backends ------------------------------------------------------------------------

export interface SslStoreContext { scope: 'account' | 'server'; accountId: string | null; username: string | null }
interface StoreEntry { id: string; modifiedAt: string; sizeBytes: number }
export interface StoreListing { directory: SslStoreView['directory']; present: Record<SslStoreKind, boolean>; entries: Record<SslStoreKind, StoreEntry[]>; truncated: boolean }
/** Where one store's files live; the request logic is the same for an account and for root. */
export interface SslStoreBackend {
  readonly context: SslStoreContext
  list(): Promise<StoreListing>
  read(kind: SslStoreKind, id: string): Promise<{ content: string; modifiedAt: string }>
  /** Creates the missing folders before the first new file. */
  prepare(listing: StoreListing, kinds: readonly SslStoreKind[]): Promise<void>
  /** A new file only, read back before it counts. */
  create(kind: SslStoreKind, id: string, pem: string): Promise<void>
  remove(kind: SslStoreKind, id: string, current: { content: string; modifiedAt: string }): Promise<void>
  labels(kind: SslStoreKind): Promise<{ labels: Record<string, string>; token: unknown }>
  saveLabels(kind: SslStoreKind, labels: Record<string, string>, token: unknown): Promise<void>
  /** openssl req with the stored key; `config` is the request file text for a challenge passphrase, removed after use. */
  readonly openssl: ((keyId: string, request: SslRequest, days: number | null, config: string | null) => Promise<string>) | null
}
const emptyListing = (): StoreListing => ({ directory: 'absent', present: { key: false, csr: false, certificate: false }, entries: { key: [], csr: [], certificate: [] }, truncated: false })
const parseLabels = (text: string): Record<string, string> => {
  let value: unknown
  try { value = JSON.parse(text) } catch { return fail('SERVICE_UNAVAILABLE', 'the saved SSL storage names are unreadable', { stateChanged: false, reason: 'labels_unreadable' }) }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([id, name]) => !SSL_STORE_ID.test(id) || typeof name !== 'string' || !SSL_STORE_LABEL.test(name))) return fail('SERVICE_UNAVAILABLE', 'the saved SSL storage names are unreadable', { stateChanged: false, reason: 'labels_unreadable' })
  return value as Record<string, string>
}
const requestFileId = (): string => '.req-' + randomBytes(8).toString('hex') + '.cnf'

export type SslStoreFiles = Pick<JailedFileManager, 'list' | 'readText' | 'writeText' | 'writeTextChecked' | 'mkdir'>
const filePath = (kind: SslStoreKind, id: string): string => SSL_STORE_PATHS[kind] + '/' + id + EXTENSION[kind]
const labelsPath = (kind: SslStoreKind): string => SSL_STORE_PATHS[kind] + '/.labels.json'
const mkdir = async (files: SslStoreFiles, path: string): Promise<void> => {
  // mkdirat(2) EEXIST means another writer created it first; the following write proves its kind.
  try { await files.mkdir(path, DIRECTORY_MODE) } catch (error) { if (!isXpanelError(error) || error.code !== 'CONFLICT') throw error }
}
const notFound = (error: unknown): boolean => isXpanelError(error) && error.code === 'NOT_FOUND'
const removeChecked = async (files: SslStoreFiles, path: string, mode: number): Promise<void> => { await files.writeTextChecked(path, null, await files.readText(path), mode) }

/** ~/ssl through the confined account file runner only; the caller holds the account lifecycle lease. */
export function accountSslStore(account: Account, files: SslStoreFiles, run: SslStoreRun | null): SslStoreBackend {
  return {
    context: { scope: 'account', accountId: account.id, username: account.username },
    async list() {
      const listing = emptyListing()
      const root = (await files.list('', { showHidden: true })).find(entry => entry.path === SSL_STORE_DIRECTORY)
      if (!root) return listing
      if (root.kind !== 'directory') return { ...listing, directory: 'unmanageable' }
      listing.directory = 'ready'
      const entries = await files.list(SSL_STORE_DIRECTORY, { showHidden: true })
      for (const kind of SSL_STORE_KINDS) {
        const entry = entries.find(item => item.path === SSL_STORE_PATHS[kind])
        if (!entry) continue
        if (entry.kind !== 'directory') return { ...listing, directory: 'unmanageable' }
        listing.present[kind] = true
        const stored = (await files.list(SSL_STORE_PATHS[kind], { showHidden: false }))
          .filter(item => item.kind === 'file' && item.name.endsWith(EXTENSION[kind]) && SSL_STORE_ID.test(item.name.slice(0, -EXTENSION[kind].length)))
          .map(item => ({ id: item.name.slice(0, -EXTENSION[kind].length), modifiedAt: item.mtime, sizeBytes: item.sizeBytes })).sort((a, b) => a.id < b.id ? -1 : 1)
        if (stored.length > SSL_STORE_MAX_ITEMS) listing.truncated = true
        listing.entries[kind] = stored.slice(0, SSL_STORE_MAX_ITEMS)
      }
      return listing
    },
    async read(kind, id) {
      try { const file = await files.readText(filePath(kind, id)); return { content: file.content, modifiedAt: file.mtime } }
      catch (error) { if (notFound(error)) return fail('NOT_FOUND', 'stored item not found', { stateChanged: false }); throw error }
    },
    async prepare(listing, kinds) {
      if (listing.directory === 'absent') await mkdir(files, SSL_STORE_DIRECTORY)
      for (const kind of kinds) if (!listing.present[kind]) await mkdir(files, SSL_STORE_PATHS[kind])
    },
    async create(kind, id, pem) {
      const path = filePath(kind, id)
      const entry = await files.writeText(path, pem, { overwrite: false, mode: FILE_MODE[kind] })
      const saved = await files.readText(path)
      if (saved.content !== pem || entry.mtime !== saved.mtime || entry.mode !== FILE_MODE[kind]) throw new Error('ssl_store_readback')
    },
    async remove(kind, id, current) {
      const path = filePath(kind, id)
      await files.writeTextChecked(path, null, { path, content: current.content, sizeBytes: Buffer.byteLength(current.content, 'utf8'), mtime: current.modifiedAt }, FILE_MODE[kind])
    },
    async labels(kind) {
      try { const file = await files.readText(labelsPath(kind)); return { labels: parseLabels(file.content), token: file } }
      catch (error) { if (notFound(error)) return { labels: {}, token: null }; throw error }
    },
    async saveLabels(kind, labels, token) {
      const content = Object.keys(labels).length ? JSON.stringify(labels, null, 2) + '\n' : null
      if (content === null && token === null) return
      await files.writeTextChecked(labelsPath(kind), content, token as FileText | null, 0o600)
    },
    openssl: run ? async (keyId, request, days, config) => {
      if (config === null) return run(account, keyId, request, days, null)
      const path = SSL_STORE_DIRECTORY + '/' + requestFileId()
      await files.writeText(path, config, { overwrite: false, mode: 0o600 })
      let output: string, removed = false
      try { output = await run(account, keyId, request, days, path) }
      finally { try { await removeChecked(files, path, 0o600); removed = true } catch { removed = false } }
      // The request file holds the passphrase; a request that leaves it behind is not complete.
      if (!removed) throw new Error('ssl_store_request_file_remains')
      return output
    } : null,
  }
}

type RootExecutor = Pick<AgentExecutor, 'readFile' | 'writeFile' | 'removePath' | 'runAction' | 'runCommand'>
interface RootIndex { version: 1; items: { kind: SslStoreKind; id: string; createdAt: string; label: string | null }[] }
let rootQueue: Promise<unknown> = Promise.resolve()
/** One root store change at a time in this agent; the index is compared again before it is replaced. */
export const withRootSslStore = <T>(work: () => Promise<T>): Promise<T> => { const next = rootQueue.then(work, work); rootQueue = next.catch(() => undefined); return next }
const rootFile = (path: string, content: string) => ({ path, content, mode: 0o600, owner: 'root', group: 'root' })

/** Root-owned 0700 directory, 0600 files and one index; written only through the executor's reviewed host targets. */
export function rootSslStore(executor: RootExecutor, opensslAvailable: boolean, now: () => Date = () => new Date()): SslStoreBackend {
  const readIndex = async (): Promise<RootIndex | null> => {
    const text = await executor.readFile(ROOT_INDEX)
    if (text === null) return null
    const unreadable = (): never => fail('SERVICE_UNAVAILABLE', 'the server SSL storage index is unreadable', { stateChanged: false, reason: 'index_unreadable' })
    let value: unknown
    try { value = JSON.parse(text) } catch { return unreadable() }
    const index = value as RootIndex
    if (!index || index.version !== 1 || !Array.isArray(index.items) || index.items.length > 3 * SSL_STORE_MAX_ITEMS || index.items.some(item => !item || !(SSL_STORE_KINDS as readonly unknown[]).includes(item.kind)
      || !SSL_STORE_ID.test(item.id) || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || (item.label !== null && (typeof item.label !== 'string' || !SSL_STORE_LABEL.test(item.label))))) return unreadable()
    return index
  }
  const writeIndex = async (next: RootIndex, previous: RootIndex | null): Promise<void> => {
    if (JSON.stringify(await readIndex()) !== JSON.stringify(previous)) return fail('CONFLICT', 'the server SSL storage changed; read it again', { stateChanged: false })
    const content = JSON.stringify(next, null, 2) + '\n'
    await executor.writeFile(rootFile(ROOT_INDEX, content))
    if (await executor.readFile(ROOT_INDEX) !== content) throw new Error('ssl_store_index_readback')
  }
  const entryOf = async (kind: SslStoreKind, id: string) => {
    const index = await readIndex(), entry = index?.items.find(item => item.kind === kind && item.id === id)
    return entry ? { index: index!, entry } : fail('NOT_FOUND', 'stored item not found', { stateChanged: false })
  }
  return {
    context: { scope: 'server', accountId: null, username: null },
    async list() {
      const index = await readIndex(), listing = emptyListing()
      if (!index) return listing
      listing.directory = 'ready'
      for (const kind of SSL_STORE_KINDS) {
        listing.present[kind] = true
        listing.entries[kind] = index.items.filter(item => item.kind === kind).map(item => ({ id: item.id, modifiedAt: item.createdAt, sizeBytes: 0 })).sort((a, b) => a.id < b.id ? -1 : 1)
      }
      return listing
    },
    async read(kind, id) {
      const { entry } = await entryOf(kind, id), content = await executor.readFile(rootPath(kind, id))
      return content === null ? fail('NOT_FOUND', 'stored item not found', { stateChanged: false }) : { content, modifiedAt: entry.createdAt }
    },
    async prepare(listing) {
      if (listing.directory !== 'absent') return
      await executor.runAction({ kind: 'ensure-dir', path: ROOT_SSL_STORE_DIRECTORY, mode: 0o700, owner: 'root', group: 'root' })
      if (await readIndex() === null) await writeIndex({ version: 1, items: [] }, null)
    },
    async create(kind, id, pem) {
      const index = await readIndex() ?? fail('CONFLICT', 'the server SSL storage changed; read it again', { stateChanged: false })
      if (await executor.readFile(rootPath(kind, id)) !== null) return fail('CONFLICT', 'stored item already exists', { stateChanged: false })
      await executor.writeFile(rootFile(rootPath(kind, id), pem))
      if (await executor.readFile(rootPath(kind, id)) !== pem) throw new Error('ssl_store_readback')
      await writeIndex({ version: 1, items: [...index.items, { kind, id, createdAt: now().toISOString(), label: null }] }, index)
    },
    async remove(kind, id, current) {
      const { index, entry } = await entryOf(kind, id)
      if (entry.createdAt !== current.modifiedAt || await executor.readFile(rootPath(kind, id)) !== current.content) return fail('CONFLICT', 'the stored item changed; read it before deleting', { stateChanged: false })
      await executor.removePath(rootPath(kind, id))
      if (await executor.readFile(rootPath(kind, id)) !== null) throw new Error('ssl_store_remove_readback')
      await writeIndex({ version: 1, items: index.items.filter(item => item !== entry) }, index)
    },
    async labels(kind) {
      const index = await readIndex()
      return { labels: Object.fromEntries((index?.items ?? []).filter(item => item.kind === kind && item.label !== null).map(item => [item.id, item.label!])), token: index }
    },
    async saveLabels(kind, labels, token) {
      const index = token as RootIndex | null
      if (!index) return fail('NOT_FOUND', 'stored item not found', { stateChanged: false })
      await writeIndex({ version: 1, items: index.items.map(item => item.kind === kind ? { ...item, label: labels[item.id] ?? null } : item) }, index)
    },
    openssl: opensslAvailable ? async (keyId, request, days, config) => {
      const path = config === null ? null : ROOT_SSL_STORE_DIRECTORY + '/' + requestFileId()
      const argv = rootSslStoreCommand(keyId, request, days, path)
      if (!isRootSslStoreCommand(argv)) return fail('PRECONDITION_FAILED', 'the openssl command was not admitted', { stateChanged: false })
      if (path !== null) await executor.writeFile(rootFile(path, config!))
      let result: ConfigTestResult, removed = true
      try { result = await executor.runCommand(argv) }
      finally { if (path !== null) { try { await executor.removePath(path); removed = await executor.readFile(path) === null } catch { removed = false } } }
      if (!removed) throw new Error('ssl_store_request_file_remains')
      if (!result.ok || Buffer.byteLength(result.stdout) > SSL_STORE_MAX_PEM_BYTES) return fail('PRECONDITION_FAILED', 'openssl did not produce the requested PEM', { stateChanged: false })
      return result.stdout
    } : null,
  }
}

// ---- Requests on a store -------------------------------------------------------------------

const parseKind = (kind: SslStoreKind, text: string) => kind === 'key' ? parseStoreKey(text) : kind === 'csr' ? parseStoreCsr(text) : parseStoreCertificate(text)
const invalidItem = (kind: SslStoreKind, id: string, modifiedAt: string, name: string | null): SslStoreItem => kind === 'key'
  ? { id, label: name, modifiedAt, valid: false, publicKeySha256: null, keyType: null, bits: null, curve: null }
  : kind === 'csr' ? { id, label: name, modifiedAt, valid: false, publicKeySha256: null, commonName: null, names: [] }
    : { id, label: name, modifiedAt, valid: false, publicKeySha256: null, commonName: null, names: [], issuer: null, selfSigned: null, notBefore: null, notAfter: null, fingerprintSha256: null }
const itemOf = (kind: SslStoreKind, id: string, content: string, modifiedAt: string, name: string | null): SslStoreItem => {
  try { return { id, label: name, modifiedAt, ...parseKind(kind, content).item } as SslStoreItem }
  catch (error) { if (isXpanelError(error) && error.code === 'VALIDATION') return invalidItem(kind, id, modifiedAt, name); throw error }
}

async function project(backend: SslStoreBackend, listing: StoreListing, status: SslStoreView['application']['status'], changed: SslStoreView['application']['changed'] = []): Promise<SslStoreView> {
  const items: Record<SslStoreKind, SslStoreItem[]> = { key: [], csr: [], certificate: [] }
  for (const kind of SSL_STORE_KINDS) {
    const list = listing.entries[kind], names = list.length ? (await backend.labels(kind)).labels : {}
    // Four reads at a time: the confined helper pool admits four workers per host.
    for (let index = 0; index < list.length; index += 4) {
      items[kind].push(...await Promise.all(list.slice(index, index + 4).map(async ({ id, modifiedAt, sizeBytes }) => {
        const name = names[id] ?? null
        if (sizeBytes > SSL_STORE_MAX_PEM_BYTES) return invalidItem(kind, id, modifiedAt, name)
        try { const file = await backend.read(kind, id); return itemOf(kind, id, file.content, file.modifiedAt, name) }
        catch (error) { if (isXpanelError(error) && ['NOT_FOUND', 'VALIDATION', 'LIMIT_EXCEEDED'].includes(error.code)) return invalidItem(kind, id, modifiedAt, name); throw error }
      })))
    }
  }
  return { context: backend.context, directory: listing.directory,
    keys: items.key as SslKeyItem[], csrs: items.csr as SslCsrItem[], certificates: items.certificate as SslCertificateItem[],
    limits: { maxItems: SSL_STORE_MAX_ITEMS, truncated: listing.truncated }, application: { status, changed } }
}

const slug = (text: string): string => text.toLowerCase().replace(/^\*\./, 'wildcard.').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'item'
const newId = (base: string): string => slug(base) + '_' + randomBytes(4).toString('hex')
const generateKey = (type: SslKeyType): Promise<string> => new Promise((resolve, reject) => {
  const done = (error: Error | null, _public: KeyObject, privateKey: KeyObject): void => { if (error) reject(error); else resolve(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string) }
  if (type.startsWith('rsa-')) generateKeyPair('rsa', { modulusLength: Number(type.slice(4)) }, done)
  else generateKeyPair('ec', { namedCurve: type.slice(6) }, done)
})
const setLabels = async (backend: SslStoreBackend, items: readonly { kind: SslStoreKind; id: string }[], name: string | null): Promise<void> => {
  for (const kind of SSL_STORE_KINDS) {
    const ids = items.filter(item => item.kind === kind).map(item => item.id)
    if (!ids.length) continue
    const current = await backend.labels(kind), next = { ...current.labels }
    for (const id of ids) { if (name === null) delete next[id]; else next[id] = name }
    if (JSON.stringify(next) !== JSON.stringify(current.labels)) await backend.saveLabels(kind, next, current.token)
  }
}

export interface SslStoreRunInput {
  backend: SslStoreBackend
  /** Fresh caller authority immediately before the first host change. */
  authorize: () => Promise<void>
}
export type SslStoreResult = SslStoreView | { item: SslStoreItem; pem: string } | { certificate: SslCertificateItem; certificatePem: string; keyId: string; privateKeyPem: string }
const uncertain = (changed: SslStoreView['application']['changed']) => fail('SERVICE_UNAVAILABLE', changed.length ? 'the store change stopped part way; review the saved items before retrying' : 'the store change requires inspection; no retry was sent',
  { stateChanged: true, unknownOutcome: true, verificationRequired: true, saved: changed })

/** Every read and write goes through the backend; key text leaves only through view and material. */
export async function runSslStoreRequest(input: SslStoreRunInput, request: SslStoreRequest | { op: 'read' }): Promise<SslStoreResult> {
  const { backend } = input
  const listing = await backend.list()
  const exists = (kind: SslStoreKind, id: string): boolean => listing.directory === 'ready' && listing.present[kind] && listing.entries[kind].some(entry => entry.id === id)
  if (request.op === 'read') return project(backend, listing, 'read')
  if (request.op === 'view') {
    if (!exists(request.kind, request.id)) return fail('NOT_FOUND', 'stored item not found', { stateChanged: false })
    const file = await backend.read(request.kind, request.id), parsed = parseKind(request.kind, file.content)
    return { item: { id: request.id, label: (await backend.labels(request.kind)).labels[request.id] ?? null, modifiedAt: file.modifiedAt, ...parsed.item } as SslStoreItem, pem: parsed.pem }
  }
  if (request.op === 'material') {
    if (!exists('certificate', request.certificateId)) return fail('NOT_FOUND', 'stored certificate not found', { stateChanged: false })
    const file = await backend.read('certificate', request.certificateId), parsed = parseStoreCertificate(file.content)
    for (const { id } of listing.entries.key) {
      let key: ParsedKey
      try { key = parseStoreKey((await backend.read('key', id)).content) } catch { continue }
      if (key.item.publicKeySha256 === parsed.item.publicKeySha256) return { certificate: { id: request.certificateId, label: null, modifiedAt: file.modifiedAt, ...parsed.item }, certificatePem: parsed.pem, keyId: id, privateKeyPem: key.pem }
    }
    return refuse('key_missing', 'no stored private key matches this certificate', 'NOT_FOUND')
  }
  if (listing.directory === 'unmanageable') return refuse('directory_unmanageable', 'the ~/ssl folder is not a plain folder; fix it in the file manager first', 'PRECONDITION_FAILED')
  if (request.op === 'label') {
    if (!exists(request.kind, request.id)) return fail('NOT_FOUND', 'stored item not found', { stateChanged: false })
    await input.authorize()
    try { await setLabels(backend, [{ kind: request.kind, id: request.id }], request.label) }
    catch (error) { if (isXpanelError(error) && error.detail?.stateChanged === false) throw error; return uncertain([]) }
    return project(backend, await backend.list(), 'labelled', [{ kind: request.kind, id: request.id }])
  }
  if (request.op === 'delete') {
    if (!exists(request.kind, request.id)) return fail('NOT_FOUND', 'stored item not found', { stateChanged: false })
    const current = await backend.read(request.kind, request.id)
    if (current.modifiedAt !== request.modifiedAt) return fail('CONFLICT', 'the stored item changed; read it before deleting', { stateChanged: false })
    await input.authorize()
    let removed = false
    try { await backend.remove(request.kind, request.id, current); removed = true; await setLabels(backend, [{ kind: request.kind, id: request.id }], null) }
    catch (error) { if (!removed && isXpanelError(error) && error.code === 'CONFLICT' && error.detail?.stateChanged === false) throw error; return fail('SERVICE_UNAVAILABLE', 'the removal requires inspection; no retry was sent', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
    return project(backend, await backend.list(), 'removed', [{ kind: request.kind, id: request.id }])
  }

  // Import and create: parse and generate everything that needs no host change first.
  const writes: { kind: SslStoreKind; id: string; pem: string }[] = []
  let stored: { id: string; parsed: ParsedKey } | null = null
  if (request.op === 'import') {
    if (request.kind === 'key') { const parsed = parseStoreKey(request.pem); writes.push({ kind: 'key', id: newId(request.label ?? (parsed.item.keyType ?? 'key') + (parsed.item.bits ?? '')), pem: parsed.pem }) }
    else { const parsed = parseStoreCertificate(request.pem); writes.push({ kind: 'certificate', id: newId(request.label ?? parsed.item.names[0] ?? parsed.item.commonName ?? 'certificate'), pem: parsed.pem }) }
  } else {
    if ('id' in request.key) {
      if (!exists('key', request.key.id)) return refuse('key_missing', 'the stored key was not found', 'NOT_FOUND')
      stored = { id: request.key.id, parsed: parseStoreKey((await backend.read('key', request.key.id)).content) }
    } else writes.push({ kind: 'key', id: newId(request.label ?? request.request?.names[0] ?? request.key.type), pem: await generateKey(request.key.type) })
    if (request.request && !backend.openssl) return fail('PRECONDITION_FAILED', 'certificate request creation needs the native openssl runner', { stateChanged: false, reason: 'openssl_unavailable' })
  }
  const kinds = [...new Set([...writes.map(write => write.kind), ...(request.op === 'create' && request.csr ? ['csr' as const] : []), ...(request.op === 'create' && request.days !== null ? ['certificate' as const] : [])])]
  for (const kind of kinds) if (listing.entries[kind].length >= SSL_STORE_MAX_ITEMS || listing.truncated) return refuse('capacity', 'the store holds at most ' + SSL_STORE_MAX_ITEMS + ' items of each kind', 'PRECONDITION_FAILED')

  await input.authorize()
  const changed: SslStoreView['application']['changed'] = []
  try {
    await backend.prepare(listing, kinds)
    for (const item of writes) { await backend.create(item.kind, item.id, item.pem); changed.push({ kind: item.kind, id: item.id }) }
    if (request.op === 'create' && request.request) {
      const keyId = stored?.id ?? writes[0]!.id
      const publicKey = stored?.parsed.item.publicKeySha256 ?? parseStoreKey(writes[0]!.pem).item.publicKeySha256
      const outputs: [SslStoreKind, number | null][] = [...(request.csr ? [['csr', null] as [SslStoreKind, null]] : []), ...(request.days !== null ? [['certificate', request.days] as [SslStoreKind, number]] : [])]
      for (const [kind, days] of outputs) {
        const config = kind === 'csr' && request.passphrase !== null ? requestConfig(request.request, request.passphrase) : null
        const parsed = kind === 'csr' ? parseStoreCsr(await backend.openssl!(keyId, request.request, null, config)) : parseStoreCertificate(await backend.openssl!(keyId, request.request, days, null))
        // The output must be signed by the key read from the store and carry the requested names.
        if (parsed.item.publicKeySha256 !== publicKey || JSON.stringify([...parsed.item.names].sort()) !== JSON.stringify([...request.request.names].sort())) throw new Error('ssl_store_output_mismatch')
        await backend.create(kind, keyId, parsed.pem); changed.push({ kind, id: keyId })
      }
    }
    if (request.label !== null) await setLabels(backend, changed, request.label)
  } catch (error) {
    if (!changed.length && isXpanelError(error) && error.detail?.stateChanged === false) throw error
    return uncertain(changed)
  }
  return project(backend, await backend.list(), request.op === 'import' ? 'imported' : 'created', changed)
}

// ---- Service certificate from the root store -------------------------------------------------

/** Postfix and Dovecot use the saved certificate covering the server hostname; the panel listener and FTP take none from the store. */
export const SSL_STORE_SERVICES = ['mail', 'panel', 'ftp'] as const
export type SslStoreService = typeof SSL_STORE_SERVICES[number]
export interface ServiceCertificateCandidate { id: string; names: string[]; notBefore: string; notAfter: string; certPath: string; keyPath: string; fingerprintSha256: string }
/** Validates the stored certificate, its CA bundle and matching key for the hostname, then writes an immutable root-owned candidate. */
export async function publishServiceCertificate(input: { backend: SslStoreBackend; certificateId: string; caBundlePem: string | null; hostname: string | null; executor: AgentExecutor; now: Date }): Promise<ServiceCertificateCandidate> {
  const material = await runSslStoreRequest({ backend: input.backend, authorize: async () => undefined }, { op: 'material', certificateId: input.certificateId }) as { certificate: SslCertificateItem; certificatePem: string; privateKeyPem: string }
  if (material.certificate.selfSigned) return refuse('self_signed', 'mail clients refuse self-signed certificates; install one a certificate authority issued')
  if (!input.hostname || !input.hostname.includes('.')) return refuse('hostname_unset', 'the server hostname is not set', 'PRECONDITION_FAILED')
  const bundle = input.caBundlePem === null ? [] : parseBundle(input.caBundlePem)
  const chain = [new X509Certificate(material.certificatePem), ...bundle]
  for (let index = 0; index + 1 < chain.length; index++) if (!chain[index]!.checkIssued(chain[index + 1]!) || !chain[index]!.verify(chain[index + 1]!.publicKey) || !chain[index + 1]!.ca) return refuse('chain_order', 'the CA bundle does not issue the certificate in order')
  let verified: ReturnType<typeof verifyIssuedCertificateBundle>
  try { verified = verifyIssuedCertificateBundle(material.certificatePem + bundle.map(certificate => certificate.toString()).join(''), material.privateKeyPem, [input.hostname], input.now) }
  catch { return refuse('names', 'the certificate is not valid now or does not cover the server hostname ' + input.hostname) }
  const id = randomUUID(), files = await publishCertificateCandidate({ executor: input.executor, certificateId: id, fullchain: verified.fullchain, privateKey: verified.privkey })
  return { id, names: [...new Set(verified.dnsSans.map(name => name.toLowerCase()))].sort(), notBefore: material.certificate.notBefore ?? input.now.toISOString(), notAfter: verified.notAfterIso, ...files, fingerprintSha256: verified.fingerprintSha256 }
}
const parseBundle = (text: string): X509Certificate[] => {
  if (Buffer.byteLength(text, 'utf8') > 8 * SSL_STORE_MAX_PEM_BYTES) return refuse('too_large', 'the CA bundle is too large')
  const blocks = text.match(/-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----/g) ?? []
  if (!blocks.length || text.replace(/-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----/g, '').trim()) return refuse('certificate_format', 'the CA bundle must hold PEM certificates only')
  try { return blocks.map(block => new X509Certificate(block)) } catch { return refuse('certificate_format', 'the CA bundle could not be read') }
}

// ---- Agent routes --------------------------------------------------------------------------

type AuditEntry = { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok'; principalId: string }
export interface SslStoreRouteDeps {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; withAccountLifecycleLease<T>(accountId: string, operation: (account: Account) => Promise<T>): Promise<T>
    getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null> }
  /** Root, the owning reseller or the account owner, from a direct local principal read inside the lease. */
  authorizeCaller(account: Account): Promise<void>
  files(account: Account, plan: Plan): SslStoreFiles | null
  run: SslStoreRun | null
  audit(entry: AuditEntry): Promise<unknown>
}
const ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/ssl-store$/
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const kindsOf = (request: SslStoreRequest | { op: 'read' }): SslStoreKind[] => request.op === 'read' ? [...SSL_STORE_KINDS]
  : request.op === 'create' ? ['key', ...(request.csr ? ['csr' as const] : []), ...(request.days !== null ? ['certificate' as const] : [])]
    : request.op === 'material' ? ['key', 'certificate'] : [request.kind]
const AUDIT_ACTIONS: Partial<Record<SslStoreRequest['op'], string>> = { create: 'ssl_store.created', import: 'ssl_store.imported', delete: 'ssl_store.removed', label: 'ssl_store.renamed' }
// Names, ids and key types only; no PEM text, passphrase or label beyond the saved name.
const auditDetail = (request: SslStoreRequest, result: SslStoreView): Record<string, unknown> => ({ changed: result.application.changed,
  ...(request.op === 'create' ? { keyType: 'type' in request.key ? request.key.type : null, names: request.request?.names ?? [], days: request.days, challengePassphrase: request.passphrase !== null } : {}),
  ...(request.op === 'label' ? { label: request.label } : {}) })
const readRequest = async (req: Request, method: string): Promise<unknown> => {
  if (method !== 'POST') return undefined
  const text = await req.text()
  if (text.length > 64 * 1024) return fail('LIMIT_EXCEEDED', 'SSL storage request is too large', { stateChanged: false })
  try { return JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', { stateChanged: false }) }
}
async function respond(deps: { caller: AgentCallerIdentity; audit(entry: AuditEntry): Promise<unknown> }, target: string, input: SslStoreRunInput, request: SslStoreRequest | { op: 'read' }): Promise<Response> {
  const result = await runSslStoreRequest(input, request)
  const action = request.op === 'read' ? undefined : AUDIT_ACTIONS[request.op]
  if (action && request.op !== 'read' && 'application' in result) {
    try { await deps.audit({ actor: deps.caller.actor, action, target, outcome: 'ok', principalId: deps.caller.principalId, detail: auditDetail(request, result) }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the store change and its audit require inspection', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
  }
  return json(result)
}

/** GET lists metadata only; POST runs one parsed operation. Key text leaves only through view and material. */
export async function handleSslStoreRoute(req: Request, url: URL, method: string, deps: SslStoreRouteDeps): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (url.search) return fail('VALIDATION', 'SSL storage requests do not accept query selectors', { stateChanged: false })
  const raw = await readRequest(req, method)
  const request: SslStoreRequest | { op: 'read' } = raw === undefined ? { op: 'read' } : parseSslStoreRequest(raw)
  const account = await deps.store.getAccountByUsername(match[1]!)
  if (!account) return fail('NOT_FOUND', 'account not found', { stateChanged: false })
  return deps.store.withAccountLifecycleLease(account.id, async fresh => {
    const authorize = async (): Promise<Plan> => {
      if (fresh.username !== match[1] || fresh.status !== 'active') return fail('FORBIDDEN', 'the account is not active', { stateChanged: false })
      await deps.authorizeCaller(fresh)
      const plan = await deps.store.getPlan(fresh.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
      if (!plan || !features || features.disabled.includes(SSL_STORE_FEATURE_KEY) || kindsOf(request).some(kind => features.disabled.includes(SSL_STORE_TOOLS[kind]))) return fail('FORBIDDEN', 'SSL storage is disabled by the current account plan', { stateChanged: false })
      return plan
    }
    const plan = await authorize(), files = deps.files(fresh, plan)
    if (!files) return fail('PRECONDITION_FAILED', 'confined account files are unavailable on this host', { stateChanged: false })
    return respond(deps, 'account:' + fresh.username, { backend: accountSslStore(fresh, files, deps.run), authorize: async () => { await authorize() } }, request)
  })
}

export interface RootSslStoreRouteDeps {
  caller: AgentCallerIdentity
  /** Root only, from a direct local principal read. */
  authorizeRoot(): Promise<void>
  /** The native executor with its reviewed host targets; null where the store cannot exist. */
  executor: AgentExecutor | null
  opensslAvailable: boolean
  hostname(): Promise<string | null>
  audit(entry: AuditEntry): Promise<unknown>
}
/** /host/ssl-store: root's own store, plus `publish` of a stored certificate as the mail service candidate. */
export async function handleRootSslStoreRoute(req: Request, url: URL, method: string, deps: RootSslStoreRouteDeps): Promise<Response | null> {
  if (url.pathname !== '/host/ssl-store') return null
  if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (url.search) return fail('VALIDATION', 'SSL storage requests do not accept query selectors', { stateChanged: false })
  const raw = await readRequest(req, method)
  await deps.authorizeRoot()
  const executor = deps.executor ?? fail('PRECONDITION_FAILED', 'the server SSL storage needs the native host executor', { stateChanged: false, reason: 'host_unavailable' })
  const backend = rootSslStore(executor, deps.opensslAvailable)
  return withRootSslStore(async () => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).op === 'publish') {
      const body = raw as Record<string, unknown>
      only(body, ['op', 'certificateId', 'caBundlePem'])
      if (body.caBundlePem !== undefined && typeof body.caBundlePem !== 'string') return fail('VALIDATION', 'the CA bundle must be PEM text', { stateChanged: false })
      await deps.authorizeRoot()
      const candidate = await publishServiceCertificate({ backend, certificateId: storeId(body.certificateId), caBundlePem: typeof body.caBundlePem === 'string' && body.caBundlePem.trim() ? body.caBundlePem : null,
        hostname: await deps.hostname(), executor, now: new Date() })
      return json({ certificate: candidate, application: { status: 'candidate_files_written', nativeApplied: false, servedTlsVerified: false } })
    }
    return respond(deps, 'server:ssl-store', { backend, authorize: deps.authorizeRoot }, raw === undefined ? { op: 'read' } : parseSslStoreRequest(raw))
  })
}
