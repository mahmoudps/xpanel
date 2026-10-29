import { describe, expect, it } from 'vitest'
import { DOVECOT_OBSERVED_SETTINGS, MASTER_OBSERVED_OPTIONS, POSTCONF_MAIN_ARGV, POSTCONF_MASTER_ARGV, POSTFIX_OBSERVED_KEYS, doveconfSettingArgv, isMailServerCommand } from './mail-server-command.ts'

describe('reviewed mail server observation grammar', () => {
  it('admits exactly postconf -n, postconf -M and doveconf -h for allowlisted settings', () => {
    expect(isMailServerCommand([...POSTCONF_MAIN_ARGV])).toBe(true)
    expect(isMailServerCommand([...POSTCONF_MASTER_ARGV])).toBe(true)
    for (const setting of DOVECOT_OBSERVED_SETTINGS) expect(isMailServerCommand(doveconfSettingArgv(setting))).toBe(true)
    expect(doveconfSettingArgv('protocols')).toEqual(['/usr/bin/doveconf', '-h', 'protocols'])
  })
  it('refuses secret-printing modes, config overrides, writes and unlisted settings', () => {
    for (const argv of [
      ['/usr/bin/doveconf', '-n'], ['/usr/bin/doveconf', '-a'], ['/usr/bin/doveconf', '-n', '-P'], ['/usr/bin/doveconf', '-P'], ['/usr/bin/doveconf', '-h', 'ssl_key'],
      ['/usr/bin/doveconf', '-h', 'ssl_cert'], ['/usr/bin/doveconf', '-h', 'passdb'], ['/usr/bin/doveconf', '-h', 'protocols', 'ssl'], ['/usr/bin/doveconf', '-c', '/tmp/x', '-h', 'ssl'],
      ['/usr/bin/doveconf', '-h'], ['/usr/sbin/postconf'], ['/usr/sbin/postconf', '-d'], ['/usr/sbin/postconf', '-x', '-n'], ['/usr/sbin/postconf', '-n', '-c', '/tmp'],
      ['/usr/sbin/postconf', '-e', 'relayhost=x'], ['/usr/sbin/postconf', '-P'], ['/usr/sbin/postconf', 'smtp_sasl_password_maps'], ['/usr/sbin/postconf', '-Mf'],
      ['postconf', '-n'], ['/usr/bin/postconf', '-n'], ['/bin/sh', '-c', 'postconf -n'], [], ['/usr/sbin/postconf', 7],
    ]) expect(isMailServerCommand(argv)).toBe(false)
    expect(() => doveconfSettingArgv('ssl_key' as never)).toThrow()
  })
  it('never lists a credential-bearing parameter', () => {
    for (const key of [...POSTFIX_OBSERVED_KEYS, ...MASTER_OBSERVED_OPTIONS, ...DOVECOT_OBSERVED_SETTINGS]) expect(key).not.toMatch(/pass|secret|token|credential|key_file|ssl_key|sasl_password/)
    expect(new Set(POSTFIX_OBSERVED_KEYS).size).toBe(POSTFIX_OBSERVED_KEYS.length)
  })
})
