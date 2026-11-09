// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FRAME_READER_CLIENTS, frameRequest, openFrameReads, withFrameRequest } from './read-only-frame.ts'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const install = (): ReturnType<typeof vi.fn<Send>> => {
  const send = vi.fn<Send>(async () => ({ ok: true }))
  ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  return send
}
afterEach(() => { document.body.innerHTML = ''; delete (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest })

describe('read-only frames read saved values and never write', { tags: ['unit'] }, () => {
  const frames = ['<div data-tool-availability="unverified">', '<div data-readonly="true" data-qualified="false">', '<section data-capability-state="unavailable">',
    '<div data-workspace-mode="read-only">', '<div data-wiring="soon">', '<fieldset disabled>']
  it.each(frames)('lets GET through and refuses every unsafe method inside %s', async frame => {
    const send = install()
    document.body.innerHTML = frame.replace(/<(\w+)([^>]*)>/, '<$1$2><div data-root></div></$1>')
    const request = frameRequest(document.querySelector('[data-root]')!)!
    await expect(request('GET', '/api/server/sec/flood')).resolves.toEqual({ ok: true })
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post'])
      await expect(request(method, '/api/server/sec/flood', {})).rejects.toMatchObject({ code: 'READ_ONLY_FRAME', details: { stateChanged: false } })
    expect(send.mock.calls.map(call => call[0])).toEqual(['GET'])
  })
  it('checks the frame on every call, so a section that turns read-only stops writing', async () => {
    const send = install()
    document.body.innerHTML = '<section data-workspace-mode="connected"><div data-root></div></section>'
    const root = document.querySelector('[data-root]')!, request = frameRequest(root)!
    await request('PUT', '/api/x', {})
    root.parentElement!.setAttribute('data-workspace-mode', 'read-only')
    await expect(request('PUT', '/api/x', {})).rejects.toMatchObject({ code: 'READ_ONLY_FRAME' })
    root.remove()
    await expect(request('POST', '/api/x', {})).rejects.toMatchObject({ code: 'READ_ONLY_FRAME' })
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('has no transport without a session', () => {
    document.body.innerHTML = '<div data-root></div>'
    expect(frameRequest(document.querySelector('[data-root]')!)).toBeUndefined()
  })
  it('keeps every control under a frame reader disabled inside a read-only frame', async () => {
    install()
    document.body.innerHTML = '<div data-readonly="true"><div data-root><input disabled><button disabled>Refresh</button></div></div>'
    const root = document.querySelector('[data-root]')!
    frameRequest(root)
    const button = root.querySelector('button')!
    button.disabled = false
    root.insertAdjacentHTML('beforeend', '<select></select>')
    await Promise.resolve()
    expect([...root.querySelectorAll<HTMLInputElement>('input,select,button')].every(control => control.disabled)).toBe(true)
  })
  it('serializes the gate into a client binding', () => {
    install()
    document.body.innerHTML = '<div data-workspace-mode="read-only"><div data-root></div></div>'
    const bound = new Function('return ' + withFrameRequest('(root => frameRequest(root))'))() as (root: Element) => (method: string, path: string) => Promise<unknown>
    return expect(bound(document.querySelector('[data-root]')!)('DELETE', '/api/x')).rejects.toMatchObject({ code: 'READ_ONLY_FRAME' })
  })
  it('splits one manage flag into read and write admission, serialized with the gate', () => {
    install()
    document.body.innerHTML = '<div data-readonly="true"><div data-root data-x-can-read="true" data-x-manage="false"></div></div><div data-live data-x-manage="true"></div>'
    const access = new Function('return ' + withFrameRequest('((root, read, manage) => frameAccess(root, read, manage))'))() as (root: Element, read: string, manage: string) => { readable(): boolean; writable(): boolean }
    const closed = access(document.querySelector('[data-root]')!, 'data-x-can-read', 'data-x-manage'), live = access(document.querySelector('[data-live]')!, 'data-x-can-read', 'data-x-manage')
    expect([closed.readable(), closed.writable(), live.readable(), live.writable()]).toEqual([true, false, true, true])
    document.querySelector('[data-root]')!.setAttribute('data-x-manage', 'true')
    expect(closed.writable()).toBe(false)
  })
  it('opens only frame reader read flags, never a write flag or another read flag', () => {
    expect(openFrameReads('<div data-can-read="false" data-sw-can-read="false" data-sw-can-manage="false" data-x-can-read="false">'))
      .toBe('<div data-can-read="true" data-sw-can-read="true" data-sw-can-manage="false" data-x-can-read="false">')
  })
  it('routes every frame reader controller through the gate', () => {
    for (const path of Object.values(FRAME_READER_CLIENTS).flat()) {
      const source = readFileSync(new URL('./' + path, import.meta.url), 'utf8')
      expect(source, path).toMatch(/\bframe(?:Request\((?:root|card)\)|Access\((?:root|card),)/)
      expect(source, path).not.toMatch(/\.xpanelSessionRequest\b/)
    }
  })
})
