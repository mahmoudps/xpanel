import { describe, expect, it, vi } from 'vitest'
import { buildAccountDeployCommand, buildAccountGitCommand, createAccountGitRun, isAccountDeployCommand, isAccountGitCommand } from './account-git-runner.ts'
import { FakeHostExecutor } from './executor.ts'

const account = { username: 'alice', uid: 1001, gid: 1002, home: '/home/alice' }
describe('exact account Git sandbox admission', () => {
  it('admits the clone operand delimiter inside the fixed outer jail', () => {
    for (const operation of [{ op: 'status' }, { op: 'init', branch: 'main' }, { op: 'clone', url: 'https://example.com/site.git', path: 'repositories/site' }] as const) {
      const command = buildAccountGitCommand(account, operation.op === 'clone' ? '.' : 'repositories/site', operation, 'debian')
      expect(isAccountGitCommand(command)).toBe(true)
      expect(command).toContain('User=1001'); expect(command).toContain('Group=1002'); expect(command).toContain('BindPaths=/home/alice')
      expect(command).toContain('--setenv=GIT_CONFIG_NOSYSTEM=1'); expect(command).toContain('--setenv=HOME=/nonexistent'); expect(command).toContain('NoExecPaths=/')
    }
  })
  it('refuses any sandbox, identity, executable or argument tampering', () => {
    const original = buildAccountGitCommand(account, 'repo', { op: 'status' }, 'debian')
    for (const [from, to] of [['User=1001', 'User=0'], ['BindPaths=/home/alice', 'BindPaths=/'], ['NoExecPaths=/', 'NoExecPaths='], ['/usr/bin/git', '/bin/sh'], ['--setenv=HOME=/nonexistent', '--setenv=HOME=/root']] as const) expect(isAccountGitCommand(original.map(value => value === from ? to : value))).toBe(false)
    expect(isAccountGitCommand([...original, '--force'])).toBe(false)
    expect(() => buildAccountGitCommand(account, '../bob', { op: 'status' }, 'debian')).toThrow()
  })
  it('uses the profile Git exec directory and refuses a mixed or unknown one', async () => {
    const el = buildAccountGitCommand(account, '.', { op: 'clone', url: 'https://example.com/site.git', path: 'repositories/site' }, 'rhel')
    expect(el).toContain('--setenv=GIT_EXEC_PATH=/usr/libexec/git-core')
    expect(el).toContain('ExecPaths=/usr/bin/git -/usr/libexec/git-core/git-remote-http -/usr/libexec/git-core/git-remote-https')
    expect(isAccountGitCommand(el)).toBe(true)
    // The shared executor allowlist admits exactly this argv.
    await new FakeHostExecutor().runCommand(el)
    expect(isAccountGitCommand(el.map(value => value === '--setenv=GIT_EXEC_PATH=/usr/libexec/git-core' ? '--setenv=GIT_EXEC_PATH=/usr/lib/git-core' : value))).toBe(false)
    expect(isAccountGitCommand(el.map(value => value === '--setenv=GIT_EXEC_PATH=/usr/libexec/git-core' ? '--setenv=GIT_EXEC_PATH=/tmp/git-core' : value))).toBe(false)
    expect(() => buildAccountGitCommand(account, 'repo', { op: 'status' }, 'arch' as 'debian')).toThrow()
  })
  it('never runs Git when the account home identity cannot be verified', async () => {
    const run = vi.fn(async () => ({ ok: true, code: 0, stdout: '', stderr: '' }))
    const git = createAccountGitRun(run, 'debian')
    const target = { id: 'a1', username: 'alice', uid: 1001, gid: 1002, home: '/srv/alice' } as Parameters<typeof git>[0]
    await expect(git(target, 'repo', { op: 'status' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    await expect(git({ ...target, username: 'zz9missing', home: '/home/zz9missing' }, 'repo', { op: 'status' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('account deployment command', () => {
  const account = { username: 'alice', uid: 20001, gid: 20001, home: '/home/alice' }
  it('keeps the account jail, lifts only the executable restriction and admits exactly itself', () => {
    const argv = buildAccountDeployCommand(account, 'site', 'cp a b\ncp c d', 'debian')
    expect(argv.slice(-3)).toEqual(['/bin/sh', '-ec', 'cp a b\ncp c d'])
    expect(argv).toContain('User=20001')
    expect(argv.some(value => /^(?:No)?ExecPaths=/.test(value))).toBe(false)
    expect(argv.includes('InaccessiblePaths=-/home/alice/.ssh -/home/alice/.netrc -/home/alice/.git-credentials')).toBe(true)
    expect(isAccountDeployCommand(argv)).toBe(true)
    expect(isAccountGitCommand(argv)).toBe(false)
    expect(isAccountDeployCommand(argv.map(value => value === 'User=20001' ? 'User=0' : value))).toBe(false)
    expect(isAccountDeployCommand([...argv.slice(0, -3), '/bin/bash', '-ec', 'id'])).toBe(false)
  })
})
