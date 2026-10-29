// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_GIT_CLIENT_BINDING, readGitClientView } from './account-git-client.ts'
import { renderAccountGitWorkspace } from './board-port/account-git-workspace.ts'

const accountId = '11111111-1111-4111-8111-111111111111', hash = 'a'.repeat(40)
const view = (op = 'list') => ({ context: { accountId, username: 'alice' }, revision: 'a'.repeat(64), repositories: ['repo'], nativeAvailable: true, selected: op === 'list' ? null : { path: 'repo', branch: 'main', head: hash, dirty: false, changedFiles: 0, remote: 'https://example.com/site.git', branches: [{ name: 'main', hash, current: true }], commits: [{ hash, at: '2026-10-27T00:00:00+00:00', subject: '<img src=x> release ١' }] }, application: { op, state: ['list', 'inspect'].includes(op) ? 'read' : 'verified', verificationRequired: false } })
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })
async function bind(request: (method: string, path: string, body?: unknown) => Promise<unknown>, canManage = true, confirm: unknown = async () => true) {
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = renderAccountGitWorkspace({ lang: 'en', accountId, canManage })
  ;(new Function('return ' + ACCOUNT_GIT_CLIENT_BINDING)() as (ask: unknown) => void)(confirm)
  await settle(); await settle()
}
describe('Git account page and controller', () => {
  it('preserves all bilingual controls, technical isolation and truthful unavailable deployment', () => {
    for (const lang of ['en', 'ar'] as const) {
      const html = renderAccountGitWorkspace({ lang, accountId, canManage: true })
      expect(html).toContain(`dir="${lang === 'ar' ? 'rtl' : 'ltr'}"`); expect(html).not.toMatch(/[٠-٩۰-۹]/)
      for (const name of ['repository', 'branch', 'clone', 'init', 'pull', 'checkout', 'history', 'status']) expect(html).toContain('data-git-' + name)
      expect(html).toContain('<bdi dir="ltr" data-git-selected>'); expect(html).toContain('id="git-deployment"')
    }
    expect(ACCOUNT_GIT_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('keeps denied surfaces inert and the permanently unavailable Deploy control disabled after reads', async () => {
    const request = vi.fn(async () => view()); await bind(request, false)
    expect(request).not.toHaveBeenCalled(); expect([...document.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true)
    await bind(request); expect(request).toHaveBeenCalledTimes(1)
    expect($<HTMLButtonElement>('[aria-labelledby="git-deployment"] button').disabled).toBe(true)
    expect($<HTMLInputElement>('[data-git-path]').disabled).toBe(false)
  })
  it('reads details with safe text nodes and posts the captured revision and HEAD only after confirmation', async () => {
    const confirmation = vi.fn(async () => true), request = vi.fn(async (_method: string, _path: string, body?: unknown) => view(body ? (body as { op: string }).op : 'list'))
    await bind(request, true, confirmation); $<HTMLButtonElement>('[data-git-inspect]').click(); await settle(); await settle()
    expect($('[data-git-history]').textContent).toContain('<img src=x> release 1'); expect(document.querySelector('[data-git-history] img')).toBeNull()
    $<HTMLButtonElement>('[data-git-pull]').click(); await settle(); await settle(); await settle()
    expect(confirmation).toHaveBeenCalledOnce(); expect(request.mock.calls.at(-1)).toEqual(['POST', '/api/account/git', { op: 'pull', path: 'repo', expectedRevision: 'a'.repeat(64), expectedHead: hash }])
    expect($<HTMLInputElement>('[data-git-path]').disabled).toBe(false)
  })
  it('locks mutations on an uncertain reply, permits refresh and never retries automatically', async () => {
    const request = vi.fn(async (_method: string, _path: string, body?: unknown) => { const op = body ? (body as { op: string }).op : 'list'; if (op === 'pull') throw Object.assign(new Error('lost'), { details: { stateChanged: true, verificationRequired: true } }); return view(op) })
    await bind(request); $<HTMLButtonElement>('[data-git-inspect]').click(); await settle(); await settle(); $<HTMLButtonElement>('[data-git-pull]').click(); await settle(); await settle(); await settle()
    expect(request).toHaveBeenCalledTimes(3); expect($<HTMLButtonElement>('[data-git-pull]').disabled).toBe(true); expect($<HTMLButtonElement>('[data-git-refresh]').disabled).toBe(false)
    expect($('[data-git-status]').textContent).toContain('needs review')
  })
  it('independently refuses foreign, malformed and incoherent acknowledgements', () => {
    const valid = view('inspect'), selected = valid.selected!
    for (const raw of [{ ...valid, context: { accountId: 'foreign' } }, { ...valid, details: { verificationRequired: true } }, { ...valid, selected: { ...selected, branch: '--config' } }, { ...valid, selected: { ...selected, remote: 'https://user:secret@example.com/repo' } }, { ...valid, selected: { ...selected, branches: [] } }, { ...valid, selected: { ...selected, commits: [{ ...selected.commits[0], hash: 'b'.repeat(40) }] } }]) expect(() => readGitClientView(raw, accountId, { op: 'inspect', path: 'repo' })).toThrow()
  })
})

describe('readable Git commit date metadata', () => {
  it.each(['en', 'ar'] as const)('renders readable commit dates without changing commit or request identity in %s', async locale => {
    const storedAt = '2026-10-27T11:31:02.123456+02:30', subject = '<img src=x> release 1 at 2025-10-26T10:00:00Z'
    const listed = view(), inspected = view('inspect')
    inspected.selected!.commits[0]!.at = storedAt; inspected.selected!.commits[0]!.subject = subject; inspected.selected!.dirty = true; inspected.selected!.changedFiles = 3
    const original = JSON.stringify({ listed, inspected })
    expect(readGitClientView(inspected, accountId, { op: 'inspect', path: 'repo' }).selected!.commits[0]!.at).toBe(storedAt)
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path === '/api/account/git' && body === undefined) return JSON.parse(JSON.stringify(listed))
      if (method === 'POST' && path === '/api/account/git' && JSON.stringify(body) === JSON.stringify({ op: 'inspect', path: 'repo' })) return JSON.parse(JSON.stringify(inspected))
      throw new Error('unexpected_git_operation')
    })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
    document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    document.body.innerHTML = renderAccountGitWorkspace({ lang: locale, accountId, canManage: true })
    const confirmation = vi.fn(async () => false)
    ;(new Function('return ' + ACCOUNT_GIT_CLIENT_BINDING)() as (ask: typeof confirmation) => void)(confirmation)
    await vi.waitFor(() => expect($('[data-git-status]').getAttribute('data-state')).toBe('read'))
    $<HTMLButtonElement>('[data-git-inspect]').click()
    await vi.waitFor(() => expect($('[data-git-status]').getAttribute('data-state')).toBe('read'))
    const history = $('[data-git-history]'), cells = history.querySelectorAll('tr td'), time = cells[1]!.querySelector<HTMLTimeElement>('time')
    expect(cells).toHaveLength(3)
    expect(cells[0]!.textContent).toBe(hash)
    expect(cells[2]!.textContent).toBe(subject)
    expect(history.querySelector('img')).toBeNull()
    expect(time).not.toBeNull()
    expect(time!.textContent).toBe('2026-10-27 09:01 UTC')
    expect(time!.getAttribute('datetime')).toBe(storedAt)
    expect(time!.closest('bdi')!.dir).toBe('ltr')
    expect($('[data-git-tree]').textContent).toBe(locale === 'ar' ? '3 ملفات معدلة' : '3 changed files')
    expect(cells[1]!.textContent).not.toContain(storedAt)
    expect($<HTMLButtonElement>('[aria-labelledby="git-deployment"] button').disabled).toBe(true)
    expect(request.mock.calls).toEqual([['GET', '/api/account/git', undefined], ['POST', '/api/account/git', { op: 'inspect', path: 'repo' }]])
    expect(confirmation).not.toHaveBeenCalled()
    expect(inspected.selected!.head).toBe(hash)
    expect(inspected.revision).toBe('a'.repeat(64))
    expect(JSON.stringify({ listed, inspected })).toBe(original)
  })
})
