// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderAccountMailingLists } from './board-port/extensions/account-mailing-lists.ts'
import {
  ACCOUNT_MAILING_LISTS_CLIENT_BINDING, mailingListDraft, mailingListMatches, readMailingLists,
} from './account-mailing-lists-client.ts'

const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const record = (patch: Record<string, unknown> = {}) => ({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', accountId, name: 'announce', domain: 'acct.example.test',
  address: 'announce@acct.example.test', members: ['one@example.test'], moderation: 'members', archiveEnabled: true,
  createdAt: '2026-01-01T00:00:00.000Z', ...patch,
})
const field = (selector: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)!
const status = () => document.querySelector<HTMLElement>('[data-mailing-list-status]')!

describe('mailing list helpers', () => {
  it('validates list records and rejects foreign or malformed rows', () => {
    expect(readMailingLists({ mailingLists: [record()] }, accountId)).toHaveLength(1)
    for (const bad of [
      { mailingLists: [record({ accountId: 'foreign' })] },
      { mailingLists: [record({ address: 'not-an-email' })] },
      { mailingLists: [record({ moderation: 'owner' })] },
      { mailingLists: [record({ members: ['a@b.test', 'a@b.test'] })] },
      { mailingLists: [record(), record()] },
      null,
    ]) expect(() => readMailingLists(bad, accountId)).toThrow()
  })
  it('builds a normalized draft and compares readback fields', () => {
    const draft = mailingListDraft({ name: ' Announce ', domain: 'ACCT.example.test', members: 'One@Example.Test\n two@example.test ,', moderation: 'moderated', archiveEnabled: false })
    expect(draft).toEqual({ name: 'announce', domain: 'acct.example.test', members: ['one@example.test', 'two@example.test'], moderation: 'moderated', archiveEnabled: false })
    expect(mailingListMatches(readMailingLists({ mailingLists: [record()] }, accountId)[0]!, draft)).toBe(false)
    for (const bad of [
      { name: 'bad name', domain: 'acct.example.test', members: '', moderation: 'members', archiveEnabled: true },
      { name: 'announce', domain: 'bad domain', members: '', moderation: 'members', archiveEnabled: true },
      { name: 'announce', domain: 'acct.example.test', members: 'not-an-email', moderation: 'members', archiveEnabled: true },
      { name: 'announce', domain: 'acct.example.test', members: 'a@b.test,a@b.test', moderation: 'members', archiveEnabled: true },
      { name: 'announce', domain: 'acct.example.test', members: '', moderation: 'owner', archiveEnabled: true },
      { name: 'announce', domain: 'acct.example.test', members: '', moderation: 'members', archiveEnabled: 'yes' },
    ]) expect(() => mailingListDraft(bad)).toThrow()
  })
})

describe('mailing lists browser binding', () => {
  beforeEach(() => {
    document.body.innerHTML = renderAccountMailingLists({ lang: 'en', expectedAccountId: accountId, canManage: true, domains: ['acct.example.test'] })
    document.documentElement.lang = 'en'
    delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  })
  const boot = (transport: ReturnType<typeof vi.fn>) => {
    (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport
    new Function(`(${ACCOUNT_MAILING_LISTS_CLIENT_BINDING})((options) => Promise.resolve(true));`)()
  }
  it('constructs the binding and renders without forms or fetch', () => {
    expect(() => new Function('return ' + ACCOUNT_MAILING_LISTS_CLIENT_BINDING)()).not.toThrow()
    expect(ACCOUNT_MAILING_LISTS_CLIENT_BINDING).not.toContain('fetch(')
    expect(document.querySelector('[data-mailing-lists]')).not.toBeNull()
    expect(document.querySelectorAll('form')).toHaveLength(0)
  })
  it('disables controls with an explicit unavailable state without a transport', () => {
    new Function(`(${ACCOUNT_MAILING_LISTS_CLIENT_BINDING})(undefined);`)()
    expect(status().dataset.state).toBe('unavailable')
    expect(document.querySelector<HTMLButtonElement>('[data-ml-create]')!.disabled).toBe(true)
  })
  it('replaces the reading message once the saved lists are read', async () => {
    boot(vi.fn(async () => ({ mailingLists: [record()] }))); await tick()
    expect(status().textContent).not.toContain('Reading')
    expect(status().dataset.state).toBe('loaded')
    expect(status().hidden).toBe(true)
  })
  it('reads saved lists, creates a list and verifies the readback', async () => {
    let lists = [record()]
    const calls: { method: string; path: string; body?: unknown }[] = []
    const transport = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) })
      if (method === 'GET') return { mailingLists: lists }
      if (method === 'POST') {
        const created = record({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'news', address: 'news@acct.example.test', members: ['n@example.test'], moderation: 'open' })
        lists = [...lists, created]
        return { mailingList: created }
      }
      throw new Error('unexpected_request')
    })
    boot(transport); await tick()
    expect(document.querySelectorAll('[data-mailing-list-id]')).toHaveLength(1)
    field('[data-ml-name]').value = 'news'
    field('[data-ml-members]').value = 'n@example.test'
    field('[data-ml-moderation]').value = 'open'
    document.querySelector<HTMLButtonElement>('[data-ml-create]')!.click(); await tick(); await tick()
    const post = calls.find(call => call.method === 'POST')
    expect(post?.body).toMatchObject({ accountId, name: 'news', domain: 'acct.example.test', members: ['n@example.test'], moderation: 'open', archiveEnabled: true })
    expect(status().dataset.state).toBe('saved')
    expect(document.querySelectorAll('[data-mailing-list-id]')).toHaveLength(2)
  })
  it('keeps a duplicate/refused create truthful and locks after an uncertain outcome', async () => {
    let mode: 'duplicate' | 'uncertain' = 'duplicate'
    const transport = vi.fn(async (method: string) => {
      if (method === 'GET') return { mailingLists: [record()] }
      if (mode === 'duplicate') throw { status: 409, details: { stateChanged: false } }
      throw { status: 503, details: { verificationRequired: true } }
    })
    boot(transport); await tick()
    field('[data-ml-name]').value = 'announce'
    document.querySelector<HTMLButtonElement>('[data-ml-create]')!.click(); await tick(); await tick()
    expect(status().dataset.state).toBe('failed')
    mode = 'uncertain'
    document.querySelector<HTMLButtonElement>('[data-ml-create]')!.click(); await tick(); await tick()
    expect(status().dataset.state).toBe('uncertain')
    expect(document.querySelector<HTMLButtonElement>('[data-ml-create]')!.disabled).toBe(true)
  })
  it('deletes a list only after confirmation and verifies absence', async () => {
    let lists = [record()]
    const transport = vi.fn(async (method: string) => {
      if (method === 'GET') return { mailingLists: lists }
      if (method === 'DELETE') { lists = []; return { ok: true } }
      throw new Error('unexpected_request')
    })
    boot(transport); await tick()
    document.querySelector<HTMLButtonElement>('[data-mailing-lists-rows] tr td:last-child button')!.click(); await tick(); await tick()
    expect(status().dataset.state).toBe('saved')
    expect(document.querySelectorAll('[data-mailing-list-id]')).toHaveLength(0)
  })
})
