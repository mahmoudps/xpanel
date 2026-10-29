import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { policyForRequest } from './authorization.ts'
import { entryPointAllowsApiRoute } from './entry-points.ts'
import { handleIntegrationsWorkspaceRoute, savedWebhookRevision } from './ops-integrations-workspace.ts'
import type { IntegrationsWorkspaceHelpers } from './ops-integrations-workspace.ts'
import { verifyWebhookSignature } from '../../agent/src/ops-webhooks.ts'
import type { WebhookDeliveryRecord } from '../../agent/src/ops-webhooks.ts'

const root = { principal: { kind: 'root', id: 'fixture-root', username: 'root' }, sessionId: 'sess', apiTokenId: null } as AuthenticatedCaller
const endpoint = { id: 'whk_' + 'a'.repeat(16), url: 'https://hooks.example.com/xpanel', events: ['account.created'], active: true }
const helpers = (overrides: Partial<IntegrationsWorkspaceHelpers> = {}) => {
  let saved: unknown = null, secrets: Record<string, string> = {}, log: WebhookDeliveryRecord[] = []
  const events: string[] = []
  const value: IntegrationsWorkspaceHelpers = {
    requireCaller: async () => root,
    assertRoot: async (_caller, action) => { events.push('root:' + action) },
    emitAudit: async entry => { events.push('audit:' + entry.action + ':' + entry.outcome) },
    readSaved: async () => saved, writeSaved: async next => { saved = next; return next },
    readSecrets: async () => secrets, writeSecrets: async next => { secrets = next; return next },
    readLog: async () => log, writeLog: async next => { log = next; return next },
    now: () => new Date('2026-10-28T09:00:00.000Z'),
    ...overrides,
  }
  return { value, events, getSecrets: () => secrets, getLog: () => log }
}
const call = (h: IntegrationsWorkspaceHelpers, path: string, method = 'GET', body?: unknown) => {
  const url = new URL('http://localhost' + path)
  return handleIntegrationsWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, h)
}

describe('integrations API workspace', () => {
  it('is root-only server policy on the xWHM listener', () => {
    for (const path of ['/api/server/integrations', '/api/server/integrations/test']) {
      expect(policyForRequest(path, 'POST')).toMatchObject({ resource: 'server', rootOnly: true })
      expect(entryPointAllowsApiRoute('xwhm', path, 'POST')).toBe(true)
    }
  })
  it('reads an empty configuration with an honest unavailable egress state', async () => {
    const body = await (await call(helpers().value, '/api/server/integrations'))!.json() as Record<string, any>
    expect(body).toMatchObject({ signatureScheme: 'hmac-sha256-t-v1', egress: { state: 'unavailable', reason: 'no_reviewed_webhook_egress' }, endpoints: [] })
    expect(body.egress.state).toBe('unavailable')
    const withEgress = await (await call(helpers({ sender: async () => ({ status: 200 }) }).value, '/api/server/integrations'))!.json() as Record<string, any>
    expect(withEgress.egress.state).toBe('available')
  })
  it('saves endpoints, generates a per-endpoint secret and never returns it', async () => {
    const h = helpers()
    const first = await (await call(h.value, '/api/server/integrations'))!.json() as Record<string, any>
    const response = await call(h.value, '/api/server/integrations', 'PUT', { config: { endpoints: [endpoint] }, expectedSavedRevision: first.savedRevision })
    const saved = await response!.json() as Record<string, any>
    expect(saved.endpoints[0]).toMatchObject({ url: endpoint.url, secretPresent: true })
    expect(JSON.stringify(saved)).not.toContain('whsec_')
    expect(h.getSecrets()[endpoint.id]).toMatch(/^whsec_[0-9a-f]{48}$/)
    expect(h.events).toContain('audit:server.integrations.saved:ok')
  })
  it('keeps an existing secret stable across saves and drops it when the endpoint is removed', async () => {
    const h = helpers()
    const first = await (await call(h.value, '/api/server/integrations'))!.json() as Record<string, any>
    await call(h.value, '/api/server/integrations', 'PUT', { config: { endpoints: [endpoint] }, expectedSavedRevision: first.savedRevision })
    const secret = h.getSecrets()[endpoint.id]
    const next = await (await call(h.value, '/api/server/integrations'))!.json() as Record<string, any>
    await call(h.value, '/api/server/integrations', 'PUT', { config: { endpoints: [{ ...endpoint, active: false }] }, expectedSavedRevision: next.savedRevision })
    expect(h.getSecrets()[endpoint.id]).toBe(secret)
    const third = await (await call(h.value, '/api/server/integrations'))!.json() as Record<string, any>
    await call(h.value, '/api/server/integrations', 'PUT', { config: { endpoints: [] }, expectedSavedRevision: third.savedRevision })
    expect(h.getSecrets()[endpoint.id]).toBeUndefined()
  })
  it('sends a signed test delivery through the injected sender and logs it', async () => {
    const send = vi.fn(async (input: { body: string; headers: Record<string, string> }) => { expect(verifyWebhookSignature('x', input.headers['x-xpanel-signature']!, input.body, Math.floor(Date.parse('2026-10-28T09:00:00.000Z') / 1000))).toBe(false); return { status: 200 } })
    const h = helpers({ sender: send })
    const first = await (await call(h.value, '/api/server/integrations'))!.json() as Record<string, any>
    await call(h.value, '/api/server/integrations', 'PUT', { config: { endpoints: [endpoint] }, expectedSavedRevision: first.savedRevision })
    const response = await call(h.value, '/api/server/integrations/test', 'POST', { id: endpoint.id })
    expect(await response!.json()).toMatchObject({ delivery: { endpointId: endpoint.id, state: 'delivered', lastStatus: 200 } })
    expect(send).toHaveBeenCalledTimes(1)
    expect(h.getLog()).toHaveLength(1)
    expect(h.events).toContain('audit:server.integrations.tested:ok')
  })
  it('refuses a test when outbound egress is unavailable, without sending', async () => {
    const h = helpers()
    const first = await (await call(h.value, '/api/server/integrations'))!.json() as Record<string, any>
    await call(h.value, '/api/server/integrations', 'PUT', { config: { endpoints: [endpoint] }, expectedSavedRevision: first.savedRevision })
    await expect(call(h.value, '/api/server/integrations/test', 'POST', { id: endpoint.id })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'no_reviewed_webhook_egress' } })
    expect(h.getLog()).toHaveLength(0)
    expect(h.events).toContain('audit:server.integrations.test_attempted:ok')
  })
  it('rejects a save conflict and an unknown endpoint test', async () => {
    const h = helpers({ sender: async () => ({ status: 200 }) })
    await expect(call(h.value, '/api/server/integrations', 'PUT', { config: { endpoints: [endpoint] }, expectedSavedRevision: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call(h.value, '/api/server/integrations/test', 'POST', { id: 'whk_' + 'c'.repeat(16) })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

void savedWebhookRevision
