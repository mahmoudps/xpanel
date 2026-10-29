import { describe, expect, it } from 'vitest'
import { isSoftwareCenterCommand } from '../../../packages/os/src/software-center-command.ts'
import { buildComponentJobPlan, parseAptPolicy, parseAptSimulation, parseDnfSimulation, parseDpkgPackages, parseRpmPackages, previewComponentChange, readSoftwareCenter } from './software-center.ts'
import type { SoftwareCenterFamily, SoftwareCenterRun } from './software-center.ts'

type Result = { ok?: boolean; code?: number | null; stdout: string; stderr?: string }
const now = () => new Date('2026-10-27T10:00:00.000Z')
const debianBase: Record<string, string> = {
  nginx: '1.24.0-2ubuntu7', 'php8.3-cli': '8.3.6-0ubuntu0.24.04.1', 'php8.3-fpm': '8.3.6-0ubuntu0.24.04.1', 'php8.3-common': '8.3.6-0ubuntu0.24.04.1', libc6: '2.39-0ubuntu8',
  git: '1:2.43.0-1ubuntu7', nodejs: '18.19.1+dfsg-6ubuntu5', npm: '9.2.0~ds1-2', 'libdbi-perl': '1.643-4build3', 'libclass-dbi-perl': '3.0.17-5', zip: '3.0-13build1',
}
const dpkgList = (packages: Record<string, string>, extra = ''): string => Object.entries(packages).map(([name, version]) => `${name}\t${version}\tinstall ok installed`).join('\n') + '\n' + extra
function host(family: SoftwareCenterFamily, installed: Record<string, string>, simulations: Record<string, Result> = {}, options: { candidates?: Record<string, string>; dpkgExtra?: string; policy?: Result; dpkg?: Result } = {}) {
  const calls: string[][] = []
  const run: SoftwareCenterRun = async argv => {
    calls.push([...argv])
    if (!isSoftwareCenterCommand(argv)) throw new Error('outside grammar: ' + argv.join(' '))
    const names = argv.slice(argv.indexOf('--') + 1)
    if (argv[0] === '/usr/bin/dpkg-query') return options.dpkg ? { ok: true, code: 0, stderr: '', ...options.dpkg } : { ok: true, code: 0, stdout: dpkgList(installed, options.dpkgExtra), stderr: '' }
    if (argv[0] === '/usr/bin/apt-cache') return options.policy ? { ok: true, code: 0, stderr: '', ...options.policy } : { ok: true, code: 0, stderr: '', stdout: names.map(name => `${name}:\n  Installed: ${installed[name] ?? '(none)'}\n  Candidate: ${options.candidates?.[name] ?? installed[name] ?? '(none)'}\n  Version table:\n     1.0 500\n        500 http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages`).join('\n') + '\n' }
    if (argv[0] === '/usr/bin/rpm') {
      const missing = names.filter(name => !(name in installed)).length
      return { ok: missing === 0, code: missing ? 1 : 0, stderr: '', stdout: names.map(name => name in installed ? `${name}\t${installed[name]}` : `package ${name} is not installed`).join('\n') + '\n' }
    }
    const key = (argv.includes('install') ? 'install ' : 'remove ') + names.join(' ')
    const simulation = simulations[key]
    if (!simulation) throw new Error('unexpected command: ' + argv.join(' '))
    return { ok: simulation.ok ?? true, code: simulation.code === undefined ? 0 : simulation.code, stdout: simulation.stdout, stderr: simulation.stderr ?? '' }
  }
  return { run, calls }
}
const aptInstallMemcached = `NOTE: This is only a simulation!
Reading package lists...
The following NEW packages will be installed:
  libevent-2.1-7t64 memcached
0 upgraded, 2 newly installed, 0 to remove and 0 not upgraded.
Need to get 1,234 kB of archives.
After this operation, 5,678 kB of additional disk space will be used.
Inst libevent-2.1-7t64 (2.1.12-stable-9ubuntu2 Ubuntu:24.04/noble [amd64])
Inst memcached (1.6.24-1build3 Ubuntu:24.04/noble [amd64])
Conf libevent-2.1-7t64 (2.1.12-stable-9ubuntu2 Ubuntu:24.04/noble [amd64])
Conf memcached (1.6.24-1build3 Ubuntu:24.04/noble [amd64])
`
const dnfInstall = `Last metadata expiration check: 0:12:01 ago on Tue 27 Oct 2026 10:00:00 AM UTC.
Dependencies resolved.
================================================================================
 Package                Architecture   Version               Repository    Size
================================================================================
Installing:
 memcached              x86_64         1.6.9-7.el9           appstream    191 k
Installing dependencies:
 libevent               x86_64         2.1.12-6.el9          baseos       265 k
 java-21-openjdk-headless-fastdebug
                        x86_64         1:21.0.5.0.11-2.el9   appstream     48 M
Upgrading:
 openssl                x86_64         1:3.2.2-6.el9_5       baseos       1.4 M

Transaction Summary
================================================================================
Install  3 Packages
Upgrade  1 Package

Total download size: 50 M
Installed size: 200 M
`
const dnfRemove = `Dependencies resolved.
================================================================================
 Package         Arch         Version              Repository             Size
================================================================================
Removing:
 memcached       x86_64       1.6.9-7.el9          @appstream            400 k
Removing unused dependencies:
 libevent        x86_64       2.1.12-6.el9         @anaconda             900 k

Transaction Summary
================================================================================
Remove  2 Packages

Freed space: 1.3 M
`

describe('software center parsers', () => {
  it('reads dpkg states strictly, merging multi-arch instances', () => {
    const packages = parseDpkgPackages('libc6\t2.39\tinstall ok installed\nlibc6\t2.39\tinstall ok installed\nold\t1.0\tdeinstall ok config-files\nhalf\t1.0\tinstall ok half-configured\ntrig\t1.0\tinstall ok triggers-pending\n')
    expect(packages.get('libc6')).toEqual({ installed: true, consistent: true, versions: ['2.39'] })
    expect(packages.has('old')).toBe(false)
    expect(packages.get('half')).toEqual({ installed: false, consistent: false, versions: ['1.0'] })
    expect(packages.get('trig')!.installed).toBe(true)
    for (const bad of ['x\t1\tinstall ok\n', 'Bad\t1\tinstall ok installed\n', 'x\t1 2\tinstall ok installed\n', 'xy\t1\tinstall ok exploded\n', 'xy\t1\tinstall ok installed\r\n']) expect(() => parseDpkgPackages(bad)).toThrow()
  })
  it('requires every rpm query name to be accounted for', () => {
    expect(parseRpmPackages('perl-DBI\t1.643-9.el9\npackage git is not installed\n', ['perl-DBI', 'git'])).toEqual(new Map([['perl-DBI', { installed: true, consistent: true, versions: ['1.643-9.el9'] }]]))
    expect(() => parseRpmPackages('perl-DBI\t1.643-9.el9\n', ['perl-DBI', 'git'])).toThrow()
    expect(() => parseRpmPackages('other\t1-1\npackage git is not installed\n', ['git'])).toThrow()
    expect(() => parseRpmPackages('error: rpmdb open failed\n', ['git'])).toThrow()
  })
  it('reads apt-cache policy candidates', () => {
    expect(parseAptPolicy('memcached:\n  Installed: (none)\n  Candidate: 1.6.24-1build3\n  Version table:\nghost:\n  Installed: (none)\n  Candidate: (none)\n')).toEqual(new Map([['memcached', '1.6.24-1build3'], ['ghost', null]]))
    expect(() => parseAptPolicy('  Candidate: 1.0\n')).toThrow()
  })
  it('parses apt-get -s Inst/Conf/Remv lines and observed sizes', () => {
    const plan = parseAptSimulation(aptInstallMemcached + 'Inst php8.3-common [8.3.6-0ubuntu0.24.04.1] (8.3.6-0ubuntu0.24.04.2 Ubuntu:24.04/noble-updates [amd64]) []\nRemv libfoo:amd64 [1.0-1]\n')
    expect(plan.install.map(change => change.name)).toEqual(['libevent-2.1-7t64', 'memcached'])
    expect(plan.upgrade).toEqual([{ name: 'php8.3-common', from: '8.3.6-0ubuntu0.24.04.1', to: '8.3.6-0ubuntu0.24.04.2' }])
    expect(plan.remove).toEqual([{ name: 'libfoo', from: '1.0-1', to: null }])
    expect(plan.configure).toEqual(['libevent-2.1-7t64', 'memcached'])
    expect(plan.downloadBytes).toBe(1234000); expect(plan.sizeDeltaBytes).toBe(5678000)
    expect(parseAptSimulation('After this operation, 2 MB disk space will be freed.\nRemv git [1:2.43.0-1ubuntu7]\n').sizeDeltaBytes).toBe(-2000000)
    expect(() => parseAptSimulation('Purg git [1:2.43.0]\n')).toThrow()
    expect(() => parseAptSimulation('Inst <script> (1 x)\n')).toThrow()
  })
  it('parses the dnf --assumeno transaction table including wrapped names', () => {
    const plan = parseDnfSimulation(dnfInstall)
    expect(plan.install.map(change => change.name)).toEqual(['memcached', 'libevent', 'java-21-openjdk-headless-fastdebug'])
    expect(plan.upgrade).toEqual([{ name: 'openssl', from: null, to: '1:3.2.2-6.el9_5' }])
    expect(plan.downloadBytes).toBe(50 * 1024 ** 2); expect(plan.sizeDeltaBytes).toBe(200 * 1024 ** 2)
    const removal = parseDnfSimulation(dnfRemove)
    expect(removal.remove.map(change => change.name)).toEqual(['memcached', 'libevent'])
    expect(removal.sizeDeltaBytes).toBe(-Math.round(1.3 * 1024 ** 2))
    expect(() => parseDnfSimulation(dnfInstall.replace('Upgrading:', 'Enabling module streams:'))).toThrow()
    expect(() => parseDnfSimulation('Dependencies resolved.\nOperation aborted.\n')).toThrow()
  })
})

describe('software center observation', () => {
  it('reports observed package state per component with a stable revision', async () => {
    const fake = host('debian', debianBase, {}, { candidates: { memcached: '1.6.24-1build3' } })
    const observed = await readSoftwareCenter({ family: 'debian', run: fake.run, now })
    expect(observed).toMatchObject({ state: 'read', family: 'debian', phpVersions: ['8.3'], candidates: 'read', observedAt: '2026-10-27T10:00:00.000Z' })
    const byId = new Map(observed.components.map(item => [item.id, item]))
    expect(byId.get('git')).toMatchObject({ state: 'installed', installed: [{ name: 'git', versions: ['1:2.43.0-1ubuntu7'] }] })
    expect(byId.get('memcached')).toMatchObject({ state: 'absent', candidates: [{ name: 'memcached', version: '1.6.24-1build3' }] })
    expect(byId.get('zip-tools')!.state).toBe('partial')
    expect(byId.get('nodejs')!.requiredBy).toEqual(['npm'])
    expect(byId.get('php83-redis')).toMatchObject({ page: 'module', state: 'absent', phpVersion: '8.3', packages: ['php8.3-redis'] })
    expect(byId.has('php82-redis')).toBe(false)
    expect(byId.get('python3-venv')!.state).toBe('absent')
    expect(observed.revision).toMatch(/^[0-9a-f]{64}$/)
    expect((await readSoftwareCenter({ family: 'debian', run: host('debian', { ...debianBase, unrelated: '1.0' }).run, now })).revision).toBe(observed.revision)
    expect((await readSoftwareCenter({ family: 'debian', run: host('debian', { ...debianBase, memcached: '1.6' }).run, now })).revision).not.toBe(observed.revision)
    expect(fake.calls.every(argv => ['/usr/bin/dpkg-query', '/usr/bin/apt-cache'].includes(argv[0]!) && argv.length <= 3 + 64)).toBe(true)
  })
  it('marks inconsistent package states for review and unread candidates truthfully', async () => {
    const observed = await readSoftwareCenter({ family: 'debian', run: host('debian', debianBase, {}, { dpkgExtra: 'memcached\t1.6.24\tinstall reinstreq half-installed\n', policy: { ok: false, code: 100, stdout: '' } }).run, now })
    const memcached = observed.components.find(item => item.id === 'memcached')!
    expect(memcached).toMatchObject({ state: 'partial', needsReview: true, candidates: null })
    expect(observed.candidates).toBe('unavailable')
  })
  it('is unavailable, never empty-installed, when the package database cannot be read', async () => {
    expect(await readSoftwareCenter({ family: null, run: null, now })).toMatchObject({ state: 'unavailable', reason: 'unsupported-host', components: [], revision: null })
    expect(await readSoftwareCenter({ family: 'debian', run: host('debian', {}, {}, { dpkg: { ok: false, code: 2, stdout: '' } }).run, now })).toMatchObject({ state: 'unavailable', reason: 'package-database-unavailable' })
    expect(await readSoftwareCenter({ family: 'debian', run: host('debian', {}, {}, { dpkg: { stdout: 'garbage line\n' } }).run, now })).toMatchObject({ state: 'unavailable', reason: 'invalid-package-database' })
    expect(await readSoftwareCenter({ family: 'debian', run: async () => { throw new Error('spawn') }, now })).toMatchObject({ state: 'unavailable', reason: 'package-database-unavailable' })
  })
  it('queries RHEL names in bounded rpm batches and derives Remi PHP versions', async () => {
    const fake = host('rhel', { nginx: '1.20.1-16.el9', 'php83-php-cli': '8.3.13-1.el9.remi', 'perl-DBI': '1.643-9.el9' })
    const observed = await readSoftwareCenter({ family: 'rhel', run: fake.run, now })
    expect(observed).toMatchObject({ state: 'read', phpVersions: ['8.3'], candidates: 'not-read' })
    expect(fake.calls.length).toBeGreaterThan(1)
    expect(fake.calls.every(argv => argv[0] === '/usr/bin/rpm' && argv.length - 5 <= 64)).toBe(true)
    const byId = new Map(observed.components.map(item => [item.id, item]))
    expect(byId.get('perl-dbi')!.state).toBe('installed')
    expect(byId.get('ffmpeg')!.state).toBe('unavailable')
    expect(byId.get('php83-apcu')!.packages).toEqual(['php83-php-pecl-apcu'])
    expect(byId.get('php83-redis')!.state).toBe('unavailable')
    expect(await readSoftwareCenter({ family: 'rhel', run: async () => ({ ok: false, code: null, stdout: '', stderr: '' }), now })).toMatchObject({ state: 'unavailable', reason: 'package-database-unavailable' })
  })
})

describe('software center previews', () => {
  const debian = async (simulations: Record<string, Result> = {}, installed = debianBase) => {
    const fake = host('debian', installed, simulations)
    return { fake, observed: await readSoftwareCenter({ family: 'debian', run: fake.run, now }) }
  }
  it('simulates an install and reports packages, estimates and observed sizes', async () => {
    const { fake, observed } = await debian({ 'install memcached': { stdout: aptInstallMemcached } })
    const preview = await previewComponentChange({ action: 'install', componentIds: ['memcached'], family: 'debian', run: fake.run, observed })
    expect(preview).toMatchObject({ state: 'ready', reason: null, requestedPackages: ['memcached'], resolvedComponentIds: ['memcached'], extraRemovals: [], extraRemovalsFingerprint: null, estimate: { memoryMb: 64, diskMb: 1 }, observed: { downloadBytes: 1234000, sizeDeltaBytes: 5678000 } })
    expect(preview.packages.install.map(change => change.name)).toEqual(['libevent-2.1-7t64', 'memcached'])
    expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(fake.calls.at(-1)).toEqual(['/usr/bin/apt-get', '-s', '-q', 'install', '--no-install-recommends', '--', 'memcached'])
  })
  it('pulls required components on install and flags protected upgrades', async () => {
    const installed = { ...debianBase }; delete installed.nodejs; delete installed.npm
    const { fake, observed } = await debian({ 'install nodejs npm': { stdout: 'Inst nodejs (18.19.1 Ubuntu:24.04/noble [amd64])\nInst npm (9.2.0 Ubuntu:24.04/noble [amd64])\nInst libc6 [2.39-0ubuntu8] (2.39-0ubuntu8.3 Ubuntu:24.04/noble-updates [amd64])\n' } }, installed)
    const preview = await previewComponentChange({ action: 'install', componentIds: ['npm'], family: 'debian', run: fake.run, observed })
    expect(preview).toMatchObject({ state: 'ready', resolvedComponentIds: ['nodejs', 'npm'], pulledComponentIds: ['nodejs'], requestedPackages: ['nodejs', 'npm'], protectedUpgrades: ['libc6'] })
  })
  it('flags extra removals with a fingerprint and refuses protected removals', async () => {
    const { fake, observed } = await debian({
      'remove libdbi-perl': { stdout: 'Remv libclass-dbi-perl [3.0.17-5]\nRemv libdbi-perl [1.643-4build3]\n' },
      'remove git': { stdout: 'Remv git [1:2.43.0-1ubuntu7]\nRemv nginx [1.24.0-2ubuntu7]\n' },
    })
    const extra = await previewComponentChange({ action: 'remove', componentIds: ['perl-dbi'], family: 'debian', run: fake.run, observed })
    expect(extra).toMatchObject({ state: 'ready', extraRemovals: ['libclass-dbi-perl'] })
    expect(extra.extraRemovalsFingerprint).toMatch(/^[0-9a-f]{64}$/)
    const guarded = await previewComponentChange({ action: 'remove', componentIds: ['git'], family: 'debian', run: fake.run, observed })
    expect(guarded).toMatchObject({ state: 'refused', reason: 'protected-package', blockers: ['nginx'] })
  })
  it('refuses removing a component another installed component requires, before simulating', async () => {
    const { fake, observed } = await debian()
    const preview = await previewComponentChange({ action: 'remove', componentIds: ['nodejs'], family: 'debian', run: fake.run, observed })
    expect(preview).toMatchObject({ state: 'refused', reason: 'required-by-installed', blockers: ['npm:nodejs'] })
    expect(fake.calls.some(argv => argv[0] === '/usr/bin/apt-get')).toBe(false)
    expect(await previewComponentChange({ action: 'remove', componentIds: ['nodejs', 'npm'], family: 'debian', run: host('debian', debianBase, { 'remove nodejs npm': { stdout: 'Remv npm [9.2.0~ds1-2]\nRemv nodejs [18.19.1+dfsg-6ubuntu5]\n' } }).run, observed })).toMatchObject({ state: 'ready', extraRemovals: [] })
  })
  it('reports truthful refusals for unknown, unavailable, no-op and failed simulations', async () => {
    const { fake, observed } = await debian({
      'install ffmpeg': { ok: false, code: 100, stdout: '', stderr: 'E: Unable to locate package ffmpeg' },
      'install htop': { ok: false, code: 100, stdout: '', stderr: 'E: Unable to correct problems, you have held broken packages.' },
      'install supervisor': { ok: false, code: null, stdout: '', stderr: '' },
      'install sqlite3': { stdout: 'Purg sqlite3 [1]\n' },
    })
    const preview = (action: 'install' | 'remove', id: string) => previewComponentChange({ action, componentIds: [id], family: 'debian', run: fake.run, observed })
    expect(await preview('install', 'php82-redis')).toMatchObject({ state: 'refused', reason: 'unknown-component' })
    expect(await preview('install', 'git')).toMatchObject({ state: 'refused', reason: 'nothing-to-do' })
    expect(await preview('remove', 'memcached')).toMatchObject({ state: 'refused', reason: 'nothing-to-do' })
    expect(await preview('install', 'ffmpeg')).toMatchObject({ state: 'refused', reason: 'package-not-found' })
    expect(await preview('install', 'htop')).toMatchObject({ state: 'refused', reason: 'dependency-problem' })
    expect(await preview('install', 'supervisor')).toMatchObject({ state: 'unavailable', reason: 'simulation-unavailable' })
    expect(await preview('install', 'sqlite')).toMatchObject({ state: 'unavailable', reason: 'invalid-simulation' })
    await expect(previewComponentChange({ action: 'install', componentIds: ['git', 'git'], family: 'debian', run: fake.run, observed })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(previewComponentChange({ action: 'purge' as 'install', componentIds: ['git'], family: 'debian', run: fake.run, observed })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('refuses catalog conflicts and RHEL-unavailable components', async () => {
    const fake = host('rhel', { 'php83-php-cli': '8.3.13-1.el9.remi' }, { 'install memcached': { ok: false, code: 1, stdout: dnfInstall, stderr: 'Error: Operation aborted.' }, 'remove memcached': { ok: false, code: 1, stdout: dnfRemove, stderr: 'Error: Operation aborted.' } })
    const observed = await readSoftwareCenter({ family: 'rhel', run: fake.run, now })
    expect(await previewComponentChange({ action: 'install', componentIds: ['ffmpeg'], family: 'rhel', run: fake.run, observed })).toMatchObject({ state: 'refused', reason: 'unavailable-on-this-os', blockers: ['ffmpeg'] })
    const ready = await previewComponentChange({ action: 'install', componentIds: ['memcached'], family: 'rhel', run: fake.run, observed })
    expect(ready).toMatchObject({ state: 'ready', protectedUpgrades: ['openssl'], observed: { downloadBytes: 50 * 1024 ** 2 } })
    const conflicting = { ...observed, components: observed.components.map(item => item.id === 'memcached' ? { ...item, conflicts: ['git'] } : item.id === 'git' ? { ...item, state: 'installed' as const } : item) }
    expect(await previewComponentChange({ action: 'install', componentIds: ['memcached'], family: 'rhel', run: fake.run, observed: conflicting })).toMatchObject({ state: 'refused', reason: 'conflict', blockers: ['memcached:git'] })
    const installed = host('rhel', { memcached: '1.6.9-7.el9', libevent: '2.1.12-6.el9' }, { 'remove memcached': { ok: false, code: 1, stdout: dnfRemove, stderr: 'Error: Operation aborted.' } })
    const after = await readSoftwareCenter({ family: 'rhel', run: installed.run, now })
    expect(await previewComponentChange({ action: 'remove', componentIds: ['memcached'], family: 'rhel', run: installed.run, observed: after })).toMatchObject({ state: 'ready', extraRemovals: ['libevent'], observed: { sizeDeltaBytes: -Math.round(1.3 * 1024 ** 2) } })
    const missing = host('rhel', {}, { 'install git': { ok: false, code: 1, stdout: 'No match for argument: git\n', stderr: 'Error: Unable to find a match: git' } })
    expect(await previewComponentChange({ action: 'install', componentIds: ['git'], family: 'rhel', run: missing.run, observed: await readSoftwareCenter({ family: 'rhel', run: missing.run, now }) })).toMatchObject({ state: 'refused', reason: 'package-not-found' })
  })
})

describe('software center job plans', () => {
  const ready = async () => {
    const fake = host('debian', debianBase, { 'install memcached': { stdout: aptInstallMemcached }, 'remove libdbi-perl': { stdout: 'Remv libclass-dbi-perl [3.0.17-5]\nRemv libdbi-perl [1.643-4build3]\n' } })
    const observed = await readSoftwareCenter({ family: 'debian', run: fake.run, now })
    return { fake, observed }
  }
  it('builds an exact reviewed install job whose policy admits only its own mutation and reads', async () => {
    const { fake, observed } = await ready()
    const preview = await previewComponentChange({ action: 'install', componentIds: ['memcached'], family: 'debian', run: fake.run, observed })
    const plan = buildComponentJobPlan({ action: 'install', componentIds: ['memcached'], family: 'debian', observedRevision: observed.revision!, preview, observed })
    expect(plan).toMatchObject({ kind: 'software.component.install', accountId: null, summary: 'Install Memcached', fingerprint: { observedRevision: observed.revision, previewFingerprint: preview.fingerprint } })
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]).toMatchObject({ id: 'install-packages', mutates: true, env: { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l' } })
    expect(plan.steps[0]!.argv).toEqual(['/usr/bin/apt-get', 'install', '-y', '-q', '--no-install-recommends', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', '--', 'memcached'])
    expect(plan.policy(plan.steps[0]!.argv)).toBe(true)
    expect(plan.policy(['/usr/bin/dpkg-query', '-W', '-f=${Package}\t${Version}\t${Status}\n'])).toBe(true)
    expect(plan.policy(['/usr/bin/apt-get', 'install', '-y', '-q', '--no-install-recommends', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', '--', 'git'])).toBe(false)
    expect(plan.policy(['/usr/bin/apt-get', 'remove', '-y', '-q', '--', 'memcached'])).toBe(false)
    expect(plan.policy(['/usr/bin/apt-get', '-s', '-q', 'install', '--no-install-recommends', '--', 'memcached'])).toBe(false)
  })
  it('succeeds only when a re-read proves the target state and nothing else was removed', async () => {
    const { fake, observed } = await ready()
    const preview = await previewComponentChange({ action: 'install', componentIds: ['memcached'], family: 'debian', run: fake.run, observed })
    const plan = buildComponentJobPlan({ action: 'install', componentIds: ['memcached'], family: 'debian', observedRevision: observed.revision!, preview, observed })
    const reread = (packages: Record<string, string>) => async () => ({ ok: true, code: 0, stdout: dpkgList(packages), stderr: '', timedOut: false })
    expect(await plan.verify!(reread({ ...debianBase, memcached: '1.6.24-1build3', 'libevent-2.1-7t64': '2.1.12' }))).toMatchObject({ ok: true, detail: { target: 'installed', components: { memcached: 'installed' } } })
    expect(await plan.verify!(reread(debianBase))).toMatchObject({ ok: false, detail: { components: { memcached: 'absent' } } })
    const withoutNginx: Record<string, string> = { ...debianBase, memcached: '1.6' }; delete withoutNginx.nginx
    expect(await plan.verify!(reread(withoutNginx))).toMatchObject({ ok: false, detail: { protectedMissing: ['nginx'], unexpectedRemovals: ['nginx'] } })
    const withoutGit: Record<string, string> = { ...debianBase, memcached: '1.6' }; delete withoutGit.git
    expect(await plan.verify!(reread(withoutGit))).toMatchObject({ ok: false, detail: { unexpectedRemovals: ['git'], protectedMissing: [] } })
    expect(await plan.verify!(async () => ({ ok: false, code: 2, stdout: '', stderr: '', timedOut: false }))).toMatchObject({ ok: false, detail: { reason: 'package-database-unavailable' } })
  })
  it('requires the exact extra-removal fingerprint and an unchanged revision', async () => {
    const { fake, observed } = await ready()
    const preview = await previewComponentChange({ action: 'remove', componentIds: ['perl-dbi'], family: 'debian', run: fake.run, observed })
    const input = { action: 'remove' as const, componentIds: ['perl-dbi'], family: 'debian' as const, observedRevision: observed.revision!, preview, observed }
    expect(() => buildComponentJobPlan(input)).toThrow(expect.objectContaining({ code: 'CONFLICT', detail: expect.objectContaining({ extraRemovals: ['libclass-dbi-perl'] }) }))
    expect(() => buildComponentJobPlan({ ...input, acceptExtraRemovals: 'f'.repeat(64) })).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    expect(() => buildComponentJobPlan({ ...input, observedRevision: 'a'.repeat(64) })).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    const plan = buildComponentJobPlan({ ...input, acceptExtraRemovals: preview.extraRemovalsFingerprint! })
    expect(plan.steps[0]!.argv).toEqual(['/usr/bin/apt-get', 'remove', '-y', '-q', '--', 'libdbi-perl'])
    const removed = { ...debianBase }; delete removed['libdbi-perl']; delete removed['libclass-dbi-perl']
    expect(await plan.verify!(async () => ({ ok: true, code: 0, stdout: dpkgList(removed), stderr: '', timedOut: false }))).toMatchObject({ ok: true, detail: { target: 'absent', components: { 'perl-dbi': 'absent' } } })
  })
  it('never builds a job from a refused preview or for packages outside the catalog', async () => {
    const { fake, observed } = await ready()
    const refused = await previewComponentChange({ action: 'install', componentIds: ['git'], family: 'debian', run: fake.run, observed })
    expect(() => buildComponentJobPlan({ action: 'install', componentIds: ['git'], family: 'debian', observedRevision: observed.revision!, preview: refused, observed })).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    const preview = await previewComponentChange({ action: 'install', componentIds: ['memcached'], family: 'debian', run: fake.run, observed })
    expect(() => buildComponentJobPlan({ action: 'install', componentIds: ['memcached'], family: 'debian', observedRevision: observed.revision!, preview: { ...preview, requestedPackages: ['nginx'] }, observed })).toThrow(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
    expect(() => buildComponentJobPlan({ action: 'install', componentIds: ['memcached'], family: 'debian', observedRevision: observed.revision!, preview: { ...preview, requestedPackages: ['evil-package'] }, observed })).toThrow(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
  })
})
