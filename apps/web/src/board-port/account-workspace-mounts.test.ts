// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tools } from '@xpanel/catalog'
import type { Account, Domain } from '@xpanel/core'
import { renderBoardCanvas } from '../board-canvas.ts'
import { ACCOUNT_BACKUP_CLIENT_BINDING } from '../account-backup-client.ts'
import { renderApprovedXpanelWorkspace } from './approved-xpanel-workspaces.ts'
import type { ApprovedXpanelWorkspaceProps } from './approved-xpanel-workspaces.ts'

// Synthetic admission/catalog evidence exercises SSR composition, not native qualification.
const account = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alice', home: '/home/alice', uid: 20014, gid: 20014, status: 'active', primaryDomain: 'alice.example.test' } as Account
const domain = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', accountId: account.id, name: account.primaryDomain } as Domain
const props = (route: string, patch: Partial<ApprovedXpanelWorkspaceProps> = {}): ApprovedXpanelWorkspaceProps => ({
  route, locale: 'en', readOnly: false, account, domains: [domain], activeDomain: domain.name,
  visibility: { principal: { kind: 'user', id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', username: account.username, accountId: account.id } },
  catalog: tools.map(tool => ['backup', 'backup-restoration', 'cron-jobs', 'aapanel-url-rewrite'].includes(tool.id) ? { ...tool, status: 'verified' as const } : tool), ...patch,
})
const render = (input: ApprovedXpanelWorkspaceProps): HTMLElement => { document.body.innerHTML = renderApprovedXpanelWorkspace(input) ?? ''; return document.body }
afterEach(() => { document.body.textContent = ''; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; vi.restoreAllMocks() })

describe('approved account workspace functional mounts', () => {
  it('mounts the owner home-backup controller once and retains every approved full-backup card', () => {
    const root = render(props('/files/backup'))
    expect(root.querySelectorAll('[data-account-backup]')).toHaveLength(1)
    expect(root.querySelector<HTMLElement>('[data-account-backup]')!.dataset.accountBackupManage).toBe('true')
    for (const id of ['backup-wizard', 'backup-include', 'backup-databases', 'backup-destination', 'backup-summary', 'backup-progress', 'backup-restore', 'backup-diff-summary', 'backup-diff', 'backup-db-diff', 'backup-mail-diff', 'backup-mail-config-diff', 'backup-restore-review', 'backup-history', 'backup-safety', 'backup-location']) expect(root.querySelector('#panel-detail-' + id)).not.toBeNull()
    expect(root.querySelectorAll('[data-account-cron],[data-htaccess-workspace]')).toHaveLength(0)
  })
  it('keeps native qualification, owner identity and read-only backup admission gates', () => {
    let root = render(props('/files/backup', { catalog: tools }))
    expect(root.querySelector<HTMLElement>('[data-account-backup]')!.dataset.accountBackupManage).toBe('false')
    root = render(props('/files/backup', { visibility: { principal: { kind: 'user', id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', username: 'other', accountId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } } }))
    expect(root.querySelector('[data-account-backup]')).toBeNull()
    root = render(props('/files/backup', { readOnly: true }))
    expect(root.querySelector('[data-account-backup]')).toBeNull(); expect(root.querySelector('#panel-detail-backup-wizard')).not.toBeNull()
  })
  it.each(['en', 'ar'] as const)('deduplicates the %s backup canvas while preserving the complete detailed workflow', locale => {
    const nativeHtml = renderBoardCanvas('/files/backup', locale)
    expect(nativeHtml).toContain('id="backup-include"')
    const native = document.createElement('div'); native.innerHTML = nativeHtml
    const nativeControls = [...native.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('button,input,select,textarea')]
    expect(nativeControls.length).toBeGreaterThan(0)
    expect(nativeControls.every(control => control.disabled && control.dataset.wiring === 'soon')).toBe(true)
    expect(native.querySelectorAll('form,[data-account-backup],[data-account-backups],[data-action]')).toHaveLength(0)
    const root = render(props('/files/backup', { locale, nativeHtml }))
    expect(root.querySelectorAll('h1')).toHaveLength(1)
    expect(root.querySelectorAll('[data-account-backup]')).toHaveLength(1)
    expect(root.querySelector('#backup-include')).toBeNull()
    for (const id of ['backup-wizard', 'backup-include', 'backup-databases', 'backup-destination', 'backup-summary', 'backup-progress', 'backup-restore', 'backup-diff-summary', 'backup-diff', 'backup-db-diff', 'backup-mail-diff', 'backup-mail-config-diff', 'backup-restore-review', 'backup-history', 'backup-safety', 'backup-location']) expect(root.querySelectorAll('#panel-detail-' + id)).toHaveLength(1)
    for (const selector of ['[data-account-backup-create]', '[data-account-backup-refresh]', '[data-account-backup-differences]', '[data-account-backup-confirmation]', '[data-account-backup-csv]']) expect(root.querySelector(selector)).not.toBeNull()
    const heading = root.querySelector<HTMLHeadingElement>('h2#panel-detail-backup-destination')!
    expect(root.querySelectorAll('#panel-detail-backup-destination')).toHaveLength(1)
    const fallback = heading.closest('section.xp-panel-detail__card')!
    expect(fallback).not.toBeNull()
    expect(fallback.getAttribute('aria-labelledby')).toBe(heading.id)
    expect(fallback.querySelectorAll('input,select,button').length).toBeGreaterThan(0)
    expect([...fallback.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')].every(control => control.disabled)).toBe(true)
  })
  it.each(['en', 'ar'] as const)('retains the %s shared home archive binding, confirmations, readback and recovery path', async locale => {
    const root = render(props('/files/backup', { locale, nativeHtml: renderBoardCanvas('/files/backup', locale) }))
    const file = 'xpanel-backup-alice-20261026T100000Z.tar.gz', created = 'xpanel-backup-alice-20261026T100001Z-abcdef012345.tar.gz', recovery = 'xpanel-backup-alice-20261026T100002Z-fedcba543210.tar.gz'
    const context = { accountId: account.id, username: account.username, scope: 'home', mailPreserved: true, maxBytes: 2 * 1024 * 1024 * 1024 }
    const archives = [{ file, bytes: 123 }]
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path === '/api/account/backups') return { context, backups: [...archives] }
      if (method === 'POST' && path === '/api/account/backups/' + file + '/preview') {
        expect(body).toEqual({})
        return { context, preview: { file, bytes: 123, scope: 'home', mailPreserved: true, revision: 'a'.repeat(64), archiveSha256: 'b'.repeat(64), rows: [{ path: 'public_html/saved.txt', state: 'replace', archiveBytes: 3, currentBytes: 2 }], counts: { add: 0, replace: 1, unchanged: 0, keep: 0, 'preserve-mail': 0 } } }
      }
      if (method === 'POST' && path === '/api/account/backups') { expect(body).toEqual({}); archives.push({ file: created, bytes: 120 }); return { context, backup: { file: created, bytes: 120 } } }
      if (method === 'POST' && path === '/api/account/backups/' + file + '/restore') {
        expect(body).toEqual({ expectedRevision: 'a'.repeat(64), confirmation: account.username }); archives.push({ file: recovery, bytes: 90 })
        return { context, backup: { file, scope: 'home', mailPreserved: true, contentReadback: 'matched', recovery: { file: recovery, bytes: 90 } } }
      }
      throw new Error('unexpected_archive_transport')
    })
    const ask = vi.fn(async () => false)
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
    ;(new Function('return ' + ACCOUNT_BACKUP_CLIENT_BINDING)() as (confirm: unknown) => void)(ask)
    const get = <T extends HTMLElement>(key: string): T => root.querySelector<T>('[data-account-backup-' + key + ']')!
    const state = async (value: string): Promise<void> => { await vi.waitFor(() => expect(get('status').dataset.state).toBe(value)) }
    await state('read')
    get<HTMLButtonElement>('create').click(); await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1))
    expect(request).toHaveBeenCalledTimes(1)
    ask.mockResolvedValue(true); get<HTMLButtonElement>('create').click(); await state('created')
    expect(get<HTMLAnchorElement>('download').getAttribute('href')).toBe('/api/account/backups/' + created + '/download')
    const select = get<HTMLSelectElement>('select'); select.value = file; select.dispatchEvent(new Event('change'))
    get<HTMLButtonElement>('preview').click(); await state('reviewed')
    expect(get('differences').textContent).toContain('public_html/saved.txt')
    expect(get<HTMLAnchorElement>('csv').getAttribute('href')).toBe('/api/account/backups/' + file + '/preview.csv?revision=' + 'a'.repeat(64))
    expect(get<HTMLButtonElement>('restore').disabled).toBe(true)
    get<HTMLInputElement>('confirmation').value = account.username; get('confirmation').dispatchEvent(new Event('input'))
    get<HTMLInputElement>('ack').checked = true; get('ack').dispatchEvent(new Event('change'))
    expect(get<HTMLButtonElement>('restore').disabled).toBe(false)
    ask.mockResolvedValue(false); get<HTMLButtonElement>('restore').click(); await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(3))
    expect(request.mock.calls.filter(call => call[1].endsWith('/restore'))).toHaveLength(0)
    ask.mockResolvedValue(true); get<HTMLButtonElement>('restore').click(); await state('restored')
    expect(get('status').textContent).toContain(recovery)
    expect(get('archives').textContent).toContain(recovery)
    expect(request.mock.calls.map(call => [call[0], call[1]])).toEqual([['GET', '/api/account/backups'], ['POST', '/api/account/backups'], ['GET', '/api/account/backups'], ['POST', '/api/account/backups/' + file + '/preview'], ['POST', '/api/account/backups/' + file + '/restore'], ['GET', '/api/account/backups']])
    expect(root.querySelectorAll('[data-account-backup]')).toHaveLength(1)
  })
  it('preserves the saved full cron mount and its unavailable state without duplicate controllers', () => {
    let root = render(props('/advanced/cron'))
    expect(root.querySelectorAll('[data-account-cron]')).toHaveLength(1)
    expect(root.querySelector<HTMLElement>('[data-account-cron]')!.dataset.cronManage).toBe('true')
    expect(root.querySelectorAll('.xp-account-cron__card')).toHaveLength(5)
    expect(root.querySelector('[data-cron-preset]')).not.toBeNull(); expect(root.querySelector('[data-cron-preview]')).not.toBeNull()
    root = render(props('/advanced/cron', { readOnly: true }))
    expect(root.querySelector<HTMLElement>('[data-account-cron]')!.dataset.cronManage).toBe('false')
    expect(root.querySelector<HTMLButtonElement>('[data-cron-save]')!.disabled).toBe(true)
  })
  it('preserves the saved domain-pinned htaccess mount and compatibility/recovery components', () => {
    let root = render(props('/software/htaccess'))
    expect(root.querySelectorAll('[data-htaccess-workspace]')).toHaveLength(1)
    expect(root.querySelector<HTMLElement>('[data-htaccess-workspace]')!.dataset.htaccessManage).toBe('true')
    for (const selector of ['[data-htaccess-php-rows]', '[data-htaccess-php-before]', '[data-htaccess-php-after]', '[data-htaccess-undo-migration]']) expect(root.querySelector(selector)).not.toBeNull()
    root = render(props('/software/htaccess', { catalog: tools }))
    expect(root.querySelector<HTMLElement>('[data-htaccess-workspace]')!.dataset.htaccessManage).toBe('false')
  })
})
