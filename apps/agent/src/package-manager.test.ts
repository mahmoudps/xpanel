import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { APT_SHOW_HOLDS_ARGV, APT_SIMULATE_UPGRADE_ARGV, APT_UPDATE_ARGV, APT_UPGRADE_PREFIX, DNF_CHECK_UPDATE_ARGV, DNF_MAKECACHE_ARGV, DNF_SECURITY_ARGV, DNF_UPGRADE_PREFIX } from '../../../packages/os/src/package-manager-command.ts'
import type { HostJobRun } from './host-job-contract.ts'
import {
  REBOOT_REQUIRED_PATH, assertKernelExcludedTransaction, buildPackageListRefreshJobPlan, buildSystemUpdateJobPlan, comparePackageVersions, parseAptHolds, parseAptSimulation, parseDnfCheckUpdate, parseDnfSelectedTransaction, parseDnfSecurity, readSystemUpdatePlan,
} from './package-manager.ts'
import type { SystemUpdateCommandResult } from './package-manager.ts'

const APT_SIMULATION = [
  'Reading package lists...',
  'Building dependency tree...',
  'Reading state information...',
  'Calculating upgrade...',
  'The following NEW packages will be installed:',
  '  linux-image-6.8.0-51-generic linux-modules-6.8.0-51-generic',
  'The following packages have been kept back:',
  '  nginx',
  'The following packages will be upgraded:',
  '  libssl3t64 linux-image-generic openssl tzdata',
  '4 upgraded, 2 newly installed, 0 to remove and 1 not upgraded.',
  'Inst libssl3t64 [3.0.13-0ubuntu3.4] (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])',
  'Inst openssl [3.0.13-0ubuntu3.4] (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64]) [libssl3t64:amd64 ]',
  'Inst linux-modules-6.8.0-51-generic (6.8.0-51.52 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])',
  'Inst linux-image-6.8.0-51-generic (6.8.0-51.52 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])',
  'Inst linux-image-generic [6.8.0-50.51] (6.8.0-51.52 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])',
  'Inst tzdata [2024a-3ubuntu1.1] (2024b-0ubuntu0.24.04 Ubuntu:24.04/noble-updates [all])',
  'Conf libssl3t64 (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])',
  'Conf openssl (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])',
  'Conf tzdata (2024b-0ubuntu0.24.04 Ubuntu:24.04/noble-updates [all])',
  '',
].join('\n')

const DNF_CHECK = [
  '',
  'kernel.x86_64                          5.14.0-427.22.1.el9_4              baseos',
  'kernel-core.x86_64                     5.14.0-427.22.1.el9_4              baseos',
  'openssl.x86_64                         1:3.0.7-27.el9                     baseos',
  'python3-a-very-long-package-name-that-overflows-the-column.noarch',
  '                                       2.1-3.el9                          appstream',
  'Obsoleting Packages',
  'grub2-tools.x86_64                     1:2.06-80.el9                      baseos',
  '    grub2-tools.x86_64                 1:2.06-77.el9                      @baseos',
  '',
].join('\n')
const DNF_SECURITY = 'ALSA-2024:3306 Important/Sec. kernel-5.14.0-427.22.1.el9_4.x86_64\nALSA-2024:3306 Important/Sec. kernel-core-5.14.0-427.22.1.el9_4.x86_64\nALSA-2024:3001 Moderate/Sec.  openssl-1:3.0.7-27.el9.x86_64\n'

const ok = (stdout: string, code = 0): SystemUpdateCommandResult => ({ ok: code === 0, code, stdout, stderr: '' })
const now = () => new Date('2026-10-27T10:00:00.000Z')
const aptRun = (simulation = APT_SIMULATION, holds = 'nginx\n') => vi.fn(async (argv: string[]) => argv.join(' ') === APT_SHOW_HOLDS_ARGV.join(' ') ? ok(holds) : argv.join(' ') === APT_SIMULATE_UPGRADE_ARGV.join(' ') ? ok(simulation) : ok('', 1))
const dnfRun = (check = DNF_CHECK, code = 100) => vi.fn(async (argv: string[]) => argv.join(' ') === DNF_SECURITY_ARGV.join(' ') ? ok(DNF_SECURITY) : argv.join(' ') === DNF_CHECK_UPDATE_ARGV.join(' ') ? ok(check, code) : ok('', 1))

describe('apt simulation observation', () => {
  it('parses Inst lines with security suites, kernels, new dependencies and holds', async () => {
    const plan = await readSystemUpdatePlan({ run: aptRun(), family: 'debian', readFile: async path => path === REBOOT_REQUIRED_PATH ? '*** System restart required ***\n' : null, now })
    expect(plan).toMatchObject({ state: 'read', source: 'apt', observedAt: '2026-10-27T10:00:00.000Z', holds: ['nginx'], rebootRequired: true, counts: { total: 6, security: 5, kernel: 3, held: 1 } })
    expect(plan.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(plan.packages.find(entry => entry.name === 'openssl')).toEqual({ name: 'openssl', current: '3.0.13-0ubuntu3.4', candidate: '3.0.13-0ubuntu3.5', origin: 'Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security', security: true, kernel: false, held: false, newInstall: false })
    expect(plan.packages.find(entry => entry.name === 'linux-image-6.8.0-51-generic')).toMatchObject({ current: null, newInstall: true, kernel: true })
    expect(plan.packages.find(entry => entry.name === 'tzdata')).toMatchObject({ security: false, kernel: false })
  })
  it('recognizes Debian security suites and empty release lists', () => {
    const [entry] = parseAptSimulation('Inst libc6:i386 [2.36-9+deb12u7] (2.36-9+deb12u8 Debian-Security:12/stable-security, Debian:12.7/stable [i386])\nInst local-tool [1.0] (1.1  [amd64])', new Set(['libc6']))
    expect(entry).toMatchObject({ name: 'libc6:i386', security: true, held: true })
    expect(parseAptSimulation('Inst bookworm-pkg [1] (2 Debian:12/bookworm-security [amd64])', new Set())[0]!.security).toBe(true)
    expect(parseAptSimulation('Inst local-tool [1.0] (1.1  [amd64])', new Set())[0]).toMatchObject({ origin: '', security: false })
  })
  it.each([
    'Inst openssl 3.0.13 (3.0.14 Ubuntu:24.04/noble-updates [amd64])',
    'Inst Bad_Name [1] (2 Ubuntu:24.04/noble [amd64])',
    'Inst openssl [1] (2 Ubuntu:24.04/noble [amd64])\nInst openssl [1] (2 Ubuntu:24.04/noble [amd64])',
    'Inst openssl [1] (2 Ubuntu:24.04/noble [amd64])\r',
    'Inst openssl [1] (2 Ubuntu:24.04/noble)',
  ])('rejects malformed simulation output %#', simulation => expect(() => parseAptSimulation(simulation, new Set())).toThrow())
  it('rejects malformed holds and output beyond bounds', () => {
    expect(() => parseAptHolds('nginx\n--force\n')).toThrow()
    expect(() => parseAptHolds('nginx\nnginx\n')).toThrow()
    expect(() => parseAptSimulation('x'.repeat(2 * 1024 * 1024 + 1), new Set())).toThrow()
  })
  it('reports malformed output, busy locks and failures as unavailable, never as a partial plan', async () => {
    expect(await readSystemUpdatePlan({ run: aptRun(APT_SIMULATION + 'Inst broken line\n'), family: 'debian', now })).toMatchObject({ state: 'unavailable', reason: 'invalid-package-manager-output', packages: [], revision: null })
    const busy = vi.fn(async () => ({ ok: false, code: 100, stdout: '', stderr: 'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 4242 (apt-get)' }))
    expect(await readSystemUpdatePlan({ run: busy, family: 'debian', now })).toMatchObject({ state: 'unavailable', reason: 'package-manager-busy' })
    expect(await readSystemUpdatePlan({ run: vi.fn(async () => { throw new Error('spawn') }), family: 'debian', now })).toMatchObject({ state: 'unavailable', reason: 'package-manager-unavailable' })
    const run = vi.fn()
    expect(await readSystemUpdatePlan({ run, family: null, now })).toMatchObject({ state: 'unavailable', source: null, reason: 'unsupported-host' })
    expect(run).not.toHaveBeenCalled()
  })
  it('keeps the revision stable across order and observation time and changes it with the plan', async () => {
    const reordered = APT_SIMULATION.split('\n').filter(line => line.startsWith('Inst ')).reverse().join('\n')
    const first = await readSystemUpdatePlan({ run: aptRun(), family: 'debian', now })
    const second = await readSystemUpdatePlan({ run: aptRun(reordered), family: 'debian', now: () => new Date('2026-10-28T00:00:00Z') })
    const held = await readSystemUpdatePlan({ run: aptRun(APT_SIMULATION, 'nginx\ntzdata\n'), family: 'debian', now })
    expect(second.revision).toBe(first.revision)
    expect(held.revision).not.toBe(first.revision)
    expect(first.rebootRequired).toBe('not-read')
  })
})

describe('dnf check-update observation', () => {
  it('parses wrapped rows, stops at obsoletes and classifies security advisories and kernels', async () => {
    const plan = await readSystemUpdatePlan({ run: dnfRun(), family: 'rhel', now })
    expect(plan).toMatchObject({ state: 'read', source: 'dnf', holds: null, rebootRequired: 'not-read', counts: { total: 4, security: 3, kernel: 2, held: null } })
    expect(plan.packages.map(entry => entry.name)).toEqual(['kernel-core.x86_64', 'kernel.x86_64', 'openssl.x86_64', 'python3-a-very-long-package-name-that-overflows-the-column.noarch'])
    expect(plan.packages.find(entry => entry.name === 'openssl.x86_64')).toEqual({ name: 'openssl.x86_64', current: null, candidate: '1:3.0.7-27.el9', origin: 'baseos', security: true, kernel: false, held: false, newInstall: false })
  })
  it('applies dnf exit-code semantics', async () => {
    expect(await readSystemUpdatePlan({ run: dnfRun('', 0), family: 'rhel', now })).toMatchObject({ state: 'read', counts: { total: 0 } })
    expect(await readSystemUpdatePlan({ run: dnfRun(DNF_CHECK, 0), family: 'rhel', now })).toMatchObject({ state: 'unavailable', reason: 'invalid-package-manager-output' })
    expect(await readSystemUpdatePlan({ run: dnfRun('', 100), family: 'rhel', now })).toMatchObject({ state: 'unavailable', reason: 'invalid-package-manager-output' })
    expect(await readSystemUpdatePlan({ run: dnfRun("Error: Cache-only enabled but no cache for 'baseos'", 1), family: 'rhel', now })).toMatchObject({ state: 'unavailable', reason: 'package-manager-unavailable' })
  })
  it('rejects misaligned rows and malformed advisories', () => {
    expect(() => parseDnfCheckUpdate('openssl.x86_64 1:3.0.7-27.el9\n', new Set())).toThrow()
    expect(() => parseDnfCheckUpdate('openssl 1:3.0.7-27.el9 baseos\n', new Set())).toThrow()
    expect(() => parseDnfSecurity('ALSA-2024:1 Important/Sec.\n')).toThrow()
    expect([...parseDnfSecurity(DNF_SECURITY)]).toEqual(['kernel.x86_64', 'kernel-core.x86_64', 'openssl.x86_64'])
  })
})

describe('package version ordering', () => {
  it.each([
    ['debian', '3.0.13-0ubuntu3.5', '3.0.13-0ubuntu3.4', 1],
    ['debian', '1.0~rc1-1', '1.0-1', -1],
    ['debian', '1:0.1', '2.0', 1],
    ['debian', '1.0-1', '1.0-1ubuntu1', -1],
    ['debian', '2024b-0ubuntu0.24.04', '2024a-3ubuntu1.1', 1],
    ['debian', '6.8.0-51.52', '6.8.0-51.52', 0],
    ['rhel', '5.14.0-427.22.1.el9_4', '5.14.0-427.18.1.el9_4', 1],
    ['rhel', '1:2.06-80.el9', '1:2.06-77.el9', 1],
    ['rhel', '1.0~rc1-1', '1.0-1', -1],
    ['rhel', '1.0^git1-1', '1.0-1', 1],
    ['rhel', '1.0a-1', '1.0.1-1', -1],
    ['rhel', '1:1.0-1', '2.0-1', 1],
    ['rhel', '1.010-1', '1.10-1', 0],
  ] as const)('%s %s vs %s', (family, left, right, expected) => expect(comparePackageVersions(family, left, right)).toBe(expected))
})

describe('reviewed update job plans', () => {
  const debian = () => readSystemUpdatePlan({ run: aptRun(), family: 'debian', now })
  it('selects security upgrades only, never new dependencies or holds, with list-only restart env', async () => {
    const observed = await debian()
    const plan = buildSystemUpdateJobPlan({ family: 'debian', observed, selection: { mode: 'security' } })
    expect(plan.kind).toBe('system.packages.upgrade')
    expect(plan.accountId).toBeNull()
    expect(plan.fingerprint).toEqual({ revision: observed.revision, selection: { mode: 'security', count: 3, sha256: createHash('sha256').update('libssl3t64\nlinux-image-generic\nopenssl').digest('hex') } })
    expect(plan.detail).toMatchObject({ mode: 'security', packages: ['libssl3t64', 'linux-image-generic', 'openssl'], packagesTruncated: false, servicesRestarted: false, counts: { packages: 3, security: 3, kernel: 1 } })
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]).toMatchObject({ id: 'upgrade-packages', mutates: true, env: { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l', APT_LISTCHANGES_FRONTEND: 'none' } })
    expect(plan.steps[0]!.argv).toEqual([...APT_UPGRADE_PREFIX, 'libssl3t64', 'linux-image-generic', 'openssl'])
    expect(plan.steps.every(step => plan.policy(step.argv))).toBe(true)
    expect(plan.policy([...APT_UPGRADE_PREFIX, '-o', 'x'])).toBe(false)
    expect(plan.summary.length).toBeLessThanOrEqual(512)
    const all = buildSystemUpdateJobPlan({ family: 'debian', observed, selection: { mode: 'all' }, refreshFirst: true })
    expect(all.steps.map(step => step.id)).toEqual(['refresh-lists', 'upgrade-packages'])
    expect(all.steps[0]!.argv).toEqual([...APT_UPDATE_ARGV])
    expect(all.steps[1]!.argv.slice(APT_UPGRADE_PREFIX.length)).toEqual(['libssl3t64', 'linux-image-generic', 'openssl', 'tzdata'])
  })
  it('chunks 500 long names within the runner argv and plan-data bounds', async () => {
    const names = Array.from({ length: 500 }, (_, index) => 'p' + String(index).padStart(3, '0') + 'x'.repeat(120))
    const observed = await readSystemUpdatePlan({ run: aptRun(names.map(name => `Inst ${name} [1.0] (1.1 Ubuntu:24.04/noble-updates [amd64])`).join('\n')), family: 'debian', now })
    const plan = buildSystemUpdateJobPlan({ family: 'debian', observed, selection: { mode: 'all' } })
    expect(plan.steps.map(step => step.id)).toEqual(['upgrade-packages', 'upgrade-packages-2', 'upgrade-packages-3'])
    expect(plan.steps.every(step => step.argv.length <= 256 && plan.policy(step.argv))).toBe(true)
    expect(plan.steps.flatMap(step => step.argv.slice(APT_UPGRADE_PREFIX.length))).toEqual(names)
    expect(Buffer.byteLength(JSON.stringify({ fingerprint: plan.fingerprint, detail: plan.detail }))).toBeLessThanOrEqual(16 * 1024)
    expect(plan.detail).toMatchObject({ packagesTruncated: true })
  })
  it('refuses held, new-dependency, unknown, empty and stale selections', async () => {
    const observed = await debian()
    for (const packages of [['nginx'], ['linux-image-6.8.0-51-generic'], ['absent'], []]) expect(() => buildSystemUpdateJobPlan({ family: 'debian', observed, selection: { mode: 'selected', packages } })).toThrow()
    expect(() => buildSystemUpdateJobPlan({ family: 'debian', observed, selection: { mode: 'selected' } })).toThrow()
    expect(() => buildSystemUpdateJobPlan({ family: 'debian', observed, selection: { mode: 'all', packages: ['openssl'] } })).toThrow()
    expect(() => buildSystemUpdateJobPlan({ family: 'rhel', observed, selection: { mode: 'all' } })).toThrow()
    const none = await readSystemUpdatePlan({ run: aptRun(APT_SIMULATION.split('\n').filter(line => !line.includes('security')).join('\n')), family: 'debian', now })
    expect(() => buildSystemUpdateJobPlan({ family: 'debian', observed: none, selection: { mode: 'security' } })).toThrow(/no selectable/)
  })
  it('verifies by re-reading and accepts only no selected package pending at or below its candidate', async () => {
    const observed = await debian()
    const plan = buildSystemUpdateJobPlan({ family: 'debian', observed, selection: { mode: 'selected', packages: ['openssl', 'tzdata'] } })
    const runWith = (simulation: string): HostJobRun => vi.fn(async (argv: readonly string[], options?: { env?: Record<string, string> }) => {
      expect(options?.env).toEqual({ LC_ALL: 'C' })
      return { ...(argv[0] === '/usr/bin/apt-mark' ? ok('nginx\n') : ok(simulation)), timedOut: false }
    }) as HostJobRun
    const upgraded = await plan.verify!(runWith(APT_SIMULATION.split('\n').filter(line => !/ (?:openssl|tzdata) /.test(line)).join('\n')))
    expect(upgraded).toMatchObject({ ok: true, detail: { upgraded: 2, remaining: [] } })
    const still = await plan.verify!(runWith(APT_SIMULATION))
    expect(still).toMatchObject({ ok: false, detail: { remaining: ['openssl', 'tzdata'] } })
    const newer = await plan.verify!(runWith('Inst openssl [3.0.13-0ubuntu3.5] (3.0.13-0ubuntu3.6 Ubuntu:24.04/noble-security [amd64])'))
    expect(newer).toMatchObject({ ok: true })
    const unreadable = await plan.verify!(vi.fn(async () => ({ ok: false, code: 100, stdout: '', stderr: 'E: failure', timedOut: false })) as HostJobRun)
    expect(unreadable).toMatchObject({ ok: false, detail: { reason: 'package-manager-unavailable' } })
  })
  it('builds dnf upgrades by name.arch and refresh jobs for both families', async () => {
    const observed = await readSystemUpdatePlan({ run: dnfRun(), family: 'rhel', now })
    const plan = buildSystemUpdateJobPlan({ family: 'rhel', observed, selection: { mode: 'security' } })
    expect(plan.steps[0]!.argv).toEqual([...DNF_UPGRADE_PREFIX, 'kernel-core.x86_64', 'kernel.x86_64', 'openssl.x86_64'])
    expect(plan.steps[0]!.env).toBeUndefined()
    const refresh = buildPackageListRefreshJobPlan('rhel')
    expect(refresh).toMatchObject({ kind: 'system.packages.refresh', accountId: null })
    expect(refresh.steps.map(step => step.argv)).toEqual([[...DNF_MAKECACHE_ARGV]])
    expect(buildPackageListRefreshJobPlan('debian').steps[0]!.argv).toEqual([...APT_UPDATE_ARGV])
    expect(refresh.steps.every(step => refresh.policy(step.argv) && step.mutates)).toBe(true)
    expect(await refresh.verify!(vi.fn(async (argv: readonly string[]) => ({ ...(argv.includes('updateinfo') ? ok('') : ok('', 0)), timedOut: false })) as HostJobRun)).toMatchObject({ ok: true })
    expect(() => buildPackageListRefreshJobPlan('other' as never)).toThrow()
  })
})

describe('kernel-excluded update jobs', () => {
  const safeSimulation = APT_SIMULATION.split('\n').filter(line => !line.startsWith('Inst linux-')).join('\n')
  const protectedRun = (selected = safeSimulation) => vi.fn(async (argv: string[]) => argv[0] === '/usr/bin/apt-mark' ? ok('nginx\n') : argv.includes('dist-upgrade') ? ok(APT_SIMULATION) : ok(selected))
  it('binds the option into a distinct observed revision and preserves visible kernel rows', async () => {
    const inclusive = await readSystemUpdatePlan({ run: aptRun(), family: 'debian', now })
    const excluded = await readSystemUpdatePlan({ run: aptRun(), family: 'debian', now, excludeKernel: true })
    expect(excluded.revision).not.toBe(inclusive.revision)
    expect(excluded.packages).toEqual(inclusive.packages)
    expect(excluded.excludeKernel).toBe(true)
    expect(inclusive.excludeKernel).toBeUndefined()
  })
  it('filters all/security selections, freezes observed kernel versions, and rechecks before every effect', async () => {
    const run = protectedRun(), observed = await readSystemUpdatePlan({ run, family: 'debian', now, excludeKernel: true }), assertRoot = vi.fn(async () => {})
    for (const mode of ['all', 'security'] as const) {
      const plan = buildSystemUpdateJobPlan({ family: 'debian', observed, selection: { mode }, revalidate: { run, assertRoot } })
      expect(plan.detail).toMatchObject({ excludeKernel: true, excludedKernelCount: 3, counts: { kernel: 0 } })
      expect(plan.fingerprint.selection).toMatchObject({ excludeKernel: true })
      expect(plan.steps[0]!.argv).toContain('linux-image-generic=6.8.0-50.51')
      expect(plan.steps[0]!.argv).toContain('linux-image-6.8.0-51-generic-')
      expect(plan.policy(plan.steps[0]!.argv)).toBe(true)
      const simulation = mode === 'security' ? safeSimulation.split('\n').filter(line => !line.startsWith('Inst tzdata ')).join('\n') : safeSimulation
      const job = buildSystemUpdateJobPlan({ family: 'debian', observed, selection: { mode }, revalidate: { run: protectedRun(simulation), assertRoot } })
      await job.beforeStep!(job.steps[0]!)
    }
    expect(assertRoot).toHaveBeenCalledTimes(4)
    expect(() => buildSystemUpdateJobPlan({ family: 'debian', observed, selection: { mode: 'all' } })).toThrow()
    expect(() => buildSystemUpdateJobPlan({ family: 'debian', observed, selection: { mode: 'selected', packages: ['linux-image-generic'] }, revalidate: { run, assertRoot } })).toThrow()
  })
  it('refuses dependency kernel changes, malformed simulations and revoked authority before effect', async () => {
    await expect(assertKernelExcludedTransaction({ family: 'debian', run: async () => ok(APT_SIMULATION), names: ['openssl'], excluded: [] })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    await expect(assertKernelExcludedTransaction({ family: 'debian', run: async () => ok('Remv linux-image-generic [1]\n'), names: ['openssl'], excluded: [] })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const observed = await readSystemUpdatePlan({ run: aptRun(), family: 'debian', now, excludeKernel: true }), run = protectedRun()
    const plan = buildSystemUpdateJobPlan({ family: 'debian', observed, selection: { mode: 'all' }, revalidate: { run, assertRoot: async () => { throw new Error('revoked') } } })
    await expect(plan.beforeStep!(plan.steps[0]!)).rejects.toThrow('revoked')
    expect(run).not.toHaveBeenCalled()
  })
  it('refuses a changed observed hold or target before the queued job effect', async () => {
    const observed = await readSystemUpdatePlan({ run: aptRun(), family: 'debian', now, excludeKernel: true })
    const run = async (argv: string[]) => argv[0] === '/usr/bin/apt-mark' ? ok('nginx\nopenssl\n') : ok(APT_SIMULATION)
    const plan = buildSystemUpdateJobPlan({ family: 'debian', observed, selection: { mode: 'selected', packages: ['openssl'] }, revalidate: { run, assertRoot: async () => {} } })
    await expect(plan.beforeStep!(plan.steps[0]!)).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
  })
  const dnfTransaction = 'Dependencies resolved.\n================\n Package Architecture Version Repository Size\n================\nUpgrading:\n openssl x86_64 1:3.0.7-27.el9 baseos 1.2 M\n\nTransaction Summary\n================\nUpgrade 1 Package\n\nTotal download size: 1.2 M\nOperation aborted.\n'
  it('parses only complete DNF install/upgrade transactions and refuses a kernel dependency', async () => {
    expect(parseDnfSelectedTransaction(dnfTransaction)).toEqual(['openssl.x86_64'])
    expect(() => parseDnfSelectedTransaction(dnfTransaction.replace('Upgrade 1 Package', 'Upgrade 2 Packages'))).toThrow()
    expect(() => parseDnfSelectedTransaction(dnfTransaction.replace('Upgrading:', 'Removing:'))).toThrow()
    await expect(assertKernelExcludedTransaction({ family: 'rhel', run: async () => ok(dnfTransaction, 1), names: ['openssl.x86_64'], excluded: ['kernel.x86_64'] })).resolves.toBeUndefined()
    await expect(assertKernelExcludedTransaction({ family: 'rhel', run: async () => ok(dnfTransaction.replace('openssl x86_64', 'kernel-core x86_64'), 1), names: ['openssl.x86_64'], excluded: ['kernel.x86_64'] })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('requires kernel preservation as well as selected-package completion at verification', async () => {
    const observed = await readSystemUpdatePlan({ run: aptRun(), family: 'debian', now, excludeKernel: true })
    const plan = buildSystemUpdateJobPlan({ family: 'debian', observed, selection: { mode: 'selected', packages: ['openssl'] }, revalidate: { run: protectedRun(), assertRoot: async () => {} } })
    const verification = (text: string): HostJobRun => async argv => ({ ...(argv[0] === '/usr/bin/apt-mark' ? ok('nginx\n') : ok(text)), timedOut: false })
    const unchangedKernel = APT_SIMULATION.split('\n').filter(line => !line.startsWith('Inst openssl ')).join('\n')
    expect(await plan.verify!(verification(unchangedKernel))).toMatchObject({ ok: true, detail: { kernelExclusionVerified: true } })
    expect(await plan.verify!(verification(unchangedKernel.split('\n').filter(line => !line.startsWith('Inst linux-')).join('\n')))).toMatchObject({ ok: false, detail: { kernelExclusionVerified: false } })
  })
})

