import { describe, expect, it } from 'vitest'
import { detectMailRouting } from './routing-detect.ts'

const record = (name: string, type: string, content: string, priority: number | null = null) => ({ name, type, content, priority })
const zone = (...records: ReturnType<typeof record>[]) => ({ name: 'example.test', records: [record('mail', 'A', '192.0.2.10'), record('remote', 'A', '198.51.100.1'), ...records] })
const detect = (value: ReturnType<typeof zone> | null, domain = 'example.test') => detectMailRouting(domain, value, 'host.server.test', ['192.0.2.10'])

describe('email routing detection', () => {
  it('is local when the lowest MX is on a server address', () => {
    expect(detect(zone(record('@', 'MX', 'mail.example.test', 10), record('@', 'MX', 'remote.example.test', 20)))).toMatchObject({ mode: 'local' })
  })
  it('is backup when only a lower-ranked MX points here', () => {
    expect(detect(zone(record('@', 'MX', 'remote.example.test', 10), record('@', 'MX', 'mail.example.test', 20)))).toMatchObject({ mode: 'backup' })
  })
  it('is remote when no MX points here, even for a host outside the zone', () => {
    expect(detect(zone(record('@', 'MX', 'mx.elsewhere.test', 10)))).toMatchObject({ mode: 'remote' })
  })
  it('counts the server hostname as here', () => {
    expect(detect(zone(record('@', 'MX', 'host.server.test.', 10)))).toMatchObject({ mode: 'local' })
  })
  it('reads the MX of a subdomain from its owner label', () => {
    const subdomain = zone(record('@', 'MX', 'remote.example.test', 10), record('shop', 'MX', 'mail.example.test', 10))
    expect(detect(subdomain, 'shop.example.test')).toEqual({ mode: 'local', mx: [{ priority: 10, host: 'mail.example.test' }] })
  })
  it('detects nothing without a zone or an MX record', () => {
    expect(detect(null).mode).toBeNull()
    expect(detect(zone()).mode).toBeNull()
  })
})
