import { describe, expect, it } from 'vitest'
import { translator } from '../i18n.ts'
import {
  formatBytes,
  formatBytesHtml,
  formatDateTime,
  formatDateTimeHtml,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRate,
  isolateTechnical,
} from './formatters.ts'

describe('design-system canonical formatters', () => {
  it('formats bytes and rates in single IEC units with two decimals and ASCII digits', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(92 * 1024)).toBe('92.00 KiB')
    expect(formatBytes(10 * 1024 * 1024 * 1024)).toBe('10.00 GiB')
    expect(formatBytes(1024, 'ar')).toBe('1.00 KiB')
    expect(formatRate(47.7 * 1024 * 1024)).toBe('47.70 MiB/s')
    expect(formatBytesHtml(1024)).toContain('<bdi dir="ltr">1.00 KiB</bdi>')
  })

  it('formats durations into consistent human units in EN and AR via PO catalog', () => {
    const ar = translator('ar')
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(0, ar)).toBe('0 ثانية')
    expect(formatDuration(13 * 86400 + 23 * 3600)).toBe('13d 23h')
    expect(formatDuration(13 * 86400 + 23 * 3600, ar)).toBe('13 يوم 23 ساعة')
    expect(formatDuration(522233)).toBe('6d 1h')
  })

  it('formats numbers and percentages with ASCII digits and grouping separators', () => {
    expect(formatNumber(99311, 'ar')).toBe('99,311')
    expect(formatNumber(9732496, 'en')).toBe('9,732,496')
    expect(formatPercent(25.15, 'ar', 2)).toBe('25.15%')
    expect(formatNumber(null)).toBe('—')
  })

  it('formats dates in user timezone with UTC fallback and bdi isolation', () => {
    const iso = '2026-11-23T10:30:00Z'
    const utcStr = formatDateTime(iso, { timeZone: 'UTC' })
    expect(utcStr).toContain('2026-11-23 10:30')
    expect(utcStr).toContain('UTC')

    const tokyoStr = formatDateTime(iso, { timeZone: 'Asia/Tokyo' })
    expect(tokyoStr).toContain('2026-11-23 19:30')

    const invalidTz = formatDateTime(iso, { timeZone: 'Invalid/Zone' })
    expect(invalidTz).toBe(utcStr)

    const html = formatDateTimeHtml(iso, { timeZone: 'Asia/Tokyo', showUtc: true, locale: 'ar' })
    expect(html).toContain('<bdi dir="ltr" data-ds-ts="2026-11-23T10:30:00.000Z">2026-11-23 19:30')
    expect(html).toContain('2026-11-23 10:30 UTC')
  })

  it('isolates technical values cleanly and escapes HTML', () => {
    expect(isolateTechnical('2001:db8::1')).toBe('<bdi dir="ltr">2001:db8::1</bdi>')
    expect(isolateTechnical('<script>alert(1)</script>')).toBe('<bdi dir="ltr">&lt;script&gt;alert(1)&lt;/script&gt;</bdi>')
    expect(isolateTechnical('')).toBe('')
  })
})
