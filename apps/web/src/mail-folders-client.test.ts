// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMailFolders } from './board-port/xmail-folders.ts'
import { MAIL_FOLDERS_CLIENT_BINDING, readMailFolderChange, readMailFolderList } from './mail-folders-client.ts'

const MAILBOX = 'alice@example.com'
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const folder = (over: Record<string, unknown> = {}) => ({ folder: 'Projects', name: 'Projects', nameDecoded: true, leaf: 'Projects', parent: null, depth: 0, delimiter: '.', specialUse: null, system: false, selectable: true, subscribed: true, children: 1, messages: 4, unseen: 2, ...over })
const list = (over: Record<string, unknown> = {}) => ({ mailbox: MAILBOX, observedAt: '2026-10-27T12:00:00.000Z', subscriptionsObserved: true, statusComplete: true, folders: [
  folder({ folder: 'INBOX', name: 'INBOX', leaf: 'INBOX', system: true, children: 0, messages: 3, unseen: 1 }), folder(),
  folder({ folder: 'Projects.&BkUGNAYnBjEGSgY5-', name: 'Projects.مشاريع', leaf: 'مشاريع', parent: 'Projects', depth: 1, children: 0, messages: 0, unseen: 0, subscribed: false }),
  folder({ folder: 'Sent', name: 'Sent', leaf: 'Sent', specialUse: '\\Sent', system: true, children: 0 }),
], ...over })
const change = (over: Record<string, unknown> = {}) => ({ operation: 'create', folder: 'Reports', outcome: 'confirmed', stateChanged: true, serverCode: null, view: list(), ...over })
const boot = (html: string, request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ar = false) => {
  document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'
  document.body.innerHTML = html
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + MAIL_FOLDERS_CLIENT_BINDING)()()
}
const status = () => document.querySelector<HTMLElement>('[data-mail-folders-status]')!
beforeEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('xMail folder readers', () => {
  it('accept only the sealed mailbox listing and flagged outcomes', () => {
    expect(readMailFolderList(list(), MAILBOX).folders).toHaveLength(4)
    for (const value of [list({ mailbox: 'bob@example.com' }), list({ folders: [folder(), folder()] }), list({ folders: [folder({ folder: 'bad\nname' })] }), list({ folders: [folder({ specialUse: '\\Secret' })] }),
      list({ subscriptionsObserved: false }), list({ folders: [folder({ messages: -1 })] }), list({ observedAt: 'yesterday' })]) expect(() => readMailFolderList(value, MAILBOX)).toThrow()
    expect(readMailFolderChange(change({ outcome: 'unknown', verificationRequired: true }), MAILBOX).outcome).toBe('unknown')
    for (const value of [change({ outcome: 'unknown' }), change({ stateChanged: false }), change({ operation: 'empty' }), change({ view: list({ mailbox: 'bob@example.com' }) })]) expect(() => readMailFolderChange(value, MAILBOX)).toThrow()
  })
})

describe('xMail folders workspace', () => {
  it('renders English and Arabic with the mailbox isolated as LTR and ASCII digits', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderMailFolders({ locale, mailbox: MAILBOX, canManage: true })
      expect(html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`)
      expect(html).toContain('<bdi dir="ltr">alice@example.com</bdi>')
      expect(html).toContain(locale === 'ar' ? 'مجلدات البريد' : 'Mail folders')
      expect(html).not.toMatch(/[٠-٩۰-۹]/)
    }
    expect(renderMailFolders({ locale: 'en', mailbox: '"><x>', canManage: false })).not.toContain('"><x>')
  })
  it('makes no request without transport, admission or a mailbox', async () => {
    boot(renderMailFolders({ locale: 'en', mailbox: MAILBOX, canManage: true }))
    expect(status().dataset.state).toBe('unavailable')
    const send = vi.fn()
    boot(renderMailFolders({ locale: 'en', mailbox: MAILBOX, canManage: false }), send); await tick()
    boot(renderMailFolders({ locale: 'en', mailbox: '', canManage: true }), send); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLButtonElement>('[data-mail-folders-submit]')!.disabled).toBe(true)
  })
  it('lists folders as a tree with protected system folders and no mailbox selector', async () => {
    const send = vi.fn(async () => list())
    boot(renderMailFolders({ locale: 'en', mailbox: MAILBOX, canManage: true }), send); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/webmail/folders')
    const rows = [...document.querySelectorAll('[data-mail-folders-rows] tr')]
    expect(rows).toHaveLength(4)
    expect(rows[0]!.textContent).toContain('Protected'); expect(rows[3]!.textContent).toContain('Sent')
    expect(rows[2]!.querySelector<HTMLElement>('.xp-mail-folders__name')!.style.paddingInlineStart).toBe('16px')
    expect(rows[2]!.textContent).toContain('مشاريع')
    expect(rows[1]!.querySelectorAll('button')).toHaveLength(2)
    expect([...document.querySelectorAll<HTMLOptionElement>('[name="parent"] option')].map(option => option.value)).toEqual(['', 'INBOX', 'Projects', 'Projects.&BkUGNAYnBjEGSgY5-', 'Sent'])
    expect(MAIL_FOLDERS_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('creates, renames and deletes with the observed count confirmation', async () => {
    const calls: Array<[string, string, unknown]> = []
    const send = vi.fn(async (method: string, path: string, body?: unknown) => { calls.push([method, path, body]); return method === 'GET' ? list() : change({ operation: path.endsWith('delete') ? 'delete' : path.endsWith('rename') ? 'rename' : 'create' }) })
    boot(renderMailFolders({ locale: 'en', mailbox: MAILBOX, canManage: true }), send); await tick()
    const name = document.querySelector<HTMLInputElement>('[name="name"]')!, parent = document.querySelector<HTMLSelectElement>('[name="parent"]')!
    name.value = ' Reports '; parent.value = 'Projects'
    document.querySelector<HTMLFormElement>('[data-mail-folders-create]')!.dispatchEvent(new Event('submit', { cancelable: true })); await tick()
    expect(calls.at(-1)).toEqual(['POST', '/api/webmail/folders', { name: 'Reports', parent: 'Projects' }])
    expect(status().textContent).toBe('Folder created.')
    const projects = [...document.querySelectorAll('[data-mail-folders-rows] tr')][1]!
    projects.querySelectorAll('button')[0]!.click()
    const editor = document.querySelector<HTMLFormElement>('[data-mail-folders-editor]')!
    expect(editor.hidden).toBe(false)
    document.querySelector<HTMLInputElement>('[name="rename"]')!.value = 'Clients'
    editor.dispatchEvent(new Event('submit', { cancelable: true })); await tick()
    expect(calls.at(-1)).toEqual(['POST', '/api/webmail/folders/rename', { folder: 'Projects', name: 'Clients' }])
    ;[...document.querySelectorAll('[data-mail-folders-rows] tr')][1]!.querySelectorAll('button')[1]!.click()
    expect(editor.textContent).toContain('This folder holds 4 messages')
    expect(document.querySelector('[data-mail-folders-confirm-text]')!.textContent).toBe('Delete Projects and its 4 messages permanently')
    const before = calls.length
    editor.dispatchEvent(new Event('submit', { cancelable: true })); await tick()
    expect(calls.length).toBe(before); expect(status().textContent).toBe('Confirm the deletion first.')
    document.querySelector<HTMLInputElement>('[name="confirm"]')!.checked = true
    editor.dispatchEvent(new Event('submit', { cancelable: true })); await tick()
    expect(calls.at(-1)).toEqual(['POST', '/api/webmail/folders/delete', { folder: 'Projects', confirm: { folder: 'Projects', messages: 4 } }])
    expect(status().textContent).toBe('Folder deleted.')
  })
  it('toggles subscription without assuming the result', async () => {
    const send = vi.fn(async (method: string) => method === 'GET' ? list() : change({ operation: 'unsubscribe', outcome: 'unknown', verificationRequired: true }))
    boot(renderMailFolders({ locale: 'en', mailbox: MAILBOX, canManage: true }), send); await tick()
    const box = [...document.querySelectorAll<HTMLInputElement>('[data-mail-folders-subscribe]')][1]!
    box.checked = false; box.dispatchEvent(new Event('change')); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/webmail/folders/subscription', { folder: 'Projects', subscribed: false })
    expect(status().dataset.state).toBe('unknown')
  })
  it('explains refusals in Arabic and re-reads after a changed count', async () => {
    let reads = 0
    const send = vi.fn(async (method: string) => {
      if (method === 'GET') { reads++; return list() }
      throw Object.assign(new Error('conflict'), { status: 409, details: { stateChanged: false, reason: 'folder_changed', messages: 5 } })
    })
    boot(renderMailFolders({ locale: 'ar', mailbox: MAILBOX, canManage: true }), send, true); await tick()
    ;[...document.querySelectorAll('[data-mail-folders-rows] tr')][1]!.querySelectorAll('button')[1]!.click()
    expect(document.querySelector('[data-mail-folders-confirm-text]')!.textContent).toBe('احذف Projects ورسائله البالغة 4 نهائيًا')
    document.querySelector<HTMLInputElement>('[name="confirm"]')!.checked = true
    document.querySelector<HTMLFormElement>('[data-mail-folders-editor]')!.dispatchEvent(new Event('submit', { cancelable: true })); await tick()
    expect(status().textContent).toBe('تغيّر المجلد منذ قراءته. راجع العدد الجديد وأكّد مجددًا.')
    expect(status().getAttribute('role')).toBe('alert')
    expect(reads).toBe(2)
    expect(document.querySelector<HTMLElement>('[data-mail-folders-editor]')!.hidden).toBe(true)
  })
  it('states failed reads truthfully without rows', async () => {
    boot(renderMailFolders({ locale: 'en', mailbox: MAILBOX, canManage: true }), vi.fn(async () => list({ mailbox: 'bob@example.com' }))); await tick()
    expect(status().dataset.state).toBe('failed')
    expect(document.querySelectorAll('[data-mail-folders-rows] button')).toHaveLength(0)
  })
})

describe('mailbox folder timestamp precision', () => {
  it.each(['en', 'ar'] as const)('preserves the complete UTC observation timestamp in %s', async locale => {
    const observedAt = '2026-10-27T12:34:56.789Z'
    const send = vi.fn(async (_method: string, _path: string) => list({ observedAt }))
    boot(renderMailFolders({ locale, mailbox: MAILBOX, canManage: true }), send, locale === 'ar')
    await tick()
    const observed = document.querySelector<HTMLElement>('[data-mail-folders-fact="observed"]')!
    expect(observed.textContent).toBe('2026-10-27 12:34 UTC')
    expect(observed.getAttribute('dir')).toBe('ltr')
    expect(observed.textContent).not.toMatch(/[٠-٩۰-۹]/)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('GET', '/api/webmail/folders')
  })
})
