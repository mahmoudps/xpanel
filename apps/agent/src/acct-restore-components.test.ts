import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, FeatureList, Plan, Reseller, ServiceUser } from '@xpanel/core'
import { buildTar } from '../../../packages/lifecycle/src/testing/tar.ts'
import { handleComponentRestoreRoute } from './acct-restore-components.ts'
import type { ComponentRestoreRouteDeps } from './acct-restore-components.ts'
import { archivedMessageMailbox, parseComponentRestoreRequest } from './acct-restore-request.ts'
import { JailedFileManager } from './file-manager.ts'
import type { AccountFileContext, AccountFileRequest, AccountFileRunner } from './file-manager.ts'
import type { AgentCallerIdentity } from './server.ts'

// Real tar.gz archives in a temporary store; the confined writer is an in-memory home with the helper's no-overwrite refusal.
const ROOT_ID = '11111111-1111-4111-8111-111111111111', RESELLER_ID = '22222222-2222-4222-8222-222222222222'
const account: Account = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test',
  planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ownerId: RESELLER_ID, status: 'active', suspendReason: null, contactEmail: 'owner@alice.example.test', ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-01-01T00:00:00.000Z' }
const FILE = 'xpanel-backup-alice-20261026T100000Z.tar.gz'
const rootCaller: AgentCallerIdentity = { principalId: ROOT_ID, actor: 'root', role: 'root', accountId: null, resellerId: null }
const resellerCaller: AgentCallerIdentity = { principalId: RESELLER_ID, actor: 'res', role: 'reseller', accountId: null, resellerId: RESELLER_ID }
const user = (login: string, email = true): ServiceUser => ({ id: 'dddddddd-dddd-4ddd-8ddd-' + createHash('sha256').update(login).digest('hex').slice(0, 12), accountId: account.id, login, services: { email, ftp: false, webdisk: false }, mailboxQuotaMb: 'unlimited', ftpDir: 'public_html' })
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) if (basename(root).startsWith('xpanel-component-restore-')) await rm(root, { recursive: true, force: true }) })

class MemoryHome implements AccountFileRunner {
  nodes = new Map<string, { kind: 'directory' } | { kind: 'file'; bytes: Buffer; mode?: number }>([['', { kind: 'directory' }]])
  ops: string[] = []
  file(path: string, content: string): void { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) this.nodes.set(parts.slice(0, i).join('/'), { kind: 'directory' }); this.nodes.set(path, { kind: 'file', bytes: Buffer.from(content) }) }
  async run(_context: Readonly<AccountFileContext>, request: Readonly<AccountFileRequest>): Promise<unknown> {
    const path = 'path' in request ? request.path : ''
    this.ops.push(request.op + ':' + path)
    const parent = (value: string): string => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : ''
    const entry = (value: string) => { const node = this.nodes.get(value)!; return { name: value.split('/').at(-1)!, path: value, kind: node.kind, sizeBytes: node.kind === 'file' ? node.bytes.length : 0, mode: node.kind === 'file' ? node.mode ?? 0o640 : 0o750, mtime: '2026-10-27T00:00:00.000Z' } }
    const directory = (value: string): void => { if (this.nodes.get(value)?.kind !== 'directory') fail('NOT_FOUND', 'no such directory', { errnoName: 'ENOENT' }) }
    if (request.op === 'list') { directory(path); return [...this.nodes.keys()].filter(key => key !== '' && parent(key) === path).map(entry) }
    if (request.op === 'mkdir') { if (this.nodes.has(path)) fail('CONFLICT', 'target exists', { errnoName: 'EEXIST' }); directory(parent(path)); this.nodes.set(path, { kind: 'directory' }); return entry(path) }
    if (request.op === 'put-bytes') {
      directory(parent(path))
      if (this.nodes.has(path) && !request.overwrite) fail('CONFLICT', 'target file already exists', { errnoName: 'EEXIST' })
      this.nodes.set(path, { kind: 'file', bytes: Buffer.from(request.contentBase64, 'base64'), mode: request.mode }); return entry(path)
    }
    if (request.op === 'get-bytes') { const node = this.nodes.get(path); if (node?.kind !== 'file') return fail('NOT_FOUND', 'no such file'); return { path, contentBase64: node.bytes.toString('base64'), sizeBytes: node.bytes.length, mtime: '2026-10-27T00:00:00.000Z' } }
    return fail('VALIDATION', 'unsupported fixture operation')
  }
}

const tree: Parameters<typeof buildTar>[0] = [
  { name: './public_html/index.html', content: '<h1>archived</h1>' },
  { name: './etc/alice.example.test/passwd', content: 'x' },
  { name: './mail/alice.example.test/info/cur/1700000000.M1.host:2,S', content: 'old message', mode: 0o600 },
  { name: './mail/alice.example.test/info/new/1700000001.M2.host', content: 'new message', mode: 0o600 },
  { name: './mail/alice.example.test/info/.Sent/cur/1700000002.M3.host:2,S', content: 'sent message', mode: 0o600 },
  { name: './mail/alice.example.test/info/dovecot.index', content: 'index' },
  { name: './mail/alice.example.test/info/tmp/partial', content: 'tmp' },
  { name: './mail/alice.example.test/gone/cur/1700000003.M4.host:2,', content: 'gone mailbox', mode: 0o600 },
]
const setup = async (input: { users?: ServiceUser[]; acl?: Reseller['acl']; root?: null } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'xpanel-component-restore-')); roots.push(root)
  await mkdir(join(root, account.username), { mode: 0o700 })
  await writeFile(join(root, account.username, FILE), await buildTar(tree, { gzip: true }), { mode: 0o600 })
  const home = new MemoryHome(), audit = vi.fn(async () => undefined)
  const plan = { id: account.planId, featureListId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', resources: { diskMb: 'unlimited' } } as unknown as Plan
  const features = { id: plan.featureListId, name: 'Default', ownerId: null, disabled: [] } as unknown as FeatureList
  const reseller = { id: RESELLER_ID, username: 'res', acl: input.acl ?? ['list-accounts', 'edit-account'] } as Reseller
  const owner = { ...account }
  const deps = (caller: AgentCallerIdentity = rootCaller, files = true): ComponentRestoreRouteDeps => ({
    caller, root: input.root === null ? null : root, audit,
    store: { getAccountByUsername: async name => name === owner.username ? owner : null, withAccountLifecycleLease: async (_id, operation) => operation(owner),
      getPlan: async () => plan, getFeatureList: async () => features, getReseller: async id => id === RESELLER_ID ? reseller : null, listServiceUsers: async () => input.users ?? [user('info@alice.example.test'), user('ftp@alice.example.test', false)] },
    currentPrincipal: async () => ({ kind: caller.role, id: caller.principalId, username: caller.actor, disabled: false }),
    files: (target, assigned) => files ? new JailedFileManager(target.home, assigned.resources.diskMb, { account: target, runner: home }) : null,
  })
  return { home, audit, deps, owner }
}
const call = (deps: ComponentRestoreRouteDeps, op: string, body: unknown, method = 'POST') => {
  const url = new URL('http://agent.local/accounts/alice/backup-components/' + op)
  return handleComponentRestoreRoute(new Request(url, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), url, method, deps)
}
const read = async (response: Response | null): Promise<any> => { expect(response?.status).toBe(200); return response!.json() }
const code = async (promise: Promise<unknown>): Promise<string> => promise.then(() => 'ok', (error: { code?: string }) => error.code ?? 'error')

describe('component restore grammar', () => {
  it('accepts only exact keys, this account archive names and 1 to 50 unique mailboxes', () => {
    expect(parseComponentRestoreRequest('inventory', 'alice', { file: FILE })).toEqual({ op: 'inventory', file: FILE })
    expect(parseComponentRestoreRequest('restore', 'alice', { file: FILE, mailboxes: ['info@alice.example.test'], expectedRevision: 'a'.repeat(64) })).toMatchObject({ op: 'restore', mailboxes: ['info@alice.example.test'] })
    for (const [op, body] of [['inventory', { file: FILE, extra: 1 }], ['inventory', { file: 'xpanel-backup-bob-20261026T100000Z.tar.gz' }], ['preview', { file: FILE, mailboxes: [] }],
      ['preview', { file: FILE, mailboxes: ['a@b.test', 'a@b.test'] }], ['preview', { file: FILE, mailboxes: ['../x@b.test'] }], ['preview', { file: FILE, mailboxes: Array.from({ length: 51 }, (_, i) => `u${i}@b.test`) }],
      ['restore', { file: FILE, mailboxes: ['a@b.test'], expectedRevision: 'nope' }]] as const) expect(() => parseComponentRestoreRequest(op, 'alice', body)).toThrow()
  })
  it('recognizes Maildir message files only', () => {
    expect(archivedMessageMailbox('mail/alice.example.test/info/cur/1:2,S')).toBe('info@alice.example.test')
    expect(archivedMessageMailbox('mail/alice.example.test/info/.Sent/new/2')).toBe('info@alice.example.test')
    for (const path of ['mail/alice.example.test/info/tmp/3', 'mail/alice.example.test/info/dovecot.index', 'mail/alice.example.test/info/.Sent/.Deep/cur/4', 'public_html/mail/x/y/cur/1', 'mail/-bad/info/cur/1']) expect(archivedMessageMailbox(path)).toBeNull()
  })
})

describe('component inventory', () => {
  it('lists components truthfully from the verified archive without writing', async () => {
    const f = await setup()
    const body = await read(await call(f.deps(), 'inventory', { file: FILE }))
    expect(body.archive).toMatchObject({ file: FILE, integrity: 'verified' })
    expect(body.components).toEqual({ files: { state: 'available', files: 1, bytes: 17 }, mailSettings: { state: 'not-restorable', files: 1 }, databases: { state: 'not-in-archive' }, dns: { state: 'not-in-archive' },
      mail: { state: 'available', truncated: false, mailboxes: [{ address: 'gone@alice.example.test', messages: 1, bytes: 12, current: 'missing' }, { address: 'info@alice.example.test', messages: 3, bytes: 34, current: 'exists' }] } })
    expect(f.home.ops).toEqual([])
  })
  it('reports mail unavailable without the confined writer and refuses without host storage', async () => {
    const f = await setup()
    expect((await read(await call(f.deps(rootCaller, false), 'inventory', { file: FILE }))).components.mail.state).toBe('unavailable')
    expect(await code(call((await setup({ root: null })).deps(), 'inventory', { file: FILE }))).toBe('PRECONDITION_FAILED')
  })
  it('denies resellers without ownership or ACL and refuses query selectors and other methods', async () => {
    const f = await setup({ acl: [] })
    expect(await code(call(f.deps(resellerCaller), 'inventory', { file: FILE }))).toBe('FORBIDDEN')
    expect(await code(call((await setup()).deps({ ...resellerCaller, principalId: '33333333-3333-4333-8333-333333333334', resellerId: null }), 'inventory', { file: FILE }))).toBe('FORBIDDEN')
    expect((await call(f.deps(), 'inventory', {}, 'GET'))?.status).toBe(405)
    const url = new URL('http://agent.local/accounts/alice/backup-components/inventory?file=x')
    expect(await code(handleComponentRestoreRoute(new Request(url, { method: 'POST' }), url, 'POST', f.deps()))).toBe('VALIDATION')
  })
})

describe('mailbox restore', () => {
  it('reviews only absent message files of existing mailboxes and refuses a mailbox that no longer exists', async () => {
    const f = await setup()
    f.home.file('mail/alice.example.test/info/cur/1700000000.M1.host:2,S', 'current copy')
    const body = await read(await call(f.deps(), 'preview', { file: FILE, mailboxes: ['info@alice.example.test'] }))
    expect(body.rows.map((row: { path: string }) => row.path)).toEqual(['mail/alice.example.test/info/.Sent/cur/1700000002.M3.host:2,S', 'mail/alice.example.test/info/new/1700000001.M2.host'])
    expect(body.counts).toEqual({ messages: 3, present: 1, batch: 2, remaining: 0, refused: 0 })
    expect(body.writer).toBe('available')
    expect(await code(call(f.deps(), 'preview', { file: FILE, mailboxes: ['gone@alice.example.test'] }))).toBe('PRECONDITION_FAILED')
    expect(await code(call(f.deps(), 'preview', { file: FILE, mailboxes: ['ftp@alice.example.test'] }))).toBe('PRECONDITION_FAILED')
  })
  it('restores the reviewed batch in place, never overwrites, verifies each file and audits', async () => {
    const f = await setup()
    f.home.file('mail/alice.example.test/info/cur/1700000000.M1.host:2,S', 'current copy')
    const reviewed = await read(await call(f.deps(), 'preview', { file: FILE, mailboxes: ['info@alice.example.test'] }))
    const body = await read(await call(f.deps(), 'restore', { file: FILE, mailboxes: ['info@alice.example.test'], expectedRevision: reviewed.revision }))
    expect(body.counts).toEqual({ restored: 2, 'skipped-exists': 0, failed: 0, 'not-attempted': 0 })
    expect(body).toMatchObject({ complete: true, verificationRequired: false, remaining: 0 })
    const stored = f.home.nodes.get('mail/alice.example.test/info/cur/1700000000.M1.host:2,S')
    expect(stored?.kind === 'file' && stored.bytes.toString()).toBe('current copy')
    expect(f.home.nodes.has('mail/alice.example.test/info/new/1700000001.M2.host')).toBe(true)
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'backup.mail_restored', outcome: 'ok', target: 'account:alice' }))
  })
  it('refuses a stale revision and a reseller without edit-account before any write', async () => {
    const f = await setup()
    expect(await code(call(f.deps(), 'restore', { file: FILE, mailboxes: ['info@alice.example.test'], expectedRevision: 'f'.repeat(64) }))).toBe('CONFLICT')
    const limited = await setup({ acl: ['list-accounts'] })
    const reviewed = await read(await call(limited.deps(resellerCaller), 'preview', { file: FILE, mailboxes: ['info@alice.example.test'] }))
    expect(await code(call(limited.deps(resellerCaller), 'restore', { file: FILE, mailboxes: ['info@alice.example.test'], expectedRevision: reviewed.revision }))).toBe('FORBIDDEN')
    expect([...f.home.ops, ...limited.home.ops].filter(op => /^(?:mkdir|put-bytes):/.test(op))).toEqual([])
  })
})
