import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, FeatureList, Plan, Reseller } from '@xpanel/core'
import { buildTar } from '../../../packages/lifecycle/src/testing/tar.ts'
import { handleBackupFileRestoreRoute, RESTORE_TIME_BUDGET_MS } from './backup-file-restore.ts'
import type { BackupFileRestoreRouteDeps } from './backup-file-restore.ts'
import { JailedFileManager } from './file-manager.ts'
import type { AccountFileContext, AccountFileRequest, AccountFileRunner } from './file-manager.ts'
import type { AgentCallerIdentity } from './server.ts'

// Real tar.gz archives in a temporary backup store; the confined runner is an in-memory home that
// enforces the helper's documented no-overwrite, parent and quota refusals. Native uid isolation is not qualified here.
const ROOT_ID = '11111111-1111-4111-8111-111111111111', RESELLER_ID = '22222222-2222-4222-8222-222222222222'
const account: Account = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test',
  planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ownerId: RESELLER_ID, status: 'active', suspendReason: null, contactEmail: 'owner@alice.example.test', ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-01-01T00:00:00.000Z' }
const planOf = (diskMb: number | 'unlimited' = 'unlimited') => ({ id: account.planId, featureListId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', resources: { diskMb } }) as unknown as Plan
const FILE = 'xpanel-backup-alice-20261026T100000Z.tar.gz', NEWER = 'xpanel-backup-alice-20261027T090000Z-0123456789ab.tar.gz', BROKEN = 'xpanel-backup-alice-20261026T120000Z.tar.gz'
const FOLDER = 'restored-20261026T100000Z'
const rootCaller: AgentCallerIdentity = { principalId: ROOT_ID, actor: 'root', role: 'root', accountId: null, resellerId: null }
const resellerCaller: AgentCallerIdentity = { principalId: RESELLER_ID, actor: 'res', role: 'reseller', accountId: null, resellerId: RESELLER_ID }
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const child = relative(resolve(tmpdir()), resolve(root))
    if (!child || child === '..' || isAbsolute(child) || child.startsWith('..' + sep) || basename(root).indexOf('xpanel-file-restore-') !== 0) throw new Error('refusing unrelated fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

type Node = { kind: 'directory' } | { kind: 'file'; bytes: Buffer; mode: number }
class MemoryHome implements AccountFileRunner {
  nodes = new Map<string, Node>([['', { kind: 'directory' }]])
  ops: string[] = []
  afterPut?: () => void
  file(path: string, content: string | Buffer, mode = 0o640): void {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) this.nodes.set(parts.slice(0, index).join('/'), { kind: 'directory' })
    this.nodes.set(path, { kind: 'file', bytes: Buffer.from(content), mode })
  }
  text(path: string): string | undefined { const node = this.nodes.get(path); return node?.kind === 'file' ? node.bytes.toString() : undefined }
  async run(context: Readonly<AccountFileContext>, request: Readonly<AccountFileRequest>): Promise<unknown> {
    const path = 'path' in request ? request.path : ''
    this.ops.push(request.op + ':' + path)
    const parent = (value: string): string => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : ''
    const entry = (value: string, node: Node) => ({ name: value.split('/').at(-1)!, path: value, kind: node.kind, sizeBytes: node.kind === 'file' ? node.bytes.length : 0, mode: node.kind === 'file' ? node.mode : 0o750, mtime: '2026-10-27T00:00:00.000Z' })
    const directory = (value: string): void => { const node = this.nodes.get(value); if (!node) return fail('NOT_FOUND', 'no such directory', { errnoName: 'ENOENT' }); if (node.kind !== 'directory') fail('NOT_FOUND', 'not a directory', { errnoName: 'ENOTDIR' }) }
    if (request.op === 'list') { directory(path); return [...this.nodes].filter(([key]) => key !== '' && parent(key) === path).map(([key, node]) => entry(key, node)) }
    if (request.op === 'mkdir') {
      if (this.nodes.has(path)) fail('CONFLICT', 'target exists', { errnoName: 'EEXIST' })
      directory(parent(path)); this.nodes.set(path, { kind: 'directory' }); return entry(path, { kind: 'directory' })
    }
    if (request.op === 'put-bytes') {
      directory(parent(path))
      const existing = this.nodes.get(path), bytes = Buffer.from(request.contentBase64, 'base64')
      if (existing?.kind === 'directory') fail('CONFLICT', 'target path is a directory', { errnoName: 'EISDIR' })
      if (existing && !request.overwrite) fail('CONFLICT', 'target file already exists', { errnoName: 'EEXIST' })
      const used = [...this.nodes.values()].reduce((sum, node) => sum + (node.kind === 'file' ? node.bytes.length : 0), 0)
      if (context.diskQuotaMb !== 'unlimited' && used + bytes.length > context.diskQuotaMb * 1024 * 1024) fail('LIMIT_EXCEEDED', 'disk quota exceeded', { errnoName: 'EDQUOT' })
      const node: Node = { kind: 'file', bytes, mode: request.mode }
      this.nodes.set(path, node); this.afterPut?.()
      return entry(path, node)
    }
    if (request.op === 'get-bytes') {
      const node = this.nodes.get(path)
      if (node?.kind !== 'file') return fail('NOT_FOUND', 'no such file', { errnoName: 'ENOENT' })
      return { path, contentBase64: node.bytes.toString('base64'), sizeBytes: node.bytes.length, mtime: '2026-10-27T00:00:00.000Z' }
    }
    return fail('VALIDATION', 'unsupported fixture operation')
  }
}

const tree: Parameters<typeof buildTar>[0] = [
  { name: './public_html/', type: 'directory' },
  { name: './public_html/index.html', content: '<h1>archived</h1>', mode: 0o644 },
  { name: './public_html/app/config.php', content: '<?php return 1;', mode: 0o600 },
  { name: './notes.txt', content: 'notes', mode: 0o755 },
  { name: './mail/alice.example.test/info/cur/1', content: 'mail', mode: 0o600 },
]
const setup = async (input: { entries?: Parameters<typeof buildTar>[0]; diskMb?: number | 'unlimited'; acl?: Reseller['acl']; disabled?: string[] } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'xpanel-file-restore-')); roots.push(root)
  await mkdir(join(root, account.username), { mode: 0o700 })
  const bytes = await buildTar(input.entries ?? tree, { gzip: true })
  await writeFile(join(root, account.username, FILE), bytes, { mode: 0o600 })
  const home = new MemoryHome(), audit = vi.fn(async () => undefined)
  const principal = { current: { kind: 'root', id: ROOT_ID, username: 'root', disabled: false } as { kind: string; id: string; username: string; disabled: boolean } | null }
  const plan = planOf(input.diskMb), features = { id: plan.featureListId, name: 'Default', ownerId: null, disabled: input.disabled ?? [] } as FeatureList
  const reseller = { id: RESELLER_ID, username: 'res', acl: input.acl ?? ['list-accounts', 'edit-account'] } as Reseller
  const deps = (caller: AgentCallerIdentity = rootCaller, extra: Partial<BackupFileRestoreRouteDeps> = {}): BackupFileRestoreRouteDeps => ({
    caller, root, audit,
    store: { getAccountByUsername: async username => username === account.username ? account : null, withAccountLifecycleLease: async (_id, operation) => operation(account),
      getPlan: async () => plan, getFeatureList: async () => features, getReseller: async id => id === RESELLER_ID ? reseller : null },
    currentPrincipal: async () => principal.current,
    files: (target, assigned) => new JailedFileManager(target.home, assigned.resources.diskMb, { account: target, runner: home }),
    ...extra,
  })
  return { root, bytes, home, audit, principal, deps }
}
const call = (deps: BackupFileRestoreRouteDeps, suffix = '', body?: unknown, method = body === undefined ? 'GET' : 'POST', search = '') => {
  const url = new URL('http://agent.local/accounts/alice/backup-files' + suffix + search)
  return handleBackupFileRestoreRoute(new Request(url, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, method, deps)
}
const read = async (response: Response | null): Promise<any> => { expect(response?.status).toBe(200); return response!.json() }
const preview = async (deps: BackupFileRestoreRouteDeps, paths: string[], destination = 'new-folder') => read(await call(deps, '/preview', { file: FILE, paths, destination }))
const restore = async (deps: BackupFileRestoreRouteDeps, paths: string[], destination = 'new-folder') => {
  const reviewed = await preview(deps, paths, destination)
  return read(await call(deps, '/restore', { file: FILE, paths, destination, expectedRevision: reviewed.revision }))
}
const writes = (home: MemoryHome): string[] => home.ops.filter(op => /^(?:mkdir|put-bytes):/.test(op))

describe('backup archive listing and browsing', () => {
  it('lists the server store newest first with a cheap integrity precheck', async () => {
    const f = await setup()
    await writeFile(join(f.root, 'alice', NEWER), await buildTar([{ name: 'a.txt', content: 'a' }], { gzip: true }), { mode: 0o600 })
    await writeFile(join(f.root, 'alice', BROKEN), 'not gzip', { mode: 0o600 })
    await writeFile(join(f.root, 'alice', 'unrelated.txt'), 'x')
    const body = await read(await call(f.deps()))
    expect(body.context).toEqual({ accountId: account.id, username: 'alice' })
    expect(body.archives.map((item: { file: string }) => item.file)).toEqual([NEWER, BROKEN, FILE])
    expect(body.archives[0]).toMatchObject({ integrity: 'unverified', reason: null, createdAt: '2026-10-27T09:00:00Z' })
    expect(body.archives[1]).toMatchObject({ integrity: 'rejected', reason: 'format' })
    expect(body).toMatchObject({ total: 3, truncated: false })
  })
  it('verifies every archive member and returns home-relative files without extracting', async () => {
    const f = await setup()
    const body = await read(await call(f.deps(), '/browse', { file: FILE }))
    expect(body.archive).toMatchObject({ file: FILE, bytes: f.bytes.length, sha256: digest(f.bytes), integrity: 'verified', createdAt: '2026-10-26T10:00:00Z' })
    expect(body.folder).toBe(FOLDER)
    expect(body.entries.map((entry: { path: string }) => entry.path)).toEqual(['mail/alice.example.test/info/cur/1', 'notes.txt', 'public_html/app/config.php', 'public_html/index.html'])
    expect(f.home.ops).toEqual([])
  })
  it('reports an archive with links or unsafe members as rejected', async () => {
    const f = await setup({ entries: [{ name: 'public_html/index.html', content: 'x' }, { name: 'link', type: 'symlink', linkname: '/etc/passwd' }] })
    expect(await read(await call(f.deps(), '/browse', { file: FILE }))).toMatchObject({ archive: { file: FILE, integrity: 'rejected', reason: 'unsafe' }, entries: [] })
  })
  it('refuses other accounts\' archive names, missing archives and malformed requests', async () => {
    const f = await setup()
    await expect(call(f.deps(), '/browse', { file: 'xpanel-backup-bob-20261026T100000Z.tar.gz' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(f.deps(), '/browse', { file: '../alice/' + FILE })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(f.deps(), '/browse', { file: NEWER })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call(f.deps(), '/browse', { file: FILE, extra: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(f.deps(), '', undefined, 'GET', '?file=x')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call(f.deps(), '/browse', undefined, 'GET'))?.status).toBe(405)
    expect(await handleBackupFileRestoreRoute(new Request('http://agent.local/accounts/alice/backups'), new URL('http://agent.local/accounts/alice/backups'), 'GET', f.deps())).toBeNull()
    await expect(call({ ...f.deps(), root: null })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})

describe('file restore preview', () => {
  it.each([['../etc/passwd'], ['/etc/passwd'], ['public_html/../notes.txt'], ['public_html/./index.html'], [''], ['public_html//index.html'], ['a\\b'], ['line\nbreak']])('refuses path traversal and malformed selections: %j', async path => {
    const f = await setup()
    await expect(call(f.deps(), '/preview', { file: FILE, paths: [path], destination: 'new-folder' })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(f.home.ops).toEqual([])
  })
  it('refuses a path that is not in the archive', async () => {
    const f = await setup()
    await expect(call(f.deps(), '/preview', { file: FILE, paths: ['public'], destination: 'new-folder' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('expands folders into a new restored-<timestamp> folder and checks it with one confined listing', async () => {
    const f = await setup()
    const body = await preview(f.deps(), ['public_html'])
    expect(body.destination).toEqual({ mode: 'new-folder', folder: FOLDER })
    expect(body.rows).toEqual([
      { path: 'public_html/app/config.php', destination: FOLDER + '/public_html/app/config.php', bytes: 15, action: 'restore', reason: null, exists: 'no' },
      { path: 'public_html/index.html', destination: FOLDER + '/public_html/index.html', bytes: 17, action: 'restore', reason: null, exists: 'no' },
    ])
    expect(body.counts).toEqual({ restore: 2, present: 0, refused: 0 })
    expect(body).toMatchObject({ writer: 'available', quota: { limitMb: 'unlimited', plannedBytes: 32, fits: true }, archive: { integrity: 'verified', sha256: digest(f.bytes) } })
    expect(body.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(f.home.ops).toEqual(['list:'])
  })
  it('in place marks present files, preserves mail and refuses files above the confined write limit', async () => {
    const big = randomBytes(2 * 1024 * 1024 + 1)
    const f = await setup({ entries: [...tree, { name: 'big.bin', content: big }] })
    f.home.file('public_html/index.html', 'current')
    const body = await preview(f.deps(), ['public_html', 'mail', 'big.bin', 'notes.txt'], 'in-place')
    const byPath = Object.fromEntries(body.rows.map((row: { path: string }) => [row.path, row]))
    expect(byPath['public_html/index.html']).toMatchObject({ destination: 'public_html/index.html', action: 'restore', exists: 'yes' })
    expect(byPath['public_html/app/config.php']).toMatchObject({ action: 'restore', exists: 'no' })
    expect(byPath['notes.txt']).toMatchObject({ action: 'restore', exists: 'no' })
    expect(byPath['mail/alice.example.test/info/cur/1']).toMatchObject({ action: 'refuse', reason: 'mail-preserved' })
    expect(byPath['big.bin']).toMatchObject({ action: 'refuse', reason: 'too-large' })
    expect(body.counts).toEqual({ restore: 2, present: 1, refused: 2 })
  })
  it('reports the plan quota and an unavailable writer truthfully', async () => {
    const f = await setup({ entries: [{ name: 'a.bin', content: randomBytes(700 * 1024) }, { name: 'b.bin', content: randomBytes(700 * 1024) }], diskMb: 1 })
    const body = await preview(f.deps(), ['a.bin', 'b.bin'])
    expect(body.quota).toEqual({ limitMb: 1, plannedBytes: 1400 * 1024, fits: false })
    await expect(call(f.deps(), '/restore', { file: FILE, paths: ['a.bin', 'b.bin'], destination: 'new-folder', expectedRevision: body.revision })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    const unavailable = await preview(f.deps(rootCaller, { files: () => null }), ['a.bin'])
    expect(unavailable).toMatchObject({ writer: 'unavailable', rows: [{ exists: 'unchecked' }] })
    await expect(call(f.deps(rootCaller, { files: () => null }), '/restore', { file: FILE, paths: ['a.bin'], destination: 'new-folder', expectedRevision: unavailable.revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(writes(f.home)).toEqual([])
  })
})

describe('file restore', () => {
  it('writes verified content into the new folder as the account and never overwrites on a second run', async () => {
    const f = await setup()
    const first = await restore(f.deps(), ['public_html', 'notes.txt'])
    expect(first.counts).toEqual({ restored: 3, 'skipped-exists': 0, failed: 0, 'not-attempted': 0 })
    expect(first).toMatchObject({ complete: true, verificationRequired: false, destination: { mode: 'new-folder', folder: FOLDER } })
    expect(f.home.text(FOLDER + '/public_html/index.html')).toBe('<h1>archived</h1>')
    expect(f.home.nodes.get(FOLDER + '/notes.txt')).toMatchObject({ mode: 0o640 })
    expect(f.home.nodes.get(FOLDER + '/public_html/app/config.php')).toMatchObject({ mode: 0o600 })
    f.home.file(FOLDER + '/notes.txt', 'edited after restore')
    const second = await restore(f.deps(), ['public_html', 'notes.txt'])
    expect(second.counts).toEqual({ restored: 0, 'skipped-exists': 3, failed: 0, 'not-attempted': 0 })
    expect(f.home.text(FOLDER + '/notes.txt')).toBe('edited after restore')
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'backup.files_restored', target: 'account:alice', outcome: 'ok', principalId: ROOT_ID }))
  })
  it('in place adds only files that do not exist and leaves current files untouched', async () => {
    const f = await setup()
    f.home.file('public_html/index.html', 'current site')
    const body = await restore(f.deps(), ['public_html'], 'in-place')
    expect(body.results).toEqual([
      { path: 'public_html/app/config.php', destination: 'public_html/app/config.php', bytes: 15, result: 'restored', reason: null, verificationRequired: false },
      { path: 'public_html/index.html', destination: 'public_html/index.html', bytes: 17, result: 'skipped-exists', reason: null, verificationRequired: false },
    ])
    expect(f.home.text('public_html/index.html')).toBe('current site')
    expect(f.home.text('public_html/app/config.php')).toBe('<?php return 1;')
  })
  it('refuses a stale review before any host change', async () => {
    const f = await setup()
    await expect(call(f.deps(), '/restore', { file: FILE, paths: ['notes.txt'], destination: 'new-folder', expectedRevision: '0'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(writes(f.home)).toEqual([])
    expect(f.audit).not.toHaveBeenCalled()
  })
  it('reports a kernel quota refusal per file', async () => {
    const f = await setup({ entries: [{ name: 'a.bin', content: randomBytes(100 * 1024) }, { name: 'b.bin', content: randomBytes(100 * 1024) }], diskMb: 1 })
    f.home.file('existing.bin', randomBytes(900 * 1024))
    const body = await restore(f.deps(), ['a.bin', 'b.bin'])
    expect(body.results.map((row: { result: string; reason: string | null }) => [row.result, row.reason])).toEqual([['restored', null], ['failed', 'quota']])
    expect(body.counts.failed).toBe(1)
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }))
  })
  it('marks a write with no proven outcome as requiring verification', async () => {
    const f = await setup()
    const run = f.home.run.bind(f.home)
    f.home.run = async (context, request) => request.op === 'put-bytes' ? Promise.reject(new Error('helper crashed')) : run(context, request)
    const body = await restore(f.deps(), ['notes.txt'])
    expect(body.results).toEqual([{ path: 'notes.txt', destination: FOLDER + '/notes.txt', bytes: 5, result: 'failed', reason: 'write-unknown', verificationRequired: true }])
    expect(body.verificationRequired).toBe(true)
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', detail: expect.objectContaining({ verificationRequired: true }) }))
  })
  it('stops starting files after the time budget and reports the rest as not attempted', async () => {
    const f = await setup()
    let clock = 0
    const deps = f.deps(rootCaller, { now: () => clock })
    const reviewed = await preview(deps, ['public_html', 'notes.txt'])
    f.home.afterPut = () => { clock = RESTORE_TIME_BUDGET_MS + 1 }
    const body = await read(await call(deps, '/restore', { file: FILE, paths: ['public_html', 'notes.txt'], destination: 'new-folder', expectedRevision: reviewed.revision }))
    expect(body.counts).toEqual({ restored: 1, 'skipped-exists': 0, failed: 0, 'not-attempted': 2 })
    expect(body.complete).toBe(false)
    expect(body.results.filter((row: { result: string }) => row.result === 'not-attempted').every((row: { reason: string }) => row.reason === 'time-budget')).toBe(true)
  })
})

describe('file restore authorization', () => {
  it('lets a reseller read its own account but requires edit-account to restore', async () => {
    const f = await setup({ acl: ['list-accounts'] })
    f.principal.current = { kind: 'reseller', id: RESELLER_ID, username: 'res', disabled: false }
    const deps = f.deps(resellerCaller)
    const reviewed = await preview(deps, ['notes.txt'])
    await expect(call(deps, '/restore', { file: FILE, paths: ['notes.txt'], destination: 'new-folder', expectedRevision: reviewed.revision })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(writes(f.home)).toEqual([])
  })
  it('restores for a reseller that owns the account and holds edit-account', async () => {
    const f = await setup()
    f.principal.current = { kind: 'reseller', id: RESELLER_ID, username: 'res', disabled: false }
    expect((await restore(f.deps(resellerCaller), ['notes.txt'])).counts.restored).toBe(1)
  })
  it('refuses other resellers, account users, disabled principals and plans without file restore', async () => {
    const other: AgentCallerIdentity = { principalId: '33333333-3333-4333-8333-333333333333', actor: 'other', role: 'reseller', accountId: null, resellerId: '33333333-3333-4333-8333-333333333333' }
    const f = await setup({ disabled: ['file-restore'] })
    f.principal.current = { kind: 'reseller', id: other.principalId, username: 'other', disabled: false }
    await expect(call(f.deps(other))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(f.deps({ principalId: account.id, actor: 'alice', role: 'user', accountId: account.id, resellerId: null }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    f.principal.current = { kind: 'reseller', id: RESELLER_ID, username: 'res', disabled: false }
    await expect(call(f.deps(resellerCaller))).rejects.toMatchObject({ code: 'FORBIDDEN', message: /disabled by the account plan/ })
    f.principal.current = { kind: 'root', id: ROOT_ID, username: 'root', disabled: true }
    await expect(call(f.deps())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    f.principal.current = { kind: 'root', id: ROOT_ID, username: 'root', disabled: false }
    expect((await read(await call(f.deps()))).archives).toHaveLength(1)
  })
  it('stops a restore when authority is revoked before the first write', async () => {
    const f = await setup()
    const reviewed = await preview(f.deps(), ['notes.txt'])
    let reads = 0
    const deps = f.deps(rootCaller, { currentPrincipal: async () => ++reads > 1 ? null : { kind: 'root', id: ROOT_ID, username: 'root', disabled: false } })
    await expect(call(deps, '/restore', { file: FILE, paths: ['notes.txt'], destination: 'new-folder', expectedRevision: reviewed.revision })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(writes(f.home)).toEqual([])
  })
})
