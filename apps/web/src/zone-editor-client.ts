import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
// xPanel zone-editor browser controller. It binds the already-rendered connected-panel hooks
// to the existing desired-state DNS API only. Saving writes desired-state records and reads
// them back; the UI never claims DNS answers, serving or propagation.
export const ZONE_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'] as const
export type ZoneRecordType = (typeof ZONE_RECORD_TYPES)[number]
export const ZONE_TTL_DEFAULT = 14400
export const ZONE_TTL_MAX = 2147483647
export const ZONE_PRIORITY_MAX = 65535
export const ZONE_SERIAL_MIN = 1
export const ZONE_SERIAL_MAX = 4294967295
/** Mirrors the state layer's relative record-name grammar (lowercase, '@' or '*'). */
export const ZONE_RECORD_NAME_PATTERN = /^(@|\*|(\*\.)?[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*)$/
export const ZONE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Control, line-separator and bidi characters the state layer refuses in record content. */
export const ZONE_UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
export interface ZoneRecord {id: string; name: string; type: ZoneRecordType; ttl: number; content: string; priority: number | null}
export interface DnsZone {id: string; accountId: string | null; name: string; serial: number; records: ZoneRecord[]}
export interface ZoneEditorDraftRow {id: string; name: string; type: ZoneRecordType; ttl: string; content: string; priority: string}
export type ZoneEditorDraftPatch = Partial<Pick<ZoneEditorDraftRow, 'name' | 'type' | 'ttl' | 'content' | 'priority'>>
export type ZoneEditorStatus = 'unavailable' | 'unread' | 'reading' | 'read' | 'saving' | 'saved' | 'deleted' | 'failed' | 'stale' | 'uncertain'
export type ZoneEditorReason = 'invalid-records' | 'invalid-zone-name' | 'not-owned' | 'zone-exists' | 'missing-zone' | 'confirmation' | 'request' | 'readback' | null
export interface ZoneEditorState {
  accountId: string
  zones: DnsZone[]
  zoneName: string
  zone: DnsZone | null
  draft: ZoneEditorDraftRow[]
  baseline: ZoneRecord[] | null
  loaded: boolean
  dirty: boolean
  busy: boolean
  reading: boolean
  uncertain: boolean
  status: ZoneEditorStatus
  reason: ZoneEditorReason
}
export interface ZoneEditorOptions {
  accountId: string
  zoneName: string
  zoneNames: readonly string[] | (() => readonly string[])
  request: (method: string, path: string, body?: unknown) => Promise<unknown>
  changed?: (state: ZoneEditorState) => void
  newRecordId?: () => string
}
export function zoneObject(value: unknown): value is Record<string, unknown> {return !!value && typeof value === 'object' && !Array.isArray(value)}
export function zoneSafeText(value: unknown, max = 4096): value is string {return typeof value === 'string' && value.length <= max && value.isWellFormed() && !ZONE_UNSAFE_TEXT.test(value)}
/** Canonical lowercase, punycode, dotless zone name; throws instead of repairing unsafe input. */
export function zoneCanonicalName(raw: string): string {
  if (!zoneSafeText(raw, 1024) || raw.length === 0 || /[\s/@:#?%[\]\\]/u.test(raw)) throw new Error('invalid_zone_name')
  const host = new URL('http://' + raw.normalize('NFC') + '/').hostname.toLowerCase().replace(/\.$/, '')
  const labels = host.split('.')
  if (!host || host.length > 253 || labels.length < 2 || labels.some(label => label.length === 0 || label.length > 63)) throw new Error('invalid_zone_name')
  return host
}
export function zoneStable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(zoneStable).join(',') + ']'
  if (zoneObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + zoneStable(value[key])).join(',') + '}'
  return JSON.stringify(value) ?? 'undefined'
}
export function readZoneRecord(value: unknown): ZoneRecord {
  if (!zoneObject(value)) throw new Error('invalid_zone_record')
  if (typeof value.id !== 'string' || !ZONE_ID_PATTERN.test(value.id)) throw new Error('invalid_zone_record')
  const name = value.name, type = value.type
  if (typeof name !== 'string' || !ZONE_RECORD_NAME_PATTERN.test(name)) throw new Error('invalid_zone_record')
  if (!ZONE_RECORD_TYPES.includes(type as ZoneRecordType)) throw new Error('invalid_zone_record')
  const ttl = value.ttl === undefined ? ZONE_TTL_DEFAULT : value.ttl
  if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < 0 || ttl > ZONE_TTL_MAX) throw new Error('invalid_zone_record')
  const content = value.content
  if (!zoneSafeText(content, 4096) || content.length === 0) throw new Error('invalid_zone_record')
  const priority = value.priority === undefined || value.priority === null ? null : value.priority
  if (priority !== null && (typeof priority !== 'number' || !Number.isSafeInteger(priority) || priority < 0 || priority > ZONE_PRIORITY_MAX)) throw new Error('invalid_zone_record')
  if (((type as ZoneRecordType) === 'MX' || (type as ZoneRecordType) === 'SRV') !== (priority !== null)) throw new Error('invalid_zone_record')
  return {id: value.id.toLowerCase(), name, type: type as ZoneRecordType, ttl, content, priority}
}
export function readDnsZone(value: unknown, allowUnassigned = false): DnsZone {
  if (!zoneObject(value)) throw new Error('invalid_dns_zone')
  if (typeof value.id !== 'string' || !ZONE_ID_PATTERN.test(value.id)) throw new Error('invalid_dns_zone')
  if (!(allowUnassigned && value.accountId === null) && (typeof value.accountId !== 'string' || !ZONE_ID_PATTERN.test(value.accountId))) throw new Error('invalid_dns_zone')
  const serial = value.serial, name = value.name
  if (typeof serial !== 'number' || !Number.isSafeInteger(serial) || serial < ZONE_SERIAL_MIN || serial > ZONE_SERIAL_MAX) throw new Error('invalid_dns_zone')
  if (typeof name !== 'string' || zoneCanonicalName(name) !== name) throw new Error('invalid_dns_zone')
  if (!Array.isArray(value.records)) throw new Error('invalid_dns_zone')
  const records = value.records.map(readZoneRecord)
  if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('invalid_dns_zone')
  return {id: value.id.toLowerCase(), accountId: typeof value.accountId === 'string' ? value.accountId.toLowerCase() : null, name, serial, records}
}
/** Keeps only validated zones owned by the pinned account; other-tenant zones are never exposed. */
export function readDnsZones(value: unknown, accountId: string): DnsZone[] {
  if (!zoneObject(value) || !Array.isArray(value.zones)) throw new Error('invalid_dns_zones')
  if (typeof accountId !== 'string' || !ZONE_ID_PATTERN.test(accountId)) throw new Error('invalid_dns_zones')
  const pinned = accountId.toLowerCase(), zones: DnsZone[] = []
  for (const raw of value.zones) {
    if (!zoneObject(raw) || typeof raw.accountId !== 'string' || raw.accountId.toLowerCase() !== pinned) continue
    const zone = readDnsZone(raw)
    if (zones.some(item => item.name === zone.name)) throw new Error('duplicate_dns_zone')
    zones.push(zone)
  }
  return zones.sort((left, right) => left.name.localeCompare(right.name))
}
export function readDnsZoneSaveAck(value: unknown): {zone: DnsZone; reconcile: unknown} {
  if (!zoneObject(value) || !zoneObject(value.zone)) throw new Error('invalid_dns_zone_acknowledgement')
  const details = zoneObject(value.details) ? value.details : {}
  if ([value, details].some(part => ['unknownOutcome', 'verificationRequired', 'needsAttention'].some(key => part[key] === true))) throw new Error('invalid_dns_zone_acknowledgement')
  return {zone: readDnsZone(value.zone), reconcile: value.reconcile ?? null}
}
export function readDnsZoneDeleteAck(value: unknown): true {
  if (!zoneObject(value) || value.ok !== true) throw new Error('invalid_dns_zone_delete_acknowledgement')
  const details = zoneObject(value.details) ? value.details : {}
  if ([value, details].some(part => ['unknownOutcome', 'verificationRequired', 'needsAttention'].some(key => part[key] === true))) throw new Error('invalid_dns_zone_delete_acknowledgement')
  return true
}
export function zoneWriteUncertain(error: unknown): boolean {
  const value = zoneObject(error) ? error : {}, details = zoneObject(value.details) ? value.details : {}
  if ([value, details].some(part => ['unknownOutcome', 'verificationRequired', 'needsAttention'].some(key => part[key] === true) || part.stateChanged === true)) return true
  if (details.stateChanged === false) return false
  if (typeof value.status === 'number') return value.status >= 500 && value.status <= 599
  return true
}
export function zoneRecordFromDraft(row: ZoneEditorDraftRow): ZoneRecord {
  if (!zoneObject(row)) throw new Error('invalid_draft_record')
  if (typeof row.id !== 'string' || !ZONE_ID_PATTERN.test(row.id)) throw new Error('invalid_draft_record')
  if (typeof row.name !== 'string' || !ZONE_RECORD_NAME_PATTERN.test(row.name)) throw new Error('invalid_draft_record')
  if (!ZONE_RECORD_TYPES.includes(row.type)) throw new Error('invalid_draft_record')
  const ttlText = typeof row.ttl === 'string' ? row.ttl.trim() : ''
  const ttl = ttlText === '' ? ZONE_TTL_DEFAULT : Number(ttlText)
  if (!Number.isSafeInteger(ttl) || ttl < 0 || ttl > ZONE_TTL_MAX) throw new Error('invalid_draft_record')
  if (typeof row.content !== 'string' || row.content.length === 0 || !zoneSafeText(row.content, 4096)) throw new Error('invalid_draft_record')
  const priorityText = typeof row.priority === 'string' ? row.priority.trim() : ''
  const priority = priorityText === '' ? null : Number(priorityText)
  if (priority !== null && (!Number.isSafeInteger(priority) || priority < 0 || priority > ZONE_PRIORITY_MAX)) throw new Error('invalid_draft_record')
  if ((row.type === 'MX' || row.type === 'SRV') !== (priority !== null)) throw new Error('invalid_draft_record')
  return {id: row.id.toLowerCase(), name: row.name, type: row.type, ttl, content: row.content, priority}
}
export function zoneRecordsFromDraft(draft: readonly ZoneEditorDraftRow[]): ZoneRecord[] {return draft.map(zoneRecordFromDraft)}
export function zoneDraftFromRecords(records: readonly ZoneRecord[]): ZoneEditorDraftRow[] {
  return records.map(record => ({id: record.id, name: record.name, type: record.type, ttl: String(record.ttl), content: record.content, priority: record.priority === null ? '' : String(record.priority)}))
}
/** Exact PUT body: only `records`, no invented serial or zone id. Each row keeps its UUID. */
export function zoneSavePayload(records: readonly ZoneRecord[]): {records: Record<string, unknown>[]} {
  return {records: records.map(record => {
    const row: Record<string, unknown> = {id: record.id, name: record.name, type: record.type, ttl: record.ttl, content: record.content}
    if (record.priority !== null) row.priority = record.priority
    return row
  })}
}
export async function requestZoneEditor(transport: (method: string, path: string, body?: unknown) => Promise<unknown>, admitted: () => boolean, method: string, path: string, body?: unknown): Promise<unknown> {
  if (method !== 'GET' && !admitted()) throw {details: {stateChanged: false}}
  return transport(method, path, body)
}
export function zoneEditorMessage(state: ZoneEditorState): string {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  switch (state.status) {
    case 'unavailable': return t('Zone editing is unavailable here. No saved zone records were read and no change is possible.')
    case 'unread': return t('Zone records have not been read from saved desired state.')
    case 'reading': return t('Reading zone records from saved desired state…')
    case 'read': return state.zone
      ? t('Zone records read from saved desired state. DNS serving and propagation are not verified.')
      : t('No saved zone record was returned for this name. Saving creates the zone in desired state; DNS serving and propagation are not verified.')
    case 'saving': return t('Saving zone records and verifying the saved readback…')
    case 'saved': return t('Zone records saved and read back from saved desired state. DNS serving and propagation are not verified.')
    case 'deleted': return t('The zone was deleted from saved desired state and the read confirms it is absent. DNS serving and propagation are not verified.')
    case 'stale': return state.reason === 'zone-exists'
      ? t('A saved zone already exists for this name. Select it instead; nothing was written.')
      : t('The saved zone differs from this draft or changed elsewhere. Your draft is preserved. Review the saved zone before saving again.')
    case 'failed': switch (state.reason) {
      case 'invalid-records': return t('The record fields are not valid. Check the record name, type, TTL, priority and content; nothing was sent.')
      case 'invalid-zone-name': return t('Enter a valid account domain name for the new zone; nothing was sent.')
      case 'not-owned': return t('That name is not one of this account’s saved domains; nothing was sent.')
      case 'missing-zone': return t('No saved zone is selected to delete; nothing was sent.')
      case 'readback': return t('The saved readback could not be verified. Your draft is preserved.')
      default: return t('The request was refused or could not complete. Your draft is preserved.')
    }
    case 'uncertain': return t('The write outcome requires review. Your draft is preserved. Select the zone again to re-read the saved records.')
  }
}
export function createZoneEditor(options: ZoneEditorOptions) {
  const ownedCanonical = (): string[] => {
    const names: string[] = []
    for (const name of typeof options.zoneNames === 'function' ? options.zoneNames() : options.zoneNames) {
      try { const canonical = zoneCanonicalName(name); if (!names.includes(canonical)) names.push(canonical) } catch { /* a rendered option that is not a domain name can never be selected */ }
    }
    return names
  }
  const nextRecordId = (): string => {
    let id: string
    if (options.newRecordId) id = options.newRecordId()
    else {
      const cryptoApi = (globalThis as {crypto?: {randomUUID?: () => string}}).crypto
      if (!cryptoApi || typeof cryptoApi.randomUUID !== 'function') throw new Error('secure_random_unavailable')
      id = cryptoApi.randomUUID()
    }
    if (typeof id !== 'string' || !ZONE_ID_PATTERN.test(id)) throw new Error('invalid_record_id')
    return id.toLowerCase()
  }
  const state: ZoneEditorState = {accountId: options.accountId, zones: [], zoneName: options.zoneName, zone: null, draft: [], baseline: null, loaded: false, dirty: false, busy: false, reading: false, uncertain: false, status: 'unread', reason: null}
  let generation = 0, pending: ZoneRecord[] | null = null
  const publish = () => {
    state.dirty = state.loaded && state.baseline !== null && zoneStable(state.draft) !== zoneStable(zoneDraftFromRecords(state.baseline))
    options.changed?.({
      ...state,
      zones: state.zones.map(zone => ({...zone, records: zone.records.map(record => ({...record}))})),
      zone: state.zone ? {...state.zone, records: state.zone.records.map(record => ({...record}))} : null,
      draft: state.draft.map(row => ({...row})),
      baseline: state.baseline ? state.baseline.map(record => ({...record})) : null,
    })
  }
  const status = (value: ZoneEditorStatus) => {state.status = value; publish()}
  const locked = () => state.busy || state.reading || state.uncertain
  const read = async (): Promise<DnsZone[]> => readDnsZones(await options.request('GET', '/api/dns/zones'), state.accountId)
  const install = (zone: DnsZone | null) => {
    state.zone = zone
    state.baseline = zone ? zone.records.map(record => ({...record})) : []
    state.draft = zoneDraftFromRecords(state.baseline)
    state.loaded = true
    state.uncertain = false
    state.reason = null
    pending = null
  }
  const selectedOwnedName = (): string | null => {
    if (!state.zoneName) return null
    let canonical: string
    try { canonical = zoneCanonicalName(state.zoneName) } catch { return null }
    return ownedCanonical().includes(canonical) ? canonical : null
  }
  async function refresh(): Promise<boolean> {
    if (state.busy || state.reading) return false
    const token = ++generation
    state.reading = true
    status(state.uncertain ? 'uncertain' : 'reading')
    try {
      const zones = await read()
      if (token !== generation) return false
      state.zones = zones
      const observed = zones.find(zone => zone.name === state.zoneName) ?? null
      state.zone = observed
      if (state.uncertain) {
        const desired = pending
        pending = null
        state.uncertain = false
        if (desired && observed && zoneStable(observed.records) === zoneStable(desired)) {
          install(observed)
          status('saved')
        } else if (!observed || zoneStable(observed.records) === zoneStable(state.baseline ?? [])) {
          state.reason = 'request'
          status('failed')
        } else {
          state.reason = 'readback'
          status('stale')
        }
      } else if (state.dirty) {
        state.reason = observed && zoneStable(observed.records) !== zoneStable(state.baseline ?? []) ? 'readback' : null
        status(state.reason ? 'stale' : 'read')
      } else {
        install(observed)
        status('read')
      }
      return true
    } catch {
      if (token === generation) {state.reason = 'request'; status(state.uncertain ? 'uncertain' : 'failed')}
      return false
    } finally {
      if (token === generation) {state.reading = false; publish()}
    }
  }
  async function selectZone(name: string, confirm?: () => Promise<unknown>): Promise<boolean> {
    if (state.busy || state.reading) return false
    let canonical: string
    try { canonical = zoneCanonicalName(name) } catch { state.reason = 'invalid-zone-name'; status('failed'); return false }
    if (!ownedCanonical().includes(canonical)) {state.reason = 'not-owned'; status('failed'); return false}
    if (canonical === state.zoneName && state.loaded) return false
    if (state.dirty || state.uncertain) {
      if (!confirm) {state.reason = 'readback'; status('stale'); return false}
      const token = ++generation
      state.busy = true
      publish()
      let approved = false
      try { approved = await confirm() === true } catch { approved = false }
      if (token !== generation) return false
      state.busy = false
      publish()
      if (!approved) return false
    }
    state.zoneName = canonical
    state.zone = null
    state.baseline = null
    state.draft = []
    state.loaded = false
    state.dirty = false
    state.uncertain = false
    state.reason = null
    pending = null
    publish()
    await refresh()
    return true
  }
  function editRecord(id: string, patch: ZoneEditorDraftPatch): boolean {
    if (locked() || !state.loaded) return false
    const current = state.draft.find(row => row.id === id)
    if (!current) return false
    const next: ZoneEditorDraftRow = {...current}
    if (patch.name !== undefined) { if (typeof patch.name !== 'string') return false; next.name = patch.name }
    if (patch.type !== undefined) { if (!ZONE_RECORD_TYPES.includes(patch.type)) return false; next.type = patch.type }
    if (patch.ttl !== undefined) { if (typeof patch.ttl !== 'string') return false; next.ttl = patch.ttl }
    if (patch.content !== undefined) { if (typeof patch.content !== 'string') return false; next.content = patch.content }
    if (patch.priority !== undefined) { if (typeof patch.priority !== 'string') return false; next.priority = patch.priority }
    state.draft = state.draft.map(row => row.id === id ? next : row)
    state.reason = null
    publish()
    return true
  }
  function addRecord(): boolean {
    if (locked() || !state.loaded) return false
    let id: string
    try { id = nextRecordId() } catch { state.reason = 'request'; status('failed'); return false }
    state.draft = [...state.draft, {id, name: '@', type: 'A', ttl: String(ZONE_TTL_DEFAULT), content: '', priority: ''}]
    state.reason = null
    publish()
    return true
  }
  function removeRecord(id: string): boolean {
    if (locked() || !state.loaded || !state.draft.some(row => row.id === id)) return false
    state.draft = state.draft.filter(row => row.id !== id)
    state.reason = null
    publish()
    return true
  }
  async function save(): Promise<boolean> {
    if (locked() || !state.loaded) return false
    const zoneName = selectedOwnedName()
    if (!zoneName) {state.reason = 'not-owned'; status('failed'); return false}
    let submitted: ZoneRecord[]
    try { submitted = zoneRecordsFromDraft(state.draft) } catch { state.reason = 'invalid-records'; status('failed'); return false }
    if (submitted.length === 0 && state.zone === null) {state.reason = 'invalid-records'; status('failed'); return false}
    const previous = state.zone ? state.zone.serial : null
    const token = ++generation
    state.busy = true
    state.uncertain = false
    state.reason = null
    pending = submitted
    status('saving')
    try {
      const raw = await options.request('PUT', '/api/dns/zones/' + encodeURIComponent(zoneName), zoneSavePayload(submitted))
      let acknowledged: {zone: DnsZone; reconcile: unknown}
      try { acknowledged = readDnsZoneSaveAck(raw) } catch { throw {zoneEditorDisputed: 'invalid_dns_zone_acknowledgement'} }
      if (acknowledged.zone.name !== zoneName || acknowledged.zone.accountId !== state.accountId || zoneStable(acknowledged.zone.records) !== zoneStable(submitted)) throw {zoneEditorDisputed: 'zone_save_acknowledgement_mismatch'}
      let zones: DnsZone[]
      try { zones = await read() } catch { throw {zoneEditorUnreadable: true} }
      if (token !== generation) return false
      state.zones = zones
      const observed = zones.find(zone => zone.name === zoneName) ?? null
      if (!observed || zoneStable(observed.records) !== zoneStable(submitted) || observed.serial !== acknowledged.zone.serial || (previous !== null && observed.serial <= previous)) throw {zoneEditorDisputed: 'zone_readback_mismatch'}
      install(observed)
      status('saved')
      return true
    } catch (error) {
      if (token !== generation) return false
      if (zoneObject(error) && typeof error.zoneEditorDisputed === 'string') {state.uncertain = false; state.reason = 'readback'; status('stale')}
      else if (zoneObject(error) && error.zoneEditorUnreadable === true) {state.uncertain = true; state.reason = 'request'; status('uncertain')}
      else if (zoneWriteUncertain(error)) {state.uncertain = true; state.reason = 'request'; status('uncertain')}
      else {state.uncertain = false; state.reason = 'request'; status('failed')}
      return false
    } finally {
      if (token === generation) {state.busy = false; publish()}
    }
  }
  async function addZone(rawName: string, confirm?: () => Promise<unknown>): Promise<boolean> {
    if (locked() || !state.loaded) return false
    let name: string
    try { name = zoneCanonicalName(rawName) } catch { state.reason = 'invalid-zone-name'; status('failed'); return false }
    if (!ownedCanonical().includes(name)) {state.reason = 'not-owned'; status('failed'); return false}
    if (state.dirty || state.uncertain) {
      if (!confirm) {state.reason = 'readback'; status('stale'); return false}
      const confirmToken = ++generation
      state.busy = true
      publish()
      let approved = false
      try { approved = await confirm() === true } catch { approved = false }
      if (confirmToken !== generation) return false
      state.busy = false
      if (!approved) {publish(); return false}
      state.draft = state.baseline ? zoneDraftFromRecords(state.baseline) : []
      state.uncertain = false
      pending = null
      publish()
    }
    const token = ++generation
    state.busy = true
    state.uncertain = false
    state.reason = null
    status('saving')
    try {
      let zones: DnsZone[]
      try { zones = await read() } catch { throw {zoneEditorUnreadable: true} }
      if (token !== generation) return false
      state.zones = zones
      if (zones.some(zone => zone.name === name)) {state.reason = 'zone-exists'; status('stale'); return false}
      const raw = await options.request('PUT', '/api/dns/zones/' + encodeURIComponent(name), {records: []})
      let acknowledged: {zone: DnsZone; reconcile: unknown}
      try { acknowledged = readDnsZoneSaveAck(raw) } catch { throw {zoneEditorDisputed: 'invalid_dns_zone_acknowledgement'} }
      if (acknowledged.zone.name !== name || acknowledged.zone.accountId !== state.accountId || acknowledged.zone.records.length !== 0) throw {zoneEditorDisputed: 'zone_create_acknowledgement_mismatch'}
      let observedZones: DnsZone[]
      try { observedZones = await read() } catch { throw {zoneEditorUnreadable: true} }
      if (token !== generation) return false
      state.zones = observedZones
      const observed = observedZones.find(zone => zone.name === name) ?? null
      if (!observed || observed.records.length !== 0 || observed.serial !== acknowledged.zone.serial) throw {zoneEditorDisputed: 'zone_create_readback_mismatch'}
      state.zoneName = name
      install(observed)
      status('saved')
      return true
    } catch (error) {
      if (token !== generation) return false
      if (zoneObject(error) && typeof error.zoneEditorDisputed === 'string') {state.uncertain = false; state.reason = 'readback'; status('stale')}
      else if (zoneObject(error) && error.zoneEditorUnreadable === true) {state.uncertain = true; state.reason = 'request'; status('uncertain')}
      else if (zoneWriteUncertain(error)) {state.uncertain = true; state.reason = 'request'; status('uncertain')}
      else {state.uncertain = false; state.reason = 'request'; status('failed')}
      return false
    } finally {
      if (token === generation) {state.busy = false; publish()}
    }
  }
  async function deleteZone(confirm: (name: string) => Promise<unknown>): Promise<boolean> {
    if (locked() || !state.loaded) return false
    const zoneName = selectedOwnedName()
    if (!zoneName) {state.reason = 'not-owned'; status('failed'); return false}
    if (!state.zone || state.zone.name !== zoneName) {state.reason = 'missing-zone'; status('failed'); return false}
    const token = ++generation
    state.busy = true
    state.uncertain = false
    state.reason = null
    pending = null
    publish()
    let approved = false
    try { approved = await confirm(zoneName) === true } catch { approved = false }
    if (token !== generation) return false
    if (!approved) {
      state.busy = false
      state.reason = 'confirmation'
      publish()
      return false
    }
    try {
      status('saving')
      const raw = await options.request('DELETE', '/api/dns/zones/' + encodeURIComponent(zoneName))
      try { readDnsZoneDeleteAck(raw) } catch { throw {zoneEditorDisputed: 'invalid_dns_zone_delete_acknowledgement'} }
      let zones: DnsZone[]
      try { zones = await read() } catch { throw {zoneEditorUnreadable: true} }
      if (token !== generation) return false
      state.zones = zones
      if (zones.some(zone => zone.name === zoneName)) throw {zoneEditorDisputed: 'zone_delete_readback_present'}
      state.zone = null
      state.baseline = []
      state.draft = []
      state.loaded = true
      state.uncertain = false
      state.reason = null
      pending = null
      status('deleted')
      return true
    } catch (error) {
      if (token !== generation) return false
      if (zoneObject(error) && typeof error.zoneEditorDisputed === 'string') {state.uncertain = false; state.reason = 'readback'; status('stale')}
      else if (zoneObject(error) && error.zoneEditorUnreadable === true) {state.uncertain = true; state.reason = 'request'; status('uncertain')}
      else if (zoneWriteUncertain(error)) {state.uncertain = true; state.reason = 'request'; status('uncertain')}
      else {state.uncertain = false; state.reason = 'request'; status('failed')}
      return false
    } finally {
      if (token === generation) {state.busy = false; publish()}
    }
  }
  return {state, refresh, selectZone, editRecord, addRecord, removeRecord, save, addZone, deleteZone}
}
function bindZoneEditor(askDialog: unknown): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const confirmDialog: ((options: Record<string, unknown>) => Promise<unknown>) | null = typeof askDialog === 'function' ? askDialog as (options: Record<string, unknown>) => Promise<unknown> : null
  const transport = (window as Window & {xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown>}).xpanelSessionRequest
  document.querySelectorAll<HTMLElement>('[data-dns-editor]').forEach(editor => {
    if (editor.closest('[data-whm-dns-workspace]')) return
    const zoneSelect = editor.querySelector<HTMLSelectElement>('[data-dns-zone]')
    const accountSelect = editor.querySelector<HTMLSelectElement>('[data-dns-account]')
    const newNameInput = editor.querySelector<HTMLInputElement>('[data-dns-new-name]')
    const recordsBody = editor.querySelector<HTMLElement>('[data-dns-records]')
    const status = editor.querySelector<HTMLElement>('[data-dns-status]')
    const addRecordButton = editor.querySelector<HTMLButtonElement>('[data-dns-add-record]')
    const addZoneButton = editor.querySelector<HTMLButtonElement>('[data-dns-add-zone]')
    const saveButton = editor.querySelector<HTMLButtonElement>('[data-dns-save]')
    const deleteButton = editor.querySelector<HTMLButtonElement>('[data-dns-delete]')
    if (!zoneSelect || !accountSelect || !newNameInput || !recordsBody || !status || !addRecordButton || !addZoneButton || !saveButton || !deleteButton) return
    const controls: (HTMLInputElement | HTMLSelectElement | HTMLButtonElement)[] = [zoneSelect, accountSelect, newNameInput, addRecordButton, addZoneButton, saveButton, deleteButton]
    const setUnavailable = (message: string) => {
      for (const control of controls) control.disabled = true
      editor.setAttribute('aria-disabled', 'true')
      status.dataset.state = 'unavailable'
      status.textContent = message
    }
    const accountId = accountSelect.value
    const zoneNames = (): string[] => Array.from(zoneSelect.options).map(option => option.value).filter(name => name !== '')
    if (typeof transport !== 'function' || !accountId || zoneNames().length === 0) {
      setUnavailable(t('Zone editing is unavailable here. Saved zone records were not read and no change is possible.'))
      return
    }
    const send = transport
    const blocked = (): boolean => !!editor.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    if (blocked()) {
      setUnavailable(t('Zone editing is unavailable here. Saved zone records were not read and no change is possible.'))
      return
    }
    const fieldLabel = (field: string): string => field === 'name' ? t('Record name') : field === 'type' ? t('Record type') : field === 'ttl' ? 'TTL' : field === 'content' ? t('Record content') : t('Priority')
    const renderRows = (state: ZoneEditorState, locked: boolean) => {
      recordsBody.textContent = ''
      if (state.draft.length === 0) {
        const row = document.createElement('tr'), cell = document.createElement('td')
        cell.colSpan = 6
        cell.textContent = !state.loaded
          ? t('Zone records have not been read.')
          : state.zone
            ? t('No records are stored in this zone yet.')
            : t('No saved zone record was returned for this name. Add a record to create the desired state.')
        row.append(cell)
        recordsBody.append(row)
        return
      }
      for (const draftRow of state.draft) {
        const row = document.createElement('tr')
        row.dataset.recordId = draftRow.id
        const cell = (child: HTMLElement) => { const td = document.createElement('td'); td.append(child); row.append(td) }
        const textInput = (field: 'name' | 'ttl' | 'content' | 'priority', kind: 'text' | 'number', value: string, min?: number, max?: number) => {
          const input = document.createElement('input')
          input.className = 'xp-input'
          input.type = kind
          input.dir = 'ltr'
          input.value = value
          input.disabled = locked
          input.dataset.zoneField = field
          input.setAttribute('aria-label', fieldLabel(field))
          if (kind === 'number') { input.min = String(min ?? 0); input.step = '1'; if (max !== undefined) input.max = String(max) }
          return input
        }
        cell(textInput('name', 'text', draftRow.name))
        const typeSelect = document.createElement('select')
        typeSelect.className = 'xp-select'
        typeSelect.dir = 'ltr'
        typeSelect.disabled = locked
        typeSelect.dataset.zoneField = 'type'
        typeSelect.setAttribute('aria-label', fieldLabel('type'))
        for (const type of ZONE_RECORD_TYPES) { const option = document.createElement('option'); option.value = type; option.textContent = type; typeSelect.append(option) }
        typeSelect.value = draftRow.type
        cell(typeSelect)
        cell(textInput('ttl', 'number', draftRow.ttl, 0, ZONE_TTL_MAX))
        cell(textInput('content', 'text', draftRow.content))
        cell(textInput('priority', 'number', draftRow.priority, 0, ZONE_PRIORITY_MAX))
        const removeButton = document.createElement('button')
        removeButton.type = 'button'
        removeButton.className = 'xp-btn'
        removeButton.dataset.zoneRemove = ''
        removeButton.disabled = locked
        removeButton.textContent = t('Remove')
        removeButton.setAttribute('aria-label', t('Remove this record row'))
        cell(removeButton)
        recordsBody.append(row)
      }
    }
    const paint = (state: ZoneEditorState) => {
      const blockedNow = blocked(), readLocked = blockedNow || state.busy || state.reading || state.uncertain || !state.loaded
      status.dataset.state = state.status
      status.textContent = blockedNow
        ? t('Zone editing is unavailable here. Saved zone records were not read and no change is possible.')
        : zoneEditorMessage(state)
      editor.setAttribute('aria-busy', String(state.busy || state.reading))
      if (blockedNow) editor.setAttribute('aria-disabled', 'true')
      accountSelect.disabled = true
      zoneSelect.disabled = blockedNow || state.busy
      newNameInput.disabled = readLocked
      addRecordButton.disabled = readLocked
      addZoneButton.disabled = readLocked || newNameInput.value.trim() === ''
      saveButton.disabled = readLocked || !state.dirty
      deleteButton.disabled = readLocked || state.zone === null
      if (state.zoneName && zoneSelect.value !== state.zoneName) zoneSelect.value = state.zoneName
      renderRows(state, readLocked)
    }
    const workspace = createZoneEditor({
      accountId, zoneName: zoneSelect.value, zoneNames,
      request: (method, path, body) => requestZoneEditor(send, () => !blocked(), method, path, body),
      changed: paint,
    })
    const askDiscard = (): Promise<unknown> => {
      if (!workspace.state.dirty && !workspace.state.uncertain) return Promise.resolve(true)
      if (!confirmDialog) return Promise.resolve(false)
      return confirmDialog({
        title: t('Discard unsaved record changes?'),
        body: t('The saved records for the selected zone will be read and unsaved row changes will be discarded. No previous write is retried.'),
        confirm: t('Discard and read'),
        danger: true,
      })
    }
    recordsBody.addEventListener('input', event => {
      const target = event.target
      if (!(target instanceof HTMLInputElement) || target.disabled) return
      const row = target.closest<HTMLElement>('[data-record-id]'), field = target.dataset.zoneField
      if (!row?.dataset.recordId) return
      if (field === 'name') workspace.editRecord(row.dataset.recordId, {name: target.value})
      else if (field === 'ttl') workspace.editRecord(row.dataset.recordId, {ttl: target.value})
      else if (field === 'content') workspace.editRecord(row.dataset.recordId, {content: target.value})
      else if (field === 'priority') workspace.editRecord(row.dataset.recordId, {priority: target.value})
    })
    recordsBody.addEventListener('change', event => {
      const target = event.target
      if (!(target instanceof HTMLSelectElement) || target.disabled || target.dataset.zoneField !== 'type') return
      const row = target.closest<HTMLElement>('[data-record-id]')
      if (!row?.dataset.recordId || !ZONE_RECORD_TYPES.includes(target.value as ZoneRecordType)) return
      workspace.editRecord(row.dataset.recordId, {type: target.value as ZoneRecordType})
    })
    recordsBody.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-zone-remove]') : null
      if (!target || target.disabled || blocked()) return
      const row = target.closest<HTMLElement>('[data-record-id]')
      if (row?.dataset.recordId) workspace.removeRecord(row.dataset.recordId)
    })
    zoneSelect.addEventListener('change', () => {
      if (blocked()) return
      void workspace.selectZone(zoneSelect.value, askDiscard).then(switched => { if (!switched) zoneSelect.value = workspace.state.zoneName })
    })
    newNameInput.addEventListener('input', () => paint(workspace.state))
    addRecordButton.addEventListener('click', () => { if (!blocked() && !addRecordButton.disabled) workspace.addRecord() })
    addZoneButton.addEventListener('click', () => {
      if (blocked() || addZoneButton.disabled) return
      void workspace.addZone(newNameInput.value, askDiscard).then(created => { if (created) { newNameInput.value = ''; paint(workspace.state) } })
    })
    saveButton.addEventListener('click', () => { if (!blocked() && !saveButton.disabled) void workspace.save() })
    deleteButton.addEventListener('click', () => {
      if (blocked() || deleteButton.disabled) return
      if (!confirmDialog) {
        status.dataset.state = 'failed'
        status.textContent = t('Confirmation is unavailable; no zone was deleted.')
        return
      }
      const zoneName = workspace.state.zoneName
      void workspace.deleteZone(() => confirmDialog({
        title: t('Delete DNS zone'),
        body: t('Delete the saved desired-state zone for {zone}? This does not delete the domain and does not claim DNS propagation or serving changes.', { zone: zoneName }),
        confirm: t('Delete zone'),
        danger: true,
      }))
    })
    window.addEventListener('beforeunload', event => {
      if (workspace.state.dirty || workspace.state.uncertain) { event.preventDefault(); event.returnValue = '' }
    })
    paint(workspace.state)
    void workspace.refresh()
  })
}
export const zoneEditorClientBinding = (bind: (...args: never[]) => void, withRuntime = false): string => `(()=>{const ZONE_RECORD_TYPES=${JSON.stringify([...ZONE_RECORD_TYPES])};const ZONE_TTL_DEFAULT=${ZONE_TTL_DEFAULT};const ZONE_TTL_MAX=${ZONE_TTL_MAX};const ZONE_PRIORITY_MAX=${ZONE_PRIORITY_MAX};const ZONE_SERIAL_MIN=${ZONE_SERIAL_MIN};const ZONE_SERIAL_MAX=${ZONE_SERIAL_MAX};const ZONE_RECORD_NAME_PATTERN=${ZONE_RECORD_NAME_PATTERN.toString()};const ZONE_ID_PATTERN=${ZONE_ID_PATTERN.toString()};const ZONE_UNSAFE_TEXT=${ZONE_UNSAFE_TEXT.toString()};const zoneObject=${zoneObject.toString()};const zoneSafeText=${zoneSafeText.toString()};const zoneCanonicalName=${zoneCanonicalName.toString()};const zoneStable=${zoneStable.toString()};const readZoneRecord=${readZoneRecord.toString()};const readDnsZone=${readDnsZone.toString()};const readDnsZones=${readDnsZones.toString()};const readDnsZoneSaveAck=${readDnsZoneSaveAck.toString()};const readDnsZoneDeleteAck=${readDnsZoneDeleteAck.toString()};const zoneWriteUncertain=${zoneWriteUncertain.toString()};const zoneRecordFromDraft=${zoneRecordFromDraft.toString()};const zoneRecordsFromDraft=${zoneRecordsFromDraft.toString()};const zoneDraftFromRecords=${zoneDraftFromRecords.toString()};const zoneSavePayload=${zoneSavePayload.toString()};const requestZoneEditor=${requestZoneEditor.toString()};const zoneEditorMessage=${zoneEditorMessage.toString()};const createZoneEditor=${createZoneEditor.toString()};return ${withRuntime ? "(askDialog) => (" + bind.toString() + ")(askDialog, { ZONE_ID_PATTERN, ZONE_RECORD_TYPES, ZONE_TTL_DEFAULT, ZONE_TTL_MAX, ZONE_PRIORITY_MAX, readDnsZone, readDnsZoneDeleteAck, zoneCanonicalName, zoneDraftFromRecords, zoneObject, zoneRecordsFromDraft, zoneSavePayload, zoneStable, zoneWriteUncertain })" : bind.toString()};})()`

export const ZONE_EDITOR_CLIENT_BINDING = zoneEditorClientBinding(bindZoneEditor)
