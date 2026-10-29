import { describe, expect, it } from 'vitest'
import { gpgAccountArgv, gpgArgv, isGpgCommand, validateGpgArmor } from './gpg-command.ts'
const identity = { username: 'alice', home: '/home/alice', uid: 1001, gid: 1001 }, fingerprint = 'A'.repeat(40)
const armor = '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nYWJj\n-----END PGP PUBLIC KEY BLOCK-----\n'
describe('fixed GnuPG grammar', () => {
  it('runs every admitted operation under the account with cleared groups and no secret arguments', () => {
    for (const command of [{ op: 'public' }, { op: 'secret' }, { op: 'inspect' }, { op: 'import' }, { op: 'export', fingerprint }, { op: 'delete', fingerprint }, { op: 'generate', uid: 'Alice <alice@example.test>', algorithm: 'ed25519', days: 365 }, { op: 'subkey', fingerprint, algorithm: 'ed25519', days: 365 }] as const) {
      const argv = gpgAccountArgv(identity, command)
      expect(argv.slice(0, 8)).toEqual(['/usr/bin/setpriv', '--reuid', '1001', '--regid', '1001', '--clear-groups', '--no-new-privs', '--'])
      expect(isGpgCommand(argv)).toBe(true); expect(isGpgCommand([...argv, '--output', '/tmp/key'])).toBe(false)
      expect(argv).not.toContain('--passphrase'); expect(argv).not.toContain('--export-secret-keys')
      if (['public', 'secret', 'inspect'].includes(command.op)) expect(argv.filter(value => value === '--with-fingerprint')).toHaveLength(2)
    }
  })
  it('refuses foreign homes, root identities, weak algorithms and fingerprint injection', () => {
    for (const account of [{ ...identity, uid: 0 }, { ...identity, gid: 0 }, { ...identity, home: '/root' }, { ...identity, username: '../bob' }]) expect(() => gpgArgv(account, { op: 'public' })).toThrow()
    expect(() => gpgArgv(identity, { op: 'delete', fingerprint: '--export-secret-keys' })).toThrow()
    expect(isGpgCommand(['/bin/sh', '-c', 'gpg --export-secret-keys'])).toBe(false)
    for (const command of [{ op: 'anything', algorithm: 'ed25519', days: 1, fingerprint }, { op: 'public', output: '/tmp/key' }, { op: 'generate', algorithm: 'ed25519', days: 1, uid: 'Alice <alice@example.test>', passphrase: 'secret' }]) expect(() => gpgAccountArgv(identity, command as never)).toThrow()
    expect(isGpgCommand(['/usr/bin/gpg', '--no-options', '--export-secret-keys'])).toBe(false)
  })
  it('accepts one bounded key armor only and prevents private key export', () => {
    expect(validateGpgArmor(armor).secret).toBe(false)
    const secret = armor.replaceAll('PUBLIC', 'PRIVATE'); expect(validateGpgArmor(secret).secret).toBe(true)
    for (const bad of [secret, armor + armor, armor.replace('YWJj', '$(id)'), armor.replace('END PGP PUBLIC', 'END PGP PRIVATE'), 'x'.repeat(262145)]) expect(() => validateGpgArmor(bad, true)).toThrow()
  })
})
