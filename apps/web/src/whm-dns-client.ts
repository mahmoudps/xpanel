/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import { zoneEditorClientBinding } from './zone-editor-client.ts'
import type { DnsZone, ZoneEditorDraftRow, ZoneRecordType } from './zone-editor-client.ts'

type WhmZone = DnsZone & { revision: string }
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
type DnsRuntime = Pick<typeof import('./zone-editor-client.ts'), 'ZONE_ID_PATTERN' | 'ZONE_RECORD_TYPES' | 'ZONE_TTL_DEFAULT' | 'ZONE_TTL_MAX' | 'ZONE_PRIORITY_MAX' | 'readDnsZone' | 'readDnsZoneDeleteAck' | 'zoneCanonicalName' | 'zoneDraftFromRecords' | 'zoneObject' | 'zoneRecordsFromDraft' | 'zoneSavePayload' | 'zoneStable' | 'zoneWriteUncertain'>

/** WHM adapter over the same validated DNS record contract as the account editor. */
function bindWhmDns(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined, runtime: DnsRuntime): void {
  const { ZONE_ID_PATTERN, ZONE_RECORD_TYPES, ZONE_TTL_DEFAULT, ZONE_TTL_MAX, ZONE_PRIORITY_MAX, readDnsZone, readDnsZoneDeleteAck, zoneCanonicalName, zoneDraftFromRecords, zoneObject, zoneRecordsFromDraft, zoneSavePayload, zoneStable, zoneWriteUncertain } = runtime
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-dns-workspace] [data-dns-editor]').forEach(root => {
    if (root.dataset.dnsBound === 'true') return
    root.dataset.dnsBound = 'true'
    const workspace = root.closest<HTMLElement>('[data-whm-dns-workspace]')!
    const select = root.querySelector<HTMLSelectElement>('[data-dns-zone]')!
    const account = root.querySelector<HTMLSelectElement>('[data-dns-account]')!
    const newName = root.querySelector<HTMLInputElement>('[data-dns-new-name]')!
    const rows = root.querySelector<HTMLTableSectionElement>('[data-dns-records]')!
    const status = root.querySelector<HTMLElement>('[data-dns-status]')!
    const button = (key: string): HTMLButtonElement => root.querySelector<HTMLButtonElement>('[data-dns-' + key + ']')!
    if (!select || !account || !newName || !rows || !status || ['refresh', 'add-record', 'add-zone', 'save', 'delete'].some(key => !button(key))) return
    const send = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && !root.closest(denied)
    let zones: WhmZone[] = [], selected: WhmZone | null = null, draft: ZoneEditorDraftRow[] = []
    let busy = false, loaded = false, review = false, confirming = false
    const dirty = (): boolean => !!selected && zoneStable(draft) !== zoneStable(zoneDraftFromRecords(selected.records))
    const announce = (state: string, message: string): void => {
      status.dataset.state = state
      status.textContent = message
      status.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status')
    }
    const controls = (): void => {
      const blocked = !admitted() || busy || confirming || !loaded
      select.disabled = blocked
      account.disabled = blocked || review
      newName.disabled = blocked || review
      button('refresh').disabled = !admitted() || busy || confirming
      button('add-zone').disabled = blocked || review || !newName.value.trim() || !account.options.length
      button('add-record').disabled = blocked || review || !selected
      button('save').disabled = blocked || review || !dirty()
      button('delete').disabled = blocked || review || !selected
      rows.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = blocked || review })
      root.setAttribute('aria-busy', String(busy || confirming))
    }
    const readCollection = (value: unknown): WhmZone[] => {
      if (!zoneObject(value) || !Array.isArray(value.zones) || value.zones.length > 10000) throw new Error('invalid_dns_zones')
      const names = new Set<string>(), ids = new Set<string>()
      return value.zones.map(raw => {
        const zone = readDnsZone(raw, true)
        if (!zoneObject(raw) || typeof raw.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.revision) || names.has(zone.name) || ids.has(zone.id)) throw new Error('invalid_dns_revision')
        names.add(zone.name); ids.add(zone.id)
        return { ...zone, revision: raw.revision }
      })
    }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => {
      if (!send || !admitted()) return Promise.reject({ stateChanged: false })
      return body === undefined ? send(method, path) : send(method, path, body)
    }
    const read = async (): Promise<WhmZone[]> => readCollection(await request('GET', '/api/dns/zones'))
    const textCell = (row: HTMLTableRowElement, value: string, technical = false): void => {
      const td = document.createElement('td')
      const content = technical ? document.createElement('bdi') : document.createElement('span')
      if (technical) content.dir = 'ltr'
      content.textContent = value; td.append(content); row.append(td)
    }
    const summaries = (): void => {
      const count = workspace.querySelector<HTMLElement>('[data-whm-dns-zone-count]')
      const body = workspace.querySelector<HTMLElement>('[data-whm-dns-zone-rows]')
      const serial = workspace.querySelector<HTMLElement>('[data-whm-dns-soa-serial]')
      if (count) count.textContent = String(zones.length)
      if (serial) { serial.textContent = ''; const isolated = document.createElement('bdi'); isolated.dir = 'ltr'; isolated.textContent = selected ? String(selected.serial) : t('Not read'); serial.append(isolated) }
      if (!body) return
      body.textContent = ''
      for (const zone of zones) {
        const label = zone.accountId === null ? t('Unassigned (server)') : Array.from(account.options).find(option => option.value === zone.accountId)?.textContent ?? t('Not read')
        const row = document.createElement('tr')
        textCell(row, zone.name, true); textCell(row, label); textCell(row, String(zone.records.length), true)
        textCell(row, String(zone.serial), true); textCell(row, t('Not read')); body.append(row)
      }
      if (!zones.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = t('The read returned no DNS zones.'); row.append(cell); body.append(row) }
    }
    const fields = ['name', 'type', 'ttl', 'content', 'priority'] as const
    const labels = [t('Record name'), t('Record type'), 'TTL', t('Record content'), t('Priority')]
    const paintRows = (): void => {
      rows.textContent = ''
      for (const record of draft) {
        const row = document.createElement('tr'); row.dataset.recordId = record.id
        fields.forEach((field, index) => {
          const td = document.createElement('td'), label = document.createElement('label')
          const input = document.createElement(field === 'type' ? 'select' : 'input')
          input.id = 'whm-dns-' + record.id + '-' + field
          input.className = field === 'type' ? 'xp-select' : 'xp-input'
          input.dir = 'ltr'; input.dataset.field = field; input.setAttribute('aria-label', labels[index]!)
          label.htmlFor = input.id; label.textContent = labels[index]!
          if (input instanceof HTMLSelectElement) for (const type of ZONE_RECORD_TYPES) { const option = document.createElement('option'); option.value = type; option.textContent = type; input.append(option) }
          if (input instanceof HTMLInputElement) {
            input.type = field === 'ttl' || field === 'priority' ? 'number' : 'text'
            if (input.type === 'number') { input.min = '0'; input.max = String(field === 'ttl' ? ZONE_TTL_MAX : ZONE_PRIORITY_MAX); input.step = '1' }
          }
          input.value = record[field]
          input.addEventListener(field === 'type' ? 'change' : 'input', () => {
            if (input.disabled || !admitted()) return
            if (field === 'type') record.type = input.value as ZoneRecordType
            else record[field] = input.value
            controls()
          })
          td.append(label, input); row.append(td)
        })
        const td = document.createElement('td'), remove = document.createElement('button')
        remove.type = 'button'; remove.className = 'xp-btn'; remove.textContent = t('Remove record'); remove.dataset.dnsRemove = ''
        remove.addEventListener('click', () => { if (!remove.disabled && admitted()) { draft = draft.filter(item => item !== record); paintRows(); controls() } })
        td.append(remove); row.append(td); rows.append(row)
      }
      if (!draft.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 6; td.textContent = selected ? t('No saved records. Add a record to this zone.') : t('Select a saved zone or create a new zone.'); row.append(td); rows.append(row) }
    }
    const install = (name: string): void => {
      selected = zones.find(zone => zone.name === name) ?? zones[0] ?? null
      select.textContent = ''
      for (const zone of zones) { const option = document.createElement('option'); option.value = zone.name; option.textContent = zone.name; select.append(option) }
      select.value = selected?.name ?? ''; draft = zoneDraftFromRecords(selected?.records ?? [])
      loaded = true; review = false; summaries(); paintRows()
    }
    const confirm = async (title: string, body: string, danger = false): Promise<boolean> => {
      if (!askDialog || confirming) { announce('failed', t('Confirmation is unavailable; nothing was changed.')); return false }
      confirming = true; controls()
      try { return await askDialog({ title, body, danger, confirm: t('Confirm') }) === true }
      catch { return false }
      finally { confirming = false; controls() }
    }
    const discard = (): Promise<boolean> => !dirty() && !review ? Promise.resolve(true) : confirm(t('Discard draft and read saved zones?'), t('Unsaved edits will be discarded. A previous request is never retried.'), true)
    const refresh = async (targetName?: string): Promise<void> => {
      if (busy || confirming || !admitted() || !await discard()) return
      if (busy || confirming || !admitted()) return
      busy = true; controls(); announce('reading', t('Reading saved DNS zones…'))
      try { const name = targetName ?? selected?.name ?? ''; zones = await read(); install(name); announce('read', t('Saved zones read. DNS serving and propagation are unverified.')) }
      catch { announce('failed', t('Saved zones could not be read. No changes were sent; the draft is preserved.')) }
      finally { busy = false; controls() }
    }
    const write = async (kind: 'save' | 'create' | 'delete'): Promise<void> => {
      if (busy || confirming || review || !loaded || !admitted()) return
      const baseline = selected
      let name: string, payload: Record<string, unknown>
      try {
        name = kind === 'create' ? zoneCanonicalName(newName.value.trim()) : baseline?.name ?? ''
        if (!name || kind === 'save' && !dirty()) return
        if (kind === 'create' && account.value && !ZONE_ID_PATTERN.test(account.value)) throw new Error('invalid_account')
        const expected = kind === 'create' ? null : baseline!.revision
        payload = kind === 'delete' ? { expectedZoneRevision: expected } : { ...zoneSavePayload(kind === 'create' ? [] : zoneRecordsFromDraft(draft)), expectedZoneRevision: expected,
          ...(kind === 'create' ? { accountId: account.value || null } : {}) }
      } catch { announce('failed', t('Check the zone name, record fields, TTL and priority. Nothing was sent.')); return }
      const accountLabel = account.selectedOptions[0]?.textContent ?? ''
      const discardNotice = kind === 'create' && dirty() ? '\n' + t('Creating the zone also discards unsaved edits in the current zone.') : ''
      if (!await confirm(kind === 'delete' ? t('Delete DNS zone') : kind === 'create' ? t('Create DNS zone') : t('Save DNS zone'), name + (kind === 'create' ? ' · ' + accountLabel : '') + '\n' + t('This changes saved configuration. DNS serving and propagation remain unverified.') + discardNotice, kind === 'delete')) return
      if (!admitted()) { controls(); return }
      busy = true; controls(); let submitted = false
      try {
        const current = await read(), target = current.find(zone => zone.name === name) ?? null
        if (kind === 'create' ? target !== null : !target || target.revision !== baseline!.revision) {
          review = true; announce('stale', t('The saved zone changed. Your draft is kept. Read and review saved zones before retrying.')); return
        }
        submitted = true
        const result = await request(kind === 'delete' ? 'DELETE' : 'PUT', '/api/dns/zones/' + encodeURIComponent(name), payload)
        let acknowledged: WhmZone | null = null
        if (kind === 'delete') readDnsZoneDeleteAck(result)
        else {
          if (!zoneObject(result) || typeof result.revision !== 'string') throw new Error('invalid_ack')
          readDnsZoneDeleteAck({ ...result, ok: true })
          const zone = readDnsZone(result.zone, true)
          acknowledged = { ...zone, revision: result.revision }
          if (zone.name !== name || zone.accountId !== (kind === 'create' ? payload.accountId : baseline!.accountId)
            || zoneStable(zoneSavePayload(zone.records).records) !== zoneStable(payload.records)
            || kind === 'save' && zone.serial <= baseline!.serial) throw new Error('wrong_ack')
        }
        const observed = await read(), found = observed.find(zone => zone.name === name) ?? null
        if (kind === 'delete' ? found !== null : !found || zoneStable(found) !== zoneStable(acknowledged)) throw new Error('readback_mismatch')
        zones = observed; install(kind === 'delete' ? '' : name)
        if (kind === 'create') newName.value = ''
        announce(kind === 'delete' ? 'deleted' : 'saved', t('Saved configuration and readback verified. DNS serving and propagation remain unverified.'))
      } catch (error) {
        review = submitted && zoneWriteUncertain(error)
        const conflict = zoneObject(error) && error.status === 409
        review ||= conflict
        announce(review ? conflict ? 'stale' : 'uncertain' : 'failed', review
          ? t('The outcome requires review. The draft is kept; no retry was sent. Read saved zones before continuing.')
          : t('The request was refused or the current zone could not be read. The draft is kept; no retry was sent.'))
      } finally { busy = false; controls() }
    }
    if (!send || !admitted()) {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true })
      announce('unavailable', t('DNS editing is unavailable here. Nothing was read or changed.')); return
    }
    select.addEventListener('change', () => { const name = select.value; select.value = selected?.name ?? ''; void refresh(name) })
    newName.addEventListener('input', controls)
    button('refresh').addEventListener('click', () => { void refresh() })
    button('add-record').addEventListener('click', () => { if (!button('add-record').disabled && admitted()) { draft.push({ id: window.crypto.randomUUID(), name: '@', type: 'A', ttl: String(ZONE_TTL_DEFAULT), content: '', priority: '' }); paintRows(); controls() } })
    button('save').addEventListener('click', () => { void write('save') })
    button('add-zone').addEventListener('click', () => { void write('create') })
    button('delete').addEventListener('click', () => { void write('delete') })
    window.addEventListener('beforeunload', event => { if (dirty() || review) { event.preventDefault(); event.returnValue = '' } })
    void refresh()
  })
}

export const WHM_DNS_CLIENT_BINDING = zoneEditorClientBinding(bindWhmDns, true)
