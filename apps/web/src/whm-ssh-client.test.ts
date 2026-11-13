// @vitest-environment jsdom
import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmSshEffective, renderWhmSshFailures, renderWhmSshKeys } from './board-port/whm-security-components.ts'
import { WHM_SSH_CLIENT_BINDING } from './whm-ssh-client.ts'
import { renderV2WhmSsh } from './themes/v2/pages/xwhm/security/ssh.ts'

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
const runWhmSshBinding = new Function('return ' + WHM_SSH_CLIENT_BINDING)() as (ask?: (options: Record<string, unknown>) => Promise<boolean>) => void
let defaultSshTemplate: HTMLTemplateElement | undefined
let listeners: EventListener[], subtleDescriptor: PropertyDescriptor | undefined
beforeEach(() => {
  listeners = []; const listen = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, callback, options) => { if (name === 'beforeunload') listeners.push(callback as EventListener); listen(name, callback, options) })
  subtleDescriptor = Object.getOwnPropertyDescriptor(window.crypto, 'subtle'); Object.defineProperty(window.crypto, 'subtle', { value: webcrypto.subtle, configurable: true })
  if (!defaultSshTemplate) {
    defaultSshTemplate = document.createElement('template')
    defaultSshTemplate.innerHTML = '<section data-whm-detail-route="/whm/security/ssh">' + renderWhmSshKeys({ locale: 'en', canManage: true }) + renderWhmSshEffective({ locale: 'en' }) + renderWhmSshFailures({ locale: 'en' }) + '</section>'
  }
  document.body.replaceChildren(defaultSshTemplate.content.cloneNode(true))
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
  const boot = () => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; runWhmSshBinding(ask) }
  return { send, ask, boot, actions, events, current: () => keys, mode: (value: string) => { mode = value }, writes: () => send.mock.calls.filter(call => call[0] !== 'GET') }
}
const ready = async () => vi.waitFor(() => expect(status().dataset.state).toBe('read'), { interval: 5 })

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

type SshTheme = 'classic' | 'v2'
const sshDomCache = new Map<string, HTMLTemplateElement>()
const mountSsh = (theme: SshTheme, locale: 'en' | 'ar' = 'en', canManage = true): HTMLElement => {
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  const key = `${theme}:${locale}:${canManage}`
  let tpl = sshDomCache.get(key)
  if (!tpl) {
    tpl = document.createElement('template')
    tpl.innerHTML = theme === 'classic'
      ? '<section data-whm-detail-route="/whm/security/ssh">' + renderWhmSshKeys({ locale, canManage }) + renderWhmSshEffective({ locale }) + renderWhmSshFailures({ locale }) + '</section>'
      : renderV2WhmSsh({ locale, observationAuthority: { canRead: true, canManage } })
    sshDomCache.set(key, tpl)
  }
  document.body.replaceChildren(tpl.content.cloneNode(true))
  return document.querySelector<HTMLElement>('[data-whm-detail-route="/whm/security/ssh"]')!
}
const sshTemplate = (root: HTMLElement, name: string) => root.querySelector<HTMLTemplateElement>('template[data-xp-template="' + name + '"]')!
const sshTemplateNames = ['whm-ssh-remove', 'whm-ssh-fact-technical', 'whm-ssh-fact-text'] as const
const sshCorruptions: readonly (readonly [string, (template: HTMLTemplateElement, root: HTMLElement) => void])[] = [
  ['missing', template => template.remove()],
  ['duplicate', (template, root) => root.append(template.cloneNode(true))],
  ['wrong root', template => template.content.replaceChildren(document.createElement('section'))],
  ['missing label', template => template.content.querySelector('[data-xp-slot="label"]')!.remove()],
  ['wrong label tag', template => { const label = document.createElement('code'); label.dataset.xpSlot = 'label'; template.content.querySelector('[data-xp-slot="label"]')!.replaceWith(label) }],
  ['duplicate label', template => { const label = template.content.querySelector('[data-xp-slot="label"]')!; label.parentElement!.append(label.cloneNode(true)) }],
  ['unexpected slot', template => { const extra = document.createElement('span'); extra.dataset.xpSlot = 'unexpected'; template.content.firstElementChild!.append(extra) }],
  ['event handler', template => template.content.firstElementChild!.setAttribute('onclick', 'window.unexpected=true')],
  ['native action metadata', template => template.content.firstElementChild!.setAttribute('data-api-url', '/api/security/ssh/keys')],
  ['interactive child', template => template.content.firstElementChild!.append(document.createElement('input'))],
  ['borrowed nested owner', (template, root) => { const nested = document.createElement('section'); nested.dataset.whmDetailRoute = '/whm/security/ssh'; nested.append(template); root.append(nested) }],
]

describe('selected-theme SSH factories', () => {
  beforeAll(() => { mountSsh('classic', 'en', true); mountSsh('v2', 'en', true); document.body.replaceChildren() })
  it.each(['classic', 'v2'] as const)('uses actual %s markup for facts and managed removal while retaining native payloads', async theme => {
    for (const locale of ['en', 'ar'] as const) {
      const root = mountSsh(theme, locale), f = model(), key = generatedKey(); f.boot(); await ready()
      const policy = root.querySelector('[data-whm-ssh-effective]')!
      expect(policy.querySelectorAll('bdi').length).toBeGreaterThan(0)
      for (const value of policy.querySelectorAll('bdi')) { expect(value.dir).toBe('ltr'); expect(value.classList.contains(theme === 'classic' ? 'xp-mono' : 'v2-mono')).toBe(true) }
      expect([...policy.children].every(node => theme === 'classic' ? node.classList.contains('xp-security-observation__fact') : !node.className.includes('xp-'))).toBe(true)
      expect(root.querySelector<HTMLButtonElement>('[data-whm-ssh-remove]')!.disabled).toBe(true)
      fill(key); add().click(); await vi.waitFor(() => expect(status().dataset.state).toBe('saved'))
      expect(f.writes()[0]).toEqual(['POST', '/api/security/ssh/keys', { publicKey: key, expectedRevision: 'a'.repeat(64) }])
      const remove = [...root.querySelectorAll<HTMLButtonElement>('[data-whm-ssh-remove]')].find(button => button.dataset.whmSshRemove === fingerprint(key))!
      expect(remove.classList.contains(theme === 'classic' ? 'xp-btn' : 'v2-btn')).toBe(true)
      if (theme === 'v2') expect(remove.className).not.toContain('xp-')
      expect(remove.type).toBe('button'); expect(remove.disabled).toBe(false); expect(remove.querySelector('[data-xp-slot="label"]')?.tagName).toBe('SPAN')
      remove.click(); await vi.waitFor(() => expect(f.writes()).toHaveLength(2)); await vi.waitFor(() => expect(root.querySelectorAll('[data-whm-ssh-remove]')).toHaveLength(1))
      expect(f.writes()[1]).toEqual(['DELETE', '/api/security/ssh/keys', { fingerprint: fingerprint(key), expectedRevision: 'b'.repeat(64) }])
      expect(f.ask).toHaveBeenCalledTimes(2); expect(draft().value).toBe('')
      expect(root.textContent).not.toContain(key.split(' ')[1]!); expect(root.querySelector('img')).toBeNull()
    }
    expect(WHM_SSH_CLIENT_BINDING).not.toContain('xp-btn')
    expect(WHM_SSH_CLIENT_BINDING).not.toContain('xp-security-observation__fact')
    expect(WHM_SSH_CLIENT_BINDING).not.toContain('innerHTML'); expect(WHM_SSH_CLIENT_BINDING).not.toContain('fetch(')
  })

  it.each(['classic', 'v2'] as const)('keeps unobserved %s policy as ordinary text and read-only authority unchanged', async theme => {
    for (const locale of ['en', 'ar'] as const) {
      const root = mountSsh(theme, locale, false)
      const send = vi.fn(async () => ({ ssh: { keys: initial(), policy: { state: 'unavailable', values: {} }, service: { state: 'unavailable' }, failedLogins: { state: 'unavailable', items: [], window: '24h', limit: 500, truncated: false } }, keyActions: { add: true, remove: true } }))
      const ask = vi.fn(async () => true); (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
      new Function('return ' + WHM_SSH_CLIENT_BINDING)()(ask); await ready()
      const policy = root.querySelector('[data-whm-ssh-effective]')!, value = policy.querySelector('[data-xp-slot="value"]')!
      expect(value.tagName).toBe('SPAN'); expect(value.hasAttribute('dir')).toBe(false); expect(policy.querySelectorAll('bdi')).toHaveLength(0)
      expect(add().disabled).toBe(true); fill(generatedKey()); add().disabled = false; add().click()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(send.mock.calls).toEqual([['GET', '/api/security/ssh']]); expect(ask).not.toHaveBeenCalled(); expect(draft().readOnly).toBe(true)
    }
  })

  it.each(['classic', 'v2'] as const)('sends zero transport calls for malformed complete %s factory contracts', theme => {
    for (const name of sshTemplateNames) for (const [reason, corrupt] of sshCorruptions) {
      const root = mountSsh(theme); corrupt(sshTemplate(root, name), root)
      const f = model(); f.boot()
      expect(f.send, name + ': ' + reason).not.toHaveBeenCalled(); expect(f.ask).not.toHaveBeenCalled()
      expect(status().dataset.state).toBe('unavailable'); expect(add().disabled).toBe(true); expect(draft().disabled).toBe(true)
    }
    for (const name of ['whm-ssh-fact-technical', 'whm-ssh-fact-text'] as const) {
      const root = mountSsh(theme), value = sshTemplate(root, name).content.querySelector<HTMLElement>('[data-xp-slot="value"]')!
      value.dir = name === 'whm-ssh-fact-technical' ? 'rtl' : 'ltr'
      const f = model(); f.boot(); expect(f.send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable')
    }
    const root = mountSsh(theme); (sshTemplate(root, 'whm-ssh-remove').content.firstElementChild as HTMLButtonElement).disabled = false
    const f = model(); f.boot(); expect(f.send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable')
  })

  it.each(['classic', 'v2'] as const)('rejects %s controls or route identity changed during the initial read without painting its reply', async theme => {
    for (const change of ['rows', 'route'] as const) {
      const root = mountSsh(theme), f = model(), original = f.send.getMockImplementation()!
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      f.send.mockImplementation(async (method, path, body) => { await gate; return original(method, path, body) })
      f.boot(); expect(f.send).toHaveBeenCalledTimes(1)
      const replacement = document.createElement('tbody'); replacement.dataset.whmSshKeyRows = ''
      if (change === 'rows') root.querySelector('[data-whm-ssh-key-rows]')!.replaceWith(replacement)
      else root.dataset.whmDetailRoute = '/whm/security'
      release(); await vi.waitFor(() => expect(status().dataset.state).toBe('unavailable'))
      expect(replacement.children).toHaveLength(0); expect(root.querySelectorAll('[data-whm-ssh-remove]')).toHaveLength(0)
      expect(f.writes()).toHaveLength(0); expect(f.ask).not.toHaveBeenCalled(); expect(add().disabled).toBe(true)
    }
  })

  it.each(['classic', 'v2'] as const)('rejects a late %s template change during confirmation without sending or discarding the key', async theme => {
    const root = mountSsh(theme), f = model(), key = generatedKey()
    let accept!: (accepted: boolean) => void
    f.ask.mockImplementation(() => new Promise<boolean>(resolve => { accept = resolve }))
    f.boot(); await ready(); fill(key); add().click(); await vi.waitFor(() => expect(f.ask).toHaveBeenCalledTimes(1))
    sshTemplate(root, 'whm-ssh-remove').remove(); accept(true)
    await vi.waitFor(() => expect(status().dataset.state).toBe('unavailable'))
    expect(f.send.mock.calls).toHaveLength(1); expect(f.writes()).toHaveLength(0); expect(draft().value).toBe(key); expect(add().disabled).toBe(true)
  })

  it.each(['classic', 'v2'] as const)('rejects a late %s template change in the pre-write read and retains the draft', async theme => {
    const root = mountSsh(theme), f = model(), key = generatedKey(), original = f.send.getMockImplementation()!
    let release!: () => void, reads = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    f.send.mockImplementation(async (method, path, body) => { if (method === 'GET' && ++reads === 2) await gate; return original(method, path, body) })
    f.boot(); await ready(); fill(key); add().click(); await vi.waitFor(() => expect(reads).toBe(2))
    sshTemplate(root, 'whm-ssh-fact-text').remove(); release()
    await vi.waitFor(() => expect(status().dataset.state).toBe('unavailable'))
    expect(f.writes()).toHaveLength(0); expect(f.send.mock.calls).toHaveLength(2); expect(draft().value).toBe(key)
  })

  it.each(['classic', 'v2'] as const)('keeps the %s result uncertain when factories change after a key write or during readback', async theme => {
    for (const phase of ['write', 'readback'] as const) {
      const root = mountSsh(theme), f = model(), key = generatedKey(), original = f.send.getMockImplementation()!
      let release!: () => void, reads = 0, pending = false
      const gate = new Promise<void>(resolve => { release = resolve })
      f.send.mockImplementation(async (method, path, body) => {
        if (method === 'GET') reads++
        const value = await original(method, path, body)
        if (phase === 'write' && method === 'POST' || phase === 'readback' && method === 'GET' && reads === 3) { pending = true; await gate }
        return value
      })
      f.boot(); await ready(); fill(key); add().click(); await vi.waitFor(() => expect(pending).toBe(true))
      sshTemplate(root, 'whm-ssh-fact-technical').remove(); release()
      await vi.waitFor(() => expect(status().dataset.state).toBe('uncertain'))
      expect(f.writes()).toHaveLength(1); expect(draft().value).toBe(key); expect(add().disabled).toBe(true)
      add().disabled = false; add().click(); await new Promise(resolve => setTimeout(resolve, 0)); expect(f.writes()).toHaveLength(1)
      expect(root.textContent).not.toContain(key.split(' ')[1]!)
    }
  })

  it.each(['classic', 'v2'] as const)('rechecks %s managed-removal factories at the action boundary', async theme => {
    const root = mountSsh(theme), f = model(), key = generatedKey(); f.boot(); await ready(); fill(key); add().click()
    await vi.waitFor(() => expect(status().dataset.state).toBe('saved'))
    const remove = [...root.querySelectorAll<HTMLButtonElement>('[data-whm-ssh-remove]')].find(button => button.dataset.whmSshRemove === fingerprint(key))!
    sshTemplate(root, 'whm-ssh-remove').content.querySelector('[data-xp-slot="label"]')!.remove(); remove.click()
    expect(status().dataset.state).toBe('unavailable'); expect(f.writes()).toHaveLength(1); expect(f.ask).toHaveBeenCalledTimes(1); expect(f.current().items).toHaveLength(2)
  })
})
