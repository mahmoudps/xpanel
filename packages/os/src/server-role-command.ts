import type { ServerRole } from '@xpanel/core'

/**
 * Units a server role switches. nginx is never listed: it carries the management ingress on 2083/2087/2096, so the
 * web role stops the site backends and the panel stays reachable.
 */
export const SERVER_ROLE_UNITS: Readonly<Record<ServerRole, readonly string[]>> = {
  web: ['apache2.service', 'httpd.service', 'lshttpd.service', 'lsws.service'],
  mail: ['postfix.service', 'dovecot.service', 'opendkim.service'],
  spam: ['rspamd.service', 'spamassassin.service', 'spamd.service'],
  dns: ['pdns.service'],
  ftp: ['pure-ftpd.service'],
  mysql: ['mariadb.service', 'mysql.service'],
  postgresql: ['postgresql.service'],
}
const UNITS: ReadonlySet<string> = new Set(Object.values(SERVER_ROLE_UNITS).flat())
const SYSTEMCTL = '/usr/bin/systemctl'

export const serverRoleSwitchArgv = (verb: 'enable' | 'disable', unit: string): string[] => [SYSTEMCTL, verb, '--now', '--', unit]
export const serverRoleLoadArgv = (unit: string): string[] => [SYSTEMCTL, 'show', '-p', 'LoadState', '--value', '--', unit]
export const serverRoleStateArgv = (unit: string): string[] => [SYSTEMCTL, 'show', '-p', 'ActiveState', '--value', '--', unit]

/** Reviewed grammar: only a role unit, only enable or disable with --now, and the two read-only state queries. */
export function isServerRoleCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(item => typeof item !== 'string')) return false
  const unit = argv.at(-1) as string
  if (!UNITS.has(unit)) return false
  const same = (expected: readonly string[]): boolean => expected.length === argv.length && expected.every((item, index) => item === argv[index])
  return same(serverRoleSwitchArgv('enable', unit)) || same(serverRoleSwitchArgv('disable', unit)) || same(serverRoleLoadArgv(unit)) || same(serverRoleStateArgv(unit))
}
