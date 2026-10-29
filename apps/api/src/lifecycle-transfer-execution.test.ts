import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import { buildReview, createTransferSession, transition } from '@xpanel/lifecycle'
import type { TransferEvent } from '@xpanel/lifecycle'
import { createTransferExecution } from './lifecycle-transfer-execution.ts'
import type { TransferExecutionDeps } from './lifecycle-transfer-execution.ts'
import { signTransferManifest } from './acct-transfer-source.ts'
import type { TransferSourceRequest } from './acct-transfer-discovery.ts'
import type { AuthenticatedCaller } from './auth.ts'

// Synthetic transports and agent ports only: no network, no host. The production HTTPS channel is not exercised.
const TOKEN = 'xp_' + 'a'.repeat(43), TOKEN_ID = '11111111-1111-4111-8111-111111111111', PLAN = '22222222-2222-4222-8222-222222222222'
const auth = { kind: 'api-token' as const, url: 'https://source.example.test', tokenId: TOKEN_ID, tlsFingerprint: null }
const caller = { principal: { kind: 'root', id: 'r', username: 'root' }, sessionId: 's', apiTokenId: null } as unknown as AuthenticatedCaller
const accountOf = (username: string) => ({ username, uid: 20001, primaryDomain: username + '.example.test', domains: [username + '.example.test', 'shop.' + username + '.example.test'], plan: 'gold', diskBytes: 100, databases: [username + '_wp'], mailboxes: 2, phpVersions: ['8.3'] })
const session = (names = ['alice']) => {
  let s = createTransferSession({ id: '33333333-3333-4333-8333-333333333333', actor: 'root', now: '2026-10-28T00:00:00.000Z', auth })
  s = transition(s, { type: 'connected', source: { hostname: 'source.example.test', version: '1.0.0' } }, '2026-10-28T00:00:01.000Z')
  s = transition(s, { type: 'inventory', accounts: names.map(accountOf), plans: [{ name: 'gold' }] }, '2026-10-28T00:00:02.000Z')
  s = transition(s, { type: 'select', accounts: names, plans: [], local: { usernames: [], domains: [], uids: [], plans: ['gold'] } }, '2026-10-28T00:00:03.000Z')
  s = transition(s, { type: 'review' }, '2026-10-28T00:00:04.000Z')
  return s
}
const archive = Buffer.from('gzip archive bytes'), sha = createHash('sha256').update(archive).digest('hex')
const manifestFor = (username: string, token = TOKEN) => { const manifest = { source: 'source.example.test', username, file: `xpanel-backup-${username}-20261028T120000Z.tar.gz`, bytes: archive.length, sha256: sha, createdAt: '2026-10-28T12:00:00.000Z' }; return { manifest, signature: signTransferManifest(token, manifest) } }
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

const fixture = (overrides: Partial<TransferExecutionDeps> = {}, local: { accounts?: string[]; domains?: string[] } = {}) => {
  const calls: unknown[][] = []
  const deps: TransferExecutionDeps = {
    store: { listAccounts: async () => (local.accounts ?? []).map(username => ({ username })) as never, listDomains: async () => (local.domains ?? []).map(name => ({ name })) as never, listPlans: async () => [{ id: PLAN, name: 'gold' }] as never },
    readToken: async id => id === TOKEN_ID ? TOKEN : null,
    transport: async (input: TransferSourceRequest) => { calls.push(['manifest', input.url, input.method, input.token]); const username = /accounts\/([a-z0-9]+)\/backup$/.exec(input.url)![1]!; return { status: 201, contentType: 'application/json', body: JSON.stringify(manifestFor(username)) } },
    streamTransport: async (input: TransferSourceRequest) => { calls.push(['download', input.url, input.maxBytes]); return { status: 200, contentType: 'application/gzip', body: (async function* () { yield archive.subarray(0, 5); yield archive.subarray(5) })() } },
    importArchive: async (_caller, username, body, expected) => {
      const bytes = Buffer.from(await new Response(body).arrayBuffer())
      calls.push(['import', username, bytes.length, expected])
      return json(201, { file: `xpanel-backup-${username}-20261028T130000Z-abcdefabcdef.tar.gz`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    },
    createAccount: async (_caller, input) => { calls.push(['create', input]); return { id: 'new', username: input.username } },
    restoreArchive: async (_caller, username, file) => { calls.push(['restore', username, file]); return json(200, { backup: { file } }) },
    verifyArchive: async (_caller, username, file) => { calls.push(['verify', username, file]); return json(200, { file, archiveSha256: sha, verified: true, counts: {}, mailCompared: false }) },
    audit: async (_caller, action) => { calls.push(['audit', action]) },
    ...overrides,
  }
  const events: TransferEvent[] = []
  const execution = createTransferExecution(deps)
  return { calls, events, execution, run: async (s = session()) => { await execution.run(caller, s, buildReview(s), async event => { events.push(event) }) } }
}

describe('server-to-server transfer execution', () => {
  it('requests a signed archive, streams it with its digest, creates the account, restores and verifies it', async () => {
    const f = fixture()
    await f.execution.admit(caller, session(), buildReview(session()))
    await f.run()
    expect(f.events.map(event => (event as { phase: string }).phase)).toEqual(['exporting', 'copying', 'importing', 'reconciling', 'done'])
    expect(f.calls.filter(call => call[0] !== 'audit')).toEqual([
      ['manifest', 'https://source.example.test/api/transfers/source/accounts/alice/backup', 'POST', TOKEN],
      ['download', 'https://source.example.test/api/transfers/source/accounts/alice/backup/xpanel-backup-alice-20261028T120000Z.tar.gz', archive.length],
      ['import', 'alice', archive.length, { bytes: archive.length, sha256: sha }],
      ['create', { username: 'alice', primaryDomain: 'alice.example.test', planId: PLAN }],
      ['restore', 'alice', 'xpanel-backup-alice-20261028T130000Z-abcdefabcdef.tar.gz'],
      ['verify', 'alice', 'xpanel-backup-alice-20261028T130000Z-abcdefabcdef.tar.gz'],
    ])
    expect(f.calls.at(-1)).toEqual(['audit', 'transfer.account.imported'])
  })
  it('refuses a conflicting account before any download and continues with the next account', async () => {
    const f = fixture({}, { accounts: ['alice'] })
    await f.run(session(['alice', 'bob']))
    expect(f.events.filter(event => (event as { account: string }).account === 'alice').map(event => (event as { phase: string }).phase)).toEqual(['exporting', 'failed'])
    expect((f.events[1] as { error: string }).error).toMatch(/already has the account name/)
    expect(f.calls.some(call => call[0] === 'manifest' && String(call[1]).includes('/alice/'))).toBe(false)
    expect(f.events.at(-1)).toMatchObject({ account: 'bob', phase: 'done' })
  })
  it('stops before any change when the manifest signature, the source digest or the stored digest does not match', async () => {
    for (const overrides of [
      { transport: async () => ({ status: 201, contentType: 'application/json', body: JSON.stringify(manifestFor('alice', 'xp_' + 'b'.repeat(43))) }) },
      { importArchive: async () => json(412, { code: 'PRECONDITION_FAILED', details: { stateChanged: false } }) },
      { streamTransport: async () => ({ status: 200, contentType: 'text/html', body: (async function* () { yield Buffer.from('<html>') })() }) },
    ] as Partial<TransferExecutionDeps>[]) {
      const f = fixture(overrides)
      await f.run()
      expect(f.events.at(-1)).toMatchObject({ phase: 'failed' })
      expect((f.events.at(-1) as { error: string }).error).not.toMatch(/exists on this server/)
      expect(f.calls.some(call => call[0] === 'create')).toBe(false)
    }
  })
  it('reports a created account whose restore was not verified as needing review, never as done', async () => {
    const f = fixture({ verifyArchive: async () => json(200, { verified: false, archiveSha256: sha }) })
    await f.run()
    expect(f.events.at(-1)).toMatchObject({ phase: 'failed', error: expect.stringMatching(/exists on this server, but its restore was not verified/) })
    expect(f.calls.at(-1)).toEqual(['audit', 'transfer.account.failed'])
  })
  it('admits only the API token channel, a stored token and mapped plans', async () => {
    const f = fixture()
    const ssh = { ...session(), auth: { kind: 'ssh-key', host: 'h.example.test', port: 22, user: 'root', keyId: TOKEN_ID, hostKeyFingerprint: 'SHA256:' + 'A'.repeat(43) } } as never
    await expect(f.execution.admit(caller, ssh, buildReview(session()))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(fixture({ readToken: async () => null }).execution.admit(caller, session(), buildReview(session()))).rejects.toMatchObject({ message: expect.stringMatching(/no longer exists/) })
    await expect(fixture({ store: { listAccounts: async () => [], listDomains: async () => [], listPlans: async () => [] } as never }).execution.admit(caller, session(), buildReview(session()))).rejects.toMatchObject({ message: expect.stringMatching(/plan that does not exist/) })
    await expect(f.execution.admit({ principal: { kind: 'reseller' } } as never, session(), buildReview(session()))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(() => fail('VALIDATION', 'x')).toThrow()
  })
})
