/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction, VIEW_RECORD_HELPERS } from './workspace-view-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction

type Ask = (options: Record<string, unknown>) => Promise<unknown>
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
const IP_ROLES = ['shared', 'dedicated', 'mail'] as const
const IP_OWNERS = ['root', 'reseller', 'account'] as const
const IP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export interface WhmIpEntry {
  id: string; address: string; version: 4 | 6; prefixLength: number; interfaceName: string; role: typeof IP_ROLES[number]
  ownerKind: typeof IP_OWNERS[number]; ownerId: string | null; ptrHostname: string | null; isPrimary: boolean
}
export interface WhmIpDraft { address: string; prefixLength: number; role: WhmIpEntry['role']; ownerKind: 'root'; ownerId: null; ptrHostname: string | null }

/** Strict reader for one IP pool entry as returned by GET/POST /api/ips (canonical address, root-owned ⇔ no owner ID). */
export function readWhmIpEntry(value: unknown): WhmIpEntry {
  const o = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>
  if (typeof o.id !== 'string' || !IP_UUID.test(o.id) || typeof o.address !== 'string' || !/^[0-9a-f:.]{2,45}$/.test(o.address)
    || (o.version !== 4 && o.version !== 6) || (o.version === 6) !== o.address.includes(':')
    || typeof o.prefixLength !== 'number' || !Number.isSafeInteger(o.prefixLength) || o.prefixLength < 1 || o.prefixLength > (o.version === 4 ? 32 : 128)
    || typeof o.interfaceName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,31}$/.test(o.interfaceName)
    || !(IP_ROLES as readonly unknown[]).includes(o.role) || !(IP_OWNERS as readonly unknown[]).includes(o.ownerKind)
    || (o.ownerKind === 'root' ? o.ownerId !== null : typeof o.ownerId !== 'string' || !IP_UUID.test(o.ownerId))
    || !(o.ptrHostname === null || typeof o.ptrHostname === 'string' && /^[a-z0-9.-]{1,253}$/i.test(o.ptrHostname)) || typeof o.isPrimary !== 'boolean') throw new Error('invalid_ip_entry')
  return { id: o.id, address: o.address, version: o.version, prefixLength: o.prefixLength, interfaceName: o.interfaceName, role: o.role as WhmIpEntry['role'],
    ownerKind: o.ownerKind as WhmIpEntry['ownerKind'], ownerId: o.ownerId as string | null, ptrHostname: o.ptrHostname as string | null, isPrimary: o.isPrimary }
}
export function readWhmIpPool(value: unknown): WhmIpEntry[] {
  const ips = value && typeof value === 'object' ? (value as { ips?: unknown }).ips : undefined
  if (!Array.isArray(ips) || ips.length > 4096) throw new Error('invalid_ip_pool')
  const pool = ips.map(readWhmIpEntry)
  if (new Set(pool.map(ip => ip.id)).size !== pool.length || new Set(pool.map(ip => ip.address)).size !== pool.length) throw new Error('invalid_ip_pool')
  return pool
}
/** Local shape check only; the API canonicalizes and validates the address, prefix and PTR name again. */
export function whmIpDraft(values: { address: unknown; prefixLength: unknown; role: unknown; ownerKind: unknown; ptrHostname: unknown }): WhmIpDraft {
  const text = (item: unknown): string => typeof item === 'string' ? item.trim() : ''
  const address = text(values.address), prefix = text(values.prefixLength), ptr = text(values.ptrHostname)
  if (!/^[0-9A-Fa-f:.]{2,45}$/.test(address) || !(address.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address))) throw new Error('invalid_ip_address')
  if (!/^[0-9]{1,3}$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (address.includes(':') ? 128 : 32)) throw new Error('invalid_ip_prefix')
  if (!(IP_ROLES as readonly unknown[]).includes(values.role)) throw new Error('invalid_ip_role')
  // The form has no owner picker; reseller/account entries need an owner ID the API requires.
  if (values.ownerKind !== 'root') throw new Error('ip_owner_unavailable')
  if (ptr && !/^[A-Za-z0-9.-]{1,253}$/.test(ptr)) throw new Error('invalid_ip_ptr')
  return { address, prefixLength: Number(prefix), role: values.role as WhmIpDraft['role'], ownerKind: 'root', ownerId: null, ptrHostname: ptr || null }
}

function bindWhmIps(askDialog: Ask | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-ip-pool]').forEach(root => {
    if (root.dataset.whmIpsBound === 'true') return
    root.dataset.whmIpsBound = 'true'
    const form = root.querySelector<HTMLFormElement>('[data-add-ip-form]'), body = root.querySelector<HTMLTableSectionElement>('[data-ip-pool-table] tbody')
    const formStatus = root.querySelector<HTMLElement>('[data-add-ip-status]'), poolStatus = root.querySelector<HTMLElement>('[data-ip-pool-status]')
    const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]')
    const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    if (!form || !body || !formStatus || !poolStatus || !submit) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const editable = (): boolean => root.isConnected && root.dataset.ipEditable === 'true' && !root.closest(denied) && typeof request === 'function'
    let busy = false, uncertain = false
    const note = (node: HTMLElement, state: string, message: string): void => { node.hidden = false; node.dataset.state = state; node.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status'); node.textContent = message }
    const counts = root.querySelectorAll<HTMLElement>('[data-ip-pool-count-label]')
    try {
      if (counts.length !== 1) throw new Error('ip_count_label_unavailable')
      const record = cloneViewRecord(root, 'whm-ip-row', 'tr', { address: '', version: '', interface: '', owner: '', ptr: '', 'remove-label': '' })
      viewAction(record, 'role', 'span'); viewAction(record, 'primary', 'span'); viewAction(record, 'remove')
      cloneViewRecord(root, 'whm-ip-empty', 'tr', { message: '' })
      for (const name of ['whm-ip-role-web', 'whm-ip-role-mail', 'whm-ip-primary', 'whm-ip-secondary']) cloneViewRecord(root, name, 'span', { label: '' })
    } catch {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true })
      note(formStatus, 'unavailable', t('Saving is unavailable. No changes were sent.')); return
    }
    const sync = (): void => {
      const blocked = busy || uncertain || !editable()
      submit.disabled = blocked
      body.querySelectorAll<HTMLButtonElement>('[data-ip-remove]').forEach(button => { button.disabled = blocked })
      root.setAttribute('aria-busy', String(busy))
    }
    const refusedForSure = (error: unknown): boolean => {
      const value = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>
      const details = (value.details && typeof value.details === 'object' ? value.details : {}) as Record<string, unknown>
      if ([value, details].some(part => part.unknownOutcome === true || part.verificationRequired === true)) return false
      return details.stateChanged === false || typeof value.status === 'number' && value.status >= 400 && value.status < 500 && value.status !== 408
    }
    const uncertainOutcome = (node: HTMLElement): void => { uncertain = true; note(node, 'uncertain', t('The outcome is uncertain. Reload the page and review the IP pool before retrying; no automatic retry was sent.')) }
    const row = (ip: WhmIpEntry): HTMLTableRowElement => {
      const tr = cloneViewRecord(root, 'whm-ip-row', 'tr', { address: ip.address + '/' + String(ip.prefixLength), version: 'IPv' + String(ip.version), interface: ip.interfaceName,
        owner: ip.ownerKind + (ip.ownerId ? ' (' + t(msgctxt('xwhm', 'Owner unavailable')) + ')' : ''), ptr: ip.ptrHostname ?? '—', 'remove-label': t('Remove') }) as HTMLTableRowElement
      tr.dataset.ipRow = ip.address; tr.dataset.ipId = ip.id
      viewAction(tr, 'role', 'span').replaceChildren(cloneViewRecord(root, ip.role === 'mail' ? 'whm-ip-role-mail' : 'whm-ip-role-web', 'span', { label: ip.role }))
      viewAction(tr, 'primary', 'span').replaceChildren(cloneViewRecord(root, ip.isPrimary ? 'whm-ip-primary' : 'whm-ip-secondary', 'span', { label: ip.isPrimary ? t('Primary') : t('Secondary') }))
      const remove = viewAction(tr, 'remove')
      if (ip.isPrimary) remove.hidden = true
      else { remove.dataset.ipRemove = ip.id; remove.dataset.ipAddress = ip.address; remove.setAttribute('aria-label', t('Remove {name}', { name: ip.address })) }
      return tr
    }
    const paint = (pool: WhmIpEntry[]): void => {
      // shortcut: a row that is still present keeps its server-rendered owner name; edits made elsewhere appear after a reload.
      const kept = new Map([...body.querySelectorAll<HTMLTableRowElement>('tr[data-ip-id]')].map(item => [item.dataset.ipId, item]))
      body.replaceChildren(...pool.map(ip => kept.get(ip.id) ?? row(ip)))
      if (!pool.length) body.append(cloneViewRecord(root, 'whm-ip-empty', 'tr', { message: t('No IP addresses are in the pool.') }))
      counts[0]!.textContent = t('{count, plural, one {{count} address} other {{count} addresses}}', { count: pool.length })
    }
    const readPool = async (): Promise<WhmIpEntry[]> => readWhmIpPool(await request!('GET', '/api/ips'))
    const add = async (): Promise<void> => {
      if (busy || uncertain || !editable() || !form.reportValidity()) return
      const field = (name: string): unknown => (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value
      let draft: WhmIpDraft
      try { draft = whmIpDraft({ address: field('address'), prefixLength: field('prefixLength'), role: field('role'), ownerKind: field('ownerKind'), ptrHostname: field('ptrHostname') }) }
      catch (error) {
        note(formStatus, 'failed', error instanceof Error && error.message === 'ip_owner_unavailable' ? t('This form adds server-wide addresses only. Choose root as the owner; nothing was sent.') : t('Enter an IPv4 or IPv6 address, a prefix length that fits it and an optional reverse DNS name. Nothing was sent.'))
        return
      }
      busy = true; sync(); note(formStatus, 'loading', t('Adding the address…'))
      try {
        const reply = await request!('POST', '/api/ips', draft)
        const saved = readWhmIpEntry(reply && typeof reply === 'object' ? (reply as { ip?: unknown }).ip : undefined)
        const plain = (name: string | null): string => (name ?? '').toLowerCase().replace(/\.$/, '')
        if (saved.prefixLength !== draft.prefixLength || saved.role !== draft.role || saved.ownerKind !== 'root' || saved.ownerId !== null || plain(saved.ptrHostname) !== plain(draft.ptrHostname)) throw new Error('ip_ack_mismatch')
        const pool = await readPool(), observed = pool.find(ip => ip.id === saved.id)
        if (!observed || JSON.stringify(observed) !== JSON.stringify(saved)) throw new Error('ip_not_observed')
        paint(pool); form.reset()
        note(formStatus, 'saved', t('The address was saved to the IP pool and read back. Its configuration on a network interface is not verified here.'))
      } catch (error) {
        if (refusedForSure(error)) note(formStatus, 'failed', t('The server refused the values. Nothing was changed; check the fields and try again.'))
        else uncertainOutcome(formStatus)
      } finally { busy = false; sync() }
    }
    const remove = async (button: HTMLButtonElement): Promise<void> => {
      const id = button.dataset.ipRemove ?? '', address = button.dataset.ipAddress ?? ''
      if (busy || uncertain || !editable() || button.disabled || !IP_UUID.test(id)) return
      if (typeof askDialog !== 'function') { note(poolStatus, 'failed', t('Removing an address needs confirmation; nothing was sent.')); return }
      busy = true; sync()
      try {
        if (await askDialog({ title: t('Remove IP address?'), body: address, confirm: t('Remove'), danger: true }) !== true || !editable()) { note(poolStatus, 'cancelled', t('Removal was cancelled. Nothing was sent.')); return }
        note(poolStatus, 'loading', t('Removing the address…'))
        const reply = await request!('DELETE', '/api/ips/' + id)
        if (!reply || typeof reply !== 'object' || (reply as { ok?: unknown }).ok !== true) throw new Error('ip_remove_ack')
        const pool = await readPool()
        if (pool.some(ip => ip.id === id)) throw new Error('ip_not_removed')
        paint(pool)
        note(poolStatus, 'saved', t('The address was removed and verified absent from the IP pool.'))
      } catch (error) {
        if (refusedForSure(error)) note(poolStatus, 'failed', t('The server refused the removal. A default or assigned address cannot be removed; nothing was changed.'))
        else uncertainOutcome(poolStatus)
      } finally { busy = false; sync() }
    }
    form.addEventListener('submit', event => { event.preventDefault(); void add() })
    body.addEventListener('click', event => { const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-ip-remove]') : null; if (button) void remove(button) })
    sync()
    if (!editable()) note(formStatus, 'unavailable', t('Changing the IP pool requires root authorization. Nothing was changed.'))
  })
}

export const WHM_IPS_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const IP_ROLES=${JSON.stringify(IP_ROLES)};const IP_OWNERS=${JSON.stringify(IP_OWNERS)};const IP_UUID=${IP_UUID.toString()};const readWhmIpEntry=${readWhmIpEntry.toString()};const readWhmIpPool=${readWhmIpPool.toString()};const whmIpDraft=${whmIpDraft.toString()};return ${bindWhmIps.toString()};})()`
