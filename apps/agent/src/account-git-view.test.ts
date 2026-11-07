import { describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import { buildGitViewCommand, isGitViewCommand } from '../../../packages/os/src/git-view-command.ts'
import type { GitViewOperation } from '../../../packages/os/src/git-view-command.ts'
import { isAccountGitCommand, buildAccountGitCommand } from './account-git-runner.ts'
import { parseGitViewRequest, parseViewCommit, parseViewGrep, parseViewLog, parseViewRefs, parseViewTree, runGitView } from './account-git-view.ts'

const hash = 'a'.repeat(40), other = 'b'.repeat(40)
const account = { username: 'alice', uid: 1001, gid: 1001, home: '/home/alice' } as Account
const params = (query: string) => new URLSearchParams(query)
const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: '' })
const config = 'core.repositoryformatversion\n0\0core.bare\nfalse\0'

describe('Git viewer grammar', () => {
  const operations: GitViewOperation[] = [
    { op: 'view-log', rev: 'main', skip: 0 }, { op: 'view-log', rev: hash, skip: 50, file: 'src/app file.js' }, { op: 'view-log', rev: 'v1.0', skip: 0, search: { kind: 'message', text: 'fix: a b' } },
    { op: 'view-log', rev: 'HEAD', skip: 0, search: { kind: 'pickaxe', text: 'needle' } }, { op: 'view-log', rev: 'HEAD', skip: 0, search: { kind: 'author', text: 'Bob' } }, { op: 'view-refs' }, { op: 'view-commit', hash }, { op: 'view-diff', hash },
    { op: 'view-tree', rev: 'main', dir: '' }, { op: 'view-tree', rev: 'main', dir: 'src/lib' }, { op: 'view-blob', rev: 'main', file: 'a.txt' }, { op: 'view-grep', rev: 'main', text: 'needle' },
  ]
  it('admits exactly what it builds, inside the account jail too', () => {
    for (const operation of operations) {
      expect(isGitViewCommand(buildGitViewCommand(operation)), JSON.stringify(operation)).toBe(true)
      expect(isAccountGitCommand(buildAccountGitCommand(account, 'site', operation, 'debian')), JSON.stringify(operation)).toBe(true)
    }
  })
  it('refuses options, rev syntax and paths that climb out', () => {
    for (const operation of [{ op: 'view-log', rev: '--all', skip: 0 }, { op: 'view-log', rev: 'a..b', skip: 0 }, { op: 'view-log', rev: 'main', skip: -1 }, { op: 'view-tree', rev: 'main', dir: '../x' }, { op: 'view-blob', rev: 'main', file: '/etc/passwd' }, { op: 'view-blob', rev: 'main', file: '-x' }, { op: 'view-grep', rev: 'main', text: '' }, { op: 'view-commit', hash: 'HEAD' }] as GitViewOperation[])
      expect(() => buildGitViewCommand(operation), JSON.stringify(operation)).toThrow()
    const built = buildGitViewCommand({ op: 'view-log', rev: 'main', skip: 0 })
    expect(isGitViewCommand([...built.slice(0, -1), '--output=/tmp/x', 'main'])).toBe(false)
    expect(isGitViewCommand(built.map(item => item === 'log' ? 'push' : item))).toBe(false)
  })
  it('parses viewer selectors strictly', () => {
    expect(parseGitViewRequest(params('view=log&path=site'))).toEqual({ view: 'log', path: 'site', rev: 'HEAD', skip: 0 })
    expect(parseGitViewRequest(params('view=log&path=site&rev=main&skip=50&search=author&text=Bob'))).toMatchObject({ skip: 50, search: { kind: 'author', text: 'Bob' } })
    for (const bad of ['view=log', 'view=push&path=site', 'view=log&path=../x', 'view=log&path=site&search=author', 'view=log&path=site&cmd=x', 'view=tree&path=site&dir=../x', 'view=commit&path=site&hash=HEAD', 'view=log&path=site&rev=a&rev=b'])
      expect(() => parseGitViewRequest(params(bad)), bad).toThrow()
  })
})

describe('Git viewer output', () => {
  it('reads log, refs, tree, commit and grep output', () => {
    expect(parseViewLog(`${hash}\x1f${other}\x1fBob\x1f2026-11-07T10:00:00+00:00\x1fHEAD -> main, tag: v1\x1fFirst <b>\n`)[0]).toEqual({ hash, parents: [other], author: 'Bob', at: '2026-11-07T10:00:00+00:00', refs: ['main', 'tag: v1'], subject: 'First <b>' })
    expect(parseViewRefs(`refs/heads/main\t${hash}\tcommit\t2026-11-07T10:00:00+00:00\nrefs/tags/v1\t${other}\ttag\t\n`).map(ref => [ref.kind, ref.name, ref.at !== null])).toEqual([['branch', 'main', true], ['tag', 'v1', false]])
    expect(parseViewTree([`100644 blob ${hash}     120\ta b.txt`, `040000 tree ${other}       -\tsrc`, ''].join(String.fromCharCode(0))).map(entry => [entry.kind, entry.name, entry.sizeBytes])).toEqual([['tree', 'src', null], ['blob', 'a b.txt', 120]])
    const commit = parseViewCommit(`${hash}\x1f\x1fBob\x1fb@x.test\x1f2026-11-07T10:00:00+00:00\x1fBob\x1f2026-11-07T10:00:00+00:00\x1fSubject\x1fBody line\n\x1e\n\n3\t1\tsrc/a.js\n-\t-\timg.png\n`)
    expect(commit).toMatchObject({ hash, parents: [], subject: 'Subject', body: 'Body line', changes: [{ file: 'src/a.js', added: 3, removed: 1 }, { file: 'img.png', added: null, removed: null }] })
    expect(parseViewGrep('main:src/a.js\x0012:const needle = 1\n')).toEqual([{ file: 'src/a.js', line: 12, text: 'const needle = 1' }])
  })
  it('refuses output it cannot read rather than guessing', () => {
    expect(() => parseViewLog('garbage\n')).toThrow(); expect(() => parseViewTree('garbage\0')).toThrow(); expect(() => parseViewCommit('garbage')).toThrow()
  })
})

describe('Git viewer run', () => {
  const runner = (replies: Record<string, ReturnType<typeof ok>>) => vi.fn(async (_account: Account, _path: string, operation: { op: string }) => replies[operation.op] ?? ok(config))
  it('checks the repository configuration before any view', async () => {
    const run = vi.fn(async () => ok('core.pager\nevil\0'))
    await expect(runGitView(account, { view: 'refs', path: 'site' }, run)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('flags a full page as having more', async () => {
    const line = `${hash}\x1f\x1fBob\x1f2026-11-07T10:00:00+00:00\x1f\x1fS\n`
    expect(await runGitView(account, { view: 'log', path: 'site', rev: 'HEAD', skip: 0 }, runner({ 'view-log': ok(line.repeat(50)) }))).toMatchObject({ hasMore: true })
    expect(await runGitView(account, { view: 'log', path: 'site', rev: 'HEAD', skip: 0 }, runner({ 'view-log': ok(line) }))).toMatchObject({ hasMore: false })
  })
  it('omits a diff over the output bound and never cuts it', async () => {
    const run = vi.fn(async (_account: Account, _path: string, operation: { op: string }) => {
      if (operation.op === 'view-diff') { const error = Object.assign(new Error('too big'), { code: 'PRECONDITION_FAILED', detail: {} }); Object.setPrototypeOf(error, (await import('@xpanel/core')).XpanelError.prototype); throw error }
      return operation.op === 'view-commit' ? ok(`${hash}\x1f\x1fB\x1fb@x.test\x1f2026-11-07T10:00:00+00:00\x1fB\x1f2026-11-07T10:00:00+00:00\x1fS\x1f\x1e\n`) : ok(config)
    })
    expect(await runGitView(account, { view: 'commit', path: 'site', hash }, run)).toMatchObject({ view: 'commit', patch: null })
  })
  it('states a binary or large blob instead of returning its bytes', async () => {
    const tree = (size: number) => ok(`100644 blob ${hash} ${size}\tfile.bin\0`)
    expect(await runGitView(account, { view: 'blob', path: 'site', rev: 'main', file: 'file.bin' }, runner({ 'view-tree': tree(300000) }))).toMatchObject({ state: 'too-large', text: null, sizeBytes: 300000 })
    expect(await runGitView(account, { view: 'blob', path: 'site', rev: 'main', file: 'file.bin' }, runner({ 'view-tree': tree(5), 'view-blob': ok('a\0b') }))).toMatchObject({ state: 'binary', text: null })
    expect(await runGitView(account, { view: 'blob', path: 'site', rev: 'main', file: 'file.bin' }, runner({ 'view-tree': tree(5), 'view-blob': ok('hello') }))).toMatchObject({ state: 'text', text: 'hello' })
    await expect(runGitView(account, { view: 'blob', path: 'site', rev: 'main', file: 'missing' }, runner({ 'view-tree': tree(5) }))).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('reads a grep exit 1 as no match and a real failure as a refusal', async () => {
    const reply = (code: number) => runner({ 'view-grep': { ok: false, code, stdout: '', stderr: '' } })
    expect(await runGitView(account, { view: 'grep', path: 'site', rev: 'main', text: 'x' }, reply(1))).toEqual({ view: 'grep', rev: 'main', matches: [] })
    await expect(runGitView(account, { view: 'grep', path: 'site', rev: 'main', text: 'x' }, reply(128))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
