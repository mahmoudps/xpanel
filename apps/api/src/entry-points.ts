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
const administratorFamilies = /^\/api\/(?:server|setup|jobs|feature-lists|plans|resellers|accounts|ips|domains|databases|service-users|dns|mail|backups|transfers|lifecycle|web-features|git|cache|containers|apps|analytics|firewall|generations|reconcile|audit)(?:\/|$)/

/** Listener confinement is additional to, and never a replacement for, route RBAC and ownership checks. */
export const entryPointAllowsApiRoute = (entryPoint: EntryPoint, pathname: string, method: string): boolean => {
  if (method === 'GET' && pathname === '/api/health') return true
  if (pathname === '/api/dav/authorize') return entryPoint === 'xpanel' && method === 'GET'
  if (pathname === '/api/auth/ui-preferences' || pathname === '/api/auth/personal-preferences') return method === 'GET' || method === 'PUT'
  // Personal account credentials are confined to the owner listener; route RBAC still authorizes each call.
  if (pathname === '/api/auth/sessions') return entryPoint === 'xpanel' && method === 'GET'
  if (pathname === '/api/auth/sessions/revoke-others') return entryPoint === 'xpanel' && method === 'POST'
  if (/^\/api\/auth\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pathname)) return entryPoint === 'xpanel' && method === 'DELETE'
  if (pathname === '/api/auth/api-tokens') return entryPoint === 'xpanel' && (method === 'GET' || method === 'POST')
  if (pathname === '/api/auth/api-tokens/revoke') return entryPoint === 'xpanel' && method === 'POST'
  if (/^\/api\/auth\/api-tokens\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(pathname)) return entryPoint === 'xpanel' && method === 'PATCH'
  if (/^\/api\/auth\/api-tokens\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/revoke$/.test(pathname)) return entryPoint === 'xpanel' && method === 'POST'
  // Security questions and external sign-in belong to the panel principals of xPanel and xWHM, never to xMail.
  if (/^\/api\/auth\/(?:security-questions(?:\/addresses)?|oidc\/(?:start|callback|pending)|external-identities(?:\/start|\/[0-9a-f-]{36})?)$/.test(pathname)) return entryPoint !== 'xmail'
  if (pathname.startsWith('/api/auth/')) return authRoutes.has(pathname.slice('/api/auth/'.length))
  // Each listener issues handoffs only toward the one panel it may open.
  if (pathname === '/api/handoff/xpanel') return entryPoint === 'xwhm' && method === 'POST'
  if (pathname === '/api/handoff/xmail') return entryPoint === 'xpanel' && method === 'POST'
  if (pathname === '/api/integrations/whmcs/provision') return entryPoint === 'xwhm' && method === 'POST'
  if (pathname.startsWith('/api/cluster/dns/')) return entryPoint === 'xwhm'
  if (entryPoint === 'xmail') {
    if (method === 'GET' && pathname === '/api/ws') return true
    return /^\/api\/webmail(?:\/|$)/.test(pathname)
  }
  if (['/api/catalog', '/api/events/recent'].includes(pathname)) return method === 'GET'
  if (pathname === '/api/metrics') return entryPoint === 'xwhm' && method === 'GET'
  if (pathname === '/api/admin/preferences' || pathname === '/api/admin/favorites') return entryPoint === 'xwhm' && (method === 'GET' || method === 'PUT')
  if (pathname === '/api/admin/notifications') return entryPoint === 'xwhm' && method === 'GET'
  if (pathname === '/api/admin/notifications/read') return entryPoint === 'xwhm' && method === 'POST'
  if (pathname === '/api/domains/bulk-actions') return entryPoint === 'xwhm' && method === 'POST'
  if (/^\/api\/domains\/[^/]+\/site-settings$/.test(pathname)) return entryPoint === 'xpanel' && (method === 'GET' || method === 'PUT')
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
  if (pathname === '/api/account/mailx/greylisting' || pathname === '/api/account/mailx/routing') return method === 'GET' || method === 'PUT'
  if (pathname === '/api/account/mailx/deliverability') return method === 'GET' || method === 'POST'
  if (pathname === '/api/account/mailx/track-delivery') return method === 'GET'
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
  if (pathname === '/api/account/git/view') return method === 'GET'
  if (pathname === '/api/account/email/disk-usage') return method === 'GET'
  if (pathname === '/api/account/email/disk-usage/cleanup') return method === 'POST'
  if (pathname === '/api/account/packages' || pathname === '/api/account/database-remote-access' || pathname === '/api/account/developer') return method === 'GET' || method === 'POST'
  if (pathname === '/api/account/developer/functions' || pathname === '/api/account/developer/openapi') return method === 'GET'
  if (pathname === '/api/account/developer/call') return method === 'POST'
  if (/^\/api\/account\/pgp(?:\/(?:[A-F0-9]{40}|[A-F0-9]{64})\/public)?$/.test(pathname)) return method === 'GET' || method === 'POST' || method === 'DELETE'
  if (/^\/api\/account\/logs\/[0-9a-f-]{36}\/(?:access|error)$/.test(pathname)) return method === 'GET'
  if (pathname === '/api/account/logs/settings') return method === 'GET' || method === 'PUT'
  if (/^\/api\/account\/logs\/[0-9a-f-]{36}\/access\/download$/.test(pathname)) return method === 'GET'
  if (/^\/api\/account\/logs\/archives(?:\/[a-z0-9.-]{1,280}\.gz)?$/.test(pathname)) return method === 'GET'
  if (pathname === '/api/account/web-stats') return method === 'GET' || method === 'PUT'
  if (/^\/api\/account\/web-stats\/webalizer\/https?\/[a-z0-9.-]{1,253}\/[a-z_0-9.]{1,40}$/.test(pathname)) return method === 'GET'
  if (pathname === '/api/account/site-health') return method === 'GET'
  if (pathname === '/api/account/web-disk' || pathname === '/api/account/calendars-contacts/connection' || pathname === '/api/account/calendars-contacts/connection/apple.mobileconfig') return method === 'GET'
  if (pathname === '/api/account/sec/waf') return method === 'GET' || method === 'PUT'
  if (pathname === '/api/account/ip-blocker' || pathname === '/api/account/edge-cache' || pathname === '/api/account/leech-protection') return method === 'GET' || method === 'POST'
  if (pathname === '/api/account/sec/cloudflare' || pathname === '/api/account/sec/cloudflare/zone') return method === 'GET'
  if (pathname === '/api/account/sec/cloudflare/purge') return method === 'POST'
  if (pathname === '/api/account/staging' || /^\/api\/account\/staging\/[0-9a-f-]{36}$/.test(pathname)) return method === 'GET'
  if (/^\/api\/account\/staging\/[0-9a-f-]{36}\/(?:copy|review|promote|discard)$/.test(pathname)) return method === 'POST'
  if (pathname === '/api/account/announcements') return method === 'GET'
  if (/^\/api\/account\/plugins(?:\/[a-z0-9_-]{1,64}\/[a-z0-9_-]{1,64}\/icon)?$/.test(pathname)) return method === 'GET'
  if (/^\/api\/account\/announcements\/[0-9a-f-]{36}\/dismiss$/.test(pathname)) return method === 'POST'
  if (pathname === '/api/account/team') return method === 'GET' || method === 'POST'
  if (/^\/api\/account\/team\/[0-9a-f-]{36}$/.test(pathname)) return method === 'PUT' || method === 'DELETE'
  if (/^\/api\/account\/team\/[0-9a-f-]{36}\/(?:suspend|reinstate|password-link)$/.test(pathname)) return method === 'POST'
  if (pathname === '/api/account/database-insights') return method === 'GET'
  if (pathname === '/api/account/ftp/sessions' || pathname === '/api/account/ftp/monthly-report') return method === 'GET'
  if (pathname === '/api/account/ftp/sessions/disconnect') return method === 'POST'
  if (pathname === '/api/account/ftp/anonymous') return method === 'GET' || method === 'PUT'
  if (pathname === '/api/account/optimize' || pathname === '/api/account/applications') return method === 'GET'
  if (pathname === '/api/account/applications/jobs' || pathname === '/api/account/applications/recover') return method === 'POST'
  if (pathname === '/api/account/runtime') return method === 'GET' || method === 'POST'
  if (pathname === '/api/account/runtime/log') return method === 'GET'
  if (pathname === '/api/account/file-restoration') return method === 'GET'
  if (/^\/api\/account\/file-restoration\/(?:browse|preview|restore)$/.test(pathname)) return method === 'POST'
  if (pathname === '/api/account/team-audit' || pathname === '/api/account/server-information' || pathname === '/api/account/perl-modules/log' || pathname === '/api/account/perl-modules/search') return method === 'GET'
  if (pathname === '/api/account/perl-modules' || pathname === '/api/account/images' || pathname === '/api/account/website-backups') return method === 'GET' || method === 'POST'
  if (/^\/api\/account\/database-engines\/(?:postgresql|phpmyadmin|phppgadmin)$/.test(pathname)) return method === 'GET'
  if (/^\/api\/account\/database-engines\/postgresql\/(?:users|databases)$/.test(pathname)) return method === 'POST'
  if (/^\/api\/account\/database-engines\/postgresql\/(?:users|databases)\/[0-9a-f-]{36}$/.test(pathname)) return method === 'DELETE'
  if (/^\/api\/account\/database-engines\/postgresql\/(?:users\/[0-9a-f-]{36}\/password|databases\/[0-9a-f-]{36}\/(?:trash|restore))$/.test(pathname)) return method === 'POST'
  if (pathname === '/api/account/database-engines/phpmyadmin/sign-on' || pathname === '/api/account/database-engines/phppgadmin/sign-on') return method === 'POST'
  if (pathname === '/api/account/virus-scan') return method === 'GET' || method === 'POST'
  if (/^\/api\/account\/network-tools\/(?:dns|ping|traceroute|port)$/.test(pathname)) return method === 'POST'
  // The WHM Quota Modification table is for root and resellers only.
  if (pathname === '/api/accounts/disk-quotas') return false
  if (/^\/api\/accounts\/(?:admin|enhancements|skeleton|web-templates)(?:\/|$)/.test(pathname)) return false
  if (/^\/api\/accounts(?:\/[^/]+)?$/.test(pathname)) return method === 'GET'
  if (/^\/api\/accounts\/[^/]+\/files$/.test(pathname)) return true
  if (/^\/api\/accounts\/[^/]+\/certificates$/.test(pathname)) return method === 'GET' || method === 'POST'
  if (/^\/api\/accounts\/[^/]+\/certificates\/install$/.test(pathname)) return method === 'POST'
  if (/^\/api\/accounts\/[^/]+\/certificates\/[0-9a-f-]{36}$/.test(pathname)) return method === 'DELETE'
  if (/^\/api\/accounts\/[^/]+\/ssl$/.test(pathname)) return method === 'GET'
  if (/^\/api\/accounts\/[^/]+\/ssl\/(?:keys|csrs|certificates)$/.test(pathname)) return method === 'POST'
  if (/^\/api\/accounts\/[^/]+\/ssl\/(?:keys|csrs|certificates)\/[a-z0-9][a-z0-9_-]{0,63}$/.test(pathname)) return method === 'GET' || method === 'PATCH' || method === 'DELETE'
  if (ownerFamilies.test(pathname)) return pathname !== '/api/analytics/io'
  if (/^\/api\/mail(?:\/|$)/.test(pathname)) return pathname !== '/api/mail/ips'
  return false
}
