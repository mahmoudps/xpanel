/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction, VIEW_RECORD_HELPERS } from './workspace-view-templates.ts'
import { frameRequest as canonicalFrameRequest, withFrameRequest } from './read-only-frame.ts'
const frameRequest = canonicalFrameRequest
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction

export type NodeView = { id: string; label: string; hostname: string; port: number; fingerprint: string; role: 'web' | 'dns' | 'mail' | 'db' | 'all'; version: string; linkedAt: string }
export type NodesView = {
  config: { nodes: NodeView[] }; savedRevision: string; invalid: boolean
  thisServer: { hostname: string | null; id: string }; singleNode: boolean; channel: { verification: 'available' | 'unavailable'; reason: string | null }
  invitations: { active: number; expiresAt: string | null }
}

export function readNodesView(value: unknown): NodesView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const hash = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)
  const fqdn = (item: unknown): item is string => typeof item === 'string' && item.length <= 253 && /^(?!-)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/.test(item)
  const nodeId = (item: unknown): item is string => typeof item === 'string' && /^node_[0-9a-f]{16}$/.test(item)
  const readNode = (raw: unknown): NodeView => {
    if (!object(raw) || !nodeId(raw.id) || typeof raw.label !== 'string' || raw.label.length < 1 || raw.label.length > 64 || !fqdn(raw.hostname) || typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535
      || !hash(raw.fingerprint) || !['web', 'dns', 'mail', 'db', 'all'].includes(String(raw.role)) || typeof raw.version !== 'string' || typeof raw.linkedAt !== 'string') throw new Error('invalid_node')
    return { id: raw.id, label: raw.label, hostname: raw.hostname, port: raw.port, fingerprint: raw.fingerprint, role: raw.role as NodeView['role'], version: raw.version, linkedAt: raw.linkedAt }
  }
  if (!object(value) || !object(value.config) || !Array.isArray(value.config.nodes) || value.config.nodes.length > 64 || !hash(value.savedRevision) || typeof value.invalid !== 'boolean'
    || !object(value.thisServer) || (value.thisServer.hostname !== null && !fqdn(value.thisServer.hostname)) || !nodeId(value.thisServer.id) || typeof value.singleNode !== 'boolean'
    || !object(value.channel) || !['available', 'unavailable'].includes(String(value.channel.verification)) || !object(value.invitations) || typeof value.invitations.active !== 'number') throw new Error('invalid_nodes')
  return { config: { nodes: value.config.nodes.map(readNode) }, savedRevision: value.savedRevision, invalid: value.invalid, thisServer: { hostname: value.thisServer.hostname as string | null, id: value.thisServer.id },
    singleNode: value.singleNode, channel: { verification: value.channel.verification as 'available' | 'unavailable', reason: typeof value.channel.reason === 'string' ? value.channel.reason : null },
    invitations: { active: value.invitations.active, expiresAt: typeof value.invitations.expiresAt === 'string' ? value.invitations.expiresAt : null } }
}

/** Stable refusals of the link protocol, in the operator's words. */
export function nodeRefusal(reason: unknown, t: (message: string) => string): string {
  const known: Record<string, string> = {
    node_already_linked: t('This hostname is already linked.'), version_mismatch: t('Both servers must run the same major xPanel version.'), self_link: t('A server cannot link to itself.'),
    fingerprint_mismatch: t('The node certificate did not match the pinned fingerprint; the node is not trusted.'), auth_refused: t('The node refused this server. Create a new link code there.'), invitation_required: t('The link code has expired or was already used.'),
    node_unreachable: t('The node could not be reached.'), identity_mismatch: t('The node did not prove its identity.'), management_tls_unavailable: t('The management certificate of this server could not be read, so it cannot be linked yet.'),
    public_origin_required: t('Linking works on the xWHM address of a server with management TLS.'), link_code_invalid: t('Paste the complete link code from the other server.'), too_many_invitations: t('Too many link codes are waiting. Let one expire first.'),
  }
  return known[String(reason)] ?? t('The node link could not be changed. Nothing was changed here.')
}

function bindOpsNodes(askDialog?: (options: { title: string; body: string; confirm: string; danger?: boolean }) => Promise<unknown>): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-ops-nodes-workspace]').forEach(root => {
    if (root.dataset.nodesBound === 'true') return
    root.dataset.nodesBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-ops-nodes-status]'), rows = root.querySelector<HTMLElement>('[data-ops-nodes-rows]'), editor = root.querySelector<HTMLElement>('[data-ops-nodes-editor]'), single = root.querySelector<HTMLElement>('[data-ops-nodes-single]')
    const field = (name: string): HTMLInputElement | HTMLSelectElement | null => root.querySelector('[data-ops-nodes-' + name + ']')
    const button = (key: string): HTMLButtonElement | null => root.querySelector<HTMLButtonElement>('[data-ops-nodes-action="' + key + '"]')
    const addButton = root.querySelector<HTMLButtonElement>('[data-ops-nodes-add]'), codeOutput = root.querySelector<HTMLInputElement>('[data-ops-nodes-invite-code]'), codeNote = root.querySelector<HTMLElement>('[data-ops-nodes-invite-note]')
    const transport = frameRequest(root)
    if (!status || !rows || !editor || !addButton || !codeOutput || !codeNote) return
    const denied = '[data-wiring="unavailable"],[data-capability-state="unavailable"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.nodesCanRead === 'true'
    const manageable = (): boolean => admitted() && root.dataset.nodesCanManage === 'true' && !root.closest(denied)
    // Reject an incomplete selected-theme contract before any authorized provider read.
    try {
      const template0 = cloneViewRecord(root, 'ops-node-row', 'tr', { 'label': '', 'hostname': '', 'role': '', 'version': '', 'enrollment': '', 'verify-label': '', 'repin-label': '', 'remove-label': '', 'force-label': '' })
      for (const name of ['verify', 'repin', 'remove', 'force']) viewAction(template0, name)
      cloneViewRecord(root, 'ops-node-empty', 'tr', { 'message': '' })
    } catch {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true })
      status.dataset.state = 'unavailable'; status.textContent = t('Unavailable'); return
    }
    let view: NodesView | null = null, busy = false
    const verification = new Map<string, { enrollment: string; observed: string | null; unreachable: boolean }>()
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'conflict'].includes(state) ? 'alert' : 'status') }
    const fact = (key: string, value: string): void => { const target = root.querySelector<HTMLElement>('[data-ops-nodes-fact="' + key + '"]'); if (target) target.textContent = value }
    const roleLabel = (role: string): string => ({ all: t('All roles'), web: t('Web'), dns: 'DNS', mail: t('Mail'), db: t('Database') } as Record<string, string>)[role] ?? role
    const enrollLabel = (id: string): string => ({ verified: t('Verified'), unreachable: t('Unreachable') } as Record<string, string>)[verification.get(id)?.enrollment ?? ''] ?? t('Linked, not verified yet')
    const lock = (): void => {
      const can = manageable() && !busy
      for (const name of ['code', 'label', 'role']) { const control = field(name); if (control) control.disabled = !can }
      addButton.disabled = !can
      const invite = button('invite'); if (invite) invite.disabled = !can || view?.channel.verification !== 'available'
      const read = button('read'); if (read) read.disabled = busy || !admitted()
      rows.querySelectorAll<HTMLButtonElement>('[data-xp-action]').forEach(control => { control.disabled = !can })
      root.setAttribute('aria-busy', String(busy))
    }
    const paint = (): void => {
      rows.textContent = ''
      const nodes = view?.config.nodes ?? []
      if (!nodes.length) rows.append(cloneViewRecord(root, 'ops-node-empty', 'tr', { message: view ? t('No servers are linked.') : t('No node registry has been read.') }))
      for (const node of nodes) {
        const seen = verification.get(node.id)
        const row = cloneViewRecord(root, 'ops-node-row', 'tr', { label: node.label, hostname: node.hostname + ':' + String(node.port), role: roleLabel(node.role), version: node.version, enrollment: enrollLabel(node.id), 'verify-label': t('Verify channel'), 'repin-label': t('Trust new certificate'), 'remove-label': t('Unlink'), 'force-label': t('Unlink here only') })
        const verifyButton = viewAction<HTMLButtonElement>(row, 'verify'), repin = viewAction<HTMLButtonElement>(row, 'repin'), remove = viewAction<HTMLButtonElement>(row, 'remove'), force = viewAction<HTMLButtonElement>(row, 'force')
        verifyButton.hidden = remove.hidden = !manageable(); verifyButton.dataset.opsNodesVerify = node.id
        repin.hidden = !manageable() || !seen?.observed; force.hidden = !manageable() || !seen?.unreachable
        for (const control of [verifyButton, repin, remove, force]) control.disabled = busy || !manageable()
        verifyButton.addEventListener('click', () => { if (!verifyButton.disabled) void verify(node) })
        repin.addEventListener('click', () => { if (!repin.disabled) void repinNode(node, seen?.observed ?? '') })
        remove.addEventListener('click', () => { if (!remove.disabled) void unlink(node, false) })
        force.addEventListener('click', () => { if (!force.disabled) void unlink(node, true) })
        rows.append(row)
      }
      fact('count', String(nodes.length))
    }
    const render = (value: NodesView): void => {
      view = value
      fact('this', value.thisServer.hostname ?? t('Not set')); fact('channel', value.channel.verification === 'available' ? t('Available') : t('Unavailable'))
      editor.hidden = !manageable()
      if (single) single.hidden = !value.singleNode
      paint()
      if (value.invalid) note('conflict', t('The saved node links could not be read and need review. Nothing can be linked until they are fixed.'))
      else if (value.channel.verification === 'unavailable') note('unavailable', nodeRefusal(value.channel.reason, t))
      else note('read', t('Node links read. Verify a node to prove its channel now.'))
      lock()
    }
    const run = async (state: string, message: string, work: () => Promise<void>): Promise<void> => {
      if (busy || !manageable()) return
      busy = true; lock(); note(state, message)
      try { await work() } catch (error) {
        const failure = error as { status?: number; details?: { reason?: unknown } }
        note(failure.status === 409 ? 'conflict' : 'failed', failure.details?.reason ? nodeRefusal(failure.details.reason, t) : t('The node link could not be changed. Nothing was changed here.'))
      } finally { busy = false; lock() }
    }
    const read = async (): Promise<void> => render(readNodesView(await transport!('GET', '/api/server/nodes')))
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; lock(); note('reading', t('Reading nodes…'))
      try { await read() } catch { if (admitted()) note('failed', t('The node registry could not be read. Nothing was changed.')) } finally { busy = false; lock() }
    }
    const invite = (): Promise<void> => run('saving', t('Creating a link code…'), async () => {
      const reply = await transport!('POST', '/api/server/nodes/invitations', {}) as { code?: unknown; expiresAt?: unknown }
      if (typeof reply.code !== 'string' || typeof reply.expiresAt !== 'string') throw new Error('invalid_invitation')
      codeOutput.value = reply.code
      codeOutput.disabled = false
      codeNote.hidden = false
      codeNote.textContent = t('Paste this code on the other server before {time} UTC. It is shown once and links one server.', { time: reply.expiresAt.slice(0, 16).replace('T', ' ') })
      note('read', t('Link code created.'))
    })
    const add = (): Promise<void> => run('saving', t('Linking the server…'), async () => {
      const code = field('code') as HTMLInputElement, label = (field('label') as HTMLInputElement).value.trim(), role = (field('role') as HTMLSelectElement).value
      if (!code.value.trim() || !label) { note('failed', t('Enter the link code and a label.')); return }
      const value = readNodesView(await transport!('POST', '/api/server/nodes/link', { code: code.value.trim(), label, role }))
      code.value = ''; (field('label') as HTMLInputElement).value = ''
      render(value); note('saved', t('The servers are linked. Each one has proved its certificate and credential to the other.'))
    })
    const verify = (node: NodeView): Promise<void> => run('verifying', t('Verifying the authenticated channel…'), async () => {
      const result = await transport!('POST', '/api/server/nodes/verify', { id: node.id }) as { enrollment?: string; reason?: string | null; observedFingerprint?: string | null }
      const ok = result.enrollment === 'verified', observed = typeof result.observedFingerprint === 'string' ? result.observedFingerprint : null
      verification.set(node.id, { enrollment: ok ? 'verified' : 'unreachable', observed, unreachable: !ok })
      paint()
      note(ok ? 'read' : 'failed', ok ? t('The node channel was verified.') : observed ? t('The node now presents certificate {fingerprint}. Compare it on that server before you trust it.', { fingerprint: observed }) : nodeRefusal(result.reason, t))
    })
    const repinNode = (node: NodeView, fingerprint: string): Promise<void> => run('saving', t('Checking the new certificate…'), async () => {
      if (!fingerprint || !view) return
      if (typeof askDialog !== 'function' || await askDialog({ title: t('Trust new certificate'), body: t('Trust certificate {fingerprint} for {host}? The node must still answer with its own identity.', { fingerprint, host: node.hostname }), confirm: t('Trust new certificate') }) !== true) { note('read', t('Nothing was changed.')); return }
      verification.delete(node.id)
      await read(); render(readNodesView(await transport!('PATCH', '/api/server/nodes/' + node.id, { expectedSavedRevision: view.savedRevision, fingerprint })))
      note('saved', t('The new certificate is pinned.'))
    })
    const unlink = (node: NodeView, force: boolean): Promise<void> => run('saving', t('Unlinking the server…'), async () => {
      if (!view) return
      if (typeof askDialog !== 'function' || await askDialog({ title: t('Unlink'), body: force ? t('{host} could not be told. Its link stays there until root removes it, and it can no longer reach this server.', { host: node.hostname }) : t('Unlink {host}? Both servers forget each other and their link credentials stop working.', { host: node.hostname }), confirm: t('Unlink'), danger: true }) !== true) { note('read', t('Nothing was changed.')); return }
      let reply: unknown
      try { reply = await transport!('DELETE', '/api/server/nodes/' + node.id, { expectedSavedRevision: view.savedRevision, ...(force ? { force: true } : {}) }) } catch (error) {
        if ((error as { details?: { reason?: unknown } }).details?.reason === 'node_unreachable') { verification.set(node.id, { enrollment: 'unreachable', observed: null, unreachable: true }); paint() }
        throw error
      }
      verification.delete(node.id)
      render(readNodesView(reply)); note('saved', t('The server was unlinked.'))
    })
    addButton.addEventListener('click', () => { void add() })
    button('read')?.addEventListener('click', () => { void load() })
    button('invite')?.addEventListener('click', () => { void invite() })
    if (!admitted()) note('unavailable', t('Server nodes are unavailable here. Nothing was read or changed.'))
    lock()
  })
}

export const OPS_NODES_CLIENT_BINDING = withFrameRequest(`(()=>{${VIEW_RECORD_HELPERS}const readNodesView=${readNodesView.toString()};const nodeRefusal=${nodeRefusal.toString()};return ${bindOpsNodes.toString()};})()`)
