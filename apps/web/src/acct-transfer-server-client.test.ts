// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderAcctTransferServerWorkspace } from './board-port/acct-transfer-server.ts'
import { ACCT_TRANSFER_CREDENTIALS_CLIENT_BINDING, readTransferCredentialsView } from './acct-transfer-credentials-client.ts'
import { WHM_TRANSFER_CLIENT_BINDING } from './whm-transfer-client.ts'

const id = (value: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(value).padStart(12, '0')
const TOKEN = 'xp_' + 'Q'.repeat(43)
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const credential = (n: number) => ({ id: id(n), label: 'Old server ' + n, kind: 'api-token', fingerprint: String(n).repeat(16).slice(0, 16), createdAt: '2026-10-28T10:00:00.000Z', createdBy: 'root' })
const listView = (items: unknown[], changed?: string) => ({ revision: String(items.length).repeat(64), limit: 50, credentials: items, ...(changed ? { changed } : {}) })
const session = () => ({ session: { id: id(1), actor: 'root', createdAt: '2026-10-28T10:00:00.000Z', state: 'inventoried', auth: { kind: 'api-token', url: 'https://source.example.test', tokenId: id(2), tlsFingerprint: null },
  source: { hostname: 'source.example.test', version: '0.1.0' }, inventory: { accounts: [{ username: 'alice', primaryDomain: 'alice.example.test', plan: 'gold', diskBytes: 1, databases: [], mailboxes: 0 }, { username: 'bob', primaryDomain: 'bob.example.test', plan: 'gold', diskBytes: 1, databases: [], mailboxes: 0 }], plans: [{ name: 'gold' }] },
  local: null, selection: { accounts: [], plans: [] }, conflicts: [], resolutions: {}, reviewDigest: null, progress: {}, log: [], error: null }, revision: '1'.repeat(64), review: null, digest: null })
const boot = (send: (method: string, path: string, body?: unknown) => Promise<unknown>, canManage = true, ask = vi.fn(async () => true)) => {
  document.body.innerHTML = renderAcctTransferServerWorkspace({ locale: 'en', canManage })
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  new Function('return ' + ACCT_TRANSFER_CREDENTIALS_CLIENT_BINDING)()(ask)
  new Function('return ' + WHM_TRANSFER_CLIENT_BINDING)()(ask, false)
  return ask
}
const q = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; vi.restoreAllMocks() })

describe('source token view', () => {
  it('accepts metadata only and refuses any reply carrying a token', () => {
    expect(readTransferCredentialsView(listView([credential(1)], id(1))).changed).toBe(id(1))
    expect(() => readTransferCredentialsView(listView([{ ...credential(1), token: TOKEN }]))).toThrow()
    expect(() => readTransferCredentialsView(listView([credential(1), credential(1)]))).toThrow()
    expect(() => readTransferCredentialsView({ ...listView([]), limit: 10 })).toThrow()
  })
})

describe('live transfer from a linked server', () => {
  const nodes = { config: { nodes: [{ id: 'node_' + 'a'.repeat(16), label: 'Old server', hostname: 'whm.old.example.test' }] } }
  const liveSession = (results: unknown = {}) => { const entry = session(); return { ...entry, session: { ...entry.session, state: 'completed', live: true, progress: { alice: { targetUsername: 'alice', phase: 'done', bytes: 1, totalBytes: 1, error: null } } }, results } }
  const model = (entry: unknown, live = true) => vi.fn(async (method: string, path: string, body?: unknown) => {
    if (path === '/api/transfers/credentials') return listView([])
    if (path === '/api/server/nodes') return nodes
    if (path === '/api/transfers/sessions' && method === 'GET') return { sessions: [entry], cpanelImports: [], capabilities: { discover: true, execute: true, live, cpanelImport: false, cpanelUploadMaxBytes: 0 } }
    if (path === '/api/transfers/sessions' && method === 'POST') return { ...session(), session: { ...session().session, live: (body as { live: boolean }).live } }
    if (method === 'PATCH') return entry
    throw { status: 404 }
  })
  it('offers linked servers by id and starts a live session without any credential', async () => {
    const send = model(session()); boot(send); await tick(); await tick()
    const node = q<HTMLSelectElement>('[data-transfer-node]')
    expect([...node.options].map(option => option.textContent)).toEqual(['None', 'Old server · whm.old.example.test'])
    expect(q<HTMLButtonElement>('[data-transfer-create]').disabled).toBe(true)
    node.value = 'node_' + 'a'.repeat(16); node.dispatchEvent(new Event('change'))
    expect(q<HTMLButtonElement>('[data-transfer-create]').disabled).toBe(false)
    q<HTMLButtonElement>('[data-transfer-create]').click(); await tick()
    expect(send.mock.calls.find(call => call[0] === 'POST')?.[2]).toEqual({ node: 'node_' + 'a'.repeat(16), live: true })
  })
  it('keeps the linked server choice closed where a live transfer cannot run', async () => {
    boot(model(session(), false)); await tick(); await tick()
    expect(q<HTMLSelectElement>('[data-transfer-node]').disabled).toBe(true)
  })
  const preview = { account: 'alice', cutoverAt: '2026-11-07T10:00:00.000Z', mail: [{ mailbox: 'info@alice.example.test', messages: 3 }], files: 2, databases: { onCopy: 1, changes: 'unknown' }, zones: 'unknown', edgeNotCarriedBack: ['ipBlocker'], digest: 'd'.repeat(64) }
  const lossRows = () => [...document.querySelectorAll('[data-transfer-revert-loss] tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent))
  const shown = [['Mail written since the cutover', '3 messages'], ['info@alice.example.test', '3 messages'], ['Files changed since the cutover', '2 files'],
    ['Database changes since the cutover', 'Unknown; 1 database is removed with the copy'], ['DNS zones changed since the cutover', 'Unknown'], ['Edge settings saved since the cutover', 'IP blocker']]
  it('shows what a revert drops and reverts only when the account name is typed over that list', async () => {
    const live = { cutoverAt: '2026-11-07T10:00:00.000Z', zones: 1, revertedAt: null }
    const base = model(liveSession({ alice: { live } }))
    const send = vi.fn(async (method: string, path: string, body?: unknown) => method === 'PATCH' && (body as { action: string }).action === 'revert-preview' ? { preview } : base(method, path, body))
    const ask = vi.fn(async (_options: Record<string, unknown>): Promise<unknown> => 'bob')
    boot(send, true, ask as never); await tick(); await tick()
    expect(q<HTMLSelectElement>('[data-transfer-revert-account]').value).toBe('alice')
    expect(document.querySelector('[data-transfer-accept-loss]')).toBeNull()
    q<HTMLButtonElement>('[data-transfer-revert]').click(); await tick()
    expect(send.mock.calls.find(call => call[0] === 'PATCH')?.[2]).toEqual({ action: 'revert-preview', account: 'alice', expectedRevision: '1'.repeat(64) })
    expect(lossRows()).toEqual(shown)
    const dialog = ask.mock.calls.at(-1)![0]
    expect(dialog).toMatchObject({ input: true, danger: true, label: 'Type the account name to confirm' })
    expect(String(dialog.body)).toContain('Mail written since the cutover: 3 messages; Files changed since the cutover: 2 files')
    expect(String(dialog.body)).not.toContain('info@alice.example.test')
    // the wrong name sends nothing
    expect(send.mock.calls.some(call => call[0] === 'PATCH' && (call[2] as { action: string }).action === 'revert')).toBe(false)
    expect(q('[data-transfer-status]').textContent).toBe('The account name did not match. Nothing was sent.')
    ask.mockResolvedValueOnce('alice')
    q<HTMLButtonElement>('[data-transfer-revert]').click(); await tick(); await tick()
    expect(send.mock.calls.find(call => call[0] === 'PATCH' && (call[2] as { action: string }).action === 'revert')?.[2]).toEqual({ action: 'revert', account: 'alice', confirmation: 'd'.repeat(64), expectedRevision: '1'.repeat(64) })
  })
  it('offers nothing to revert once it was reverted, and shows what it did not carry back', async () => {
    boot(model(liveSession({ alice: { live: { cutoverAt: '2026-11-07T10:00:00.000Z', zones: 1, revertedAt: '2026-11-07T11:00:00.000Z', lost: preview } } }))); await tick(); await tick()
    expect(q<HTMLSelectElement>('[data-transfer-revert-account]').options).toHaveLength(0)
    expect(q<HTMLButtonElement>('[data-transfer-revert]').disabled).toBe(true)
    expect(lossRows()).toEqual(shown)
  })
})

describe('whole-server migration page', () => {
  const model = () => {
    let items: unknown[] = [credential(2)]
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (path === '/api/transfers/credentials' && method === 'GET') return listView(items)
      if (path === '/api/transfers/credentials' && method === 'POST') { const created = { ...credential(3), label: (body as { label: string }).label }; items = [...items, created]; return listView(items, created.id) }
      if (path === '/api/transfers/sessions' && method === 'GET') return { sessions: [session()], cpanelImports: [], capabilities: { discover: true, execute: false, cpanelImport: false, cpanelUploadMaxBytes: 0 } }
      if (method === 'PATCH') return { ...session(), session: { ...session().session, state: 'selected', selection: (body as { accounts: string[]; plans: string[] }) }, revision: '2'.repeat(64) }
      throw { status: 404 }
    })
    return send
  }
  it('fills stored tokens by reference and selects every source account and plan', async () => {
    const send = model(); boot(send); await tick()
    const options = [...q<HTMLSelectElement>('[data-transfer-credential]').options]
    expect(options.map(option => [option.value, option.dataset.kind])).toEqual([[id(2), 'api-token']])
    const boxes = [...document.querySelectorAll<HTMLInputElement>('[data-transfer-accounts] input, [data-transfer-plans] input')]
    expect(boxes.map(box => [box.value, box.checked, box.disabled])).toEqual([['alice', true, true], ['bob', true, true], ['gold', true, true]])
    expect(q<HTMLElement>('[data-acct-transfer-credentials-status]').dataset.state).toBe('read')
    q<HTMLButtonElement>('[data-transfer-select]').click(); await tick()
    expect(send.mock.calls.find(call => call[0] === 'PATCH')?.[2]).toMatchObject({ action: 'select', accounts: ['alice', 'bob'], plans: ['gold'], expectedRevision: '1'.repeat(64) })
    expect(q<HTMLElement>('[data-transfer-workspace]').dataset.transferScope).toBe('server')
    expect(q<HTMLElement>('[data-transfer-archive-review]').closest('[hidden]')).not.toBeNull()
  })
  it('stores a token once, clears the field and refreshes the session credential list', async () => {
    const send = model(); boot(send); await tick()
    q<HTMLInputElement>('[data-acct-transfer-credential-input="label"]').value = 'New source'
    q<HTMLInputElement>('[data-acct-transfer-credential-input="token"]').value = TOKEN
    q<HTMLFormElement>('[data-acct-transfer-credentials-form]').requestSubmit(); await tick()
    expect(send.mock.calls.find(call => call[0] === 'POST')?.[2]).toEqual({ label: 'New source', token: TOKEN, expectedRevision: '1'.repeat(64) })
    expect(q<HTMLInputElement>('[data-acct-transfer-credential-input="token"]').value).toBe('')
    expect(q<HTMLElement>('[data-acct-transfer-credentials-status]').dataset.state).toBe('saved')
    expect([...q<HTMLSelectElement>('[data-transfer-credential]').options].map(option => option.value)).toEqual([id(2), id(3)])
    expect(document.body.textContent).not.toContain(TOKEN)
  })
  it('refuses an incomplete token before sending and clears it', async () => {
    const send = model(); boot(send); await tick()
    q<HTMLInputElement>('[data-acct-transfer-credential-input="label"]').value = 'x'
    q<HTMLInputElement>('[data-acct-transfer-credential-input="token"]').value = 'xp_short'
    q<HTMLFormElement>('[data-acct-transfer-credentials-form]').requestSubmit(); await tick()
    expect(send.mock.calls.some(call => call[0] === 'POST')).toBe(false)
    expect(q<HTMLInputElement>('[data-acct-transfer-credential-input="token"]').value).toBe('')
    expect(q<HTMLElement>('[data-acct-transfer-credentials-status]').dataset.state).toBe('failed')
  })
  it('shows a denied state without requests for a read-only viewer', async () => {
    const send = model(); boot(send, false); await tick()
    expect(send.mock.calls.some(call => call[1] === '/api/transfers/credentials')).toBe(false)
    expect(q<HTMLElement>('[data-acct-transfer-credentials-status]').dataset.state).toBe('denied')
    expect(q<HTMLInputElement>('[data-acct-transfer-credential-input="token"]').disabled).toBe(true)
  })
})
