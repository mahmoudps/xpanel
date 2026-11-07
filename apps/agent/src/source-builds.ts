import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fail } from '@xpanel/core'
import { system } from '@xpanel/render'
import { SOURCE_BUILD_PACKAGES_ARGV, sourceBuildArgv } from '../../../packages/os/src/source-build-command.ts'
import type { SourceBuildModule } from '../../../packages/os/src/source-build-command.ts'
import { MAILFX_FTS_PLUGINS } from './mailfx-render.ts'
import { AWSTATS_BINARIES, WEBALIZER_CHECK_ARGV, awstatsCheckArgv } from './web-stats-format.ts'

/** Past the unit's own 30-minute bound, so the unit decides. */
export const SOURCE_BUILD_TIMEOUT_MS = 1_860_000
/** A failed rebuild retries at this pace, and a host without the dnf plugin still notices an update. */
export const SOURCE_BUILD_CHECK_MS = 6 * 3_600_000

export type SourceBuildState = 'current' | 'stale' | 'rebuilding' | 'rebuild_failed'
export interface SourceBuildRow { id: SourceBuildModule; state: SourceBuildState; builtAgainst: string | null; installed: string | null; failedAt: string | null }
export interface SourceBuildsView { hook: boolean; modules: SourceBuildRow[] }
type Run = (argv: string[]) => Promise<{ ok: boolean; stdout?: string }>
export interface SourceBuildPaths { dir: string; marker: string; hook: string; plugin: string; script: string }

const PATHS: SourceBuildPaths = { dir: system.SOURCE_BUILD_DIR, marker: system.SOURCE_BUILD_MARKER, hook: system.SOURCE_BUILD_HOOK, plugin: MAILFX_FTS_PLUGINS[1],
  script: fileURLToPath(new URL('../../../scripts/el-source-builds.sh', import.meta.url)) }
// A version-bound module is compared with its package; the other two have no ABI, so running them is the check.
const MODULES: readonly { id: SourceBuildModule; package?: string; runs?: (run: Run) => Promise<boolean> }[] = [
  { id: 'mpm-itk', package: 'httpd' },
  { id: 'fts-xapian', package: 'dovecot' },
  // -V exits 1 by design, so only its output proves the binary loads.
  { id: 'webalizer', runs: run => run([...WEBALIZER_CHECK_ARGV]).then(result => result.stdout?.startsWith('Webalizer V') === true, () => false) },
  { id: 'awstats', runs: run => run(awstatsCheckArgv(AWSTATS_BINARIES[1])).then(result => result.ok, () => false) },
]
const readText = (path: string): Promise<string | null> => readFile(path, 'utf8').then(text => text.trim(), () => null)
let rebuilding: SourceBuildModule | null = null

/** Installed package versions against what each build recorded; a module the host never built has no record and no row. */
export async function observeSourceBuilds(run: Run, paths: SourceBuildPaths = PATHS): Promise<SourceBuildsView> {
  const built = await Promise.all(MODULES.map(async module => ({ ...module, stamp: await readText(join(paths.dir, module.id)) })))
  const modules: SourceBuildRow[] = [], hook = existsSync(paths.hook)
  if (built.every(module => module.stamp === null)) return { hook, modules }
  const listed = await run([...SOURCE_BUILD_PACKAGES_ARGV]).catch(() => null)
  const installed = new Map([...(listed?.stdout ?? '').matchAll(/^(httpd|dovecot) (\S+)$/gm)].map(match => [match[1]!, match[2]!]))
  // httpd is on every EL host: an empty answer is an unreadable database, and acting on it would retire a working plugin.
  if (!installed.size) return fail('SERVICE_UNAVAILABLE', 'the installed package versions could not be read', { stateChanged: false, reason: 'package_versions_unreadable' })
  for (const { id, package: name, runs, stamp } of built) {
    const version = name ? installed.get(name) : undefined
    if (stamp === null || name && version === undefined) continue
    const stale = runs ? !await runs(run) : version !== stamp
    const failedAt = stale ? await readText(join(paths.dir, `${id}.failed`)) : null
    modules.push({ id, state: rebuilding === id ? 'rebuilding' : !stale ? 'current' : failedAt ? 'rebuild_failed' : 'stale', builtAgainst: stamp || null, installed: version ?? null, failedAt })
  }
  return { hook, modules }
}

export interface SourceBuildDeps {
  run: Run
  /** Rewrites the Dovecot configuration from what is on disk. */
  reconcile: () => Promise<unknown>
  audit: (entry: { actor: 'system'; action: 'server.source_build.rebuild'; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed' }) => Promise<unknown>
  admit: <T>(work: () => Promise<T>) => Promise<T>
  onError: (error: unknown) => void
  paths?: SourceBuildPaths
  now?: () => Date
}

/** Called from the agent's minute timer: acts on the dnf hook's marker, at agent start and every check interval. */
export function createSourceBuilds(deps: SourceBuildDeps): { tick: () => Promise<void> } {
  const paths = deps.paths ?? PATHS, now = deps.now ?? (() => new Date()), apply = (): Promise<unknown> => deps.reconcile().catch(deps.onError)
  let running = false, nextCheckAt = 0
  const repair = async (row: SourceBuildRow): Promise<void> => {
    const fts = row.id === 'fts-xapian', failed = join(paths.dir, `${row.id}.failed`)
    rebuilding = row.id
    try {
      // Dovecot refuses every login that names a plugin of another ABI, so mail comes back without search before the build starts.
      if (fts && existsSync(paths.plugin)) { await deps.admit(() => rm(paths.plugin, { force: true })); await apply() }
      const built = await deps.run(sourceBuildArgv(paths.script, row.id)).then(result => result.ok, () => false)
      rebuilding = null
      const fixed = built && (await observeSourceBuilds(deps.run, paths)).modules.find(module => module.id === row.id)?.state === 'current'
      await deps.admit(() => fixed ? rm(failed, { force: true }) : writeFile(failed, `${now().toISOString()}\n`, { mode: 0o644 }))
      await deps.audit({ actor: 'system', action: 'server.source_build.rebuild', target: `source_build:${row.id}`, detail: { builtAgainst: row.builtAgainst, installed: row.installed }, outcome: fixed ? 'ok' : 'failed' }).catch(deps.onError)
      if (fts && fixed) await apply()
    } finally { rebuilding = null }
  }
  return {
    tick: async () => {
      if (running || now().getTime() < nextCheckAt && !existsSync(paths.marker)) return
      running = true
      try {
        // Removed before the read: an update landing during this run leaves a new marker for the next tick.
        await deps.admit(() => rm(paths.marker, { force: true }))
        nextCheckAt = now().getTime() + SOURCE_BUILD_CHECK_MS
        for (const row of (await observeSourceBuilds(deps.run, paths)).modules) if (row.state !== 'current') await repair(row)
      } catch (error) { deps.onError(error) } finally { running = false }
    },
  }
}
