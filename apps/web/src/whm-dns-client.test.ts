// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmDnsWorkspace } from './board-port/whm-dns-workspace.ts'
import { WHM_DNS_CLIENT_BINDING } from './whm-dns-client.ts'

const id = (value: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(value).padStart(12, '0')
const zone = (patch: Record<string, unknown> = {}) => ({ id: id(1), accountId: id(2), name: 'alpha.example.test', serial: 7,
  records: [{ id: id(3), name: '@', type: 'A', ttl: 0, content: '192.0.2.1', priority: null }], revision: '7'.padStart(64, '0'), ...patch })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const button = (key: string) => document.querySelector<HTMLButtonElement>('[data-dns-' + key + ']')!
const status = () => document.querySelector<HTMLElement>('[data-dns-status]')!
const field = (key: string) => document.querySelector<HTMLInputElement>('[data-field="' + key + '"]')!
const edit = (key: string, value: string) => { field(key).value = value; field(key).dispatchEvent(new Event('input')) }
let beforeUnload: EventListener[]

beforeEach(() => {
  beforeUnload = []
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, callback, options) => { if (name === 'beforeunload') beforeUnload.push(callback as EventListener); add(name, callback, options) })
  document.body.innerHTML = '<div data-whm-dns-workspace>' + renderWhmDnsWorkspace({ locale: 'en', title: 'DNS zones', principal: { kind: 'root', id: id(4), username: 'root' }, accounts: [{ id: id(2), username: 'Alpha account' }] as never }) + '<span data-whm-dns-zone-count>Not read</span><table><tbody data-whm-dns-zone-rows></tbody></table><dd data-whm-dns-soa-serial>Not read</dd><p data-provider-health>Not read</p></div>'
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})
afterEach(() => { for (const listener of beforeUnload) window.removeEventListener('beforeunload', listener); vi.restoreAllMocks(); document.body.replaceChildren() })

const model = () => {
  let zones = [zone()], mode = 'normal'
  const send = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (method === 'GET') {
      if (mode === 'read-error') throw new Error('unread')
      return { zones: clone(zones) }
    }
    if (mode === 'denied') throw { status: 422, details: { stateChanged: false } }
    if (mode === 'uncertain') throw { status: 503, details: { unknownOutcome: true } }
    const name = decodeURIComponent(path.split('/').at(-1)!)
    if (method === 'DELETE') { zones = zones.filter(item => item.name !== name); return { ok: true } }
    if (method === 'PUT') {
      const input = body as Record<string, unknown>, old = zones.find(item => item.name === name)
      const saved = zone({ id: old?.id ?? id(5), accountId: old?.accountId ?? input.accountId ?? null, name,
        serial: (old?.serial ?? 0) + 1, records: clone(input.records), revision: String((old?.serial ?? 0) + 1).padStart(64, '0') })
      zones = [...zones.filter(item => item.name !== name), saved]
      return { zone: clone(mode === 'wrong-ack' ? { ...saved, name: 'other.example.test' } : saved), revision: saved.revision }
    }
    throw new Error('unexpected_request')
  })
  const ask = vi.fn(async () => true)
  const boot = () => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + WHM_DNS_CLIENT_BINDING)()(ask) }
  return { send, ask, boot, setMode: (value: string) => { mode = value }, setZones: (value: ReturnType<typeof zone>[]) => { zones = value }, writes: () => send.mock.calls.filter(call => call[0] !== 'GET') }
}

describe('xWHM DNS controller', () => {
  it('builds a self-contained runtime and preserves all existing editor actions', () => {
    expect(() => new Function('return ' + WHM_DNS_CLIENT_BINDING)()).not.toThrow()
    expect(WHM_DNS_CLIENT_BINDING).not.toContain('fetch(')
    expect(WHM_DNS_CLIENT_BINDING).not.toContain('innerHTML')
    for (const key of ['refresh', 'add-record', 'add-zone', 'save', 'delete']) expect(button(key)).not.toBeNull()
  })
  it('does not read or mutate when the transport or capability admission is missing', async () => {
    new Function('return ' + WHM_DNS_CLIENT_BINDING)()(undefined)
    expect(status().dataset.state).toBe('unavailable')
    expect(button('save').disabled).toBe(true)
    document.querySelector<HTMLElement>('[data-dns-editor]')!.removeAttribute('data-dns-bound')
    document.querySelector<HTMLElement>('[data-whm-dns-workspace]')!.dataset.capabilityUnavailable = 'true'
    const f = model(); f.boot(); await tick()
    expect(f.send).not.toHaveBeenCalled()
  })
  it('reads the exact server serial, preserves TTL zero, and exposes account labels without internal IDs', async () => {
    const f = model(); f.boot(); await tick()
    expect(status().dataset.state).toBe('read')
    expect(field('ttl').value).toBe('0')
    expect(document.querySelector('[data-whm-dns-soa-serial]')!.textContent).toBe('7')
    expect(document.querySelector('[data-whm-dns-zone-rows]')!.textContent).toContain('Alpha account')
    expect(document.querySelector('[data-whm-dns-zone-rows]')!.textContent).not.toContain(id(2))
    expect(document.querySelector('[data-provider-health]')!.textContent).toBe('Not read')
    expect(button('save').disabled).toBe(true)
  })
  it('retains text-entry focus while editing and sends only records plus the captured revision', async () => {
    const f = model(); f.boot(); await tick()
    const input = field('content'); input.focus(); edit('content', '192.0.2.99')
    expect(document.activeElement).toBe(input)
    button('save').click(); await tick(); await tick()
    expect(f.writes()).toHaveLength(1)
    expect(f.writes()[0]![2]).toEqual({ expectedZoneRevision: '7'.padStart(64, '0'), records: [{ id: id(3), name: '@', type: 'A', ttl: 0, content: '192.0.2.99' }] })
    expect(status().dataset.state).toBe('saved')
    expect(document.querySelector('[data-whm-dns-soa-serial]')!.textContent).toBe('8')
  })
  it('cancels saving, deletion and creation without a read or write', async () => {
    const f = model(); f.ask.mockResolvedValue(false); f.boot(); await tick(); edit('content', '192.0.2.2')
    const reads = f.send.mock.calls.length
    button('save').click(); await tick(); button('delete').click(); await tick()
    const name = document.querySelector<HTMLInputElement>('[data-dns-new-name]')!; name.value = 'new.example.test'; name.dispatchEvent(new Event('input'))
    button('add-zone').click(); await tick()
    expect(f.ask).toHaveBeenCalledTimes(3)
    expect(f.send.mock.calls).toHaveLength(reads)
    expect(field('content').value).toBe('192.0.2.2')
  })
  it('refuses invalid row data locally without opening a confirmation or writing', async () => {
    const f = model(); f.boot(); await tick(); edit('ttl', '-1'); button('save').click(); await tick()
    expect(status().dataset.state).toBe('failed'); expect(f.ask).not.toHaveBeenCalled(); expect(f.writes()).toHaveLength(0)
  })
  it('preserves stale drafts and requires an explicit discard before another write', async () => {
    const f = model(); f.boot(); await tick(); edit('content', '192.0.2.9')
    f.setZones([zone({ serial: 8, revision: '8'.padStart(64, '0') })])
    button('save').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('stale'); expect(f.writes()).toHaveLength(0)
    expect(field('content').value).toBe('192.0.2.9'); expect(button('save').disabled).toBe(true)
    f.ask.mockResolvedValue(false); button('refresh').click(); await tick()
    expect(status().dataset.state).toBe('stale'); expect(field('content').value).toBe('192.0.2.9')
    f.ask.mockResolvedValue(true); button('refresh').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('read'); expect(field('content').value).toBe('192.0.2.1')
  })
  it.each(['uncertain', 'wrong-ack'])('locks the draft after %s and never retries the mutation', async mode => {
    const f = model(); f.boot(); await tick(); edit('content', '192.0.2.9'); f.setMode(mode)
    button('save').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('uncertain'); expect(f.writes()).toHaveLength(1)
    expect(button('save').disabled).toBe(true); expect(field('content').value).toBe('192.0.2.9')
  })
  it('keeps a definitely refused draft editable', async () => {
    const f = model(); f.boot(); await tick(); edit('content', '192.0.2.9'); f.setMode('denied')
    button('save').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('failed'); expect(button('save').disabled).toBe(false); expect(field('content').value).toBe('192.0.2.9')
  })
  it('re-reads saved zones after confirming a selection switch out of an unknown outcome', async () => {
    const f = model()
    f.setZones([zone(), zone({ id: id(8), name: 'other.example.test' })]); f.boot(); await tick()
    edit('content', '192.0.2.9'); f.setMode('uncertain'); button('save').click(); await tick(); await tick()
    const reads = f.send.mock.calls.filter(call => call[0] === 'GET').length
    f.setMode('normal')
    const select = document.querySelector<HTMLSelectElement>('[data-dns-zone]')!; select.value = 'other.example.test'; select.dispatchEvent(new Event('change'))
    await tick(); await tick()
    expect(f.send.mock.calls.filter(call => call[0] === 'GET')).toHaveLength(reads + 1)
    expect(status().dataset.state).toBe('read')
    expect(select.value).toBe('other.example.test')
    expect(f.writes()).toHaveLength(1)
  })
  it('creates and deletes a zone with exact expected-state bodies and persisted absence', async () => {
    const f = model(); f.boot(); await tick()
    const input = document.querySelector<HTMLInputElement>('[data-dns-new-name]')!
    input.value = 'new.example.test'; input.dispatchEvent(new Event('input')); button('add-zone').click(); await tick(); await tick()
    expect(f.writes()[0]![2]).toEqual({ records: [], expectedZoneRevision: null, accountId: null })
    expect(status().dataset.state).toBe('saved')
    button('delete').click(); await tick(); await tick()
    expect(f.writes()[1]![2]).toEqual({ expectedZoneRevision: '1'.padStart(64, '0') })
    expect(status().dataset.state).toBe('deleted')
    expect(Array.from(document.querySelector<HTMLSelectElement>('[data-dns-zone]')!.options).map(option => option.value)).not.toContain('new.example.test')
  })
  it('shows a real empty read and retains an unread state after malformed reads', async () => {
    const f = model(); f.setZones([]); f.boot(); await tick()
    expect(document.querySelector('[data-whm-dns-zone-count]')!.textContent).toBe('0')
    expect(button('add-record').disabled).toBe(true)
    f.setZones([zone({ name: '<img src=x onerror=alert(1)>' })]); button('refresh').click(); await tick()
    expect(status().dataset.state).toBe('failed'); expect(document.querySelector('img')).toBeNull()
  })
})
