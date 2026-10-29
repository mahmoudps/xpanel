import { describe, expect, it, vi } from 'vitest'
import { HOST_SERVICES } from './host-services.ts'
import { readServerNetwork, readServerRole, readServerTimers } from './server-observation.ts'
import type { ServerCronDirent } from './server-observation.ts'

const now = () => new Date('2026-10-27T10:00:00Z')
const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: '' })
const TIMERS = JSON.stringify([
  { next: 1793145600000000, left: 1793145600000000, last: 1793059200123456, passed: 1793059200123456, unit: 'logrotate.timer', activates: 'logrotate.service' },
  { next: 1793145600000000, left: 1793145600000000, last: 0, passed: 0, unit: 'xpanel-cron-alice-backup-db.timer', activates: 'xpanel-cron-alice-backup-db.service' },
  { next: null, left: null, last: null, passed: null, unit: 'xpanel-metrics.timer', activates: ['xpanel-metrics.service'] },
])
const ADDRESSES = JSON.stringify([
  { ifindex: 1, ifname: 'lo', flags: ['LOOPBACK', 'UP', 'LOWER_UP'], mtu: 65536, operstate: 'UNKNOWN', link_type: 'loopback', address: '00:00:00:00:00:00', addr_info: [
    { family: 'inet', local: '127.0.0.1', prefixlen: 8, scope: 'host', label: 'lo', valid_life_time: 4294967295 }, { family: 'inet6', local: '::1', prefixlen: 128, scope: 'host', noprefixroute: true }] },
  { ifindex: 2, ifname: 'eth0', flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'], mtu: 1500, operstate: 'UP', link_type: 'ether', address: '52:54:00:12:34:56', addr_info: [
    { family: 'inet', local: '192.0.2.10', prefixlen: 24, broadcast: '192.0.2.255', scope: 'global', dynamic: true, label: 'eth0' }, { family: 'inet', local: '192.0.2.11', prefixlen: 24, scope: 'global', secondary: true },
    { family: 'inet6', local: '2001:db8::10', prefixlen: 64, scope: 'global' }, { family: 'inet6', local: 'fe80::5054:ff:fe12:3456', prefixlen: 64, scope: 'link' }] },
])
const ROUTES4 = JSON.stringify([
  { dst: 'default', gateway: '192.0.2.1', dev: 'eth0', protocol: 'dhcp', prefsrc: '192.0.2.10', metric: 100, flags: [] },
  { dst: '192.0.2.0/24', dev: 'eth0', protocol: 'kernel', scope: 'link', prefsrc: '192.0.2.10', flags: [] },
  { dst: '198.51.100.0/24', nexthops: [{ gateway: '192.0.2.2', dev: 'eth0', weight: 1, flags: [] }, { gateway: '192.0.2.3', dev: 'eth0', weight: 1, flags: [] }] },
  { type: 'blackhole', dst: '203.0.113.0/24', flags: [] },
])
const ROUTES6 = JSON.stringify([{ dst: '2001:db8::/64', dev: 'eth0', protocol: 'kernel', metric: 256, flags: [], pref: 'medium' }, { dst: 'default', gateway: 'fe80::1', dev: 'eth0', protocol: 'ra', metric: 1024, flags: [], pref: 'medium' }])
const network = (outputs: Partial<Record<'addr' | 'route4' | 'route6', string>> = {}, files: Record<string, string | null | Error> = {}) => {
  const run = vi.fn(async (argv: string[]) => ok(argv[2] === '-6' ? outputs.route6 ?? ROUTES6 : argv[2] === 'route' ? outputs.route4 ?? ROUTES4 : outputs.addr ?? ADDRESSES))
  const content: Record<string, string | null | Error> = { '/etc/hostname': 'web1\n', '/etc/resolv.conf': 'nameserver 192.0.2.53\nnameserver 2001:db8::53\n# nameserver bad\nsearch example.test\noptions edns0\n', ...files }
  const readFile = vi.fn(async (path: string) => { const value = content[path]; if (value instanceof Error) throw value; return value ?? null })
  return { run, readFile, read: () => readServerNetwork({ run, readFile, now }) }
}
const dirent = (name: string, file = true): ServerCronDirent => ({ name, isFile: () => file })

describe('server timers observation', () => {
  it('parses systemctl list-timers JSON, classifies owners and lists cron.d names only', async () => {
    const run = vi.fn(async () => ok(TIMERS))
    const result = await readServerTimers({ run, now, readCronDirectory: async () => [dirent('php', false), dirent('e2scrub_all'), dirent('bad name'), dirent('.placeholder')] })
    expect(run).toHaveBeenCalledWith(['/usr/bin/systemctl', 'list-timers', '--all', '--output=json', '--no-pager'])
    expect(result.timers).toEqual({ state: 'read', reason: null, truncated: false, items: [
      { unit: 'logrotate.timer', activates: ['logrotate.service'], next: '2026-10-28T00:00:00.000Z', last: '2026-10-27T00:00:00.123Z', owner: { kind: 'system' } },
      { unit: 'xpanel-cron-alice-backup-db.timer', activates: ['xpanel-cron-alice-backup-db.service'], next: '2026-10-28T00:00:00.000Z', last: null, owner: { kind: 'account-cron', username: 'alice', jobId: 'backup-db' } },
      { unit: 'xpanel-metrics.timer', activates: ['xpanel-metrics.service'], next: null, last: null, owner: { kind: 'panel' } },
    ] })
    expect(result.cronDirectory).toEqual({ state: 'read', reason: null, truncated: false, unlisted: 1, items: [{ name: '.placeholder', kind: 'file' }, { name: 'e2scrub_all', kind: 'file' }, { name: 'php', kind: 'other' }] })
    expect(result.observedAt).toBe('2026-10-27T10:00:00.000Z')
  })
  it.each([
    ['invalid JSON', '{'], ['an object', '{}'], ['a non-timer unit', JSON.stringify([{ unit: 'logrotate.service', next: null }])], ['a string timestamp', JSON.stringify([{ unit: 'a.timer', next: 'Tue 2026-10-27' }])],
    ['a negative timestamp', JSON.stringify([{ unit: 'a.timer', last: -1 }])], ['an unsafe unit name', JSON.stringify([{ unit: 'a b.timer' }])], ['a bad activates list', JSON.stringify([{ unit: 'a.timer', activates: [7] }])],
    ['a bad passed span', JSON.stringify([{ unit: 'a.timer', passed: 'x' }])], ['duplicate units', JSON.stringify([{ unit: 'a.timer' }, { unit: 'a.timer' }])],
  ])('reports %s as unavailable, never as a partial read', async (_label, stdout) => {
    expect((await readServerTimers({ run: async () => ok(stdout), now })).timers).toEqual({ state: 'unavailable', reason: 'malformed_output', truncated: false, items: [] })
  })
  it('states command failure, output limit, truncation and a missing host executor truthfully', async () => {
    expect((await readServerTimers({ run: async () => ({ ok: false, code: 1, stdout: '', stderr: 'x' }), now })).timers.reason).toBe('command_failed')
    expect((await readServerTimers({ run: async () => { throw new Error('spawn') }, now })).timers.reason).toBe('command_failed')
    expect((await readServerTimers({ run: async () => ok('[' + ' '.repeat(2 * 1024 * 1024) + ']'), now })).timers.reason).toBe('output_limit')
    const many = JSON.stringify(Array.from({ length: 2001 }, (_, index) => ({ unit: `t${index}.timer` })))
    const big = await readServerTimers({ run: async () => ok(many), now })
    expect([big.timers.state, big.timers.truncated, big.timers.items.length]).toEqual(['read', true, 2000])
    expect(await readServerTimers({ now })).toMatchObject({ timers: { state: 'unavailable', reason: 'host_unavailable' }, cronDirectory: { state: 'unavailable', reason: 'host_unavailable' } })
  })
  it('distinguishes an absent cron directory from an unreadable one', async () => {
    const run = async () => ok('[]')
    expect((await readServerTimers({ run, now, readCronDirectory: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) } })).cronDirectory.state).toBe('absent')
    expect((await readServerTimers({ run, now, readCronDirectory: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }) } })).cronDirectory).toMatchObject({ state: 'unavailable', reason: 'unreadable' })
    const many = await readServerTimers({ run, now, readCronDirectory: async () => Array.from({ length: 513 }, (_, index) => dirent('job' + String(index).padStart(3, '0'))) })
    expect([many.cronDirectory.truncated, many.cronDirectory.items.length]).toEqual([true, 512])
  })
})

describe('server network observation', () => {
  it('parses ip -j addr and routes, the static hostname and resolver lines', async () => {
    const { run, read } = network()
    const result = await read()
    expect(run.mock.calls.map(call => call[0].join(' ')).sort()).toEqual(['/usr/sbin/ip -j -6 route show', '/usr/sbin/ip -j addr show', '/usr/sbin/ip -j route show'])
    expect(result.hostname).toEqual({ state: 'read', reason: null, value: 'web1' })
    expect(result.resolvers).toEqual({ state: 'read', reason: null, value: ['192.0.2.53', '2001:db8::53'], truncated: false })
    expect(result.interfaces.items).toEqual([
      { name: 'lo', operstate: 'UNKNOWN', mtu: 65536, loopback: true, addresses: [{ family: 4, address: '127.0.0.1', prefixLength: 8, scope: 'host', dynamic: false }, { family: 6, address: '::1', prefixLength: 128, scope: 'host', dynamic: false }] },
      { name: 'eth0', operstate: 'UP', mtu: 1500, loopback: false, addresses: [{ family: 4, address: '192.0.2.10', prefixLength: 24, scope: 'global', dynamic: true }, { family: 4, address: '192.0.2.11', prefixLength: 24, scope: 'global', dynamic: false },
        { family: 6, address: '2001:db8::10', prefixLength: 64, scope: 'global', dynamic: false }, { family: 6, address: 'fe80::5054:ff:fe12:3456', prefixLength: 64, scope: 'link', dynamic: false }] },
    ])
    expect(result.routes4.items[0]).toEqual({ family: 4, destination: 'default', gateway: '192.0.2.1', device: 'eth0', protocol: 'dhcp', scope: null, source: '192.0.2.10', metric: 100, type: null, nexthops: [] })
    expect(result.routes4.items[2]!.nexthops).toEqual([{ gateway: '192.0.2.2', device: 'eth0' }, { gateway: '192.0.2.3', device: 'eth0' }])
    expect(result.routes4.items[3]).toMatchObject({ destination: '203.0.113.0/24', type: 'blackhole', gateway: null, device: null })
    expect(result.routes6.items.map(item => [item.destination, item.gateway])).toEqual([['2001:db8::/64', null], ['default', 'fe80::1']])
  })
  it.each([
    ['addr', 'not json'], ['addr', '{}'], ['addr', JSON.stringify([{ ifname: 'eth 0', operstate: 'UP' }])], ['addr', JSON.stringify([{ ifname: 'eth0', operstate: 'UP', addr_info: [{ family: 'inet', local: '192.0.2.1', prefixlen: 33, scope: 'global' }] }])],
    ['addr', JSON.stringify([{ ifname: 'eth0', operstate: 'UP', addr_info: [{ family: 'inet', local: '2001:db8::1', prefixlen: 24, scope: 'global' }] }])], ['addr', JSON.stringify([{ ifname: 'eth0', operstate: 'UP', addr_info: [{ family: 'packet' }] }])],
    ['addr', JSON.stringify([{ ifname: 'eth0', operstate: 'UP' }, { ifname: 'eth0', operstate: 'DOWN' }])], ['addr', JSON.stringify([{ ifname: 'eth0', operstate: 'up' }])],
    ['route4', JSON.stringify([{ dst: 'somewhere' }])], ['route4', JSON.stringify([{ dst: '192.0.2.0/33' }])], ['route4', JSON.stringify([{ dst: '2001:db8::/64' }])], ['route4', JSON.stringify([{ dst: 'default', gateway: 'gw' }])],
    ['route6', JSON.stringify([{ dst: '2001:db8::/129' }])], ['route6', JSON.stringify([{ dst: 'default', nexthops: {} }])],
  ] as const)('reports malformed %s output %s as unavailable', async (key, stdout) => {
    const result = await network({ [key]: stdout }).read()
    expect(result[key === 'addr' ? 'interfaces' : key === 'route4' ? 'routes4' : 'routes6']).toEqual({ state: 'unavailable', reason: 'malformed_output', truncated: false, items: [] })
  })
  it('keeps hostname and resolver facts truthful when missing, unreadable or malformed', async () => {
    expect((await network({}, { '/etc/hostname': '# static\nweb1.example.test\n' }).read()).hostname.value).toBe('web1.example.test')
    expect((await network({}, { '/etc/hostname': 'bad name\n' }).read()).hostname).toEqual({ state: 'unavailable', reason: 'malformed_output', value: null })
    expect((await network({}, { '/etc/hostname': null }).read()).hostname).toEqual({ state: 'absent', reason: null, value: null })
    // An O_NOFOLLOW read of a systemd-resolved symlink fails; that is unreadable, not empty.
    expect((await network({}, { '/etc/resolv.conf': Object.assign(new Error('ELOOP'), { code: 'ELOOP' }) }).read()).resolvers).toEqual({ state: 'unavailable', reason: 'unreadable', value: [], truncated: false })
    expect((await network({}, { '/etc/resolv.conf': 'nameserver resolver.example\n' }).read()).resolvers.state).toBe('unavailable')
    expect((await network({}, { '/etc/resolv.conf': 'nameserver 192.0.2.1 extra\n' }).read()).resolvers.state).toBe('unavailable')
    const many = await network({}, { '/etc/resolv.conf': Array.from({ length: 17 }, (_, index) => `nameserver 192.0.2.${index + 1}`).join('\n') }).read()
    expect([many.resolvers.value.length, many.resolvers.truncated]).toEqual([16, true])
    expect((await network({}, { '/etc/resolv.conf': 'x'.repeat(65 * 1024) }).read()).resolvers.reason).toBe('output_limit')
    expect(await readServerNetwork({ now })).toMatchObject({ hostname: { state: 'unavailable', reason: 'host_unavailable' }, interfaces: { state: 'unavailable', reason: 'host_unavailable' }, routes6: { state: 'unavailable' } })
  })
})

describe('server role observation', () => {
  it('reads observed service states through the existing services reader', async () => {
    const run = vi.fn(async (argv: string[]) => ok(argv.at(-1) === 'nginx.service' ? 'loaded\nactive\n' : 'not-found\ninactive\n'))
    const result = await readServerRole({ run, now })
    expect(result.services.state).toBe('read')
    expect(result.services.items).toHaveLength(HOST_SERVICES.length)
    expect(result.services.items.find(item => item.id === 'nginx')).toEqual({ id: 'nginx', label: 'nginx', unit: 'nginx.service', state: 'active' })
    expect(result.services.items.find(item => item.id === 'postfix')!.state).toBe('not-installed')
    expect(await readServerRole({ now })).toEqual({ observedAt: '2026-10-27T10:00:00.000Z', services: { state: 'unavailable', reason: 'host_unavailable', truncated: false, items: [] } })
    expect((await readServerRole({ run: async () => { throw new Error('x') }, now })).services.reason).toBe('command_failed')
  })
})
