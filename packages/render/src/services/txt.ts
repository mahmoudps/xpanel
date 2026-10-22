// DNS character-strings (RFC 1035 §3.3, §5.1): TXT values are stored as one logical
// string and rendered as quoted chunks of at most 255 octets.
import { invalid } from './validate.ts'

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })

export const CHAR_STRING_MAX = 255
/** Upper bound for one logical TXT value (a 4096-bit DKIM key needs ~750). */
export const TXT_MAX_BYTES = 4096

export const utf8Length = (s: string): number => enc.encode(s).length

/** Split into <=255-octet strings, never cutting a UTF-8 sequence. */
export const txtChunks = (value: string): string[] => {
  const out: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of value) {
    const n = enc.encode(ch).length
    if (bytes + n > CHAR_STRING_MAX) {
      out.push(cur)
      cur = ''
      bytes = 0
    }
    cur += ch
    bytes += n
  }
  if (cur !== '' || out.length === 0) out.push(cur)
  return out
}

/** Body of one quoted character-string: `"` and `\` escaped, non-printable octets as `\DDD`. */
export const escapeCharString = (s: string): string => {
  let r = ''
  for (const b of enc.encode(s)) {
    if (b === 0x22 || b === 0x5c) r += `\\${String.fromCharCode(b)}`
    else if (b < 0x20 || b > 0x7e) r += `\\${String(b).padStart(3, '0')}`
    else r += String.fromCharCode(b)
  }
  return r
}

/** Presentation form understood by BIND and the PowerDNS API: `"chunk1" "chunk2"`. */
export const quoteTxt = (value: string): string =>
  txtChunks(value).map((c) => `"${escapeCharString(c)}"`).join(' ')

/** Decode `\DDD` and `\X` escapes of a character-string body into octets. */
export const decodeCharString = (raw: string): number[] => {
  const out: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string
    if (c !== '\\') {
      const cp = raw.codePointAt(i) ?? 0
      const ch = String.fromCodePoint(cp)
      out.push(...enc.encode(ch))
      i += ch.length - 1
      continue
    }
    const d = raw.slice(i + 1, i + 4)
    if (/^\d{3}$/.test(d)) {
      const n = Number(d)
      if (n > 255) return invalid('character-string', raw, `escape \\${d} is above 255`)
      out.push(n)
      i += 3
    } else if (i + 1 < raw.length) {
      const cp = raw.codePointAt(i + 1) ?? 0
      const ch = String.fromCodePoint(cp)
      out.push(...enc.encode(ch))
      i += ch.length
    } else {
      return invalid('character-string', raw, 'ends with a lone backslash')
    }
  }
  return out
}

export const decodeOctets = (what: string, octets: number[]): string => {
  try {
    return dec.decode(new Uint8Array(octets))
  } catch {
    return invalid(what, '', 'is not valid UTF-8')
  }
}

/**
 * Parse presentation-format TXT rdata (`"a" "b"` or bare words) into the logical value.
 * Strings are concatenated without separators, as SPF/DKIM consumers do.
 */
export const parseTxtPresentation = (text: string): string => {
  const octets: number[] = []
  let i = 0
  let parts = 0
  while (i < text.length) {
    const c = text[i]
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    let j = i
    let body: string
    if (c === '"') {
      j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      if (j >= text.length) return invalid('TXT content', text, 'has an unterminated quoted string')
      body = text.slice(i + 1, j)
      j++
    } else {
      while (j < text.length && text[j] !== ' ' && text[j] !== '\t' && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      body = text.slice(i, Math.min(j, text.length))
    }
    const bytes = decodeCharString(body)
    if (bytes.length > CHAR_STRING_MAX) return invalid('TXT content', text, 'has a character-string over 255 octets')
    octets.push(...bytes)
    parts++
    i = j
  }
  if (parts === 0) return invalid('TXT content', text, 'is empty')
  return decodeOctets('TXT content', octets)
}
