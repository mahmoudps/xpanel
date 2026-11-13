/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { unqualifiedTools as tools } from '@xpanel/catalog'
import type { Account } from '@xpanel/core'
import { FILE_WORKSPACE_CLIENT_BINDING, workspaceArchiveRefusal, workspaceRelocateRefusal } from './file-workspace-client.ts'
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
const host = (refuse?: (body: Body) => unknown, extra: ReturnType<typeof file>[] = []) => {
  const entries = new Map([file('a.txt'), file('archive', 'directory'), ...extra].map(entry => [entry.path, entry]))
  const calls: Body[] = []
  const request = vi.fn(async (_method: string, _path: string, body: Body) => {
    calls.push(body)
    if (body.op === 'list') return { entries: [...entries.values()].filter(entry => entry.path.split('/').slice(0, -1).join('/') === body.path) }
    const refusal = refuse?.(body)
    if (refusal) throw refusal
    if (body.op === 'compress') { const made = file(body.destination as string); entries.set(made.path, made); return made }
    if (body.op === 'extract') { const out = file([body.destination, 'readme.txt'].filter(Boolean).join('/')); entries.set(out.path, out); return { destination: body.destination, entries: 1, bytes: 2 } }
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
const action = (name: 'copy' | 'move' | 'compress' | 'extract') => document.querySelector<HTMLButtonElement>(`[data-file-selection-action="${name}"]`)!
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
    for (const name of ['copy', 'move', 'compress', 'extract'] as const) expect([action(name).disabled, action(name).hasAttribute('data-capability-unavailable')]).toEqual([true, true])
    const unqualified = host()
    const { root, ask } = boot(v2(true, { qualifiedTools: new Set(), presentation: 'live', canManage: true }), unqualified.request)
    await settled(root)
    select(root)
    for (const name of ['copy', 'move', 'compress', 'extract'] as const) {
      expect([action(name).disabled, action(name).hasAttribute('data-capability-unavailable')]).toEqual([true, true])
      action(name).disabled = false
      action(name).click()
    }
    await Promise.resolve()
    expect(ask).not.toHaveBeenCalled()
    expect(unqualified.mutations()).toEqual([])
  })
})

describe('classic selection actions gate', { tags: ['feature'] }, () => {
  // The classic surface wraps its native file manager in the approved workspace itself.
  const classic = (verified: boolean) => renderPanelSurface({
    account, activeRoute: '/files/manager', files: [], locale: 'en',
    visibility: { principal: { kind: 'user', id: 'principal', username: account.username, accountId: account.id }, disabledFeatures: new Set() },
    catalog: tools.map(tool => tool.id === 'file-manager' && verified ? { ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } } : tool),
  })
  it('connects Copy, Move, Compress and Extract only behind the verified file-manager tool', () => {
    document.body.innerHTML = classic(true)
    const card = document.querySelector('[data-workspace-section="selection-actions"]')!
    expect([...card.querySelectorAll('button')].map(button => [button.textContent, button.dataset.fileSelectionAction ?? button.dataset.wiring, button.disabled]))
      .toEqual([['Copy', 'copy', true], ['Move', 'move', true], ['Compress', 'compress', true], ['Extract', 'extract', true]])
    document.body.innerHTML = classic(false)
    expect(document.querySelectorAll('[data-file-selection-action]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-workspace-section="selection-actions"] button')).toHaveLength(0)
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

describe('file selection Compress and Extract handlers', { tags: ['feature'] }, () => {
  const archive = file('site.tar.gz')

  it('enables Compress for one item and Extract only for one archive file, then writes and reads back the named archive', async () => {
    const fake = host(undefined, [archive])
    const { root, ask } = boot(v2(), fake.request, 'a.txt.tar.gz')
    await settled(root)
    select(root)
    expect([action('compress').disabled, action('extract').disabled]).toEqual([false, true])
    root.querySelector<HTMLInputElement>('tr[data-file-path="a.txt"] [data-xp-slot="select"]')!.checked = false
    root.querySelector('tr[data-file-path="a.txt"] [data-xp-slot="select"]')!.dispatchEvent(new Event('change', { bubbles: true }))
    select(root, 'site.tar.gz')
    expect(action('extract').disabled).toBe(false)
    root.querySelector<HTMLInputElement>('tr[data-file-path="site.tar.gz"] [data-xp-slot="select"]')!.checked = false
    root.querySelector('tr[data-file-path="site.tar.gz"] [data-xp-slot="select"]')!.dispatchEvent(new Event('change', { bubbles: true }))
    select(root)
    action('compress').click()
    await settled(root, 'saved')
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ input: true, value: 'a.txt.zip' }))
    expect(fake.mutations()).toEqual([{ op: 'compress', paths: ['a.txt'], destination: 'a.txt.tar.gz' }])
    expect(status(root).textContent).toBe('Compressed into a.txt.tar.gz. The folder was read back.')
  })

  it('compresses every selected item of the folder into one archive while the one-item actions stay disabled', async () => {
    const fake = host(undefined, [archive])
    const { root, ask } = boot(v2(), fake.request, 'bundle.zip')
    await settled(root)
    for (const path of ['a.txt', 'archive', 'site.tar.gz']) select(root, path)
    expect((['copy', 'move', 'compress', 'extract'] as const).map(name => action(name).disabled)).toEqual([true, true, false, true])
    action('compress').click()
    await settled(root, 'saved')
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ input: true, value: 'a.txt.zip', body: expect.stringMatching(/^a\.txt, archive, site\.tar\.gz — /) }))
    expect(fake.mutations()).toEqual([{ op: 'compress', paths: ['a.txt', 'archive', 'site.tar.gz'], destination: 'bundle.zip' }])
    expect(status(root).textContent).toBe('Compressed into bundle.zip. The folder was read back.')
  })

  it('refuses an archive path inside any selected folder before any request', async () => {
    const fake = host()
    const { root } = boot(v2(), fake.request, 'archive/all.zip')
    await settled(root)
    for (const path of ['a.txt', 'archive']) select(root, path)
    action('compress').click()
    await settled(root, 'failed')
    expect(fake.mutations()).toEqual([])
    expect(status(root).textContent).toContain('Nothing was changed.')
  })

  it('extracts into the folder holding the archive by default and reports what the helper wrote', async () => {
    const fake = host(undefined, [archive])
    const { root, ask } = boot(v2(), fake.request, '')
    await settled(root)
    select(root, 'site.tar.gz')
    action('extract').click()
    await settled(root, 'saved')
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ input: true, value: '' }))
    expect(fake.mutations()).toEqual([{ op: 'extract', path: 'site.tar.gz', destination: '' }])
    expect(status(root).textContent).toBe('Extracted 1 item into /home/alice. The folder was read back.')
    expect(root.querySelector('tr[data-file-path="readme.txt"]')).not.toBeNull()
  })

  it('refuses an archive name without a supported ending before any request', async () => {
    const fake = host()
    const { root } = boot(v2(), fake.request, 'a.rar')
    await settled(root)
    select(root)
    action('compress').click()
    await settled(root, 'failed')
    expect(fake.mutations()).toEqual([])
    expect(status(root).textContent).toBe('End the archive name in .zip, .tar, .tar.gz, .tar.bz2 or .tar.zst. Nothing was changed.')
  })

  it('names a missing format library by its stable reason and keeps further changes available', async () => {
    const fake = host(() => Object.assign(new Error('refused'), { code: 'PRECONDITION_FAILED', status: 412, details: { stateChanged: false, reason: 'archive_format_unavailable' } }), [archive])
    const { root } = boot(v2(), fake.request, 'out')
    await settled(root)
    select(root, 'site.tar.gz')
    action('extract').click()
    await settled(root, 'failed')
    expect(status(root).textContent).toBe('This archive format is not available on this server. Nothing was changed.')
    expect(root.dataset.fileUncertain).toBe('false')
  })
})

describe('compress and extract refusal copy', { tags: ['unit'] }, () => {
  it('names each stable code and reason and leaves unknown failures to the generic text', () => {
    const coded = (code: string, reason?: string) => workspaceArchiveRefusal(Object.assign(new Error('x'), { code, details: { stateChanged: false, ...(reason ? { reason } : {}) } }))
    expect(coded('SERVICE_UNAVAILABLE', 'archive_capacity_busy')).toBe('Other archive work is running on this server. Try again shortly. Nothing was changed.')
    expect(coded('LIMIT_EXCEEDED')).toBe('This exceeds an archive limit: 10000 items, 512 MiB, expanding more than 250 times, or your disk quota. Nothing was changed.')
    for (const code of ['VALIDATION', 'CONFLICT', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_FAILED']) expect(coded(code)).toMatch(/\.$/)
    expect(workspaceArchiveRefusal(new Error('destination_inside_source'))).toBe(coded('VALIDATION'))
    expect(coded('SERVICE_UNAVAILABLE')).toBeNull()
    expect(workspaceArchiveRefusal(null)).toBeNull()
  })
})
