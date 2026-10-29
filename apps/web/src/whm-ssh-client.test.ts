// @vitest-environment jsdom
import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmSshEffective, renderWhmSshFailures, renderWhmSshKeys } from './board-port/whm-security-components.ts'
import { WHM_SSH_CLIENT_BINDING } from './whm-ssh-client.ts'

// Synthetic session/host transport only. No browser-native authentication or SSH operation occurs.
const generatedKey = () => {
  const { publicKey } = generateKeyPairSync('ed25519'), x = publicKey.export({ format: 'jwk' }).x!
  const field = (value: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32BE(value.length); return Buffer.concat([size, value]) }
  return 'ssh-ed25519 ' + Buffer.concat([field(Buffer.from('ssh-ed25519')), field(Buffer.from(x, 'base64url'))]).toString('base64') + ' <img src=x>'
}
const fingerprint = (key: string) => 'SHA256:' + createHash('sha256').update(Buffer.from(key.split(' ')[1]!, 'base64')).digest('base64').replace(/=+$/, '')
const initial = () => ({ state: 'read', revision: 'a'.repeat(64), items: [{ fingerprint: 'SHA256:' + 'A'.repeat(43), keyType: 'ssh-ed25519', comment: 'existing', managed: false, protected: true, addedAt: null as string | null, lastUsedAt: null as null }], opaqueEntries: 0 })
const status = () => document.querySelector<HTMLElement>('[data-whm-ssh-status]')!
const draft = () => document.querySelector<HTMLTextAreaElement>('[data-whm-ssh-public-key]')!
const add = () => document.querySelector<HTMLButtonElement>('[data-whm-ssh-add]')!
const fill = (key: string) => { draft().value = key; draft().dispatchEvent(new Event('input')) }
let listeners: EventListener[], subtleDescriptor: PropertyDescriptor | undefined
beforeEach(() => {
  listeners = []; const listen = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, callback, options) => { if (name === 'beforeunload') listeners.push(callback as EventListener); listen(name, callback, options) })
  subtleDescriptor = Object.getOwnPropertyDescriptor(window.crypto, 'subtle'); Object.defineProperty(window.crypto, 'subtle', { value: webcrypto.subtle, configurable: true })
  document.body.innerHTML = '<section data-whm-detail-route="/whm/security/ssh">' + renderWhmSshKeys({ locale: 'en', canManage: true }) + renderWhmSshEffective({ locale: 'en' }) + renderWhmSshFailures({ locale: 'en' }) + '</section>'
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})
afterEach(() => { for (const listener of listeners) window.removeEventListener('beforeunload', listener); if (subtleDescriptor) Object.defineProperty(window.crypto, 'subtle', subtleDescriptor); else delete (window.crypto as unknown as Record<string, unknown>).subtle; vi.restoreAllMocks(); document.body.replaceChildren(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })
const model = () => {
  let keys = initial(), mode = 'normal'
  const actions = { add: true, remove: true }, ask = vi.fn(async () => true)
  const events: Array<{ at: string; address: string; username: string; method: string }> = []
  const send = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (method === 'GET') return { ssh: { observedAt: '2026-10-26T15:00:00Z', keys: structuredClone(keys), policy: { state: 'read', values: { port: '22', pubkeyauthentication: 'yes', passwordauthentication: 'yes', permitrootlogin: 'prohibit-password' } }, service: { state: 'read', unit: 'ssh.service', active: 'active', substate: 'running', enabled: 'enabled' }, failedLogins: { state: 'read', items: structuredClone(events), window: path.includes('window=7d') ? '7d' : '24h', limit: 500, truncated: false } }, keyActions: { ...actions } }
    if (mode === 'unknown') throw { status: 503, details: { unknownOutcome: true, verificationRequired: true } }
    if (mode === 'denied') throw { status: 422, details: { stateChanged: false } }
    const input = body as { publicKey?: string; fingerprint?: string }
    if (method === 'POST') { const key = input.publicKey!; keys = { ...keys, revision: 'b'.repeat(64), items: [...keys.items, { fingerprint: mode === 'wrong-target' ? 'SHA256:' + 'B'.repeat(43) : fingerprint(key), keyType: 'ssh-ed25519', comment: key.split(' ').slice(2).join(' '), managed: true, protected: false, addedAt: '2026-10-26T15:01:00Z', lastUsedAt: null }] } }
    else keys = { ...keys, revision: 'c'.repeat(64), items: keys.items.filter(key => key.fingerprint !== input.fingerprint) }
    return { applied: true, keys: structuredClone(keys) }
  })
  const boot = () => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + WHM_SSH_CLIENT_BINDING)()(ask) }
  return { send, ask, boot, actions, events, current: () => keys, mode: (value: string) => { mode = value }, writes: () => send.mock.calls.filter(call => call[0] !== 'GET') }
}
const ready = async () => vi.waitFor(() => expect(status().dataset.state).toBe('read'))

describe('root SSH observation and key controller', () => {
  it('refuses reads and writes under the canonical unavailable capability wrapper', () => {
    document.querySelector<HTMLElement>('[data-whm-detail-route]')!.dataset.capabilityState = 'unavailable'
    const f = model(); f.boot()
    expect(f.send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable')
    expect(add().disabled).toBe(true); expect(draft().disabled).toBe(true)
  })
  it('contains no direct fetch or HTML assignment and refuses missing transport', () => {
    expect(() => new Function('return ' + WHM_SSH_CLIENT_BINDING)()).not.toThrow()
    expect(WHM_SSH_CLIENT_BINDING).not.toContain('fetch('); expect(WHM_SSH_CLIENT_BINDING).not.toContain('innerHTML')
    new Function('return ' + WHM_SSH_CLIENT_BINDING)()(undefined)
    expect(status().dataset.state).toBe('unavailable'); expect(add().disabled).toBe(true)
  })
  it.each(['en', 'ar'] as const)('renders human SSH metadata dates in %s without changing structured events or raw source', async locale => {
    document.body.innerHTML = '<section data-whm-detail-route="/whm/security/ssh">' + renderWhmSshKeys({ locale, canManage: false }) + renderWhmSshEffective({ locale }) + renderWhmSshFailures({ locale }) + '</section>'
    const observedAt = '2026-10-27T10:11:12.123456Z', eventAt = '2026-10-27T09:08:07.654321Z', addedAt = '2026-10-27T08:07:06.543210Z', keys = initial()
    keys.items[0]!.addedAt = addedAt
    const rawMessage = 'Oct 27 09:08:07 sshd: synthetic source event at ' + eventAt
    const payload = { ssh: { observedAt, keys, policy: { state: 'read', values: { port: '22', passwordauthentication: 'yes' } }, service: { state: 'read', unit: 'ssh.service', active: 'active', substate: 'running', enabled: 'enabled' }, failedLogins: { state: 'read', items: [{ at: eventAt, address: '2001:db8::42', username: 'alice', method: 'password', message: rawMessage }], window: '24h', limit: 500, truncated: false } }, keyActions: { add: false, remove: false } }, rawBefore = JSON.stringify(payload)
    const send = vi.fn(async (_method: string, _path: string) => payload)
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    new Function('return ' + WHM_SSH_CLIENT_BINDING)()(undefined); await ready()
    const policy = document.querySelector('[data-whm-ssh-effective]')!, term = [...policy.querySelectorAll('dt')].find(node => node.textContent === (locale === 'ar' ? 'بدء القراءة (UTC)' : 'Read started (UTC)'))
    expect(term?.nextElementSibling?.querySelector('bdi[dir="ltr"]')?.textContent).toBe('2026-10-27 10:11 UTC')
    expect(document.querySelector('[data-whm-ssh-failure-rows] tr:first-child td:first-child bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 09:08 UTC')
    expect(document.querySelector('[data-whm-ssh-failure-rows] tr:first-child td:nth-child(2) bdi[dir="ltr"]')!.textContent).toBe('2001:db8::42')
    expect(document.querySelector('[data-whm-ssh-key-rows] tr:first-child td:nth-child(4) bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 08:07 UTC')
    expect(document.querySelector('[data-whm-ssh-key-rows] tr:first-child td:first-child bdi[dir="ltr"]')!.textContent).toBe(keys.items[0]!.fingerprint)
    expect(payload.ssh.failedLogins.items[0]).toMatchObject({ at: eventAt, message: rawMessage })
    expect(JSON.stringify(payload)).toBe(rawBefore)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('GET', '/api/security/ssh')
    expect(add().disabled).toBe(true)
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('keeps existing keys protected and mutation controls unavailable when the server gate is closed', async () => {
    const f = model(); f.actions.add = false; f.actions.remove = false; f.boot(); await ready()
    expect(document.querySelector<HTMLButtonElement>('[data-whm-ssh-remove]')!.disabled).toBe(true)
    fill(generatedKey()); add().disabled = false; add().click()
    await new Promise(resolve => setTimeout(resolve, 0)); expect(f.writes()).toHaveLength(0); expect(draft().readOnly).toBe(true)
  })
  it('adds exactly the intended key and verifies the file-state readback without exposing its blob as page text', async () => {
    const f = model(), key = generatedKey(); f.boot(); await ready(); fill(key); add().click()
    await vi.waitFor(() => expect(status().dataset.state).toBe('saved'))
    expect(f.writes()).toHaveLength(1); expect(f.writes()[0]?.[2]).toEqual({ publicKey: key, expectedRevision: 'a'.repeat(64) })
    expect(document.body.textContent).not.toContain(key.split(' ')[1]!)
    expect(document.querySelector('img')).toBeNull(); expect(draft().value).toBe('')
    const remove = [...document.querySelectorAll<HTMLButtonElement>('[data-whm-ssh-remove]')].find(button => button.dataset.whmSshRemove === fingerprint(key))!
    remove.click(); await vi.waitFor(() => expect(f.current().items).toHaveLength(1))
    await vi.waitFor(() => expect(document.querySelectorAll('[data-whm-ssh-remove]')).toHaveLength(1))
    expect(f.writes()[1]?.[2]).toEqual({ fingerprint: fingerprint(key), expectedRevision: 'b'.repeat(64) })
  })
  it('cancels key addition without reading again or sending a mutation and retains the public-key draft', async () => {
    const f = model(), key = generatedKey(); f.ask.mockResolvedValue(false); f.boot(); await ready(); fill(key); add().click()
    await vi.waitFor(() => expect(f.ask).toHaveBeenCalledTimes(1))
    expect(f.send.mock.calls).toHaveLength(1); expect(f.writes()).toHaveLength(0); expect(draft().value).toBe(key)
  })
  it('retains stale drafts without a mutation and supports a confirmed fresh read', async () => {
    const f = model(), key = generatedKey(); f.boot(); await ready(); fill(key); f.current().revision = 'd'.repeat(64); add().click()
    await vi.waitFor(() => expect(status().dataset.state).toBe('stale'))
    expect(f.writes()).toHaveLength(0); expect(draft().value).toBe(key); expect(add().disabled).toBe(true)
    document.querySelector<HTMLButtonElement>('[data-whm-ssh-refresh]')!.click(); await ready()
    expect(draft().value).toBe(key); expect(f.writes()).toHaveLength(0)
  })
  it.each(['unknown', 'wrong-target'])('locks an %s outcome without automatically retrying', async mode => {
    const f = model(), key = generatedKey(); f.boot(); await ready(); fill(key); f.mode(mode); add().click()
    await vi.waitFor(() => expect(status().dataset.state).toBe('uncertain'))
    expect(f.writes()).toHaveLength(1); expect(add().disabled).toBe(true); expect(draft().value).toBe(key)
    add().disabled = false; add().click(); await new Promise(resolve => setTimeout(resolve, 0)); expect(f.writes()).toHaveLength(1)
  })
  it('retains a definitely refused key draft and keeps another explicit attempt available', async () => {
    const f = model(), key = generatedKey(); f.boot(); await ready(); fill(key); f.mode('denied'); add().click()
    await vi.waitFor(() => expect(status().dataset.state).toBe('failed'))
    expect(draft().value).toBe(key); expect(add().disabled).toBe(false)
  })
  it('uses the real bounded 7-day read route for the preserved range selector', async () => {
    const f = model(); f.boot(); await ready()
    const range = document.querySelector<HTMLSelectElement>('[data-whm-ssh-window]')!; range.value = '7d'; range.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith('GET', '/api/security/ssh?window=7d'))
    await vi.waitFor(() => expect(range.value).toBe('7d'))
    expect(document.querySelector('[data-whm-ssh-failures-note]')!.textContent).toContain('7-day')
  })
  it('retains the approved Count column as one per observed event without inventing aggregates', async () => {
    const f = model(); f.events.push({ at: '2026-10-26T15:00:00Z', address: '192.0.2.4', username: '<img src=x>', method: 'password' }, { at: '2026-10-26T15:00:01Z', address: '192.0.2.4', username: 'alice', method: 'none' })
    f.boot(); await ready()
    const rows = [...document.querySelectorAll<HTMLTableRowElement>('[data-whm-ssh-failure-rows] tr')]
    expect(rows).toHaveLength(2)
    for (const row of rows) { expect(row.cells).toHaveLength(6); expect(row.cells[4]!.textContent).toBe('1'); expect(row.cells[5]!.textContent).toContain('ban state not read') }
    expect(document.querySelector('img')).toBeNull()
  })
  it('keeps a mixed unknown-entry count visible without displaying unparsed file contents', async () => {
    const f = model(); f.current().opaqueEntries = 1; f.boot(); await ready()
    const note = document.querySelector<HTMLElement>('[data-whm-ssh-opaque]')!
    expect(note.hidden).toBe(false); expect(note.textContent).toContain('1'); expect(note.textContent).toContain('preserved and protected')
  })
})
