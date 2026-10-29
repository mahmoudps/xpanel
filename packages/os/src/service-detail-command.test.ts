import { describe, expect, it } from 'vitest'
import { PDNS_RPING_ARGV, PDNS_VERSION_ARGV, isServiceDetailCommand, isServiceDetailZone, pdnsCheckZoneArgv } from './service-detail-command.ts'

describe('reviewed PowerDNS read grammar', () => {
  it('admits exactly rping, version and per-zone check-zone', () => {
    expect(isServiceDetailCommand([...PDNS_RPING_ARGV])).toBe(true)
    expect(isServiceDetailCommand([...PDNS_VERSION_ARGV])).toBe(true)
    expect(pdnsCheckZoneArgv('example.com')).toEqual(['/usr/bin/pdnsutil', 'check-zone', 'example.com'])
    expect(isServiceDetailCommand(pdnsCheckZoneArgv('xn--bcher-kva.example'))).toBe(true)
  })
  it('accepts canonical zone names only', () => {
    for (const zone of ['example.com', 'a.b.example.org', 'xn--bcher-kva.example', '0.example.net']) expect(isServiceDetailZone(zone)).toBe(true)
    for (const zone of ['', 'com', 'Example.com', 'example.com.', '-x.example.com', 'x-.example.com', '*.example.com', 'ex ample.com', '../etc', '--zone=x.com', 'a'.repeat(64) + '.com', `${'a.'.repeat(127)}com`, 7]) expect(isServiceDetailZone(zone)).toBe(false)
  })
  it('refuses mutations, selectors, extra operands and other binaries', () => {
    for (const argv of [
      ['/usr/bin/pdns_control', 'reload'], ['/usr/bin/pdns_control', 'bind-reload-now'], ['/usr/bin/pdns_control', 'rediscover'], ['/usr/bin/pdns_control', 'quit'],
      ['/usr/bin/pdns_control', '--socket-dir=/tmp', 'rping'], ['/usr/bin/pdns_control', 'rping', 'x'], ['/usr/bin/pdns_control', 'list-zones'],
      ['/usr/bin/pdnsutil', 'check-zone'], ['/usr/bin/pdnsutil', 'check-zone', 'example.com', '/tmp/x.zone'], ['/usr/bin/pdnsutil', 'check-zone', '-v'],
      ['/usr/bin/pdnsutil', 'check-all-zones'], ['/usr/bin/pdnsutil', 'increase-serial', 'example.com'], ['/usr/bin/pdnsutil', 'edit-zone', 'example.com'],
      ['/usr/bin/pdnsutil', '--config-dir=/tmp', 'check-zone', 'example.com'], ['pdns_control', 'rping'], ['/usr/sbin/pdns_control', 'rping'], ['/bin/sh', '-c', 'pdns_control rping'], [], ['/usr/bin/pdns_control', 7],
    ]) expect(isServiceDetailCommand(argv)).toBe(false)
    expect(() => pdnsCheckZoneArgv('--help')).toThrow()
  })
})
