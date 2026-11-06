/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tools } from '@xpanel/catalog'
import type { Account } from '@xpanel/core'
import { FILE_WORKSPACE_CLIENT_BINDING, workspaceRelocateRefusal } from './file-workspace-client.ts'
import { renderPanelSurface } from './surfaces/xpanel.ts'
import { v2Messages } from './themes/v2/messages.ts'
import { renderV2FilesPage } from './themes/v2/pages/xpanel/files/index.ts'
import type { SurfaceAuthority } from './models/theme-surface.ts'

const timestamp = '2026-10-29T12:00:00.000Z'
const account: Account = {
  id: 'relocate-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test',
  planId: 'plan', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@alice.example.test',
  ipv4: '192.0.2.21', shell: 'none', createdAt: '2026-10-22T14:05:00Z',
}
const file = (path: string, kind = 'file') => ({ name: path.split('/').at(-1)!, path, kind, sizeBytes: kind === 'file' ? 2 : 0, mode: kind === 'file' ? 0o640 : 0o750, mtime: timestamp })
type Body = Record<string, unknown>

/** Keeps host state so every acknowledgement can be read back the way the controller verifies it. */
const host = (refuse?: (body: Body) => unknown) => {
  const entries = new Map([['a.txt', file('a.txt')], ['archive', file('archive', 'directory')]])
  const calls: Body[] = []
  const request = vi.fn(async (_method: string, _path: string, body: Body) => {
    calls.push(body)
    if (body.op === 'list') return { entries: [...entries.values()].filter(entry => entry.path.split('/').slice(0, -1).join('/') === body.path) }
    const refusal = refuse?.(body)
    if (refusal) throw refusal
    const source = entries.get(body.path as string)!, moved = { ...source, ...file(body.destination as string, source.kind) }
    if (body.op === 'move') entries.delete(source.path)
    entries.set(moved.path, moved)
    return moved
  })
  return { request, calls, mutations: () => calls.filter(body => body.op !== 'list') }
}

const boot = (html: string, request: ReturnType<typeof host>['request'], answer: string | null = 'archive/b.txt') => {
  document.body.innerHTML = html
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  const ask = vi.fn(async (options: Record<string, unknown>) => options.input ? answer : true)
  new Function('return ' + FILE_WORKSPACE_CLIENT_BINDING)()(ask)
  return { root: document.querySelector<HTMLElement>('[data-file-manager="browse"]')!, ask }
}
const v2 = (canManage = true, authority?: Partial<SurfaceAuthority>) =>
  renderV2FilesPage(v2Messages.translator('en'), { surface: { account, files: [] }, canManage, ...(authority ? { authority: authority as SurfaceAuthority } : {}) })
const status = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-file-status]')!
const action = (name: 'copy' | 'move') => document.querySelector<HTMLButtonElement>(`[data-file-selection-action="${name}"]`)!
const select = (root: HTMLElement, path = 'a.txt') => {
  const input = root.querySelector<HTMLInputElement>(`tr[data-file-path="${path}"] [data-xp-slot="select"]`)!
  input.checked = true
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
const settled = async (root: HTMLElement, state = 'read') => { await vi.waitFor(() => expect(status(root).dataset.state).toBe(state)) }

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  document.body.replaceChildren()
})

describe('file selection Copy and Move handlers', { tags: ['feature'] }, () => {
  it('enables Copy and Move for exactly one selected item and sends the exact move request', async () => {
    const fake = host()
    const { root, ask } = boot(v2(), fake.request)
    await settled(root)
    expect(action('copy').disabled).toBe(true)
    select(root)
    expect([action('copy').disabled, action('move').disabled]).toEqual([false, false])
    select(root, 'archive')
    expect(action('move').disabled).toBe(true)
    root.querySelector<HTMLInputElement>('tr[data-file-path="archive"] [data-xp-slot="select"]')!.checked = false
    root.querySelector('tr[data-file-path="archive"] [data-xp-slot="select"]')!.dispatchEvent(new Event('change', { bubbles: true }))
    action('move').click()
    await settled(root, 'saved')
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ input: true, value: 'a.txt' }))
    expect(fake.mutations()).toEqual([{ op: 'move', path: 'a.txt', destination: 'archive/b.txt' }])
    expect(fake.calls.slice(-3).map(body => [body.op, body.path])).toEqual([['list', 'archive'], ['list', ''], ['list', '']])
    expect(status(root).textContent).toBe('Moved to archive/b.txt. The folder was read back.')
    expect(root.querySelector('tr[data-file-path="a.txt"]')).toBeNull()
  })

  it('copies to a pasted absolute path inside the home and keeps the source', async () => {
    const fake = host()
    const { root } = boot(v2(), fake.request, '/home/alice/a-copy.txt')
    await settled(root)
    select(root)
    action('copy').click()
    await settled(root, 'saved')
    expect(fake.mutations()).toEqual([{ op: 'copy', path: 'a.txt', destination: 'a-copy.txt' }])
    expect([...root.querySelectorAll<HTMLElement>('[data-file-manager-table] tbody tr')].map(row => row.dataset.filePath)).toEqual(['a.txt', 'archive', 'a-copy.txt'])
  })

  it.each([['../outside'], ['a.txt'], ['a.txt/inner'], ['.trash/a.txt']])('refuses destination %j before any request', async answer => {
    const fake = host()
    const { root } = boot(v2(), fake.request, answer)
    await settled(root)
    select(root)
    action('move').click()
    await settled(root, 'failed')
    expect(fake.mutations()).toEqual([])
    expect(status(root).textContent).toContain('Nothing was changed.')
  })

  it('maps a definite refusal by its stable code and keeps further changes available', async () => {
    const fake = host(() => Object.assign(new Error('refused'), { code: 'CONFLICT', status: 409, details: { stateChanged: false } }))
    const { root } = boot(v2(), fake.request)
    await settled(root)
    select(root)
    action('move').click()
    await settled(root, 'failed')
    expect(status(root).textContent).toBe('Something already exists at that path. Nothing was replaced.')
    expect(root.dataset.fileUncertain).toBe('false')
    expect(fake.mutations()).toHaveLength(1)
  })

  it('locks further changes when the outcome is uncertain', async () => {
    const fake = host(() => Object.assign(new Error('unknown'), { code: 'SERVICE_UNAVAILABLE', status: 503, details: { stateChanged: true, verificationRequired: true } }))
    const { root } = boot(v2(), fake.request)
    await settled(root)
    select(root)
    action('copy').click()
    await settled(root, 'uncertain')
    expect(root.dataset.fileUncertain).toBe('true')
    expect(action('copy').disabled).toBe(true)
  })

  it('keeps Copy and Move disabled and unavailable when the page gate is closed', async () => {
    const closed = host()
    boot(v2(false), closed.request)
    expect(closed.request).not.toHaveBeenCalled()
    for (const name of ['copy', 'move'] as const) expect([action(name).disabled, action(name).hasAttribute('data-capability-unavailable')]).toEqual([true, true])
    const unqualified = host()
    const { root, ask } = boot(v2(true, { qualifiedTools: new Set(), presentation: 'live', canManage: true }), unqualified.request)
    await settled(root)
    select(root)
    for (const name of ['copy', 'move'] as const) {
      expect([action(name).disabled, action(name).hasAttribute('data-capability-unavailable')]).toEqual([true, true])
      action(name).disabled = false
      action(name).click()
    }
    await Promise.resolve()
    expect(ask).not.toHaveBeenCalled()
    expect(unqualified.mutations()).toEqual([])
  })
})

describe('classic selection actions gate', { tags: ['unit'] }, () => {
  // The classic surface wraps its native file manager in the approved workspace itself.
  const classic = (verified: boolean) => renderPanelSurface({
    account, activeRoute: '/files/manager', files: [], locale: 'en',
    visibility: { principal: { kind: 'user', id: 'principal', username: account.username, accountId: account.id }, disabledFeatures: new Set() },
    catalog: tools.map(tool => tool.id === 'file-manager' && verified ? { ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } } : tool),
  })
  it('connects Copy and Move only behind the verified file-manager tool; Compress and Extract stay unavailable', () => {
    document.body.innerHTML = classic(true)
    const card = document.querySelector('[data-workspace-section="selection-actions"]')!
    expect([...card.querySelectorAll('button')].map(button => [button.textContent, button.dataset.fileSelectionAction ?? button.dataset.wiring, button.disabled]))
      .toEqual([['Copy', 'copy', true], ['Move', 'move', true], ['Compress', 'soon', true], ['Extract', 'soon', true]])
    document.body.innerHTML = classic(false)
    expect(document.querySelectorAll('[data-file-selection-action]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-workspace-section="selection-actions"] [data-wiring="soon"]')).toHaveLength(4)
  })
})

describe('move and copy refusal copy', { tags: ['unit'] }, () => {
  it('names each stable code and leaves unknown failures to the generic text', () => {
    const coded = (code: string) => workspaceRelocateRefusal(Object.assign(new Error('x'), { code }))
    expect(coded('CONFLICT')).toBe('Something already exists at that path. Nothing was replaced.')
    for (const code of ['VALIDATION', 'FORBIDDEN', 'NOT_FOUND', 'LIMIT_EXCEEDED', 'PRECONDITION_FAILED']) expect(coded(code)).toMatch(/\.$/)
    expect(workspaceRelocateRefusal(new Error('invalid_account_path'))).toBe(coded('VALIDATION'))
    expect(coded('SERVICE_UNAVAILABLE')).toBeNull()
    expect(workspaceRelocateRefusal(null)).toBeNull()
  })
})
