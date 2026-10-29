import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, Plan, ServiceUser } from '@xpanel/core'
import { handleAccountPgpRoute, parseGpgKeys, parsePgpRequest, pgpMailboxes, pgpRevision, runPgpRequest } from './account-pgp.ts'
import type { PgpRouteDeps, PgpView } from './account-pgp.ts'
import type { GpgCommand, GpgIdentity } from '../../../packages/os/src/gpg-command.ts'
const ID = '11111111-1111-4111-8111-111111111111', FP = 'A'.repeat(40), OTHER = 'B'.repeat(40)
const account = { id: ID, username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', planId: 'plan' } as Account
const armor = '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nYWJj\n-----END PGP PUBLIC KEY BLOCK-----\n'
const listing = (fingerprint = FP, secret = false, encryption = true) => `${secret ? 'sec' : 'pub'}:u:255:22:${fingerprint.slice(-16)}:1700000000:1800000000::u:::scSC:\nfpr:::::::::${fingerprint}:\nuid:u::::1700000000::::Alice <alice@example.test>:\n${encryption ? 'sub:u:255:18:CCCCCCCCCCCCCCCC:1700000000:1800000000:::::e:\nfpr:::::::::' + 'C'.repeat(40) + ':\n' : ''}`
function setup(options: { initial?: boolean; dir?: boolean; secretImport?: boolean; noReadback?: boolean; failSubkey?: boolean } = {}) {
  let exists = options.dir !== false, present = !!options.initial, secret = !!options.initial, encryption = !!options.initial
  const files = { list: vi.fn(async () => exists ? [{ path: '.gnupg', kind: 'directory', mode: 0o700 }] : []), mkdir: vi.fn(async () => { exists = true }), chmod: vi.fn() } as unknown as Parameters<typeof runPgpRequest>[0]['files']
  const run = vi.fn(async (_identity: GpgIdentity, command: GpgCommand, stdin?: string) => {
    if (command.op === 'public' || command.op === 'secret') return { ok: true, stdout: present && (command.op === 'public' || secret) ? listing(FP, command.op === 'secret', encryption) : '', status: '' }
    if (command.op === 'version') return { ok: true, stdout: 'gpg (GnuPG) 2.2.40\n', status: '' }
    if (command.op === 'inspect') return { ok: true, stdout: listing(), status: '' }
    if (command.op === 'generate') { expect(stdin).toBe('private passphrase\n'); present = true; secret = true; return { ok: true, stdout: '', status: '[GNUPG:] KEY_CREATED P ' + FP } }
    if (command.op === 'subkey') { encryption = !options.failSubkey; return { ok: !options.failSubkey, stdout: '', status: '' } }
    if (command.op === 'import') { present = !options.noReadback; secret = !!options.secretImport; return { ok: true, stdout: '', status: '[GNUPG:] IMPORT_OK 1 ' + FP } }
    if (command.op === 'delete') { if (!options.noReadback) present = false; return { ok: true, stdout: '', status: '' } }
    return { ok: true, stdout: armor, status: '' }
  })
  const authorize = vi.fn(async () => {})
  const input = { account, files, runner: { run }, mailboxes: ['alice@example.test'], authorize }
  return { input, run, files, authorize, read: async () => await runPgpRequest({ ...input, request: { op: 'read' } }) as PgpView }
}
describe('OpenPGP listing and grammar', () => {
  it('parses public and secret metadata without secret material', () => {
    expect(parseGpgKeys(listing())).toEqual([{ fingerprint: FP, uids: ['Alice <alice@example.test>'], algorithm: 'Ed25519', bits: 255, created: '2023-11-14T22:13:20.000Z', expires: '2027-01-15T08:00:00.000Z', hasSecret: false, encryption: true }])
    expect(parseGpgKeys(listing(FP, true))[0]!.hasSecret).toBe(true)
    expect(parseGpgKeys(listing().replace('Alice', 'A\\x3alice'))[0]!.uids[0]).toBe('A:lice <alice@example.test>')
  })
  it('rejects truncated, contradictory and malformed colon records', () => {
    for (const bad of [listing().trim(), listing().replace('255:22', 'oops:22'), listing().replace(FP + ':', 'not-a-fingerprint:'), listing() + listing(), listing().replace('Alice', 'A\\x00lice'), listing().replace('uid:', 'unknown:')]) expect(() => parseGpgKeys(bad)).toThrow()
  })
  it('reads short trust records and does not report token-backed or missing secret stubs as local secrets', () => {
    expect(parseGpgKeys('tru:o:0:1166697654:1:3:1:5\n' + listing())).toHaveLength(1)
    const stub = (marker: string) => { const lines = listing(FP, true, false).split('\n'), fields = lines[0]!.split(':'); fields[14] = marker; lines[0] = fields.join(':'); return lines.join('\n') }
    for (const marker of ['#', 'D2760001240100000000000000000000']) expect(parseGpgKeys(stub(marker))[0]!.hasSecret).toBe(false)
    expect(parseGpgKeys(stub('+'))[0]!.hasSecret).toBe(true)
    expect(() => parseGpgKeys('tru:o:invalid\n' + listing())).toThrow()
  })
  it('requires finite payloads, strong passphrases and exact typed confirmation', () => {
    const body = { op: 'generate', expectedRevision: 'a'.repeat(64), name: 'Alice', address: 'alice@example.test', algorithm: 'ed25519', days: 365, passphrase: 'private passphrase' }
    expect(parsePgpRequest('POST', body)).toEqual(body)
    for (const bad of [{ ...body, account: 'bob' }, { ...body, passphrase: 'short' }, { ...body, algorithm: 'rsa1024' }, { ...body, days: 0 }, { ...body, name: 'Alice\n--export-secret-keys' }]) expect(() => parsePgpRequest('POST', bad)).toThrow()
    expect(() => parsePgpRequest('DELETE', { op: 'delete', expectedRevision: body.expectedRevision, fingerprint: FP, confirmation: OTHER })).toThrow()
  })
  it('selects only this account’s email-enabled service users', () => {
    const users = [{ accountId: ID, login: 'ALICE@example.test', services: { email: true } }, { accountId: ID, login: 'ftp@example.test', services: { email: false } }, { accountId: 'other', login: 'bob@example.test', services: { email: true } }] as ServiceUser[]
    expect(pgpMailboxes(account, users)).toEqual(['alice@example.test'])
  })
})
describe('OpenPGP verified account operations', () => {
  it('generates a signing key plus encryption subkey, with secret stdin only and verified metadata', async () => {
    const t = setup({ dir: false }), before = await t.read(), result = await runPgpRequest({ ...t.input, request: parsePgpRequest('POST', { op: 'generate', expectedRevision: before.revision, name: 'Alice', address: 'alice@example.test', algorithm: 'ed25519', days: 365, passphrase: 'private passphrase' }) }) as PgpView
    expect(t.files.mkdir).toHaveBeenCalledWith('.gnupg', 0o700); expect(result.application).toEqual({ status: 'generated', fingerprint: FP }); expect(result.keys[0]).toMatchObject({ hasSecret: true, encryption: true })
    expect(JSON.stringify(result)).not.toContain('private passphrase'); expect(t.authorize.mock.calls.length).toBeGreaterThan(2)
    expect(t.run.mock.calls.filter(call => ['generate', 'subkey'].includes(call[1].op)).every(call => call[0].uid === 1001 && call[0].gid === 1001)).toBe(true)
  })
  it('imports and deletes only when the re-read proves the requested result', async () => {
    const t = setup(), before = await t.read(), added = await runPgpRequest({ ...t.input, request: { op: 'import', expectedRevision: before.revision, armor } }) as PgpView
    expect(added.application.status).toBe('imported'); expect(added.keys).toHaveLength(1)
    const exported = await runPgpRequest({ ...t.input, request: { op: 'export', fingerprint: FP } }); expect(exported).toMatchObject({ kind: 'public', armor })
    const removed = await runPgpRequest({ ...t.input, request: { op: 'delete', expectedRevision: added.revision, fingerprint: FP, confirmation: FP } }) as PgpView
    expect(removed.keys).toEqual([]); expect(removed.application.status).toBe('deleted')
  })
  it('locks uncertain mutation results instead of claiming success or retrying', async () => {
    const noReadback = setup({ noReadback: true }), before = await noReadback.read()
    await expect(runPgpRequest({ ...noReadback.input, request: { op: 'import', expectedRevision: before.revision, armor } })).rejects.toMatchObject({ detail: { unknownOutcome: true, verificationRequired: true } })
    const partial = setup({ failSubkey: true })
    await expect(runPgpRequest({ ...partial.input, request: parsePgpRequest('POST', { op: 'generate', expectedRevision: (await partial.read()).revision, name: 'Alice', address: 'alice@example.test', algorithm: 'ed25519', days: 365, passphrase: 'private passphrase' }) })).rejects.toMatchObject({ detail: { unknownOutcome: true } })
  })
  it('refuses a generation status that names an already existing key', async () => {
    const t = setup({ initial: true }), before = await t.read()
    await expect(runPgpRequest({ ...t.input, request: parsePgpRequest('POST', { op: 'generate', expectedRevision: before.revision, name: 'Alice', address: 'alice@example.test', algorithm: 'ed25519', days: 365, passphrase: 'private passphrase' }) })).rejects.toMatchObject({ detail: { unknownOutcome: true, verificationRequired: true } })
    expect(t.run.mock.calls.some(call => call[1].op === 'subkey')).toBe(false)
  })
  it('refuses stale state, foreign mailboxes and authority lost before mutation', async () => {
    const t = setup(), request = { op: 'import' as const, expectedRevision: 'a'.repeat(64), armor }
    await expect(runPgpRequest({ ...t.input, request })).rejects.toMatchObject({ code: 'CONFLICT' }); expect(t.run.mock.calls.map(call => call[1].op)).toEqual(['public', 'secret'])
    const generate = parsePgpRequest('POST', { op: 'generate', expectedRevision: pgpRevision(ID, []), name: 'Bob', address: 'bob@example.test', algorithm: 'rsa3072', days: 1, passphrase: 'private passphrase' })
    await expect(runPgpRequest({ ...t.input, request: generate })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const callsBeforeDenial = t.run.mock.calls.length
    await expect(runPgpRequest({ ...t.input, request: { ...request, expectedRevision: pgpRevision(ID, []) }, authorize: async () => fail('FORBIDDEN', 'lost authority', { stateChanged: false }) })).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(t.run).toHaveBeenCalledTimes(callsBeforeDenial)
  })
  it('rechecks every imported mailbox immediately before mutation', async () => {
    const t = setup()
    await expect(runPgpRequest({ ...t.input, request: { op: 'import', expectedRevision: pgpRevision(ID, []), armor }, authorize: async mailboxes => { if (mailboxes?.includes('alice@example.test')) fail('FORBIDDEN', 'mailbox removed', { stateChanged: false }) } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(t.run.mock.calls.some(call => call[1].op === 'import')).toBe(false)
  })
  it('refuses symlink or nonprivate keyring roots before executing GnuPG', async () => {
    for (const entry of [{ path: '.gnupg', kind: 'symlink', mode: 0o700 }, { path: '.gnupg', kind: 'directory', mode: 0o755 }]) {
      const t = setup(); vi.mocked(t.files.list).mockResolvedValue([entry] as never)
      await expect(t.read()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' }); expect(t.run).not.toHaveBeenCalled()
    }
  })
  it('rejects foreign imported identities and refuses a private export from the runner', async () => {
    const t = setup(); t.run.mockImplementation(async (_identity, command) => ({ ok: true, stdout: command.op === 'version' ? 'gpg (GnuPG) 2.2.40\n' : command.op === 'inspect' ? listing().replace('alice@example.test', 'bob@example.test') : '', status: '' }))
    await expect(runPgpRequest({ ...t.input, request: { op: 'import', expectedRevision: pgpRevision(ID, []), armor } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const present = setup({ initial: true }); present.run.mockImplementation(async (_identity, command) => ({ ok: true, stdout: command.op === 'export' ? armor.replaceAll('PUBLIC', 'PRIVATE') : listing(FP, command.op === 'secret'), status: '' }))
    await expect(runPgpRequest({ ...present.input, request: { op: 'export', fingerprint: FP } })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('agent route holds the lifecycle lease and audits fingerprints only', async () => {
    const t = setup(), audit = vi.fn(async (_entry: Record<string, unknown>) => {}), lease = vi.fn(async (_id: string, operation: (account: Account) => Promise<unknown>) => operation(account)), users = [{ accountId: ID, login: 'alice@example.test', services: { email: true } }] as ServiceUser[]
    const deps = { caller: { role: 'user', accountId: ID, principalId: 'owner', actor: 'alice' }, store: { getAccountByUsername: async () => account, getPlan: async () => ({ id: 'plan', featureListId: 'features' }) as Plan, getFeatureList: async () => ({ disabled: [] }), listServiceUsers: async () => users, withAccountLifecycleLease: lease }, currentPrincipal: async () => ({ id: 'owner', kind: 'user', accountId: ID, username: 'alice', disabled: false }), files: () => t.input.files, runner: t.input.runner, audit } as unknown as PgpRouteDeps
    const url = new URL('http://agent/accounts/alice/pgp'), req = new Request(url, { method: 'POST', body: JSON.stringify({ op: 'import', expectedRevision: pgpRevision(ID, []), armor }) })
    const response = await handleAccountPgpRoute(req, url, 'POST', deps)
    expect(response?.status).toBe(200); expect(lease).toHaveBeenCalledWith(ID, expect.any(Function)); expect(audit.mock.calls[0]![0]).toMatchObject({ detail: { fingerprint: FP } }); expect(JSON.stringify(audit.mock.calls)).not.toContain('YWJj')
    await expect(handleAccountPgpRoute(new Request(url), url, 'GET', { ...deps, caller: { ...deps.caller, accountId: 'foreign' } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
