// Strict validators for every name that reaches a path, unit name or config file.
// They reject; they never repair input.

import { fail, validateUsername } from '@xpanel/core'
import type { Account, Limit, OsProfile } from '@xpanel/core'

/** systemd's "regular user" range (UIDS-GIDS.md): 1000..60000. */
export const ACCOUNT_ID_MIN = 1000
export const ACCOUNT_ID_MAX = 60000

/** Default home bases: /home and /home0 .. /home99. */
export const DEFAULT_HOME_BASE_RE = /^\/home[1-9]?[0-9]?$/

/** Top-level directories that may never hold account homes (terminate removes the home). */
const PROTECTED_TOP = new Set([
  'bin', 'boot', 'dev', 'etc', 'lib', 'lib32', 'lib64', 'libx32', 'lost+found', 'opt', 'proc', 'root', 'run',
  'sbin', 'snap', 'sys', 'tmp', 'usr', 'var',
])

const PATH_SEGMENT_RE = /^[A-Za-z0-9._+-]+$/

export const invalid = (message: string, detail: Record<string, unknown> = {}): never =>
  fail('VALIDATION', message, detail)

export const assertInt = (what: string, v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    return invalid(`${what} must be an integer in [${min}, ${max}]`, { what, value: v, min, max })
  }
  return v
}

/** `'unlimited'` passes through; numbers must sit inside [min, max]. */
export const assertLimit = (what: string, v: unknown, min: number, max: number): Limit =>
  v === 'unlimited' ? 'unlimited' : assertInt(what, v, min, max)

/**
 * Core's rule (charset, length, reserved system names and prefixes) applied again where the name
 * becomes a user, group, path or unit name, plus this host's web server users from the profile.
 */
export const assertUsername = (input: unknown, os?: Pick<OsProfile, 'paths'>): string => {
  const name = validateUsername(input)
  if (os && (name === os.paths.apacheUser || name === os.paths.nginxUser)) {
    return invalid(`username "${name}" is the web server user`, { username: name })
  }
  return name
}

export const assertAccountId = (what: 'uid' | 'gid', v: unknown): number =>
  assertInt(what, v, ACCOUNT_ID_MIN, ACCOUNT_ID_MAX)

/** Absolute, normalized path of safe characters. No `.`/`..` segments, no `//`, no trailing `/`. */
export const assertAbsPath = (what: string, p: unknown, maxLen = 1024): string => {
  if (typeof p !== 'string' || p.length < 2 || p.length > maxLen || !p.startsWith('/')) {
    return invalid(`${what} must be an absolute path`, { what, path: p })
  }
  for (const seg of p.slice(1).split('/')) {
    if (!PATH_SEGMENT_RE.test(seg) || seg === '.' || seg === '..') {
      return invalid(`${what} has an unsafe path segment`, { what, path: p, segment: seg })
    }
  }
  return p
}

/** Mount points may be `/` itself. */
export const assertMountPoint = (what: string, p: unknown): string => (p === '/' ? '/' : assertAbsPath(what, p))

export const assertHomeBase = (base: unknown): string => {
  const b = assertAbsPath('home base', base)
  const top = b.slice(1).split('/')[0] ?? ''
  if (PROTECTED_TOP.has(top)) return invalid(`home base ${b} is inside a system directory`, { base: b })
  return b
}

export interface HomeLayout {
  home: string
  base: string
}

/**
 * The home must be exactly `<base>/<username>`. Bases default to /home, /home2 .. /home99; custom
 * bases are allowed outside system directories. This is what makes `remove-path home` safe.
 */
export const assertAccountHome = (home: unknown, username: string, bases?: readonly string[]): HomeLayout => {
  const h = assertAbsPath('home', home)
  const cut = h.lastIndexOf('/')
  const base = h.slice(0, cut)
  if (h.slice(cut + 1) !== username || base === '') {
    return invalid('home must be <base>/<username>', { home: h, username })
  }
  const allowed = bases ? bases.map(assertHomeBase).includes(base) : DEFAULT_HOME_BASE_RE.test(base)
  if (!allowed) return invalid(`home base ${base} is not an allowed home base`, { home: h, base })
  return { home: h, base }
}

export interface AccountIdentity {
  username: string
  uid: number
  gid: number
}

export const assertAccountIdentity = (account: Pick<Account, 'username' | 'uid' | 'gid'>, os?: Pick<OsProfile, 'paths'>): AccountIdentity => ({
  username: assertUsername(account.username, os),
  uid: assertAccountId('uid', account.uid),
  gid: assertAccountId('gid', account.gid),
})

/** PHP versions as used in unit names and paths: 5.6, 7.4, 8.3 ... */
export const assertPhpVersion = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[5-9]\.[0-9]{1,2}$/.test(v)) return invalid('php version must look like 8.3', { version: v })
  return v
}

/** Short object names used inside unit names (cron job ids, app names). */
export const assertShortName = (what: string, v: unknown): string => {
  if (typeof v !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(v)) {
    return invalid(`${what} must be 1-32 chars of a-z, 0-9 and inner dashes`, { what, value: v })
  }
  return v
}

export const assertPort = (what: string, v: unknown): number => assertInt(what, v, 1, 65535)

/**
 * Block device for systemd IO*Max=. Accepts a /dev path or `major:minor`, which systemd cannot take
 * raw and is mapped to the udev link /dev/block/<major>:<minor>.
 */
export const toSystemdIoDevice = (d: unknown): string => {
  if (typeof d === 'string') {
    const mm = /^([0-9]{1,4}):([0-9]{1,7})$/.exec(d)
    if (mm) return `/dev/block/${Number(mm[1])}:${Number(mm[2])}`
    if (d.startsWith('/dev/') && d.length > 5 && d.length <= 255) {
      const segs = d.slice(1).split('/')
      if (segs.every((s) => /^[A-Za-z0-9_+.:-]+$/.test(s) && s !== '.' && s !== '..')) return d
    }
  }
  return invalid('io device must be a /dev path or major:minor', { device: d })
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/

/** Rejects NUL, newlines and every other control character. */
export const assertNoControl = (what: string, v: unknown, maxLen: number): string => {
  if (typeof v !== 'string' || v.length > maxLen || CONTROL_RE.test(v)) {
    return invalid(`${what} must be a string of at most ${maxLen} chars without control characters`, { what })
  }
  return v
}
