import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, FeatureList, Plan, Reseller, ServiceUser } from '@xpanel/core'
import { buildTar } from '../../../packages/lifecycle/src/testing/tar.ts'
import { createBackupRunController } from './acct-backup-runs.ts'
import type { BackupRunDeps } from './acct-backup-runs.ts'
import type { BackupCommand } from './backup-low-priority.ts'
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
    expect(body.components).toEqual({ files: { state: 'available', files: 1, bytes: 17 }, mailSettings: { state: 'not-restorable', files: 1 }, databases: { state: 'not-in-archive', databases: [], restores: [] }, dns: { state: 'not-in-archive', zones: [] },
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

describe('part restore', () => {
  const DUMP = 'CREATE TABLE wp_options (id int);', ZONE_NAME = 'alice.example.test'
  const ARCHIVED_ZONE = JSON.stringify({ id: 'old-id', accountId: 'old-account', name: ZONE_NAME, serial: 7, records: [{ id: 'r1', type: 'A', name: '@', value: '192.0.2.7', ttl: 300 }] })
  const dbTree: Parameters<typeof buildTar>[0] = [{ name: './public_html/index.html', content: '<h1>archived</h1>' }, { name: '.xpanel-backup-data/databases/alice_wp.sql', content: DUMP, mode: 0o600 },
    { name: '.xpanel-backup-data/dns/' + ZONE_NAME + '.json', content: ARCHIVED_ZONE, mode: 0o600 }, { name: '.xpanel-backup-data/manifest.json', content: '{}', mode: 0o600 }]
  const dbSetup = async (options: { recorded?: boolean; restore?: boolean; databases?: string[]; zones?: boolean } = {}) => {
    const f = await setup(), bytes = await buildTar(dbTree, { gzip: true }), archiveSha = createHash('sha256').update(bytes).digest('hex')
    const root = (f.deps().root)!
    await writeFile(join(root, account.username, FILE), bytes, { mode: 0o600 })
    const run = { id: '44444444-4444-4444-8444-444444444444', trigger: 'schedule', actor: 'scheduler', startedAt: '2026-10-26T10:00:00.000Z', finishedAt: '2026-10-26T10:05:00.000Z', state: 'succeeded', destinationIds: [], accounts: 1,
      mailIncluded: true, databasesIncluded: true, dnsIncluded: true, control: null, entries: [], retention: [], localDeleted: 0,
      archives: [{ username: 'alice', file: FILE, bytes: bytes.length, sha256: archiveSha, databases: ['alice_wp'], zones: [ZONE_NAME], integrity: 'verified', reason: null, detail: null }] }
    let ledger: unknown = { version: 1, lastScheduledAt: null, runs: options.recorded === false ? [] : [run], recoveries: [], restores: [] }
    const controller = createBackupRunController({ readConfig: async () => ({ destinations: null, schedule: null }), provider: null, listAccounts: async () => [], createBackup: null,
      verifyArchive: async () => { throw new Error('unused') }, readLocalArchive: async () => { throw new Error('unused') }, listLocalArchives: async () => [], deleteLocalArchive: async () => {},
      storeRecovered: async () => 'exists', readLedger: async () => ledger, writeLedger: async value => { ledger = structuredClone(value) } } satisfies BackupRunDeps)
    const restored: { database: string; content: string; sha256: string }[] = []
    const restoreDatabase = vi.fn(async (_account: Account, database: string, inputPath: string, sha256: string) => { restored.push({ database, content: await readFile(inputPath, 'utf8'), sha256 }) })
    const runner = vi.fn(async (command: BackupCommand) => {
      const content = command.argv.at(-1)!.endsWith('.sql') ? DUMP : ARCHIVED_ZONE
      await writeFile(command.stdoutPath!, content, { flag: 'wx' }); return { ok: true, code: 0, stdout: '', stderr: '', stdoutBytes: Buffer.byteLength(content), killed: null }
    })
    let zone = { id: 'zone-1', accountId: account.id, name: ZONE_NAME, serial: 40, records: [] as unknown[] }
    const saveDnsZone = vi.fn(async (next: typeof zone) => { zone = next; return next }), reconcile = vi.fn(async () => {})
    const deps = (caller: AgentCallerIdentity = rootCaller): ComponentRestoreRouteDeps => {
      const base = f.deps(caller)
      return { ...base, store: { ...base.store, listDatabases: async () => (options.databases ?? ['alice_wp']).map(name => ({ name, engine: 'mariadb', trashedAt: null })),
        listDnsZones: async () => options.zones === false ? [] : [zone], getDnsZone: async name => options.zones === false || name !== ZONE_NAME ? null : zone, saveDnsZone },
        backupRuns: controller, restoreDatabase: options.restore === false ? null : restoreDatabase, reconcile, run: runner }
    }
    return { ...f, root, deps, controller, restored, restoreDatabase, runner, archiveSha, saveDnsZone, reconcile, zone: () => zone, ledger: () => ledger }
  }
  const request = (t: { archiveSha: string }, over: Record<string, unknown> = {}) => ({ file: FILE, databases: ['alice_wp'], zones: [], expectedArchiveSha256: t.archiveSha, ...over })
  it('lists the dumps and zones of a ledger-verified server archive apart from home files', async () => {
    const t = await dbSetup()
    const body = await read(await call(t.deps(), 'inventory', { file: FILE }))
    expect(body.components.files).toEqual({ state: 'available', files: 1, bytes: 17 })
    expect(body.components.databases).toEqual({ state: 'available', databases: [{ name: 'alice_wp', bytes: Buffer.byteLength(DUMP), current: 'exists' }], restores: [] })
    expect(body.components.dns).toEqual({ state: 'available', zones: [{ name: ZONE_NAME, bytes: Buffer.byteLength(ARCHIVED_ZONE), current: 'exists' }] })
    expect((await read(await call((await dbSetup({ restore: false })).deps(), 'inventory', { file: FILE }))).components.databases.state).toBe('unavailable')
    expect((await read(await call((await dbSetup({ recorded: false })).deps(), 'inventory', { file: FILE }))).components.dns.state).toBe('unavailable')
    expect((await read(await call((await dbSetup({ databases: [], zones: false })).deps(), 'inventory', { file: FILE }))).components.dns.zones[0].current).toBe('missing')
  })
  it('restores each selected part in the background, checks digests, applies zones once and audits per-item results', async () => {
    const t = await dbSetup()
    const started = await read(await call(t.deps(), 'parts', request(t, { zones: [ZONE_NAME] })))
    expect(started).toMatchObject({ context: { username: 'alice' }, archive: { file: FILE, sha256: t.archiveSha }, state: 'running', databases: ['alice_wp'], zones: [ZONE_NAME] })
    await t.controller.idle()
    expect(t.restored).toEqual([{ database: 'alice_wp', content: DUMP, sha256: createHash('sha256').update(DUMP).digest('hex') }])
    expect(t.runner.mock.calls.map(call => call[0].argv.at(-1))).toEqual(['.xpanel-backup-data/databases/alice_wp.sql', '.xpanel-backup-data/dns/' + ZONE_NAME + '.json'])
    // The archived records return; the zone keeps its current identity and owner, and the serial moves forward.
    expect(t.zone()).toMatchObject({ id: 'zone-1', accountId: account.id, name: ZONE_NAME, serial: 41, records: [{ id: 'r1', value: '192.0.2.7' }] })
    expect(t.reconcile).toHaveBeenCalledTimes(1)
    expect((await t.controller.view()).restores[0]).toMatchObject({ id: started.restoreId, state: 'finished', items: [{ part: 'database', name: 'alice_wp', result: 'restored' }, { part: 'dns', name: ZONE_NAME, result: 'restored' }] })
    expect(t.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'backup.parts_restored', outcome: 'ok', target: 'account:alice', detail: expect.objectContaining({ dnsApplied: true }) }))
    expect((await readdir(join(t.root, 'alice'))).filter(name => name.startsWith('.restore-'))).toEqual([])
    expect((await read(await call(t.deps(), 'inventory', { file: FILE }))).components.databases.restores).toHaveLength(1)
  })
  it('refuses unverified archives, foreign digests, absent or missing parts and resellers without edit-account before any restore', async () => {
    const t = await dbSetup()
    expect(await code(call(t.deps(), 'parts', request(t, { expectedArchiveSha256: 'f'.repeat(64) })))).toBe('CONFLICT')
    expect(await code(call(t.deps(), 'parts', request(t, { databases: ['alice_shop'] })))).toBe('NOT_FOUND')
    expect(await code(call(t.deps(), 'parts', request(t, { databases: ['bob_wp'] })))).toBe('VALIDATION')
    expect(await code(call(t.deps(), 'parts', request(t, { databases: [], zones: [] })))).toBe('VALIDATION')
    const unrecorded = await dbSetup({ recorded: false })
    expect(await code(call(unrecorded.deps(), 'parts', request(unrecorded)))).toBe('CONFLICT')
    const dropped = await dbSetup({ databases: [], zones: false })
    expect(await code(call(dropped.deps(), 'parts', request(dropped)))).toBe('PRECONDITION_FAILED')
    expect(await code(call(dropped.deps(), 'parts', request(dropped, { databases: [], zones: [ZONE_NAME] })))).toBe('PRECONDITION_FAILED')
    expect(await code(call((await dbSetup({ restore: false })).deps(), 'parts', request(t)))).toBe('PRECONDITION_FAILED')
    expect(await code(call(t.deps(resellerCaller), 'parts', request(t)))).toBe('ok')
    await t.controller.idle()
    const limited = await setup({ acl: ['list-accounts'] })
    expect(await code(call({ ...limited.deps(resellerCaller), backupRuns: t.controller, restoreDatabase: t.restoreDatabase }, 'parts', request(t)))).toBe('FORBIDDEN')
    for (const d of [unrecorded, dropped]) { expect(d.restoreDatabase).not.toHaveBeenCalled(); expect(d.saveDnsZone).not.toHaveBeenCalled() }
  })
  it('records a not-attempted item when the archive no longer matches the verified digest', async () => {
    const t = await dbSetup()
    await writeFile(join(t.root, 'alice', FILE), await buildTar([...dbTree, { name: './late.txt', content: 'x' }], { gzip: true }))
    await call(t.deps(), 'parts', request(t))
    await t.controller.idle()
    expect((await t.controller.view()).restores[0]).toMatchObject({ state: 'finished', items: [{ part: 'database', name: 'alice_wp', result: 'not-attempted', reason: 'archive-changed' }] })
    expect(t.restoreDatabase).not.toHaveBeenCalled()
    expect(t.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'backup.parts_restored', outcome: 'failed' }))
  })
})
