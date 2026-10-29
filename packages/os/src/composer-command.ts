/** Composer CLI --version is the only root command admitted. PHP -n avoids loading php.ini. */
export const COMPOSER_VERSION_ARGV = ['/usr/bin/php', '-n', '/usr/bin/composer', '--no-plugins', '--no-scripts', '--no-interaction', '--no-ansi', '--version'] as const
export const isComposerCommand = (argv: readonly unknown[]): boolean => Array.isArray(argv) && argv.length === COMPOSER_VERSION_ARGV.length && COMPOSER_VERSION_ARGV.every((value, index) => argv[index] === value)
