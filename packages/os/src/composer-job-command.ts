import { isPhpInventoryProbeVersion, phpBinaryProbeArgv } from './php-inventory-command.ts'

export type ComposerJobAction = 'install' | 'update'
export const COMPOSER_JOB_HELPER = '/usr/libexec/xpanel-composer-job'
export const COMPOSER_JOB_PROTOCOL = 1
export const COMPOSER_JOB_TIMEOUT_MS = 600_000
export const COMPOSER_JOB_TRANSACTION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A root-owned native transaction helper, never root Composer. Its private journal supplies the pinned account target. */
export function composerJobCommand(transactionId: string): string[] {
  if (!COMPOSER_JOB_TRANSACTION.test(transactionId)) throw new Error('invalid_composer_transaction')
  return [COMPOSER_JOB_HELPER, '--protocol=1', '--execute', '--transaction=' + transactionId]
}
export function isComposerJobCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.length !== 4 || typeof argv[3] !== 'string') return false
  const transactionId = argv[3].startsWith('--transaction=') ? argv[3].slice(14) : ''
  return COMPOSER_JOB_TRANSACTION.test(transactionId) && composerJobCommand(transactionId).every((value, index) => argv[index] === value)
}

/** Inner argv is used only after the qualified helper drops UID/GID in a descriptor-pinned isolated staging tree.
 * Composer CLI global options document --no-plugins/--no-scripts; install/update document --prefer-dist/--no-progress.
 * https://getcomposer.org/doc/03-cli.md — no caller flags, PHP path, working directory, package name or source URL.
 */
export function composerAccountCommand(action: ComposerJobAction, phpVersion: string, family: 'debian' | 'rhel'): string[] {
  if (!['install', 'update'].includes(action) || !isPhpInventoryProbeVersion(phpVersion) || !['debian', 'rhel'].includes(family)) throw new Error('unsupported_composer_command')
  const php = phpBinaryProbeArgv(phpVersion, family === 'debian' ? 'dpkg' : 'rpm')[0]!
  return [php, '-n', '/usr/bin/composer', action, '--no-interaction', '--no-plugins', '--no-scripts', '--no-ansi', '--prefer-dist', '--no-progress']
}
export function isComposerAccountCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.length !== 10 || argv.some(value => typeof value !== 'string')) return false
  for (const family of ['debian', 'rhel'] as const) for (const version of ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4']) for (const action of ['install', 'update'] as const) {
    if (composerAccountCommand(action, version, family).every((value, index) => argv[index] === value)) return true
  }
  return false
}
