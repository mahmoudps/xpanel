import { describe, expect, it } from 'vitest'
import { assertSiteOptions, servedDocRoot } from './site-options.ts'

const code = (value: unknown): string | null => { try { assertSiteOptions(value); return null } catch (error) { return (error as { code: string }).code } }

describe('site options', () => {
  it('keeps only canonical values', () => {
    expect(assertSiteOptions({ runDirectory: 'public', denyRules: [{ name: 'uploads', directory: '/uploads', extensions: ['PHP', 'php', 'phtml'] }], traffic: { siteConnections: 50, ipConnections: null, rateKbPerConnection: null } }))
      .toEqual({ runDirectory: 'public', denyRules: [{ name: 'uploads', directory: '/uploads', extensions: ['php', 'phtml'] }], traffic: { siteConnections: 50, ipConnections: null, rateKbPerConnection: null } })
    expect(assertSiteOptions({})).toEqual({})
  })
  it.each([
    [{ runDirectory: '../other' }], [{ runDirectory: '/public' }], [{ runDirectory: 'a/../b' }], [{ runDirectory: '.hidden' }], [{ isolated: false }], [{ unknown: true }],
    [{ denyRules: [] }], [{ denyRules: [{ name: 'a b', directory: '/x', extensions: ['php'] }] }], [{ denyRules: [{ name: 'a', directory: '/x/../y', extensions: ['php'] }] }],
    [{ denyRules: [{ name: 'a', directory: '/x', extensions: ['p|hp'] }] }], [{ denyRules: [{ name: 'a', directory: '/x', extensions: ['php'] }, { name: 'a', directory: '/y', extensions: ['php'] }] }],
    [{ traffic: { siteConnections: null, ipConnections: null, rateKbPerConnection: null } }], [{ traffic: { siteConnections: 0, ipConnections: null, rateKbPerConnection: null } }],
    [{ stoppedMessage: 'two\nlines' }], [{ stoppedMessage: ' ' }], [{ expiryReminder: { address: 'not an address', days: 3 } }], [{ expiryReminder: { address: 'a@example.test', days: 0 } }], [{ category: '' }],
  ])('refuses %j', value => { expect(code(value)).toBe('VALIDATION') })
  it('serves the run directory and leaves the document root as the project root', () => {
    expect(servedDocRoot({ docRoot: '/home/a/public_html', site: { runDirectory: 'public' } })).toBe('/home/a/public_html/public')
    expect(servedDocRoot({ docRoot: '/home/a/public_html' })).toBe('/home/a/public_html')
  })
})
