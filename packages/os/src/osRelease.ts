import { fail } from '@xpanel/core'
import type { OsRelease } from './types.ts'

export const MAX_OS_RELEASE_CHARS = 64 * 1024

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const DOUBLE_QUOTE_ESCAPES = new Set(['"', '\\', '$', '`'])

const scanDoubleQuoted = (src: string, from: number): { text: string; next: number } | null => {
  let text = ''
  for (let i = from; i < src.length; i++) {
    const c = src[i]!
    if (c === '"') return { text, next: i + 1 }
    const n = src[i + 1]
    if (c === '\\' && n !== undefined && DOUBLE_QUOTE_ESCAPES.has(n)) {
      text += n
      i++
    } else {
      text += c
    }
  }
  return null
}

/** Shell-style word: quotes and backslash escapes, ends at unquoted whitespace. null when malformed. */
const parseValue = (src: string): string | null => {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === ' ' || c === '\t') break
    if (c === '"') {
      const q = scanDoubleQuoted(src, i + 1)
      if (!q) return null
      out += q.text
      i = q.next
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1)
      if (close < 0) return null
      out += src.slice(i + 1, close)
      i = close + 1
    } else if (c === '\\') {
      const n = src[i + 1]
      if (n === undefined) return null
      out += n
      i += 2
    } else {
      out += c
      i++
    }
  }
  const rest = src.slice(i).trim()
  return rest === '' || rest.startsWith('#') ? out : null
}

/**
 * Parses os-release(5). Malformed lines are skipped, the last assignment of a key wins,
 * and a missing ID defaults to "linux" as the spec requires. Values are not trusted here:
 * support checks compare them against an allowlist.
 */
export const parseOsRelease = (text: string): OsRelease => {
  if (typeof text !== 'string') return fail('VALIDATION', 'os-release content must be text')
  if (text.length > MAX_OS_RELEASE_CHARS) return fail('VALIDATION', 'os-release is too large', { length: text.length })
  const fields: Record<string, string> = Object.create(null)
  // a raw CR never belongs to a value; treating it as a line end tolerates CRLF files without a final LF
  for (const raw of text.split(/\r?\n|\r/)) {
    const line = raw.trimStart()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    if (!KEY.test(key)) continue
    const value = parseValue(line.slice(eq + 1))
    if (value !== null) fields[key] = value
  }
  const get = (k: string): string => fields[k] ?? ''
  return Object.freeze({
    id: get('ID') || 'linux',
    idLike: Object.freeze(get('ID_LIKE').split(/\s+/).filter(Boolean)) as string[],
    versionId: get('VERSION_ID'),
    versionCodename: get('VERSION_CODENAME'),
    name: get('NAME'),
    prettyName: get('PRETTY_NAME'),
    platformId: get('PLATFORM_ID'),
    fields: Object.freeze(fields),
  })
}
