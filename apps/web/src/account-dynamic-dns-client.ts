import type { MessageValues } from './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
const DDNS_ID = /^ddns_[A-Za-z0-9_-]{22}$/
const DDNS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ddnsObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const ddnsHost = (value: unknown): value is string => typeof value === 'string' && value.length <= 253 && value.includes('.') && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
const ddnsStamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
export interface DynamicDnsClientEntry { id: string; hostname: string; zone: string; type: 'A' | 'AAAA'; description: string; createdAt: string; updatedAt: string; lastChangedAt: string | null; pending: boolean }
export interface DynamicDnsClientView { context: { accountId: string }; revision: string; entries: DynamicDnsClientEntry[]; zones: { name: string }[]; limit: number; issued?: { id: string; secret: string } }
export function readDynamicDnsView(raw: unknown, accountId: string, expectIssue: boolean, expectedId?: string): DynamicDnsClientView {
  const bad = (): never => { throw new Error('invalid_dynamic_dns_reply') }
  if (!DDNS_UUID.test(accountId) || !ddnsObject(raw) || Object.keys(raw).sort().join() !== (expectIssue ? 'context,entries,issued,limit,revision,zones' : 'context,entries,limit,revision,zones')
    || !ddnsObject(raw.context) || Object.keys(raw.context).join() !== 'accountId' || raw.context.accountId !== accountId || typeof raw.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.revision)
    || raw.limit !== 25 || !Array.isArray(raw.entries) || raw.entries.length > 25 || !Array.isArray(raw.zones) || raw.zones.length > 10000) return bad()
  const ids = new Set<string>()
  for (const row of raw.entries) {
    if (!ddnsObject(row) || Object.keys(row).sort().join() !== 'createdAt,description,hostname,id,lastChangedAt,pending,type,updatedAt,zone'
      || typeof row.id !== 'string' || !DDNS_ID.test(row.id) || ids.has(row.id) || !ddnsHost(row.hostname) || !ddnsHost(row.zone) || !(row.hostname === row.zone || row.hostname.endsWith('.' + row.zone))
      || !['A', 'AAAA'].includes(row.type as string) || typeof row.description !== 'string' || row.description.length > 200 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>]/.test(row.description)
      || !ddnsStamp(row.createdAt) || !ddnsStamp(row.updatedAt) || !(row.lastChangedAt === null || ddnsStamp(row.lastChangedAt)) || typeof row.pending !== 'boolean') return bad()
    ids.add(row.id)
  }
  for (const zone of raw.zones) if (!ddnsObject(zone) || Object.keys(zone).join() !== 'name' || !ddnsHost(zone.name)) return bad()
  if (expectIssue && (!ddnsObject(raw.issued) || Object.keys(raw.issued).sort().join() !== 'id,secret' || typeof raw.issued.id !== 'string' || !ids.has(raw.issued.id) || (expectedId !== undefined && raw.issued.id !== expectedId) || typeof raw.issued.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.issued.secret))) return bad()
  return raw as unknown as DynamicDnsClientView
}
function bindAccountDynamicDns(_askDialog: unknown): void {
  const t = (message: string, values?: MessageValues) => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-account-dynamic-dns]').forEach(root => {
    if (root.dataset.ddnsBound === 'true') return
    root.dataset.ddnsBound = 'true'
    const find = <T extends HTMLElement>(name: string): T => root.querySelector<T>('[data-ddns-' + name + ']')!
    const status = find('status'), rows = find('rows'), zone = find<HTMLSelectElement>('zone'), hostname = find<HTMLInputElement>('hostname'), type = find<HTMLSelectElement>('type'), description = find<HTMLInputElement>('description'), confirmation = find<HTMLInputElement>('confirm-name')
    const issued = find('issued'), confirmPanel = find('confirm'), secret = find('secret'), username = find('username'), refresh = find<HTMLButtonElement>('refresh'), create = find<HTMLButtonElement>('create')
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const eligible = (): boolean => root.isConnected && root.dataset.ddnsManage === 'true' && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    if (!status || !rows || !zone || !hostname || !type || !description || !confirmation || !issued || !confirmPanel || !secret || !username || !refresh || !create) return
    const rowSlots = ['hostname', 'type', 'description', 'updated', 'state', 'manage'] as const
    const rowTemplate = clientTemplate(root, 'ddns-row'), emptyTemplate = clientTemplate(root, 'ddns-empty')
    cloneClientTemplate(rowTemplate, 'tr', rowSlots); cloneClientTemplate(emptyTemplate, 'tr', ['message'])
    let view: DynamicDnsClientView | null = null, selected: DynamicDnsClientEntry | null = null, busy = false, uncertain = false
    const note = (message: string, state: string): void => { status.textContent = message; status.dataset.state = state; status.setAttribute('role', state === 'error' ? 'alert' : 'status') }
    const hideSecret = (): void => { secret.textContent = ''; username.textContent = ''; issued.hidden = true }
    const lock = (): void => {
      for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')) control.disabled = !eligible() || busy
      create.disabled = !eligible() || busy || uncertain || !view || view.entries.length >= 25 || !view.zones.length
      for (const name of ['rotate', 'delete']) find<HTMLButtonElement>(name).disabled = !eligible() || busy || uncertain || !selected || confirmation.value !== selected.hostname
      root.setAttribute('aria-busy', String(busy))
    }
    const paint = (): void => {
      if (!view) return
      rows.textContent = ''; zone.textContent = ''
      for (const item of view.zones) { const option = document.createElement('option'); option.value = item.name; option.textContent = item.name; zone.append(option) }
      find('count').textContent = t('{used} / {limit} credentials', { used: view.entries.length, limit: view.limit })
      for (const item of view.entries) {
        const row = cloneClientTemplate(rowTemplate, 'tr', rowSlots)
        for (const [slot, text] of [['hostname', item.hostname], ['type', item.type], ['description', item.description || '—'], ['updated', item.lastChangedAt === null ? t('Not updated') : formatDisplayDateTime(item.lastChangedAt)], ['state', item.pending ? t('Publication needs retry or review') : t('Ready')]] as const) clientTemplateSlot(row, slot).textContent = text
        const button = clientTemplateSlot(row, 'manage', 'button') as HTMLButtonElement
        button.setAttribute('aria-label', t('Manage {host}', { host: item.hostname }))
        button.addEventListener('click', () => { if (!eligible() || busy || uncertain) return; hideSecret(); selected = item; confirmation.value = ''; find('selected').textContent = item.hostname; confirmPanel.hidden = false; confirmation.focus(); lock() }); rows.append(row)
      }
      if (!view.entries.length) { const row = cloneClientTemplate(emptyTemplate, 'tr', ['message']); clientTemplateSlot(row, 'message', 'td').textContent = t('No dynamic DNS credentials yet.'); rows.append(row) }
      lock()
    }
    const errorMessage = (error: unknown, mutation: boolean): string => {
      const code = ddnsObject(error) ? String(error.code ?? '') : ''
      if (code === 'CONFLICT') return t('The saved state changed. Refresh and review before trying again.')
      if (code === 'VALIDATION') return t('Check the zone, lowercase full hostname, type and description.')
      if (code === 'FORBIDDEN' || code === 'UNAUTHENTICATED') return t('Your account no longer has access to this operation.')
      return mutation ? t('The credential change could not be confirmed. Refresh before another change. If a password was issued but not received, rotate it.') : t('The hostname list could not be read. Try refreshing.')
    }
    const run = async (method: string, path: string, body?: unknown, expectedId?: string): Promise<void> => {
      if (!eligible() || busy || !send) return
      const mutation = method !== 'GET', issue = method === 'POST'
      hideSecret(); busy = true; lock(); note(mutation ? t('Saving…') : t('Reading hostnames…'), 'loading')
      try {
        const result = readDynamicDnsView(await send(method, path, body), root.dataset.account ?? '', issue, expectedId)
        if (!eligible()) { hideSecret(); return }
        view = result; uncertain = false; selected = null; confirmation.value = ''; confirmPanel.hidden = true; paint()
        if (result.issued) { username.textContent = result.issued.id; secret.textContent = result.issued.secret; issued.hidden = false; delete result.issued }
        if (mutation) { hostname.value = ''; description.value = '' }
        note(mutation ? t('Credential change saved. The DNS record changes only when the update client sends an address.') : t('Saved hostnames loaded.'), 'ready')
      } catch (error) { if (mutation) uncertain = true; note(errorMessage(error, mutation), 'error') }
      finally { busy = false; lock() }
    }
    refresh.addEventListener('click', () => { void run('GET', '/api/account/dynamic-dns') })
    create.addEventListener('click', () => {
      if (!view || uncertain || !ddnsHost(hostname.value) || !zone.value || !(hostname.value === zone.value || hostname.value.endsWith('.' + zone.value))) { note(t('Enter a lowercase full hostname inside the selected zone.'), 'error'); return }
      void run('POST', '/api/account/dynamic-dns', { zone: zone.value, hostname: hostname.value, type: type.value, description: description.value, expectedRevision: view.revision })
    })
    confirmation.addEventListener('input', lock)
    for (const action of ['rotate', 'delete']) find<HTMLButtonElement>(action).addEventListener('click', () => {
      if (!view || !selected || uncertain || confirmation.value !== selected.hostname) return
      void run(action === 'rotate' ? 'POST' : 'DELETE', '/api/account/dynamic-dns/' + selected.id + (action === 'rotate' ? '/rotate' : ''), { expectedRevision: view.revision }, action === 'rotate' ? selected.id : undefined)
    })
    find('cancel').addEventListener('click', () => { selected = null; confirmPanel.hidden = true; confirmation.value = ''; lock() })
    find('hide').addEventListener('click', hideSecret)
    find('copy').addEventListener('click', () => { if (!secret.textContent || !navigator.clipboard) return; void navigator.clipboard.writeText(secret.textContent).then(() => note(t('Password copied.'), 'ready'), () => note(t('Copy failed. Select and copy the password manually.'), 'error')) })
    window.addEventListener('pagehide', hideSecret)
    const endpoint = find('endpoint'); if (location.protocol === 'https:') endpoint.textContent = location.origin + '/nic/update'
    if (!send || !eligible()) { lock(); note(t('Dynamic DNS is unavailable here. No credentials were read or changed.'), 'unavailable'); return }
    void run('GET', '/api/account/dynamic-dns')
  })
}
export const ACCOUNT_DYNAMIC_DNS_CLIENT_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const DDNS_ID=${DDNS_ID.toString()};const DDNS_UUID=${DDNS_UUID.toString()};const ddnsObject=${ddnsObject.toString()};const ddnsHost=${ddnsHost.toString()};const ddnsStamp=${ddnsStamp.toString()};const readDynamicDnsView=${readDynamicDnsView.toString()};return ${bindAccountDynamicDns.toString()};})()`
