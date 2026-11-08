import { fail } from './errors.ts'
import type { ServerFtpSettings, ServerSettings } from './types.ts'

export const FTP_TLS_MODES = ['required', 'optional'] as const
const KEYS = ['enabled', 'tls', 'tlsCipherSuite', 'anonymous', 'anonymousUploads', 'maxIdleMinutes', 'maxConnections', 'maxConnectionsPerIp', 'passivePorts', 'brokenClients', 'listingLimit']

/** Pure-FTPd defaults with the port range the host policy has always rendered; an unset block means these values. */
export const DEFAULT_SERVER_FTP_SETTINGS: ServerFtpSettings = Object.freeze({
  enabled: true, tls: 'required', tlsCipherSuite: 'HIGH', anonymous: false, anonymousUploads: false, maxIdleMinutes: 15,
  maxConnections: 150, maxConnectionsPerIp: 8, passivePorts: Object.freeze({ min: 30000, max: 35000 }), brokenClients: false, listingLimit: 10000,
})

const int = (v: unknown, min: number, max: number, what: string): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fail('VALIDATION', `${what} must be an integer from ${min} to ${max}`, { stateChanged: false })
const flag = (v: unknown, what: string): boolean => typeof v === 'boolean' ? v : fail('VALIDATION', `${what} must be a boolean`, { stateChanged: false })

/** Cleartext-only FTP is not offered: TLS is required or optional. Anonymous uploads need anonymous logins. */
export const validateServerFtpSettings = (v: unknown): ServerFtpSettings => {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.keys(v).length !== KEYS.length || !KEYS.every(key => Object.hasOwn(v, key))) return fail('VALIDATION', `FTP settings must be { ${KEYS.join(', ')} }`, { stateChanged: false })
  const o = v as Record<string, unknown>, ports = o.passivePorts as Record<string, unknown> | null
  if (!(FTP_TLS_MODES as readonly unknown[]).includes(o.tls)) return fail('VALIDATION', 'tls must be required or optional; plaintext-only FTP is forbidden', { stateChanged: false })
  if (typeof o.tlsCipherSuite !== 'string' || !/^[A-Za-z0-9:+!@=_-]{1,256}$/.test(o.tlsCipherSuite)) return fail('VALIDATION', 'tlsCipherSuite must be an OpenSSL cipher list', { stateChanged: false })
  if (typeof ports !== 'object' || ports === null || Array.isArray(ports) || Object.keys(ports).sort().join() !== 'max,min') return fail('VALIDATION', 'passivePorts must be { min, max }', { stateChanged: false })
  const min = int(ports.min, 1024, 65534, 'passivePorts.min'), max = int(ports.max, 1025, 65535, 'passivePorts.max')
  if (min >= max) return fail('VALIDATION', 'passivePorts.min must be below passivePorts.max', { stateChanged: false })
  const anonymous = flag(o.anonymous, 'anonymous'), anonymousUploads = flag(o.anonymousUploads, 'anonymousUploads')
  if (anonymousUploads && !anonymous) return fail('VALIDATION', 'anonymous uploads need anonymous logins', { stateChanged: false })
  return {
    enabled: flag(o.enabled, 'enabled'), tls: o.tls as ServerFtpSettings['tls'], tlsCipherSuite: o.tlsCipherSuite, anonymous, anonymousUploads,
    maxIdleMinutes: int(o.maxIdleMinutes, 1, 1440, 'maxIdleMinutes'), maxConnections: int(o.maxConnections, 1, 10000, 'maxConnections'), maxConnectionsPerIp: int(o.maxConnectionsPerIp, 1, 1000, 'maxConnectionsPerIp'),
    passivePorts: { min, max }, brokenClients: flag(o.brokenClients, 'brokenClients'), listingLimit: int(o.listingLimit, 100, 100000, 'listingLimit'),
  }
}

export const effectiveServerFtpSettings = (settings: Pick<ServerSettings, 'ftp'> | null | undefined): ServerFtpSettings => settings?.ftp ?? DEFAULT_SERVER_FTP_SETTINGS
