import { DAV_PUBLIC_PORTS, fail, MANAGEMENT_BACKEND_PORTS, validateDomainName } from '@xpanel/core'
import type { SecListener } from './sec-policy.ts'

/** Saved by the API, read by its request gate; a root console reset (`xpanel panel-access reset`) always clears it. */
export const PANEL_GATE_STATE = 'extended/server/sec-panel-gate.json'
export const PANEL_TEMPORARY_LOGINS_STATE = 'extended/server/sec-panel-temporary-logins.json'
const LISTENERS: readonly SecListener[] = ['xpanel', 'xwhm', 'xmail']

export const UNAUTH_RESPONSES = ['not-found', 'forbidden', 'blank', 'redirect'] as const
export type UnauthResponseKind = typeof UNAUTH_RESPONSES[number]
export interface PanelGatePolicy {
  entrance: { path: string; listeners: SecListener[] } | null
  response: { kind: UnauthResponseKind; url: string | null }
  basicAuth: { username: string; passwordHash: string; listeners: SecListener[] } | null
  /** xWHM never stops: it is the page that starts the others. */
  stopped: SecListener[]
}
export const PANEL_GATE_DEFAULT: PanelGatePolicy = { entrance: null, response: { kind: 'not-found', url: null }, basicAuth: null, stopped: [] }

export interface PanelTemporaryLogin {
  id: string
  tokenHash: string
  note: string
  issuerId: string
  issuer: string
  createdAt: string
  expiresAt: string
  usedAt: string | null
  revokedAt: string | null
}
export interface PanelTemporaryLogins { logins: PanelTemporaryLogin[] }
export const PANEL_TEMPORARY_LOGINS_DEFAULT: PanelTemporaryLogins = { logins: [] }
export const PANEL_TEMPORARY_LOGINS_MAX = 64
export const TEMPORARY_LIFETIME_MINUTES = { min: 5, max: 1440 } as const

const unchanged = { stateChanged: false }
const invalid = (message: string, reason?: string): never => fail('VALIDATION', message, { ...unchanged, ...(reason ? { reason } : {}) })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, expected: readonly string[]): boolean => Object.keys(value).sort().join() === [...expected].sort().join()
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const ISO = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

const listeners = (value: unknown, what: string): SecListener[] => {
  if (!Array.isArray(value) || value.length < 1 || value.some(item => !LISTENERS.includes(item as SecListener))) return invalid(`${what} must name at least one entry point`)
  return LISTENERS.filter(name => value.includes(name))
}

/** One path segment; the digit keeps it apart from every page name. */
export function parseEntrancePath(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) return invalid('the entrance may hold only letters, digits, hyphens and underscores', 'ENTRANCE_INVALID')
  if (value.length < 8) return invalid('the entrance must be at least 8 characters', 'ENTRANCE_TOO_SHORT')
  if (value.length > 64) return invalid('the entrance must be at most 64 characters', 'ENTRANCE_INVALID')
  return /[0-9]/.test(value) ? value : invalid('the entrance must contain a digit', 'ENTRANCE_INVALID')
}

const redirectUrl = (value: unknown): string => {
  let url: URL | null = null
  try { url = typeof value === 'string' && value.length <= 512 && !UNSAFE.test(value) ? new URL(value) : null } catch { url = null }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.href !== value) return invalid('the redirect must be one exact https address')
  return url.href
}

export const BASIC_USERNAME = /^[A-Za-z0-9._-]{1,64}$/
const PASSWORD_HASH = /^\$argon2id\$[A-Za-z0-9$=,+/-]{16,480}$/

export function parsePanelGatePolicy(value: unknown): PanelGatePolicy {
  if (!object(value) || !keys(value, ['entrance', 'response', 'basicAuth', 'stopped'])) return invalid('panel gate fields are incomplete or unknown')
  const entrance = value.entrance === null ? null
    : object(value.entrance) && keys(value.entrance, ['path', 'listeners']) ? { path: parseEntrancePath(value.entrance.path), listeners: listeners(value.entrance.listeners, 'the entrance') } : invalid('the entrance needs a path and entry points')
  const response = value.response
  if (!object(response) || !keys(response, ['kind', 'url']) || !UNAUTH_RESPONSES.includes(response.kind as UnauthResponseKind)) return invalid('the unauthenticated response is not recognised')
  const kind = response.kind as UnauthResponseKind
  const url = kind === 'redirect' ? redirectUrl(response.url) : response.url === null ? null : invalid('only a redirect takes an address')
  const basic = value.basicAuth
  const basicAuth = basic === null ? null
    : object(basic) && keys(basic, ['username', 'passwordHash', 'listeners']) && typeof basic.username === 'string' && BASIC_USERNAME.test(basic.username) && typeof basic.passwordHash === 'string' && PASSWORD_HASH.test(basic.passwordHash)
      ? { username: basic.username, passwordHash: basic.passwordHash, listeners: listeners(basic.listeners, 'basic authentication') } : invalid('basic authentication needs a username, a password and entry points')
  if (!Array.isArray(value.stopped) || value.stopped.some(item => item !== 'xpanel' && item !== 'xmail')) return invalid('only xPanel and xMail can be stopped, never xWHM', 'XWHM_NOT_STOPPABLE')
  return { entrance, response: { kind, url }, basicAuth, stopped: LISTENERS.filter(name => (value.stopped as unknown[]).includes(name)) }
}

export function parsePanelTemporaryLogins(value: unknown): PanelTemporaryLogins {
  if (!object(value) || !keys(value, ['logins']) || !Array.isArray(value.logins) || value.logins.length > PANEL_TEMPORARY_LOGINS_MAX) return invalid('temporary sign-in links are invalid')
  const logins = value.logins.map(item => {
    if (!object(item) || !keys(item, ['id', 'tokenHash', 'note', 'issuerId', 'issuer', 'createdAt', 'expiresAt', 'usedAt', 'revokedAt'])
      || typeof item.id !== 'string' || !/^[0-9a-f]{16}$/.test(item.id) || typeof item.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(item.tokenHash)
      || typeof item.note !== 'string' || item.note.length > 128 || UNSAFE.test(item.note) || typeof item.issuerId !== 'string' || typeof item.issuer !== 'string' || item.issuer.length > 254
      || !ISO(item.createdAt) || !ISO(item.expiresAt) || !(item.usedAt === null || ISO(item.usedAt)) || !(item.revokedAt === null || ISO(item.revokedAt))) return invalid('a temporary sign-in link is invalid')
    return { id: item.id, tokenHash: item.tokenHash, note: item.note, issuerId: item.issuerId, issuer: item.issuer, createdAt: item.createdAt, expiresAt: item.expiresAt, usedAt: item.usedAt, revokedAt: item.revokedAt } as PanelTemporaryLogin
  })
  return { logins }
}

export interface PanelBinding { ports: Record<SecListener, number>; hosts: Record<SecListener, string | null> }
export const PANEL_BINDING_DEFAULT: PanelBinding = { ports: { xpanel: 2083, xwhm: 2087, xmail: 2096 }, hosts: { xpanel: null, xwhm: null, xmail: null } }
const FIXED_PORTS = [80, 443, ...DAV_PUBLIC_PORTS, ...MANAGEMENT_BACKEND_PORTS]

/** The port grammar the root lifecycle repeats in scripts/management-tls.mjs. `taken` holds the ports of this server that are not the panel's. */
export function parsePanelBinding(value: unknown, taken: readonly number[] = []): PanelBinding {
  if (!object(value) || !keys(value, ['ports', 'hosts']) || !object(value.ports) || !keys(value.ports, LISTENERS) || !object(value.hosts) || !keys(value.hosts, LISTENERS)) return invalid('the panel binding needs a port and a host for each entry point')
  const ports = {} as PanelBinding['ports'], hosts = {} as PanelBinding['hosts']
  for (const name of LISTENERS) {
    const port = value.ports[name], host = value.hosts[name]
    if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) return invalid('a port must be a whole number from 1 to 65535', 'INVALID_PORT')
    if ([...FIXED_PORTS, ...taken].includes(port)) return fail('CONFLICT', `port ${port} is in use by this server`, { ...unchanged, reason: 'PORT_IN_USE', port })
    ports[name] = port
    if (host === null) { hosts[name] = null; continue }
    let parsed: string
    try { parsed = validateDomainName(host) } catch { return invalid('the host must be a fully qualified domain name', 'INVALID_HOST') }
    if (parsed !== host || parsed.length > 248) return invalid('the host must be a fully qualified lowercase domain name', 'INVALID_HOST')
    hosts[name] = parsed
  }
  if (new Set(Object.values(ports)).size !== 3) return fail('CONFLICT', 'each entry point needs its own port', { ...unchanged, reason: 'PORT_IN_USE' })
  const named = Object.values(hosts).filter(Boolean)
  if (new Set(named).size !== named.length) return invalid('each entry point needs its own host name', 'INVALID_HOST')
  return { ports, hosts }
}
