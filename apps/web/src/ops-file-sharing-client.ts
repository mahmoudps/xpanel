/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction, VIEW_RECORD_HELPERS } from './workspace-view-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction

export type ShareClientView = { host: string; permission: 'ro' | 'rw'; squashRoot: boolean; subtreeCheck: boolean }
export type ShareView = { id: string; path: string; clients: ShareClientView[]; exportState?: 'exported' | 'not-exported' | 'conflict' }
export type FileSharingView = {
  config: { shares: ShareView[] }; savedRevision: string; activeRevision: string; invalid: boolean
  observed: { state: 'read' | 'unavailable'; managedPresent: boolean; shares: ShareView[]; foreignExports: string[]; reason: string | null }
}

export function readFileSharingView(value: unknown): FileSharingView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const hash = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)
  const unsafe = new RegExp('[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]')
  const sharePath = (item: unknown): item is string => typeof item === 'string' && /^\/(?:home|srv\/shares)\//.test(item) && item.length <= 1024 && !unsafe.test(item)
  const host = (item: unknown): item is string => typeof item === 'string' && item.length >= 1 && item.length <= 255 && !/[\u0000-\u001f\u007f-\u009f\s]/.test(item)
  const readShare = (raw: unknown, withExport: boolean): ShareView => {
    if (!object(raw) || typeof raw.id !== 'string' || !/^shr_[0-9a-z]{16}$/.test(raw.id) || !sharePath(raw.path) || !Array.isArray(raw.clients) || raw.clients.length < 1 || raw.clients.length > 64
      || withExport && !['exported', 'not-exported', 'conflict'].includes(String(raw.exportState))) throw new Error('invalid_share')
    const clients = raw.clients.map(client => { if (!object(client) || !host(client.host) || (client.permission !== 'ro' && client.permission !== 'rw') || typeof client.squashRoot !== 'boolean' || typeof client.subtreeCheck !== 'boolean') throw new Error('invalid_share_client'); return { host: client.host, permission: client.permission as 'ro' | 'rw', squashRoot: client.squashRoot, subtreeCheck: client.subtreeCheck } })
    return { id: raw.id, path: raw.path, clients, ...(withExport ? { exportState: raw.exportState as ShareView['exportState'] } : {}) }
  }
  if (!object(value) || !object(value.config) || !Array.isArray(value.config.shares) || value.config.shares.length > 200 || !hash(value.savedRevision) || !hash(value.activeRevision) || typeof value.invalid !== 'boolean' || !object(value.observed)) throw new Error('invalid_file_sharing')
  const observed = value.observed
  if (!['read', 'unavailable'].includes(String(observed.state)) || typeof observed.managedPresent !== 'boolean' || !Array.isArray(observed.shares) || observed.shares.length > 200 || !Array.isArray(observed.foreignExports) || observed.foreignExports.length > 1000 || (observed.reason !== null && (typeof observed.reason !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(observed.reason)))) throw new Error('invalid_file_sharing')
  return {
    config: { shares: value.config.shares.map(share => readShare(share, false)) },
    savedRevision: value.savedRevision, activeRevision: value.activeRevision, invalid: value.invalid,
    observed: { state: observed.state as 'read' | 'unavailable', managedPresent: observed.managedPresent, shares: observed.shares.map(share => readShare(share, true)), foreignExports: observed.foreignExports.map(path => { if (typeof path !== 'string' || !path.startsWith('/') || path.length > 1024) throw new Error('invalid_foreign_export'); return path }), reason: observed.reason as string | null },
  }
}

export const randomShareId = (): string => {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  const bytes = new Uint8Array(16); (globalThis.crypto ?? { getRandomValues: (array: Uint8Array) => { for (let index = 0; index < array.length; index++) array[index] = Math.floor(Math.random() * 256); return array } }).getRandomValues(bytes)
  return 'shr_' + Array.from(bytes, byte => alphabet[byte % 36]).join('')
}

function bindOpsFileSharing(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-ops-shares-workspace]').forEach(root => {
    if (root.dataset.sharesBound === 'true') return
    root.dataset.sharesBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-ops-shares-status]'), rows = root.querySelector<HTMLElement>('[data-ops-shares-rows]')
    const editor = root.querySelector<HTMLElement>('[data-ops-shares-editor]'), foreignCard = root.querySelector<HTMLElement>('[data-ops-shares-foreign-card]'), foreign = root.querySelector<HTMLElement>('[data-ops-shares-foreign]')
    const pathInput = root.querySelector<HTMLInputElement>('[data-ops-shares-path]'), hostInput = root.querySelector<HTMLInputElement>('[data-ops-shares-host]'), permission = root.querySelector<HTMLSelectElement>('[data-ops-shares-permission]')
    const button = (key: string): HTMLButtonElement | null => root.querySelector<HTMLButtonElement>('[data-ops-shares-action="' + key + '"]')
    const addButton = root.querySelector<HTMLButtonElement>('[data-ops-shares-add]'), saveButton = root.querySelector<HTMLButtonElement>('[data-ops-shares-save]')
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !rows || !editor || !pathInput || !hostInput || !permission || !addButton || !saveButton) return
    const denied = '[data-wiring="unavailable"],[data-capability-state="unavailable"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.sharesCanRead === 'true' && !root.closest(denied)
    const manageable = (): boolean => admitted() && root.dataset.sharesCanManage === 'true'
    // Reject an incomplete selected-theme contract before any authorized provider read.
    try {
      const template0 = cloneViewRecord(root, 'ops-share-row', 'tr', { 'path': '', 'clients': '', 'state': '', 'remove-label': '' })
      viewAction(template0, 'remove')
      cloneViewRecord(root, 'ops-share-empty', 'tr', { 'message': '' })
      cloneViewRecord(root, 'ops-share-foreign', 'li', { 'path': '' })
    } catch {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true })
      status.dataset.state = 'unavailable'; status.textContent = t('Unavailable'); return
    }
    let view: FileSharingView | null = null, draft: ShareView[] = [], dirty = false, busy = false
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'uncertain', 'conflict'].includes(state) ? 'alert' : 'status') }
    const fact = (key: string, value: string): void => { const target = root.querySelector<HTMLElement>('[data-ops-shares-fact="' + key + '"]'); if (target) target.textContent = value }
    const exportLabel = (state: ShareView['exportState']): string => state === 'exported' ? t('Exported') : state === 'conflict' ? t('Differs from saved configuration') : t('Not exported')
    const lock = (): void => {
      const can = manageable() && !busy
      for (const control of [pathInput, hostInput, permission, addButton]) control.disabled = !can
      saveButton.disabled = !can || !dirty
      const apply = button('apply'); if (apply) apply.disabled = !can || dirty || !view || view.observed.state !== 'read'
      const read = button('read'); if (read) read.disabled = busy || !admitted()
      rows.querySelectorAll<HTMLButtonElement>('[data-xp-action="remove"]').forEach(control => { control.disabled = !can })
      root.setAttribute('aria-busy', String(busy))
    }
    const paint = (): void => {
      rows.textContent = ''
      if (!draft.length) rows.append(cloneViewRecord(root, 'ops-share-empty', 'tr', { message: view?.observed.state === 'read' ? t('No shares are configured.') : t('No share configuration has been read.') }))
      for (const share of draft) {
        const exported = view?.observed.shares.find(item => item.path === share.path)
        const row = cloneViewRecord(root, 'ops-share-row', 'tr', { path: share.path, clients: share.clients.map(client => client.permission === 'rw' ? t('{host} (read and write)', { host: client.host }) : t('{host} (read only)', { host: client.host })).join(', '), state: dirty ? t('Not applied') : exported ? exportLabel(exported.exportState) : t('Not applied'), 'remove-label': t('Remove') })
        const remove = viewAction<HTMLButtonElement>(row, 'remove')
        remove.hidden = !manageable(); remove.disabled = busy || !manageable()
        remove.addEventListener('click', () => { if (busy || !manageable()) return; draft = draft.filter(item => item.id !== share.id); dirty = true; paint(); lock() })
        rows.append(row)
      }
      fact('count', String(draft.length))
    }
    const render = (value: FileSharingView): void => {
      view = value; draft = value.config.shares.map(share => ({ ...share, clients: share.clients.map(client => ({ ...client })) })); dirty = false
      fact('nfs', value.observed.state === 'read' ? t('Available') : value.observed.reason === 'nfs_server_unavailable' ? t('Not installed') : t('Not verified'))
      fact('managed', value.observed.managedPresent ? t('Present') : t('Absent'))
      editor.hidden = !manageable()
      if (foreign && foreignCard) { foreign.textContent = ''; foreignCard.hidden = value.observed.foreignExports.length === 0; for (const path of value.observed.foreignExports) foreign.append(cloneViewRecord(root, 'ops-share-foreign', 'li', { path })) }
      paint()
      if (value.invalid) note('conflict', t('The saved share configuration could not be read and is shown as empty. Saving will replace it.'))
      else if (value.observed.state !== 'read') note('unavailable', value.observed.reason === 'nfs_server_unavailable' ? t('The NFS server is not available on this host, so shares cannot be exported. Configuration can still be saved.') : t('The export table could not be read. Nothing was changed.'))
      else note('read', t('Share configuration read. Review it before applying; nothing has been changed.'))
      lock()
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; lock(); note('reading', t('Reading shares…'))
      try { render(readFileSharingView(await transport!('GET', '/api/server/file-sharing'))) }
      catch { if (admitted()) note('failed', t('The share configuration could not be read. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    const save = async (): Promise<void> => {
      if (busy || !manageable() || !view || !dirty) return
      busy = true; lock(); note('saving', t('Saving shares…'))
      try { const saved = readFileSharingView(await transport!('PUT', '/api/server/file-sharing', { config: { shares: draft.map(share => ({ id: share.id, path: share.path, clients: share.clients })) }, expectedSavedRevision: view.savedRevision })); render(saved); note('saved', t('Shares saved. Apply to change active exports.')) }
      catch (error) { const status = (error as { status?: number }).status; note(status === 409 ? 'conflict' : 'failed', status === 409 ? t('Shares changed since they were read. Reload before saving.') : t('The shares could not be saved. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    const apply = async (): Promise<void> => {
      if (busy || !manageable() || !view || dirty || view.observed.state !== 'read') return
      if (typeof askDialog !== 'function' || await askDialog({ title: t('Apply shares to active exports?'), body: t('The managed exports file is rewritten and exportfs re-exports. Other exports on this server are unchanged. The result is confirmed by reading the export table again.'), confirm: t('Apply exports') }) !== true) return
      const revision = view.savedRevision, active = view.activeRevision
      busy = true; lock(); note('applying', t('Applying exports…'))
      let message = '', state = 'applied'
      try { await transport!('POST', '/api/server/file-sharing/apply', { expectedRevision: revision, expectedActiveRevision: active }); message = t('Exports applied and verified against the kernel export table.') }
      catch (error) { const detail = (error as { details?: Record<string, unknown> }).details ?? {}; state = detail.unknownOutcome ? 'uncertain' : detail.rolledBack ? 'conflict' : 'failed'; message = detail.unknownOutcome ? t('The export outcome is unknown. Review NFS exports before retrying.') : detail.rolledBack ? t('Applying failed and the previous exports were restored.') : t('The exports could not be applied. Nothing was changed.') }
      busy = false; await load(); note(state, message)
    }
    addButton.addEventListener('click', () => {
      if (!manageable()) return
      const path = pathInput.value.trim(), host = hostInput.value.trim()
      if (!/^\/(?:home|srv\/shares)\/\S+$/.test(path) || path.includes('//') || /\s|\\/.test(path)) { note('failed', t('Enter a folder under /home or /srv/shares.')); return }
      if (!host || /\s/.test(host) || draft.some(share => share.path === path)) { note('failed', draft.some(share => share.path === path) ? t('That folder is already shared.') : t('Enter a client host or network.')); return }
      draft = [...draft, { id: randomShareId(), path, clients: [{ host, permission: permission.value === 'rw' ? 'rw' : 'ro', squashRoot: true, subtreeCheck: true }] }]
      dirty = true; pathInput.value = ''; hostInput.value = ''; paint(); lock(); note('read', t('Share added to the draft. Save to store it.'))
    })
    saveButton.addEventListener('click', () => { void save() })
    button('read')?.addEventListener('click', () => { void load() })
    button('apply')?.addEventListener('click', () => { void apply() })
    if (!admitted()) note('unavailable', t('Server file sharing is unavailable here. Nothing was read or changed.'))
    lock()
  })
}

export const OPS_FILE_SHARING_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const readFileSharingView=${readFileSharingView.toString()};const randomShareId=${randomShareId.toString()};return ${bindOpsFileSharing.toString()};})()`
