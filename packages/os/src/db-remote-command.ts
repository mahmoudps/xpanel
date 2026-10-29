import { formatCidr, parseCidr } from '@xpanel/core'
import type { Cidr } from '@xpanel/core'

/**
 * Reviewed nft(8) grammar for the remote-database source sets inside the xPanel-owned table.
 * The renderer declares both interval sets and the TCP/3306 accept rules; this grammar only reads
 * them and replaces their elements. No caller-selected table, set, family, port or verdict.
 */
export const DB_REMOTE_NFT = '/usr/sbin/nft'
export const DB_REMOTE_TABLE = 'xpanel'
export const DB_REMOTE_SET_V4 = 'xpanel_dbremote4'
export const DB_REMOTE_SET_V6 = 'xpanel_dbremote6'
// shortcut: the whole union travels in one argv word (Linux MAX_ARG_STRLEN is 128 KiB); upgrade to a protected nft -f file when more sources are needed.
export const DB_REMOTE_MAX_ELEMENTS = 1024
export type DbRemoteFamily = 4 | 6

const setOf = (family: DbRemoteFamily): string => family === 4 ? DB_REMOTE_SET_V4 : DB_REMOTE_SET_V6
/** nft(8) -j prints the set in the libnftables-json(5) schema. */
export const dbRemoteListArgv = (family: DbRemoteFamily): string[] => [DB_REMOTE_NFT, '-j', 'list', 'set', 'inet', DB_REMOTE_TABLE, setOf(family)]

const contains = (outer: Cidr, inner: Cidr): boolean => {
  const bits = outer.version === 4 ? 32 : 128
  return outer.version === inner.version && outer.prefix <= inner.prefix && outer.value >> BigInt(bits - outer.prefix) === inner.value >> BigInt(bits - outer.prefix)
}

/**
 * Canonical, de-duplicated sources with contained networks removed, so the elements never overlap and
 * `add element` is valid with or without auto-merge. Same host rule as the remote-access policy:
 * canonical CIDR, no /0, IPv6 exact addresses only.
 */
export function canonicalDbRemoteSources(sources: readonly unknown[]): { v4: string[]; v6: string[] } {
  if (!Array.isArray(sources)) throw new Error('invalid_remote_database_sources')
  const parsed: Cidr[] = []
  for (const source of sources) {
    const cidr = parseCidr(source)
    if (!cidr || formatCidr(cidr) !== source || cidr.prefix === 0 || cidr.version === 6 && cidr.prefix !== 128) throw new Error('invalid_remote_database_source')
    parsed.push(cidr)
  }
  parsed.sort((a, b) => a.version - b.version || a.prefix - b.prefix || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
  const kept: Cidr[] = []
  for (const cidr of parsed) if (!kept.some(outer => contains(outer, cidr))) kept.push(cidr)
  kept.sort((a, b) => a.version - b.version || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
  const v4 = kept.filter(cidr => cidr.version === 4).map(formatCidr), v6 = kept.filter(cidr => cidr.version === 6).map(formatCidr)
  if (v4.length > DB_REMOTE_MAX_ELEMENTS || v6.length > DB_REMOTE_MAX_ELEMENTS) throw new Error('remote_database_source_capacity')
  return { v4, v6 }
}

/** nft(8): commands given on the command line form one transaction, so both sets change atomically or not at all. */
export function dbRemoteReplaceArgv(sources: readonly unknown[]): string[] {
  const { v4, v6 } = canonicalDbRemoteSources(sources)
  const target = `inet ${DB_REMOTE_TABLE}`
  return [DB_REMOTE_NFT, [
    `flush set ${target} ${DB_REMOTE_SET_V4}`, `flush set ${target} ${DB_REMOTE_SET_V6}`,
    ...(v4.length ? [`add element ${target} ${DB_REMOTE_SET_V4} { ${v4.join(', ')} }`] : []),
    ...(v6.length ? [`add element ${target} ${DB_REMOTE_SET_V6} { ${v6.join(', ')} }`] : []),
  ].join('; ')]
}

const REPLACE = /^flush set inet xpanel xpanel_dbremote4; flush set inet xpanel xpanel_dbremote6(?:; add element inet xpanel xpanel_dbremote4 \{ ([^{};]+) \})?(?:; add element inet xpanel xpanel_dbremote6 \{ ([^{};]+) \})?$/

export function isDatabaseRemoteCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  const same = (allowed: readonly string[]): boolean => allowed.length === argv.length && allowed.every((value, index) => value === argv[index])
  if (same(dbRemoteListArgv(4)) || same(dbRemoteListArgv(6))) return true
  if (argv.length !== 2 || argv[0] !== DB_REMOTE_NFT || (argv[1] as string).length > 131072) return false
  const match = REPLACE.exec(argv[1] as string)
  if (!match) return false
  // Only the exact canonical rebuild of the same elements is admitted; reordered or overlapping text is refused.
  try { return same(dbRemoteReplaceArgv([...(match[1]?.split(', ') ?? []), ...(match[2]?.split(', ') ?? [])])) } catch { return false }
}
