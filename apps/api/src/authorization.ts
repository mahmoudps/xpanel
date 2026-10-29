import { tools } from '@xpanel/catalog'
import { assertAcl, assertCanSeeAccount, fail, isUuid } from '@xpanel/core'
import type { Account, ResellerAcl } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'

export interface RoutePolicy {
  resource: string
  scopeAccess?: 'read' | 'write'
  acl?: ResellerAcl
  rootOnly?: boolean
  toolIds?: readonly string[]
}

export interface MailboxPrincipalAccess {
  mailbox: string
  serviceUserId: string
  account: Account
}

export type PrincipalContext =
  | { kind: 'root'; id: string; username: string }
  | { kind: 'reseller'; id: string; username: string }
  | { kind: 'user'; id: string; username: string; accountId: string }
  | { kind: 'mailbox'; id: string; username: string; accountId: string; mailbox: string; serviceUserId?: string }

const readMethods = new Set(['GET', 'HEAD', 'OPTIONS'])
const toolById = new Map(tools.map(tool => [tool.id, tool]))
// The authenticated caller is unique to this request; clients cannot supply or replace this policy binding.
const requestPolicies = new WeakMap<AuthenticatedCaller, RoutePolicy>()

export const extractMailboxBinding = (caller: AuthenticatedCaller): { kind: 'id' | 'address'; value: string } | null => {
  const extCaller = caller as AuthenticatedCaller & {
    mailbox?: string | null
    mailboxId?: string | null
    serviceUserId?: string | null
    principalKind?: string | null
  }
  const extPrincipal = caller.principal as {
    kind?: string
    username?: string
    mailbox?: string | null
    mailboxId?: string | null
    serviceUserId?: string | null
  }

  const directId = extCaller.mailboxId ?? extCaller.serviceUserId ?? extPrincipal.mailboxId ?? extPrincipal.serviceUserId
  if (typeof directId === 'string' && directId.trim().length > 0) {
    return { kind: 'id', value: directId.trim().toLowerCase() }
  }
  const directMailbox = extCaller.mailbox ?? extPrincipal.mailbox
  if (typeof directMailbox === 'string' && directMailbox.trim().length > 0) {
    return { kind: 'address', value: directMailbox.trim().toLowerCase() }
  }
  if ((extCaller.principalKind === 'mailbox' || extPrincipal.kind === 'mailbox') && typeof extPrincipal.username === 'string') {
    const candidate = extPrincipal.username.trim().toLowerCase()
    if (candidate.includes('@')) return { kind: 'address', value: candidate }
    if (isUuid(candidate as unknown)) return { kind: 'id', value: candidate }
  }

  for (const rawScope of caller.scopes) {
    if (!rawScope.startsWith('mailbox:')) continue
    const rawTarget: string = rawScope.slice('mailbox:'.length).trim().toLowerCase()
    if (!rawTarget || rawTarget === '*' || rawTarget === 'read' || rawTarget === 'write') continue
    if (rawTarget.includes('@')) return { kind: 'address', value: rawTarget }
    const colonIdx = rawTarget.indexOf(':')
    if (colonIdx > 0 && colonIdx < rawTarget.length - 1) {
      const localPart = rawTarget.slice(0, colonIdx)
      const domainPart = rawTarget.slice(colonIdx + 1)
      return { kind: 'address', value: `${localPart}@${domainPart}` }
    }
    if (isUuid(rawTarget as unknown)) return { kind: 'id', value: rawTarget }
  }
  return null
}

export const isMailboxPrincipal = (caller: AuthenticatedCaller): boolean => {
  const extCaller = caller as AuthenticatedCaller & { principalKind?: string | null }
  const extPrincipal = caller.principal as { kind?: string }
  return extCaller.principalKind === 'mailbox' || extPrincipal.kind === 'mailbox' || extractMailboxBinding(caller) !== null
}

export const isMailboxRouteAllowed = (pathname: string, method: string): boolean => {
  if (/^\/api\/webmail(?:\/|$)/.test(pathname)) return true
  if (/^\/api\/mail\/filters(?:\/|$)/.test(pathname)) return true
  if (method === 'GET' && pathname === '/api/auth/me') return true
  if (method === 'POST' && (pathname === '/api/auth/logout' || pathname === '/api/auth/change-password')) return true
  return false
}

/** A grant is explicit: an empty set and unrelated root-owned grants never expand access. */
export const hasApiScope = (caller: AuthenticatedCaller, scope: string): boolean => {
  const resource = scope.slice(0, scope.lastIndexOf(':'))
  if (caller.scopes.includes('*') || caller.scopes.includes(scope) || caller.scopes.includes(`${resource}:*`)) {
    return true
  }
  if (isMailboxPrincipal(caller)) {
    const nonMailboxScopes = caller.scopes.filter(s => !s.startsWith('mailbox:'))
    if (nonMailboxScopes.length === 0 && (resource === 'webmail' || resource === 'mail' || resource === 'auth')) {
      return true
    }
  }
  return false
}

export const assertApiScope = (caller: AuthenticatedCaller, scope: string): void => {
  if (!hasApiScope(caller, scope)) return fail('FORBIDDEN', 'API token does not grant this operation', { requiredScope: scope })
}

/** Every protected route family declares a resource and a method-sensitive reseller privilege. */
export const policyForRequest = (pathname: string, method: string): RoutePolicy => {
  const read = readMethods.has(method)
  if (/^\/api\/auth(?:\/|$)/.test(pathname)) return { resource: 'auth' }
  // Issuance re-checks the exact target account or mailbox; these rows only admit the issuing role and feature.
  if (pathname === '/api/handoff/xpanel') return { resource: 'handoff', acl: 'edit-account' }
  if (pathname === '/api/handoff/xmail') return { resource: 'handoff', acl: 'edit-account', toolIds: ['email-accounts'] }
  if (pathname === '/api/events/recent') return { resource: 'events' }
  if (pathname === '/api/catalog') return { resource: 'catalog' }
  if (pathname === '/api/account/preferences') return { resource: 'account-preferences', toolIds: ['account-preferences'] }
  if (/^\/api\/account\/collaboration(?:\/calendars(?:\/[0-9a-f]{32})?)?$/.test(pathname)) return { resource: 'webmail', acl: 'edit-account', toolIds: ['email-accounts', 'calendars-contacts-management', 'calendars-contacts-sharing', 'calendars-contacts-config'] }
  if (pathname === '/api/account/mailx/collections') return { resource: 'webmail', acl: 'edit-account', toolIds: ['email-accounts', 'calendars-contacts-management', 'calendars-contacts-config'] }
  if (pathname === '/api/account/mailx/mail-tools/lists') return { resource: 'mail', acl: read ? 'list-accounts' : 'edit-account', toolIds: ['email-accounts', 'mailing-lists'] }
  if (/^\/api\/account\/mailx\/mail-tools(?:\/(?:learn|apply))?$/.test(pathname)) return { resource: 'mail', acl: read ? 'list-accounts' : 'edit-account', toolIds: ['email-accounts', 'spam-filters'] }
  if (/^\/api\/account\/mailx\/archive(?:\/retention)?$/.test(pathname)) return { resource: 'mail', acl: read ? 'list-accounts' : 'edit-account', toolIds: ['email-accounts', 'email-archive'] }
  if (pathname === '/api/admin/preferences') return { resource: 'admin-preferences', toolIds: ['aapanel-language-theme'] }
  if (/^\/api\/account\/backups(?:\/|$)/.test(pathname)) return { resource: 'backups', acl: 'edit-account', toolIds: [/(?:preview|preview\.csv|restore)$/.test(pathname) ? 'backup-restoration' : 'backup'], ...(method === 'POST' && /\/preview$/.test(pathname) ? { scopeAccess: 'read' as const } : {}) }
  if (/^\/api\/account\/cron(?:\/|$)/.test(pathname)) return { resource: 'cron', acl: 'edit-account', toolIds: ['cron-jobs'] }
  if (pathname === '/api/account/ssh/keys') return { resource: 'ssh', acl: 'edit-account', toolIds: ['ssh-access'] }
  if (/^\/api\/account\/dynamic-dns(?:\/|$)/.test(pathname)) return { resource: 'dynamic-dns', acl: 'edit-account', toolIds: ['dynamic-dns'] }
  if (pathname === '/api/account/optimize') return { resource: 'optimize', acl: 'list-accounts', toolIds: ['optimize-website'], scopeAccess: 'read' }
  if (pathname === '/api/account/applications' || pathname === '/api/account/applications/jobs') return { resource: 'applications', acl: read ? 'list-accounts' : 'edit-account', toolIds: ['application-manager'] }
  if (pathname === '/api/account/git') return { resource: 'git', acl: 'edit-account', toolIds: ['git-version-control'] }
  if (/^\/api\/account\/staging(?:\/|$)/.test(pathname)) return { resource: 'staging', acl: 'edit-account', toolIds: ['site-staging'], ...(method === 'POST' && pathname.endsWith('/review') ? { scopeAccess: 'read' as const } : {}) }
  if (pathname === '/api/account/packages') return { resource: 'account-packages', acl: 'edit-account', toolIds: ['php-pear-packages'] }
  if (pathname === '/api/account/database-remote-access') return { resource: 'databases', acl: 'edit-account', toolIds: ['remote-database-access'] }
  if (/^\/api\/account\/database-engines\/(?:postgresql|phppgadmin)$/.test(pathname)) return { resource: 'databases', acl: 'list-accounts', toolIds: [pathname.endsWith('/postgresql') ? 'postgresql-databases' : 'phppgadmin'] }
  if (/^\/api\/account\/database-engines\/postgresql\/(?:users|databases)(?:\/|$)/.test(pathname)) return { resource: 'databases', acl: 'edit-account', toolIds: ['postgresql-databases'] }
  if (/^\/api\/account\/database-engines\/phpmyadmin(?:\/sign-on)?$/.test(pathname)) return { resource: 'databases', acl: 'edit-account', toolIds: ['phpmyadmin'] }
  if (pathname === '/api/account/developer') return { resource: 'developer', scopeAccess: 'read', toolIds: ['api-shell'] }
  if (['/api/server/panel/developer', '/api/server/panel/integrations'].includes(pathname)) return { resource: 'server', rootOnly: true, scopeAccess: 'read' }
  if (/^\/api\/account\/pgp(?:\/|$)/.test(pathname)) return { resource: 'pgp', acl: 'edit-account', toolIds: ['email-encryption'] }
  if (/^\/api\/domains\/[0-9a-f-]{36}\/site-publisher(?:\/|$)/.test(pathname)) return { resource: 'site-publisher', acl: 'edit-account', toolIds: ['site-publisher'], ...(pathname.endsWith('/preview') ? { scopeAccess: 'read' as const } : {}) }
  if (/^\/api\/account\/logs\/[0-9a-f-]{36}\/(?:access|error)$/.test(pathname)) return { resource: 'logs', acl: 'list-accounts', toolIds: [pathname.endsWith('/access') ? 'raw-access' : 'errors'] }
  if (pathname === '/api/account/site-health') return { resource: 'health', acl: 'list-accounts', toolIds: ['account-health-overview'] }
  if (pathname === '/api/account/sec/waf') return { resource: 'waf', acl: read ? 'list-accounts' : 'edit-account', toolIds: ['modsecurity'] }
  if (/^\/api\/account\/sec\/cloudflare(?:\/zone|\/purge)?$/.test(pathname)) return { resource: 'cloudflare', acl: read ? 'list-accounts' : 'edit-account', toolIds: ['cloudflare-account'] }
  if (/^\/api\/account\/announcements(?:\/[0-9a-f-]{36}\/dismiss)?$/.test(pathname)) return { resource: 'accounts' }
  if (/^\/api\/account\/team(?:\/[0-9a-f-]{36}(?:\/(?:suspend|reinstate|password-link))?)?$/.test(pathname)) return { resource: 'team', acl: 'edit-account', toolIds: ['manage-team'] }
  if (pathname === '/api/account/database-insights') return { resource: 'database-insights', acl: 'list-accounts', toolIds: ['database-insights'] }
  if (pathname === '/api/account/virus-scan') return { resource: 'virus-scan', acl: read ? 'list-accounts' : 'edit-account', toolIds: ['virus-scanner'] }
  if (/^\/api\/account\/network-tools\/(?:dns|ping|traceroute|port)$/.test(pathname)) return { resource: 'network-tools', acl: 'list-accounts', toolIds: ['track-dns'], scopeAccess: 'read' }
  if (/^\/api\/certificate-workspace(?:\/|$)/.test(pathname)) return { resource: 'tls', acl: 'manage-ssl', toolIds: ['ssl-install'] }
  if (/^\/api\/security\/(?:workspace|ssh(?:\/keys)?)$/.test(pathname)) return { resource: 'security', rootOnly: true }
  if (pathname === '/api/search') return { resource: 'search', acl: 'list-accounts' }
  if (pathname === '/api/accounts/health') return { resource: 'accounts', acl: 'list-accounts', scopeAccess: 'read' }
  if (/^\/api\/jobs(?:\/|$)/.test(pathname)) return { resource: 'jobs', rootOnly: true }
  if (pathname === '/api/server/mail-quality/check') return { resource: 'server', rootOnly: true, scopeAccess: 'read' }
  if (/^\/api\/server\/default-index\/[^/]+\/preview$/.test(pathname)) return { resource: 'server', rootOnly: true, scopeAccess: 'read' }
  if (pathname === '/api/server/upgrade/preflight') return { resource: 'server', rootOnly: true, scopeAccess: 'read' }
  if (pathname === '/api/server/software-center/preview') return { resource: 'server', rootOnly: true, scopeAccess: 'read' }
  if (pathname === '/api/server/repair/preview') return { resource: 'server', rootOnly: true, scopeAccess: 'read' }
  if (/^\/api\/(?:server|setup)(?:\/|$)/.test(pathname)) return { resource: 'server', rootOnly: true }
  if (/^\/api\/feature-lists(?:\/|$)/.test(pathname)) return { resource: 'feature-lists', acl: 'manage-feature-lists' }
  if (/^\/api\/plans(?:\/|$)/.test(pathname)) return { resource: 'plans', acl: 'manage-plans' }
  if (/^\/api\/resellers(?:\/|$)/.test(pathname)) return { resource: 'resellers', rootOnly: !read }
  if (/^\/api\/accounts\/[^/]+\/files$/.test(pathname)) return { resource: 'files', acl: 'edit-account', toolIds: ['file-manager'] }
  if (/^\/api\/accounts\/[^/]+\/shell$/.test(pathname)) return { resource: 'shell', acl: 'edit-account', toolIds: ['ssh-access'] }
  if (/^\/api\/accounts\/[^/]+\/certificates(?:\/(?:install|[0-9a-f-]{36}))?$/.test(pathname)) return { resource: 'accounts', acl: 'manage-ssl', toolIds: ['ssl-install'] }
  if (/^\/api\/accounts(?:\/|$)/.test(pathname)) {
    const acl: ResellerAcl = read ? 'list-accounts'
      : /\/(?:suspend|unsuspend)$/.test(pathname) ? 'suspend-account'
      : method === 'DELETE' ? 'terminate-account'
      : pathname === '/api/accounts' && method === 'POST' ? 'create-account' : 'edit-account'
    return { resource: 'accounts', acl }
  }
  if (/^\/api\/ips(?:\/|$)/.test(pathname)) return { resource: 'ips', rootOnly: !read, acl: 'list-accounts' }
  if (pathname === '/api/mail/ips') return { resource: 'mail', rootOnly: true }
  if (/^\/api\/domains\/[^/]+\/htaccess(?:\/|$)/.test(pathname)) return { resource: 'files', acl: read ? 'list-accounts' : 'edit-account', toolIds: ['aapanel-url-rewrite'], ...(method === 'POST' && /\/htaccess$/.test(pathname) ? { scopeAccess: 'read' as const } : {}) }
  if (/^\/api\/domains\/[^/]+\/web-directives\/(?:error-pages|indexes|mime-types|hotlink|ip-blocker|redirects)$/.test(pathname)) return { resource: 'files', acl: read ? 'list-accounts' : 'edit-account', toolIds: ['aapanel-url-rewrite', pathname.endsWith('/hotlink') ? 'hotlink-protection' : pathname.split('/').at(-1)!] }
  if (/^\/api\/domains(?:\/|$)/.test(pathname)) return { resource: 'domains', acl: read ? 'list-accounts' : 'edit-account', toolIds: ['domains'] }
  if (/^\/api\/databases(?:\/|$)/.test(pathname)) return { resource: 'databases', acl: read ? 'list-accounts' : 'edit-account', toolIds: ['mysql-databases'] }
  if (/^\/api\/service-users(?:\/|$)/.test(pathname)) return { resource: 'service-users', acl: read ? 'list-accounts' : 'edit-account' }
  if (/^\/api\/dns(?:\/|$)/.test(pathname)) return { resource: 'dns', acl: 'manage-dns', toolIds: ['zone-editor'] }
  // Filter routes enforce the exact account-wide or mailbox feature after trusted scope selection.
  if (/^\/api\/mail\/filters(?:\/|$)/.test(pathname)) return { resource: 'mail', acl: read ? 'list-accounts' : 'edit-account' }
  if (/^\/api\/mail\/quarantine(?:\/|$)/.test(pathname)) return { resource: 'mail', acl: read ? 'list-accounts' : 'edit-account', toolIds: ['spam-quarantine', 'email-accounts'] }
  if (/^\/api\/mail(?:\/|$)/.test(pathname)) {
    const toolId = pathname.includes('domain-forwarders') ? 'domain-forwarders' : pathname.includes('forwarders') ? 'forwarders' : pathname.includes('mailing-lists') ? 'mailing-lists' : pathname.includes('filters') ? 'email-filters' : 'email-accounts'
    return { resource: 'mail', acl: read ? 'list-accounts' : 'edit-account', toolIds: [toolId] }
  }
  if (pathname === '/api/webmail/inbox' && method === 'GET') return { resource: 'webmail', acl: 'edit-account', toolIds: ['webmail-message-list'] }
  if (/^\/api\/webmail\/inbox\/[1-9]\d*$/.test(pathname) && method === 'GET') return { resource: 'webmail', acl: 'edit-account', toolIds: ['webmail-message-read'] }
  if (/^\/api\/webmail\/inbox\/[1-9]\d*$/.test(pathname) && method === 'DELETE') return { resource: 'webmail', acl: 'edit-account', toolIds: ['webmail-message-read'] }
  if (/^\/api\/webmail\/inbox\/[1-9]\d*\/move$/.test(pathname) && method === 'POST') return { resource: 'webmail', acl: 'edit-account', toolIds: ['webmail-message-read'] }
  if (pathname === '/api/webmail/send' && method === 'POST') return { resource: 'webmail', acl: 'edit-account', toolIds: ['webmail-compose'] }
  if (pathname === '/api/webmail/drafts' && method === 'POST') return { resource: 'webmail', acl: 'edit-account', toolIds: ['webmail-compose'] }
  if (pathname === '/api/webmail/track-delivery' && method === 'GET') return { resource: 'webmail', acl: 'edit-account', toolIds: ['webmail-track-delivery'] }
  if (/^\/api\/webmail\/folders(?:\/(?:rename|delete|subscription))?$/.test(pathname) && (method === 'GET' || method === 'POST')) return { resource: 'webmail', acl: 'edit-account', toolIds: ['webmail-folders'] }
  if (/^\/api\/webmail\/disk-usage(?:\/(?:preview|cleanup|purge))?$/.test(pathname) && (method === 'GET' || method === 'POST')) return { resource: 'webmail', acl: 'edit-account', toolIds: ['webmail-disk-cleanup'] }
  if (/^\/api\/webmail\/connect-devices(?:\/(?:autoconfig\.xml|apple\.mobileconfig))?$/.test(pathname) && method === 'GET') return { resource: 'webmail', acl: 'edit-account', toolIds: ['webmail-mail-client-setup'] }
  if (pathname === '/api/webmail/forwarders' && (method === 'GET' || method === 'PUT')) return { resource: 'webmail', acl: 'edit-account', toolIds: ['webmail-forwarders'] }
  if (pathname === '/api/webmail/preferences' && (method === 'GET' || method === 'PUT')) return { resource: 'webmail', acl: 'edit-account', toolIds: ['webmail-preferences'] }
  if (pathname === '/api/webmail/spam-preferences') return { resource: 'webmail', acl: 'edit-account', toolIds: ['webmail-spam-box', 'webmail-spam-autodelete'] }
  if (/^\/api\/webmail\/mailing-lists(?:\/[^/]+)?$/.test(pathname)) return { resource: 'webmail', acl: 'edit-account', toolIds: ['webmail-mailing-lists'] }
  if (/^\/api\/webmail\/(?:search|search-message|attachment-workspace|attachment-download(?:\/[^/]+)?)$/.test(pathname) && method === 'GET') return { resource: 'webmail', acl: 'edit-account', toolIds: ['email-accounts'] }
  if (/^\/api\/webmail(?:\/|$)/.test(pathname)) return { resource: 'webmail', acl: 'edit-account', toolIds: ['email-accounts'] }
  if (/^\/api\/backups\/files(?:\/[a-z][a-z0-9]{0,15}(?:\/(?:browse|preview|restore))?)?$/.test(pathname)) return { resource: 'backups', acl: pathname.endsWith('/restore') ? 'edit-account' : 'list-accounts', toolIds: ['file-restore'], ...(method === 'POST' && !pathname.endsWith('/restore') ? { scopeAccess: 'read' as const } : {}) }
  if (/^\/api\/backups\/components\/[a-z][a-z0-9]{0,15}\/(?:inventory|preview|restore)$/.test(pathname)) return { resource: 'backups', acl: pathname.endsWith('/restore') ? 'edit-account' : 'list-accounts', toolIds: ['file-restore'], ...(method === 'POST' && !pathname.endsWith('/restore') ? { scopeAccess: 'read' as const } : {}) }
  if (/^\/api\/backups\/workspace\/(?:runs|destinations\/[0-9a-f-]{36}\/(?:retention|recover))$/.test(pathname)) return { resource: 'backups', rootOnly: true, toolIds: ['backup'] }
  if (/^\/api\/backups\/accounts\/[a-z][a-z0-9]{0,15}$/.test(pathname)) return { resource: 'backups', rootOnly: true, toolIds: ['backup-restoration'] }
  if (/^\/api\/backups(?:\/|$)/.test(pathname)) return { resource: 'backups', acl: 'transfer', toolIds: ['backup'] }
  // A destination exports accounts with the same lifecycle read token it uses for the source inventory.
  if (/^\/api\/transfers\/source\/accounts\/[a-z][a-z0-9]{0,15}\/backup(?:\/[^/]+)?$/.test(pathname)) return { resource: 'lifecycle', rootOnly: true, scopeAccess: 'read' }
  if (/^\/api\/(?:transfers|lifecycle)(?:\/|$)/.test(pathname)) return { resource: 'lifecycle', rootOnly: true }
  if (/^\/api\/web-features(?:\/|$)/.test(pathname)) return { resource: 'files', acl: 'edit-account', toolIds: [pathname.split('/').at(-1) === 'extras' ? 'file-manager' : pathname.split('/').at(-1)!] }
  if (/^\/api\/git(?:\/|$)/.test(pathname)) return { resource: 'git', acl: 'edit-account', toolIds: ['git-version-control'] }
  if (/^\/api\/(?:cache|containers|apps)(?:\/|$)/.test(pathname)) return { resource: pathname.split('/')[2]!, acl: 'edit-account', toolIds: [pathname.startsWith('/api/cache/') ? 'account-cache-services' : pathname.startsWith('/api/containers/') ? 'account-containers' : 'web-apps'] }
  if (/^\/api\/analytics(?:\/|$)/.test(pathname)) return { resource: 'analytics', acl: 'list-accounts' }
  if (/^\/api\/(?:firewall|generations|reconcile|cluster|whmcs)(?:\/|$)/.test(pathname)) return { resource: pathname.split('/')[2]!, rootOnly: true }
  if (pathname === '/api/audit') return { resource: 'audit', acl: 'list-accounts' }
  if (/^\/api\/(?:branding|languages)(?:\/|$)/.test(pathname)) return { resource: pathname.split('/')[2]!, rootOnly: !read }
  return fail('FORBIDDEN', 'no authorization policy is declared for this route')
}

/** The account plan's own feature policy, independent of who is asking. */
export const assertAccountPlanFeatures = async (store: StateStore, account: Account, toolIds: readonly string[]): Promise<void> => {
  if (toolIds.length === 0) return
  const plan = await store.getPlan(account.planId)
  const list = plan ? await store.getFeatureList(plan.featureListId) : null
  if (!list) return fail('FORBIDDEN', 'account feature policy is unavailable')
  for (const id of toolIds) {
    const tool = toolById.get(id)
    if (!tool) return fail('FORBIDDEN', 'operation feature policy is unavailable')
    if (list.disabled.includes(id) || (tool.featureKey && list.disabled.includes(tool.featureKey))) return fail('FORBIDDEN', 'this feature is disabled by the account plan')
  }
}

export const assertAccountFeatures = async (store: StateStore, caller: AuthenticatedCaller, account: Account, toolIds: readonly string[]): Promise<void> => {
  if (caller.principal.kind === 'root' && !isMailboxPrincipal(caller)) return
  await assertAccountPlanFeatures(store, account, toolIds)
}

export const requireMailboxPrincipalAccess = async (store: StateStore, caller: AuthenticatedCaller): Promise<MailboxPrincipalAccess> => {
  const binding = extractMailboxBinding(caller)
  if (!binding) return fail('FORBIDDEN', 'mailbox principal binding is unavailable')
  // Validated direct reads also support callers holding the authority writer lease.
  const serviceUser = binding.kind === 'id'
    ? await store.getServiceUser(binding.value)
    : await store.getServiceUserByLogin(binding.value)
  if (!serviceUser) return fail('NOT_FOUND', 'mailbox not found')
  if (caller.principal.kind === 'user' && caller.principal.accountId && serviceUser.accountId !== caller.principal.accountId) {
    return fail('NOT_FOUND', 'mailbox not found')
  }
  if (!serviceUser.services.email) return fail('FORBIDDEN', 'mailbox service user email capability is disabled')
  const account = await store.getAccount(serviceUser.accountId)
  if (!account) return fail('NOT_FOUND', 'mailbox not found')
  if (caller.principal.kind === 'reseller') {
    assertCanSeeAccount(caller.principal, account)
  }
  if (account.status !== 'active') return fail('FORBIDDEN', 'hosting account is suspended or terminating')
  const policy = requestPolicies.get(caller)
  const requiredTools = new Set<string>(['email-accounts', ...(policy?.toolIds ?? [])])
  await assertAccountFeatures(store, caller, account, [...requiredTools])
  return {
    mailbox: serviceUser.login.toLowerCase(),
    serviceUserId: serviceUser.id,
    account,
  }
}

export const assertRequestAuthorized = async (store: StateStore, caller: AuthenticatedCaller, req: Request): Promise<void> => {
  const pathname = new URL(req.url).pathname
  const method = req.method.toUpperCase()
  const policy = policyForRequest(pathname, method)
  requestPolicies.set(caller, policy)
  let read = policy.scopeAccess === undefined ? readMethods.has(method) : policy.scopeAccess === 'read'
  if (policy.resource === 'files' && /\/accounts\/[^/]+\/files$/.test(pathname) && method === 'POST') {
    let body: unknown
    try { body = await req.clone().json() } catch { fail('VALIDATION', 'request body must be valid JSON') }
    read = !!body && typeof body === 'object' && 'op' in body && typeof body.op === 'string' && ['list', 'read', 'list-trash', 'get-bytes'].includes(body.op)
    policy.acl = read ? 'list-accounts' : 'edit-account'
  }
  if (isMailboxPrincipal(caller)) {
    if (!isMailboxRouteAllowed(pathname, method)) {
      return fail('FORBIDDEN', 'mailbox principals are confined to webmail and mailbox filter operations')
    }
  }
  if (caller.apiTokenId !== null) assertApiScope(caller, `${policy.resource}:${read ? 'read' : 'write'}`)
  const passwordRecoveryRoute = (method === 'GET' && pathname === '/api/auth/me') ||
    (method === 'POST' && ['/api/auth/logout', '/api/auth/change-password'].includes(pathname))
  if (caller.principalRecord.forcePasswordChange && !passwordRecoveryRoute) return fail('FORBIDDEN', 'password change is required before continuing', { passwordChangeRequired: true })
  if (policy.rootOnly && (caller.principal.kind !== 'root' || isMailboxPrincipal(caller))) return fail('FORBIDDEN', 'root role is required for this operation')
  if (isMailboxPrincipal(caller)) {
    if (!/^\/api\/auth\/(?:me|logout)$/.test(pathname)) {
      await requireMailboxPrincipalAccess(store, caller)
    }
    return
  }
  if (caller.principal.kind === 'reseller') {
    const reseller = await store.getReseller(caller.principal.id)
    if (!reseller) return fail('FORBIDDEN', 'reseller authorization is unavailable')
    if (policy.acl) assertAcl(caller.principal, reseller, policy.acl)
  }
  if (caller.principal.kind === 'user') {
    const account = await store.getAccount(caller.principal.accountId, { username: caller.principal.username })
    if (!account) return fail('UNAUTHENTICATED', 'hosting account is unavailable')
    if (account.status !== 'active' && !/^\/api\/auth\/(?:me|logout)$/.test(pathname)) return fail('FORBIDDEN', 'hosting account is suspended or terminating')
    await assertAccountFeatures(store, caller, account, policy.toolIds ?? [])
  }
}

export const assertAccountAuthorized = async (store: StateStore, caller: AuthenticatedCaller, account: Account, action: string, allowUserSelf = true): Promise<void> => {
  if (isMailboxPrincipal(caller)) return fail('FORBIDDEN', 'mailbox principals cannot access hosting account administration')
  const current = await store.getAccount(account.id)
  if (!current) return fail('NOT_FOUND', 'account not found')
  assertCanSeeAccount(caller.principal, current)
  if (caller.principal.kind === 'user' && !allowUserSelf) return fail('FORBIDDEN', 'hosting administrator permission is required')
  if (caller.principal.kind !== 'root' && !action.startsWith('account.') && current.status !== 'active') return fail('FORBIDDEN', 'hosting account is suspended or terminating')
  const policy = requestPolicies.get(caller)
  if (!policy && caller.principal.kind !== 'root') return fail('PRECONDITION_FAILED', 'request authorization context is unavailable')
  if (caller.principal.kind === 'reseller') {
    const reseller = await store.getReseller(caller.principal.id)
    if (!reseller) return fail('FORBIDDEN', 'reseller authorization is unavailable')
    if (policy?.acl) assertAcl(caller.principal, reseller, policy.acl)
  }
  await assertAccountFeatures(store, caller, current, policy?.toolIds ?? [])
}

export const ownedAccounts = async (store: StateStore, caller: AuthenticatedCaller): Promise<Account[]> => {
  if (isMailboxPrincipal(caller)) return []
  if (caller.principal.kind === 'root') return store.listAccounts()
  if (caller.principal.kind === 'reseller') {
    const reseller = await store.getReseller(caller.principal.id)
    if (!reseller) return fail('FORBIDDEN', 'reseller authorization is unavailable')
    const candidates = await store.listAccounts({ ownerId: reseller.id })
    const policy = requestPolicies.get(caller)
    if (!policy) return fail('PRECONDITION_FAILED', 'request authorization context is unavailable')
    const allowed: Account[] = []
    for (const account of candidates) {
      if (policy.resource !== 'accounts' && account.status !== 'active') continue
      try { await assertAccountFeatures(store, caller, account, policy.toolIds ?? []) }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'FORBIDDEN') continue; throw error }
      allowed.push(account)
    }
    return allowed
  }
  const account = await store.getAccount(caller.principal.accountId)
  return account && account.status === 'active' ? [account] : []
}

export const requireMailbox = async (store: StateStore, caller: AuthenticatedCaller, requested?: string | null): Promise<string> => {
  const mailbox = requested?.trim().toLowerCase()
  if (mailbox && !/^[^\s@/\\]+@[^\s@/\\]+$/.test(mailbox)) return fail('VALIDATION', 'mailbox must be an email address')
  if (isMailboxPrincipal(caller)) {
    const bound = await requireMailboxPrincipalAccess(store, caller)
    if (mailbox && mailbox !== bound.mailbox) return fail('NOT_FOUND', 'mailbox not found')
    return bound.mailbox
  }
  const all = await store.readSnapshot()
  if (mailbox) {
    const serviceUser = all.serviceUsers.find(user => user.services.email && user.login.toLowerCase() === mailbox)
    const account = serviceUser ? await store.getAccount(serviceUser.accountId) : null
    if (!account) return fail('NOT_FOUND', 'mailbox not found')
    await assertAccountAuthorized(store, caller, account, 'mailbox.access')
    await assertAccountFeatures(store, caller, account, ['email-accounts'])
    return mailbox
  }
  const ids = new Set((await ownedAccounts(store, caller)).map(account => account.id))
  const available = all.serviceUsers.filter(user => user.services.email && ids.has(user.accountId))
  if (available.length !== 1) return fail('VALIDATION', 'select exactly one mailbox')
  return requireMailbox(store, caller, available[0]!.login)
}

export const assertMailboxAuthorized = requireMailbox

export const requireDomainAccount = async (store: StateStore, caller: AuthenticatedCaller, domainName: string, action: string, requestedAccountId?: string | null): Promise<Account> => {
  const domain = (await store.listDomains()).find(item => item.name === domainName.toLowerCase())
  const account = domain ? await store.getAccount(domain.accountId) : null
  if (!account) return fail('NOT_FOUND', 'domain not found')
  await assertAccountAuthorized(store, caller, account, action)
  if (requestedAccountId && requestedAccountId !== account.id) return fail('FORBIDDEN', 'domain ownership cannot be supplied by the request')
  return account
}
