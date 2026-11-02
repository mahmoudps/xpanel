// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import { ACCOUNT_BACKUP_CLIENT_BINDING, readAccountBackups, readAccountBackupPreview } from './account-backup-client.ts'
import { renderAccountBackupWorkspace } from './board-port/account-backup-workspace.ts'
import { renderV2AccountBackupPage } from './themes/v2/pages/xpanel/operations/backup.ts'
import { isLocale, translator } from './i18n.ts'

let testDom: EnvironmentReturn | undefined
beforeEach(async () => {
  testDom = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://panel.example.test/backups', runScripts: 'outside-only' } })
  vi.stubGlobal('xpT', (message: string, values?: Readonly<Record<string, string | number>>) => {
    const lang = document.documentElement.lang
    return translator(isLocale(lang) ? lang : undefined)(message, values)
  })
})

// Declared HTTP replies exercise the real binding; no native archive operation is implied.
const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username = 'alice'
const file = 'xpanel-backup-alice-20261026T100000Z.tar.gz'
const created = 'xpanel-backup-alice-20261026T100001Z-abcdef012345.tar.gz'
const recovery = 'xpanel-backup-alice-20261026T100002Z-fedcba543210.tar.gz'
const context = { accountId, username, scope: 'home', mailPreserved: true, maxBytes: 2 * 1024 * 1024 * 1024 }
const review = { file, bytes: 123, scope: 'home', mailPreserved: true, revision: 'a'.repeat(64), archiveSha256: 'b'.repeat(64),
  rows: [{ path: '<img src=x onerror=alert(1)>', state: 'replace', archiveBytes: 3, currentBytes: 2 }, { path: 'kept.txt', state: 'keep', archiveBytes: null, currentBytes: 1 }],
  counts: { add: 0, replace: 1, unchanged: 0, keep: 1, 'preserve-mail': 0 } }
const element = <T extends Element = HTMLElement>(key: string): T => document.querySelector('[data-account-backup-' + key + ']') as T
const click = (key: string): void => element<HTMLButtonElement>(key).click()
const settled = async (): Promise<void> => { await vi.waitFor(() => expect(document.querySelector('[data-account-backup]')!.getAttribute('aria-busy')).toBe('false')) }
const v2Page = (locale: 'en' | 'ar' = 'en'): string => renderV2AccountBackupPage({ locale, account: { id: accountId, username, uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test', planId: 'p1', ownerId: null, status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.1', ipv6: null, extraIps: [], shell: 'jailed', createdAt: '2026-10-29T00:00:00Z' } }, { canRead: true, canManage: true })
function mount(options: { manage?: boolean; transport?: boolean; archives?: {file:string;bytes:number}[]; dialog?: boolean; failure?: 'unknown' | 'refused' | 'wrong-context'; html?: string; beforeBind?: (root: HTMLElement) => void } = {}) {
  const archives = options.archives ?? [{ file, bytes: 123 }]
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (method === 'GET') return { context, backups: [...archives] }
    if (path.endsWith('/preview')) return { context, preview: review }
    if (options.failure === 'unknown') throw { status: 503 }
    if (options.failure === 'refused') throw { status: 422, details: { stateChanged: false } }
    if (options.failure === 'wrong-context') return { context: { ...context, accountId: 'other' }, backup: { file: created, bytes: 123 } }
    if (path.endsWith('/restore')) { archives.push({ file: recovery, bytes: 90 }); return { context, backup: { file, scope: 'home', mailPreserved: true, contentReadback: 'matched', recovery: { file: recovery, bytes: 90 } } } }
    expect(body).toEqual({}); archives.push({ file: created, bytes: 120 }); return { context, backup: { file: created, bytes: 120 } }
  })
  Object.assign(window, { xpanelSessionRequest: options.transport === false ? undefined : request })
  document.body.innerHTML = options.html ?? renderAccountBackupWorkspace({ lang: 'en', accountId, username, canManage: options.manage !== false })
  options.beforeBind?.(document.querySelector<HTMLElement>('[data-account-backup]')!)
  const dialog = vi.fn(async () => options.dialog !== false)
  const bind = new Function('return ' + ACCOUNT_BACKUP_CLIENT_BINDING)() as (ask: typeof dialog) => void
  bind(dialog)
  return { request, dialog }
}
afterEach(async () => {
  try {
    document.body.textContent = ''
    delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  } finally {
    await testDom?.teardown(globalThis)
    testDom = undefined
  }
})

describe('account backup reply identity and review validation', () => {
  it('pins the account, archive names, unique metadata and exact difference counts', () => {
    expect(readAccountBackups({ context, backups: [{ file, bytes: 0 }] }, accountId, username)).toEqual([{ file, bytes: 0 }])
    expect(() => readAccountBackups({ context: { ...context, accountId: 'foreign' }, backups: [] }, accountId, username)).toThrow()
    expect(() => readAccountBackups({ context, backups: [{ file: file.replace('alice', 'bob'), bytes: 10 }] }, accountId, username)).toThrow()
    expect(() => readAccountBackups({ context, backups: [{ file, bytes: 10 }, { file, bytes: 10 }] }, accountId, username)).toThrow()
    expect(readAccountBackupPreview({ context, preview: review }, accountId, username, file).counts.replace).toBe(1)
    expect(() => readAccountBackupPreview({ context, preview: { ...review, counts: { ...review.counts, replace: 2 } } }, accountId, username, file)).toThrow()
    expect(() => readAccountBackupPreview({ context, preview: { ...review, rows: [{ ...review.rows[0], path: 'bad\u0000name' }] } }, accountId, username, file)).toThrow()
  })
  it('serializes a self-contained binding without raw fetch or innerHTML sinks', () => {
    expect(ACCOUNT_BACKUP_CLIENT_BINDING).not.toContain('innerHTML')
    expect(ACCOUNT_BACKUP_CLIENT_BINDING).not.toContain('fetch(')
    expect(() => new Function('return ' + ACCOUNT_BACKUP_CLIENT_BINDING)()).not.toThrow()
  })
})

describe('actual backup UI binding with declared transport', () => {
  it.each(['classic', 'v2'] as const)('keeps the %s archive columns and dated semantic slot after a real read', async theme => {
    mount({ ...(theme === 'v2' ? { html: v2Page() } : {}) }); await settled()
    const row = element<HTMLTableSectionElement>('archives').rows[0]!
    expect(row.cells).toHaveLength(theme === 'v2' ? 6 : 4)
    expect(row.querySelector('[data-xp-slot="file"]')?.textContent).toBe(file)
    expect(row.querySelector('time')?.dateTime).toBe('2026-10-26T10:00:00Z')
    expect(row.querySelector('[data-xp-slot="bytes"]')?.textContent).toBe('123')
    if (theme === 'v2') {
      expect(row.cells[1]?.textContent).toBe('Home files')
      expect(row.cells[3]?.textContent).toBe('Account archive storage')
    }
  })
  it.each(['classic', 'v2'] as const)('retains the %s empty-table column span', async theme => {
    mount({ archives: [], ...(theme === 'v2' ? { html: v2Page() } : {}) }); await settled()
    expect(element<HTMLTableSectionElement>('archives').rows[0]!.cells[0]!.colSpan).toBe(theme === 'v2' ? 6 : 4)
  })
  it('uses the V2 row action to review that archive without applying a restore', async () => {
    const { request } = mount({ html: v2Page(), archives: [{ file: created, bytes: 120 }, { file, bytes: 123 }] }); await settled()
    const row = [...element<HTMLTableSectionElement>('archives').rows].find(row => row.querySelector('[data-xp-slot="file"]')?.textContent === file)!
    row.querySelector<HTMLButtonElement>('[data-xp-action="review"]')!.click()
    await vi.waitFor(() => expect(element('status').dataset.state).toBe('reviewed'))
    expect(element<HTMLSelectElement>('select').value).toBe(file)
    expect(request.mock.calls.filter(call => call[0] === 'POST')).toEqual([['POST', '/api/account/backups/' + file + '/preview', {}]])
    expect(element<HTMLButtonElement>('restore').disabled).toBe(true)
    expect(element('differences').querySelector('img')).toBeNull()
  })
  it.each(['missing', 'ambiguous', 'wrong-shape'] as const)('refuses a %s theme template before any archive request', async failure => {
    const { request } = mount({ html: v2Page(), beforeBind: root => {
      if (failure === 'missing') root.querySelector('template[data-xp-template="account-backup-difference-row"]')!.remove()
      else if (failure === 'ambiguous') root.append(root.querySelector('template[data-xp-template="account-backup-archive-row"]')!.cloneNode(true))
      else root.querySelector<HTMLElement>('[data-account-backup-archives]')!.dataset.xpColumns = '4'
    } })
    expect(request).not.toHaveBeenCalled()
    expect(element('status').dataset.state).toBe('unavailable')
    expect(element<HTMLButtonElement>('restore').disabled).toBe(true)
  })
  it('sends no read for unavailable transport or missing admission', async () => {
    const first = mount({ manage: false }); expect(first.request).not.toHaveBeenCalled(); expect(element<HTMLButtonElement>('create').disabled).toBe(true)
    const second = mount({ transport: false }); expect(second.request).not.toHaveBeenCalled(); expect(element('status').textContent).toContain('unavailable')
  })
  it('reads actual metadata, exposes the pinned download and verifies create readback', async () => {
    const { request } = mount(); await settled()
    expect(element<HTMLAnchorElement>('download').getAttribute('href')).toBe('/api/account/backups/' + file + '/download')
    click('create'); await vi.waitFor(() => expect(element('status').dataset.state).toBe('created'))
    expect(request.mock.calls.filter(call => call[0] === 'POST')).toEqual([['POST', '/api/account/backups', {}]])
    expect(element<HTMLSelectElement>('select').value).toBe(created)
    expect(request.mock.calls.filter(call => call[0] === 'GET')).toHaveLength(2)
  })
  it('does not send a cancelled creation', async () => {
    const { request } = mount({ dialog: false }); await settled(); click('create'); await settled()
    expect(request.mock.calls.some(call => call[0] === 'POST')).toBe(false)
  })
  it('renders reviewed paths as text and requires exact name, acknowledgement and confirmation for restore', async () => {
    const { request, dialog } = mount(); await settled(); click('preview'); await vi.waitFor(() => expect(element('status').dataset.state).toBe('reviewed'))
    expect(element('differences').textContent).toContain('<img src=x onerror=alert(1)>'); expect(element('differences').querySelector('img')).toBeNull()
    expect(element<HTMLAnchorElement>('csv').getAttribute('href')).toContain('revision=' + review.revision)
    expect(element<HTMLButtonElement>('restore').disabled).toBe(true)
    element<HTMLInputElement>('confirmation').value = username; element('confirmation').dispatchEvent(new Event('input'))
    expect(element<HTMLButtonElement>('restore').disabled).toBe(true)
    element<HTMLInputElement>('ack').checked = true; element('ack').dispatchEvent(new Event('change')); click('restore')
    await vi.waitFor(() => expect(element('status').dataset.state).toBe('restored'))
    expect(request).toHaveBeenCalledWith('POST', '/api/account/backups/' + file + '/restore', { expectedRevision: review.revision, confirmation: username })
    expect(dialog).toHaveBeenCalledTimes(1); expect(element('status').textContent).toContain(recovery)
  })
  it.each(['unknown', 'wrong-context'] as const)('locks an unverified %s outcome until an explicit current-state read', async failure => {
    const { request } = mount({ failure }); await settled(); click('create'); await vi.waitFor(() => expect(element('status').dataset.state).toBe('uncertain'))
    expect(element<HTMLButtonElement>('create').disabled).toBe(true)
    expect(request.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(1)
    click('refresh'); await vi.waitFor(() => expect(element('status').dataset.state).toBe('read'))
    expect(element<HTMLButtonElement>('create').disabled).toBe(false)
    expect(request.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(1)
  })
  it('retains definite refusal as editable and leaves over-limit archives visible without download/restore', async () => {
    mount({ failure: 'refused' }); await settled(); click('create'); await vi.waitFor(() => expect(element('status').dataset.state).toBe('failed'))
    expect(element<HTMLButtonElement>('create').disabled).toBe(false)
    mount({ archives: [{ file, bytes: context.maxBytes + 1 }] }); await settled()
    expect(element('archives').textContent).toContain(String(context.maxBytes + 1)); expect(element<HTMLAnchorElement>('download').hasAttribute('href')).toBe(false)
    expect(element<HTMLButtonElement>('preview').disabled).toBe(true)
  })
})

describe('readable backup archive date metadata', () => {
  it.each([['classic', 'en'], ['classic', 'ar'], ['v2', 'en'], ['v2', 'ar']] as const)('renders readable archive creation dates without changing natural archive identity in %s %s', async (theme, locale) => {
    const archive = created, invalidCalendar = 'xpanel-backup-alice-20260230T100000Z.tar.gz'
    const listing = { context, backups: [{ file: archive, bytes: 123 }, { file: invalidCalendar, bytes: 124 }] }
    const previewReply = { context, preview: { ...review, file: archive } }, original = JSON.stringify({ listing, previewReply })
    expect(readAccountBackups(listing, accountId, username).map(item => item.file)).toEqual([archive, invalidCalendar])
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path === '/api/account/backups') return JSON.parse(JSON.stringify(listing))
      if (method === 'POST' && path === '/api/account/backups/' + archive + '/preview' && JSON.stringify(body) === '{}') return JSON.parse(JSON.stringify(previewReply))
      throw new Error('unexpected_archive_operation')
    })
    Object.assign(window, { xpanelSessionRequest: request })
    document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    document.body.innerHTML = theme === 'v2' ? v2Page(locale) : renderAccountBackupWorkspace({ lang: locale, accountId, username, canManage: true })
    const dialog = vi.fn(async (_options: Record<string, unknown>) => false)
    ;(new Function('return ' + ACCOUNT_BACKUP_CLIENT_BINDING)() as (ask: typeof dialog) => void)(dialog)
    await vi.waitFor(() => expect(element('status').dataset.state).toBe('read'))
    const rows = element('archives').querySelectorAll('tr'), time = rows[0]!.querySelector<HTMLTimeElement>('time[data-xp-slot="created"]')
    expect(rows[0]!.querySelector('[data-xp-slot="file"]')!.textContent).toBe(archive)
    expect(rows[0]!.querySelector('[data-xp-slot="bytes"]')!.textContent).toBe('123')
    expect(time).not.toBeNull()
    expect(time!.textContent).toBe('2026-10-26 10:00 UTC')
    expect(time!.getAttribute('datetime')).toBe('2026-10-26T10:00:01Z')
    expect(time!.dir).toBe('ltr')
    expect(rows[1]!.querySelector('[data-xp-slot="file"]')!.textContent).toBe(invalidCalendar)
    const unread = rows[1]!.querySelector<HTMLTimeElement>('time[data-xp-slot="created"]')!
    expect(unread.textContent).toBe(locale === 'ar' ? 'لم يُقرأ' : 'Not read')
    expect(unread.dir).toBe('ltr')
    expect(unread.hasAttribute('datetime')).toBe(false)
    expect([...element<HTMLSelectElement>('select').options].map(option => option.value)).toEqual([archive, invalidCalendar])
    expect(element<HTMLSelectElement>('select').value).toBe(archive)
    expect(element<HTMLAnchorElement>('download').getAttribute('href')).toBe('/api/account/backups/' + archive + '/download')
    expect(element<HTMLAnchorElement>('download').getAttribute('download')).toBe(archive)
    click('preview'); await vi.waitFor(() => expect(element('status').dataset.state).toBe('reviewed'))
    expect(element<HTMLAnchorElement>('csv').getAttribute('href')).toBe('/api/account/backups/' + archive + '/preview.csv?revision=' + review.revision)
    expect(request.mock.calls).toEqual([['GET', '/api/account/backups'], ['POST', '/api/account/backups/' + archive + '/preview', {}]])
    expect(dialog).not.toHaveBeenCalled()
    expect(JSON.stringify({ listing, previewReply })).toBe(original)
    click('create'); await vi.waitFor(() => expect(dialog).toHaveBeenCalledTimes(1))
    expect(dialog.mock.calls[0]![0].body).toBe(locale === 'ar' ? 'هل تريد إنشاء أرشيف ملفات الحساب alice؟ بيانات البريد وإعداداته منفصلة.' : 'Create a home-file archive for alice? Mail data and mail settings are separate.')
    expect(request).toHaveBeenCalledTimes(2)
  })
})
