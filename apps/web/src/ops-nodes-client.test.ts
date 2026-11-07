// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderOpsNodesWorkspace } from './board-port/ops-nodes-workspace.ts'
import { NODE_CLUSTER_CLIENT_BINDING, readClusterView } from './node-cluster-client.ts'
import { nodeRefusal, OPS_NODES_CLIENT_BINDING, readNodesView } from './ops-nodes-client.ts'

const tick = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const rev = (char: string) => char.repeat(64)
const node = { id: 'node_' + 'a'.repeat(16), label: 'Node 2', hostname: 'whm.node2.example.com', port: 2087, fingerprint: 'b'.repeat(64), role: 'all' as const, version: '1.4.0', linkedAt: '2026-11-07T10:00:00.000Z' }
const view = (overrides: Record<string, unknown> = {}) => ({ config: { nodes: [] as unknown[] }, savedRevision: rev('1'), invalid: false, thisServer: { hostname: 'panel.example.com', id: 'node_' + 'c'.repeat(16) }, singleNode: true, channel: { verification: 'available', reason: null }, invitations: { active: 0, expiresAt: null }, ...overrides })
const linked = () => view({ config: { nodes: [node] }, singleNode: false })
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const boot = (send?: Send, canManage = true, askDialog?: unknown) => {
  document.body.innerHTML = `<section data-whm-detail-route="/whm/server/nodes" data-capability-state="authorized">${renderOpsNodesWorkspace({ locale: 'en', canRead: true, canManage })}</section>`
  if (send) (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + OPS_NODES_CLIENT_BINDING)()(askDialog)
  new Function('return ' + NODE_CLUSTER_CLIENT_BINDING)()(askDialog)
}
const action = (key: string) => document.querySelector<HTMLButtonElement>('[data-ops-nodes-action="' + key + '"]')!
const status = () => document.querySelector<HTMLElement>('[data-ops-nodes-status]')!
const input = (name: string) => document.querySelector('[data-ops-nodes-' + name + ']') as HTMLInputElement
const rowAction = (name: string) => document.querySelector<HTMLButtonElement>('[data-ops-nodes-rows] [data-xp-action="' + name + '"]')!
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('server nodes client', () => {
  it('validates the contract and rejects malformed nodes and hostnames', () => {
    expect(readNodesView(linked()).config.nodes).toHaveLength(1)
    expect(() => readNodesView(view({ config: { nodes: [{ ...node, hostname: 'nodots' }] } }))).toThrow()
    expect(() => readNodesView(view({ config: { nodes: [{ ...node, fingerprint: 'zz' }] } }))).toThrow()
    expect(() => readNodesView(view({ thisServer: { hostname: 'nodots', id: 'x' } }))).toThrow()
    expect(() => readNodesView(view({ channel: { verification: 'maybe' } }))).toThrow()
  })
  it('names every stable refusal and falls back without inventing a cause', () => {
    const t = (message: string) => message
    for (const reason of ['node_already_linked', 'version_mismatch', 'self_link', 'fingerprint_mismatch', 'auth_refused', 'invitation_required', 'node_unreachable', 'identity_mismatch', 'management_tls_unavailable', 'public_origin_required', 'link_code_invalid', 'too_many_invitations']) expect(nodeRefusal(reason, t)).not.toBe(nodeRefusal('other', t))
  })
  it('shows the single-node state and a server that cannot be linked', async () => {
    boot(async () => view({ channel: { verification: 'unavailable', reason: 'public_origin_required' } }))
    action('read').click(); await tick()
    expect(document.querySelector<HTMLElement>('[data-ops-nodes-single]')!.hidden).toBe(false)
    expect(document.querySelector('[data-ops-nodes-fact="channel"]')!.textContent).toBe('Unavailable')
    expect(status().textContent).toContain('xWHM address')
    expect(action('invite').disabled).toBe(true)
  })
  it('creates a link code, shows it once and links with a pasted one', async () => {
    const calls: unknown[][] = []
    boot(async (method, path, body) => {
      calls.push([method, path, body])
      if (path === '/api/server/nodes/invitations') return { code: 'xpn1.code', expiresAt: '2026-11-07T10:30:00.000Z' }
      return path === '/api/server/nodes/link' ? linked() : view()
    })
    action('read').click(); await tick()
    action('invite').click(); await tick()
    expect(input('invite-code').value).toBe('xpn1.code')
    expect(input('invite-note').textContent).toContain('2026-11-07 10:30 UTC')
    input('code').value = 'xpn1.other'; input('label').value = 'Second'; input('role').value = 'mail'
    document.querySelector<HTMLButtonElement>('[data-ops-nodes-add]')!.click(); await tick()
    expect(calls).toContainEqual(['POST', '/api/server/nodes/link', { code: 'xpn1.other', label: 'Second', role: 'mail' }])
    expect(input('code').value).toBe('')
    expect(status().textContent).toContain('linked')
    expect(document.querySelector('[data-ops-nodes-rows]')!.textContent).toContain('whm.node2.example.com:2087')
  })
  it('asks for a link code and a label before any request', async () => {
    const send = vi.fn(async () => view())
    boot(send); action('read').click(); await tick(); send.mockClear()
    document.querySelector<HTMLButtonElement>('[data-ops-nodes-add]')!.click(); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(status().textContent).toContain('link code')
  })
  it('reports a stable refusal from the link route', async () => {
    boot(async (_method, path) => { if (path === '/api/server/nodes/link') throw { status: 412, details: { reason: 'version_mismatch' } }; return view() })
    action('read').click(); await tick()
    input('code').value = 'xpn1.x'; input('label').value = 'Second'
    document.querySelector<HTMLButtonElement>('[data-ops-nodes-add]')!.click(); await tick()
    expect(status().dataset.state).toBe('failed')
    expect(status().textContent).toBe('Both servers must run the same major xPanel version.')
  })
  it('offers to trust a renewed certificate only after showing it, and only with a confirmation', async () => {
    const calls: unknown[][] = [], ask = vi.fn(async () => true)
    boot(async (method, path, body) => {
      calls.push([method, path, body])
      if (path === '/api/server/nodes/verify') return { id: node.id, enrollment: 'unreachable', reason: 'fingerprint_mismatch', observedFingerprint: 'e'.repeat(64) }
      return linked()
    }, true, ask)
    action('read').click(); await tick()
    expect(rowAction('repin').hidden).toBe(true)
    rowAction('verify').click(); await tick()
    expect(status().textContent).toContain('e'.repeat(64))
    expect(rowAction('repin').hidden).toBe(false)
    rowAction('repin').click(); await tick()
    expect(ask).toHaveBeenCalled()
    expect(calls).toContainEqual(['PATCH', '/api/server/nodes/' + node.id, { expectedSavedRevision: rev('1'), fingerprint: 'e'.repeat(64) }])
    expect(status().textContent).toBe('The new certificate is pinned.')
  })
  it('unlinks on both sides, and offers this side only when the node cannot be reached', async () => {
    const calls: unknown[][] = []
    let refused = true
    boot(async (method, path, body) => {
      calls.push([method, path, body])
      if (path === '/api/server/nodes/verify') return { id: node.id, enrollment: 'unreachable', reason: 'node_unreachable', observedFingerprint: null }
      if (method === 'DELETE') { if (refused) { refused = false; throw { status: 412, details: { reason: 'node_unreachable' } } } return { ...view(), peerNotified: false } }
      return linked()
    }, true, async () => true)
    action('read').click(); await tick()
    expect(rowAction('force').hidden).toBe(true)
    rowAction('remove').click(); await tick()
    expect(status().textContent).toBe('The node could not be reached.')
    expect(rowAction('force').hidden).toBe(false)
    rowAction('force').click(); await tick()
    expect(calls).toContainEqual(['DELETE', '/api/server/nodes/' + node.id, { expectedSavedRevision: rev('1'), force: true }])
    expect(status().textContent).toBe('The server was unlinked.')
  })
  it('keeps the page read-only for a reader', async () => {
    boot(async () => linked(), false)
    action('read').click(); await tick()
    expect(document.querySelector<HTMLElement>('[data-ops-nodes-editor]')!.hidden).toBe(true)
    expect(rowAction('verify').hidden).toBe(true)
  })
})

describe('configuration cluster client', () => {
  const cluster = (overrides: Record<string, unknown> = {}) => ({ revision: rev('2'), sections: ['tweak-settings', 'update-preferences'], members: [node.id], nodes: [{ id: node.id, label: 'Node 2', hostname: node.hostname }],
    versions: [{ number: 3, createdAt: '2026-11-07T10:00:00.000Z', actor: 'root', note: '', digest: rev('3'), sections: ['tweak-settings'], pushes: { [node.id]: { state: 'applied', at: '2026-11-07T10:01:00.000Z', reason: null } } }], ...overrides })
  const q = <T extends HTMLElement>(hook: string) => document.querySelector<T>('[data-node-cluster-' + hook + ']')!
  const status = () => q('status')
  const row = (name: string) => q('versions').querySelector<HTMLButtonElement>('[data-xp-action="' + name + '"]')!
  it('validates the contract', () => {
    expect(readClusterView(cluster()).versions).toHaveLength(1)
    expect(() => readClusterView(cluster({ versions: [{ number: 'x' }] }))).toThrow()
    expect(() => readClusterView({})).toThrow()
  })
  it('shows members, sections and each member result of a version', async () => {
    boot(async () => cluster())
    q('read').click(); await tick()
    expect(q('members').textContent).toContain('Node 2 (whm.node2.example.com)')
    expect(q<HTMLInputElement>('members').querySelector<HTMLInputElement>('input')!.checked).toBe(true)
    expect(q('sections').textContent).toContain('Tweak Settings')
    expect(q('versions').textContent).toContain('2026-11-07 10:00 UTC')
    expect(q('versions').textContent).toContain('Node 2: Applied')
  })
  it('saves members, creates a version and pushes it with a confirmation', async () => {
    const calls: unknown[][] = [], ask = vi.fn(async () => true)
    boot(async (method, path, body) => { calls.push([method, path, body]); return cluster() }, true, ask)
    q('read').click(); await tick()
    q('save').click(); await tick()
    expect(calls).toContainEqual(['PUT', '/api/server/cluster/members', { members: [node.id], expectedRevision: rev('2') }])
    q('create').click(); await tick()
    expect(status().textContent).toContain('at least one')
    q('sections').querySelector<HTMLInputElement>('input')!.checked = true
    q<HTMLInputElement>('note').value = 'first'
    q('create').click(); await tick()
    expect(calls).toContainEqual(['POST', '/api/server/cluster/versions', { sections: ['tweak-settings'], note: 'first' }])
    row('push').click(); await tick()
    expect(ask).toHaveBeenCalled()
    expect(calls).toContainEqual(['POST', '/api/server/cluster/versions/3/push', { members: [node.id] }])
    expect(status().textContent).toContain('finished')
  })
  it('names why a rollback was refused and sends the overwrite choice', async () => {
    const calls: unknown[][] = []
    boot(async (method, path, body) => {
      calls.push([method, path, body])
      if (path.endsWith('/rollback')) { if ((body as { overwrite: boolean }).overwrite) return cluster(); throw { status: 409, details: { reason: 'local_changes' } } }
      return cluster()
    })
    q('read').click(); await tick()
    row('rollback').click(); await tick()
    expect(status().dataset.state).toBe('conflict')
    expect(status().textContent).toContain('changed the file after the push')
    q<HTMLInputElement>('overwrite').checked = true
    row('rollback').click(); await tick()
    expect(calls.at(-1)).toEqual(['POST', '/api/server/cluster/versions/3/rollback', { member: node.id, overwrite: true }])
    expect(status().dataset.state).toBe('saved')
  })
  it('stays closed without an authorized reader', () => {
    document.body.innerHTML = renderOpsNodesWorkspace({ locale: 'en', canRead: false, canManage: false })
    new Function('return ' + NODE_CLUSTER_CLIENT_BINDING)()()
    expect(q<HTMLButtonElement>('read').disabled).toBe(true)
    expect(status().dataset.state).toBe('unavailable')
  })
})
