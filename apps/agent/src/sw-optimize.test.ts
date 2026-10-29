import { describe, expect, it } from 'vitest'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import { readSwOptimizeView } from '../../../packages/os/src/sw-optimize-command.ts'
import { handleSwOptimizeRoute, parseEdgePolicy } from './sw-optimize.ts'
import type { SwOptimizeContext } from './sw-optimize.ts'

const managed = ['# Managed by xPanel. Changes are overwritten on the next config generation.', 'http {', '    gzip on;', '    gzip_proxied any;', '    gzip_min_length 1024;', '    gzip_types text/plain text/css application/json;', '    proxy_cache_path /var/cache/xpanel levels=1:2 keys_zone=xpanel_cache:64m max_size=1024m inactive=60m use_temp_path=off;', '}'].join('\n') + '\n'
const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', planId: 'plan', status: 'active' } as Account
const domains = [{ accountId: account.id, name: 'b.example', suspended: true }, { accountId: account.id, name: 'a.example', redirect: { code: 301, to: 'https://x.example' } }, { accountId: 'other', name: 'other.example' }] as unknown as Domain[]
const context = (overrides: Partial<SwOptimizeContext> = {}, disabled: string[] = []): SwOptimizeContext => ({
  caller: { role: 'user', accountId: account.id, principalId: 'p1', actor: 'alice' } as never, currentPrincipal: async () => ({ kind: 'user', id: 'p1', username: 'alice', accountId: account.id, disabled: false }), readEdgeMain: async () => managed,
  store: { getAccountByUsername: async name => name === 'alice' ? account : null, listDomains: async () => domains, getPlan: async () => ({ featureListId: 'f' }) as Plan, getFeatureList: async () => ({ disabled }) as unknown as FeatureList, withAccountLifecycleLease: async (_id, operation) => operation(account) },
  ...overrides,
})
const read = async (ctx: SwOptimizeContext, path = '/accounts/alice/optimize') => { const url = new URL('http://agent.local' + path); return handleSwOptimizeRoute(new Request(url), url, 'GET', ctx) }

describe('edge optimization policy', () => {
  it('parses the managed nginx directives and always lists text/html', () => {
    expect(parseEdgePolicy(managed)).toEqual({ compression: 'on', types: ['text/html', 'text/plain', 'text/css', 'application/json'], minLength: 1024, proxied: ['any'], cache: { configured: true, maxSize: '1024m' } })
    expect(parseEdgePolicy('user nginx;\ngzip on;\n')).toBe('unmanaged')
    expect(() => parseEdgePolicy(managed + 'gzip off;\n')).toThrow()
    expect(() => parseEdgePolicy(managed.replace('gzip on;', 'gzip maybe;'))).toThrow()
    expect(() => parseEdgePolicy(managed.replace('application/json', 'application/json$(id)'))).toThrow()
  })
  it('returns only the owner account domains with truthful policy states', async () => {
    const view = readSwOptimizeView(await (await read(context()))!.json())
    expect(view.domains).toEqual([{ name: 'a.example', redirect: true, suspended: false }, { name: 'b.example', redirect: false, suspended: true }])
    expect(view.policy!.cache.configured).toBe(true); expect(view.actions).toEqual({ siteCompression: false, siteCache: false, purge: false })
    expect(readSwOptimizeView(await (await read(context({ readEdgeMain: null })))!.json()).reason).toBe('edge-config-unavailable')
    expect(readSwOptimizeView(await (await read(context({ readEdgeMain: async () => managed + 'gzip on;\n' })))!.json()).reason).toBe('invalid-edge-config')
  })
  it('refuses other accounts, roots, disabled features and selectors', async () => {
    await expect(read(context(), '/accounts/bob/optimize')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(read(context({ caller: { role: 'root', accountId: null } as never }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(read(context({}, ['optimize-website']))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(read(context(), '/accounts/alice/optimize?domain=a.example')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
