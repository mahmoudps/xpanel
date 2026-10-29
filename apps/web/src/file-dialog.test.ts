/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
import { renderPanelSurface } from './surfaces/xpanel.ts'
import { FILE_WORKSPACE_CLIENT_BINDING, workspaceEntry, workspaceTrash } from './file-workspace-client.ts'

const plan = { ...defaultPlan({ id: 'file-plan', name: 'Synthetic plan', featureListId: 'file-features' }), shell: 'jailed' as const }
const account: Account = {
  id: 'file-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test',
  planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@alice.example.test',
  ipv4: '192.0.2.21', shell: 'jailed', createdAt: '2026-10-22T14:05:00Z',
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('file manager confirmation dialog', () => {
  afterEach(() => {
    document.body.replaceChildren()
    delete (window as unknown as { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  })

  it('formats size and time, refuses an empty name, and deletes only after confirmation', async () => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, value?: string) {
      this.returnValue = value ?? ''
      this.open = false
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    }
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('should-not-run')
    // The file workspace verifies every write against a re-read, so the fixture keeps server-side state.
    const files = new Map([['note.txt', { name: 'note.txt', path: 'note.txt', kind: 'file', sizeBytes: 2048, mode: 0o640, mtime: '2026-10-22T14:05:09.000Z' }]])
    const request = vi.fn(async (_method: string, _path: string, body: { op?: string; path?: string }) => {
      if (body?.op === 'list') return { entries: [...files.values()] }
      if (body?.op === 'trash') {
        const item = files.get(body.path!)!
        files.delete(item.path)
        return { id: '6f1c3f0e-2b7a-4c1d-9e2f-0a1b2c3d4e5f', originalPath: item.path, name: item.name, sizeBytes: item.sizeBytes, deletedAt: '2026-10-22T14:06:00.000Z' }
      }
      if (body?.op === 'write') {
        const created = { name: body.path!, path: body.path!, kind: 'file', sizeBytes: 0, mode: 0o640, mtime: '2026-10-22T14:07:00.000Z' }
        files.set(created.path, created)
        return created
      }
      if (body?.op === 'read') return { path: body.path!, content: '', sizeBytes: 0, mtime: files.get(body.path!)!.mtime }
      throw { status: 400, stateChanged: false }
    })
    ;(window as unknown as { xpanelSessionRequest: typeof request }).xpanelSessionRequest = request
    document.documentElement.lang = 'en'
    document.documentElement.dataset.realtimeEnabled = 'false'
    document.body.innerHTML = renderPanelSurface({ account, plan, activeRoute: '/files/manager', files: [], locale: 'en' })
    new Function('window', 'document', BROWSER_REALTIME_SCRIPT)(window, document)
    await tick()
    // The file workspace controller reports 1024-based sizes with IEC units.
    expect(document.body.textContent).toContain('2.00 KiB')
    expect(document.body.textContent).toContain('2026-10-22 14:05 UTC')
    expect(prompt).not.toHaveBeenCalled()

    const trashCalls = () => request.mock.calls.filter(call => (call[2] as { op?: string }).op === 'trash')
    const writeCalls = () => request.mock.calls.filter(call => (call[2] as { op?: string }).op === 'write')
    document.querySelector<HTMLButtonElement>('[data-file-manager-table] tbody .xp-btn:last-child')?.click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-xp-prompt]')
    expect(dialog?.hasAttribute('open')).toBe(true)
    dialog?.querySelector<HTMLButtonElement>('[data-xp-prompt-cancel]')?.click()
    await tick()
    expect(trashCalls()).toHaveLength(0)

    document.querySelector<HTMLButtonElement>('[data-file-manager-table] tbody .xp-btn:last-child')?.click()
    dialog?.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    expect(trashCalls()).toHaveLength(1)

    document.querySelector<HTMLButtonElement>('[data-action="new-file"]')?.click()
    const input = document.querySelector<HTMLInputElement>('[data-xp-prompt-input]')
    expect(input).not.toBeNull()
    input!.value = '   '
    dialog?.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    expect(writeCalls()).toHaveLength(0)
    input!.value = 'notes.txt'
    dialog?.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    expect(writeCalls()[0]?.[2]).toMatchObject({ op: 'write', path: 'notes.txt', content: '' })
    expect(prompt).not.toHaveBeenCalled()
  })
})
describe('readable file workspace metadata', () => {
  it.each([
    { locale: 'en', mode: 'browse', evidence: '' }, { locale: 'ar', mode: 'browse', evidence: '' },
    { locale: 'en', mode: 'trash', evidence: '' }, { locale: 'ar', mode: 'trash', evidence: '' },
  ] as const)('renders human UTC file metadata with unchanged machine identity ($locale, $mode)$evidence', async ({ locale, mode }) => {
    const file = { name: 'time-review.txt', path: 'time-review.txt', kind: 'file', sizeBytes: 12345, mode: 0o640, mtime: '2026-10-27T09:01:02.123Z' }
    const trash = { id: '44444444-4444-4444-8444-444444444444', originalPath: 'long-directory-2026/full-time-review.txt', name: 'full-time-review.txt', sizeBytes: 12345, deletedAt: '2026-10-26T18:07:08.987Z' }
    expect(workspaceEntry(file).mtime).toBe(file.mtime); expect(workspaceTrash(trash).deletedAt).toBe(trash.deletedAt)
    const original = JSON.stringify({ file, trash }), rawTime = mode === 'browse' ? file.mtime : trash.deletedAt
    const expected = mode === 'browse' ? '2026-10-27 09:01 UTC' : '2026-10-26 18:07 UTC'
    const request = vi.fn(async (method: string, path: string, body: Record<string, unknown>) => {
      expect(method).toBe('POST'); expect(path).toBe('/api/accounts/alice/files')
      expect(body).toEqual(mode === 'browse' ? { op: 'list', path: '' } : { op: 'list-trash' })
      return JSON.parse(JSON.stringify(mode === 'browse' ? { entries: [file] } : { items: [trash] }))
    })
    const oldLang = document.documentElement.lang, oldDir = document.documentElement.dir
    const listeners: EventListener[] = [], add = window.addEventListener.bind(window)
    const spy = vi.spyOn(window, 'addEventListener').mockImplementation((name, callback, options) => { if (name === 'beforeunload') listeners.push(callback as EventListener); add(name, callback, options) })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
    document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    document.body.innerHTML = renderPanelSurface({ account, plan, activeRoute: mode === 'trash' ? '/files/trash' : '/files/manager', files: [], locale })
    try {
      const confirm = vi.fn(async () => false)
      new Function('return ' + FILE_WORKSPACE_CLIENT_BINDING)()(confirm)
      await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[data-file-status]')!.dataset.state).toBe('read'))
      const row = document.querySelector<HTMLElement>('[data-file-manager-table] tbody tr')!, date = row.querySelector<HTMLTimeElement>('td:nth-child(5) time')
      expect(row.dataset.filePath).toBe(mode === 'browse' ? file.path : trash.originalPath)
      if (mode === 'trash') {
        expect(row.dataset.trashId).toBe(trash.id)
        const restore = row.querySelector<HTMLButtonElement>('[data-file-workspace-action="restore"]')
        expect(restore).not.toBeNull(); expect(restore!.dataset.path).toBe(trash.originalPath); expect(restore!.disabled).toBe(false)
        expect(document.querySelectorAll('[data-file-status]')).toHaveLength(1)
      }
      expect(date).not.toBeNull(); expect(date!.textContent).toBe(expected); expect(date!.dateTime).toBe(rawTime)
      expect(date!.closest('bdi')!.dir).toBe('ltr'); expect(date!.closest('bdi')!.classList.contains('xp-mono')).toBe(true)
      expect(row.querySelector('td:nth-child(5)')!.textContent).not.toContain(rawTime)
      expect(request).toHaveBeenCalledTimes(1); expect(confirm).not.toHaveBeenCalled()
      expect(JSON.stringify({ file, trash })).toBe(original)
    } finally { for (const listener of listeners) window.removeEventListener('beforeunload', listener); spy.mockRestore(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.documentElement.lang = oldLang; document.documentElement.dir = oldDir; document.body.replaceChildren() }
  })
})

describe('real /files/trash route', () => {
  const trashed = { id: '55555555-5555-4555-8555-555555555555', originalPath: 'old-folder/alpha.txt', name: 'alpha.txt', sizeBytes: 15, deletedAt: '2026-10-25T00:00:00.000Z' }
  const mount = (request: (method: string, path: string, body: Record<string, unknown>) => Promise<unknown>, confirm = vi.fn(async (_options?: Record<string, unknown>) => true)) => {
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
    document.body.innerHTML = renderPanelSurface({ account, plan, activeRoute: '/files/trash', files: [], locale: 'en' })
    new Function('return ' + FILE_WORKSPACE_CLIENT_BINDING)()(confirm)
    return { root: document.querySelector<HTMLElement>('[data-file-manager="trash"]')!, status: document.querySelector<HTMLElement>('[data-file-status]')!, confirm }
  }
  afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren() })

  it('reads its rows once mounted, showing loading then the loaded table', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const request = vi.fn(async (_method: string, _path: string, body: Record<string, unknown>) => { expect(body).toEqual({ op: 'list-trash' }); await gate; return { items: [trashed] } })
    const { root, status } = mount(request)
    expect(request).toHaveBeenCalledTimes(1)
    expect(status.dataset.state).toBe('loading'); expect(status.hidden).toBe(false); expect(root.getAttribute('aria-busy')).toBe('true'); expect(root.dataset.fileLoading).toBe('true')
    release()
    await vi.waitFor(() => expect(status.dataset.state).toBe('read'))
    expect(root.getAttribute('aria-busy')).toBe('false'); expect(root.dataset.fileLoading).toBe('false')
    const rows = root.querySelectorAll<HTMLElement>('[data-file-manager-table] tbody tr')
    expect(rows).toHaveLength(1); expect(rows[0]!.dataset.trashId).toBe(trashed.id); expect(rows[0]!.textContent).toContain('old-folder/alpha.txt')
  })

  it('shows the observed empty state and the failed-read state', async () => {
    const empty = mount(vi.fn(async () => ({ items: [] })))
    await vi.waitFor(() => expect(empty.status.dataset.state).toBe('read'))
    const block = empty.root.querySelector<HTMLElement>('[data-trash-empty]')!
    expect(block.hidden).toBe(false); expect(empty.root.querySelector<HTMLElement>('.xp-table-wrap')!.hidden).toBe(true)
    expect(block.querySelector('svg[aria-hidden="true"]')).not.toBeNull(); expect(block.querySelector('h2')!.textContent).toBe('The trash is empty')
    expect(block.querySelector('p')!.textContent).toBe('Files you move to the trash stay here until you restore them or delete them for good.')
    expect(empty.root.querySelectorAll('[data-file-manager-table] tbody tr')).toHaveLength(0)
    document.body.replaceChildren()
    const failed = mount(vi.fn(async () => { throw Object.assign(new Error('synthetic'), { status: 503, details: { stateChanged: false } }) }))
    await vi.waitFor(() => expect(failed.status.dataset.state).toBe('failed'))
    expect(failed.status.getAttribute('role')).toBe('alert'); expect(failed.status.textContent).toBe('Trash metadata could not be read.')
  })

  it('repaints the table from the API after a verified restore', async () => {
    let items = [trashed]
    const request = vi.fn(async (_method: string, _path: string, body: Record<string, unknown>) => {
      if (body.op === 'list-trash') return { items }
      if (body.op === 'restore') { expect(body).toEqual({ op: 'restore', trashId: trashed.id, overwrite: false }); items = []; return { name: 'alpha.txt', path: 'old-folder/alpha.txt', kind: 'file', sizeBytes: 15, mode: 0o640, mtime: '2026-10-25T00:00:00.000Z' } }
      throw new Error('unexpected')
    })
    const { root, status, confirm } = mount(request)
    await vi.waitFor(() => expect(status.dataset.state).toBe('read'))
    root.querySelector<HTMLButtonElement>('[data-file-workspace-action="restore"]')!.click()
    await vi.waitFor(() => expect(status.dataset.state).toBe('saved'))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(root.querySelector('[data-trash-id]')).toBeNull()
    expect(root.querySelector<HTMLElement>('[data-trash-empty]')!.hidden).toBe(false)
  })

  it('keeps the table and hides the empty-state block while items are listed', async () => {
    const { root, status } = mount(vi.fn(async () => ({ items: [trashed] })))
    await vi.waitFor(() => expect(status.dataset.state).toBe('read'))
    expect(root.querySelector<HTMLElement>('[data-trash-empty]')!.hidden).toBe(true); expect(root.querySelector<HTMLElement>('.xp-table-wrap')!.hidden).toBe(false)
    const purge = root.querySelector<HTMLButtonElement>('[data-file-workspace-action="purge"]')!
    expect(purge.textContent).toBe('Delete for good…'); expect(purge.getAttribute('aria-label')).toBe('Delete old-folder/alpha.txt for good'); expect(purge.disabled).toBe(false)
  })

  it('deletes one item for good only after the danger confirmation, pinned to the reviewed revision, then re-reads the rows', async () => {
    let items = [trashed, { ...trashed, id: '66666666-6666-4666-8666-666666666666', originalPath: 'beta.txt', name: 'beta.txt' }]
    const request = vi.fn(async (_method: string, _path: string, body: Record<string, unknown>) => {
      if (body.op === 'list-trash') return { items }
      if (body.op === 'purge-trash') { expect(body).toEqual({ op: 'purge-trash', trashId: trashed.id, originalPath: trashed.originalPath, deletedAt: trashed.deletedAt }); items = items.filter(item => item.id !== trashed.id); return { ...trashed } }
      throw new Error('unexpected')
    })
    const confirm = vi.fn(async (_options?: Record<string, unknown>) => false)
    const { root, status } = mount(request, confirm)
    await vi.waitFor(() => expect(status.dataset.state).toBe('read'))
    const button = () => root.querySelector<HTMLButtonElement>(`[data-trash-id="${trashed.id}"] [data-file-workspace-action="purge"]`)!
    button().click(); await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0]![0]).toMatchObject({ title: 'Delete for good', confirm: 'Delete for good', danger: true })
    expect(String(confirm.mock.calls[0]![0]!.body)).toContain(trashed.originalPath)
    expect(request.mock.calls.filter(call => call[2].op === 'purge-trash')).toHaveLength(0)
    confirm.mockResolvedValue(true)
    button().click()
    await vi.waitFor(() => expect(status.dataset.state).toBe('saved'))
    expect(request.mock.calls.map(call => call[2].op)).toEqual(['list-trash', 'purge-trash', 'list-trash', 'list-trash'])
    expect(root.querySelector(`[data-trash-id="${trashed.id}"]`)).toBeNull(); expect(root.querySelectorAll('[data-trash-id]')).toHaveLength(1)
  })

  it('keeps the row on a definite refusal and locks further changes when the purge is not observed', async () => {
    const refused = mount(vi.fn(async (_method: string, _path: string, body: Record<string, unknown>) => {
      if (body.op === 'list-trash') return { items: [trashed] }
      throw Object.assign(new Error('changed'), { status: 409, details: { stateChanged: false } })
    }))
    await vi.waitFor(() => expect(refused.status.dataset.state).toBe('read'))
    refused.root.querySelector<HTMLButtonElement>('[data-file-workspace-action="purge"]')!.click()
    await vi.waitFor(() => expect(refused.status.dataset.state).toBe('failed'))
    expect(refused.root.querySelector(`[data-trash-id="${trashed.id}"]`)).not.toBeNull(); expect(refused.root.querySelector<HTMLButtonElement>('[data-file-workspace-action="purge"]')!.disabled).toBe(false)
    document.body.replaceChildren()
    const unverified = mount(vi.fn(async (_method: string, _path: string, body: Record<string, unknown>) => body.op === 'list-trash' ? { items: [trashed] } : { ...trashed }))
    await vi.waitFor(() => expect(unverified.status.dataset.state).toBe('read'))
    unverified.root.querySelector<HTMLButtonElement>('[data-file-workspace-action="purge"]')!.click()
    await vi.waitFor(() => expect(unverified.status.dataset.state).toBe('uncertain'))
    expect(unverified.root.querySelector<HTMLButtonElement>('[data-file-workspace-action="purge"]')!.disabled).toBe(true)
    expect(unverified.root.querySelector<HTMLButtonElement>('[data-action="empty-trash"]')!.disabled).toBe(true)
  })
})
