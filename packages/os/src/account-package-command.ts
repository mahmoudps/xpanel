/** PEAR pure-PHP libraries use account-confined data writes; no package script or shell command is admitted. */
export const ACCOUNT_PEAR_ROOT = '.xpanel-packages/pear'
export const ACCOUNT_PEAR_LIBRARY = ACCOUNT_PEAR_ROOT + '/library'
export const ACCOUNT_PEAR_REGISTRY = ACCOUNT_PEAR_ROOT + '/installed.json'
export const ACCOUNT_PEAR_TRANSACTION = ACCOUNT_PEAR_ROOT + '/transaction.json'
export const ACCOUNT_PEAR_LIMITS = { packages: 32, files: 32, fileBytes: 65536, packageBytes: 262144, registryBytes: 131072, snapshotBytes: 786432, catalogBytes: 12582912 } as const
export const isPearName = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Za-z0-9_]{0,63}$/.test(value)
export const isPearVersion = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{1,3}(?:\.[0-9]{1,3}){1,3}(?:(?:alpha|beta|RC)[0-9]{1,3})?$/.test(value)
export const isPearFile = (value: unknown): value is string => typeof value === 'string' && value.length <= 200 && /^[A-Za-z_][A-Za-z0-9_-]*(?:\/[A-Za-z_][A-Za-z0-9_-]*)*\.php$/.test(value)
export const pearSource = (name: string, version: string): string => {
  if (!isPearName(name) || !isPearVersion(version)) throw new Error('invalid_pear_release')
  return 'https://pear.php.net/get/' + name + '-' + version + '.tgz'
}
