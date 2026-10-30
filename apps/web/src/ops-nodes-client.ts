/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction, VIEW_RECORD_HELPERS } from './workspace-view-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction

export type NodeView = { id: string; label: string; hostname: string; port: number; fingerprint: string; role: 'web' | 'dns' | 'mail' | 'db' | 'all' }
export type NodesView = {
  config: { nodes: NodeView[] }; savedRevision: string; activeRevision: string; invalid: boolean
  thisServer: { hostname: string | null }; singleNode: boolean; channel: { verification: 'available' | 'unavailable' }
}

export function readNodesView(value: unknown): NodesView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const hash = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)
  const fqdn = (item: unknown): item is string => typeof item === 'string' && item.length <= 253 && /^(?!-)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/.test(item)
  const readNode = (raw: unknown): NodeView => {
    if (!object(raw) || typeof raw.id !== 'string' || !/^node_[0-9a-f]{16}$/.test(raw.id) || typeof raw.label !== 'string' || raw.label.length < 1 || raw.label.length > 64 || !fqdn(raw.hostname)
      || typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535 || !hash(raw.fingerprint) || !['web', 'dns', 'mail', 'db', 'all'].includes(String(raw.role))) throw new Error('invalid_node')
    return { id: raw.id, label: raw.label, hostname: raw.hostname, port: raw.port, fingerprint: raw.fingerprint, role: raw.role as NodeView['role'] }
  }
  if (!object(value) || !object(value.config) || !Array.isArray(value.config.nodes) || value.config.nodes.length > 64 || !hash(value.savedRevision) || !hash(value.activeRevision) || typeof value.invalid !== 'boolean'
    || !object(value.thisServer) || (value.thisServer.hostname !== null && !fqdn(value.thisServer.hostname)) || typeof value.singleNode !== 'boolean' || !object(value.channel) || !['available', 'unavailable'].includes(String(value.channel.verification))) throw new Error('invalid_nodes')
  return { config: { nodes: value.config.nodes.map(readNode) }, savedRevision: value.savedRevision, activeRevision: value.activeRevision, invalid: value.invalid, thisServer: { hostname: value.thisServer.hostname as string | null }, singleNode: value.singleNode, channel: { verification: value.channel.verification as 'available' | 'unavailable' } }
}

export const randomNodeId = (): string => {
  const bytes = new Uint8Array(8); (globalThis.crypto ?? { getRandomValues: (array: Uint8Array) => { for (let index = 0; index < array.length; index++) array[index] = Math.floor(Math.random() * 256); return array } }).getRandomValues(bytes)
  return 'node_' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function bindOpsNodes(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-ops-nodes-workspace]').forEach(root => {
    if (root.dataset.nodesBound === 'true') return
    root.dataset.nodesBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-ops-nodes-status]'), rows = root.querySelector<HTMLElement>('[data-ops-nodes-rows]'), editor = root.querySelector<HTMLElement>('[data-ops-nodes-editor]'), single = root.querySelector<HTMLElement>('[data-ops-nodes-single]')
    const field = (name: string): HTMLInputElement | HTMLSelectElement | null => root.querySelector('[data-ops-nodes-' + name + ']')
    const button = (key: string): HTMLButtonElement | null => root.querySelector<HTMLButtonElement>('[data-ops-nodes-action="' + key + '"]')
    const addButton = root.querySelector<HTMLButtonElement>('[data-ops-nodes-add]'), saveButton = root.querySelector<HTMLButtonElement>('[data-ops-nodes-save]')
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !rows || !editor || !addButton || !saveButton) return
    const denied = '[data-wiring="unavailable"],[data-capability-state="unavailable"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.nodesCanRead === 'true' && !root.closest(denied)
    const manageable = (): boolean => admitted() && root.dataset.nodesCanManage === 'true'
    // Reject an incomplete selected-theme contract before any authorized provider read.
    try {
      const template0 = cloneViewRecord(root, 'ops-node-row', 'tr', { 'label': '', 'hostname': '', 'role': '', 'enrollment': '', 'verify-label': '', 'remove-label': '' })
      viewAction(template0, 'verify')
      viewAction(template0, 'remove')
      cloneViewRecord(root, 'ops-node-empty', 'tr', { 'message': '' })
    } catch {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true })
      status.dataset.state = 'unavailable'; status.textContent = t('Unavailable'); return
    }
    let view: NodesView | null = null, draft: NodeView[] = [], dirty = false, busy = false
    const verification = new Map<string, string>()
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'conflict'].includes(state) ? 'alert' : 'status') }
    const fact = (key: string, value: string): void => { const target = root.querySelector<HTMLElement>('[data-ops-nodes-fact="' + key + '"]'); if (target) target.textContent = value }
    const roleLabel = (role: string): string => ({ all: t('All roles'), web: t('Web'), dns: 'DNS', mail: t('Mail'), db: t('Database') } as Record<string, string>)[role] ?? role
    const enrollLabel = (id: string): string => ({ verified: t('Verified'), unreachable: t('Unreachable'), pending: t('Pending') } as Record<string, string>)[verification.get(id) ?? 'pending'] ?? t('Pending')
    const lock = (): void => {
      const can = manageable() && !busy
      for (const name of ['label', 'host', 'port', 'fingerprint', 'role']) { const control = field(name); if (control) control.disabled = !can }
      addButton.disabled = !can; saveButton.disabled = !can || !dirty
      const read = button('read'); if (read) read.disabled = busy || !admitted()
      root.querySelectorAll<HTMLButtonElement>('[data-ops-nodes-verify]').forEach(element => { element.disabled = busy || !manageable() || dirty })
      rows.querySelectorAll<HTMLButtonElement>('[data-xp-action="remove"]').forEach(control => { control.disabled = !can })
      root.setAttribute('aria-busy', String(busy))
    }
    const paint = (): void => {
      rows.textContent = ''
      if (!draft.length) rows.append(cloneViewRecord(root, 'ops-node-empty', 'tr', { message: view ? t('No additional nodes are registered.') : t('No node registry has been read.') }))
      for (const node of draft) {
        const row = cloneViewRecord(root, 'ops-node-row', 'tr', { label: node.label, hostname: node.hostname + ':' + String(node.port), role: roleLabel(node.role), enrollment: dirty ? t('Pending') : enrollLabel(node.id), 'verify-label': t('Verify channel'), 'remove-label': t('Remove') })
        const verifyButton = viewAction<HTMLButtonElement>(row, 'verify'), remove = viewAction<HTMLButtonElement>(row, 'remove')
        verifyButton.hidden = remove.hidden = !manageable(); verifyButton.dataset.opsNodesVerify = node.id
        verifyButton.disabled = busy || !manageable() || dirty; remove.disabled = busy || !manageable()
        verifyButton.addEventListener('click', () => { if (!verifyButton.disabled) void verify(node.id) })
        remove.addEventListener('click', () => { if (busy || !manageable()) return; draft = draft.filter(item => item.id !== node.id); dirty = true; paint(); lock() })
        rows.append(row)
      }
      fact('count', String(draft.length))
    }
    const render = (value: NodesView): void => {
      view = value; draft = value.config.nodes.map(node => ({ ...node })); dirty = false; verification.clear()
      fact('this', value.thisServer.hostname ?? t('Not set')); fact('channel', value.channel.verification === 'available' ? t('Available') : t('Unavailable'))
      editor.hidden = !manageable()
      if (single) single.hidden = !value.singleNode
      paint()
      if (value.invalid) note('conflict', t('The saved node registry could not be read and is shown as empty. Saving will replace it.'))
      else note('read', t('Node registry read. Nodes are usable only once their authenticated channel is verified.'))
      lock()
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; lock(); note('reading', t('Reading nodes…'))
      try { render(readNodesView(await transport!('GET', '/api/server/nodes'))) }
      catch { if (admitted()) note('failed', t('The node registry could not be read. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    const save = async (): Promise<void> => {
      if (busy || !manageable() || !view || !dirty) return
      busy = true; lock(); note('saving', t('Saving the node registry…'))
      try { render(readNodesView(await transport!('PUT', '/api/server/nodes', { config: { nodes: draft }, expectedSavedRevision: view.savedRevision }))); note('saved', t('Node registry saved.')) }
      catch (error) { const code = (error as { status?: number }).status; note(code === 409 ? 'conflict' : 'failed', code === 409 ? t('The registry changed since it was read. Reload before saving.') : t('The node registry could not be saved. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    const verify = async (id: string): Promise<void> => {
      if (busy || !manageable() || dirty) return
      busy = true; lock(); note('verifying', t('Verifying the authenticated channel…'))
      try {
        const result = await transport!('POST', '/api/server/nodes/verify', { id }) as { enrollment?: string; reason?: string | null }
        const enrollment = result.enrollment === 'verified' ? 'verified' : result.enrollment === 'unreachable' ? 'unreachable' : 'pending'
        verification.set(id, enrollment); paint()
        note(enrollment === 'verified' ? 'read' : 'failed', enrollment === 'verified' ? t('The node channel was verified.') : result.reason === 'authenticated_channel_unavailable' ? t('Channel verification is unavailable on this server; the node stays pending.') : result.reason === 'fingerprint_mismatch' ? t('The node key fingerprint did not match; the node is not trusted.') : t('The node could not be reached.'))
      } catch { note('failed', t('The node channel could not be verified.')) }
      finally { busy = false; lock() }
    }
    addButton.addEventListener('click', () => {
      if (!manageable()) return
      const label = (field('label') as HTMLInputElement).value.trim(), host = (field('host') as HTMLInputElement).value.trim(), port = Number((field('port') as HTMLInputElement).value), fingerprint = (field('fingerprint') as HTMLInputElement).value.trim().toLowerCase(), role = (field('role') as HTMLSelectElement).value
      if (!label || !/^(?!-)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/.test(host)) { note('failed', t('Enter a label and a fully-qualified hostname.')); return }
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(fingerprint)) { note('failed', t('Enter a valid port and a 64-character SHA-256 fingerprint.')); return }
      if (draft.some(node => node.hostname === host)) { note('failed', t('That hostname is already registered.')); return }
      draft = [...draft, { id: randomNodeId(), label, hostname: host, port, fingerprint, role: role as NodeView['role'] }]
      dirty = true; (field('label') as HTMLInputElement).value = ''; (field('host') as HTMLInputElement).value = ''; (field('fingerprint') as HTMLInputElement).value = ''
      paint(); lock(); note('read', t('Node added to the draft. Save to store it.'))
    })
    saveButton.addEventListener('click', () => { void save() })
    button('read')?.addEventListener('click', () => { void load() })
    if (!admitted()) note('unavailable', t('Server nodes are unavailable here. Nothing was read or changed.'))
    lock()
  })
}

export const OPS_NODES_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const readNodesView=${readNodesView.toString()};const randomNodeId=${randomNodeId.toString()};return ${bindOpsNodes.toString()};})()`
