import { describe, expect, it } from 'vitest'
import { COMPOSER_VERSION_ARGV, isComposerCommand } from './composer-command.ts'
import { readComposerWorkspaceView } from './composer-command-view.ts'
describe('Composer finite command admission', () => {
  it('admits only the fixed php.ini-free version probe with scripts and plugins disabled', () => {
    expect(isComposerCommand([...COMPOSER_VERSION_ARGV])).toBe(true)
    for (const argv of [[], ['/usr/bin/composer', 'install'], [...COMPOSER_VERSION_ARGV, '--working-dir=/home/alpha'], [...COMPOSER_VERSION_ARGV.slice(0, -1), 'update'], COMPOSER_VERSION_ARGV.map(value => value === '-n' ? '-c' : value)]) expect(isComposerCommand(argv)).toBe(false)
  })
  it('rejects invented successful execution capabilities and malformed response contracts', () => {
    const view = { scope: 'saved-site-document-roots', observedAt: '2026-10-27T00:00:00.000Z', binary: { state: 'unavailable', executable: '/usr/bin/composer', version: null }, projects: [], selected: null, actions: { install: false, update: false, mirror: false, reason: 'isolated-composer-runner-unavailable' } }
    expect(readComposerWorkspaceView(view)).toEqual(view)
    expect(() => readComposerWorkspaceView({ ...view, actions: { ...view.actions, install: true } })).toThrow()
    expect(() => readComposerWorkspaceView({ ...view, binary: { ...view.binary, state: 'read' } })).toThrow()
  })
})
