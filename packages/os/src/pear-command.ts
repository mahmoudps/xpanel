/** Server PEAR per PHP version: each version keeps its own php_dir, passed to every pear run, so a package never crosses versions. */
export const PEAR_ROOT = '/usr/share/xpanel/pear'
export const isPearPackageName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)
const isVersion = (value: unknown): value is string => typeof value === 'string' && /^[5-9]\.[0-9]{1,2}$/.test(value)
const isPhp = (value: unknown): value is string => typeof value === 'string' && /^(?:\/usr\/bin\/php[5-9]\.[0-9]{1,2}|\/opt\/remi\/php[5-9][0-9]{1,2}\/root\/usr\/bin\/php)$/.test(value)
const isPearCmd = (value: unknown): value is string => typeof value === 'string' && /^(?:\/usr\/share\/php\/pearcmd\.php|\/opt\/remi\/php[5-9][0-9]{1,2}\/root\/usr\/share\/pear\/pearcmd\.php)$/.test(value)
export const pearLibraryDir = (version: string): string => isVersion(version) ? `${PEAR_ROOT}/${version}/php` : invalid()
export const pearCommandPath = (family: 'debian' | 'rhel', version: string): string => family === 'debian' ? '/usr/share/php/pearcmd.php' : `/opt/remi/php${version.replace('.', '')}/root/usr/share/pear/pearcmd.php`
export const pearPackageName = (family: 'debian' | 'rhel', version: string): string => family === 'debian' ? 'php-pear' : `php${version.replace('.', '')}-php-pear`
const DIRS = ['php_dir', 'data_dir', 'doc_dir', 'test_dir', 'www_dir', 'cfg_dir', 'bin_dir', 'cache_dir', 'download_dir', 'temp_dir'] as const
const dirArgs = (version: string): string[] => DIRS.flatMap(key => ['-d', `${key}=${key === 'php_dir' ? pearLibraryDir(version) : `${PEAR_ROOT}/${version}/${key.replace('_dir', '')}`}`])
export type PearOperation = 'list' | 'search' | 'install' | 'upgrade' | 'uninstall'
export const pearArgv = (php: string, pearcmd: string, version: string, operation: PearOperation, name?: string): string[] => {
  if (!isPhp(php) || !isPearCmd(pearcmd) || (operation === 'list') !== (name === undefined) || name !== undefined && !isPearPackageName(name)) return invalid()
  return [php, pearcmd, ...dirArgs(version), operation, ...(name === undefined ? [] : [name])]
}
/** Executor admission: exactly the argv pearArgv builds. */
export function isPearCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || !argv.every(item => typeof item === 'string') || argv.length < 23 || !isPhp(argv[0]) || !isPearCmd(argv[1])) return false
  const version = /^php_dir=\/usr\/share\/xpanel\/pear\/([5-9]\.[0-9]{1,2})\/php$/.exec(String(argv[3]))?.[1]
  if (!version) return false
  try {
    const operation = argv[22] as PearOperation, name = argv[23] as string | undefined
    if (!['list', 'search', 'install', 'upgrade', 'uninstall'].includes(operation) || argv.length > 24) return false
    const expected = pearArgv(argv[0] as string, argv[1] as string, version, operation, name)
    return expected.length === argv.length && expected.every((value, index) => value === argv[index])
  } catch { return false }
}
function invalid(): never { throw new Error('unsupported_pear_command') }
