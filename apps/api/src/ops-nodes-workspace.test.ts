import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:tls'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { policyForRequest } from './authorization.ts'
import { entryPointAllowsApiRoute } from './entry-points.ts'
import { colonFingerprint, createNodeLink, encodeLinkCode, liveInvitations, nodeOrigin, observeTlsFingerprint, parseLinkCode, parseNodeConfig, readNodeToken, savedNodeConfigRevision } from './node-link.ts'
import type { ManagedNode } from './node-link.ts'
import { addFakeServer, createFakeNetwork, linkServers } from './node-peers-test-fixture.ts'
import type { FakeNetwork, FakeServer } from './node-peers-test-fixture.ts'

// Feature layer: two real API sides over a modelled TLS pin. Nothing here reaches a socket except the certificate read below.
const node = (overrides: Partial<ManagedNode> = {}): ManagedNode => ({ id: 'node_' + 'a'.repeat(16), label: 'Node 2', hostname: 'node2.example.com', port: 2087, fingerprint: 'b'.repeat(64), role: 'all', version: '1.4.0', linkedAt: '2026-11-07T10:00:00.000Z', inboundTokenId: '11111111-1111-4111-8111-111111111111', ...overrides })
let network: FakeNetwork, a: FakeServer, b: FakeServer
beforeEach(async () => { network = createFakeNetwork(); a = await addFakeServer(network, 'alpha'); b = await addFakeServer(network, 'beta') })
afterEach(() => network.close())
const list = async (server: FakeServer) => await (await server.root('GET', '/api/server/nodes')).json() as { config: { nodes: Record<string, unknown>[] }; savedRevision: string; singleNode: boolean; channel: Record<string, unknown>; invitations: { active: number } }
const detail = async (response: Response) => await response.json() as { code: string; details: { reason?: string } }

describe('linked server nodes', () => {
  it('routes root work to xWHM and peer calls to the narrow scope', () => {
    for (const path of ['/api/server/nodes', '/api/server/nodes/verify', '/api/server/nodes/link', '/api/server/nodes/invitations']) {
      expect(policyForRequest(path, 'POST')).toMatchObject({ resource: 'server', rootOnly: true })
      expect(entryPointAllowsApiRoute('xwhm', path, 'POST')).toBe(true)
      expect(entryPointAllowsApiRoute('xpanel', path, 'POST')).toBe(false)
    }
    for (const path of ['/api/server/nodes/peer/identity', '/api/server/nodes/peer/join', '/api/server/nodes/peer/config/apply', '/api/server/nodes/peer/live/alice/freeze']) {
      expect(policyForRequest(path, 'POST')).toMatchObject({ resource: 'nodes', rootOnly: true })
      expect(entryPointAllowsApiRoute('xwhm', path, 'POST')).toBe(true)
      expect(entryPointAllowsApiRoute('xmail', path, 'POST')).toBe(false)
    }
  })
  it('validates the saved links strictly and encodes one link code form', () => {
    expect(parseNodeConfig({ nodes: [node()] }).nodes).toHaveLength(1)
    for (const change of [{ hostname: 'nodots' }, { fingerprint: 'zz' }, { port: 0 }, { role: 'x' }, { version: 'x' }, { inboundTokenId: 'x' }]) expect(() => parseNodeConfig({ nodes: [node(change as never)] })).toThrow()
    expect(() => parseNodeConfig({ nodes: [{ ...node(), extra: 1 }] })).toThrow()
    expect(() => parseNodeConfig({ nodes: [node(), node()] })).toThrow()
    const input = { hostname: 'whm.beta.example.com', port: 2087, fingerprint: 'c'.repeat(64), token: 'xp_' + 'a'.repeat(43) }
    expect(parseLinkCode(encodeLinkCode(input))).toEqual(input)
    for (const bad of ['', 'xpn1.', 'xpn1.e30', 'other.' + encodeLinkCode(input), 7]) expect(() => parseLinkCode(bad)).toThrow(/link code/)
    expect(colonFingerprint('ab'.repeat(32))).toBe(Array.from({ length: 32 }, () => 'AB').join(':'))
    expect(liveInvitations([{ tokenId: 'x', expiresAt: '2026-11-07T10:00:00.000Z' }], new Date('2026-11-07T10:00:00.000Z'))).toEqual([])
  })
  it('shows an honest single server, and refuses a code where no peer can reach this server', async () => {
    expect(await list(a)).toMatchObject({ singleNode: true, channel: { verification: 'available', reason: null }, config: { nodes: [] } })
    const link = createNodeLink({ store: a.store, db: null as never, serverSecret: 'x'.repeat(32), publicOrigin: null, version: async () => '1.0.0' })
    await expect(link.identity()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'public_origin_required' } })
    const broken = createNodeLink({ store: a.store, db: null as never, serverSecret: 'x'.repeat(32), publicOrigin: 'https://whm.alpha.example.com:2087', version: async () => '1.0.0', observeTls: async () => { throw new Error('refused') } })
    await expect(broken.identity()).rejects.toMatchObject({ detail: { reason: 'management_tls_unavailable' } })
  })
  it('links two servers with mutual proof and shows no credential', async () => {
    expect((await linkServers(a, b, { label: 'Beta', role: 'mail' })).status).toBe(201)
    const onA = (await list(a)).config.nodes, onB = (await list(b)).config.nodes
    expect(onA).toMatchObject([{ id: b.link.selfId, label: 'Beta', role: 'mail', hostname: b.hostname, port: 2087, fingerprint: b.fingerprint, version: '1.4.0' }])
    expect(onB).toMatchObject([{ id: a.link.selfId, label: a.hostname, role: 'all', hostname: a.hostname, fingerprint: a.fingerprint }])
    expect(JSON.stringify([onA, onB])).not.toMatch(/xp_|inboundTokenId/)
    // each side dialled the other on the pin of its certificate, with a credential the other issued
    const hosts = network.requests.map(request => new URL(request.url).hostname + ' ' + new URL(request.url).pathname)
    expect(hosts).toEqual(expect.arrayContaining([b.hostname + ' /api/server/nodes/peer/join', a.hostname + ' /api/server/nodes/peer/identity', b.hostname + ' /api/server/nodes/peer/identity']))
    expect(network.requests.every(request => request.tlsFingerprint === colonFingerprint(network.servers.get(new URL(request.url).hostname)!.fingerprint))).toBe(true)
    // tokens stay in one root-only file on each side and never reach the saved links or an audit record
    const secrets = join(a.store.rootDir, 'extended', 'server', 'node-credentials.json')
    if (process.platform !== 'win32') expect((await stat(secrets)).mode & 0o777).toBe(0o600)
    const token = (await readNodeToken(a.store, b.link.selfId))!
    expect(token).toMatch(/^xp_/)
    expect(await readFile(join(a.store.rootDir, 'extended', 'server', 'managed-nodes.json'), 'utf8')).not.toContain(token)
    expect(JSON.stringify([a.audits, b.audits])).not.toContain('xp_')
    expect(a.audits.map(entry => entry.action)).toContain('server.nodes.linked')
    expect(b.audits.map(entry => entry.action)).toEqual(expect.arrayContaining(['server.nodes.invited', 'server.nodes.joined']))
    expect((await list(b)).invitations.active).toBe(0)
  })
  it('spends a link code once and refuses a second link to the same hostname', async () => {
    const code = (await (await b.root('POST', '/api/server/nodes/invitations', {})).json() as { code: string }).code
    expect((await a.root('POST', '/api/server/nodes/link', { code, label: 'Beta', role: 'all' })).status).toBe(201)
    const again = await a.root('POST', '/api/server/nodes/link', { code, label: 'Beta', role: 'all' })
    expect(again.status).toBe(409)
    expect((await detail(again)).details.reason).toBe('node_already_linked')
    const third = await addFakeServer(network, 'gamma')
    const stolen = await third.root('POST', '/api/server/nodes/link', { code, label: 'Beta', role: 'all' })
    expect(stolen.status).toBe(412)
    expect((await detail(stolen)).details.reason).toBe('auth_refused')
    expect((await list(third)).config.nodes).toEqual([])
  })
  it('refuses a different major version on both sides and leaves nothing behind', async () => {
    const old = await addFakeServer(network, 'old', { version: '2.0.0' })
    const refused = await linkServers(a, old)
    expect(refused.status).toBe(412)
    expect((await detail(refused)).details.reason).toBe('version_mismatch')
    expect((await list(a)).config.nodes).toEqual([])
    expect((await list(old)).config.nodes).toEqual([])
    expect(a.audits.map(entry => entry.action)).toContain('server.nodes.link_failed')
  })
  it('sends nothing to a server that does not present the pinned certificate', async () => {
    const code = (await (await b.root('POST', '/api/server/nodes/invitations', {})).json() as { code: string }).code
    b.fingerprint = 'd'.repeat(64)
    const refused = await a.root('POST', '/api/server/nodes/link', { code, label: 'Beta', role: 'all' })
    expect((await detail(refused)).details.reason).toBe('fingerprint_mismatch')
    expect((await list(b)).config.nodes).toEqual([])
  })
  it('refuses a link to itself', async () => {
    const code = (await (await a.root('POST', '/api/server/nodes/invitations', {})).json() as { code: string }).code
    expect((await detail(await a.root('POST', '/api/server/nodes/link', { code, label: 'Self', role: 'all' }))).details.reason).toBe('self_link')
  })
  it('accepts link work from an interactive root session only', async () => {
    await linkServers(a, b)
    const token = (await readNodeToken(a.store, b.link.selfId))!
    const call = (path: string) => b.serve(new Request('https://' + b.hostname + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: '{}' }))
    // a link token reaches the peer routes and nothing of root's own node page
    expect((await call('/api/server/nodes/invitations')).status).toBe(403)
    expect((await call('/api/server/nodes/link')).status).toBe(403)
    expect((await detail(await call('/api/server/nodes/peer/join'))).details.reason).toBe('invitation_required')
    // a root session is not a peer
    expect((await detail(await b.root('POST', '/api/server/nodes/peer/pin', { fingerprint: 'e'.repeat(64) }))).details.reason).toBe('node_not_linked')
  })
  it('verifies a link, reports a renewed certificate, and re-pins only what answers as the node', async () => {
    await linkServers(a, b)
    const verify = async () => await (await a.root('POST', '/api/server/nodes/verify', { id: b.link.selfId })).json() as Record<string, unknown>
    expect(await verify()).toMatchObject({ enrollment: 'verified', reason: null })
    b.fingerprint = 'e'.repeat(64)
    expect(await verify()).toMatchObject({ enrollment: 'unreachable', reason: 'fingerprint_mismatch', observedFingerprint: 'e'.repeat(64) })
    const saved = (await list(a)).savedRevision
    const wrong = await a.root('PATCH', '/api/server/nodes/' + b.link.selfId, { expectedSavedRevision: saved, fingerprint: 'f'.repeat(64) })
    expect((await detail(wrong)).details.reason).toBe('fingerprint_mismatch')
    expect((await a.root('PATCH', '/api/server/nodes/' + b.link.selfId, { expectedSavedRevision: saved, fingerprint: 'e'.repeat(64) })).status).toBe(200)
    expect(await verify()).toMatchObject({ enrollment: 'verified' })
    expect(a.audits.map(entry => entry.action)).toContain('server.nodes.repinned')
    b.reachable = false
    expect(await verify()).toMatchObject({ enrollment: 'unreachable', reason: 'node_unreachable', observedFingerprint: null })
  })
  it('announces a renewed certificate over the channel that still holds', async () => {
    await linkServers(a, b)
    await b.link.announcePin()
    b.fingerprint = 'e'.repeat(64)
    await b.link.announcePin()
    expect((await list(a)).config.nodes).toMatchObject([{ fingerprint: 'e'.repeat(64) }])
    expect((await a.link.call(await a.link.node(b.link.selfId), '/api/server/nodes/peer/identity')).fingerprint).toBe('e'.repeat(64))
    const repeated = network.requests.length
    await b.link.announcePin()
    expect(network.requests.length).toBe(repeated)
  })
  it('renames a link under the saved revision', async () => {
    await linkServers(a, b)
    const saved = (await list(a)).savedRevision
    expect((await a.root('PATCH', '/api/server/nodes/' + b.link.selfId, { expectedSavedRevision: saved, label: 'Renamed', role: 'db' })).status).toBe(200)
    expect((await list(a)).config.nodes).toMatchObject([{ label: 'Renamed', role: 'db' }])
    expect((await a.root('PATCH', '/api/server/nodes/' + b.link.selfId, { expectedSavedRevision: saved, label: 'Late' })).status).toBe(409)
    expect((await a.root('PATCH', '/api/server/nodes/' + b.link.selfId, { expectedSavedRevision: 'f'.repeat(64), secret: 'x' })).status).toBe(400)
  })
  it('unlinks on both sides, or on this side alone when forced', async () => {
    await linkServers(a, b)
    const inbound = (await a.link.nodes())[0]!.inboundTokenId, token = (await readNodeToken(b.store, a.link.selfId))!
    b.reachable = false
    const saved = (await list(a)).savedRevision
    const refused = await a.root('DELETE', '/api/server/nodes/' + b.link.selfId, { expectedSavedRevision: saved })
    expect((await detail(refused)).details.reason).toBe('node_unreachable')
    expect((await list(a)).config.nodes).toHaveLength(1)
    b.reachable = true
    expect(await (await a.root('DELETE', '/api/server/nodes/' + b.link.selfId, { expectedSavedRevision: saved })).json()).toMatchObject({ peerNotified: true, singleNode: true })
    expect(await list(b)).toMatchObject({ singleNode: true })
    expect(await readNodeToken(a.store, b.link.selfId)).toBeNull()
    expect(inbound).toMatch(/-/)
    // the token this server issued no longer opens it
    expect((await b.serve(new Request('https://' + b.hostname + '/api/server/nodes/peer/identity', { headers: { authorization: 'Bearer ' + token } }))).status).toBe(401)
    expect((await linkServers(a, b)).status).toBe(201)
    b.reachable = false
    expect(await (await a.root('DELETE', '/api/server/nodes/' + b.link.selfId, { expectedSavedRevision: (await list(a)).savedRevision, force: true })).json()).toMatchObject({ peerNotified: false })
  })
  it('keeps a damaged saved file visible instead of treating it as empty for writes', async () => {
    await linkServers(a, b)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(a.store.rootDir, 'extended', 'server', 'managed-nodes.json'), '{"nodes":[{"id":"x"}]}')
    expect(await list(a)).toMatchObject({ config: { nodes: [] } })
    expect((await a.root('GET', '/api/server/nodes')).status).toBe(200)
    expect((await linkServers(a, await addFakeServer(network, 'gamma'))).status).toBe(412)
  })
  it('reads the certificate a peer presents without sending anything', async () => {
    const { spawnSync } = await import('node:child_process'), { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os')
    const dir = await mkdtemp(join(tmpdir(), 'xp-node-cert-')), key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem')
    const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=node.test', '-days', '1'], { encoding: 'utf8' })
    if (made.status !== 0) return expect.fail('openssl is required for this check: ' + made.stderr.slice(0, 200))
    const pem = await readFile(cert, 'utf8')
    let received = 0
    const server = createServer({ key: await readFile(key, 'utf8'), cert: pem }, socket => { socket.on('data', () => { received++ }); socket.on('error', () => undefined) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const seen = await observeTlsFingerprint('127.0.0.1', (server.address() as AddressInfo).port)
    server.close()
    await rm(dir, { recursive: true, force: true })
    const { X509Certificate } = await import('node:crypto')
    expect(colonFingerprint(seen)).toBe(new X509Certificate(pem).fingerprint256)
    expect(received).toBe(0)
    expect(nodeOrigin({ hostname: 'a.example.com', port: 2087 })).toBe('https://a.example.com:2087')
    expect(savedNodeConfigRevision(null)).toMatch(/^[0-9a-f]{64}$/)
  })
})
