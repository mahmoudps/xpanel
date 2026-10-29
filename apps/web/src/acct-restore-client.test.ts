// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmRestoreMoreWorkspace } from './board-port/acct-restore-workspace.ts'
import { ACCT_RESTORE_CLIENT_BINDING, readRestoreMoreReply } from './acct-restore-client.ts'

const FILE = 'xpanel-backup-alice-20261026T100000Z.tar.gz', REVISION = 'a'.repeat(64), SHA = 'b'.repeat(64), BOX = 'info@alice.example.test'
const MESSAGE = 'mail/alice.example.test/info/new/1700000001.M2.host'
const context = { accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alice' }
const archive = { file: FILE, bytes: 2048, sha256: SHA, createdAt: '2026-10-26T10:00:00Z', integrity: 'verified' }
const components = (state = 'available') => ({ files: { state: 'available', files: 2, bytes: 30 }, mail: { state, truncated: false, mailboxes: [{ address: BOX, messages: 2, bytes: 22, current: 'exists' }, { address: 'gone@alice.example.test', messages: 1, bytes: 5, current: 'missing' }] },
  mailSettings: { state: 'not-restorable', files: 1 }, databases: { state: 'not-in-archive', databases: [], restores: [] }, dns: { state: 'not-in-archive', zones: [] } })
const preview = (remaining = 0) => ({ context, archive, mailboxes: [BOX], rows: [{ path: MESSAGE, bytes: 11 }], counts: { messages: 2, present: 1, batch: 1, remaining, refused: 0 }, quota: { limitMb: 'unlimited', plannedBytes: 11, fits: true }, writer: 'available', limits: {}, revision: REVISION })
const restored = { context, archive, mailboxes: [BOX], results: [{ path: MESSAGE, bytes: 11, result: 'restored', reason: null, verificationRequired: false }], counts: { restored: 1, 'skipped-exists': 0, failed: 0, 'not-attempted': 0 }, createdDirectories: 0, complete: true, remaining: 0, verificationRequired: false, revision: REVISION }
type Transport = (method: string, path: string, body?: any) => Promise<unknown>
const server = (overrides: Record<string, () => unknown> = {}): Transport => vi.fn(async (_method: string, path: string) => {
  const key = path === '/api/backups/files' ? 'accounts' : path === '/api/backups/files/alice' ? 'archives' : path.split('/').at(-1)!
  if (overrides[key]) return overrides[key]!()
  return ({ accounts: { accounts: [{ username: 'alice', primaryDomain: 'alice.example.test' }] }, archives: { context, archives: [{ file: FILE, bytes: 2048, createdAt: '2026-10-26T10:00:00Z', integrity: 'unverified', reason: null }], total: 1, truncated: false },
    inventory: { context, archive, components: components() }, preview: preview(), restore: restored } as Record<string, unknown>)[key]
})
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const mount = (locale: 'en' | 'ar' = 'en', canRead = true, canRestore = true) => { const view = renderWhmRestoreMoreWorkspace({ locale, canRead, canRestore }); document.body.innerHTML = `<section data-capability-state="authorized">${view.main}${view.aside}</section>` }
const boot = async (request?: Transport) => { if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; new Function('return ' + ACCT_RESTORE_CLIENT_BINDING)()(); await tick() }
const q = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const click = async (element: Element) => { (element as HTMLElement).click(); await tick() }
const open = async (request: Transport) => {
  await boot(request)
  const select = q<HTMLSelectElement>('[data-restore-more-account]'); select.value = 'alice'; select.dispatchEvent(new Event('change', { bubbles: true })); await tick()
  await click(q(`button[data-file="${FILE}"]`))
}
const tickBox = async (address: string) => { const box = q<HTMLInputElement>(`[data-restore-more-mailboxes] input[value="${address}"]`); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); await tick() }
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; mount() })

describe('restore-more reply parser', () => {
  it('binds replies to the account, archive, mailboxes and revision', () => {
    expect(readRestoreMoreReply('inventory', { context, archive, components: components() }, { username: 'alice', file: FILE }).mail.mailboxes).toHaveLength(2)
    expect(() => readRestoreMoreReply('inventory', { context: { ...context, username: 'bob' }, archive, components: components() }, { username: 'alice', file: FILE })).toThrow()
    expect(() => readRestoreMoreReply('inventory', { context, archive, components: { ...components(), dns: { state: 'available' } } }, { username: 'alice', file: FILE })).toThrow()
    expect(() => readRestoreMoreReply('preview', { ...preview(), rows: [{ path: 'mail/alice.example.test/other/cur/1', bytes: 1 }] }, { username: 'alice', file: FILE, mailboxes: [BOX] })).toThrow()
    expect(() => readRestoreMoreReply('restore', restored, { username: 'alice', file: FILE, mailboxes: [BOX], revision: 'c'.repeat(64) })).toThrow()
    expect(readRestoreMoreReply('restore', restored, { username: 'alice', file: FILE, mailboxes: [BOX], revision: REVISION }).counts.restored).toBe(1)
  })
})

describe('restore-more client', () => {
  it('shows every component truthfully and allows only existing mailboxes', async () => {
    await open(server())
    const rows = [...document.querySelectorAll('[data-restore-more-components] tr')].map(row => row.textContent)
    expect(rows).toHaveLength(5)
    expect(rows[3]).toContain('no database dumps')
    expect(rows[4]).toContain('Not in this backup')
    expect(q<HTMLInputElement>('[data-restore-more-mailboxes] input[value="gone@alice.example.test"]').disabled).toBe(true)
    expect(q<HTMLButtonElement>('[data-restore-more-preview]').disabled).toBe(true)
  })
  it('reviews, requires acknowledgement and restores the reviewed batch with its revision', async () => {
    const request = server()
    await open(request)
    await tickBox(BOX)
    await click(q('[data-restore-more-preview]'))
    expect(request).toHaveBeenLastCalledWith('POST', '/api/backups/components/alice/preview', { file: FILE, mailboxes: [BOX] })
    expect(q('[data-restore-more-count-batch]').textContent).toBe('1')
    expect(q<HTMLButtonElement>('[data-restore-more-restore]').disabled).toBe(true)
    const ack = q<HTMLInputElement>('[data-restore-more-ack]'); ack.checked = true; ack.dispatchEvent(new Event('change', { bubbles: true })); await tick()
    await click(q('[data-restore-more-restore]'))
    expect(request).toHaveBeenLastCalledWith('POST', '/api/backups/components/alice/restore', { file: FILE, mailboxes: [BOX], expectedRevision: REVISION })
    expect(q('[data-restore-more-count-restored]').textContent).toBe('1')
    expect(q('[data-restore-more-continue]').hidden).toBe(true)
  })
  it('reports an unverifiable reply and stays inert without authority', async () => {
    await open(server({ inventory: () => ({ context, archive, components: { ...components(), databases: { state: 'available' } } }) }))
    expect(q('[data-restore-more-status]').textContent).toContain('could not be verified')
    mount('en', false)
    const request = server()
    await boot(request)
    expect(request).not.toHaveBeenCalled()
    expect(q('[data-restore-more-status]').dataset.state).toBe('unavailable')
  })
  it('renders Arabic direction from the locale with ASCII digits', async () => {
    document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl'
    try {
      mount('ar')
      expect(q('[data-whm-restore-more-workspace]').getAttribute('dir')).toBe('rtl')
      expect(q('[data-restore-more-steps]').textContent).not.toMatch(/[٠-٩]/)
      const unverified = { ...restored, results: [{ path: MESSAGE, bytes: 11, result: 'failed', reason: 'write-unknown', verificationRequired: true }], counts: { restored: 0, 'skipped-exists': 0, failed: 1, 'not-attempted': 0 }, verificationRequired: true }
      await open(server({ preview: () => ({ ...preview(), quota: { limitMb: 100, plannedBytes: 11, fits: true } }), restore: () => unverified }))
      expect(q(`button[data-file="${FILE}"]`).getAttribute('aria-label')).toBe('فتح النسخة ' + FILE)
      expect(q(`[data-restore-more-mailboxes] input[value="${BOX}"]`).getAttribute('aria-label')).toBe('تحديد ' + BOX)
      await tickBox(BOX); await click(q('[data-restore-more-preview]'))
      expect(q('[data-restore-more-quota]').textContent).toBe('ضمن 100 MiB')
      const ack = q<HTMLInputElement>('[data-restore-more-ack]'); ack.checked = true; ack.dispatchEvent(new Event('change', { bubbles: true })); await tick()
      await click(q('[data-restore-more-restore]'))
      expect(q('[data-restore-more-results]').textContent).toContain(' يلزم التحقق.')
      expect(q('[data-restore-more-status]').textContent).toContain(' تتطلب بعض النتائج فحص صناديق البريد.')
    } finally { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' }
  })
})

describe('database restore replies', () => {
  it('reads archived dumps and binds an accepted restore to the reviewed archive and databases', () => {
    const dumps = { state: 'available', databases: [{ name: 'alice_wp', bytes: 10, current: 'exists' }], restores: [] }
    expect(readRestoreMoreReply('inventory', { context, archive, components: { ...components(), databases: dumps } }, { username: 'alice', file: FILE }).databases).toEqual({ state: 'available', databases: [{ name: 'alice_wp', bytes: 10, current: 'exists' }] })
    const zones = { state: 'available', zones: [{ name: 'alice.example.test', bytes: 50, current: 'exists' }] }
    expect(readRestoreMoreReply('inventory', { context, archive, components: { ...components(), dns: zones } }, { username: 'alice', file: FILE }).dns).toEqual(zones)
    for (const databases of [{ ...dumps, databases: [{ name: 'bob_wp', bytes: 10, current: 'exists' }] }, { ...dumps, state: 'not-in-archive' }, { state: 'available' }])
      expect(() => readRestoreMoreReply('inventory', { context, archive, components: { ...components(), databases } }, { username: 'alice', file: FILE })).toThrow()
    const started = { context, archive: { file: FILE, sha256: SHA }, restoreId: '44444444-4444-4444-8444-444444444444', state: 'running', databases: ['alice_wp'], zones: ['alice.example.test'] }
    const expected = { username: 'alice', file: FILE, sha256: SHA, databases: ['alice_wp'], zones: ['alice.example.test'] }
    expect(readRestoreMoreReply('parts', started, expected)).toEqual({ restoreId: started.restoreId, databases: ['alice_wp'], zones: ['alice.example.test'] })
    for (const reply of [{ ...started, state: 'finished' }, { ...started, archive: { file: FILE, sha256: 'c'.repeat(64) } }, { ...started, databases: ['alice_shop'] }, { ...started, zones: [] }])
      expect(() => readRestoreMoreReply('parts', reply, expected)).toThrow()
  })
})
