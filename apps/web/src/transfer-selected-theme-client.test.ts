// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import { translator } from './i18n.ts'
import { renderWhmDetailPage } from './board-port/approved-xwhm.ts'
import { renderAcctTransferServerWorkspace } from './board-port/acct-transfer-server.ts'
import { renderWhmBackupDestinationsWorkspace } from './board-port/whm-backup-destinations-workspace.ts'
import { renderV2TransferPage } from './themes/v2/pages/xwhm/lifecycle/transfers.ts'
import { renderV2BackupDestinationsPage } from './themes/v2/pages/xwhm/lifecycle/destinations.ts'
import { WHM_TRANSFER_CLIENT_BINDING } from './whm-transfer-client.ts'
import { ACCT_TRANSFER_CREDENTIALS_CLIENT_BINDING } from './acct-transfer-credentials-client.ts'
import { WHM_BACKUP_DESTINATIONS_CLIENT_BINDING } from './whm-backup-destinations-client.ts'

let testDom: EnvironmentReturn | undefined
beforeEach(async () => {
  testDom = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://whm.example.test/whm/transfers', runScripts: 'outside-only' } })
})
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`
const stamp = '2026-10-29T12:00:00.000Z'
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const mount = (html: string) => {
  document.documentElement.lang = 'en'
  document.body.innerHTML = html
  vi.stubGlobal('xpT', translator('en'))
  return document
}
afterEach(async () => {
  try {
    document.body.replaceChildren()
    delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
    vi.restoreAllMocks(); vi.unstubAllGlobals()
  } finally { await testDom?.teardown(globalThis); testDom = undefined }
})

const session = (observed = true) => ({ session: { id: id(1), actor: 'root', createdAt: stamp, updatedAt: stamp, state: 'completed', auth: { kind: 'ssh-key', host: 'source.example.test', port: 22, user: 'root', keyId: id(2), hostKeyFingerprint: 'SHA256:' + 'A'.repeat(43) }, source: observed ? { hostname: 'source.example.test', version: '1.4.2' } : null,
  inventory: observed ? { accounts: [{ username: 'alice', primaryDomain: 'alice.example.test', uid: 2020, plan: 'Gold', diskBytes: 64, databases: [], mailboxes: 2 }], plans: [{ name: 'Gold' }] } : null, selection: { accounts: ['alice'], plans: ['Gold'] }, conflicts: [], resolutions: {}, reviewDigest: null, progress: observed ? { alice: { phase: 'done', bytes: 64, totalBytes: 64 } } : {}, log: [], error: null }, revision: 'a'.repeat(64), review: observed ? { accounts: [{ source: 'alice', target: 'alice_restored', plan: 'Gold', domains: ['alice.example.test'], mailboxes: 2 }] } : null, digest: null,
  results: observed ? { alice: { home: { bytes: 64 }, databases: [], mailboxes: [], zones: [] } } : {}, running: false, stopRequested: false })
const transferHtml = (theme: 'classic' | 'v2') => theme === 'v2' ? renderV2TransferPage({ locale: 'en', canRead: true, canManage: true }) : renderWhmDetailPage({ activeRoute: '/whm/transfers', locale: 'en', principal: { kind: 'root', id: id(9), username: 'root' } })!
const boot = (binding: string, request: (method: string, path: string, body?: unknown) => Promise<unknown>, ask = vi.fn(async () => true)) => {
  Object.assign(window, { xpanelSessionRequest: request })
  new Function('return ' + binding)()(ask)
  return ask
}

describe('selected-theme transfer and destination controllers', () => {
  it.each(['classic', 'v2'] as const)('fills %s inventory and status using semantic hooks and its actual column count', async theme => {
    const doc = mount(transferHtml(theme) + '<p data-transfer-identities-observation id="foreign">foreign workspace</p>')
    const send = vi.fn(async (_method: string, _path: string) => ({ sessions: [session()], cpanelImports: [], capabilities: { discover: false, execute: false, cpanelImport: false, cpanelUploadMaxBytes: 0 } }))
    boot(WHM_TRANSFER_CLIENT_BINDING, send); await settle()
    const body = doc.querySelector('[data-transfer-inventory-rows]')!
    expect(body.querySelectorAll('tr')).toHaveLength(1)
    expect(body.querySelectorAll('td')).toHaveLength(theme === 'v2' ? 4 : 9)
    expect(body.textContent).toContain('alice.example.test')
    if (theme === 'v2') expect(body.textContent).toContain('2020')
    expect(doc.querySelector('[data-transfer-source-observation]')?.textContent).toContain('trusted server adapters')
    expect(doc.querySelector('[data-transfer-plan-observation]')?.textContent).toContain('authenticated inventory')
    expect(doc.querySelector('[data-transfer-identities-observation]')?.textContent).toContain('Authenticated source inventory')
    expect(doc.querySelector('#foreign')?.textContent).toBe('foreign workspace')
    expect(doc.querySelector('[data-transfer-review-results] tbody')?.textContent).toContain('alice_restored')
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })

  it.each(['classic', 'v2'] as const)('clears stale %s observations with a theme-owned empty row', async theme => {
    const doc = mount(transferHtml(theme)); let current = session()
    const send = vi.fn(async (_method: string, _path: string) => ({ sessions: [current], cpanelImports: [], capabilities: { discover: false, execute: false, cpanelImport: false, cpanelUploadMaxBytes: 0 } }))
    boot(WHM_TRANSFER_CLIENT_BINDING, send); await settle()
    expect(doc.querySelector('[data-transfer-progress-rows]')?.textContent).toContain('64')
    current = session(false); doc.querySelector<HTMLButtonElement>('[data-transfer-refresh]')!.click(); await settle()
    expect(doc.querySelector('[data-transfer-inventory-rows] td')?.getAttribute('colspan')).toBe(theme === 'v2' ? '4' : '9')
    expect(doc.querySelector('[data-transfer-progress-rows]')?.textContent).not.toContain('64')
    expect(doc.querySelector('[data-transfer-progress-state]')?.getAttribute('data-transfer-progress-state')).toBe('not-read')
  })

  it.each(['classic', 'v2'] as const)('preserves %s write-once token submission, confirmed readback and secret clearing', async theme => {
    const html = theme === 'v2' ? renderV2TransferPage({ locale: 'en', canRead: true, canManage: true, scope: 'server' }) : renderAcctTransferServerWorkspace({ locale: 'en', canManage: true })
    const doc = mount(html), token = 'xp_' + 'A'.repeat(43)
    const items: Array<{ id: string; label: string; kind: 'api-token'; fingerprint: string; createdAt: string; createdBy: string }> = []
    const send = vi.fn(async (method: string, _path: string, body?: unknown) => {
      if (method === 'POST') { items.push({ id: id(3), label: (body as { label: string }).label, kind: 'api-token', fingerprint: '1'.repeat(16), createdAt: stamp, createdBy: 'root' }); return { revision: 'b'.repeat(64), limit: 50, credentials: [...items], changed: id(3) } }
      return { revision: items.length ? 'b'.repeat(64) : 'a'.repeat(64), limit: 50, credentials: [...items] }
    })
    const ask = boot(ACCT_TRANSFER_CREDENTIALS_CLIENT_BINDING, send); await settle()
    doc.querySelector<HTMLInputElement>('[data-acct-transfer-credential-input="label"]')!.value = 'New source'
    doc.querySelector<HTMLInputElement>('[data-acct-transfer-credential-input="token"]')!.value = token
    doc.querySelector<HTMLFormElement>('[data-acct-transfer-credentials-form]')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); await settle()
    expect(ask).toHaveBeenCalledOnce()
    expect(send.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(1)
    expect(send.mock.calls.find(call => call[0] === 'POST')?.[2]).toEqual({ label: 'New source', token, expectedRevision: 'a'.repeat(64) })
    expect(doc.querySelector<HTMLInputElement>('[data-acct-transfer-credential-input="token"]')!.value).toBe('')
    expect(doc.querySelector('[data-acct-transfer-credentials-rows]')?.textContent).toContain('New source')
    expect(doc.querySelector('[data-acct-transfer-credentials-status]')?.getAttribute('data-state')).toBe('saved')
    expect(doc.body.textContent).not.toContain(token)
    expect(doc.querySelector('[data-acct-transfer-credentials-rows] button')?.className).toBe(theme === 'v2' ? 'v2-btn' : 'xp-btn')
  })

  it('does not read or enable V2 source credentials without explicit manage authority', async () => {
    const doc = mount(renderV2TransferPage({ locale: 'en', canRead: true, canManage: false, scope: 'server' }))
    const send = vi.fn(async () => ({})); boot(ACCT_TRANSFER_CREDENTIALS_CLIENT_BINDING, send); await settle()
    expect(send).not.toHaveBeenCalled()
    expect(doc.querySelector<HTMLButtonElement>('[data-acct-transfer-credential-save]')!.disabled).toBe(true)
    expect(doc.querySelector('[data-acct-transfer-credentials-form]')?.tagName).toBe('DIV')
  })

  it.each(['classic', 'v2'] as const)('fills %s destination actions without granting an unavailable remote test', async theme => {
    const html = theme === 'v2' ? renderV2BackupDestinationsPage({ locale: 'en', canRead: true, canManage: true }) : renderWhmBackupDestinationsWorkspace({ locale: 'en', canManage: true })
    const doc = mount(html)
    const destination = { id: id(4), name: '<remote>', kind: 'sftp', endpoint: 'sftp://backup.example.test', bucket: null, region: null, pathPrefix: '/tenant-backups', username: 'backup', retentionDays: 30, enabled: false, credentialRef: null, state: 'unavailable', effectiveActive: false, verification: null }
    const send = vi.fn(async (_method: string, _path: string) => ({ revision: 'a'.repeat(64), destinations: [destination], capabilities: { canTest: false, profiles: [] }, application: { nativeApplied: false, schedulerVerified: false } }))
    boot(WHM_BACKUP_DESTINATIONS_CLIENT_BINDING, send); await settle()
    expect(doc.querySelector('[data-destination-rows]')?.textContent).toContain('<remote>')
    expect(doc.querySelector('remote')).toBeNull()
    expect(doc.querySelector<HTMLButtonElement>('[data-destination-action="test"]')!.disabled).toBe(true)
    expect(doc.querySelector('[data-destination-action="edit"]')?.className).toBe(theme === 'v2' ? 'v2-btn' : 'xp-btn')
    expect(doc.querySelector('[data-destination-rows]')?.textContent).not.toContain(id(4))
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })
})
