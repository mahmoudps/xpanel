/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction, VIEW_RECORD_HELPERS } from './workspace-view-templates.ts'
import { frameRequest as canonicalFrameRequest, withFrameRequest } from './read-only-frame.ts'
const frameRequest = canonicalFrameRequest
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction

export type ClusterPush = { state: string; at: string; reason: string | null }
export type ClusterVersion = { number: number; createdAt: string; actor: string; note: string; digest: string; sections: string[]; pushes: Record<string, ClusterPush> }
export type ClusterView = { revision: string; sections: string[]; members: string[]; nodes: { id: string; label: string; hostname: string }[]; versions: ClusterVersion[] }

export function readClusterView(value: unknown): ClusterView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const strings = (item: unknown): item is string[] => Array.isArray(item) && item.every(entry => typeof entry === 'string')
  if (!object(value) || typeof value.revision !== 'string' || !strings(value.sections) || !strings(value.members) || !Array.isArray(value.nodes) || !Array.isArray(value.versions)
    || !value.nodes.every(node => object(node) && typeof node.id === 'string' && typeof node.label === 'string' && typeof node.hostname === 'string')
    || !value.versions.every(version => object(version) && Number.isSafeInteger(version.number) && typeof version.createdAt === 'string' && typeof version.actor === 'string' && typeof version.note === 'string' && typeof version.digest === 'string' && strings(version.sections) && object(version.pushes))) throw new Error('invalid_cluster')
  return value as unknown as ClusterView
}

function bindNodeCluster(askDialog?: (options: { title: string; body: string; confirm: string; danger?: boolean }) => Promise<unknown>): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-node-cluster]').forEach(root => {
    if (root.dataset.clusterBound === 'true') return
    root.dataset.clusterBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-node-cluster-status]'), members = root.querySelector<HTMLElement>('[data-node-cluster-members]'), sections = root.querySelector<HTMLElement>('[data-node-cluster-sections]')
    const versions = root.querySelector<HTMLElement>('[data-node-cluster-versions]'), noteInput = root.querySelector<HTMLInputElement>('[data-node-cluster-note]'), member = root.querySelector<HTMLSelectElement>('[data-node-cluster-member]'), overwrite = root.querySelector<HTMLInputElement>('[data-node-cluster-overwrite]')
    const readButton = root.querySelector<HTMLButtonElement>('[data-node-cluster-read]'), saveButton = root.querySelector<HTMLButtonElement>('[data-node-cluster-save]'), createButton = root.querySelector<HTMLButtonElement>('[data-node-cluster-create]')
    const transport = frameRequest(root)
    if (!status || !members || !sections || !versions || !noteInput || !member || !overwrite || !readButton || !saveButton || !createButton) return
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.clusterCanRead === 'true'
    const manageable = (): boolean => admitted() && root.dataset.clusterCanManage === 'true' && !root.closest('[data-wiring="unavailable"],[data-capability-state="unavailable"],[aria-disabled="true"],fieldset:disabled')
    try {
      viewAction(cloneViewRecord(root, 'node-cluster-version-row', 'tr', { number: '', created: '', sections: '', pushes: '', 'push-label': '', 'rollback-label': '' }), 'push')
      cloneViewRecord(root, 'node-cluster-version-empty', 'tr', { message: '' })
      viewAction(cloneViewRecord(root, 'node-cluster-choice', 'label', { name: '' }), 'select', 'input')
    } catch {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true })
      status.dataset.state = 'unavailable'; status.textContent = t('Unavailable'); return
    }
    let view: ClusterView | null = null, busy = false
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'conflict'].includes(state) ? 'alert' : 'status') }
    const sectionLabel = (id: string): string => ({ 'tweak-settings': t('Tweak Settings'), 'update-preferences': t('Update preferences'), 'maintenance-schedule': t('Maintenance schedule'), 'sign-in-policy': t('Sign-in policy') } as Record<string, string>)[id] ?? id
    const pushLabel = (state: string): string => ({ pushing: t('Pushing'), applied: t('Applied'), failed: t('Failed'), rolled_back: t('Rolled back'), interrupted: t('Interrupted') } as Record<string, string>)[state] ?? state
    const lock = (): void => {
      const can = manageable() && !busy
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = !can })
      readButton.disabled = busy || !admitted()
      root.setAttribute('aria-busy', String(busy))
    }
    const choice = (name: string, value: string, checked: boolean): HTMLElement => {
      const row = cloneViewRecord(root, 'node-cluster-choice', 'label', { name }), box = viewAction<HTMLInputElement>(row, 'select', 'input')
      box.value = value; box.checked = checked
      return row
    }
    const chosen = (box: HTMLElement): string[] => [...box.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')].map(input => input.value)
    const paint = (): void => {
      if (!view) return
      const current = view
      members.textContent = ''; sections.textContent = ''; versions.textContent = ''; member.textContent = ''
      for (const node of current.nodes) members.append(choice(node.label + ' (' + node.hostname + ')', node.id, current.members.includes(node.id)))
      for (const id of current.sections) sections.append(choice(sectionLabel(id), id, false))
      for (const node of current.nodes.filter(item => current.members.includes(item.id))) { const option = document.createElement('option'); option.value = node.id; option.textContent = node.label; member.append(option) }
      if (!current.versions.length) versions.append(cloneViewRecord(root, 'node-cluster-version-empty', 'tr', { message: t('No version has been created.') }))
      for (const version of current.versions) {
        const pushes = Object.entries(version.pushes).map(([id, push]) => (current.nodes.find(node => node.id === id)?.label ?? id) + ': ' + pushLabel(push.state)).join(', ')
        const row = cloneViewRecord(root, 'node-cluster-version-row', 'tr', { number: version.number, created: version.createdAt.slice(0, 16).replace('T', ' ') + ' UTC', sections: version.sections.map(sectionLabel).join(', '), pushes: pushes || t('Not pushed'), 'push-label': t('Push to members'), 'rollback-label': t('Roll back on member') })
        viewAction<HTMLButtonElement>(row, 'push').addEventListener('click', () => { void push(version) })
        viewAction<HTMLButtonElement>(row, 'rollback').addEventListener('click', () => { void rollback(version) })
        versions.append(row)
      }
    }
    const refusal = (error: unknown): string => {
      const reason = (error as { details?: { reason?: unknown } }).details?.reason
      return ({ insufficient_privileges: t('That node credential lacks the privileges a member needs. Link the server again.'), not_latest: t('Only the newest push on that member can be rolled back.'), local_changes: t('That member changed the file after the push. Choose to overwrite local changes to roll back anyway.'), not_pushed: t('This version was not pushed to that member.'), section_invalid: t('A chosen file fails validation; fix it before pushing.'), node_not_linked: t('That server is no longer linked.') } as Record<string, string>)[String(reason)] ?? t('The cluster could not be changed. Nothing was changed here.')
    }
    const read = async (): Promise<void> => { view = readClusterView(await transport!('GET', '/api/server/cluster')); paint() }
    const run = async (state: string, message: string, work: () => Promise<void>): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; lock(); note(state, message)
      try { await work() } catch (error) { note((error as { status?: number }).status === 409 ? 'conflict' : 'failed', refusal(error)) } finally { busy = false; lock() }
    }
    const wait = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 1000))
    const push = (version: ClusterVersion): Promise<void> => run('saving', t('Pushing to the members…'), async () => {
      if (!view) return
      if (typeof askDialog !== 'function' || await askDialog({ title: t('Push to members'), body: t('Version {number} replaces these files on {count, plural, one {# member} other {# members}}. Each member keeps what it had, so the push can be rolled back there.', { number: version.number, count: view.members.length }), confirm: t('Push to members') }) !== true) { note('read', t('Nothing was changed.')); return }
      view = readClusterView(await transport!('POST', '/api/server/cluster/versions/' + version.number + '/push', { members: view.members }))
      for (let attempt = 0; attempt < 90 && view.versions.find(item => item.number === version.number)?.pushes && Object.values(view.versions.find(item => item.number === version.number)!.pushes).some(item => item.state === 'pushing'); attempt++) { await wait(); await read() }
      paint(); note('read', t('The push finished. Each member shows its own result.'))
    })
    const rollback = (version: ClusterVersion): Promise<void> => run('saving', t('Rolling back on the member…'), async () => {
      if (!member.value) { note('failed', t('Choose a member first.')); return }
      view = readClusterView(await transport!('POST', '/api/server/cluster/versions/' + version.number + '/rollback', { member: member.value, overwrite: overwrite.checked }))
      paint(); note('saved', t('The member is back to what it had before this push.'))
    })
    readButton.addEventListener('click', () => { void run('reading', t('Reading the cluster…'), async () => { await read(); note('read', t('Cluster read.')) }) })
    saveButton.addEventListener('click', () => { void run('saving', t('Saving the members…'), async () => {
      view = readClusterView(await transport!('PUT', '/api/server/cluster/members', { members: chosen(members), expectedRevision: view?.revision ?? '' })); paint(); note('saved', t('Members saved.'))
    }) })
    createButton.addEventListener('click', () => { void run('saving', t('Creating a version…'), async () => {
      const picked = chosen(sections)
      if (!picked.length) { note('failed', t('Choose at least one configuration section.')); return }
      view = readClusterView(await transport!('POST', '/api/server/cluster/versions', { sections: picked, note: noteInput.value.trim() })); noteInput.value = ''; paint(); note('saved', t('Version created from what is saved on this server now.'))
    }) })
    if (!admitted()) note('unavailable', t('The configuration cluster is unavailable here. Nothing was read or changed.'))
    lock()
  })
}

export const NODE_CLUSTER_CLIENT_BINDING = withFrameRequest(`(()=>{${VIEW_RECORD_HELPERS}const readClusterView=${readClusterView.toString()};return ${bindNodeCluster.toString()};})()`)
