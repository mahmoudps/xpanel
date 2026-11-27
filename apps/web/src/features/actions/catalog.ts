import type { CatalogTool, VisibilityContext } from '@xpanel/catalog'
import type { ResellerAcl } from '@xpanel/core'

export type ActionMode = 'post' | 'dialog' | 'drawer' | 'navigate'

export interface ActionFieldSpec {
  readonly name: string
  readonly label: string
  readonly type: 'text' | 'select' | 'email' | 'password'
  readonly dir?: 'ltr' | 'auto'
  readonly placeholder?: string
  readonly required?: boolean
  readonly help?: string
  readonly options?: readonly { readonly value: string; readonly label: string }[]
}

export interface CoreActionDescriptor {
  readonly id: string
  readonly surface: 'xwhm' | 'xpanel'
  readonly label: string
  readonly section: string
  readonly route: string
  readonly hint: string
  readonly keywords: string
  readonly mode: ActionMode
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly endpoint?: string
  readonly confirm?: boolean
  readonly destructive?: boolean
  readonly undoEndpoint?: string
  readonly fields?: readonly ActionFieldSpec[]
  readonly isAllowed: (visibility: VisibilityContext, qualifiedTools: ReadonlySet<string>) => boolean
}

const isRoot = (v: VisibilityContext): boolean => v.principal.kind === 'root'
const hasTool = (tools: ReadonlySet<string>, ...ids: string[]): boolean =>
  tools.size === 0 || ids.some(id => tools.has(id))
const hasResellerAcl = (v: VisibilityContext, acl: ResellerAcl): boolean =>
  isRoot(v) || (v.principal.kind === 'reseller' && v.reseller?.acl.includes(acl) === true)
const featureEnabled = (v: VisibilityContext, toolId: string): boolean =>
  !(v.disabledFeatures?.has(toolId)) && (v.allowedToolIds === undefined || v.allowedToolIds.has(toolId))

/** Authoritative catalog of the 12 core operational actions mapped to verified API endpoints. */
export const CORE_OPERATIONAL_ACTIONS: readonly CoreActionDescriptor[] = [
  {
    id: 'restart-service',
    surface: 'xwhm',
    label: 'Restart host service',
    section: 'Services',
    route: '/whm/services',
    hint: 'Services',
    keywords: 'restart service nginx apache php mariadb dovecot postfix',
    mode: 'drawer',
    method: 'POST',
    endpoint: '/api/server/services/{service}/restart',
    confirm: true,
    fields: [
      {
        name: 'service',
        label: 'Service unit',
        type: 'select',
        required: true,
        options: [
          { value: 'nginx', label: 'Nginx edge proxy' },
          { value: 'apache', label: 'Apache HTTPD' },
          { value: 'mariadb', label: 'MariaDB server' },
          { value: 'postfix', label: 'Postfix MTA' },
          { value: 'dovecot', label: 'Dovecot IMAP' },
        ],
      },
    ],
    isAllowed: (v, tools) => isRoot(v) && hasTool(tools, 'restart-web', 'restart-mysql', 'restart-mta', 'restart-imap', 'restart-dns'),
  },
  {
    id: 'suspend-account',
    surface: 'xwhm',
    label: 'Suspend hosting account',
    section: 'Accounts',
    route: '/whm/accounts',
    hint: 'Accounts',
    keywords: 'suspend lock account reseller terminate',
    mode: 'drawer',
    method: 'POST',
    endpoint: '/api/accounts/{username}/suspend',
    undoEndpoint: '/api/accounts/{username}/unsuspend',
    confirm: true,
    destructive: true,
    fields: [
      { name: 'username', label: 'Account username', type: 'text', dir: 'ltr', required: true, placeholder: 'alice' },
      { name: 'reason', label: 'Reason', type: 'text', dir: 'auto', placeholder: 'Administrative hold' },
    ],
    isAllowed: (v, tools) => hasResellerAcl(v, 'suspend-account') && hasTool(tools, 'manage-account-suspension', 'terminate-accounts'),
  },
  {
    id: 'create-dns-record',
    surface: 'xwhm',
    label: 'Manage DNS zones',
    section: 'Domains & DNS',
    route: '/whm/dns',
    hint: 'DNS',
    keywords: 'dns zone record a aaaa cname mx txt',
    mode: 'navigate',
    isAllowed: (v, tools) => hasResellerAcl(v, 'manage-dns') && hasTool(tools, 'dns-zone-manager', 'add-dns-zone'),
  },
  {
    id: 'issue-ssl',
    surface: 'xwhm',
    label: 'Run AutoSSL certificate check',
    section: 'Security & SSL',
    route: '/whm/ssl',
    hint: 'SSL',
    keywords: 'ssl tls certificate autossl renew issue https',
    mode: 'post',
    method: 'POST',
    endpoint: '/api/server/ssl/autossl/run',
    confirm: true,
    isAllowed: (v, tools) => isRoot(v) && hasTool(tools, 'auto-ssl', 'ssl-hosts'),
  },
  {
    id: 'create-database',
    surface: 'xpanel',
    label: 'Create MariaDB database',
    section: 'Databases',
    route: '/databases/mariadb',
    hint: 'Databases',
    keywords: 'create database mariadb mysql sql schema',
    mode: 'drawer',
    method: 'POST',
    endpoint: '/api/databases',
    fields: [
      { name: 'name', label: 'Database name', type: 'text', dir: 'ltr', required: true, placeholder: 'app_prod' },
    ],
    isAllowed: (v, tools) => featureEnabled(v, 'mysql-databases') && hasTool(tools, 'mysql-databases'),
  },
  {
    id: 'create-mailbox',
    surface: 'xpanel',
    label: 'Create email mailbox',
    section: 'Email',
    route: '/email/accounts',
    hint: 'Email',
    keywords: 'create mailbox email account smtp imap',
    mode: 'navigate',
    isAllowed: (v, tools) => featureEnabled(v, 'email-accounts') && hasTool(tools, 'email-accounts', 'email-account-create'),
  },
  {
    id: 'purge-edge-cache',
    surface: 'xpanel',
    label: 'Purge edge cache',
    section: 'Domains',
    route: '/domains/site-settings',
    hint: 'Cache',
    keywords: 'purge clear edge cache nginx static',
    mode: 'navigate',
    isAllowed: (v, tools) => featureEnabled(v, 'manage-domain') && hasTool(tools, 'manage-domain', 'aapanel-site-config-editor'),
  },
  {
    id: 'deliver-mail-queue',
    surface: 'xwhm',
    label: 'Inspect mail queue',
    section: 'Mail',
    route: '/whm/email/queue',
    hint: 'Mail queue',
    keywords: 'mail queue deliver postfix flush bounce',
    mode: 'navigate',
    isAllowed: (v, tools) => isRoot(v) && hasTool(tools, 'mail-queue-manager'),
  },
  {
    id: 'run-backup',
    surface: 'xpanel',
    label: 'Create home backup archive',
    section: 'Files',
    route: '/files/backup',
    hint: 'Backup',
    keywords: 'run backup archive snapshot home restore',
    mode: 'post',
    method: 'POST',
    endpoint: '/api/account/backups',
    confirm: true,
    isAllowed: (v, tools) => featureEnabled(v, 'backup') && hasTool(tools, 'backup', 'website-backups'),
  },
  {
    id: 'switch-php-version',
    surface: 'xwhm',
    label: 'Switch domain PHP version',
    section: 'Software',
    route: '/whm/software/php',
    hint: 'PHP',
    keywords: 'php version handler fpm multi-php',
    mode: 'navigate',
    isAllowed: (v, tools) => isRoot(v) && hasTool(tools, 'php-manager-domains', 'php-manager-system'),
  },
  {
    id: 'unblock-firewall-ip',
    surface: 'xwhm',
    label: 'Unblock firewall IP address',
    section: 'Security',
    route: '/whm/security/firewall',
    hint: 'Firewall',
    keywords: 'unblock unban firewall ip address ban',
    mode: 'drawer',
    method: 'POST',
    endpoint: '/api/firewall/bans/unban',
    confirm: true,
    fields: [
      { name: 'address', label: 'IP address to unblock', type: 'text', dir: 'ltr', required: true, placeholder: '203.0.113.10' },
    ],
    isAllowed: (v, tools) => isRoot(v) && hasTool(tools, 'aapanel-ip-rules', 'aapanel-firewall-switch'),
  },
  {
    id: 'check-config-health',
    surface: 'xwhm',
    label: 'Run configuration health check',
    section: 'Monitoring & Logs',
    route: '/whm/monitoring/health',
    hint: 'Health check',
    keywords: 'config health check repair drift validate',
    mode: 'post',
    method: 'GET',
    endpoint: '/api/server/configuration-health',
    isAllowed: (v, tools) => isRoot(v) && hasTool(tools, 'server-health', 'service-status'),
  },
]

export function visibleCoreActions(
  surface: 'login' | 'xpanel' | 'xwhm' | 'xmail',
  visibility: VisibilityContext | undefined,
  catalog: readonly CatalogTool[] | undefined,
  availableRoutes: ReadonlySet<string>,
): CoreActionDescriptor[] {
  if (!visibility || (surface !== 'xwhm' && surface !== 'xpanel')) return []
  const qualified = new Set(
    (catalog ?? [])
      .filter(tool => tool.status === 'verified' && tool.delivery.status === 'verified')
      .map(tool => tool.id),
  )
  return CORE_OPERATIONAL_ACTIONS.filter(action =>
    action.surface === surface &&
    availableRoutes.has(action.route) &&
    action.isAllowed(visibility, qualified),
  )
}
