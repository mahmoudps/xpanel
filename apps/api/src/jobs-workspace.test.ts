import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleJobsWorkspaceRoute } from './jobs-workspace.ts'
import type { JobsWorkspaceHelpers } from './jobs-workspace.ts'

const root = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' } } as AuthenticatedCaller
const reseller = { principal: { kind: 'reseller', id: '22222222-2222-4222-8222-222222222222', username: 'res1' } } as AuthenticatedCaller
const ID = '00000000-0000-4000-8000-000000000000'

const helpers = (overrides: Partial<JobsWorkspaceHelpers> = {}) => {
  const events: string[] = []
  const base: JobsWorkspaceHelpers = {
    requireCaller: vi.fn(async () => { events.push('auth'); return root }),
    assertRoot: vi.fn(async (caller: AuthenticatedCaller) => {
      events.push('root')
      if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required for this operation')
    }),
    emitAudit: vi.fn(async (entry: { action: string }) => { events.push(entry.action) }),
    callAgent: vi.fn(async (_caller: AuthenticatedCaller, path: string, method: string) => { events.push(`${method} ${path}`); return Response.json({ jobs: [] }) }),
    ...overrides,
  }
  return { helpers: base, events }
}

const call = (path: string, method: string, h: JobsWorkspaceHelpers, body?: string) => {
  const url = new URL('http://localhost' + path)
  return handleJobsWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body }) }), url, method, h)
}

describe('API host jobs workspace', () => {
  it.each(['XP-JOB-2026-000123', 'LEGACY/77-A', null])('preserves the issued or null reference through list, detail and cancellation: %s', async referenceCode => {
    const job = { id: ID, referenceCode, status: 'running' }
    const { helpers: h } = helpers({ callAgent: vi.fn(async (_caller, path) => Response.json(path === '/host/jobs' ? { jobs: [job] } : { job })) })
    for (const [path, method] of [['/api/jobs', 'GET'], [`/api/jobs/${ID}`, 'GET'], [`/api/jobs/${ID}/cancel`, 'POST']]) {
      const response = (await call(path!, method!, h))!
      const result = await response.json() as { jobs?: { referenceCode: string | null }[]; job?: { referenceCode: string | null } }
      expect((result.job ?? result.jobs![0])!.referenceCode).toBe(referenceCode)
    }
  })

  it.each([undefined, ID, 'XP-JOB-000000', 'XP-JOB-2026-000123\nsecret'])('rejects an absent or unsafe public reference: %s', async referenceCode => {
    const { helpers: h } = helpers({ callAgent: vi.fn(async () => Response.json({ job: { id: ID, referenceCode } })) })
    await expect(call(`/api/jobs/${ID}`, 'GET', h)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
  })
  it('leaves unrelated routes untouched', async () => {
    const { helpers: h } = helpers()
    expect(await call('/api/jobsx', 'GET', h)).toBeNull()
    expect(await call('/api/server/php/inventory', 'GET', h)).toBeNull()
    expect(h.requireCaller).not.toHaveBeenCalled()
  })

  it('forwards validated reads to the agent after root authorization', async () => {
    const { helpers: h, events } = helpers()
    const response = (await call('/api/jobs?status=running&kindPrefix=system.packages&limit=20', 'GET', h))!
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ jobs: [] })
    expect(events).toEqual(['auth', 'root', 'GET /host/jobs?status=running&kindPrefix=system.packages&limit=20'])
    await call(`/api/jobs/${ID}`, 'GET', h)
    await call(`/api/jobs/${ID}/log?offset=128&limit=4096`, 'GET', h)
    expect(events.filter(event => event.startsWith('GET')).slice(-2)).toEqual([`GET /host/jobs/${ID}`, `GET /host/jobs/${ID}/log?offset=128&limit=4096`])
  })

  it('refuses resellers with 403 before any agent call', async () => {
    const { helpers: h } = helpers({ requireCaller: vi.fn(async () => reseller) })
    await expect(call('/api/jobs', 'GET', h)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(`/api/jobs/${ID}/cancel`, 'POST', h)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(h.callAgent).not.toHaveBeenCalled()
    expect(h.emitAudit).not.toHaveBeenCalled()
  })

  it.each([
    '/api/jobs?unknown=1', '/api/jobs?status=done', '/api/jobs?kindPrefix=../x', '/api/jobs?limit=500', '/api/jobs?limit=1&limit=2',
    '/api/jobs/AAAAAAAA-0000-4000-8000-000000000000', '/api/jobs/1', `/api/jobs/${ID}?status=queued`, `/api/jobs/${ID}/log?offset=x`, `/api/jobs/${ID}/log?limit=262145`,
  ])('rejects selector grammar %s', async path => {
    const { helpers: h } = helpers()
    await expect(call(path, 'GET', h)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(h.callAgent).not.toHaveBeenCalled()
  })

  it('answers wrong methods with 405', async () => {
    const { helpers: h } = helpers()
    const post = (await call('/api/jobs', 'POST', h))!
    expect(post.status).toBe(405); expect(post.headers.get('allow')).toBe('GET')
    const get = (await call(`/api/jobs/${ID}/cancel`, 'GET', h))!
    expect(get.status).toBe(405); expect(get.headers.get('allow')).toBe('POST')
    expect(h.callAgent).not.toHaveBeenCalled()
  })

  it('cancels with audit and re-asserts fresh root before and after the agent call', async () => {
    const { helpers: h, events } = helpers({ callAgent: vi.fn(async (_caller, path, method) => { events.push(`${method} ${path}`); return Response.json({ job: { id: ID, referenceCode: 'XP-JOB-2026-000123', status: 'running', cancelRequested: true } }) }) })
    const response = (await call(`/api/jobs/${ID}/cancel`, 'POST', h))!
    expect(await response.json()).toMatchObject({ job: { cancelRequested: true } })
    expect(events).toEqual(['auth', 'root', 'host.job.cancel_requested', 'auth', 'root', `POST /host/jobs/${ID}/cancel`, 'auth', 'root', 'host.job.cancel_recorded'])
    await expect(call(`/api/jobs/${ID}/cancel`, 'POST', h, '{"x":1}')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(`/api/jobs/${ID}/cancel?force=1`, 'POST', h)).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('reports a recorded cancellation when root authority changes after the agent call', async () => {
    const callers = [root, root, reseller]
    const { helpers: h } = helpers({ requireCaller: vi.fn(async () => callers.shift()!), callAgent: vi.fn(async () => Response.json({ job: { id: ID, referenceCode: null } })) })
    await expect(call(`/api/jobs/${ID}/cancel`, 'POST', h)).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: true, verificationRequired: true } })
  })

  it('maps agent absence and refusals to truthful problems without echoing agent text', async () => {
    const absent = helpers({ callAgent: vi.fn(async () => fail('PRECONDITION_FAILED', 'privileged host agent is not connected')) }).helpers
    await expect(call('/api/jobs', 'GET', absent)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false, reason: 'host_agent_unavailable' } })
    const problem = (status: number, details: Record<string, unknown> = {}) => helpers({ callAgent: vi.fn(async () => Response.json({ detail: 'secret /internal/path', details }, { status })) }).helpers
    await expect(call('/api/jobs', 'GET', problem(503))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'the host job runner is unavailable', detail: { reason: 'host_job_runner_unavailable' } })
    await expect(call(`/api/jobs/${ID}`, 'GET', problem(404))).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'host job not found' })
    await expect(call(`/api/jobs/${ID}/cancel`, 'POST', problem(412, { stateChanged: false }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    await expect(call(`/api/jobs/${ID}/cancel`, 'POST', problem(500))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true } })
    const broken = helpers({ callAgent: vi.fn(async () => { throw new TypeError('socket hang up') }) }).helpers
    await expect(call(`/api/jobs/${ID}/cancel`, 'POST', broken)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true } })
    const garbage = helpers({ callAgent: vi.fn(async () => new Response('not json')) }).helpers
    await expect(call('/api/jobs', 'GET', garbage)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
  })
})
