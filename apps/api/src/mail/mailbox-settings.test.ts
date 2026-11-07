import { describe, expect, it } from 'vitest'
import { loginAlertDue, loginRange, parseMailboxSettings } from './mailbox-settings.ts'

const NOW = Date.parse('2026-11-07T12:00:00.000Z')
describe('mailbox settings', () => {
  it('validates addresses and modes', () => {
    expect(parseMailboxSettings({ addresses: ['Me@Example.COM'], loginAlerts: true, alertKnownRanges: false, plusFolders: 'create' }).addresses).toEqual(['me@example.com'])
    expect(() => parseMailboxSettings({ addresses: ['nope'], loginAlerts: true, alertKnownRanges: false, plusFolders: 'off' })).toThrow(/address is invalid/)
    expect(() => parseMailboxSettings({ addresses: ['a@b.c', 'a@b.c'], loginAlerts: true, alertKnownRanges: false, plusFolders: 'off' })).toThrow(/address is invalid/)
    expect(() => parseMailboxSettings({ addresses: [], loginAlerts: true, alertKnownRanges: false, plusFolders: 'always' })).toThrow(/plusFolders/)
    expect(() => parseMailboxSettings({ addresses: Array.from({ length: 6 }, (_, i) => `a${i}@b.c`), loginAlerts: true, alertKnownRanges: false, plusFolders: 'off' })).toThrow(/at most 5/)
  })

  it('alerts once for a new IP, never for a known one, and skips known ranges unless asked', () => {
    const empty = { ips: {}, notifiedAt: {} }
    expect(loginAlertDue(empty, '203.0.113.9', false, NOW)).toBe(true)
    const known = { ips: { '203.0.113.9': '2026-11-01T00:00:00.000Z' }, notifiedAt: {} }
    expect(loginAlertDue(known, '203.0.113.9', false, NOW)).toBe(false)
    expect(loginAlertDue(known, '203.0.113.10', false, NOW)).toBe(false)
    expect(loginAlertDue(known, '203.0.113.10', true, NOW)).toBe(true)
    expect(loginAlertDue({ ips: {}, notifiedAt: { '198.51.100.1': '2026-11-07T00:00:00.000Z' } }, '198.51.100.1', false, NOW)).toBe(false)
    expect(loginAlertDue({ ips: {}, notifiedAt: { '198.51.100.1': '2026-11-05T00:00:00.000Z' } }, '198.51.100.1', false, NOW)).toBe(true)
    expect(loginRange('2001:db8:1:2::5')).toBe('2001:db8:1')
  })
})
