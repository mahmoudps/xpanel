import { describe, expect, it } from 'vitest'
import type { HostAction } from '@xpanel/core'
import { XpanelError } from '@xpanel/core'
import {
  accountProvisionActions,
  accountTerminateActions,
  effectiveShell,
  findWebServerInAccountGroups,
  isAccountUnit,
  MAX_DISK_MB,
  NOLOGIN_SHELL,
  quotaBlocksKb,
} from './account.ts'
import { debianOs, makeAccount, makePlan, rhelOs, unlimited } from './testkit.ts'

const codeOf = (f: () => unknown): string => {
  try {
    f()
  } catch (e) {
    if (e instanceof XpanelError) return e.code
    throw e
  }
  throw new Error('did not throw')
}

const provision = (o: Parameters<typeof makeAccount>[0] = {}, p: Parameters<typeof makePlan>[0] = {}, fs: string | null = '/home') =>
  accountProvisionActions(makeAccount(o), makePlan(p), debianOs, { quotaFilesystem: fs })

describe('accountProvisionActions', () => {
  it('creates group, user, closed dirs and quota in order', () => {
    const actions = provision()
    expect(actions[0]).toEqual({ kind: 'ensure-group', name: 'alice', gid: 1001 })
    expect(actions[1]).toEqual({ kind: 'ensure-user', name: 'alice', uid: 1001, gid: 1001, home: '/home/alice', shell: NOLOGIN_SHELL })
    const dirs = actions.filter((a): a is Extract<HostAction, { kind: 'ensure-dir' }> => a.kind === 'ensure-dir')
    expect(dirs.map((d) => [d.path, d.mode.toString(8)])).toEqual([
      ['/home/alice', '750'],
      ['/home/alice/public_html', '750'],
      ['/home/alice/tmp', '700'],
      ['/home/alice/logs', '750'],
      ['/home/alice/mail', '700'],
    ])
    for (const d of dirs) expect([d.owner, d.group]).toEqual(['alice', 'alice'])
    expect(actions.at(-1)).toEqual({ kind: 'set-quota', user: 'alice', blockSoftKb: 10485760, blockHardKb: 10485760, filesystem: '/home' })
  })

  it('never puts a web server user in the account group or as owner', () => {
    for (const os of [debianOs, rhelOs]) {
      const text = JSON.stringify(accountProvisionActions(makeAccount(), makePlan(), os, { quotaFilesystem: '/' }))
      expect(text).not.toContain(os.paths.apacheUser)
      expect(text).not.toContain(`"${os.paths.nginxUser}"`)
    }
  })

  it('clears the quota explicitly for unlimited plans and skips it without quota support', () => {
    const q = provision({}, { resources: unlimited }).find((a) => a.kind === 'set-quota')
    expect(q).toEqual({ kind: 'set-quota', user: 'alice', blockSoftKb: 0, blockHardKb: 0, filesystem: '/home' })
    expect(provision({}, {}, null).some((a) => a.kind === 'set-quota')).toBe(false)
  })

  it('uses a jailed shell only when plan and account allow it and the account is active', () => {
    const shellOf = (o: Parameters<typeof makeAccount>[0], p: Parameters<typeof makePlan>[0]) =>
      (provision(o, p)[1] as Extract<HostAction, { kind: 'ensure-user' }>).shell
    expect(shellOf({ shell: 'jailed' }, { shell: 'jailed' })).toBe('/opt/xpanel/bin/jailshell')
    expect(shellOf({ shell: 'jailed' }, { shell: 'none' })).toBe(NOLOGIN_SHELL)
    expect(shellOf({ shell: 'none' }, { shell: 'jailed' })).toBe(NOLOGIN_SHELL)
    expect(shellOf({ shell: 'jailed', status: 'suspended' }, { shell: 'jailed' })).toBe(NOLOGIN_SHELL)
    expect(effectiveShell({ shell: 'jailed', status: 'active' }, { shell: 'jailed' }, '/usr/local/bin/js')).toBe('/usr/local/bin/js')
    expect(codeOf(() => effectiveShell({ shell: 'jailed', status: 'active' }, { shell: 'jailed' }, 'bash'))).toBe('VALIDATION')
  })

  it('rejects invalid, reserved and web-server usernames', () => {
    for (const username of ['Alice', '1abc', 'a-b', 'a_b', 'a.b', '', 'abcdefghijklmnopq', 'root', 'test', 'mysql', 'xpanelx', 'alice;rm', 'alice\n', '../etc']) {
      expect(codeOf(() => provision({ username, home: `/home/${username}` })), username).toBe('VALIDATION')
    }
  })

  it('rejects ids outside the regular user range, with exact boundaries', () => {
    for (const uid of [0, 999, 60001, 65534, -1, 1000.5, Number.NaN]) {
      expect(codeOf(() => provision({ uid })), String(uid)).toBe('VALIDATION')
    }
    expect(() => provision({ uid: 1000, gid: 60000 })).not.toThrow()
  })

  it('rejects homes that are not <base>/<username> under an allowed base', () => {
    for (const home of ['/home/bob', '/etc/alice', '/', '/alice', '/home/../etc/alice', '/home//alice', '/home/alice/', 'home/alice', '/home/alice x', '/var/www/alice', '/opt/xpanel/alice', '/usr/alice']) {
      expect(codeOf(() => provision({ home })), home).toBe('VALIDATION')
    }
    expect(() => provision({ home: '/home2/alice' })).not.toThrow()
    expect(() =>
      accountProvisionActions(makeAccount({ home: '/srv/homes/alice' }), makePlan(), debianOs, { quotaFilesystem: '/srv', homeBases: ['/srv/homes'] }),
    ).not.toThrow()
    expect(codeOf(() =>
      accountProvisionActions(makeAccount({ home: '/etc/x/alice' }), makePlan(), debianOs, { quotaFilesystem: '/', homeBases: ['/etc/x'] }),
    )).toBe('VALIDATION')
  })

  it('refuses terminating accounts and foreign plans', () => {
    expect(codeOf(() => provision({ status: 'terminating' }))).toBe('PRECONDITION_FAILED')
    expect(codeOf(() => provision({}, { id: 'other' }))).toBe('VALIDATION')
  })
})

describe('quotaBlocksKb', () => {
  it('maps MB to equal soft and hard KiB blocks', () => {
    expect(quotaBlocksKb(1)).toEqual({ blockSoftKb: 1024, blockHardKb: 1024 })
    expect(quotaBlocksKb(1024 * 1024 * 1024)).toEqual({ blockSoftKb: 1024 ** 4, blockHardKb: 1024 ** 4 })
    expect(quotaBlocksKb(MAX_DISK_MB).blockHardKb).toBe(MAX_DISK_MB * 1024)
    expect(Number.isSafeInteger(MAX_DISK_MB * 1024)).toBe(true)
    expect(quotaBlocksKb('unlimited')).toEqual({ blockSoftKb: 0, blockHardKb: 0 })
  })

  it('rejects 0 MB (it would mean no limit), negatives, fractions and sizes past exact KiB counts', () => {
    for (const v of [0, -1, 1.5, MAX_DISK_MB + 1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(codeOf(() => quotaBlocksKb(v)), String(v)).toBe('VALIDATION')
    }
  })
})

describe('accountTerminateActions', () => {
  const terminating = makeAccount({ status: 'terminating' })
  const units = ['xpanel-php-fpm-alice-8.3.service', 'xpanel-cron-alice-backup.timer', 'xpanel-cron-alice-backup.service', 'xpanel-app-alice-api.service']

  it('is only planned with the username confirmed and status terminating', () => {
    expect(codeOf(() => accountTerminateActions(terminating, debianOs, { confirmUsername: '' }))).toBe('PRECONDITION_FAILED')
    expect(codeOf(() => accountTerminateActions(terminating, debianOs, { confirmUsername: 'bob' }))).toBe('PRECONDITION_FAILED')
    expect(codeOf(() => accountTerminateActions(makeAccount(), debianOs, { confirmUsername: 'alice' }))).toBe('PRECONDITION_FAILED')
  })

  it('stops timers first, then units and slices, removes files, deletes the user, then the home last', () => {
    const actions = accountTerminateActions(terminating, debianOs, { confirmUsername: 'alice', units, quotaFilesystem: '/home' })
    const kinds = actions.map((a) => a.kind)
    const stops = actions
      .filter((a): a is Extract<HostAction, { kind: 'systemd' }> => a.kind === 'systemd' && a.verb === 'stop')
      .map((a) => a.unit)
    // a timer still active after its service stopped could start the job again mid-termination
    expect(stops).toEqual([
      'xpanel-cron-alice-backup.timer',
      'xpanel-php-fpm-alice-8.3.service',
      'xpanel-cron-alice-backup.service',
      'xpanel-app-alice-api.service',
      'xpanel-1001.slice',
      'user-1001.slice',
    ])
    expect(actions.slice(0, 2)).toEqual([
      { kind: 'systemd', verb: 'stop', unit: 'xpanel-cron-alice-backup.timer' },
      { kind: 'systemd', verb: 'disable', unit: 'xpanel-cron-alice-backup.timer' },
    ])
    const removed = actions.filter((a): a is Extract<HostAction, { kind: 'remove-path' }> => a.kind === 'remove-path').map((a) => a.path)
    expect(removed).toEqual(expect.arrayContaining([
      '/etc/systemd/system/xpanel-cron-alice-backup.timer',
      '/etc/systemd/system/xpanel-1001.slice',
      // set-property drop-ins would hand a reused UID the old limits
      '/etc/systemd/system.control/xpanel-1001.slice.d',
      '/run/systemd/system.control/xpanel-1001.slice.d',
      '/etc/systemd/system/user-1001.slice.d/50-xpanel.conf',
      // exactly the files the edge FPM renderers write (fpmPaths is their source)
      '/etc/xpanel/php-fpm/8.3/alice.conf',
      '/etc/xpanel/php-fpm/8.3/alice.pool.conf',
      '/run/xpanel/fpm/alice-8.3',
      // logs of a terminated account must not reach the next account with the same name
      '/var/log/xpanel/php-fpm/alice',
      '/etc/xpanel/apps/alice',
    ]))
    expect(new Set(removed).size).toBe(removed.length)
    expect(kinds.indexOf('systemd-daemon-reload')).toBeGreaterThan(kinds.lastIndexOf('systemd'))
    expect(kinds.indexOf('delete-user')).toBeGreaterThan(kinds.indexOf('set-quota'))
    expect(actions.at(-2)).toEqual({ kind: 'delete-user', name: 'alice' })
    expect(actions.at(-1)).toEqual({ kind: 'remove-path', path: '/home/alice' })
  })

  it('refuses units that belong to someone else or to the system', () => {
    for (const unit of ['sshd.service', 'xpanel-cron-bob-x.timer', 'xpanel-php-fpm-alice-8.3.timer', 'xpanel-app-alice-a.b.service', 'xpanel-cron-alicex-1.timer', '../x.service', 'xpanel-cron-alice-.timer']) {
      expect(codeOf(() => accountTerminateActions(terminating, debianOs, { confirmUsername: 'alice', units: [unit] })), unit).toBe('VALIDATION')
    }
  })

  it('never removes a home outside an allowed base', () => {
    expect(codeOf(() => accountTerminateActions(makeAccount({ status: 'terminating', home: '/' }), debianOs, { confirmUsername: 'alice' }))).toBe('VALIDATION')
    expect(codeOf(() => accountTerminateActions(makeAccount({ status: 'terminating', home: '/etc' }), debianOs, { confirmUsername: 'alice' }))).toBe('VALIDATION')
  })
})

describe('isAccountUnit', () => {
  it('matches exactly the account units', () => {
    expect(isAccountUnit('alice', 'xpanel-php-fpm-alice-8.3.service')).toBe(true)
    expect(isAccountUnit('alice', 'xpanel-cron-alice-nightly-backup.timer')).toBe(true)
    expect(isAccountUnit('ali', 'xpanel-cron-alice-x.timer')).toBe(false)
    expect(isAccountUnit('alice', 'xpanel-app-alice-api.timer')).toBe(false)
  })
})

describe('findWebServerInAccountGroups', () => {
  it('reports web server users inside account groups only', () => {
    const etcGroup = ['www-data:x:33:', 'alice:x:1001:www-data', 'bob:x:1002:', 'carol:x:1003:nginx,apache', 'sudo:x:27:www-data'].join('\n')
    expect(findWebServerInAccountGroups(etcGroup, ['alice', 'bob', 'carol'], debianOs)).toEqual(['alice:www-data'])
    expect(findWebServerInAccountGroups(etcGroup, ['alice', 'bob', 'carol'], rhelOs)).toEqual(['carol:nginx', 'carol:apache'])
  })
})
