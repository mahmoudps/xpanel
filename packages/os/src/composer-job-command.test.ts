import { describe, expect, it } from 'vitest'
import { composerAccountCommand, composerJobCommand, isComposerAccountCommand, isComposerJobCommand } from './composer-job-command.ts'
const transaction = '11111111-1111-4111-8111-111111111111'
describe('Confined Composer job command grammar', () => {
  it('admits only the fixed helper transaction operation', () => {
    const argv = composerJobCommand(transaction)
    expect(isComposerJobCommand(argv)).toBe(true)
    for (const candidate of [[...argv, '--root'], ['/usr/bin/composer', 'install'], argv.map(arg => arg === '--execute' ? '--shell' : arg), argv.map(arg => arg.startsWith('--transaction=') ? '--transaction=../../private' : arg)]) expect(isComposerJobCommand(candidate)).toBe(false)
  })
  it.each(['debian', 'rhel'] as const)('uses the saved version binary on %s with scripts/plugins disabled and no caller options', family => {
    for (const action of ['install', 'update'] as const) {
      const argv = composerAccountCommand(action, '8.3', family)
      expect(argv.slice(0, 4)).toEqual([family === 'debian' ? '/usr/bin/php8.3' : '/opt/remi/php83/root/usr/bin/php', '-n', '/usr/bin/composer', action])
      expect(argv).toContain('--no-scripts'); expect(argv).toContain('--no-plugins'); expect(isComposerAccountCommand(argv)).toBe(true)
      for (const candidate of [[...argv, '--working-dir=/root'], argv.map(arg => arg === '--no-plugins' ? '--allow-superuser' : arg), argv.map(arg => arg === '-n' ? '-c' : arg), argv.map(arg => arg === action ? 'exec' : arg)]) expect(isComposerAccountCommand(candidate)).toBe(false)
    }
  })
  it('refuses unsupported PHP, actions, transaction references and injected binary paths', () => {
    expect(() => composerAccountCommand('install', '8.9', 'debian')).toThrow()
    expect(() => composerAccountCommand('exec' as never, '8.3', 'debian')).toThrow()
    expect(() => composerJobCommand('../other')).toThrow()
    expect(isComposerAccountCommand(['/bin/sh', '-c', 'composer install'])).toBe(false)
  })
})
