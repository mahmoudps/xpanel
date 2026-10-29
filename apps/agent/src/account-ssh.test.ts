import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, Plan } from '@xpanel/core'
import type { FileText } from './file-manager.ts'
import { AUTHORIZED_KEYS_PATH, handleAccountSshRoute, parseAccountSshRequest, parseAuthorizedKeys, parseNewAuthorizedKey, runAccountSshRequest, sshKeysRevision } from './account-ssh.ts'
import type { AccountSshFiles, AccountSshRouteDeps } from './account-ssh.ts'

// OpenSSH public key wire format (RFC 4251/4253/5656/8709) built from real node:crypto keys.
const str = (value: Buffer | string): Buffer => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1'), length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return Buffer.concat([length, bytes]) }
const mpint = (value: Buffer): Buffer => str((value[0]! & 0x80) ? Buffer.concat([Buffer.alloc(1), value]) : value)
const jwk = (key: KeyObject): Record<string, string> => key.export({ format: 'jwk' }) as Record<string, string>
const ed25519 = (): string => 'ssh-ed25519 ' + Buffer.concat([str('ssh-ed25519'), str(Buffer.from(jwk(generateKeyPairSync('ed25519').publicKey).x!, 'base64url'))]).toString('base64')
const ecdsa = (bits: 256 | 384 | 521): string => {
  const value = jwk(generateKeyPairSync('ec', { namedCurve: 'P-' + bits }).publicKey), point = Buffer.concat([Buffer.from([4]), Buffer.from(value.x!, 'base64url'), Buffer.from(value.y!, 'base64url')])
  return 'ecdsa-sha2-nistp' + bits + ' ' + Buffer.concat([str('ecdsa-sha2-nistp' + bits), str('nistp' + bits), str(point)]).toString('base64')
}
const rsa = (bits: number): string => { const value = jwk(generateKeyPairSync('rsa', { modulusLength: bits }).publicKey); return 'ssh-rsa ' + Buffer.concat([str('ssh-rsa'), mpint(Buffer.from(value.e!, 'base64url')), mpint(Buffer.from(value.n!, 'base64url'))]).toString('base64') }
const fingerprint = (line: string): string => 'SHA256:' + createHash('sha256').update(Buffer.from(line.split(' ')[1]!, 'base64')).digest('base64').replace(/=+$/, '')
const ED = ed25519(), ED2 = ed25519(), EC = ecdsa(256), RSA3072 = rsa(3072), RSA2048 = rsa(2048)
const field = (fn: () => unknown): string => { try { fn() } catch (error) { return ((error as { detail?: { fields?: { code: string }[] } }).detail?.fields?.[0]?.code) ?? 'thrown' } return 'accepted' }

const ACCOUNT = '11111111-1111-4111-8111-111111111111', PLAN = '22222222-2222-4222-8222-222222222222'
const account = { id: ACCOUNT, username: 'alice', status: 'active', shell: 'jailed', planId: PLAN, uid: 1001, gid: 1001, home: '/home/alice' } as Account
const plan = { id: PLAN, featureListId: 'list', shell: 'jailed' } as Plan
function files(initial: { dir?: { kind: 'directory' | 'symlink' | 'file'; mode: number } | null; content?: string | null } = {}) {
  let dir = initial.dir === undefined ? { kind: 'directory' as const, mode: 0o700 } : initial.dir, tick = 0, mode = 0o600
  const make = (content: string): FileText => ({ path: AUTHORIZED_KEYS_PATH, content, sizeBytes: Buffer.byteLength(content), mtime: new Date(1700000000000 + ++tick * 1000).toISOString() })
  let file: FileText | null = initial.content === undefined || initial.content === null ? null : make(initial.content)
  const entry = () => ({ name: '.ssh', path: '.ssh', kind: dir!.kind, sizeBytes: 0, mode: dir!.mode, mtime: new Date(0).toISOString() })
  const api = {
    list: vi.fn(async () => dir ? [entry(), { name: 'public_html', path: 'public_html', kind: 'directory', sizeBytes: 0, mode: 0o750, mtime: new Date(0).toISOString() }] : []),
    readText: vi.fn(async () => file ? { ...file } : fail('NOT_FOUND', 'missing')),
    writeTextChecked: vi.fn(async (_path: string, content: string | null, expected: FileText | null, nextMode?: number) => {
      if (JSON.stringify(expected) !== JSON.stringify(file)) return fail('CONFLICT', 'file preimage changed', { stateChanged: false })
      file = make(content ?? ''); mode = nextMode ?? 0o640
      return { name: 'authorized_keys', path: AUTHORIZED_KEYS_PATH, kind: 'file' as const, sizeBytes: file.sizeBytes, mode, mtime: file.mtime }
    }),
    mkdir: vi.fn(async (_path: string, nextMode: number) => { if (dir) return fail('CONFLICT', 'target exists'); dir = { kind: 'directory', mode: nextMode }; return entry() }),
    chmod: vi.fn(async (_path: string, nextMode: number) => { dir = { ...dir!, mode: nextMode }; return entry() }),
  }
  return { api, files: api as unknown as AccountSshFiles, file: () => file, dir: () => dir, mode: () => mode, replace: (content: string) => { file = make(content) } }
}
const run = (fs: ReturnType<typeof files>, method: string, body?: unknown, authorize = async () => undefined) => runAccountSshRequest({ account, plan, settings: { sshPort: 2222 } as never, files: fs.files, request: parseAccountSshRequest(method, body), authorize })

describe('authorized_keys parsing (sshd(8) AUTHORIZED_KEYS FILE FORMAT)', () => {
  it('lists keys with type, comment, options flag and SHA256 fingerprints; ignores comments and flags malformed lines', () => {
    const content = '# managed by me\n\n' + ED + ' laptop key\r\nfrom="192.0.2.0/24",command="echo \\"hi there\\"" ' + EC + ' ci\n' + RSA2048 + '\nssh-ed25519 AAAA@@@@ broken\nssh-rsa ' + ED.split(' ')[1] + ' wrong type\n  ' + RSA3072 + '\n'
    const parsed = parseAuthorizedKeys(content)
    expect(parsed.keys.map(key => [key.line, key.type, key.comment, key.hasOptions, key.allowed, key.bits])).toEqual([[3, 'ssh-ed25519', 'laptop key', false, true, 256], [4, 'ecdsa-sha2-nistp256', 'ci', true, true, 256], [5, 'ssh-rsa', '', false, false, 2048], [8, 'ssh-rsa', '', false, true, 3072]])
    expect(parsed.keys[0]!.fingerprint).toBe(fingerprint(ED)); expect(parsed.keys[0]!.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(parsed.unrecognizedLines).toEqual([6, 7])
    expect(parseAuthorizedKeys('command="unterminated ' + ED).unrecognizedLines).toEqual([1])
  })
  it('accepts only allowlisted single keys and refuses options, injection and weak or malformed keys', () => {
    expect(parseNewAuthorizedKey(ED + '  my laptop ')).toMatchObject({ type: 'ssh-ed25519', comment: 'my laptop', fingerprint: fingerprint(ED), line: ED + ' my laptop' })
    expect(parseNewAuthorizedKey(ecdsa(384)).bits).toBe(384); expect(parseNewAuthorizedKey(ecdsa(521)).bits).toBe(521); expect(parseNewAuthorizedKey(RSA3072 + ' build').bits).toBe(3072)
    const point = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]), offCurve = 'ecdsa-sha2-nistp256 ' + Buffer.concat([str('ecdsa-sha2-nistp256'), str('nistp256'), str(point)]).toString('base64')
    expect([
      field(() => parseNewAuthorizedKey(RSA2048)), field(() => parseNewAuthorizedKey('command="sh" ' + ED)), field(() => parseNewAuthorizedKey('no-pty ' + ED)),
      field(() => parseNewAuthorizedKey(ED + ' a\n' + ED2)), field(() => parseNewAuthorizedKey(ED + ' a\rb')), field(() => parseNewAuthorizedKey(ED + ' bad\u0000')), field(() => parseNewAuthorizedKey(ED + ' \u202eevil')),
      field(() => parseNewAuthorizedKey('ssh-dss ' + ED.split(' ')[1])), field(() => parseNewAuthorizedKey(offCurve)), field(() => parseNewAuthorizedKey('ssh-ed25519 ' + EC.split(' ')[1])),
      field(() => parseNewAuthorizedKey(ED + ' ' + 'c'.repeat(256))), field(() => parseNewAuthorizedKey('')), field(() => parseNewAuthorizedKey(42)), field(() => parseNewAuthorizedKey(ED.slice(0, -4))),
    ]).toEqual(['rsa_too_short', 'options_refused', 'options_refused', 'multiple_lines', 'multiple_lines', 'invalid_characters', 'invalid_characters', 'unsupported_type', 'invalid_key', 'invalid_key', 'comment_too_long', 'required', 'invalid', 'invalid_key'])
    expect(() => parseAccountSshRequest('POST', { expectedRevision: 'a'.repeat(64), key: ED, path: '/root/.ssh/authorized_keys' })).toThrow()
    expect(() => parseAccountSshRequest('DELETE', { expectedRevision: 'a'.repeat(64), fingerprint: 'MD5:aa' })).toThrow()
    expect(() => parseAccountSshRequest('PUT', {})).toThrow()
  })
})

describe('confined authorized_keys workspace', () => {
  it('creates ~/.ssh 0700 and the file 0600 through the runner, then re-reads it', async () => {
    const fs = files({ dir: null })
    const read = await run(fs, 'GET')
    expect(read).toMatchObject({ file: { exists: false, directory: { exists: false, kind: null }, revision: sshKeysRevision(ACCOUNT, null) }, keys: [], capabilities: { canAdd: true, canRemove: false }, login: { enabled: true, port: 2222, source: 'saved-configuration' }, application: { nativeQualified: false } })
    const added = await run(fs, 'POST', { expectedRevision: read.file.revision, key: ED + ' laptop' })
    expect(fs.api.mkdir).toHaveBeenCalledWith('.ssh', 0o700); expect(fs.mode()).toBe(0o600); expect(fs.file()!.content).toBe(ED + ' laptop\n')
    expect(added).toMatchObject({ application: { status: 'added' }, keys: [{ fingerprint: fingerprint(ED), comment: 'laptop' }], file: { exists: true, directory: { mode: 0o700 } } })
    expect(fs.api.readText).toHaveBeenCalledTimes(1)
    await expect(run(fs, 'POST', { expectedRevision: added.file.revision, key: ED + ' again' })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false, fields: [{ code: 'duplicate' }] } })
  })
  it('appends after a file without a trailing newline, tightens a loose ~/.ssh mode and removes by fingerprint keeping other bytes', async () => {
    const fs = files({ dir: { kind: 'directory', mode: 0o750 }, content: '# keep\r\n' + ED + ' one\r\n' + EC })
    const read = await run(fs, 'GET')
    const added = await run(fs, 'POST', { expectedRevision: read.file.revision, key: ED2 })
    expect(fs.api.chmod).toHaveBeenCalledWith('.ssh', 0o700); expect(fs.file()!.content).toBe('# keep\r\n' + ED + ' one\r\n' + EC + '\n' + ED2 + '\n')
    const removed = await run(fs, 'DELETE', { expectedRevision: added.file.revision, fingerprint: fingerprint(ED) })
    expect(fs.file()!.content).toBe('# keep\r\n' + EC + '\n' + ED2 + '\n'); expect(removed.application).toMatchObject({ status: 'removed', removedLines: 1 })
    await expect(run(fs, 'DELETE', { expectedRevision: removed.file.revision, fingerprint: fingerprint(ED) })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('refuses stale revisions with 409 before any write, passes preimage conflicts through and keeps unmanageable directories read-only', async () => {
    const fs = files({ content: ED + '\n' })
    const read = await run(fs, 'GET'); fs.replace(ED + '\n' + EC + '\n')
    await expect(run(fs, 'POST', { expectedRevision: read.file.revision, key: ED2 })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(fs.api.writeTextChecked).not.toHaveBeenCalled()
    const racing = files({ content: ED + '\n' }), current = await run(racing, 'GET')
    racing.api.writeTextChecked.mockImplementationOnce(async () => fail('CONFLICT', 'file preimage changed', { stateChanged: false }))
    await expect(run(racing, 'POST', { expectedRevision: current.file.revision, key: ED2 })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    const lost = files({ content: ED + '\n' }), before = await run(lost, 'GET')
    lost.api.writeTextChecked.mockImplementationOnce(async () => fail('SERVICE_UNAVAILABLE', 'helper died', { stateChanged: true, unknownOutcome: true }))
    await expect(run(lost, 'POST', { expectedRevision: before.file.revision, key: ED2 })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    const linked = files({ dir: { kind: 'symlink', mode: 0o777 } }), view = await run(linked, 'GET')
    expect(view.capabilities).toEqual({ canAdd: false, canRemove: false, reason: 'directory_unmanageable' }); expect(linked.api.readText).not.toHaveBeenCalled()
    await expect(run(linked, 'POST', { expectedRevision: view.file.revision, key: ED })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const created = files({ dir: null }), empty = await run(created, 'GET')
    created.api.mkdir.mockImplementationOnce(async () => fail('CONFLICT', 'mkdirat failed: File exists'))
    await expect(run(created, 'POST', { expectedRevision: empty.file.revision, key: ED })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    const denied = files(), seen = await run(denied, 'GET')
    await expect(run(denied, 'POST', { expectedRevision: seen.file.revision, key: ED }, async () => fail('FORBIDDEN', 'gone', { stateChanged: false }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(denied.api.writeTextChecked).not.toHaveBeenCalled()
  })
})

describe('agent SSH key route authority', () => {
  const principal = { kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT, disabled: false }
  const deps = (over: Partial<{ caller: AccountSshRouteDeps['caller']; disabled: string[]; principal: typeof principal | null; fs: ReturnType<typeof files> }> = {}) => {
    const fs = over.fs ?? files(), audit = vi.fn(async () => undefined), lease = vi.fn(async (_id: string, op: (a: Account) => Promise<Response>) => op(account))
    const value: AccountSshRouteDeps = { caller: over.caller ?? { principalId: 'p-alice', actor: 'alice', role: 'user', accountId: ACCOUNT, resellerId: null },
      store: { getAccountByUsername: async name => name === 'alice' ? account : name === 'bob' ? { ...account, id: '33333333-3333-4333-8333-333333333333', username: 'bob' } : null, withAccountLifecycleLease: lease as never,
        getPlan: async () => plan, getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: over.disabled ?? [] }), getServerSettings: async () => null },
      currentPrincipal: async () => over.principal === undefined ? principal : over.principal, files: () => fs.files, audit }
    return { value, fs, audit, lease }
  }
  const call = (d: AccountSshRouteDeps, method = 'GET', body?: unknown, path = '/accounts/alice/ssh/keys') => { const url = new URL('http://agent.local' + path); return handleAccountSshRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, method, d) }
  it('serves the owner, audits a change and ignores unrelated paths', async () => {
    const d = deps(), read = await (await call(d.value))!.json() as { file: { revision: string } }
    expect(await call(d.value, 'GET', undefined, '/accounts/alice/files')).toBeNull()
    const response = await call(d.value, 'POST', { expectedRevision: read.file.revision, key: ED })
    expect(response!.status).toBe(200); expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'account.ssh_key.added', target: 'account:alice', detail: { fingerprint: fingerprint(ED), type: 'ssh-ed25519' } }))
    expect(JSON.stringify(d.audit.mock.calls)).not.toContain(ED.split(' ')[1])
  })
  it('refuses reseller, root, foreign, disabled-plan and revoked callers without touching files', async () => {
    for (const role of ['reseller', 'root'] as const) await expect(call(deps({ caller: { principalId: 'x', actor: 'x', role, accountId: null, resellerId: null } }).value)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const foreign = deps(); await expect(call(foreign.value, 'GET', undefined, '/accounts/bob/ssh/keys')).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(foreign.lease).not.toHaveBeenCalled()
    const disabled = deps({ disabled: ['ssh-access'] }); await expect(call(disabled.value)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(disabled.fs.api.list).not.toHaveBeenCalled()
    await expect(call(deps({ disabled: ['SSH Access & Terminal'] }).value)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(deps({ principal: { ...principal, disabled: true } }).value)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(deps().value, 'GET', undefined, '/accounts/alice/ssh/keys?account=bob')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call(deps().value, 'PUT'))!.status).toBe(405)
  })
})
