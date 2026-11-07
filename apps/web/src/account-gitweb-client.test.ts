// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderAccountGitWorkspace } from './board-port/account-git-workspace.ts'
import { ACCOUNT_GITWEB_CLIENT_BINDING, readGitViewResult } from './account-gitweb-client.ts'

const accountId = '11111111-1111-4111-8111-111111111111', hash = 'a'.repeat(40)
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const replies: Record<string, unknown> = {
  log: { view: 'log', commits: [{ hash, parents: [], author: 'Bob', at: '2026-11-07T10:00:00+00:00', refs: ['main', 'tag: v1'], subject: '<img src=x> first' }], hasMore: true },
  refs: { view: 'refs', refs: [{ name: 'main', kind: 'branch', hash, at: null }, { name: 'v1', kind: 'tag', hash, at: null }] },
  commit: { view: 'commit', hash, parents: [], author: 'Bob', email: 'b@x.test', at: '2026-11-07T10:00:00+00:00', committer: 'Bob', committedAt: '2026-11-07T10:00:00+00:00', subject: 'first', body: '', changes: [{ file: 'a.txt', added: 1, removed: 0 }], patch: null },
  tree: { view: 'tree', rev: 'HEAD', dir: '', entries: [{ name: 'src', kind: 'tree', mode: '040000', sizeBytes: null }, { name: 'a.txt', kind: 'blob', mode: '100644', sizeBytes: 3 }] },
  blob: { view: 'blob', rev: 'HEAD', file: 'a.txt', sizeBytes: 3, state: 'text', text: 'one\ntwo' },
  grep: { view: 'grep', rev: 'HEAD', matches: [{ file: 'a.txt', line: 2, text: 'two' }] },
}
const request = vi.fn(async (_method: string, path: string) => replies[new URL(path, 'http://x').searchParams.get('view') ?? '']!)
async function bind(canRead = true) {
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = renderAccountGitWorkspace({ lang: 'en', accountId, canManage: canRead })
  const select = $<HTMLSelectElement>('[data-git-repository]'); select.replaceChildren(new Option('site', 'site')); select.value = 'site'
  ;(new Function('return ' + ACCOUNT_GITWEB_CLIENT_BINDING)() as () => void)()
  await settle()
}
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); request.mockClear() })

describe('Git history browser client', () => {
  it('stays inert without authority', async () => {
    await bind(false); expect($<HTMLButtonElement>('[data-gitweb-log]').disabled).toBe(true); expect($('[data-gitweb-status]').textContent).toContain('unavailable')
  })
  it('lists history with branch markers as text and pages on request', async () => {
    await bind(); $<HTMLButtonElement>('[data-gitweb-log]').click(); await settle()
    expect(request.mock.calls[0]![1]).toBe('/api/account/git/view?view=log&rev=HEAD&path=site')
    expect($('[data-gitweb-log-rows]').textContent).toContain('[main, tag: v1]'); expect(document.querySelector('[data-gitweb-log-rows] img')).toBeNull()
    $<HTMLButtonElement>('[data-gitweb-more]').click(); await settle()
    expect(request.mock.calls[1]![1]).toContain('skip=1'); expect($('[data-gitweb-log-rows]').querySelectorAll('tr')).toHaveLength(2)
  })
  it('opens a commit and states an omitted diff', async () => {
    await bind(); $<HTMLButtonElement>('[data-gitweb-log]').click(); await settle()
    $<HTMLButtonElement>('[data-gitweb-log-rows] button').click(); await settle()
    expect($<HTMLElement>('[data-gitweb-panel="commit"]').hidden).toBe(false); expect($('[data-gitweb-patch]').textContent).toContain('too large')
    expect($('[data-gitweb-changes-rows]').textContent).toContain('+1 -0'); expect($<HTMLElement>('[data-gitweb-patch-download]').hidden).toBe(true)
  })
  it('walks the tree into a file with line numbers and lists refs', async () => {
    await bind(); $<HTMLButtonElement>('[data-gitweb-tree]').click(); await settle()
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-gitweb-tree-rows] button')]; expect(buttons[0]!.textContent).toBe('src/')
    buttons[1]!.click(); await settle()
    expect($('[data-gitweb-blob]').textContent).toBe('1  one\n2  two')
    $<HTMLButtonElement>('[data-gitweb-refs]').click(); await settle()
    expect($('[data-gitweb-refs-rows]').textContent).toContain('v1'); expect($<HTMLSelectElement>('[data-gitweb-rev]').options).toHaveLength(3)
  })
  it('searches commit text and file content', async () => {
    await bind(); $<HTMLInputElement>('[data-gitweb-search-text]').value = 'two'; $<HTMLSelectElement>('[data-gitweb-search-kind]').value = 'author'; $<HTMLButtonElement>('[data-gitweb-search]').click(); await settle()
    expect(request.mock.calls.at(-1)![1]).toContain('search=author&text=two')
    $<HTMLSelectElement>('[data-gitweb-search-kind]').value = 'content'; $<HTMLButtonElement>('[data-gitweb-search]').click(); await settle()
    expect($('[data-gitweb-grep-rows]').textContent).toContain('two')
  })
  it('refuses a mismatched reply', () => { expect(() => readGitViewResult({ view: 'tree', entries: [] }, 'log')).toThrow() })
})
