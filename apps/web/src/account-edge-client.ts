import { VIEW_RECORD_HELPERS, cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction } from './workspace-view-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction
/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

export interface IpBlockerClientView {
  context: { accountId: string; username: string }; state: 'default' | 'saved' | 'invalid'; revision: string; limit: number; updatedAt: string | null
  entries: { entry: string; first: string; last: string }[]; reconcile?: 'requested' | 'failed' | 'not_connected' | 'unknown'
}
export interface EdgeCacheClientView {
  context: { accountId: string; username: string }; state: 'default' | 'saved' | 'invalid'; revision: string; enabled: boolean | null; purgedAt: string | null; updatedAt: string | null
  reconcile?: 'requested' | 'failed' | 'not_connected' | 'unknown'
}

/** Shape checks of the account edge replies; the API owns the grammar and the agent renders only saved files. */
export function readAccountEdgeView(value: unknown, kind: 'ip-blocker' | 'cache', accountId: string): IpBlockerClientView | EdgeCacheClientView {
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const iso = (item: unknown): boolean => item === null || typeof item === 'string' && item.length <= 40 && Number.isFinite(Date.parse(item))
  const address = (item: unknown): boolean => typeof item === 'string' && item.length <= 64 && /^[0-9a-f.:/]+$/.test(item)
  const bad = (): never => { throw new Error('invalid_account_edge_view') }
  if (!object(value) || !object(value.context) || value.context.accountId !== accountId || typeof value.context.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(value.context.username)
    || !['default', 'saved', 'invalid'].includes(value.state) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || !iso(value.updatedAt)
    || value.reconcile !== undefined && !['requested', 'failed', 'not_connected', 'unknown'].includes(value.reconcile)) return bad()
  if (kind === 'cache') return typeof value.enabled === 'boolean' || value.enabled === null && value.state === 'invalid' ? iso(value.purgedAt) ? value as EdgeCacheClientView : bad() : bad()
  if (!Number.isSafeInteger(value.limit) || value.limit < 1 || !Array.isArray(value.entries) || value.entries.length > value.limit
    || value.entries.some((item: unknown) => !object(item) || Object.keys(item).sort().join() !== 'entry,first,last' || !address(item.entry) || !address(item.first) || !address(item.last))) return bad()
  return value as IpBlockerClientView
}

function bindAccountEdge(askDialog: unknown, parse: typeof readAccountEdgeView): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const confirm = typeof askDialog === 'function' ? askDialog as (options: Record<string, unknown>) => Promise<unknown> : null
  const blocked = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const FIELD: Record<string, string> = {
    address: msgid('Use an IPv4 or IPv6 address, a range such as 10.5.3.3-40, a CIDR block such as 192.0.2.0/24, a prefix such as 10. or a host name.'),
    protected_address: msgid('Loopback addresses that the server uses to reach its own sites cannot be blocked.'), range: msgid('The range ends before it starts.'),
    too_many: msgid('There are too many blocks. Use a larger CIDR block or remove entries first.'), duplicate: msgid('This address or range is already blocked.'),
    unresolved: msgid('The host name could not be resolved to an address.'), not_found: msgid('This block is no longer saved. Read the list again.'),
  }
  const APPLIED: Record<string, string> = {
    requested: msgid('Saved. The server is applying the change to your sites.'), failed: msgid('Saved, but applying the server configuration failed; the previous configuration stays active.'),
    not_connected: msgid('Saved. No host agent is connected, so nothing is applied yet.'), unknown: msgid('Saved. Whether the server applied the change is unknown; read again later.'),
  }
  const note = (status: HTMLElement, state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
  const failure = (error: unknown): { field: string; code: string } | null => {
    const details = error && typeof error === 'object' && (error as Record<string, any>).details
    const fields = details && Array.isArray(details.fields) ? details.fields : []
    return fields.length && typeof fields[0]?.code === 'string' ? fields[0] : null
  }
  const uncertain = (error: unknown): boolean => { const value = error && typeof error === 'object' ? error as Record<string, any> : {}, details = value.details && typeof value.details === 'object' ? value.details : {}; return details.stateChanged !== false }
  document.querySelectorAll<HTMLElement>('[data-ip-blocker]').forEach(root => {
    if (root.dataset.ipbBound === 'true') return
    root.dataset.ipbBound = 'true'
    const input = root.querySelector<HTMLInputElement>('[data-ipb-input]'), add = root.querySelector<HTMLButtonElement>('[data-ipb-add]'), refresh = root.querySelector<HTMLButtonElement>('[data-ipb-refresh]')
    const status = root.querySelector<HTMLElement>('[data-ipb-status]'), rows = root.querySelector<HTMLElement>('[data-ipb-rows]'), error = root.querySelector<HTMLElement>('[data-ipb-error]'), count = root.querySelector<HTMLElement>('[data-ipb-count]')
    if (!input || !add || !refresh || !status || !rows || !error || !count) return
    try { cloneViewRecord(root, 'ip-blocker-row', 'tr', { entry: '', first: '', last: '', 'remove-label': '' }); cloneViewRecord(root, 'ip-blocker-empty', 'tr', { message: '' }) }
    catch { root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(control => { control.disabled = true }); note(status, 'unavailable', t('The IP blocker is unavailable here. Nothing was read or changed.')); return }
    const accountId = root.dataset.ipbAccount ?? ''
    const admitted = (): boolean => root.isConnected && root.dataset.ipbManage === 'true' && !root.closest(blocked) && typeof transport === 'function'
    let view: IpBlockerClientView | null = null, busy = false, review = false
    const paint = (): void => {
      const ready = !busy && !review && admitted() && view !== null && view.state !== 'invalid'
      input.disabled = !ready; add.disabled = !ready; refresh.disabled = busy || !admitted()
      rows.textContent = ''
      for (const item of view?.entries ?? []) {
        const row = cloneViewRecord(root, 'ip-blocker-row', 'tr', { entry: item.entry, first: item.first, last: item.last, 'remove-label': t('Remove') })
        const remove = viewAction(row, 'remove'); remove.disabled = !ready
        remove.addEventListener('click', () => { void change({ remove: item.entry }, item.entry) })
        rows.append(row)
      }
      if (!rows.childElementCount) rows.append(cloneViewRecord(root, 'ip-blocker-empty', 'tr', { message: view ? t('No addresses are blocked.') : t('Not read.') }))
      count.textContent = view ? t('{count, plural, one {# block} other {# blocks}} of {limit}', { count: view.entries.length, limit: view.limit }) : t('Not read')
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; paint(); note(status, 'reading', t('Reading the blocked addresses…'))
      try { view = parse(await transport!('GET', '/api/account/ip-blocker'), 'ip-blocker', accountId) as IpBlockerClientView; review = false; note(status, view.state === 'invalid' ? 'failed' : 'read', view.state === 'invalid' ? t('The saved list needs review by the server administrator. Nothing can be changed here.') : t('The blocked addresses were read from the saved list.')) }
      catch { view = null; note(status, 'failed', t('The blocked addresses could not be read. Nothing was changed.')) }
      finally { busy = false; paint() }
    }
    const change = async (body: { add: string } | { remove: string }, label: string): Promise<void> => {
      if (busy || review || !view || !admitted()) return
      if ('remove' in body && confirm && await confirm({ title: t('Remove this block?'), body: label + '\n' + t('Requests from these addresses reach your sites again after the server applies the change.'), confirm: t('Remove'), danger: true }) !== true) return
      busy = true; error.hidden = true; paint(); note(status, 'saving', t('Saving…'))
      let sent = false
      try {
        sent = true
        view = parse(await transport!('POST', '/api/account/ip-blocker', { expectedRevision: view.revision, ...body }), 'ip-blocker', accountId) as IpBlockerClientView
        if ('add' in body) input.value = ''
        note(status, view.reconcile === 'requested' ? 'saved' : 'warning', t(APPLIED[view.reconcile ?? 'unknown'] ?? APPLIED.unknown!))
      } catch (reason) {
        const refused = failure(reason)
        if (refused) { error.textContent = t(FIELD[refused.code] ?? FIELD.address!); error.hidden = false; note(status, 'fields', t('The change was refused. Nothing was saved.')) }
        else if ((reason as Record<string, any>)?.status === 409 || sent && uncertain(reason)) { review = true; note(status, 'uncertain', t('The outcome needs review. No retry was sent. Read the list again before continuing.')) }
        else note(status, 'failed', t('The change was refused. Nothing was saved.'))
      } finally { busy = false; paint() }
    }
    if (!admitted()) { paint(); refresh.disabled = true; note(status, 'unavailable', t('The IP blocker is unavailable here. Nothing was read or changed.')); return }
    add.addEventListener('click', () => { const value = input.value.trim(); if (!value) { error.textContent = t('Enter an address, range or host name.'); error.hidden = false; return } void change({ add: value }, value) })
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); add.click() } })
    refresh.addEventListener('click', () => { review = false; void load() })
    void load()
  })
  document.querySelectorAll<HTMLElement>('[data-edge-cache]').forEach(root => {
    if (root.dataset.ecBound === 'true') return
    root.dataset.ecBound = 'true'
    const purge = root.querySelector<HTMLButtonElement>('[data-edge-cache-purge]'), toggle = root.querySelector<HTMLButtonElement>('[data-edge-cache-toggle]'), status = root.querySelector<HTMLElement>('[data-edge-cache-status]')
    const state = root.querySelector<HTMLElement>('[data-edge-cache-state]'), purged = root.querySelector<HTMLElement>('[data-edge-cache-purged]')
    if (!purge || !toggle || !status || !state || !purged) return
    const accountId = root.dataset.ecAccount ?? ''
    const admitted = (): boolean => root.isConnected && root.dataset.ecManage === 'true' && !root.closest(blocked) && typeof transport === 'function'
    let view: EdgeCacheClientView | null = null, busy = false, review = false
    const stamp = (iso: string): string => iso.slice(0, 10) + ' ' + iso.slice(11, 16) + ' UTC'
    const paint = (): void => {
      const ready = !busy && !review && admitted() && view !== null && view.enabled !== null
      purge.disabled = !ready || view?.enabled !== true; toggle.disabled = !ready
      toggle.textContent = view?.enabled === false ? t('Turn the cache on') : t('Turn the cache off')
      state.textContent = !view ? t('Not read') : view.enabled === null ? t('Needs review') : view.enabled ? t('On for your sites') : t('Off for your sites')
      purged.textContent = !view ? t('Not read') : view.purgedAt ? stamp(view.purgedAt) : t('Never')
    }
    const send = async (op: 'purge' | 'enable' | 'disable'): Promise<void> => {
      if (busy || review || !view || !admitted()) return
      if (confirm && await confirm(op === 'purge' ? { title: t('Purge the cache?'), body: t('Every cached response of your sites is dropped. The next visit to each page asks your site again.'), confirm: t('Purge cache') }
        : { title: op === 'enable' ? t('Turn the cache on?') : t('Turn the cache off?'), body: op === 'enable' ? t('Eligible responses of your sites are cached by the server edge again.') : t('Every request reaches your sites; responses are no longer cached.'), confirm: t('Confirm') }) !== true) return
      busy = true; paint(); note(status, 'saving', t('Saving…'))
      try { view = parse(await transport!('POST', '/api/account/edge-cache', { expectedRevision: view.revision, op }), 'cache', accountId) as EdgeCacheClientView; note(status, view.reconcile === 'requested' ? 'saved' : 'warning', t(APPLIED[view.reconcile ?? 'unknown'] ?? APPLIED.unknown!)) }
      catch (reason) { review = (reason as Record<string, any>)?.status === 409 || uncertain(reason); note(status, review ? 'uncertain' : 'failed', review ? t('The outcome needs review. No retry was sent. Read the page again before continuing.') : t('The change was refused. Nothing was saved.')) }
      finally { busy = false; paint() }
    }
    if (!admitted()) { paint(); note(status, 'unavailable', t('Cache control is unavailable here. Nothing was read or changed.')); return }
    purge.addEventListener('click', () => { void send('purge') })
    toggle.addEventListener('click', () => { void send(view?.enabled === false ? 'enable' : 'disable') })
    busy = true; paint(); note(status, 'reading', t('Reading the cache settings…'))
    void (async () => {
      try { view = parse(await transport!('GET', '/api/account/edge-cache'), 'cache', accountId) as EdgeCacheClientView; note(status, view.enabled === null ? 'failed' : 'read', view.enabled === null ? t('The saved cache settings need review by the server administrator.') : t('The cache settings were read from the saved configuration.')) }
      catch { note(status, 'failed', t('The cache settings could not be read. Nothing was changed.')) }
      finally { busy = false; paint() }
    })()
  })
}
export const ACCOUNT_EDGE_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const parse=${readAccountEdgeView.toString()};const bind=${bindAccountEdge.toString()};return (askDialog)=>bind(askDialog,parse);})()`
