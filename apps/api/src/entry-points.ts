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

/** A mailbox sign-in persists a user principal named by its address hash (mail/inbox.ts mailboxPrincipalUsername). */
export const isMailboxPrincipalUsername = (username: string): boolean =>
  /^mbx[0-9a-f]{28}$/i.test(username) || username.includes('@')

/** xMail admits only mailbox principals, and xPanel admits only account owners: the user kind alone is not enough. */
export const entryPointAdmitsPrincipal = (entryPoint: EntryPoint, principal: { kind: Principal['kind']; username: string }): boolean =>
  entryPointAllowsRole(entryPoint, principal.kind)
  && (principal.kind !== 'user' || (entryPoint === 'xmail') === isMailboxPrincipalUsername(principal.username))

// Cookie paths and names do not isolate ports. The stored credential must also bind its audience.
export const sessionTokenHash = (rawToken: string, entryPoint?: EntryPoint): string =>
  createHash('sha256').update(entryPoint ? `xpanel-session:v1:${entryPoint}\0${rawToken}` : rawToken, 'utf8').digest('hex')

export const sessionCookieName = (entryPoint?: EntryPoint, secure = false): string =>
  `${secure ? '__Host-' : ''}${entryPoint ?? 'xpanel'}_session`

const authRoutes = new Set(['login', 'logout', 'me', 'change-password', '2fa/setup', '2fa/enable', '2fa/disable', 'team/password'])
const ownerFamilies = /^\/api\/(?:domains|databases|service-users|dns|backups|web-features|git|cache|containers|apps|analytics)(?:\/|$)/
const administratorFamilies = /^\/api\/(?:server|setup|jobs|feature-lists|plans|resellers|accounts|ips|domains|databases|service-users|dns|mail|backups|transfers|lifecycle|web-features|git|cache|containers|apps|analytics|firewall|generations|reconcile|cluster|audit)(?:\/|$)/

/** Listener confinement is additional to, and never a replacement for, route RBAC and ownership checks. */
export const entryPointAllowsApiRoute = (entryPoint: EntryPoint, pathname: string, method: string): boolean => {
  if (method === 'GET' && pathname === '/api/health') return true
  if (pathname.startsWith('/api/auth/')) return authRoutes.has(pathname.slice('/api/auth/'.length))
  // Each listener issues handoffs only toward the one panel it may open.
  if (pathname === '/api/handoff/xpanel') return entryPoint === 'xwhm' && method === 'POST'
  if (pathname === '/api/handoff/xmail') return entryPoint === 'xpanel' && method === 'POST'
  if (pathname === '/api/integrations/whmcs/provision') return entryPoint === 'xwhm' && method === 'POST'
  if (entryPoint === 'xmail') {
    if (method === 'GET' && pathname === '/api/ws') return true
    return /^\/api\/webmail(?:\/|$)/.test(pathname)
  }
  if (['/api/catalog', '/api/events/recent'].includes(pathname)) return method === 'GET'
  if (pathname === '/api/admin/preferences') return entryPoint === 'xwhm' && (method === 'GET' || method === 'PUT')
  if (entryPoint === 'xwhm' && (/^\/api\/certificate-workspace(?:\/|$)/.test(pathname) || /^\/api\/security\/(?:workspace|ssh(?:\/keys)?)$/.test(pathname))) return true
  if (entryPoint === 'xwhm') return pathname === '/api/search' ? method === 'GET' : administratorFamilies.test(pathname)
  if (/^\/api\/backups\/files(?:\/|$)/.test(pathname)) return false
  if (/^\/api\/backups\/components(?:\/|$)/.test(pathname)) return false
  if (pathname === '/api/account/preferences') return method === 'GET' || method === 'PATCH'
  if (pathname === '/api/account/collaboration') return method === 'GET'
  if (pathname === '/api/account/collaboration/calendars') return method === 'POST'
  if (/^\/api\/account\/collaboration\/calendars\/[0-9a-f]{32}$/.test(pathname)) return method === 'PATCH' || method === 'DELETE'
  if (pathname === '/api/account/mailx/collections') return method === 'GET' || method === 'PUT'
  if (pathname === '/api/account/mailx/mail-tools') return method === 'GET'
  if (pathname === '/api/account/mailx/mail-tools/lists') return method === 'GET' || method === 'POST'
  if (pathname === '/api/account/mailx/mail-tools/learn' || pathname === '/api/account/mailx/mail-tools/apply') return method === 'POST'
  if (pathname === '/api/account/mailx/archive') return method === 'GET' || method === 'PUT'
  if (pathname === '/api/account/mailx/archive/retention') return method === 'POST'
  if (pathname === '/api/account/backups') return method === 'GET' || method === 'POST'
  if (/^\/api\/account\/backups\/[^/]+\/(?:preview|restore)$/.test(pathname)) return method === 'POST'
  if (/^\/api\/account\/backups\/[^/]+\/(?:download|preview\.csv)$/.test(pathname)) return method === 'GET'
  if (pathname === '/api/account/cron') return method === 'GET' || method === 'POST'
  if (/^\/api\/account\/cron\/[0-9a-f-]{36}$/.test(pathname)) return method === 'PATCH' || method === 'DELETE'
  if (/^\/api\/account\/cron\/[0-9a-f-]{36}\/status$/.test(pathname)) return method === 'GET'
  if (/^\/api\/account\/cron\/[0-9a-f-]{36}\/run$/.test(pathname)) return method === 'POST'
  if (pathname === '/api/account/ssh/keys') return method === 'GET' || method === 'POST' || method === 'DELETE'
  if (pathname === '/api/account/terminal') return method === 'GET' || method === 'POST' || method === 'DELETE'
  if (/^\/api\/account\/dynamic-dns(?:\/ddns_[A-Za-z0-9_-]{22}(?:\/rotate)?)?$/.test(pathname)) return method === 'GET' || method === 'POST' || method === 'DELETE'
  if (pathname === '/api/account/git') return method === 'GET' || method === 'POST'
  if (pathname === '/api/account/packages' || pathname === '/api/account/database-remote-access' || pathname === '/api/account/developer') return method === 'GET' || method === 'POST'
  if (/^\/api\/account\/pgp(?:\/(?:[A-F0-9]{40}|[A-F0-9]{64})\/public)?$/.test(pathname)) return method === 'GET' || method === 'POST' || method === 'DELETE'
  if (/^\/api\/account\/logs\/[0-9a-f-]{36}\/(?:access|error)$/.test(pathname)) return method === 'GET'
  if (pathname === '/api/account/site-health') return method === 'GET'
  if (pathname === '/api/account/sec/waf') return method === 'GET' || method === 'PUT'
  if (pathname === '/api/account/sec/cloudflare' || pathname === '/api/account/sec/cloudflare/zone') return method === 'GET'
  if (pathname === '/api/account/sec/cloudflare/purge') return method === 'POST'
  if (pathname === '/api/account/staging' || /^\/api\/account\/staging\/[0-9a-f-]{36}$/.test(pathname)) return method === 'GET'
  if (/^\/api\/account\/staging\/[0-9a-f-]{36}\/(?:copy|review|promote|discard)$/.test(pathname)) return method === 'POST'
  if (pathname === '/api/account/announcements') return method === 'GET'
  if (/^\/api\/account\/announcements\/[0-9a-f-]{36}\/dismiss$/.test(pathname)) return method === 'POST'
  if (pathname === '/api/account/team') return method === 'GET' || method === 'POST'
  if (/^\/api\/account\/team\/[0-9a-f-]{36}$/.test(pathname)) return method === 'PUT' || method === 'DELETE'
  if (/^\/api\/account\/team\/[0-9a-f-]{36}\/(?:suspend|reinstate|password-link)$/.test(pathname)) return method === 'POST'
  if (pathname === '/api/account/database-insights') return method === 'GET'
  if (pathname === '/api/account/optimize' || pathname === '/api/account/applications') return method === 'GET'
  if (pathname === '/api/account/applications/jobs') return method === 'POST'
  if (pathname === '/api/account/runtime') return method === 'GET' || method === 'POST'
  if (pathname === '/api/account/runtime/log') return method === 'GET'
  if (/^\/api\/account\/database-engines\/(?:postgresql|phpmyadmin|phppgadmin)$/.test(pathname)) return method === 'GET'
  if (/^\/api\/account\/database-engines\/postgresql\/(?:users|databases)$/.test(pathname)) return method === 'POST'
  if (/^\/api\/account\/database-engines\/postgresql\/(?:users|databases)\/[0-9a-f-]{36}$/.test(pathname)) return method === 'DELETE'
  if (/^\/api\/account\/database-engines\/postgresql\/(?:users\/[0-9a-f-]{36}\/password|databases\/[0-9a-f-]{36}\/(?:trash|restore))$/.test(pathname)) return method === 'POST'
  if (pathname === '/api/account/database-engines/phpmyadmin/sign-on') return method === 'POST'
  if (pathname === '/api/account/virus-scan') return method === 'GET' || method === 'POST'
  if (/^\/api\/account\/network-tools\/(?:dns|ping|traceroute|port)$/.test(pathname)) return method === 'POST'
  if (/^\/api\/accounts(?:\/[^/]+)?$/.test(pathname)) return method === 'GET'
  if (/^\/api\/accounts\/[^/]+\/files$/.test(pathname)) return true
  if (/^\/api\/accounts\/[^/]+\/certificates$/.test(pathname)) return method === 'GET' || method === 'POST'
  if (/^\/api\/accounts\/[^/]+\/certificates\/install$/.test(pathname)) return method === 'POST'
  if (/^\/api\/accounts\/[^/]+\/certificates\/[0-9a-f-]{36}$/.test(pathname)) return method === 'DELETE'
  if (ownerFamilies.test(pathname)) return !['/api/analytics/io', '/api/analytics/websites/ingest'].includes(pathname)
  if (/^\/api\/mail(?:\/|$)/.test(pathname)) return pathname !== '/api/mail/ips' && pathname !== '/api/mail/caldav-carddav'
  return false
}
