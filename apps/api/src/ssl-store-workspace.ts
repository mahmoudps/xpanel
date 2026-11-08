import { join } from 'node:path'
import { fail, isXpanelError, parseTweakValues, TWEAK_SETTINGS_STATE } from '@xpanel/core'
import type { Account, ErrorCode } from '@xpanel/core'
import { services } from '@xpanel/render'
import { readJsonIfExists } from '@xpanel/state'
import type { NewCertificate, StateStore, StoredCertificate } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { isMailboxPrincipal } from './authorization.ts'
import { SSL_KEY_TYPES, SSL_STORE_ID, SSL_STORE_KINDS, SSL_STORE_LABEL, SSL_STORE_MAX_ITEMS, SSL_STORE_MAX_NAMES, SSL_STORE_SERVICES, parseSslStoreRequest } from '../../agent/src/ssl-store.ts'
import type { SslKeyType, SslStoreItem, SslStoreKind, SslStoreRequest, SslStoreView } from '../../agent/src/ssl-store.ts'

/**
 * /api/accounts/{account}/ssl: the account's ~/ssl store for its owner, its reseller (manage-ssl) and root.
 * /api/server/ssl: root's own store (WHM SSL Storage Manager), whose certificates can serve the mail services.
 */
const ACCOUNT_ROUTE = /^\/api\/accounts\/([a-z][a-z0-9]{0,15})\/ssl(?:\/(keys|csrs|certificates)(?:\/([a-z0-9][a-z0-9_-]{0,63}))?)?$/
const SERVER_ROUTE = /^\/api\/server\/ssl(?:\/(keys|csrs|certificates)(?:\/([a-z0-9][a-z0-9_-]{0,63})(\/install)?)?)?$/
const KIND_OF: Readonly<Record<string, SslStoreKind>> = { keys: 'key', csrs: 'csr', certificates: 'certificate' }
export const SSL_STORE_TOOL_IDS: Readonly<Record<string, string>> = { keys: 'ssl-private-keys', csrs: 'ssl-csrs', certificates: 'ssl-certificates' }
const REASONS = new Set(['key_format', 'key_encrypted', 'key_strength', 'certificate_format', 'leaf_ca', 'too_large', 'names', 'subject', 'key_missing', 'directory_unmanageable', 'capacity', 'days',
  'openssl_unavailable', 'label', 'passphrase', 'labels_unreadable', 'index_unreadable', 'self_signed', 'hostname_unset', 'chain_order', 'host_unavailable'])
const PASSED: ReadonlySet<string> = new Set<ErrorCode>(['VALIDATION', 'NOT_FOUND', 'FORBIDDEN', 'CONFLICT', 'LIMIT_EXCEEDED', 'PRECONDITION_FAILED'])
export const SSL_DEFAULT_KEY_TWEAK = 'ssl.defaultKeyType'
const DEFAULT_DAYS = 365
const unchanged = { stateChanged: false }
const uncertain = { stateChanged: true, unknownOutcome: true, verificationRequired: true }

export interface SslStorePorts {
  store: Pick<StateStore, 'getAccountByUsername' | 'rootDir' | 'createCertificate' | 'listCertificates' | 'getServerSettings'>
  requireCaller(req: Request): Promise<AuthenticatedCaller>
  /** Ownership, reseller ACL and plan features from the request policy (authorization.ts). */
  assertCanAccessAccount(caller: AuthenticatedCaller, account: Account, action: string): Promise<void>
  /** Null when no protected agent is connected: every route refuses before reading or writing. */
  callAgent: ((path: string, options: { method?: string; body?: unknown; caller: AuthenticatedCaller }) => Promise<Response>) | null
  /** Applies saved state; the service certificate counts only after an applied or unchanged generation. */
  reconcile(caller: AuthenticatedCaller): Promise<{ ok: boolean; body: Record<string, unknown> } | null>
  audit(caller: AuthenticatedCaller, action: string, target: string, detail: Record<string, unknown>): Promise<void>
}
type Target = { scope: 'account'; account: Account; caller: AuthenticatedCaller } | { scope: 'server'; caller: AuthenticatedCaller }
const agentPath = (target: Target): string => target.scope === 'account' ? '/accounts/' + target.account.username + '/ssl-store' : '/host/ssl-store'

/** The saved Tweak Settings value; null when the settings file cannot be read, so nothing is guessed. */
export async function readDefaultKeyType(store: Pick<StateStore, 'rootDir'>): Promise<SslKeyType | null> {
  let value: unknown
  try { value = parseTweakValues(await readJsonIfExists<unknown>(join(store.rootDir, TWEAK_SETTINGS_STATE)))[SSL_DEFAULT_KEY_TWEAK] } catch { return null }
  return (SSL_KEY_TYPES as readonly unknown[]).includes(value) ? value as SslKeyType : null
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const sha = (value: unknown): boolean => value === null || typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const time = (value: unknown): boolean => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value))
const names = (value: unknown): boolean => Array.isArray(value) && value.length <= SSL_STORE_MAX_NAMES && value.every(name => typeof name === 'string' && /^(?:\*\.)?[a-z0-9.-]{1,253}$/.test(name))
const text = (value: unknown, max = 256): boolean => value === null || typeof value === 'string' && value.length <= max

/** Pins every item field so a reply can never smuggle PEM text into a list. */
function validItem(kind: SslStoreKind, raw: unknown): raw is SslStoreItem {
  if (!object(raw) || typeof raw.id !== 'string' || !SSL_STORE_ID.test(raw.id) || !time(raw.modifiedAt) || raw.modifiedAt === null || typeof raw.valid !== 'boolean' || !sha(raw.publicKeySha256)
    || !(raw.label === null || typeof raw.label === 'string' && SSL_STORE_LABEL.test(raw.label))) return false
  const keys = Object.keys(raw).sort().join()
  if (kind === 'key') return keys === 'bits,curve,id,keyType,label,modifiedAt,publicKeySha256,valid' && [null, 'rsa', 'ec'].includes(raw.keyType as string | null)
    && (raw.bits === null || Number.isSafeInteger(raw.bits)) && [null, 'prime256v1', 'secp384r1'].includes(raw.curve as string | null)
  if (kind === 'csr') return keys === 'commonName,id,label,modifiedAt,names,publicKeySha256,valid' && text(raw.commonName) && names(raw.names)
  return keys === 'commonName,fingerprintSha256,id,issuer,label,modifiedAt,names,notAfter,notBefore,publicKeySha256,selfSigned,valid' && text(raw.commonName) && text(raw.issuer) && names(raw.names)
    && (raw.selfSigned === null || typeof raw.selfSigned === 'boolean') && time(raw.notBefore) && time(raw.notAfter) && sha(raw.fingerprintSha256)
}
export function validateSslStoreView(raw: unknown, target: { scope: 'account'; account: Account } | { scope: 'server' }, status: SslStoreView['application']['status']): SslStoreView {
  const bad = (): never => fail('CONFIG_TEST_FAILED', 'protected SSL storage reply is invalid')
  const context = object(raw) && object(raw.context) ? raw.context : null
  const bound = context !== null && (target.scope === 'account' ? context.scope === 'account' && context.accountId === target.account.id && context.username === target.account.username
    : context.scope === 'server' && context.accountId === null && context.username === null)
  if (!object(raw) || !bound || !['absent', 'ready', 'unmanageable'].includes(raw.directory as string)
    || !object(raw.limits) || raw.limits.maxItems !== SSL_STORE_MAX_ITEMS || typeof raw.limits.truncated !== 'boolean' || !object(raw.application) || raw.application.status !== status || !Array.isArray(raw.application.changed)) return bad()
  for (const [kind, list] of [['key', raw.keys], ['csr', raw.csrs], ['certificate', raw.certificates]] as const) if (!Array.isArray(list) || list.length > SSL_STORE_MAX_ITEMS || !list.every(item => validItem(kind, item))) return bad()
  if (!raw.application.changed.every(item => object(item) && (SSL_STORE_KINDS as readonly unknown[]).includes(item.kind) && typeof item.id === 'string' && SSL_STORE_ID.test(item.id))) return bad()
  return raw as unknown as SslStoreView
}

/** Agent reply with its stable refusal reason kept; an unknown outcome is never reported as refused. */
async function agent(ports: SslStorePorts, target: Target, body: Record<string, unknown> | undefined, mutation: boolean): Promise<unknown> {
  if (!ports.callAgent) return fail('PRECONDITION_FAILED', 'SSL storage needs the protected host agent', { ...unchanged, reason: 'host_unavailable' })
  const unknown = { stateChanged: mutation, verificationRequired: mutation, unknownOutcome: mutation }
  let response: Response
  try { response = await ports.callAgent(agentPath(target), { caller: target.caller, ...(body === undefined ? {} : { method: 'POST', body }) }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the protected SSL storage service could not be reached', unknown) }
  let value: unknown
  try { const raw = await response.text(); if (raw.length > 1024 * 1024) throw new Error('too_large'); value = JSON.parse(raw) } catch { return fail('SERVICE_UNAVAILABLE', 'the protected SSL storage reply could not be read', unknown) }
  if (response.ok) return value
  const problem = object(value) ? value : {}, details = object(problem.details) ? problem.details : {}
  if (details.stateChanged === false && details.unknownOutcome !== true && typeof problem.code === 'string' && PASSED.has(problem.code)) {
    return fail(problem.code as ErrorCode, typeof problem.detail === 'string' ? problem.detail.slice(0, 300) : 'the SSL storage request was refused',
      { ...unchanged, ...(typeof details.reason === 'string' && REASONS.has(details.reason) ? { reason: details.reason } : {}) })
  }
  const saved = Array.isArray(details.saved) ? details.saved.filter(item => object(item) && (SSL_STORE_KINDS as readonly unknown[]).includes(item.kind) && typeof item.id === 'string' && SSL_STORE_ID.test(item.id)).map(item => ({ kind: item.kind, id: item.id })) : []
  return fail('SERVICE_UNAVAILABLE', 'the SSL storage change requires inspection; no retry was sent', { ...unknown, ...(saved.length ? { saved } : {}) })
}

const allowed = (body: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(body).some(key => !keys.includes(key))) fail('VALIDATION', 'unsupported SSL storage field', unchanged)
}
const defined = (value: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
/** REST body to the agent's JSON operation; the shared parser checks it before anything is sent. */
async function operation(store: SslStorePorts['store'], segment: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const keyChoice = async (): Promise<Record<string, unknown>> => {
    if (body.keyId !== undefined) return { keyId: body.keyId }
    const keyType = body.keyType ?? await readDefaultKeyType(store)
    return keyType === null ? fail('PRECONDITION_FAILED', 'the default key type could not be read; choose a key type', { ...unchanged, reason: 'default_key_type_unreadable' }) : { keyType }
  }
  const label = body.label === undefined ? {} : { label: body.label }
  if (body.pem !== undefined && segment !== 'csrs') {
    allowed(body, ['pem', 'label'])
    return { op: 'import', kind: segment === 'keys' ? 'key' : 'certificate', pem: body.pem, ...label }
  }
  if (segment === 'keys') { allowed(body, ['keyType', 'label']); return { op: 'create', ...await keyChoice(), ...label } }
  if (segment === 'csrs') { allowed(body, ['keyId', 'keyType', 'names', 'subject', 'label', 'passphrase']); return defined({ op: 'create', ...await keyChoice(), names: body.names, subject: body.subject, csr: true, passphrase: body.passphrase, ...label }) }
  allowed(body, ['keyId', 'keyType', 'names', 'subject', 'days', 'csr', 'label', 'passphrase'])
  return defined({ op: 'create', ...await keyChoice(), names: body.names, subject: body.subject, days: body.days ?? DEFAULT_DAYS, csr: body.csr ?? false, passphrase: body.passphrase, ...label })
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text()
  if (raw.length > 64 * 1024) return fail('LIMIT_EXCEEDED', 'SSL storage request is too large', unchanged)
  let value: unknown
  try { value = raw ? JSON.parse(raw) : {} } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  return object(value) ? value : fail('VALIDATION', 'request body must be an object', unchanged)
}

/** Stored material for the install route; the private key stays on the trusted API and agent boundary. */
export async function readSslStoreMaterial(ports: SslStorePorts, caller: AuthenticatedCaller, account: Account, certificateId: string): Promise<{ certificatePem: string; privateKeyPem: string }> {
  const raw = { op: 'material', certificateId }
  parseSslStoreRequest(raw)
  const reply = await agent(ports, { scope: 'account', account, caller }, raw, false)
  if (!object(reply) || !validItem('certificate', reply.certificate) || (reply.certificate as SslStoreItem).id !== certificateId || typeof reply.keyId !== 'string' || !SSL_STORE_ID.test(reply.keyId)
    || typeof reply.certificatePem !== 'string' || !reply.certificatePem.startsWith('-----BEGIN CERTIFICATE-----\n') || typeof reply.privateKeyPem !== 'string' || !reply.privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----\n')) return fail('SERVICE_UNAVAILABLE', 'the stored certificate could not be verified', unchanged)
  return { certificatePem: reply.certificatePem, privateKeyPem: reply.privateKeyPem }
}

/**
 * A root-store certificate for a service: only the mail services take a certificate from saved state (the one covering the
 * server hostname, rendered into Postfix and Dovecot); the panel listener and FTP are refused with a stable reason.
 */
async function installServiceCertificate(ports: SslStorePorts, req: Request, caller: AuthenticatedCaller, id: string): Promise<Response> {
  const body = await readBody(req)
  allowed(body, ['service', 'caBundlePem'])
  if (!(SSL_STORE_SERVICES as readonly unknown[]).includes(body.service)) return fail('VALIDATION', 'service must be mail, panel or ftp', unchanged)
  if (body.service !== 'mail') return fail('PRECONDITION_FAILED', body.service === 'panel' ? 'the panel listener certificate is managed by its own TLS lifecycle, not by the store' : 'FTP does not take a TLS certificate in this product', { ...unchanged, reason: 'service_install_unavailable', service: body.service })
  if (body.caBundlePem !== undefined && typeof body.caBundlePem !== 'string') return fail('VALIDATION', 'the CA bundle must be PEM text', unchanged)
  const reply = await agent(ports, { scope: 'server', caller }, defined({ op: 'publish', certificateId: id, caBundlePem: body.caBundlePem }), true)
  const certificate = object(reply) && object(reply.certificate) ? reply.certificate : null
  const paths = certificate && typeof certificate.id === 'string' ? (() => { try { return services.certFiles(certificate.id as string) } catch { return null } })() : null
  if (!certificate || !paths || certificate.certPath !== paths.fullchain || certificate.keyPath !== paths.privkey || !names(certificate.names) || !(certificate.names as string[]).length
    || typeof certificate.notAfter !== 'string' || !Number.isFinite(Date.parse(certificate.notAfter)) || !time(certificate.notBefore) || !sha(certificate.fingerprintSha256)) return fail('SERVICE_UNAVAILABLE', 'the service certificate candidate requires inspection', uncertain)
  let saved: StoredCertificate, reconcile: { ok: boolean; body: Record<string, unknown> } | null
  try {
    const input: NewCertificate = { id: certificate.id as string, accountId: null, names: certificate.names as string[], source: 'upload', challenge: null, notBefore: certificate.notBefore as string | null,
      notAfter: certificate.notAfter, autoRenew: false, certPath: paths.fullchain, keyPath: paths.privkey, fingerprintSha256: certificate.fingerprintSha256 as string }
    saved = await ports.store.createCertificate(input)
    reconcile = await ports.reconcile(caller)
    if (!reconcile?.ok || !['applied', 'noop'].includes(String(reconcile.body.status))) throw new Error('service_certificate_apply')
    await ports.audit(caller, 'ssl_store.service_installed', 'certificate:' + saved.names.join(','), { certificateId: saved.id, storeCertificateId: id, service: 'mail', names: saved.names, notAfter: saved.notAfter })
  } catch { return fail('SERVICE_UNAVAILABLE', 'the mail service certificate was saved but its application requires inspection', uncertain) }
  // Postfix and Dovecot use the latest-expiring saved certificate that covers the hostname; say whether that is this one.
  const hostname = (await ports.store.getServerSettings())?.hostname
  const selected = services.mailHostnameTls(hostname, await ports.store.listCertificates())
  return json({ certificate: { id: saved.id, names: saved.names, notAfter: saved.notAfter }, service: 'mail', mailUses: selected?.certFile === paths.fullchain, reconcile: { status: reconcile.body.status },
    application: { scope: 'stored_configuration', servedTlsVerified: false } })
}

export async function handleSslStoreWorkspaceRoute(req: Request, url: URL, method: string, ports: SslStorePorts): Promise<Response | null> {
  const accountMatch = ACCOUNT_ROUTE.exec(url.pathname), serverMatch = accountMatch ? null : SERVER_ROUTE.exec(url.pathname)
  if (!accountMatch && !serverMatch) return null
  const [, username, segment, id] = accountMatch ?? [undefined, undefined, serverMatch![1], serverMatch![2]]
  const install = !!serverMatch?.[3]
  const methods = install ? ['POST'] : !segment ? ['GET'] : !id ? ['POST'] : ['GET', 'PATCH', 'DELETE']
  if (!methods.includes(method) || install && segment !== 'certificates') return new Response(null, { status: 405, headers: { allow: methods.join(', ') } })
  if (url.search) return fail('VALIDATION', 'SSL storage does not accept query selectors', unchanged)
  const authorize = async (): Promise<Target> => {
    const caller = await ports.requireCaller(req)
    if (isMailboxPrincipal(caller)) return fail('FORBIDDEN', 'SSL storage requires the account owner, its reseller or root', unchanged)
    if (serverMatch) return caller.principal.kind === 'root' ? { scope: 'server', caller } : fail('FORBIDDEN', 'the server SSL storage is for root', unchanged)
    const account = await ports.store.getAccountByUsername(username!)
    if (!account) return fail('NOT_FOUND', 'account not found', unchanged)
    if (account.status !== 'active') return fail('PRECONDITION_FAILED', 'an active account is required for SSL storage', unchanged)
    await ports.assertCanAccessAccount(caller, account, 'certificates')
    return { scope: 'account', account, caller }
  }
  const first = await authorize()
  if (install) return installServiceCertificate(ports, req, first.caller, id!)
  const withTypes = async (view: SslStoreView) => json({ ...view, keyTypes: SSL_KEY_TYPES, defaultKeyType: await readDefaultKeyType(ports.store) })
  if (!segment) {
    let view: SslStoreView
    try { view = validateSslStoreView(await agent(ports, first, undefined, false), first, 'read') }
    catch (error) { if (isXpanelError(error) && error.code !== 'CONFIG_TEST_FAILED') throw error; return fail('SERVICE_UNAVAILABLE', 'the protected SSL storage read could not be verified', unchanged) }
    return withTypes(view)
  }
  const kind = KIND_OF[segment]!
  if (id && method === 'GET') {
    const raw = { op: 'view', kind, id }
    parseSslStoreRequest(raw)
    const reply = await agent(ports, first, raw, false)
    if (!object(reply) || !validItem(kind, reply.item) || (reply.item as SslStoreItem).id !== id || typeof reply.pem !== 'string' || reply.pem.length > 32 * 1024 || !/^-----BEGIN (?:PRIVATE KEY|CERTIFICATE REQUEST|CERTIFICATE)-----\n/.test(reply.pem)) return fail('SERVICE_UNAVAILABLE', 'the stored item could not be verified', unchanged)
    return json({ kind, item: reply.item, pem: reply.pem })
  }
  const body = await readBody(req)
  let raw: Record<string, unknown>, request: SslStoreRequest
  try {
    raw = id && method === 'PATCH' ? (allowed(body, ['label']), { op: 'label', kind, id, label: Object.hasOwn(body, 'label') ? body.label : undefined })
      : id ? (allowed(body, ['modifiedAt']), { op: 'delete', kind, id, modifiedAt: body.modifiedAt }) : await operation(ports.store, segment, body)
    request = parseSslStoreRequest(defined(raw))
  } catch (error) { if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, ...unchanged }); throw error }
  // Fresh authority immediately before the change; the agent checks it again inside the account lease or as root.
  const fresh = await authorize()
  if (fresh.caller.principal.id !== first.caller.principal.id || fresh.scope !== first.scope || (fresh.scope === 'account' && first.scope === 'account' && fresh.account.id !== first.account.id)) return fail('CONFLICT', 'the account binding changed before saving', unchanged)
  const status = request.op === 'delete' ? 'removed' : request.op === 'import' ? 'imported' : request.op === 'label' ? 'labelled' : 'created'
  let view: SslStoreView
  try { view = validateSslStoreView(await agent(ports, fresh, defined(raw), true), fresh, status) }
  catch (error) { if (isXpanelError(error) && error.code !== 'CONFIG_TEST_FAILED') throw error; return fail('SERVICE_UNAVAILABLE', 'the SSL storage outcome requires inspection', uncertain) }
  const lists: Record<SslStoreKind, SslStoreItem[]> = { key: view.keys, csr: view.csrs, certificate: view.certificates }
  const expected = request.op === 'create' ? 1 + (request.csr ? 1 : 0) + (request.days !== null ? 1 : 0) - ('id' in request.key ? 1 : 0) : 1
  const present = view.application.changed.map(item => lists[item.kind].find(row => row.id === item.id))
  const label = request.op === 'label' ? request.label : null
  if (view.application.changed.length !== expected || present.some(row => (row !== undefined) !== (request.op !== 'delete')) || (request.op === 'label' && present[0]?.label !== label)) return fail('SERVICE_UNAVAILABLE', 'the SSL storage outcome requires inspection', uncertain)
  return withTypes(view)
}
