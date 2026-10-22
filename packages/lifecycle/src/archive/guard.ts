import { fail } from '@xpanel/core'
import { hasControlChars } from '../validate.ts'
import { ancestors, normalizeEntryName, resolveLinkTarget, within } from './paths.ts'

export type EntryType = 'file' | 'directory' | 'symlink' | 'hardlink'

export interface SafeEntry {
  /** normalized relative path */
  path: string
  type: EntryType
  size: number
  mode: number
  mtime: Date | null
  /** symlink: raw (already verified) target; hardlink: normalized archive path */
  linkTarget: string | null
}

export interface SkippedEntry {
  path: string
  code: 'special-file' | 'unsupported-type' | 'control-chars' | 'symlink-escape' | 'symlink-chain' | 'symlink-not-allowed'
  reason: string
}

export interface GuardOptions {
  maxEntries: number
  maxTotalBytes: number
  /**
   * Root a link at `path` must stay inside (e.g. `cpmove-bob/homedir`), or null when
   * links are not allowed there at all.
   */
  linkScope: (path: string) => string | null
  /**
   * `contained`: a symlink must resolve inside its scope, without passing through another
   * symlink. `any`: symlinks are data and keep any target; for walks that never write, or
   * whose extraction runs as the account itself (GNU tar as the account uid).
   */
  symlinks: 'contained' | 'any'
}

interface RawHeader {
  name: string
  type?: string | null
  size?: number
  mode?: number
  mtime?: Date
  linkname?: string | null
}

const MAX_LINK_TARGET = 4096

const DEFAULT_GUARD: GuardOptions = {
  maxEntries: 2_000_000,
  maxTotalBytes: 512 * 1024 ** 3,
  linkScope: () => '',
  symlinks: 'contained',
}

type GuardDecision = { action: 'accept'; entry: SafeEntry } | { action: 'skip'; skipped: SkippedEntry }

const hostile = (reason: string, name: unknown): never =>
  fail('VALIDATION', `unsafe archive entry rejected: ${reason}`, { entry: String(name).slice(0, 300), reason })

/**
 * Stateful per-archive checker. Fatal problems (traversal, writes through links,
 * hardlinks out of scope, caps) throw and reject the whole archive; questionable but
 * common content (escaping or chained symlinks, device nodes) is skipped and reported.
 * State changes only for accepted entries, so two walks over the same accepted entries
 * (an exporter and the importer reading its archive) always decide alike.
 */
export class ArchiveGuard {
  readonly opts: GuardOptions
  private dirs = new Set<string>()
  private links = new Set<string>()
  private linkVisited = new Set<string>()
  entries = 0
  bytes = 0

  constructor(opts: Partial<GuardOptions> = {}) {
    this.opts = { ...DEFAULT_GUARD, ...opts }
  }

  private underLink(path: string): boolean {
    return this.links.has(path) || ancestors(path).some((a) => this.links.has(a))
  }

  private accept(entry: SafeEntry, visited: readonly string[] = []): GuardDecision {
    for (const a of ancestors(entry.path)) this.dirs.add(a)
    if (entry.type === 'directory') this.dirs.add(entry.path)
    if (entry.type === 'symlink') this.links.add(entry.path)
    for (const v of visited) this.linkVisited.add(v)
    return { action: 'accept', entry }
  }

  check(h: RawHeader): GuardDecision {
    if (++this.entries > this.opts.maxEntries) fail('LIMIT_EXCEEDED', `archive has more than ${this.opts.maxEntries} entries`)
    const size = h.size ?? 0
    if (!Number.isSafeInteger(size) || size < 0) hostile('invalid size', h.name)
    this.bytes += size
    if (this.bytes > this.opts.maxTotalBytes) fail('LIMIT_EXCEEDED', `archive content exceeds ${this.opts.maxTotalBytes} bytes`)

    const n = normalizeEntryName(h.name)
    if (!n.ok) return hostile(n.reason, h.name)
    const path = n.path
    const skip = (code: SkippedEntry['code'], reason: string): GuardDecision => ({ action: 'skip', skipped: { path, code, reason } })

    const type = h.type ?? 'file'
    if (type === 'character-device' || type === 'block-device' || type === 'fifo') return skip('special-file', `${type} entries are never extracted`)
    if (!['file', 'contiguous-file', 'directory', 'symlink', 'link'].includes(type)) return skip('unsupported-type', `entry type ${type}`)
    if (path === '') {
      if (type !== 'directory') hostile('non-directory archive root', h.name)
      return { action: 'accept', entry: { path, type: 'directory', size: 0, mode: h.mode ?? 0o755, mtime: h.mtime ?? null, linkTarget: null } }
    }
    if (this.underLink(path)) hostile('entry is written through or over a symlink', h.name)
    if (n.control) return skip('control-chars', 'control characters in name')

    const base = { path, size, mode: h.mode ?? 0o644, mtime: h.mtime ?? null }
    if (type === 'directory') return this.accept({ ...base, size: 0, mode: h.mode ?? 0o755, type: 'directory', linkTarget: null })
    if (type === 'symlink') return this.checkSymlink(h, path, base)
    if (type === 'link') {
      const t = normalizeEntryName(h.linkname)
      if (!t.ok || t.path === '') return hostile(`hardlink target ${t.ok ? 'is the root' : t.reason}`, h.name)
      const scope = this.opts.linkScope(path)
      if (scope === null || !within(t.path, scope) || this.opts.linkScope(t.path) !== scope) hostile('hardlink target outside its part of the archive', h.name)
      if (this.underLink(t.path)) hostile('hardlink target is a symlink', h.name)
      return this.accept({ ...base, size: 0, type: 'hardlink', linkTarget: t.path })
    }
    return this.accept({ ...base, type: 'file', linkTarget: null })
  }

  private checkSymlink(h: RawHeader, path: string, base: Omit<SafeEntry, 'type' | 'linkTarget'>): GuardDecision {
    const skip = (code: SkippedEntry['code'], reason: string): GuardDecision => ({ action: 'skip', skipped: { path, code, reason } })
    if (this.dirs.has(path)) hostile('symlink replaces a directory already in the archive', h.name)
    const scope = this.opts.linkScope(path)
    if (scope === null) return skip('symlink-not-allowed', 'symlinks are not allowed in this part of the archive')
    const target = h.linkname
    if (typeof target !== 'string' || target.length === 0 || target.length > MAX_LINK_TARGET || target.includes('\u0000')) {
      return skip('symlink-escape', 'symlink target is empty, too long or contains NUL')
    }
    const entry: SafeEntry = { ...base, size: 0, type: 'symlink', linkTarget: target }
    if (this.opts.symlinks === 'any') return hasControlChars(target) ? skip('control-chars', 'control characters in symlink target') : this.accept(entry)
    // an earlier link already resolves through this path: making it a link would change where that one points
    if (this.linkVisited.has(path)) return skip('symlink-chain', 'another symlink resolves through this path')
    const r = resolveLinkTarget(path, target, scope)
    if (!r) return skip('symlink-escape', `symlink target ${target.slice(0, 200)} leaves ${scope || 'the archive'}`)
    if (r.visited.some((v) => this.links.has(v))) return skip('symlink-chain', 'symlink resolves through another symlink')
    return this.accept(entry, r.visited)
  }
}
