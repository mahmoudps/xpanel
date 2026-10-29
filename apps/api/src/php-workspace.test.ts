import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handlePhpWorkspaceRoute, projectPhpDesiredUsage } from './php-workspace.ts'

const caller = { principal: { kind: 'root', id: 'fixture-root', username: 'root' } } as AuthenticatedCaller
const domain = (name: string, accountId: string, version = '8.3', handler = 'fpm') => ({ name, accountId, php: { version, handler } }) as Domain
describe('PHP root workspace contracts', () => {
  it('groups actual desired domain assignments without presenting them as installed runtimes', () => {
    const result = projectPhpDesiredUsage([domain('b.example.test', 'a'), domain('a.example.test', 'a'), domain('c.example.test', 'b', '8.2', 'cgi')], [{ id: 'a', username: 'account-a' }] as Account[])
    expect(result).toEqual([
      { version: '8.2', domainCount: 1, accountCount: 1, handlers: [{ handler: 'cgi', count: 1 }], domains: [{ name: 'c.example.test', account: null, handler: 'cgi' }] },
      { version: '8.3', domainCount: 2, accountCount: 1, handlers: [{ handler: 'fpm', count: 2 }], domains: [{ name: 'a.example.test', account: 'account-a', handler: 'fpm' }, { name: 'b.example.test', account: 'account-a', handler: 'fpm' }] },
    ])
    expect(JSON.stringify(result)).not.toContain('accountId')
  })
  it('authenticates and asserts root before asking the protected agent for inventory', async () => {
    const events: string[] = []
    const result = await handlePhpWorkspaceRoute(new Request('http://localhost/api/server/php/inventory'), new URL('http://localhost/api/server/php/inventory'), 'GET', {
      requireCaller: async () => { events.push('auth'); return caller }, assertRoot: async () => { events.push('root') },
      readInventory: async received => { expect(received).toBe(caller); events.push('inventory'); return Response.json({ state: 'read', versions: [] }) },
      listDomains: vi.fn(), listAccounts: vi.fn(),
    })
    expect(events).toEqual(['auth', 'root', 'inventory']); expect(result!.status).toBe(200)
  })
  it('does not touch an agent or domain inventory when root authorization is refused', async () => {
    const readInventory = vi.fn(), listDomains = vi.fn(), listAccounts = vi.fn()
    await expect(handlePhpWorkspaceRoute(new Request('http://localhost/api/server/php/inventory'), new URL('http://localhost/api/server/php/inventory'), 'GET', {
      requireCaller: async () => caller, assertRoot: async () => { throw new Error('denied') }, readInventory, listDomains, listAccounts,
    })).rejects.toThrow('denied')
    expect(readInventory).not.toHaveBeenCalled(); expect(listDomains).not.toHaveBeenCalled(); expect(listAccounts).not.toHaveBeenCalled()
  })
  it.each(['?version=8.3', '?accountId=foreign', '?command=php', '?path=/etc/php.ini'])('refuses selector %s before protected reads', async query => {
    const readInventory = vi.fn(), listDomains = vi.fn(), listAccounts = vi.fn(), url = new URL('http://localhost/api/server/php/inventory' + query)
    await expect(handlePhpWorkspaceRoute(new Request(url), url, 'GET', { requireCaller: async () => caller, assertRoot: async () => {}, readInventory, listDomains, listAccounts })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(readInventory).not.toHaveBeenCalled(); expect(listDomains).not.toHaveBeenCalled()
  })
  it('only serves GET and leaves unrelated routes untouched', async () => {
    const helpers = { requireCaller: vi.fn(async () => caller), assertRoot: vi.fn(async () => {}), readInventory: vi.fn(), listDomains: vi.fn(), listAccounts: vi.fn() }
    expect(await handlePhpWorkspaceRoute(new Request('http://localhost/api/other'), new URL('http://localhost/api/other'), 'GET', helpers)).toBeNull()
    expect(helpers.requireCaller).not.toHaveBeenCalled()
    const url = new URL('http://localhost/api/server/php/inventory')
    const response = await handlePhpWorkspaceRoute(new Request(url, { method: 'POST' }), url, 'POST', helpers)
    expect(response!.status).toBe(405); expect(response!.headers.get('allow')).toBe('GET'); expect(helpers.readInventory).not.toHaveBeenCalled()
  })
  it('states the usage evidence scope explicitly and never returns account identifiers as labels', async () => {
    const url = new URL('http://localhost/api/server/php/usage')
    const response = await handlePhpWorkspaceRoute(new Request(url), url, 'GET', { requireCaller: async () => caller, assertRoot: async () => {}, readInventory: vi.fn(), listDomains: async () => [domain('a.example.test', 'private-internal-key')], listAccounts: async () => [] })
    const body = await response!.json() as Record<string, unknown>
    expect(body).toMatchObject({ scope: 'saved-domain-configuration', observedRuntime: false })
    expect(JSON.stringify(body)).not.toContain('private-internal-key')
  })
})
