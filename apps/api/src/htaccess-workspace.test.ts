import { describe, expect, it } from 'vitest'
import { parseHtaccessHttpRequest, validateHtaccessWorkspaceReply, executeHtaccessWorkspaceRequest } from './htaccess-workspace.ts'
import { validateFileWorkspaceRequest } from './file-workspace-validation.ts'
const target = { domainId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111' }, revision = 'a'.repeat(64)
describe('.htaccess public transport', () => {
  it('pins operation to the route and carries the actual PHP migration draft', () => {
    expect(parseHtaccessHttpRequest('GET', undefined)).toEqual({ op: 'read' })
    expect(parseHtaccessHttpRequest('POST', 'migrate-php', { content: 'php_value memory_limit 128M', expectedRevision: revision, expectedPhpRevision: revision })).toMatchObject({ op: 'migrate-php', content: 'php_value memory_limit 128M' })
    for (const extra of [{ path: '/etc/passwd' }, { host: 'other.test' }, { accountId: target.accountId }, { op: 'read' }]) expect(() => parseHtaccessHttpRequest('PUT', undefined, { content: '', expectedRevision: revision, ...extra })).toThrow()
    expect(() => validateFileWorkspaceRequest({ op: 'write-checked', path: '.htaccess', content: '', remove: false, expectedExists: false, expectedContent: '', expectedMtime: '', mode: 0o640 })).toThrow()
  })
  it('refuses foreign-account replies independently of the browser', () => { expect(() => validateHtaccessWorkspaceReply(target, { context: { domainId: target.domainId, accountId: '33333333-3333-4333-8333-333333333333', path: '.htaccess', domainName: 'example.test' } })).toThrow() })
  it('preserves known unchanged refusals and locks unverifiable mutations', async () => {
    const request = { op: 'save' as const, content: '', expectedRevision: revision }
    const refused = await executeHtaccessWorkspaceRequest(target, request, async () => Response.json({ error: { details: { stateChanged: false } } }, { status: 409 }))
    expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ details: { stateChanged: false } })
    await expect(executeHtaccessWorkspaceRequest(target, request, async () => Response.json({ bogus: true }))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
  })
})
