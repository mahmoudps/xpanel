import { describe, expect, it } from 'vitest'
import { ASCII_BYTES_BINDING, ISOLATE_LTR_BINDING, formatAsciiBytes, formatAsciiRate, formatIsolatedBytes, isolateLtr } from './display-format.ts'
import { isolateClientValues } from './i18n.ts'

const nb = '\u00a0', lri = '\u2066', pdi = '\u2069'

describe('one product byte format', () => {
  it('uses binary IEC units, ASCII digits and a non-breaking space', () => {
    expect([0, -5, Number.NaN, 0.25, 1, 1023, 1024, 1536, 10 * 1024, 2_000_000, 1024 ** 3 * 17.7, 1024 ** 4 * 3].map(formatAsciiBytes))
      .toEqual([`0${nb}B`, `0${nb}B`, `0${nb}B`, `<1${nb}B`, `1${nb}B`, `1023${nb}B`, `1.00${nb}KiB`, `1.50${nb}KiB`, `10.0${nb}KiB`, `1.91${nb}MiB`, `17.7${nb}GiB`, `3.00${nb}TiB`])
  })

  it('moves a value that rounds to 1024 into the next unit', () => {
    expect(formatAsciiBytes(1024 * 1023.7)).toBe(`1.00${nb}MiB`)
  })

  it('writes rates in the same units', () => {
    expect([formatAsciiRate(512), formatAsciiRate(2048), formatAsciiRate(3 * 1024 * 1024)]).toEqual([`512${nb}B/s`, `2.00${nb}KiB/s`, `3.00${nb}MiB/s`])
  })

  it('gives clients the isolated form from the same implementation', () => {
    const standalone = new Function(`return ${ASCII_BYTES_BINDING}`)() as (bytes: number, perSecond?: boolean) => string
    for (const bytes of [0, 64, 1500, 2_100_000_000]) expect(standalone(bytes)).toBe(formatIsolatedBytes(bytes))
    expect(standalone(2048, true)).toBe(`${lri}2.00${nb}KiB/s${pdi}`)
  })
})

describe('direction isolation of technical text', () => {
  it('wraps a run in LRI and PDI, also as a browser binding', () => {
    expect(isolateLtr('/opt/xpanel/php/8.3/bin/php')).toBe(`${lri}/opt/xpanel/php/8.3/bin/php${pdi}`)
    expect((new Function(`${ISOLATE_LTR_BINDING}; return isolateLtr`)() as (text: string) => string)('~/logs')).toBe(`${lri}~/logs${pdi}`)
  })

  it('isolates technical values only in right-to-left locales', () => {
    const values = { time: '2026-10-22 12:00 UTC', path: '~/public_html', file: '.htaccess', address: 'other@example.org', size: `17.7${nb}GiB`, count: 3, digits: '42', name: 'صندوق', done: `${lri}1${nb}B${pdi}` }
    expect(isolateClientValues('en', values)).toBe(values)
    expect(isolateClientValues('ar', values)).toEqual({ ...values, time: `${lri}2026-10-22 12:00 UTC${pdi}`, path: `${lri}~/public_html${pdi}`, file: `${lri}.htaccess${pdi}`, address: `${lri}other@example.org${pdi}`, size: `${lri}17.7${nb}GiB${pdi}` })
    expect(isolateClientValues('ar', undefined)).toBeUndefined()
  })
})
