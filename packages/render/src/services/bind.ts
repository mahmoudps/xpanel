// RFC 1035 master-file import/export, for cPanel's public backup layout (dnszones/<zone>.db)
// and for zone downloads. $INCLUDE and $GENERATE are refused: an import never reads files.
import { isXpanelError } from '@xpanel/core'
import {
  DEFAULT_TTL,
  assertTtl,
  normalizeZone,
  validateZone,
  validateRecord,
  type RecordInput,
  type ZoneRecord,
  type ZoneRecordType,
  ZONE_RECORD_TYPES,
} from './dns.ts'
import { decodeCharString, decodeOctets, quoteTxt } from './txt.ts'
import { invalid } from './validate.ts'

interface Token {
  text: string
  quoted: boolean
}

interface Entry {
  line: number
  blankOwner: boolean
  tokens: Token[]
}

export const BIND_MAX_BYTES = 4 * 1024 * 1024

const syntax = (line: number, why: string): never => invalid('zone file', `line ${line}`, `line ${line}: ${why}`)

const lex = (text: string): Entry[] => {
  const entries: Entry[] = []
  let tokens: Token[] = []
  let line = 1
  let entryLine = 1
  let blankOwner = false
  let atStart = true
  let depth = 0
  const flush = (): void => {
    if (tokens.length > 0) entries.push({ line: entryLine, blankOwner, tokens })
    tokens = []
  }
  let i = 0
  while (i < text.length) {
    const c = text[i] as string
    if (atStart && depth === 0) {
      blankOwner = c === ' ' || c === '\t'
      entryLine = line
      atStart = false
    }
    if (c === '\n') {
      line++
      if (depth === 0) {
        flush()
        atStart = true
      }
      i++
    } else if (c === '\r' || c === ' ' || c === '\t') {
      i++
    } else if (c === ';') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '(') {
      depth++
      i++
    } else if (c === ')') {
      if (depth === 0) syntax(line, 'unbalanced ")"')
      depth--
      i++
    } else if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\n') syntax(line, 'newline inside a quoted string')
        j += text[j] === '\\' ? 2 : 1
      }
      if (j >= text.length) syntax(line, 'unterminated quoted string')
      tokens.push({ text: text.slice(i + 1, j), quoted: true })
      i = j + 1
    } else {
      let j = i
      while (j < text.length && !' \t\r\n;()"'.includes(text[j] as string)) j += text[j] === '\\' ? 2 : 1
      tokens.push({ text: text.slice(i, j), quoted: false })
      i = j
    }
  }
  if (depth !== 0) syntax(line, 'unbalanced "(" at end of file')
  flush()
  return entries
}

const TTL_RE = /^(?:\d+|(?:\d+[smhdw])+)$/i
const UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }

/** `3600`, `1h`, `1h30m`, `2w` → seconds. */
export const parseBindTtl = (s: string): number => {
  if (!TTL_RE.test(s)) return invalid('TTL', s, 'is not a BIND TTL')
  if (/^\d+$/.test(s)) return Number(s)
  let total = 0
  for (const m of s.toLowerCase().matchAll(/(\d+)([smhdw])/g)) total += Number(m[1]) * (UNIT[m[2] as string] ?? 0)
  return total
}

const CLASSES = new Set(['IN', 'CH', 'HS', 'CS'])

const absolute = (name: string, origin: string | null, line: number): string => {
  if (name.includes('\\')) syntax(line, `escaped characters in name "${name}" are not supported`)
  if (name === '@') return origin ?? syntax(line, '"@" used before $ORIGIN is known')
  if (name.endsWith('.')) return name.slice(0, -1).toLowerCase()
  if (origin === null) return syntax(line, `relative name "${name}" used before $ORIGIN is known`)
  return `${name}.${origin}`.toLowerCase()
}

/** Like `absolute` but keeps `\.` in the mailbox label of an SOA rname. */
const absoluteRname = (name: string, origin: string | null, line: number): string => {
  if (name.endsWith('.')) return name.slice(0, -1).toLowerCase()
  if (origin === null) return syntax(line, 'relative SOA rname used before $ORIGIN is known')
  return `${name}.${origin}`.toLowerCase()
}

export interface SkippedRecord {
  line: number
  type: string
  reason: string
}

export interface ParsedZone {
  zone: string
  /** canonical records, apex SOA first */
  records: ZoneRecord[]
  /** unsupported types, other classes, out-of-zone and invalid records, with the reason */
  skipped: SkippedRecord[]
}

interface Raw {
  line: number
  owner: string
  ttl: number
  type: ZoneRecordType
  content: string
  priority: number | null
}

const rdataOf = (type: ZoneRecordType, t: Token[], origin: string | null, line: number): { content: string; priority: number | null } => {
  const words = t.map((x) => x.text)
  const need = (n: number): void => {
    if (t.length !== n) syntax(line, `${type} expects ${n} rdata fields, got ${t.length}`)
  }
  const name = (s: string): string => (s === '.' ? '.' : `${absolute(s, origin, line)}.`)
  switch (type) {
    case 'A':
    case 'AAAA':
      need(1)
      return { content: words[0] as string, priority: null }
    case 'NS':
    case 'CNAME':
      need(1)
      return { content: name(words[0] as string), priority: null }
    case 'MX':
      need(2)
      return { content: name(words[1] as string), priority: Number(/^\d+$/.test(words[0] as string) ? words[0] : NaN) }
    case 'SRV':
      need(4)
      return { content: `${words[1]} ${words[2]} ${name(words[3] as string)}`, priority: Number(/^\d+$/.test(words[0] as string) ? words[0] : NaN) }
    case 'TXT': {
      if (t.length === 0) syntax(line, 'TXT without data')
      const octets: number[] = []
      for (const tok of t) {
        const b = decodeCharString(tok.text)
        if (b.length > 255) syntax(line, 'TXT character-string longer than 255 octets')
        octets.push(...b)
      }
      return { content: decodeOctets('TXT content', octets), priority: null }
    }
    case 'CAA': {
      need(3)
      // a bare token cannot contain '"', and escapes mean the same quoted or not
      return { content: `${words[0]} ${words[1]} "${words[2]}"`, priority: null }
    }
    case 'SOA': {
      need(7)
      // the serial is a plain number; only the four timers take BIND units
      const serial = words[2] as string
      if (!/^\d{1,10}$/.test(serial)) syntax(line, `SOA serial "${serial.slice(0, 20)}" is not a number`)
      const times = words.slice(3).map((w) => String(parseBindTtl(w)))
      return { content: [name(words[0] as string), `${absoluteRname(words[1] as string, origin, line)}.`, serial, ...times].join(' '), priority: null }
    }
  }
}

/**
 * Parse a zone file. `origin` is the zone (cPanel's dnszones/<zone>.db has no $ORIGIN);
 * without it the first $ORIGIN or the SOA owner is used.
 */
export const parseBindZone = (text: string, opts: { origin?: string } = {}): ParsedZone => {
  if (typeof text !== 'string') return invalid('zone file', text, 'must be text')
  if (text.length > BIND_MAX_BYTES) return invalid('zone file', '', `is larger than ${BIND_MAX_BYTES} bytes`)
  const entries = lex(text.replace(/^\uFEFF/, ''))
  let origin: string | null = opts.origin ? normalizeZone(opts.origin) : null
  let zone = origin
  let defaultTtl: number | null = null
  let lastTtl: number | null = null
  let lastOwner: string | null = null
  const raws: Raw[] = []
  const skipped: SkippedRecord[] = []

  for (const e of entries) {
    const t = e.tokens
    const first = t[0] as Token
    if (!e.blankOwner && !first.quoted && first.text.startsWith('$')) {
      const dir = first.text.toUpperCase()
      if (dir === '$ORIGIN') {
        if (t.length !== 2) syntax(e.line, '$ORIGIN takes one name')
        origin = normalizeZone(absolute((t[1] as Token).text, origin, e.line))
        zone ??= origin
      } else if (dir === '$TTL') {
        if (t.length !== 2) syntax(e.line, '$TTL takes one value')
        defaultTtl = parseBindTtl((t[1] as Token).text)
      } else {
        syntax(e.line, `directive ${first.text} is not supported`)
      }
      continue
    }
    let idx = 0
    let owner: string
    if (e.blankOwner) {
      owner = lastOwner ?? syntax(e.line, 'record without an owner name')
    } else {
      owner = absolute(first.text, origin, e.line)
      idx = 1
    }
    lastOwner = owner
    let ttl: number | null = null
    let cls = 'IN'
    for (let k = 0; k < 2 && idx < t.length; k++) {
      const w = (t[idx] as Token).text
      if (ttl === null && TTL_RE.test(w)) {
        ttl = parseBindTtl(w)
        idx++
      } else if (CLASSES.has(w.toUpperCase())) {
        cls = w.toUpperCase()
        idx++
      }
    }
    const typeTok = t[idx]
    if (!typeTok) syntax(e.line, 'record without a type')
    const type = (typeTok as Token).text.toUpperCase()
    const rdata = t.slice(idx + 1)
    if (cls !== 'IN') {
      skipped.push({ line: e.line, type, reason: `class ${cls} is not imported` })
      continue
    }
    if (!(ZONE_RECORD_TYPES as readonly string[]).includes(type)) {
      skipped.push({ line: e.line, type, reason: `type ${type} is not supported` })
      continue
    }
    const zt = type as ZoneRecordType
    const resolvedTtl: number = ttl ?? defaultTtl ?? lastTtl ?? DEFAULT_TTL
    lastTtl = resolvedTtl
    try {
      const { content, priority } = rdataOf(zt, rdata, origin, e.line)
      raws.push({ line: e.line, owner, ttl: resolvedTtl, type: zt, content, priority })
    } catch (err) {
      if (!isXpanelError(err)) throw err
      skipped.push({ line: e.line, type, reason: err.message })
    }
  }

  zone ??= raws.find((r) => r.type === 'SOA')?.owner ?? null
  if (zone === null) return invalid('zone file', '', 'has no $ORIGIN, no SOA and no origin was given')
  const z = normalizeZone(zone)
  const records: ZoneRecord[] = []
  let soaSeen = false
  for (const r of raws) {
    if (r.owner !== z && !r.owner.endsWith(`.${z}`)) {
      skipped.push({ line: r.line, type: r.type, reason: `${r.owner} is outside zone ${z}` })
      continue
    }
    if (r.type === 'SOA' && soaSeen) {
      skipped.push({ line: r.line, type: r.type, reason: 'second SOA ignored' })
      continue
    }
    try {
      const rec = validateRecord({ zone: z, name: `${r.owner}.`, type: r.type, ttl: r.ttl, content: r.content, priority: r.priority })
      if (rec.type === 'SOA') soaSeen = true
      records.push(rec)
    } catch (err) {
      if (!isXpanelError(err)) throw err
      skipped.push({ line: r.line, type: r.type, reason: err.message })
    }
  }
  // same whole-zone rules as a save (duplicates collapse, CNAME stands alone), so an import
  // never hands back a record set the API would refuse; BIND refuses such a zone too
  const zoneRecords = validateZone(records, { requireSoa: false })
  zoneRecords.sort((a, b) => (a.type === 'SOA' ? -1 : b.type === 'SOA' ? 1 : 0))
  skipped.sort((a, b) => a.line - b.line)
  return { zone: z, records: zoneRecords, skipped }
}

// ---- export -------------------------------------------------------------------------------

const TYPE_ORDER: Record<ZoneRecordType, number> = { SOA: 0, NS: 1, A: 2, AAAA: 3, CNAME: 4, MX: 5, TXT: 6, SRV: 7, CAA: 8 }

const rdata = (r: ZoneRecord): string => {
  if (r.type === 'TXT') return quoteTxt(r.content)
  if (r.type === 'MX' || r.type === 'SRV') return `${r.priority} ${r.content}`
  if (r.type === 'SOA') {
    const [mname, rname, serial, refresh, retry, expire, minimum] = r.content.split(' ')
    return `${mname} ${rname} (\n\t\t\t\t${serial}\t; serial\n\t\t\t\t${refresh}\t; refresh\n\t\t\t\t${retry}\t; retry\n\t\t\t\t${expire}\t; expire\n\t\t\t\t${minimum} )\t; minimum`
  }
  return r.content
}

const nameOrder = (a: string, b: string): number => {
  if (a === b) return 0
  if (a === '@') return -1
  if (b === '@') return 1
  return a.localeCompare(b)
}

/** Render canonical records as a BIND zone file with relative names under $ORIGIN. */
export const renderBindZone = (records: RecordInput[], opts: { ttl?: number } = {}): string => {
  const recs = validateZone(records, { requireSoa: false })
  const zone = recs[0]?.zone
  if (!zone) return invalid('zone', '', 'has no records to export')
  const defaultTtl = assertTtl(opts.ttl ?? DEFAULT_TTL)
  const sorted = [...recs].sort((a, b) => {
    if (a.type === 'SOA' || b.type === 'SOA') return TYPE_ORDER[a.type] - TYPE_ORDER[b.type]
    return nameOrder(a.name, b.name) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.content.localeCompare(b.content)
  })
  const lines = [`; zone ${zone} exported by xPanel`, `$ORIGIN ${zone}.`, `$TTL ${defaultTtl}`]
  for (const r of sorted) lines.push(`${r.name}\t${r.ttl}\tIN\t${r.type}\t${rdata(r)}`)
  return `${lines.join('\n')}\n`
}
