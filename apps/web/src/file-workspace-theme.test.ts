// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FILE_WORKSPACE_CLIENT_BINDING } from './file-workspace-client.ts'
import { filePresentation } from './themes/v2/pages/xpanel/files/templates.ts'
import type { Locale, Translate } from './i18n.ts'

const timestamp = '2026-10-29T12:00:00.000Z'
const row = '<tr class="theme-row"><td><input type="checkbox" data-xp-slot="select" disabled></td><td><bdi dir="ltr" data-xp-slot="name"></bdi><span data-xp-slot="kind"></span></td><td><bdi dir="ltr" data-xp-slot="size"></bdi></td><td><time data-xp-slot="modified"></time></td><td><bdi dir="ltr" data-xp-slot="mode"></bdi></td><td><span data-xp-slot="owner"></span></td><td class="theme-actions" data-xp-slot="actions"></td></tr>'
const templates = `<template data-xp-template="file-row">${row}</template><template data-xp-template="trash-row">${row}</template><template data-xp-template="file-action"><button type="button" class="theme-action" data-xp-slot="label"></button></template><template data-xp-template="trash-action"><button type="button" class="theme-restore" data-xp-slot="label"></button></template><template data-xp-template="trash-purge-action"><button type="button" class="theme-purge" data-xp-slot="label"></button></template><template data-xp-template="file-empty-row"><tr class="theme-empty"><td colspan="7" data-xp-slot="message"></td></tr></template><template data-xp-template="file-upload-row"><li><bdi data-xp-slot="name"></bdi><bdi data-xp-slot="bytes"></bdi><span data-xp-slot="state"></span><div data-xp-slot="progress" role="progressbar" hidden></div><button type="button" data-xp-slot="dismiss" data-capability-unavailable="true" disabled></button></li></template>`
const listeners: EventListener[] = []

function mount(mode: 'browse' | 'trash', send: (method: string, path: string, body: Record<string, unknown>) => Promise<unknown>, markup = templates, beforeBoot?: () => void) {
  const locale: Locale = 'en'
  const text: Translate = Object.assign((value: string) => value, { locale })
  const view = filePresentation(text, 'controls') + filePresentation(text, 'details') + (mode === 'browse' ? filePresentation(text, 'closed') + '<div data-file-editor-panel hidden><textarea id="jailed-code-editor"></textarea><button type="button" data-file-editor-close>Close</button></div>' + filePresentation(text, 'uploads') : '')
  document.body.innerHTML = `<section data-file-manager="${mode}" data-account-username="alice" data-account-home="/home/alice"><button type="button" data-action="refresh-files"></button><button type="button" data-action="upload-file">Upload</button><input type="file" data-file-upload><button type="button" data-capability-unavailable disabled>Copy</button><p data-file-status hidden></p><div class="theme-table" data-file-table-wrap><table data-file-manager-table><thead><tr><th><input type="checkbox" data-file-select-all disabled></th>${'<th>Column</th>'.repeat(6)}</tr></thead><tbody></tbody></table></div><div data-trash-empty hidden></div><span data-file-current-path></span><span data-file-selected-path></span>${view}${markup}</section>`
  beforeBoot?.()
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  const original = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, listener, options) => {
    if (name === 'beforeunload') listeners.push(listener as EventListener)
    original(name, listener, options)
  })
  new Function('return ' + FILE_WORKSPACE_CLIENT_BINDING)()(vi.fn(async () => true))
  return document.querySelector<HTMLElement>('[data-file-manager]')!
}

afterEach(() => {
  for (const listener of listeners.splice(0)) window.removeEventListener('beforeunload', listener)
  vi.restoreAllMocks()
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  document.body.replaceChildren()
})

describe('file workspace presentation contract', () => {
  it('preserves theme row, action and technical markup while filling real file facts safely', async () => {
    const request = vi.fn(async (_method: string, _path: string, body: Record<string, unknown>) => {
      expect(body).toEqual({ op: 'list', path: '' })
      return { entries: [{ name: '<note>.txt', path: '<note>.txt', kind: 'file', sizeBytes: 2048, mode: 0o640, mtime: timestamp }] }
    })
    const root = mount('browse', request, templates.replace('data-xp-slot="name"></bdi>', 'data-xp-slot="name"></bdi><bdi dir="ltr" data-xp-slot="path"></bdi>'))
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-file-status]')!.dataset.state).toBe('read'))
    const result = root.querySelector<HTMLElement>('tbody tr')!
    expect(result.className).toBe('theme-row')
    expect(result.dataset.fileKind).toBe('file')
    expect(result.querySelector('[data-xp-slot="name"]')!.textContent).toBe('<note>.txt')
    expect(result.querySelector('[data-xp-slot="path"]')!.textContent).toBe('<note>.txt')
    expect(result.querySelector('note')).toBeNull()
    expect(result.querySelector('[data-xp-slot="size"]')!.textContent).toBe('2.00 KiB')
    expect(result.querySelector('time')!.dateTime).toBe(timestamp)
    expect(result.querySelectorAll('.theme-action')).toHaveLength(4)
    expect(result.querySelector('[class^="xp-"]')).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('uses the theme empty row after an observed empty read', async () => {
    const root = mount('browse', vi.fn(async () => ({ entries: [] })))
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-file-status]')!.dataset.state).toBe('read'))
    expect(root.querySelector('tbody tr')!.className).toBe('theme-empty')
    expect(root.querySelector('tbody')!.textContent).toBe('This directory is empty.')
  })

  it('hides the semantic trash table after verified restore, preserving the theme buttons', async () => {
    const item = { id: '12345678-1234-4234-8234-123456789abc', originalPath: 'note.txt', name: 'note.txt', sizeBytes: 4, deletedAt: timestamp }
    let items = [item]
    const request = vi.fn(async (_method: string, _path: string, body: Record<string, unknown>) => {
      if (body.op === 'list-trash') return { items }
      expect(body).toEqual({ op: 'restore', trashId: item.id, overwrite: false })
      items = []
      return { name: item.name, path: item.originalPath, kind: 'file', sizeBytes: 4, mode: 0o640, mtime: timestamp }
    })
    const root = mount('trash', request)
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-file-status]')!.dataset.state).toBe('read'))
    expect(root.querySelector('[data-file-workspace-action="purge"]')!.className).toBe('theme-purge')
    root.querySelector<HTMLButtonElement>('.theme-restore')!.click()
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-file-status]')!.dataset.state).toBe('saved'))
    expect(root.querySelector<HTMLElement>('[data-file-table-wrap]')!.hidden).toBe(true)
    expect(root.querySelector<HTMLElement>('[data-trash-empty]')!.hidden).toBe(false)
  })

  it.each(['', templates.replace('data-xp-slot="modified"', 'data-missing="modified"'), templates.replace('<time data-xp-slot="modified"></time>', '<span data-xp-slot="modified"></span>'), templates.replace('type="button" class="theme-action"', 'type="submit" class="theme-action"'), templates.replace('data-xp-slot="select"', 'data-missing="select"'), templates.replace('data-xp-slot="owner"', 'data-missing="owner"'), templates.replace('colspan="7"','colspan="6"'), templates.replace('data-xp-slot="dismiss"','data-missing="dismiss"'), templates.replace('role="progressbar" hidden','role="progressbar" aria-valuenow="0" hidden')])('fails closed before network effects when required templates are missing or malformed', markup => {
    const request = vi.fn(async () => ({ entries: [] }))
    const root = mount('browse', request, markup)
    expect(request).not.toHaveBeenCalled()
    expect(root.querySelector<HTMLElement>('[data-file-status]')!.dataset.state).toBe('unavailable')
    expect(root.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
  })
})


describe('observed file selection and upload states', () => {
  const entry = (name = 'alpha.txt') => ({ name, path: name, kind: 'file', sizeBytes: 2, mode: 0o640, mtime: timestamp })
  const settled = async (root: HTMLElement) => { await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-file-status]')!.dataset.state).toBe('read')) }
  const select = (root: HTMLElement, index = 0) => { const input = root.querySelectorAll<HTMLInputElement>('tbody [data-xp-slot="select"]')[index]!; input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })) }

  it('selects, filters and clears observed metadata without reading a file or enabling unavailable actions', async () => {
    const request = vi.fn(async () => ({ entries: [entry(), entry('beta.txt')] }))
    const root = mount('browse', request); await settled(root)
    expect(root.querySelectorAll('tbody tr')[0]!.children).toHaveLength(7)
    expect(root.querySelector('[data-capability-unavailable]')!.hasAttribute('disabled')).toBe(true)
    select(root)
    expect(root.querySelector('[data-file-detail="path"]')!.textContent).toBe('/home/alice/alpha.txt')
    expect(root.querySelector('[data-file-detail="owner"]')!.textContent).toBe('Not read')
    expect(root.querySelector('[data-file-selection-count]')!.textContent).toBe('1')
    const filter = root.querySelector<HTMLInputElement>('[data-file-filter]')!
    filter.value = 'missing'; filter.dispatchEvent(new Event('input', { bubbles: true }))
    expect(root.querySelector('[data-file-selection-count]')!.textContent).toBe('0')
    expect(root.querySelector<HTMLElement>('[data-file-filter-empty]')!.hidden).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('clears selection on an actual refreshed listing even when the path remains present', async () => {
    const request = vi.fn(async () => ({ entries: [entry()] }))
    const root = mount('browse', request); await settled(root); select(root)
    root.querySelector<HTMLButtonElement>('[data-action="refresh-files"]')!.click()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(root.querySelector('[data-file-selection-count]')!.textContent).toBe('0'))
  })

  it('opens the editor only after an actual read and keeps a dirty buffer through close/reopen', async () => {
    const request = vi.fn(async (_m: string, _p: string, body: Record<string, unknown>) => body.op === 'list' ? { entries: [entry()] } : { path: 'alpha.txt', content: 'AB', sizeBytes: 2, mtime: timestamp })
    const root = mount('browse', request); await settled(root); select(root)
    expect(request).toHaveBeenCalledTimes(1)
    expect(root.querySelector<HTMLElement>('[data-file-editor-panel]')!.hidden).toBe(true)
    root.querySelector<HTMLButtonElement>('[data-file-detail-primary]')!.click()
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-file-editor-panel]')!.hidden).toBe(false))
    const editor = root.querySelector<HTMLTextAreaElement>('#jailed-code-editor')!
    editor.value = 'draft'; editor.dispatchEvent(new Event('input', { bubbles: true }))
    root.querySelector<HTMLButtonElement>('[data-file-editor-close]')!.click()
    expect(root.querySelector<HTMLElement>('[data-file-editor-panel]')!.hidden).toBe(true)
    root.querySelector<HTMLButtonElement>('[data-file-editor-show]')!.click()
    expect(editor.value).toBe('draft')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('keeps two trash revisions with the same path separate without displaying opaque identities', async () => {
    const items = ['12345678-1234-4234-8234-123456789abc', '12345678-1234-4234-8234-123456789abd'].map(id => ({ id, originalPath: 'same.txt', name: 'same.txt', sizeBytes: 2, deletedAt: timestamp }))
    const request = vi.fn(async () => ({ items }))
    const root = mount('trash', request); await settled(root); select(root, 0); expect(root.querySelector('[data-file-detail="mode"]')!.textContent).toBe('Not recorded'); select(root, 1)
    expect(root.querySelector('[data-file-selection-count]')!.textContent).toBe('2')
    expect(root.textContent).not.toContain(items[0]!.id)
    expect(root.querySelector('[data-file-detail="mode"]')!.textContent).toBe('Not read')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('reports actual upload read/send/readback completion with indeterminate progress only', async () => {
    let finishRead!: (buffer: ArrayBuffer) => void
    const file = { name: 'alpha.txt', size: 2, arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { finishRead = resolve }) }
    const request = vi.fn(async (_m: string, _p: string, body: Record<string, unknown>) => {
      if (body.op === 'list') return { entries: [] }
      if (body.op === 'put-bytes') return entry()
      if (body.op === 'get-bytes') return { path: 'alpha.txt', contentBase64: 'QUI=', sizeBytes: 2, mtime: timestamp }
      throw new Error('unexpected operation')
    })
    const root = mount('browse', request); await settled(root)
    const picker = root.querySelector<HTMLInputElement>('[data-file-upload]')!
    root.querySelector<HTMLButtonElement>('[data-action="upload-file"]')!.click()
    Object.defineProperty(picker, 'files', { configurable: true, value: [file] }); picker.dispatchEvent(new Event('change', { bubbles: true }))
    expect(root.querySelector('[data-file-uploads]')!.textContent).toContain('Reading upload')
    expect(request).toHaveBeenCalledTimes(1)
    finishRead(new Uint8Array([65, 66]).buffer)
    await vi.waitFor(() => expect(root.querySelector('[data-file-uploads]')!.textContent).toContain('Upload confirmed'))
    expect(root.querySelector('[data-file-uploads] [role="progressbar"]')!.hasAttribute('aria-valuenow')).toBe(false)
    expect(request.mock.calls.map(call => call[2].op)).toEqual(['list', 'put-bytes', 'get-bytes', 'list'])
    const dismiss = root.querySelector<HTMLButtonElement>('[data-file-uploads] [data-xp-slot="dismiss"]')!
    expect(dismiss.disabled).toBe(false); dismiss.click()
    expect(root.querySelector('[data-file-upload-count]')!.textContent).toBe('0')
    expect(request).toHaveBeenCalledTimes(4)
  })

  it('retains uncertainty after a dispatched upload fails and never retries it', async () => {
    const request = vi.fn(async (_m: string, _p: string, body: Record<string, unknown>) => {
      if (body.op === 'list') return { entries: [] }
      throw new Error('connection lost')
    })
    const root = mount('browse', request); await settled(root)
    const picker = root.querySelector<HTMLInputElement>('[data-file-upload]')!
    const start = () => { root.querySelector<HTMLButtonElement>('[data-action="upload-file"]')!.click(); Object.defineProperty(picker, 'files', { configurable: true, value: [{ name: 'alpha.txt', size: 2, arrayBuffer: async () => new Uint8Array([65, 66]).buffer }] }); picker.dispatchEvent(new Event('change', { bubbles: true })) }
    start()
    await vi.waitFor(() => expect(root.querySelector('[data-file-uploads]')!.textContent).toContain('Upload outcome uncertain'))
    start()
    expect(request.mock.calls.filter(call => call[2].op === 'put-bytes')).toHaveLength(1)
    expect(root.dataset.fileUncertain).toBe('true')
  })

  it('keeps a late file read hidden after the workspace identity changes', async () => {
    let finish!: (value: unknown) => void
    const request = vi.fn(async (_m: string, _p: string, body: Record<string, unknown>) => {
      if (body.op === 'list') return { entries: [entry()] }
      return new Promise(resolve => { finish = resolve })
    })
    const root = mount('browse', request); await settled(root)
    root.querySelector<HTMLButtonElement>('[data-file-workspace-action="open"]')!.click()
    await vi.waitFor(() => expect(request.mock.calls.some(call => call[2].op === 'read')).toBe(true))
    expect(typeof finish).toBe('function')
    root.dataset.accountUsername = 'bob'
    finish({ path: 'alpha.txt', content: 'AB', sizeBytes: 2, mtime: timestamp })
    await vi.waitFor(() => expect(root.dataset.fileLoading).toBe('false'))
    expect(root.querySelector<HTMLElement>('[data-file-editor-panel]')!.hidden).toBe(true)
    expect(root.querySelector('[data-file-detail="name"]')!.textContent).toBe('No file selected')
    expect(request.mock.calls.every(call => call[1] === '/api/accounts/alice/files')).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
  })
})


it.each(['headers', 'details', 'foreign-detail'] as const)('fails closed before every POST read for malformed presentation %s', fault => {
  const request = vi.fn(async () => ({ entries: [] }))
  const root = mount('browse', request, templates, () => {
    if (fault === 'headers') document.querySelector('[data-file-manager-table] th')!.remove()
    if (fault === 'details') document.querySelector('[data-file-detail="owner"]')!.remove()
    if (fault === 'foreign-detail') {
      const field = document.querySelector('[data-file-detail="owner"]')!
      const foreign = document.createElement('div'); foreign.setAttribute('data-file-manager', 'browse'); field.replaceWith(foreign); foreign.append(field)
    }
  })
  expect(request).not.toHaveBeenCalled()
  expect(root.querySelector<HTMLElement>('[data-file-status]')!.dataset.state).toBe('unavailable')
})
