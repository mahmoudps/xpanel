import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import { deriveSitePublisherTarget, parseSitePublisherDraft, renderSitePublisherDraft, SitePublisherWorkspace } from './site-publisher.ts'
import { handleSitePublisherAgentRoute, parseSitePublisherMutation, readSitePublisherBody } from './site-publisher-routes.ts'
import type { SitePublisherAgentDeps } from './site-publisher-routes.ts'

const account = { id: '11111111-1111-4111-8111-111111111111', home: '/home/alice', status: 'active' } as Account
const domain = { id: '22222222-2222-4222-8222-222222222222', accountId: account.id, name: 'example.test', kind: 'primary', siteType: 'php', docRoot: '/home/alice/public_html', suspended: false } as Domain
const draft = { template: 'coming-soon' as const, lang: 'en' as const, title: 'A title', message: 'Some text', email: '', phone: '' }
describe('confined site publisher recovery boundary', () => {
  it('derives the current account-relative target and refuses foreign, alias, redirect and escaping roots', () => {
    expect(deriveSitePublisherTarget(account, domain)).toMatchObject({ path: 'public_html', domainName: 'example.test' })
    for (const change of [{ accountId: '33333333-3333-4333-8333-333333333333' }, { kind: 'alias' }, { redirect: { url: 'https://example.test' } }, { suspended: true }, { docRoot: '/home/alice' }, { docRoot: '/home/bob/public_html' }, { docRoot: '/home/alice/.xpanel/site' }, { docRoot: '/home/alice/a/../public_html' }]) expect(() => deriveSitePublisherTarget(account, { ...domain, ...change } as Domain)).toThrow()
  })
  it('escapes customer content and generates deterministic bilingual script-free previews', () => {
    for (const lang of ['en', 'ar'] as const) {
      const result = renderSitePublisherDraft({ ...draft, lang, title: '<script>alert(1)</script>', message: 'A & B\nSecond line', email: 'me@example.test', phone: '+123' })
      expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); expect(result.html).toContain('dir="' + (lang === 'ar' ? 'rtl' : 'ltr') + '"'); expect(result.html).not.toContain('<script>'); expect(result.hash).toHaveLength(64)
      expect(renderSitePublisherDraft({ ...draft, lang }).hash).toBe(renderSitePublisherDraft({ ...draft, lang }).hash)
    }
  })
  it('rejects unknown fields, control content and invalid draft selectors', () => {
    for (const change of [{ path: '/etc/passwd' }, { template: 'external' }, { lang: 'xx' }, { title: '' }, { message: 'bad\u202e' }, { phone: 'javascript:1' }, { email: 'wrong' }]) expect(() => parseSitePublisherDraft({ ...draft, ...change })).toThrow()
    expect(() => parseSitePublisherMutation({ expectedRevision: 'a'.repeat(64), draft, accountId: account.id }, 'publish')).toThrow()
  })
  it('archives the whole document root before any live write and stops with backup_failed when it cannot', async () => {
    const memory = memoryFiles({ 'public_html/index.php': '<?php echo 1;', 'public_html/app.css': 'body{}' })
    memory.files.compress = vi.fn(async () => fail('LIMIT_EXCEEDED', 'quota'))
    const workspace = new SitePublisherWorkspace(deriveSitePublisherTarget(account, domain), memory.files, async () => {})
    const view = await workspace.inspect()
    expect(view.capabilities).toEqual({ canPublish: true, canRollback: false })
    const before = memory.docroot()
    await expect(workspace.publish(view.revision, draft)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'backup_failed', stateChanged: false } })
    expect(memory.docroot()).toEqual(before)
    expect(memory.writes.filter(path => path.startsWith('public_html/'))).toEqual([])
  })
  it('publishes after the archive, keeps the current backup and removes backups older than 30 days', async () => {
    const memory = memoryFiles({ 'public_html/index.php': '<?php echo 1;' }, ['20260901T000000000Z-0123456789abcdef', '20261101T000000000Z-0123456789abcdef'])
    const workspace = new SitePublisherWorkspace(deriveSitePublisherTarget(account, domain), memory.files, async () => {})
    const now = new Date('2026-11-07T10:00:00.000Z')
    const view = await workspace.publish((await workspace.inspect()).revision, draft, now)
    expect(view.recovery.status).toBe('published'); expect(view.capabilities).toEqual({ canPublish: true, canRollback: true })
    expect(memory.lastBackup()).toMatch(/^20261107T100000000Z-[0-9a-f]{16}$/)
    expect(memory.files.compress).toHaveBeenCalledWith(['public_html'], '.xpanel/site-publisher/' + domain.id + '/' + memory.lastBackup() + '/document-root.tar.zst')
    expect(memory.order.indexOf('compress')).toBeLessThan(memory.order.indexOf('write:public_html/index.html'))
    expect(memory.docroot()).toEqual({ 'public_html/index.html': renderSitePublisherDraft(draft).html })
    expect(memory.purged).toEqual(['.xpanel/site-publisher/' + domain.id + '/20260901T000000000Z-0123456789abcdef'])
    const restored = await workspace.rollback(view.revision)
    expect(restored.recovery.status).toBe('restored'); expect(memory.docroot()).toEqual({ 'public_html/index.php': '<?php echo 1;' })
  })
  it('does not bypass revoked authorization while failing closed', async () => {
    const workspace = new SitePublisherWorkspace(deriveSitePublisherTarget(account, domain), { list: vi.fn(), readText: vi.fn(), writeTextChecked: vi.fn(), mkdir: vi.fn(), compress: vi.fn(), moveToTrash: vi.fn(), purgeTrash: vi.fn() }, async () => fail('FORBIDDEN', 'revoked', { stateChanged: false }))
    await expect(workspace.publish('a'.repeat(64), draft)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('refuses recovery of an absent journal and enforces request JSON bounds', async () => {
    const workspace = new SitePublisherWorkspace(deriveSitePublisherTarget(account, domain), { list: async () => [], readText: async () => fail('NOT_FOUND', 'missing'), writeTextChecked: vi.fn(), mkdir: vi.fn(), compress: vi.fn(), moveToTrash: vi.fn(), purgeTrash: vi.fn() }, async () => {})
    const view = await workspace.inspect()
    await expect(workspace.rollback(view.revision)).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    await expect(readSitePublisherBody(new Request('http://local', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(readSitePublisherBody(new Request('http://local', { method: 'POST', body: JSON.stringify({ message: 'x'.repeat(17000) }), headers: { 'content-type': 'application/json' } }))).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('rejects delegated/root callers and checks the fresh owner before accepting a preview', async () => {
    const current = { ...account, username: 'alice', planId: 'plan' }, principalId = '33333333-3333-4333-8333-333333333333'
    const deps = { caller: { principalId, actor: 'alice', role: 'user', accountId: account.id, resellerId: null }, store: { getAccountByUsername: async () => current, getDomain: async () => domain, getPlan: async () => ({ featureListId: 'features' }), getFeatureList: async () => ({ disabled: [] }), withAccountLifecycleLease: vi.fn() }, currentPrincipal: async () => ({ kind: 'user', id: principalId, username: 'alice', accountId: account.id, disabled: false }), files: vi.fn(), audit: vi.fn() } as unknown as SitePublisherAgentDeps
    const url = new URL('http://local/accounts/alice/site-publisher/' + domain.id + '/preview')
    const req = () => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) })
    const reply = await handleSitePublisherAgentRoute(req(), url, 'POST', deps)
    const preview: unknown = await reply!.json()
    if (!preview || typeof preview !== 'object' || !('html' in preview) || typeof preview.html !== 'string') throw new Error('invalid_preview_reply')
    expect(preview.html).toContain('<!doctype html>'); expect(deps.files).not.toHaveBeenCalled(); expect(deps.store.withAccountLifecycleLease).not.toHaveBeenCalled()
    await expect(handleSitePublisherAgentRoute(req(), url, 'POST', { ...deps, caller: { ...deps.caller, role: 'root' } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(handleSitePublisherAgentRoute(req(), url, 'POST', { ...deps, currentPrincipal: async () => null })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(handleSitePublisherAgentRoute(req(), new URL(url + '?accountId=other'), 'POST', deps)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

/** In-memory confined file service: paths are home-relative, as the helper sees them. */
function memoryFiles(initial: Record<string, string>, backups: string[] = []) {
  const text = new Map(Object.entries(initial)), dirs = new Set<string>(['public_html', ...backups.map(id => '.xpanel/site-publisher/' + domain.id + '/' + id)])
  const order: string[] = [], writes: string[] = [], purged: string[] = []
  let tick = 0, last = ''
  const mtime = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()
  const times = new Map<string, string>()
  const parentOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  for (const dir of [...dirs]) for (let p = parentOf(dir); p; p = parentOf(p)) dirs.add(p)
  const files = {
    list: vi.fn(async (path: string) => [...[...dirs].filter(dir => parentOf(dir) === path).map(dir => ({ name: dir.slice(path ? path.length + 1 : 0), path: dir, kind: 'directory' as const, sizeBytes: 0, mode: 0o750, mtime: '2026-01-01T00:00:00.000Z' })),
      ...[...text.keys()].filter(file => parentOf(file) === path).map(file => ({ name: file.slice(path ? path.length + 1 : 0), path: file, kind: 'file' as const, sizeBytes: Buffer.byteLength(text.get(file)!), mode: 0o640, mtime: times.get(file) ?? '2026-01-01T00:00:00.000Z' }))]),
    readText: vi.fn(async (path: string) => text.has(path) ? { path, content: text.get(path)!, sizeBytes: Buffer.byteLength(text.get(path)!), mtime: times.get(path) ?? '2026-01-01T00:00:00.000Z' } : fail('NOT_FOUND', 'missing')),
    writeTextChecked: vi.fn(async (path: string, content: string | null) => {
      order.push('write:' + path); writes.push(path)
      if (content === null) { text.delete(path); return null }
      text.set(path, content); const at = mtime(); times.set(path, at)
      return { name: path.split('/').pop()!, path, kind: 'file' as const, sizeBytes: Buffer.byteLength(content), mode: 0o640, mtime: at }
    }),
    mkdir: vi.fn(async (path: string) => { dirs.add(path); if (path.split('/').length === 4) last = path.split('/')[3]!; return { name: path.split('/').pop()!, path, kind: 'directory' as const, sizeBytes: 0, mode: 0o750, mtime: mtime() } }),
    compress: vi.fn(async (_paths: readonly string[], destination: string) => { order.push('compress'); return { name: 'document-root.tar.zst', path: destination, kind: 'file' as const, sizeBytes: 1, mode: 0o640, mtime: mtime() } }),
    moveToTrash: vi.fn(async (path: string) => { dirs.delete(path); return { id: 'trash-' + purged.length, originalPath: path, name: path.split('/').pop()!, sizeBytes: 0, deletedAt: '2026-11-07T10:00:00.000Z' } }),
    purgeTrash: vi.fn(async (_id: string, expected: { originalPath: string }) => { purged.push(expected.originalPath); return { id: _id, originalPath: expected.originalPath, name: '', sizeBytes: 0, deletedAt: '2026-11-07T10:00:00.000Z' } }),
  }
  const docroot = () => Object.fromEntries([...text].filter(([path]) => path.startsWith('public_html/')))
  return { files, order, writes, purged, docroot, lastBackup: () => last }
}
