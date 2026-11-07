import { constants } from 'node:fs'
import { lstat, open, readdir, unlink } from 'node:fs/promises'
import { posix } from 'node:path'
import { fail } from '@xpanel/core'
import { edge } from '@xpanel/render'

/** Only fixed directories and rotated names; a live log is never removed. Site logs are the one exception: they are truncated in place, as cPanel-style clears are, so nginx keeps its open file. */
export const LOG_CLEANUP_CATEGORIES = {
  web: { dirs: ['/var/log/nginx', '/var/log/apache2', '/var/log/httpd', edge.XP_PATHS.apacheLogDir] },
  mail: { dirs: ['/var/log'], only: /^(?:mail|maillog|mail\.err|mail\.warn)/ },
  system: { dirs: ['/var/log'], only: /^(?:syslog|messages|kern|auth|secure|cron|dpkg|daemon|user|alternatives|bootstrap)/ },
} as const
export type LogCleanupCategory = keyof typeof LOG_CLEANUP_CATEGORIES | 'site' | 'journal'
export const LOG_CATEGORY_IDS: readonly LogCleanupCategory[] = [...Object.keys(LOG_CLEANUP_CATEGORIES) as (keyof typeof LOG_CLEANUP_CATEGORIES)[], 'site', 'journal']
const ROTATED = /(?:\.[1-9][0-9]?|\.gz|\.xz|\.zst|\.old|-[0-9]{8}(?:\.gz)?)$/
const SITE_LOG = /^[a-z0-9.-]{1,253}\.(?:access|error)\.log$/
const FILES_MAX = 5000

export interface LogCleanupFile { path: string; bytes: number }
export interface LogCleanupRow { id: LogCleanupCategory; files: number; bytes: number; items: LogCleanupFile[] }
export type LogCleanupRun = (argv: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>
const JOURNAL_USAGE = ['/usr/bin/journalctl', '--disk-usage']
const JOURNAL_VACUUM = ['/usr/bin/journalctl', '--vacuum-size=64M']
const SUFFIX: Readonly<Record<string, number>> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }
/** journalctl(1) --disk-usage prints e.g. "Archived and active journals take up 16.0M in the file system." */
export const parseJournalUsage = (text: string): number | null => {
  const match = /take up ([0-9.]+)([BKMGT])/.exec(text)
  return match ? Math.round(Number(match[1]) * SUFFIX[match[2]!]!) : null
}
// st_blocks, not st_size: what comes back on the filesystem is what the report must match.
const allocated = (info: { blocks: number }): number => info.blocks * 512

async function listDir(dir: string, take: (name: string) => boolean, out: LogCleanupFile[]): Promise<void> {
  let names: string[]
  try { names = await readdir(dir) } catch { return }
  for (const name of names.sort()) {
    if (out.length >= FILES_MAX || !take(name)) continue
    const path = posix.join(dir, name), info = await lstat(path).catch(() => null)
    if (info?.isFile() && info.nlink === 1) out.push({ path, bytes: allocated(info) })
  }
}

export async function scanLogCleanup(run: LogCleanupRun, siteLogDir: string = edge.XP_PATHS.nginxLogDir): Promise<LogCleanupRow[]> {
  const rows: LogCleanupRow[] = []
  const row = (id: LogCleanupCategory, items: LogCleanupFile[]): void => { rows.push({ id, files: items.length, bytes: items.reduce((sum, item) => sum + item.bytes, 0), items: items.slice(0, 100) }) }
  for (const [id, category] of Object.entries(LOG_CLEANUP_CATEGORIES)) {
    const items: LogCleanupFile[] = [], only = 'only' in category ? category.only : null
    for (const dir of category.dirs) await listDir(dir, name => ROTATED.test(name) && (!only || only.test(name)), items)
    row(id as LogCleanupCategory, items)
  }
  const site: LogCleanupFile[] = []
  await listDir(siteLogDir, name => SITE_LOG.test(name), site)
  row('site', site.filter(item => item.bytes > 0))
  const usage = await run(JOURNAL_USAGE).catch(() => null), bytes = usage?.ok ? parseJournalUsage(usage.stdout + usage.stderr) : null
  if (bytes !== null) rows.push({ id: 'journal', files: 0, bytes, items: [] })
  return rows
}

const truncate = async (path: string): Promise<void> => {
  const handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW)
  try { await handle.truncate(0) } finally { await handle.close() }
}

/** Scans again at the moment of deletion, so a file named only in an old preview is never touched. */
export async function applyLogCleanup(run: LogCleanupRun, categories: readonly LogCleanupCategory[], siteLogDir?: string): Promise<{ freedBytes: number; removed: number; failed: number; rows: LogCleanupRow[] }> {
  if (!categories.length || categories.some(id => !LOG_CATEGORY_IDS.includes(id))) return fail('VALIDATION', 'choose at least one log category', { stateChanged: false, reason: 'log_category_invalid' })
  const before = await scanLogCleanup(run, siteLogDir)
  let freedBytes = 0, removed = 0, failed = 0
  for (const id of categories) {
    if (id === 'journal') {
      const was = before.find(row => row.id === 'journal')?.bytes
      if (was === undefined) { failed++; continue }
      await run(JOURNAL_VACUUM).catch(() => null)
      const now = await run(JOURNAL_USAGE).catch(() => null), after = now?.ok ? parseJournalUsage(now.stdout + now.stderr) : null
      if (after === null) failed++; else freedBytes += Math.max(0, was - after)
      continue
    }
    const items: LogCleanupFile[] = []
    if (id === 'site') await listDir(siteLogDir ?? edge.XP_PATHS.nginxLogDir, name => SITE_LOG.test(name), items)
    else { const category = LOG_CLEANUP_CATEGORIES[id], only = 'only' in category ? category.only : null; for (const dir of category.dirs) await listDir(dir, name => ROTATED.test(name) && (!only || only.test(name)), items) }
    for (const item of items) {
      try { if (id === 'site') await truncate(item.path); else await unlink(item.path); freedBytes += item.bytes; removed++ } catch { failed++ }
    }
  }
  return { freedBytes, removed, failed, rows: await scanLogCleanup(run, siteLogDir) }
}
