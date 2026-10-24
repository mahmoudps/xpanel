/// <reference lib="dom" />
// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://panel.example.test/whm/monitoring/io"}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
import { renderServerIoMonitorChart } from './charts.ts'
import { renderLiveUpdatesIndicator } from './shell.ts'
import { SYNTHETIC_WHM_IO_SNAPSHOT } from '../../../tests/fixtures/analytics-snapshots.ts'

const listeners: Array<['document' | 'window', string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]> = []
afterEach(() => {
  for (const [target, type, listener, options] of listeners.splice(0)) (target === 'document' ? document : window).removeEventListener(type, listener, options)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.documentElement.removeAttribute('lang')
  document.body.innerHTML = ''
  delete document.documentElement.dataset.realtimeEnabled
})

describe('unqualified IO live-update exclusion', () => {
  it.each(['en', 'ar'] as const)('does not let the old numeric-only updater overwrite truthful %s display or observation time', locale => {
    document.body.innerHTML = renderServerIoMonitorChart(SYNTHETIC_WHM_IO_SNAPSHOT, locale)
    document.documentElement.dataset.realtimeEnabled = 'true'
    let socket: { onmessage?: (message: { data: string }) => void } | undefined
    vi.stubGlobal('WebSocket', class { constructor() { socket = this } })
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    for (const target of ['document', 'window'] as const) {
      const object = target === 'document' ? document : window
      const add = object.addEventListener.bind(object)
      vi.spyOn(object, 'addEventListener').mockImplementation((type, listener, options) => {
        listeners.push([target, type, listener, options])
        add(type, listener, options)
      })
    }
    const before = document.body.innerHTML
    new Function('window', 'document', BROWSER_REALTIME_SCRIPT)(window, document)
    expect(socket?.onmessage).toBeTypeOf('function')
    for (const value of [0, 100, 0]) {
      socket!.onmessage!({ data: JSON.stringify({ id: `diagnostic-event-${value}`, at: '2026-10-23T00:01:00Z', kind: 'io.analytics', scope: { accountId: null }, data: { current: { readBytesPerSec: value, writeBytesPerSec: value, readIops: value, writeIops: value, awaitMs: value } } }) })
      expect(document.body.innerHTML).toBe(before)
    }
    expect(document.querySelector('[data-live-kpi]')).toBeNull()
    expect(document.querySelector('[data-resource-observation-state]')?.getAttribute('data-resource-observation-state')).toBe('incomplete')
  })
})


describe('responsive live-update indicators', () => {
  type Socket = { onopen?: () => void; onclose?: () => void; onerror?: () => void; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }

  function setup(locale: 'en' | 'ar', enabled = true) {
    vi.useFakeTimers()
    document.documentElement.lang = locale
    document.documentElement.dataset.realtimeEnabled = String(enabled)
    document.body.innerHTML = `<div data-view="permanently-unavailable">${renderLiveUpdatesIndicator(locale, false)}</div><div data-view="desktop">${renderLiveUpdatesIndicator(locale, true)}</div><div data-view="mobile">${renderLiveUpdatesIndicator(locale, true)}</div>`
    const permanent = document.querySelector('[data-view="permanently-unavailable"]')!
    const original = permanent.innerHTML
    const sockets: Socket[] = []
    let failNext = false
    const construct = vi.fn(function () {
      if (failNext) throw new Error('Synthetic transport failure')
      const socket: Socket = { send: vi.fn(), close: vi.fn() }
      sockets.push(socket)
      return socket
    })
    vi.stubGlobal('WebSocket', construct)
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    for (const target of ['document', 'window'] as const) {
      const object = target === 'document' ? document : window
      const add = object.addEventListener.bind(object)
      vi.spyOn(object, 'addEventListener').mockImplementation((type, listener, options) => {
        listeners.push([target, type, listener, options])
        add(type, listener, options)
      })
    }
    new Function('window', 'document', BROWSER_REALTIME_SCRIPT)(window, document)
    const indicators = () => [...document.querySelectorAll<HTMLElement>('[data-view="desktop"] [data-ws-indicator], [data-view="mobile"] [data-ws-indicator]')]
    const unchanged = () => expect(permanent.innerHTML).toBe(original)
    return { sockets, construct, indicators, unchanged, failNext: () => { failNext = true } }
  }

  it.each(['en', 'ar'] as const)('updates both %s views through connection, reconnect and transport failure', locale => {
    const fixture = setup(locale)
    expect(fixture.construct).toHaveBeenCalledTimes(1)
    fixture.sockets[0]!.onopen!()
    for (const indicator of fixture.indicators()) {
      expect(indicator.dataset.wsIndicator).toBe('connected')
      expect(indicator.querySelector('.xp-badge__label')?.textContent).toBe(locale === 'ar' ? 'مباشر' : 'Live')
      expect(indicator.querySelector('.xp-badge')?.getAttribute('data-status')).toBe('ok')
    }
    fixture.unchanged()
    fixture.sockets[0]!.onclose!()
    for (const indicator of fixture.indicators()) {
      expect(indicator.dataset.wsIndicator).toBe('disconnected')
      expect(indicator.querySelector('.xp-badge__label')?.textContent).toBe(locale === 'ar' ? 'إعادة الاتصال' : 'Reconnecting')
    }
    fixture.unchanged()
    fixture.failNext()
    vi.advanceTimersByTime(1600)
    expect(fixture.construct).toHaveBeenCalledTimes(2)
    for (const indicator of fixture.indicators()) {
      const label = locale === 'ar' ? 'التحديثات المباشرة متوقفة' : 'Live updates off'
      expect(indicator.dataset.wsIndicator).toBe('unavailable')
      expect(indicator.getAttribute('aria-label')).toBe(label)
      expect(indicator.getAttribute('title')).toBe(label)
      expect(indicator.querySelector('.xp-badge__label')?.textContent).toBe(label)
      expect(indicator.querySelector('.xp-badge')?.getAttribute('data-status')).toBe('suspended')
    }
    fixture.unchanged()
  })

  it.each(['error', 'timeout'] as const)('marks both pending views unavailable after an initial %s', reason => {
    const fixture = setup('en')
    if (reason === 'error') fixture.sockets[0]!.onerror!()
    else vi.advanceTimersByTime(4000)
    for (const indicator of fixture.indicators()) {
      expect(indicator.dataset.wsIndicator).toBe('unavailable')
      expect(indicator.querySelector('.xp-badge__label')?.textContent).toBe('Live updates off')
    }
    fixture.unchanged()
    expect(fixture.construct).toHaveBeenCalledTimes(1)
  })

  it.each(['en', 'ar'] as const)('constructs no WebSocket when real-time transport is disabled in %s', locale => {
    const fixture = setup(locale, false)
    const before = document.body.innerHTML
    vi.advanceTimersByTime(10_000)
    expect(fixture.construct).not.toHaveBeenCalled()
    expect(document.body.innerHTML).toBe(before)
    fixture.unchanged()
  })
})
