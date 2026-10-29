import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { handleComposerWorkspaceRoute } from './composer-workspace.ts'
import type { ComposerWorkspaceHelpers } from './composer-workspace.ts'

const caller = { principal: { id: 'root-a', username: 'root', kind: 'root' } } as AuthenticatedCaller
const domainId = '11111111-2222-4333-8444-555555555555', jobId = '99999999-2222-4333-8444-555555555555', H = (c: string) => c.repeat(64)
const review = { state: 'ready', action: 'install', domainId, domain: 'example.test', account: 'alpha', phpVersion: '8.3', expectedRevision: H('a'), reviewFingerprint: H('b'), graphDigest: H('c'), lockDigest: H('d'), packages: [{ name: 'vendor/package', version: '1.2.0', development: false }] }
const fixture = (reply: unknown) => {
  const helpers = { requireCaller: vi.fn(async () => caller), assertRoot: vi.fn(async () => {}), callHost: vi.fn(async () => reply), emitAudit: vi.fn(async () => {}) }
  return helpers as typeof helpers & ComposerWorkspaceHelpers
}
const post = (helpers: ComposerWorkspaceHelpers, path: string, body: unknown) => { const url = new URL('http://local/api/server/composer/jobs/' + path); return handleComposerWorkspaceRoute(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, 'POST', helpers) }

describe('Composer job API binding', () => {
  it('previews through the agent and returns only the verified review grammar', async () => {
    const f = fixture({ review: { ...review } })
    const body = await (await post(f, 'preview', { action: 'install', domainId }))!.json()
    expect(f.callHost).toHaveBeenCalledWith(caller, '/host/composer/jobs/preview', { action: 'install', domainId }, false)
    expect(body.review.packages).toEqual(review.packages); expect(f.emitAudit).not.toHaveBeenCalled()
    await expect(post(fixture({ review: { ...review, action: 'update' } }), 'preview', { action: 'install', domainId })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(post(fixture({ review: { ...review, script: 'post-install' } }), 'preview', { action: 'install', domainId })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it.each([{ action: 'install', domainId, path: '/home/alpha' }, { action: 'require', domainId }, { action: 'install', domainId: 'site-a' }])('refuses extra fields, unknown actions and non-id targets %#', async input => {
    const f = fixture({ review }); await expect(post(f, 'preview', input)).rejects.toMatchObject({ code: 'VALIDATION' }); expect(f.callHost).not.toHaveBeenCalled()
  })
  it('audits intent and submission around a verified 202 job and marks unverifiable replies unknown', async () => {
    const input = { action: 'install', domainId, expectedRevision: H('a'), reviewFingerprint: H('b') }
    const f = fixture({ job: { id: jobId, kind: 'composer.dependencies.install' } })
    const response = await post(f, 'apply', input)
    expect(response!.status).toBe(202); expect(f.emitAudit).toHaveBeenCalledTimes(2); expect(f.callHost).toHaveBeenCalledWith(caller, '/host/composer/jobs/apply', input, true)
    await expect(post(fixture({ job: { id: jobId, kind: 'composer.dependencies.update' } }), 'apply', input)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    const { emitAudit: _, ...noAudit } = fixture({}); await expect(post(noAudit as ComposerWorkspaceHelpers, 'apply', input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const agentRefusal = fixture(null); agentRefusal.callHost.mockRejectedValue(Object.assign(new Error('refused'), { code: 'PRECONDITION_FAILED', detail: { stateChanged: false } }))
    await expect(post(agentRefusal, 'apply', input)).rejects.toThrow('refused')
  })
})
