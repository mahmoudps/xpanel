import { describe, expect, it } from 'vitest'
import { buildAccountGitCommand, isAccountGitCommand } from './account-git-runner.ts'

const account = { username: 'alice', uid: 1001, gid: 1002, home: '/home/alice' }
describe('exact account Git sandbox admission', () => {
  it('admits the clone operand delimiter inside the fixed outer jail', () => {
    for (const operation of [{ op: 'status' }, { op: 'init', branch: 'main' }, { op: 'clone', url: 'https://example.com/site.git', path: 'repositories/site' }] as const) {
      const command = buildAccountGitCommand(account, operation.op === 'clone' ? '.' : 'repositories/site', operation)
      expect(isAccountGitCommand(command)).toBe(true)
      expect(command).toContain('User=1001'); expect(command).toContain('Group=1002'); expect(command).toContain('BindPaths=/home/alice')
      expect(command).toContain('--setenv=GIT_CONFIG_NOSYSTEM=1'); expect(command).toContain('--setenv=HOME=/nonexistent'); expect(command).toContain('NoExecPaths=/')
    }
  })
  it('refuses any sandbox, identity, executable or argument tampering', () => {
    const original = buildAccountGitCommand(account, 'repo', { op: 'status' })
    for (const [from, to] of [['User=1001', 'User=0'], ['BindPaths=/home/alice', 'BindPaths=/'], ['NoExecPaths=/', 'NoExecPaths='], ['/usr/bin/git', '/bin/sh'], ['--setenv=HOME=/nonexistent', '--setenv=HOME=/root']] as const) expect(isAccountGitCommand(original.map(value => value === from ? to : value))).toBe(false)
    expect(isAccountGitCommand([...original, '--force'])).toBe(false)
    expect(() => buildAccountGitCommand(account, '../bob', { op: 'status' })).toThrow()
  })
})
