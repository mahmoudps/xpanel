import { describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { assertFtpDir, ftpHomeField, ftpPasswdLine, renderFtpPasswd, type FtpUserInput } from './ftp.ts'

const rejects = (fn: () => unknown, pattern?: RegExp): void => {
  let err: unknown
  try {
    fn()
  } catch (e) {
    err = e
  }
  expect(isXpanelError(err), `expected VALIDATION, got ${String(err)}`).toBe(true)
  if (isXpanelError(err)) {
    expect(err.code).toBe('VALIDATION')
    if (pattern) expect(err.message).toMatch(pattern)
  }
}

const SHA512 = `$6$saltsalt$${'a'.repeat(86)}`
const BCRYPT = `$2y$10$${'b'.repeat(53)}`
const account = { username: 'alice', uid: 1001, gid: 1002, home: '/home/alice' }
const user: FtpUserInput = { login: 'deploy@example.com', passwordHash: SHA512, account, dir: 'public_html/uploads' }

describe('ftpPasswdLine', () => {
  it('renders the pure-pw line with the account ids and /./ chroot at the home', () => {
    expect(ftpPasswdLine(user)).toBe(`deploy@example.com:${SHA512}:1001:1002::/home/alice/./public_html/uploads/::::::::::::`)
    expect(ftpPasswdLine(user).split(':')).toHaveLength(18)
  })

  it('always jails at the home (root-owned parent) and only starts in the directory', () => {
    expect(ftpPasswdLine({ ...user, dir: '' }).split(':')[5]).toBe('/home/alice/./')
    expect(ftpHomeField('/home/alice', 'site/')).toBe('/home/alice/./site/')
    // exactly one chroot marker, right after the home: a symlinked <dir> resolves inside the jail
    const home = ftpPasswdLine(user).split(':')[5] ?? ''
    expect(home.indexOf('/./')).toBe('/home/alice'.length)
    expect(home.split('/./')).toHaveLength(2)
    rejects(() => ftpHomeField('/home/../etc', 'x'), /home/)
    rejects(() => ftpHomeField('/etc/alice', 'x'), /home/)
  })

  it('writes quota and bandwidth in the bytes and bytes/s pure-pw stores; unlimited stays empty', () => {
    const f = ftpPasswdLine({ ...user, login: 'alice', passwordHash: BCRYPT, quotaMb: 512, maxFiles: 10000, uploadKBps: 2048, downloadKBps: 'unlimited', maxConnections: 3 }).split(':')
    expect(f[0]).toBe('alice')
    expect(f.slice(6, 13)).toEqual([String(2048 * 1024), '', '', '', '3', '10000', String(512 * 1024 * 1024)])
    expect(ftpPasswdLine({ ...user, downloadKBps: 1 }).split(':')[7]).toBe('1024')
    rejects(() => ftpPasswdLine({ ...user, uploadKBps: 0 }))
    rejects(() => ftpPasswdLine({ ...user, downloadKBps: 10_000_001 }))
    expect(ftpPasswdLine({ ...user, quotaMb: 'unlimited' }).split(':')[12]).toBe('')
    rejects(() => ftpPasswdLine({ ...user, quotaMb: 0 }))
    rejects(() => ftpPasswdLine({ ...user, maxConnections: -1 }))
    rejects(() => ftpPasswdLine({ ...user, quotaMb: 2.5 }))
  })

  it('rejects separators and newlines in every field', () => {
    rejects(() => ftpPasswdLine({ ...user, passwordHash: `${SHA512}:0:0` }), /hash/)
    rejects(() => ftpPasswdLine({ ...user, passwordHash: 'plaintext' }), /hash/)
    rejects(() => ftpPasswdLine({ ...user, login: 'deploy\n@example.com' }))
    rejects(() => ftpPasswdLine({ ...user, login: 'de:ploy@example.com' }))
    rejects(() => ftpPasswdLine({ ...user, login: 'root' }))
    rejects(() => ftpPasswdLine({ ...user, login: 'a-very-long-login-name@example-hosting.com' }), /32/)
    rejects(() => ftpPasswdLine({ ...user, account: { ...account, uid: 0 } }), /uid/)
    rejects(() => ftpPasswdLine({ ...user, account: { ...account, home: '/' } }))
    rejects(() => ftpPasswdLine({ ...user, account: { ...account, uid: 60001 } }), /uid/)
    rejects(() => ftpPasswdLine({ ...user, account: { ...account, username: 'root' } }), /username/)
  })
})

describe('assertFtpDir', () => {
  it('accepts normal relative directories', () => {
    expect(assertFtpDir('public_html')).toBe('public_html')
    expect(assertFtpDir('public_html/my site/v1.2/')).toBe('public_html/my site/v1.2')
    expect(assertFtpDir('')).toBe('')
  })

  it('rejects every way out of the home', () => {
    for (const bad of [
      '../',
      '..',
      '../../etc',
      'public_html/../../root',
      'public_html/..',
      '/etc',
      '/home/bob',
      'a/./b',
      './a',
      '.',
      'a//b',
      '~/x',
      '~bob',
      'a\\..\\b',
      '%2e%2e/x',
      'a:b',
      'a\nb',
      'a\u0000b',
      'pub․․/x',
      '．．/x',
      ' leading',
      '.hidden',
      '...',
    ]) {
      rejects(() => assertFtpDir(bad))
    }
  })
})

describe('renderFtpPasswd', () => {
  it('writes a root-only file without suspended users and compiles it with pure-pw mkdb', () => {
    const out = renderFtpPasswd([
      { ...user, login: 'zed@example.com' },
      user,
      { ...user, login: 'gone@example.com', suspended: true },
    ])
    expect(out.file).toMatchObject({ path: '/etc/pure-ftpd/pureftpd.passwd', mode: 0o600, owner: 'root', group: 'root' })
    expect(out.file.content.split('\n').filter(Boolean).map((l) => l.split(':')[0])).toEqual(['deploy@example.com', 'zed@example.com'])
    expect(out.actions).toEqual([{ kind: 'exec', argv: ['pure-pw', 'mkdb', '/etc/pure-ftpd/pureftpd.pdb', '-f', '/etc/pure-ftpd/pureftpd.passwd'] }])
  })

  it('rejects duplicate logins and unsafe file paths', () => {
    rejects(() => renderFtpPasswd([user, { ...user, login: 'DEPLOY@example.com' }]), /twice/)
    rejects(() => renderFtpPasswd([user], { passwdFile: '/etc/pure-ftpd/../shadow' }))
    rejects(() => renderFtpPasswd([user], { pdbFile: 'relative.pdb' }))
  })
})
