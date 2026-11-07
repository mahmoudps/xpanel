import { describe, expect, it } from 'vitest'
import { composerAccountCommand, composerMirrorCommand, isComposerAccountCommand, isComposerJobCommand } from './composer-job-command.ts'

const prefix = ['/usr/bin/systemd-run', '--wait', '--pipe', '--property', 'User=20001', '--']
describe('account Composer job command grammar', () => {
  it.each(['debian', 'rhel'] as const)('uses the saved version binary on %s with scripts and plugins off', family => {
    for (const action of ['install', 'update'] as const) {
      const argv = composerAccountCommand(action, '8.3', family)
      expect(argv.slice(0, 3)).toEqual([family === 'debian' ? '/usr/bin/php8.3' : '/opt/remi/php83/root/usr/bin/php', '/usr/bin/composer', action])
      expect(argv).toContain('--no-scripts'); expect(argv).toContain('--no-plugins'); expect(isComposerAccountCommand(argv)).toBe(true)
      for (const candidate of [[...argv, '--working-dir=/root'], argv.map(arg => arg === '--no-plugins' ? '--allow-superuser' : arg), argv.slice(0, -1)]) expect(isComposerAccountCommand(candidate)).toBe(false)
    }
  })
  it('sets or clears the mirror in the account configuration and admits nothing else', () => {
    expect(composerMirrorCommand('8.3', 'debian', 'https://mirror.example.test/repo').slice(-3)).toEqual(['repos.packagist', 'composer', 'https://mirror.example.test/repo'])
    expect(composerMirrorCommand('8.3', 'debian', null).slice(-2)).toEqual(['--unset', 'repos.packagist'])
    expect(isComposerAccountCommand(composerMirrorCommand('8.3', 'rhel', 'https://mirror.example.test'))).toBe(true)
    expect(() => composerMirrorCommand('8.3', 'debian', 'http://mirror.example.test')).toThrow()
    expect(() => composerMirrorCommand('8.3', 'debian', 'https://a.test/$(id)')).toThrow()
  })
  it('admits a step only as a numeric account unit around a reviewed command', () => {
    const run = composerAccountCommand('install', '8.3', 'debian')
    expect(isComposerJobCommand([...prefix, ...run])).toBe(true)
    expect(isComposerJobCommand([...prefix.map(value => value === 'User=20001' ? 'User=root' : value), ...run])).toBe(false)
    expect(isComposerJobCommand(run)).toBe(false)
    expect(isComposerJobCommand([...prefix, '/bin/sh', '-c', 'composer install'])).toBe(false)
  })
  it('refuses unsupported PHP and actions', () => {
    expect(() => composerAccountCommand('install', '8.9', 'debian')).toThrow()
    expect(() => composerAccountCommand('exec' as never, '8.3', 'debian')).toThrow()
    expect(isComposerAccountCommand(['/bin/sh', '-c', 'composer install'])).toBe(false)
  })
})
