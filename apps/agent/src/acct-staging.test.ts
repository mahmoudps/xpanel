import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import { handleStagingRoute, stagingDiff, stagingSource } from './acct-staging.ts'
import type { StagingRouteDeps } from './acct-staging.ts'
import { JailedFileManager } from './file-manager.ts'
import type { AccountFileContext, AccountFileRequest, AccountFileRunner } from './file-manager.ts'
import type { AgentCallerIdentity } from './server.ts'

// In-memory confined home with the helper's documented no-overwrite and trash behavior; native uid isolation is not qualified here.
const account: Account = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test',
  planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@alice.example.test', ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-01-01T00:00:00.000Z' }
const DOMAIN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const domainOf = (extra: Partial<Domain> = {}): Domain => ({ id: DOMAIN_ID, accountId: account.id, name: 'alice.example.test', kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'static', upstream: null, redirect: null,
  php: {} as Domain['php'], wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ...extra })
const owner: AgentCallerIdentity = { principalId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', actor: 'alice', role: 'user', accountId: account.id, resellerId: null }

type Node = { kind: 'directory' } | { kind: 'file'; bytes: Buffer; mode: number }
class MemoryHome implements AccountFileRunner {
  nodes = new Map<string, Node>([['', { kind: 'directory' }]])
  trash = new Map<string, Map<string, Node>>()
  ops: string[] = []
  failPut?: string
  file(path: string, content: string): void { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) this.nodes.set(parts.slice(0, i).join('/'), { kind: 'directory' }); this.nodes.set(path, { kind: 'file', bytes: Buffer.from(content), mode: 0o640 }) }
  text(path: string): string | undefined { const node = this.nodes.get(path); return node?.kind === 'file' ? node.bytes.toString() : undefined }
  async run(_context: Readonly<AccountFileContext>, request: Readonly<AccountFileRequest>): Promise<unknown> {
    const path = 'path' in request ? request.path : ''
    this.ops.push(request.op + ':' + path)
    const parent = (value: string): string => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : ''
    const entry = (value: string, node = this.nodes.get(value)!) => ({ name: value.split('/').at(-1)!, path: value, kind: node.kind, sizeBytes: node.kind === 'file' ? node.bytes.length : 0, mode: node.kind === 'file' ? node.mode : 0o750, mtime: '2026-10-27T00:00:00.000Z' })
    const directory = (value: string): void => { if (this.nodes.get(value)?.kind !== 'directory') fail('NOT_FOUND', 'no such directory', { errnoName: 'ENOENT' }) }
    if (request.op === 'list') { directory(path); return [...this.nodes.keys()].filter(key => key !== '' && parent(key) === path).map(key => entry(key)) }
    if (request.op === 'mkdir') { if (this.nodes.has(path)) fail('CONFLICT', 'target exists', { errnoName: 'EEXIST' }); directory(parent(path)); this.nodes.set(path, { kind: 'directory' }); return entry(path) }
    if (request.op === 'put-bytes') {
      directory(parent(path))
      if (this.failPut === path) fail('LIMIT_EXCEEDED', 'disk quota exceeded', { errnoName: 'EDQUOT' })
      if (this.nodes.has(path) && !request.overwrite) fail('CONFLICT', 'target file already exists', { errnoName: 'EEXIST' })
      this.nodes.set(path, { kind: 'file', bytes: Buffer.from(request.contentBase64, 'base64'), mode: request.mode }); return entry(path)
    }
    if (request.op === 'get-bytes') { const node = this.nodes.get(path); if (node?.kind !== 'file') return fail('NOT_FOUND', 'no such file'); return { path, contentBase64: node.bytes.toString('base64'), sizeBytes: node.bytes.length, mtime: '2026-10-27T00:00:00.000Z' } }
    if (request.op === 'trash') {
      const moved = new Map([...this.nodes].filter(([key]) => key === path || key.startsWith(path + '/')))
      if (!moved.size) return fail('NOT_FOUND', 'no such path')
      const id = randomUUID(); this.trash.set(id, moved); for (const key of moved.keys()) this.nodes.delete(key)
      return { id, originalPath: path, name: path.split('/').at(-1)!, sizeBytes: 0, deletedAt: '2026-10-28T00:00:00.000Z' }
    }
    if (request.op === 'restore') { const moved = this.trash.get(request.trashId)!; for (const [key, node] of moved) this.nodes.set(key, node); this.trash.delete(request.trashId); const first = [...moved.keys()][0]!; return entry(first) }
    return fail('VALIDATION', 'unsupported fixture operation')
  }
}

const setup = (input: { domains?: Domain[]; disabled?: string[]; files?: boolean } = {}) => {
  const home = new MemoryHome(), audit = vi.fn(async () => undefined)
  home.file('public_html/index.html', '<h1>live</h1>'); home.file('public_html/css/site.css', 'body{}'); home.file('public_html/.htaccess', 'Options -Indexes')
  const plan = { id: account.planId, featureListId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', resources: { diskMb: 'unlimited' } } as unknown as Plan
  const features = { id: plan.featureListId, name: 'Default', ownerId: null, disabled: input.disabled ?? [] } as unknown as FeatureList
  const principal = { current: { kind: 'user', id: owner.principalId, username: 'alice', accountId: account.id, disabled: false } as Awaited<ReturnType<StagingRouteDeps['currentPrincipal']>> }
  const deps = (caller: AgentCallerIdentity = owner): StagingRouteDeps => ({
    caller, audit, currentPrincipal: async () => principal.current,
    store: { getAccount: async id => id === account.id ? account : null, getPlan: async () => plan, getFeatureList: async () => features, listDomains: async () => input.domains ?? [domainOf()], withAccountLifecycleLease: async (_id, operation) => operation(account) },
    files: (target, assigned) => input.files === false ? null : new JailedFileManager(target.home, assigned.resources.diskMb, { account: target, runner: home }),
  })
  return { home, audit, principal, deps }
}
const call = (deps: StagingRouteDeps, op?: string, body: unknown = {}, user = 'alice') => {
  const url = new URL(`http://agent.local/accounts/${user}/staging/${DOMAIN_ID}${op ? '/' + op : ''}`), method = op ? 'POST' : 'GET'
  return handleStagingRoute(new Request(url, op ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method }), url, method, deps)
}
const read = async (response: Response | null): Promise<any> => { expect(response?.status).toBe(200); return response!.json() }
const code = async (promise: Promise<unknown>): Promise<string> => promise.then(() => 'ok', (error: { code?: string }) => error.code ?? 'error')

describe('staging rules', () => {
  it('derives confined live and staging paths and refuses aliases, redirects and overlaps', () => {
    expect(stagingSource(account, domainOf(), [domainOf()])).toEqual({ live: 'public_html', staging: 'staging/alice.example.test' })
    expect(() => stagingSource(account, domainOf({ kind: 'alias' }), [])).toThrow()
    expect(() => stagingSource(account, domainOf({ redirect: { to: 'https://x.test', code: 301 } }), [])).toThrow()
    expect(() => stagingSource(account, domainOf({ docRoot: '/home/bob/public_html' }), [])).toThrow()
    expect(() => stagingSource(account, domainOf({ docRoot: '/home/alice/../etc' }), [])).toThrow()
    expect(() => stagingSource(account, domainOf(), [domainOf(), domainOf({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', docRoot: '/home/alice/staging' })])).toThrow()
  })
  it('lists added, changed and removed files', () => {
    const file = (path: string, sha256: string) => ({ path, bytes: 1, mode: 0o640, sha256 })
    expect(stagingDiff([file('a', '1'), file('b', '2')], [file('a', '1'), file('b', '3'), file('c', '4')]).map(row => row.change + ':' + row.path)).toEqual(['change:b', 'add:c'])
    expect(stagingDiff([file('a', '1')], [])).toEqual([{ path: 'a', change: 'remove', bytes: 1 }])
  })
})

describe('staging route', () => {
  it('copies the document root into the confined staging folder and verifies each file', async () => {
    const f = setup()
    const body = await read(await call(f.deps(), 'copy'))
    expect(body).toMatchObject({ outcome: 'copied', counts: { files: 3, copied: 3, failed: 0, notAttempted: 0 }, verificationRequired: false, context: { domainId: DOMAIN_ID, domain: 'alice.example.test' } })
    expect(f.home.text('staging/alice.example.test/css/site.css')).toBe('body{}')
    expect(f.home.text('staging/alice.example.test/.htaccess')).toBe('Options -Indexes')
    expect(await code(call(f.deps(), 'copy'))).toBe('CONFLICT')
    expect(await read(await call(f.deps()))).toMatchObject({ live: { path: 'public_html', files: 3, links: 0 }, staging: { path: 'staging/alice.example.test', exists: true, files: 3 } })
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'staging.copied', outcome: 'ok' }))
  })
  it('reviews and promotes with recoverable replacement through the trash', async () => {
    const f = setup()
    await read(await call(f.deps(), 'copy'))
    f.home.file('staging/alice.example.test/index.html', '<h1>new</h1>'); f.home.file('staging/alice.example.test/about.html', 'about'); f.home.nodes.delete('staging/alice.example.test/css/site.css')
    const reviewed = await read(await call(f.deps(), 'review'))
    expect(reviewed.rows.map((row: { change: string; path: string }) => row.change + ':' + row.path)).toEqual(['add:about.html', 'remove:css/site.css', 'change:index.html'])
    const body = await read(await call(f.deps(), 'promote', { expectedRevision: reviewed.revision }))
    expect(body).toMatchObject({ outcome: 'promoted', counts: { applied: 3, failed: 0, 'not-attempted': 0 }, verificationRequired: false })
    expect(f.home.text('public_html/index.html')).toBe('<h1>new</h1>')
    expect(f.home.text('public_html/about.html')).toBe('about')
    expect(f.home.nodes.has('public_html/css/site.css')).toBe(false)
    expect(f.home.trash.size).toBe(2)
    expect(await code(call(f.deps(), 'promote', { expectedRevision: reviewed.revision }))).toBe('CONFLICT')
  })
  it('puts the previous live file back when the replacement cannot be written', async () => {
    const f = setup()
    await read(await call(f.deps(), 'copy'))
    f.home.file('staging/alice.example.test/index.html', '<h1>new</h1>')
    const reviewed = await read(await call(f.deps(), 'review'))
    f.home.failPut = 'public_html/index.html'
    const body = await read(await call(f.deps(), 'promote', { expectedRevision: reviewed.revision }))
    expect(body.results).toEqual([{ path: 'index.html', change: 'change', result: 'failed', trashId: null, verificationRequired: false }])
    expect(f.home.text('public_html/index.html')).toBe('<h1>live</h1>')
  })
  it('discards the staging copy into the account trash', async () => {
    const f = setup()
    await read(await call(f.deps(), 'copy'))
    expect(await read(await call(f.deps(), 'discard'))).toMatchObject({ outcome: 'discarded', verificationRequired: false })
    expect(f.home.nodes.has('staging/alice.example.test')).toBe(false)
    expect(await code(call(f.deps(), 'discard'))).toBe('NOT_FOUND')
  })
  it('refuses other principals, disabled plans, missing writer, extra fields and limits before any write', async () => {
    const f = setup()
    expect(await code(call(f.deps({ ...owner, role: 'root', accountId: null }), 'copy'))).toBe('FORBIDDEN')
    expect(await code(call(f.deps(), 'copy', {}, 'bob'))).toBe('FORBIDDEN')
    expect(await code(call(f.deps(), 'copy', { path: '/etc' }))).toBe('VALIDATION')
    expect(await code(call(setup({ disabled: ['site-staging'] }).deps(), 'copy'))).toBe('FORBIDDEN')
    expect(await code(call(setup({ files: false }).deps(), 'copy'))).toBe('PRECONDITION_FAILED')
    f.principal.current = { ...f.principal.current!, disabled: true }
    expect(await code(call(f.deps(), 'copy'))).toBe('FORBIDDEN')
    const big = setup()
    for (let i = 0; i < 501; i++) big.home.file(`public_html/f${i}.txt`, 'x')
    expect(await code(call(big.deps(), 'copy'))).toBe('LIMIT_EXCEEDED')
    expect([...f.home.ops, ...big.home.ops].filter(op => /^(?:mkdir|put-bytes|trash):/.test(op))).toEqual([])
  })
})
