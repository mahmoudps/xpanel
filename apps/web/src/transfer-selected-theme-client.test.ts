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
    const send = vi.fn(async (_method: string, _path: string) => _path === '/api/transfers/credentials' ? { credentials: [] } : ({ sessions: [session()], cpanelImports: [], capabilities: { discover: false, execute: false, cpanelImport: false, cpanelUploadMaxBytes: 0 } }))
    boot(WHM_TRANSFER_CLIENT_BINDING, send); await settle()
    const body = doc.querySelector('[data-transfer-inventory-rows]')!
    expect(body.querySelectorAll('tr')).toHaveLength(1)
    expect(body.querySelectorAll('td')).toHaveLength(theme === 'v2' ? 8 : 9)
    expect(body.textContent).toContain('alice.example.test')
    expect(body.textContent).toContain('Gold')
    expect(body.textContent).toContain('64')
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
    const send = vi.fn(async (_method: string, _path: string) => _path === '/api/transfers/credentials' ? { credentials: [] } : ({ sessions: [current], cpanelImports: [], capabilities: { discover: false, execute: false, cpanelImport: false, cpanelUploadMaxBytes: 0 } }))
    boot(WHM_TRANSFER_CLIENT_BINDING, send); await settle()
    expect(doc.querySelector('[data-transfer-progress-rows]')?.textContent).toContain('64')
    current = session(false); doc.querySelector<HTMLButtonElement>('[data-transfer-refresh]')!.click(); await settle()
    expect(doc.querySelector('[data-transfer-inventory-rows] td')?.getAttribute('colspan')).toBe(theme === 'v2' ? '8' : '9')
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

const transferCapabilities = { discover: false, execute: false, cpanelImport: false, cpanelUploadMaxBytes: 0 }
const comparisonSession = () => {
  const current = session()
  return { ...current, session: { ...current.session, state: 'inventoried', inventory: { accounts: [
    { username: 'alice', primaryDomain: 'alice.example.test', uid: 2020, plan: 'Gold', diskBytes: 1500, databases: [{ name: 'alice_db' }], mailboxes: 2 },
    { username: 'bob', primaryDomain: 'bob.example.test', uid: 3030, plan: 'Silver', diskBytes: 0, databases: [], mailboxes: 0 },
  ], plans: [{ name: 'Gold' }] }, selection: { accounts: ['alice'], plans: ['Gold'] } } }
}
const transferTemplate = (name: string) => document.querySelector<HTMLTemplateElement>('template[data-xp-template="' + name + '"]')!
const transferState = () => document.querySelector<HTMLElement>('[data-transfer-status]')!

describe('approved transfer comparison and finite records', () => {
  it.each(['en', 'ar'] as const)('retains %s eight columns, observed values, technical context and one existing selection per account', async locale => {
    mount(renderV2TransferPage({ locale, canRead: true, canManage: true }))
    document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'; vi.stubGlobal('xpT', translator(locale))
    const send = vi.fn(async (_method: string, _path: string) => _path === '/api/transfers/credentials' ? { credentials: [] } : ({ sessions: [comparisonSession()], cpanelImports: [], capabilities: transferCapabilities }))
    boot(WHM_TRANSFER_CLIENT_BINDING, send); await vi.waitFor(() => expect(transferState().dataset.state).toBe('read'))
    const body = document.querySelector<HTMLTableSectionElement>('[data-transfer-inventory-rows]')!
    expect(body.closest('table')!.tHead!.rows[0]!.cells).toHaveLength(8)
    expect([...body.rows].every(row => row.cells.length === 8)).toBe(true)
    expect(body).toBe(document.querySelector('[data-transfer-accounts]'))
    expect(body.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
    expect(body.rows[0]!.cells[1]!.textContent).toContain('alice.example.test'); expect(body.rows[0]!.cells[1]!.textContent).toContain('2020')
    expect(body.rows[0]!.cells[2]!.textContent).toBe('Gold'); expect(body.rows[0]!.cells[3]!.textContent).toBe('\u20661.46\u00a0KiB\u2069')
    expect(body.rows[0]!.cells[4]!.textContent).toBe('1'); expect(body.rows[0]!.cells[5]!.textContent).toBe('2')
    expect(body.rows[1]!.cells[3]!.textContent).toBe('\u20660\u00a0B\u2069'); expect(body.rows[1]!.cells[4]!.textContent).toBe('0')
    const all = document.querySelector<HTMLInputElement>('[data-transfer-select-all]')!
    expect(all.closest('tbody')).toBeNull(); expect(all.indeterminate).toBe(true)
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    expect(send.mock.calls).toEqual([['GET', '/api/transfers/sessions'], ['GET', '/api/transfers/credentials']])
  })

  it('uses Select all without transport, then saves exactly the existing account and plan selection with its captured revision', { tags: ['slow', 'journey'] }, async () => {
    mount(transferHtml('v2')); let current = comparisonSession()
    const send = vi.fn(async (method: string, _path: string, body?: unknown) => {
      if (method === 'GET' && _path === '/api/transfers/credentials') return { credentials: [] }
      if (method === 'PATCH') { const value = body as { accounts: string[]; plans: string[] }; current = { ...current, revision: 'b'.repeat(64), session: { ...current.session, state: 'selected', selection: { accounts: value.accounts, plans: value.plans } } }; return current }
      return { sessions: [current], cpanelImports: [], capabilities: transferCapabilities }
    })
    const ask = boot(WHM_TRANSFER_CLIENT_BINDING, send); await vi.waitFor(() => expect(transferState().dataset.state).toBe('read'))
    document.querySelector<HTMLInputElement>('[data-transfer-select-all]')!.click()
    expect([...document.querySelectorAll<HTMLInputElement>('[data-transfer-accounts] input:checked')].map(input => input.value)).toEqual(['alice', 'bob'])
    expect(send.mock.calls).toEqual([['GET', '/api/transfers/sessions'], ['GET', '/api/transfers/credentials']]); expect(ask).not.toHaveBeenCalled()
    document.querySelector<HTMLButtonElement>('[data-transfer-select]')!.click()
    await vi.waitFor(() => expect(transferState().dataset.state).toBe('saved'))
    expect(send.mock.calls.filter(call => call[0] !== 'GET')).toEqual([['PATCH', '/api/transfers/sessions/' + id(1), { accounts: ['alice', 'bob'], plans: ['Gold'], action: 'select', expectedRevision: 'a'.repeat(64) }]])
    expect(ask).toHaveBeenCalledOnce()
  })

  it('opens the existing conflict editor from its owning row without issuing a mutation', async () => {
    mount(transferHtml('v2')); const original = comparisonSession()
    const current = { ...original, session: { ...original.session, state: 'selected', conflicts: [
      { id: id(4), kind: 'username', subject: 'alice', choices: ['rename', 'skip'] },
      { id: id(5), kind: 'domain', subject: 'bob.example.test', choices: ['drop-domain', 'skip'] },
    ] } }
    const send = vi.fn(async (_method: string, _path: string) => _path === '/api/transfers/credentials' ? { credentials: [] } : ({ sessions: [current], cpanelImports: [], capabilities: transferCapabilities }))
    boot(WHM_TRANSFER_CLIENT_BINDING, send); await vi.waitFor(() => expect(transferState().dataset.state).toBe('read'))
    const bob = document.querySelector<HTMLTableSectionElement>('[data-transfer-inventory-rows]')!.rows[1]!
    expect(bob.cells[6]!.textContent).toContain('Domain')
    bob.querySelector<HTMLButtonElement>('[data-xp-action="resolve"]')!.click()
    const conflict = document.querySelector<HTMLSelectElement>('[data-transfer-conflict]')!, resolution = document.querySelector<HTMLSelectElement>('[data-transfer-resolution]')!
    expect(conflict.value).toBe(id(5)); expect([...resolution.options].map(option => option.value)).toEqual(['drop-domain', 'skip'])
    expect(document.activeElement).toBe(resolution); expect(send.mock.calls).toEqual([['GET', '/api/transfers/sessions'], ['GET', '/api/transfers/credentials']])
  })

  it('keeps whole-server selection checked and uneditable without duplicating account controls', async () => {
    mount(renderV2TransferPage({ locale: 'en', canRead: true, canManage: true, scope: 'server' }))
    const send = vi.fn(async (_method: string, path: string) => path.endsWith('/credentials') ? { credentials: [] } : { sessions: [comparisonSession()], cpanelImports: [], capabilities: transferCapabilities })
    boot(WHM_TRANSFER_CLIENT_BINDING, send); await vi.waitFor(() => expect(transferState().dataset.state).toBe('read'))
    const choices = [...document.querySelectorAll<HTMLInputElement>('[data-transfer-accounts] input')]
    expect(choices).toHaveLength(2); expect(choices.every(input => input.checked && input.disabled)).toBe(true)
    const all = document.querySelector<HTMLInputElement>('[data-transfer-select-all]')!; expect(all.disabled).toBe(true); all.click()
    choices[0]!.click(); expect(choices.every(input => input.checked)).toBe(true)
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })

  it('shows unknown source facts explicitly and does not infer destination identity from the observed source UID', async () => {
    mount(transferHtml('v2')); const original = comparisonSession()
    const current = { ...original, session: { ...original.session, inventory: { ...original.session.inventory, accounts: [{ username: 'alice', primaryDomain: 'alice.example.test', uid: 2020, plan: null, diskBytes: -1, databases: null, mailboxes: '2' }] } } }
    const send = vi.fn(async (_method: string, _path: string) => _path === '/api/transfers/credentials' ? { credentials: [] } : ({ sessions: [current], cpanelImports: [], capabilities: transferCapabilities }))
    boot(WHM_TRANSFER_CLIENT_BINDING, send); await vi.waitFor(() => expect(transferState().dataset.state).toBe('read'))
    const row = document.querySelector<HTMLTableSectionElement>('[data-transfer-inventory-rows]')!.rows[0]!
    for (const column of [2, 3, 4, 5, 6]) expect(row.cells[column]!.textContent).toBe('Not read')
    expect(row.cells[1]!.textContent).toContain('Source UID'); expect(row.cells[1]!.textContent).toContain('2020')
    expect(row.textContent).not.toContain('xpanel-2020.slice'); expect(row.querySelector<HTMLButtonElement>('[data-xp-action="resolve"]')!.disabled).toBe(true)
  })

  it.each(['classic', 'v2'] as const)('validates every finite %s record, its typed slots and its owner before any startup GET', { tags: ['slow'] }, theme => {
    const html = transferHtml(theme)
    mount(html); const names = [...document.querySelectorAll<HTMLTemplateElement>('[data-transfer-workspace] template[data-xp-template]')].map(template => template.dataset.xpTemplate!)
    expect(names).toHaveLength(26)
    for (const name of names) for (const corruption of ['missing', 'duplicate', 'tag', 'borrowed'] as const) {
      mount(html); const template = transferTemplate(name)
      if (corruption === 'missing') template.remove()
      if (corruption === 'duplicate') template.after(template.cloneNode(true))
      if (corruption === 'tag') { const slot = template.content.querySelector<HTMLElement>('[data-xp-slot]')!, wrong = document.createElement(slot.tagName === 'SPAN' ? 'code' : 'span'); wrong.dataset.xpSlot = slot.dataset.xpSlot; slot.replaceWith(wrong) }
      if (corruption === 'borrowed') { const nested = document.createElement('section'); nested.dataset.transferWorkspace = ''; nested.dataset.transferBound = 'true'; template.after(nested); nested.append(template) }
      const send = vi.fn(async () => ({})); boot(WHM_TRANSFER_CLIENT_BINDING, send)
      expect(send, name + ':' + corruption).not.toHaveBeenCalled(); expect(transferState().dataset.state).toBe('unavailable')
      expect([...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('[data-transfer-workspace] input,[data-transfer-workspace] select,[data-transfer-workspace] button')].every(control => control.disabled)).toBe(true)
    }
  })

  it.each(['classic', 'v2'] as const)('refuses same-width but wrong-record %s fields rather than accepting the union of every template key', theme => {
    mount(transferHtml(theme)); transferTemplate('transfer-archive-summary-row').content.replaceChildren(transferTemplate('transfer-archive-conflicts-row').content.cloneNode(true))
    const send = vi.fn(async () => ({})); boot(WHM_TRANSFER_CLIENT_BINDING, send)
    expect(send).not.toHaveBeenCalled(); expect(transferState().dataset.state).toBe('unavailable')
  })

  it.each(['classic', 'v2'] as const)('demotes %s on fulfilled and rejected late reads without painting or enabling native controls', async theme => {
    for (const rejectRead of [false, true]) {
      mount(transferHtml(theme)); let finish!: (value: unknown) => void, fail!: (error: unknown) => void
      const send = vi.fn(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
      boot(WHM_TRANSFER_CLIENT_BINDING, send); expect(send).toHaveBeenCalledOnce(); transferTemplate('transfer-archive-conflicts-row').remove()
      if (rejectRead) fail(new Error('read unavailable')); else finish({ sessions: [session()], cpanelImports: [], capabilities: transferCapabilities })
      await vi.waitFor(() => expect(transferState().dataset.state).toBe('unavailable'))
      expect(document.querySelector('[data-transfer-inventory-rows]')?.textContent).not.toContain('alice.example.test')
      expect(send).toHaveBeenCalledOnce()
      expect([...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('[data-transfer-workspace] input,[data-transfer-workspace] select,[data-transfer-workspace] button')].every(control => control.disabled)).toBe(true)
    }
  })

  for (const theme of ['classic', 'v2'] as const) it(`sends no ${theme} selection mutation when confirmation loses its template or authority`, { tags: theme === 'v2' ? ['slow'] : [] }, async () => {
    for (const deny of ['template', 'authority']) {
      mount(transferHtml(theme)); let confirm!: (value: boolean) => void
      const ask = vi.fn(() => new Promise<boolean>(resolve => { confirm = resolve }))
      const send = vi.fn(async (_method: string, _path: string) => _path === '/api/transfers/credentials' ? { credentials: [] } : ({ sessions: [comparisonSession()], cpanelImports: [], capabilities: transferCapabilities }))
      boot(WHM_TRANSFER_CLIENT_BINDING, send, ask); await vi.waitFor(() => expect(transferState().dataset.state).toBe('read'))
      const initialReadCalls = send.mock.calls.length
      expect(send.mock.calls).toEqual([['GET', '/api/transfers/sessions'], ['GET', '/api/transfers/credentials']])
      document.querySelector<HTMLButtonElement>('[data-transfer-select]')!.click(); await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce())
      if (deny === 'template') transferTemplate('transfer-review-row').remove(); else document.querySelector<HTMLElement>('[data-transfer-workspace]')!.dataset.readonly = 'true'
      confirm(true); await vi.waitFor(() => expect(transferState().dataset.state).toBe('unavailable'))
      expect(send).toHaveBeenCalledTimes(initialReadCalls)
      expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
    }
  })

  it('keeps an already sent write uncertain when its template contract disappears before acknowledgement', async () => {
    mount(transferHtml('v2')); let acknowledge!: (value: unknown) => void
    const current = comparisonSession(), send = vi.fn((method: string, path: string) => method === 'GET' ? Promise.resolve(path === '/api/transfers/credentials' ? { credentials: [] } : { sessions: [current], cpanelImports: [], capabilities: transferCapabilities }) : new Promise(resolve => { acknowledge = resolve }))
    boot(WHM_TRANSFER_CLIENT_BINDING, send); await vi.waitFor(() => expect(transferState().dataset.state).toBe('read'))
    document.querySelector<HTMLButtonElement>('[data-transfer-select]')!.click(); await vi.waitFor(() => expect(send.mock.calls.some(call => call[0] === 'PATCH')).toBe(true))
    transferTemplate('transfer-review-row').remove(); acknowledge(current)
    await vi.waitFor(() => expect(transferState().dataset.state).toBe('uncertain'))
    expect(send.mock.calls.filter(call => call[0] === 'GET')).toEqual([['GET', '/api/transfers/sessions'], ['GET', '/api/transfers/credentials']]); expect(send.mock.calls.filter(call => call[0] === 'PATCH')).toHaveLength(1)
    expect(document.querySelector<HTMLButtonElement>('[data-transfer-select]')!.disabled).toBe(true)
  })
})


describe('V2 named source credential refresh admission', () => {
  it.each(['accounts', 'server'] as const)('reads and refreshes named credentials in the %s workspace without a mutation', { tags: ['slow'] }, async scope => {
    mount(renderV2TransferPage({ locale: 'en', canRead: true, canManage: true, scope }))
    const root = document.querySelector<HTMLElement>('[data-transfer-workspace]')
    const credential = document.querySelector<HTMLSelectElement>('[data-transfer-credential]')
    const refresh = document.querySelector<HTMLButtonElement>('[data-transfer-refresh]')
    if (!root || !credential || !refresh) throw new Error('Missing actual transfer controls')
    expect(root.dataset.transferCredentials).toBe('read')
    let label = 'Named source'
    const send = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/api/transfers/credentials') return { credentials: [{ id: id(7), kind: 'api-token', label, fingerprint: '1'.repeat(16) }] }
      if (method === 'GET' && path === '/api/transfers/sessions') return { sessions: [comparisonSession()], cpanelImports: [], capabilities: transferCapabilities }
      throw new Error('Unexpected transfer request')
    })
    const ask = boot(WHM_TRANSFER_CLIENT_BINDING, send)
    await vi.waitFor(() => expect(root.dataset.transferCredentialState).toBe('read'))
    expect(credential.options).toHaveLength(1)
    expect(credential.options[0]?.value).toBe(id(7))
    expect(credential.options[0]?.textContent).toContain(label)
    credential.value = id(7)
    label = 'Renamed source'; refresh.click()
    await vi.waitFor(() => expect(credential.options[0]?.textContent).toContain(label))
    expect(credential.value).toBe(id(7))
    expect(send.mock.calls).toEqual([['GET', '/api/transfers/sessions'], ['GET', '/api/transfers/credentials'], ['GET', '/api/transfers/sessions'], ['GET', '/api/transfers/credentials']])
    expect(ask).not.toHaveBeenCalled()
    // Without the manage flag the workspace still reads, and never writes or opens a control.
    root.dataset.transferManage = 'false'; refresh.click(); await settle()
    expect((send.mock.calls as unknown[][]).every(call => call[0] === 'GET')).toBe(true)
    expect(credential.disabled).toBe(true)
  })
  it.each([
    ['accounts', false, true, false], ['server', false, true, false],
    ['accounts', true, false, false], ['server', true, false, false],
    ['accounts', true, true, true], ['server', true, true, true],
  ] as const)('never writes in denied/read-only %s mode (%s,%s,%s)', async (scope, canRead, canManage, readOnly) => {
    const html = renderV2TransferPage({ locale: 'en', canRead, canManage, scope })
    mount(readOnly ? '<div data-readonly="true">' + html + '</div>' : html)
    const root = document.querySelector<HTMLElement>('[data-transfer-workspace]')
    if (!root) throw new Error('Missing transfer workspace')
    expect(root.dataset.transferCredentials).toBe(canRead ? 'read' : undefined)
    const send = vi.fn(async () => ({}))
    boot(WHM_TRANSFER_CLIENT_BINDING, send); await settle()
    // A read-only frame reads saved state (GET only); a denied workspace reads nothing.
    if (readOnly) expect((send.mock.calls as unknown[][]).every(call => call[0] === 'GET')).toBe(true)
    else expect(send).not.toHaveBeenCalled()
    expect([...root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')].every(control => control.disabled)).toBe(true)
  })
})
