/// <reference lib="dom" />
// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://panel.example.test/whm/monitoring/io"}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
import { renderServerIoMonitorChart } from './charts.ts'
import { SYNTHETIC_WHM_IO_SNAPSHOT } from '../../../tests/fixtures/analytics-snapshots.ts'

const listeners: Array<['document' | 'window', string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]> = []
afterEach(() => {
  for (const [target, type, listener, options] of listeners.splice(0)) (target === 'document' ? document : window).removeEventListener(type, listener, options)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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
