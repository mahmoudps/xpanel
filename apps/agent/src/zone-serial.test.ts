import { describe, expect, it } from 'vitest'
import { bumpSoaSerial, chooseZoneSerial } from './zone-serial.ts'

const now = new Date('2026-10-24T12:00:00.000Z')

const zone = (serial: number, extra = ''): string =>
  `example.test. 3600 IN SOA ns.example.test. hostmaster.example.test. (\n\t\t\t\t${serial}\t; serial\n\t\t\t\t3600\t; refresh\n)\n${extra}`

describe('PowerDNS SOA serial', () => {
  it('bumps a stale serial to the UTC day stamp and increments within the day', () => {
    expect(bumpSoaSerial(2026102202, now)).toBe(2026102400)
    expect(bumpSoaSerial(2026102400, now)).toBe(2026102401)
    expect(bumpSoaSerial(2026102405, now)).toBe(2026102406)
    expect(bumpSoaSerial(4_294_967_295, now)).toBe(4_294_967_295)
  })

  it('keeps the state serial without a previous file and never decreases an unchanged zone', () => {
    const previous = zone(2026102202)
    const rendered = zone(2026102201)
    expect(chooseZoneSerial(2026102201, null, rendered, now)).toBe(2026102201)
    expect(chooseZoneSerial(2026102201, previous, rendered, now)).toBe(2026102202)
  })

  it('bumps when the zone body changes', () => {
    const previous = zone(2026102202)
    const rendered = zone(2026102201, 'www 3600 IN A 192.0.2.10\n')
    expect(chooseZoneSerial(2026102201, previous, rendered, now)).toBe(2026102400)
  })
})
