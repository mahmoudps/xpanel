import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import type { DirectoryPrivacyFiles } from './directory-privacy.ts'
import { handleLeechRoute, LeechMonitor, leechStatePath, parseAuthLogLine, parseLeechFolder, readLeechRecord, renderLeechBlock } from './leech-protection.ts'
import type { LeechFolder, LeechMonitorDeps, LeechRouteDeps } from './leech-protection.ts'

const ACCOUNT = { id: '22222222-2222-4222-8222-222222222222', username: 'alice', home: '/home/alice', status: 'active', planId: 'p' } as Account
const DOMAIN = { id: 'd', accountId: ACCOUNT.id, name: 'example.test', kind: 'main', suspended: false, siteType: 'php', docRoot: '/home/alice/public_html' } as unknown as Domain
const NOW = new Date('2026-11-07T10:00:00.000Z')
const FOLDER: LeechFolder = { path: 'public_html/members', maxLogins: 3, redirectUrl: 'https://example.test/shared', alertEmail: 'owner@example.test', disableUsers: true }
const HASH = '$6$abcdefghijklmnop$' + 'x'.repeat(86)
const PRIVACY = '# BEGIN xPanel directory-privacy\nAuthType Basic\nAuthName "Members"\nAuthUserFile "/home/alice/.htpasswds/public_html/members/passwd"\nRequire valid-user\n# END xPanel directory-privacy\n'
const seconds = NOW.getTime() / 1000
const line = (ip: string, options: { status?: number; user?: string; path?: string; at?: number; host?: string } = {}): string =>
  [options.at ?? seconds - 60, options.host ?? 'example.test', ip, options.status ?? 200, options.user ?? 'alice', options.path ?? '/members/index.php'].join('\t') + '\n'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-leech-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function memoryFiles(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial))
  const port = {
    readText: vi.fn(async (path: string) => { const content = files.get(path); return content === undefined ? fail('NOT_FOUND', 'no file') : { path, content, sizeBytes: Buffer.byteLength(content), mtime: NOW.toISOString() } }),
    writeTextChecked: vi.fn(async (path: string, content: string | null) => { if (content === null) files.delete(path); else files.set(path, content); return null }),
    list: vi.fn(async () => []), mkdir: vi.fn(),
  }
  return { files, port: port as unknown as DirectoryPrivacyFiles & typeof port }
}
async function save(folders: LeechFolder[]): Promise<void> {
  const path = join(root, leechStatePath(ACCOUNT.id))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ version: 1, folders, updatedAt: NOW.toISOString() }))
}
function harness(initial: Record<string, string> = { 'public_html/members/.htaccess': PRIVACY, '.htpasswds/public_html/members/passwd': `alice:${HASH}\nbob:${HASH}\n` }, overrides: Partial<LeechMonitorDeps> = {}) {
  const memory = memoryFiles(initial)
  let log = '', ino = 7, now = NOW
  const sendAlert = vi.fn(async () => undefined), audit = vi.fn(async () => undefined), truncateLog = vi.fn(async () => { log = '' })
  const monitor = new LeechMonitor({
    root, files: () => memory.port, sendAlert, audit, truncateLog, now: () => now,
    readLog: async (offset, max) => { const text = Buffer.from(log).subarray(offset, offset + max).toString(); return { ino, size: Buffer.byteLength(log), text } },
    store: { getAccount: async id => id === ACCOUNT.id ? ACCOUNT : null, listDomains: async () => [DOMAIN], withAccountLifecycleLease: async (_id, work) => work(ACCOUNT) },
    ...overrides,
  })
  return { monitor, memory, sendAlert, audit, truncateLog, append: (text: string) => { log += text }, rotate: () => { ino++; log = '' }, advance: (ms: number) => { now = new Date(now.getTime() + ms) } }
}
const htaccess = (h: ReturnType<typeof harness>) => h.memory.files.get('public_html/members/.htaccess')!

describe('leech protection settings', () => {
  it('names each refused field for the form and keeps a saved record canonical', () => {
    expect(parseLeechFolder(FOLDER)).toEqual(FOLDER)
    expect(() => parseLeechFolder({ ...FOLDER, extra: 1 })).toThrow()
    try { parseLeechFolder({ path: '../up', maxLogins: 0, redirectUrl: 'ftp://x.test/', alertEmail: 'a b@example.test', disableUsers: 'yes' }); expect.unreachable() }
    catch (error) { expect((error as { detail: { fields: { field: string }[] } }).detail.fields.map(item => item.field)).toEqual(['path', 'maxLogins', 'redirectUrl', 'alertEmail', 'disableUsers']) }
    // RewriteRule expands "%N" in the substitution; the redirect must stay literal.
    expect(() => parseLeechFolder({ ...FOLDER, redirectUrl: 'https://example.test/a%20b' })).toThrow()
    const record = { version: 1, folders: [FOLDER], updatedAt: NOW.toISOString() }
    expect(readLeechRecord(record)).toEqual(record)
    expect(readLeechRecord({ ...record, folders: [FOLDER, FOLDER] })).toBeNull()
    expect(readLeechRecord({ ...record, folders: [{ ...FOLDER, maxLogins: 0 }] })).toBeNull()
  })

  it('renders no block without an offender and escapes dots in user names', () => {
    expect(renderLeechBlock(FOLDER, [])).toEqual([])
    expect(renderLeechBlock(FOLDER, ['b.ob', 'alice'])).toEqual(['RewriteEngine On', 'RewriteCond %{REMOTE_USER} ^(?:alice|b\\.ob)$', 'RewriteRule ^ https://example.test/shared [R=302,L]'])
    expect(() => renderLeechBlock(FOLDER, ['a b'])).toThrow()
  })

  it('reads only well-formed auth log lines', () => {
    expect(parseAuthLogLine(line('192.0.2.1').trimEnd())).toEqual({ at: (seconds - 60) * 1000, vhost: 'example.test', ip: '192.0.2.1', status: 200, user: 'alice', path: '/members/index.php' })
    expect(parseAuthLogLine(line('2001:db8::1').trimEnd())?.ip).toBe('2001:db8::1')
    for (const bad of ['', 'a\tb', line('192.0.2.1', { user: 'bad\\tuser' }).trimEnd(), line('192.0.2.1', { path: 'relative' }).trimEnd(), line('not an ip').trimEnd()]) expect(parseAuthLogLine(bad)).toBeNull()
  })
})

describe('leech protection monitor', () => {
  it('redirects, disables and alerts when a user passes the limit, as the cPanel acceptance asks', async () => {
    await save([FOLDER])
    const h = harness()
    h.append(line('192.0.2.1') + line('192.0.2.2') + line('192.0.2.3') + line('192.0.2.3'))
    await h.monitor.tick()
    expect(htaccess(h)).toBe(PRIVACY)
    expect(h.memory.files.get('.htpasswds/public_html/members/passwd')).toContain('alice:$6$')
    h.append(line('192.0.2.4'))
    await h.monitor.tick()
    expect(htaccess(h)).toContain('RewriteCond %{REMOTE_USER} ^(?:alice)$\nRewriteRule ^ https://example.test/shared [R=302,L]\n# END xPanel leech-protection')
    expect(h.memory.files.get('.htpasswds/public_html/members/passwd')).toBe(`alice:!${HASH}\nbob:${HASH}\n`)
    expect(h.sendAlert).toHaveBeenCalledTimes(1)
    expect(h.sendAlert.mock.calls[0]).toEqual(expect.arrayContaining(['owner@example.test', 'Leech protection: alice on alice']))
    expect(h.audit).toHaveBeenCalledWith({ actor: 'system', action: 'account.leech_protection.triggered', target: 'account:alice', outcome: 'ok', detail: { path: 'public_html/members', users: ['alice'], disabled: true, alert: 'sent' } })
    expect(await h.monitor.status(ACCOUNT.id)).toEqual([expect.objectContaining({ path: FOLDER.path, state: 'applied', flagged: ['alice'], disabled: ['alice'] })])
    // Later ticks do not repeat the alert or the password file write.
    h.append(line('192.0.2.5'))
    h.memory.port.writeTextChecked.mockClear()
    await h.monitor.tick()
    expect(h.sendAlert).toHaveBeenCalledTimes(1); expect(h.memory.port.writeTextChecked).not.toHaveBeenCalled()
  })

  it('counts addresses only for signed-in requests inside the window, the folder and its site', async () => {
    await save([FOLDER])
    const h = harness()
    h.append(line('192.0.2.1', { status: 401 }) + line('192.0.2.2', { status: 401 }) + line('192.0.2.3', { status: 401 }) + line('192.0.2.4', { status: 401 }))
    h.append(line('192.0.2.5', { path: '/public/page' }) + line('192.0.2.6', { path: '/membership' }) + line('192.0.2.7', { host: 'other.test' }) + line('192.0.2.8', { at: seconds - 3 * 3600 }))
    await h.monitor.tick()
    expect(htaccess(h)).toBe(PRIVACY)
    h.append(line('192.0.2.1', { path: '/members' }) + line('192.0.2.2', { status: 302, path: '/members/a/b' }) + line('192.0.2.3') + line('192.0.2.4', { status: 403 }))
    await h.monitor.tick()
    expect(htaccess(h)).toContain('^(?:alice)$')
  })

  it('lifts the redirect when the two hours pass; a disabled user stays disabled', async () => {
    await save([FOLDER])
    const h = harness()
    h.append(['1', '2', '3', '4'].map(n => line('192.0.2.' + n)).join(''))
    await h.monitor.tick()
    expect(htaccess(h)).toContain('leech-protection')
    h.advance(2 * 3600 * 1000 + 1000)
    await h.monitor.tick()
    expect(htaccess(h)).toBe(PRIVACY)
    expect(h.memory.files.get('.htpasswds/public_html/members/passwd')).toContain('alice:!$6$')
  })

  it('reports folders it cannot enforce and clears a removed folder', async () => {
    await save([FOLDER, { ...FOLDER, path: 'private' }, { ...FOLDER, path: 'public_html/free' }, { ...FOLDER, path: 'public_html/off' }])
    const h = harness({ 'public_html/members/.htaccess': PRIVACY, '.htpasswds/public_html/members/passwd': `alice:${HASH}\n`, 'private/.htaccess': PRIVACY, '.htpasswds/private/passwd': `alice:${HASH}\n`,
      'public_html/off/.htaccess': PRIVACY + 'RewriteEngine off\n', '.htpasswds/public_html/off/passwd': `alice:${HASH}\n` })
    const states = await h.monitor.applyAccount(ACCOUNT.id)
    expect(states.map(item => [item.path, item.state])).toEqual([['public_html/members', 'applied'], ['private', 'outside_document_root'], ['public_html/free', 'not_protected'], ['public_html/off', 'conflict']])
    await save([])
    h.memory.files.set('public_html/members/.htaccess', '# BEGIN xPanel leech-protection\nRewriteEngine On\n# END xPanel leech-protection\n' + PRIVACY)
    await h.monitor.applyAccount(ACCOUNT.id, 'public_html/members')
    expect(htaccess(h)).toBe(PRIVACY)
  })

  it('leaves an unowned or inactive account alone and survives a failing tick', async () => {
    await save([FOLDER])
    const inactive = harness(undefined, { store: { getAccount: async () => ({ ...ACCOUNT, status: 'suspended' }) as Account, listDomains: async () => [DOMAIN], withAccountLifecycleLease: async (_id, work) => work(ACCOUNT) } })
    inactive.append(['1', '2', '3', '4'].map(n => line('192.0.2.' + n)).join(''))
    await inactive.monitor.tick()
    expect(htaccess(inactive)).toBe(PRIVACY)
    const broken = harness(undefined, { readLog: async () => { throw new Error('unreadable') } })
    await expect(broken.monitor.tick()).resolves.toBeUndefined()
  })

  it('records an alert that could not be sent', async () => {
    await save([FOLDER])
    const h = harness(undefined, { sendAlert: async () => { throw new Error('sendmail_failed') } })
    h.append(['1', '2', '3', '4'].map(n => line('192.0.2.' + n)).join(''))
    await h.monitor.tick()
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ alert: 'failed' }) }))
  })

  it('follows a rotated log and keeps the log bounded with no folder watched', async () => {
    await save([FOLDER])
    const h = harness()
    h.append(line('192.0.2.1') + line('192.0.2.2'))
    await h.monitor.tick()
    h.rotate()
    h.append(line('192.0.2.3') + line('192.0.2.4'))
    await h.monitor.tick()
    expect(htaccess(h)).toContain('^(?:alice)$')
    await save([])
    h.append('x'.repeat(17 * 1024 * 1024))
    await h.monitor.tick()
    expect(h.truncateLog).toHaveBeenCalledTimes(1)
  })
})

describe('leech protection agent route', () => {
  const OWNER = { id: 'principal', kind: 'user', username: 'alice', accountId: ACCOUNT.id, disabled: false }
  function deps(overrides: Partial<LeechRouteDeps> = {}): LeechRouteDeps {
    return {
      caller: { role: 'user', principalId: 'principal', accountId: ACCOUNT.id }, currentPrincipal: async () => OWNER, monitor: harness().monitor, readBody: async req => await req.json() as Record<string, unknown>,
      store: { getAccountByUsername: async name => name === 'alice' ? ACCOUNT : null, getPlan: async () => ({ featureListId: 'f' }) as never, getFeatureList: async () => ({ disabled: [] }) as never, getServerSettings: async () => ({ engine: 'apache' }) as never },
      ...overrides,
    }
  }
  const send = (route: LeechRouteDeps, path = '/accounts/alice/leech-protection', body: unknown = { op: 'status' }) =>
    handleLeechRoute(new Request('http://agent.test' + path, { method: 'POST', body: JSON.stringify(body) }), new URL('http://agent.test' + path), 'POST', route)

  it('ignores other paths and reports what can be saved on this host', async () => {
    await save([FOLDER])
    expect(await send(deps(), '/accounts/alice/other')).toBeNull()
    expect(await (await send(deps()))!.json() as unknown).toEqual({ context: { accountId: ACCOUNT.id, username: 'alice' }, capabilities: { canSave: true, reason: null }, folders: [expect.objectContaining({ path: FOLDER.path, state: 'pending' })] })
    expect((await (await send(deps({ monitor: null })))!.json() as { capabilities: unknown }).capabilities).toEqual({ canSave: false, reason: 'monitor' })
    const openLitespeed = deps(); openLitespeed.store.getServerSettings = async () => ({ engine: 'openlitespeed' }) as never
    expect((await (await send(openLitespeed))!.json() as { capabilities: unknown }).capabilities).toEqual({ canSave: false, reason: 'engine' })
    await expect(send(openLitespeed, undefined, { op: 'apply', path: FOLDER.path })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('applies one folder for its owner only and honours the plan', async () => {
    await save([FOLDER])
    const applied = await (await send(deps(), undefined, { op: 'apply', path: FOLDER.path }))!.json() as { folders: { state: string }[] }
    expect(applied.folders[0]?.state).toBe('applied')
    await expect(send(deps(), undefined, { op: 'apply', path: '../etc' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(send(deps({ caller: { role: 'root', principalId: 'principal', accountId: null } }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(send(deps({ currentPrincipal: async () => ({ ...OWNER, disabled: true }) }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(send(deps(), '/accounts/mallory/leech-protection')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const plan = deps(); plan.store.getFeatureList = async () => ({ disabled: ['leech-protection'] }) as never
    await expect(send(plan)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
