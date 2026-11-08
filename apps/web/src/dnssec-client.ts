import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />

/**
 * DNSSEC browser controller for the zone editor. Reads and changes one zone through
 * `/api/dns/zones/<zone>/dnssec`; key state, DS records and signing come only from the host reply.
 */
export interface DnssecClientKey { id: number; type: 'KSK' | 'ZSK' | 'CSK'; active: boolean; published: boolean; algorithm: string; tag: number; ds: { keyTag: number; algorithm: number; digestType: number; digest: string }[] }
export interface DnssecClientState {
  zone: string; store: 'ready' | 'unconfigured'; served: boolean; signing: 'unsigned' | 'signed' | 'pending'; publication: 'none' | 'current' | 'pending'
  nsec: { mode: 'nsec' | 'nsec3'; optOut: boolean } | null; observedAt: string; keys: DnssecClientKey[]
  rollovers: { keyId: number; newKeyId: number; type: 'KSK' | 'ZSK' | 'CSK'; notBefore: string; ready: boolean }[]
}
/** Choices both themes render; the controller sends the value, the host validates it again. */

type DnssecStatusKind = 'reading' | 'read' | 'saving' | 'saved' | 'failed' | 'uncertain' | 'unavailable'

export function dnssecObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
/** Accepts only the pinned workspace reply for the selected zone. */
export function dnssecState(value: unknown, zone: string): DnssecClientState {
  if (!dnssecObject(value) || !dnssecObject(value.view) || !Array.isArray(value.rollovers)) throw new Error('invalid_dnssec')
  const v = value.view
  if (v.zone !== zone || !['ready', 'unconfigured'].includes(v.store as string) || typeof v.served !== 'boolean' || !['unsigned', 'signed', 'pending'].includes(v.signing as string)
    || !['none', 'current', 'pending'].includes(v.publication as string) || typeof v.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v.observedAt) || !Array.isArray(v.keys)) throw new Error('invalid_dnssec')
  const nsec = v.nsec === null ? null : dnssecObject(v.nsec) && (v.nsec.mode === 'nsec' || v.nsec.mode === 'nsec3') && typeof v.nsec.optOut === 'boolean' ? { mode: v.nsec.mode as 'nsec' | 'nsec3', optOut: v.nsec.optOut } : null
  const keys = v.keys.map(key => {
    if (!dnssecObject(key) || !Number.isSafeInteger(key.id) || !['KSK', 'ZSK', 'CSK'].includes(key.type as string) || typeof key.active !== 'boolean' || typeof key.published !== 'boolean'
      || typeof key.algorithm !== 'string' || !/^[A-Z0-9-]{2,32}$/.test(key.algorithm) || !Number.isSafeInteger(key.tag) || !Array.isArray(key.ds)) throw new Error('invalid_dnssec')
    const ds = key.ds.map(item => {
      if (!dnssecObject(item) || item.keyTag !== key.tag || !Number.isSafeInteger(item.algorithm) || ![2, 4].includes(item.digestType as number) || typeof item.digest !== 'string' || !/^[0-9A-F]{64,96}$/.test(item.digest)) throw new Error('invalid_dnssec')
      return { keyTag: item.keyTag as number, algorithm: item.algorithm as number, digestType: item.digestType as number, digest: item.digest }
    })
    return { id: key.id as number, type: key.type as DnssecClientKey['type'], active: key.active, published: key.published, algorithm: key.algorithm, tag: key.tag as number, ds }
  })
  const rollovers = value.rollovers.map(item => {
    if (!dnssecObject(item) || !Number.isSafeInteger(item.keyId) || !Number.isSafeInteger(item.newKeyId) || !['KSK', 'ZSK', 'CSK'].includes(item.type as string) || typeof item.notBefore !== 'string' || typeof item.ready !== 'boolean') throw new Error('invalid_dnssec')
    return { keyId: item.keyId as number, newKeyId: item.newKeyId as number, type: item.type as DnssecClientKey['type'], notBefore: item.notBefore, ready: item.ready }
  })
  return { zone, store: v.store as DnssecClientState['store'], served: v.served, signing: v.signing as DnssecClientState['signing'], publication: v.publication as DnssecClientState['publication'], nsec, observedAt: v.observedAt, keys, rollovers }
}
/** `YYYY-MM-DD HH:mm UTC` with ASCII digits. */
export function dnssecUtc(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ') + ' UTC'
}
/** Registrar DS lines, one per digest, from the host's computed records. */
export function dnssecDsLines(state: DnssecClientState): string[] {
  return state.keys.flatMap(key => key.ds.map(ds => `${state.zone}. IN DS ${ds.keyTag} ${ds.algorithm} ${ds.digestType} ${ds.digest}`))
}
/** The actions offered per key; the host still refuses unsafe ones with a stable reason. */
export function dnssecKeyActions(key: DnssecClientKey, state: DnssecClientState): ('activate' | 'deactivate' | 'publish' | 'unpublish' | 'remove' | 'rollover')[] {
  const rolling = state.rollovers.some(item => item.keyId === key.id || item.newKeyId === key.id)
  return [...(key.active ? ['deactivate' as const] : key.published ? ['activate' as const, 'unpublish' as const] : ['publish' as const]),
    ...(!key.active ? ['remove' as const] : []), ...(key.active && !rolling ? ['rollover' as const] : [])]
}

function bindDnssec(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const copy = (message: string, values?: MessageValues): string => xpT(message, values)
  void askDialog
  const reasons: Record<string, string> = {
    dnssec_key_store_unavailable: copy('This DNS server has no DNSSEC key store, so zones cannot be signed here.'),
    zone_not_published: copy('The local DNS server does not serve this zone yet. Save the zone and try again.'),
    last_active_key: copy('This is the last active signing key. Add another key first, or turn DNSSEC off.'),
    active_key_unpublished: copy('An active key must stay published.'),
    key_unpublished: copy('Publish the key before activating it.'),
    dnssec_key_limit: copy('The zone already holds the maximum of 6 keys.'),
    rollover_wait: copy('Resolvers may still cache the old keys. Finish the rollover after the time shown.'),
    rollover_ds_unconfirmed: copy('Confirm that the registrar publishes the new DS record first.'),
    rollover_unpublished: copy('The DNS server does not publish the new key yet. Refresh in a minute.'),
    dnssec_already_enabled: copy('DNSSEC is already on for this zone.'),
  }
  document.querySelectorAll<HTMLElement>('[data-dnssec]').forEach(root => {
    if (root.dataset.dnssecBound === 'true') return
    root.dataset.dnssecBound = 'true'
    const zoneSelect = root.querySelector<HTMLSelectElement>('select[data-dnssec-zone]')
    const status = root.querySelector<HTMLElement>('[data-dnssec-status]')
    const rows = root.querySelector<HTMLTableSectionElement>('tbody[data-dnssec-keys]')
    const rollRows = root.querySelector<HTMLTableSectionElement>('tbody[data-dnssec-rollovers]')
    const dsBlock = root.querySelector<HTMLElement>('[data-dnssec-ds]')
    const algorithm = root.querySelector<HTMLSelectElement>('select[data-dnssec-algorithm]')
    const layout = root.querySelector<HTMLSelectElement>('select[data-dnssec-layout]')
    const addType = root.querySelector<HTMLSelectElement>('select[data-dnssec-add-type]')
    const nsecMode = root.querySelector<HTMLSelectElement>('select[data-dnssec-nsec-mode]')
    const confirm = root.querySelector<HTMLInputElement>('input[data-dnssec-disable-confirm]')
    const dsUpdated = root.querySelector<HTMLInputElement>('input[data-dnssec-ds-updated]')
    const facts = { signing: root.querySelector<HTMLElement>('[data-dnssec-signing]'), publication: root.querySelector<HTMLElement>('[data-dnssec-publication]'), nsec: root.querySelector<HTMLElement>('[data-dnssec-nsec]'), observed: root.querySelector<HTMLElement>('[data-dnssec-observed]') }
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!zoneSelect || !status || !rows || !rollRows || !dsBlock) return
    const eligible = (): boolean => root.isConnected && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled') && /^[a-z0-9.-]{1,253}$/.test(zoneSelect.value)
    const controls = (): (HTMLButtonElement | HTMLInputElement | HTMLSelectElement)[] => [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')]
    let state: DnssecClientState | null = null, busy = false, uncertain = false
    const setStatus = (message: string, kind: DnssecStatusKind): void => {
      status.hidden = !message; status.dataset.state = kind
      status.setAttribute('role', kind === 'failed' || kind === 'uncertain' ? 'alert' : 'status')
      status.textContent = message
    }
    const lock = (): void => {
      const blocked = busy || uncertain || !eligible() || state === null || state.store !== 'ready' || !state.served
      controls().forEach(control => { control.disabled = control === zoneSelect ? busy || uncertain : control.hasAttribute('data-dnssec-refresh') ? busy : blocked })
      const enable = root.querySelector<HTMLButtonElement>('button[data-dnssec-enable]')
      if (enable && state) enable.disabled = blocked || state.keys.length > 0
    }
    const route = (): string => '/api/dns/zones/' + encodeURIComponent(zoneSelect.value) + '/dnssec'
    const label = (key: DnssecClientKey): string => (key.active ? copy('Active') : copy('Inactive')) + ', ' + (key.published ? copy('Published') : copy('Not published'))
    const actionLabels: Record<string, string> = { activate: copy('Activate'), deactivate: copy('Deactivate'), publish: copy('Publish'), unpublish: copy('Unpublish'), remove: copy('Remove key'), rollover: copy('Roll over') }
    const paint = (): void => {
      rows.textContent = ''; rollRows.textContent = ''
      const s = state
      if (facts.signing) facts.signing.textContent = !s ? copy('Not read') : s.store !== 'ready' ? copy('Unavailable') : s.signing === 'signed' ? copy('Signed') : s.signing === 'pending' ? copy('Signing in progress') : copy('Not signed')
      if (facts.publication) facts.publication.textContent = !s || s.publication === 'none' ? copy('No keys') : s.publication === 'current' ? copy('All keys published') : copy('Waiting for the DNS server key cache')
      if (facts.nsec) facts.nsec.textContent = !s?.nsec ? copy('Not read') : s.nsec.mode === 'nsec' ? 'NSEC' : s.nsec.optOut ? copy('NSEC3 with opt-out') : 'NSEC3'
      if (facts.observed) facts.observed.textContent = s ? dnssecUtc(s.observedAt) : copy('Not read')
      for (const key of s?.keys ?? []) {
        const row = cloneClientTemplate(clientTemplate(root, 'dnssec-key'), 'tr', ['id', 'type', 'algorithm', 'tag', 'state', 'actions'])
        clientTemplateSlot(row, 'id').textContent = String(key.id)
        clientTemplateSlot(row, 'type').textContent = key.type
        clientTemplateSlot(row, 'algorithm').textContent = key.algorithm
        clientTemplateSlot(row, 'tag').textContent = String(key.tag)
        clientTemplateSlot(row, 'state').textContent = label(key)
        const box = clientTemplateSlot(row, 'actions', 'div')
        for (const action of dnssecKeyActions(key, s!)) {
          const button = cloneClientTemplate(clientTemplate(root, 'dnssec-action'), 'button', []) as HTMLButtonElement
          button.textContent = actionLabels[action]!
          button.setAttribute('aria-label', actionLabels[action] + ': ' + key.type + ' ' + key.tag)
          button.addEventListener('click', () => { void (action === 'rollover' ? change({ op: 'rollover-start', keyId: key.id }) : change({ op: 'key', verb: action, keyId: key.id })) })
          box.appendChild(button)
        }
        rows.appendChild(row)
      }
      if (!s?.keys.length) {
        const row = cloneClientTemplate(clientTemplate(root, 'dnssec-empty'), 'tr', ['message'])
        clientTemplateSlot(row, 'message').textContent = !s ? copy('DNSSEC keys have not been read.') : s.store !== 'ready' ? copy('This DNS server has no DNSSEC key store, so zones cannot be signed here.') : copy('This zone is not signed.')
        rows.appendChild(row)
      }
      for (const item of s?.rollovers ?? []) {
        const row = cloneClientTemplate(clientTemplate(root, 'dnssec-rollover'), 'tr', ['keys', 'type', 'not-before', 'action'])
        clientTemplateSlot(row, 'keys').textContent = item.keyId + ' > ' + item.newKeyId
        clientTemplateSlot(row, 'type').textContent = item.type
        clientTemplateSlot(row, 'not-before').textContent = dnssecUtc(item.notBefore)
        const finish = clientTemplateSlot(row, 'action', 'button') as HTMLButtonElement
        finish.textContent = item.type === 'ZSK' ? copy('Switch signing to the new key') : copy('Remove the old key')
        finish.addEventListener('click', () => { void change({ op: 'rollover-finish', keyId: item.keyId, newKeyId: item.newKeyId, ...(item.type === 'ZSK' ? {} : { dsUpdated: dsUpdated?.checked === true }) }) })
        rollRows.appendChild(row)
      }
      const lines = s ? dnssecDsLines(s) : []
      dsBlock.textContent = lines.length ? lines.join('\n') : copy('No DS record is published yet.')
      if (nsecMode && s?.nsec) nsecMode.value = s.nsec.mode === 'nsec' ? 'nsec' : s.nsec.optOut ? 'nsec3-optout' : 'nsec3'
      lock()
    }
    const read = async (): Promise<void> => {
      if (busy) return
      busy = true; lock(); setStatus(copy('Reading DNSSEC keys…'), 'reading')
      try {
        state = dnssecState(await transport!('GET', route()), zoneSelect.value); paint()
        setStatus(state.store !== 'ready' ? copy('This DNS server has no DNSSEC key store, so zones cannot be signed here.') : !state.served ? copy('The local DNS server does not serve this zone yet. Save the zone and try again.') : copy('DNSSEC keys read from the DNS server.'), state.store === 'ready' && state.served ? 'read' : 'unavailable')
      } catch { state = null; paint(); setStatus(copy('DNSSEC keys could not be read. Nothing was changed.'), 'failed') }
      finally { busy = false; lock() }
    }
    const change = async (body: Record<string, unknown>): Promise<void> => {
      if (busy || uncertain || !state || !eligible()) return
      busy = true; lock(); setStatus(copy('Applying the DNSSEC change…'), 'saving')
      try {
        state = dnssecState(await transport!('POST', route(), body), zoneSelect.value); paint()
        setStatus(state.publication === 'pending' ? copy('Saved in the key store. The DNS server publishes the change within a minute; refresh to check.') : copy('Saved and read back from the DNS server.'), 'saved')
      } catch (error) {
        const detail = dnssecObject(error) && dnssecObject(error.details) ? error.details : {}
        const certain = detail.stateChanged === false && detail.verificationRequired !== true && detail.unknownOutcome !== true
        if (!certain) { uncertain = true; setStatus(copy('The DNSSEC change outcome is uncertain. Refresh and inspect the keys before retrying; nothing was retried.'), 'uncertain') }
        else setStatus(typeof detail.reason === 'string' && reasons[detail.reason] ? reasons[detail.reason]! : copy('The DNSSEC change was refused. Nothing was changed.'), 'failed')
      } finally { busy = false; lock() }
    }
    if (typeof transport !== 'function' || !eligible()) {
      controls().forEach(control => { control.disabled = true })
      setStatus(copy('DNSSEC is unavailable here. No keys were read or changed.'), 'unavailable')
      return
    }
    zoneSelect.addEventListener('change', () => { uncertain = false; state = null; paint(); void read() })
    root.querySelector('button[data-dnssec-refresh]')?.addEventListener('click', () => { uncertain = false; void read() })
    root.querySelector('button[data-dnssec-enable]')?.addEventListener('click', () => { void change({ op: 'enable', algorithm: algorithm?.value ?? 'ecdsa256', layout: layout?.value ?? 'csk' }) })
    root.querySelector('button[data-dnssec-add-key]')?.addEventListener('click', () => { void change({ op: 'add-key', type: addType?.value === 'ksk' ? 'ksk' : 'zsk', algorithm: algorithm?.value ?? 'ecdsa256', active: false }) })
    root.querySelector('button[data-dnssec-nsec-save]')?.addEventListener('click', () => { const mode = nsecMode?.value ?? 'nsec'; void change({ op: 'nsec', mode: mode === 'nsec' ? 'nsec' : 'nsec3', optOut: mode === 'nsec3-optout' }) })
    root.querySelector('button[data-dnssec-disable]')?.addEventListener('click', () => {
      if (confirm?.value.trim().toLowerCase() !== zoneSelect.value) { setStatus(copy('Type the zone name to turn DNSSEC off. Nothing was sent.'), 'failed'); return }
      void change({ op: 'disable', confirm: zoneSelect.value })
    })
    paint()
    void read()
  })
}

export const DNSSEC_CLIENT_BINDING = `(function(askDialog){const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const dnssecObject=${dnssecObject.toString()};const dnssecState=${dnssecState.toString()};const dnssecUtc=${dnssecUtc.toString()};const dnssecDsLines=${dnssecDsLines.toString()};const dnssecKeyActions=${dnssecKeyActions.toString()};(${bindDnssec.toString()})(askDialog);})`
