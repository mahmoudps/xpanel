import { describe, expect, it } from 'vitest'
import { renderSitePublisherDraft } from '../../agent/src/site-publisher.ts'
import { executeSitePublisherWorkspaceRequest, parseSitePublisherHttpRequest, validateSitePublisherWorkspaceReply } from './site-publisher-workspace.ts'

const target = { accountId: '11111111-1111-4111-8111-111111111111', domainId: '22222222-2222-4222-8222-222222222222' }, revision = 'a'.repeat(64)
const draft = { template: 'coming-soon' as const, lang: 'en' as const, title: 'Title', message: 'Message', email: '', phone: '' }
const view = () => ({ context: { ...target, domainName: 'example.test', path: 'public_html' }, revision, files: ['index.html', 'index.htm', 'index.php'].map(name => ({ name, exists: false, hash: null, sizeBytes: 0 })), recovery: { status: 'none', createdAt: null }, capabilities: { canPublish: false, canRollback: false }, application: { status: 'read', nativeQualified: false } })
describe('site publisher protected API boundary', () => {
  it('pins operation and rejects caller-controlled account/path/operation fields', () => {
    expect(parseSitePublisherHttpRequest('GET', undefined)).toEqual({ operation: 'read' })
    expect(parseSitePublisherHttpRequest('POST', 'preview', draft)).toEqual({ operation: 'preview', body: draft })
    expect(parseSitePublisherHttpRequest('POST', 'rollback', { expectedRevision: revision })).toEqual({ operation: 'rollback', body: { expectedRevision: revision } })
    for (const extra of [{ accountId: target.accountId }, { path: '/etc/passwd' }, { operation: 'publish' }, { expectedRevision: revision }]) expect(() => parseSitePublisherHttpRequest('POST', 'preview', { ...draft, ...extra })).toThrow()
    expect(() => parseSitePublisherHttpRequest('GET', 'publish', draft)).toThrow()
  })
  it('pins every reply to the selected account/domain and refuses unqualified publish claims', () => {
    expect(validateSitePublisherWorkspaceReply(target, view())).toEqual(view())
    for (const change of [{ context: { ...view().context, accountId: target.domainId } }, { context: { ...view().context, path: '/etc/passwd' } }, { capabilities: { canPublish: true, canRollback: false } }, { application: { status: 'read', nativeQualified: true } }, { recovery: { status: 'none', createdAt: '2026-10-27T00:00:00.000Z' } }]) expect(() => validateSitePublisherWorkspaceReply(target, { ...view(), ...change })).toThrow()
  })
  it('checks preview bytes against their digest and blocks active content', () => {
    const preview = renderSitePublisherDraft(draft)
    expect(validateSitePublisherWorkspaceReply(target, preview, 'preview')).toEqual(preview)
    expect(() => validateSitePublisherWorkspaceReply(target, { ...preview, html: preview.html + ' ' }, 'preview')).toThrow()
    expect(() => validateSitePublisherWorkspaceReply(target, { html: '<!doctype html><script>x</script>', hash: 'a'.repeat(64) }, 'preview')).toThrow()
  })
  it('preserves known unchanged refusals and locks ambiguous mutations', async () => {
    const request = parseSitePublisherHttpRequest('POST', 'publish', { expectedRevision: revision, draft })
    const refusal = await executeSitePublisherWorkspaceRequest(target, request, async () => Response.json({ error: { detail: { stateChanged: false } } }, { status: 412 }))
    expect(refusal.status).toBe(412); expect(await refusal.json()).toMatchObject({ details: { stateChanged: false } })
    for (const invoke of [async () => Response.json({ error: 'failed' }, { status: 503 }), async () => Response.json(view()), async () => { throw new Error('disconnect') }]) await expect(executeSitePublisherWorkspaceRequest(target, request, invoke)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true } })
  })
  it('bounds streamed replies and returns only validated inspection or preview data', async () => {
    const response = await executeSitePublisherWorkspaceRequest(target, { operation: 'read' }, async () => Response.json(view()))
    expect(await response.json()).toEqual(view()); expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(executeSitePublisherWorkspaceRequest(target, { operation: 'read' }, async () => new Response(' '.repeat(65537)))).rejects.toMatchObject({ detail: { stateChanged: false } })
  })
})
