// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmDefaultSiteWorkspace } from './board-port/whm-default-site-workspace.ts'
import { defaultSitePolicy, readDefaultSite, WHM_DEFAULT_SITE_CLIENT_BINDING } from './whm-default-site-client.ts'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const initial = () => ({ configuration: { state: 'read', source: 'saved-server-settings', policy: { response: 'reject', redirectTo: null, refuseHttps: false }, explicitPolicy: false, revision: 'a'.repeat(64) }, actions: { save: true }, application: { status: 'unverified', targetVerified: false } })
const logs = () => ({ observation: { state: 'read', observedAt: '2026-10-26T21:30:00Z', source: 'nginx-default-access-log', limit: 100, truncated: false, malformedRecords: 0, items: [{ at: '2026-10-26T21:29:00Z', host: '<img src=x onerror=alert(1)>', address: '192.0.2.1', status: 404 }] } })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const control = <T extends HTMLElement = HTMLElement>(name: string): T => document.querySelector<T>('[data-default-site-' + name + ']')!
let listeners: EventListener[]
beforeEach(() => {
  listeners = []
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, callback, options) => { if (name === 'beforeunload') listeners.push(callback as EventListener); add(name, callback, options) })
  document.body.innerHTML = renderWhmDefaultSiteWorkspace({ locale: 'en', canManage: true })
})
afterEach(() => { for (const listener of listeners) window.removeEventListener('beforeunload', listener); vi.restoreAllMocks(); document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
const model = () => {
  let source = initial(), mode = 'normal', observation: unknown = logs()
  const transport = vi.fn(async (method: string, path: string, body?: unknown): Promise<unknown> => {
    if (method === 'GET' && path.endsWith('/requests')) return clone(observation)
    if (method === 'GET') { if (mode === 'read-error') throw new Error('Synthetic read failure'); return clone(source) }
    if (mode === 'conflict') throw { status: 409, details: { stateChanged: false } }
    if (mode === 'unknown') throw new Error('Synthetic transport interruption')
    const request = body as { policy: ReturnType<typeof defaultSitePolicy>; expectedRevision: string }
    expect(request.expectedRevision).toBe(source.configuration.revision)
    const policy = request.policy!
    source = { ...source, configuration: { ...source.configuration, policy: policy as typeof source.configuration.policy, explicitPolicy: true, revision: 'b'.repeat(64) } }
    const ack = { configuration: clone(source.configuration), application: { status: 'not_requested', targetVerified: false }, stateChanged: true }
    if (mode === 'unverified-ack') ack.application.status = 'unverified'
    if (mode === 'mismatch') source.configuration = { ...source.configuration, policy: initial().configuration.policy, revision: 'c'.repeat(64) }
    return ack
  })
  const ask = vi.fn(async () => true)
  const boot = () => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport; new Function('return ' + WHM_DEFAULT_SITE_CLIENT_BINDING)()(ask) }
  return { transport, ask, boot, setMode: (value: string) => { mode = value }, unqualified: () => { source.actions.save = false }, setObservation: (value: unknown) => { observation = value }, writes: () => transport.mock.calls.filter(call => call[0] === 'PUT') }
}
const edit = () => {
  const response = control<HTMLSelectElement>('response'); response.value = 'redirect'; response.dispatchEvent(new Event('change', { bubbles: true }))
  const redirect = control<HTMLInputElement>('redirect'); redirect.value = 'https://landing.example.test/'; redirect.dispatchEvent(new Event('input', { bubbles: true }))
}
const submit = () => control('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

describe('default-site safe client projection and real request binding', () => {
  it('requires verified saved source, revision and explicit save qualification', () => {
    expect(readDefaultSite(initial())?.qualified).toBe(true)
    expect(readDefaultSite({ ...initial(), actions: {} })).toBeNull()
    expect(defaultSitePolicy({ response: 'redirect', redirectTo: 'https://user:password@example.test/', refuseHttps: false })).toBeNull()
    expect(defaultSitePolicy({ response: 'redirect', redirectTo: 'https://example.test/$host', refuseHttps: false })).toBeNull()
    expect(defaultSitePolicy({ response: 'redirect', redirectTo: 'https://example.test/' + 'é'.repeat(400), refuseHttps: false })).toBeNull()
    expect(WHM_DEFAULT_SITE_CLIENT_BINDING).not.toMatch(/fetch\(|innerHTML/)
    expect(() => new Function('return ' + WHM_DEFAULT_SITE_CLIENT_BINDING)()).not.toThrow()
  })
  it('keeps neutral unavailable controls visible and makes no session request', async () => {
    document.body.innerHTML = '<section data-capability-state="unavailable">' + renderWhmDefaultSiteWorkspace({ locale: 'en', canManage: false }) + '</section>'
    const f = model(); f.boot(); await tick(); submit(); control<HTMLButtonElement>('refresh').click()
    expect(document.querySelector('form')).toBeNull(); expect(f.transport).not.toHaveBeenCalled()
    for (const input of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) expect(input.disabled).toBe(true)
  })
  it('reads actual qualification and renders observed host values as literal isolated text', async () => {
    const f = model(); f.unqualified(); f.boot(); await tick()
    expect(control('status').textContent).toContain('has not qualified')
    expect(control<HTMLSelectElement>('response').disabled).toBe(true)
    expect(control<HTMLButtonElement>('refresh').disabled).toBe(false)
    expect(document.querySelector('img')).toBeNull(); expect(control('requests').textContent).toContain('<img src=x onerror=alert(1)>')
    expect(control('requests').querySelector('bdi[dir=ltr]')).not.toBeNull()
  })
  it('saves only after confirmation and verifies the exact persisted readback', async () => {
    const f = model(); f.boot(); await tick(); edit(); submit(); await tick(); await tick()
    expect(f.ask).toHaveBeenCalledTimes(1); expect(f.writes()).toHaveLength(1)
    expect(f.writes()[0]![2]).toEqual({ policy: { response: 'redirect', redirectTo: 'https://landing.example.test/', refuseHttps: false }, expectedRevision: 'a'.repeat(64) })
    expect(control('status').dataset.state).toBe('saved'); expect(control('status').textContent).toContain('Native application was not requested')
    expect(control<HTMLButtonElement>('save').disabled).toBe(true)
  })
  it('cancels a confirmation while preserving the typed policy draft', async () => {
    const f = model(); f.ask.mockResolvedValue(false); f.boot(); await tick(); edit(); submit(); await tick()
    expect(f.writes()).toHaveLength(0); expect(control<HTMLInputElement>('redirect').value).toBe('https://landing.example.test/')
  })
  it.each(['mismatch', 'unverified-ack'])('locks %s as uncertain without acknowledging a saved policy', async mode => {
    const f = model(); f.boot(); await tick(); edit(); f.setMode(mode); submit(); await tick(); await tick()
    expect(control('status').dataset.state).toBe('uncertain'); expect(control<HTMLInputElement>('redirect').value).toBe('https://landing.example.test/')
    submit(); await tick(); expect(f.writes()).toHaveLength(1)
  })
  it('retains stale drafts and requires explicit reload before any further write', async () => {
    const f = model(); f.boot(); await tick(); edit(); f.setMode('conflict'); submit(); await tick(); await tick()
    expect(control('status').dataset.state).toBe('stale'); expect(control<HTMLInputElement>('redirect').value).toBe('https://landing.example.test/')
    submit(); await tick(); expect(f.writes()).toHaveLength(1)
  })
  it('retains unknown outcomes and unlocks only after an explicit saved-source reload', async () => {
    const f = model(); f.boot(); await tick(); edit(); f.setMode('unknown'); submit(); await tick(); await tick()
    expect(control('status').dataset.state).toBe('uncertain'); expect(control<HTMLButtonElement>('save').disabled).toBe(true)
    f.setMode('normal'); control<HTMLButtonElement>('discard').click(); await tick()
    expect(control('status').dataset.state).toBe('read'); expect(control<HTMLInputElement>('redirect').value).toBe('')
  })
  it('preserves drafts when a discard read fails and distinguishes unavailable logs from empty history', async () => {
    const f = model(); f.setObservation({ observation: { ...logs().observation, state: 'unavailable', items: [], reason: 'default_log_unavailable' } }); f.boot(); await tick()
    expect(control('observation-status').dataset.state).toBe('unavailable'); expect(control('observation-status').textContent).toContain('not an empty request history')
    edit(); f.setMode('read-error'); control<HTMLButtonElement>('discard').click(); await tick()
    expect(control('status').dataset.state).toBe('failed'); expect(control<HTMLInputElement>('redirect').value).toBe('https://landing.example.test/')
  })
  it.each(['en', 'ar'] as const)('preserves the approved card controls and ASCII digits in readonly %s', locale => {
    document.body.innerHTML = renderWhmDefaultSiteWorkspace({ locale, canManage: false })
    expect(document.querySelector('form')).toBeNull(); expect(document.querySelectorAll('th')).toHaveLength(4)
    for (const input of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')) expect(document.querySelector('label[for="' + input.id + '"]')).not.toBeNull()
    expect(document.body.innerHTML).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    expect(control<HTMLButtonElement>('save').disabled).toBe(true)
  })
})


describe('full timestamp display additional default HTTP observations', () => {
  it.each(['en', 'ar'] as const)('formats structured request instants without rewriting host address or status in %s', async locale => {
    document.body.innerHTML = renderWhmDefaultSiteWorkspace({ locale, canManage: true })
    const raw = logs()
    raw.observation.items[0]!.at = '2026-10-27T11:00:13.1200+02:00'
    const before = JSON.stringify(raw)
    const send = vi.fn(async (_method: string, path: string) => path.endsWith('/requests') ? raw : initial())
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    new Function('return ' + WHM_DEFAULT_SITE_CLIENT_BINDING)()(undefined); await tick(); await tick()
    const cells = control('requests').querySelectorAll('tr td')
    expect(cells[0]!.textContent).toBe('2026-10-27 09:00 UTC')
    expect(cells[0]!.querySelector('bdi')!.getAttribute('dir')).toBe('ltr')
    expect(Array.from(cells).slice(1).map(cell => cell.textContent)).toEqual(['<img src=x onerror=alert(1)>', '192.0.2.1', '404'])
    expect(control('requests').querySelector('img')).toBeNull()
    expect(raw.observation.items[0]!.at).toBe('2026-10-27T11:00:13.1200+02:00')
    expect(send).toHaveBeenCalledWith('GET', '/api/server/default-site/requests')
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
    expect(JSON.stringify(raw)).toBe(before)
  })
})
