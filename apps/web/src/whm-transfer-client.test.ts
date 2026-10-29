// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmTransferWorkspace } from './board-port/whm-transfer-workspace.ts'
import { WHM_TRANSFER_CLIENT_BINDING } from './whm-transfer-client.ts'

const id = (value: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(value).padStart(12, '0')
const entry = (state = 'created', inventory: unknown = null, review: { accounts: { source: string; target: string; plan: string; domains: string[]; mailboxes: number }[] } | null = null, digest: string | null = null) => ({ session: { id: id(1), actor: 'synthetic-root', createdAt: '2026-10-26T12:00:00.000Z', updatedAt: '2026-10-26T12:00:00.000Z', state,
  auth: { kind: 'ssh-key', host: 'source.example.test', port: 22, user: 'root', keyId: id(2), hostKeyFingerprint: 'SHA256:' + 'A'.repeat(43) }, source: inventory ? { hostname: 'source.example.test', version: '1.4.2' } : null,
  inventory, local: null, selection: { accounts: [] as string[], plans: [] as string[] }, conflicts: [], resolutions: {}, reviewDigest: null, progress: {} as Record<string, unknown>, log: [], error: null }, revision: '1'.repeat(64), review, digest })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const button = (name: string) => document.querySelector<HTMLButtonElement>('[data-transfer-' + name + ']')!
const status = () => document.querySelector<HTMLElement>('[data-transfer-status]')!
const field = (name: string) => document.querySelector<HTMLInputElement>('[data-transfer-field="' + name + '"]')!
let listeners: EventListener[]
beforeEach(() => {
  listeners = []
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, callback, options) => { if (name === 'beforeunload') listeners.push(callback as EventListener); add(name, callback, options) })
  document.body.innerHTML = renderWhmTransferWorkspace({ lang: 'en', canManage: true, credentials: [{ id: id(2), label: 'Stored source key', kind: 'ssh-key' }] })
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})
afterEach(() => { for (const listener of listeners) window.removeEventListener('beforeunload', listener); document.body.replaceChildren(); vi.restoreAllMocks(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })
const model = (initial = entry()) => {
  let current = clone(initial), mode = 'normal'
  const archiveReviews: Record<string, unknown>[] = []
  const send = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (method === 'GET') return { sessions: [clone(current)], archiveReviews: clone(archiveReviews), capabilities: { discover: false, execute: false, archiveReview: true, archiveMaxBytes: 524288 } }
    if (mode === 'unknown') throw { status: 503, details: { unknownOutcome: true } }
    if (mode === 'stale') throw { status: 409, details: { stateChanged: false } }
    const input = body as Record<string, unknown>
    if (path === '/api/transfers/cpanel-review') { const review = { id: id(4), filename: input.filename, archiveSha256: 'a'.repeat(64), archiveRetained: false, nativeApplied: false, plan: { account: { username: 'bob', primaryDomain: 'bob.example.test' }, domains: [], databases: [], mailboxes: [], warnings: [] }, conflicts: [] }; archiveReviews.push(review); return { archiveReview: clone(review) } }
    if (method === 'POST') current = { ...entry(), session: { ...entry().session, id: id(3), auth: input.auth as ReturnType<typeof entry>['session']['auth'] }, revision: '3'.repeat(64) }
    else current = { ...current, session: { ...current.session, state: input.action === 'cancel' ? 'cancelled' : current.session.state }, revision: '2'.repeat(64) }
    return clone(current)
  })
  const ask = vi.fn(async () => true)
  const boot = () => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + WHM_TRANSFER_CLIENT_BINDING)()(ask) }
  return { send, ask, boot, setMode: (value: string) => { mode = value }, setCurrent: (value: ReturnType<typeof entry>) => { current = clone(value) }, setArchiveReviews: (value: Record<string, unknown>[]) => { archiveReviews.splice(0, archiveReviews.length, ...clone(value)) }, writes: () => send.mock.calls.filter(call => call[0] !== 'GET') }
}

describe('persisted transfer review browser contract', () => {
  it('constructs a self-contained binding and exposes actual available actions', () => {
    expect(() => new Function('return ' + WHM_TRANSFER_CLIENT_BINDING)()).not.toThrow()
    expect(WHM_TRANSFER_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_TRANSFER_CLIENT_BINDING).not.toContain('fetch(')
    for (const name of ['refresh', 'create', 'discover', 'select', 'resolve', 'review', 'run', 'cancel', 'inspect']) expect(button(name)).not.toBeNull()
  })
  it('locks all controls without an admitted transport', async () => {
    new Function('return ' + WHM_TRANSFER_CLIENT_BINDING)()(undefined)
    expect(status().dataset.state).toBe('unavailable'); expect(button('create').disabled).toBe(true)
    document.querySelector<HTMLElement>('[data-transfer-workspace]')!.removeAttribute('data-transfer-bound')
    document.querySelector<HTMLElement>('[data-transfer-workspace]')!.dataset.transferManage = 'false'
    const f = model(); f.boot(); await tick(); expect(f.send).not.toHaveBeenCalled()
  })
  it('reads persisted state without exposing internal session or credential references as labels', async () => {
    const f = model(); f.boot(); await tick()
    expect(status().dataset.state).toBe('read')
    expect(document.querySelector('[data-transfer-session]')!.textContent).toContain('Unnumbered session')
    expect(document.querySelector('[data-transfer-session]')!.textContent).not.toContain(id(1))
    expect(document.querySelector('[data-transfer-credential]')!.textContent).toBe('Stored source key')
    expect(button('discover').disabled).toBe(true); expect(button('run').disabled).toBe(true)
    expect(document.querySelector('[data-transfer-execution-note]')!.textContent).toContain('unavailable')
  })
  it('keeps the review action label while placing populated and empty review content in its result container', async () => {
    const initial = entry('reviewed', { accounts: [{ username: 'alice', primaryDomain: 'alice.example.test', plan: 'gold' }], plans: [{ name: 'gold' }] })
    const reviewed = { ...initial, review: { accounts: [{ source: 'alice', target: 'alice_restored', plan: 'gold', domains: ['alice.example.test'], mailboxes: 2 }] }, digest: 'd'.repeat(64) }
    const f = model(reviewed); f.boot(); await tick()
    const result = document.querySelector<HTMLElement>('[data-transfer-review-results]')!
    expect(result.tagName).toBe('DIV')
    expect(result.querySelector('table tbody')?.textContent).toContain('alice_restored')
    expect(button('review').textContent).toBe('Build current review')
    expect(button('review').querySelector('table,p')).toBeNull()
    expect(button('run').disabled).toBe(true)
    f.setCurrent(entry()); button('refresh').click(); await tick(); await tick()
    expect(result.querySelector('table')).toBeNull()
    expect(result.textContent).toContain('No reviewed records were returned.')
    expect(button('review').textContent).toBe('Build current review')
  })
  it('cancels confirmation without reading or writing and keeps the source draft', async () => {
    const f = model(); f.ask.mockResolvedValue(false); f.boot(); await tick()
    field('transfer-host').value = 'source.example.test'
    const calls = f.send.mock.calls.length
    button('cancel').click(); await tick()
    expect(f.send.mock.calls).toHaveLength(calls); expect(field('transfer-host').value).toBe('source.example.test')
  })
  it('cancels a pending session with the captured revision and verifies persisted readback', async () => {
    const f = model(); f.boot(); await tick(); button('cancel').click(); await tick(); await tick()
    expect(f.writes()).toHaveLength(1)
    expect(f.writes()[0]![2]).toEqual({ action: 'cancel', expectedRevision: '1'.repeat(64) })
    expect(status().dataset.state).toBe('saved'); expect(button('cancel').disabled).toBe(true)
    expect(document.querySelector('[data-transfer-state]')!.textContent).toBe('Cancelled')
  })
  it('creates a draft with a stored credential reference without invented events or source identity', async () => {
    const f = model(); f.boot(); await tick()
    field('transfer-host').value = 'source.example.test'; field('transfer-fingerprint').value = 'SHA256:' + 'A'.repeat(43)
    button('create').click(); await tick(); await tick()
    expect(f.writes()[0]![2]).toEqual({ auth: { kind: 'ssh-key', host: 'source.example.test', port: 22, user: 'root', keyId: id(2), hostKeyFingerprint: 'SHA256:' + 'A'.repeat(43) } })
    expect(status().dataset.state).toBe('saved')
  })
  it.each([['unknown', 'uncertain'], ['stale', 'stale']])('preserves a %s outcome and requires explicit saved-state inspection', async (mode, expected) => {
    const f = model(); f.boot(); await tick(); f.setMode(mode)
    button('cancel').click(); await tick(); await tick()
    expect(status().dataset.state).toBe(expected); expect(button('cancel').disabled).toBe(true); expect(f.writes()).toHaveLength(1)
    f.ask.mockResolvedValue(false); button('refresh').click(); await tick(); expect(status().dataset.state).toBe(expected)
    f.ask.mockResolvedValue(true); button('refresh').click(); await tick(); await tick(); expect(status().dataset.state).toBe('read'); expect(f.writes()).toHaveLength(1)
  })
  it('refuses an absent or oversized archive before dispatch', async () => {
    const f = model(); f.boot(); await tick(); button('inspect').click(); await tick()
    expect(status().dataset.state).toBe('failed'); expect(f.writes()).toHaveLength(0)
    Object.defineProperty(field('transfer-archive'), 'files', { configurable: true, value: [{ name: 'too-large.tar.gz', size: 524289 }] })
    button('inspect').click(); await tick(); expect(f.writes()).toHaveLength(0)
  })
  it('updates approved observed-data panels and clears facts when another session has none', async () => {
    document.body.insertAdjacentHTML('beforeend', '<section data-whm-detail-section="transfer-identities"><p class="xp-whm-detail-status">Not read</p><table><thead><tr><th>Account</th></tr></thead><tbody></tbody></table></section><section data-whm-detail-section="transfer-progress"><div data-transfer-progress-state="not-read">Not read</div><table><thead><tr><th>Progress</th></tr></thead><tbody></tbody></table></section>')
    const initial = entry('applying', { accounts: [{ username: 'alice', primaryDomain: 'alice.example.test', plan: 'gold', diskBytes: 64, databases: [], mailboxes: 0 }], plans: [{ name: 'gold' }] })
    initial.session.selection.accounts = ['alice']; initial.session.progress = { alice: { phase: 'copying', bytes: 32, totalBytes: 64 } }
    const f = model(initial); f.boot(); await tick()
    expect(document.querySelector('[data-whm-detail-section="transfer-identities"] tbody')!.textContent).toContain('alice')
    expect(document.querySelector('[data-whm-detail-section="transfer-progress"] tbody')!.textContent).toContain('32 / 64')
    expect(document.querySelector('[data-transfer-progress-state]')!.getAttribute('data-transfer-progress-state')).toBe('read')
    f.setCurrent(entry()); button('refresh').click(); await tick(); await tick()
    expect(document.querySelector('[data-whm-detail-section="transfer-progress"] tbody')!.textContent).not.toContain('32 / 64')
    expect(document.querySelector('[data-transfer-progress-state]')!.getAttribute('data-transfer-progress-state')).toBe('not-read')
  })
  it('inspects bytes through the archive route without discarding an unsaved source selection', async () => {
    const f = model(entry('inventoried', { accounts: [{ username: 'alice' }], plans: [{ name: 'gold' }] })); f.boot(); await tick()
    const checkbox = document.querySelector<HTMLInputElement>('[data-transfer-accounts] input')!; checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    Object.defineProperty(field('transfer-archive'), 'files', { configurable: true, value: [{ name: 'cpmove-bob.tar.gz', size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }] })
    button('inspect').click(); await tick(); await tick()
    expect(f.writes()[0]?.[1]).toBe('/api/transfers/cpanel-review')
    expect(f.writes()[0]?.[2]).toEqual({ filename: 'cpmove-bob.tar.gz', archiveBase64: 'AQID' })
    expect(status().dataset.state).toBe('saved')
    expect(document.querySelector<HTMLInputElement>('[data-transfer-accounts] input')!.checked).toBe(true)
  })
  it('fills actual parsed archive details and clears stale rows without implying import execution', async () => {
    const grid = '<table><thead><tr><th>Item</th><th>Source</th><th>Destination</th><th>Action</th></tr></thead><tbody></tbody></table>'
    document.body.insertAdjacentHTML('beforeend', '<section data-whm-detail-section="transfer-import"><p class="xp-whm-detail-status">Not read</p>' + Array.from({ length: 5 }, () => '<details>' + grid + '</details>').join('') + grid + '</section>')
    const f = model()
    f.setArchiveReviews([{ plan: { account: { username: 'bob', primaryDomain: 'bob.example.test' }, domains: [{ name: 'bob.example.test', docRoot: 'public_html' }], home: { files: 2, bytes: 32 }, databases: [{ sourceName: 'bob_blog', name: 'target_blog' }], dbUsers: [{ sourceName: 'bob_writer', name: 'target_writer' }], mailboxes: [{ address: 'support@bob.example.test', maildir: 'mail/bob.example.test/support', hasMaildir: true }], dnsZones: [{ zone: 'bob.example.test', records: [{ name: 'www', type: 'A', content: '192.0.2.10' }] }], warnings: [{ message: 'Review \u0662 source entries', path: 'homedir/example' }] }, conflicts: [{ kind: 'username', value: 'bob' }] }])
    f.boot(); await tick()
    const section = document.querySelector('[data-whm-detail-section="transfer-import"]')!
    expect(section.textContent).toContain('public_html'); expect(section.textContent).toContain('target_blog'); expect(section.textContent).toContain('target_writer')
    expect(section.textContent).toContain('support@bob.example.test'); expect(section.textContent).toContain('192.0.2.10'); expect(section.textContent).toContain('Review 2 source entries')
    expect(section.textContent).toContain('Parsed review only'); expect(button('run').disabled).toBe(true); expect(f.writes()).toHaveLength(0)
    f.setArchiveReviews([]); button('refresh').click(); await tick(); await tick()
    expect(section.textContent).not.toContain('target_blog'); expect(section.textContent).not.toContain('192.0.2.10')
    expect(section.textContent).toContain('No parsed archive review was returned')
  })
  it('fills source plans from observed inventory and clears them on a session without inventory', async () => {
    document.body.insertAdjacentHTML('beforeend', '<section data-whm-detail-section="transfer-plans"><p class="xp-whm-detail-status">Not read</p><table><thead><tr><th>Plan</th><th>Destination</th><th>Owner</th><th>Conflict</th></tr></thead><tbody></tbody></table></section>')
    const f = model(entry('inventoried', { accounts: [], plans: [{ name: 'source-gold' }] })); f.boot(); await tick()
    const section = document.querySelector('[data-whm-detail-section="transfer-plans"]')!
    expect(section.textContent).toContain('source-gold'); expect(section.textContent).toContain('ownership has not been read')
    f.setCurrent(entry()); button('refresh').click(); await tick(); await tick()
    expect(section.textContent).not.toContain('source-gold'); expect(section.textContent).toContain('No authenticated source plans')
  })
})


describe('transfer human session dates preserve persisted option identity', () => {
  it.each(['en', 'ar'] as const)('shows precise UTC metadata in %s while the native option value stays the stored session id', async lang => {
    const initial = entry(), rawAt = '2026-10-27T14:00:00.123456+02:00'
    initial.session.createdAt = rawAt
    const original = JSON.stringify(initial), f = model(initial)
    document.body.innerHTML = renderWhmTransferWorkspace({ lang, canManage: true, credentials: [{ id: id(2), label: 'Stored source key', kind: 'ssh-key' }] })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = f.send
    document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
    new Function('return ' + WHM_TRANSFER_CLIENT_BINDING)()(f.ask)
    await tick()
    expect(document.querySelector('[data-transfer-archive-limit]')!.textContent).toBe(lang === 'ar' ? 'الحد الأقصى لرفع أرشيف للفحص: 524288 بايت' : 'Maximum archive inspection upload: 524288 bytes')
    const picker = document.querySelector<HTMLSelectElement>('[data-transfer-session]')!, option = picker.options[0]!
    expect(option.textContent).toContain('2026-10-27 12:00 UTC')
    expect(option.textContent).toMatch(lang === 'ar' ? /^جلسة غير مرقمة · .+ · 2026-10-27 12:00 UTC · .+$/ : /^Unnumbered session · .+ · 2026-10-27 12:00 UTC · .+$/)
    expect(option.textContent).not.toContain(rawAt); expect(option.textContent).not.toContain(id(1))
    expect(option.value).toBe(id(1)); expect(picker.value).toBe(id(1))
    expect(f.send.mock.calls.map(call => call.slice(0, 2))).toEqual([['GET', '/api/transfers/sessions']])
    expect(f.writes()).toHaveLength(0); expect(button('discover').disabled).toBe(true); expect(button('run').disabled).toBe(true)
    expect(JSON.stringify(initial)).toBe(original)
  })
})
