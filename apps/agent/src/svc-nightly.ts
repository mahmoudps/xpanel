import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { nightlyPackageCheck, updateLogRetentionDays } from '@xpanel/core'
import type { TweakValue } from '@xpanel/core'

export const PACKAGE_CHECK_PATH = '/var/lib/xpanel/svc/package-check.json'
/** After the 00:00 UTC rollovers of bandwidth and logs, once per UTC day. */
const NIGHTLY_HOUR = 2
const REPORTED_FILES = 50
export interface PackageCheckResult { at: string; state: 'clean' | 'modified' | 'unavailable'; release: string | null; checked: number; modified: string[]; missing: string[] }
export interface NightlyState { day: string | null }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const sha256File = (path: string): Promise<string> => new Promise((resolve, reject) => {
  const hash = createHash('sha256'), stream = createReadStream(path)
  stream.on('data', chunk => hash.update(chunk)); stream.on('error', reject); stream.on('end', () => resolve(hash.digest('hex')))
})

/** Compares the installed tree with the digests of its own release-manifest.json, one file at a time. */
export async function checkInstalledRelease(releaseRoot: string, now: () => Date = () => new Date(), digest: (path: string) => Promise<string> = sha256File): Promise<PackageCheckResult> {
  const base = { at: now().toISOString(), checked: 0, modified: [] as string[], missing: [] as string[] }
  let manifest: unknown
  try { manifest = JSON.parse(await readFile(join(releaseRoot, 'release-manifest.json'), 'utf8')) } catch { return { ...base, state: 'unavailable', release: null } }
  if (!object(manifest) || !Array.isArray(manifest.files) || typeof manifest.version !== 'string') return { ...base, state: 'unavailable', release: null }
  const result: PackageCheckResult = { ...base, state: 'clean', release: manifest.version }
  for (const entry of manifest.files) {
    if (!object(entry) || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') return { ...base, state: 'unavailable', release: manifest.version }
    result.checked++
    const path = join(releaseRoot, entry.path)
    const actual = await stat(path).then(() => digest(path), () => null)
    if (actual === null) { if (result.missing.length < REPORTED_FILES) result.missing.push(entry.path) }
    else if (actual !== entry.sha256 && result.modified.length < REPORTED_FILES) result.modified.push(entry.path)
  }
  if (result.modified.length || result.missing.length) result.state = 'modified'
  return result
}

export interface NightlyTasks {
  readTweaks: () => Promise<Record<string, TweakValue>>
  runProcessKiller: () => Promise<void>
  /** null when this host has no signed release tree (development checkouts) */
  checkRelease: (() => Promise<void>) | null
  /** Removes finished update, repair and PHP jobs older than the cutoff. */
  pruneJobs: (before: Date) => Promise<void>
  updateWafVendors: () => Promise<void>
  readState: () => Promise<NightlyState>
  writeState: (state: NightlyState) => Promise<void>
  now?: () => Date
  onError?: (task: string, error: unknown) => void
}

/** Runs at most once per UTC day from the agent's minute timer; a task that fails never stops the others. */
export function createNightlyMaintenance(tasks: NightlyTasks): { tick: () => Promise<void> } {
  const now = tasks.now ?? (() => new Date())
  let running = false
  const attempt = async (name: string, work: () => Promise<void>): Promise<void> => { try { await work() } catch (error) { tasks.onError?.(name, error) } }
  return {
    tick: async () => {
      const at = now(), day = at.toISOString().slice(0, 10)
      if (running || at.getUTCHours() < NIGHTLY_HOUR) return
      running = true
      try {
        if ((await tasks.readState()).day === day) return
        await tasks.writeState({ day })
        const tweaks = await tasks.readTweaks(), retention = updateLogRetentionDays(tweaks)
        await attempt('process-killer', tasks.runProcessKiller)
        if (retention !== null) await attempt('job-retention', () => tasks.pruneJobs(new Date(at.getTime() - retention * 86_400_000)))
        await attempt('waf-vendors', tasks.updateWafVendors)
        if (tasks.checkRelease && nightlyPackageCheck(tweaks)) await attempt('package-check', tasks.checkRelease)
      } finally { running = false }
    },
  }
}
