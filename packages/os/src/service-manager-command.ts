import { edge, services, system } from '@xpanel/render'
import { isPhpVersion, SUPPORTED_PHP_VERSIONS } from './php.ts'
import type { XpanelOsProfile } from './types.ts'

export const SERVICE_MANAGER_SYSTEMCTL = '/usr/bin/systemctl'
export const SERVICE_MANAGER_LIST = [SERVICE_MANAGER_SYSTEMCTL, 'list-units', '--type=service', '--all', '--plain', '--no-legend', '--no-pager', '--full'] as const
export const SERVICE_MANAGER_FILES = [SERVICE_MANAGER_SYSTEMCTL, 'list-unit-files', '--type=service', '--no-legend', '--no-pager', '--full'] as const
export const SERVICE_MANAGER_REBOOT = [SERVICE_MANAGER_SYSTEMCTL, 'reboot'] as const
export const SERVICE_MANAGER_BOOT_UNITS = ['atd.service', 'chrony.service', 'chronyd.service', 'memcached.service', 'rsyslog.service'] as const
export const SERVICE_MANAGER_PHP_TESTS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  ...SUPPORTED_PHP_VERSIONS.map(version => [`php${version}-fpm.service`, `/usr/sbin/php-fpm${version}`]), ['php-fpm.service', '/usr/sbin/php-fpm'],
]))
export const isServiceManagerUnit = (value: unknown): value is string => typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9](?:[A-Za-z0-9_.:@-]|\\x[0-9a-fA-F]{2})*\.service$/.test(value)
export const isServiceManagerBootUnit = (value: string): boolean => (SERVICE_MANAGER_BOOT_UNITS as readonly string[]).includes(value)
export const serviceManagerRestartTest = (unit: string): string[] | null => unit === 'ssh.service' || unit === 'sshd.service' ? ['/usr/sbin/sshd', '-t'] : Object.hasOwn(SERVICE_MANAGER_PHP_TESTS, unit) ? [SERVICE_MANAGER_PHP_TESTS[unit]!, '-t'] : null
export const serviceManagerShow = (unit: string): string[] => [SERVICE_MANAGER_SYSTEMCTL, 'show', '--no-pager', '--property=Id,Names,LoadState,ActiveState,SubState,UnitFileState', '--', unit]
export const serviceManagerCat = (unit: string): string[] => [SERVICE_MANAGER_SYSTEMCTL, 'cat', '--no-pager', '--', unit]
const ACCOUNT_FPM_MASTER = /^xpanel-php-fpm-([a-z][a-z0-9]{0,15})-([0-9]\.[0-9])\.service$/
export const isAccountFpmMaster = (unit: string): boolean => isPhpVersion(ACCOUNT_FPM_MASTER.exec(unit)?.[2])
const mailTest = (os: XpanelOsProfile, name: 'postfix' | 'dovecot'): string[] => services.mailConfigTests(os).find(test => test.name === name)!.argv
/** A managed unit's own offline configuration check from the host profile; null when its daemon ships none (PostgreSQL, Redis, pure-ftpd, cron, xPanel). */
export function serviceConfigTest(unit: string, os: XpanelOsProfile): string[] | null {
  const [, user, version] = ACCOUNT_FPM_MASTER.exec(unit) ?? []
  // the reconciler's own check: as the account, since a root run leaves an error log its master cannot open
  if (user && isPhpVersion(version)) return ['runuser', '-u', user, '--', edge.phpFpmBinary(os, version), '--test', '--fpm-config', edge.fpmMasterConfPath(user, version)]
  const distroPhp = SUPPORTED_PHP_VERSIONS.find(version => `${os.phpFpmService(version)}.service` === unit)
  if (distroPhp) return [edge.phpFpmBinary(os, distroPhp), '-t']
  switch (unit) {
    case 'nginx.service': return edge.nginxConfigTest(os).argv
    case 'apache2.service': case 'httpd.service': return edge.apacheConfigTest(os).argv
    case 'ssh.service': case 'sshd.service': return system.sshdConfigTest(os).argv
    case 'postfix.service': return mailTest(os, 'postfix')
    // stdout of doveconf -n may hold secrets; callers keep only stderr
    case 'dovecot.service': return mailTest(os, 'dovecot')
    // MariaDB has no --validate-config; --help --verbose reads every option file and aborts on an invalid option
    case 'mariadb.service': case 'mysql.service': return [os.family === 'rhel' ? '/usr/libexec/mariadbd' : '/usr/sbin/mariadbd', '--help', '--verbose']
    case 'pdns.service': return ['/usr/sbin/pdns_server', '--config=check']
    case 'opendkim.service': return ['/usr/sbin/opendkim', '-n', '-x', '/etc/opendkim.conf']
    default: return null
  }
}
const same = (a: readonly unknown[], b: readonly string[]) => a.length === b.length && a.every((item, index) => item === b[index])

/** systemctl(1): fixed list/show/cat commands; no shell, wildcard selector, --now, force, or caller-selected binary. */
export function isServiceManagerCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(item => typeof item !== 'string')) return false
  if ([SERVICE_MANAGER_LIST, SERVICE_MANAGER_FILES, SERVICE_MANAGER_REBOOT].some(command => same(argv, command))) return true
  if (Object.values(SERVICE_MANAGER_PHP_TESTS).some(binary => same(argv, [binary, '-t'])) || same(argv, ['/usr/sbin/sshd', '-t'])) return true
  const unit = argv.at(-1)
  if (!isServiceManagerUnit(unit)) return false
  if (same(argv, serviceManagerShow(unit))) return true
  if (isServiceManagerBootUnit(unit) && same(argv, serviceManagerCat(unit))) return true
  if (isServiceManagerBootUnit(unit) && (same(argv, [SERVICE_MANAGER_SYSTEMCTL, 'enable', '--', unit]) || same(argv, [SERVICE_MANAGER_SYSTEMCTL, 'disable', '--', unit]))) return true
  return serviceManagerRestartTest(unit) !== null && same(argv, [SERVICE_MANAGER_SYSTEMCTL, 'restart', '--', unit])
}
