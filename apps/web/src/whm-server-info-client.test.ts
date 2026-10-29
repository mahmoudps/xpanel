/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmSurface } from './surfaces/xwhm.ts'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
import { readWhmServerInfo, WHM_SERVER_INFO_CLIENT_BINDING } from './whm-server-info-client.ts'

const info = { load: { load1: 0.5, load5: 0.25, load15: 0.1 }, memory: { totalBytes: 2147483648, availableBytes: 1073741824 }, disk: { filesystem: '/dev/sda1', mount: '/', totalBytes: 10737418240, usedBytes: 5368709120, availableBytes: 5368709120 } }
const tick = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = (selector: string) => document.querySelector<HTMLElement>(selector)!
const render = (locale: 'en' | 'ar' = 'en') => { document.body.innerHTML = renderWhmSurface({ locale, activeRoute: '/whm/monitoring/server-info', principal: { kind: 'root', id: 'fixture-root', username: 'operator' } }) }
let listeners: [EventTarget, string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][]
beforeEach(() => {
  listeners = []
  for (const target of [document, window]) { const add = target.addEventListener.bind(target); vi.spyOn(target, 'addEventListener').mockImplementation((name, handler, options) => { listeners.push([target, name, handler, options]); add(name, handler, options) }) }
  document.documentElement.dataset.realtimeEnabled = 'false'; document.documentElement.lang = 'en'
})
afterEach(() => {
  for (const [target, name, handler, options] of listeners) target.removeEventListener(name, handler, options)
  vi.restoreAllMocks(); document.body.replaceChildren(); document.documentElement.lang = ''; document.documentElement.dir = ''
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})

describe('server information binding', () => {
  it('rejects partial or inconsistent host measurements', () => {
    expect(readWhmServerInfo(info).load).toEqual([0.5, 0.25, 0.1])
    for (const bad of [null, { ...info, load: { load1: 1, load5: 1 } }, { ...info, memory: { totalBytes: 1, availableBytes: 2 } }, { ...info, disk: undefined }]) expect(() => readWhmServerInfo(bad)).toThrow()
  })
  it('replaces every Reading value with the error state when the read fails', async () => {
    render()
    const send = vi.fn(async () => { throw { status: 503, details: { stateChanged: false } } })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    new Function('window', 'document', BROWSER_REALTIME_SCRIPT)(window, document); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/info')
    for (const key of ['load', 'memory', 'disk']) expect($(`[data-host-${key}]`).textContent).toBe('Unavailable')
    expect($('[data-host-info]').textContent).not.toContain('Reading')
    expect($('[data-host-info-status]').dataset.state).toBe('failed')
    expect($('[data-host-info-status]').getAttribute('role')).toBe('alert')
    expect($('[data-host-info-status]').hidden).toBe(false)
  })
  it('paints verified measurements as LTR values in Arabic with ASCII digits', async () => {
    document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl'; render('ar')
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = vi.fn(async () => info)
    new Function('return ' + WHM_SERVER_INFO_CLIENT_BINDING)()(); await tick()
    expect($('[data-host-load]').textContent).toBe('0.5 0.25 0.1')
    expect($('[data-host-memory]').textContent).toBe('1024 MB / 2048 MB')
    expect($('[data-host-disk]').dir).toBe('ltr')
    expect($('[data-host-info-status]').dataset.state).toBe('read')
  })
})
