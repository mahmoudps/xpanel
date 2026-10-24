import { describe, expect, it } from 'vitest'
import { bumpSoaSerial, chooseZoneSerial, stampZoneContent, storedZoneContentHash, zoneContentHash } from './zone-serial.ts'

const now = new Date('2026-10-24T12:00:00.000Z')

const rawZone = (serial: number, extra = ''): string =>
  `example.test. 3600 IN SOA ns.example.test. hostmaster.example.test. (\n\t\t\t\t${serial}\t; serial\n\t\t\t\t3600\t; refresh\n)\n${extra}`

describe('PowerDNS SOA serial', () => {
  it('bumps a stale serial to the UTC day stamp and increments within the day', () => {
    expect(bumpSoaSerial(2026102202, now)).toBe(2026102400)
    expect(bumpSoaSerial(2026102400, now)).toBe(2026102401)
    expect(bumpSoaSerial(2026102405, now)).toBe(2026102406)
    expect(bumpSoaSerial(4_294_967_295, now)).toBe(4_294_967_295)
  })

  it('keeps the state serial without a previous file and never decreases a matching hash', () => {
    const rendered = rawZone(2026102201)
    const previous = stampZoneContent(rawZone(2026102202))
    expect(chooseZoneSerial(2026102201, null, rendered, now)).toBe(2026102201)
    expect(chooseZoneSerial(2026102201, previous, rendered, now)).toBe(2026102202)
    expect(storedZoneContentHash(stampZoneContent(rendered))).toBe(storedZoneContentHash(previous))
  })

  it('bumps a zone that already has the records but no stored hash', () => {
    const previous = rawZone(2026102202, 'xp202610._domainkey 3600 IN TXT "v=DKIM1"\n')
    const rendered = rawZone(2026102201, 'xp202610._domainkey 3600 IN TXT "v=DKIM1"\n')
    expect(storedZoneContentHash(previous)).toBeNull()
    expect(chooseZoneSerial(2026102201, previous, rendered, now)).toBe(2026102400)
  })

  it('bumps when the stored hash differs and keeps the new hash stable', () => {
    const previous = stampZoneContent(rawZone(2026102202))
    const rendered = rawZone(2026102201, 'www 3600 IN A 192.0.2.10\n')
    expect(chooseZoneSerial(2026102201, previous, rendered, now)).toBe(2026102400)
    const stamped = stampZoneContent(rawZone(2026102400, 'www 3600 IN A 192.0.2.10\n'))
    expect(chooseZoneSerial(2026102400, stamped, rendered, now)).toBe(2026102400)
  })

  it('bumps when a planted content marker is not the stamp at the end of the file', () => {
    const rendered = rawZone(2026102201, 'www 3600 IN A 192.0.2.10\n')
    const hash = zoneContentHash(rendered)
    const planted = rawZone(2026102202, `; xpanel-content ${hash}\nwww 3600 IN A 192.0.2.1\n`)
    expect(storedZoneContentHash(planted)).toBeNull()
    expect(chooseZoneSerial(2026102201, planted, rendered, now)).toBe(2026102400)
    expect(chooseZoneSerial(2026102400, stampZoneContent(rendered), rendered, now)).toBe(2026102400)
  })
})
