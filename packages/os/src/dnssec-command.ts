/**
 * Reviewed PowerDNS DNSSEC grammar for the BIND backend's key store. pdnsutil 4.5 to 4.9 take these names and
 * pdnsutil 5.0 translates them to its new syntax. Zone names are lowercase punycode, key ids positive integers.
 */
import { PDNS_CONTROL, PDNSUTIL, isServiceDetailZone } from './service-detail-command.ts'

export const DNSSEC_DIG = '/usr/bin/dig'
/** RFC 8624 signing algorithms: 13 is the default; SHA-1 and DSA algorithms are not offered. */
export const DNSSEC_ALGORITHMS = { ecdsa256: 13, ecdsa384: 14, ed25519: 15, rsasha256: 8, rsasha512: 10 } as const
export type DnssecAlgorithm = keyof typeof DNSSEC_ALGORITHMS
export type DnssecKeyVerb = 'activate' | 'deactivate' | 'publish' | 'unpublish' | 'remove'
const VERBS: readonly DnssecKeyVerb[] = ['activate', 'deactivate', 'publish', 'unpublish', 'remove']
const KEY_ID = /^[1-9][0-9]{0,8}$/
// RFC 9276: NSEC3 with zero extra iterations and no salt; flag 1 is opt-out.
export const NSEC3_PARAMS = { plain: '1 0 0 -', optOut: '1 1 0 -' } as const
const RSA_BITS = '2048'

export const isDnssecAlgorithm = (value: unknown): value is DnssecAlgorithm => typeof value === 'string' && Object.hasOwn(DNSSEC_ALGORITHMS, value)
export const isDnssecKeyId = (value: unknown): value is number => Number.isSafeInteger(value) && KEY_ID.test(String(value))
const zone = (value: string): string => { if (!isServiceDetailZone(value)) throw new Error('unsupported_zone'); return value }
const keyId = (value: number): string => { if (!isDnssecKeyId(value)) throw new Error('unsupported_key_id'); return String(value) }

export const dnssecListKeysArgv = (name: string): string[] => [PDNSUTIL, 'list-keys', zone(name)]
export const dnssecShowZoneArgv = (name: string): string[] => [PDNSUTIL, 'show-zone', zone(name)]
/** RSA keys get 2048 bits (RFC 8624); the curve algorithms have a fixed size. */
export function dnssecAddKeyArgv(name: string, type: 'ksk' | 'zsk', algorithm: DnssecAlgorithm, active: boolean, published: boolean): string[] {
  if (!isDnssecAlgorithm(algorithm)) throw new Error('unsupported_algorithm')
  return [PDNSUTIL, 'add-zone-key', zone(name), type, active ? 'active' : 'inactive', published ? 'published' : 'unpublished', ...(algorithm.startsWith('rsa') ? [RSA_BITS] : []), algorithm]
}
export function dnssecKeyArgv(verb: DnssecKeyVerb, name: string, id: number): string[] {
  if (!VERBS.includes(verb)) throw new Error('unsupported_key_verb')
  return [PDNSUTIL, `${verb}-zone-key`, zone(name), keyId(id)]
}
export const dnssecSetNsec3Argv = (name: string, optOut: boolean): string[] => [PDNSUTIL, 'set-nsec3', zone(name), optOut ? NSEC3_PARAMS.optOut : NSEC3_PARAMS.plain]
export const dnssecUnsetNsec3Argv = (name: string): string[] => [PDNSUTIL, 'unset-nsec3', zone(name)]
export const dnssecDisableArgv = (name: string): string[] => [PDNSUTIL, 'disable-dnssec', zone(name)]
/** The BIND backend reads NSEC3 settings when it loads the zone. */
export const dnssecBindReloadArgv = (name: string): string[] => [PDNS_CONTROL, 'bind-reload-now', zone(name)]
export const dnssecPurgeArgv = (name: string): string[] => [PDNS_CONTROL, 'purge', `${zone(name)}$`]
/** Effective settings; the caller keeps only the key store line because other settings can hold secrets. */
export const DNSSEC_CURRENT_CONFIG_ARGV = [PDNS_CONTROL, 'current-config', 'diff'] as const
/** The local authoritative answer with its signatures, for one apex type. */
export const dnssecDigArgv = (name: string, type: 'DNSKEY' | 'SOA'): string[] =>
  [DNSSEC_DIG, '@127.0.0.1', zone(name), type, '+dnssec', '+norecurse', '+noall', '+answer', '+nosplit', '+time=2', '+tries=1']

export function isDnssecCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  const a = argv as string[]
  const z = (value: string | undefined): boolean => isServiceDetailZone(value)
  if (a[0] === PDNSUTIL) {
    if (a.length === 3 && ['list-keys', 'show-zone', 'unset-nsec3', 'disable-dnssec'].includes(a[1]!)) return z(a[2])
    if (a.length === 4 && a[1] === 'set-nsec3') return z(a[2]) && (a[3] === NSEC3_PARAMS.plain || a[3] === NSEC3_PARAMS.optOut)
    if (a.length === 4 && VERBS.some(verb => a[1] === `${verb}-zone-key`)) return z(a[2]) && KEY_ID.test(a[3]!)
    if (a[1] === 'add-zone-key' && (a.length === 7 || a.length === 8) && z(a[2]) && ['ksk', 'zsk'].includes(a[3]!) && ['active', 'inactive'].includes(a[4]!) && ['published', 'unpublished'].includes(a[5]!)) {
      const algorithm = a[a.length - 1]!
      return isDnssecAlgorithm(algorithm) && (algorithm.startsWith('rsa') ? a.length === 8 && a[6] === RSA_BITS : a.length === 7)
    }
    return false
  }
  if (a[0] === PDNS_CONTROL) {
    if (a.length === 3 && a[1] === 'current-config') return a[2] === 'diff'
    if (a.length === 3 && a[1] === 'bind-reload-now') return z(a[2])
    return a.length === 3 && a[1] === 'purge' && a[2]!.endsWith('$') && z(a[2]!.slice(0, -1))
  }
  return a[0] === DNSSEC_DIG && a.length === 11 && a[1] === '@127.0.0.1' && z(a[2]) && ['DNSKEY', 'SOA'].includes(a[3]!)
    && a.slice(4).join(' ') === '+dnssec +norecurse +noall +answer +nosplit +time=2 +tries=1'
}
