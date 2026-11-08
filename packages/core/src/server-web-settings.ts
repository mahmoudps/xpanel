import { validateDomainIndexFiles } from './default-index.ts'
import { fail } from './errors.ts'
import type { ServerWebSettings, TlsProtocol } from './types.ts'

const TLS_PROTOCOLS: readonly TlsProtocol[] = ['TLSv1.2', 'TLSv1.3']
const INCLUDE_KEYS = ['apachePreMain', 'apachePreVhost', 'apachePostVhost', 'nginxHttp'] as const
const KEYS = ['timeoutSec', 'clientMaxBodyMb', 'tlsProtocols', 'tlsCiphers', 'gzip', 'directoryIndex', 'rlimitMemMb', 'rlimitCpuSec', 'includes']

const record = (v: unknown, what: string, keys: readonly string[]): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).every((k) => keys.includes(k)) && keys.every((k) => Object.hasOwn(v, k))
    ? (v as Record<string, unknown>)
    : fail('VALIDATION', `${what} must be { ${keys.join(', ')} }`)
const int = (v: unknown, min: number, max: number, what: string): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fail('VALIDATION', `${what} must be an integer from ${min} to ${max}`)
const optionalInt = (v: unknown, min: number, max: number, what: string): number | null => (v === null ? null : int(v, min, max, what))

/** What the web servers apply while nothing is saved: the values the edge and backend have always been rendered with. */
export const defaultServerWebSettings = (): ServerWebSettings => ({
  timeoutSec: 300,
  clientMaxBodyMb: 128,
  tlsProtocols: ['TLSv1.2', 'TLSv1.3'],
  // nginx's built-in ssl_ciphers value
  tlsCiphers: 'HIGH:!aNULL:!MD5',
  // nginx's built-in gzip_comp_level
  gzip: { enabled: true, level: 1 },
  directoryIndex: ['index.php', 'index.html', 'index.htm'],
  rlimitMemMb: null,
  rlimitCpuSec: null,
  includes: { apachePreMain: '', apachePreVhost: '', apachePostVhost: '', nginxHttp: '' },
})

/** The saved directives, or the defaults while none are saved. */
export const effectiveServerWebSettings = (settings: { web?: ServerWebSettings }): ServerWebSettings => settings.web ?? defaultServerWebSettings()

/** Structure and bounds only; the directives are config-tested before any reload. */
export const validateServerWebSettings = (v: unknown): ServerWebSettings => {
  const o = record(v, 'web settings', KEYS)
  const protocols = o.tlsProtocols
  if (!Array.isArray(protocols) || protocols.length === 0 || protocols.some((p) => !TLS_PROTOCOLS.includes(p as TlsProtocol)) || new Set(protocols).size !== protocols.length) {
    return fail('VALIDATION', 'tlsProtocols must be distinct values from TLSv1.2 and TLSv1.3')
  }
  if (typeof o.tlsCiphers !== 'string' || !/^[A-Za-z0-9:+!@=_-]{1,1024}$/.test(o.tlsCiphers)) return fail('VALIDATION', 'tlsCiphers must be an OpenSSL cipher list')
  const gzip = record(o.gzip, 'gzip', ['enabled', 'level'])
  if (typeof gzip.enabled !== 'boolean') return fail('VALIDATION', 'gzip.enabled must be a boolean')
  const includes = record(o.includes, 'includes', INCLUDE_KEYS)
  for (const key of INCLUDE_KEYS) {
    const text = includes[key]
    if (typeof text !== 'string' || text.length > 65536 || text.includes('\0')) return fail('VALIDATION', `includes.${key} must be text of at most 65536 characters`)
  }
  return {
    timeoutSec: int(o.timeoutSec, 1, 3600, 'timeoutSec'),
    clientMaxBodyMb: int(o.clientMaxBodyMb, 1, 10240, 'clientMaxBodyMb'),
    tlsProtocols: TLS_PROTOCOLS.filter((p) => protocols.includes(p)),
    tlsCiphers: o.tlsCiphers,
    gzip: { enabled: gzip.enabled, level: int(gzip.level, 1, 9, 'gzip.level') },
    directoryIndex: validateDomainIndexFiles(o.directoryIndex),
    rlimitMemMb: optionalInt(o.rlimitMemMb, 1, 1_048_576, 'rlimitMemMb'),
    rlimitCpuSec: optionalInt(o.rlimitCpuSec, 1, 86_400, 'rlimitCpuSec'),
    includes: { apachePreMain: includes.apachePreMain as string, apachePreVhost: includes.apachePreVhost as string, apachePostVhost: includes.apachePostVhost as string, nginxHttp: includes.nginxHttp as string },
  }
}
