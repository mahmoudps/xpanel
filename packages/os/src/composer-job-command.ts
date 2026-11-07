import { isPhpInventoryProbeVersion, phpBinaryProbeArgv } from './php-inventory-command.ts'

export type ComposerJobAction = 'install' | 'update'
export const COMPOSER_JOB_TIMEOUT_MS = 600_000
const COMPOSER = '/usr/bin/composer'
const MIRROR = /^https:\/\/[A-Za-z0-9.-]{1,253}(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~/-]{0,200})?$/
const VERSIONS = ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4'] as const

const php = (phpVersion: string, family: 'debian' | 'rhel'): string => {
  if (!isPhpInventoryProbeVersion(phpVersion) || !['debian', 'rhel'].includes(family)) throw new Error('unsupported_composer_command')
  return phpBinaryProbeArgv(phpVersion, family === 'debian' ? 'dpkg' : 'rpm')[0]!
}
/** Composer CLI options from https://getcomposer.org/doc/03-cli.md; no caller flags, working directory, package name or source URL. */
export function composerAccountCommand(action: ComposerJobAction, phpVersion: string, family: 'debian' | 'rhel'): string[] {
  if (!['install', 'update'].includes(action)) throw new Error('unsupported_composer_command')
  return [php(phpVersion, family), COMPOSER, action, '--no-interaction', '--no-plugins', '--no-scripts', '--no-ansi', '--prefer-dist', '--no-progress']
}
/** The account's global Composer configuration names the mirror; no mirror clears it, so a job never inherits an old one. */
export function composerMirrorCommand(phpVersion: string, family: 'debian' | 'rhel', mirror: string | null): string[] {
  if (mirror !== null && !MIRROR.test(mirror)) throw new Error('unsupported_composer_command')
  return [php(phpVersion, family), COMPOSER, 'config', '--global', '--no-interaction', '--no-plugins', ...(mirror === null ? ['--unset', 'repos.packagist'] : ['repos.packagist', 'composer', mirror])]
}
export function isComposerAccountCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  for (const family of ['debian', 'rhel'] as const) for (const version of VERSIONS) {
    for (const action of ['install', 'update'] as const) if (composerAccountCommand(action, version, family).join('\0') === argv.join('\0')) return true
    if (composerMirrorCommand(version, family, null).join('\0') === argv.join('\0')) return true
    const last = argv.at(-1) as string
    if (MIRROR.test(last) && composerMirrorCommand(version, family, last).join('\0') === argv.join('\0')) return true
  }
  return false
}
/** A job step: systemd-run as a numeric account, then one reviewed Composer command. */
export function isComposerJobCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string') || !String(argv[0]).endsWith('/systemd-run')) return false
  const at = (argv as string[]).lastIndexOf('--')
  return at > 0 && argv.some(value => typeof value === 'string' && /^User=[0-9]+$/.test(value)) && isComposerAccountCommand(argv.slice(at + 1))
}
