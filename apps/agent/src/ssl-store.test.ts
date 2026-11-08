import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, Plan } from '@xpanel/core'
import { FakeHostExecutor } from './executor.ts'
import type { FileEntry, FileText } from './file-manager.ts'
import {
  ROOT_SSL_STORE_DIRECTORY, accountSslStore, buildSslStoreCommand, handleRootSslStoreRoute, handleSslStoreRoute, isRootSslStoreCommand, isSslStoreCommand, opensslRequestArgv,
  parseSslRequest, parseSslStoreRequest, parseStoreCertificate, parseStoreCsr, parseStoreKey, publishServiceCertificate, requestConfig, rootSslStore, rootSslStoreCommand, runSslStoreRequest,
} from './ssl-store.ts'
import type { SslRequest, SslStoreBackend, SslStoreFiles, SslStoreRun, SslStoreView } from './ssl-store.ts'

// Portable PKCS #10 and X.509 fixtures from a minimal DER encoder; real openssl output is covered by ssl-store.linux.test.ts.
const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts), length: number[] = []
  if (body.length > 127) for (let value = body.length; value; value >>>= 8) length.unshift(value & 255)
  return Buffer.concat([Buffer.from([tag]), Buffer.from(length.length ? [128 | length.length, ...length] : [body.length]), body])
}
const seq = (...parts: Buffer[]) => der(0x30, ...parts)
const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'))
const dn = (cn: string) => seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from(cn)))))
const san = (names: string[]) => seq(oid('551d11'), der(0x04, seq(...names.map(name => der(0x82, Buffer.from(name))))))
const pemOf = (label: string, bytes: Buffer) => '-----BEGIN ' + label + '-----\n' + bytes.toString('base64').match(/.{1,64}/g)!.join('\n') + '\n-----END ' + label + '-----\n'
const algorithm = (key: KeyObject) => key.asymmetricKeyType === 'rsa' ? seq(oid('2a864886f70d01010b'), der(0x05)) : seq(oid('2a8648ce3d040302'))
const csrFor = (key: KeyObject, names: string[], tamper = false): string => {
  const info = seq(der(0x02, Buffer.from([0])), dn(names[0]!), createPublicKey(key).export({ type: 'spki', format: 'der' }),
    der(0xa0, seq(oid('2a864886f70d01090e'), der(0x31, seq(san(names))))))
  const signature = sign('sha256', tamper ? Buffer.concat([info, Buffer.from([0])]) : info, key)
  return pemOf('CERTIFICATE REQUEST', seq(info, algorithm(key), der(0x03, Buffer.concat([Buffer.from([0]), signature]))))
}
/** Self-signed unless an issuer key and name are given; `ca` adds critical CA:TRUE. */
const certFor = (key: KeyObject, names: string[], ca = false, issuer?: { key: KeyObject; name: string }, to = '2027-12-31'): string => {
  const utc = (day: string) => der(0x17, Buffer.from(day.slice(2).replaceAll('-', '') + '000000Z'))
  const signer = issuer?.key ?? key
  const extensions = [...ca ? [seq(oid('551d13'), der(0x01, Buffer.from([255])), der(0x04, seq(der(0x01, Buffer.from([255])))))] : [], san(names)]
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([7])), algorithm(signer), dn(issuer?.name ?? names[0]!), seq(utc('2026-01-01'), utc(to)), dn(names[0]!),
    createPublicKey(key).export({ type: 'spki', format: 'der' }), der(0xa3, seq(...extensions)))
  return pemOf('CERTIFICATE', seq(tbs, algorithm(signer), der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, signer)]))))
}
const ec = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
const pkcs8 = (key: KeyObject) => key.export({ type: 'pkcs8', format: 'pem' }) as string
const refusal = (fn: () => unknown): string => { try { fn() } catch (error) { return (error as { detail?: { reason?: string } }).detail?.reason ?? (error as { code?: string }).code ?? 'thrown' } return 'accepted' }
const asyncRefusal = async (fn: () => Promise<unknown>): Promise<Record<string, unknown>> => { try { await fn() } catch (error) { const e = error as { code: string; detail: Record<string, unknown> }; return { code: e.code, ...e.detail } } return { code: 'accepted' } }

const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', status: 'active', planId: 'plan', uid: 1001, gid: 1001, home: '/home/alice' } as Account

/** In-memory confined runner: one map of relative path to file or folder. */
function memoryFiles() {
  const nodes = new Map<string, { kind: 'file' | 'directory'; content: string; mode: number; mtime: string }>()
  let tick = 0
  const stamp = () => new Date(1_700_000_000_000 + ++tick * 1000).toISOString()
  const entry = (path: string): FileEntry => { const node = nodes.get(path)!; return { name: path.split('/').at(-1)!, path, kind: node.kind, sizeBytes: Buffer.byteLength(node.content), mode: node.mode, mtime: node.mtime } }
  const files = {
    list: vi.fn(async (path: string, opts: { showHidden?: boolean } = {}) => [...nodes.keys()].filter(key => key.split('/').slice(0, -1).join('/') === path && (opts.showHidden !== false || !key.split('/').at(-1)!.startsWith('.'))).map(entry)),
    readText: vi.fn(async (path: string): Promise<FileText> => { const node = nodes.get(path); if (!node || node.kind !== 'file') return fail('NOT_FOUND', 'missing'); return { path, content: node.content, sizeBytes: Buffer.byteLength(node.content), mtime: node.mtime } }),
    writeText: vi.fn(async (path: string, content: string, opts: { overwrite?: boolean; mode?: number } = {}) => {
      if (opts.overwrite === false && nodes.has(path)) return fail('CONFLICT', 'exists', { stateChanged: false })
      if (!nodes.has(path.split('/').slice(0, -1).join('/'))) return fail('NOT_FOUND', 'parent missing')
      nodes.set(path, { kind: 'file', content, mode: opts.mode ?? 0o640, mtime: stamp() }); return entry(path)
    }),
    writeTextChecked: vi.fn(async (path: string, content: string | null, expected: FileText | null, mode = 0o640) => {
      const node = nodes.get(path)
      if (expected === null ? node !== undefined : !node || node.content !== expected.content || node.mtime !== expected.mtime) return fail('CONFLICT', 'changed', { stateChanged: false })
      if (content === null) { nodes.delete(path); return null }
      nodes.set(path, { kind: 'file', content, mode, mtime: stamp() }); return entry(path)
    }),
    mkdir: vi.fn(async (path: string, mode: number) => { if (nodes.has(path)) return fail('CONFLICT', 'exists'); nodes.set(path, { kind: 'directory', content: '', mode, mtime: stamp() }); return entry(path) }),
  }
  return { files: files as unknown as SslStoreFiles, mocks: files, nodes }
}
/** Fake openssl: signs a PKCS #10 or self-signed X.509 with the stored key, like `openssl req` would. */
const fakeRun = (memory: ReturnType<typeof memoryFiles>, signer?: KeyObject, seen?: (configPath: string | null) => void): SslStoreRun => async (_account, keyId, request, days, configPath) => {
  seen?.(configPath)
  const key = signer ?? parseStoreKey(memory.nodes.get('ssl/keys/' + keyId + '.key')!.content).key
  return days === null ? csrFor(key, request.names) : certFor(key, request.names)
}
const store = (memory: ReturnType<typeof memoryFiles>, run: SslStoreRun | null = fakeRun(memory)) => accountSslStore(account, memory.files, run)
const input = (backend: SslStoreBackend, authorize = vi.fn(async () => undefined)) => ({ backend, authorize })
const request: SslRequest = { names: ['example.test', 'www.example.test'], subject: { organization: 'Example Ltd', country: 'SA' } }

describe('stored PEM parsing', () => {
  it('normalizes RSA and EC keys to PKCS #8 and reports type, size and public key hash', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    const parsed = parseStoreKey(rsa.export({ type: 'pkcs1', format: 'pem' }))
    expect(parsed.pem.startsWith('-----BEGIN PRIVATE KEY-----\n')).toBe(true)
    expect(parsed.item).toMatchObject({ valid: true, keyType: 'rsa', bits: 2048, curve: null })
    expect(parsed.item.publicKeySha256).toMatch(/^[0-9a-f]{64}$/)
    expect(parseStoreKey(ec().export({ type: 'sec1', format: 'pem' })).item).toMatchObject({ keyType: 'ec', bits: 256, curve: 'prime256v1' })
  })
  it('refuses encrypted, weak, unsupported and multi-block keys with stable reasons', () => {
    const rsa1024 = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey
    expect(refusal(() => parseStoreKey(rsa1024.export({ type: 'pkcs8', format: 'pem' })))).toBe('key_strength')
    expect(refusal(() => parseStoreKey(pkcs8(generateKeyPairSync('ed25519').privateKey)))).toBe('key_strength')
    expect(refusal(() => parseStoreKey(ec().export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'secret' })))).toBe('key_encrypted')
    expect(refusal(() => parseStoreKey(pkcs8(ec()) + pkcs8(ec())))).toBe('key_format')
    expect(refusal(() => parseStoreKey('x'.repeat(17 * 1024)))).toBe('too_large')
  })
  it('reads site certificates, flags self-signed ones and refuses certificate authorities', () => {
    const key = ec(), parsed = parseStoreCertificate(certFor(key, ['example.test', '*.example.test']))
    expect(parsed.item).toMatchObject({ names: ['example.test', '*.example.test'], commonName: 'example.test', selfSigned: true, notAfter: '2027-12-31T00:00:00.000Z' })
    expect(parsed.item.publicKeySha256).toBe(parseStoreKey(pkcs8(key)).item.publicKeySha256)
    expect(refusal(() => parseStoreCertificate(certFor(key, ['ca.test'], true)))).toBe('leaf_ca')
  })
  it('reads PKCS #10 names and verifies the request signature', () => {
    const key = ec(), parsed = parseStoreCsr(csrFor(key, ['example.test', 'www.example.test']))
    expect(parsed.item).toMatchObject({ commonName: 'example.test', names: ['example.test', 'www.example.test'], publicKeySha256: parseStoreKey(pkcs8(key)).item.publicKeySha256 })
    expect(refusal(() => parseStoreCsr(csrFor(key, ['example.test'], true)))).toBe('certificate_format')
  })
})

describe('certificate requests and the openssl grammar', () => {
  it('validates names and subject fields', () => {
    expect(parseSslRequest([' Example.TEST ', '*.example.test', 'example.test'], { organization: 'شركة المثال', country: 'SA', email: 'admin@example.test' }))
      .toEqual({ names: ['example.test', '*.example.test'], subject: { organization: 'شركة المثال', country: 'SA', email: 'admin@example.test' } })
    expect(refusal(() => parseSslRequest([], {}))).toBe('names')
    expect(refusal(() => parseSslRequest(['bad name'], {}))).toBe('names')
    expect(refusal(() => parseSslRequest(['example.test'], { organization: 'A/B' }))).toBe('subject')
    expect(refusal(() => parseSslRequest(['example.test'], { country: 'sa' }))).toBe('subject')
    expect(refusal(() => parseSslRequest(['example.test'], { unit: 'x' }))).toBe('subject')
  })
  it('admits exactly the jailed openssl req it builds and nothing near it', () => {
    const argv = buildSslStoreCommand(account, 'example_test_0a1b2c3d', request, null)
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(opensslRequestArgv('ssl/keys/example_test_0a1b2c3d.key', request, null))
    expect(argv).toContain('User=1001')
    expect(argv).toContain('BindPaths=/home/alice')
    expect(isSslStoreCommand(argv)).toBe(true)
    expect(isSslStoreCommand(buildSslStoreCommand(account, 'k1', request, 365))).toBe(true)
    expect(isSslStoreCommand(buildSslStoreCommand(account, 'k1', request, null, 'ssl/.req-0123456789abcdef.cnf'))).toBe(true)
    const tail = argv.indexOf('--') + 1
    const variant = (index: number, value: string) => argv.map((item, at) => at === index ? value : item)
    expect(isSslStoreCommand([...argv, '-out', 'x'])).toBe(false)
    expect(isSslStoreCommand(variant(tail + 4, '../../etc/shadow'))).toBe(false)
    expect(isSslStoreCommand(variant(tail, '/bin/sh'))).toBe(false)
    expect(isSslStoreCommand(variant(tail + 8, '/CN=other.test'))).toBe(false)
    expect(isSslStoreCommand(variant(tail + 13, 'subjectAltName=DNS:example.test,IP:127.0.0.1'))).toBe(false)
    expect(isSslStoreCommand(argv.map(item => item === 'User=1001' ? 'User=0' : item))).toBe(false)
    // A request file is only for a signing request, at its reviewed private path.
    expect(isSslStoreCommand(buildSslStoreCommand(account, 'k1', request, 365, 'ssl/.req-0123456789abcdef.cnf'))).toBe(false)
    expect(isSslStoreCommand(buildSslStoreCommand(account, 'k1', request, null, '/etc/ssl/openssl.cnf'))).toBe(false)
  })
  it('admits the root store grammar on its own absolute paths only', () => {
    expect(rootSslStoreCommand('k1', request, null)[4]).toBe(ROOT_SSL_STORE_DIRECTORY + '/k1.key')
    expect(isRootSslStoreCommand(rootSslStoreCommand('k1', request, 30))).toBe(true)
    expect(isRootSslStoreCommand(rootSslStoreCommand('k1', request, null, ROOT_SSL_STORE_DIRECTORY + '/.req-0123456789abcdef.cnf'))).toBe(true)
    expect(isRootSslStoreCommand(opensslRequestArgv('/home/alice/ssl/keys/k1.key', request, null))).toBe(false)
    expect(isRootSslStoreCommand(rootSslStoreCommand('k1', request, null, '/tmp/x.cnf'))).toBe(false)
    expect(isSslStoreCommand(rootSslStoreCommand('k1', request, null))).toBe(false)
  })
  it('writes the challenge passphrase and subject into a request file with OpenSSL escapes, never into argv', () => {
    const config = requestConfig({ names: ['example.test'], subject: { organization: "Acme's #1 $Co" } }, 's3cr"et#\\x')
    expect(config).toBe('[req]\ndistinguished_name = req_dn\nattributes = req_attributes\nprompt = no\n[req_dn]\nO = Acme\\\'s \\#1 \\$Co\nCN = example.test\n[req_attributes]\nchallengePassword = s3cr\\"et\\#\\\\x\n')
    expect(rootSslStoreCommand('k1', request, null, ROOT_SSL_STORE_DIRECTORY + '/.req-0123456789abcdef.cnf').join(' ')).not.toContain('s3cr')
  })
  it('parses each operation strictly', () => {
    expect(parseSslStoreRequest({ op: 'create', keyType: 'ecdsa-prime256v1' })).toEqual({ op: 'create', key: { type: 'ecdsa-prime256v1' }, label: null, request: null, csr: false, days: null, passphrase: null })
    expect(refusal(() => parseSslStoreRequest({ op: 'create', keyType: 'rsa-1024' }))).toBe('key_strength')
    expect(refusal(() => parseSslStoreRequest({ op: 'create', keyId: 'k1' }))).toBe('VALIDATION')
    expect(refusal(() => parseSslStoreRequest({ op: 'create', keyType: 'rsa-2048', names: ['example.test'] }))).toBe('VALIDATION')
    expect(refusal(() => parseSslStoreRequest({ op: 'create', keyType: 'rsa-2048', names: ['example.test'], days: 9999 }))).toBe('days')
    expect(refusal(() => parseSslStoreRequest({ op: 'create', keyType: 'rsa-2048', names: ['example.test'], days: 30, passphrase: 'secret' }))).toBe('passphrase')
    expect(refusal(() => parseSslStoreRequest({ op: 'create', keyType: 'rsa-2048', names: ['example.test'], csr: true, passphrase: ' pad ' }))).toBe('passphrase')
    expect(refusal(() => parseSslStoreRequest({ op: 'view', kind: 'key', id: '../x' }))).toBe('VALIDATION')
    expect(refusal(() => parseSslStoreRequest({ op: 'delete', kind: 'key', id: 'k1', modifiedAt: 'x' }))).toBe('VALIDATION')
    expect(parseSslStoreRequest({ op: 'label', kind: 'key', id: 'k1', label: 'متجر 2026' })).toEqual({ op: 'label', kind: 'key', id: 'k1', label: 'متجر 2026' })
    expect(refusal(() => parseSslStoreRequest({ op: 'label', kind: 'key', id: 'k1', label: '<b>' }))).toBe('label')
    expect(refusal(() => parseSslStoreRequest({ op: 'label', kind: 'key', id: 'k1' }))).toBe('label')
  })
})

describe('the ~/ssl store through the confined runner', () => {
  it('generates a key into ~/ssl/keys as a 0600 file under 0700 folders and lists metadata only', async () => {
    const memory = memoryFiles(), authorize = vi.fn(async () => undefined)
    const view = await runSslStoreRequest(input(store(memory, null), authorize), parseSslStoreRequest({ op: 'create', keyType: 'ecdsa-prime256v1', label: 'Shop key' })) as SslStoreView
    expect(view.application.status).toBe('created')
    expect(view.context).toEqual({ scope: 'account', accountId: account.id, username: 'alice' })
    expect(view.keys).toEqual([expect.objectContaining({ id: expect.stringMatching(/^shop_key_[0-9a-f]{8}$/), label: 'Shop key', keyType: 'ec', bits: 256, valid: true })])
    expect(JSON.stringify(view)).not.toMatch(/PRIVATE KEY/)
    const id = view.keys[0]!.id
    expect([...memory.nodes].map(([path, node]) => [path, node.kind, node.mode])).toEqual([['ssl', 'directory', 0o700], ['ssl/keys', 'directory', 0o700], ['ssl/keys/' + id + '.key', 'file', 0o600], ['ssl/keys/.labels.json', 'file', 0o600]])
    expect(JSON.parse(memory.nodes.get('ssl/keys/.labels.json')!.content)).toEqual({ [id]: 'Shop key' })
    expect(authorize).toHaveBeenCalledTimes(1)
  })
  it('renames a key beside its file, keeping the id, and drops the name with the key', async () => {
    const memory = memoryFiles()
    const created = await runSslStoreRequest(input(store(memory, null)), parseSslStoreRequest({ op: 'create', keyType: 'ecdsa-prime256v1' })) as SslStoreView
    const id = created.keys[0]!.id
    expect(created.keys[0]!.label).toBeNull()
    const renamed = await runSslStoreRequest(input(store(memory)), parseSslStoreRequest({ op: 'label', kind: 'key', id, label: 'Shop (2026)' })) as SslStoreView
    expect(renamed.application).toEqual({ status: 'labelled', changed: [{ kind: 'key', id }] })
    expect(renamed.keys[0]).toMatchObject({ id, label: 'Shop (2026)' })
    expect(memory.nodes.has('ssl/keys/' + id + '.key')).toBe(true)
    const cleared = await runSslStoreRequest(input(store(memory)), parseSslStoreRequest({ op: 'label', kind: 'key', id, label: null })) as SslStoreView
    expect(cleared.keys[0]!.label).toBeNull()
    expect(memory.nodes.has('ssl/keys/.labels.json')).toBe(false)
    await runSslStoreRequest(input(store(memory)), parseSslStoreRequest({ op: 'label', kind: 'key', id, label: 'Again' }))
    await runSslStoreRequest(input(store(memory)), { op: 'delete', kind: 'key', id, modifiedAt: renamed.keys[0]!.modifiedAt })
    expect(memory.nodes.has('ssl/keys/.labels.json')).toBe(false)
    expect(await asyncRefusal(() => runSslStoreRequest(input(store(memory)), parseSslStoreRequest({ op: 'label', kind: 'key', id, label: 'Gone' })))).toMatchObject({ code: 'NOT_FOUND' })
  })
  it('creates a key, a CSR and a self-signed certificate signed by that key in one request', async () => {
    const memory = memoryFiles()
    const view = await runSslStoreRequest(input(store(memory)), parseSslStoreRequest({ op: 'create', keyType: 'rsa-2048', names: request.names, subject: request.subject, csr: true, days: 365 })) as SslStoreView
    const id = view.keys[0]!.id
    expect(view.csrs).toEqual([expect.objectContaining({ id, names: request.names, publicKeySha256: view.keys[0]!.publicKeySha256 })])
    expect(view.certificates).toEqual([expect.objectContaining({ id, names: request.names, selfSigned: true, publicKeySha256: view.keys[0]!.publicKeySha256 })])
    expect(memory.nodes.get('ssl/csrs/' + id + '.csr')!.mode).toBe(0o640)
    expect(memory.nodes.get('ssl/certs/' + id + '.crt')!.mode).toBe(0o640)
  })
  it('passes a challenge passphrase through a 0600 request file in ~/ssl that is gone afterwards', async () => {
    const memory = memoryFiles(), paths: (string | null)[] = []
    const during: string[] = []
    const run = fakeRun(memory, undefined, path => { paths.push(path); if (path) { const node = memory.nodes.get(path)!; during.push(node.content); expect(node.mode).toBe(0o600) } })
    await runSslStoreRequest(input(store(memory, run)), parseSslStoreRequest({ op: 'create', keyType: 'ecdsa-prime256v1', names: ['example.test'], csr: true, passphrase: 'open sesame' }))
    expect(paths).toEqual([expect.stringMatching(/^ssl\/\.req-[0-9a-f]{16}\.cnf$/)])
    expect(during[0]).toContain('challengePassword = open sesame')
    expect([...memory.nodes.keys()].some(path => path.includes('.req-'))).toBe(false)
  })
  it('refuses openssl output that another key signed and reports what was already saved', async () => {
    const memory = memoryFiles()
    const failure = await asyncRefusal(() => runSslStoreRequest(input(store(memory, fakeRun(memoryFiles(), ec()))), parseSslStoreRequest({ op: 'create', keyType: 'ecdsa-prime256v1', names: ['example.test'], csr: true })))
    expect(failure).toMatchObject({ code: 'SERVICE_UNAVAILABLE', stateChanged: true, verificationRequired: true })
    expect((failure.saved as { kind: string }[]).map(item => item.kind)).toEqual(['key'])
    expect([...memory.nodes.keys()].some(path => path.startsWith('ssl/csrs/') && path.endsWith('.csr'))).toBe(false)
  })
  it('needs the native runner for requests and changes nothing without it', async () => {
    const memory = memoryFiles()
    expect(await asyncRefusal(() => runSslStoreRequest(input(store(memory, null)), parseSslStoreRequest({ op: 'create', keyType: 'rsa-2048', names: ['example.test'], csr: true }))))
      .toMatchObject({ code: 'PRECONDITION_FAILED', stateChanged: false, reason: 'openssl_unavailable' })
    expect(memory.nodes.size).toBe(0)
  })
  it('imports, views, finds install material and deletes with the read revision', async () => {
    const memory = memoryFiles(), key = ec()
    await runSslStoreRequest(input(store(memory)), { op: 'import', kind: 'key', pem: pkcs8(key), label: null })
    const view = await runSslStoreRequest(input(store(memory)), { op: 'import', kind: 'certificate', pem: certFor(key, ['example.test']), label: null }) as SslStoreView
    const certificate = view.certificates[0]!
    expect(certificate.id).toMatch(/^example_test_[0-9a-f]{8}$/)
    const material = await runSslStoreRequest(input(store(memory)), { op: 'material', certificateId: certificate.id }) as { keyId: string; privateKeyPem: string; certificatePem: string }
    expect(material.keyId).toBe(view.keys[0]!.id)
    expect(material.privateKeyPem).toBe(pkcs8(key))
    const shown = await runSslStoreRequest(input(store(memory)), { op: 'view', kind: 'key', id: material.keyId }) as { pem: string }
    expect(shown.pem).toBe(pkcs8(key))
    expect(await asyncRefusal(() => runSslStoreRequest(input(store(memory)), { op: 'delete', kind: 'key', id: material.keyId, modifiedAt: '2020-01-01T00:00:00.000Z' }))).toMatchObject({ code: 'CONFLICT', stateChanged: false })
    const after = await runSslStoreRequest(input(store(memory)), { op: 'delete', kind: 'key', id: material.keyId, modifiedAt: view.keys[0]!.modifiedAt }) as SslStoreView
    expect(after.keys).toEqual([])
    expect(after.application).toEqual({ status: 'removed', changed: [{ kind: 'key', id: material.keyId }] })
    expect(await asyncRefusal(() => runSslStoreRequest(input(store(memory)), { op: 'material', certificateId: certificate.id }))).toMatchObject({ code: 'NOT_FOUND', reason: 'key_missing' })
  })
  it('lists unreadable files as invalid entries and refuses a ~/ssl that is not a folder', async () => {
    const memory = memoryFiles()
    await runSslStoreRequest(input(store(memory)), parseSslStoreRequest({ op: 'create', keyType: 'ecdsa-prime256v1', label: 'k' }))
    memory.nodes.set('ssl/keys/broken.key', { kind: 'file', content: 'not a key', mode: 0o600, mtime: '2026-01-01T00:00:00.000Z' })
    const view = await runSslStoreRequest(input(store(memory)), { op: 'read' }) as SslStoreView
    expect(view.keys.find(item => item.id === 'broken')).toEqual({ id: 'broken', label: null, modifiedAt: '2026-01-01T00:00:00.000Z', valid: false, publicKeySha256: null, keyType: null, bits: null, curve: null })
    const other = memoryFiles()
    other.nodes.set('ssl', { kind: 'file', content: 'x', mode: 0o600, mtime: '2026-01-01T00:00:00.000Z' })
    expect(await asyncRefusal(() => runSslStoreRequest(input(store(other)), parseSslStoreRequest({ op: 'create', keyType: 'rsa-2048' })))).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'directory_unmanageable' })
  })
})

/** The fake host signs requests with the stored root key, like the reviewed root openssl run. */
function rootHost() {
  const executor = new FakeHostExecutor()
  const commands: string[][] = []
  executor.runCommand = async (argv: string[]) => {
    commands.push(argv)
    expect(isRootSslStoreCommand(argv)).toBe(true)
    const key = parseStoreKey(executor.files.get(argv[4]!)!.content).key, names = argv[13]!.slice('subjectAltName='.length).split(',').map(name => name.slice(4))
    if (argv[7] === '-config') expect(executor.files.get(argv[8]!)).toMatchObject({ mode: 0o600, owner: 'root', group: 'root' })
    return { ok: true, code: 0, stdout: argv.length === 19 ? certFor(key, names) : csrFor(key, names), stderr: '' }
  }
  return { executor, commands }
}

describe('root store for the WHM SSL Storage Manager', () => {
  it('keeps root-owned 0600 files beside one index in a 0700 folder, with names and the same operations', async () => {
    const { executor, commands } = rootHost(), backend = rootSslStore(executor, true, () => new Date('2026-11-06T10:00:00.000Z'))
    const view = await runSslStoreRequest(input(backend), parseSslStoreRequest({ op: 'create', keyType: 'ecdsa-prime256v1', names: ['host.example.test'], csr: true, passphrase: 'open sesame', label: 'Mail' })) as SslStoreView
    expect(view.context).toEqual({ scope: 'server', accountId: null, username: null })
    const id = view.keys[0]!.id
    expect(view.csrs).toEqual([expect.objectContaining({ id, label: 'Mail', names: ['host.example.test'] })])
    expect(executor.dirs.get(ROOT_SSL_STORE_DIRECTORY)).toMatchObject({ mode: 0o700, owner: 'root', group: 'root' })
    expect(executor.files.get(ROOT_SSL_STORE_DIRECTORY + '/' + id + '.key')).toMatchObject({ mode: 0o600, owner: 'root', group: 'root' })
    expect(JSON.parse(executor.files.get(ROOT_SSL_STORE_DIRECTORY + '/index.json')!.content).items).toEqual([
      { kind: 'key', id, createdAt: '2026-11-06T10:00:00.000Z', label: 'Mail' }, { kind: 'csr', id, createdAt: '2026-11-06T10:00:00.000Z', label: 'Mail' }])
    expect(commands).toHaveLength(1)
    expect(commands[0]!.join(' ')).not.toContain('open sesame')
    expect([...executor.files.keys()].some(path => path.includes('.req-'))).toBe(false)
    expect(JSON.stringify(view)).not.toMatch(/PRIVATE KEY|sesame/)
    const removed = await runSslStoreRequest(input(backend), { op: 'delete', kind: 'csr', id, modifiedAt: view.csrs[0]!.modifiedAt }) as SslStoreView
    expect(removed.csrs).toEqual([])
    expect(executor.files.has(ROOT_SSL_STORE_DIRECTORY + '/' + id + '.csr')).toBe(false)
  })
  it('publishes only a CA-issued stored certificate covering the hostname as the mail candidate', async () => {
    const { executor } = rootHost(), backend = rootSslStore(executor, true)
    const site = ec(), ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    const caPem = certFor(ca, ['Fixture CA'], true)
    await runSslStoreRequest(input(backend), { op: 'import', kind: 'key', pem: pkcs8(site), label: null })
    const view = await runSslStoreRequest(input(backend), { op: 'import', kind: 'certificate', pem: certFor(site, ['host.example.test'], false, { key: ca, name: 'Fixture CA' }), label: null }) as SslStoreView
    const id = view.certificates[0]!.id, now = new Date('2026-11-06T10:00:00.000Z')
    expect(await asyncRefusal(() => publishServiceCertificate({ backend, certificateId: id, caBundlePem: caPem, hostname: 'other.example.test', executor, now }))).toMatchObject({ reason: 'names' })
    expect(await asyncRefusal(() => publishServiceCertificate({ backend, certificateId: id, caBundlePem: caPem, hostname: null, executor, now }))).toMatchObject({ reason: 'hostname_unset' })
    expect(await asyncRefusal(() => publishServiceCertificate({ backend, certificateId: id, caBundlePem: certFor(ec(), ['Other CA'], true), hostname: 'host.example.test', executor, now }))).toMatchObject({ reason: 'chain_order' })
    const candidate = await publishServiceCertificate({ backend, certificateId: id, caBundlePem: caPem, hostname: 'host.example.test', executor, now })
    expect(candidate).toMatchObject({ names: ['host.example.test'], notAfter: '2027-12-31T00:00:00.000Z' })
    expect(executor.files.get(candidate.keyPath)).toMatchObject({ mode: 0o600, owner: 'root', group: 'root' })
    expect(parseStoreKey(executor.files.get(candidate.keyPath)!.content).item.publicKeySha256).toBe(parseStoreKey(pkcs8(site)).item.publicKeySha256)
    expect(executor.files.get(candidate.certPath)!.content).toContain(caPem.trim().split('\n')[1])
    const selfSigned = await runSslStoreRequest(input(backend), { op: 'import', kind: 'certificate', pem: certFor(site, ['host.example.test']), label: null }) as SslStoreView
    const own = selfSigned.certificates.find(item => item.selfSigned)!.id
    expect(await asyncRefusal(() => publishServiceCertificate({ backend, certificateId: own, caBundlePem: null, hostname: 'host.example.test', executor, now }))).toMatchObject({ reason: 'self_signed' })
  })
  it('serves the root route to root only and audits without key material', async () => {
    const { executor } = rootHost(), audit = vi.fn(async () => undefined), authorizeRoot = vi.fn(async () => undefined)
    const deps = { caller: { principalId: 'root-id', actor: 'root', role: 'root' as const, accountId: null, resellerId: null }, authorizeRoot, executor, opensslAvailable: true, hostname: async () => 'host.example.test', audit }
    const post = (body: unknown) => handleRootSslStoreRoute(new Request('http://agent/host/ssl-store', { method: 'POST', body: JSON.stringify(body) }), new URL('http://agent/host/ssl-store'), 'POST', deps)
    expect((await post({ op: 'create', keyType: 'ecdsa-prime256v1' }))!.status).toBe(200)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ssl_store.created', target: 'server:ssl-store', principalId: 'root-id' }))
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/BEGIN|PRIVATE/)
    authorizeRoot.mockImplementationOnce(async () => fail('FORBIDDEN', 'root only', { stateChanged: false }))
    expect(await asyncRefusal(async () => post({ op: 'create', keyType: 'ecdsa-prime256v1' }))).toMatchObject({ code: 'FORBIDDEN' })
    expect(await asyncRefusal(async () => handleRootSslStoreRoute(new Request('http://agent/host/ssl-store'), new URL('http://agent/host/ssl-store'), 'GET', { ...deps, executor: null }))).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'host_unavailable' })
  })
})

describe('account agent route', () => {
  const plan = { id: 'plan', featureListId: 'features' } as Plan
  const deps = (disabled: string[] = []) => {
    const memory = memoryFiles(), audit = vi.fn(async () => undefined), authorizeCaller = vi.fn(async () => undefined)
    return { memory, audit, authorizeCaller, deps: { caller: { principalId: 'p1', actor: 'alice', role: 'user' as const, accountId: account.id, resellerId: null },
      store: { getAccountByUsername: async () => account, withAccountLifecycleLease: async <T>(_id: string, op: (fresh: Account) => Promise<T>) => op(account),
        getPlan: async () => plan, getFeatureList: async () => ({ id: 'features', disabled } as never) },
      authorizeCaller, files: () => memory.files, run: fakeRun(memory), audit } }
  }
  const call = (d: ReturnType<typeof deps>['deps'], body?: unknown) => handleSslStoreRoute(new Request('http://agent/accounts/alice/ssl-store', body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), new URL('http://agent/accounts/alice/ssl-store'), body === undefined ? 'GET' : 'POST', d)
  it('audits a change without key material or passphrase and re-authorizes before the first write', async () => {
    const d = deps(), response = await call(d.deps, { op: 'create', keyType: 'ecdsa-prime256v1', names: ['example.test'], csr: true, passphrase: 'open sesame' })
    expect(response!.status).toBe(200)
    expect(d.authorizeCaller).toHaveBeenCalledTimes(2)
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ssl_store.created', target: 'account:alice', principalId: 'p1', detail: expect.objectContaining({ challengePassphrase: true }) }))
    expect(JSON.stringify(d.audit.mock.calls)).not.toMatch(/BEGIN|PRIVATE|sesame/)
    expect(JSON.stringify(await response!.json())).not.toMatch(/PRIVATE KEY/)
  })
  it('honours the plan feature list', async () => {
    expect(await asyncRefusal(() => call(deps(['SSL/TLS']).deps))).toMatchObject({ code: 'FORBIDDEN' })
    expect(await asyncRefusal(() => call(deps(['ssl-csrs']).deps, { op: 'create', keyType: 'rsa-2048', names: ['example.test'], csr: true }))).toMatchObject({ code: 'FORBIDDEN' })
    expect((await call(deps(['ssl-csrs']).deps, { op: 'create', keyType: 'ecdsa-prime256v1' }))!.status).toBe(200)
  })
})
