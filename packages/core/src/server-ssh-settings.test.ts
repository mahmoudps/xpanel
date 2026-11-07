import { describe, expect, it } from 'vitest'
import { DEFAULT_SERVER_SSH_SETTINGS, effectiveServerSshSettings, sshLockoutReason, validateServerSshSettings, validateShellJailPolicy } from './server-ssh-settings.ts'

const jail = { privateTmp: false, hiddenHomes: false, systemView: false, exceptions: [] }
const policy = { passwordAuth: false, pubkeyAuth: true, rootLogin: 'prohibit-password', loginAlarm: false, jail }
const code = (run: () => unknown): string | null => { try { run(); return null } catch (error) { return (error as { code?: string }).code ?? 'other' } }

describe('SSH sign-in policy', { tags: ['unit'] }, () => {
  it('keeps the policy the host has always rendered when the block is unset', () => {
    expect(effectiveServerSshSettings({})).toBe(DEFAULT_SERVER_SSH_SETTINGS)
    expect(DEFAULT_SERVER_SSH_SETTINGS).toMatchObject({ passwordAuth: false, pubkeyAuth: true, rootLogin: 'prohibit-password' })
  })

  it('refuses a policy with no sign-in method and unknown fields', () => {
    expect(code(() => validateServerSshSettings({ ...policy, pubkeyAuth: false }))).toBe('NO_AUTH_METHOD')
    expect(code(() => validateServerSshSettings({ ...policy, extra: 1 }))).toBe('VALIDATION')
    expect(code(() => validateServerSshSettings({ ...policy, rootLogin: 'maybe' }))).toBe('VALIDATION')
    expect(validateServerSshSettings({ ...policy, rootLogin: 'forced-commands-only', previousPort: 22 })).toMatchObject({ rootLogin: 'forced-commands-only', previousPort: 22 })
  })

  it('accepts a shell jail exception only with one account and a reason', () => {
    expect(validateShellJailPolicy({ ...jail, exceptions: [{ username: 'alice', reason: ' legacy deploy ' }] }).exceptions).toEqual([{ username: 'alice', reason: 'legacy deploy' }])
    expect(code(() => validateShellJailPolicy({ ...jail, exceptions: [{ username: 'alice', reason: '' }] }))).toBe('VALIDATION')
    expect(code(() => validateShellJailPolicy({ ...jail, exceptions: [{ username: '../root', reason: 'x' }] }))).toBe('VALIDATION')
    expect(code(() => validateShellJailPolicy({ ...jail, exceptions: [{ username: 'alice', reason: 'a' }, { username: 'alice', reason: 'b' }] }))).toBe('VALIDATION')
  })
})

describe('sshLockoutReason', { tags: ['unit'] }, () => {
  const open = { rootKeys: 1, rootPassword: false, otherAdministrators: 0 }
  it('passes while root keeps a key, a usable password, or another administrator exists', () => {
    expect(sshLockoutReason({ passwordAuth: false, pubkeyAuth: true, rootLogin: 'prohibit-password' }, open)).toBeNull()
    expect(sshLockoutReason({ passwordAuth: true, pubkeyAuth: false, rootLogin: 'yes' }, { ...open, rootKeys: 0, rootPassword: true })).toBeNull()
    expect(sshLockoutReason({ passwordAuth: false, pubkeyAuth: true, rootLogin: 'no' }, { ...open, otherAdministrators: 1 })).toBeNull()
  })
  it('names the missing way in and never counts an unread fact', () => {
    expect(sshLockoutReason({ passwordAuth: false, pubkeyAuth: true, rootLogin: 'prohibit-password' }, { ...open, rootKeys: 0 })).toBe('root_has_no_key')
    expect(sshLockoutReason({ passwordAuth: false, pubkeyAuth: true, rootLogin: 'prohibit-password' }, { rootKeys: null, rootPassword: null, otherAdministrators: null })).toBe('root_has_no_key')
    expect(sshLockoutReason({ passwordAuth: true, pubkeyAuth: false, rootLogin: 'yes' }, { ...open, rootPassword: false })).toBe('root_has_no_password')
    expect(sshLockoutReason({ passwordAuth: false, pubkeyAuth: true, rootLogin: 'no' }, open)).toBe('no_other_administrator')
    expect(sshLockoutReason({ passwordAuth: true, pubkeyAuth: false, rootLogin: 'prohibit-password' }, open)).toBe('no_other_administrator')
    expect(sshLockoutReason({ passwordAuth: false, pubkeyAuth: true, rootLogin: 'forced-commands-only' }, open)).toBe('no_other_administrator')
  })
})
