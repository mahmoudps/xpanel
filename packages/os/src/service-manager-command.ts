import { SUPPORTED_PHP_VERSIONS } from './php.ts'

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
