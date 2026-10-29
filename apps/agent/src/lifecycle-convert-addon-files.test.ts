import { describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, Plan } from '@xpanel/core'
import { copyAccountTrees, handleConvertAddonFilesRoute, trashCreated } from './lifecycle-convert-addon-files.ts'
import type { TreeFiles } from './lifecycle-convert-addon-files.ts'
import type { FileEntry } from './file-manager.ts'

// In-memory stand-in for the confined runner: same list/get/put/mkdir/trash contract, no host access.
const tree = (initial: Record<string, string | null | 'link'> = {}) => {
  const nodes = new Map<string, { kind: FileEntry['kind']; data: Buffer; mode: number }>()
  for (const [path, value] of Object.entries(initial)) nodes.set(path, value === null ? { kind: 'directory', data: Buffer.alloc(0), mode: 0o755 } : value === 'link' ? { kind: 'symlink', data: Buffer.alloc(0), mode: 0o777 } : { kind: 'file', data: Buffer.from(value), mode: 0o644 })
  const trash: string[] = [], log: string[] = []
  const entry = (path: string): FileEntry => { const node = nodes.get(path)!; return { name: path.split('/').at(-1)!, path, kind: node.kind, sizeBytes: node.data.length, mode: node.mode, mtime: '2026-10-28T00:00:00.000Z' } }
  const parentOk = (path: string) => !path.includes('/') || nodes.get(path.slice(0, path.lastIndexOf('/')))?.kind === 'directory'
  const files: TreeFiles = {
    list: async (path = '') => { if (path && nodes.get(path)?.kind !== 'directory') fail('NOT_FOUND', 'not found'); return [...nodes.keys()].filter(key => key.slice(0, key.lastIndexOf('/') < 0 ? 0 : key.lastIndexOf('/')) === path && key !== path).map(entry) },
    getBytes: async path => { const node = nodes.get(path); if (node?.kind !== 'file') return fail('NOT_FOUND', 'not found'); return { path, contentBase64: node.data.toString('base64'), sizeBytes: node.data.length, mtime: 'x' } },
    putBytes: async (path, base64, opts) => { if (nodes.has(path)) fail('CONFLICT', 'exists'); if (!parentOk(path)) fail('NOT_FOUND', 'parent'); nodes.set(path, { kind: 'file', data: Buffer.from(base64, 'base64'), mode: opts?.mode ?? 0o640 }); log.push('put ' + path); return entry(path) },
    mkdir: async (path, mode = 0o750) => { if (nodes.has(path)) fail('CONFLICT', 'exists'); if (!parentOk(path)) fail('NOT_FOUND', 'parent'); nodes.set(path, { kind: 'directory', data: Buffer.alloc(0), mode }); log.push('mkdir ' + path); return entry(path) },
    moveToTrash: async path => { if (!nodes.has(path)) fail('NOT_FOUND', 'gone'); for (const key of [...nodes.keys()]) if (key === path || key.startsWith(path + '/')) nodes.delete(key); trash.push(path); return { id: 'x', originalPath: path, name: path, sizeBytes: 0, deletedAt: 'x' } },
  }
  return { files, nodes, trash, log }
}
const ok = async () => undefined

describe('confined cross-account tree copy', () => {
  it('copies directories and files under the target path, clamps modes and reads every file back', async () => {
    const source = tree({ domains: null, 'domains/shop': null, 'domains/shop/index.html': 'hello', 'domains/shop/img': null, 'domains/shop/img/a.png': 'png', mail: null, 'mail/shop.test': null, 'mail/shop.test/info': null, 'mail/shop.test/info/cur': null, 'mail/shop.test/info/cur/1': 'msg' })
    const target = tree({ public_html: null, mail: null })
    const created: string[] = []
    const result = await copyAccountTrees({ source: source.files, target: target.files, check: ok, created, items: [{ from: 'domains/shop', to: 'public_html' }, { from: 'mail/shop.test', to: 'mail/shop.test' }, { from: 'mail/blog.shop.test', to: 'mail/blog.shop.test' }] })
    expect(result).toMatchObject({ files: 3, bytes: 11, skipped: ['mail/blog.shop.test'] })
    expect(target.nodes.get('public_html/img/a.png')).toMatchObject({ kind: 'file', mode: 0o640 })
    expect(target.nodes.get('mail/shop.test/info/cur/1')!.data.toString()).toBe('msg')
    expect(created).toEqual(['public_html/index.html', 'public_html/img', 'public_html/img/a.png', 'mail/shop.test', 'mail/shop.test/info', 'mail/shop.test/info/cur', 'mail/shop.test/info/cur/1'].sort((a, b) => created.indexOf(a) - created.indexOf(b)))
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/)
  })
  it('refuses links, existing target files and unsafe paths before writing anything', async () => {
    const linked = tree({ site: null, 'site/link': 'link' }), target = tree({ public_html: null, 'public_html/index.html': 'old' })
    await expect(copyAccountTrees({ source: linked.files, target: target.files, check: ok, created: [], items: [{ from: 'site', to: 'public_html' }] })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    const site = tree({ site: null, 'site/index.html': 'new' })
    await expect(copyAccountTrees({ source: site.files, target: target.files, check: ok, created: [], items: [{ from: 'site', to: 'public_html' }] })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    for (const bad of ['../x', '.trash/a', '/etc', 'a/./b', '']) await expect(copyAccountTrees({ source: site.files, target: target.files, check: ok, created: [], items: [{ from: bad, to: 'x' }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(target.log).toEqual([])
  })
  it('stops when an account identity check fails and trashes exactly what it created, newest first', async () => {
    const source = tree({ site: null, 'site/a': '1', 'site/b': '2' }), target = tree({})
    let checks = 0
    const created: string[] = []
    await expect(copyAccountTrees({ source: source.files, target: target.files, created, check: async () => { if (++checks === 2) fail('CONFLICT', 'an account changed during the file copy') }, items: [{ from: 'site', to: 'public_html' }] })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(created).toEqual(['public_html', 'public_html/a'])
    expect(await trashCreated(target.files, created)).toEqual({ trashed: 2, failed: [] })
    expect(target.trash).toEqual(['public_html/a', 'public_html'])
    expect(target.nodes.size).toBe(0)
  })
})

describe('convert-addon file route', () => {
  const account = (username: string, id: string) => ({ id, username, uid: 20001, home: '/home/' + username, planId: 'p', status: 'active' }) as unknown as Account
  const deps = (sides: Record<string, ReturnType<typeof tree>>, role = 'root') => ({
    authorize: async () => { if (role !== 'root') fail('FORBIDDEN', 'root required') },
    store: { getAccountByUsername: async (name: string) => name === 'alice' ? account('alice', 'a') : name === 'shop' ? account('shop', 'b') : null, getPlan: async () => ({ id: 'p' }) as Plan },
    files: (target: Account) => sides[target.username]!.files,
    audit: async () => undefined, caller: { actor: 'root', principalId: 'r' },
  })
  const post = (path: string, body: unknown, d: ReturnType<typeof deps>) => { const url = new URL('http://agent.local' + path); return handleConvertAddonFilesRoute(new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), url, 'POST', d) }
  it('copies, rolls a failed copy back into the target trash, and cleans the source into its trash', async () => {
    const sides = { alice: tree({ site: null, 'site/a': '1' }), shop: tree({ public_html: null }) }
    const copied = await (await post('/transfers/convert-addon/copy', { source: 'alice', target: 'shop', items: [{ from: 'site', to: 'public_html' }] }, deps(sides)))!.json()
    expect(copied).toMatchObject({ files: 1, created: ['public_html/a'] })
    const again = { alice: tree({ site: null, 'site/a': '1', 'site/b': '2' }), shop: tree({}) }
    again.shop.files.putBytes = async (path) => { if (path.endsWith('/b')) fail('PRECONDITION_FAILED', 'quota'); again.shop.nodes.set(path, { kind: 'file', data: Buffer.from('1'), mode: 0o640 }); return { name: 'a', path, kind: 'file', sizeBytes: 1, mode: 0o640, mtime: 'x' } }
    await expect(post('/transfers/convert-addon/copy', { source: 'alice', target: 'shop', items: [{ from: 'site', to: 'public_html' }] }, deps(again))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false, rolledBack: 2 } })
    expect(again.shop.nodes.size).toBe(0)
    const cleaned = await (await post('/transfers/convert-addon/cleanup', { source: 'alice', paths: ['site'] }, deps(sides)))!.json()
    expect(cleaned).toEqual({ trashed: 1, failed: [], complete: true })
    expect(sides.alice.trash).toEqual(['site'])
  })
  it('is root only with an exact body grammar', async () => {
    const sides = { alice: tree({}), shop: tree({}) }
    await expect(post('/transfers/convert-addon/copy', { source: 'alice', target: 'shop', items: [] }, deps(sides, 'user'))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(post('/transfers/convert-addon/copy', { source: 'alice', target: 'shop', items: [], extra: 1 }, deps(sides))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(post('/transfers/convert-addon/copy', { source: 'alice', target: 'alice', items: [{ from: 'a', to: 'b' }] }, deps(sides))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(post('/transfers/convert-addon/copy', { source: 'alice', target: 'ghost', items: [{ from: 'a', to: 'b' }] }, deps(sides))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await post('/transfers/convert-addon/rollback', {}, deps(sides))).toBeNull()
  })
})
