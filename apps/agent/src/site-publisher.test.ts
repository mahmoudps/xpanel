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
  it('reports publishing unavailable for an empty document root without writing backups', async () => {
    const write = vi.fn(), mkdir = vi.fn(), authorize = vi.fn(async () => {})
    const workspace = new SitePublisherWorkspace(deriveSitePublisherTarget(account, domain), { list: async () => [], readText: async () => fail('NOT_FOUND', 'missing'), writeTextChecked: write, mkdir }, authorize)
    const view = await workspace.inspect()
    expect(view.capabilities).toEqual({ canPublish: false, canRollback: false }); expect(view.recovery.status).toBe('none')
    await expect(workspace.publish(view.revision, draft)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(write).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled(); expect(authorize).toHaveBeenCalled()
  })
  it('refuses publication on nonempty document roots before any file operation', async () => {
    const list = vi.fn(), readText = vi.fn(), write = vi.fn(), mkdir = vi.fn()
    const workspace = new SitePublisherWorkspace(deriveSitePublisherTarget(account, domain), { list, readText, writeTextChecked: write, mkdir }, async () => {})
    await expect(workspace.publish('a'.repeat(64), draft)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    for (const operation of [list, readText, write, mkdir]) expect(operation).not.toHaveBeenCalled()
  })
  it('does not bypass revoked authorization while failing closed', async () => {
    const workspace = new SitePublisherWorkspace(deriveSitePublisherTarget(account, domain), { list: vi.fn(), readText: vi.fn(), writeTextChecked: vi.fn(), mkdir: vi.fn() }, async () => fail('FORBIDDEN', 'revoked', { stateChanged: false }))
    await expect(workspace.publish('a'.repeat(64), draft)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('refuses recovery of an absent journal and enforces request JSON bounds', async () => {
    const workspace = new SitePublisherWorkspace(deriveSitePublisherTarget(account, domain), { list: async () => [], readText: async () => fail('NOT_FOUND', 'missing'), writeTextChecked: vi.fn(), mkdir: vi.fn() }, async () => {})
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
