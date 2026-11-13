import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { suggestServerSettings } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { system } from '@xpanel/render'
import { createTestStateStore } from '@xpanel/state'
import { isSourceBuildCommand, SOURCE_BUILD_PACKAGES_ARGV } from '../../../packages/os/src/source-build-command.ts'
import { createProductionHostTargetMatcher } from './executor.ts'
import { compileDesiredGeneration } from './reconciler.ts'
import { createSourceBuilds, observeSourceBuilds, SOURCE_BUILD_CHECK_MS } from './source-builds.ts'
import type { SourceBuildPaths } from './source-builds.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const hostWith = async (stamps: Record<string, string>): Promise<SourceBuildPaths> => {
  const root = await mkdtemp(join(tmpdir(), 'xpanel-source-builds-')); roots.push(root)
  const dir = join(root, 'source-builds')
  await mkdir(dir)
  for (const [id, version] of Object.entries(stamps)) await writeFile(join(dir, id), `${version}\n`)
  return { dir, marker: join(dir, 'update-seen'), hook: join(root, 'hook.action'), plugin: join(root, 'plugin.so'), script: '/opt/xpanel/scripts/el-source-builds.sh' }
}
const packages = (httpd: string, dovecot: string | null = null) => ({ ok: dovecot !== null, stdout: `httpd ${httpd}\n${dovecot === null ? 'package dovecot is not installed' : `dovecot ${dovecot}`}\n` })
const isBuild = (argv: string[]): boolean => argv[0] === '/usr/bin/systemd-run'

/** A host whose rpm answers `installed`; `build` stands for the script, which writes the stamp on success. */
const scenario = async (paths: SourceBuildPaths, installed: () => { ok: boolean; stdout: string }, build: (module: string) => Promise<boolean>, reconcileFails = false) => {
  const events: string[] = [], audits: { target: string; outcome: string }[] = [], errors: unknown[] = []
  let at = 1_000_000
  const builds = createSourceBuilds({ paths, now: () => new Date(at),
    run: async argv => {
      expect(isSourceBuildCommand(argv) || argv[0] === '/usr/bin/perl' || argv[1] === '-V').toBe(true)
      if (isBuild(argv)) { const module = argv.at(-1)!; events.push(`build:${module}`); return { ok: await build(module) } }
      if (argv[0] === SOURCE_BUILD_PACKAGES_ARGV[0]) return installed()
      return { ok: false }
    },
    reconcile: async () => { events.push(`reconcile:${existsSync(paths.plugin) ? 'plugin' : 'no-plugin'}`); if (reconcileFails) throw new Error('reconcile failed') },
    audit: async entry => { audits.push({ target: entry.target, outcome: entry.outcome }) },
    admit: work => work(), onError: error => { errors.push(error) } })
  return { builds, events, audits, errors, advance: (ms: number) => { at += ms } }
}

describe('source build state', { tags: ['feature'] }, () => {
  it('compares each build with its package and leaves out what the host never built', async () => {
    const paths = await hostWith({ 'mpm-itk': '2.4.62', 'fts-xapian': '2.3.16' })
    const view = await observeSourceBuilds(async () => packages('2.4.63', '2.3.16'), paths)
    expect(view).toEqual({ hook: false, modules: [
      { id: 'mpm-itk', state: 'stale', builtAgainst: '2.4.62', installed: '2.4.63', failedAt: null },
      { id: 'fts-xapian', state: 'current', builtAgainst: '2.3.16', installed: '2.3.16', failedAt: null },
    ] })
  })

  it('says a failed rebuild failed, and forgets the failure once the versions match again', async () => {
    const paths = await hostWith({ 'mpm-itk': '2.4.62' })
    await writeFile(join(paths.dir, 'mpm-itk.failed'), '2026-11-07T10:00:00.000Z\n')
    expect((await observeSourceBuilds(async () => packages('2.4.63'), paths)).modules[0]).toMatchObject({ state: 'rebuild_failed', failedAt: '2026-11-07T10:00:00.000Z' })
    expect((await observeSourceBuilds(async () => packages('2.4.62'), paths)).modules[0]).toMatchObject({ state: 'current', failedAt: null })
  })

  it('checks Webalizer and AWStats by running them, because they have no ABI to compare', async () => {
    const paths = await hostWith({ webalizer: '', awstats: '' })
    const view = await observeSourceBuilds(async argv => argv[0] === SOURCE_BUILD_PACKAGES_ARGV[0] ? packages('2.4.62') : argv[1] === '-V' ? { ok: false, stdout: 'Webalizer V2.23-08' } : { ok: false }, paths)
    expect(view.modules.map(module => [module.id, module.state, module.builtAgainst])).toEqual([['webalizer', 'current', null], ['awstats', 'stale', null]])
  })

  it('leaves a module out when its package was removed, and never reads rpm on a host with no builds', async () => {
    const paths = await hostWith({ 'fts-xapian': '2.3.16' })
    expect((await observeSourceBuilds(async () => packages('2.4.62'), paths)).modules).toEqual([])
    const empty = await hostWith({})
    expect(await observeSourceBuilds(async () => { throw new Error('rpm read') }, empty)).toEqual({ hook: false, modules: [] })
  })

  it('refuses an unreadable package database with a stable reason instead of calling every build stale', async () => {
    const paths = await hostWith({ 'fts-xapian': '2.3.16' })
    for (const answer of [async () => ({ ok: false, stdout: '' }), async () => { throw new Error('no rpm') }]) await expect(observeSourceBuilds(answer, paths)).rejects.toMatchObject({ detail: { reason: 'package_versions_unreadable' } })
  })
})

describe('source rebuild after a package update', { tags: ['feature'] }, () => {
  it('takes the stale Dovecot plugin out of the configuration before it builds, and puts search back after', async () => {
    const paths = await hostWith({ 'fts-xapian': '2.3.16' })
    await writeFile(paths.plugin, 'old abi')
    const host = await scenario(paths, () => packages('2.4.62', '2.3.21'), async () => { await writeFile(paths.plugin, 'new abi'); await writeFile(join(paths.dir, 'fts-xapian'), '2.3.21\n'); return true })
    await host.builds.tick()
    expect(host.events).toEqual(['reconcile:no-plugin', 'build:fts-xapian', 'reconcile:plugin'])
    expect(host.audits).toEqual([{ target: 'source_build:fts-xapian', outcome: 'ok' }])
  })

  it('leaves mail running without search when the plugin rebuild fails, and reports it', async () => {
    const paths = await hostWith({ 'fts-xapian': '2.3.16' })
    await writeFile(paths.plugin, 'old abi')
    const host = await scenario(paths, () => packages('2.4.62', '2.3.21'), async () => false)
    await host.builds.tick()
    expect(host.events).toEqual(['reconcile:no-plugin', 'build:fts-xapian'])
    expect(existsSync(paths.plugin)).toBe(false)
    expect(host.audits).toEqual([{ target: 'source_build:fts-xapian', outcome: 'failed' }])
    expect((await observeSourceBuilds(async () => packages('2.4.62', '2.3.21'), paths)).modules[0]).toMatchObject({ state: 'rebuild_failed', builtAgainst: '2.3.16', installed: '2.3.21' })
  })

  it('counts a build that exits cleanly but left the version behind as failed', async () => {
    const paths = await hostWith({ 'mpm-itk': '2.4.62' })
    const host = await scenario(paths, () => packages('2.4.63'), async () => true)
    await host.builds.tick()
    expect(host.audits).toEqual([{ target: 'source_build:mpm-itk', outcome: 'failed' }])
    expect(await readFile(join(paths.dir, 'mpm-itk.failed'), 'utf8')).toBe('1970-01-01T00:16:40.000Z\n')
  })

  it('never touches Dovecot for an Apache rebuild, and clears an old failure when it works', async () => {
    const paths = await hostWith({ 'mpm-itk': '2.4.62' })
    await writeFile(join(paths.dir, 'mpm-itk.failed'), '2026-11-07T10:00:00.000Z\n')
    const host = await scenario(paths, () => packages('2.4.63'), async () => { await writeFile(join(paths.dir, 'mpm-itk'), '2.4.63\n'); return true })
    await host.builds.tick()
    expect(host.events).toEqual(['build:mpm-itk'])
    expect(existsSync(join(paths.dir, 'mpm-itk.failed'))).toBe(false)
  })

  it('checks at agent start, then only for the hook marker or the interval', async () => {
    const paths = await hostWith({ 'mpm-itk': '2.4.62' })
    let httpd = '2.4.62'
    const host = await scenario(paths, () => packages(httpd), async () => { await writeFile(join(paths.dir, 'mpm-itk'), `${httpd}\n`); return true })
    await host.builds.tick()
    expect(host.events).toEqual([])
    httpd = '2.4.63'
    await host.builds.tick()
    expect(host.events).toEqual([])
    await writeFile(paths.marker, '')
    await host.builds.tick()
    expect(host.events).toEqual(['build:mpm-itk'])
    expect(existsSync(paths.marker)).toBe(false)
    httpd = '2.4.64'
    host.advance(SOURCE_BUILD_CHECK_MS)
    await host.builds.tick()
    expect(host.events).toEqual(['build:mpm-itk', 'build:mpm-itk'])
  })

  it('retries a failed rebuild on the next interval, and leaves the plugin step out once it is gone', async () => {
    const paths = await hostWith({ 'fts-xapian': '2.3.16' })
    await writeFile(paths.plugin, 'old abi')
    const host = await scenario(paths, () => packages('2.4.62', '2.3.21'), async () => false)
    await host.builds.tick()
    host.advance(SOURCE_BUILD_CHECK_MS)
    await host.builds.tick()
    expect(host.events).toEqual(['reconcile:no-plugin', 'build:fts-xapian', 'build:fts-xapian'])
  })

  it('still builds when the reconcile fails, and reports it', async () => {
    const paths = await hostWith({ 'fts-xapian': '2.3.16' })
    await writeFile(paths.plugin, 'old abi')
    const host = await scenario(paths, () => packages('2.4.62', '2.3.21'), async () => false, true)
    await host.builds.tick()
    expect(host.events).toEqual(['reconcile:no-plugin', 'build:fts-xapian'])
    expect(host.errors).toHaveLength(1)
  })

  it('stops at an unreadable package database without retiring the plugin, and reports it', async () => {
    const paths = await hostWith({ 'fts-xapian': '2.3.16' })
    await writeFile(paths.plugin, 'old abi')
    const host = await scenario(paths, () => ({ ok: false, stdout: '' }), async () => true)
    await host.builds.tick()
    expect(host.events).toEqual([])
    expect(existsSync(paths.plugin)).toBe(true)
    expect(host.errors).toHaveLength(1)
  })
})

describe('source build hook', { tags: ['feature'] }, () => {
  it('renders only for a host whose plugin runs it, as an executor target', async () => {
    const state = await createTestStateStore()
    try {
      const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
      await state.store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
      const snapshot = await state.store.readSnapshot(), os = profileFor('ID=almalinux\nVERSION_ID="9.4"\n')
      expect(compileDesiredGeneration(snapshot, { os }).files.some(file => file.path === system.SOURCE_BUILD_HOOK)).toBe(false)
      expect(compileDesiredGeneration(snapshot, { os, sourceBuildHook: true }).files.some(file => file.path === system.SOURCE_BUILD_HOOK)).toBe(true)
      expect(createProductionHostTargetMatcher()(system.SOURCE_BUILD_HOOK, 'write')).toBe(true)
    } finally { await state.close() }
  })
})
