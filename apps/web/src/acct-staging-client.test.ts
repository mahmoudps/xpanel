// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderAccountStagingWorkspace } from './board-port/acct-staging-workspace.ts'
import { ACCT_STAGING_CLIENT_BINDING, readStagingReply } from './acct-staging-client.ts'

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', DOMAIN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', REVISION = 'a'.repeat(64), RECORDS = 'b'.repeat(64)
const context = { accountId: ACCOUNT, username: 'alice', domainId: DOMAIN, domain: 'alice.example.test' }
const record = { domainId: DOMAIN, domain: 'alice.example.test', state: 'ready', files: 3, createdAt: '2026-10-28T10:00:00.000Z', createdBy: 'alice', promotedAt: null }
const list = (records: unknown[] = []) => ({ context: { accountId: ACCOUNT, username: 'alice' }, domains: [{ id: DOMAIN, name: 'alice.example.test', kind: 'primary' }], records, revision: RECORDS, capabilities: { agent: true } })
const review = { context, live: { path: 'public_html', files: 3, bytes: 30, links: 0 }, staging: { path: 'staging/alice.example.test', exists: true, files: 3, bytes: 30, links: 0 }, rows: [{ path: 'index.html', change: 'change', bytes: 10 }], revision: REVISION, limits: {} }
type Transport = (method: string, path: string, body?: any) => Promise<unknown>
const server = (overrides: Record<string, () => unknown> = {}): Transport => vi.fn(async (_method: string, path: string) => {
  const key = path === '/api/account/staging' ? 'list' : path.split('/').at(-1)!
  if (overrides[key]) return overrides[key]!()
  return ({ list: list(), copy: { context, outcome: 'copied', counts: { files: 3, copied: 3, failed: 0, notAttempted: 0 }, verificationRequired: false, records: [record], recordsRevision: RECORDS }, review,
    promote: { context, outcome: 'promoted', results: [{ path: 'index.html', change: 'change', result: 'applied', trashId: null, verificationRequired: false }], counts: {}, revision: REVISION, verificationRequired: false, records: [{ ...record, promotedAt: '2026-10-28T11:00:00.000Z' }], recordsRevision: RECORDS },
    discard: { context, outcome: 'discarded', trashId: null, verificationRequired: false, records: [], recordsRevision: RECORDS } } as Record<string, unknown>)[key]
})
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const mount = (canManage = true, lang: 'en' | 'ar' = 'en') => { document.body.innerHTML = `<section data-workspace-mode="connected">${renderAccountStagingWorkspace({ lang, accountId: ACCOUNT, canManage })}</section>` }
const boot = async (request: Transport, ask?: () => Promise<unknown>) => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; new Function('return ' + ACCT_STAGING_CLIENT_BINDING)()(ask); await tick() }
const q = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const click = async (element: Element) => { (element as HTMLElement).click(); await tick() }
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; mount() })

describe('staging reply parser', () => {
  it('binds replies to the account, domain and reviewed revision', () => {
    expect(readStagingReply('list', list([record]), { accountId: ACCOUNT }).records).toHaveLength(1)
    expect(() => readStagingReply('list', list(), { accountId: 'other' })).toThrow()
    expect(() => readStagingReply('review', { ...review, rows: [{ path: '../etc/passwd', change: 'add', bytes: 1 }] }, { accountId: ACCOUNT, domainId: DOMAIN })).toThrow()
    expect(() => readStagingReply('review', review, { accountId: ACCOUNT, domainId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })).toThrow()
    expect(() => readStagingReply('promote', { context, outcome: 'promoted', results: [], revision: 'c'.repeat(64), verificationRequired: false, records: [], recordsRevision: RECORDS }, { accountId: ACCOUNT, domainId: DOMAIN, revision: REVISION })).toThrow()
  })
})

describe('staging client', () => {
  it('creates a copy, reviews it and promotes only after acknowledgement', async () => {
    const request = server()
    await boot(request, async () => true)
    await click(q('button[data-action="copy"]'))
    expect(request).toHaveBeenLastCalledWith('POST', `/api/account/staging/${DOMAIN}/copy`, { expectedRecordsRevision: RECORDS })
    expect(q('[data-staging-rows]').textContent).toContain('Ready')
    await click(q('button[data-action="review"]'))
    expect(q('[data-staging-changes]').textContent).toBe('1')
    expect(q<HTMLButtonElement>('[data-staging-promote]').disabled).toBe(true)
    const ack = q<HTMLInputElement>('[data-staging-ack]'); ack.checked = true; ack.dispatchEvent(new Event('change', { bubbles: true })); await tick()
    await click(q('[data-staging-promote]'))
    expect(request).toHaveBeenLastCalledWith('POST', `/api/account/staging/${DOMAIN}/promote`, { expectedRevision: REVISION, expectedRecordsRevision: RECORDS })
    expect(q('[data-staging-results]').textContent).toContain('Applied and verified')
  })
  it('discards only after confirmation and disables discard without a dialog', async () => {
    const ask = vi.fn(async () => false), request = server({ list: () => list([record]) })
    await boot(request, ask)
    await click(q('button[data-action="discard"]'))
    expect(ask).toHaveBeenCalled()
    expect(request).not.toHaveBeenCalledWith('POST', `/api/account/staging/${DOMAIN}/discard`, expect.anything())
    mount(); await boot(server({ list: () => list([record]) }))
    expect(q<HTMLButtonElement>('button[data-action="discard"]').disabled).toBe(true)
  })
  it('reports unverifiable replies and stays inert without authority', async () => {
    await boot(server({ list: () => ({ ...list(), capabilities: {} }) }))
    expect(q('[data-staging-status]').textContent).toContain('could not be verified')
    mount(false)
    const request = server()
    await boot(request)
    expect(request).not.toHaveBeenCalled()
    expect(q('[data-staging-status]').dataset.state).toBe('unavailable')
  })
  it('renders Arabic direction from the locale', () => {
    document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl'
    try { mount(true, 'ar'); expect(q('[data-account-staging]').getAttribute('dir')).toBe('rtl') } finally { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' }
  })
})
