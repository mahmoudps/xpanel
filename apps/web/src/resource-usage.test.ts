import { describe, expect, it } from 'vitest'
import { renderThresholdMeter } from './tokens.ts'
import { renderServerIoMonitorChart } from './charts.ts'
import { renderWhmSurface } from './surfaces/xwhm.ts'
import { renderMailSurface } from './surfaces/xmail.ts'
import { SYNTHETIC_WHM_IO_SNAPSHOT } from '../../../tests/fixtures/analytics-snapshots.ts'

const options = { locale: 'en' as const, unit: 'MiB', label: 'Memory' }
const plainText = (html: string): string => html.replace(/<[^>]+>/g, '')

describe('truthful resource usage rendering', () => {
  it('does not invent a percentage or healthy state for an unlimited quota', () => {
    const html = renderThresholdMeter(42, 'unlimited', options)
    expect(html).not.toMatch(/role="(?:progressbar|meter)"|aria-valuenow=|xp-meter__fill|data-threshold="ok"/)
    expect(html).toContain('42')
    expect(html).toMatch(/unlimited/i)
  })

  it('preserves an empty zero allocation instead of replacing its limit with 1', () => {
    const html = renderThresholdMeter(0, 0, options)
    expect(plainText(html)).toContain('0 / 0')
    expect(html).toContain('No allocation')
    expect(html).not.toMatch(/role="(?:progressbar|meter)"|aria-valuenow=|xp-meter__fill|data-threshold="ok"/)
  })

  it('shows a nonzero observation against zero allocation as exceeded without fabricating a ratio', () => {
    const html = renderThresholdMeter(7, 0, options)
    expect(plainText(html)).toContain('7 / 0')
    expect(html).toContain('Limit exceeded')
    expect(html).not.toMatch(/role="(?:progressbar|meter)"|aria-valuenow=|xp-meter__fill|\d+%/)
  })

  it('does not manufacture an observed zero from an invalid measurement', () => {
    const html = renderThresholdMeter(Number.NaN, 100, options)
    expect(html).toContain('Unavailable')
    expect(html).not.toContain('0 / 100')
    expect(html).not.toMatch(/role="(?:progressbar|meter)"|data-threshold="ok"/)
  })

  it.each([
    [79.999, '&lt;80%', 'ok'], [80, '(80%)', 'warn'], [94.999, '&lt;95%', 'warn'],
    [95, '(95%)', 'critical'], [100.001, '&gt;100%', 'critical'], [250, '(250%)', 'critical'],
  ] as const)('retains the raw boundary status for %s without a contradictory rounded percentage', (used, visible, threshold) => {
    const html = renderThresholdMeter(used, 100, options)
    expect(html).toContain(visible)
    expect(html).toContain(`data-threshold="${threshold}"`)
    expect(html).toContain(`aria-valuenow="${Math.min(100, used)}"`)
    expect(plainText(html)).toContain(`${used} / 100 MiB`)
  })

  it.each(['en', 'ar'] as const)('keeps partial unavailable data, explicit unlimited and ASCII digits in %s', locale => {
    const partial = renderThresholdMeter(7, undefined, { ...options, locale })
    expect(plainText(partial)).toContain(locale === 'ar' ? '7 / غير متاح MiB' : '7 / Unavailable MiB')
    expect(partial).not.toMatch(/role="meter"|aria-valuenow=/)
    const html = renderThresholdMeter(42, 'unlimited', { ...options, locale })
    expect(html).toContain(locale === 'ar' ? 'غير محدود' : 'Unlimited')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    expect(html).toMatch(/<bdi dir="ltr"><bdi dir="ltr" data-resource-part="used">42<\/bdi> \/ <bdi dir="(?:ltr|rtl)" data-resource-part="limit">/)
  })

  it('requires an accessible resource label and escapes supplied labels and units', () => {
    expect(() => renderThresholdMeter(1, 2, { ...options, label: ' ' })).toThrow(/nonempty/)
    const html = renderThresholdMeter(1, 2, { ...options, label: '<img src=x>', unit: '<script>bad</script>' })
    expect(html).toContain('&lt;img src=x&gt;')
    expect(html).not.toContain('<img src=x>')
    expect(html).not.toContain('<script>bad</script>')
  })

  it('keeps positive tiny values and fractional limits distinct from observed zero and zero allocation', () => {
    const small = renderThresholdMeter(0.000001, 0.5, options)
    expect(plainText(small)).toContain('0.000001 / 0.5 MiB (&lt;0.1%)')
    expect(small).toContain('aria-valuenow="0.000001"')
    expect(small).toContain('aria-valuemax="0.5"')
    expect(plainText(renderThresholdMeter(0, 0.5, options))).toContain('0 / 0.5 MiB (0%)')
    expect(plainText(renderThresholdMeter(Number.MIN_VALUE, Number.MIN_VALUE, options))).toContain('5e-324 / 5e-324 MiB (100%)')
    expect(plainText(renderThresholdMeter(Number.MIN_VALUE, 100, options))).toContain('&lt;0.1%')
    const snapshot = structuredClone(SYNTHETIC_WHM_IO_SNAPSHOT)
    snapshot.current.readBytesPerSec = Number.MIN_VALUE
    snapshot.accounts[0]!.readBytesPerSec = Number.MIN_VALUE
    const html = renderServerIoMonitorChart(snapshot)
    expect(html).toContain('5e-324 B/s')
    expect(html).not.toContain('>0 MiB/s<')
  })

  it('does not use invented IO or one-core capacities or claim unqualified host health', () => {
    const snapshot = structuredClone(SYNTHETIC_WHM_IO_SNAPSHOT)
    snapshot.accounts = [{ ...snapshot.accounts[0]!, cpuPercent: 150, memoryCurrentBytes: 0, pidsCurrent: 0, memoryLimitMb: 'unlimited', pidsLimit: 'unlimited' }]
    const html = renderServerIoMonitorChart(snapshot)
    expect(html).toContain('150% (1 core)')
    expect(html).toContain('MiB/s')
    expect(html).toContain('Configured limit')
    expect(html).toContain('data-resource-observation-state="incomplete"')
    expect(html).not.toMatch(/100 MB\/s|100 MiB\/s|150 \/ 100|PSI some=|Healthy|data-live-kpi=|xp-chart-svg|Unlimited/)
    expect(html.match(/data-resource-state="unavailable"/g)).toHaveLength(2)
  })

  it('does not present unknown-rate zeros as measured idle activity', () => {
    const snapshot = structuredClone(SYNTHETIC_WHM_IO_SNAPSHOT)
    snapshot.current.readBytesPerSec = 0
    snapshot.current.writeBytesPerSec = 0
    snapshot.current.readIops = 0
    snapshot.current.writeIops = 0
    snapshot.accounts = []
    const html = renderServerIoMonitorChart(snapshot)
    expect(html).not.toMatch(/>0 MiB\/s<|>0 IOPS<|No active account slices/)
    expect(html).toContain('Unavailable')
  })

  it('uses real configured reseller caps without inventing usage from row order or incomplete account lists', () => {
    const resellers = [1, 2].map(id => ({ id: `reseller-${id}`, username: `reseller${id}`, acl: [], maxAccounts: 5, totalDiskMb: 10240, totalBandwidthMb: 102400, oversell: false, nameservers: [], delegatedIps: [] }))
    const render = (rows: typeof resellers) => renderWhmSurface({ principal: { kind: 'root', id: 'root', username: 'root' }, activeRoute: '/whm/resellers', resellers: rows })
    const forward = render(resellers), reversed = render([...resellers].reverse())
    const row = (html: string, username: string) => html.match(new RegExp(`<tr data-reseller-row="${username}">[\\s\\S]*?<\\/tr>`))![0]
    expect(row(forward, 'reseller1')).toBe(row(reversed, 'reseller1'))
    expect(plainText(forward)).toContain('Unavailable / 5 accounts')
    expect(plainText(forward)).toContain('Unavailable / 10 GiB')
    expect(forward).not.toMatch(/18 \/|6 \/|180 \/|48 \/|role="meter"/)
  })

  it('preserves a mailbox measurement when its cap is unavailable', () => {
    const html = renderMailSurface({ mailbox: 'owner@example.test', quotaUsedMb: 7, activeRoute: '/mail/overview' })
    expect(plainText(html)).toContain('7 / Unavailable MiB')
    expect(html).not.toContain('7 / 1')
    expect(html).not.toMatch(/role="meter"|data-threshold="ok"/)
  })
})
