// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmSurface } from './surfaces/xwhm.ts'
import { WHM_LOCAL_ARCHIVES_CLIENT_BINDING } from './whm-local-archives-client.ts'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'

const file = 'xpanel-backup-alice-20261026T100000Z.tar.gz'
const runId = '11111111-1111-4111-8111-111111111111'
const account = { id: 'a1', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test', planId: 'p1', ownerId: null, status: 'active' as const, suspendReason: null, contactEmail: '', ipv4: '192.0.2.1', ipv6: null, extraIps: [], shell: 'jailed' as const, createdAt: '2026-10-29T00:00:00Z' }
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
const mount = (options: { archives?: unknown[]; manage?: boolean; mutate?: (root: HTMLElement) => void; created?: unknown } = {}) => {
  document.body.innerHTML = renderWhmSurface({ locale: 'en', principal: { kind: 'root', id: 'root1', username: 'root' }, activeRoute: '/whm/backups', accounts: [account], catalog: [] })
  const root = document.querySelector<HTMLElement>('[data-account-backups]')!
  if (options.manage === false) root.dataset.backupManage = 'false'
  options.mutate?.(root)
  const request = vi.fn(async (method: string) => method === 'GET' ? { backups: options.archives ?? [{ file, bytes: 2048 }] } : options.created ?? { run: { id: runId, state: 'running' } })
  Object.assign(window, { xpanelSessionRequest: request })
  new Function('return ' + WHM_LOCAL_ARCHIVES_CLIENT_BINDING)()()
  return { root, request }
}
afterEach(() => { document.body.replaceChildren(); document.documentElement.lang = 'en'; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('local archive review entry', () => {
  it('connects the shared browser script to the guarded listing binding', () => {
    expect(BROWSER_REALTIME_SCRIPT).toContain('(' + WHM_LOCAL_ARCHIVES_CLIENT_BINDING + ')();')
  })
  it('opens a manual file-review journey and sends no restore POST on click', async () => {
    const { root, request } = mount(); await tick()
    const link = root.querySelector<HTMLAnchorElement>('[data-backup-files] a')!
    expect(link.getAttribute('href')).toBe('/whm/backups/files?lang=en')
    expect(link.textContent).toContain(file)
    expect(root.textContent).toContain('Choose an account to list its backups.')
    link.addEventListener('click', event => event.preventDefault()); link.click(); await tick()
    expect(request.mock.calls).toEqual([['GET', '/api/backups/accounts/alice']])
    expect(root.querySelector('[data-backup-files] button')).toBeNull()
  })
  it('keeps archive review in the current Arabic locale', async () => {
    document.documentElement.lang = 'ar'
    const { root } = mount(); await tick()
    expect(root.querySelector('a[data-xp-slot="review"]')?.getAttribute('href')).toBe('/whm/backups/files?lang=ar')
  })
  it.each([false, true])('sends nothing without root admission or its selected template (%s)', async missingTemplate => {
    const { root, request } = mount({ manage: missingTemplate, ...(missingTemplate ? { mutate: root => root.querySelector('template[data-xp-template="whm-local-archive-row"]')!.remove() } : {}) }); await tick()
    expect(request).not.toHaveBeenCalled()
    expect(root.querySelector<HTMLButtonElement>('[data-backup-create]')!.disabled).toBe(true)
  })
  it.each(['foreign', 'markup', 'duplicate'])('rejects a %s archive listing without trusting its filenames', async kind => {
    const row = { file, bytes: 2 }
    const { root } = mount({ archives: kind === 'foreign' ? [{ ...row, file: file.replace('alice', 'bob') }] : kind === 'markup' ? [{ ...row, file: '<img src=x onerror=alert(1)>' }] : [row, row] }); await tick()
    expect(root.querySelector('[data-backup-files]')!.children).toHaveLength(0)
    expect(root.querySelector('[data-backup-files] img')).toBeNull()
    expect(root.querySelector('[data-backup-status]')!.getAttribute('role')).toBe('alert')
  })
  it('starts only the explicit creation operation and keeps internal job identity out of visible copy', async () => {
    const { root, request } = mount(); await tick()
    root.querySelector<HTMLButtonElement>('[data-backup-create]')!.click(); await tick()
    expect(request.mock.calls).toEqual([['GET', '/api/backups/accounts/alice'], ['POST', '/api/backups/accounts/alice', { op: 'create' }]])
    expect(root.textContent).not.toContain(runId)
    expect(root.querySelector('[data-backup-status]')!.textContent).toContain('The backup job started at low priority.')
  })
  it('can read the archive list again on a single-account page after a job starts', async () => {
    const { root, request } = mount(); await tick()
    root.querySelector<HTMLButtonElement>('[data-backup-create]')!.click(); await tick()
    await vi.waitFor(() => expect(root.getAttribute('aria-busy')).toBe('false'))
    root.querySelector<HTMLButtonElement>('[data-backup-local-read]')!.click(); await tick()
    expect(request.mock.calls.filter(call => call[0] === 'GET')).toHaveLength(2)
    expect(request.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(1)
  })
  it('locks an unverified creation outcome without retrying or claiming success', async () => {
    const { root, request } = mount({ created: { ok: true } }); await tick()
    root.querySelector<HTMLButtonElement>('[data-backup-create]')!.click(); await tick()
    expect(root.querySelector('[data-backup-status]')!.textContent).toContain('outcome requires review')
    expect(root.querySelector<HTMLButtonElement>('[data-backup-create]')!.disabled).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
  })
})
