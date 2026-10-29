import { describe, expect, it } from 'vitest'
import { isPearFile, isPearName, isPearVersion, pearSource } from './account-package-command.ts'

describe('fixed private PEAR library grammar', () => {
  it('accepts exact PEAR release identities and PHP library files only', () => {
    expect(isPearName('Config_Lite')).toBe(true); expect(isPearVersion('1.0.0RC1')).toBe(true); expect(isPearFile('Config/Lite.php')).toBe(true)
    expect(pearSource('Config_Lite', '1.0.0')).toBe('https://pear.php.net/get/Config_Lite-1.0.0.tgz')
  })
  it('refuses flags, paths, free channels, binaries, scripts and unbounded versions', () => {
    for (const value of ['../Config', '-f', 'pear.php.net/Config', 'https://example.com/x', 'Config Lite', '']) expect(isPearName(value)).toBe(false)
    for (const value of ['latest', '>=1.0', '1', '1000.0.0', '1.0;sh']) expect(isPearVersion(value)).toBe(false)
    for (const value of ['/Config.php', '../Config.php', 'Config/../Lite.php', '.htaccess', 'setup.sh', 'module.so', 'Config\\Lite.php', 'foo/./bar.php']) expect(isPearFile(value)).toBe(false)
    expect(() => pearSource('../Config', '1.0.0')).toThrow()
  })
})
