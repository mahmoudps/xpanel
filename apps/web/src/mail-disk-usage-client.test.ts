// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMailDiskUsage } from './board-port/xmail-disk-usage.ts'
import { MAIL_DISK_USAGE_CLIENT_BINDING, readCleanupPreview, readCleanupResult, readMailboxUsage } from './mail-disk-usage-client.ts'

const MAILBOX = 'alice@example.com'
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const usage = (over: Record<string, unknown> = {}) => ({ mailbox: MAILBOX, observedAt: '2026-10-27T12:00:00.000Z', capabilities: { statusSize: true, quota: true, move: true, uidPlus: true },
  quota: { state: 'read', root: 'User quota', usedBytes: 2097152, limitBytes: 1073741824, messages: null }, omittedFolders: 0, trash: 'Trash', limits: { measureMessages: 50000, actionMessages: 5000 },
  folders: [{ folder: 'INBOX', name: 'INBOX', specialUse: null, messages: 3, unseen: 1, size: { state: 'measured', bytes: 3146128, method: 'status-size' } },
    { folder: 'Trash', name: 'Trash', specialUse: '\\Trash', messages: 1, unseen: 0, size: { state: 'measured', bytes: 50, method: 'status-size' } },
    { folder: 'Big', name: 'Big', specialUse: null, messages: 60000, unseen: 0, size: { state: 'not-measured', reason: 'too-many-messages' } }], ...over })
const preview = (over: Record<string, unknown> = {}) => ({ mailbox: MAILBOX, observedAt: '2026-10-27T12:00:00.000Z', folder: 'INBOX', name: 'INBOX', uidValidity: 17, criteria: { olderThanDays: 365 }, matched: 2, matchedBytes: 3145828,
  batch: { uids: [1, 2], count: 2, bytes: 3145828 }, actionLimit: 5000, trash: 'Trash', isTrash: false, capabilities: { move: true, uidPlus: true }, ...over })
const result = (over: Record<string, unknown> = {}) => ({ operation: 'move-to-trash', folder: 'INBOX', trash: 'Trash', requested: 2, completed: 2, remaining: [], outcome: 'confirmed', stateChanged: true, folders: [], ...over })
const boot = (html: string, request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ar = false) => {
  document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'
  document.body.innerHTML = html
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + MAIL_DISK_USAGE_CLIENT_BINDING)()()
}
const status = () => document.querySelector<HTMLElement>('[data-mail-usage-status]')!
const submit = (selector: string) => document.querySelector<HTMLFormElement>(selector)!.dispatchEvent(new Event('submit', { cancelable: true }))
beforeEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('xMail disk usage readers', () => {
  it('accept measured or explicitly unmeasured sizes for the sealed mailbox only', () => {
    expect(readMailboxUsage(usage(), MAILBOX).folders).toHaveLength(3)
    for (const value of [usage({ mailbox: 'bob@example.com' }), usage({ trash: 'Missing' }), usage({ quota: { state: 'guessed' } }),
      usage({ folders: [{ folder: 'INBOX', name: 'INBOX', specialUse: null, messages: 1, unseen: 0, size: { state: 'measured', bytes: 10 } }] }),
      usage({ folders: [{ folder: 'INBOX', name: 'INBOX', specialUse: null, messages: 1, unseen: 0, size: { state: 'not-measured', reason: 'lazy' } }] })]) expect(() => readMailboxUsage(value, MAILBOX)).toThrow()
    expect(readCleanupPreview(preview(), MAILBOX, 'INBOX').batch.uids).toEqual([1, 2])
    for (const value of [preview({ folder: 'Sent' }), preview({ criteria: {} }), preview({ criteria: { query: 'ALL' } }), preview({ batch: { uids: [1, 1], count: 2, bytes: 1 } }), preview({ matched: 3 })]) expect(() => readCleanupPreview(value, MAILBOX, 'INBOX')).toThrow()
    expect(() => readCleanupResult(result({ outcome: 'partial' }), 'INBOX', 2)).toThrow()
    expect(() => readCleanupResult(result({ completed: 1 }), 'INBOX', 2)).toThrow()
    expect(readCleanupResult(result({ outcome: 'partial', completed: 1, verificationRequired: true }), 'INBOX', 2).outcome).toBe('partial')
  })
})

describe('xMail disk usage workspace', () => {
  it('renders English and Arabic with ASCII digits and an LTR mailbox', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderMailDiskUsage({ locale, mailbox: MAILBOX, canManage: true })
      expect(html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`); expect(html).toContain('<bdi dir="ltr">alice@example.com</bdi>')
      expect(html).toContain(locale === 'ar' ? 'استخدام مساحة صندوق البريد' : 'Mailbox disk usage'); expect(html).not.toMatch(/[٠-٩۰-۹]/)
    }
  })
  it('makes no request without transport or admission', async () => {
    const send = vi.fn()
    boot(renderMailDiskUsage({ locale: 'en', mailbox: MAILBOX, canManage: false }), send); await tick()
    expect(send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable')
  })
  it('shows folders largest first, unmeasured folders truthfully and quota from the server', async () => {
    const send = vi.fn(async () => usage())
    boot(renderMailDiskUsage({ locale: 'en', mailbox: MAILBOX, canManage: true }), send); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/webmail/disk-usage')
    const rows = [...document.querySelectorAll('[data-mail-usage-rows] tr')].map(row => row.textContent)
    expect(rows[0]).toContain('3.0 MiB'); expect(rows[2]).toContain('Not measured: more than 50000 messages')
    expect(document.querySelector('[data-mail-usage-fact="quota-used"]')!.textContent).toBe('2.0 MiB')
    expect(document.querySelector('[data-mail-usage-fact="total"]')!.textContent).toBe('Not every folder was measured')
    expect(document.querySelector<HTMLMeterElement>('[data-mail-usage-meter]')!.hidden).toBe(false)
    expect(MAIL_DISK_USAGE_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('refuses an empty cleanup locally, previews, then moves exactly the previewed batch', async () => {
    const calls: Array<[string, string, unknown]> = []
    const send = vi.fn(async (method: string, path: string, body?: unknown) => { calls.push([method, path, body]); return path === '/api/webmail/disk-usage' ? usage() : path.startsWith('/api/webmail/disk-usage/preview') ? preview() : result() })
    boot(renderMailDiskUsage({ locale: 'en', mailbox: MAILBOX, canManage: true }), send); await tick()
    submit('[data-mail-usage-cleanup]'); await tick()
    expect(status().textContent).toBe('Choose at least one cleanup criterion.'); expect(calls).toHaveLength(1)
    document.querySelector<HTMLInputElement>('[name="olderThanDays"]')!.value = '365'
    submit('[data-mail-usage-cleanup]'); await tick()
    expect(calls.at(-1)).toEqual(['GET', '/api/webmail/disk-usage/preview?folder=INBOX&olderThanDays=365', undefined])
    const apply = document.querySelector<HTMLButtonElement>('[data-mail-usage-apply]')!
    expect(document.querySelector<HTMLElement>('[data-mail-usage-preview]')!.hidden).toBe(false); expect(apply.textContent).toBe('Move to Trash'); expect(apply.disabled).toBe(false)
    apply.click(); await tick()
    expect(calls.find(call => call[0] === 'POST')).toEqual(['POST', '/api/webmail/disk-usage/cleanup', { folder: 'INBOX', uidValidity: 17, criteria: { olderThanDays: 365 }, uids: [1, 2] }])
    expect(status().textContent).toBe('Messages moved to Trash: 2')
    expect(calls.at(-1)![1]).toBe('/api/webmail/disk-usage')
  })
  it('requires the permanent-deletion confirmation in Trash and reports partial results for review', async () => {
    const calls: Array<[string, string, unknown]> = []
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body])
      return path === '/api/webmail/disk-usage' ? usage() : path.startsWith('/api/webmail/disk-usage/preview') ? preview({ folder: 'Trash', name: 'Trash', uidValidity: 41, criteria: { seen: true }, matched: 1, matchedBytes: 50, batch: { uids: [9], count: 1, bytes: 50 }, isTrash: true })
        : result({ operation: 'delete-permanently', folder: 'Trash', requested: 1, completed: 0, outcome: 'unknown', verificationRequired: true })
    })
    boot(renderMailDiskUsage({ locale: 'en', mailbox: MAILBOX, canManage: true }), send); await tick()
    document.querySelector<HTMLSelectElement>('[name="folder"]')!.value = 'Trash'; document.querySelector<HTMLInputElement>('[name="seen"]')!.checked = true
    submit('[data-mail-usage-cleanup]'); await tick()
    const apply = document.querySelector<HTMLButtonElement>('[data-mail-usage-apply]')!, confirm = document.querySelector<HTMLInputElement>('[name="purgeConfirm"]')!
    expect(apply.textContent).toBe('Delete permanently'); expect(apply.disabled).toBe(true)
    confirm.checked = true; confirm.dispatchEvent(new Event('change'))
    expect(apply.disabled).toBe(false)
    apply.click(); await tick()
    expect(calls.find(call => call[0] === 'POST')).toEqual(['POST', '/api/webmail/disk-usage/purge', { folder: 'Trash', uidValidity: 41, criteria: { seen: true }, uids: [9], confirm: { folder: 'Trash', count: 1 } }])
    expect(status().dataset.state).toBe('unknown')
  })
  it('explains a changed preview in Arabic and re-reads usage', async () => {
    let reads = 0
    const send = vi.fn(async (method: string, path: string) => {
      if (path === '/api/webmail/disk-usage') { reads++; return usage() }
      if (method === 'GET') return preview()
      throw Object.assign(new Error('conflict'), { status: 409, details: { stateChanged: false, reason: 'cleanup_set_changed' } })
    })
    boot(renderMailDiskUsage({ locale: 'ar', mailbox: MAILBOX, canManage: true }), send, true); await tick()
    document.querySelector<HTMLInputElement>('[name="seen"]')!.checked = true
    submit('[data-mail-usage-cleanup]'); await tick()
    expect(status().textContent).toBe('الرسائل المطابقة: 2')
    document.querySelector<HTMLButtonElement>('[data-mail-usage-apply]')!.click(); await tick()
    expect(status().textContent).toBe('تغيّرت الرسائل المعاينة. عاين مجددًا. لم يتغير شيء.')
    expect(reads).toBe(2)
  })
})

describe('mailbox usage timestamp precision', () => {
  it.each(['en', 'ar'] as const)('preserves the complete UTC observation timestamp in %s', async locale => {
    const observedAt = '2026-10-27T12:34:56.789Z'
    const send = vi.fn(async (_method: string, _path: string) => usage({ observedAt }))
    boot(renderMailDiskUsage({ locale, mailbox: MAILBOX, canManage: true }), send, locale === 'ar')
    await tick()
    const observed = document.querySelector<HTMLElement>('[data-mail-usage-fact="observed"]')!
    expect(observed.textContent).toBe('2026-10-27 12:34 UTC')
    expect(observed.getAttribute('dir')).toBe('ltr')
    expect(observed.textContent).not.toMatch(/[٠-٩۰-۹]/)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('GET', '/api/webmail/disk-usage')
  })
})
