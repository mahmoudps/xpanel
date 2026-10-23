import { createHash } from 'node:crypto'
import type { Principal } from '@xpanel/core'

export type EntryPoint = 'xpanel' | 'xwhm' | 'xmail'

export const ENTRY_POINTS = Object.freeze({
  xpanel: Object.freeze({ port: 2083, home: '/panel', roles: Object.freeze(['user'] as const) }),
  xwhm: Object.freeze({ port: 2087, home: '/whm', roles: Object.freeze(['root', 'reseller'] as const) }),
  xmail: Object.freeze({ port: 2096, home: '/mail', roles: Object.freeze(['user'] as const) }),
})

export const entryPointAllowsRole = (entryPoint: EntryPoint, role: Principal['kind']): boolean =>
  (ENTRY_POINTS[entryPoint].roles as readonly string[]).includes(role)

// Cookie paths and names do not isolate ports. The stored credential must also bind its audience.
export const sessionTokenHash = (rawToken: string, entryPoint?: EntryPoint): string =>
  createHash('sha256').update(entryPoint ? `xpanel-session:v1:${entryPoint}\0${rawToken}` : rawToken, 'utf8').digest('hex')

export const sessionCookieName = (entryPoint?: EntryPoint, secure = false): string =>
  `${secure ? '__Host-' : ''}${entryPoint ?? 'xpanel'}_session`

const authRoutes = new Set(['login', 'logout', 'me', 'change-password', '2fa/setup', '2fa/enable', '2fa/disable'])
const ownerFamilies = /^\/api\/(?:domains|databases|service-users|dns|backups|web-features|git|cache|containers|apps|analytics)(?:\/|$)/
const administratorFamilies = /^\/api\/(?:server|setup|feature-lists|plans|resellers|accounts|ips|domains|databases|service-users|dns|mail|backups|transfers|lifecycle|web-features|git|cache|containers|apps|analytics|firewall|generations|reconcile|cluster|whmcs|audit|branding|languages)(?:\/|$)/

/** Listener confinement is additional to, and never a replacement for, route RBAC and ownership checks. */
export const entryPointAllowsApiRoute = (entryPoint: EntryPoint, pathname: string, method: string): boolean => {
  if (method === 'GET' && pathname === '/api/health') return true
  if (pathname.startsWith('/api/auth/')) return authRoutes.has(pathname.slice('/api/auth/'.length))
  if (entryPoint === 'xmail') return /^\/api\/webmail(?:\/|$)/.test(pathname)
  if (['/api/catalog', '/api/events/recent'].includes(pathname)) return method === 'GET'
  if (entryPoint === 'xwhm') return pathname === '/api/search' ? method === 'GET' : administratorFamilies.test(pathname)
  if (/^\/api\/accounts(?:\/[^/]+)?$/.test(pathname)) return method === 'GET'
  if (/^\/api\/accounts\/[^/]+\/(?:files|shell)$/.test(pathname)) return true
  if (ownerFamilies.test(pathname)) return !['/api/databases/mongo', '/api/analytics/io', '/api/analytics/websites/ingest'].includes(pathname)
  if (/^\/api\/mail(?:\/|$)/.test(pathname)) return pathname !== '/api/mail/ips' && pathname !== '/api/mail/caldav-carddav'
  return method === 'GET' && ['/api/branding', '/api/languages'].includes(pathname)
}
