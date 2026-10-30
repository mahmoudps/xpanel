// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import { translator } from './i18n.ts'
import { renderWhmBackupFilesWorkspace } from './board-port/whm-backup-files-workspace.ts'
import { renderV2WhmRestoreFilesPage } from './themes/v2/pages/xwhm/recovery-tools/restore.ts'
import { WHM_BACKUP_FILES_CLIENT_BINDING } from './whm-backup-files-client.ts'

let environment: EnvironmentReturn | undefined
beforeEach(async () => {
  environment = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://whm.example.test/whm/backups/files', runScripts: 'outside-only' } })
  vi.stubGlobal('xpT', translator('en'))
})
afterEach(async () => {
  try { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; vi.unstubAllGlobals() }
  finally { await environment?.teardown(globalThis); environment = undefined }
})
const file = 'xpanel-backup-alice-20261026T100000Z.tar.gz'
const folder = 'restored-20261026T100000Z'
const revision = 'a'.repeat(64), sha256 = 'b'.repeat(64)
const context = { username: 'alice', accountId: 'account-a' }
const archive = { file, integrity: 'verified', sha256, bytes: 17 }
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const html = (theme: 'classic' | 'v2', canRead = true, canRestore = true) => {
  if (theme === 'v2') return renderV2WhmRestoreFilesPage({ locale: 'en' }, { canRead, canManage: canRestore })
  const view = renderWhmBackupFilesWorkspace({ locale: 'en', canRead, canRestore })
  return view.main + view.aside
}
const get = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const boot = (send: (method: string, path: string, body?: unknown) => Promise<unknown>) => {
  Object.assign(window, { xpanelSessionRequest: send })
  new Function('return ' + WHM_BACKUP_FILES_CLIENT_BINDING)()()
}
const sendFixture = () => vi.fn(async (_method: string, path: string, body?: unknown) => {
  if (path === '/api/backups/files') return { accounts: [{ username: 'alice', primaryDomain: 'alice.example.test' }] }
  if (path === '/api/backups/files/alice') return { context, archives: [{ file, createdAt: '2026-10-26T10:00:00Z', integrity: 'unverified', bytes: 17, reason: null }], total: 1, truncated: false }
  if (path.endsWith('/browse')) return { context, archive, folder, entries: [{ path: 'public_html/index.html', bytes: 17 }] }
  if (path.endsWith('/preview')) return { context, archive, destination: { mode: 'new-folder', folder }, revision,
    rows: [{ path: 'public_html', destination: folder + '/public_html', bytes: 17, action: 'restore', exists: 'no', reason: null }],
    counts: { restore: 1, present: 0, refused: 0 }, quota: { limitMb: 'unlimited', plannedBytes: 17, fits: true }, writer: 'available' }
  if (path.endsWith('/restore')) return { context, archive, destination: { mode: 'new-folder', folder }, revision,
    results: [{ path: 'public_html/index.html', destination: folder + '/public_html/index.html', bytes: 17, result: 'restored', reason: null, verificationRequired: false }],
    counts: { restored: 1, 'skipped-exists': 0, failed: 0, 'not-attempted': 0 }, complete: true, verificationRequired: false }
  throw new Error('unexpected_request:' + path + ':' + JSON.stringify(body))
})

describe('selected-theme backup-file controller', () => {
  it.each(['classic', 'v2'] as const)('executes the serialized %s view through actual review and revision-bound restore', async theme => {
    document.body.innerHTML = html(theme)
    const send = sendFixture(); boot(send); await tick()
    get<HTMLSelectElement>('[data-backup-files-account]').value = 'alice'
    get('[data-backup-files-account]').dispatchEvent(new Event('change')); await tick()
    const row = get('[data-backup-files-archives] tr')
    expect(row.querySelectorAll('td')).toHaveLength(5)
    expect(row.querySelector('[data-xp-slot="file"]')?.textContent).toBe(file)
    expect(get('[data-backup-files-archives] button').classList.contains(theme === 'v2' ? 'v2-btn' : 'xp-btn')).toBe(true)
    get<HTMLButtonElement>('[data-backup-files-archives] button').click(); await tick()
    const box = get<HTMLInputElement>('[data-backup-files-entries] input')
    expect(box.value).toBe('public_html'); expect(box.disabled).toBe(false)
    box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }))
    get<HTMLButtonElement>('[data-backup-files-preview]').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/backups/files/alice/preview', { file, paths: ['public_html'], destination: 'new-folder' })
    expect(get('[data-backup-files-review] [data-xp-slot="destination"]').textContent).toBe(folder + '/public_html')
    expect(get<HTMLButtonElement>('[data-backup-files-restore]').disabled).toBe(true)
    const ack = get<HTMLInputElement>('[data-backup-files-ack]'); ack.checked = true; ack.dispatchEvent(new Event('change'))
    get<HTMLButtonElement>('[data-backup-files-restore]').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/backups/files/alice/restore', { file, paths: ['public_html'], destination: 'new-folder', expectedRevision: revision })
    expect(get('[data-backup-files-results] [data-result]').getAttribute('data-result')).toBe('restored')
    expect(get('[data-backup-files-results] [data-xp-slot="path"]').textContent).toBe('public_html/index.html')
    expect(get('[data-backup-files-results] [data-xp-slot="path"]').getAttribute('dir')).toBe('ltr')
  })

  it.each(['classic', 'v2'] as const)('fails closed before requests for missing, duplicated or incomplete %s templates', async theme => {
    for (const defect of ['missing', 'duplicate', 'slot'] as const) {
      document.body.innerHTML = html(theme)
      const template = get<HTMLTemplateElement>('template[data-xp-template="backup-files-result"]')
      if (defect === 'missing') template.remove()
      else if (defect === 'duplicate') template.after(template.cloneNode(true))
      else template.content.querySelector('[data-xp-slot="destination"]')!.removeAttribute('data-xp-slot')
      const send = sendFixture(); boot(send); await tick()
      expect(send).not.toHaveBeenCalled()
      expect(get('[data-backup-files-status]').getAttribute('data-state')).toBe('unavailable')
      expect([...document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')].every(control => control.disabled)).toBe(true)
    }
  })

  it.each(['classic', 'v2'] as const)('preserves the %s native admission boundary and initially disabled controls', async theme => {
    document.body.innerHTML = html(theme, false, false)
    expect([...document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')].every(control => control.disabled)).toBe(true)
    const send = sendFixture(); boot(send); await tick()
    expect(send).not.toHaveBeenCalled()
  })
})
