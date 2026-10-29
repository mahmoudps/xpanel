import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, Plan } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { ACCOUNT_SSH_PATH, handleAccountSshRoute } from './account-ssh-workspace.ts'
import type { ReadAgent } from './account-ssh-workspace.ts'
import { AUTHORIZED_KEYS_PATH, parseAccountSshRequest, runAccountSshRequest } from '../../agent/src/account-ssh.ts'
import type { AccountSshFiles } from '../../agent/src/account-ssh.ts'
import type { FileText } from '../../agent/src/file-manager.ts'

// The agent side is the actual runAccountSshRequest; only the confined runner and transport are test doubles.
const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const account = { id: ACCOUNT, username: 'alice', status: 'active', shell: 'none', planId: 'plan', uid: 1001, gid: 1001, home: '/home/alice' } as Account
const plan = { id: 'plan', featureListId: 'list', shell: 'jailed' } as Plan
const caller = (kind: 'user' | 'root' | 'reseller', extra: Record<string, unknown> = {}) => ({ principal: { kind, id: 'p-' + kind, username: kind === 'user' ? 'alice' : kind, ...(kind === 'user' ? { accountId: ACCOUNT } : {}) }, apiTokenId: null, scopes: [], principalRecord: { forcePasswordChange: false }, ...extra }) as unknown as AuthenticatedCaller
const ed = (): string => { const x = (generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as { x: string }).x, part = (v: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(v.length); return Buffer.concat([l, v]) }; return 'ssh-ed25519 ' + Buffer.concat([part(Buffer.from('ssh-ed25519')), part(Buffer.from(x, 'base64url'))]).toString('base64') }
const KEY = ed()

function setup(options: { disabled?: string[]; callers?: AuthenticatedCaller[]; reply?: (value: unknown) => unknown } = {}) {
  let file: FileText | null = null, tick = 0
  const files = { list: async () => [{ name: '.ssh', path: '.ssh', kind: 'directory', sizeBytes: 0, mode: 0o700, mtime: new Date(0).toISOString() }], readText: async () => file ? { ...file } : fail('NOT_FOUND', 'missing'),
    writeTextChecked: async (_path: string, content: string | null, expected: FileText | null) => { if (JSON.stringify(expected) !== JSON.stringify(file)) return fail('CONFLICT', 'changed', { stateChanged: false }); file = { path: AUTHORIZED_KEYS_PATH, content: content!, sizeBytes: Buffer.byteLength(content!), mtime: new Date(1700000000000 + ++tick * 1000).toISOString() }; return { name: 'authorized_keys', path: AUTHORIZED_KEYS_PATH, kind: 'file', sizeBytes: file.sizeBytes, mode: 0o600, mtime: file.mtime } },
    mkdir: async () => fail('CONFLICT', 'exists'), chmod: async () => fail('CONFLICT', 'unused') } as unknown as AccountSshFiles
  const readAgent = vi.fn(async (_caller: AuthenticatedCaller, path: string, input?: unknown, _mutation?: boolean, method = input === undefined ? 'GET' : 'POST') => {
    expect(path).toBe('/accounts/alice/ssh/keys')
    const view = await runAccountSshRequest({ account, plan, settings: null, files, request: parseAccountSshRequest(method, input), authorize: async () => undefined })
    return options.reply ? options.reply(view) : view
  })
  const store = { getAccount: async (id: string) => id === ACCOUNT ? account : null, getPlan: async () => plan, getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: options.disabled ?? [] }) } as unknown as StateStore
  const callers = [...(options.callers ?? [])]
  const ports = { store, requireCaller: async () => callers.length ? callers.shift()! : caller('user'), readAgent: readAgent as unknown as ReadAgent }
  const route = (method = 'GET', body?: unknown, search = '') => { const url = new URL('http://panel.test' + ACCOUNT_SSH_PATH + search); return handleAccountSshRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, method, ports) }
  const json = async (method = 'GET', body?: unknown): Promise<Record<string, any>> => (await route(method, body))!.json()
  return { route, json, readAgent, file: () => file }
}

describe('account SSH key workspace', () => {
  it('lists, adds the canonical line and removes by fingerprint for the account owner', async () => {
    const t = setup(), read = await t.json()
    expect(read).toMatchObject({ context: { accountId: ACCOUNT, username: 'alice' }, keys: [], login: { enabled: false, accountShell: 'none', planShell: 'jailed', port: null } })
    const added = await t.json('POST', { expectedRevision: read.file.revision, key: '  ' + KEY + '\tlaptop  ' })
    expect(t.readAgent.mock.calls[1]!.slice(2)).toEqual([{ expectedRevision: read.file.revision, key: KEY + ' laptop' }, true, 'POST'])
    expect(added).toMatchObject({ application: { status: 'added' }, keys: [{ comment: 'laptop' }] }); expect(t.file()!.content).toBe(KEY + ' laptop\n')
    const removed = await t.json('DELETE', { expectedRevision: added.file.revision, fingerprint: added.keys[0].fingerprint })
    expect(removed).toMatchObject({ application: { status: 'removed', removedLines: 1 }, keys: [] }); expect(t.file()!.content).toBe('')
  })
  it('refuses root, reseller, mailbox and disabled-plan callers before any agent request', async () => {
    for (const other of [caller('root'), caller('reseller'), caller('user', { principalKind: 'mailbox' })]) { const t = setup({ callers: [other] }); await expect(t.route()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(t.readAgent).not.toHaveBeenCalled() }
    for (const disabled of [['ssh-access'], ['SSH Access & Terminal']]) { const t = setup({ disabled }); await expect(t.route()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(t.readAgent).not.toHaveBeenCalled() }
    const foreign = setup({ callers: [{ ...caller('user'), principal: { kind: 'user', id: 'p-bob', username: 'bob', accountId: '99999999-9999-4999-8999-999999999999' } } as unknown as AuthenticatedCaller] })
    await expect(foreign.route()).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('validates key grammar and selectors locally, rechecks authority before writing and maps conflicts', async () => {
    const t = setup(), read = await t.json(); t.readAgent.mockClear()
    await expect(t.route('POST', { expectedRevision: read.file.revision, key: 'command="sh" ' + KEY })).rejects.toMatchObject({ code: 'VALIDATION', detail: { fields: [{ code: 'options_refused' }] } })
    await expect(t.route('POST', { expectedRevision: read.file.revision, key: KEY, account: 'bob' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(t.route('GET', undefined, '?account=bob')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(t.readAgent).not.toHaveBeenCalled(); expect((await t.route('PUT'))!.status).toBe(405)
    await expect(t.route('POST', { expectedRevision: 'f'.repeat(64), key: KEY })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    const changed = setup({ callers: [caller('user'), { ...caller('user'), principal: { kind: 'user', id: 'p-other', username: 'alice', accountId: ACCOUNT } } as unknown as AuthenticatedCaller] })
    await expect(changed.route('POST', { expectedRevision: read.file.revision, key: KEY })).rejects.toMatchObject({ code: 'CONFLICT' }); expect(changed.readAgent).not.toHaveBeenCalled()
  })
  it('never reports an unverifiable agent reply as success', async () => {
    const foreign = setup({ reply: view => ({ ...(view as object), context: { accountId: '99999999-9999-4999-8999-999999999999', username: 'bob' } }) })
    await expect(foreign.route()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
    const seen = await setup().json(), lying = setup({ reply: view => ({ ...(view as object), keys: [], capacity: { maxKeys: 100, used: 0 } }) })
    await expect(lying.route('POST', { expectedRevision: seen.file.revision, key: KEY })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, verificationRequired: true } })
    const qualified = setup({ reply: view => ({ ...(view as object), application: { status: 'read', nativeQualified: true } }) })
    await expect(qualified.route()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
})
