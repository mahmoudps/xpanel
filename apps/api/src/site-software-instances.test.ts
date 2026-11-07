import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleSiteSoftwareInstancesApiRoute } from './site-software-instances.ts'
import type { SiteSoftwareInstanceHelpers } from './site-software-instances.ts'

const ROOT = { principal: { id: '11111111-1111-4111-8111-111111111111', kind: 'root', username: 'root' } } as AuthenticatedCaller
const RESELLER = { principal: { id: '22222222-2222-4222-8222-222222222222', kind: 'reseller', username: 'reseller1' } } as AuthenticatedCaller
const row = { username: 'alice', accountId: '11111111-1111-4111-8111-111111111111', domainId: '22222222-2222-4222-8222-222222222222', domain: 'a.example', path: 'blog', appId: 'sample', version: '1.0.0', previousVersion: null, database: 'alice_app1', updatedAt: '2026-11-07T12:00:00.000Z', revision: 'a'.repeat(64), accountStatus: 'active' }
const harness = (callHost: SiteSoftwareInstanceHelpers['callHost'] | undefined, caller = ROOT) => {
  const helpers = { requireCaller: vi.fn(async () => caller), ...(callHost ? { callHost } : {}), assertRoot: vi.fn(async (who: AuthenticatedCaller) => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required') }) } as unknown as SiteSoftwareInstanceHelpers
  return (method: string, path: string, body?: unknown) => handleSiteSoftwareInstancesApiRoute(new Request('http://api.test' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://api.test' + path), method, helpers)
}

describe('site software instances workspace', { tags: ['unit'] }, () => {
  it('passes through only rows that match their grammar', async () => {
    const host = vi.fn(async () => ({ instances: [{ ...row, extra: 'dropped' }] }))
    expect(await (await harness(host)('GET', '/api/server/site-software/instances'))!.json()).toEqual({ instances: [row] })
    const send = harness(vi.fn(async () => ({ instances: [{ ...row, username: '../root' }] })))
    await expect(send('GET', '/api/server/site-software/instances')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('is root only and truthful without the host agent', async () => {
    await expect(harness(vi.fn(), RESELLER)('GET', '/api/server/site-software/instances')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(harness(undefined)('GET', '/api/server/site-software/instances')).rejects.toMatchObject({ detail: { reason: 'host_agent_unavailable' } })
    expect((await harness(vi.fn())('POST', '/api/server/site-software/instances'))!.status).toBe(405)
    expect(await harness(vi.fn())('GET', '/api/server/other')).toBeNull()
  })
  it('submits an exact job and treats an unverifiable reply as unknown', async () => {
    const body = { username: 'alice', domainId: row.domainId, path: 'blog', action: 'update', version: '1.1.0', expectedRecord: row.revision }
    const host = vi.fn(async () => ({ job: { id: 'job-9', kind: 'application.update' } }))
    const reply = await harness(host)('POST', '/api/server/site-software/instances/jobs', body)
    expect(reply!.status).toBe(202)
    expect(host).toHaveBeenCalledWith(ROOT, '/host/site-software/instances/jobs', body)
    await expect(harness(host)('POST', '/api/server/site-software/instances/jobs', { ...body, extra: 1 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(harness(vi.fn(async () => ({ job: { id: 'job-9', kind: 'application.remove' } })))('POST', '/api/server/site-software/instances/jobs', body)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
  })
  it('forwards one release chunk and checks the reply', async () => {
    const body = { appId: 'sample', version: '1.0.0', offset: 0, contentBase64: 'AQID' }, host = vi.fn(async () => ({ received: 3, complete: true, bytes: 3 }))
    expect(await (await harness(host)('POST', '/api/server/site-software/artifacts', body))!.json()).toEqual({ received: 3, complete: true, bytes: 3 })
    await expect(harness(host)('POST', '/api/server/site-software/artifacts', { ...body, name: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(harness(vi.fn(async () => ({})))('POST', '/api/server/site-software/artifacts', body)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
})
