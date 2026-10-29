// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { MONITORING_LOG_UNITS } from '../../../../packages/os/src/monitoring-command.ts'
import { renderWhmMonitoringDisk, renderWhmMonitoringLogs, renderWhmMonitoringPerformance, renderWhmMonitoringProcesses } from './whm-monitoring-workspace.ts'

const pages = (locale: 'en' | 'ar', canRead: boolean) => [
  ['processes', renderWhmMonitoringProcesses({ locale, canRead, canSignal: true })],
  ['disk', renderWhmMonitoringDisk({ locale, canRead })],
  ['logs', renderWhmMonitoringLogs({ locale, canRead })],
  ['performance', renderWhmMonitoringPerformance({ locale, canRead })],
] as const

describe('WHM monitoring renderers', () => {
  it.each(['en', 'ar'] as const)('render labelled, localized and truthful unread workspaces in %s', locale => {
    for (const [kind, html] of pages(locale, true)) {
      document.body.innerHTML = html
      const root = document.querySelector<HTMLElement>('[data-whm-monitoring]')!
      expect([root.dataset.whmMonitoring, root.getAttribute('dir'), root.getAttribute('lang'), root.dataset.monitoringCanRead]).toEqual([kind, locale === 'ar' ? 'rtl' : 'ltr', locale, 'true'])
      expect(html).not.toMatch(/[٠-٩۰-۹]/)
      expect(document.querySelector('h1')).toBeNull()
      expect(document.querySelector('[data-whm-monitoring-status]')!.getAttribute('data-state')).toBe('unread')
      expect(document.querySelector<HTMLButtonElement>('[data-whm-monitoring-refresh]')!.disabled).toBe(false)
      for (const control of document.querySelectorAll<HTMLElement>('input,select')) expect(document.querySelector('label[for="' + control.id + '"]')).not.toBeNull()
      for (const table of document.querySelectorAll('table')) expect(table.querySelector('caption')).not.toBeNull()
      expect(document.querySelectorAll('[data-whm-monitoring-observed-at], [data-whm-monitoring-observed-range]').length).toBe(1)
      if (locale === 'ar') expect(document.body.textContent).toMatch(/[؀-ۿ]/)
    }
  })
  it('keeps process signals out of server markup and only declares the capability', () => {
    document.body.innerHTML = renderWhmMonitoringProcesses({ locale: 'en', canRead: true, canSignal: true })
    expect(document.querySelector('[data-whm-monitoring-signal]')).toBeNull()
    expect(document.querySelector<HTMLElement>('[data-whm-monitoring]')!.dataset.monitoringCanSignal).toBe('true')
    expect(document.body.textContent).toContain('Command arguments are not read')
    document.body.innerHTML = renderWhmMonitoringProcesses({ locale: 'en', canRead: false, canSignal: true })
    expect(document.querySelector<HTMLElement>('[data-whm-monitoring]')!.dataset.monitoringCanSignal).toBe('false')
  })
  it('offers exactly the reviewed log units and bounded selectors', () => {
    document.body.innerHTML = renderWhmMonitoringLogs({ locale: 'en', canRead: true })
    expect([...document.querySelectorAll<HTMLOptionElement>('[data-whm-monitoring-unit] option')].map(option => option.value)).toEqual([...MONITORING_LOG_UNITS])
    expect([...document.querySelectorAll<HTMLOptionElement>('[data-whm-monitoring-priority] option')].map(option => option.value)).toEqual(['', '0', '1', '2', '3', '4', '5', '6', '7'])
    const lines = document.querySelector<HTMLInputElement>('[data-whm-monitoring-lines]')!
    expect([lines.min, lines.max, lines.value]).toEqual(['1', '500', '100'])
  })
  it.each(['en', 'ar'] as const)('retains every component disabled without read authority in %s', locale => {
    for (const [, html] of pages(locale, false)) {
      document.body.innerHTML = html
      for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) expect(control.disabled).toBe(true)
      expect(document.querySelectorAll('table').length).toBeGreaterThan(0)
    }
    document.body.innerHTML = renderWhmMonitoringPerformance({ locale, canRead: false })
    expect(document.querySelectorAll('[data-whm-monitoring-chart]').length).toBe(5)
  })
})
