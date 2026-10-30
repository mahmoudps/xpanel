// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FILE_WORKSPACE_CLIENT_BINDING } from './file-workspace-client.ts'

const timestamp = '2026-10-29T12:00:00.000Z'
const row = '<tr class="theme-row"><td><bdi dir="ltr" data-xp-slot="name"></bdi></td><td data-xp-slot="kind"></td><td><bdi dir="ltr" data-xp-slot="size"></bdi></td><td><bdi dir="ltr" data-xp-slot="mode"></bdi></td><td><bdi dir="ltr"><time data-xp-slot="modified"></time></bdi></td><td class="theme-actions" data-xp-slot="actions"></td></tr>'
const templates = `<template data-xp-template="file-row">${row}</template><template data-xp-template="trash-row">${row}</template><template data-xp-template="file-action"><button type="button" class="theme-action" data-xp-slot="label"></button></template><template data-xp-template="trash-action"><button type="button" class="theme-restore" data-xp-slot="label"></button></template><template data-xp-template="trash-purge-action"><button type="button" class="theme-purge" data-xp-slot="label"></button></template><template data-xp-template="file-empty-row"><tr class="theme-empty"><td colspan="6" data-xp-slot="message"></td></tr></template>`
const listeners: EventListener[] = []

function mount(mode: 'browse' | 'trash', send: (method: string, path: string, body: Record<string, unknown>) => Promise<unknown>, markup = templates) {
  document.body.innerHTML = `<section data-file-manager="${mode}" data-account-username="alice"><button data-action="refresh-files"></button><p data-file-status hidden></p><div class="theme-table" data-file-table-wrap><table data-file-manager-table><tbody></tbody></table></div><div data-trash-empty hidden></div>${mode === 'browse' ? '<textarea id="jailed-code-editor"></textarea><span data-file-current-path></span><span data-file-selected-path></span>' : ''}${markup}</section>`
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

  it.each(['', templates.replace('data-xp-slot="modified"', 'data-missing="modified"'), templates.replace('<time data-xp-slot="modified"></time>', '<span data-xp-slot="modified"></span>'), templates.replace('type="button" class="theme-action"', 'type="submit" class="theme-action"')])('fails closed before network effects when required templates are missing or malformed', markup => {
    const request = vi.fn(async () => ({ entries: [] }))
    const root = mount('browse', request, markup)
    expect(request).not.toHaveBeenCalled()
    expect(root.querySelector<HTMLElement>('[data-file-status]')!.dataset.state).toBe('unavailable')
    expect(root.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
  })
})
