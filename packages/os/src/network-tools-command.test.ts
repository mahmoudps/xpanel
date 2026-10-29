import { describe, expect, it } from 'vitest'
import { PING_ARGV_PREFIX, TRACEROUTE_ARGV_PREFIX, canonicalIp, isNetworkToolsCommand, isPublicAddress, pingArgv, tracerouteArgv } from './network-tools-command.ts'

describe('network diagnostics argv grammar', () => {
  it('admits only the exact ping and traceroute argv with a public literal', () => {
    expect(pingArgv('93.184.215.14')).toEqual(['/usr/bin/env', 'LC_ALL=C', '/usr/bin/ping', '-n', '-c', '4', '-W', '2', '-w', '10', '93.184.215.14'])
    expect(tracerouteArgv('2606:4700:4700::1111')).toEqual(['/usr/bin/env', 'LC_ALL=C', '/usr/bin/traceroute', '-n', '-q', '1', '-w', '2', '-m', '20', '2606:4700:4700::1111'])
    expect(isNetworkToolsCommand(pingArgv('8.8.8.8'))).toBe(true); expect(isNetworkToolsCommand(tracerouteArgv('1.1.1.1'))).toBe(true)
    for (const argv of [[...PING_ARGV_PREFIX, '-f'], [...PING_ARGV_PREFIX, '--'], [...PING_ARGV_PREFIX, 'example.com'], [...PING_ARGV_PREFIX, '8.8.8.8', '-f'], [...PING_ARGV_PREFIX.slice(2), '8.8.8.8'],
      [...TRACEROUTE_ARGV_PREFIX, '127.0.0.1'], [...TRACEROUTE_ARGV_PREFIX, '2606:4700:4700:0:0:0:0:1111'], [...TRACEROUTE_ARGV_PREFIX, 'fe80::1%eth0'], ['/usr/bin/ping', '-n', '-c', '4', '8.8.8.8'],
      [...PING_ARGV_PREFIX.slice(0, -1), '100', '8.8.8.8'], [...PING_ARGV_PREFIX, 8 as unknown as string]])
      expect(isNetworkToolsCommand(argv)).toBe(false)
    expect(() => pingArgv('10.0.0.1')).toThrow(expect.objectContaining({ code: 'VALIDATION' })); expect(() => tracerouteArgv('-f')).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
  })
  it('refuses loopback, private, link-local, shared, metadata, multicast, reserved and embedding ranges', () => {
    for (const address of ['127.0.0.1', '127.255.255.254', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.100.100.200', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
      '192.0.2.1', '198.51.100.7', '203.0.113.9', '198.18.0.1', '::1', '::', 'fe80::1', 'fd00:ec2::254', 'fc00::1', 'ff02::1', '::ffff:7f00:1', '::ffff:808:808', '64:ff9b::a00:1', '2002:a00:1::1', '2001:db8::1', '2001::1'])
      expect(isPublicAddress(canonicalIp(address)!.address)).toBe(false)
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.215.14', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) expect(isPublicAddress(address)).toBe(true)
  })
  it('canonicalizes literals and rejects zone ids, brackets and non-canonical text', () => {
    expect(canonicalIp('2001:DB8:0:0::1')).toEqual({ address: '2001:db8::1', family: 6 }); expect(canonicalIp('8.8.8.8')).toEqual({ address: '8.8.8.8', family: 4 })
    for (const value of ['fe80::1%eth0', '[::1]', '08.8.8.8', '8.8.8', 'example.com', '', 42]) expect(canonicalIp(value)).toBeNull()
    expect(isPublicAddress('2A00:1450:4001:80B::200E')).toBe(false)
  })
})
