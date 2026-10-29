import { describe, expect, it } from 'vitest'
import { buildGitCommand, GIT_PREFIX, isGitBranch, isGitCommand, isGitHttpsUrl, isGitPath } from './git-command.ts'

describe('finite Git command grammar', () => {
  it('admits only reconstructed read and write operations', () => {
    for (const op of ['status', 'branches', 'history', 'config', 'head', 'pull'] as const) expect(isGitCommand(buildGitCommand({ op }))).toBe(true)
    for (const operation of [{ op: 'init', branch: 'main' }, { op: 'checkout', branch: 'release/1' }, { op: 'clone', url: 'https://example.com/team/site.git', path: 'repositories/site' }] as const) expect(isGitCommand(buildGitCommand(operation))).toBe(true)
    for (const argv of [['/usr/bin/git', 'status'], [...buildGitCommand({ op: 'pull' }), '--force'], [...GIT_PREFIX, 'push', 'origin'], [...GIT_PREFIX, '-c', 'core.sshCommand=sh', 'status']]) expect(isGitCommand(argv)).toBe(false)
  })
  it('refuses path and branch option/traversal injection', () => {
    for (const path of ['', '.', '..', '/home/alice/repo', 'a/../b', 'a/.git', 'a/.GIT/x', '-c', 'a\\b', 'a b']) expect(isGitPath(path)).toBe(false)
    for (const branch of ['', '-b', 'HEAD', 'a..b', 'a//b', 'a/.b', 'a.lock', 'a@{1}', 'a/']) expect(isGitBranch(branch)).toBe(false)
    expect(isGitPath('repositories/site.git')).toBe(true); expect(isGitBranch('release/1.2')).toBe(true)
  })
  it('refuses credentials, local transports, endpoint options and malformed public URLs', () => {
    for (const url of ['file:///tmp/repo', 'ssh://example.com/site', 'https://alice:secret@example.com/site', 'https://127.0.0.1/repo', 'https://localhost/repo', 'https://service.internal/repo', 'https://example.com:443/repo', 'https://example.com/repo?x=1', 'https://example.com/repo#x', 'https://example.com/%2e%2e/repo', 'https://example.com/a/../repo']) expect(isGitHttpsUrl(url)).toBe(false)
    expect(isGitHttpsUrl('https://example.com/team/site.git')).toBe(true)
  })
})
