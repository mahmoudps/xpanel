import { createHash, randomBytes } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { PanelHandoffAudience, PanelHandoffLanding } from '@xpanel/db'
import { ENTRY_POINTS } from './entry-points.ts'

/** A handed-off session never outlives an ordinary 24 h session; one hour bounds an operator's visit. */
export const HANDOFF_SESSION_TTL_MS = 3600_000

/** The hidden form posts `token=<43 base64url chars>`; anything larger is refused before parsing. */
export const HANDOFF_FORM_MAX_BYTES = 256

const TOKEN = /^[A-Za-z0-9_-]{43}$/

/** 256-bit secret, transported once in a POST body and never stored. */
export const newHandoffToken = (): string => randomBytes(32).toString('base64url')

/** Domain-separated so a handoff secret can never match a session, API or team credential hash. */
export const handoffTokenHash = (token: string): string =>
  createHash('sha256').update(`xpanel-handoff:v1\0${token}`, 'utf8').digest('hex')

/** Exactly one `token` field in an `application/x-www-form-urlencoded` body; no other field or duplicate. */
export const parseHandoffForm = (contentType: string | null, body: string): string | null => {
  if (contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') return null
  if (Buffer.byteLength(body, 'utf8') > HANDOFF_FORM_MAX_BYTES) return null
  const fields = [...new URLSearchParams(body)]
  if (fields.length !== 1 || fields[0]![0] !== 'token') return null
  return TOKEN.test(fields[0]![1]) ? fields[0]![1] : null
}

/** The only places a consumed handoff may land; the browser never supplies a path. */
export const handoffLandingPath = (audience: PanelHandoffAudience, landing: PanelHandoffLanding): string =>
  audience === 'xpanel' ? ENTRY_POINTS.xpanel.home
    : landing === 'calendar' ? '/mail/calendar' : landing === 'contacts' ? '/mail/contacts' : ENTRY_POINTS.xmail.home

export const parseHandoffLanding = (value: unknown): PanelHandoffLanding =>
  value === undefined ? 'home'
    : value === 'home' || value === 'calendar' || value === 'contacts' ? value
      : fail('VALIDATION', 'landing must be home, calendar or contacts')

/**
 * An impersonated session acts for the target, never as the target's sign-in identity: it cannot change the
 * password, second factor, API tokens, team or contact identity.
 */
export const impersonationForbidsRoute = (pathname: string, method: string): boolean => {
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
  if (pathname === '/api/auth/change-password' || pathname.startsWith('/api/auth/2fa/')) return true
  if (pathname.startsWith('/api/handoff/')) return true
  if (!write) return false
  return pathname === '/api/account/preferences'
    || /^\/api\/account\/team(?:\/|$)/.test(pathname)
    || /(?:^|\/)api-tokens(?:\/|$)/.test(pathname)
    || /^\/api\/accounts\/[^/]+$/.test(pathname)
}
