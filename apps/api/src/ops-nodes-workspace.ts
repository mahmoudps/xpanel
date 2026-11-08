import { randomBytes } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import type { Db } from '@xpanel/db'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertSameMajor, encodeLinkCode, isNodeFingerprint, isNodeId, isNodeLabel, isNodeRole, isNodeToken, liveInvitations, MAX_NODES, mintNodeToken, NODE_IDENTITY_PATH, NODE_INVITATION_SCOPES, NODE_INVITATION_TTL_MS, NODE_JOIN_PATH, NODE_LINK_SCOPES, NODE_LINK_TOKEN_MS, NODE_MAX_INVITATIONS, NODE_PIN_PATH, NODE_UNLINK_PATH, parseLinkCode, parseNodeIdentity, savedNodeConfigRevision } from './node-link.ts'
import type { ManagedNode, NodeEnrollment, NodeIdentity, NodeLink, NodeRole } from './node-link.ts'

export interface NodesWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  db: Db
  link: NodeLink
  /** This server's configured hostname, or null when it has not been set. */
  readHostname: () => Promise<string | null>
  /** Same admission as the API tokens page: the original interactive root session, re-checked on the writer. */
  authorizeIssuance: (tx: Db, caller: AuthenticatedCaller) => Promise<void>
}

const ROUTE = '/api/server/nodes', VERIFY = ROUTE + '/verify', INVITE = ROUTE + '/invitations', LINK = ROUTE + '/link'
const ITEM = /^\/api\/server\/nodes\/(node_[0-9a-f]{16})$/
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const notAllowed = (allow: string): Response => new Response(null, { status: 405, headers: { allow } })
/** The saved link without the id of the token it was issued: enough to manage it, nothing to reuse. */
const publicNode = ({ inboundTokenId: _token, ...node }: ManagedNode) => node
const reasonOf = (error: unknown): string => isXpanelError(error) && typeof error.detail.reason === 'string' ? error.detail.reason : 'node_unreachable'
const tokenName = (kind: 'invite' | 'link'): string => 'node-' + kind + '-' + randomBytes(4).toString('hex')

async function readJson(request: Request, max: number): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > max) return fail('VALIDATION', 'the request body is too large', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'request body is not valid JSON', unchanged) }
  return object(body) ? body : fail('VALIDATION', 'request body must be an object', unchanged)
}
const assertKeys = (body: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void => {
  if (required.some(key => !Object.hasOwn(body, key)) || Object.keys(body).some(key => !required.includes(key) && !optional.includes(key))) fail('VALIDATION', 'unsupported node fields', unchanged)
}
const removeLink = async (link: NodeLink, node: ManagedNode): Promise<void> => {
  await link.update(state => {
    state.config.nodes = state.config.nodes.filter(entry => entry.id !== node.id)
    delete state.secrets.tokens[node.id]
  })
  await link.revoke(node.inboundTokenId)
}

/** The server nodes page and the peer routes of the link protocol. Only the two protocol handovers ever carry a token. */
export async function handleNodesWorkspaceRoute(request: Request, url: URL, method: string, helpers: NodesWorkspaceHelpers): Promise<Response | null> {
  const { pathname } = url
  if ([NODE_IDENTITY_PATH, NODE_JOIN_PATH, NODE_PIN_PATH, NODE_UNLINK_PATH].includes(pathname)) return peerRoute(request, url, method, helpers)
  const item = ITEM.exec(pathname)
  if (![ROUTE, VERIFY, INVITE, LINK].includes(pathname) && !item) return null
  const { link } = helpers
  const action = pathname === VERIFY ? 'server.nodes.verify' : pathname === INVITE ? 'server.nodes.invite' : pathname === LINK ? 'server.nodes.link' : item ? 'server.nodes.update' : 'server.nodes.read'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (url.search) return fail('VALIDATION', 'node routes accept no selectors', unchanged)
  const audit = (actor: AuthenticatedCaller, name: string, target: string, detail: Record<string, unknown>, outcome: 'ok' | 'failed' = 'ok') => helpers.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action: name, target, detail, outcome })
  const fresh = async (): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, action)
    if (current.principal.id !== caller.principal.id || current.sessionId !== caller.sessionId || current.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'node authority changed', unchanged)
    return current
  }
  const interactive = (): void => { if (caller.sessionId === null || caller.apiTokenId !== null) fail('FORBIDDEN', 'linking requires an interactive root session', unchanged) }
  const expected = async (body: Record<string, unknown>): Promise<void> => {
    if (typeof body.expectedSavedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedSavedRevision)) fail('VALIDATION', 'the observed saved revision is required', unchanged)
    if (savedNodeConfigRevision((await link.readSaved()).raw) !== body.expectedSavedRevision) fail('CONFLICT', 'the node links changed since they were read; reload before saving', unchanged)
  }
  const view = async () => {
    const { raw, config } = await link.readSaved()
    const nodes = config?.nodes ?? [], { available, reason } = link.availability()
    const invitations = liveInvitations((await link.readSecrets()).invitations, link.now())
    return { config: { nodes: nodes.map(publicNode) }, savedRevision: savedNodeConfigRevision(raw), invalid: config === null, thisServer: { hostname: await helpers.readHostname(), id: link.selfId },
      singleNode: nodes.length === 0, channel: { verification: available ? 'available' : 'unavailable', reason }, invitations: { active: invitations.length, expiresAt: invitations.map(entry => entry.expiresAt).sort().at(-1) ?? null } }
  }

  if (pathname === ROUTE) {
    if (method !== 'GET') return notAllowed('GET')
    const result = await view()
    await fresh()
    return json(200, result)
  }
  if (pathname === INVITE) {
    if (method !== 'POST') return notAllowed('POST')
    interactive()
    assertKeys(await readJson(request, 64), [])
    const own = await link.identity(), actor = await fresh(), expiresAt = new Date(link.now().getTime() + NODE_INVITATION_TTL_MS).toISOString()
    if (liveInvitations((await link.readSecrets()).invitations, link.now()).length >= NODE_MAX_INVITATIONS) return fail('CONFLICT', 'too many link codes are waiting; let one expire first', { ...unchanged, reason: 'too_many_invitations' })
    const minted = await mintNodeToken(helpers.db, { principalId: actor.principal.id, name: tokenName('invite'), scopes: NODE_INVITATION_SCOPES, expiresAt }, tx => helpers.authorizeIssuance(tx, actor))
    await link.update(state => { state.secrets.invitations = [...liveInvitations(state.secrets.invitations, link.now()), { tokenId: minted.id, expiresAt }] })
    await audit(actor, 'server.nodes.invited', 'node-invitation:' + minted.id, { expiresAt })
    return json(201, { code: encodeLinkCode({ hostname: own.hostname, port: own.port, fingerprint: own.fingerprint, token: minted.secret }), expiresAt })
  }
  if (pathname === LINK) {
    if (method !== 'POST') return notAllowed('POST')
    interactive()
    const body = await readJson(request, 1024)
    assertKeys(body, ['code', 'label', 'role'])
    const invite = parseLinkCode(body.code)
    if (!isNodeLabel(body.label) || !isNodeRole(body.role)) return fail('VALIDATION', 'a label and a role are required', unchanged)
    const label = body.label, role = body.role, own = await link.identity(), saved = await link.nodes()
    if (invite.hostname === own.hostname) return fail('CONFLICT', 'a server cannot link to itself', { ...unchanged, reason: 'self_link' })
    if (saved.some(node => node.hostname === invite.hostname)) return fail('CONFLICT', 'this hostname is already linked', { ...unchanged, reason: 'node_already_linked' })
    if (saved.length >= MAX_NODES) return fail('LIMIT_EXCEEDED', 'at most ' + MAX_NODES + ' nodes can be linked', unchanged)
    const actor = await fresh()
    const issued = await mintNodeToken(helpers.db, { principalId: actor.principal.id, name: tokenName('link'), scopes: NODE_LINK_SCOPES, expiresAt: new Date(link.now().getTime() + NODE_LINK_TOKEN_MS).toISOString() }, tx => helpers.authorizeIssuance(tx, actor))
    let joined: { node: NodeIdentity; token: string } | null = null
    try {
      const reply = await link.call(invite, NODE_JOIN_PATH, { method: 'POST', token: invite.token, body: { node: own, token: issued.secret } })
      if (!isNodeToken(reply.token)) return fail('PRECONDITION_FAILED', 'the node did not return its credential', { ...unchanged, reason: 'identity_mismatch' })
      joined = { node: parseNodeIdentity(reply.node), token: reply.token }
      // the certificate pinned from the code answers with the identity the node claimed, under the credential it issued
      const seen = parseNodeIdentity(await link.call(invite, NODE_IDENTITY_PATH, { token: joined.token }))
      if (seen.id !== joined.node.id || seen.id === own.id || joined.node.hostname !== invite.hostname) return fail('PRECONDITION_FAILED', 'the node identity did not match', { ...unchanged, reason: 'identity_mismatch' })
      assertSameMajor(own.version, joined.node.version)
      const { node: peer, token } = joined
      const added: ManagedNode = { id: peer.id, label, hostname: invite.hostname, port: invite.port, fingerprint: invite.fingerprint, role, version: peer.version, linkedAt: link.now().toISOString(), inboundTokenId: issued.id }
      await link.update(state => {
        if (state.config.nodes.some(node => node.id === added.id || node.hostname === added.hostname)) return fail('CONFLICT', 'this hostname is already linked', { ...unchanged, reason: 'node_already_linked' })
        state.config.nodes.push(added)
        state.secrets.tokens[added.id] = token
      })
      await audit(actor, 'server.nodes.linked', 'node:' + added.hostname, { id: added.id, role, port: added.port, version: added.version })
      return json(201, await view())
    } catch (error) {
      await link.revoke(issued.id).catch(() => undefined)
      if (joined) await link.call(invite, NODE_UNLINK_PATH, { method: 'POST', token: joined.token, body: {} }).catch(() => undefined)
      await audit(actor, 'server.nodes.link_failed', 'node:' + invite.hostname, { reason: reasonOf(error) }, 'failed').catch(() => undefined)
      throw error
    }
  }
  if (pathname === VERIFY) {
    if (method !== 'POST') return notAllowed('POST')
    const body = await readJson(request, 1024)
    assertKeys(body, ['id'])
    if (!isNodeId(body.id)) return fail('VALIDATION', 'a node id is required', unchanged)
    const node = await link.node(body.id), actor = await fresh()
    let enrollment: NodeEnrollment = 'verified', reason: string | null = null, observedFingerprint: string | null = null
    try {
      const seen = parseNodeIdentity(await link.call(node, NODE_IDENTITY_PATH))
      if (seen.id !== node.id) { enrollment = 'unreachable'; reason = 'identity_mismatch' }
    } catch (error) {
      enrollment = 'unreachable'
      reason = reasonOf(error)
      if (reason === 'fingerprint_mismatch') observedFingerprint = await link.observe(node.hostname, node.port).catch(() => null)
    }
    await audit(actor, 'server.nodes.verified', 'node:' + node.hostname, { enrollment, reason }, enrollment === 'verified' ? 'ok' : 'failed')
    if (enrollment === 'verified') await link.announcePin().catch(() => undefined)
    return json(200, { id: node.id, enrollment, reason, observedFingerprint })
  }
  const id = item![1]!
  if (method === 'PATCH') {
    const body = await readJson(request, 1024)
    assertKeys(body, ['expectedSavedRevision'], ['label', 'role', 'fingerprint'])
    if (body.label !== undefined && !isNodeLabel(body.label) || body.role !== undefined && !isNodeRole(body.role) || body.fingerprint !== undefined && !isNodeFingerprint(body.fingerprint)) return fail('VALIDATION', 'a valid label, role or SHA-256 fingerprint is required', unchanged)
    await expected(body)
    const node = await link.node(id), actor = await fresh()
    // a new pin is trusted only once the node answers on it with its own identity, under the credential it issued
    if (body.fingerprint !== undefined) {
      const seen = parseNodeIdentity(await link.call({ ...node, fingerprint: body.fingerprint as string }, NODE_IDENTITY_PATH))
      if (seen.id !== node.id) return fail('PRECONDITION_FAILED', 'the node identity did not match', { ...unchanged, reason: 'identity_mismatch' })
    }
    await link.update(state => {
      const entry = state.config.nodes.find(candidate => candidate.id === id) ?? fail('NOT_FOUND', 'the node is not linked', unchanged)
      if (body.label !== undefined) entry.label = body.label as string
      if (body.role !== undefined) entry.role = body.role as NodeRole
      if (body.fingerprint !== undefined) entry.fingerprint = body.fingerprint as string
    })
    await audit(actor, body.fingerprint === undefined ? 'server.nodes.updated' : 'server.nodes.repinned', 'node:' + node.hostname, { id })
    return json(200, await view())
  }
  if (method === 'DELETE') {
    const body = await readJson(request, 1024)
    assertKeys(body, ['expectedSavedRevision'], ['force'])
    if (body.force !== undefined && body.force !== true) return fail('VALIDATION', 'force must be true when present', unchanged)
    await expected(body)
    const node = await link.node(id), actor = await fresh()
    let peerNotified = true
    try { await link.call(node, NODE_UNLINK_PATH, { method: 'POST', body: {} }) } catch (error) {
      if (body.force !== true) throw error
      peerNotified = false
    }
    await removeLink(link, node)
    await audit(actor, 'server.nodes.unlinked', 'node:' + node.hostname, { id, peerNotified, forced: body.force === true })
    return json(200, { ...await view(), peerNotified })
  }
  return notAllowed('PATCH, DELETE')
}

async function peerRoute(request: Request, url: URL, method: string, helpers: NodesWorkspaceHelpers): Promise<Response> {
  const { link } = helpers, { pathname } = url
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'server.nodes.peer')
  if (url.search) return fail('VALIDATION', 'node routes accept no selectors', unchanged)
  if (caller.apiTokenId === null) return fail('FORBIDDEN', 'peer routes accept a node credential only', { ...unchanged, reason: 'node_not_linked' })
  const audit = (name: string, target: string, detail: Record<string, unknown>) => helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: name, target, detail, outcome: 'ok' })
  if (pathname === NODE_IDENTITY_PATH) {
    if (method !== 'GET') return notAllowed('GET')
    return json(200, await link.identity())
  }
  if (method !== 'POST') return notAllowed('POST')
  const body = await readJson(request, 4096)
  if (pathname === NODE_JOIN_PATH) {
    const invitation = liveInvitations((await link.readSecrets()).invitations, link.now()).find(entry => entry.tokenId === caller.apiTokenId)
    if (!invitation) return fail('FORBIDDEN', 'this link code is not valid here', { ...unchanged, reason: 'invitation_required' })
    assertKeys(body, ['node', 'token'])
    if (!isNodeToken(body.token)) return fail('VALIDATION', 'a node credential is required', unchanged)
    const requester = parseNodeIdentity(body.node), own = await link.identity(), token = body.token, saved = await link.nodes()
    assertSameMajor(own.version, requester.version)
    if (requester.id === own.id) return fail('CONFLICT', 'a server cannot link to itself', { ...unchanged, reason: 'self_link' })
    if (saved.some(node => node.id === requester.id || node.hostname === requester.hostname)) return fail('CONFLICT', 'this hostname is already linked', { ...unchanged, reason: 'node_already_linked' })
    if (saved.length >= MAX_NODES) return fail('LIMIT_EXCEEDED', 'at most ' + MAX_NODES + ' nodes can be linked', unchanged)
    // the requester must answer on the certificate it claims, under the credential it just handed over
    const seen = parseNodeIdentity(await link.call(requester, NODE_IDENTITY_PATH, { token }))
    if (seen.id !== requester.id || seen.hostname !== requester.hostname || seen.fingerprint !== requester.fingerprint) return fail('PRECONDITION_FAILED', 'the requesting server did not prove its identity', { ...unchanged, reason: 'identity_mismatch' })
    const issued = await mintNodeToken(helpers.db, { principalId: caller.principal.id, name: tokenName('link'), scopes: NODE_LINK_SCOPES, expiresAt: new Date(link.now().getTime() + NODE_LINK_TOKEN_MS).toISOString() })
    const added: ManagedNode = { id: requester.id, label: requester.hostname.slice(0, 64), hostname: requester.hostname, port: requester.port, fingerprint: requester.fingerprint, role: 'all', version: requester.version, linkedAt: link.now().toISOString(), inboundTokenId: issued.id }
    try {
      await link.update(state => {
        state.config.nodes.push(added)
        state.secrets.tokens[added.id] = token
        state.secrets.invitations = state.secrets.invitations.filter(entry => entry.tokenId !== invitation.tokenId)
      })
    } catch (error) { await link.revoke(issued.id).catch(() => undefined); throw error }
    await link.revoke(invitation.tokenId)
    await audit('server.nodes.joined', 'node:' + added.hostname, { id: added.id, port: added.port, version: added.version })
    return json(200, { node: own, token: issued.secret })
  }
  const peer = await link.peerOf(caller)
  if (pathname === NODE_PIN_PATH) {
    assertKeys(body, ['fingerprint'])
    if (!isNodeFingerprint(body.fingerprint)) return fail('VALIDATION', 'a SHA-256 fingerprint is required', unchanged)
    const fingerprint = body.fingerprint
    await link.update(state => { const entry = state.config.nodes.find(candidate => candidate.id === peer.id); if (entry) entry.fingerprint = fingerprint })
    await audit('server.nodes.repinned', 'node:' + peer.hostname, { id: peer.id, announced: true })
    return json(200, { repinned: true })
  }
  assertKeys(body, [])
  await removeLink(link, peer)
  await audit('server.nodes.unlinked', 'node:' + peer.hostname, { id: peer.id, byPeer: true })
  return json(200, { unlinked: true })
}
