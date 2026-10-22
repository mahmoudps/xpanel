import { posix } from 'node:path'
import { hasControlChars } from '../validate.ts'

type NameVerdict =
  | { ok: true; path: string; control: boolean }
  | { ok: false; reason: string }

const MAX_PATH = 4096
const MAX_SEGMENT_BYTES = 255

/**
 * Normalizes a tar member name to a relative POSIX path without a trailing slash.
 * Only a leading `./` is tolerated; `..`, absolute names, empty segments, NUL and
 * backslashes are rejected because no honest archiver emits them.
 */
export const normalizeEntryName = (raw: unknown): NameVerdict => {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'empty name' }
  if (raw.includes('\u0000')) return { ok: false, reason: 'NUL in name' }
  if (raw.includes('\\')) return { ok: false, reason: 'backslash in name' }
  if (raw.startsWith('/')) return { ok: false, reason: 'absolute name' }
  if (/^[A-Za-z]:/.test(raw)) return { ok: false, reason: 'drive-letter name' }
  if (raw.length > MAX_PATH) return { ok: false, reason: 'name too long' }
  let p = raw
  while (p.startsWith('./')) p = p.slice(2)
  if (p === '.' || p === '') return { ok: true, path: '', control: false }
  if (p.endsWith('/')) p = p.slice(0, -1)
  const segs = p.split('/')
  for (const s of segs) {
    if (s === '') return { ok: false, reason: 'empty path segment' }
    if (s === '.' || s === '..') return { ok: false, reason: 'path traversal' }
    if (Buffer.byteLength(s) > MAX_SEGMENT_BYTES) return { ok: false, reason: 'path segment too long' }
  }
  return { ok: true, path: p, control: hasControlChars(p) }
}

export const within = (p: string, scope: string): boolean =>
  scope === '' || p === scope || p.startsWith(`${scope}/`)

/** Proper ancestors of a relative path: a/b/c -> [a, a/b]. */
export const ancestors = (p: string): string[] => {
  const segs = p.split('/')
  const out: string[] = []
  for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join('/'))
  return out
}

/**
 * Lexically resolves a symlink target relative to the link's directory. Returns the
 * visited prefixes (to detect traversal through other links) and the final path, or
 * null when the target is absolute or any step leaves `scope`.
 */
export const resolveLinkTarget = (linkPath: string, target: unknown, scope: string): { path: string; visited: string[] } | null => {
  if (typeof target !== 'string' || target.length === 0 || target.length > MAX_PATH) return null
  if (target.startsWith('/') || target.includes('\u0000') || target.includes('\\') || hasControlChars(target)) return null
  const dir = posix.dirname(linkPath)
  const segs = dir === '.' ? [] : dir.split('/')
  const visited: string[] = []
  for (const s of target.split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') {
      if (segs.length === 0) return null
      segs.pop()
    } else segs.push(s)
    const cur = segs.join('/')
    if (!within(cur, scope)) return null
    visited.push(cur)
  }
  return { path: segs.join('/'), visited }
}
