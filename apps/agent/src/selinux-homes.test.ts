import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { PROTECTED_HOME_DIRS } from '@xpanel/core'
import { createProductionHostTargetMatcher, FakeHostExecutor } from './executor.ts'
import { ACCOUNT_HOME_POLICY_SCRIPT, ACCOUNT_HOME_POLICY_STAMP, ensureAccountHomeContexts, relabelAccountPaths, SELINUX_ENFORCE_PATH } from './selinux-homes.ts'

const accounts = [{ username: 'alice', home: '/home/alice' }, { username: 'bob', home: '/home/bob' }]
const host = (selinux = true): FakeHostExecutor => {
  const executor = new FakeHostExecutor()
  if (selinux) executor.files.set(SELINUX_ENFORCE_PATH, { path: SELINUX_ENFORCE_PATH, content: '1', mode: 0o644 })
  return executor
}
const relabelOf = (username: string, path: string): string[] => ['/usr/sbin/runuser', '-u', username, '--', '/usr/sbin/restorecon', '-R', '-F', '-i', path]

describe('EL account home contexts at agent startup', { tags: ['unit'] }, () => {
  it('leaves Debian and hosts without SELinux untouched', async () => {
    for (const [executor, family] of [[host(), 'debian'], [host(false), 'rhel']] as const) {
      await ensureAccountHomeContexts(executor, family, accounts)
      expect(executor.executedCommands).toEqual([])
      expect(executor.files.has(ACCOUNT_HOME_POLICY_STAMP)).toBe(false)
    }
  })

  it('applies the policy, relabels each home as its account, and does it once', async () => {
    const executor = host()
    await ensureAccountHomeContexts(executor, 'rhel', accounts)
    expect(executor.executedCommands).toEqual([['/bin/bash', ACCOUNT_HOME_POLICY_SCRIPT], relabelOf('alice', '/home/alice'), relabelOf('bob', '/home/bob')])
    expect(executor.files.get(ACCOUNT_HOME_POLICY_STAMP)?.content).toMatch(/^[0-9a-f]{64}\n$/)
    await ensureAccountHomeContexts(executor, 'rhel', accounts)
    expect(executor.executedCommands).toHaveLength(3)
  })

  it('reapplies when the policy script differs from the stamp', async () => {
    const executor = host()
    executor.files.set(ACCOUNT_HOME_POLICY_STAMP, { path: ACCOUNT_HOME_POLICY_STAMP, content: `${'0'.repeat(64)}\n`, mode: 0o644 })
    await ensureAccountHomeContexts(executor, 'rhel', accounts)
    expect(executor.executedCommands).toHaveLength(3)
  })

  it('keeps relabelling after one failed home and repeats at the next start', async () => {
    const executor = host()
    executor.failCommand('/home/alice')
    await expect(ensureAccountHomeContexts(executor, 'rhel', accounts)).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', detail: { accounts: ['alice'], verificationRequired: true } })
    expect(executor.executedCommands.at(-1)).toEqual(relabelOf('bob', '/home/bob'))
    expect(executor.files.has(ACCOUNT_HOME_POLICY_STAMP)).toBe(false)
    executor.clearCommandFailures()
    await ensureAccountHomeContexts(executor, 'rhel', accounts)
    expect(executor.files.has(ACCOUNT_HOME_POLICY_STAMP)).toBe(true)
  })

  it('relabels nothing when SELinux refuses the policy', async () => {
    const executor = host()
    executor.failCommand('/bin/bash')
    await expect(ensureAccountHomeContexts(executor, 'rhel', accounts)).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', detail: { stateChanged: false } })
    expect(executor.executedCommands).toHaveLength(1)
    expect(executor.files.has(ACCOUNT_HOME_POLICY_STAMP)).toBe(false)
  })

  it('admits exactly the stamp as a host file', () => {
    const matcher = createProductionHostTargetMatcher()
    expect((['read', 'write', 'remove', 'ensure-directory'] as const).map(operation => matcher(ACCOUNT_HOME_POLICY_STAMP, operation))).toEqual([true, true, false, false])
    expect(matcher(`${ACCOUNT_HOME_POLICY_STAMP}.other`, 'write')).toBe(false)
  })
})

describe('relabelling a tree that arrived in a home', { tags: ['unit'] }, () => {
  it('runs on EL with SELinux only, and as the account', async () => {
    for (const [executor, family] of [[host(), 'debian'], [host(), undefined], [host(false), 'rhel']] as const) {
      await relabelAccountPaths(executor, family, 'alice', ['/home/alice'])
      expect(executor.executedCommands).toEqual([])
    }
    const executor = host()
    await relabelAccountPaths(executor, 'rhel', 'alice', ['/home/alice'])
    expect(executor.executedCommands).toEqual([relabelOf('alice', '/home/alice')])
  })

  it('reports a failed relabel instead of a finished restore', async () => {
    const executor = host()
    executor.failCommand('restorecon')
    await expect(relabelAccountPaths(executor, 'rhel', 'alice', ['/home/alice'])).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', detail: { stateChanged: true, verificationRequired: true } })
  })
})

describe('the account home policy script', { tags: ['unit'] }, () => {
  const stubs = 'semanage() { echo "semanage $*"; [[ "$1 $2" != "fcontext -a" ]]; }\nsetsebool() { echo "setsebool $*"; }\nexport -f semanage setsebool\n'
  const applied = (): string[] => {
    const run = spawnSync('bash', ['-c', `${stubs}bash "$1"`, 'stub', ACCOUNT_HOME_POLICY_SCRIPT], { encoding: 'utf8', timeout: 10_000 })
    expect(run.status, run.stdout + run.stderr).toBe(0)
    return run.stdout.trim().split('\n')
  }
  const rules = (): Map<string, RegExp> => new Map(applied().flatMap(line => {
    const rule = /^semanage fcontext -m -t (\S+) (\S+)$/.exec(line)
    return rule ? [[rule[1]!, new RegExp(`^${rule[2]!}$`)] as const] : []
  }))

  it('enables home traversal and falls back to modifying a rule that already exists', () => {
    expect(applied()).toContain('setsebool -P httpd_enable_homedirs 1')
    expect(applied().filter(line => line.startsWith('semanage fcontext -a'))).toHaveLength(2)
    expect(applied().filter(line => line.startsWith('semanage fcontext -m'))).toHaveLength(2)
  })

  it('types every path PHP may use and every document root the panel accepts', () => {
    const web = rules().get('httpd_sys_rw_content_t')!
    for (const path of ['public_html', 'public_html/wp-content/uploads/a.png', 'public_html/.htaccess', 'public_html/cgi-bin/run.cgi', 'tmp', 'tmp/sess_1', 'logs/app.log',
      'addon.example.com', 'addon.example.com/index.php', 'sites/shop/public', 'wp-config.php']) expect(web.test(`/home/alice/${path}`), path).toBe(true)
  })

  it('keeps mail, private directories and dot entries away from web processes', () => {
    const web = rules().get('httpd_sys_rw_content_t')!
    for (const path of ['', '/.ssh', '/.ssh/authorized_keys', '/.gnupg/pubring.kbx', '/.htpasswds/public_html/passwd', '/mail', '/mail/example.com/info/cur/1', '/etc', '/etc/shadow', '/ssl/key.pem', '/backups', '/backups/a.tar.gz']) {
      expect(web.test(`/home/alice${path}`), path).toBe(false)
    }
    // Two directories can look alike without being the protected one.
    for (const path of ['mailroom', 'etcetera/a', 'ssl.example.com', 'backups2']) expect(web.test(`/home/alice/${path}`), path).toBe(true)
  })

  it('leaves out exactly the protected home directories PHP does not use', () => {
    const web = rules().get('httpd_sys_rw_content_t')!
    expect([...PROTECTED_HOME_DIRS].filter(name => !web.test(`/home/alice/${name}`)).sort()).toEqual(['backups', 'etc', 'mail', 'ssl'])
  })

  it('lets Apache read Directory Privacy password files without giving PHP write access', () => {
    const passwords = rules().get('httpd_sys_content_t')!
    expect(passwords.test('/home/alice/.htpasswds')).toBe(true)
    expect(passwords.test('/home/alice/.htpasswds/public_html/private/passwd')).toBe(true)
    expect(passwords.test('/home/alice/.htpasswds2/passwd')).toBe(false)
  })
})
