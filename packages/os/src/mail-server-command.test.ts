import { describe, expect, it } from 'vitest'
import { DOVECOT_OBSERVED_SETTINGS, MASTER_OBSERVED_OPTIONS, POSTCONF_MAIN_ARGV, POSTCONF_MASTER_ARGV, POSTFIX_OBSERVED_KEYS, doveconfSettingArgv, isMailServerCommand, DOVECOT_PATH_SETTINGS, isDovecotFileReference } from './mail-server-command.ts'

describe('reviewed mail server observation grammar', () => {
  it('admits exactly postconf -n, postconf -M and doveconf -h for allowlisted settings', () => {
    expect(isMailServerCommand([...POSTCONF_MAIN_ARGV])).toBe(true)
    expect(isMailServerCommand([...POSTCONF_MASTER_ARGV])).toBe(true)
    for (const setting of DOVECOT_OBSERVED_SETTINGS) expect(isMailServerCommand(doveconfSettingArgv(setting))).toBe(true)
    expect(doveconfSettingArgv('protocols')).toEqual(['/usr/bin/doveconf', '-h', 'protocols'])
  })
  it('refuses secret-printing modes, config overrides, writes and unlisted settings', () => {
    for (const argv of [
      ['/usr/bin/doveconf', '-n'], ['/usr/bin/doveconf', '-a'], ['/usr/bin/doveconf', '-n', '-P'], ['/usr/bin/doveconf', '-P'], ['/usr/bin/doveconf', '-x', '-h', 'ssl_key'],
      ['/usr/bin/doveconf', '-h', 'ssl_dh'], ['/usr/bin/doveconf', '-h', 'passdb'], ['/usr/bin/doveconf', '-h', 'protocols', 'ssl'], ['/usr/bin/doveconf', '-c', '/tmp/x', '-h', 'ssl'],
      ['/usr/bin/doveconf', '-h'], ['/usr/sbin/postconf'], ['/usr/sbin/postconf', '-d'], ['/usr/sbin/postconf', '-x', '-n'], ['/usr/sbin/postconf', '-n', '-c', '/tmp'],
      ['/usr/sbin/postconf', '-e', 'relayhost=x'], ['/usr/sbin/postconf', '-P'], ['/usr/sbin/postconf', 'smtp_sasl_password_maps'], ['/usr/sbin/postconf', '-Mf'],
      ['postconf', '-n'], ['/usr/bin/postconf', '-n'], ['/bin/sh', '-c', 'postconf -n'], [], ['/usr/sbin/postconf', 7],
    ]) expect(isMailServerCommand(argv)).toBe(false)
    expect(() => doveconfSettingArgv('passdb' as never)).toThrow()
  })
  it('never lists a credential-bearing parameter', () => {
    for (const key of [...POSTFIX_OBSERVED_KEYS, ...MASTER_OBSERVED_OPTIONS, ...DOVECOT_OBSERVED_SETTINGS.filter(item => !DOVECOT_PATH_SETTINGS.includes(item))]) expect(key).not.toMatch(/pass|secret|token|credential|key_file|ssl_key|sasl_password/)
    // Key settings are observed only as a file reference: never inline PEM, the hidden marker or a relative path.
    for (const value of ['</etc/xpanel/ssl/c1/privkey.pem', '/etc/xpanel/ssl/c1/privkey.pem']) expect(isDovecotFileReference(value)).toBe(true)
    for (const value of ['-----BEGIN PRIVATE KEY-----', '# hidden, use -P to show it', '<privkey.pem', '</etc/../root/key', '</etc/a b']) expect(isDovecotFileReference(value)).toBe(false)
    expect(new Set(POSTFIX_OBSERVED_KEYS).size).toBe(POSTFIX_OBSERVED_KEYS.length)
  })
})
