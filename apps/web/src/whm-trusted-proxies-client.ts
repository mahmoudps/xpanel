/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
export interface TrustedProxiesClientPolicy { cidrs: string[]; header: 'X-Forwarded-For' }
export interface TrustedProxiesClientView {
  state: 'default' | 'saved' | 'invalid'; policy: TrustedProxiesClientPolicy | null; updatedAt: string | null; revision: string; application: 'saved_only'
  observation: { state: 'read' | 'unavailable'; active: { state: 'read'; policy: TrustedProxiesClientPolicy; revision: string } | null; activation: 'available' | 'unavailable'; reason: string | null }
}
export function readTrustedProxiesClientView(value: unknown): TrustedProxiesClientView {
  const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
  const revision = (raw: unknown): raw is string => typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw)
  const policy = (raw: unknown): TrustedProxiesClientPolicy => {
    if (!object(raw) || Object.keys(raw).sort().join() !== 'cidrs,header' || raw.header !== 'X-Forwarded-For' || !Array.isArray(raw.cidrs) || raw.cidrs.length > 32 || new Set(raw.cidrs).size !== raw.cidrs.length || !raw.cidrs.every(cidr => typeof cidr === 'string' && cidr.length <= 64 && /^[0-9a-f:.]+\/[0-9]{1,3}$/.test(cidr))) throw new Error('unverified_proxy_policy')
    return { cidrs: [...raw.cidrs as string[]], header: 'X-Forwarded-For' }
  }
  if (!object(value) || Object.keys(value).sort().join() !== 'application,observation,policy,revision,state,updatedAt' || !['default', 'saved', 'invalid'].includes(value.state as string) || value.application !== 'saved_only' || !revision(value.revision) || !object(value.observation)) throw new Error('unverified_proxy_view')
  const selected = value.policy === null ? null : policy(value.policy), o = value.observation
  if (value.state === 'invalid' ? selected !== null || value.updatedAt !== null : selected === null) throw new Error('unverified_proxy_view')
  if (value.state === 'default' && (value.updatedAt !== null || selected!.cidrs.length !== 0)) throw new Error('unverified_proxy_view')
  if (value.state === 'saved' && (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) || new Date(value.updatedAt).toISOString() !== value.updatedAt)) throw new Error('unverified_proxy_view')
  if (Object.keys(o).sort().join() !== 'activation,active,reason,state') throw new Error('unverified_proxy_observation')
  let active: TrustedProxiesClientView['observation']['active'] = null
  if (o.state === 'read') {
    if (o.activation !== 'available' || o.reason !== null || !object(o.active) || Object.keys(o.active).sort().join() !== 'policy,revision,state' || o.active.state !== 'read' || !revision(o.active.revision)) throw new Error('unverified_proxy_observation')
    active = { state: 'read', policy: policy(o.active.policy), revision: o.active.revision }
  } else if (o.state !== 'unavailable' || o.activation !== 'unavailable' || o.active !== null || typeof o.reason !== 'string' || !/^[a-z_]{1,80}$/.test(o.reason)) throw new Error('unverified_proxy_observation')
  return { state: value.state as TrustedProxiesClientView['state'], policy: selected, updatedAt: value.updatedAt as string | null, revision: value.revision, application: 'saved_only', observation: { state: o.state as 'read' | 'unavailable', active, activation: o.activation as 'available' | 'unavailable', reason: o.reason as string | null } }
}
function bindWhmTrustedProxies(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-trusted-proxies-workspace]').forEach(root => {
    if (root.dataset.trustedProxiesBound === 'true') return
    root.dataset.trustedProxiesBound = 'true'
    const one = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const form = one<HTMLFormElement>('[data-trusted-proxies-form]'), status = one<HTMLElement>('[data-trusted-proxies-status]'), saveStatus = one<HTMLElement>('[data-trusted-proxies-save-status]'), applyStatus = one<HTMLElement>('[data-trusted-proxies-apply-status]')
    const input = one<HTMLTextAreaElement>('[data-trusted-proxies-cidrs]'), save = one<HTMLButtonElement>('[data-trusted-proxies-save]'), reload = one<HTMLButtonElement>('[data-trusted-proxies-reload]'), apply = one<HTMLButtonElement>('[data-trusted-proxies-apply]'), confirm = one<HTMLInputElement>('[data-trusted-proxies-confirm]'), rows = one<HTMLTableSectionElement>('[data-trusted-proxies-rows]')
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!form || !status || !saveStatus || !applyStatus || !input || !save || !reload || !apply || !confirm || !rows) return
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.trustedProxiesCanManage === 'true' && form.tagName === 'FORM' && !root.closest(denied) && typeof request === 'function'
    let view: TrustedProxiesClientView | null = null, busy = false
    const note = (target: HTMLElement, state: string, text: string): void => { target.hidden = false; target.dataset.state = state; target.textContent = text; target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const lock = (): void => { const editable = admitted() && !busy && view !== null && view.state !== 'invalid'; input.disabled = save.disabled = !editable; reload.disabled = busy || !admitted(); confirm.disabled = !editable || view?.state !== 'saved' || view.observation.activation !== 'available'; apply.disabled = confirm.disabled || confirm.value !== 'APPLY TRUSTED PROXIES'; root.setAttribute('aria-busy', String(busy)) }
    const field = (name: string, text: string, technical = false): void => { const node = one<HTMLElement>('[data-trusted-proxies-field="' + name + '"]'); if (!node) return; node.replaceChildren(); if (technical) { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = text; node.append(bdi) } else node.textContent = text }
    const paint = (next: TrustedProxiesClientView): void => {
      view = next; input.value = next.policy?.cidrs.join('\n') ?? ''; confirm.value = ''
      field('saved', next.policy ? String(next.policy.cidrs.length) : t('Unavailable'), !!next.policy)
      field('updated', next.updatedAt ? formatDisplayDateTime(next.updatedAt) : t(msgctxt('whm-trusted-proxies-client', 'Never saved')), !!next.updatedAt)
      field('active', next.observation.active ? t('Observed native configuration') : t('Unavailable; saved policy is not evidence of active trust'))
      field('activation', next.observation.activation === 'available' ? t('Protected provider available') : t('Unavailable; protected dedicated ingress and recovery are required'))
      rows.replaceChildren()
      for (const cidr of next.policy?.cidrs ?? []) { const row = document.createElement('tr'); for (const text of [cidr, 'X-Forwarded-For']) { const td = document.createElement('td'), bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = text; td.append(bdi); row.append(td) }; rows.append(row) }
      if (!rows.children.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 2; td.textContent = next.state === 'invalid' ? t('Saved policy needs review.') : t('No saved proxy networks. No proxy is trusted by this saved policy.'); row.append(td); rows.append(row) }
      note(status, next.state === 'invalid' ? 'failed' : 'read', next.state === 'invalid' ? t('Saved configuration could not be verified. Editing is locked pending review.') : t('Saved configuration read. Saving never changes active listener trust.'))
    }
    const failed = (error: unknown): string => { const value = error as { status?: number; details?: { stateChanged?: boolean; verificationRequired?: boolean; rolledBack?: boolean } }; return value?.details?.rolledBack ? t('Activation failed and the previous configuration was restored. Reload before retrying.') : value?.details?.stateChanged || value?.details?.verificationRequired ? t('The outcome requires review. Reload before attempting another change.') : value?.status === 409 ? t('Configuration changed. Reload before saving or applying.') : value?.status === 412 ? t('Protected ingress, recovery or observation is unavailable. No activation is claimed.') : t('The operation could not be verified. Reload before retrying.') }
    const load = async (): Promise<void> => { if (busy || !admitted() || !request) return; busy = true; view = null; lock(); note(status, 'reading', t('Reading proxy configuration…')); try { paint(readTrustedProxiesClientView(await request('GET', '/api/server/trusted-proxies'))) } catch (error) { note(status, 'failed', failed(error)) } finally { busy = false; lock() } }
    if (!admitted()) { lock(); note(status, 'unavailable', t('Trusted proxy configuration is unavailable here. Nothing was read or changed.')); return }
    reload.addEventListener('click', () => { saveStatus.hidden = applyStatus.hidden = true; void load() }); confirm.addEventListener('input', lock)
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || !view || view.state === 'invalid' || !admitted() || !request) return
      const cidrs = input.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).sort()
      if (cidrs.length > 32 || new Set(cidrs).size !== cidrs.length || !cidrs.every(cidr => /^[0-9a-f:.]+\/[0-9]{1,3}$/.test(cidr) && cidr.length <= 64)) { note(saveStatus, 'failed', t('Enter up to 32 distinct canonical CIDRs, one per line.')); return }
      const policy: TrustedProxiesClientPolicy = { cidrs, header: 'X-Forwarded-For' }, revision = view.revision
      busy = true; lock(); note(saveStatus, 'reading', t('Saving policy without activation…'))
      try { const ack = readTrustedProxiesClientView(await request('PUT', '/api/server/trusted-proxies', { policy, expectedRevision: revision })); if (ack.state !== 'saved' || JSON.stringify(ack.policy) !== JSON.stringify(policy)) throw new Error('save_unverified'); const next = readTrustedProxiesClientView(await request('GET', '/api/server/trusted-proxies')); if (next.revision !== ack.revision || JSON.stringify(next.policy) !== JSON.stringify(policy)) throw new Error('save_readback_unverified'); paint(next); note(saveStatus, 'read', t('Policy saved and read back. Active trust was not changed.')) } catch (error) { view = null; note(saveStatus, 'failed', failed(error)) } finally { busy = false; lock() }
    })
    apply.addEventListener('click', async () => {
      if (busy || !view || view.state !== 'saved' || !view.observation.active || apply.disabled || confirm.value !== 'APPLY TRUSTED PROXIES' || !admitted() || !request) return
      const selected = view; busy = true; lock(); note(applyStatus, 'reading', t('Applying saved policy through the protected provider…'))
      try { const ack = await request('POST', '/api/server/trusted-proxies/apply', { expectedRevision: selected.revision, expectedActiveRevision: selected.observation.active!.revision }) as { active?: { policy?: unknown; revision?: unknown }; savedRevision?: unknown; stateChanged?: unknown; verificationRequired?: unknown }; if (ack?.savedRevision !== selected.revision || ack.stateChanged !== true || ack.verificationRequired !== false || JSON.stringify(ack.active?.policy) !== JSON.stringify(selected.policy)) throw new Error('apply_unverified'); const next = readTrustedProxiesClientView(await request('GET', '/api/server/trusted-proxies')); if (next.revision !== selected.revision || !next.observation.active || next.observation.active.revision !== ack.active?.revision || JSON.stringify(next.observation.active.policy) !== JSON.stringify(selected.policy)) throw new Error('active_readback_unverified'); paint(next); note(applyStatus, 'read', t('The protected provider verified the active saved policy and management access.')) } catch (error) { view = null; note(applyStatus, 'failed', failed(error)) } finally { busy = false; lock() }
    })
    void load()
  })
}
export const WHM_TRUSTED_PROXIES_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readTrustedProxiesClientView=${readTrustedProxiesClientView.toString()};return ${bindWhmTrustedProxies.toString()};})()`
