import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import type { RenderedFile } from '@xpanel/core'
import { profileFor, releaseFeatures } from '@xpanel/os'
import type { XpanelOsProfile } from '@xpanel/os'
import { ALMA_9, ALMA_10, UBUNTU_2404 } from '../../../packages/os/src/fixtures.ts'
import { HostJobRunner } from './host-jobs.ts'
import type { HostJobCommandResult, HostJobView } from './host-job-contract.ts'
import type { PackageSafety } from './ops-package-writers.ts'
import { createReleasePackages, handleReleasePackagesRoute, RELEASE_INSTALLER } from './release-packages.ts'
import type { ReleasePackagesDeps, ReleasePackagesView } from './release-packages.ts'

const handles: TestDbHandle[] = [], dirs: string[] = [], runners: HostJobRunner[] = []
afterEach(async () => {
  for (const runner of runners.splice(0)) runner.close()
  await Promise.all(handles.splice(0).map(handle => handle.close()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const ok = (stdout = ''): HostJobCommandResult => ({ ok: true, code: 0, stdout, stderr: '', timedOut: false })
const CLEAN: PackageSafety = { state: 'read', writers: [], database: 'clean' }
const everyHost = (os: XpanelOsProfile): string[] => releaseFeatures(os).filter(feature => !feature.selectedBy.length || feature.id === 'php-8.3').flatMap(feature => feature.packages)

/** A package database and file system: `unavailable` packages make their transaction fail, as a repository without them does. */
const host = (os: XpanelOsProfile, input: { absent: readonly string[]; extra?: readonly string[]; unavailable?: readonly string[]; files?: readonly string[] }) => {
  const installed = new Set([...everyHost(os), ...(input.extra ?? [])].filter(name => !input.absent.includes(name)))
  const files = new Map<string, string>((input.files ?? []).map(path => [path, 'stock'])), ran: string[][] = [], unavailable = [...(input.unavailable ?? [])]
  const run = async (argv: readonly string[]): Promise<HostJobCommandResult> => {
    ran.push([...argv])
    if (argv[0] === '/usr/bin/dpkg-query') return ok([...installed].map(name => `${name}\t1.0\tinstall ok installed`).join('\n') + '\n')
    if (argv[0] === '/usr/bin/rpm') {
      const names = argv.slice(argv.indexOf('--') + 1)
      return { ...ok(names.map(name => installed.has(name) ? `${name}\t1.0-1` : `package ${name} is not installed`).join('\n') + '\n'), ok: names.every(name => installed.has(name)), code: names.every(name => installed.has(name)) ? 0 : 1 }
    }
    if (argv.includes('install') && argv.includes('--')) {
      const names = argv.slice(argv.indexOf('--') + 1)
      if (names.some(name => unavailable.includes(name))) return { ok: false, code: os.family === 'debian' ? 100 : 1, stdout: '', stderr: 'no candidate', timedOut: false }
      for (const name of names) installed.add(name)
      return ok()
    }
    if (argv[1] === RELEASE_INSTALLER) { for (const feature of releaseFeatures(os)) for (const build of feature.builds) if (argv[2] === `--el-source-build=${build.id}`) files.set(build.path, 'built'); return ok() }
    return ok()
  }
  return { installed, files, ran, unavailable, run }
}

const setup = async (os: XpanelOsProfile, world: ReturnType<typeof host>, overrides: Partial<ReleasePackagesDeps> = {}) => {
  const handle = handles.at(-1) ?? await createTestDb()
  if (!handles.includes(handle)) handles.push(handle)
  const logDir = dirs.at(-1) ?? await mkdtemp(join(tmpdir(), 'xpanel-release-packages-'))
  if (!dirs.includes(logDir)) dirs.push(logDir)
  const runner = new HostJobRunner({ db: handle.db, run: argv => world.run(argv), logDir })
  runners.push(runner)
  const audit = vi.fn(async () => undefined), reconcile = vi.fn(async () => undefined), written: RenderedFile[] = []
  const packages = createReleasePackages({
    version: '1.2.3', profile: os, run: argv => world.run(argv), exists: async path => world.files.has(path), readFile: async path => world.files.get(path) ?? null,
    writeFile: async file => { written.push(file); world.files.set(file.path, file.content) }, safety: async () => CLEAN, jobs: runner, reconcile, audit, admit: work => work(), ...overrides,
  })
  return { packages, runner, audit, reconcile, written }
}
const row = (view: ReleasePackagesView, id: string) => view.features.find(feature => feature.id === id)
const job = async (runner: HostJobRunner): Promise<HostJobView> => { await runner.idle(); return (await runner.list({ kindPrefix: 'system.packages.release' }))[0]! }
const ubuntu = profileFor(UBUNTU_2404)
const NEW_PACKAGES = ['python3-radicale', 'awstats', 'libgeoip2-perl']

describe('report per feature', () => {
  it('names what is missing, and leaves options the installer did not choose out of it', async () => {
    const { packages } = await setup(ubuntu, host(ubuntu, { absent: NEW_PACKAGES }))
    const view = await packages.read()
    expect(view).toMatchObject({ state: 'read', summary: 'missing', release: '1.2.3', jobStatus: 'none', revision: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(row(view, 'calendars')).toEqual({ id: 'calendars', state: 'missing', missing: ['python3-radicale'] })
    expect(row(view, 'web-stats')).toEqual({ id: 'web-stats', state: 'missing', missing: ['awstats', 'libgeoip2-perl'] })
    expect(row(view, 'web-server')).toMatchObject({ state: 'complete', missing: [] })
    expect(row(view, 'php-8.3')).toMatchObject({ state: 'complete' })
    for (const id of ['mail', 'dns', 'ftp', 'mariadb', 'modsecurity', 'php-7.4']) expect(row(view, id)).toMatchObject({ state: 'not-selected', missing: [] })
  })
  it('finds the rest of an option once its main package is on the host', async () => {
    const { packages } = await setup(ubuntu, host(ubuntu, { absent: [], extra: ['postfix', 'opendkim', 'dovecot-core'] }))
    expect(row(await packages.read(), 'mail')).toMatchObject({ state: 'missing', missing: expect.arrayContaining(['dovecot-fts-xapian', 'dovecot-sieve']) })
  })
  it('does not call a host with postfix alone a mail server', async () => {
    const { packages } = await setup(ubuntu, host(ubuntu, { absent: [], extra: ['postfix'] }))
    expect(row(await packages.read(), 'mail')).toMatchObject({ state: 'not-selected' })
  })
  it('reads an unsupported host and a broken package database as unavailable, never as complete', async () => {
    const world = host(ubuntu, { absent: [] })
    expect(await (await setup(ubuntu, world, { profile: null })).packages.read()).toMatchObject({ state: 'unavailable', summary: 'unsupported-host', features: [], revision: null })
    expect(await (await setup(ubuntu, world, { version: null })).packages.read()).toMatchObject({ state: 'unavailable', summary: 'unsupported-host' })
    const broken = async (): Promise<HostJobCommandResult> => ({ ok: false, code: 2, stdout: '', stderr: 'locked', timedOut: false })
    expect(await (await setup(ubuntu, world, { run: broken })).packages.read()).toMatchObject({ state: 'unavailable', summary: 'package-database-unavailable' })
    expect(await (await setup(ubuntu, world, { run: async () => ok('garbage\n') })).packages.read()).toMatchObject({ state: 'unavailable', summary: 'invalid-package-database' })
  })
})

describe('automatic job after the switch', () => {
  it('installs what is missing once, reconciles, audits as the system actor and turns the distribution daemon off', async () => {
    const world = host(ubuntu, { absent: [...NEW_PACKAGES, 'lighttpd', 'lighttpd-mod-webdav'] })
    const { packages, runner, audit, reconcile } = await setup(ubuntu, world)
    await packages.tick()
    const finished = await job(runner)
    expect(finished).toMatchObject({ kind: 'system.packages.release:1.2.3', status: 'succeeded', actor: 'system:release-packages', verification: { ok: true, detail: { verification: { missing: {}, reconcile: 'applied' } } } })
    expect(finished.steps.map(step => step.id)).toEqual(['refresh-lists', 'install-web-stats', 'install-web-disk', 'install-calendars', 'stop-lighttpd', 'disable-lighttpd'])
    expect(finished.steps.every(step => step.state === 'succeeded')).toBe(true)
    expect(world.ran).toContainEqual(['/usr/bin/apt-get', 'install', '-y', '-q', '--no-install-recommends', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', '--', 'python3-radicale'])
    expect(world.ran).toContainEqual(['/usr/bin/systemctl', 'disable', 'lighttpd'])
    expect(reconcile).toHaveBeenCalledOnce()
    expect(audit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actor: 'system:release-packages', action: 'upgrade.packages_queued', target: 'release:1.2.3', detail: { jobId: finished.id, features: ['web-stats', 'web-disk', 'calendars'] } }))
    expect((await packages.read()).summary).toBe('complete')
    await packages.tick()
    expect(await runner.list({ kindPrefix: 'system.packages.release' })).toHaveLength(1)
  })
  it('submits nothing on a host that already has the declared set', async () => {
    const world = host(ubuntu, { absent: [] }), { packages, runner, audit } = await setup(ubuntu, world)
    await packages.tick(); world.ran.length = 0; await packages.tick()
    expect(await runner.list({ kindPrefix: 'system.packages.release' })).toEqual([])
    expect(audit).not.toHaveBeenCalled(); expect(world.ran).toEqual([])
  })
  it('keeps going past a package the repositories lack and reports exactly that feature', async () => {
    const world = host(ubuntu, { absent: NEW_PACKAGES, unavailable: ['python3-radicale'] })
    const { packages, runner } = await setup(ubuntu, world)
    await packages.tick()
    expect(await job(runner)).toMatchObject({ status: 'failed', verification: { ok: false, detail: { verification: { missing: { calendars: ['python3-radicale'] }, reconcile: 'applied' } } } })
    const view = await packages.read()
    expect(world.installed.has('awstats')).toBe(true)
    expect(view).toMatchObject({ summary: 'missing', jobStatus: 'failed' })
    expect(row(view, 'web-stats')).toMatchObject({ state: 'complete' })
    expect(row(view, 'calendars')).toMatchObject({ state: 'missing', missing: ['python3-radicale'] })
  })
  it('spends one attempt per release: a failed job waits for the operator across agent restarts, a new release tries again', async () => {
    const world = host(ubuntu, { absent: ['python3-radicale'], unavailable: ['python3-radicale'] })
    const first = await setup(ubuntu, world)
    await first.packages.tick(); await first.runner.idle()
    const restarted = await setup(ubuntu, world)
    await restarted.packages.tick(); await restarted.runner.idle()
    expect(await restarted.runner.list({ kindPrefix: 'system.packages.release' })).toHaveLength(1)
    const next = await setup(ubuntu, world, { version: '1.2.4' })
    await next.packages.tick(); await next.runner.idle()
    expect((await next.runner.list({ kindPrefix: 'system.packages.release' })).map(item => item.kind).sort()).toEqual(['system.packages.release:1.2.3', 'system.packages.release:1.2.4'])
  })
  it('waits for a competing package manager instead of failing its one attempt', async () => {
    const busy: PackageSafety = { state: 'read', writers: [{ pid: 7, command: 'unattended-upgr' }], database: 'clean' }
    const safety = vi.fn(async () => busy), world = host(ubuntu, { absent: ['awstats'] })
    const { packages, runner } = await setup(ubuntu, world, { safety })
    await packages.tick()
    expect(await runner.list({ kindPrefix: 'system.packages.release' })).toEqual([])
    safety.mockImplementation(async () => CLEAN)
    await packages.tick()
    expect((await job(runner)).status).toBe('succeeded')
  })
  it('stops at a package manager that appears between features, leaving the rest to the operator', async () => {
    const busy: PackageSafety = { state: 'read', writers: [{ pid: 7, command: 'apt' }], database: 'clean' }
    let answers = 0
    const safety = vi.fn(async () => ++answers > 2 ? busy : CLEAN)
    const { packages, runner } = await setup(ubuntu, host(ubuntu, { absent: NEW_PACKAGES }), { safety })
    await packages.tick()
    expect((await job(runner)).status).toBe('failed')
    expect((await packages.read()).summary).toBe('missing')
  })
  it('never turns a failed tick into a rejected timer, and tries again', async () => {
    const reads = vi.fn(async (): Promise<HostJobCommandResult> => { throw new Error('host gone') })
    const { packages } = await setup(ubuntu, host(ubuntu, { absent: ['awstats'] }), { readFile: async () => { throw new Error('host gone') }, run: reads })
    await expect(packages.tick()).resolves.toBeUndefined()
    await expect(packages.tick()).resolves.toBeUndefined()
  })
  it('holds writer admission only to queue the job, never while it runs', async () => {
    let admitted = 0, release = (): void => {}
    const world = host(ubuntu, { absent: ['awstats'] }), packageManager = world.run, stuck = new Promise<void>(resolve => { release = resolve })
    world.run = async argv => { if (argv.includes('awstats')) await stuck; return packageManager(argv) }
    const { packages, runner } = await setup(ubuntu, world, { admit: async work => { admitted++; try { return await work() } finally { admitted-- } } })
    await packages.tick()
    expect(admitted).toBe(0)
    expect((await packages.read()).summary).toBe('job-active')
    release()
    expect((await job(runner)).status).toBe('succeeded')
  })
  it('counts a failed reconcile as a failed job without losing the installed packages', async () => {
    const world = host(ubuntu, { absent: ['awstats'] })
    const { packages, runner } = await setup(ubuntu, world, { reconcile: async () => { throw new Error('generation refused') } })
    await packages.tick()
    expect(await job(runner)).toMatchObject({ status: 'failed', verification: { detail: { verification: { missing: {}, reconcile: 'failed' } } } })
    expect(world.installed.has('awstats')).toBe(true)
  })
})

describe('EL hosts', () => {
  const alma10 = profileFor(ALMA_10), alma9 = profileFor(ALMA_9)
  it('runs the pinned source builds after their inputs and reports a build that failed by feature', async () => {
    const world = host(alma10, { absent: ['perl-GeoIP2'], files: [] })
    const original = world.run
    world.run = async argv => argv[2] === '--el-source-build=webalizer' ? { ok: false, code: 1, stdout: '', stderr: 'ERROR: Webalizer could not be fetched', timedOut: false } : original(argv)
    const { packages, runner } = await setup(alma10, world)
    await packages.tick()
    const finished = await job(runner)
    expect(finished.steps.map(step => step.id)).toEqual(['install-web-stats', 'build-webalizer', 'build-awstats'])
    expect(world.ran).toContainEqual(['/bin/bash', RELEASE_INSTALLER, '--el-source-build=awstats'])
    expect(finished).toMatchObject({ status: 'failed', verification: { detail: { verification: { missing: { 'web-stats': ['webalizer'] } } } } })
  })
  it('counts a built component as installed', async () => {
    const paths = releaseFeatures(alma10).flatMap(feature => feature.builds.map(build => build.path))
    const { packages } = await setup(alma10, host(alma10, { absent: [], files: paths }))
    expect((await packages.read()).summary).toBe('complete')
  })
  it('writes the closed awstats site before and after the RPM can bring the stock one', async () => {
    const paths = releaseFeatures(alma9).flatMap(feature => feature.builds.map(build => build.path))
    const world = host(alma9, { absent: ['awstats'], files: [...paths, '/etc/httpd/conf.d/awstats.conf'] })
    const { packages, runner, written } = await setup(alma9, world)
    await packages.tick()
    expect(written.map(file => file.path)).toEqual(['/etc/httpd/conf.d/awstats.conf'])
    world.files.set('/etc/httpd/conf.d/awstats.conf', 'Require local')
    await runner.idle()
    expect(world.files.get('/etc/httpd/conf.d/awstats.conf')).toContain('not published')
  })
  it('leaves Ubuntu Apache configuration alone', async () => {
    const { packages, written } = await setup(ubuntu, host(ubuntu, { absent: [] }))
    await packages.tick()
    expect(written).toEqual([])
  })
})

describe('operator retry', () => {
  const assertCurrent = async () => ({ actor: 'root' })
  const failedJob = async () => {
    const world = host(ubuntu, { absent: ['python3-radicale'], unavailable: ['python3-radicale'] })
    const context = await setup(ubuntu, world)
    await context.packages.tick(); await context.runner.idle()
    return { ...context, world }
  }
  it('queues a new job as the operator after the repository recovers', async () => {
    const { packages, runner, world, audit } = await failedJob()
    world.unavailable.length = 0
    const accepted = await packages.retry((await packages.read()).revision!, assertCurrent)
    expect(accepted.status).toMatch(/queued|running/)
    expect((await job(runner)).status).toBe('succeeded')
    expect(await runner.list({ kindPrefix: 'system.packages.release' })).toHaveLength(2)
    expect((await packages.read()).summary).toBe('complete')
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ actor: 'root', action: 'upgrade.packages_queued' }))
  })
  it('refuses a stale revision, an active job, a complete host and a busy package manager with nothing changed', async () => {
    const { packages } = await failedJob()
    await expect(packages.retry('a'.repeat(64), assertCurrent)).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    const complete = await setup(ubuntu, host(ubuntu, { absent: [] }))
    await expect(complete.packages.retry((await complete.packages.read()).revision!, assertCurrent)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'nothing-missing' } })
    const busy = await setup(ubuntu, host(ubuntu, { absent: ['awstats'] }), { safety: async () => ({ state: 'read', writers: [{ pid: 7, command: 'dpkg' }], database: 'clean' }) })
    await expect(busy.packages.retry((await busy.packages.read()).revision!, assertCurrent)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'competing-package-writer', stateChanged: false } })
    const unavailable = await setup(ubuntu, host(ubuntu, { absent: [] }), { jobs: null })
    await expect(unavailable.packages.retry('a'.repeat(64), assertCurrent)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('re-checks authority just before submitting', async () => {
    const { packages, runner } = await failedJob()
    await expect(packages.retry((await packages.read()).revision!, async () => { throw new Error('authority changed') })).rejects.toThrow('authority changed')
    expect(await runner.list({ kindPrefix: 'system.packages.release' })).toHaveLength(1)
  })
})

describe('agent routes', () => {
  const route = (path: string, method = 'GET', body?: string, packages: Parameters<typeof handleReleasePackagesRoute>[3]['packages'] = stub) =>
    handleReleasePackagesRoute(new Request('http://agent' + path, { method, ...(body === undefined ? {} : { body }) }), new URL('http://agent' + path), method, { assertRoot, packages })
  const assertRoot = vi.fn(async () => ({ actor: 'root' }))
  const stub = { read: vi.fn(async () => ({ state: 'read' }) as ReleasePackagesView), retry: vi.fn(async () => ({ id: 'job-1', status: 'queued' }) as HostJobView), tick: vi.fn() }
  const revision = 'a'.repeat(64)
  it('ignores other paths and refuses the wrong method, selectors, bad bodies and a missing composition', async () => {
    expect(await route('/host/upgrade')).toBeNull()
    expect((await route('/host/upgrade/packages', 'POST'))!.status).toBe(405)
    await expect(route('/host/upgrade/packages?x=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    for (const body of ['{}', 'nope', JSON.stringify({ expectedRevision: 'short' }), JSON.stringify({ expectedRevision: revision, extra: 1 })]) await expect(route('/host/upgrade/packages/retry', 'POST', body)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(route('/host/upgrade/packages', 'GET', undefined, null)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(stub.retry).not.toHaveBeenCalled()
  })
  it('reads and accepts a retry with a job id', async () => {
    expect(await (await route('/host/upgrade/packages'))!.json()).toEqual({ state: 'read' })
    const accepted = (await route('/host/upgrade/packages/retry', 'POST', JSON.stringify({ expectedRevision: revision })))!
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ job: { id: 'job-1', status: 'queued' } })
    expect(assertRoot).toHaveBeenCalledWith('host.upgrade.packages')
  })
})
