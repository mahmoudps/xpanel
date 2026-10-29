import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { DISPLAY_DATETIME_BINDING, formatAsciiDate, formatDisplayDateTime, formatUtcClock, formatUtcDay } from './tokens.ts'

describe('display date format YYYY-MM-DD HH:mm', () => {
  it('formats a date-only value', () => {
    assert.equal(formatAsciiDate('2026-10-22T14:06:31.000Z'), '2026-10-22')
    assert.equal(formatUtcDay('2026-10-22T23:59:59.999Z'), '2026-10-22 UTC')
  })

  it('formats date and time to the minute with the UTC label', () => {
    assert.equal(formatDisplayDateTime('2026-10-22T14:06:31.123456Z'), '2026-10-22 14:06 UTC')
    assert.equal(formatDisplayDateTime('2026-10-22T16:06:31+02:00'), '2026-10-22 14:06 UTC')
    assert.equal(formatDisplayDateTime(new Date(Date.UTC(2026, 0, 5, 3, 7, 59))), '2026-01-05 03:07 UTC')
    assert.equal(formatAsciiDate('2026-10-22T14:06:31.000Z', { includeTime: true }), '2026-10-22 14:06 UTC')
    assert.equal(formatUtcClock('2026-10-22T14:06:31.000Z'), '14:06 UTC')
  })

  it('keeps ASCII digits for Arabic-digit input and rejects non-instants', () => {
    assert.equal(formatDisplayDateTime('٢٠٢٦-١٠-٢٢T١٤:٠٦:٣١Z'), '2026-10-22 14:06 UTC')
    assert.equal(formatDisplayDateTime('22/10/2026 14:06:31 UTC'), '—')
    assert.equal(formatDisplayDateTime('2026-02-30T00:00:00Z'), '—')
    assert.equal(formatDisplayDateTime(null), '—')
  })

  it('gives client bindings the same output', () => {
    const inlined = new Function(`return ${DISPLAY_DATETIME_BINDING}`)() as typeof formatDisplayDateTime
    assert.equal(inlined('2026-10-22T14:06:31.000Z'), '2026-10-22 14:06 UTC')
    assert.equal(inlined('٢٠٢٦-١٠-٢٢T١٤:٠٦:٣١Z'), '2026-10-22 14:06 UTC')
  })
})
