import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleUpgradeWorkspaceRoute } from './upgrade-workspace.ts'
import type { UpgradeWorkspaceHelpers } from './upgrade-workspace.ts'

const caller = (kind: 'root' | 'reseller' = 'root', id = '00000000-0000-4000-8000-000000000001'): AuthenticatedCaller => ({ principal: { kind, id, username: kind } } as unknown as AuthenticatedCaller)
const revision = 'a'.repeat(64)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const harness = (options: { callers?: AuthenticatedCaller[]; agent?: (path: string, body: unknown) => Response } = {}) => {
  const callers = [...(options.callers ?? [])]
  const audits: string[] = []
  const agentCalls: { path: string; method: string | undefined; body: unknown }[] = []
  const helpers: UpgradeWorkspaceHelpers = {
    requireCaller: vi.fn(async () => callers.length > 1 ? callers.shift()! : callers[0] ?? caller()),
    assertRoot: async (current, action) => { if (current.principal.kind !== 'root') fail('FORBIDDEN', `root is required for ${action}`) },
    emitAudit: async input => { audits.push(input.action) },
    callAgent: async (path, opts) => { agentCalls.push({ path, method: opts.method, body: opts.body }); return options.agent ? options.agent(path, opts.body) : json({ ok: true, path }) },
  }
  const call = (path: string, method = 'GET', body?: unknown) => handleUpgradeWorkspaceRoute(new Request('https://panel.test' + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), new URL('https://panel.test' + path), method, helpers)
  return { helpers, audits, agentCalls, call }
}

describe('API upgrade workspace', () => {
  it('forwards root reads to the fixed agent observation routes', async () => {
    const h = harness()
    const read = (await h.call('/api/server/upgrade'))!
    expect(read.status).toBe(200)
    expect(read.headers.get('cache-control')).toBe('no-store')
    expect(await read.json()).toEqual({ ok: true, path: '/host/upgrade' })
    await h.call('/api/server/upgrade/status')
    expect(h.agentCalls.map(item => item.path)).toEqual(['/host/upgrade', '/host/upgrade/status'])
    expect(await h.call('/api/server/other')).toBeNull()
    expect((await h.call('/api/server/upgrade', 'POST'))!.status).toBe(405)
    await expect(h.call('/api/server/upgrade?targetVersion=1.1.0')).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('refuses non-root callers before any agent call', async () => {
    const h = harness({ callers: [caller('reseller')] })
    await expect(h.call('/api/server/upgrade')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(h.call('/api/server/upgrade/start', 'POST', { targetVersion: '1.1.0', expectedRevision: revision, confirm: 'upgrade 1.1.0' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(h.agentCalls).toEqual([])
  })

  it('rejects request-controlled preflight evidence with 422 semantics', async () => {
    const h = harness()
    for (const field of ['freeBytes', 'os', 'currentVersion', 'schemaVersions', 'releaseBytes', 'dryRun', 'snapshotPath']) {
      await expect(h.call('/api/server/upgrade/preflight', 'POST', { targetVersion: '1.1.0', expectedRevision: revision, [field]: 1 })).rejects.toMatchObject({ code: 'VALIDATION', detail: { fields: [field] } })
    }
    await expect(h.call('/api/server/upgrade/preflight', 'POST', { targetVersion: '1.1', expectedRevision: revision })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.call('/api/server/upgrade/start', 'POST', { targetVersion: '1.1.0', expectedRevision: revision, confirm: 'yes' })).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'confirmation-mismatch' } })
    expect(h.agentCalls).toEqual([])
  })

  it('forwards preflight and passes the agent refusal status through', async () => {
    const h = harness({ agent: () => json({ code: 'CONFLICT', details: { reason: 'revision-changed' } }, 409) })
    const response = (await h.call('/api/server/upgrade/preflight', 'POST', { targetVersion: '1.1.0', expectedRevision: revision }))!
    expect(response.status).toBe(409)
    expect(h.agentCalls).toEqual([{ path: '/host/upgrade/preflight', method: 'POST', body: { targetVersion: '1.1.0', expectedRevision: revision } }])
  })

  it('audits start before dispatch and after acceptance, re-checking root around the agent call', async () => {
    const accepted = { accepted: true, handoffId: '11111111-1111-4111-8111-111111111111', upgradeId: null, targetVersion: '1.1.0', fromVersion: '1.0.0' }
    const h = harness({ agent: () => json(accepted, 202) })
    const response = (await h.call('/api/server/upgrade/start', 'POST', { targetVersion: '1.1.0', expectedRevision: revision, confirm: 'upgrade 1.1.0' }))!
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual(accepted)
    expect(h.audits).toEqual(['upgrade.start_requested', 'upgrade.start_accepted'])
    expect(h.helpers.requireCaller).toHaveBeenCalledTimes(3)
    expect(h.agentCalls[0]).toEqual({ path: '/host/upgrade/start', method: 'POST', body: { targetVersion: '1.1.0', expectedRevision: revision, confirm: 'upgrade 1.1.0' } })
  })

  it('reports a handed-off start as needing verification when root is revoked during the call', async () => {
    const h = harness({ callers: [caller(), caller(), caller('reseller')], agent: () => json({ accepted: true }, 202) })
    await expect(h.call('/api/server/upgrade/start', 'POST', { targetVersion: '1.1.0', expectedRevision: revision, confirm: 'upgrade 1.1.0' })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: true, verificationRequired: true } })
    expect(h.audits).toEqual(['upgrade.start_requested'])
  })

  it('does not dispatch when root changes between the audit and the agent call', async () => {
    const h = harness({ callers: [caller(), caller('root', '00000000-0000-4000-8000-000000000002')] })
    await expect(h.call('/api/server/upgrade/start', 'POST', { targetVersion: '1.1.0', expectedRevision: revision, confirm: 'upgrade 1.1.0' })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(h.agentCalls).toEqual([])
  })
})
