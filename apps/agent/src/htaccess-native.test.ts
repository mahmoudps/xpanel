import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { HtaccessTarget } from './htaccess-workspace.ts'
const fixture = vi.hoisted(() => ({ directories: new Set<string>(), unsafe: '', missingBinary: false }))
// These are explicit Linux metadata/process test transports. No native parser,
// privileged filesystem, daemon configuration or kernel proof is exercised.
vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(async (path: string) => {
    if (path === '/usr/sbin/apache2ctl' && fixture.missingBinary || (path === '/run/xpanel' || path === '/run/xpanel/htaccess-checks') && !fixture.directories.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    const file = path === '/usr/sbin/apache2ctl' || path === '/etc/apache2/apache2.conf'
    return { uid: 0, mode: path === fixture.unsafe ? 0o777 : file ? 0o644 : 0o755, isSymbolicLink: () => false, isFile: () => file, isDirectory: () => !file }
  }),
  mkdir: vi.fn(async (path: string) => { fixture.directories.add(path) }),
  mkdtemp: vi.fn(async (prefix: string) => prefix + 'test'),
  writeFile: vi.fn(async () => undefined), rm: vi.fn(async () => undefined),
}))
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 1234, kill: vi.fn() })
  queueMicrotask(() => child.emit('close', 0)); return child
}) }))
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createNativeHtaccessValidator } from './htaccess-native.ts'
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const uidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid')
const target: HtaccessTarget = { accountId: '11111111-1111-4111-8111-111111111111', domainId: '22222222-2222-4222-8222-222222222222', username: 'alice', home: '/home/alice', path: 'public_html/.htaccess', docRoot: '/home/alice/public_html', domainName: 'example.test', backendPort: 8080, engine: 'apache', phpHandler: 'fpm', active: true }
const validator = () => createNativeHtaccessValidator({ apacheControlPath: '/usr/sbin/apache2ctl', apacheMainConfigPath: '/etc/apache2/apache2.conf', workRoot: '/run/xpanel/htaccess-checks' })
beforeEach(() => {
  fixture.directories.clear(); fixture.unsafe = ''; fixture.missingBinary = false; vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' })
  Object.defineProperty(process, 'getuid', { configurable: true, writable: true, value: () => 0 })
  vi.spyOn(process, 'kill').mockImplementation(() => true)
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  if (uidDescriptor) Object.defineProperty(process, 'getuid', uidDescriptor); else Reflect.deleteProperty(process, 'getuid')
  vi.restoreAllMocks()
})
describe('protected Apache validation adapter with declared boundaries', () => {
  it('prepares only fixed runtime directories during validation and uses exact trusted argv', async () => {
    const v = validator(); expect(await v.available()).toBe(true); expect(mkdir).not.toHaveBeenCalled()
    expect(await v.check(target, 'RewriteEngine On\n')).toMatchObject({ valid: true, nativeChecked: true })
    expect(vi.mocked(mkdir).mock.calls.map(call => call[0])).toEqual(['/run/xpanel', '/run/xpanel/htaccess-checks'])
    expect(vi.mocked(mkdir).mock.calls.every(call => { const options = call[1]; return !!options && typeof options === 'object' && options.mode === 0o700 && !options.recursive })).toBe(true)
    expect(spawn).toHaveBeenCalledWith('/usr/sbin/apache2ctl', ['-t', '-f', '/run/xpanel/htaccess-checks/candidate-test/apache.conf'], expect.objectContaining({ shell: false, detached: true }))
    expect(vi.mocked(writeFile).mock.calls[1]?.[1]).toBe('Include "/etc/apache2/apache2.conf"\n<Directory "/home/alice/public_html">\nInclude "/run/xpanel/htaccess-checks/candidate-test/candidate.conf"\n</Directory>\n')
    expect(rm).toHaveBeenCalledWith('/run/xpanel/htaccess-checks/candidate-test', { recursive: true, force: true })
  })
  it('refuses an existing unsafe runtime parent or an absent protected executable', async () => {
    fixture.directories.add('/run/xpanel'); fixture.unsafe = '/run/xpanel'
    expect(await validator().available()).toBe(false)
    await expect(validator().check(target, 'RewriteEngine On\n')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    fixture.unsafe = ''; fixture.missingBinary = true; expect(await validator().available()).toBe(false)
    expect(spawn).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled()
  })
  it('refuses tenant global directives before invoking the root parser', async () => {
    expect(await validator().check(target, 'Include /etc/passwd\n')).toMatchObject({ valid: false, nativeChecked: false })
    expect(spawn).not.toHaveBeenCalled(); expect(writeFile).not.toHaveBeenCalled()
  })
})
