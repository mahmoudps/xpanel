import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { policyForRequest } from './authorization.ts'
import { entryPointAllowsApiRoute } from './entry-points.ts'
import { handleNodesWorkspaceRoute, nodeConfigRevision, parseNodeConfig, savedNodeConfigRevision } from './ops-nodes-workspace.ts'
import type { ManagedNode, NodesWorkspaceHelpers } from './ops-nodes-workspace.ts'

const root = { principal: { kind: 'root', id: 'fixture-root', username: 'root' }, sessionId: 'sess', apiTokenId: null } as AuthenticatedCaller
const node = (overrides: Partial<ManagedNode> = {}): ManagedNode => ({ id: 'node_' + 'a'.repeat(16), label: 'Node 2', hostname: 'node2.example.com', port: 2087, fingerprint: 'b'.repeat(64), role: 'all', ...overrides })
const helpers = (overrides: Partial<NodesWorkspaceHelpers> = {}) => {
  let stored: unknown = null
  const events: string[] = []
  const value: NodesWorkspaceHelpers = {
    requireCaller: async () => root,
    assertRoot: async (_caller, action) => { events.push('root:' + action) },
    emitAudit: async entry => { events.push('audit:' + entry.action + ':' + entry.outcome) },
    readSaved: async () => stored,
    writeSaved: async next => { stored = next; return next },
    readHostname: async () => 'panel.example.com',
    ...overrides,
  }
  return { value, events }
}
const call = (h: NodesWorkspaceHelpers, path: string, method = 'GET', body?: unknown) => {
  const url = new URL('http://localhost' + path)
  return handleNodesWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, h)
}

describe('server nodes API workspace', () => {
  it('is root-only server policy on the xWHM listener', () => {
    for (const path of ['/api/server/nodes', '/api/server/nodes/verify']) {
      expect(policyForRequest(path, 'POST')).toMatchObject({ resource: 'server', rootOnly: true })
      expect(entryPointAllowsApiRoute('xwhm', path, 'POST')).toBe(true)
      expect(entryPointAllowsApiRoute('xpanel', path, 'POST')).toBe(false)
    }
  })
  it('validates the node registry grammar strictly', () => {
    expect(parseNodeConfig({ nodes: [node()] }).nodes).toHaveLength(1)
    const mutate = (change: (value: { nodes: unknown[] }) => void) => { const value = { nodes: [node()] }; change(value as never); return () => parseNodeConfig(value) }
    expect(mutate(value => { (value.nodes[0] as ManagedNode).hostname = 'nodots' })).toThrow()
    expect(mutate(value => { (value.nodes[0] as ManagedNode).fingerprint = 'zz' })).toThrow()
    expect(mutate(value => { (value.nodes[0] as ManagedNode).port = 0 })).toThrow()
    expect(mutate(value => { (value.nodes[0] as Record<string, unknown>).extra = 1 })).toThrow()
    expect(mutate(value => { value.nodes[1] = node() })).toThrow()
  })
  it('reports a single-node honest state and the channel verification capability', async () => {
    const body = await (await call(helpers().value, '/api/server/nodes'))!.json() as Record<string, any>
    expect(body).toMatchObject({ singleNode: true, thisServer: { hostname: 'panel.example.com' }, channel: { verification: 'unavailable' } })
    expect(body.config.nodes).toEqual([])
    const withChannel = await (await call(helpers({ verifyChannel: async () => ({ reachable: true, fingerprintMatched: true }) }).value, '/api/server/nodes'))!.json() as Record<string, any>
    expect(withChannel.channel.verification).toBe('available')
  })
  it('saves the registry with optimistic concurrency and verifies the write', async () => {
    const h = helpers()
    const first = await (await call(h.value, '/api/server/nodes'))!.json() as Record<string, any>
    const saved = await call(h.value, '/api/server/nodes', 'PUT', { config: { nodes: [node()] }, expectedSavedRevision: first.savedRevision })
    expect(await saved!.json()).toMatchObject({ config: { nodes: [{ hostname: 'node2.example.com' }] }, activeRevision: nodeConfigRevision({ nodes: [node()] }) })
    expect(h.events).toContain('audit:server.nodes.saved:ok')
    await expect(call(h.value, '/api/server/nodes', 'PUT', { config: { nodes: [node()] }, expectedSavedRevision: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('reports an honest pending state when the authenticated channel is unavailable', async () => {
    let stored: unknown = { nodes: [node()] }
    const h = helpers({ readSaved: async () => stored })
    const response = await call(h.value, '/api/server/nodes/verify', 'POST', { id: node().id })
    expect(await response!.json()).toEqual({ id: node().id, enrollment: 'pending', reason: 'authenticated_channel_unavailable' })
    expect(h.events).toContain('audit:server.nodes.verify_attempted:ok')
    void stored
  })
  it('verifies a reachable node and rejects a fingerprint mismatch when a channel exists', async () => {
    const stored = { nodes: [node()] }
    const verified = await (await call(helpers({ readSaved: async () => stored, verifyChannel: async () => ({ reachable: true, fingerprintMatched: true }) }).value, '/api/server/nodes/verify', 'POST', { id: node().id }))!.json()
    expect(verified).toEqual({ id: node().id, enrollment: 'verified', reason: null })
    const mismatch = await (await call(helpers({ readSaved: async () => stored, verifyChannel: async () => ({ reachable: true, fingerprintMatched: false }) }).value, '/api/server/nodes/verify', 'POST', { id: node().id }))!.json() as Record<string, any>
    expect(mismatch).toMatchObject({ enrollment: 'unreachable', reason: 'fingerprint_mismatch' })
    await expect(call(helpers({ readSaved: async () => stored }).value, '/api/server/nodes/verify', 'POST', { id: 'node_' + 'c'.repeat(16) })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

void savedNodeConfigRevision
