/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ZONE_EDITOR_CLIENT_BINDING,
  ZONE_RECORD_TYPES,
  createZoneEditor,
  readDnsZoneDeleteAck,
  readDnsZoneSaveAck,
  readDnsZones,
  readZoneRecord,
  requestZoneEditor,
  zoneCanonicalName,
  zoneDraftFromRecords,
  zoneEditorMessage,
  zoneRecordsFromDraft,
  zoneSavePayload,
  zoneStable,
  zoneWriteUncertain,
  type DnsZone,
  type ZoneEditorState,
  type ZoneRecord,
} from './zone-editor-client.ts'

const accountId = '10000000-0000-4000-8000-000000000001'
const otherAccountId = '20000000-0000-4000-8000-000000000002'
const zoneId = '30000000-0000-4000-8000-000000000003'
const recordId = (index: number): string => '40000000-0000-4000-8000-' + String(index).padStart(12, '0')
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const record = (patch: Partial<ZoneRecord> = {}): ZoneRecord => ({ id: recordId(1), name: '@', type: 'A', ttl: 300, content: '192.0.2.10', priority: null, ...patch })
const zone = (name = 'alpha.test', records: ZoneRecord[] = [record()], serial = 41): DnsZone => ({ id: zoneId, accountId, name, serial, records })
const stateOf = (patch: Partial<ZoneEditorState> = {}): ZoneEditorState => ({ accountId, zones: [], zoneName: 'alpha.test', zone: null, draft: [], baseline: [], loaded: true, dirty: false, busy: false, reading: false, uncertain: false, status: 'read', reason: null, ...patch })
const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(r => { resolve = r }); return { promise, resolve } }
const flush = async () => { for (let index = 0; index < 12; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
type Ask = (options: Record<string, unknown>) => Promise<unknown>
type Call = { method: string; path: string; body?: Record<string, unknown> }
function model() {
  const api = {
    zones: [zone()] as DnsZone[],
    calls: [] as Call[],
    failure: null as unknown,
    throwAfterCommit: null as unknown,
    readback: null as ((zones: DnsZone[]) => DnsZone[]) | null,
    ack: null as ((value: Record<string, unknown>) => unknown) | null,
    async send(method: string, path: string, body?: unknown): Promise<unknown> {
      const copied = body === undefined ? undefined : clone(body) as Record<string, unknown>
      api.calls.push(copied === undefined ? { method, path } : { method, path, body: copied })
      if (method === 'GET') {
        const current = clone(api.zones)
        return { zones: clone(api.readback ? api.readback(current) : current) }
      }
      if (api.failure) throw api.failure
      const name = decodeURIComponent(path.split('/').at(-1)!)
      if (method === 'PUT') {
        const raw = (body ?? {}) as { records?: Record<string, unknown>[] }
        const records = Array.isArray(raw.records) ? raw.records : []
        for (const item of records) {
          if (typeof item.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.id)) throw { status: 400, details: { stateChanged: false } }
          if (typeof item.ttl !== 'number' || !Number.isSafeInteger(item.ttl)) throw { status: 400, details: { stateChanged: false } }
          if (((item.type === 'MX' || item.type === 'SRV') !== (typeof item.priority === 'number'))) throw { status: 400, details: { stateChanged: false } }
        }
        const existing = api.zones.find(item => item.name === name)
        const saved: DnsZone = {
          id: existing?.id ?? zoneId,
          accountId,
          name,
          serial: existing ? existing.serial + 1 : 2026102201,
          records: records.map(item => ({ id: String(item.id).toLowerCase(), name: String(item.name), type: item.type as ZoneRecord['type'], ttl: Number(item.ttl), content: String(item.content), priority: typeof item.priority === 'number' ? item.priority : null })),
        }
        api.zones = existing ? api.zones.map(item => item.name === name ? saved : item) : [...api.zones, saved]
        const acknowledgement = { zone: clone(saved), reconcile: null }
        if (api.throwAfterCommit) throw api.throwAfterCommit
        return api.ack ? api.ack(acknowledgement) : acknowledgement
      }
      if (method === 'DELETE') {
        api.zones = api.zones.filter(item => item.name !== name)
        return { ok: true, reconcile: null }
      }
      throw new Error('unexpected transport ' + method)
    },
  }
  return api
}
const writes = (api: ReturnType<typeof model>): Call[] => api.calls.filter(call => call.method !== 'GET')
const setup = async (options: { names?: string[]; zoneName?: string; newRecordId?: () => string } = {}) => {
  const api = model()
  let next = 2
  const workspace = createZoneEditor({ accountId, zoneName: options.zoneName ?? 'alpha.test', zoneNames: options.names ?? ['alpha.test', 'beta.test'], request: api.send, newRecordId: options.newRecordId ?? (() => recordId(next++)) })
  await workspace.refresh()
  return { api, workspace }
}

describe('zone editor boundary validation', () => {
  it('canonicalizes rendered zone names and refuses unsafe input', () => {
    expect(zoneCanonicalName('ALPHA.TEST.')).toBe('alpha.test')
    expect(zoneCanonicalName('bücher.example')).toBe('xn--bcher-kva.example')
    for (const raw of ['', ' alpha.test', 'alpha.test ', 'single', 'alpha test', 'alpha.test/path', 'a\u2028b.test', 'alpha..test'])
      expect(() => zoneCanonicalName(raw), raw).toThrow()
  })
  it('rejects unsafe or incomplete record data before painting', () => {
    expect(ZONE_RECORD_TYPES).toContain('MX')
    expect(readZoneRecord({ ...record(), id: recordId(1) })).toEqual(record())
    expect(readZoneRecord({ ...record(), zone: 'alpha.test' })).toEqual(record())
    expect(readZoneRecord({ id: recordId(1), name: '@', type: 'A', content: '192.0.2.10' }).ttl).toBe(14400)
    const faults: Record<string, unknown>[] = [
      { ...record(), id: 'not-a-uuid' },
      { ...record(), name: 'WWW' },
      { ...record(), type: 'TXT2' },
      { ...record(), ttl: 3.5 },
      { ...record(), ttl: -1 },
      { ...record(), ttl: 2147483648 },
      { ...record(), content: '' },
      { ...record(), content: '192.0.2.10\u2028' },
      { ...record(), priority: 10 },
      { ...record({ name: 'mail', type: 'MX', content: 'mail.alpha.test' }), priority: null },
      { ...record({ name: 'mail', type: 'MX', content: 'mail.alpha.test' }), priority: 70000 },
    ]
    for (const fault of faults) expect(() => readZoneRecord(fault), JSON.stringify(fault)).toThrow()
  })
  it('keeps only validated account-owned zones and never exposes a foreign tenant', () => {
    const payload = { zones: [zone(), { ...zone('beta.test'), accountId: otherAccountId }] }
    expect(readDnsZones(payload, accountId).map(item => item.name)).toEqual(['alpha.test'])
    const foreignOnly = { zones: [{ ...zone('beta.test'), accountId: otherAccountId, records: [{ id: 'bad' }] }] }
    expect(readDnsZones(foreignOnly, accountId)).toEqual([])
    expect(() => readDnsZones({ zones: [zone(), zone()] }, accountId)).toThrow()
    expect(() => readDnsZones({ zones: [{ ...zone('gamma.test'), serial: 0 }] }, accountId)).toThrow()
    expect(() => readDnsZones({ zones: [{ ...zone(), records: [{ ...record(), id: 'bad' }] }] }, accountId)).toThrow()
    expect(() => readDnsZones({ zones: 'private' }, accountId)).toThrow()
    expect(() => readDnsZones({ zones: [] }, 'not-an-account-id')).toThrow()
  })
  it('rejects incomplete acknowledgements and review flags', () => {
    expect(readDnsZoneSaveAck({ zone: clone(zone()), reconcile: null }).zone.name).toBe('alpha.test')
    expect(() => readDnsZoneSaveAck({})).toThrow()
    expect(() => readDnsZoneSaveAck({ zone: {} })).toThrow()
    expect(() => readDnsZoneSaveAck({ zone: clone(zone()), details: { verificationRequired: true } })).toThrow()
    expect(() => readDnsZoneSaveAck({ zone: clone(zone()), unknownOutcome: true })).toThrow()
    expect(readDnsZoneDeleteAck({ ok: true, reconcile: null })).toBe(true)
    expect(() => readDnsZoneDeleteAck({ ok: false })).toThrow()
    expect(() => readDnsZoneDeleteAck({ ok: true, details: { unknownOutcome: true } })).toThrow()
  })
  it('round-trips drafts into the exact records-only PUT payload', () => {
    const records = [record(), record({ id: recordId(2), name: 'mail', type: 'MX', ttl: 600, content: 'mail.alpha.test', priority: 10 })]
    const payload = zoneSavePayload(records)
    expect(Object.keys(payload)).toEqual(['records'])
    expect(payload.records[0]).toEqual({ id: recordId(1), name: '@', type: 'A', ttl: 300, content: '192.0.2.10' })
    expect(Object.hasOwn(payload.records[0]!, 'priority')).toBe(false)
    expect(payload.records[1]).toEqual({ id: recordId(2), name: 'mail', type: 'MX', ttl: 600, content: 'mail.alpha.test', priority: 10 })
    const draft = zoneDraftFromRecords(records)
    expect(draft.map(row => row.ttl)).toEqual(['300', '600'])
    expect(zoneStable(zoneRecordsFromDraft(draft))).toBe(zoneStable(records))
    const defaults = zoneRecordsFromDraft([{ ...draft[0]!, ttl: '', priority: '' }])
    expect(defaults[0]).toMatchObject({ ttl: 14400, priority: null })
    expect(() => zoneRecordsFromDraft([{ ...draft[0]!, ttl: '3.5' }])).toThrow()
    expect(() => zoneRecordsFromDraft([{ ...draft[0]!, priority: '10' }])).toThrow()
    expect(() => zoneRecordsFromDraft([{ ...draft[0]!, name: 'WWW' }])).toThrow()
  })
  it('treats only explicit refusals as safe and transport outcomes as uncertain', () => {
    expect(zoneWriteUncertain({ status: 422, details: { stateChanged: false } })).toBe(false)
    expect(zoneWriteUncertain({ status: 403 })).toBe(false)
    expect(zoneWriteUncertain({ status: 503 })).toBe(true)
    expect(zoneWriteUncertain({ details: { verificationRequired: true } })).toBe(true)
    expect(zoneWriteUncertain({ details: { stateChanged: true } })).toBe(true)
    expect(zoneWriteUncertain(new Error('offline'))).toBe(true)
  })
  it('states desired-state readback without claiming DNS serving or propagation', () => {
    const read = zoneEditorMessage(stateOf({ zone: zone() }))
    expect(read).toMatch(/read from saved desired state/)
    expect(read).toMatch(/serving and propagation are not verified/)
    expect(zoneEditorMessage(stateOf({ status: 'saved', zone: zone() }))).toMatch(/saved and read back.*not verified/)
    expect(zoneEditorMessage(stateOf({ status: 'deleted', zone: null }))).toMatch(/absent.*not verified/)
    expect(zoneEditorMessage(stateOf({ status: 'read', zone: null }))).toMatch(/creates the zone in desired state/)
    expect(zoneEditorMessage(stateOf({ status: 'failed', reason: 'invalid-records' }))).toMatch(/nothing was sent/)
    document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl'
    const arabic = zoneEditorMessage(stateOf({ status: 'saved', zone: zone() }))
    const deleteBody = xpT('Delete the saved desired-state zone for {zone}? This does not delete the domain and does not claim DNS propagation or serving changes.', { zone: 'alpha.test' })
    document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'
    expect(deleteBody).toBe('هل تريد حذف المنطقة المحفوظة في الحالة المطلوبة للنطاق alpha.test؟ لا يحذف هذا النطاق نفسه ولا يدّعي تغيير نشر DNS أو الخدمة.')
    expect(arabic).toMatch(/[\u0600-\u06ff]/)
    expect(arabic).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    expect(zoneEditorMessage(stateOf({ status: 'unavailable' }))).toMatch(/unavailable/)
    for (const message of [read, arabic]) expect(message).not.toMatch(/\bsaved\b.*\bpropagated\b/i)
  })
  it('refuses unilateral mutations while allowing reads through the transport guard', async () => {
    const calls: string[] = []
    const transport = async (method: string) => { calls.push(method); return {} }
    await expect(requestZoneEditor(transport, () => false, 'PUT', '/api/dns/zones/alpha.test', { records: [] })).rejects.toEqual({ details: { stateChanged: false } })
    await expect(requestZoneEditor(transport, () => false, 'DELETE', '/api/dns/zones/alpha.test')).rejects.toEqual({ details: { stateChanged: false } })
    expect(calls).toEqual([])
    await requestZoneEditor(transport, () => false, 'GET', '/api/dns/zones')
    await requestZoneEditor(transport, () => true, 'PUT', '/api/dns/zones/alpha.test', { records: [] })
    expect(calls).toEqual(['GET', 'PUT'])
  })
})

describe('zone editor controller', () => {
  it('reads the selected account-owned zone into an editable draft', async () => {
    const { api, workspace } = await setup()
    expect(workspace.state.status).toBe('read')
    expect(workspace.state.loaded).toBe(true)
    expect(workspace.state.zone!.serial).toBe(41)
    expect(workspace.state.draft).toEqual([{ id: recordId(1), name: '@', type: 'A', ttl: '300', content: '192.0.2.10', priority: '' }])
    expect(api.calls).toEqual([{ method: 'GET', path: '/api/dns/zones' }])
  })
  it('represents an absent zone as a truthful empty draft', async () => {
    const { workspace } = await setup({ zoneName: 'beta.test' })
    expect(workspace.state.loaded).toBe(true)
    expect(workspace.state.zone).toBeNull()
    expect(workspace.state.draft).toEqual([])
    expect(workspace.state.dirty).toBe(false)
    expect(zoneEditorMessage(workspace.state)).toMatch(/No saved zone record was returned/)
  })
  it('keeps unread state and hides foreign data after a malformed read', async () => {
    const api = model()
    api.zones = [{ ...zone(), records: [{ ...record(), id: 'bad' }] }]
    const workspace = createZoneEditor({ accountId, zoneName: 'alpha.test', zoneNames: ['alpha.test'], request: api.send })
    expect(await workspace.refresh()).toBe(false)
    expect(workspace.state.status).toBe('failed')
    expect(workspace.state.loaded).toBe(false)
    expect(workspace.state.draft).toEqual([])
    api.zones = [{ ...zone(), accountId: otherAccountId }]
    expect(await workspace.refresh()).toBe(true)
    expect(workspace.state.zones).toEqual([])
    expect(workspace.state.zone).toBeNull()
    expect(workspace.state.status).toBe('read')
  })
  it('tracks added, edited and removed draft rows without sending writes', async () => {
    const { api, workspace } = await setup()
    expect(workspace.addRecord()).toBe(true)
    expect(workspace.state.dirty).toBe(true)
    const added = workspace.state.draft[1]!
    expect(added).toEqual({ id: recordId(2), name: '@', type: 'A', ttl: '14400', content: '', priority: '' })
    expect(workspace.editRecord(added.id, { name: 'www', ttl: '600', content: '192.0.2.11' })).toBe(true)
    expect(workspace.editRecord('missing-record', { name: 'x' })).toBe(false)
    expect(workspace.removeRecord(added.id)).toBe(true)
    expect(workspace.state.draft).toHaveLength(1)
    expect(workspace.state.dirty).toBe(false)
    expect(writes(api)).toEqual([])
  })
  it('saves the exact records array and verifies the serial readback', async () => {
    const { api, workspace } = await setup()
    workspace.addRecord()
    workspace.editRecord(workspace.state.draft[1]!.id, { name: 'www', ttl: '600', content: '192.0.2.11' })
    expect(await workspace.save()).toBe(true)
    const put = writes(api)[0]!
    expect(put).toEqual({
      method: 'PUT',
      path: '/api/dns/zones/alpha.test',
      body: {
        records: [
          { id: recordId(1), name: '@', type: 'A', ttl: 300, content: '192.0.2.10' },
          { id: recordId(2), name: 'www', type: 'A', ttl: 600, content: '192.0.2.11' },
        ],
      },
    })
    expect(Object.keys((put!.body ?? {}))).toEqual(['records'])
    expect(api.calls.map(call => call.method)).toEqual(['GET', 'PUT', 'GET'])
    expect(workspace.state.status).toBe('saved')
    expect(workspace.state.dirty).toBe(false)
    expect(workspace.state.zone!.serial).toBe(42)
    expect(zoneStable(workspace.state.baseline)).toBe(zoneStable(workspace.state.zone!.records))
  })
  it('includes MX priority only where the state layer requires it', async () => {
    const { api, workspace } = await setup()
    workspace.addRecord()
    const added = workspace.state.draft[1]!.id
    workspace.editRecord(added, { name: 'mail', type: 'MX', ttl: '600', content: 'mail.alpha.test', priority: '10' })
    expect(await workspace.save()).toBe(true)
    const put = writes(api)[0]!
    expect(put.body!.records).toEqual([
      { id: recordId(1), name: '@', type: 'A', ttl: 300, content: '192.0.2.10' },
      { id: recordId(2), name: 'mail', type: 'MX', ttl: 600, content: 'mail.alpha.test', priority: 10 },
    ])
  })
  it('refuses invalid record fields before any transport', async () => {
    const { api, workspace } = await setup()
    workspace.addRecord()
    workspace.editRecord(workspace.state.draft[1]!.id, { ttl: '3.5' })
    expect(await workspace.save()).toBe(false)
    expect(workspace.state.status).toBe('failed')
    expect(workspace.state.reason).toBe('invalid-records')
    expect(workspace.state.draft[1]!.ttl).toBe('3.5')
    expect(writes(api)).toEqual([])
  })
  it('keeps the draft when readback records or serial do not match', async () => {
    const { api, workspace } = await setup()
    workspace.editRecord(workspace.state.draft[0]!.id, { content: '192.0.2.99' })
    api.readback = zones => zones.map(item => ({ ...item, serial: item.serial + 1 }))
    expect(await workspace.save()).toBe(false)
    expect(workspace.state.status).toBe('stale')
    expect(workspace.state.dirty).toBe(true)
    expect(workspace.state.draft[0]!.content).toBe('192.0.2.99')
    api.readback = zones => zones.map(item => ({ ...item, records: [] }))
    expect(await workspace.save()).toBe(false)
    expect(workspace.state.status).toBe('stale')
    expect(workspace.state.draft[0]!.content).toBe('192.0.2.99')
  })
  it('does not call a mismatched acknowledgement saved', async () => {
    const { api, workspace } = await setup()
    workspace.editRecord(workspace.state.draft[0]!.id, { content: '192.0.2.99' })
    api.ack = value => ({ ...value, zone: { ...(value.zone as DnsZone), name: 'beta.test' } })
    expect(await workspace.save()).toBe(false)
    expect(workspace.state.status).toBe('stale')
    expect(workspace.state.draft[0]!.content).toBe('192.0.2.99')
  })
  it('keeps the draft after an explicit server refusal', async () => {
    const { api, workspace } = await setup()
    workspace.editRecord(workspace.state.draft[0]!.id, { content: '192.0.2.99' })
    api.failure = { status: 403, details: { stateChanged: false } }
    expect(await workspace.save()).toBe(false)
    expect(workspace.state.status).toBe('failed')
    expect(workspace.state.uncertain).toBe(false)
    expect(workspace.state.draft[0]!.content).toBe('192.0.2.99')
  })
  it('requires review for an unknown outcome and re-locks until a fresh read', async () => {
    const { api, workspace } = await setup()
    workspace.editRecord(workspace.state.draft[0]!.id, { content: '192.0.2.99' })
    api.failure = new Error('offline')
    expect(await workspace.save()).toBe(false)
    expect(workspace.state.status).toBe('uncertain')
    expect(workspace.state.uncertain).toBe(true)
    expect(await workspace.save()).toBe(false)
    expect(writes(api)).toHaveLength(1)
    api.failure = null
    await workspace.refresh()
    expect(workspace.state.uncertain).toBe(false)
    expect(workspace.state.status).toBe('failed')
    expect(workspace.state.draft[0]!.content).toBe('192.0.2.99')
    expect(await workspace.save()).toBe(true)
    expect(writes(api)).toHaveLength(2)
  })
  it('resolves an applied but unreadable write only from matching readback', async () => {
    const { api, workspace } = await setup()
    workspace.editRecord(workspace.state.draft[0]!.id, { content: '192.0.2.99' })
    api.throwAfterCommit = { status: 503 }
    expect(await workspace.save()).toBe(false)
    expect(workspace.state.status).toBe('uncertain')
    await workspace.refresh()
    expect(workspace.state.uncertain).toBe(false)
    expect(workspace.state.status).toBe('saved')
    expect(workspace.state.dirty).toBe(false)
  })
  it('deletes only after explicit confirmation and verifies absence', async () => {
    const { api, workspace } = await setup()
    expect(await workspace.deleteZone(async () => false)).toBe(false)
    expect(writes(api)).toEqual([])
    expect(workspace.state.zoneName).toBe('alpha.test')
    expect(workspace.state.zone!.name).toBe('alpha.test')
    expect(await workspace.deleteZone(async () => true)).toBe(true)
    expect(writes(api)[0]).toEqual({ method: 'DELETE', path: '/api/dns/zones/alpha.test' })
    expect(workspace.state.status).toBe('deleted')
    expect(workspace.state.zoneName).toBe('alpha.test')
    expect(workspace.state.zone).toBeNull()
    expect(workspace.state.draft).toEqual([])
    expect(workspace.state.zones.some(item => item.name === 'alpha.test')).toBe(false)
  })
  it('does not report a delete saved while the readback still returns the zone', async () => {
    const { api, workspace } = await setup()
    api.readback = zones => [...zones, zone()]
    expect(await workspace.deleteZone(async () => true)).toBe(false)
    expect(workspace.state.status).toBe('stale')
    expect(workspace.state.zone).not.toBeNull()
  })
  it('adds a zone only when the name is valid, owned and absent', async () => {
    const { api, workspace } = await setup()
    expect(await workspace.addZone('not a name')).toBe(false)
    expect(workspace.state.reason).toBe('invalid-zone-name')
    expect(await workspace.addZone('gamma.test')).toBe(false)
    expect(workspace.state.reason).toBe('not-owned')
    expect(await workspace.addZone('alpha.test')).toBe(false)
    expect(workspace.state.reason).toBe('zone-exists')
    expect(writes(api)).toEqual([])
    expect(await workspace.addZone('BETA.TEST.')).toBe(true)
    const put = writes(api)[0]!
    expect(put).toEqual({ method: 'PUT', path: '/api/dns/zones/beta.test', body: { records: [] } })
    expect(workspace.state.status).toBe('saved')
    expect(workspace.state.zoneName).toBe('beta.test')
    expect(workspace.state.zone!.records).toEqual([])
    expect(workspace.state.zone!.serial).toBe(2026102201)
  })
  it('switches selection by reading saved records and requires a discard confirmation', async () => {
    const { api, workspace } = await setup()
    workspace.addRecord()
    expect(await workspace.selectZone('beta.test')).toBe(false)
    expect(workspace.state.zoneName).toBe('alpha.test')
    expect(workspace.state.draft).toHaveLength(2)
    expect(await workspace.selectZone('beta.test', async () => false)).toBe(false)
    expect(workspace.state.zoneName).toBe('alpha.test')
    expect(await workspace.selectZone('beta.test', async () => true)).toBe(true)
    expect(workspace.state.zoneName).toBe('beta.test')
    expect(workspace.state.draft).toEqual([])
    expect(writes(api)).toEqual([])
  })
  it('requires a discard confirmation before creating a zone over a dirty draft', async () => {
    const { api, workspace } = await setup()
    workspace.addRecord()
    expect(await workspace.addZone('beta.test')).toBe(false)
    expect(writes(api)).toEqual([])
    expect(workspace.state.draft).toHaveLength(2)
    expect(await workspace.addZone('beta.test', async () => true)).toBe(true)
    expect(writes(api)[0]).toEqual({ method: 'PUT', path: '/api/dns/zones/beta.test', body: { records: [] } })
  })
  it('never discards a pending draft while a discard dialog is unresolved', async () => {
    const { workspace } = await setup()
    workspace.addRecord()
    const dialog = deferred()
    const switching = workspace.selectZone('beta.test', () => dialog.promise)
    expect(workspace.state.busy).toBe(true)
    expect(workspace.editRecord(workspace.state.draft[1]!.id, { name: 'www' })).toBe(false)
    expect(workspace.state.draft[1]!.name).toBe('@')
    dialog.resolve(false)
    await switching
    expect(workspace.state.busy).toBe(false)
    expect(workspace.state.zoneName).toBe('alpha.test')
    expect(workspace.state.draft).toHaveLength(2)
    expect(workspace.state.draft[1]!.name).toBe('@')
    expect(workspace.state.dirty).toBe(true)
  })
})

describe('serialized browser binding', () => {
  const editorMarkup = () => `<section data-approved-xpanel-workspace="/domains/zone-editor"><section data-dns-editor>
    <select data-dns-zone><option value="alpha.test">alpha.test</option><option value="beta.test">beta.test</option></select>
    <select data-dns-account><option value="${accountId}">alice</option></select>
    <input data-dns-new-name>
    <table><tbody data-dns-records></tbody></table>
    <p data-dns-status role="status">Reading zone records…</p>
    <button type="button" data-dns-add-record>Add record</button>
    <button type="button" data-dns-add-zone>Add zone</button>
    <button type="button" data-dns-save>Save zone</button>
    <button type="button" data-dns-delete>Delete zone</button>
  </section></section>`
  const controls = () => Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('[data-dns-editor] input, [data-dns-editor] select, [data-dns-editor] button'))
  const bindEditor = (askDialog?: Ask) => {
    const factory = new Function('return ' + ZONE_EDITOR_CLIENT_BINDING)() as (ask: unknown) => void
    factory(askDialog)
  }
  const status = () => document.querySelector<HTMLElement>('[data-dns-status]')!
  const button = (name: string) => document.querySelector<HTMLButtonElement>('[data-dns-' + name + ']')!
  const rowInput = (index: number, field: string): HTMLInputElement => Array.from(document.querySelectorAll<HTMLTableRowElement>('[data-dns-records] tr'))[index]!.querySelector<HTMLInputElement>('[data-zone-field="' + field + '"]')!
  beforeEach(() => {
    document.body.replaceChildren()
    document.documentElement.lang = 'en'
    delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
    delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  })
  it('serializes a standalone binding with no module closure or fetch', () => {
    expect(new Function('return ' + ZONE_EDITOR_CLIENT_BINDING)()).toBeTypeOf('function')
    expect(ZONE_EDITOR_CLIENT_BINDING).toContain('xpanelSessionRequest')
    expect(ZONE_EDITOR_CLIENT_BINDING).toContain('readDnsZones')
    expect(ZONE_EDITOR_CLIENT_BINDING).toContain('createZoneEditor')
    expect(ZONE_EDITOR_CLIENT_BINDING).not.toContain('fetch(')
    expect(ZONE_EDITOR_CLIENT_BINDING).not.toContain('XMLHttpRequest')
    expect(ZONE_EDITOR_CLIENT_BINDING).not.toContain('import(')
  })
  it('disables every control and never reads inside a denied wrapper', async () => {
    document.body.innerHTML = '<div data-capability-unavailable="true">' + editorMarkup() + '</div>'
    const send = vi.fn(async () => ({ zones: [zone()] }))
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    bindEditor(vi.fn(async () => true))
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect(controls()).toHaveLength(7)
    for (const control of controls()) expect(control.disabled, control.outerHTML).toBe(true)
    expect(status().dataset.state).toBe('unavailable')
    expect(status().textContent).toMatch(/unavailable/)
  })
  it('shows an explicit unavailable state when the session transport is missing', async () => {
    document.body.innerHTML = editorMarkup()
    bindEditor(vi.fn(async () => true))
    await flush()
    for (const control of controls()) expect(control.disabled).toBe(true)
    expect(status().dataset.state).toBe('unavailable')
  })
  it('reads, edits, saves and deletes through the rendered hooks', async () => {
    document.body.innerHTML = editorMarkup()
    const api = model()
    const send = vi.fn(api.send)
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    const askDialog = vi.fn(async (_options: Record<string, unknown>) => true)
    bindEditor(askDialog)
    await flush()
    expect(send).toHaveBeenCalledWith('GET', '/api/dns/zones', undefined)
    expect(document.querySelectorAll('[data-dns-records] tr')).toHaveLength(1)
    expect(rowInput(0, 'name').value).toBe('@')
    expect(status().textContent).toMatch(/read from saved desired state/)
    expect(status().textContent).toMatch(/not verified/)
    expect(button('save').disabled).toBe(true)
    expect(button('delete').disabled).toBe(false)
    rowInput(0, 'content').value = '192.0.2.99'
    rowInput(0, 'content').dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    expect(button('save').disabled).toBe(false)
    button('add-record').click()
    await flush()
    expect(document.querySelectorAll('[data-dns-records] tr')).toHaveLength(2)
    rowInput(1, 'name').value = 'www'
    rowInput(1, 'name').dispatchEvent(new Event('input', { bubbles: true }))
    rowInput(1, 'ttl').value = '600'
    rowInput(1, 'ttl').dispatchEvent(new Event('input', { bubbles: true }))
    rowInput(1, 'content').value = '192.0.2.11'
    rowInput(1, 'content').dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    button('save').click()
    await flush()
    const put = api.calls.find(call => call.method === 'PUT')!
    expect(put.path).toBe('/api/dns/zones/alpha.test')
    const body = put.body as { records: Record<string, unknown>[] }
    expect(Object.keys(put.body!)).toEqual(['records'])
    expect(body.records[0]).toEqual({ id: recordId(1), name: '@', type: 'A', ttl: 300, content: '192.0.2.99' })
    expect(body.records[1]).toMatchObject({ name: 'www', type: 'A', ttl: 600, content: '192.0.2.11' })
    expect(body.records[1]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(status().textContent).toMatch(/saved and read back/)
    expect(button('save').disabled).toBe(true)
    expect(button('delete').disabled).toBe(false)
    button('delete').click()
    await flush()
    expect(askDialog).toHaveBeenCalledTimes(1)
    expect((askDialog.mock.calls[0]![0] as Record<string, unknown>).danger).toBe(true)
    expect((askDialog.mock.calls[0]![0] as Record<string, unknown>).body).toBe('Delete the saved desired-state zone for alpha.test? This does not delete the domain and does not claim DNS propagation or serving changes.')
    const remove = api.calls.find(call => call.method === 'DELETE')!
    expect(remove.path).toBe('/api/dns/zones/alpha.test')
    expect(status().textContent).toMatch(/deleted from saved desired state/)
    expect(button('delete').disabled).toBe(true)
  })
})
