import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TWEAK_SETTINGS_STATE, TWEAKS } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { SSL_KEY_TYPES } from '../../agent/src/ssl-store.ts'
import { handleSslStoreWorkspaceRoute, readSslStoreMaterial } from './ssl-store-workspace.ts'
import type { SslStorePorts } from './ssl-store-workspace.ts'

const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', status: 'active' } as Account
const owner = { principal: { kind: 'user', id: 'p1', username: 'alice', accountId: account.id }, sessionId: 's1', apiTokenId: null, scopes: [] } as unknown as AuthenticatedCaller
const key = { id: 'shop_0a1b2c3d', label: null as string | null, modifiedAt: '2026-11-06T10:00:00.000Z', valid: true, publicKeySha256: 'a'.repeat(64), keyType: 'ec', bits: 256, curve: 'prime256v1' }
const ACCOUNT_CONTEXT = { scope: 'account', accountId: account.id, username: 'alice' }, SERVER_CONTEXT = { scope: 'server', accountId: null, username: null }
const view = (status = 'read', changed: unknown[] = [], keys: unknown[] = [key], context: unknown = ACCOUNT_CONTEXT, certificates: unknown[] = []) => ({ context, directory: 'ready', keys, csrs: [], certificates,
  limits: { maxItems: 50, truncated: false }, application: { status, changed } })
const rootCaller = { principal: { kind: 'root', id: 'r1', username: 'root' }, sessionId: 's2', apiTokenId: null, scopes: ['*'] } as unknown as AuthenticatedCaller
const storedCertificate = { id: 'host_0a1b2c3d', label: null, modifiedAt: key.modifiedAt, valid: true, publicKeySha256: 'a'.repeat(64), commonName: 'host.example.test', names: ['host.example.test'], issuer: 'CA',
  selfSigned: false, notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2027-01-01T00:00:00.000Z', fingerprintSha256: 'b'.repeat(64) }
const problem = (status: number, code: string, details: Record<string, unknown>) => new Response(JSON.stringify({ code, detail: 'refused', details }), { status })

let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = '' })
async function ports(reply: (body: unknown) => Response, caller = owner, agentPath = '/accounts/alice/ssl-store') {
  root = await mkdtemp(join(tmpdir(), 'ssl-ws-'))
  const sent: unknown[] = [], certificates: Record<string, unknown>[] = []
  const callAgent = vi.fn(async (path: string, options: { body?: unknown }) => { expect(path).toBe(agentPath); sent.push(options.body); return reply(options.body) })
  const reconcile = vi.fn(async () => ({ ok: true, body: { status: 'applied' } as Record<string, unknown> })), audit = vi.fn(async () => undefined)
  const store = { rootDir: root, getAccountByUsername: async (name: string) => name === 'alice' ? account : null, getServerSettings: async () => ({ hostname: 'host.example.test' }),
    createCertificate: vi.fn(async (input: Record<string, unknown>) => { const saved = { challenge: null, chainPath: null, lastError: null, renewedAt: null, ...input }; certificates.push(saved); return saved }),
    listCertificates: async () => certificates } as unknown as SslStorePorts['store']
  const result = { sent, certificates, callAgent, reconcile, audit, store, requireCaller: async () => caller, assertCanAccessAccount: vi.fn(async () => undefined) }
  return result as typeof result & SslStorePorts
}
const call = (p: SslStorePorts, method: string, path: string, body?: unknown) => {
  const url = new URL(path, 'http://panel.test')
  return handleSslStoreWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, method, p)
}
const failure = async (run: () => Promise<unknown>): Promise<Record<string, unknown>> => { try { await run() } catch (error) { const e = error as { code: string; detail: Record<string, unknown> }; return { code: e.code, ...e.detail } } return { code: 'accepted' } }

describe('/api/server/ssl (root store)', () => {
  it('serves root only and binds the reply to the server store', async () => {
    const p = await ports(() => new Response(JSON.stringify(view('read', [], [key], SERVER_CONTEXT))), rootCaller, '/host/ssl-store')
    expect(await (await call(p, 'GET', '/api/server/ssl'))!.json()).toMatchObject({ context: SERVER_CONTEXT, keys: [key] })
    expect(await failure(async () => call(await ports(() => new Response('{}')), 'GET', '/api/server/ssl'))).toMatchObject({ code: 'FORBIDDEN' })
    const mixed = await ports(() => new Response(JSON.stringify(view())), rootCaller, '/host/ssl-store')
    expect(await failure(() => call(mixed, 'GET', '/api/server/ssl'))).toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
  it('passes the challenge passphrase to the agent only in the request body', async () => {
    const p = await ports(() => new Response(JSON.stringify(view('created', [{ kind: 'key', id: key.id }, { kind: 'csr', id: key.id }], [key], SERVER_CONTEXT).valueOf())), rootCaller, '/host/ssl-store')
    await failure(() => call(p, 'POST', '/api/server/ssl/csrs', { keyType: 'ecdsa-prime256v1', names: ['host.example.test'], passphrase: 'open sesame' }))
    expect(p.sent).toEqual([{ op: 'create', keyType: 'ecdsa-prime256v1', names: ['host.example.test'], csr: true, passphrase: 'open sesame' }])
    expect(await failure(() => call(p, 'POST', '/api/server/ssl/csrs', { keyType: 'ecdsa-prime256v1', names: ['host.example.test'], passphrase: ' x ' }))).toMatchObject({ code: 'VALIDATION', reason: 'passphrase' })
  })
  it('installs a stored certificate for the mail services only, saved for the hostname and reconciled', async () => {
    const candidate = { id: '22222222-2222-4222-8222-222222222222', names: ['host.example.test'], notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2027-01-01T00:00:00.000Z',
      certPath: '/etc/xpanel/certs/22222222-2222-4222-8222-222222222222/fullchain.pem', keyPath: '/etc/xpanel/certs/22222222-2222-4222-8222-222222222222/privkey.pem', fingerprintSha256: 'c'.repeat(64) }
    const { services } = await import('@xpanel/render')
    Object.assign(candidate, { certPath: services.certFiles(candidate.id).fullchain, keyPath: services.certFiles(candidate.id).privkey })
    const p = await ports(() => new Response(JSON.stringify({ certificate: candidate, application: { status: 'candidate_files_written' } })), rootCaller, '/host/ssl-store')
    const response = await call(p, 'POST', '/api/server/ssl/certificates/' + storedCertificate.id + '/install', { service: 'mail' })
    expect(await response!.json()).toMatchObject({ certificate: { id: candidate.id }, service: 'mail', mailUses: true, application: { servedTlsVerified: false } })
    expect(p.sent).toEqual([{ op: 'publish', certificateId: storedCertificate.id }])
    expect(p.certificates).toEqual([expect.objectContaining({ id: candidate.id, accountId: null, source: 'upload', names: ['host.example.test'] })])
    expect(p.reconcile).toHaveBeenCalledOnce()
    expect(p.audit).toHaveBeenCalledWith(rootCaller, 'ssl_store.service_installed', 'certificate:host.example.test', expect.objectContaining({ service: 'mail', storeCertificateId: storedCertificate.id }))
    for (const service of ['panel', 'ftp']) expect(await failure(() => call(p, 'POST', '/api/server/ssl/certificates/' + storedCertificate.id + '/install', { service }))).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'service_install_unavailable', stateChanged: false })
    expect(p.sent).toHaveLength(1)
    p.reconcile.mockResolvedValueOnce({ ok: false, body: { status: 'failed' } })
    expect(await failure(() => call(p, 'POST', '/api/server/ssl/certificates/' + storedCertificate.id + '/install', { service: 'mail' }))).toMatchObject({ code: 'SERVICE_UNAVAILABLE', verificationRequired: true })
  })
})

describe('/api/accounts/{account}/ssl', () => {
  it('lists the store with the key types and the Tweak Settings default', async () => {
    const p = await ports(() => new Response(JSON.stringify(view())))
    expect(await (await call(p, 'GET', '/api/accounts/alice/ssl'))!.json()).toMatchObject({ keys: [key], keyTypes: [...SSL_KEY_TYPES], defaultKeyType: 'rsa-2048' })
    expect(p.assertCanAccessAccount).toHaveBeenCalledWith(owner, account, 'certificates')
    expect(TWEAKS.find(tweak => tweak.key === 'ssl.defaultKeyType')).toMatchObject({ kind: 'choice', default: 'rsa-2048', choices: [...SSL_KEY_TYPES] })
  })
  it('uses the saved default key type when a new key names none', async () => {
    const p = await ports(body => new Response(JSON.stringify(view('created', [{ kind: 'key', id: key.id }]))))
    await mkdir(join(root, 'extended/server'), { recursive: true })
    await writeFile(join(root, TWEAK_SETTINGS_STATE), JSON.stringify({ 'ssl.defaultKeyType': 'ecdsa-secp384r1' }))
    expect((await call(p, 'POST', '/api/accounts/alice/ssl/keys', { label: 'shop' }))!.status).toBe(200)
    expect(p.sent).toEqual([{ op: 'create', keyType: 'ecdsa-secp384r1', label: 'shop' }])
    // One changed item for a CSR plus a certificate is an incomplete outcome, never a success.
    expect(await failure(() => call(p, 'POST', '/api/accounts/alice/ssl/certificates', { keyId: key.id, names: ['example.test'], csr: true }))).toMatchObject({ code: 'SERVICE_UNAVAILABLE', verificationRequired: true })
    expect(p.sent[1]).toEqual({ op: 'create', keyId: key.id, names: ['example.test'], csr: true, days: 365 })
  })
  it('refuses invalid material at the API before anything is sent', async () => {
    const p = await ports(() => new Response('{}'))
    expect(await failure(() => call(p, 'POST', '/api/accounts/alice/ssl/keys', { pem: 'not a key' }))).toMatchObject({ code: 'VALIDATION', reason: 'key_format', stateChanged: false })
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
    expect(await failure(() => call(p, 'POST', '/api/accounts/alice/ssl/keys', { pem: weak }))).toMatchObject({ reason: 'key_strength' })
    expect(await failure(() => call(p, 'POST', '/api/accounts/alice/ssl/csrs', { keyType: 'rsa-2048', names: ['bad name'] }))).toMatchObject({ reason: 'names' })
    expect(await failure(() => call(p, 'POST', '/api/accounts/alice/ssl/csrs', { pem: 'x' }))).toMatchObject({ code: 'VALIDATION' })
    expect(p.callAgent).not.toHaveBeenCalled()
  })
  it('keeps the agent refusal reason and never turns an unknown outcome into a refusal', async () => {
    let next = problem(412, 'PRECONDITION_FAILED', { stateChanged: false, reason: 'capacity' })
    const p = await ports(() => next)
    expect(await failure(() => call(p, 'POST', '/api/accounts/alice/ssl/keys', { keyType: 'rsa-2048' }))).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'capacity', stateChanged: false })
    next = problem(503, 'SERVICE_UNAVAILABLE', { stateChanged: true, unknownOutcome: true, saved: [{ kind: 'key', id: key.id }, { kind: 'key', id: '../x' }] })
    expect(await failure(() => call(p, 'POST', '/api/accounts/alice/ssl/csrs', { keyType: 'rsa-2048', names: ['example.test'] }))).toMatchObject({ code: 'SERVICE_UNAVAILABLE', unknownOutcome: true, saved: [{ kind: 'key', id: key.id }] })
  })
  it('refuses a list reply that carries anything beyond metadata', async () => {
    const p = await ports(() => new Response(JSON.stringify(view('read', [], [{ ...key, pem: '-----BEGIN PRIVATE KEY-----' }]))))
    expect(await failure(() => call(p, 'GET', '/api/accounts/alice/ssl'))).toMatchObject({ code: 'SERVICE_UNAVAILABLE', stateChanged: false })
  })
  it('views one item and deletes it with the read revision', async () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n'
    const p = await ports(body => (body as { op: string }).op === 'view' ? new Response(JSON.stringify({ item: key, pem })) : new Response(JSON.stringify(view('removed', [{ kind: 'key', id: key.id }], []))))
    expect(await (await call(p, 'GET', '/api/accounts/alice/ssl/keys/' + key.id))!.json()).toEqual({ kind: 'key', item: key, pem })
    expect((await call(p, 'DELETE', '/api/accounts/alice/ssl/keys/' + key.id, { modifiedAt: key.modifiedAt }))!.status).toBe(200)
    expect(p.sent).toEqual([{ op: 'view', kind: 'key', id: key.id }, { op: 'delete', kind: 'key', id: key.id, modifiedAt: key.modifiedAt }])
    const renamed = await ports(() => new Response(JSON.stringify(view('labelled', [{ kind: 'key', id: key.id }], [{ ...key, label: 'Shop' }]))))
    expect((await call(renamed, 'PATCH', '/api/accounts/alice/ssl/keys/' + key.id, { label: 'Shop' }))!.status).toBe(200)
    expect(renamed.sent).toEqual([{ op: 'label', kind: 'key', id: key.id, label: 'Shop' }])
    expect(await failure(() => call(renamed, 'PATCH', '/api/accounts/alice/ssl/keys/' + key.id, { label: 'Other' }))).toMatchObject({ code: 'SERVICE_UNAVAILABLE', verificationRequired: true })
    expect(await failure(() => call(renamed, 'PATCH', '/api/accounts/alice/ssl/keys/' + key.id, { label: '<b>' }))).toMatchObject({ code: 'VALIDATION', reason: 'label' })
    const stale = await ports(() => new Response(JSON.stringify(view('removed', [{ kind: 'key', id: key.id }]))))
    expect(await failure(() => call(stale, 'DELETE', '/api/accounts/alice/ssl/keys/' + key.id, { modifiedAt: key.modifiedAt }))).toMatchObject({ code: 'SERVICE_UNAVAILABLE', verificationRequired: true })
  })
  it('admits no mailbox session and nothing without a connected agent', async () => {
    const mailbox = { ...owner, principal: { ...owner.principal, kind: 'mailbox' } } as unknown as AuthenticatedCaller
    expect(await failure(async () => call(await ports(() => new Response('{}'), mailbox), 'GET', '/api/accounts/alice/ssl'))).toMatchObject({ code: 'FORBIDDEN' })
    const offline = { ...await ports(() => new Response('{}')), callAgent: null }
    expect(await failure(() => call(offline, 'GET', '/api/accounts/alice/ssl'))).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'host_unavailable' })
    expect((await call(offline, 'PUT', '/api/accounts/alice/ssl'))!.status).toBe(405)
  })
  it('reads install material only in its pinned shape', async () => {
    const certificate = { id: 'example_test_0a1b2c3d', label: null, modifiedAt: key.modifiedAt, valid: true, publicKeySha256: 'a'.repeat(64), commonName: 'example.test', names: ['example.test'], issuer: 'CA', selfSigned: false,
      notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2027-01-01T00:00:00.000Z', fingerprintSha256: 'b'.repeat(64) }
    const material = { certificate, keyId: key.id, certificatePem: '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n' }
    const p = await ports(() => new Response(JSON.stringify(material)))
    expect(await readSslStoreMaterial(p, owner, account, certificate.id)).toEqual({ certificatePem: material.certificatePem, privateKeyPem: material.privateKeyPem })
    expect(p.sent).toEqual([{ op: 'material', certificateId: certificate.id }])
    const wrong = await ports(() => new Response(JSON.stringify({ ...material, certificate: { ...certificate, id: 'other_1' } })))
    expect(await failure(() => readSslStoreMaterial(wrong, owner, account, certificate.id))).toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
})
