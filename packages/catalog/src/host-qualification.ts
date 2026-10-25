import type { CatalogTool } from './types.ts'

/** Probes a connected Linux agent can report. The control plane is added by the API. */
export const HOST_PROBES = ['control-plane', 'linux-account', 'apache', 'mariadb', 'mail', 'files', 'acme', 'pdns', 'backups', 'systemd', 'host-info', 'audit_log'] as const
export type HostProbe = (typeof HOST_PROBES)[number]
export type HostProbeResult = 'passed' | 'failed'

export interface HostQualificationReport {
  executor: 'linux' | 'fake' | 'unknown'
  probes: Partial<Record<HostProbe, HostProbeResult>>
}

/**
 * Implemented API and screen capabilities bound to connected-host probes.
 * A tool stays hidden until every probe it names has passed on this server.
 */
export const PHASE1_TOOL_PROBES: Readonly<Record<string, readonly HostProbe[]>> = {
  'list-accounts': ['control-plane'],
  'create-account': ['control-plane', 'linux-account', 'apache'],
  'modify-account': ['control-plane'],
  'password-modification': ['control-plane'],
  'manage-account-suspension': ['control-plane', 'linux-account'],
  'terminate-accounts': ['control-plane', 'linux-account'],
  'add-package': ['control-plane'],
  'edit-package': ['control-plane'],
  'delete-package': ['control-plane'],
  'feature-list-crud': ['control-plane'],
  'server-settings-edit': ['control-plane'],
  'domain-php-settings': ['control-plane', 'apache'],
  'dns-zone-records': ['control-plane', 'pdns'],
  domains: ['control-plane', 'apache'],
  'create-domain': ['control-plane', 'apache'],
  'email-accounts': ['control-plane', 'mail'],
  'email-account-create': ['control-plane', 'mail'],
  'email-account-manage': ['control-plane', 'mail'],
  'mysql-databases': ['control-plane', 'mariadb'],
  'mysql-users': ['control-plane', 'mariadb'],
  'file-manager': ['control-plane', 'files'],
  'file-text-editor': ['control-plane', 'files'],
  'ssl-tls-status': ['control-plane'],
  'ssl-install': ['control-plane', 'apache', 'acme'],
  'webmail-message-list': ['control-plane', 'mail'],
  'webmail-message-read': ['control-plane', 'mail'],
  'webmail-compose': ['control-plane', 'mail'],
  'reseller-center': ['control-plane'],
  'dns-zone-manager': ['control-plane', 'pdns'],
  'add-dns-zone': ['control-plane', 'pdns'],
  'delete-dns-zone': ['control-plane', 'pdns'],
  'backup-restoration': ['control-plane', 'backups'],
  'restart-web': ['control-plane', 'systemd'],
  'restart-mysql': ['control-plane', 'systemd'],
  'restart-mta': ['control-plane', 'systemd'],
  'restart-imap': ['control-plane', 'systemd'],
  'restart-ftp': ['control-plane', 'systemd'],
  'restart-dns': ['control-plane', 'systemd'],
  'server-information': ['control-plane', 'host-info'],
  'audit-log': ['audit_log'],
}

/** Copy the catalog and mark only the implemented tools whose probes passed. */
export const qualifyHostTools = (
  catalog: readonly CatalogTool[],
  report: HostQualificationReport | null,
  enabled = process.env.XPANEL_HOST_QUALIFICATION !== 'off',
): CatalogTool[] => {
  if (!enabled || report?.executor !== 'linux') return catalog.map(tool => ({ ...tool, delivery: { ...tool.delivery } }))
  return catalog.map(tool => {
    const needs = PHASE1_TOOL_PROBES[tool.id]
    if (needs === undefined || tool.status === 'out-of-scope') return { ...tool, delivery: { ...tool.delivery } }
    if (!needs.every(probe => report.probes[probe] === 'passed')) return { ...tool, delivery: { ...tool.delivery } }
    return {
      ...tool,
      status: 'verified',
      delivery: {
        status: 'verified',
        reason: 'This server’s Linux agent passed the probes this implemented tool requires.',
        evidence: tool.delivery.evidence,
      },
    }
  })
}
