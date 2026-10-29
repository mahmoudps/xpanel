// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmBackupFilesWorkspace } from './board-port/whm-backup-files-workspace.ts'
import { readBackupFilesReply, WHM_BACKUP_FILES_CLIENT_BINDING } from './whm-backup-files-client.ts'

const FILE = 'xpanel-backup-alice-20261026T100000Z.tar.gz', BAD = 'xpanel-backup-alice-20261026T120000Z.tar.gz', FOLDER = 'restored-20261026T100000Z'
const REVISION = 'a'.repeat(64), SHA = 'b'.repeat(64)
const context = { accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alice' }
const archive = { file: FILE, bytes: 2048, sha256: SHA, createdAt: '2026-10-26T10:00:00Z', integrity: 'verified' }
const replies = {
  accounts: { accounts: [{ username: 'alice', primaryDomain: 'alice.example.test' }] },
  archives: { context, archives: [{ file: BAD, bytes: 9, createdAt: '2026-10-26T12:00:00Z', integrity: 'rejected', reason: 'format' }, { file: FILE, bytes: 2048, createdAt: '2026-10-26T10:00:00Z', integrity: 'unverified', reason: null }], total: 2, truncated: false },
  browse: { context, archive, folder: FOLDER, entries: [{ path: 'mail/x/cur/1', bytes: 4, mode: 0o600 }, { path: 'notes.txt', bytes: 5, mode: 0o640 }, { path: 'public_html/app/config.php', bytes: 15, mode: 0o600 }, { path: 'public_html/index.html', bytes: 17, mode: 0o640 }] },
  preview: (destination: string, rows: unknown[]) => ({ context, archive, destination: { mode: destination, folder: destination === 'new-folder' ? FOLDER : null }, rows,
    counts: { restore: rows.filter((row: any) => row.action === 'restore' && row.exists !== 'yes').length, present: rows.filter((row: any) => row.action === 'restore' && row.exists === 'yes').length, refused: rows.filter((row: any) => row.action === 'refuse').length },
    quota: { limitMb: 'unlimited', plannedBytes: 32, fits: true }, writer: 'available', limits: {}, revision: REVISION }),
  restore: (results: any[]) => ({ context, archive, destination: { mode: 'new-folder', folder: FOLDER }, results, counts: Object.fromEntries(['restored', 'skipped-exists', 'failed', 'not-attempted'].map(state => [state, results.filter(row => row.result === state).length])),
    complete: !results.some(row => row.result === 'not-attempted'), verificationRequired: results.some(row => row.verificationRequired), revision: REVISION }),
}
const row = (path: string, extra: Record<string, unknown> = {}) => ({ path, destination: FOLDER + '/' + path, bytes: 17, action: 'restore', reason: null, exists: 'no', ...extra })
const result = (path: string, value: string, reason: string | null = null) => ({ path, destination: FOLDER + '/' + path, bytes: 17, result: value, reason, verificationRequired: false })
type Transport = (method: string, path: string, body?: any) => Promise<unknown>
const server = (overrides: Partial<Record<string, (body?: any) => unknown>> = {}): Transport => vi.fn(async (method: string, path: string, body?: any) => {
  const key = path === '/api/backups/files' ? 'accounts' : path === '/api/backups/files/alice' ? 'archives' : path.split('/').at(-1)!
  if (overrides[key]) return overrides[key]!(body)
  if (key === 'preview') return replies.preview(body.destination, body.paths.map((path: string) => row(path)))
  if (key === 'restore') return replies.restore(body.paths.map((path: string) => result(path, 'restored')))
  return (replies as Record<string, unknown>)[key]
})
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const mount = (locale: 'en' | 'ar' = 'en', canRead = true, canRestore = true, state = 'authorized') => {
  const view = renderWhmBackupFilesWorkspace({ locale, canRead, canRestore })
  document.body.innerHTML = `<section data-whm-detail-route="/whm/backups/files" data-capability-state="${state}">${view.main}${view.aside}</section>`
}
const boot = async (request?: Transport) => {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + WHM_BACKUP_FILES_CLIENT_BINDING)()()
  await tick()
}
const q = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const status = () => q('[data-backup-files-status]').textContent
const choose = async (username: string) => { const select = q<HTMLSelectElement>('[data-backup-files-account]'); select.value = username; select.dispatchEvent(new Event('change', { bubbles: true })); await tick() }
const click = async (element: Element) => { (element as HTMLElement).click(); await tick() }
const check = async (path: string) => { const box = q<HTMLInputElement>(`[data-backup-files-entries] input[value="${path}"]`); box.checked = !box.checked; box.dispatchEvent(new Event('change', { bubbles: true })); await tick() }
const openArchive = async (request: Transport) => { await boot(request); await choose('alice'); await click(q(`button[data-file="${FILE}"]`)) }
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; mount() })

describe('WHM restore files client', () => {
  it('lists accounts and archives, keeps rejected archives closed and browses a verified tree', async () => {
    const request = server()
    await boot(request)
    expect([...q<HTMLSelectElement>('[data-backup-files-account]').options].map(option => option.value)).toEqual(['', 'alice'])
    await choose('alice')
    expect(q(`button[data-file="${BAD}"]`).hasAttribute('disabled')).toBe(true)
    expect(q('[data-backup-files-archives]').textContent).toContain('Rejected: not gzip-compressed tar data')
    expect(q('[data-backup-files-steps] [aria-current]').getAttribute('data-step')).toBe('backup')
    await click(q(`button[data-file="${FILE}"]`))
    expect(request).toHaveBeenLastCalledWith('POST', '/api/backups/files/alice/browse', { file: FILE })
    expect(q('[data-backup-files-integrity]').textContent).toContain('Verified')
    expect(q('[data-backup-files-sha256] bdi').textContent).toBe(SHA)
    expect(q('[data-backup-files-folder]').textContent).toBe(FOLDER + '/')
    expect([...document.querySelectorAll('[data-backup-files-entries] input')].map(box => (box as HTMLInputElement).value)).toEqual(['mail', 'public_html', 'notes.txt'])
    await click(q('button[data-open="public_html"]'))
    expect(q('[data-backup-files-path]').textContent).toBe('/public_html')
    expect([...document.querySelectorAll('[data-backup-files-entries] input')].map(box => (box as HTMLInputElement).value)).toEqual(['public_html/app', 'public_html/index.html'])
    expect(q<HTMLButtonElement>('[data-backup-files-up]').disabled).toBe(false)
    await click(q('[data-backup-files-up]'))
    expect(q('[data-backup-files-path]').textContent).toBe('/')
  })
  it.each(['en', 'ar'] as const)('preserves the complete archive creation instant in %s without opening or restoring it', async locale => {
    const createdAt = '2026-10-26T10:11:12Z'
    const request = server({ archives: () => ({ ...replies.archives, archives: [{ ...replies.archives.archives[1]!, createdAt }], total: 1 }) })
    mount(locale, true, false); await boot(request); await choose('alice')
    expect(q('[data-backup-files-archives] tr:first-child td:first-child bdi[dir="ltr"]').textContent).toBe('2026-10-26 10:11 UTC')
    expect(request).toHaveBeenLastCalledWith('GET', '/api/backups/files/alice')
    expect(vi.mocked(request).mock.calls.every(([method]) => method === 'GET')).toBe(true)
    expect(q<HTMLButtonElement>('[data-backup-files-restore]').disabled).toBe(true)
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('reviews then restores the exact selection with the reviewed revision and reports each file', async () => {
    const request = server()
    await openArchive(request)
    await check('notes.txt'); await check('public_html')
    expect(q('[data-backup-files-selection]').textContent).toContain('2 of 500')
    await click(q('button[data-open="public_html"]'))
    expect(q<HTMLInputElement>('[data-backup-files-entries] input[value="public_html/index.html"]')).toMatchObject({ checked: true, disabled: true })
    await click(q('[data-backup-files-preview]'))
    expect(request).toHaveBeenLastCalledWith('POST', '/api/backups/files/alice/preview', { file: FILE, paths: ['notes.txt', 'public_html'], destination: 'new-folder' })
    expect(q('[data-backup-files-review]').textContent).toContain(FOLDER + '/notes.txt')
    expect(q('[data-backup-files-count-restore]').textContent).toBe('2')
    const restore = q<HTMLButtonElement>('[data-backup-files-restore]'), ack = q<HTMLInputElement>('[data-backup-files-ack]')
    expect(restore.disabled).toBe(true); expect(ack.disabled).toBe(false)
    ack.checked = true; ack.dispatchEvent(new Event('change', { bubbles: true }))
    expect(restore.disabled).toBe(false)
    await click(restore)
    expect(request).toHaveBeenLastCalledWith('POST', '/api/backups/files/alice/restore', { file: FILE, paths: ['notes.txt', 'public_html'], destination: 'new-folder', expectedRevision: REVISION })
    expect(q('[data-backup-files-count-restored]').textContent).toBe('2')
    expect(q('[data-backup-files-results]').textContent).toContain('Restored and verified')
    expect(q('[data-backup-files-steps] [aria-current]').getAttribute('data-step')).toBe('result')
    expect(status()).toContain('2 restored, 0 skipped, 0 failed, 0 not attempted.')
    expect(q<HTMLButtonElement>('[data-backup-files-continue]').hidden).toBe(true)
  })
  it('invalidates the review when the destination changes and shows present files as skipped', async () => {
    const request = server({ preview: body => replies.preview(body.destination, [row('notes.txt', { destination: 'notes.txt', exists: 'yes' }), row('mail/x/cur/1', { destination: 'mail/x/cur/1', action: 'refuse', reason: 'mail-preserved', exists: 'unchecked' })]) })
    await openArchive(request)
    await check('notes.txt'); await check('mail')
    const inPlace = q<HTMLInputElement>('input[value="in-place"]')
    inPlace.checked = true; inPlace.dispatchEvent(new Event('change', { bubbles: true }))
    await click(q('[data-backup-files-preview]'))
    expect(request).toHaveBeenLastCalledWith('POST', '/api/backups/files/alice/preview', { file: FILE, paths: ['mail', 'notes.txt'], destination: 'in-place' })
    expect(q('[data-backup-files-review]').textContent).toContain('Skip, already present')
    expect(q('[data-backup-files-review]').textContent).toContain('Not restored: mail data and settings are not restored in place')
    expect(q<HTMLInputElement>('[data-backup-files-ack]').disabled).toBe(true)
    const fresh = q<HTMLInputElement>('input[value="new-folder"]')
    fresh.checked = true; fresh.dispatchEvent(new Event('change', { bubbles: true }))
    expect(q('[data-backup-files-review]').textContent).toContain('No restore has been reviewed.')
  })
  it('offers to continue a restore stopped by the time budget', async () => {
    const request = server({ restore: () => replies.restore([result('notes.txt', 'restored'), result('public_html/index.html', 'not-attempted', 'time-budget')]) })
    await openArchive(request)
    await check('notes.txt'); await click(q('[data-backup-files-preview]'))
    const ack = q<HTMLInputElement>('[data-backup-files-ack]'); ack.checked = true; ack.dispatchEvent(new Event('change', { bubbles: true }))
    await click(q('[data-backup-files-restore]'))
    const more = q<HTMLButtonElement>('[data-backup-files-continue]')
    expect(more.hidden).toBe(false)
    expect(q('[data-backup-files-results]').textContent).toContain('not started within this request time limit')
    await click(more)
    expect((request as ReturnType<typeof vi.fn>).mock.calls.filter(call => call[1].endsWith('/restore'))).toHaveLength(2)
  })
  it('never treats an unverifiable reply or a refused restore as success', async () => {
    const request = server({ restore: () => ({ ...replies.restore([result('notes.txt', 'restored')]), revision: 'c'.repeat(64) }) })
    await openArchive(request)
    await check('notes.txt'); await click(q('[data-backup-files-preview]'))
    const ack = q<HTMLInputElement>('[data-backup-files-ack]'); ack.checked = true; ack.dispatchEvent(new Event('change', { bubbles: true }))
    await click(q('[data-backup-files-restore]'))
    expect(status()).toContain('could not be verified')
    expect(q('[data-backup-files-results]').textContent).toContain('No restore has run.')
    const conflict = server({ restore: () => Promise.reject(Object.assign(new Error('archive or selection changed'), { code: 'CONFLICT', details: {} })) })
    mount(); await openArchive(conflict)
    await check('notes.txt'); await click(q('[data-backup-files-preview]'))
    const again = q<HTMLInputElement>('[data-backup-files-ack]'); again.checked = true; again.dispatchEvent(new Event('change', { bubbles: true }))
    await click(q('[data-backup-files-restore]'))
    expect(status()).toContain('Review the restore again.')
    expect(q<HTMLButtonElement>('[data-backup-files-restore]').disabled).toBe(true)
  })
  it('lets a list-only reseller review but not restore, in Arabic', async () => {
    mount('ar', true, false)
    document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl'
    const request = server()
    await openArchive(request)
    expect(q('[data-backup-files-archives]').textContent).toContain('مرفوض: ليست بيانات tar مضغوطة بـ gzip')
    expect(q(`button[data-file="${FILE}"]`).getAttribute('aria-label')).toBe('فتح النسخة ' + FILE)
    expect(q('[data-backup-files-entries] input[value="notes.txt"]').getAttribute('aria-label')).toBe('تحديد notes.txt')
    await check('notes.txt'); await click(q('[data-backup-files-preview]'))
    expect(q<HTMLInputElement>('[data-backup-files-ack]').disabled).toBe(true)
    expect(q<HTMLButtonElement>('[data-backup-files-restore]').disabled).toBe(true)
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('stays inert when unavailable or without a session transport', async () => {
    mount('en', true, true, 'unavailable')
    const request = server()
    await boot(request)
    expect(request).not.toHaveBeenCalled()
    mount('en', false)
    await boot(request)
    expect(request).not.toHaveBeenCalled()
    expect(q<HTMLSelectElement>('[data-backup-files-account]').disabled).toBe(true)
    expect(WHM_BACKUP_FILES_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_BACKUP_FILES_CLIENT_BINDING).not.toContain('fetch(')
  })
})

describe('restore files reply contract', () => {
  it('binds replies to the requested account, archive and revision', () => {
    expect(() => readBackupFilesReply('archives', { ...replies.archives, context: { ...context, username: 'bob' } }, { username: 'alice' })).toThrow()
    expect(() => readBackupFilesReply('browse', replies.browse, { username: 'alice', file: BAD })).toThrow()
    expect(() => readBackupFilesReply('browse', { ...replies.browse, entries: [{ path: '../etc/passwd', bytes: 1 }] }, { username: 'alice', file: FILE })).toThrow()
    expect(() => readBackupFilesReply('preview', replies.preview('in-place', [row('a')]), { username: 'alice', file: FILE, destination: 'new-folder' })).toThrow()
    expect(() => readBackupFilesReply('preview', { ...replies.preview('new-folder', [row('a')]), counts: { restore: 0, present: 0, refused: 0 } }, { username: 'alice', file: FILE, destination: 'new-folder' })).toThrow()
    expect(() => readBackupFilesReply('restore', { ...replies.restore([result('a', 'restored')]), counts: { restored: 0, 'skipped-exists': 1, failed: 0, 'not-attempted': 0 } }, { username: 'alice', file: FILE, destination: 'new-folder', revision: REVISION })).toThrow()
    expect(readBackupFilesReply('restore', replies.restore([result('a', 'skipped-exists')]), { username: 'alice', file: FILE, destination: 'new-folder', revision: REVISION }).counts['skipped-exists']).toBe(1)
    expect(readBackupFilesReply('browse', { context, archive: { file: FILE, integrity: 'rejected', reason: 'unsafe' }, folder: FOLDER, entries: [] }, { username: 'alice', file: FILE }).archive).toEqual({ file: FILE, integrity: 'rejected', reason: 'unsafe', bytes: null, sha256: null })
  })
})
