import { describe, expect, it, vi } from 'vitest'
import type { Account, Plan } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { CPAN_SEARCH_PATH, handleCpanSearchRoute, readCpanResults } from './perl-cpan-search.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const account = { id: ACCOUNT, username: 'alice', status: 'active', planId: 'plan' } as Account
const plan = { id: 'plan', featureListId: 'list' } as Plan
const caller = { principal: { kind: 'user', id: 'p', username: 'alice', accountId: ACCOUNT }, scopes: [] } as unknown as AuthenticatedCaller
const store = (disabled: string[] = []) => ({ getAccount: async () => account, getPlan: async () => plan, getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled }) }) as unknown as StateStore
const ports = (disabled?: string[]) => ({ store: store(disabled), requireCaller: async () => caller, readAgent: vi.fn() as never })
const answer = { results: [
  { distribution: 'JSON-Tiny', hits: [{ module: [{ name: 'JSON::Tiny', version: '0.58' }] }, { documentation: 'JSON::Tiny', abstract: 'Minimalistic\nJSON.', module: [{ name: 'JSON::Tiny', version: '0.58' }] }] },
  { distribution: 'Bad', hits: [{ documentation: 'rm -rf /', abstract: 'not a module' }] },
  { distribution: 'Docs-Only', hits: [{ documentation: 'Docs::Only', module: [{ name: 'Docs::Only', version: '$(evil)' }] }] },
] }
const ask = (query: string, fetcher: typeof fetch, disabled?: string[], method = 'GET') => {
  const url = new URL('https://panel.example.test' + CPAN_SEARCH_PATH + query)
  return handleCpanSearchRoute(new Request(url, { method }), url, method, ports(disabled), fetcher)
}
const replying = (body: unknown, init?: ResponseInit) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), init)) as unknown as typeof fetch

describe('CPAN search', { tags: ['unit'] }, () => {
  it('keeps one documented module per distribution and checks every field', () => {
    expect(readCpanResults(answer)).toEqual([{ name: 'JSON::Tiny', version: '0.58', description: 'Minimalistic JSON.' }, { name: 'Docs::Only', version: null, description: '' }])
    expect(readCpanResults({ results: 'x' })).toBeNull()
    expect(readCpanResults({ results: [{ hits: 'x' }] })).toBeNull()
  })

  it('asks MetaCPAN for the words given, without following a redirect', async () => {
    const fetcher = replying(answer), response = await ask('?q=json%20tiny', fetcher)
    expect(await response.json()).toMatchObject({ context: { accountId: ACCOUNT }, query: 'json tiny', modules: [{ name: 'JSON::Tiny' }, { name: 'Docs::Only' }] })
    expect(fetcher).toHaveBeenCalledWith('https://fastapi.metacpan.org/v1/search/web?q=json%20tiny&size=20', expect.objectContaining({ redirect: 'error' }))
  })

  it.each(['', '?q=a', '?q=a%3Bb', '?q=' + 'x'.repeat(101), '?q=json&mailbox=x'])('refuses the selector %s before any request', async query => {
    const fetcher = replying(answer)
    await expect(ask(query, fetcher)).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'invalid_search', stateChanged: false } })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each<[string, typeof fetch]>([
    ['an unreachable service', vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch],
    ['a refusal', replying('nope', { status: 503 })],
    ['a reply that is not JSON', replying('<html>')],
    ['an unexpected shape', replying({ hits: [] })],
    ['an oversized reply', replying('x'.repeat(2 * 1024 * 1024 + 1))],
  ])('reports %s as unavailable and invents no result', async (_name, fetcher) => {
    await expect(ask('?q=json', fetcher)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { reason: 'cpan_search_unavailable', stateChanged: false } })
  })

  it('runs one search at a time per account and frees the slot after a failure', async () => {
    let release = (_value: Response): void => undefined
    const slow = vi.fn(() => new Promise<Response>(resolve => { release = resolve })) as unknown as typeof fetch
    const first = ask('?q=json', slow)
    await vi.waitFor(() => expect(slow).toHaveBeenCalled())
    await expect(ask('?q=yaml', replying(answer))).rejects.toMatchObject({ code: 'CONFLICT' })
    release(new Response(JSON.stringify(answer)))
    expect((await first).status).toBe(200)
    expect((await ask('?q=yaml', replying(answer))).status).toBe(200)
  })

  it('needs the plan feature and takes GET only', async () => {
    await expect(ask('?q=json', replying(answer), ['perl-modules'])).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await ask('?q=json', replying(answer), undefined, 'POST')).status).toBe(405)
  })
})
