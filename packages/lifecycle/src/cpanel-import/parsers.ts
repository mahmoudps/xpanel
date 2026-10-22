import { validateEmailLocalPart } from '@xpanel/core'
import { parse as parseYaml } from 'yaml'
import { hasControlChars, isAddress, isObj, isUsernameSyntax, passes } from '../validate.ts'

// Parsers for the publicly documented cpmove / pkgacct layout. All input is untrusted text;
// parsers never throw on odd lines, they skip them and the importer reports what it used.

/** cp/<user>: KEY=VALUE lines (PLAN, DNS, DNS1.., CONTACTEMAIL, MAXADDON, ...). */
export const parseCpUserFile = (text: string): Map<string, string> => {
  const m = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Z0-9_-]{1,64}$/.test(key)) continue
    const value = line.slice(eq + 1)
    if (value.length > 4096 || hasControlChars(value)) continue
    m.set(key, value.trim())
  }
  return m
}

/** Domains listed in DNS, DNS1, DNS2, ... in numeric order. */
export const cpDomains = (cp: Map<string, string>): string[] =>
  [...cp.entries()]
    .filter(([k]) => /^DNS\d*$/.test(k))
    .sort(([a], [b]) => Number(a.slice(3) || -1) - Number(b.slice(3) || -1))
    .map(([, v]) => v.toLowerCase())

/** YAML with the failsafe schema: every scalar is a string, no tags or custom types, aliases capped. */
export const parseSafeYaml = (text: string): unknown =>
  parseYaml(text, { schema: 'failsafe', maxAliasCount: 20, prettyErrors: false, uniqueKeys: false, logLevel: 'error' })

export interface UserdataMain {
  mainDomain: string | null
  /** addon domain -> backing subdomain */
  addonDomains: Map<string, string>
  parkedDomains: string[]
  subDomains: string[]
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export const parseUserdataMain = (text: string): UserdataMain => {
  const y = parseSafeYaml(text)
  if (!isObj(y)) throw new Error('userdata/main is not a mapping')
  const addon = new Map<string, string>()
  if (isObj(y.addon_domains)) {
    for (const [k, v] of Object.entries(y.addon_domains)) if (typeof v === 'string') addon.set(k.toLowerCase(), v.toLowerCase())
  }
  return {
    mainDomain: typeof y.main_domain === 'string' ? y.main_domain.toLowerCase() : null,
    addonDomains: addon,
    parkedDomains: strList(y.parked_domains).map((d) => d.toLowerCase()),
    subDomains: strList(y.sub_domains).map((d) => d.toLowerCase()),
  }
}

export interface UserdataDomain {
  servername: string | null
  documentroot: string | null
  homedir: string | null
  serveralias: string[]
  phpversion: string | null
}

export const parseUserdataDomain = (text: string): UserdataDomain => {
  const y = parseSafeYaml(text)
  if (!isObj(y)) throw new Error('userdata file is not a mapping')
  const s = (k: string): string | null => (typeof y[k] === 'string' && !hasControlChars(y[k] as string) ? (y[k] as string) : null)
  return {
    servername: s('servername')?.toLowerCase() ?? null,
    documentroot: s('documentroot'),
    homedir: s('homedir'),
    serveralias: (s('serveralias') ?? '').split(/\s+/).filter(Boolean).map((a) => a.toLowerCase()),
    phpversion: s('phpversion'),
  }
}

/** ea-php81 / alt-php74 / php8.2 -> "8.1" / "7.4" / "8.2"; anything else -> null. */
export const phpVersionHint = (v: string | null): string | null => {
  if (!v) return null
  const m = /^(?:ea-php|alt-php|php)(\d)\.?(\d)$/.exec(v.trim())
  return m ? `${m[1]}.${m[2]}` : null
}

type ForwardDest =
  | { kind: 'address'; address: string }
  | { kind: 'local-user'; user: string }
  | { kind: 'fail'; message: string }
  | { kind: 'blackhole' }
  | { kind: 'pipe' }
  | { kind: 'file' }
  | { kind: 'invalid'; raw: string }

interface ValiasLine {
  /** local@domain as written (lowercased), or '*' for the domain's default address */
  source: string
  dests: ForwardDest[]
}

const parseDest = (raw: string): ForwardDest => {
  const d = raw.trim().replace(/^"(.*)"$/, '$1')
  if (d.startsWith('|')) return { kind: 'pipe' }
  if (d.startsWith('/')) return { kind: 'file' }
  if (d === ':blackhole:') return { kind: 'blackhole' }
  const lower = d.toLowerCase()
  if (isAddress(lower)) return { kind: 'address', address: lower }
  if (isUsernameSyntax(lower)) return { kind: 'local-user', user: lower }
  return { kind: 'invalid', raw: d.slice(0, 200) }
}

/** va/<domain>: "src: dest, dest" lines; :fail: consumes the rest of the line as its message. */
export const parseValiases = (text: string): ValiasLine[] => {
  const out: ValiasLine[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const m = /^([^\s:]+)\s*:\s*(.*)$/.exec(t)
    if (!m) continue
    const source = (m[1] as string).toLowerCase()
    const rest = (m[2] as string).trim()
    if (/^:fail:/i.test(rest)) {
      out.push({ source, dests: [{ kind: 'fail', message: rest.slice(6).trim().slice(0, 200) }] })
      continue
    }
    out.push({ source, dests: rest.split(',').filter((x) => x.trim()).map(parseDest) })
  }
  return out
}

const isLocalPart = passes(validateEmailLocalPart)

/** homedir/etc/<domain>/passwd: local:x:uid:gid:gecos:maildir:home. Only usable local parts are kept. */
export const parseMailPasswd = (text: string): { locals: string[]; rejected: string[] } => {
  const locals: string[] = []
  const rejected: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const local = line.split(':')[0]?.trim() ?? ''
    if (!local) continue
    if (isLocalPart(local) && local === local.toLowerCase()) {
      if (!locals.includes(local)) locals.push(local)
    } else rejected.push(local.slice(0, 64))
  }
  return { locals, rejected }
}

/** homedir/etc/<domain>/quota: local:bytes. */
export const parseMailQuota = (text: string): Map<string, number> => {
  const m = new Map<string, number>()
  for (const line of text.split(/\r?\n/)) {
    const [local, bytes] = line.split(':')
    if (local && bytes && /^\d{1,15}$/.test(bytes.trim())) m.set(local.trim().toLowerCase(), Number(bytes.trim()))
  }
  return m
}
