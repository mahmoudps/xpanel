import { fail } from '@xpanel/core'
import type { OsRelease, XpanelOsProfile } from './types.ts'
import { MAX_OS_RELEASE_CHARS, parseOsRelease } from './osRelease.ts'
import { classifyRelease } from './support.ts'
import { aptProfile } from './apt.ts'
import { dnfProfile } from './dnf.ts'

/**
 * Returns the file text, or null/undefined when the file is absent. A thrown error counts as
 * absent only with a Node `code` of ENOENT (missing file or dangling symlink) or ENOTDIR (a path
 * component is not a directory); any other failure stops detection.
 */
export type ReadFile = (path: string) => string | null | undefined

export const OS_RELEASE_PATHS: readonly string[] = Object.freeze(['/etc/os-release', '/usr/lib/os-release'])

const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR'])

const isAbsent = (e: unknown): boolean => {
  const code = e !== null && typeof e === 'object' ? (e as { code?: unknown }).code : undefined
  return typeof code === 'string' && ABSENT_CODES.has(code)
}

const reason = (e: unknown): string => (e instanceof Error ? e.message.slice(0, 160) : 'read failed')

/**
 * os-release(5) lookup order: /etc/os-release, then /usr/lib/os-release only when the first is absent.
 * A file that exists but cannot be read, or is not usable text, stops detection instead of consulting the fallback.
 */
export const readOsRelease = (readFile: ReadFile): OsRelease => {
  const errors: string[] = []
  for (const path of OS_RELEASE_PATHS) {
    let text: unknown
    try {
      text = readFile(path)
    } catch (e) {
      if (!isAbsent(e)) {
        return fail('UNSUPPORTED_OS', 'cannot identify the operating system: os-release could not be read', { path, error: reason(e) })
      }
      errors.push(`${path}: ${reason(e)}`)
      continue
    }
    if (text === null || text === undefined) {
      errors.push(`${path}: missing`)
      continue
    }
    if (typeof text !== 'string' || text.length > MAX_OS_RELEASE_CHARS) {
      return fail('UNSUPPORTED_OS', 'cannot identify the operating system: os-release is not readable text', { path })
    }
    return parseOsRelease(text)
  }
  return fail('UNSUPPORTED_OS', 'cannot identify the operating system: no os-release file', { tried: [...OS_RELEASE_PATHS], errors })
}

/** Resolves the adapter for a release (parsed, or raw os-release text). Unsupported systems throw UNSUPPORTED_OS. */
export const profileFor = (release: OsRelease | string): XpanelOsProfile => {
  const r = typeof release === 'string' ? parseOsRelease(release) : release
  return classifyRelease(r).family === 'debian' ? aptProfile(r) : dnfProfile(r)
}

export const detectOs = (readFile: ReadFile): XpanelOsProfile => profileFor(readOsRelease(readFile))
