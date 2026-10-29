import { describe, expect, it, vi } from 'vitest'
import { PHP_BINARY_PROBE, PHP_DPKG_QUERY_ARGV, PHP_RPM_QUERY_ARGV, parsePhpBinaryObservation, parsePhpPackages, phpBinaryProbeArgv, readPhpRuntimeInventory } from './php-inventory.ts'
import { isPhpInventoryCommand } from '../../../packages/os/src/php-inventory-command.ts'

const result = (stdout: string, ok = true) => ({ ok, stdout, stderr: '' })
const probe = (version = '8.3.12') => JSON.stringify({ version, sapi: 'cli', builtInExtensions: ['Core', 'json'] })
describe('PHP inventory read adapter', () => {
  it('admits only the exact fixed read commands, with no general PHP or package mutation allowance', () => {
    for (const argv of [[...PHP_DPKG_QUERY_ARGV], [...PHP_RPM_QUERY_ARGV], phpBinaryProbeArgv('8.3', 'dpkg'), phpBinaryProbeArgv('8.3', 'rpm'), phpBinaryProbeArgv('8.3', 'rpm', true)]) expect(isPhpInventoryCommand(argv)).toBe(true)
    for (const argv of [[], ['/usr/bin/php', '-r', PHP_BINARY_PROBE], ['/usr/bin/php', '-n', '-r', 'system("id");'], ['/usr/bin/php8.5', '-n', '-r', PHP_BINARY_PROBE], [...PHP_DPKG_QUERY_ARGV, '--root=/tmp'], ['/usr/bin/dpkg-query', '-W', '-f=arbitrary'], ['/usr/bin/rpm', '-e', 'php83-php-cli'], ['/bin/sh', '-c', 'php -r code']]) expect(isPhpInventoryCommand(argv)).toBe(false)
  })
  it('uses package observations and fixed no-INI probes without desired-state inputs', async () => {
    const run = vi.fn(async (argv: string[]) => argv[0] === '/usr/bin/dpkg-query' ? result('php8.3-cli\t8.3.12-1\tinstall ok installed\nphp8.3-curl\t8.3.12-1\tinstall ok installed\nnginx\t1.24-1\tinstall ok installed\n') : result(probe()))
    const inventory = await readPhpRuntimeInventory(run, 'dpkg', () => new Date('2026-10-26T12:00:00Z'))
    expect(run.mock.calls.map(([argv]) => argv)).toEqual([[...PHP_DPKG_QUERY_ARGV], phpBinaryProbeArgv('8.3', 'dpkg')])
    expect(inventory).toMatchObject({ state: 'read', source: 'dpkg', observedAt: '2026-10-26T12:00:00.000Z', versions: [{ version: '8.3', supported: true, extensionEnablement: 'not-read', fpmRequest: 'not-read', binary: { state: 'read', scope: 'cli-without-ini', version: '8.3.12', builtInExtensions: ['Core', 'json'] } }] })
    expect(inventory.versions[0]!.packages.map(item => item.component)).toEqual(['cli', 'curl'])
    expect(Object.values(inventory.capabilities)).toEqual([false, false, false, false, false])
    expect(PHP_BINARY_PROBE).not.toMatch(/include|require|ini_set|exec|system|shell_exec/)
    expect(run.mock.calls[1]![0]).toContain('-n')
  })
  it('uses the trusted RPM source and observed SCL runtime path without querying a foreign database', async () => {
    const run = vi.fn(async (argv: string[]) => argv[0] === '/usr/bin/dpkg-query' ? result('', false) : argv[0] === '/usr/bin/rpm' ? result('php83-php-cli\t8.3.12-1.el9\tinstalled\nphp83-php-common\t8.3.12-1.el9\tinstalled\n') : result(probe()))
    const inventory = await readPhpRuntimeInventory(run, 'rpm')
    expect(inventory.source).toBe('rpm')
    expect(run.mock.calls[0]![0]).toEqual([...PHP_RPM_QUERY_ARGV])
    expect(run.mock.calls[1]![0]).toEqual(['/opt/remi/php83/root/usr/bin/php', '-n', '-r', PHP_BINARY_PROBE])
  })
  it('distinguishes an actual empty package inventory from an unavailable command', async () => {
    expect(await readPhpRuntimeInventory(async () => result(''), 'dpkg')).toMatchObject({ state: 'read', source: 'dpkg', versions: [] })
    expect(await readPhpRuntimeInventory(async () => result('', false), 'dpkg')).toMatchObject({ state: 'unavailable', source: null, versions: [], reason: 'package-inventory-unavailable' })
  })
  it('does not fall back after the trusted package database fails or accept an unspecified source', async () => {
    const run = vi.fn(async (argv: string[]) => argv[0] === '/usr/bin/dpkg-query' ? result('', false) : result('php83-php-cli\t8.3.12-1.el9\tinstalled\n'))
    expect(await readPhpRuntimeInventory(run, 'dpkg')).toMatchObject({ state: 'unavailable', versions: [] })
    expect(run.mock.calls.map(([argv]) => argv)).toEqual([[...PHP_DPKG_QUERY_ARGV]])
    run.mockClear()
    expect(await readPhpRuntimeInventory(run, undefined as unknown as 'dpkg')).toMatchObject({ state: 'unavailable', versions: [] })
    expect(run).not.toHaveBeenCalled()
  })
  it('retains distribution PHP packages and binds their binary version explicitly', async () => {
    const run = vi.fn(async (argv: string[]) => argv[0] === '/usr/bin/dpkg-query' ? result('', false) : argv[0] === '/usr/bin/rpm' ? result('php-cli\t8.3.12-1.el9\tinstalled\nphp-common\t8.3.12-1.el9\tinstalled\n') : result(probe()))
    const inventory = await readPhpRuntimeInventory(run, 'rpm')
    expect(inventory.versions).toHaveLength(1)
    expect(inventory.versions[0]!.version).toBe('8.3')
    expect(run.mock.calls[1]![0]).toEqual(['/usr/bin/php', '-n', '-r', PHP_BINARY_PROBE])
  })
  it('retains observed lsphp packages without claiming a working LSAPI or FPM request', async () => {
    const run = vi.fn(async (argv: string[]) => argv[0] === '/usr/bin/dpkg-query' ? result('lsphp83\t8.3.12-1\tinstall ok installed\nlsphp83-mysql\t8.3.12-1\tinstall ok installed\n') : result('', false))
    const inventory = await readPhpRuntimeInventory(run, 'dpkg')
    expect(inventory.versions).toHaveLength(1)
    expect(inventory.versions[0]).toMatchObject({ version: '8.3', packages: [{ name: 'lsphp83', component: 'runtime' }, { name: 'lsphp83-mysql', component: 'mysql' }], binary: { state: 'unavailable' }, fpmRequest: 'not-read', extensionEnablement: 'not-read' })
    expect(run.mock.calls.map(([argv]) => argv[0])).toEqual(['/usr/bin/dpkg-query', '/usr/bin/php8.3'])
  })
  it('does not present package-only or unsupported runtime versions as executed binaries', async () => {
    const run = vi.fn(async (argv: string[]) => argv[0] === '/usr/bin/dpkg-query' ? result('php8.3-fpm\t8.3.12-1\tinstall ok installed\nphp8.5-cli\t8.5.1-1\tinstall ok installed\n') : result('', false))
    const inventory = await readPhpRuntimeInventory(run, 'dpkg')
    expect(inventory.versions.map(item => item.binary)).toEqual([{ state: 'unavailable', scope: 'cli-without-ini', reason: 'binary-unavailable' }, { state: 'unavailable', scope: 'cli-without-ini', reason: 'unsupported-version' }])
    expect(run).toHaveBeenCalledTimes(2)
  })
  it.each(['noise', 'php8.3-cli\t8.3.12-1\tinstall ok installed\nphp8.3-cli\t8.3.12-1\tinstall ok installed\n', 'php8.3-cli\t8.3\tinstall ok installed\r\n', 'x'.repeat(2 * 1024 * 1024 + 1)])('refuses malformed/duplicate/oversized inventory without probing', async stdout => {
    const run = vi.fn(async () => result(stdout))
    expect(await readPhpRuntimeInventory(run, 'dpkg')).toMatchObject({ state: 'unavailable', reason: 'invalid-package-inventory', versions: [] })
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('ignores removed package residues and retains package version identity', () => {
    expect([...parsePhpPackages('php8.3-cli:amd64\t8.3.12-1ubuntu1\tinstall ok installed\nphp8.2-fpm\t8.2.9-1\tdeinstall ok config-files\n', 'dpkg')]).toEqual([['8.3', [{ name: 'php8.3-cli:amd64', version: '8.3.12-1ubuntu1', component: 'cli' }]]])
  })
  it.each(['8.3;id', '../../bin/sh', '8.3 -r', '8.5'])('never constructs a command from an unsupported version %s', version => {
    expect(() => phpBinaryProbeArgv(version, 'dpkg')).toThrow()
  })
  it.each([JSON.stringify({ version: '8.2.12', sapi: 'cli', builtInExtensions: [] }), JSON.stringify({ version: '8.3.12', sapi: 'fpm-fcgi', builtInExtensions: [] }), JSON.stringify({ version: '8.3.12', sapi: 'cli', builtInExtensions: ['json', 'JSON'] }), JSON.stringify({ version: '8.3.12', sapi: 'cli', builtInExtensions: ['<img>'] }), 'invalid'])('refuses an unbound or malformed binary observation', value => {
    expect(parsePhpBinaryObservation(value, '8.3')).toEqual({ state: 'unavailable', scope: 'cli-without-ini', reason: 'invalid-binary-observation' })
  })
})
